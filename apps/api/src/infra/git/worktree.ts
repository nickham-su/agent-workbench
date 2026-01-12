import { ensureDir, rmrf } from "../fs/fs.js";
import { runGit } from "./gitExec.js";

export async function createWorktree(params: { mirrorPath: string; worktreePath: string; branch: string; dataDir: string }) {
  await ensureDir(params.worktreePath);
  const remoteRef = `origin/${params.branch}`;
  const detached = await runGit(["-C", params.mirrorPath, "worktree", "add", params.worktreePath, remoteRef], { cwd: params.dataDir });
  if (!detached.ok) {
    await rmrf(params.worktreePath);
    throw new Error(`git worktree add failed: ${(detached.stderr || detached.stdout).trim().replace(/\\s+/g, " ")}`);
  }

  const checkout = await runGit(["-C", params.worktreePath, "switch", "-c", params.branch, "--track", remoteRef], { cwd: params.dataDir });
  if (!checkout.ok) {
    const cleanup = await runGit(["-C", params.mirrorPath, "worktree", "remove", "--force", params.worktreePath], { cwd: params.dataDir });
    if (!cleanup.ok) await rmrf(params.worktreePath);
    throw new Error(`git worktree add failed: ${(checkout.stderr || checkout.stdout).trim().replace(/\\s+/g, " ")}`);
  }
}

export async function removeWorktree(params: { mirrorPath: string; worktreePath: string; dataDir: string }) {
  const res = await runGit(["-C", params.mirrorPath, "worktree", "remove", "--force", params.worktreePath], { cwd: params.dataDir });
  if (!res.ok) {
    // 兜底：即使 git 侧元数据清理失败，也尽量删除目录避免占用空间
    await rmrf(params.worktreePath);
    throw new Error(`git worktree remove failed: ${(res.stderr || res.stdout).trim().replace(/\\s+/g, " ")}`);
  }
}

export async function switchWorktreeBranch(params: { worktreePath: string; branch: string; dataDir: string }) {
  const res = await runGit(["-C", params.worktreePath, "switch", params.branch], { cwd: params.dataDir });
  if (res.ok) return;

  const remoteRef = `origin/${params.branch}`;
  const create = await runGit(["-C", params.worktreePath, "switch", "-c", params.branch, "--track", remoteRef], { cwd: params.dataDir });
  if (!create.ok) {
    throw new Error(`git switch failed: ${(create.stderr || create.stdout || res.stderr || res.stdout).trim().replace(/\\s+/g, " ")}`);
  }
}
