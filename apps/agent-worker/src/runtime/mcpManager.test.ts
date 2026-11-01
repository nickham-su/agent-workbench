import test from "node:test";
import assert from "node:assert/strict";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AgentApiClient } from "./apiClient.js";
import { McpManager, toMcpToolNameForTest } from "./mcpManager.js";

const TTL = 10 * 60_000;
const RETRY_DELAY = 5_000;
const names = (tools: Awaited<ReturnType<McpManager["listTools"]>>) => tools.map((tool) => tool.name);
const canonical = (name: string, server = "demo") => toMcpToolNameForTest(server, name)!;
const tool = (name: string) => ({ name, description: name, inputSchema: { type: "object" as const, properties: {} } });
type ToolResponse = { tools: ReturnType<typeof tool>[] };
const response = (...tools: string[]): ToolResponse => ({ tools: tools.map(tool) });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

class FakeClient {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  notification?: () => void;
  discoveryCount = 0;
  closeCount = 0;
  calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  discovery: () => Promise<ToolResponse> = async () => response("lookup");
  execution: () => Promise<unknown> = async () => ({ content: [{ type: "text", text: "result" }] });

  setNotificationHandler(schema: unknown, handler: () => void) {
    assert.equal(schema, ToolListChangedNotificationSchema);
    this.notification = handler;
  }
  listTools() { this.discoveryCount++; return this.discovery(); }
  callTool(request: { name: string; arguments: Record<string, unknown> }) { this.calls.push(request); return this.execution(); }
  async close() { this.closeCount++; this.onclose?.(); }
  notify() { this.notification?.(); }
}
function server(id = "demo", enabled = true, version = "v1") {
  return { id, enabled, config: { type: "remote", url: `http://example.invalid/${id}/${version}` } };
}
function harness(ids = ["demo"]) {
  let now = 0;
  let settings = { updatedAt: 1, servers: ids.map((id) => server(id)) };
  const clients: FakeClient[] = [];
  const logs: string[] = [];
  let settingsCalls = 0;
  let createClient = async () => new FakeClient();
  const api = { getAgentMcpSettings: async () => { settingsCalls++; return structuredClone(settings); } } as unknown as AgentApiClient;
  const manager = new McpManager(api, {
    warn: (message: unknown) => logs.push(String(message)),
    error: (message: unknown) => logs.push(String(message)),
    info: (message: unknown) => logs.push(String(message)),
  }, {
    nowMs: () => now,
    connectClient: async () => {
      const client = await createClient();
      clients.push(client);
      return client as unknown as Client;
    },
  });
  return {
    manager, clients, logs, api, allowedServerIds: ids,
    setNow: (value: number) => { now = value; },
    setServers: (servers: typeof settings.servers) => { settings = { updatedAt: settings.updatedAt + 1, servers }; },
    setClientFactory: (factory: () => Promise<FakeClient>) => { createClient = factory; },
    settingsCalls: () => settingsCalls,
  };
}

// No real MCP clients, processes, timers or network connections are used in these tests.
test("cold discovery is synchronous; subsequent hits reuse a connection and snapshot", async () => {
  const h = harness();
  const waiting = deferred<ToolResponse>();
  const client = new FakeClient();
  client.discovery = () => waiting.promise;
  h.setClientFactory(async () => client);
  let finished = false;
  const first = h.manager.listTools(["demo"]).then((tools) => { finished = true; return tools; });
  await flush();
  assert.equal(finished, false);
  assert.equal(client.discoveryCount, 1);
  waiting.resolve(response("lookup"));
  assert.deepEqual(names(await first), [canonical("lookup")]);
  assert.deepEqual(names(await h.manager.listTools(["demo"])), [canonical("lookup")]);
  assert.equal(h.clients.length, 1);
  assert.equal(client.discoveryCount, 1);
  assert.equal(h.settingsCalls(), 2, "tool caching must not cache settings checks");
});

test("successful empty results are cached", async () => {
  const h = harness();
  const client = new FakeClient();
  client.discovery = async () => response();
  h.setClientFactory(async () => client);
  assert.deepEqual(await h.manager.listTools(["demo"]), []);
  assert.deepEqual(await h.manager.listTools(["demo"]), []);
  assert.equal(client.discoveryCount, 1);
});

