import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  assertPreviewRawUrlPath,
  createPreviewFileService,
  type PreviewFileError,
  type PreviewFileSystem,
  type PreviewFileStat
} from "./preview-file.service.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => await fs.rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "awb-preview-file-"));
  tempDirs.push(root);
  await fs.writeFile(path.join(root, "index.html"), "<h1>root</h1>");
  await fs.mkdir(path.join(root, "pages"));
  await fs.writeFile(path.join(root, "pages", "index.html"), "<h1>page</h1>");
  await fs.writeFile(path.join(root, "pages", "styles.css"), "body{}");
  await fs.writeFile(path.join(root, "unsupported.json"), "{}");
  const service = createPreviewFileService({ getWorkspaceById: (workspaceId) => workspaceId === "ws" ? { id: "ws", path: root } : null });
  return { root, service };
}

function assertFailure(error: unknown, failure: string) {
  assert.equal((error as PreviewFileError).failure, failure);
  return true;
}

test("resolves workspace files and directory index files without repo dispatch", async () => {
  const { service } = await fixture();
  const root = await service.resolve({ workspaceId: "ws", decodedPath: "", trailingSlash: true });
  assert.equal(root.kind, "file");
  if (root.kind !== "file") throw new Error("expected file");
  assert.equal(root.relativePath, "index.html");
  assert.equal(root.resource.mime, "text/html; charset=utf-8");

  const redirect = await service.resolve({ workspaceId: "ws", decodedPath: "pages", trailingSlash: false });
  assert.deepEqual(redirect, { kind: "redirect", relativePath: "pages" });
  const nested = await service.resolve({ workspaceId: "ws", decodedPath: "pages/", trailingSlash: true });
  assert.equal(nested.kind, "file");
  if (nested.kind !== "file") throw new Error("expected file");
  assert.equal(nested.relativePath, "pages/index.html");

  await assert.rejects(
    service.resolve({ workspaceId: "ws", decodedPath: "missing", trailingSlash: true }),
    (error) => assertFailure(error, "path_missing")
  );
  assert.deepEqual(
    await service.resolve({ workspaceId: "ws", decodedPath: "", trailingSlash: false }),
    { kind: "redirect", relativePath: "" }
  );

  const noIndex = await fixture();
  await fs.rm(path.join(noIndex.root, "index.html"));
  await assert.rejects(
    noIndex.service.resolve({ workspaceId: "ws", decodedPath: "", trailingSlash: true }),
    (error) => assertFailure(error, "path_missing")
  );
});

test("rejects denylisted segments, unsupported resources, and path escapes", async () => {
  const { root, service } = await fixture();
  await fs.mkdir(path.join(root, ".GiT"));
  await fs.writeFile(path.join(root, ".GiT", "index.html"), "blocked");
  await fs.mkdir(path.join(root, ".AwB"));
  await fs.writeFile(path.join(root, ".AwB", "index.html"), "blocked");
  await fs.mkdir(path.join(root, ".git-not-denied"));
  await fs.writeFile(path.join(root, ".git-not-denied", "index.html"), "allowed");

  for (const decodedPath of [".git/index.html", ".GIT/index.html", ".awb/index.html", ".AwB/index.html"]) {
    await assert.rejects(service.resolve({ workspaceId: "ws", decodedPath, trailingSlash: true }), (error) => assertFailure(error, "denied_segment"));
  }
  const allowed = await service.resolve({ workspaceId: "ws", decodedPath: ".git-not-denied/index.html", trailingSlash: true });
  assert.equal(allowed.kind, "file");
  await assert.rejects(service.resolve({ workspaceId: "ws", decodedPath: "unsupported.json", trailingSlash: true }), (error) => assertFailure(error, "unsupported_type"));
  await assert.rejects(service.resolve({ workspaceId: "ws", decodedPath: "../outside.html", trailingSlash: true }), (error) => assertFailure(error, "path_escape"));
  await assert.rejects(service.resolve({ workspaceId: "missing", decodedPath: "index.html", trailingSlash: true }), (error) => assertFailure(error, "workspace_missing"));
});

test("rejects symlink targets, symlink ancestors, and symlinks escaping the workspace", async (t) => {
  const { root, service } = await fixture();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "awb-preview-outside-"));
  tempDirs.push(outside);
  await fs.writeFile(path.join(outside, "outside.html"), "outside");
  try {
    await fs.symlink(path.join(root, "pages", "index.html"), path.join(root, "inside-link.html"));
    await fs.symlink(path.join(outside, "outside.html"), path.join(root, "outside-link.html"));
    await fs.symlink(path.join(root, "pages"), path.join(root, "linked-pages"));
  } catch (error: any) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip("symbolic links are unavailable in this environment");
      return;
    }
    throw error;
  }

  for (const decodedPath of ["inside-link.html", "outside-link.html", "linked-pages/index.html"]) {
    await assert.rejects(service.resolve({ workspaceId: "ws", decodedPath, trailingSlash: true }), (error) => assertFailure(error, "symlink"));
  }
});

