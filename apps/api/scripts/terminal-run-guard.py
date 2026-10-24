#!/usr/bin/python3
"""Linux-only owner of one terminal's Bash and descendants. Private FD protocol.

No workspace code or environment is evaluated by this supervisor. FD 3 receives
one child spec and stop requests; FD 6 reports ready/stopped. Bash alone inherits
the user's environment and the existing bootstrap/ack FDs.
"""
import ctypes
import json
import os
import select
import signal
import sys
import time

PR_SET_CHILD_SUBREAPER = 36
SPEC_LIMIT = 4 * 1024 * 1024
GRACE_SECONDS = 2.0


def capabilities():
    if sys.platform != "linux" or not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        raise RuntimeError("unsupported")
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
        raise RuntimeError("unsupported")
    with open("/proc/self/task/%d/children" % os.getpid(), "r", encoding="ascii") as metadata:
        metadata.read(0)
    fd = os.pidfd_open(os.getpid())
    try:
        signal.pidfd_send_signal(fd, 0)
    finally:
        os.close(fd)


def children(pid):
    # Only traverse the owned process tree, not all host processes. A direct
    # child is never reaped while its numeric PID is used in the force phase.
    try:
        with open("/proc/%d/task/%d/children" % (pid, pid), "r", encoding="ascii") as stream:
            return [int(value) for value in stream.read().split()]
    except FileNotFoundError:
        return []


def graceful_stop(sid):
    pending = children(os.getpid())
    visited = set()
    while pending:
        pid = pending.pop()
        if pid in visited:
            continue
        visited.add(pid)
        fd = None
        try:
            fd = os.pidfd_open(pid)
            # The pane's live session leader anchors SID. If a descendant has
            # detached, the force/adoption phase still owns and reaps it.
            if os.getsid(pid) != sid:
                continue
            pending.extend(children(pid))
            signal.pidfd_send_signal(fd, signal.SIGCONT)
            signal.pidfd_send_signal(fd, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass
        finally:
            if fd is not None:
                os.close(fd)


def main():
    capabilities()
    if len(sys.argv) == 2 and sys.argv[1] == "--check":
        return 0
    if len(sys.argv) != 1:
        return 1
    stopped_at = None
    buffer = bytearray()
    shell_pid = None
    shell_code = 0
    run_id = None

    def stop(_signal=None, _frame=None):
        nonlocal stopped_at
        if stopped_at is None:
            stopped_at = time.monotonic()

    for signum in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, stop)
    # Never auto-reap: unreaped direct children are identity anchors.
    signal.signal(signal.SIGCHLD, signal.SIG_DFL)

    def publish(state):
        message = json.dumps({"version": 1, "runId": run_id, "state": state, "exitCode": shell_code}, separators=(",", ":")) + "\n"
        try:
            os.write(6, message.encode("ascii"))
        except BrokenPipeError:
            stop()

    # Block only before any user process exists. EOF/malformed data cannot
    # accidentally execute a shell. The parent bounds this startup handshake.
    while b"\n" not in buffer:
        chunk = os.read(3, 65536)
        if not chunk or len(buffer) + len(chunk) > SPEC_LIMIT:
            return 1
        buffer.extend(chunk)
    line, _, remaining = buffer.partition(b"\n")
    spec = json.loads(line)
    run_id = spec["runId"]
    shell = spec["shell"]
    env = spec["env"]
    if not isinstance(run_id, str) or not isinstance(shell, str) or not isinstance(env, dict):
        return 1
    if stopped_at is not None:
        publish("stopped")
        return 0
    shell_pid = os.fork()
    if shell_pid == 0:
        try:
            for name in ("SIGHUP", "SIGTERM", "SIGINT", "SIGCHLD", "SIGPIPE", "SIGXFZ", "SIGXFSZ"):
                if hasattr(signal, name):
                    signal.signal(getattr(signal, name), signal.SIG_DFL)
            os.dup2(4, 3)
            os.dup2(5, 4)
            os.closerange(5, 1048576)
            os.execvpe(shell, [shell, "--rcfile", "/dev/fd/3", "-i"], env)
        except BaseException:
            os._exit(127)
    os.close(4)
    os.close(5)
    os.set_blocking(3, False)
    buffer = bytearray(remaining)
    sid = os.getsid(0)
    term_sent = False
    publish("ready")
    while True:
        # ECHILD is the sole completion proof, including adopted grandchildren.
        no_children = False
        while True:
            try:
                pid, status = os.waitpid(-1, os.WNOHANG)
                if pid == 0:
                    break
                if pid == shell_pid:
                    shell_code = os.waitstatus_to_exitcode(status)
                    if shell_code < 0:
                        shell_code = 128 - shell_code
                    stop()
            except ChildProcessError:
                no_children = True
                break
        if no_children:
            publish("stopped")
            return min(shell_code, 255)
        if stopped_at is not None:
            if not term_sent:
                graceful_stop(sid)
                term_sent = True
            if time.monotonic() - stopped_at >= GRACE_SECONDS:
                # These are our own non-reaped direct children, hence no PID
                # reuse race. Killing parents makes survivors our direct children
                # via subreaper; repeat until the kernel reports ECHILD.
                for pid in children(os.getpid()):
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except (ProcessLookupError, PermissionError):
                        pass
        readable, _, _ = select.select([3], [], [], 0.025)
        if readable:
            try:
                chunk = os.read(3, 4096)
            except BlockingIOError:
                continue
            if not chunk:
                stop()  # launcher died: retain ownership while converging
                time.sleep(0.025)
                continue
            buffer.extend(chunk)
            if len(buffer) > 4096:
                stop()
                buffer.clear()
            while b"\n" in buffer:
                line, _, rest = buffer.partition(b"\n")
                buffer = bytearray(rest)
                if line == b"stop":
                    stop()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        # No paths, user environment or command details on stderr. An abnormal
        # supervisor exit is unknown, NEVER a stopped acknowledgement.
        sys.exit(1)