test("TTL is ten minutes since success, hits do not renew it, and stale hits never await refresh", async () => {
  const h = harness();
  await h.manager.listTools(["demo"]);
  const client = h.clients[0]!;
  h.setNow(TTL - 1);
  await h.manager.listTools(["demo"]);
  assert.equal(client.discoveryCount, 1);
  const waiting = deferred<ToolResponse>();
  client.discovery = () => waiting.promise;
  h.setNow(TTL);
  const stale = await h.manager.listTools(["demo"]);
  assert.deepEqual(names(stale), [canonical("lookup")]);
  assert.equal(client.discoveryCount, 2);
  assert.deepEqual(names(await h.manager.listTools(["demo"])), [canonical("lookup")]);
  assert.equal(client.discoveryCount, 2);
  waiting.resolve(response("new"));
  await flush();
  assert.deepEqual(names(await h.manager.listTools(["demo"])), [canonical("new")]);
  assert.deepEqual(names(stale), [canonical("lookup")], "old request snapshot must not mutate");
  h.setNow(TTL * 2 - 1);
  await h.manager.listTools(["demo"]);
  assert.equal(client.discoveryCount, 2);
});

test("fast background success still returns the old snapshot on the triggering request", async () => {
  const h = harness();
  await h.manager.listTools(["demo"]);
  h.clients[0]!.discovery = async () => response("new");
  h.setNow(TTL);
  assert.deepEqual(names(await h.manager.listTools(["demo"])), [canonical("lookup")]);
  await flush();
  assert.deepEqual(names(await h.manager.listTools(["demo"])), [canonical("new")]);
});

test("stale data has no maximum age; failed refreshes wait five seconds and do not leak errors", async () => {
  const h = harness();
  await h.manager.listTools(["demo"]);
  const client = h.clients[0]!;
  client.discovery = async () => { throw new Error("synthetic-secret-header-and-url"); };
  h.setNow(TTL * 1_000_000);
  assert.deepEqual(names(await h.manager.listTools(["demo"])), [canonical("lookup")]);
  await flush();
  assert.equal(client.discoveryCount, 2);
  h.setNow(TTL * 1_000_000 + RETRY_DELAY - 1);
  await h.manager.listTools(["demo"]);
  assert.equal(client.discoveryCount, 2);
  h.setNow(TTL * 1_000_000 + RETRY_DELAY);
  assert.deepEqual(names(await h.manager.listTools(["demo"])), [canonical("lookup")]);
  await flush();
  assert.equal(client.discoveryCount, 3);
  assert.equal(client.closeCount, 0, "soft refresh failure must preserve the connection and cache");
  assert.equal(h.logs.length, 2);
  assert.equal(h.logs.join("\n").includes("synthetic-secret"), false);
});

test("cold requests share one discovery; cold failures are not cached and recover", async () => {
  const h = harness();
  const waiting = deferred<ToolResponse>();
  const client = new FakeClient();
  client.discovery = () => waiting.promise;
  let created = 0;
  h.setClientFactory(async () => created++ === 0 ? client : new FakeClient());
  const first = h.manager.listTools(["demo"]);
  const second = h.manager.listTools(["demo"]);
  await flush();
  assert.equal(client.discoveryCount, 1);
  assert.equal(h.clients.length, 1);
  waiting.reject(new Error("synthetic-private-command"));
  assert.deepEqual(await first, []);
  assert.deepEqual(await second, []);
  assert.deepEqual(names(await h.manager.listTools(["demo"])), [canonical("lookup")]);
  assert.equal(h.clients.length, 2);
  assert.equal(h.logs.join("\n").includes("synthetic-private-command"), false);
});

test("concurrent expired calls share one background refresh", async () => {
  const h = harness();
  await h.manager.listTools(["demo"]);
  const waiting = deferred<ToolResponse>();
  h.clients[0]!.discovery = () => waiting.promise;
  h.setNow(TTL);
  const results = await Promise.all(Array.from({ length: 8 }, () => h.manager.listTools(["demo"])));
  for (const tools of results) assert.deepEqual(names(tools), [canonical("lookup")]);
  assert.equal(h.clients[0]!.discoveryCount, 2);
  waiting.resolve(response("updated"));
  await flush();
});

test("list-changed hard-invalidates before TTL and refreshes only on demand", async () => {
  const h = harness();
  await h.manager.listTools(["demo"]);
  const client = h.clients[0]!;
  client.notify();
  assert.equal(client.discoveryCount, 1, "notification itself must not query tools");
  const waiting = deferred<ToolResponse>();
  client.discovery = () => waiting.promise;
  let finished = false;
  const next = h.manager.listTools(["demo"]).then((tools) => { finished = true; return tools; });
  await flush();
  assert.equal(finished, false, "hard invalidation must not return stale tools");
  waiting.resolve(response("replacement"));
  assert.deepEqual(names(await next), [canonical("replacement")]);
});

