import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { createApp } from "../../../app/createApp.js";
import { createSessionCookieValue } from "../../../infra/auth/sessionCookie.js";
import { newSortableId } from "../../../utils/ids.js";
import { appendMessage, convergeRunTerminal, createMessageRunRecord, createMessageSession, persistRunTerminalIntent, startMessageRun } from "../agent-message.store.js";
import { createAgentTestFixture, createTestWorkspace, type AgentTestFixture } from "../testkit/agent-testkit.js";

const repoRoot = fileURLToPath(new URL("../../../../../../", import.meta.url));
const cliEntry = path.join(repoRoot, "packages/cli/dist/cli.cjs");
const authToken = "fixture-cli-smoke-token";
async function freePort() {
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve) => server.close(() => resolve())); return address.port;
}
async function provider(t: TestContext) {
  const requests: Array<Record<string, unknown>> = [];
  let toolIssued = false;
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += String(chunk);
    const input = JSON.parse(body) as Record<string, unknown>; requests.push(input); const responseId = `fixture-${requests.length}`;
    assert.equal(req.url, "/v1/responses");
    res.setHeader("content-type", input.stream ? "text/event-stream" : "application/json");
    if (input.stream) {
      const itemId = `${responseId}-message`;
      const tool = !toolIssued && JSON.stringify(input.input).includes("fixture tool cycle");
      if (tool) toolIssued = true;
      const argumentsText = JSON.stringify({ filePath: "tool-input.txt" });
      const chunks = tool ? [
        { type: "response.created", response: { id: responseId, created_at: 1, model: "fixture-model" } },
        { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: itemId, call_id: `${responseId}-call`, name: "read", arguments: "" } },
        { type: "response.function_call_arguments.delta", item_id: itemId, output_index: 0, delta: argumentsText },
        { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: itemId, call_id: `${responseId}-call`, name: "read", arguments: argumentsText, status: "completed" } },
        { type: "response.completed", response: { output: [], usage: { input_tokens: 1, output_tokens: 1 }, service_tier: null } }
      ] : [
        { type: "response.created", response: { id: responseId, created_at: 1, model: "fixture-model" } },
        { type: "response.output_item.added", output_index: 0, item: { type: "message", id: itemId, phase: "final_answer" } },
        { type: "response.output_text.delta", item_id: itemId, delta: "受控 Provider 最终回答" },
        { type: "response.output_item.done", output_index: 0, item: { type: "message", id: itemId, phase: "final_answer" } },
        { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 }, service_tier: null } }
      ];
      res.end(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(""));
    } else res.end(JSON.stringify({ id: responseId, created_at: 1, model: "fixture-model", output: [{ type: "message", role: "assistant", id: `${responseId}-summary`, phase: "final_answer", content: [{ type: "output_text", text: "受控压缩摘要", annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  return { baseURL: `http://127.0.0.1:${address.port}/v1`, requests };
}
async function fixture(t: TestContext, worker: boolean, observe?: (request: { method: string; url: string; body: unknown }) => void) {
  const apiPort = await freePort(); const workerPort = await freePort();
  const f = await createAgentTestFixture({ repoRoot, dataDirPrefix: "cli-agent-public-", withApp: true, authToken, agentWorkerConcurrency: worker ? 2 : 0,
    appFactory: async (ctx) => {
      ctx.agentWorkerEnabled = worker; ctx.agentWorkerPort = workerPort; ctx.agentApiOrigin = `http://127.0.0.1:${apiPort}`;
      const app = await createApp(ctx);
      if (observe) app.addHook("preHandler", async (request) => { observe(request); });
      return app;
    } });
  t.after(() => f.dispose()); const workspace = await createTestWorkspace(f, { title: "CLI smoke workspace" });
  const home = path.join(f.dataDir, "cli-home"); await fs.mkdir(home);
  const publicRequests: string[] = []; f.app!.server.on("request", (request) => { if (request.headers.cookie?.includes("awb_session=")) publicRequests.push(request.url ?? ""); });
  const origin = await f.app!.listen({ host: "127.0.0.1", port: apiPort });
  async function run(args: string[], input = "") {
    const child = spawn(process.execPath, [cliEntry, ...args, "--json"], { cwd: home, env: { HOME: home, USERPROFILE: home, TMPDIR: home, PATH: path.dirname(process.execPath), NODE_PATH: "" }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; }); child.stdin.end(input);
    const timer = setTimeout(() => child.kill("SIGKILL"), 25000);
    try { const [code] = await once(child, "close"); return { code, stdout, stderr }; } finally { clearTimeout(timer); }
  }
  const login = await run(["login", "--url", origin, "--token-stdin"], `${authToken}\n`); assert.equal(login.code, 0, login.stderr);
  const controllerCookie = `awb_session=${createSessionCookieValue({ authToken, nowMs: Date.now(), ttlMs: 3600000 })}`;
  async function publicJson(route: string) { const result = await fetch(`${origin}${route}`, { headers: { cookie: controllerCookie } }); assert.equal(result.status, 200); return result.json() as Promise<Record<string, unknown>>; }
  return { ...f, workspace, home, origin, run, publicJson, controllerCookie, publicRequests };
}
function success(result: { code: unknown; stdout: string; stderr: string }) { assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, ""); return JSON.parse(result.stdout).data; }
function events(result: { code: unknown; stdout: string; stderr: string }) { assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, ""); const rows = result.stdout.trim().split("\n").map((line) => JSON.parse(line)); assert.equal(rows[0].type, "metadata"); assert.equal(rows.at(-1).type, "terminal"); assert.equal(rows.at(-1).complete, true); return rows; }

/** Parse central directory entries, then inflate each file: no external unzip binary needed. */
function unzip(buffer: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>(); const end = buffer.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06])); assert.ok(end >= 0);
  let offset = buffer.readUInt32LE(end + 16); const count = buffer.readUInt16LE(end + 10);
  for (let index = 0; index < count; index++) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50); const method = buffer.readUInt16LE(offset + 10); const length = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28); const extraLength = buffer.readUInt16LE(offset + 30); const commentLength = buffer.readUInt16LE(offset + 32); const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength); const data = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28); const compressed = buffer.subarray(data, data + length);
    entries.set(name, method === 8 ? inflateRawSync(compressed) : compressed); offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

