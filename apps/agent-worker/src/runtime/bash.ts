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

    // POSIX: detached=true creates a new process group so we can kill the entire command tree.
    // Windows: detached does not give us killpg semantics; we use taskkill to kill the process tree.
    const child = spawn("bash", ["-lc", params.command], {
      cwd: params.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      detached: process.platform !== "win32"
    });

    let stdout = "";
    let stderr = "";
    let capturedBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let settled = false;
    let terminating = false;

    let exitCode: number | null = null;
    let settleAfterExitTimer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;

    const clearSettleAfterExitTimer = () => {
      if (!settleAfterExitTimer) return;
      clearTimeout(settleAfterExitTimer);
      settleAfterExitTimer = null;
    };

    const clearKillTimer = () => {
      if (!killTimer) return;
      clearTimeout(killTimer);
      killTimer = null;
    };

    const destroyStreams = () => {
      // If grandchildren inherit stdio fds, Node may never emit "close".
      // Destroy streams so we can settle after "exit".
      try {
        child.stdout?.destroy();
      } catch {
        // ignore
      }
      try {
        child.stderr?.destroy();
      } catch {
        // ignore
      }
    };

    const tryKillProcessTree = (signal: NodeJS.Signals) => {
      const pid = child.pid;
      if (!pid) return;

      if (process.platform === "win32") {
        // Windows has no killpg semantics.
        // Best-effort approach:
        // - For SIGTERM: terminate the direct child.
        // - For SIGKILL: use taskkill to terminate the whole process tree; if taskkill fails, fall back to child.kill.
        if (signal !== "SIGKILL") {
          try {
            child.kill(signal);
          } catch {
            // ignore
          }
          return;
        }

        const fallback = () => {
          try {
            child.kill(signal);
          } catch {
            // ignore
          }
        };

        let spawned = false;
        try {
          const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true
          });
          spawned = true;
          killer.once("error", () => fallback());
          killer.once("exit", (code) => {
            if ((code ?? 0) !== 0) fallback();
          });
          killer.unref();
        } catch {
          // ignore
        }
        if (!spawned) fallback();
        return;
      }

      // POSIX: kill process group (negative pid).
      try {
        process.kill(-pid, signal);
      } catch {
        // Fallback: kill the direct child.
        try {
          child.kill(signal);
        } catch {
          // ignore
        }
      }
    };

    const terminate = (reason: "timeout" | "abort" | "output_limit") => {
      if (reason === "timeout") {
        timedOut = true;
      }

      if (settled) return;
      if (terminating) return;
      terminating = true;

      // No need to keep the outer timeout timer around once termination begins.
      clearTimeout(timer);

      // Try graceful termination first, then hard kill.
      tryKillProcessTree("SIGTERM");

      const graceMs = 200;
      if (killTimer) return;
      killTimer = setTimeout(() => {
        tryKillProcessTree("SIGKILL");
        destroyStreams();
      }, graceMs);
      killTimer.unref?.();
    };

    const finish = (value: BashRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearSettleAfterExitTimer();
      clearKillTimer();
      params.signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };

    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearSettleAfterExitTimer();
      clearKillTimer();
      params.signal?.removeEventListener("abort", onAbort);
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const timer = setTimeout(() => {
      terminate("timeout");
    }, params.timeoutMs);

    const onAbort = () => {
      terminate("abort");
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
        terminate("output_limit");
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
        terminate("output_limit");
        return;
      }
      capturedBytes += chunkBytes;
      stderr += chunk;
    });

    child.on("error", (err) => {
      fail(err);
    });

    child.on("exit", (code) => {
      exitCode = code;
      // "close" may never fire if descendants inherited stdio fds.
      // Settle shortly after exit as a safety net.
      if (!settleAfterExitTimer) {
        const delayMs = terminating ? 250 : 1500;
        settleAfterExitTimer = setTimeout(() => {
          destroyStreams();
          finish({
            ok: exitCode === 0 && !timedOut && !outputLimitExceeded,
            code: exitCode,
            stdout,
            stderr,
            timedOut,
            outputLimitExceeded
          });
        }, delayMs);
        settleAfterExitTimer.unref?.();
      }
    });

    child.on("close", (code) => {
      // Prefer close for complete stdout/stderr capture.
      clearSettleAfterExitTimer();
      clearKillTimer();
      finish({
        ok: code === 0 && !timedOut && !outputLimitExceeded,
        code,
        stdout,
        stderr,
        timedOut,
        outputLimitExceeded
      });
    });
  });
}
