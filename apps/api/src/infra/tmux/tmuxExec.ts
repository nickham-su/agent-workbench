import { spawn } from "node:child_process";

export type ExecResult = {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
};

export async function runTmux(
  args: string[],
  opts: { cwd: string; timeoutMs?: number } = { cwd: process.cwd() }
): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  return new Promise<ExecResult>((resolve) => {
    const env = { ...process.env };
    // 避免在用户本机 tmux 内运行时发生“嵌套 tmux”相关行为
    delete (env as any).TMUX;
    const child = spawn("tmux", args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env
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
