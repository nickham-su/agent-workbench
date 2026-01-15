import path from "node:path";
import { ensureDir, rmrf } from "../fs/fs.js";
import { runGit } from "./gitExec.js";

export async function cloneFromMirror(params: {
  mirrorPath: string;
  repoUrl: string;
  worktreePath: string;
  branch: string;
  dataDir: string;
}) {
  await ensureDir(path.dirname(params.worktreePath));
  // 注意：mirror 是一个 bare repo，但它存的是 refs/remotes/origin/*（而不是 refs/heads/*）。
  // 直接 `git clone <mirror>` 会因为 mirror 缺少 refs/heads 而克隆不出任何远端分支。
  // 这里改为 init + fetch，把 mirror 里的 refs 映射成标准的 origin/* 远端分支，然后再切分支。
  const init = await runGit(["init", params.worktreePath], { cwd: params.dataDir });
  if (!init.ok) {
    await rmrf(params.worktreePath);
    throw new Error(`git init failed: ${(init.stderr || init.stdout).trim().replace(/\\s+/g, " ")}`);
  }

  const addRemote = await runGit(["-C", params.worktreePath, "remote", "add", "origin", params.mirrorPath], {
    cwd: params.dataDir
  });
  if (!addRemote.ok) {
    await rmrf(params.worktreePath);
    throw new Error(`git remote add failed: ${(addRemote.stderr || addRemote.stdout).trim().replace(/\\s+/g, " ")}`);
  }

  // 兼容两种 mirror 形态：
  // - refs/heads/*（未来可能调整为更“镜像”的 bare heads）
  // - refs/remotes/origin/*（当前实现：fetch 到 remotes/origin）
  const fetch = await runGit(
    [
      "-C",
      params.worktreePath,
      "fetch",
      "--prune",
      "--tags",
      "origin",
      "+refs/heads/*:refs/remotes/origin/*",
      "+refs/remotes/origin/*:refs/remotes/origin/*"
    ],
    { cwd: params.dataDir }
  );
  if (!fetch.ok) {
    await rmrf(params.worktreePath);
    throw new Error(`git fetch from mirror failed: ${(fetch.stderr || fetch.stdout).trim().replace(/\\s+/g, " ")}`);
  }

  const remoteRef = `origin/${params.branch}`;
  const checkout = await runGit(["-C", params.worktreePath, "checkout", "-b", params.branch, "--track", remoteRef], {
    cwd: params.dataDir
  });
  if (!checkout.ok) {
    await rmrf(params.worktreePath);
    throw new Error(`git checkout failed: ${(checkout.stderr || checkout.stdout).trim().replace(/\\s+/g, " ")}`);
  }

  // 切回真正的远端地址，并恢复标准 fetch 规则（从远端 refs/heads/* 拉取到本地 origin/*）。
  const setUrl = await runGit(["-C", params.worktreePath, "remote", "set-url", "origin", params.repoUrl], {
    cwd: params.dataDir
  });
  if (!setUrl.ok) {
    await rmrf(params.worktreePath);
    throw new Error(`git remote set-url failed: ${(setUrl.stderr || setUrl.stdout).trim().replace(/\\s+/g, " ")}`);
  }

  await runGit(["-C", params.worktreePath, "config", "--unset-all", "remote.origin.fetch"], { cwd: params.dataDir });
  const addFetch = await runGit(["-C", params.worktreePath, "config", "--add", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"], {
    cwd: params.dataDir
  });
  if (!addFetch.ok) {
    await rmrf(params.worktreePath);
    throw new Error(`git config remote.origin.fetch failed: ${(addFetch.stderr || addFetch.stdout).trim().replace(/\\s+/g, " ")}`);
  }
}
