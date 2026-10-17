import assert from "node:assert/strict";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import mutableFs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { request } from "node:http";
import { test, type TestContext } from "node:test";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { HttpError } from "../../app/errors.js";
import { createAgentTestFixture, createTestRepository, createTestWorkspace } from "../agent/testkit/agent-testkit.js";
import { registerWorkspaceFilesRoutes, type WorkspaceFilesRouteTestHooks } from "./workspace-files.routes.js";
import { extractWorkspaceArchive, createWorkspaceFile } from "./workspace-files.service.js";
import { zipFixture, tarFixture } from "./workspace-archive-fixtures.js";
import { ArchiveStagingArea } from "./workspace-archive-staging.js";
import { ArchiveOwnedNodes } from "./workspace-archive-owned.js";
import { withWorkspaceLock } from "../../infra/locks/workspaceLock.js";
import { withWorkspaceRepoLock } from "../../infra/locks/workspaceRepoLock.js";
import { workspaceLifecycleCoordinator } from "../../infra/locks/workspace-lifecycle-coordinator.js";
import { workspaceDeletingFence } from "../agent/lifecycle/workspace-deleting-fence.js";
import { deleteWorkspace } from "./workspace.service.js";
import { getWorkspaceDeletionIntent } from "./workspace-deletion.store.js";

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const logger = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {}, child() { return this; } } as any;
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function setup(t: TestContext, hooks: WorkspaceFilesRouteTestHooks = {}) {
  const fixture = await createAgentTestFixture({ repoRoot, dataDirPrefix: "workspace-extract-" });
  t.after(() => fixture.dispose());
  const workspace = await createTestWorkspace(fixture);
  const logs: string[] = [];
  const app = Fastify({ logger: { level: "warn", stream: { write: (line: string) => { logs.push(line); } } } });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof HttpError) return reply.code(error.statusCode).send({ message: error.message, code: error.code });
    const native = error as { statusCode?: number; message?: string };
    const known = typeof native.statusCode === "number" && native.statusCode < 500;
    return reply.code(known ? native.statusCode! : 500).send({ message: known ? native.message : "Internal Server Error" });
  });
  await app.register(multipart);
  await registerWorkspaceFilesRoutes(app, fixture.ctx, hooks);
  t.after(() => app.close());
  const url = `/api/workspaces/${workspace.id}/files/extract`;
  const inject = (source = "input.zip", extra: Record<string, unknown> = {}) => app.inject({ method: "POST", url, payload: { path: source, ...extra } });
  return { fixture, workspace, app, logs, url, inject };
}

for (const [filename, data] of [
  ["input.ZIP", zipFixture([{ name: "src/a", data: "hello" }, { name: ".dot", data: "ok" }])],
  ["input.TAR", tarFixture([{ name: "src/a", data: "hello" }, { name: ".dot", data: "ok" }])],
  ["input.TAR.GZ", gzipSync(tarFixture([{ name: "src/a", data: "hello" }, { name: ".dot", data: "ok" }]))],
  ["input.TGZ", gzipSync(tarFixture([{ name: "src/a", data: "hello" }, { name: ".dot", data: "ok" }]))]
] as const) {
  test(`A-API-01/FMT-01: real route extracts ${filename} at its existing parent and preserves source`, async (t) => {
    const { workspace, inject } = await setup(t);
    await fs.mkdir(path.join(workspace.path, "downloads"));
    const relative = `downloads/${filename}`;
    await fs.writeFile(path.join(workspace.path, relative), data);
    const response = await inject(relative);
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { path: relative, dir: "downloads", format: filename.endsWith("ZIP") ? "zip" : filename.endsWith("TAR") ? "tar" : "tar-gzip", topLevelCount: 2, fileCount: 2, directoryCount: 1, extractedBytes: 7 });
    assert.equal(await fs.readFile(path.join(workspace.path, "downloads/src/a"), "utf8"), "hello");
    assert.deepEqual(await fs.readFile(path.join(workspace.path, relative)), data);
    assert.deepEqual((await fs.readdir(path.join(workspace.path, "downloads"))).sort(), [".dot", filename, "src"]);
  });
}

test("A-API-01/PUB-02: repository mapping, root response and absent reserved repository names", async (t) => {
  const { fixture, workspace, inject } = await setup(t);
  const { workspaceRepo } = await createTestRepository(fixture, { workspace, dirName: "repository" });
  await fs.writeFile(path.join(workspaceRepo.path, "input.zip"), zipFixture([{ name: "file", data: "repo" }]));
  const inside = await inject("repository/input.zip");
  assert.equal(inside.statusCode, 200, inside.body);
  assert.equal(inside.json().dir, "repository");
  assert.equal(await fs.readFile(path.join(workspaceRepo.path, "file"), "utf8"), "repo");
  await fs.rm(workspaceRepo.path, { recursive: true });
  await fs.writeFile(path.join(workspace.path, "input.zip"), zipFixture([{ name: "repository/file", data: "never" }]));
  const reserved = await inject();
  assert.equal(reserved.statusCode, 409); assert.equal(reserved.json().code, "ARCHIVE_TARGET_CONFLICT");
  await assert.rejects(fs.lstat(workspaceRepo.path), { code: "ENOENT" });
  await fs.writeFile(path.join(workspace.path, "empty.zip"), zipFixture([]));
  const empty = await inject("empty.zip");
  assert.equal(empty.statusCode, 200, empty.body); assert.equal(empty.json().dir, ""); assert.equal(empty.json().topLevelCount, 0);
});

