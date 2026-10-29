import fs from "node:fs/promises";
import path from "node:path";
import type { WorkspaceRecord } from "@agent-workbench/shared";
import type { AppContext } from "../../app/context.js";
import { HttpError } from "../../app/errors.js";
import { workspaceRoot } from "../../infra/fs/paths.js";

function under(root: string, candidate: string) {
  return candidate === root || candidate.startsWith(root + path.sep);
}

function segment(value: string) {
  return Boolean(value) && value !== "." && value !== ".." && path.basename(value) === value && !/[\\/\0\r\n]/.test(value);
}

async function readMetadataPath(file: string) {
  const st = await fs.lstat(file);
  if (!st.isFile() || st.size > 4096) throw new Error("Invalid Git metadata");
  return (await fs.readFile(file, "utf8")).trim();
}

/** Validate physical roots without launching another Git process for every status poll. */
export async function assertWorkspaceRepoSafe(
  ctx: Pick<AppContext, "dataDir">,
  ws: WorkspaceRecord,
  wsRepo: { dirName: string; path: string }
) {
  try {
    if (!segment(ws.dirName) || !segment(wsRepo.dirName)) throw new Error("Invalid path");
    const expectedWorkspace = path.resolve(workspaceRoot(ctx.dataDir, ws.dirName));
    const expectedRepo = path.join(expectedWorkspace, wsRepo.dirName);
    if (path.resolve(ws.path) !== expectedWorkspace || path.resolve(wsRepo.path) !== expectedRepo) throw new Error("Invalid path");
    const dataReal = await fs.realpath(ctx.dataDir);
    const workspaceReal = await fs.realpath(expectedWorkspace);
    const repoReal = await fs.realpath(expectedRepo);
    // A configured data root may itself be a symlink. Its owned descendants may not redirect elsewhere.
    if (workspaceReal !== path.join(dataReal, "workspaces", ws.dirName) || repoReal !== path.join(workspaceReal, wsRepo.dirName)) throw new Error("Invalid path");
    if (!(await fs.lstat(expectedWorkspace)).isDirectory() || !(await fs.lstat(expectedRepo)).isDirectory()) throw new Error("Invalid path");
    const allowedMetadata = [path.join(dataReal, "workspaces"), path.join(dataReal, "repos")];
    const logicalMetadata = [...allowedMetadata, path.resolve(ctx.dataDir, "workspaces"), path.resolve(ctx.dataDir, "repos")];
    const safeMetadataDirectory = async (candidate: string) => {
      if (!logicalMetadata.some((root) => under(root, path.resolve(candidate)))) throw new Error("Invalid Git metadata");
      const real = await fs.realpath(candidate);
      if (!allowedMetadata.some((root) => under(root, real)) || !(await fs.stat(real)).isDirectory()) throw new Error("Invalid Git metadata");
      return real;
    };
    const dotGit = path.join(repoReal, ".git");
    const dotGitStat = await fs.lstat(dotGit);
    let gitDir: string;
    if (dotGitStat.isDirectory()) gitDir = await safeMetadataDirectory(dotGit);
    else if (dotGitStat.isFile()) {
      const text = await readMetadataPath(dotGit);
      if (!text.startsWith("gitdir: ") || text.includes("\n") || text.includes("\0")) throw new Error("Invalid Git metadata");
      gitDir = await safeMetadataDirectory(path.resolve(repoReal, text.slice(8)));
    } else throw new Error("Invalid Git metadata");
    const commonFile = path.join(gitDir, "commondir");
    let commonDir = gitDir;
    try {
      commonDir = await safeMetadataDirectory(path.resolve(gitDir, await readMetadataPath(commonFile)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // A gitfile may identify an owned linked worktree, not borrow another repository's index.
    // Linked worktrees have both commondir and a matching back-link, checked below.
    if (dotGitStat.isFile() && commonDir === gitDir) throw new Error("Invalid Git metadata");
    // The index is private to this worktree (not commondir). Never borrow another
    // repository's index through a symlink; an unborn repository may have no index yet.
    const indexPath = path.join(gitDir, "index");
    try {
      const index = await fs.lstat(indexPath);
      if (!index.isFile() || index.isSymbolicLink() || await fs.realpath(indexPath) !== indexPath) throw new Error("Invalid Git index");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // These are Git's own repository-discovery prerequisites. Missing .git must never fall back to a parent repository.
    const head = await readMetadataPath(path.join(gitDir, "HEAD"));
    if (!/^(?:ref: refs\/[^\0\r\n]+|[0-9a-f]{40}|[0-9a-f]{64})$/.test(head)) throw new Error("Invalid Git metadata");
    await safeMetadataDirectory(path.join(commonDir, "refs"));
    const visited = new Set<string>();
    const checkObjects = async (candidate: string): Promise<void> => {
      const objects = await safeMetadataDirectory(candidate);
      if (visited.has(objects)) return;
      if (visited.size >= 16) throw new Error("Invalid Git metadata");
      visited.add(objects);
      try {
        const alternates = await readMetadataPath(path.join(objects, "info", "alternates"));
        for (const alternate of alternates.split("\n").filter(Boolean)) await checkObjects(path.resolve(objects, alternate));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    };
    await checkObjects(path.join(commonDir, "objects"));
    if (commonDir !== gitDir) {
      // A linked worktree's back-link identifies the worktree that owns this index/HEAD.
      const backLink = await readMetadataPath(path.join(gitDir, "gitdir"));
      const backLinkPath = path.resolve(gitDir, backLink);
      if (!logicalMetadata.some((root) => under(root, backLinkPath))) throw new Error("Invalid Git metadata");
      if (await fs.realpath(backLinkPath) !== dotGit) throw new Error("Invalid Git metadata");
    }
  } catch {
    // Do not include filesystem errors, which contain absolute paths.
    throw new HttpError(409, "Repository location or Git metadata is invalid", "GIT_TARGET_INVALID");
  }
}
