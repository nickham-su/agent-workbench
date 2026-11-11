import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import swagger from "@fastify/swagger";
import { Value } from "@sinclair/typebox/value";
import { AgentAcceptUserMessageResponseSchema, AgentStopMessageQueueResponseSchema, AgentQueueErrorCodeSchema, ErrorResponseSchema } from "@agent-workbench/shared";
import { registerAuthGuards } from "../../../app/auth.js";
import { isHttpError } from "../../../app/errors.js";
import { AUTH_COOKIE_NAME, AUTH_SESSION_TTL_MS, createSessionCookieValue } from "../../../infra/auth/sessionCookie.js";
import { agentAttachmentTempDir } from "../attachments/agent-attachment-paths.js";
import { registerAgentMessageQueueRoutes } from "./message-queue.routes.js";
import { queueFixture, PNG, scope } from "./message-queue.testkit.js";

const base = "/api/agent/sessions/s1";
function form(payload: Record<string, unknown>, images = [{ filename: "test.png", bytes: PNG }]) {
  const boundary = "s4-isolated-form-boundary";
  const chunks = [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="payload"\r\n\r\n${JSON.stringify(payload)}\r\n`)];
  for (const image of images) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="images"; filename="${image.filename}"\r\nContent-Type: image/png\r\n\r\n`), image.bytes, Buffer.from("\r\n"));
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat(chunks) };
}
async function httpFixture(t: TestContext, authenticated = false) {
  const f = await queueFixture(t);
  const app = Fastify({ logger: false });
  const authToken = authenticated ? randomUUID() : null;
  await registerAuthGuards(app, { authToken, authCookieSecure: false, agentInternalToken: randomUUID() });
  await app.register(multipart, { limits: { fileSize: 2 * 1024 * 1024 * 1024, parts: 1_000_000 } });
  await app.register(swagger, { openapi: { info: { title: "S4 isolated queue", version: "1" } } });
  app.setErrorHandler((error, _request, reply) => {
    if (isHttpError(error)) return reply.code(error.statusCode).send({ message: error.message, code: error.code });
    if (error instanceof Error && "statusCode" in error && typeof error.statusCode === "number" && error.statusCode < 500)
      return reply.code(error.statusCode).send({ message: error.message });
    return reply.code(500).send({ message: "Internal Server Error" });
  });
  await registerAgentMessageQueueRoutes(app, { service: f.service, dataDir: f.dataDir });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const cookie = authToken ? `${AUTH_COOKIE_NAME}=${createSessionCookieValue({ authToken, nowMs: Date.now(), ttlMs: AUTH_SESSION_TTL_MS })}` : "";
  return { ...f, app, cookie };
}

test("isolated HTTP accepts JSON 202, exposes by-request/detail/snapshot without a fake Run and documents shared schema", async t => {
  const f = await httpFixture(t);
  const response = await f.app.inject({ method: "POST", url: `${base}/receipts`, payload: { workspaceId: "w1", clientRequestId: "a", text: " hello " } });
  assert.equal(response.statusCode, 202, response.body);
  const accepted = response.json(); assert.equal(Value.Check(AgentAcceptUserMessageResponseSchema, accepted), true);
  assert.equal(accepted.receipt.status, "queued"); assert.equal(accepted.receipt.messageId, null); assert.equal(accepted.receipt.runId, null);
  const query = await f.app.inject({ url: `${base}/receipts/by-request?workspaceId=w1&clientRequestId=a` });
  assert.equal(query.statusCode, 200); assert.equal(query.json().receipt.id, accepted.receipt.id);
  const detail = await f.app.inject({ url: `${base}/receipts/${accepted.receipt.id}?workspaceId=w1` });
  assert.equal(detail.statusCode, 200); assert.equal(detail.json().inputText, " hello "); assert.equal(detail.json().text, "hello");
  const snapshot = await f.app.inject({ url: `${base}/message-queue?workspaceId=w1` });
  assert.equal(snapshot.json().pendingCount, 1); assert.equal(snapshot.json().queueVersion, 1);
  const missing = await f.app.inject({ url: `${base}/receipts/by-request?workspaceId=w1&clientRequestId=missing` });
  assert.equal(missing.statusCode, 404);
  assert.ok(f.app.swagger().paths?.[`${base.replace("s1", "{sessionId}")}/receipts`]);
});