test("A-PATH-10/11/API-05: schema precedes canonical source rules; alternate spelling cannot choose a different region", async (t) => {
  const { fixture, workspace, app, inject, url } = await setup(t);
  const { workspaceRepo } = await createTestRepository(fixture, { workspace, dirName: "repository" });
  await fs.writeFile(path.join(workspaceRepo.path, "input.zip"), zipFixture([{ name: "file", data: "repo" }]));
  for (const source of ["./repository/input.zip", "repository//input.zip", "repository/./input.zip", "repository/../input.zip", "repository\\input.zip", ".git/input.zip", "/absolute.zip", "C:/archive.zip", "\ud800/input.zip", "\udfff.zip", "界".repeat(86) + ".zip", Array(18).fill("界".repeat(85)).join("/")]) {
    const response = await inject(source);
    assert.equal(response.statusCode, 400, response.body); assert.equal(response.json().code, "ARCHIVE_PATH_INVALID");
  }
  for (const payload of [{}, { path: "" }, { path: "a".repeat(4097) }]) {
    const response = await app.inject({ method: "POST", url, payload });
    assert.equal(response.statusCode, 400, response.body); assert.equal(response.json().code, undefined);
  }
  const valid = await inject("repository/input.zip");
  assert.equal(valid.statusCode, 200, valid.body); assert.equal(valid.json().path, "repository/input.zip");
});

test("A-PATH-07/API-02: missing source, directories, source links and parent links never escape", async (t) => {
  const { fixture, workspace, inject, app } = await setup(t);
  const bytes = zipFixture([{ name: "output", data: "ok" }]);
  const sentinel = path.join(fixture.dataDir, "sentinel.zip");
  await fs.writeFile(sentinel, bytes);
  await fs.symlink(sentinel, path.join(workspace.path, "link.zip"));
  await fs.symlink("absent", path.join(workspace.path, "dangling.zip"));
  await fs.symlink(fixture.dataDir, path.join(workspace.path, "parent-link"));
  await fs.mkdir(path.join(workspace.path, "directory.zip"));
  for (const name of ["link.zip", "dangling.zip", "parent-link/sentinel.zip", "directory.zip"]) {
    const response = await inject(name); assert.equal(response.statusCode, 400, response.body); assert.equal(response.json().code, "ARCHIVE_PATH_INVALID");
  }
  const missing = await inject("missing.zip"); assert.equal(missing.statusCode, 404); assert.equal(missing.json().code, "ARCHIVE_SOURCE_NOT_FOUND");
  const absentWs = await app.inject({ method: "POST", url: "/api/workspaces/absent/files/extract", payload: { path: "input.zip" } });
  assert.equal(absentWs.statusCode, 404);
  assert.deepEqual(await fs.readFile(sentinel), bytes);
  await assert.rejects(fs.lstat(path.join(fixture.dataDir, "output")), { code: "ENOENT" });
});

test("A-API-02: destination/overwrite/merge/password/limits/hooks body fields cannot enable behavior", async (t) => {
  const { fixture, workspace, inject } = await setup(t);
  await fs.writeFile(path.join(workspace.path, "input.zip"), zipFixture([{ name: "existing", data: "replace" }]));
  await fs.writeFile(path.join(workspace.path, "existing"), "keep");
  const response = await inject("input.zip", { destination: fixture.dataDir, overwrite: true, merge: true, password: "fake-test-only", limits: { inputBytes: 1e15 }, hooks: {} });
  assert.equal(response.statusCode, 409, response.body); assert.equal(response.json().code, "ARCHIVE_TARGET_CONFLICT");
  assert.equal(await fs.readFile(path.join(workspace.path, "existing"), "utf8"), "keep");
  await assert.rejects(fs.lstat(path.join(fixture.dataDir, "existing")), { code: "ENOENT" });
});

test("A-API-03/04: parser/native errors are safe, one summary log, and next request can run", async (t) => {
  let fail = true;
  const { workspace, inject, logs } = await setup(t, { archiveExtract: { hooks: { onPhase: ({ phase }) => {
    if (fail && phase === "before-publish") throw Object.assign(new Error("FAKE_PRIVATE_PAYLOAD /fake-sensitive-name"), { code: "ENOSPC" });
  } } } });
  await fs.writeFile(path.join(workspace.path, "input.zip"), zipFixture([{ name: "output", data: "ok" }]));
  const first = await inject(); assert.equal(first.statusCode, 507); assert.equal(first.json().code, "ARCHIVE_STORAGE_EXHAUSTED");
  assert.ok(!first.body.includes("FAKE_PRIVATE_PAYLOAD")); assert.ok(!first.body.includes(workspace.path));
  const summaries = logs.filter((line) => line.includes("Workspace archive extraction failed"));
  assert.equal(summaries.length, 1);
  for (const line of summaries) { assert.ok(!line.includes(workspace.path)); assert.ok(!line.includes("fake-sensitive-name")); assert.ok(!line.includes("FAKE_PRIVATE_PAYLOAD")); }
  fail = false;
  const next = await inject(); assert.equal(next.statusCode, 200, next.body);
});

