import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { ConfigStore } from "../src/config.js";
import type { HttpRequest, HttpResult } from "../src/http.js";
import { HttpClient } from "../src/http.js";
import { MAX_PAYLOAD_BYTES, MAX_TEXT_BYTES } from "../src/input.js";
import { runCli } from "../src/program.js";
import { agentSession, connectionStore, jsonResult } from "./agent-fixture.js";
import { captureIO, cookieHeader, httpServer, temporaryDirectory } from "./helpers.js";

type Call = { path: string; request: HttpRequest };
const agents = { agents: [{ id: "a", name: "first", summary: "first" }, { id: "b", name: "second", summary: "second" }] };
const ack = { sessionId: "s", messageId: "m", runId: "r", deduplicated: false };
function normal(call: Call): HttpResult {
  if (call.path.includes("/agents/available")) return jsonResult(agents);
  if (call.path === "/api/agent/sessions") return jsonResult(agentSession(), 201);
  if (call.path.includes("/messages")) return jsonResult(ack, 201);
  if (call.path.startsWith("/api/agent/sessions/s?")) return jsonResult(agentSession());
  throw Error("unexpected request");
}
async function execute(args: string[] = [], handle: (call: Call) => HttpResult | Promise<HttpResult> = normal, config: ConfigStore = connectionStore()) {
  const calls: Call[] = []; const capture = captureIO();
  const code = await runCli(["session", "send", "-w", "w", "--prompt", "hello --workspace", "--json", ...args], {
    io: capture.io, createConfigStore: () => config,
    http: { request: async (_origin, path, request = {}) => { const call = { path, request }; calls.push(call); return handle(call); } }
  });
  return { code, calls, stdout: capture.output(), stderr: capture.diagnostic() };
}
const posts = (calls: Call[]) => calls.filter((call) => call.request.method === "POST");

test("normal send output reports acceptance and identities without a speculative warning", async () => {
  const capture = captureIO();
  const calls: Call[] = [];
  const code = await runCli(["session", "send", "-w", "w", "--prompt", "hello"], {
    io: capture.io, createConfigStore: () => connectionStore(),
    http: { request: async (_origin, path, request = {}) => { const call = { path, request }; calls.push(call); return normal(call); } }
  });
  assert.equal(code, 0, capture.diagnostic());
  assert.match(capture.output(), /^已受理。\n/);
  assert.doesNotMatch(capture.output(), /不代表|不保证|执行成功/);
  for (const entry of ["workspaceId：w", "sessionId：s", "agentId：a", "messageId：m", "runId：r", "sessionCreated：true", "accepted：true", "deduplicated：false"]) {
    assert.ok(capture.output().includes(`${entry}\n`), entry);
  }
  const requestId = (posts(calls)[1].request.body as { clientRequestId: string }).clientRequestId;
  assert.ok(capture.output().includes(`clientRequestId：${requestId}\n`));
  assert.equal(posts(calls).length, 2);
  assert.equal(capture.diagnostic(), "");
});

test("A-SEND-CREATE/REQUEST-ID: one create then one send, first Agent is fixed and every call has a fresh UUID", async () => {
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const output = await execute(); assert.equal(output.code, 0, output.stderr);
    assert.deepEqual(output.calls.map((call) => call.path), ["/api/workspaces/w/agents/available?surface=user", "/api/agent/sessions", "/api/agent/sessions/s/messages"]);
    assert.deepEqual(posts(output.calls)[0].request.body, { workspaceId: "w" });
    const body = posts(output.calls)[1].request.body as Record<string, unknown>;
    assert.equal(body.agentId, "a"); assert.equal(body.text, "hello --workspace");
    assert.match(body.clientRequestId as string, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
    ids.push(body.clientRequestId as string);
    assert.deepEqual(JSON.parse(output.stdout).data, { workspaceId: "w", sessionId: "s", agentId: "a", messageId: "m", runId: "r", clientRequestId: body.clientRequestId, sessionCreated: true, accepted: true, deduplicated: false });
  }
  assert.notEqual(ids[0], ids[1]);
});

