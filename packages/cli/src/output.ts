import type { Writable } from "node:stream";
import { CliError, errorDiagnostic, withErrorDetails, type ErrorDetails } from "./errors.js";
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
  return text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd").replace(/\r\n/g, "\n").split("\n").map(escapeDisplayText).join("\n");
}
export async function writeSuccess(io: CliIO, human: string, details: ErrorDetails = {}): Promise<void> {
  try { await writeText(io.stdout, human); }
  catch (error) { throw withErrorDetails(error, details); }
}
export async function writeFailure(io: CliIO, error: CliError): Promise<void> {
  await writeDiagnostic(io.stderr, errorDiagnostic(error));
}
/** Bounded best effort for diagnostics only; business stdout must use writeText. */
export async function writeDiagnostic(stream: Writable, text: string, signal?: AbortSignal): Promise<boolean> {
  const alreadyClosed = stream.closed;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const cleanup = () => {
      stream.removeListener("error", onError); stream.removeListener("close", onClose);
      signal?.removeEventListener("abort", abandon);
    };
    const finish = (written = false) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abandon); resolve(written);
    };
    const abandon = () => {
      if (settled) return;
      finish();
      // Destroy without an error: late write callbacks cannot emit an unhandled
      // write error. Keep the guard until destruction completes (or reports error).
      // An already-closed stream will not emit another close; a closing one still needs the guard.
      try { stream.destroy(); if (alreadyClosed) cleanup(); } catch { cleanup(); }
    };
    const onError = () => { abandon(); cleanup(); };
    const onClose = () => { finish(); cleanup(); };
    const timer = setTimeout(abandon, 250);
    stream.on("error", onError); stream.once("close", onClose);
    signal?.addEventListener("abort", abandon, { once: true });
    if (signal?.aborted) { abandon(); return; }
    try {
      stream.write(text, (failure) => {
        if (settled) return;
        if (failure) abandon();
        else { finish(true); cleanup(); }
      });
    } catch { abandon(); }
  });
}
