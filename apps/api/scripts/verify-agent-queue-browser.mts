/**
 * Opt-in A-COUNT E2E. Uses an already-built Web/Worker and an optional, isolated
 * Playwright install; never imports main.ts, Vite config or an integration test.
 * Preparation, isolation variables and invocation: docs/design/0038-agent-session-message-queue/08-implementation-and-acceptance.md.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { FastifyInstance } from "fastify";
import type { AgentMessageQueueSnapshot } from "@agent-workbench/shared";
import { createApp } from "../src/app/createApp.js";
import type { AppContext } from "../src/app/context.js";
import { openDb, type Db } from "../src/infra/db/db.js";
import { workspaceRoot } from "../src/infra/fs/paths.js";
import { insertWorkspace } from "../src/modules/workspaces/workspace.store.js";
import { getRunRecord } from "../src/modules/agent/agent-message.store.js";
import { AgentWorkerClient } from "../src/modules/agent/agent.worker-client.js";

// Only the small browser surface used here is structural: default API builds
// must not resolve an optional Playwright package from the real dependency tree.
type Bounds = { x: number; y: number; width: number; height: number };
interface Locator {
  fill(text: string): Promise<void>;
  press(key: string): Promise<void>;
  click(): Promise<void>;
  count(): Promise<number>;
  innerText(): Promise<string>;
  boundingBox(): Promise<Bounds | null>;
  waitFor(options: { state: "visible" | "hidden"; timeout?: number }): Promise<void>;
  getByRole(role: string, options: { name: string | RegExp; exact?: boolean }): Locator;
}
interface BrowserResponse { url(): string; json(): Promise<unknown> }
interface Page {
  goto(url: string, options?: { waitUntil: "domcontentloaded" }): Promise<unknown>;
  reload(options?: { waitUntil: "domcontentloaded" }): Promise<unknown>;
  locator(selector: string): Locator;
  evaluate<T>(callback: () => T): Promise<T>;
  waitForFunction(callback: () => boolean, argument?: unknown, options?: { timeout: number }): Promise<unknown>;
  waitForResponse(predicate: (response: BrowserResponse) => boolean, options: { timeout: number }): Promise<BrowserResponse>;
  screenshot(options: { path: string; fullPage: boolean }): Promise<unknown>;
}
interface BrowserContext {
  newPage(): Promise<Page>;
  close(): Promise<void>;
  browser(): { version(): string };
  addInitScript(callback: (arg: { workspaceId: string; sessionId: string }) => void, arg: { workspaceId: string; sessionId: string }): Promise<void>;
  route(pattern: string, callback: (route: { request(): { url(): string }; continue(): Promise<void>; abort(reason: string): Promise<void> }) => Promise<void>): Promise<void>;
  routeWebSocket(pattern: string, callback: (socket: { url(): string; connectToServer(): unknown; close(): void }) => void): Promise<void>;
}
type Playwright = { chromium: { launchPersistentContext(profile: string, options: Record<string, unknown>): Promise<BrowserContext> } };

const repoRoot = await fs.realpath(fileURLToPath(new URL("../../../", import.meta.url)));
const isolationRoot = path.join(repoRoot, ".tmp-tests/browser-e2e");
let phase = "isolation";
let evidenceDir: string | undefined;

function inside(root: string, value: string) {
  const relative = path.relative(root, value);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}
async function isolatedPath(value: string) {
  const resolved = path.resolve(value);
  assert.ok(inside(isolationRoot, resolved), "path must stay inside browser-e2e isolation");
  assert.equal(await fs.realpath(resolved), resolved, "symlinked isolation paths are not allowed");
  return resolved;
}
async function waitUntil(condition: () => boolean | Promise<boolean>, description: string, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (!await condition()) {
    assert.ok(Date.now() < deadline, `timed out: ${description}`);
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}
async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}
async function closeServer(server: Server | undefined) {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
function loopback(raw: string) {
  const url = new URL(raw);
  return ["http:", "https:", "ws:", "wss:"].includes(url.protocol) && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
}
function providerChunks(first: boolean) {
  const begin = { type: "response.created", response: { id: first ? "browser-tools" : "browser-answer", created_at: 1, model: "gpt-5.2" } };
  if (!first) return [begin,
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "browser-message", phase: "final_answer" } },
    { type: "response.output_text.delta", item_id: "browser-message", delta: "Browser queue processed" },
    { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "browser-message", phase: "final_answer" } },
    { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
  ];
  const calls = [1, 2].map(index => ({ type: "function_call", id: `browser-call-item-${index}`, call_id: `browser-call-${index}`,
    name: "bash", arguments: JSON.stringify({ command: `printf browser-tool-${index}` }), status: "completed" }));
  return [begin, ...calls.flatMap((item, index) => [
    { type: "response.output_item.added", output_index: index, item: { ...item, arguments: "" } },
    { type: "response.function_call_arguments.delta", item_id: item.id, output_index: index, delta: item.arguments },
    { type: "response.output_item.done", output_index: index, item },
  ]), { type: "response.completed", response: { output: calls, usage: { input_tokens: 1, output_tokens: 1 } } }];
}

async function main() {
  const args = process.argv.slice(2);
  assert.ok(args.length <= 1 && args.every(arg => arg.startsWith("--tools=")), "usage: verify-agent-queue-browser.mts [--tools=<repo-relative directory>]");
  assert.equal(await fs.realpath(isolationRoot), isolationRoot);
  for (const key of ["HOME", "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "npm_config_cache",
    "npm_config_userconfig", "npm_config_globalconfig", "PLAYWRIGHT_BROWSERS_PATH"] as const) {
    assert.ok(process.env[key], `missing isolation variable: ${key}`);
    await isolatedPath(process.env[key]!);
  }
  for (const key of ["npm_config_userconfig", "npm_config_globalconfig"]) assert.equal(await fs.readFile(process.env[key]!, "utf8"), "");
  assert.ok(!Object.keys(process.env).some(key => key.startsWith("AWB_")), "run under the documented clean environment, not user AWB settings");
  assert.ok(!process.env.NODE_OPTIONS, "do not inherit Node preloads");
  const tools = await isolatedPath(path.resolve(repoRoot, args[0]?.slice("--tools=".length) ?? ".tmp-tests/browser-e2e/tools"));
  const packageDir = await isolatedPath(path.join(tools, "node_modules/playwright"));
  assert.equal(JSON.parse(await fs.readFile(path.join(packageDir, "package.json"), "utf8")).version, "1.56.1");
  const playwright = await import(pathToFileURL(path.join(packageDir, "index.mjs")).href) as Playwright;
  await fs.access(path.join(repoRoot, "apps/web/dist/index.html"));
  await fs.access(path.join(repoRoot, "apps/agent-worker/dist/main.js"));
  evidenceDir = await fs.mkdtemp(path.join(isolationRoot, "evidence/agent-queue-"));
  const profile = await fs.mkdtemp(path.join(isolationRoot, "profiles/agent-queue-"));
  const dataDir = await fs.mkdtemp(path.join(isolationRoot, "tmp/agent-queue-"));
  const evidence: Record<string, unknown> = { suite: "A-COUNT", playwright: "1.56.1", passed: false, assertions: {} };
  const checks = evidence.assertions as Record<string, boolean>;
  let browser: BrowserContext | undefined, page: Page | undefined, app: FastifyInstance | undefined, db: Db | undefined;
  let provider: Server | undefined, bridge: Server | undefined;
  let sessionId = "", runId = "", targetPort = 0, blockedHttp = 0, blockedWebSocket = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const terminalIds = new Set<string>();
  const requests: Array<Record<string, unknown>> = [];
  const workspaceId = "browser-queue-workspace";
  const texts = ["browser queued one", "browser queued cancel", "browser queued three"];
  const count = () => page!.locator('[data-testid="queue-pending-count"]');
  const editor = () => page!.locator('[data-testid="agent-message-queue"] + textarea:visible');
  try {
    phase = "chromium-launch";
    browser = await playwright.chromium.launchPersistentContext(profile, { headless: true, locale: "zh-CN", viewport: { width: 1600, height: 1100 },
      downloadsPath: path.join(isolationRoot, "downloads"), serviceWorkers: "block", args: ["--disable-background-networking", "--disable-component-update", "--no-first-run", "--disable-sync"] });
    evidence.chromium = browser.browser().version();
    await browser.route("**/*", async route => {
      if (loopback(route.request().url())) await route.continue();
      else { blockedHttp++; await route.abort("blockedbyclient"); }
    });
    await browser.routeWebSocket("**/*", socket => {
      if (loopback(socket.url())) socket.connectToServer();
      else { blockedWebSocket++; socket.close(); }
    });
    phase = "fixture";
    provider = createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/responses") { res.writeHead(404); res.end(); return; }
      let body = "";
      req.setEncoding("utf8"); req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        try {
          requests.push(JSON.parse(body));
          res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
          res.end(providerChunks(requests.length === 1).map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join(""));
        } catch { res.writeHead(400); res.end(); }
      });
    });
    const providerOrigin = await listen(provider);
    // API must know a stable callback origin before creating the managed Worker.
    // A loopback-only bridge gives both HTTP listeners port 0 without a free-port
    // reservation race. Browser traffic goes directly to Fastify, including WS.
    bridge = createServer((req, res) => {
      if (!targetPort || !req.url?.startsWith("/api/internal/agent/")) { res.writeHead(503); res.end(); return; }
      const forwarded = httpRequest({ hostname: "127.0.0.1", port: targetPort, path: req.url, method: req.method, headers: req.headers }, upstream => {
        res.writeHead(upstream.statusCode ?? 502, upstream.headers); upstream.pipe(res);
      });
      forwarded.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.on("aborted", () => forwarded.destroy()); req.pipe(forwarded);
    });
    const workerApiOrigin = await listen(bridge);
    db = await openDb(dataDir);
    const ctx: AppContext = { db, repoRoot, dataDir, fileMaxBytes: 1024 * 1024, version: "browser-e2e", logLevel: "error",
      serveWeb: true, webDistDir: path.join(repoRoot, "apps/web/dist"), preview: { enabled: false, runtime: null }, analytics: { enabled: false },
      credentialMasterKey: Buffer.alloc(32, 7), credentialMasterKeySource: "generated", credentialMasterKeyId: "browser-fixture", credentialMasterKeyCreatedAt: Date.now(),
      authToken: null, authCookieSecure: false, agentWorkerEnabled: true, agentWorkerHost: "127.0.0.1", agentWorkerPort: 4312,
      agentWorkerSocketPath: path.join(dataDir, "worker.sock"), agentWorkerConcurrency: 1, agentInternalToken: "browser-fixture-internal-only",
      agentWorkerResponseValidation: "strict", agentApiOrigin: workerApiOrigin, agentPluginHostEnabled: false, agentPluginServicesEnabled: false,
      agentPluginHostSocketPath: path.join(dataDir, "plugin.sock") };
    app = await createApp(ctx);
    const workspacePath = workspaceRoot(dataDir, "browser-queue-workspace");
    await fs.mkdir(workspacePath, { recursive: true });
    insertWorkspace(db, { id: workspaceId, dirName: "browser-queue-workspace", title: "A-COUNT Browser Fixture", path: workspacePath,
      terminalCredentialId: null, createdAt: Date.now(), updatedAt: Date.now() });
    app.addHook("preHandler", async request => {
      if (request.url !== "/api/internal/agent/tool-executions/update") return;
      const body = request.body as { status?: string; toolExecutionId: string };
      if (!["completed", "failed"].includes(body.status ?? "")) return;
      terminalIds.add(body.toolExecutionId); await gate;
    });
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    targetPort = new URL(origin).port ? Number(new URL(origin).port) : 80;
    const api = async <T,>(url: string, method = "GET", body?: unknown): Promise<T> => {
      const response = await fetch(`${origin}${url}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10_000) });
      assert.ok(response.ok, `fixture API returned ${response.status} for ${method} ${url.split("?")[0]}`);
      return await response.json() as T;
    };
    await api("/api/settings/agent/providers", "PUT", { default: { providerId: "browser-provider", modelId: "gpt-5.2" }, providers: [
      { id: "browser-provider", name: "Loopback fixture", npm: "@ai-sdk/openai", options: { baseURL: `${providerOrigin}/v1`, apiKey: "fixture-not-a-real-key" },
        models: [{ id: "gpt-5.2", name: "Loopback model", contextWindowTokens: 128000 }] },
    ] });
    await api("/api/settings/agent/agents", "PUT", { default: { agentId: "browser-agent" }, agents: [
      { id: "browser-agent", name: "Browser fixture", summary: "", prompt: "Use fixture tools.", tools: ["bash"], pluginTools: [], mcpServers: [],
        defaultModel: { providerId: "browser-provider", modelId: "gpt-5.2" }, scope: "both", order: 0 },
    ] });
    await api("/api/settings/agent/runtime", "PUT", { modelRequestMaxRetries: 0, modelIdleTimeoutMs: 1500, modelTotalTimeoutMs: 1500, autoCompactThresholdPct: 80 });
    sessionId = (await api<{ id: string }>("/api/agent/sessions", "POST", { workspaceId, title: "A-COUNT Browser Session" })).id;
    const worker = new AgentWorkerClient({ workerOrigin: "http://127.0.0.1:4312", workerSocketPath: ctx.agentWorkerSocketPath,
      internalToken: ctx.agentInternalToken, responseValidation: "strict", logger: app.log });
    const identity = await worker.getRuntimeIdentity();
    assert.match(identity.runtimeInstanceId, /^[0-9a-f-]{36}$/);
    checks.realManagedWorkerIdentity = true;
    const snapshot = () => api<AgentMessageQueueSnapshot>(`/api/agent/sessions/${sessionId}/message-queue?workspaceId=${workspaceId}`);
    const receipts = () => db!.prepare("select id, status, injected_run_id as runId from agent_user_message_receipt where session_id=? order by sequence").all(sessionId) as Array<{ id: string; status: string; runId: string | null }>;
    await browser.addInitScript(({ workspaceId: ws, sessionId: session }) => {
      localStorage.setItem("agent-workbench.locale", "zh-CN");
      localStorage.setItem(`agent-workbench.workspace.agent.activeClient.v1.${ws}`, session);
      localStorage.setItem(`agent-workbench.workspace.dockLayout.v4.${ws}`, JSON.stringify({ version: 4, updatedAt: 1,
        ratios: { topBottom: 0.9, topLeft: 0.75 }, activeToolIdByArea: { leftTop: "agent", leftBottom: null, rightTop: null },
        toolMinimized: { agent: false, files: true, search: true, terminal: true, editor: true, codeReview: true, scheduledTasks: true, environmentVariables: true } }));
    }, { workspaceId, sessionId });
    page = await browser.newPage();
    const url = `${origin}/workspaces/${workspaceId}`;
    phase = "workspace-browser";
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await editor().waitFor({ state: "visible", timeout: 20_000 });
    assert.equal(await count().count(), 0); checks.initialZeroHidden = true;
    const send = async (text: string) => {
      await editor().fill(text); await editor().press("Enter");
      await page!.waitForFunction(() => [...document.querySelectorAll<HTMLTextAreaElement>('[data-testid="agent-message-queue"] + textarea')].some(input => input.getBoundingClientRect().height > 0 && input.value === ""), undefined, { timeout: 10_000 });
    };
    phase = "browser-first-message";
    await send("browser initial tool request");
    await waitUntil(() => terminalIds.size === 2, "both real bash results reached the closed writeback gate");
    assert.equal(requests.length, 1);
    const first = receipts(); assert.equal(first.length, 1); assert.ok(first[0]!.runId); runId = first[0]!.runId!;
    assert.equal(getRunRecord(db, runId)!.status, "running"); checks.firstMessageViaBrowser = true;
    phase = "browser-queue-three";
    for (const [index, text] of texts.entries()) {
      phase = `browser-queue-send-${index + 1}`; await send(text);
      phase = `browser-queue-accept-${index + 1}`;
      await waitUntil(async () => (await snapshot()).pendingCount === index + 1, "browser receipt accepted");
    }
    await page.waitForFunction(() => document.querySelector('[data-testid="queue-pending-count"]')?.textContent?.trim() === "有 3 条消息等待处理");
    const before = await snapshot(); assert.equal(before.pendingCount, 3); assert.equal(receipts().length, 4); assert.equal(requests.length, 1);
    const bounds = await page.evaluate(() => {
      const label = document.querySelector('[data-testid="queue-pending-count"]')!;
      const input = document.querySelector('[data-testid="agent-message-queue"] + textarea')!;
      const l = label.getBoundingClientRect(), i = input.getBoundingClientRect();
      const footerStyle = getComputedStyle(input.closest("footer")!);
      return { label: { top: l.top, bottom: l.bottom, width: l.width, height: l.height }, input: { top: i.top, bottom: i.bottom, width: i.width, height: i.height },
        footerStyles: { position: footerStyle.position, paddingLeft: parseFloat(footerStyle.paddingLeft) },
        labelBeforeInput: Boolean(label.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING), text: label.textContent?.trim() };
    });
    assert.equal(bounds.footerStyles.position, "relative"); assert.ok(bounds.footerStyles.paddingLeft > 0, "built Tailwind layout must be present");
    checks.builtLayoutStylesPresent = true;
    assert.ok(bounds.labelBeforeInput && bounds.label.bottom <= bounds.input.top);
    assert.ok(bounds.label.height > 0 && bounds.input.height > 0);
    assert.ok((await count().boundingBox())!.width > 0);
    checks.threeQueuedVisible = true; checks.realLayoutAboveInput = true; evidence.layout = bounds;
    await page.screenshot({ path: path.join(evidenceDir, "queued-three.png"), fullPage: true });
    phase = "browser-refresh";
    const receiptIds = receipts().map(item => item.id);
    await page.reload({ waitUntil: "domcontentloaded" });
    await editor().waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector('[data-testid="queue-pending-count"]')?.textContent?.trim() === "有 3 条消息等待处理");
    assert.deepEqual(receipts().map(item => item.id), receiptIds); assert.deepEqual((await snapshot()).items.map(item => item.id), before.items.map(item => item.id));
    assert.equal(requests.length, 1); checks.refreshPreservesThreeWithoutDuplicate = true;
    await page.screenshot({ path: path.join(evidenceDir, "refreshed-three.png"), fullPage: true });
    phase = "browser-cancel";
    const cancel = before.items.find(item => item.textPreview === texts[1]); assert.ok(cancel);
    phase = "browser-expand-queue";
    const openBefore = await page.evaluate(() => document.querySelector('[data-testid="queue-items"]')?.hasAttribute("open"));
    await page.evaluate(() => {
      const details = document.querySelector('[data-testid="queue-items"]')!;
      const debug = { changes: [] as boolean[], get connected() { return details.isConnected; } };
      new MutationObserver(() => debug.changes.push(details.hasAttribute("open"))).observe(details, { attributes: true, attributeFilter: ["open"] });
      (window as unknown as { queueDebug: typeof debug }).queueDebug = debug;
    });
    await page.locator('[data-testid="queue-items"] summary').click();
    evidence.queueExpansion = { openBefore, openAfter: await page.evaluate(() => document.querySelector('[data-testid="queue-items"]')?.hasAttribute("open")) };
    phase = "browser-expanded-run-poll";
    const runPoll = await page.waitForResponse(response => new URL(response.url()).pathname === `/api/agent/sessions/${sessionId}/run-state`, { timeout: 15_000 });
    assert.equal((await runPoll.json() as { status: string }).status, "running");
    // Let the real response and Vue render commit; never mutate the product state.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    assert.equal(await page.evaluate(() => (window as unknown as { queueDebug?: { connected: boolean } }).queueDebug?.connected === true
      && document.querySelector('[data-testid="queue-items"]')?.hasAttribute("open") === true), true);
    checks.realRunPollPreservesExpandedDetails = true;
    phase = "browser-cancel-button";
    // Ant Design inserts a visual space between two Chinese button characters.
    await page.locator(`[data-receipt-id="${cancel.id}"]`).getByRole("button", { name: /^取\s*消$/ }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="queue-pending-count"]')?.textContent?.trim() === "有 2 条消息等待处理");
    const stableDetails = await page.evaluate(() => (window as unknown as { queueDebug?: { connected: boolean } }).queueDebug?.connected === true
      && document.querySelector('[data-testid="queue-items"]')?.hasAttribute("open") === true);
    assert.equal(stableDetails, true); checks.expandedDetailsSurviveRunSnapshotsAndCancel = true;
    assert.equal((await snapshot()).pendingCount, 2); assert.equal(receipts().find(item => item.id === cancel.id)!.status, "cancelled");
    assert.equal(requests.length, 1); checks.cancelViaBrowserShowsTwo = true;
    await page.screenshot({ path: path.join(evidenceDir, "cancelled-two.png"), fullPage: true });
    phase = "same-run-injection";
    release();
    await waitUntil(() => getRunRecord(db!, runId)?.status === "completed", "same Run completes after releasing the whole tool round");
    await count().waitFor({ state: "hidden", timeout: 10_000 });
    assert.equal(await count().count(), 0); assert.equal((await snapshot()).pendingCount, 0); checks.finalZeroHidden = true;
    assert.equal(requests.length, 2);
    const input = requests[1]!.input as Array<Record<string, unknown>>;
    const calls = input.filter(item => item.type === "function_call"), outputs = input.filter(item => item.type === "function_call_output");
    assert.equal(calls.length, 2); assert.equal(outputs.length, 2);
    assert.deepEqual(new Set(outputs.map(item => item.call_id)), new Set(calls.map(item => item.call_id)));
    const callPositions = input.flatMap((item, index) => item.type === "function_call" ? [index] : []);
    const outputPositions = input.flatMap((item, index) => item.type === "function_call_output" ? [index] : []);
    assert.ok(Math.max(...callPositions) < Math.min(...outputPositions));
    const userPositions = [texts[0]!, texts[2]!].map(text => input.findIndex(item => item.role === "user" && JSON.stringify(item.content).includes(text)));
    assert.ok(userPositions[0]! > Math.max(...outputPositions) && userPositions[1]! > userPositions[0]!);
    assert.ok(!JSON.stringify(input).includes(texts[1]!)); checks.actualProviderInputHasTwoUsersAfterCompleteToolRound = true;
    const finalReceipts = receipts(); assert.equal(finalReceipts.length, 4);
    assert.equal(finalReceipts.filter(item => item.status === "cancelled").length, 1);
    assert.ok(finalReceipts.filter(item => item.status === "injected").every(item => item.runId === runId));
    assert.equal((db.prepare("select count(*) as n from agent_run where session_id=?").get(sessionId) as { n: number }).n, 1); checks.sameRunNoDuplicateReceipts = true;
    await page.screenshot({ path: path.join(evidenceDir, "completed-zero.png"), fullPage: true });
    evidence.run = { id: runId, status: "completed", receiptCount: 4, injectedCount: 3, cancelledCount: 1 };
    evidence.provider = { kind: "loopback-fake", requestCount: 2, callPositions, outputPositions, userPositions };
    evidence.network = { loopbackOnly: true, blockedHttp, blockedWebSocket };
    evidence.screenshots = ["queued-three.png", "refreshed-three.png", "cancelled-two.png", "completed-zero.png"];
    evidence.passed = true;
  } finally {
    if (!evidence.passed && page) {
      await page.screenshot({ path: path.join(evidenceDir, "failure.png"), fullPage: true }).catch(() => undefined);
      evidence.failureDom = await page.evaluate(() => ({
        visibleTextareaCount: [...document.querySelectorAll("textarea")].filter(node => node.getBoundingClientRect().height > 0).length,
        detailsOpen: document.querySelector('[data-testid="queue-items"]')?.hasAttribute("open"),
        receiptRowCount: document.querySelectorAll('[data-receipt-id]').length,
        debug: (window as unknown as { queueDebug?: { changes: boolean[]; connected: boolean } }).queueDebug,
        countText: document.querySelector('[data-testid="queue-pending-count"]')?.textContent?.trim(),
      })).catch(() => null);
    }
    release();
    // Always release writeback before shutting down browser/API. Normal and
    // failure paths let an already-started Run settle while SQLite stays open.
    if (sessionId && db) await waitUntil(() => (db!.prepare("select count(*) as n from agent_run where session_id=? and status='running'").get(sessionId) as { n: number }).n === 0,
      "teardown Run settlement", 10_000).catch(() => undefined);
    const cleanupErrors: string[] = [];
    try { await browser?.close(); } catch { cleanupErrors.push("browser"); }
    let appClosed = !app;
    try { await app?.close(); appClosed = true; } catch { cleanupErrors.push("application"); }
    if (appClosed) db?.close(); // Do not close SQLite beneath a still-owned Runner.
    try { await closeServer(bridge); } catch { cleanupErrors.push("bridge"); }
    try { await closeServer(provider); } catch { cleanupErrors.push("provider"); }
    if (appClosed) await fs.rm(dataDir, { recursive: true, force: true });
    evidence.cleanup = { complete: cleanupErrors.length === 0, failedComponents: cleanupErrors };
    if (cleanupErrors.length) evidence.passed = false;
    await fs.writeFile(path.join(evidenceDir, "result.json"), JSON.stringify(evidence, null, 2));
    assert.equal(cleanupErrors.length, 0, "fixture cleanup must complete");
  }
  console.log(JSON.stringify({ passed: true, suite: "A-COUNT", evidence: path.relative(repoRoot, evidenceDir!) }));
}

await main().catch(async error => {
  const message = error instanceof Error ? error.message : "";
  // Classify browser failures without persisting raw errors, credentials or paths.
  const diagnostic = message.includes("strict mode violation") ? "selector-not-unique"
    : message.includes("Target page, context or browser has been closed") ? "browser-closed"
    : message.includes("Timeout") || message.includes("timed out") ? "timeout" : "other";
  const operation = /^([a-zA-Z.]+):/.exec(message)?.[1];
  const actionability = ["element is not visible", "element is not enabled", "element was detached", "intercepts pointer events", "element is not stable"].filter(reason => message.includes(reason));
  if (evidenceDir) await fs.writeFile(path.join(evidenceDir, "failure.json"), JSON.stringify({ passed: false, phase,
    errorType: error instanceof Error ? error.name : "unknown", diagnostic, operation, actionability }, null, 2));
  console.error(`A-COUNT browser verification failed at ${phase}; inspect isolated evidence (no user configuration was loaded).`);
  process.exitCode = 1;
});