test("A-SEND-EXISTING/SUBTASK/BUSY: primary writes once, explicit Agent verified, child rejected and 409 never queued", async () => {
  const explicit = await execute(["-s", "s", "-a", "b"]);
  assert.equal(explicit.code, 0); assert.equal(posts(explicit.calls).length, 1);
  assert.equal((posts(explicit.calls)[0].request.body as { agentId: string }).agentId, "b");
  assert.equal(JSON.parse(explicit.stdout).data.sessionCreated, false);
  const defaultExisting = await execute(["-s", "s"]);
  assert.equal((posts(defaultExisting.calls)[0].request.body as { agentId: string }).agentId, "a");
  const child = await execute(["-s", "s"], (call) => call.path.startsWith("/api/agent/sessions/s?") ? jsonResult(agentSession({ kind: "subtask" })) : normal(call));
  assert.equal(child.code, 2); assert.equal(posts(child.calls).length, 0);
  const busy = await execute(["-s", "s"], (call) => call.path.endsWith("/messages") ? jsonResult({ message: "private body" }, 409) : normal(call));
  assert.equal(busy.code, 6); assert.equal(posts(busy.calls).length, 1);
  assert.equal(JSON.parse(busy.stderr).error.effect, "rejected");
  assert.equal(busy.stdout, ""); assert.equal(busy.stderr.includes("private body"), false);
});

test("A-DISCOVER-NONE/BAD-FIRST: no Agent or unavailable explicit ID creates nothing; bad first never switches", async () => {
  for (const args of [[], ["-a", "missing"]]) {
    const output = await execute(args, (call) => call.path.includes("/agents/") ? jsonResult(args.length ? agents : { agents: [] }) : normal(call));
    assert.equal(output.code, 6); assert.equal(posts(output.calls).length, 0);
  }
  const output = await execute([], (call) => call.path.endsWith("/messages") ? jsonResult({ code: "AGENT_WORKER_UNAVAILABLE", message: "private config" }, 503) : normal(call));
  assert.equal(output.code, 6); assert.equal(posts(output.calls).length, 2);
  assert.equal((posts(output.calls)[1].request.body as { agentId: string }).agentId, "a");
  assert.equal(output.calls.filter((call) => call.path.includes("/agents/")).length, 1);
});

test("A-UNKNOWN-REJECT/CREATE: rejected vs unknown create; no retry or later send", async () => {
  for (const status of [401, 404, 500]) {
    const output = await execute([], (call) => call.path === "/api/agent/sessions" ? jsonResult({ message: "private server detail" }, status) : normal(call));
    assert.equal(output.code, status === 401 ? 4 : 6); assert.equal(posts(output.calls).length, 1);
    const error = JSON.parse(output.stderr).error;
    assert.equal(error.phase, "create"); assert.equal(error.effect, status < 500 ? "rejected" : "unknown");
    assert.equal(error.context.sessionId, undefined); assert.equal(output.stderr.includes("private server detail"), false);
  }
  for (const body of ["not-json", JSON.stringify({ id: "untrusted" }), JSON.stringify(agentSession({ kind: "subtask" }))]) {
    const output = await execute([], (call) => call.path === "/api/agent/sessions" ? { status: 201, body, setCookies: [] } : normal(call));
    assert.equal(output.code, 6); assert.equal(posts(output.calls).length, 1);
    assert.equal(JSON.parse(output.stderr).error.effect, "unknown");
    assert.equal(JSON.parse(output.stderr).error.context.sessionId, undefined);
  }
});

