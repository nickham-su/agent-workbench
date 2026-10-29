import type { Writable } from "node:stream";
import { CliError, errorDiagnostic, errorObject, withErrorDetails, type ErrorDetails } from "./errors.js";
import { escapeDisplayText } from "./session-list-output.js";
import type { CliIO } from "./token-input.js";

/** Await write completion, including Writable backpressure; never ignore async EPIPE. */
export async function writeText(stream: Writable, text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const failure = (error: unknown) => {
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      setImmediate(() => { stream.removeListener("error", onError); });
      reject(new CliError(code === "EPIPE" ? 141 : 6, "输出未完整写入，已停止本地调用。", { code: code === "EPIPE" ? "OUTPUT_CLOSED" : "RESPONSE_INVALID" }));
    };
    const onError = (error: Error) => { failure(error); };
    stream.once("error", onError);
    try {
      stream.write(text, (error) => {
        if (error) { failure(error); return; } // The subsequent 'error' event consumes its listener.
        stream.removeListener("error", onError);
        resolve();
      });
    } catch (error) {
      stream.removeListener("error", onError);
      failure(error);
    }
  });
}
export function displayBody(text: string): string {
  return text.replace(/\r\n/g, "\n").split("\n").map(escapeDisplayText).join("\n");
}
export async function writeSuccess(io: CliIO, json: boolean, command: string, data: unknown, human: string, details: ErrorDetails = {}): Promise<void> {
  try { await writeText(io.stdout, json ? `${JSON.stringify({ schemaVersion: 1, ok: true, command, data })}\n` : human); }
  catch (error) { throw withErrorDetails(error, details); }
}
export async function writeEvent(io: CliIO, event: Record<string, unknown>): Promise<void> {
  await writeText(io.stdout, `${JSON.stringify({ schemaVersion: 1, ...event })}\n`);
}
export async function writeFailure(io: CliIO, json: boolean, error: CliError): Promise<void> {
  // Only the final diagnostic is best effort. Never replace the operation's error
  // or hold its exit hostage to an unread stderr. Normal output uses writeText.
  const alreadyClosed = io.stderr.closed;
  await new Promise<void>((resolve) => {
    let settled = false;
    const cleanup = () => { io.stderr.removeListener("error", onError); io.stderr.removeListener("close", onClose); };
    const finish = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(); };
    const abandon = () => {
      if (settled) return;
      finish();
      // Destroy without an error: late write callbacks cannot emit an unhandled
      // write error. Keep the guard until destruction completes (or reports error).
      // An already-closed stream will not emit another close; a closing one still needs the guard.
      try { io.stderr.destroy(); if (alreadyClosed) cleanup(); } catch { cleanup(); }
    };
    const onError = () => { abandon(); cleanup(); };
    const onClose = () => { finish(); cleanup(); };
    const timer = setTimeout(abandon, 250);
    io.stderr.on("error", onError); io.stderr.once("close", onClose);
    try {
      io.stderr.write(json ? `${JSON.stringify(errorObject(error))}\n` : errorDiagnostic(error), (failure) => {
        if (settled) return;
        if (failure) abandon();
        else { finish(); cleanup(); }
      });
    } catch { abandon(); }
  });
}
