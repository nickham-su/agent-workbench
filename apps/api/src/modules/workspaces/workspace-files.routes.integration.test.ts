import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { validateHeaderValue } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { test, type TestContext } from "node:test";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { createApp } from "../../app/createApp.js";
import { HttpError } from "../../app/errors.js";
import { workspaceLifecycleCoordinator } from "../../infra/locks/workspace-lifecycle-coordinator.js";
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

  // Deletion now holds admission through terminal/filesystem/final DB cleanup. Queue this
  // observer and the second upload BEFORE final cleanup can take the gate; otherwise the
  // request may legitimately observe a completed deletion (404), not a pending one (409).
  let pendingObserved!: () => void;
  let finishObservation!: () => void;
  const pendingWait = new Promise<void>((resolve) => { pendingObserved = resolve; });
  const finishWait = new Promise<void>((resolve) => { finishObservation = resolve; });
  t.after(() => { release(); finishObservation(); });
  const observation = workspaceLifecycleCoordinator.withAdmission(workspace.id, async () => {
    pendingObserved();
    await finishWait;
  });
  const secondTarget = path.join(workspace.path, "second.txt");
  const secondUpload = app.inject({
    method: "POST",
    url: `/api/workspaces/${workspace.id}/files/upload`,
    ...multipartUpload("second.txt", "second"),
  }).then((response) => response);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const firstResponse = await firstUpload;
  assert.equal(firstResponse.statusCode, 200, firstResponse.body);
  await pendingWait;
  assert.equal(await fs.readFile(path.join(workspace.path, "first.txt"), "utf8"), "first");
  assert.ok(getWorkspaceDeletionIntent(fixture.db, workspace.id), "upload 完成后 delete 应建立 intent");
  finishObservation();
  await observation;
  const secondResponse = await secondUpload;
  assert.equal(secondResponse.statusCode, 409, secondResponse.body);
  assert.equal(secondResponse.json().code, "WORKSPACE_DELETING");
  await assert.rejects(() => fs.access(secondTarget));
  await deleting;
});

test("workspace 文件下载为 Unicode 文件名生成合法响应头，保留文件名及完整内容", async (t) => {
  const fixture = await createAgentTestFixture({ dataDirPrefix: "workspace-download-headers-" });
  t.after(() => fixture.dispose());
  const workspace = await createTestWorkspace(fixture);
  const app = Fastify();
  await registerWorkspaceFilesRoutes(app, fixture.ctx);
  t.after(() => app.close());

  for (const filename of ["测试图片.jpg", "image-😀.png", "report '()*%\".jpg", "plain image.jpg"]) {
    await t.test(filename, async () => {
      const content = Buffer.from([0, 1, 2, 255]);
      await fs.writeFile(path.join(workspace.path, filename), content);
      const response = await app.inject({
        method: "GET",
        url: `/api/workspaces/${workspace.id}/files/download?path=${encodeURIComponent(filename)}`
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers["content-type"], "application/octet-stream");
      assert.equal(response.headers["content-length"], String(content.length));
      assert.deepEqual(response.rawPayload, content);
      const header = String(response.headers["content-disposition"]);
      validateHeaderValue("Content-Disposition", header);
      assert.match(header, /^[\x20-\x7e]+$/);
      const match = /^attachment; filename="((?:\\.|[^"\\])*)"; filename\*=UTF-8''(.+)$/.exec(header);
      assert.ok(match, header);
      assert.equal(decodeURIComponent(match[2]), filename);
      assert.doesNotMatch(match[2], /['()*]/);
    });
  }
});

test("workspace ZIP 下载同样发送合法的 Unicode 文件名响应头", async (t) => {
  const fixture = await createAgentTestFixture({ dataDirPrefix: "workspace-download-zip-" });
  t.after(() => fixture.dispose());
  const workspace = await createTestWorkspace(fixture);
  const directory = "图片目录😀";
  await fs.mkdir(path.join(workspace.path, directory));
  await fs.writeFile(path.join(workspace.path, directory, "image.jpg"), "image data");
  const app = Fastify();
  await registerWorkspaceFilesRoutes(app, fixture.ctx);
  t.after(() => app.close());
  const response = await app.inject({
    method: "GET",
    url: `/api/workspaces/${workspace.id}/files/download?path=${encodeURIComponent(directory)}`
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "application/zip");
  const header = String(response.headers["content-disposition"]);
  validateHeaderValue("Content-Disposition", header);
  assert.equal(decodeURIComponent(header.split("filename*=UTF-8''")[1]), `${directory}.zip`);
  assert.equal(response.rawPayload.subarray(0, 2).toString(), "PK");
});

test("下载失败后清除二进制响应头，生产错误处理器正常发送 JSON", async (t) => {
  const fixture = await createAgentTestFixture({
    withApp: true,
    agentWorkerConcurrency: 0,
    dataDirPrefix: "workspace-download-errors-",
    appFactory: async (ctx) => {
      const app = await createApp({ ...ctx, logLevel: "fatal" });
      app.get<{ Params: { kind: string } }>("/__test/download-error/:kind", async (request, reply) => {
        reply.type("application/octet-stream").header("Content-Disposition", 'attachment; filename="file.jpg"').header("Content-Length", "999");
        if (request.params.kind === "header") validateHeaderValue("Content-Disposition", 'attachment; filename="测试.jpg"');
        if (request.params.kind === "http") throw new HttpError(409, "File changed", "FILE_CHANGED");
        if (request.params.kind === "status") throw Object.assign(new Error("Invalid download"), { statusCode: 400 });
        if (request.params.kind === "stream") return reply.send(new Readable({ read() { this.destroy(new Error("Stream failed")); } }));
        throw new Error("Download failed");
      });
      return app;
    }
  });
  t.after(() => fixture.dispose());
  for (const [kind, statusCode, body] of [
    ["header", 500, { message: "Internal Server Error" }],
    ["stream", 500, { message: "Internal Server Error" }],
    ["unknown", 500, { message: "Internal Server Error" }],
    ["http", 409, { message: "File changed", code: "FILE_CHANGED" }],
    ["status", 400, { message: "Invalid download" }]
  ] as const) {
    await t.test(kind, async () => {
      const response = await fixture.app!.inject({ method: "GET", url: `/__test/download-error/${kind}` });
      assert.equal(response.statusCode, statusCode, response.body);
      assert.match(String(response.headers["content-type"]), /^application\/json\b/);
      assert.equal(response.headers["content-disposition"], undefined);
      assert.deepEqual(response.json(), body);
      assert.equal(response.headers["content-length"], String(Buffer.byteLength(response.body)));
    });
  }
});