test("strict route validation rejects missing bodies and extra fields without silently stripping them", async t => {
  const f = await httpFixture(t);
  const accepted = await f.accept("a");
  const cases = [
    { method: "POST" as const, url: `${base}/receipts`, payload: { workspaceId: "w1", clientRequestId: "b", text: "hello", hidden: true } },
    { method: "POST" as const, url: `${base}/message-queue/stop`, payload: { workspaceId: "w1", operationId: "stop", expectedQueueVersion: 0 } },
    { method: "POST" as const, url: `${base}/message-queue/stop` },
    { method: "POST" as const, url: `${base}/receipts/${accepted.receipt.id}/cancel`, payload: { workspaceId: "w1", extra: 1 } },
    { method: "GET" as const, url: `${base}/message-queue?workspaceId=w1&extra=x` },
    { method: "GET" as const, url: "/api/agent/attachment-retention?extra=x" },
  ];
  for (const input of cases) {
    const response = await f.app.inject(input);
    assert.equal(response.statusCode, 400, `${input.url}: ${response.body}`);
  }
  assert.equal(f.store.snapshot(scope).pendingCount, 1);
  assert.equal(f.store.snapshot(scope).mode, "active");
});

test("HTTP multipart uses shared receipt payload, deduplicates changed temp IDs and revokes cancelled image authorization", async t => {
  const f = await httpFixture(t);
  const input = { workspaceId: "w1", clientRequestId: "image", text: "" };
  const first = await f.app.inject({ method: "POST", url: `${base}/receipts`, ...form(input) });
  assert.equal(first.statusCode, 202, first.body);
  const accepted = first.json();
  const retry = await f.app.inject({ method: "POST", url: `${base}/receipts`, ...form(input) });
  assert.equal(retry.statusCode, 202, retry.body); assert.equal(retry.json().receipt.id, accepted.receipt.id); assert.equal(retry.json().deduplicated, true);
  const detail = await f.app.inject({ url: `${base}/receipts/${accepted.receipt.id}?workspaceId=w1` });
  const image = detail.json().attachments[0];
  assert.equal("storageKey" in image, false); assert.equal("path" in image, false);
  const url = `${base}/receipts/${accepted.receipt.id}/attachments/${image.id}/content?workspaceId=w1`;
  const imageResponse = await f.app.inject({ url });
  assert.equal(imageResponse.statusCode, 200); assert.deepEqual(imageResponse.rawPayload, PNG);
  assert.equal(imageResponse.headers["cache-control"], "no-store"); assert.equal(imageResponse.headers["x-content-type-options"], "nosniff");
  assert.equal((await f.app.inject({ url: url.replace("workspaceId=w1", "workspaceId=other") })).statusCode, 404);
  assert.equal((await f.app.inject({ url: url.replace(accepted.receipt.id, "unknown") })).statusCode, 404);
  const cancelled = await f.app.inject({ method: "POST", url: `${base}/receipts/${accepted.receipt.id}/cancel`, payload: { workspaceId: "w1" } });
  assert.equal(cancelled.statusCode, 200); assert.equal(cancelled.json().receipt.status, "cancelled");
  assert.equal((await f.app.inject({ url })).statusCode, 404);
});

test("HTTP multipart rejects invalid payload and image signatures and cleans private staging files", async t => {
  const f = await httpFixture(t);
  for (const input of [
    form({ workspaceId: "w1", clientRequestId: "extra", text: "", extra: true }),
    form({ workspaceId: "w1", clientRequestId: "invalid", text: "" }, [{ filename: "test.png", bytes: Buffer.from("not png") }]),
  ]) {
    const response = await f.app.inject({ method: "POST", url: `${base}/receipts`, ...input });
    assert.equal(response.statusCode, 400, response.body);
  }
  assert.equal(f.store.snapshot(scope).pendingCount, 0);
  const temps = await fs.readdir(agentAttachmentTempDir(f.dataDir)).catch(() => []);
  assert.equal(temps.length, 0);
});

test("HTTP controlled image rejects a modified published file without exposing its private path", async t => {
  const f = await httpFixture(t);
  const response = await f.app.inject({ method: "POST", url: `${base}/receipts`, ...form({ workspaceId: "w1", clientRequestId: "image" }) });
  assert.equal(response.statusCode, 202, response.body); const id = response.json().receipt.id;
  const image = f.store.attachments(scope, id)[0]!;
  await fs.writeFile(path.join(f.workspacePath, ".awb", "agent", "attachments", image.storageKey), Buffer.concat([PNG.subarray(0, 11), Buffer.from([1])]));
  const content = await f.app.inject({ url: `${base}/receipts/${id}/attachments/${image.id}/content?workspaceId=w1` });
  assert.equal(content.statusCode, 404); assert.equal(content.body.includes(f.dataDir), false);
});