test("another notification during cold discovery prevents the old result becoming authoritative", async () => {
  const h = harness();
  await h.manager.listTools(["demo"]);
  const client = h.clients[0]!;
  const first = deferred<ToolResponse>();
  const second = deferred<ToolResponse>();
  let calls = 0;
  client.discovery = () => ++calls === 1 ? first.promise : second.promise;
  client.notify();
  const next = h.manager.listTools(["demo"]);
  await flush();
  client.notify();
  const concurrent = h.manager.listTools(["demo"]);
  await flush();
  first.resolve(response("obsolete"));
  await flush();
  second.resolve(response("current"));
  assert.deepEqual(names(await next), [canonical("current")]);
  assert.deepEqual(names(await concurrent), [canonical("current")]);
  assert.equal(calls, 2);
  await assert.rejects(h.manager.callTool(canonical("obsolete"), {}, { allowedServerIds: h.allowedServerIds }), /unknown mcp tool/);
});

test("a hard invalidation overrides stale refresh failure/backoff and never serves its old cache", async () => {
  const h = harness();
  await h.manager.listTools(["demo"]);
  const client = h.clients[0]!;
  client.discovery = async () => { throw new Error("unavailable"); };
  h.setNow(TTL);
  await h.manager.listTools(["demo"]);
  await flush();
  client.notify();
  const waiting = deferred<ToolResponse>();
  client.discovery = () => waiting.promise;
  const next = h.manager.listTools(["demo"]);
  await flush();
  assert.equal(client.discoveryCount, 3);
  waiting.resolve(response("after-notification"));
  assert.deepEqual(names(await next), [canonical("after-notification")]);
});

for (const change of ["configuration", "disabled", "deleted", "disconnected"] as const) {
  test(`${change}: a late old refresh cannot restore cache, routes or delete a new connection`, async () => {
    const h = harness();
    await h.manager.listTools(["demo"]);
    const old = h.clients[0]!;
    const waiting = deferred<ToolResponse>();
    old.discovery = () => waiting.promise;
    h.setNow(TTL);
    await h.manager.listTools(["demo"]);
    const lateClose = old.onclose;
    if (change === "configuration") h.setServers([server("demo", true, "v2")]);
    if (change === "disabled") h.setServers([server("demo", false)]);
    if (change === "deleted") h.setServers([]);
    if (change === "disconnected") old.onclose?.();
    const expected = change === "disabled" || change === "deleted" ? [] : [canonical("lookup")];
    assert.deepEqual(names(await h.manager.listTools(["demo"])), expected);
    waiting.resolve(response("obsolete"));
    await flush();
    lateClose?.();
    assert.deepEqual(names(await h.manager.listTools(["demo"])), expected);
    await assert.rejects(h.manager.callTool(canonical("obsolete"), {}, { allowedServerIds: h.allowedServerIds }), /unknown mcp tool/);
    assert.equal(old.calls.length, 0);
    if (expected.length) assert.equal(h.clients.length, 2);
  });
}

test("configuration synchronization serializes slow connects and applies newer settings last", async () => {
  const h = harness();
  const firstConnect = deferred<FakeClient>();
  const old = new FakeClient();
  let creates = 0;
  h.setClientFactory(async () => ++creates === 1 ? firstConnect.promise : new FakeClient());
  const first = h.manager.syncSettings();
  await flush();
  h.setServers([server("demo", true, "v2")]);
  const second = h.manager.syncSettings();
  await flush();
  assert.equal(creates, 1);
  firstConnect.resolve(old);
  await Promise.all([first, second]);
  assert.equal(creates, 2);
  assert.equal(old.closeCount, 1);
  assert.deepEqual(names(await h.manager.listTools(["demo"])), [canonical("lookup")]);
  assert.equal(h.clients[1]!.discoveryCount, 1);
});

test("caller authorization is applied on every list, including cross-run cache hits", async () => {
  const h = harness(["alpha", "beta"]);
  assert.deepEqual(names(await h.manager.listTools(["alpha"])), [canonical("lookup", "alpha")]);
  assert.equal(h.clients[1]!.discoveryCount, 0);
  assert.deepEqual(names(await h.manager.listTools(["beta"])), [canonical("lookup", "beta")]);
  assert.deepEqual(await h.manager.listTools([]), []);
  assert.equal(h.clients[0]!.discoveryCount, 1);
  assert.equal(h.clients[1]!.discoveryCount, 1);
});

