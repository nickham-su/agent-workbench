import { spawn } from "node:child_process";

export type BashRunResult = {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputLimitExceeded: boolean;
};

export async function runBashCommand(params: {
  command: string;
  cwd: string;
  timeoutMs: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}): Promise<BashRunResult> {
  return new Promise<BashRunResult>((resolve, reject) => {
    const maxOutputBytes = params.maxOutputBytes ?? 512 * 1024;
    const child = spawn("bash", ["-lc", params.command], {
      cwd: params.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    });

    let stdout = "";
    let stderr = "";
    let capturedBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let settled = false;

    const finish = (value: BashRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      params.signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };

    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      params.signal?.removeEventListener("abort", onAbort);
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, params.timeoutMs);

    const onAbort = () => {
      child.kill("SIGKILL");
    };

    if (params.signal) {
      if (params.signal.aborted) {
        clearTimeout(timer);
        return fail(new Error("aborted"));
      }
      params.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const chunkBytes = Buffer.byteLength(chunk, "utf8");
      if (capturedBytes + chunkBytes > maxOutputBytes) {
        const remain = Math.max(0, maxOutputBytes - capturedBytes);
        if (remain > 0) {
          stdout += Buffer.from(chunk, "utf8").subarray(0, remain).toString("utf8");
          capturedBytes += remain;
        }
        outputLimitExceeded = true;
        child.kill("SIGKILL");
        return;
      }
      capturedBytes += chunkBytes;
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      const chunkBytes = Buffer.byteLength(chunk, "utf8");
      if (capturedBytes + chunkBytes > maxOutputBytes) {
        const remain = Math.max(0, maxOutputBytes - capturedBytes);
        if (remain > 0) {
          stderr += Buffer.from(chunk, "utf8").subarray(0, remain).toString("utf8");
          capturedBytes += remain;
        }
        outputLimitExceeded = true;
        child.kill("SIGKILL");
        return;
      }
      capturedBytes += chunkBytes;
      stderr += chunk;
    });
    child.on("error", (err) => {
      fail(err);
    });
    child.on("close", (code) => {
      finish({ ok: code === 0 && !timedOut && !outputLimitExceeded, code, stdout, stderr, timedOut, outputLimitExceeded });
    });
  });
}