test("raw URL and decoded path validation rejects separator ambiguities without a second decode", async () => {
  for (const rawUrl of ["/s/session/%2fetc", "/s/session/%2Fetc", "/s/session/%5cetc", "/s/session/%5Cetc"]) {
    assert.throws(() => assertPreviewRawUrlPath(rawUrl), (error) => assertFailure(error, "encoded_separator"));
  }
  for (const rawUrl of ["/s/session/%", "/s/session/%2", "/s/session/%xz"]) {
    assert.throws(() => assertPreviewRawUrlPath(rawUrl), (error) => assertFailure(error, "invalid_path"));
  }
  assert.doesNotThrow(() => assertPreviewRawUrlPath("/s/session/%252fetc?ignored=1"));

  const { service } = await fixture();
  for (const decodedPath of ["pages\\index.html", "pages\0index.html", "pages\nindex.html", "pages\rindex.html"]) {
    await assert.rejects(service.resolve({ workspaceId: "ws", decodedPath, trailingSlash: true }), (error) => assertFailure(error, "invalid_path"));
  }
  await assert.rejects(service.resolve({ workspaceId: "ws", decodedPath: "%2fetc", trailingSlash: true }), (error) => assertFailure(error, "path_missing"));
});

test("rejects special files where the platform supports FIFO creation", async (t) => {
  if (process.platform === "win32") {
    t.skip("FIFO fixtures are not supported on Windows");
    return;
  }
  const { root, service } = await fixture();
  const fifo = path.join(root, "pipe.mp3");
  const result = await new Promise<{ code: number | null }>((resolve, reject) => {
    const child = process.getuid?.() === undefined ? null : spawn("mkfifo", [fifo]);
    if (!child) return reject(new Error("mkfifo unavailable"));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code }));
  }).catch((error: any) => {
    if (error?.code === "ENOENT" || error?.code === "EACCES") return null;
    throw error;
  });
  if (!result || result.code !== 0) {
    t.skip("mkfifo is unavailable in this environment");
    return;
  }
  await assert.rejects(service.resolve({ workspaceId: "ws", decodedPath: "pipe.mp3", trailingSlash: true }), (error) => assertFailure(error, "not_regular"));
});

test("open revalidates the descriptor and rejects a controlled TOCTOU swap", async () => {
  const { root, service } = await fixture();
  const target = await service.resolve({ workspaceId: "ws", decodedPath: "index.html", trailingSlash: true });
  if (target.kind !== "file") throw new Error("expected file");

  const realHandle = await fs.open(path.join(root, "index.html"), "r");
  const realStat = await realHandle.stat();
  await realHandle.close();
  const fakeStat = { ...realStat, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, dev: realStat.dev + 1, ino: realStat.ino + 1 } as PreviewFileStat;
  let closeCalls = 0;
  const fileSystem: PreviewFileSystem = {
    lstat: async (filePath) => await fs.lstat(filePath),
    realpath: async (filePath) => await fs.realpath(filePath),
    open: async () => ({ fd: 42, stat: async () => fakeStat, close: async () => { closeCalls += 1; } })
  };
  const controlled = createPreviewFileService({ getWorkspaceById: () => ({ id: "ws", path: root }), fileSystem });
  const controlledTarget = await controlled.resolve({ workspaceId: "ws", decodedPath: "index.html", trailingSlash: true });
  if (controlledTarget.kind !== "file") throw new Error("expected file");
  await assert.rejects(controlled.open(controlledTarget), (error) => assertFailure(error, "changed_during_open"));
  assert.equal(closeCalls, 1);

  const opened = await service.open(target);
  assert.equal(opened.stat.isFile(), true);
  await opened.handle.close();
});

test("open rejects a target replaced by a symlink after resolution", async (t) => {
  const { root, service } = await fixture();
  const target = await service.resolve({ workspaceId: "ws", decodedPath: "index.html", trailingSlash: true });
  if (target.kind !== "file") throw new Error("expected file");

  const replacement = path.join(root, "replacement.html");
  await fs.writeFile(replacement, "replacement");
  await fs.rm(path.join(root, "index.html"));
  try {
    await fs.symlink(replacement, path.join(root, "index.html"));
  } catch (error: any) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip("symbolic links are unavailable in this environment");
      return;
    }
    throw error;
  }

  await assert.rejects(service.open(target), (error) => assertFailure(error, "symlink"));
});