test("A-REGRESSION-API: real managed Worker and controlled Provider exercise CLI discovery, send/images/follow/history/compact/download", { timeout: 90000 }, async (t) => {
  const stub = await provider(t); const f = await fixture(t, true); const w = f.workspace.id;
  for (const [url, payload] of [
    ["/api/settings/agent/providers", { default: { providerId: "fixture-provider", modelId: "fixture-model" }, providers: [{ id: "fixture-provider", name: "fixture", npm: "@ai-sdk/openai", options: { baseURL: stub.baseURL, apiKey: "fixture-only" }, models: [{ id: "fixture-model", name: "fixture-model", contextWindowTokens: 128000 }] }] }],
    ["/api/settings/agent/agents", { agents: [{ id: "default", name: "CLI smoke", summary: "controlled", prompt: "Answer the fixture request.", tools: ["read"], pluginTools: [], mcpServers: [], defaultModel: { providerId: "fixture-provider", modelId: "fixture-model" }, scope: "both", order: 0 }] }],
    ["/api/settings/agent/runtime", { modelRequestMaxRetries: 0, modelIdleTimeoutMs: 5000, modelTotalTimeoutMs: 10000, autoCompactThresholdPct: 80 }]
  ] as const) { const result = await f.app!.inject({ method: "PUT", url, headers: { cookie: f.controllerCookie }, payload }); assert.equal(result.statusCode, 200, result.body); }
  assert.deepEqual(success(await f.run(["workspace", "list"])).items, [{ id: w, name: "CLI smoke workspace" }]);
  const agents = success(await f.run(["agent", "list", "-w", w])); assert.deepEqual(agents.items, [{ id: "default", name: "CLI smoke", summary: "controlled" }]);
  const sent = events(await f.run(["session", "send", "-w", w, "--prompt", "fixture question", "-f", "--follow-timeout", "20s"])); const s = sent[0].sessionId as string;
  assert.equal(sent.at(-1).runStatus, "completed"); assert.ok(sent.some((row) => row.type === "message" && row.message.parts.some((part: { text?: string }) => part.text === "受控 Provider 最终回答")));
  const recent = success(await f.run(["session", "messages", "-w", w, "-s", s, "-n", "1"])); assert.equal(recent.items.length, 1); assert.equal(recent.items[0].parts[0].text, "受控 Provider 最终回答");
  const image = path.join(f.dataDir, "fixture.png"); await fs.writeFile(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=", "base64"));
  events(await f.run(["session", "send", "-w", w, "-s", s, "--image", image, "-f", "--follow-timeout", "20s"]));
  assert.ok(stub.requests.some((request) => JSON.stringify(request.input).includes("data:image/png;base64,")));
  await fs.writeFile(path.join(f.workspace.path, "tool-input.txt"), "tool fixture content");
  const toolCycle = events(await f.run(["session", "send", "-w", w, "-s", s, "--prompt", "fixture tool cycle", "-f", "--follow-timeout", "20s"]));
  assert.ok(toolCycle.some((row) => row.type === "message" && row.message.type === "assistant"));
  for (const row of toolCycle.filter((row) => row.type === "message")) assert.ok(row.message.parts.every((part: { type: string }) => part.type === "text" || part.type === "image"));
  assert.ok(stub.requests.some((request) => JSON.stringify(request.input).includes("function_call_output")));
  assert.equal(success(await f.run(["session", "status", "-w", w, "-s", s])).status, "idle");
  const before = success(await f.run(["session", "messages", "-w", w, "-s", s, "-n", "20"]));
  const compact = events(await f.run(["session", "compact", "-w", w, "-s", s, "-f", "--follow-timeout", "20s"])); assert.equal(compact.at(-1).runStatus, "completed");
  const after = success(await f.run(["session", "messages", "-w", w, "-s", s, "-n", "20"])); assert.deepEqual(after.items.map((message: { id: string }) => message.id), before.items.map((message: { id: string }) => message.id));
  await fs.mkdir(path.join(f.workspace.path, "reports", "empty"), { recursive: true }); await fs.writeFile(path.join(f.workspace.path, "reports", "answer.txt"), "artifact bytes");
  const file = path.join(f.home, "answer.bin"); const zip = path.join(f.home, "reports.zip");
  assert.equal(success(await f.run(["file", "download", "-w", w, "--path", "reports/answer.txt", "--output", file])).format, "file"); assert.equal(await fs.readFile(file, "utf8"), "artifact bytes");
  assert.equal(success(await f.run(["file", "download", "-w", w, "--path", "reports", "--output", zip])).format, "zip"); const entries = unzip(await fs.readFile(zip)); assert.equal(entries.get("reports/answer.txt")?.toString(), "artifact bytes"); assert.equal(entries.has("reports/empty/"), false);
  assert.ok(f.publicRequests.length > 15); assert.equal(f.publicRequests.some((route) => route.startsWith("/api/internal/") || route.includes("/events") || route.includes("/settings/")), false);
  assert.equal((await fetch(`${f.origin}/api/internal/agent/sessions/${s}/run-state`)).status, 401);
});

/** Seeds only initial lifecycle state. Every assertion below observes real public API/CLI results. */
function seedRun(f: AgentTestFixture, workspaceId: string, kind: "primary" | "subtask", parentRunId: string | null, status: "running" | "completed" = "running") {
  const sessionId = newSortableId("sess"); const runId = newSortableId("run"); const messageId = newSortableId("msg"); const now = Date.now();
  createMessageSession(f.db, { id: sessionId, workspaceId, title: "tree fixture", kind, createdAt: now });
  appendMessage(f.db, { id: messageId, workspaceId, sessionId, expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [{ id: newSortableId("part"), position: 0, type: "text", text: "tree input" }], createdAt: now });
  createMessageRunRecord(f.db, { runId, workspaceId, sessionId, triggerMessageId: messageId, agentId: "default", providerId: "fixture", modelId: "fixture", status, parentRunId, subtaskDepth: parentRunId ? 1 : 0, createdAt: now });
  if (status === "running") startMessageRun(f.db, { workspaceId, sessionId, runId, updatedAt: now });
  return { sessionId, runId, messageId };
}

test("A-CONTROL-CANCEL-TREE: CLI cancellation reaches active child/grandchild, leaves completed child and files unchanged; child is read-only", async (t) => {
  const f = await fixture(t, false); const w = f.workspace.id; const root = seedRun(f, w, "primary", null); const child = seedRun(f, w, "subtask", root.runId); const grandchild = seedRun(f, w, "subtask", child.runId); const done = seedRun(f, w, "subtask", root.runId, "completed");
  const written = path.join(f.workspace.path, "before-cancel.txt"); await fs.writeFile(written, "must survive");
  for (const target of [child, grandchild]) {
    assert.equal(success(await f.run(["session", "show", "-w", w, "-s", target.sessionId])).kind, "subtask");
    assert.equal(success(await f.run(["session", "status", "-w", w, "-s", target.sessionId])).status, "running");
    assert.equal(success(await f.run(["session", "messages", "-w", w, "-s", target.sessionId, "-n", "1"])).count, 1);
    const denied = await f.run(["session", "cancel", "-w", w, "-s", target.sessionId]); assert.equal(denied.code, 2); assert.equal(denied.stdout, "");
  }
  const cancel = success(await f.run(["session", "cancel", "-w", w, "-s", root.sessionId])); assert.equal(cancel.requested, true);
  for (const target of [root, child, grandchild]) {
    const state = success(await f.run(["session", "status", "-w", w, "-s", target.sessionId])); assert.equal(state.status, "idle");
    const run = await f.publicJson(`/api/agent/sessions/${target.sessionId}/runs/${target.runId}?workspaceId=${w}`); assert.equal(run.status, "cancelled");
  }
  assert.equal((await f.publicJson(`/api/agent/sessions/${done.sessionId}/runs/${done.runId}?workspaceId=${w}`)).status, "completed");
  assert.equal(await fs.readFile(written, "utf8"), "must survive");
});


test("全面审查M3: real API cancel uses new current Run after CLI precheck, not the completed old tree", async (t) => {
  const posted: unknown[] = [];
  const f = await fixture(t, false, (request) => {
    if (request.method === "POST" && request.url.split("?", 1)[0].endsWith("/cancel")) posted.push(request.body);
  }); const w = f.workspace.id;
  const old = seedRun(f, w, "primary", null); const historicalChild = seedRun(f, w, "subtask", old.runId);
  const nextRunId = newSortableId("run"); let nextChild: ReturnType<typeof seedRun> | undefined;
  let prechecks = 0; let transitionError: unknown;
  f.app!.server.on("request", (request, response) => {
    const route = new URL(request.url!, f.origin).pathname;
    if (request.method === "GET" && route === `/api/agent/sessions/${old.sessionId}`) {
      prechecks++;
      // Deterministically switch after the real metadata response, before the CLI POST.
      response.once("finish", () => {
        try {
          const identity = { workspaceId: w, sessionId: old.sessionId, runId: old.runId, updatedAt: Date.now() };
          persistRunTerminalIntent(f.db, { ...identity, status: "completed", code: "run_completed", detail: null });
          convergeRunTerminal(f.db, identity);
          createMessageRunRecord(f.db, { runId: nextRunId, workspaceId: w, sessionId: old.sessionId, triggerMessageId: old.messageId, agentId: "default", providerId: "fixture", modelId: "fixture", status: "running", createdAt: Date.now() });
          startMessageRun(f.db, { workspaceId: w, sessionId: old.sessionId, runId: nextRunId, updatedAt: Date.now() });
          nextChild = seedRun(f, w, "subtask", nextRunId);
        } catch (error) { transitionError = error; }
      });
    }
  });
  const result = success(await f.run(["session", "cancel", "-w", w, "-s", old.sessionId]));
  assert.equal(transitionError, undefined); assert.equal(prechecks, 1); assert.deepEqual(posted, [{ workspaceId: w }]); assert.equal(result.status, "idle");
  assert.ok(nextChild);
  for (const [sessionId, runId, expected] of [
    [old.sessionId, old.runId, "completed"], [old.sessionId, nextRunId, "cancelled"],
    [nextChild.sessionId, nextChild.runId, "cancelled"], [historicalChild.sessionId, historicalChild.runId, "running"]
  ]) assert.equal((await f.publicJson(`/api/agent/sessions/${sessionId}/runs/${runId}?workspaceId=${w}`)).status, expected);
  assert.equal(success(await f.run(["session", "status", "-w", w, "-s", historicalChild.sessionId])).status, "running");
});

test("全面审查M3: real API idle-root cancel never scans or cancels historical active descendants", async (t) => {
  const f = await fixture(t, false); const w = f.workspace.id;
  const root = seedRun(f, w, "primary", null, "completed"); const orphan = seedRun(f, w, "subtask", root.runId); const descendant = seedRun(f, w, "subtask", orphan.runId);
  assert.equal(success(await f.run(["session", "status", "-w", w, "-s", root.sessionId])).status, "idle");
  const before = f.publicRequests.length;
  const result = success(await f.run(["session", "cancel", "-w", w, "-s", root.sessionId]));
  assert.equal(result.status, "idle");
  assert.equal(f.publicRequests.slice(before).filter((route) => route.includes("/cancel")).length, 1);
  assert.equal((await f.publicJson(`/api/agent/sessions/${root.sessionId}/runs/${root.runId}?workspaceId=${w}`)).status, "completed");
  for (const target of [orphan, descendant]) {
    assert.equal((await f.publicJson(`/api/agent/sessions/${target.sessionId}/runs/${target.runId}?workspaceId=${w}`)).status, "running");
    assert.equal(success(await f.run(["session", "status", "-w", w, "-s", target.sessionId])).status, "running");
  }
});

test("A-DOWNLOAD-LIMITS/TYPES: real API preserves 100 MiB directory limit, .git/symlink rejection and empty ZIP semantics", { timeout: 60000 }, async (t) => {
  const f = await fixture(t, false); const w = f.workspace.id;
  const directory = path.join(f.workspace.path, "large"); await fs.mkdir(directory);
  const source = path.join(directory, "sparse.bin"); const handle = await fs.open(source, "w"); await handle.truncate(100 * 1024 * 1024); await handle.close();
  const exact = path.join(f.home, "exact.zip"); assert.equal(success(await f.run(["file", "download", "-w", w, "--path", "large", "--output", exact])).format, "zip");
  // Inspect ZIP metadata without inflating 100 MiB into the test process.
  const zip = await fs.readFile(exact); const central = zip.indexOf(Buffer.from([0x50,0x4b,0x01,0x02])); assert.ok(central >= 0); assert.equal(zip.readUInt32LE(central + 24), 100 * 1024 * 1024);
  const larger = await fs.open(source, "r+"); await larger.truncate(100 * 1024 * 1024 + 1); await larger.close();
  const forbiddenGit = path.join(f.workspace.path, "with-git"); await fs.mkdir(path.join(forbiddenGit, ".git"), { recursive: true });
  const forbiddenLink = path.join(f.workspace.path, "with-link"); await fs.mkdir(forbiddenLink); await fs.symlink(source, path.join(forbiddenLink, "linked"));
  for (const remote of ["large", "with-git", "with-link"]) {
    const output = path.join(f.home, `${remote}.zip`); const result = await f.run(["file", "download", "-w", w, "--path", remote, "--output", output]); assert.equal(result.code, 6); assert.equal(result.stdout, ""); await assert.rejects(fs.lstat(output), { code: "ENOENT" });
  }
  await fs.mkdir(path.join(f.workspace.path, "empty")); const empty = path.join(f.home, "empty.zip"); success(await f.run(["file", "download", "-w", w, "--path", "empty", "--output", empty])); assert.equal(unzip(await fs.readFile(empty)).size, 0);
});


test("A-MESSAGES-PAGES/SUBTASK: real Timeline pages >500 sparse records and idle follow has bounded stable completion", async (t) => {
  const f = await fixture(t, false); const w = f.workspace.id; const sessionId = newSortableId("sess"); const now = Date.now();
  createMessageSession(f.db, { id: sessionId, workspaceId: w, title: "sparse history fixture", kind: "subtask", createdAt: now });
  let head: string | null = null; const visible: string[] = [];
  for (let index = 0; index < 525; index++) {
    const id = newSortableId("msg"); const ordinary = index % 100 === 0;
    appendMessage(f.db, { id, workspaceId: w, sessionId, expectedHeadMessageId: head, expectedRevision: index, type: ordinary ? "user" : "assistant", status: "completed", parts: [{ id: newSortableId("part"), position: 0, type: ordinary ? "text" : "reasoning", text: ordinary ? `visible-${index}` : "private fixture reasoning" }], createdAt: now + index });
    head = id; if (ordinary) visible.push(id);
  }
  const history = success(await f.run(["session", "messages", "-w", w, "-s", sessionId, "-n", "10"])); assert.deepEqual(history.items.map((message: { id: string }) => message.id), visible);
  const observed = events(await f.run(["session", "messages", "-w", w, "-s", sessionId, "-n", "10", "-f", "--follow-timeout", "10s"])); assert.equal(observed.at(-1).outcome, "no_active_run"); assert.deepEqual(observed.filter((row) => row.type === "message").map((row) => row.message.id), visible);
  assert.equal(JSON.stringify(history).includes("private fixture reasoning"), false);
  assert.ok(f.publicRequests.filter((route) => route.includes("mode=before")).length >= 8);
});
