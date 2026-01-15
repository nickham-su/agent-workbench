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
  const clone = await runGit(["clone", "--no-hardlinks", "--no-checkout", params.mirrorPath, params.worktreePath], {
    cwd: params.dataDir
  });
  if (!clone.ok) {
    await rmrf(params.worktreePath);
    throw new Error(`git clone failed: ${(clone.stderr || clone.stdout).trim().replace(/\\s+/g, " ")}`);
  }

  const remoteRef = `origin/${params.branch}`;
  const checkout = await runGit(
    ["-C", params.worktreePath, "checkout", "-b", params.branch, "--track", remoteRef],
    { cwd: params.dataDir }
  );
  if (!checkout.ok) {
    await rmrf(params.worktreePath);
    throw new Error(`git checkout failed: ${(checkout.stderr || checkout.stdout).trim().replace(/\\s+/g, " ")}`);
  }

  const setUrl = await runGit(["-C", params.worktreePath, "remote", "set-url", "origin", params.repoUrl], {
    cwd: params.dataDir
  });
  if (!setUrl.ok) {
    await rmrf(params.worktreePath);
    throw new Error(`git remote set-url failed: ${(setUrl.stderr || setUrl.stdout).trim().replace(/\\s+/g, " ")}`);
  }
}
