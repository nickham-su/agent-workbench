import { spawn, type ChildProcess } from "node:child_process";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertTerminalEnvironmentLaunchLocator, assertTerminalEnvironmentPayload, assertTerminalLaunchStatus,
  buildTerminalEnvironment, terminalLaunchSpawnErrorCode, terminalEnvironmentProtocolError,
  TERMINAL_ENV_PAYLOAD_MAX_BYTES, TERMINAL_ENV_PAYLOAD_NAME, TERMINAL_ENV_STATUS_NAME, TERMINAL_ENV_STATUS_MAX_BYTES,
  type TerminalEnvironmentLaunchLocator, type TerminalLaunchStatus
} from "./terminal-env-launch.protocol.js";
import {
  assertTerminalEnvironmentDirectoriesCurrent, assertTerminalEnvironmentFileCurrent,
  closeTerminalEnvironmentDirectories, openTerminalEnvironmentDirectories, openTerminalEnvironmentFile,
  readBoundedTerminalEnvironmentFile, writeTerminalEnvironmentStatus, type TerminalEnvironmentDirectories
} from "./terminal-env-launch.files.js";

function signalExitCode(signal: NodeJS.Signals | null): number {
  const number = signal ? (os.constants.signals as Record<string, number>)[signal] : undefined;
  return number ? 128 + number : 1;
}
/** Exported for protocol tests; direct invocation below is the trusted fixed executable entry. */
export async function runTerminalEnvironmentLauncher(locator: TerminalEnvironmentLaunchLocator): Promise<number> {
  assertTerminalEnvironmentLaunchLocator(locator);
  let dirs: TerminalEnvironmentDirectories | undefined;
  let statusHandle: FileHandle | undefined;
  let child: ChildProcess | undefined;
  let stopped: NodeJS.Signals | null = null;
  let stopTimer: NodeJS.Timeout | undefined;
  let forceFinish: (() => void) | undefined;
  const requestStop = (signal: NodeJS.Signals) => {
    stopped ??= signal;
    if (child) child.kill(signal);
    if (!stopTimer) stopTimer = setTimeout(() => {
      // Only the child object owned by THIS invocation, never an old persisted PID/process group.
      child?.kill("SIGKILL");
      forceFinish?.();
    }, 5000);
  };
  const onHup = () => requestStop("SIGHUP"), onTerm = () => requestStop("SIGTERM");
  process.on("SIGHUP", onHup);
  process.on("SIGTERM", onTerm);
  const closeProtocol = async () => {
    await statusHandle?.close().catch(() => undefined);
    statusHandle = undefined;
    await closeTerminalEnvironmentDirectories(dirs);
    dirs = undefined;
  };
  const publish = async (status: TerminalLaunchStatus) => {
    if (!dirs || !statusHandle || (stopped && status.state === "spawned")) return false;
    try {
      assertTerminalLaunchStatus(status, locator.attemptId);
      await writeTerminalEnvironmentStatus({ dirs, locator, handle: statusHandle, status, cancelled: () => stopped !== null });
      await closeProtocol(); // No subsequent payload/status read or write after a final handshake.
      return true;
    } catch {
      // A failed handshake is not success. Stop the owned shell, then let API timeout/presence compensate.
      if (!stopped) process.stderr.write("STATUS_WRITE_FAILED\n");
      requestStop("SIGTERM");
      await closeProtocol();
      return false;
    }
  };
  try {
    if (stopped) return signalExitCode(stopped);
    dirs = await openTerminalEnvironmentDirectories(locator);
    statusHandle = await openTerminalEnvironmentFile({ directory: dirs.directory, name: TERMINAL_ENV_STATUS_NAME,
      identity: locator.status, ownerUid: locator.ownerUid, writable: true });
    const pendingText = await readBoundedTerminalEnvironmentFile(statusHandle, TERMINAL_ENV_STATUS_MAX_BYTES);
    let pending: unknown;
    try { pending = JSON.parse(pendingText); } catch { terminalEnvironmentProtocolError(); }
    assertTerminalLaunchStatus(pending, locator.attemptId);
    if (pending.state !== "pending") terminalEnvironmentProtocolError();
    let payload: unknown;
    const payloadHandle = await openTerminalEnvironmentFile({ directory: dirs.directory, name: TERMINAL_ENV_PAYLOAD_NAME,
      identity: locator.payload, ownerUid: locator.ownerUid });
    try {
      const text = await readBoundedTerminalEnvironmentFile(payloadHandle, TERMINAL_ENV_PAYLOAD_MAX_BYTES);
      await assertTerminalEnvironmentFileCurrent({ directory: dirs.directory, name: TERMINAL_ENV_PAYLOAD_NAME,
        identity: locator.payload, ownerUid: locator.ownerUid, handle: payloadHandle });
      try { payload = JSON.parse(text); } catch { terminalEnvironmentProtocolError(); }
    } finally { await payloadHandle.close().catch(() => undefined); }
    assertTerminalEnvironmentPayload(payload, locator.attemptId);
    const env = buildTerminalEnvironment(payload, process.env);
    await assertTerminalEnvironmentDirectoriesCurrent(dirs, locator);
    if (stopped) return signalExitCode(stopped);
    try {
      // shell is one executable string; values never enter shell command text or argv.
      child = spawn(payload.shell, [], { env, stdio: "inherit" });
    } catch (error) {
      await publish({ version: 1, attemptId: locator.attemptId, state: "spawn-error", code: terminalLaunchSpawnErrorCode(error) });
      return stopped ? signalExitCode(stopped) : 1;
    }
    let finalStatus: Promise<boolean> | undefined;
    let publicationFailed = false;
    const result = await new Promise<number>((resolve) => {
      let finished = false;
      const finish = (code: number) => {
        if (!finished) { finished = true; resolve(code); }
      };
      forceFinish = () => finish(signalExitCode(stopped));
      child!.once("spawn", () => {
        if (stopped) { child!.kill(stopped); return; }
        finalStatus = publish({ version: 1, attemptId: locator.attemptId, state: "spawned" });
        void finalStatus.then((success) => { publicationFailed = !success; });
      });
      child!.once("error", (error) => {
        finalStatus = publish({ version: 1, attemptId: locator.attemptId, state: "spawn-error", code: terminalLaunchSpawnErrorCode(error) });
        void finalStatus.then(() => finish(1));
      });
      child!.once("close", (code, signal) => {
        void Promise.resolve(finalStatus).then(() => finish(publicationFailed ? 1 : stopped ? signalExitCode(stopped)
          : code ?? signalExitCode(signal)));
      });
    });
    return result;
  } catch {
    // No raw errors, argv, environment, path or JSON contents are emitted by the launcher.
    if (statusHandle && dirs && !stopped) {
      await publish({ version: 1, attemptId: locator.attemptId, state: "spawn-error", code: "SNAPSHOT_INVALID" });
    }
    return stopped ? signalExitCode(stopped) : 1;
  } finally {
    if (stopTimer) clearTimeout(stopTimer);
    process.off("SIGHUP", onHup);
    process.off("SIGTERM", onTerm);
    await closeProtocol();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) terminalEnvironmentProtocolError();
    const locator: unknown = JSON.parse(process.argv[2]!);
    assertTerminalEnvironmentLaunchLocator(locator);
    process.exitCode = await runTerminalEnvironmentLauncher(locator);
  } catch {
    process.stderr.write("TERMINAL_ENV_PROTOCOL_FAILED\n");
    process.exitCode = 1;
  }
}
