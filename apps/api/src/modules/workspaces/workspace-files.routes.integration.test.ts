import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { workspaceDeletingFence } from "../agent/lifecycle/workspace-deleting-fence.js";
import { createIntegrationFixture } from "../agent/integration/context-writeback.helpers.js";
import { createAgentTestFixture, createTestWorkspace } from "../agent/testkit/agent-testkit.js";
import { registerWorkspaceFilesRoutes } from "./workspace-files.routes.js";
import { deleteWorkspace } from "./workspace.service.js";
import { getWorkspaceDeletionIntent } from "./workspace-deletion.store.js";

const logger = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {}, child() { return this; } } as any;

function multipartUpload(filename: string, content: string) {
  const boundary = "awb-workspace-upload-boundary";
  const payload = Buffer.from([
    `--${boundary}\r\n`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`,
    "Content-Type: text/plain\r\n\r\n",
    content,
    `\r\n--${boundary}--\r\n`,
  ].join(""));
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload,
  };
}

test("workspace upload multipart route 在 restored deleting fence 下拒绝且不落盘", async (t: TestContext) => {
  const fixture = await createIntegrationFixture(t);
  const filename = "must-not-write.txt";
  const target = path.join(fixture.workspacePath, filename);
  workspaceDeletingFence.restore(fixture.workspaceId);
  try {
    const response = await fixture.app.inject({
      method: "POST",
      url: `/api/workspaces/${fixture.workspaceId}/files/upload`,
      ...multipartUpload(filename, "must not persist"),
    });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().code, "WORKSPACE_DELETING");
    await assert.rejects(() => fs.access(target));
  } finally {
    workspaceDeletingFence.end(fixture.workspaceId);
  }
});

test("真实 multipart upload 在 production gate 内完成后，delete 才建立 intent 并拒绝后续 upload", async (t: TestContext) => {
  const fixture = await createAgentTestFixture({ withApp: false, dataDirPrefix: "workspace-upload-race-" });
  t.after(() => fixture.dispose());
  const workspace = await createTestWorkspace(fixture, { title: "upload race" });
  let admitted!: () => void;
  let release!: () => void;
  const admittedWait = new Promise<void>((resolve) => { admitted = resolve; });
  const releaseWait = new Promise<void>((resolve) => { release = resolve; });
  const app = Fastify();
  await app.register(multipart);
  await registerWorkspaceFilesRoutes(app, fixture.ctx, {
    afterUploadMutationAdmitted: async ({ workspaceId }) => {
      if (workspaceId !== workspace.id) return;
      admitted();
      await releaseWait;
    },
  });
  t.after(() => app.close());

  const firstUpload = app.inject({
    method: "POST",
    url: `/api/workspaces/${workspace.id}/files/upload`,
    ...multipartUpload("first.txt", "first"),
  });
  await admittedWait;
  const deleting = deleteWorkspace(fixture.ctx, logger, workspace.id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(getWorkspaceDeletionIntent(fixture.db, workspace.id), null, "upload 未完成前不得建立 delete intent");

  release();
  const firstResponse = await firstUpload;
  assert.equal(firstResponse.statusCode, 200, firstResponse.body);
  assert.equal(await fs.readFile(path.join(workspace.path, "first.txt"), "utf8"), "first");
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(getWorkspaceDeletionIntent(fixture.db, workspace.id), "upload 完成后 delete 应建立 intent");

  const secondTarget = path.join(workspace.path, "second.txt");
  const secondResponse = await app.inject({
    method: "POST",
    url: `/api/workspaces/${workspace.id}/files/upload`,
    ...multipartUpload("second.txt", "second"),
  });
  assert.equal(secondResponse.statusCode, 409, secondResponse.body);
  assert.equal(secondResponse.json().code, "WORKSPACE_DELETING");
  await assert.rejects(() => fs.access(secondTarget));
  await deleting;
});