for (const lockKind of ["workspace", "repo", "lifecycle"] as const) {
  test(`A-LIMIT-05/PUB-13: process slot is held while waiting for ${lockKind} lock; second Workspace fails immediately`, async (t) => {
    const slotted = barrier();
    const { fixture, workspace, inject } = await setup(t, { archiveExtract: { afterSlotAcquired: slotted.resolve } });
    const secondWorkspace = await createTestWorkspace(fixture);
    await fs.writeFile(path.join(secondWorkspace.path, "input.zip"), zipFixture([]));
    let source = "input.zip";
    if (lockKind === "repo") {
      const { workspaceRepo } = await createTestRepository(fixture, { workspace, dirName: "repository" });
      await fs.writeFile(path.join(workspaceRepo.path, "input.zip"), zipFixture([])); source = "repository/input.zip";
    } else await fs.writeFile(path.join(workspace.path, "input.zip"), zipFixture([]));
    const locked = barrier(); const release = barrier();
    const hold = async () => { locked.resolve(); await release.promise; };
    const holding = lockKind === "workspace" ? withWorkspaceLock({ workspaceId: workspace.id }, hold)
      : lockKind === "repo" ? withWorkspaceRepoLock({ workspaceId: workspace.id, dirName: "repository" }, hold)
      : workspaceLifecycleCoordinator.withAdmission(workspace.id, hold);
    await locked.promise;
    t.after(() => release.resolve());
    const first = inject(source).then((value) => value);
    await slotted.promise;
    await assert.rejects(extractWorkspaceArchive(fixture.ctx, secondWorkspace.id, { path: "input.zip" }), { code: "ARCHIVE_BUSY", statusCode: 429 });
    // Canonical validation must run even when the slot is busy.
    await assert.rejects(extractWorkspaceArchive(fixture.ctx, secondWorkspace.id, { path: "./input.zip" }), { code: "ARCHIVE_PATH_INVALID" });
    assert.deepEqual(await fs.readdir(secondWorkspace.path), ["input.zip"]);
    release.resolve(); await holding;
    const response = await first; assert.equal(response.statusCode, 200, response.body);
    const second = await extractWorkspaceArchive(fixture.ctx, secondWorkspace.id, { path: "input.zip" }); assert.equal(second.topLevelCount, 0);
  });
}

test("A-PUB-12: restored deleting fence rejects before any staging writes", async (t) => {
  const { workspace, inject } = await setup(t);
  await fs.writeFile(path.join(workspace.path, "input.zip"), zipFixture([]));
  workspaceDeletingFence.restore(workspace.id);
  try {
    const response = await inject(); assert.equal(response.statusCode, 409, response.body); assert.equal(response.json().code, "WORKSPACE_DELETING");
    assert.deepEqual(await fs.readdir(workspace.path), ["input.zip"]);
  } finally { workspaceDeletingFence.end(workspace.id); }
  const next = await inject(); assert.equal(next.statusCode, 200, next.body);
});

test("A-PUB-12/13: deletion and file mutation wait for admitted extraction and cleanup", async (t) => {
  const paused = barrier(); const release = barrier();
  const { fixture, workspace, inject } = await setup(t, { archiveExtract: { hooks: { onPhase: async ({ phase }) => {
    if (phase === "before-cleanup") { paused.resolve(); await release.promise; }
  } } } });
  await fs.writeFile(path.join(workspace.path, "input.zip"), zipFixture([{ name: "output", data: "ok" }]));
  const extracting = inject().then((response) => response);
  await paused.promise;
  t.after(() => release.resolve());
  const mutation = createWorkspaceFile(fixture.ctx, workspace.id, { path: "after-extract", content: "next" });
  const deleting = deleteWorkspace(fixture.ctx, logger, workspace.id);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(getWorkspaceDeletionIntent(fixture.db, workspace.id), null);
  assert.ok((await fs.readdir(workspace.path)).some((name) => name.startsWith(".awb-extract-")));
  release.resolve();
  const response = await extracting; assert.equal(response.statusCode, 200, response.body);
  await mutation;
  await deleting;
  await assert.rejects(fs.lstat(workspace.path), { code: "ENOENT" });
});

test("A-PUB-14: HTTP disconnect during publication does not cancel the admitted operation", async (t) => {
  const paused = barrier(); const release = barrier(); const completed = barrier();
  const { workspace, app, url } = await setup(t, { archiveExtract: { hooks: { onPhase: async ({ phase }) => {
    if (phase === "published") { paused.resolve(); await release.promise; }
    if (phase === "before-cleanup") completed.resolve();
  } } } });
  await fs.writeFile(path.join(workspace.path, "input.zip"), zipFixture([{ name: "dir/file", data: "ok" }]));
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const req = request(address + url, { method: "POST", headers: { "content-type": "application/json" } });
  req.on("error", () => {}); req.end(JSON.stringify({ path: "input.zip" }));
  await paused.promise;
  const closed = barrier(); req.on("close", closed.resolve); req.destroy(); await closed.promise;
  release.resolve();
  await completed.promise;
  // A second request waits until any same-process cleanup has released its slot.
  // The onResponse hook is not guaranteed after a disconnected transport; use lifecycle admission.
  await workspaceLifecycleCoordinator.withAdmission(workspace.id, async () => {
    assert.equal(await fs.readFile(path.join(workspace.path, "dir/file"), "utf8"), "ok");
    assert.deepEqual((await fs.readdir(workspace.path)).sort(), ["dir", "input.zip"]);
  });
});

test("A-API-02: production auth guard protects extraction and OpenAPI lists full error responses", async (t) => {
  const fixture = await createAgentTestFixture({ repoRoot, dataDirPrefix: "workspace-extract-auth-", withApp: true, authToken: "test-extraction-auth-only" });
  t.after(() => fixture.dispose());
  const workspace = await createTestWorkspace(fixture);
  await fs.writeFile(path.join(workspace.path, "input.zip"), zipFixture([]));
  const denied = await fixture.app!.inject({ method: "POST", url: `/api/workspaces/${workspace.id}/files/extract`, payload: { path: "input.zip" } });
  assert.equal(denied.statusCode, 401, denied.body);
  assert.deepEqual(await fs.readdir(workspace.path), ["input.zip"]);
  const schema = fixture.app!.swagger().paths?.["/api/workspaces/{workspaceId}/files/extract"]?.post as any;
  assert.ok(schema);
  for (const status of [200, 400, 401, 403, 404, 408, 409, 413, 429, 500, 507]) assert.ok(schema.responses[String(status)]);
});