test("removed tool routes are deleted; execution does not rediscover unrelated servers", async () => {
  const h = harness(["alpha", "beta"]);
  await h.manager.listTools(["alpha", "beta"]);
  const alpha = h.clients[0]!;
  alpha.discovery = async () => response("new");
  h.setNow(TTL);
  await h.manager.listTools(["alpha"]);
  await flush();
  await assert.rejects(h.manager.callTool(canonical("lookup", "alpha"), {}, { allowedServerIds: h.allowedServerIds }), /unknown mcp tool/);
  assert.equal(alpha.discoveryCount, 2);
  assert.equal(h.clients[1]!.discoveryCount, 1);
  const result = await h.manager.callTool(canonical("new", "alpha"), { input: 1 }, { allowedServerIds: h.allowedServerIds });
  assert.equal(result.text, "result");
  assert.deepEqual(alpha.calls, [{ name: "new", arguments: { input: 1 } }]);
});

test("cold execution discovers only the uniquely matching service and preserves its result", async () => {
  const h = harness(["alpha", "beta"]);
  const result = await h.manager.callTool(canonical("lookup", "alpha"), { input: 1 }, { allowedServerIds: h.allowedServerIds });
  assert.deepEqual(result, {
    serverId: "alpha", toolName: "lookup", text: "result",
    raw: { content: [{ type: "text", text: "result" }] },
  });
  assert.equal(h.clients[0]!.discoveryCount, 1);
  assert.equal(h.clients[1]!.discoveryCount, 0);
  await assert.rejects(h.manager.callTool("mcp_missing_tool", {}, { allowedServerIds: h.allowedServerIds }), /unknown mcp tool/);
  assert.equal(h.clients[1]!.discoveryCount, 0);
});

test("ambiguous canonical server prefixes are not guessed or scanned", async () => {
  const h = harness(["alpha", "alpha_beta"]);
  await assert.rejects(h.manager.callTool("mcp_alpha_beta_tool", {}, { allowedServerIds: h.allowedServerIds }), /unknown mcp tool/);
  assert.deepEqual(h.clients.map((client) => client.discoveryCount), [0, 0]);
});

test("tool execution checks revocation, and a removed tool cannot execute after a notification", async () => {
  const h = harness();
  await h.manager.listTools(["demo"]);
  const client = h.clients[0]!;
  client.notify();
  client.discovery = async () => response();
  await assert.rejects(h.manager.callTool(canonical("lookup"), {}, { allowedServerIds: h.allowedServerIds }), /unknown mcp tool/);
  assert.equal(client.calls.length, 0);
  h.setServers([server("demo", false)]);
  await assert.rejects(h.manager.callTool(canonical("lookup"), {}, { allowedServerIds: h.allowedServerIds }), /unknown mcp tool/);
  assert.equal(client.calls.length, 0);
});

test("execution failure is never automatically retried", async () => {
  const h = harness();
  await h.manager.listTools(["demo"]);
  const client = h.clients[0]!;
  const error = new Error("execution failed");
  client.execution = async () => { throw error; };
  await assert.rejects(h.manager.callTool(canonical("lookup"), {}, { allowedServerIds: h.allowedServerIds }), (actual) => actual === error);
  assert.equal(client.calls.length, 1);
  assert.equal(client.discoveryCount, 1);
});

test("ordinary transport request errors preserve caches and do not leak private SDK messages", async () => {
  const h = harness();
  await h.manager.listTools(["demo"]);
  const client = h.clients[0]!;
  client.onerror?.(new Error("synthetic-private-header"));
  client.discovery = async () => response("new");
  assert.deepEqual(names(await h.manager.listTools(["demo"])), [canonical("lookup")]);
  assert.equal(client.discoveryCount, 1);
  assert.equal(h.logs.join("\n").includes("synthetic-private-header"), false);
});

test("callers cannot mutate the cached schema through returned definitions", async () => {
  const h = harness();
  const first = await h.manager.listTools(["demo"]);
  first[0]!.inputSchema.type = "malformed";
  first[0]!.description = "mutated";
  const second = await h.manager.listTools(["demo"]);
  assert.equal(second[0]!.inputSchema.type, "object");
  assert.equal(second[0]!.description, "lookup");
});

