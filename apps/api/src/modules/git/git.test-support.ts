import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import type { AppContext } from "../../app/context.js";
import { openDb } from "../../infra/db/db.js";
import { insertRepo } from "../repos/repo.store.js";
import { insertWorkspace, insertWorkspaceRepo } from "../workspaces/workspace.store.js";

export async function createGitFixture(t: TestContext, count = 1, fakeGit = true) {
  const root = fileURLToPath(new URL("../../../../../.tmp-tests/git-status/", import.meta.url));
  await fs.mkdir(root, { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(root, "fixture-"));
  const db = await openDb(dataDir);
  t.after(async () => { db.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const workspaceId = "workspace_test";
  const workspacePath = path.join(dataDir, "workspaces", workspaceId);
  await fs.mkdir(workspacePath, { recursive: true });
  const now = Date.now();
  insertWorkspace(db, { id: workspaceId, dirName: workspaceId, title: "Test", path: workspacePath, terminalCredentialId: null, createdAt: now, updatedAt: now });
  const ctx = { db, dataDir, fileMaxBytes: 1024 * 1024 } as AppContext;
  const paths: string[] = [];
  for (let index = 0; index < count; index++) {
    const dirName = `repo-${index}`;
    const repoPath = path.join(workspacePath, dirName);
    paths.push(repoPath);
    await fs.mkdir(repoPath, { recursive: true });
    if (fakeGit) {
      await fs.mkdir(path.join(repoPath, ".git", "objects"), { recursive: true });
      await fs.mkdir(path.join(repoPath, ".git", "refs"), { recursive: true });
      await fs.writeFile(path.join(repoPath, ".git", "HEAD"), "ref: refs/heads/main\n");
    }
    insertRepo(db, { id: `r_${index}`, url: `https://example.test/${dirName}.git`, credentialId: null, defaultBranch: "main", mirrorPath: path.join(dataDir, "repos", `r_${index}`, "mirror.git"), syncStatus: "idle", syncError: null, lastSyncAt: now, createdAt: now, updatedAt: now });
    insertWorkspaceRepo(db, { workspaceId, repoId: `r_${index}`, dirName, path: repoPath, createdAt: now, updatedAt: now });
  }
  return { ctx, workspaceId, workspacePath, paths };
}
