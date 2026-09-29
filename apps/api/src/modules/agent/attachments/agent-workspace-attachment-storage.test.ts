import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { renameSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import {
  AgentAttachmentCommitError,
  prepareAgentWorkspaceAttachmentPublication,
  removeAgentWorkspaceAttachmentFinalFile,
  resolveSafeWorkspaceAgentAttachment,
  stageAgentImageUpload,
} from "./agent-attachment-storage.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

async function fixture(t: test.TestContext) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "awb-workspace-attachment-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const workspaceDirName = "ws_test";
  const workspacePath = path.join(dataDir, "workspaces", workspaceDirName);
  await fs.mkdir(workspacePath, { recursive: true });
  const upload = async (attachmentId: string, tempId: string) => stageAgentImageUpload({
    dataDir, tempId, attachmentId, filename: "user/../original.gif",
    stream: Readable.from([PNG]), onBytes: () => undefined,
  });
  return { dataDir, workspaceDirName, workspacePath, upload };
}

async function publishForTest(input: Parameters<typeof prepareAgentWorkspaceAttachmentPublication>[0]) {
  const publication = await prepareAgentWorkspaceAttachmentPublication(input);
  try {
    publication.checkAvailable();
    return publication.publish();
  } finally {
    await publication.close();
  }
}

test("Workspace attachment commit uses a pinned hard link and returns only its own inode for rollback", async (t) => {
  const data = await fixture(t);
  const image = await data.upload("att_valid", "tmp_valid");
  assert.equal(image.storageKey, "att_valid.png");
  const input = { dataDir: data.dataDir, workspaceDirName: data.workspaceDirName, ...image };
  const owned = await publishForTest(input);
  const finalPath = path.join(data.workspacePath, ".awb/agent/attachments", image.storageKey);
  assert.deepEqual(await fs.readFile(finalPath), PNG);
  assert.equal(await fs.stat(finalPath).then((stat) => stat.ino), owned.ino);
  const resolved = await resolveSafeWorkspaceAgentAttachment({ ...input, expectedByteSize: PNG.length });
  assert.ok(resolved);
  assert.equal(resolved.filePath, finalPath);
  await resolved.handle.close();
  await fs.rename(finalPath, `${finalPath}.parked`);
  await fs.writeFile(finalPath, Buffer.from("different user's file"));
  await assert.rejects(() => removeAgentWorkspaceAttachmentFinalFile({ ...input, owned }), /retained/);
  assert.equal(await fs.readFile(finalPath, "utf8"), "different user's file");
});

test("rollback never renames or unlinks Workspace names, including a replaced private deletion slot", async (t) => {
  const data = await fixture(t);
  const image = await data.upload("att_window", "tmp_window");
  const input = { dataDir: data.dataDir, workspaceDirName: data.workspaceDirName, ...image };
  const owned = await publishForTest(input);
  const directory = path.join(data.workspacePath, ".awb/agent/attachments");
  const final = path.join(directory, image.storageKey);
  const slot = path.join(directory, ".delete-att_window-slot");
  // A same-UID tool can replace either pathname after the last identity check,
  // even in a 0700 directory. This test must not rely on winning a timer race.
  await fs.rename(final, `${final}.parked`);
  await fs.writeFile(final, "foreign final");
  await fs.writeFile(slot, "foreign slot");
  await assert.rejects(() => removeAgentWorkspaceAttachmentFinalFile({ ...input, owned }), /retained/);
  assert.equal(await fs.readFile(final, "utf8"), "foreign final");
  assert.equal(await fs.readFile(slot, "utf8"), "foreign slot");
  assert.deepEqual(await fs.readFile(`${final}.parked`), PNG);
  await fs.rename(`${final}.parked`, final);
  await assert.rejects(() => removeAgentWorkspaceAttachmentFinalFile({ ...input, owned }), /retained/);
  assert.deepEqual(await fs.readFile(final), PNG);
  assert.equal(await fs.readFile(slot, "utf8"), "foreign slot");
});

test("prepared publisher does not overwrite a name occupied after async preparation", async (t) => {
  const data = await fixture(t);
  const image = await data.upload("att_prepared-conflict", "tmp_prepared-conflict");
  const input = { dataDir: data.dataDir, workspaceDirName: data.workspaceDirName, ...image };
  const publication = await prepareAgentWorkspaceAttachmentPublication(input);
  try {
    const final = path.join(data.workspacePath, ".awb/agent/attachments", image.storageKey);
    await fs.writeFile(final, "foreign final");
    assert.throws(() => publication.checkAvailable(), /occupied/);
    assert.throws(() => publication.publish(), (error: unknown) => error instanceof AgentAttachmentCommitError && !error.finalCreated);
    assert.equal(await fs.readFile(final, "utf8"), "foreign final");
  } finally {
    await publication.close();
  }
});

test("synchronous publication fails closed if the Workspace attachment directory is replaced", async (t) => {
  const data = await fixture(t);
  const image = await data.upload("att_prepared-swap", "tmp_prepared-swap");
  const input = { dataDir: data.dataDir, workspaceDirName: data.workspaceDirName, ...image };
  const publication = await prepareAgentWorkspaceAttachmentPublication(input);
  const attachments = path.join(data.workspacePath, ".awb/agent/attachments");
  const foreign = path.join(data.workspacePath, "foreign");
  await fs.mkdir(foreign);
  await fs.writeFile(path.join(foreign, image.storageKey), "foreign file");
  try {
    renameSync(attachments, `${attachments}.parked`);
    symlinkSync(foreign, attachments);
    assert.throws(() => publication.publish(), (error: unknown) => error instanceof AgentAttachmentCommitError && !error.finalCreated);
    assert.equal(await fs.readFile(path.join(foreign, image.storageKey), "utf8"), "foreign file");
  } finally {
    await publication.close();
  }
});

test("a replaced final after synchronous link is retained and reported rather than deleted", async (t) => {
  const data = await fixture(t);
  const image = await data.upload("att_prepared-window", "tmp_prepared-window");
  const input = { dataDir: data.dataDir, workspaceDirName: data.workspaceDirName, ...image };
  const attachments = path.join(data.workspacePath, ".awb/agent/attachments");
  const final = path.join(attachments, image.storageKey);
  const publication = await prepareAgentWorkspaceAttachmentPublication({ ...input, afterLinkForTest: () => {
    renameSync(final, `${final}.parked`);
    symlinkSync(`${final}.parked`, final);
  } });
  try {
    assert.throws(() => publication.publish(), (error: unknown) => error instanceof AgentAttachmentCommitError && error.finalCleanupPending);
    assert.deepEqual(await fs.readFile(`${final}.parked`), PNG);
    assert.equal((await fs.lstat(final)).isSymbolicLink(), true);
  } finally {
    await publication.close();
  }
});