test("TTL starts when discovery succeeds, not when its request starts", async () => {
  const h = harness();
  const waiting = deferred<ToolResponse>();
  const client = new FakeClient();
  client.discovery = () => waiting.promise;
  h.setClientFactory(async () => client);
  const cold = h.manager.listTools(["demo"]);
  await flush();
  h.setNow(120_000);
  waiting.resolve(response("lookup"));
  await cold;
  h.setNow(TTL);
  await h.manager.listTools(["demo"]);
  assert.equal(client.discoveryCount, 1);
  client.discovery = async () => response("new");
  h.setNow(TTL + 120_000);
  assert.deepEqual(names(await h.manager.listTools(["demo"])), [canonical("lookup")]);
  await flush();
  assert.equal(client.discoveryCount, 2);
});

test("a superseded background failure cannot set backoff or clear a newer hard refresh", async () => {
  const h = harness();
  await h.manager.listTools(["demo"]);
  const client = h.clients[0]!;
  const stale = deferred<ToolResponse>();
  const current = deferred<ToolResponse>();
  let calls = 0;
  client.discovery = () => ++calls === 1 ? stale.promise : current.promise;
  h.setNow(TTL);
  await h.manager.listTools(["demo"]);
  client.notify();
  const first = h.manager.listTools(["demo"]);
  await flush();
  stale.reject(new Error("synthetic-private-old-error"));
  await flush();
  const second = h.manager.listTools(["demo"]);
  await flush();
  assert.equal(calls, 2, "old finally must not clear the newer in-flight refresh");
  current.resolve(response("current"));
  assert.deepEqual(names(await first), [canonical("current")]);
  assert.deepEqual(names(await second), [canonical("current")]);
  assert.deepEqual(h.logs, []);
});

test("settings-read failure blocks cached tools and a later request can recover", async () => {
  const h = harness();
  await h.manager.listTools(["demo"]);
  const original = h.api.getAgentMcpSettings;
  h.api.getAgentMcpSettings = async () => { throw new Error("settings unavailable"); };
  await assert.rejects(h.manager.listTools(["demo"]), /settings unavailable/);
  await assert.rejects(h.manager.callTool(canonical("lookup"), {}, { allowedServerIds: h.allowedServerIds }), /settings unavailable/);
  assert.equal(h.clients[0]!.calls.length, 0);
  h.api.getAgentMcpSettings = original;
  assert.deepEqual(names(await h.manager.listTools(["demo"])), [canonical("lookup")]);
});

test("connection and close failures log only fixed safe messages", async () => {
  const h = harness();
  h.setClientFactory(async () => { throw new Error("synthetic-private-config"); });
  assert.deepEqual(await h.manager.listTools(["demo"]), []);
  h.setClientFactory(async () => {
    const client = new FakeClient();
    client.close = async () => { throw new Error("synthetic-private-url"); };
    return client;
  });
  await h.manager.listTools(["demo"]);
  h.setServers([]);
  assert.deepEqual(await h.manager.listTools(["demo"]), []);
  assert.equal(h.logs.length, 2);
  assert.equal(h.logs.join("\n").includes("synthetic-private"), false);
});

