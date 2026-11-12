import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { request } from "node:http";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import swagger from "@fastify/swagger";
import { Value } from "@sinclair/typebox/value";
import { AgentAcceptUserMessageResponseSchema, AgentStopMessageQueueResponseSchema, AgentQueueErrorCodeSchema } from "@agent-workbench/shared";
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
  assert.equal(accepted.receipt.status, "injected"); assert.ok(accepted.receipt.messageId); assert.ok(accepted.receipt.runId);
  const query = await f.app.inject({ url: `${base}/receipts/by-request?workspaceId=w1&clientRequestId=a` });
  assert.equal(query.statusCode, 200); assert.equal(query.json().receipt.id, accepted.receipt.id);
  const detail = await f.app.inject({ url: `${base}/receipts/${accepted.receipt.id}?workspaceId=w1` });
  assert.equal(detail.statusCode, 200); assert.equal(detail.json().inputText, " hello "); assert.equal(detail.json().text, "hello");
  const snapshot = await f.app.inject({ url: `${base}/message-queue?workspaceId=w1` });
  assert.equal(snapshot.json().pendingCount, 0); assert.ok(snapshot.json().queueVersion >= 1);
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
  assert.equal(f.store.snapshot(scope).pendingCount, 0);
});

test("HTTP multipart uses shared receipt payload, deduplicates changed temp IDs and revokes cancelled image authorization", async t => {
  const f = await httpFixture(t);
  const trigger = await f.accept("image-trigger");
  const input = { workspaceId: "w1", clientRequestId: "image", text: "", targetRunId: trigger.receipt.runId };
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

test("HTTP Stop replays stable acceptance and current snapshot; removed recovery routes are absent", async t => {
  const f = await httpFixture(t);
  const stop = () => f.app.inject({ method: "POST", url: `${base}/message-queue/stop`, payload: { workspaceId: "w1", operationId: "stop" } });
  const first = await stop(); assert.equal(first.statusCode, 200, first.body);
  assert.equal(Value.Check(AgentStopMessageQueueResponseSchema, first.json()), true);
  assert.equal(first.json().queue.stop.state, "quiescent", "no sent runtime targets, not inferred from DB terminal");
  await f.accept("after-stop"); await f.accept("after-stop-supplement");
  const retry = await stop();
  assert.deepEqual(retry.json().stopOperation, first.json().stopOperation);
  assert.equal(retry.json().queue.pendingCount, 1); for (const endpoint of ["resume", "abandon-unconfirmed"]) {
    assert.equal((await f.app.inject({ method: "POST", url: `${base}/message-queue/${endpoint}`, payload: {} })).statusCode, 404);
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


test("removed recovery endpoints cannot start Runs or change receipts", async t => {
  const f = await httpFixture(t); const first = await f.accept("history");
  assert.equal(first.receipt.status, "injected");
  f.finish(first.receipt.runId, "failed");
  f.runtimeStore.retireAdmission({ ...scope, runId: first.receipt.runId, runtimeInstanceId: f.runtimeInstanceId });
  const before = f.db.prepare("select * from agent_user_message_receipt order by id").all();
  const runs = f.db.prepare("select count(*) as n from agent_run").get();
  for (const endpoint of ["resume", "abandon-unconfirmed"]) {
    const response = await f.app.inject({ method: "POST", url: `${base}/message-queue/${endpoint}`, payload: { workspaceId: "w1", operationId: endpoint } });
    assert.equal(response.statusCode, 404);
  }
  assert.deepEqual(f.db.prepare("select * from agent_user_message_receipt order by id").all(), before);
  assert.deepEqual(f.db.prepare("select count(*) as n from agent_run").get(), runs);
});

for (const image of [false, true]) test(`HTTP legacy ${image ? "multipart image" : "JSON text"} captures Stop generation before body streaming`, { timeout: 15_000 }, async t => {
  const f = await httpFixture(t);
  let markCaptured!: () => void;
  const captured = new Promise<void>(resolve => { markCaptured = resolve; });
  const original = f.service.captureStopGeneration.bind(f.service);
  t.mock.method(f.service, "captureStopGeneration", (...args: Parameters<typeof original>) => {
    const generation = original(...args); markCaptured(); return generation;
  });
  const payload = { workspaceId: scope.workspaceId, clientRequestId: "stream-before-stop", text: "late input" };
  const body = image ? form(payload) : { headers: { "content-type": "application/json" }, payload: Buffer.from(JSON.stringify(payload)) };
  const address = f.app.server.address(); assert.ok(address && typeof address !== "string");
  let req!: ReturnType<typeof request>;
  const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
    req = request({ hostname: "127.0.0.1", port: address.port, path: `${base}/receipts`, method: "POST",
      headers: { ...body.headers, "content-length": body.payload.length } }, res => {
      const chunks: Buffer[] = []; res.on("data", chunk => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("error", reject); req.flushHeaders();
  });
  t.after(() => req.destroy());
  await captured;
  f.service.stop(scope, "stream-stop");
  req.end(body.payload);
  const result = await response;
  assert.equal(result.status, 409, result.body);
  assert.equal(JSON.parse(result.body).code, "AGENT_QUEUE_STOP_GENERATION_CHANGED");
  assert.equal(f.store.snapshot(scope).pendingCount, 0);
  assert.equal((f.db.prepare("select count(*) as n from agent_user_message_receipt").get() as { n: number }).n, 0);
  assert.equal(f.enqueued.length, 0);
});

test("HTTP clear is strict, scoped and independent from Stop; retries use only original receipt IDs", async t => {
  const f = await httpFixture(t); await f.accept("clear-trigger"); const a = await f.accept("http-clear");
  const clear = (payload: unknown) => f.app.inject({ method: "POST", url: `${base}/message-queue/clear`, payload: payload as object });
  for (const payload of [null, {}, { workspaceId: "w1", receiptIds: [a.receipt.id, a.receipt.id] },
    { workspaceId: "w1", receiptIds: [], operationId: "not-supported" }, { workspaceId: "w1", receiptIds: Array.from({ length: 101 }, (_, i) => String(i)) }]) {
    const response = await clear(payload); assert.equal(response.statusCode, 400, response.body);
  }
  const before = f.store.snapshot(scope);
  assert.equal((await clear({ workspaceId: "w1", receiptIds: [a.receipt.id, "foreign"] })).statusCode, 404);
  assert.deepEqual(f.store.snapshot(scope), before);
  const cleared = await clear({ workspaceId: "w1", receiptIds: [a.receipt.id] });
  assert.equal(cleared.statusCode, 200, cleared.body); assert.equal(cleared.json().cancelledCount, 1);
  assert.equal(cleared.json().queue.stop.state, "none");
  const later = await f.accept("http-clear-later");
  const retry = await clear({ workspaceId: "w1", receiptIds: [a.receipt.id] });
  assert.equal(retry.statusCode, 200); assert.equal(retry.json().cancelledCount, 0);
  assert.equal(retry.json().queue.items[0].id, later.receipt.id);
});

test("HTTP explicit Stop generation rejects stale new sends but never enters the payload dedup fingerprint", async t => {
  const f = await httpFixture(t); const generation = f.store.snapshot(scope).stopGeneration;
  const original = await f.accept("fenced-dedup");
  f.service.stop(scope, "generation-http");
  const send = (clientRequestId: string) => f.app.inject({ method: "POST", url: `${base}/receipts`, payload: { workspaceId: "w1", clientRequestId, text: "hello", stopGeneration: generation } });
  const stale = await send("stale-generation"); assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().code, "AGENT_QUEUE_STOP_GENERATION_CHANGED");
  assert.equal(Value.Check(AgentQueueErrorCodeSchema, stale.json().code), true);
  const replay = await send("fenced-dedup"); assert.equal(replay.statusCode, 202, replay.body);
  assert.equal(replay.json().deduplicated, true); assert.equal(replay.json().receipt.id, original.receipt.id);
  assert.equal(replay.json().receipt.status, "injected"); });


test("HTTP late multipart supplement cannot cross terminal into the next Run", async t => {
  const f = await httpFixture(t), first = await f.accept("multipart-target");
  assert.equal(first.receipt.status, "injected");
  const runId = first.receipt.runId;
  f.finish(runId, "completed");
  f.runtimeStore.retireAdmission({ ...scope, runId, runtimeInstanceId: f.runtimeInstanceId });
  const next = await f.accept("multipart-next");
  const response = await f.app.inject({ method: "POST", url: `${base}/receipts`,
    ...form({ workspaceId: "w1", clientRequestId: "late-multipart", targetRunId: runId, text: "late" }) });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().code, "AGENT_SUPPLEMENT_TARGET_CLOSED");
  assert.equal(f.store.snapshot(scope).pendingCount, 0);
  assert.equal(f.enqueued.length, 2); assert.notEqual(next.receipt.runId, runId);
  assert.equal((await fs.readdir(agentAttachmentTempDir(f.dataDir))).length, 0);
});
