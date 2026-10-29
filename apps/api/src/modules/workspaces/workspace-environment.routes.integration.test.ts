import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, test } from "node:test";
import Fastify from "fastify";
import Database from "better-sqlite3";
import { createApp } from "../../app/createApp.js";
import type { AppContext } from "../../app/context.js";
import { initSchema } from "../../infra/db/schema.js";
import { insertWorkspace } from "./workspace.store.js";
import { workspaceRoot } from "../../infra/fs/paths.js";
import { workspaceDeletingFence } from "../agent/lifecycle/workspace-deleting-fence.js";
import { registerAuthGuards } from "../../app/auth.js";
import { registerWorkspacesModule } from "./workspaces.module.js";
import { getWorkspaceEnvironmentService } from "./workspace-environment.service.js";
import { AUTH_COOKIE_NAME, createSessionCookieValue } from "../../infra/auth/sessionCookie.js";
import { deleteWorkspace } from "./workspace.service.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture(authToken: string | null = null, fullApp = false, durableFence = false) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-env-api-"));
  const db = new Database(":memory:"); db.pragma("foreign_keys = ON"); initSchema(db);
  const workspaceId = `ws_${randomUUID()}`; const otherId = `ws_${randomUUID()}`;
  for (const id of [workspaceId, otherId]) {
    const workspacePath = workspaceRoot(dataDir, id);
    await fs.mkdir(workspacePath, { recursive: true });
    insertWorkspace(db, { id, dirName: id, title: "Environment test", path: workspacePath, terminalCredentialId: null, createdAt: 1, updatedAt: 1 });
  }
  if (durableFence) db.prepare("insert into workspace_deletion(workspace_id,dir_name,requested_at,updated_at) values(?,?,1,1)").run(workspaceId, workspaceId);
  const ctx: AppContext = {
    db, repoRoot: process.cwd(), dataDir, fileMaxBytes: 1024, version: "test", logLevel: "fatal", serveWeb: false, webDistDir: null,
    credentialMasterKey: Buffer.alloc(32, 23), credentialMasterKeySource: "generated", credentialMasterKeyId: "fixture", credentialMasterKeyCreatedAt: 1,
    authToken, authCookieSecure: false, agentWorkerEnabled: false, agentWorkerHost: "127.0.0.1", agentWorkerPort: 0,
    agentWorkerSocketPath: path.join(dataDir, "worker.sock"), agentWorkerConcurrency: 1, agentInternalToken: "fixture-internal-not-a-secret",
    agentWorkerResponseValidation: "strict", agentApiOrigin: "http://127.0.0.1:0", agentPluginHostEnabled: false,
    agentPluginHostSocketPath: path.join(dataDir, "plugin.sock"), agentPluginServicesEnabled: false, preview: { enabled: false, runtime: null }
  };
  const logs: string[] = [];
  const stream = new Writable({ write(chunk, _encoding, done) { logs.push(String(chunk)); done(); } });
  const app = fullApp ? await createApp(ctx) : Fastify({ logger: { level: "trace", stream } });
  if (!fullApp) { await registerAuthGuards(app, ctx); await registerWorkspacesModule(app, ctx); }
  await app.ready();
  const publicPath = `/api/workspaces/${workspaceId}/environment-variables`;
  const internalPath = `/api/internal/workspaces/${workspaceId}/environment`;
  const internalHeaders = { "x-awb-agent-internal-token": ctx.agentInternalToken };
  const cookie = authToken ? { cookie: `${AUTH_COOKIE_NAME}=${createSessionCookieValue({ authToken, nowMs: Date.now(), ttlMs: 60000 })}` } : {};
  cleanups.push(async () => { await app.close(); db.close(); for (const id of [workspaceId, otherId]) workspaceDeletingFence.end(id); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { app, ctx, db, workspaceId, otherId, publicPath, internalPath, internalHeaders, cookie, logs };
}

test("environment routes integrate with real createApp, persist encrypted data and do not expand WorkspaceDetail", async () => {
  const { app, db, workspaceId, publicPath, internalPath, internalHeaders } = await fixture(null, true);
  const marker = "prototype-placeholder-not-a-real-secret";
  const create = await app.inject({ method: "POST", url: publicPath, payload: { name: "TOKEN", value: marker } });
  assert.equal(create.statusCode, 201); assert.equal(create.headers["cache-control"], "no-store");
  const variable = create.json(); assert.equal(variable.value, marker); assert.equal(variable.remark, ""); assert.equal(variable.enabled, true);
  const list = await app.inject(publicPath); assert.equal(list.statusCode, 200); assert.equal(list.json().length, 1);
  assert.equal(list.headers["cache-control"], "no-store");
  const env = await app.inject({ url: internalPath, headers: internalHeaders });
  assert.equal(env.statusCode, 200); assert.equal(env.headers["cache-control"], "no-store");
  assert.deepEqual(env.json(), { workspaceId, env: { TOKEN: marker } });
  const detail = await app.inject(`/api/workspaces/${workspaceId}`);
  assert.equal(detail.statusCode, 200); assert.equal(detail.body.includes(marker), false);
  const rows = db.prepare("select * from workspace_environment_variables").all();
  assert.equal(JSON.stringify(rows).includes(marker), false);
  const definitions = await app.inject("/api/openapi.json");
  assert.equal(definitions.statusCode, 200); assert.equal(definitions.body.includes(marker), false);
  assert.ok(definitions.json().paths[publicPath.replace(workspaceId, "{workspaceId}")]);
});

test("environment public Cookie authentication and independent internal token authentication remain enforced", async () => {
  const { app, publicPath, internalPath, internalHeaders, cookie } = await fixture("fixture-web-not-a-secret");
  for (const response of [await app.inject(publicPath), await app.inject({ method: "POST", url: publicPath, payload: { name: "A", value: "" } }), await app.inject(internalPath), await app.inject({ url: internalPath, headers: { "x-awb-agent-internal-token": "incorrect" } })]) {
    assert.equal(response.statusCode, 401); assert.equal(response.headers["cache-control"], "no-store");
  }
  assert.equal((await app.inject({ url: publicPath, headers: cookie })).statusCode, 200);
  assert.equal((await app.inject({ url: internalPath, headers: cookie })).statusCode, 401);
  assert.equal((await app.inject({ url: internalPath, headers: internalHeaders })).statusCode, 200);
  const disabledAuth = await fixture();
  assert.equal((await disabledAuth.app.inject(disabledAuth.internalPath)).statusCode, 401);
});

test("environment route strict validation precedes AJV coercion/removal and errors never echo input", async () => {
  const { app, publicPath } = await fixture();
  const marker = "private-invalid-value-marker";
  for (const payload of [
    { name: "A", value: marker, extra: marker }, { name: "A", value: marker, enabled: "false" }, { name: "A", value: 123 },
    { name: "A", value: null }, { name: " A", value: marker }, { name: "A", value: "\ud800" }, { name: "A", value: "", remark: "\udfff" }, { name: "A", value: "\0" }
  ]) {
    const result = await app.inject({ method: "POST", url: publicPath, payload });
    assert.equal(result.statusCode, 400); assert.equal(result.json().code, "WORKSPACE_ENV_INVALID_INPUT");
    assert.equal(result.headers["cache-control"], "no-store"); assert.equal(result.body.includes(marker), false);
  }
  const malformed = await app.inject({ method: "POST", url: publicPath, headers: { "content-type": "application/json" }, payload: `{"value":"${marker}` });
  assert.equal(malformed.statusCode, 400); assert.equal(malformed.json().code, "WORKSPACE_ENV_INVALID_INPUT"); assert.equal(malformed.body.includes(marker), false);
  const protectedName = await app.inject({ method: "POST", url: publicPath, payload: { name: "AWB_PRIVATE", value: marker } });
  assert.equal(protectedName.json().code, "WORKSPACE_ENV_RESERVED_NAME");
  const overLimit = await app.inject({ method: "POST", url: publicPath, payload: { name: "A", value: "😀".repeat(4096) + "x" } });
  assert.equal(overLimit.json().code, "WORKSPACE_ENV_LIMIT_EXCEEDED");
  const remarkLimit = await app.inject({ method: "POST", url: publicPath, payload: { name: "A", value: "", remark: "😀".repeat(80) + "x" } });
  assert.equal(remarkLimit.json().code, "WORKSPACE_ENV_LIMIT_EXCEEDED");
  assert.deepEqual((await app.inject(publicPath)).json(), []);
});

test("environment routes update only submitted fields and return exact empty/false values", async () => {
  const { app, publicPath, internalPath, internalHeaders } = await fixture();
  const value = " \r\n😀$PATH$(no-run) ";
  const created = (await app.inject({ method: "POST", url: publicPath, payload: { name: "A", value } })).json();
  const itemPath = `${publicPath}/${created.id}`;
  const edited = await app.inject({ method: "PATCH", url: itemPath, payload: { remark: "remarks only" } });
  assert.equal(edited.statusCode, 200); assert.equal(edited.json().value, value); assert.equal(edited.json().createdAt, created.createdAt);
  const empty = await app.inject({ method: "PATCH", url: itemPath, payload: {} }); assert.equal(empty.statusCode, 400);
  const unknown = await app.inject({ method: "PUT", url: `${itemPath}/enabled`, payload: { enabled: false, value: "bad" } }); assert.equal(unknown.statusCode, 400);
  const disabled = await app.inject({ method: "PUT", url: `${itemPath}/enabled`, payload: { enabled: false } });
  assert.equal(disabled.json().enabled, false); assert.equal(disabled.json().value, value);
  assert.deepEqual((await app.inject({ url: internalPath, headers: internalHeaders })).json().env, {});
  const clear = await app.inject({ method: "PATCH", url: itemPath, payload: { value: "", remark: "", enabled: true } });
  assert.equal(clear.json().value, ""); assert.equal(clear.json().remark, "");
  assert.deepEqual((await app.inject({ url: internalPath, headers: internalHeaders })).json().env, { A: "" });
  const removed = await app.inject({ method: "DELETE", url: itemPath }); assert.equal(removed.statusCode, 204); assert.equal(removed.body, "");
  assert.equal((await app.inject({ method: "DELETE", url: itemPath })).statusCode, 404);
});

test("environment route cross-Workspace IDs do not read/mutate foreign rows, and concurrent create has one winner", async () => {
  const { app, publicPath, otherId } = await fixture();
  const otherPath = `/api/workspaces/${otherId}/environment-variables`;
  const foreign = (await app.inject({ method: "POST", url: otherPath, payload: { name: "A", value: "foreign-marker" } })).json();
  for (const request of [{ method: "PATCH" as const, payload: { value: "changed" } }, { method: "DELETE" as const }, { method: "PUT" as const, payload: { enabled: false } }]) {
    const suffix = request.method === "PUT" ? "/enabled" : "";
    const response = await app.inject({ ...request, url: `${publicPath}/${foreign.id}${suffix}` });
    assert.equal(response.statusCode, 404); assert.equal(response.json().code, "WORKSPACE_ENV_VARIABLE_NOT_FOUND"); assert.equal(response.body.includes("foreign-marker"), false);
  }
  const results = await Promise.all([1, 2].map(() => app.inject({ method: "POST", url: publicPath, payload: { name: "A", value: "" } })));
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [201, 409]);
  assert.equal((await app.inject(otherPath)).json()[0].value, "foreign-marker");
});