test("real SDK notifications invalidate on demand without SDK automatic list refresh", async () => {
  const { Client: SdkClient } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { ListToolsRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
  const sdkServer = new Server({ name: "fixture", version: "1" }, { capabilities: { tools: { listChanged: true } } });
  let discovered = 0;
  sdkServer.setRequestHandler(ListToolsRequestSchema, async () => response(++discovered === 1 ? "old" : "new"));
  const client = new SdkClient({ name: "fixture-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await sdkServer.connect(serverTransport);
  await client.connect(clientTransport);
  const api = { getAgentMcpSettings: async () => ({ updatedAt: 1, servers: [server()] }) } as unknown as AgentApiClient;
  const manager = new McpManager(api, { warn() {}, error() {}, info() {} }, { connectClient: async () => client });
  try {
    assert.deepEqual(names(await manager.listTools(["demo"])), [canonical("old")]);
    await sdkServer.notification({ method: "notifications/tools/list_changed" });
    await flush();
    assert.equal(discovered, 1, "notification must not trigger an automatic SDK refresh");
    assert.deepEqual(names(await manager.listTools(["demo"])), [canonical("new")]);
    assert.equal(discovered, 2);
  } finally {
    await client.close();
    await sdkServer.close();
  }
});

test("hard refresh failures never fall back to the invalidated snapshot", async () => {
  const h = harness();
  await h.manager.listTools(["demo"]);
  const client = h.clients[0]!;
  client.notify();
  client.discovery = async () => { throw new Error("synthetic-private-discovery-error"); };
  assert.deepEqual(await h.manager.listTools(["demo"]), []);
  assert.equal(client.discoveryCount, 2);
  assert.equal(client.closeCount, 1);
  assert.equal(h.logs.join("\n").includes("synthetic-private"), false);
  h.setClientFactory(async () => {
    const replacement = new FakeClient();
    replacement.discovery = async () => response("new");
    return replacement;
  });
  await assert.rejects(h.manager.callTool(canonical("lookup"), {}, { allowedServerIds: h.allowedServerIds }), /unknown mcp tool/);
  assert.equal(client.calls.length, 0);
});

test("tool execution uses stale metadata without awaiting an already-running soft refresh", async () => {
  const h = harness();
  await h.manager.listTools(["demo"]);
  const client = h.clients[0]!;
  const waiting = deferred<ToolResponse>();
  client.discovery = () => waiting.promise;
  h.setNow(TTL);
  const result = await h.manager.callTool(canonical("lookup"), {}, { allowedServerIds: h.allowedServerIds });
  assert.equal(result.text, "result");
  assert.equal(client.discoveryCount, 2);
  assert.equal(client.calls.length, 1);
  await h.manager.listTools(["demo"]);
  assert.equal(client.discoveryCount, 2);
  waiting.resolve(response("lookup"));
  await flush();
});

test("late failure from an old connection cannot clear a replacement connection's cache", async () => {
  const h = harness();
  await h.manager.listTools(["demo"]);
  const old = h.clients[0]!;
  const waiting = deferred<ToolResponse>();
  old.discovery = () => waiting.promise;
  h.setNow(TTL);
  await h.manager.listTools(["demo"]);
  h.setServers([server("demo", true, "v2")]);
  await h.manager.listTools(["demo"]);
  waiting.reject(new Error("synthetic-private-old-connection"));
  await flush();
  const result = await h.manager.callTool(canonical("lookup"), {}, { allowedServerIds: h.allowedServerIds });
  assert.equal(result.text, "result");
  assert.equal(h.clients[1]!.discoveryCount, 1);
  assert.equal(h.clients[1]!.calls.length, 1);
  assert.deepEqual(h.logs, []);
});

async function httpFailureFixture(successfulLists: number) {
  const { Client: SdkClient } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  let discoveryCount = 0;
  let transportErrors = 0;
  let closes = 0;
  const client = new SdkClient({ name: "fixture-client", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL("http://example.invalid/mcp"), {
    fetch: async (_input, init) => {
      if (init?.method === "GET") return new Response(null, { status: 405 });
      const message = JSON.parse(String(init?.body)) as { id?: number; method: string; params?: { protocolVersion: string } };
      if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (message.method === "initialize") {
        return Response.json({ jsonrpc: "2.0", id: message.id, result: {
          protocolVersion: message.params!.protocolVersion,
          capabilities: { tools: { listChanged: true } }, serverInfo: { name: "fixture", version: "1" },
        } });
      }
      assert.equal(message.method, "tools/list");
      discoveryCount++;
      // A regression must fail an assertion, not OOM the test runner in a microtask loop.
      if (discoveryCount > 4) await client.close();
      if (discoveryCount > successfulLists) return new Response("synthetic-private-error", { status: 503 });
      return Response.json({ jsonrpc: "2.0", id: message.id, result: response("lookup") });
    },
  });
  await client.connect(transport);
  const sdkOnError = transport.onerror;
  transport.onerror = (error) => { transportErrors++; sdkOnError?.(error); };
  const close = client.close.bind(client);
  client.close = async () => { closes++; await close(); };
  let now = 0;
  const api = { getAgentMcpSettings: async () => ({ updatedAt: 1, servers: [server()] }) } as unknown as AgentApiClient;
  const logs: string[] = [];
  const manager = new McpManager(api, { warn: (message: unknown) => logs.push(String(message)), error() {}, info() {} }, {
    connectClient: async () => client,
    nowMs: () => now,
  });
  return {
    manager, client, logs, setNow: (value: number) => { now = value; },
    discoveryCount: () => discoveryCount, transportErrors: () => transportErrors, closes: () => closes,
  };
}

test("real SDK HTTP 503 keeps stale metadata and enforces five-second retry backoff", async () => {
  const h = await httpFailureFixture(1);
  try {
    await h.manager.listTools(["demo"]);
    h.setNow(TTL);
    assert.deepEqual(names(await h.manager.listTools(["demo"])), [canonical("lookup")]);
    await flush();
    assert.equal(h.discoveryCount(), 2);
    assert.equal(h.transportErrors(), 1, "exercise the real transport onerror-before-reject behavior");
    assert.equal(h.closes(), 0);
    h.setNow(TTL + RETRY_DELAY - 1);
    assert.deepEqual(names(await h.manager.listTools(["demo"])), [canonical("lookup")]);
    assert.equal(h.discoveryCount(), 2);
    h.setNow(TTL + RETRY_DELAY);
    assert.deepEqual(names(await h.manager.listTools(["demo"])), [canonical("lookup")]);
    await flush();
    assert.equal(h.discoveryCount(), 3);
    assert.equal(h.closes(), 0);
    assert.equal(h.logs.join("\n").includes("synthetic-private-error"), false);
  } finally { await h.client.close(); }
});

test("real SDK cold HTTP 503 fails once rather than looping discovery", async () => {
  const h = await httpFailureFixture(0);
  try {
    assert.deepEqual(await h.manager.listTools(["demo"]), []);
    assert.equal(h.discoveryCount(), 1);
    assert.equal(h.transportErrors(), 1);
    assert.equal(h.closes(), 1);
  } finally { await h.client.close(); }
});

test("continuous list-changed notifications permit at most two synchronous discovery attempts", async () => {
  const h = harness();
  const client = new FakeClient();
  client.discovery = async () => {
    client.notify();
    if (client.discoveryCount > 3) client.onclose?.();
    return response("obsolete");
  };
  h.setClientFactory(async () => client);
  assert.deepEqual(await h.manager.listTools(["demo"]), []);
  assert.equal(client.discoveryCount, 2);
  assert.equal(client.calls.length, 0);
});

test("a failing discovery is not automatically retried after a concurrent notification", async () => {
  const h = harness();
  const client = new FakeClient();
  client.discovery = async () => {
    client.notify();
    throw new Error("unavailable");
  };
  h.setClientFactory(async () => client);
  assert.deepEqual(await h.manager.listTools(["demo"]), []);
  assert.equal(client.discoveryCount, 1);
});

function collisionHarness() {
  const h = harness(["alpha", "alpha_beta"]);
  const alpha = new FakeClient();
  alpha.discovery = async () => response("beta_tool", "safe_alpha");
  const beta = new FakeClient();
  beta.discovery = async () => response("tool", "safe_beta");
  let created = 0;
  h.setClientFactory(async () => created++ === 0 ? alpha : beta);
  return { ...h, alpha, beta, conflictingName: "mcp_alpha_beta_tool" };
}

test("cross-Agent discovery and cache hits cannot overwrite another server's canonical route", async () => {
  const h = collisionHarness();
  const firstAgent = await h.manager.listTools(["alpha"]);
  assert.ok(names(firstAgent).includes(h.conflictingName));
  const secondAgent = await h.manager.listTools(["alpha_beta"]);
  assert.deepEqual(names(secondAgent), [canonical("safe_beta", "alpha_beta")]);
  assert.deepEqual(names(await h.manager.listTools(["alpha"])), [canonical("safe_alpha", "alpha")]);
  for (const allowedServerIds of [["alpha"], ["alpha_beta"], ["alpha", "alpha_beta"]]) {
    await assert.rejects(h.manager.callTool(h.conflictingName, {}, { allowedServerIds }), /conflicting mcp tool name/);
  }
  assert.equal(h.alpha.discoveryCount, 1);
  assert.equal(h.beta.discoveryCount, 1);
  assert.equal(h.alpha.calls.length, 0);
  assert.equal(h.beta.calls.length, 0);
  assert.equal(h.logs.filter((message) => message.includes("conflicting mcp tool name")).length, 1);
  const safe = await h.manager.callTool(canonical("safe_alpha", "alpha"), {}, { allowedServerIds: ["alpha"] });
  assert.equal(safe.serverId, "alpha");
});

test("a same-batch conflict removes even the earlier server's accumulated definition", async () => {
  const h = collisionHarness();
  assert.deepEqual(names(await h.manager.listTools(["alpha", "alpha_beta"])), [
    canonical("safe_alpha", "alpha"), canonical("safe_beta", "alpha_beta"),
  ]);
  await assert.rejects(h.manager.callTool(h.conflictingName, {}, { allowedServerIds: h.allowedServerIds }), /conflicting mcp tool name/);
  assert.equal(h.alpha.calls.length + h.beta.calls.length, 0);
});

test("an Agent authorized for both servers cannot drift an old snapshot after one source is deleted", async () => {
  const h = collisionHarness();
  const old = await h.manager.listTools(["alpha_beta"]);
  assert.ok(names(old).includes(h.conflictingName));
  await h.manager.listTools(["alpha"]);
  await assert.rejects(h.manager.callTool(h.conflictingName, {}, { allowedServerIds: h.allowedServerIds }), /conflicting mcp tool name/);
  h.setServers([server("alpha")]);
  assert.deepEqual(names(await h.manager.listTools(["alpha"])), [canonical("safe_alpha", "alpha")]);
  await assert.rejects(h.manager.callTool(h.conflictingName, {}, { allowedServerIds: h.allowedServerIds }), /conflicting mcp tool name/);
  assert.equal(h.alpha.calls.length + h.beta.calls.length, 0);
  assert.equal(h.beta.closeCount, 1);
});

test("tool refresh deletion and hard invalidation never un-block a previously conflicting name", async () => {
  const h = collisionHarness();
  await h.manager.listTools(h.allowedServerIds);
  h.beta.discovery = async () => response("safe_beta");
  h.beta.notify();
  await h.manager.listTools(["alpha_beta"]);
  assert.deepEqual(names(await h.manager.listTools(["alpha"])), [canonical("safe_alpha", "alpha")]);
  await assert.rejects(h.manager.callTool(h.conflictingName, {}, { allowedServerIds: ["alpha"] }), /conflicting mcp tool name/);
  h.setServers([server("alpha"), server("alpha_beta", false)]);
  await h.manager.listTools(["alpha"]);
  await assert.rejects(h.manager.callTool(h.conflictingName, {}, { allowedServerIds: ["alpha"] }), /conflicting mcp tool name/);
  assert.equal(h.alpha.calls.length + h.beta.calls.length, 0);
});

test("different original tool names normalized to the same canonical name fail closed", async () => {
  const h = harness();
  const client = new FakeClient();
  client.discovery = async () => response("read.file", "read_file", "safe");
  h.setClientFactory(async () => client);
  assert.deepEqual(names(await h.manager.listTools(["demo"])), [canonical("safe")]);
  await assert.rejects(h.manager.callTool(canonical("read_file"), {}, { allowedServerIds: ["demo"] }), /conflicting mcp tool name/);
  client.discovery = async () => response("read_file", "safe");
  client.notify();
  assert.deepEqual(names(await h.manager.listTools(["demo"])), [canonical("safe")]);
  await assert.rejects(h.manager.callTool(canonical("read_file"), {}, { allowedServerIds: ["demo"] }), /conflicting mcp tool name/);
  assert.equal(client.calls.length, 0);
});

test("provenance remains protected when conflicting sources are observed on different connections over time", async () => {
  const h = collisionHarness();
  await h.manager.listTools(["alpha"]);
  h.setServers([server("alpha_beta")]);
  assert.deepEqual(names(await h.manager.listTools(["alpha_beta"])), [canonical("safe_beta", "alpha_beta")]);
  await assert.rejects(h.manager.callTool(h.conflictingName, {}, { allowedServerIds: ["alpha_beta"] }), /conflicting mcp tool name/);
  assert.equal(h.beta.calls.length, 0);
});

test("execution requires an explicit authorized server list on each call", async () => {
  const h = harness();
  await h.manager.listTools(["demo"]);
  await assert.rejects(h.manager.callTool(canonical("lookup"), {}), /not authorized/);
  await assert.rejects(h.manager.callTool(canonical("lookup"), {}, { allowedServerIds: [] }), /not authorized/);
  await assert.rejects(h.manager.callTool(canonical("lookup"), {}, { allowedServerIds: ["other"] }), /not authorized/);
  assert.equal(h.clients[0]!.calls.length, 0);
  const result = await h.manager.callTool(canonical("lookup"), {}, { allowedServerIds: ["demo"] });
  assert.equal(result.serverId, "demo");
  assert.equal(h.clients[0]!.calls.length, 1);
});

test("cold execution never discovers a service outside the current call's authorization", async () => {
  const h = harness(["alpha", "beta"]);
  await assert.rejects(h.manager.callTool(canonical("lookup", "alpha"), {}, { allowedServerIds: ["beta"] }), /unknown mcp tool/);
  assert.deepEqual(h.clients.map((client) => client.discoveryCount), [0, 0]);
  assert.deepEqual(h.clients.map((client) => client.calls.length), [0, 0]);
});