test("A-UNKNOWN-CREATE/SEND: real TCP server accepted side effect then destroyed response; zero automatic retry/cancel", async () => {
  for (const drop of ["create", "send"]) {
    let creates = 0; let sends = 0; let cancels = 0;
    const server = await httpServer(async (request, response) => {
      if (request.url?.includes("/agents/")) { response.end(JSON.stringify(agents)); return; }
      if (request.url?.endsWith("/cancel")) { cancels++; response.end("{}"); return; }
      for await (const _ of request) { /* accept the entire request before losing response */ }
      if (request.url === "/api/agent/sessions") {
        creates++; if (drop === "create") { response.destroy(); return; }
        response.writeHead(201, { "Content-Type": "application/json" }); response.end(JSON.stringify(agentSession())); return;
      }
      if (request.url?.endsWith("/messages")) { sends++; response.destroy(); return; }
      response.writeHead(404); response.end("{}");
    });
    try {
      const capture = captureIO();
      const code = await runCli(["session", "send", "-w", "w", "--prompt", "hello", "--json"], { io: capture.io, createConfigStore: () => connectionStore(server.origin), http: new HttpClient() });
      assert.equal(code, 5); assert.equal(creates, 1); assert.equal(sends, drop === "send" ? 1 : 0); assert.equal(cancels, 0);
      assert.equal(capture.output(), ""); const error = JSON.parse(capture.diagnostic()).error;
      assert.equal(error.phase, drop); assert.equal(error.effect, "unknown"); assert.equal(error.context.sessionId, drop === "send" ? "s" : undefined);
      assert.equal(error.context.runId, undefined);
    } finally { await server.close(); }
  }
});

test("A-UNKNOWN-SEND: create-success/send-409 or invalid ack preserves confirmed session without recreating", async () => {
  for (const result of [jsonResult({}, 409), { status: 201, body: "invalid-json", setCookies: [] }, jsonResult({ ...ack, sessionId: "foreign" }, 201)]) {
    const output = await execute([], (call) => call.path.endsWith("/messages") ? result : normal(call));
    assert.equal(output.code, 6); assert.equal(posts(output.calls).length, 2);
    assert.equal(JSON.parse(output.stderr).error.context.sessionId, "s");
    assert.equal(JSON.parse(output.stderr).error.effect, result.status === 409 ? "rejected" : "unknown");
    assert.equal(output.calls.some((call) => call.path.endsWith("/cancel")), false);
  }
});

test("A-UNKNOWN-PERSIST: valid create/send response identity survives Cookie save failure; later writes stop", async () => {
  for (const failure of ["create", "send"]) {
    const config = connectionStore(); config.save = async () => { throw Error("private OS detail"); };
    const output = await execute([], (call) => {
      const result = normal(call);
      if ((failure === "create" && call.path === "/api/agent/sessions") || (failure === "send" && call.path.endsWith("/messages"))) result.setCookies = [cookieHeader];
      return result;
    }, config);
    assert.equal(output.code, 7); assert.equal(posts(output.calls).length, failure === "create" ? 1 : 2);
    const error = JSON.parse(output.stderr).error;
    assert.equal(error.effect, "accepted"); assert.equal(error.phase, failure); assert.equal(error.context.sessionId, "s");
    assert.equal(error.context.runId, failure === "send" ? "r" : undefined);
    assert.equal(error.context.messageId, failure === "send" ? "m" : undefined);
    assert.ok(error.context.clientRequestId); assert.equal(output.stdout, "");
    assert.equal(output.stderr.includes("private OS detail"), false);
  }
});

test("A-SEND-DEDUP-IDENTITY: unexpected dedup preserves trustworthy IDs but never claims actual Agent", async () => {
  for (const persistFailure of [false, true]) {
    const config = connectionStore(); if (persistFailure) config.save = async () => { throw Error("cannot save"); };
    const output = await execute([], (call) => call.path.endsWith("/messages") ? jsonResult({ ...ack, deduplicated: true }, 201, persistFailure ? [cookieHeader] : []) : normal(call), config);
    assert.equal(output.code, persistFailure ? 7 : 6); assert.equal(posts(output.calls).length, 2);
    const error = JSON.parse(output.stderr).error;
    assert.equal(error.context.runId, "r"); assert.equal(error.context.messageId, "m"); assert.equal(error.context.agentId, undefined);
    assert.equal(error.effect, "accepted"); assert.equal(output.stdout, "");
  }
});