test("environment internal serialization preserves special own-property names and disabled state", async () => {
  const { app, publicPath, internalPath, internalHeaders } = await fixture();
  for (const name of ["__proto__", "constructor", "toString", "HTTP_PROXY", "http_proxy"]) {
    assert.equal((await app.inject({ method: "POST", url: publicPath, payload: { name, value: `literal-${name}` } })).statusCode, 201);
  }
  await app.inject({ method: "POST", url: publicPath, payload: { name: "DISABLED", value: "hidden", enabled: false } });
  const result = await app.inject({ url: internalPath, headers: internalHeaders });
  assert.equal(result.statusCode, 200);
  const env = result.json().env;
  for (const name of ["__proto__", "constructor", "toString", "HTTP_PROXY", "http_proxy"]) assert.equal(Object.hasOwn(env, name) && env[name], `literal-${name}`);
  assert.equal(Object.hasOwn(env, "DISABLED"), false);
});

test("environment durable deletion fence restores before routes, including cache-hit reads", async () => {
  const { app, publicPath, internalPath, internalHeaders, workspaceId } = await fixture(null, false, true);
  assert.equal(workspaceDeletingFence.isDeleting(workspaceId), true);
  for (const response of [await app.inject(publicPath), await app.inject({ url: internalPath, headers: internalHeaders }), await app.inject({ method: "POST", url: publicPath, payload: { name: "A", value: "" } })]) {
    assert.equal(response.statusCode, 409); assert.equal(response.json().code, "WORKSPACE_DELETING"); assert.equal(response.headers["cache-control"], "no-store");
  }
});

