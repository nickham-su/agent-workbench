import { ensureDir, pathExists } from "../fs/fs.js";
import { repoRoot } from "../fs/paths.js";
import { runGit } from "./gitExec.js";

export async function ensureRepoMirror(params: {
  repoId: string;
  url: string;
  dataDir: string;
  mirrorPath: string;
  env?: NodeJS.ProcessEnv;
}) {
  await ensureDir(repoRoot(params.dataDir, params.repoId));

  const exists = await pathExists(params.mirrorPath);
  if (!exists) {
    const initRes = await runGit(["init", "--bare", params.mirrorPath], { cwd: params.dataDir, env: params.env });
    if (!initRes.ok) throw new Error(`git init --bare failed: ${(initRes.stderr || initRes.stdout).trim().replace(/\\s+/g, " ")}`);

    const addRes = await runGit(["-C", params.mirrorPath, "remote", "add", "origin", params.url], { cwd: params.dataDir, env: params.env });
    if (!addRes.ok) throw new Error(`git remote add origin failed: ${(addRes.stderr || addRes.stdout).trim().replace(/\\s+/g, " ")}`);
  }

  const setUrlRes = await runGit(["-C", params.mirrorPath, "remote", "set-url", "origin", params.url], { cwd: params.dataDir, env: params.env });
  if (!setUrlRes.ok) {
    const addRes = await runGit(["-C", params.mirrorPath, "remote", "add", "origin", params.url], { cwd: params.dataDir, env: params.env });
    if (!addRes.ok) throw new Error(`git remote add origin failed: ${(addRes.stderr || addRes.stdout).trim().replace(/\\s+/g, " ")}`);
  }

  const fetchRes = await runGit(["-C", params.mirrorPath, "fetch", "--prune", "origin", "+refs/heads/*:refs/remotes/origin/*"], {
    cwd: params.dataDir,
    env: params.env
  });
  if (!fetchRes.ok) {
    throw new Error(`git fetch failed: ${(fetchRes.stderr || fetchRes.stdout).trim().replace(/\\s+/g, " ")}`);
  }

  // 尽量设置 origin/HEAD 以便解析默认分支；失败则降级为 null，由前端做 main/master 等启发式。
  await runGit(["-C", params.mirrorPath, "remote", "set-head", "origin", "-a"], { cwd: params.dataDir, env: params.env });
}