test("A-PATH-07: mismatched Workspace/repository DB mappings fail before extraction", async (t) => {
  const { fixture, workspace, inject } = await setup(t);
  const { workspaceRepo } = await createTestRepository(fixture, { workspace, dirName: "repository" });
  await fs.writeFile(path.join(workspaceRepo.path, "input.zip"), zipFixture([]));
  fixture.db.prepare("UPDATE workspace_repos SET path = ? WHERE workspace_id = ? AND dir_name = ?").run(path.join(fixture.dataDir, "not-the-repo"), workspace.id, "repository");
  const repoMismatch = await inject("repository/input.zip");
  assert.equal(repoMismatch.statusCode, 400, repoMismatch.body);
  fixture.db.prepare("UPDATE workspaces SET path = ? WHERE id = ?").run(path.join(fixture.dataDir, "not-the-workspace"), workspace.id);
  const workspaceMismatch = await inject("input.zip");
  assert.equal(workspaceMismatch.statusCode, 409, workspaceMismatch.body);
  assert.equal(workspaceMismatch.json().code, "WORKSPACE_PATH_INVALID");
  assert.deepEqual(await fs.readdir(workspaceRepo.path), ["input.zip"]);
});

test("H1/A-PATH-07/API-04: a static Workspace root symlink rejects ordinary and repository sources without touching its target", async (t) => {
  const { fixture, workspace, inject } = await setup(t);
  const { workspaceRepo } = await createTestRepository(fixture, { workspace, dirName: "repository" });
  const target = path.join(fixture.dataDir, "isolated-link-target");
  const targetRepo = path.join(target, "repository");
  const saved = path.join(fixture.dataDir, "saved-workspace");
  const bytes = zipFixture([{ name: "output", data: "must not be extracted" }]);
  await fs.mkdir(targetRepo, { recursive: true });
  for (const dir of [target, targetRepo]) {
    await fs.writeFile(path.join(dir, "input.zip"), bytes);
    await fs.writeFile(path.join(dir, "sentinel"), "unchanged");
  }
  await fs.rename(workspace.path, saved);
  await fs.symlink(target, workspace.path, "dir");
  try {
    for (const source of ["input.zip", "repository/input.zip"]) {
      const response = await inject(source);
      assert.equal(response.statusCode, 400, response.body);
      assert.equal(response.json().code, "ARCHIVE_PATH_INVALID");
      assert.deepEqual((await fs.readdir(target)).sort(), ["input.zip", "repository", "sentinel"]);
      assert.deepEqual((await fs.readdir(targetRepo)).sort(), ["input.zip", "sentinel"]);
      for (const dir of [target, targetRepo]) {
        assert.deepEqual(await fs.readFile(path.join(dir, "input.zip")), bytes);
        assert.equal(await fs.readFile(path.join(dir, "sentinel"), "utf8"), "unchanged");
      }
    }
  } finally {
    await fs.unlink(workspace.path);
    await fs.rename(saved, workspace.path);
  }
  // Both region locks and the process slot must be reusable after boundary rejection.
  for (const [source, dir] of [["input.zip", workspace.path], ["repository/input.zip", workspaceRepo.path]]) {
    await fs.writeFile(path.join(dir!, "input.zip"), zipFixture([]));
    const response = await inject(source!);
    assert.equal(response.statusCode, 200, response.body);
  }
});

for (const changeAt of ["before-publish", "before-commit"] as const) {
  test(`H1/A-PATH-07/PUB-16: Workspace identity replacement at ${changeAt} is detected even when repository identity is unchanged`, async (t) => {
    let replaceAncestor: () => Promise<void>;
    let replaced = false;
    const { fixture, workspace, inject } = await setup(t, { archiveExtract: { hooks: { onPhase: async ({ phase }) => {
      if (!replaced && phase === changeAt) { replaced = true; await replaceAncestor(); }
    } } } });
    const { workspaceRepo } = await createTestRepository(fixture, { workspace, dirName: "repository" });
    const saved = path.join(fixture.dataDir, "saved-workspace");
    const bytes = zipFixture([{ name: "output", data: "owned output" }]);
    await fs.writeFile(path.join(workspaceRepo.path, "input.zip"), bytes);
    const originalRepo = await fs.lstat(workspaceRepo.path, { bigint: true });
    replaceAncestor = async () => {
      await fs.rename(workspace.path, saved);
      await fs.mkdir(workspace.path);
      await fs.rename(path.join(saved, "repository"), workspaceRepo.path);
      await fs.writeFile(path.join(workspace.path, "sentinel"), "external Workspace");
      const currentRepo = await fs.lstat(workspaceRepo.path, { bigint: true });
      assert.equal(currentRepo.dev, originalRepo.dev);
      assert.equal(currentRepo.ino, originalRepo.ino);
    };
    const response = await inject("repository/input.zip");
    assert.equal(response.statusCode, 500, response.body);
    assert.equal(response.json().code, "ARCHIVE_CLEANUP_INCOMPLETE");
    assert.equal(await fs.readFile(path.join(workspace.path, "sentinel"), "utf8"), "external Workspace");
    assert.deepEqual(await fs.readFile(path.join(workspaceRepo.path, "input.zip")), bytes);
    const entries = (await fs.readdir(workspaceRepo.path)).sort();
    const staging = entries.find((name) => name.startsWith(".awb-extract-"));
    assert.ok(staging, "uncertain ownership is retained rather than cleaning through a replaced ancestor");
    assert.deepEqual(entries, [staging, "input.zip", ...(changeAt === "before-commit" ? ["output"] : [])].sort());
    if (changeAt === "before-commit") assert.equal(await fs.readFile(path.join(workspaceRepo.path, "output"), "utf8"), "owned output");
    await fs.rename(workspaceRepo.path, path.join(saved, "repository"));
    await fs.unlink(path.join(workspace.path, "sentinel"));
    await fs.rmdir(workspace.path);
    await fs.rename(saved, workspace.path);
    for (const [source, dir] of [["recovered.zip", workspace.path], ["repository/recovered.zip", workspaceRepo.path]]) {
      await fs.writeFile(path.join(dir!, "recovered.zip"), zipFixture([]));
      const recovered = await inject(source!);
      assert.equal(recovered.statusCode, 200, recovered.body);
    }
    assert.ok((await fs.readdir(workspaceRepo.path)).includes(staging));
  });
}