test("environment final Workspace deletion invalidates before releasing the fence and never resurrects cache", async () => {
  const { ctx, app, publicPath, workspaceId, otherId } = await fixture();
  const service = getWorkspaceEnvironmentService(ctx);
  await service.create(workspaceId, { name: "A", value: "old" });
  await service.create(otherId, { name: "A", value: "other" });
  service.readEnvironment(workspaceId);
  const originalEnd = workspaceDeletingFence.end;
  let validatedOrder = false;
  workspaceDeletingFence.end = function (id: string) {
    if (id === workspaceId) {
      // Temporarily release the fence: if invalidation has not occurred this would revive old plaintext.
      originalEnd.call(this, id);
      assert.throws(() => service.readEnvironment(id), (error: any) => error.code === "WORKSPACE_NOT_FOUND");
      validatedOrder = true;
      return;
    }
    originalEnd.call(this, id);
  };
  try { await deleteWorkspace(ctx, app.log, workspaceId); }
  finally { workspaceDeletingFence.end = originalEnd; }
  assert.equal(validatedOrder, true);
  assert.equal(workspaceDeletingFence.isDeleting(workspaceId), false);
  assert.equal((await app.inject(publicPath)).statusCode, 404);
  assert.equal(service.readEnvironment(otherId).A, "other");
});

