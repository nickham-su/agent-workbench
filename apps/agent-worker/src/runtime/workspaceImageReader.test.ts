import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { readWorkspaceImage, WORKSPACE_IMAGE_MAX_BYTES, WorkspaceImageNotFoundError, WorkspaceImageTooLargeError } from "./workspaceImageReader.js";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function fixture(t: TestContext) {
  const base = await fs.mkdtemp(path.join(process.cwd(), "apps/agent-worker/.image-reader-test-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const workspacePath = path.join(base, "workspace");
  await fs.mkdir(path.join(workspacePath, "screens"), { recursive: true });
  await fs.writeFile(path.join(workspacePath, "screens/a.png"), png);
  return { base, workspacePath };
}

function notMissing(error: unknown) {
  assert.ok(error instanceof Error);
  assert.equal(error instanceof WorkspaceImageNotFoundError, false);
  return true;
}

for (const removed of ["file", "directory"] as const) {
  test(`Workspace image reader classifies a deleted ${removed} below a safe root`, async (t) => {
    const { workspacePath } = await fixture(t);
    const input = { workspacePath, path: "screens/a.png" };
    assert.deepEqual((await readWorkspaceImage(input)).bytes, png);
    await fs.rm(path.join(workspacePath, removed === "file" ? "screens/a.png" : "screens"), { recursive: true });
    await assert.rejects(readWorkspaceImage(input), (error: unknown) => {
      assert.ok(error instanceof WorkspaceImageNotFoundError);
      assert.equal(error.message, "Workspace image source does not exist");
      assert.equal(error.message.includes(workspacePath), false);
      return true;
    });
  });
}

test("Workspace image reader does not classify unsafe or invalid images as missing", async (t) => {
  const { workspacePath } = await fixture(t);
  await fs.symlink("absent.png", path.join(workspacePath, "screens/dangling.png"));
  await fs.symlink("screens", path.join(workspacePath, "linked"));
  await fs.mkdir(path.join(workspacePath, "screens/directory.png"));
  await fs.writeFile(path.join(workspacePath, "screens/invalid.png"), "not an image");
  await fs.writeFile(path.join(workspacePath, "not-a-directory"), "text");
  for (const imagePath of ["../missing.png", "screens/dangling.png", "linked/missing.png", "screens/directory.png", "screens/invalid.png", "not-a-directory/missing.png"]) {
    await assert.rejects(readWorkspaceImage({ workspacePath, path: imagePath }), notMissing);
  }
  await fs.rm(workspacePath, { recursive: true });
  await assert.rejects(readWorkspaceImage({ workspacePath, path: "screens/a.png" }), notMissing);
});

test("Workspace image reader checks pinned ancestors before reporting a missing entry", async (t) => {
  const { base, workspacePath } = await fixture(t);
  const screens = path.join(workspacePath, "screens");
  const replacement = path.join(base, "replacement");
  await fs.mkdir(replacement);
  const originalOpen = fs.open.bind(fs);
  let injected = false;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]).endsWith("/missing.png")) {
      injected = true;
      await fs.rename(screens, `${screens}.old`);
      await fs.symlink(replacement, screens);
    }
    return originalOpen(...args);
  });
  await assert.rejects(readWorkspaceImage({ workspacePath, path: "screens/missing.png" }), notMissing);
  assert.equal(injected, true);
});

test("Workspace image reader accepts exactly 10 MiB and classifies only larger safe files as oversized", async (t) => {
  const { workspacePath } = await fixture(t);
  const input = { workspacePath, path: "screens/a.png" };
  const imagePath = path.join(workspacePath, input.path);
  await fs.truncate(imagePath, WORKSPACE_IMAGE_MAX_BYTES);
  assert.equal((await readWorkspaceImage(input)).bytes.byteLength, WORKSPACE_IMAGE_MAX_BYTES);
  await fs.truncate(imagePath, WORKSPACE_IMAGE_MAX_BYTES + 1);
  await assert.rejects(readWorkspaceImage(input), (error: unknown) => {
    assert.ok(error instanceof WorkspaceImageTooLargeError);
    assert.equal(error.message, "Workspace image exceeds 10 MiB");
    assert.equal(error.message.includes(workspacePath), false);
    return true;
  });
});

test("Workspace image reader does not classify oversized symlinks or replaced ancestors as oversized", async (t) => {
  const { base, workspacePath } = await fixture(t);
  const imagePath = path.join(workspacePath, "screens/a.png");
  await fs.truncate(imagePath, WORKSPACE_IMAGE_MAX_BYTES + 1);
  const notOversized = (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error instanceof WorkspaceImageTooLargeError, false);
    return true;
  };
  await fs.symlink("a.png", path.join(workspacePath, "screens/link.png"));
  await assert.rejects(readWorkspaceImage({ workspacePath, path: "screens/link.png" }), notOversized);
  const screens = path.join(workspacePath, "screens");
  const replacement = path.join(base, "replacement");
  await fs.mkdir(replacement);
  const originalOpen = fs.open.bind(fs);
  let injected = false;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).endsWith("/a.png")) {
      injected = true;
      await fs.rename(screens, `${screens}.old`);
      await fs.symlink(replacement, screens);
    }
    return handle;
  });
  await assert.rejects(readWorkspaceImage({ workspacePath, path: "screens/a.png" }), notOversized);
  assert.equal(injected, true);
});