test("A-API-04/LIMIT-04: timeout and malformed archive release the global slot for a normal request", async (t) => {
  let forceTimeout = true;
  const { workspace, inject } = await setup(t, { archiveExtract: { limits: { timeoutMs: 1000 }, hooks: { onPhase: async ({ phase, signal }) => {
    if (forceTimeout && phase === "source-opened") await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  } } } });
  await fs.writeFile(path.join(workspace.path, "input.zip"), zipFixture([]));
  const timedOut = await inject(); assert.equal(timedOut.statusCode, 408, timedOut.body); assert.equal(timedOut.json().code, "ARCHIVE_TIMEOUT");
  forceTimeout = false;
  await fs.writeFile(path.join(workspace.path, "bad.zip"), "not a ZIP");
  const malformed = await inject("bad.zip"); assert.equal(malformed.statusCode, 400, malformed.body); assert.equal(malformed.json().code, "ARCHIVE_INVALID");
  const normal = await inject(); assert.equal(normal.statusCode, 200, normal.body);
  assert.deepEqual((await fs.readdir(workspace.path)).sort(), ["bad.zip", "input.zip"]);
});

for (const failContent of [false, true]) {
  test(`M1/PUB-07/18: payload hardlink during ${failContent ? "failing" : "successful"} content is never trusted or chmodded`, async (t) => {
    const { workspace, inject, logs } = await setup(t);
    const privateMarker = "fake-private-content-error /never-log-this";
    const bytes = zipFixture([{ name: "output", data: "payload", mode: 0o100755 }]);
    await fs.writeFile(path.join(workspace.path, "input.zip"), bytes);
    const foreign = path.join(workspace.path, "foreign-alias");
    const writeEntry = ArchiveStagingArea.prototype.writeEntry;
    let linked = false;
    t.mock.method(ArchiveStagingArea.prototype, "writeEntry", async function (
      this: ArchiveStagingArea, options: Parameters<ArchiveStagingArea["writeEntry"]>[0]
    ) {
      if (linked || options.kind !== "file" || !options.content) return writeEntry.call(this, options);
      const staged = this.absolutePath(options.name);
      const content = options.content;
      return writeEntry.call(this, { ...options, content: (async function* () {
        for await (const chunk of content) {
          yield chunk;
          if (!linked) {
            await fs.link(staged, foreign);
            linked = true;
            if (failContent) throw Object.assign(new Error(privateMarker), { code: "EIO" });
          }
        }
      })() });
    });
    const response = await inject();
    assert.equal(response.statusCode, 500, response.body);
    assert.equal(response.json().code, "ARCHIVE_CLEANUP_INCOMPLETE");
    const summaries = logs.map((line) => JSON.parse(line)).filter((line) => line.msg === "Workspace archive extraction failed");
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].code, "ARCHIVE_CLEANUP_INCOMPLETE");
    assert.equal(summaries[0].originalCode, failContent ? "ARCHIVE_IO_FAILED" : "ARCHIVE_TARGET_CHANGED");
    assert.ok(!logs.join("").includes(privateMarker));
    await assert.rejects(fs.lstat(path.join(workspace.path, "output")), { code: "ENOENT" });
    const stage = (await fs.readdir(workspace.path)).find((name) => name.startsWith(".awb-extract-"))!;
    const payload = path.join(workspace.path, stage, "payload/output");
    assert.equal(await fs.readFile(foreign, "utf8"), "payload");
    assert.equal((await fs.stat(foreign)).mode & 0o7777, 0o600);
    assert.equal((await fs.stat(payload, { bigint: true })).ino, (await fs.stat(foreign, { bigint: true })).ino);
    const next = await inject();
    assert.equal(next.statusCode, 200, next.body);
    assert.equal((await fs.stat(foreign)).mode & 0o7777, 0o600);
    assert.deepEqual(await fs.readFile(path.join(workspace.path, "input.zip")), bytes);
  });
}