test("environment decrypt failures stay safe/no-store and do not become successful empty snapshots", async () => {
  const { app, db, ctx, publicPath, internalPath, internalHeaders, workspaceId } = await fixture();
  const created = (await app.inject({ method: "POST", url: publicPath, payload: { name: "A", value: "plaintext-marker", enabled: false } })).json();
  const secretCipher = "private-corrupt-ciphertext-marker";
  db.prepare("update workspace_environment_variables set value_enc=? where id=?").run(secretCipher, created.id);
  getWorkspaceEnvironmentService(ctx).invalidate(workspaceId);
  for (const response of [await app.inject(publicPath), await app.inject({ url: internalPath, headers: internalHeaders })]) {
    assert.equal(response.statusCode, 500); assert.equal(response.json().code, "WORKSPACE_ENV_DECRYPT_FAILED");
    assert.equal(response.headers["cache-control"], "no-store"); assert.equal(response.body.includes(secretCipher), false); assert.equal(response.body.includes("plaintext-marker"), false);
  }
  const repaired = await app.inject({ method: "PATCH", url: `${publicPath}/${created.id}`, payload: { value: "" } });
  assert.equal(repaired.statusCode, 200);
  assert.equal((await app.inject({ url: internalPath, headers: internalHeaders })).statusCode, 200);
});

test("environment safe errors and request logging exclude body, plaintext and raw dependency exceptions", async () => {
  const { app, db, ctx, publicPath, internalPath, internalHeaders, workspaceId, logs } = await fixture();
  const marker = "private-payload-and-exception-fixture-marker";
  await app.inject({ method: "POST", url: publicPath, payload: { name: "A", value: marker } });
  await app.inject({ method: "POST", url: publicPath, payload: { name: "B", value: marker, extra: marker } });
  getWorkspaceEnvironmentService(ctx).invalidate(workspaceId);
  const original = db.prepare;
  db.prepare = (() => { throw Object.assign(new Error(marker), { code: "SQLITE_BUSY" }); }) as typeof db.prepare;
  try {
    const response = await app.inject({ url: internalPath, headers: internalHeaders });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().code, "WORKSPACE_ENV_UNAVAILABLE");
    assert.equal(response.body.includes(marker), false);
  } finally { db.prepare = original; }
  assert.equal(logs.join("").includes(marker), false);
  assert.equal(logs.join("").includes(ctx.agentInternalToken), false);
});