test("HTTP Stop replays stable acceptance and current snapshot; recovery routes reject malformed input", async t => {
  const f = await httpFixture(t); await f.accept("first");
  const stop = () => f.app.inject({ method: "POST", url: `${base}/message-queue/stop`, payload: { workspaceId: "w1", operationId: "stop" } });
  const first = await stop(); assert.equal(first.statusCode, 200, first.body);
  assert.equal(Value.Check(AgentStopMessageQueueResponseSchema, first.json()), true);
  assert.equal(first.json().queue.stop.state, "quiescent", "no sent runtime targets, not inferred from DB terminal");
  await f.accept("after-stop");
  const retry = await stop();
  assert.deepEqual(retry.json().stopOperation, first.json().stopOperation);
  assert.equal(retry.json().queue.pendingCount, 2); assert.equal(retry.json().queue.mode, "paused");
  for (const endpoint of ["resume", "abandon-unconfirmed"]) {
    assert.equal((await f.app.inject({ method: "POST", url: `${base}/message-queue/${endpoint}`, payload: {} })).statusCode, 400);
  }
});

test("queue routes retain the existing global authentication boundary", async t => {
  const f = await httpFixture(t, true);
  const request = { method: "POST" as const, url: `${base}/receipts`, payload: { workspaceId: "w1", clientRequestId: "auth", text: "hello" } };
  assert.equal((await f.app.inject(request)).statusCode, 401);
  const accepted = await f.app.inject({ ...request, headers: { cookie: f.cookie } });
  assert.equal(accepted.statusCode, 202, accepted.body);
});

test("HTTP multipart staging rejects an unsafe private directory without echoing filesystem paths", async t => {
  const f = await httpFixture(t);
  const temp = agentAttachmentTempDir(f.dataDir);
  await fs.mkdir(path.dirname(temp), { recursive: true });
  await fs.symlink(f.workspacePath, temp, "dir");
  const response = await f.app.inject({ method: "POST", url: `${base}/receipts`, ...form({ workspaceId: "w1", clientRequestId: "unsafe" }) });
  assert.equal(response.statusCode, 503, response.body);
  assert.equal(response.json().message, "Image upload could not be staged safely");
  assert.equal(response.body.includes(f.dataDir), false);
  assert.equal(f.store.snapshot(scope).pendingCount, 0);
});


test("recovery HTTP never strips extra receipt IDs, hashes, or explicit confirmation fields", async t => {
  const f = await httpFixture(t); await f.accept("recovery-http"); f.service.stop(scope, "stop-recovery-http");
  const snapshot = f.store.snapshot(scope);
  const resume = { workspaceId: "w1", operationId: "resume-http", expectedQueueVersion: snapshot.queueVersion };
  const abandon = { ...resume, operationId: "abandon-http", expectedUnconfirmedInputSetHash: "0".repeat(64), confirmIrreversible: true };
  for (const [endpoint, payload] of [["resume", { ...resume, receiptIds: [] }], ["abandon-unconfirmed", { ...abandon, receiptIds: [] }],
    ["abandon-unconfirmed", { ...abandon, confirmIrreversible: false }], ["abandon-unconfirmed", { ...abandon, expectedUnconfirmedInputSetHash: "bad" }]] as const) {
    const response = await f.app.inject({ method: "POST", url: `${base}/message-queue/${endpoint}`, payload });
    assert.equal(response.statusCode, 400, response.body); assert.equal(f.store.snapshot(scope).queueVersion, snapshot.queueVersion);
  }
  const resumed = await f.app.inject({ method: "POST", url: `${base}/message-queue/resume`, payload: resume });
  assert.equal(resumed.statusCode, 200, resumed.body); assert.equal(resumed.json().action, "dispatch_queued"); assert.equal(f.enqueued.length, 0);
});

for (const kind of ["resume", "abandon"] as const) test(`HTTP ${kind} replay preserves its original action but reports Stop/enqueue/cancel current snapshot`, async t => {
  const f = await httpFixture(t);
  const trigger = await f.accept("replay-trigger");
  if (kind === "abandon") {
    await f.dispatcher.dispatchSession(scope); const run = f.enqueued[0]!;
    f.finish(run.runId, "failed"); f.runtimeStore.retireAdmission({ ...scope, runId: run.runId, runtimeInstanceId: f.runtimeInstanceId });
  } else f.service.stop(scope, "stop-before-resume-replay");
  const initial = f.store.snapshot(scope), payload = { workspaceId: scope.workspaceId, operationId: `http-${kind}-replay`, expectedQueueVersion: initial.queueVersion,
    ...(kind === "abandon" ? { expectedUnconfirmedInputSetHash: initial.unconfirmedInputSetHash!, confirmIrreversible: true } : {}) };
  const url = `${base}/message-queue/${kind === "resume" ? "resume" : "abandon-unconfirmed"}`;
  const original = await f.app.inject({ method: "POST", url, payload }); assert.equal(original.statusCode, 200, original.body);
  const originalBody = original.json();
  const assertReplay = async () => {
    const before = f.store.snapshot(scope), calls = f.stopCalls.length, enqueues = f.enqueued.length;
    const operations = f.db.prepare("select count(*) as n from agent_queue_operation").get();
    const replay = await f.app.inject({ method: "POST", url, payload }); assert.equal(replay.statusCode, 200, replay.body);
    const { queue: _queue, ...action } = replay.json(), { queue: _oldQueue, ...oldAction } = originalBody;
    assert.deepEqual(action, oldAction); assert.deepEqual(replay.json().queue, before);
    assert.ok(before.queueVersion > originalBody.queue.queueVersion); assert.deepEqual(f.store.snapshot(scope), before);
    assert.equal(f.stopCalls.length, calls); assert.equal(f.enqueued.length, enqueues);
    assert.deepEqual(f.db.prepare("select count(*) as n from agent_queue_operation").get(), operations);
  };
  f.service.stop(scope, `stop-after-${kind}`); await assertReplay();
  const later = await f.accept(`queued-after-${kind}`); await assertReplay();
  const cancelled = await f.app.inject({ method: "POST", url: `${base}/receipts/${later.receipt.id}/cancel`, payload: { workspaceId: scope.workspaceId } });
  assert.equal(cancelled.statusCode, 200, cancelled.body); await assertReplay();
  assert.equal(f.store.snapshot(scope).pauseCode, "user_stop");
  if (kind === "abandon") assert.equal(f.store.get(scope, trigger.receipt.id).confirmation_state, "abandoned");
});

