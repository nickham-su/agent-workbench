import { spawn } from "node:child_process";
import type { FileHandle } from "node:fs/promises";
import type { Writable, Readable } from "node:stream";
import {
  openTerminalRunControl, closeTerminalRunControl, claimTerminalRunStart, readTerminalRunRequest,
  writeTerminalRunStatus, TERMINAL_RUN_PYTHON, terminalRunGuardPath,
} from "./terminal-run-control.js";
import { assertTerminalRunLocator, type TerminalRunLocator, type TerminalRunState } from "./terminal-run-control.protocol.js";

/** One small owner for a configuration run. Control mailboxes survive API restarts
 * but carry no environment or command; the guard's child spec uses a private FD. */
export async function runManagedTerminalShell(params: {
  locator: TerminalRunLocator; env: Record<string, string>; shell: string; bootstrap: FileHandle; attemptId: string;
  onReady: () => Promise<boolean>; onSpawnError: () => Promise<boolean>;
  installStop: (stop: () => void) => void; initiallyStopped: () => boolean;
}): Promise<number> {
  assertTerminalRunLocator(params.locator);
  const control = await openTerminalRunControl(params.locator);
  let timer: NodeJS.Timeout | undefined;
  let requestedStop = params.initiallyStopped();
  let specWritten = false;
  let guardReady = false, bashReady = false, published = false, stoppedProof = false;
  let requestId = "initial";
  let currentState: TerminalRunState = "prepared";
  let writes = Promise.resolve();
  const persist = (state: TerminalRunState) => {
    if (currentState === "stopped" || (currentState === "stopping" && state === "running")) return writes;
    currentState = state;
    writes = writes.then(() => writeTerminalRunStatus(control, { version: 1, runId: params.locator.runId, requestId, state }));
    return writes;
  };
  try {
    if (!await claimTerminalRunStart(control)) return 1; // API won cancellation; no spawn is permitted.
    const child = spawn(TERMINAL_RUN_PYTHON, ["-I", "-S", terminalRunGuardPath()], {
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
      stdio: ["inherit", "inherit", "inherit", "pipe", params.bootstrap.fd, "pipe", "pipe"],
    });
    const channels = child.stdio as Array<Readable | Writable | null>;
    const input = channels[3] as Writable;
    let stopSent = false;
    const requestStop = () => {
      requestedStop = true;
      if (currentState !== "stopping") void persist("stopping").catch(() => undefined);
      if (specWritten && !stopSent && !input.destroyed) {
        stopSent = true;
        input.write("stop\n", () => undefined);
      }
    };
    params.installStop(requestStop);
    input.on("error", () => { requestedStop = true; });
    const ready = () => {
      if (published || requestedStop || !guardReady || !bashReady) return;
      published = true;
      void persist("running").then(() => requestedStop ? false : params.onReady()).then((ok) => { if (!ok) requestStop(); }).catch(requestStop);
    };
    let polling = false;
    timer = setInterval(() => {
      if (polling || stoppedProof) return;
      polling = true;
      void readTerminalRunRequest(control).then((request) => {
        if (!request) return;
        requestId = request.requestId;
        if (request.action === "stop") requestStop();
      }).catch(requestStop).finally(() => { polling = false; });
    }, 40);
    return await new Promise<number>((resolve) => {
      let completed = false;
      const finish = (code: number) => {
        if (completed) return;
        completed = true;
        for (const channel of channels) channel?.destroy();
        if (!stoppedProof) void persist("unknown").catch(() => undefined);
        void writes.catch(() => undefined).then(() => resolve(code));
      };
      child.once("spawn", () => {
        // Only the guard's private pipe carries these bytes. Never argv, status,
        // Python's own environment, stdout or the user's terminal input.
        input.write(`${JSON.stringify({ runId: params.locator.runId, shell: params.shell, env: params.env })}\n`);
        specWritten = true;
        if (requestedStop) requestStop();
        void params.bootstrap.close().catch(() => undefined);
      });
      let acknowledgement = "", protocol = "";
      channels[5]?.on("data", (data: Buffer) => {
        acknowledgement += data.toString("utf8");
        const expected = `${params.attemptId}\n`;
        if (acknowledgement === expected) { bashReady = true; ready(); }
        else if (!expected.startsWith(acknowledgement)) requestStop();
      });
      channels[6]?.on("data", (data: Buffer) => {
        protocol += data.toString("utf8");
        if (protocol.length > 4096) { requestStop(); return; }
        while (protocol.includes("\n")) {
          const end = protocol.indexOf("\n"), line = protocol.slice(0, end);
          protocol = protocol.slice(end + 1);
          try {
            const value = JSON.parse(line) as Record<string, unknown>;
            if (Object.keys(value).length !== 4 || value.version !== 1 || value.runId !== params.locator.runId
              || !Number.isSafeInteger(value.exitCode) || (value.exitCode as number) < 0 || (value.exitCode as number) > 255) throw new Error();
            if (value.state === "ready" && !guardReady && !stoppedProof) { guardReady = true; ready(); }
            else if (value.state === "stopped" && !stoppedProof) {
              // Guard emits this only after ECHILD (or before any child spawn).
              // No subsequent restart is possible in this guard invocation.
              stoppedProof = true;
              requestedStop = true;
              void persist("stopped").catch(() => undefined);
            } else throw new Error();
          } catch { requestStop(); }
        }
      });
      child.once("error", () => {
        // spawn error guarantees this invocation created no guard/user process.
        stoppedProof = true;
        void persist("stopped").then(() => params.onSpawnError()).finally(() => finish(1)).catch(() => undefined);
      });
      // ChildProcess.close can wait on the bidirectional control pipe even
      // after a killed supervisor exited. Its dedicated report pipe must reach
      // EOF; drain that pipe before interpreting exit so a queued stopped proof
      // is never lost to event ordering. Exit/EOF alone still mean unknown.
      let exited: number | undefined, reportEnded = false;
      const reportEnd = () => { reportEnded = true; if (exited !== undefined) finish(exited); };
      channels[6]?.once("end", reportEnd);
      channels[6]?.once("error", reportEnd);
      child.once("exit", (code) => { exited = code ?? 1; if (reportEnded) finish(exited); });
      child.once("close", (code) => finish(code ?? 1));
    });
  } finally {
    if (timer) clearInterval(timer);
    await writes.catch(() => undefined);
    await closeTerminalRunControl(control);
  }
}
