import { spawn } from "node:child_process";

export type ExecResult = {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
};

export type ExecBufferResult = {
  ok: boolean;
  code: number | null;
  stdout: Buffer;
  stderr: string;
};

export async function runGit(
  args: string[],
  opts: { cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = { cwd: process.cwd() }
): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  return new Promise<ExecResult>((resolve) => {
    const child = spawn("git", args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(opts.env ?? {}) }
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);

    let settled = false;
    const settle = (res: ExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", (err) => {
      settle({ ok: false, code: null, stdout, stderr: (stderr || "") + String(err instanceof Error ? err.message : err) });
    });
    child.on("close", (code) => {
      settle({ ok: code === 0, code, stdout, stderr });
    });
  });
}

export async function runGitBuffer(
  args: string[],
  opts: { cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = { cwd: process.cwd() }
): Promise<ExecBufferResult> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  return new Promise<ExecBufferResult>((resolve) => {
    const child = spawn("git", args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(opts.env ?? {}) }
    });

    const stdoutChunks: Buffer[] = [];
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);

    let settled = false;
    const settle = (res: ExecBufferResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    };

    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", (err) => {
      settle({
        ok: false,
        code: null,
        stdout: Buffer.concat(stdoutChunks),
        stderr: (stderr || "") + String(err instanceof Error ? err.message : err)
      });
    });
    child.on("close", (code) => {
      settle({ ok: code === 0, code, stdout: Buffer.concat(stdoutChunks), stderr });
    });
  });
}