for (const empty of [true, false]) test(`HTTP abandon uses the shared ${empty ? "empty-input" : "stale-set"} error code without mutation`, async t => {
  const f = await httpFixture(t);
  if (!empty) {
    await f.accept("unconfirmed-set"); await f.dispatcher.dispatchSession(scope); const run = f.enqueued[0]!;
    f.finish(run.runId, "failed"); f.runtimeStore.retireAdmission({ ...scope, runId: run.runId, runtimeInstanceId: f.runtimeInstanceId });
  }
  const before = f.store.snapshot(scope);
  const payload = { workspaceId: scope.workspaceId, operationId: "invalid-abandon-set", expectedQueueVersion: before.queueVersion,
    expectedUnconfirmedInputSetHash: "0".repeat(64), confirmIrreversible: true };
  const response = await f.app.inject({ method: "POST", url: `${base}/message-queue/abandon-unconfirmed`, payload });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().code, empty ? "AGENT_NO_UNCONFIRMED_INPUT" : "AGENT_UNCONFIRMED_SET_CONFLICT");
  assert.equal(Value.Check(AgentQueueErrorCodeSchema, response.json().code), true);
  assert.equal(Value.Check(ErrorResponseSchema, response.json()), true);
  assert.deepEqual(f.store.snapshot(scope), before);
  for (const invalid of [{ ...payload, receiptIds: [] }, { ...payload, confirmIrreversible: false }, { ...payload, expectedUnconfirmedInputSetHash: "bad" }]) {
    assert.equal((await f.app.inject({ method: "POST", url: `${base}/message-queue/abandon-unconfirmed`, payload: invalid })).statusCode, 400);
    assert.deepEqual(f.store.snapshot(scope), before);
  }
});

for(const fault of ["stop_pending","invalid_profile"] as const) test(`HTTP recovery CAS wins over ${fault} without mutations or a new Run`,async t=>{
  const f=await httpFixture(t); await f.accept("cas-first");
  const activated=await f.dispatcher.dispatchSession(scope); assert.ok(activated);
  const version=f.store.snapshot(scope).queueVersion;
  if(fault==="stop_pending") {
    f.runtime.stopSession({...scope,rootSessionId:scope.sessionId,operationId:"pending-stop"});
    assert.equal(f.store.snapshot(scope).stop.state,"pending");
  } else {
    f.finish(activated.runId,"failed"); f.runtimeStore.retireAdmission({...scope,runId:activated.runId,runtimeInstanceId:f.runtimeInstanceId});
    f.setProfileError(new Error("invalid profile must not mask version conflict"));
  }
  const before=f.store.snapshot(scope), operations=f.db.prepare("select count(*) as n from agent_queue_operation").get();
  const runs=f.db.prepare("select count(*) as n from agent_run").get();
  const response=await f.app.inject({method:"POST",url:`${base}/message-queue/resume`,payload:{workspaceId:scope.workspaceId,operationId:"stale-resume",expectedQueueVersion:Math.max(0,version-1)}});
  assert.equal(response.statusCode,409,response.body);assert.equal(response.json().code,"AGENT_QUEUE_VERSION_CONFLICT");
  assert.deepEqual(f.store.snapshot(scope),before);assert.deepEqual(f.db.prepare("select count(*) as n from agent_queue_operation").get(),operations);
  assert.deepEqual(f.db.prepare("select count(*) as n from agent_run").get(),runs);assert.equal(f.enqueued.length,1);
});
