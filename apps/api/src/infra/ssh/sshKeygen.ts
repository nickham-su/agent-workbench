import { spawn } from "node:child_process";

export type ExecResult = {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
};

export async function runSshKeygen(
  args: string[],
  opts: { cwd: string; timeoutMs?: number } = { cwd: process.cwd() }
): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  return new Promise<ExecResult>((resolve) => {
    const child = spawn("ssh-keygen", args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env }
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

