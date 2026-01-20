import { runGit } from "./gitExec.js";

export type BranchRef = { name: string; sha: string };

export async function getOriginDefaultBranch(params: { mirrorPath: string; cwd: string }): Promise<string | null> {
  const res = await runGit(["-C", params.mirrorPath, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], {
    cwd: params.cwd
  });
  if (!res.ok) return null;
  const raw = res.stdout.trim();
  if (!raw) return null;
  if (raw === "origin/HEAD") return null;
  if (raw.startsWith("origin/")) return raw.slice("origin/".length);
  return raw;
}

export async function listHeadsBranches(params: { mirrorPath: string; cwd: string }): Promise<BranchRef[]> {
  const res = await runGit(
    ["-C", params.mirrorPath, "for-each-ref", "refs/remotes/origin", "--format=%(refname:short)\t%(objectname)"],
    { cwd: params.cwd }
  );
  if (!res.ok) {
    throw new Error(`Failed to list branches: ${(res.stderr || res.stdout).trim().replace(/\\s+/g, " ")}`);
  }

  return res.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, sha] = line.split("\t");
      if (!name || !sha) return null;
      if (name === "origin/HEAD") return null;
      if (name.startsWith("origin/")) return { name: name.slice("origin/".length), sha };
      return { name, sha };
    })
    .filter((x): x is BranchRef => Boolean(x));
}

export async function getOriginDefaultBranchFromRepo(params: { repoPath: string; cwd: string }): Promise<string | null> {
  const res = await runGit(["-C", params.repoPath, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], {
    cwd: params.cwd
  });
  if (!res.ok) return null;
  const raw = res.stdout.trim();
  if (!raw) return null;
  if (raw === "origin/HEAD") return null;
  if (raw.startsWith("origin/")) return raw.slice("origin/".length);
  return raw;
}

export async function listOriginBranchesFromRepo(params: { repoPath: string; cwd: string }): Promise<BranchRef[]> {
  const res = await runGit(
    ["-C", params.repoPath, "for-each-ref", "refs/remotes/origin", "--format=%(refname:short)\t%(objectname)"],
    { cwd: params.cwd }
  );
  if (!res.ok) {
    throw new Error(`Failed to list branches: ${(res.stderr || res.stdout).trim().replace(/\\s+/g, " ")}`);
  }

  return res.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, sha] = line.split("\t");
      if (!name || !sha) return null;
      if (name === "origin/HEAD") return null;
      if (name.startsWith("origin/")) return { name: name.slice("origin/".length), sha };
      return { name, sha };
    })
    .filter((x): x is BranchRef => Boolean(x));
}
