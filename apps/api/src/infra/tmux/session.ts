import { runTmux } from "./tmuxExec.js";

export type TmuxSessionPresence = "exists" | "not_found";

export function classifyTmuxHasSessionResult(result: { ok: boolean; code: number | null; stdout: string; stderr: string; timedOut: boolean }): TmuxSessionPresence {
  if (result.ok) return "exists";
  const output = `${result.stderr}\n${result.stdout}`.toLowerCase();
  // tmux 对不存在 session 的已定义结果；其它非零（spawn、timeout、server 异常）不可伪装为不存在。
  if (!result.timedOut && result.code === 1 && /can't find session|no server running|no sessions/.test(output)) {
    return "not_found";
  }
  throw new Error(`tmux has-session indeterminate: ${result.timedOut ? "timeout" : output.trim() || `exit ${result.code}`}`);
}

export async function tmuxHasSession(params: { sessionName: string; cwd: string }) {
  const res = await runTmux(["has-session", "-t", params.sessionName], { cwd: params.cwd });
  return classifyTmuxHasSessionResult(res);
}

export async function tmuxCountClients(params: { sessionName: string; cwd: string }) {
  const res = await runTmux(["list-clients", "-t", params.sessionName], { cwd: params.cwd });
  if (!res.ok) return 0;
  const lines = res.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length;
}

export async function tmuxNewSession(params: { sessionName: string; cwd: string; command: string[] }) {
  const res = await runTmux(["new-session", "-d", "-s", params.sessionName, "-c", params.cwd, ...params.command], { cwd: params.cwd });
  if (!res.ok) {
    throw new Error(`tmux new-session failed: ${(res.stderr || res.stdout).trim().replace(/\\s+/g, " ")}`);
  }

  // 仅对本 session 关闭 status line（避免在终端底部占一行），不影响用户其他 tmux 会话
  await runTmux(["set-option", "-t", params.sessionName, "status", "off"], { cwd: params.cwd });
  // 仅对本 session 开启 mouse，允许滚轮进入 tmux copy-mode 实现“滚动 tmux 内容”
  await runTmux(["set-option", "-t", params.sessionName, "mouse", "on"], { cwd: params.cwd });
}

export async function tmuxKillSession(params: { sessionName: string; cwd: string }) {
  const res = await runTmux(["kill-session", "-t", params.sessionName], { cwd: params.cwd });
  if (!res.ok) {
    throw new Error(`tmux kill-session failed: ${(res.stderr || res.stdout).trim().replace(/\\s+/g, " ")}`);
  }
}