test("A-SEND-TEXT-LIMIT: exact JSON/multipart payload bytes are sent, +1 creates nothing", async () => {
  const root = await temporaryDirectory("agent-payload-boundary");
  try {
    const image = join(root, "diagram.png"); await fs.writeFile(image, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    for (const multipart of [false, true]) for (const extra of [0, 1]) {
      const maximum = multipart ? MAX_PAYLOAD_BYTES : MAX_TEXT_BYTES;
      const overhead = Buffer.byteLength(JSON.stringify({ workspaceId: "w", clientRequestId: "x".repeat(36), agentId: "a", text: "" }));
      const prompt = "x".repeat(maximum - overhead + extra);
      const capture = captureIO(); const calls: Call[] = [];
      const code = await runCli(["session", "send", "-w", "w", "--prompt", prompt, ...(multipart ? ["--image", image] : []), "--json"], {
        io: capture.io, createConfigStore: () => connectionStore(), http: { request: async (_origin, path, request = {}) => { const call = { path, request }; calls.push(call); return normal(call); } }
      });
      assert.equal(code, extra ? 2 : 0, capture.diagnostic());
      assert.equal(posts(calls).length, extra ? 0 : 2);
      if (!extra) {
        const request = posts(calls)[1].request;
        assert.equal(Buffer.byteLength(multipart ? request.formData!.get("payload") as string : JSON.stringify(request.body)), maximum);
      }
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("A-SEND-MULTIPART: real TCP Fetch boundary, pure-image empty text and ordered byte upload", async () => {
  const root = await temporaryDirectory("agent-send-multipart");
  const first = join(root, "one.png"); const second = join(root, "two.jpg");
  await fs.writeFile(first, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])); await fs.writeFile(second, Buffer.from([255, 216, 255]));
  const captured: { contentType: string; body: Buffer }[] = [];
  const server = await httpServer(async (request, response) => {
    if (request.url?.includes("/agents/")) { response.end(JSON.stringify(agents)); return; }
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (request.url === "/api/agent/sessions") { response.writeHead(201); response.end(JSON.stringify(agentSession())); return; }
    captured.push({ contentType: String(request.headers["content-type"]), body: Buffer.concat(chunks) });
    response.writeHead(201); response.end(JSON.stringify(ack));
  });
  try {
    for (const prompt of [undefined, "描述\n图片"]) {
      const capture = captureIO();
      assert.equal(await runCli(["session", "send", "-w", "w", "--image", first, "--image", second, ...(prompt === undefined ? [] : ["--prompt", prompt]), "--json"], { io: capture.io, createConfigStore: () => connectionStore(server.origin), http: new HttpClient() }), 0, capture.diagnostic());
      const { contentType, body } = captured.at(-1)!;
      const boundary = /boundary=(.+)$/.exec(contentType)?.[1]; assert.ok(boundary);
      const wire = body.toString("utf8");
      assert.equal(wire.split('name="payload"').length - 1, 1); assert.equal(wire.split('name="images"').length - 1, 2);
      assert.ok(wire.indexOf('filename="one.png"') < wire.indexOf('filename="two.jpg"'));
      assert.ok(wire.includes(`--${boundary}--`)); assert.equal(wire.includes(root), false);
      assert.ok(wire.includes(JSON.stringify(prompt ?? "").slice(1, -1)));
      const payload = JSON.parse(/name="payload"\r\n\r\n([^]*?)\r\n--/.exec(wire)![1]);
      assert.equal(payload.text, prompt ?? ""); assert.equal(payload.agentId, "a");
      assert.ok(body.includes(await fs.readFile(first))); assert.ok(body.includes(await fs.readFile(second)));
    }
  } finally { await server.close(); await fs.rm(root, { recursive: true, force: true }); }
});