for (const failContent of [false, true]) {
  test(`M5/PUB: payload close failure ${failContent ? "preserves processing EIO" : "cannot produce success"}`, async (t) => {
    const { workspace, inject, logs } = await setup(t);
    await fs.writeFile(path.join(workspace.path, "input.zip"), zipFixture([{ name: "output", data: "payload" }]));
    const privateMarker = "fake-private-payload-close /never-log-this";
    const open = fs.open;
    let closeCalls = 0;
    t.mock.method(mutableFs, "open", async (abs: Parameters<typeof fs.open>[0], flags: Parameters<typeof fs.open>[1], mode?: Parameters<typeof fs.open>[2]) => {
      const handle = await open(abs, flags, mode);
      if (String(abs).endsWith(`${path.sep}payload${path.sep}output`)) {
        const close = handle.close.bind(handle);
        t.mock.method(handle, "close", async () => { closeCalls++; await close(); throw Object.assign(new Error(privateMarker), { code: "ENOSPC" }); });
      }
      return handle;
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    if (failContent) {
      const writeEntry = ArchiveStagingArea.prototype.writeEntry;
      t.mock.method(ArchiveStagingArea.prototype, "writeEntry", async function (this: ArchiveStagingArea, options: Parameters<ArchiveStagingArea["writeEntry"]>[0]) {
        if (options.kind !== "file" || !options.content) return writeEntry.call(this, options);
        const content = options.content;
        return writeEntry.call(this, { ...options, content: (async function* () {
          yield* content;
          throw Object.assign(new Error(privateMarker), { code: "EIO" });
        })() });
      });
    }
    const response = await inject();
    const expected = failContent ? "ARCHIVE_IO_FAILED" : "ARCHIVE_STORAGE_EXHAUSTED";
    assert.equal(response.statusCode, failContent ? 500 : 507, response.body);
    assert.equal(response.json().code, expected);
    assert.equal(closeCalls, 1);
    const summary = logs.map((line) => JSON.parse(line)).find((line) => line.msg === "Workspace archive extraction failed");
    assert.equal(summary?.originalCode, expected);
    assert.ok(!logs.join("").includes(privateMarker));
    assert.deepEqual(await fs.readdir(workspace.path), ["input.zip"]);
  });
}

for (const target of ["owner.json", "input.archive"]) {
  for (const failWrite of [false, true]) {
    test(`M5/PUB: ${target} ${failWrite ? "write and settlement errors precede close" : "standalone close failure is reported"}`, async (t) => {
      const { workspace, inject, logs } = await setup(t);
      const bytes = zipFixture([{ name: "output", data: "payload" }]);
      await fs.writeFile(path.join(workspace.path, "input.zip"), bytes);
      const privateMarker = "fake-private-snapshot-owner /never-log-this";
      const foreign = path.join(workspace.path, "foreign-alias");
      const createFile = ArchiveOwnedNodes.prototype.createFile;
      let active = true;
      let stageFile = "";
      let closeCalls = 0;
      let settleCalls = 0;
      const settleWriter = ArchiveOwnedNodes.prototype.settleWriter;
      t.mock.method(ArchiveOwnedNodes.prototype, "settleWriter", function (this: ArchiveOwnedNodes, abs: string, stat: Parameters<ArchiveOwnedNodes["settleWriter"]>[1]) {
        if (abs === stageFile) settleCalls++;
        return settleWriter.call(this, abs, stat);
      });
      t.mock.method(ArchiveOwnedNodes.prototype, "createFile", async function (this: ArchiveOwnedNodes, abs: string) {
        const handle = await createFile.call(this, abs);
        if (active && path.basename(abs) === target) {
          stageFile = abs;
          const close = handle.close.bind(handle);
          t.mock.method(handle, "close", async () => { closeCalls++; await close(); throw Object.assign(new Error(privateMarker), { code: "ENOSPC" }); });
          if (failWrite) {
            const fail = async () => { await fs.link(abs, foreign); throw Object.assign(new Error(privateMarker), { code: "EIO" }); };
            if (target === "owner.json") t.mock.method(handle, "writeFile", fail);
            else t.mock.method(handle, "write", fail);
          }
        }
        return handle;
      });
      const response = await inject();
      const expected = failWrite ? "ARCHIVE_CLEANUP_INCOMPLETE" : "ARCHIVE_STORAGE_EXHAUSTED";
      assert.equal(response.statusCode, failWrite ? 500 : 507, response.body);
      assert.equal(response.json().code, expected);
      assert.equal(closeCalls, 1);
      assert.equal(settleCalls, 1);
      const summary = logs.map((line) => JSON.parse(line)).find((line) => line.msg === "Workspace archive extraction failed");
      assert.equal(summary?.originalCode, failWrite ? "ARCHIVE_IO_FAILED" : expected);
      assert.ok(!logs.join("").includes(privateMarker));
      await assert.rejects(fs.lstat(path.join(workspace.path, "output")), { code: "ENOENT" });
      if (failWrite) {
        const retained = await fs.stat(stageFile, { bigint: true });
        assert.equal(retained.ino, (await fs.stat(foreign, { bigint: true })).ino);
        assert.equal(retained.nlink, 2n);
        assert.equal(retained.mode & 0o7777n, 0o600n);
      } else assert.deepEqual(await fs.readdir(workspace.path), ["input.zip"]);
      active = false;
      const next = await inject();
      assert.equal(next.statusCode, 200, next.body);
      assert.deepEqual(await fs.readFile(path.join(workspace.path, "input.zip")), bytes);
    });
  }
}

test("M5/PUB: owned writer initialization error is not replaced by close failure", async (t) => {
  const { workspace, inject, logs } = await setup(t);
  await fs.writeFile(path.join(workspace.path, "input.zip"), zipFixture([]));
  const open = fs.open;
  let closeCalls = 0;
  t.mock.method(mutableFs, "open", async (abs: Parameters<typeof fs.open>[0], flags: Parameters<typeof fs.open>[1], mode?: Parameters<typeof fs.open>[2]) => {
    const handle = await open(abs, flags, mode);
    if (String(abs).endsWith(`${path.sep}owner.json`)) {
      const close = handle.close.bind(handle);
      t.mock.method(handle, "chmod", async () => { throw Object.assign(new Error("fake-private-initialization"), { code: "EIO" }); });
      t.mock.method(handle, "close", async () => { closeCalls++; await close(); throw Object.assign(new Error("fake-private-close"), { code: "ENOSPC" }); });
    }
    return handle;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const response = await inject();
  assert.equal(response.statusCode, 500, response.body);
  assert.equal(response.json().code, "ARCHIVE_IO_FAILED");
  assert.equal(closeCalls, 1);
  assert.equal(logs.map((line) => JSON.parse(line)).find((line) => line.msg === "Workspace archive extraction failed")?.originalCode, "ARCHIVE_IO_FAILED");
  assert.ok(!logs.join("").includes("fake-private-"));
  assert.deepEqual(await fs.readdir(workspace.path), ["input.zip"]);
});

for (const format of ["zip", "tar"] as const) {
  for (const processing of ["none", "format", "quota", "preflight"] as const) {
    if (processing === "preflight" && format !== "zip") continue;
    test(`M5/PUB: ${format} snapshot close preserves ${processing} processing cause`, async (t) => {
      const { workspace, inject, logs } = await setup(t, { archiveExtract: { limits: processing === "quota" ? { fileBytes: 3 } : undefined } });
      const entries = [{ name: "output", data: "payload" }];
      const bytes = processing === "preflight" ? Buffer.alloc(0) : processing === "format" ? Buffer.from("invalid archive") : format === "zip" ? zipFixture(entries) : tarFixture(entries);
      const filename = `input.${format}`;
      await fs.writeFile(path.join(workspace.path, filename), bytes);
      await fs.writeFile(path.join(workspace.path, "empty.zip"), zipFixture([]));
      const privateMarker = "fake-private-parser-close /never-log-this";
      const open = fs.open;
      let active = true;
      let closeCalls = 0;
      t.mock.method(mutableFs, "open", async (abs: Parameters<typeof fs.open>[0], flags: Parameters<typeof fs.open>[1], mode?: Parameters<typeof fs.open>[2]) => {
        const handle = await open(abs, flags, mode);
        if (active && String(abs).endsWith(`${path.sep}input.archive`) && typeof flags === "number" && !(flags & (constants.O_WRONLY | constants.O_RDWR))) {
          const close = handle.close.bind(handle);
          t.mock.method(handle, "close", async () => { closeCalls++; await close(); throw Object.assign(new Error(privateMarker), { code: "ENOSPC" }); });
        }
        return handle;
      });
      syncBuiltinESMExports();
      t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
      const response = await inject(filename);
      const expected = processing === "none" ? "ARCHIVE_STORAGE_EXHAUSTED" : processing === "quota" ? "ARCHIVE_LIMIT_EXCEEDED" : "ARCHIVE_INVALID";
      assert.equal(response.statusCode, processing === "none" ? 507 : processing === "quota" ? 413 : 400, response.body);
      assert.equal(response.json().code, expected);
      // FileHandle/ReadStream may join an in-flight close through more than one call.
      assert.ok(closeCalls >= 1);
      const summary = logs.map((line) => JSON.parse(line)).find((line) => line.msg === "Workspace archive extraction failed");
      assert.equal(summary?.originalCode, expected);
      assert.ok(!logs.join("").includes(privateMarker));
      assert.deepEqual((await fs.readdir(workspace.path)).sort(), ["empty.zip", filename]);
      assert.deepEqual(await fs.readFile(path.join(workspace.path, filename)), bytes);
      active = false;
      const next = await inject("empty.zip");
      assert.equal(next.statusCode, 200, next.body);
    });
  }
}

for (const committed of [false, true]) {
  for (const fault of ["unlink", "rmdir", "alias-observation"] as const) {
    test(`M2/PUB-08/18: ${fault} cleanup failure ${committed ? "after" : "before"} commit preserves uncertain state and releases admission`, async (t) => {
      let active = true;
      let stage = "";
      const { workspace, inject } = await setup(t, { archiveExtract: { hooks: { onPhase: ({ phase, staging }) => {
        if (!active) return;
        if (staging) stage = staging;
        if (!committed && phase === "before-commit") throw Object.assign(new Error("injected pre-commit failure"), { code: "EIO" });
      } } } });
      const bytes = zipFixture([{ name: "dir/file", data: "hello" }, { name: "root-file", data: "world" }]);
      await fs.writeFile(path.join(workspace.path, "input.zip"), bytes);
      await fs.writeFile(path.join(workspace.path, "empty.zip"), zipFixture([]));
      await fs.writeFile(path.join(workspace.path, "foreign-sentinel"), "keep");
      const original = { unlink: fs.unlink, rmdir: fs.rmdir, lstat: fs.lstat };
      let faulted = false;
      let aliasRemoved = false;
      const removedPath = () => committed ? path.join(stage, "payload/dir/file") : path.join(workspace.path, "dir/file");
      const survivorPath = () => committed ? path.join(workspace.path, "dir/file") : path.join(stage, "payload/dir/file");
      const unlinkMock = t.mock.method(mutableFs, "unlink", async (abs: Parameters<typeof fs.unlink>[0]) => {
        if (active && fault === "unlink" && !faulted && abs === path.join(stage, "owner.json")) {
          faulted = true;
          throw Object.assign(new Error("injected unlink failure"), { code: "EACCES" });
        }
        await original.unlink(abs);
        if (active && fault === "alias-observation" && abs === removedPath()) aliasRemoved = true;
      });
      const rmdirMock = t.mock.method(mutableFs, "rmdir", async (abs: Parameters<typeof fs.rmdir>[0], options?: Parameters<typeof fs.rmdir>[1]) => {
        if (active && fault === "rmdir" && !faulted && abs === path.join(stage, "payload")) {
          faulted = true;
          throw Object.assign(new Error("injected rmdir failure"), { code: "EIO" });
        }
        return original.rmdir(abs, options);
      });
      const lstatMock = t.mock.method(mutableFs, "lstat", (async (...args: Parameters<typeof fs.lstat>) => {
        if (active && fault === "alias-observation" && aliasRemoved && !faulted && args[0] === survivorPath()) {
          faulted = true;
          throw Object.assign(new Error("injected post-unlink alias observation failure"), { code: "EIO" });
        }
        return original.lstat(...args);
      }) as typeof fs.lstat);
      syncBuiltinESMExports();
      t.after(() => {
        unlinkMock.mock.restore(); rmdirMock.mock.restore(); lstatMock.mock.restore();
        syncBuiltinESMExports();
      });
      const response = await inject();
      assert.equal(response.statusCode, 500, response.body);
      assert.equal(response.json().code, "ARCHIVE_CLEANUP_INCOMPLETE");
      assert.equal(faulted, true, "the filesystem primitive or its post-unlink observation actually failed");
      active = false;
      assert.equal(await fs.readFile(path.join(workspace.path, "foreign-sentinel"), "utf8"), "keep");
      await assert.rejects(fs.lstat(path.join(stage, "input.archive")), { code: "ENOENT" });
      if (committed) {
        assert.equal(await fs.readFile(path.join(workspace.path, "dir/file"), "utf8"), "hello");
        assert.equal(await fs.readFile(path.join(workspace.path, "root-file"), "utf8"), "world");
      } else {
        await assert.rejects(fs.lstat(path.join(workspace.path, "dir/file")), { code: "ENOENT" });
        await assert.rejects(fs.lstat(path.join(workspace.path, "root-file")), { code: "ENOENT" });
      }
      if (fault === "alias-observation") {
        assert.equal(aliasRemoved, true);
        await assert.rejects(fs.lstat(removedPath()), { code: "ENOENT" });
        assert.equal(await fs.readFile(survivorPath(), "utf8"), "hello");
      } else if (fault === "unlink") {
        assert.equal(JSON.parse(await fs.readFile(path.join(stage, "owner.json"), "utf8")).version, 1);
      } else {
        assert.deepEqual(await fs.readdir(path.join(stage, "payload")), []);
      }
      const next = await inject("empty.zip");
      assert.equal(next.statusCode, 200, next.body);
      assert.deepEqual(await fs.readFile(path.join(workspace.path, "input.zip")), bytes);
    });
  }
}


for (const region of ["workspace", "repo"] as const) {
  for (const action of ["upload", "rename", "delete"] as const) {
    test(`M3/PUB-13: real ${action} in ${region} waits through staging and cleanup`, async (t) => {
      const staged = barrier(); const releaseStaging = barrier();
      const cleaning = barrier(); const releaseCleanup = barrier();
      let uploadAdmitted = false;
      const { fixture, workspace, app, inject } = await setup(t, {
        afterUploadMutationAdmitted: () => { uploadAdmitted = true; },
        archiveExtract: { hooks: { onPhase: async ({ phase }) => {
          if (phase === "staging-complete") { staged.resolve(); await releaseStaging.promise; }
          if (phase === "before-cleanup") { cleaning.resolve(); await releaseCleanup.promise; }
        } } }
      });
      let parent = workspace.path;
      const prefix = region === "repo" ? "repository/" : "";
      if (region === "repo") parent = (await createTestRepository(fixture, { workspace, dirName: "repository" })).workspaceRepo.path;
      await fs.writeFile(path.join(parent, "input.zip"), zipFixture([{ name: "output", data: "extracted" }]));
      await fs.writeFile(path.join(parent, "victim"), "keep-before-release");
      const base = `/api/workspaces/${workspace.id}/files`;
      const mutationUrl = `${base}/${action}${action === "upload" ? `?dir=${encodeURIComponent(prefix.slice(0, -1))}` : ""}`;
      const started = barrier();
      let partsConsumed = false;
      app.addHook("preHandler", async (req) => {
        if (req.url !== mutationUrl) return;
        if (action === "upload") {
          const upload = req as unknown as { parts: () => AsyncIterable<unknown> };
          const parts = upload.parts.bind(upload);
          upload.parts = () => { partsConsumed = true; return parts(); };
        }
        started.resolve();
      });
      const extraction = inject(`${prefix}input.zip`).then((response) => response);
      let mutation: Promise<Awaited<ReturnType<typeof app.inject>>> | undefined;
      try {
        await staged.promise;
        const boundary = "awb-extraction-mutation-boundary";
        const payload = action === "upload" ? {
          headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
          payload: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="uploaded.txt"\r\nContent-Type: text/plain\r\n\r\nuploaded\r\n--${boundary}--\r\n`)
        } : { payload: action === "rename" ? { from: `${prefix}victim`, to: `${prefix}renamed` } : { path: `${prefix}victim` } };
        let mutationSettled = false;
        mutation = app.inject({ method: "POST", url: mutationUrl, ...payload }).then((response) => { mutationSettled = true; return response; });
        await started.promise;
        await new Promise<void>((resolve) => setImmediate(resolve));
        const assertWaiting = async () => {
          assert.equal(mutationSettled, false);
          assert.equal(await fs.readFile(path.join(parent, "victim"), "utf8"), "keep-before-release");
          await assert.rejects(fs.lstat(path.join(parent, "renamed")), { code: "ENOENT" });
          await assert.rejects(fs.lstat(path.join(parent, "uploaded.txt")), { code: "ENOENT" });
          if (action === "upload") { assert.equal(uploadAdmitted, false); assert.equal(partsConsumed, false); }
        };
        await assertWaiting();
        await assert.rejects(fs.lstat(path.join(parent, "output")), { code: "ENOENT" });
        releaseStaging.resolve();
        await cleaning.promise;
        await assertWaiting();
        assert.equal(await fs.readFile(path.join(parent, "output"), "utf8"), "extracted");
        assert.ok((await fs.readdir(parent)).some((name) => name.startsWith(".awb-extract-")));
        releaseCleanup.resolve();
        const extracted = await extraction; assert.equal(extracted.statusCode, 200, extracted.body);
        const mutated = await mutation; assert.equal(mutated.statusCode, 200, mutated.body);
        assert.ok(!(await fs.readdir(parent)).some((name) => name.startsWith(".awb-extract-")));
        if (action === "upload") {
          assert.equal(uploadAdmitted, true); assert.equal(partsConsumed, true);
          assert.equal(await fs.readFile(path.join(parent, "uploaded.txt"), "utf8"), "uploaded");
        } else {
          await assert.rejects(fs.lstat(path.join(parent, "victim")), { code: "ENOENT" });
          if (action === "rename") assert.equal(await fs.readFile(path.join(parent, "renamed"), "utf8"), "keep-before-release");
        }
      } finally {
        releaseStaging.resolve(); releaseCleanup.resolve();
        await Promise.allSettled([extraction, mutation]);
      }
    });
  }
}
