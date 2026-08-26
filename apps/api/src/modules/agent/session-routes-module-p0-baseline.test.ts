import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { afterEach, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { HttpError } from "../../app/errors.js";
import { newSortableId } from "../../utils/ids.js";
import { AgentRuntime } from "./agent.runtime.js";
import { registerAgentRoutes } from "./agent.routes.js";
import { AgentService } from "./agent.service.js";
import { createAgentComposition, createAgentService } from "./agent.composition.js";
import { agentAttachmentTempDir } from "./attachments/agent-attachment-paths.js";
import {
  AgentConflictError,
  appendContextItem,
  createAgentSession,
  getRunState,
  getSessionTranscriptItems,
  moveSessionHead,
  updateRunState
} from "./agent.store.js";
import { AgentRunCompletedEventHub } from "./run-completed-events.js";
import {
  createAgentTestFixture,
  createFakeAgentRuntime,
  createTestWorkspace,
  type AgentTestFixture
} from "./testkit/agent-testkit.js";

const fixtures: AgentTestFixture[] = [];
const routeApps: FastifyInstance[] = [];

afterEach(async () => {
  const failures: unknown[] = [];
  for (const app of routeApps.splice(0)) {
    try {
      await app.close();
    } catch (error) {
      failures.push(error);
    }
  }
  for (const fixture of fixtures.splice(0)) {
    try {
      await fixture.dispose();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "P0 baseline fixture cleanup failed");
});

async function configureAgentDefaults(app: FastifyInstance) {
  const providers = await app.inject({
    method: "PUT",
    url: "/api/settings/agent/providers",
    payload: {
      default: { providerId: "p0-provider", modelId: "p0-model" },
      providers: [{
        id: "p0-provider",
        name: "P0 provider",
        npm: "@ai-sdk/openai",
        options: { baseURL: "https://example.test/v1", apiKey: "p0-test-key" },
        models: [{ id: "p0-model", name: "P0 model", contextWindowTokens: 128000 }]
      }]
    }
  });
  assert.equal(providers.statusCode, 200, providers.body);

  const agents = await app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      agents: [{
        id: "default",
        name: "default",
        summary: "",
        prompt: "P0 characterization agent",
        tools: ["read"],
        pluginTools: [],
        mcpServers: [],
        defaultModel: { providerId: "p0-provider", modelId: "p0-model" },
        scope: "both",
        order: 0
      }]
    }
  });
  assert.equal(agents.statusCode, 200, agents.body);
}

function createPrimarySession(fixture: AgentTestFixture, workspaceId: string) {
  const id = newSortableId("sess");
  createAgentSession(fixture.db, {
    id,
    workspaceId,
    title: "P0 session",
    kind: "primary",
    createdAt: Date.now()
  });
  return id;
}

function createSubtaskSession(fixture: AgentTestFixture, workspaceId: string) {
  const id = newSortableId("sess");
  createAgentSession(fixture.db, {
    id,
    workspaceId,
    title: "P0 subtask",
    kind: "subtask",
    createdAt: Date.now()
  });
  return id;
}

async function expectHttpError(action: () => Promise<unknown>, expected: { statusCode: number; code?: string; message?: string }) {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.statusCode, expected.statusCode);
    if (expected.code !== undefined) assert.equal(error.code, expected.code);
    if (expected.message !== undefined) assert.equal(error.message, expected.message);
    return true;
  });
}

test("agent composition startup wires attachment temp cleanup with its dataDir", async () => {
  const fixture = await createAgentTestFixture();
  fixtures.push(fixture);
  const tempDir = agentAttachmentTempDir(fixture.dataDir);
  const staleFile = `${tempDir}/stale.part`;
  await fs.mkdir(tempDir, { recursive: true });
  await fs.writeFile(staleFile, "stale");
  const now = Date.now();
  await fs.utimes(staleFile, new Date(now - 25 * 60 * 60 * 1000), new Date(now - 25 * 60 * 60 * 1000));

  const composition = createAgentComposition(fixture.ctx, { warn() {} } as never);
  await composition.startupCoordinator.runPreListen();

  await assert.rejects(() => fs.access(staleFile));
});

test("P0 sendMessage freezes validation order, fast-path dedup, raw/trim split, profile errors, and running", async () => {
  const fixture = await createAgentTestFixture({ withApp: true, agentWorkerConcurrency: 0 });
  fixtures.push(fixture);
  assert.ok(fixture.app);
  await configureAgentDefaults(fixture.app);
  const workspace = await createTestWorkspace(fixture, { title: "P0 send workspace" });
  const service = createAgentService(fixture.ctx, fixture.app.log);
  const runtime = createFakeAgentRuntime();

  await expectHttpError(
    () => service.sendMessage({
      sessionId: "missing-session",
      body: { workspaceId: workspace.id, text: "hello", clientRequestId: "p0-missing" },
      runtime
    }),
    { statusCode: 404, message: "session not found" }
  );

  const subtaskSessionId = createSubtaskSession(fixture, workspace.id);
  await expectHttpError(
    () => service.sendMessage({
      sessionId: subtaskSessionId,
      body: { workspaceId: workspace.id, text: "hello", clientRequestId: "p0-subtask" },
      runtime
    }),
    { statusCode: 400, code: "AGENT_SUBTASK_READONLY" }
  );

  const sessionId = createPrimarySession(fixture, workspace.id);
  await expectHttpError(
    () => service.sendMessage({
      sessionId,
      body: { workspaceId: "other-workspace", text: "hello", clientRequestId: "p0-mismatch" },
      runtime
    }),
    { statusCode: 400, message: "workspaceId mismatch" }
  );
  await expectHttpError(
    () => service.sendMessage({
      sessionId,
      body: { workspaceId: workspace.id, text: "  \n ", clientRequestId: "p0-empty" },
      runtime
    }),
    { statusCode: 400, message: "text or image is required" }
  );
  await expectHttpError(
    () => service.sendMessage({
      sessionId,
      body: { workspaceId: workspace.id, text: "hello", clientRequestId: "p0-profile", agentId: "missing-agent" },
      runtime
    }),
    { statusCode: 400, code: "AGENT_NOT_FOUND" }
  );

  const rawText = "  preserve original runtime text  ";
  const first = await service.sendMessage({
    sessionId,
    body: { workspaceId: workspace.id, text: rawText, clientRequestId: "p0-dedup" },
    runtime
  });
  assert.equal(first.deduplicated, false);
  assert.equal(runtime.enqueueRunCalls.length, 1);
  assert.equal(runtime.enqueueRunCalls[0]?.inputText, rawText);
  const [userItem] = getSessionTranscriptItems(fixture.db, workspace.id, sessionId);
  assert.equal(userItem?.output.type, "user_text");
  assert.equal(userItem?.output.text, rawText.trim());

  const deduplicated = await service.sendMessage({
    sessionId,
    body: { workspaceId: workspace.id, text: "different body is ignored by dedup", clientRequestId: "p0-dedup" },
    runtime
  });
  assert.deepEqual(deduplicated, { ...first, deduplicated: true });
  assert.equal(runtime.enqueueRunCalls.length, 1, "deduplicated request must not enqueue again");

  await expectHttpError(
    () => service.sendMessage({
      sessionId,
      body: { workspaceId: workspace.id, text: "new request while active", clientRequestId: "p0-running" },
      runtime
    }),
    { statusCode: 409, message: "session is running" }
  );
});

test("P0 Context Query freezes full/after/tail/before paging, head fence, and visible-path authorization", async () => {
  const fixture = await createAgentTestFixture({ withApp: true, agentWorkerConcurrency: 0 });
  fixtures.push(fixture);
  assert.ok(fixture.app);
  const workspace = await createTestWorkspace(fixture, { title: "P0 context workspace" });
  const sessionId = createPrimarySession(fixture, workspace.id);
  const service = createAgentService(fixture.ctx, fixture.app.log);
  const createdAt = Date.now();
  const append = (prevId: number | null, text: string, offset: number) => appendContextItem(fixture.db, {
    workspaceId: workspace.id,
    sessionId,
    runId: null,
    turnId: null,
    step: null,
    prevId,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text },
    createdAt: createdAt + offset
  });
  const first = append(null, "first", 1);
  const second = append(first.id, "second", 2);
  const third = append(second.id, "third", 3);

  assert.deepEqual(service.getContextItems(sessionId).items.map((item) => item.id), [first.id, second.id, third.id]);
  assert.deepEqual(service.getContextItems(sessionId, { afterId: first.id }).items.map((item) => item.id), [second.id, third.id]);
  const tail = service.getContextItems(sessionId, { tailLimit: 2 });
  assert.deepEqual(tail.items.map((item) => item.id), [second.id, third.id]);
  assert.equal(tail.hasMoreBefore, true);
  const before = service.getContextItems(sessionId, { beforeId: third.id, limit: 1, expectedHeadItemId: third.id });
  assert.deepEqual(before.items.map((item) => item.id), [second.id]);
  assert.equal(before.hasMoreBefore, true);
  await expectHttpError(
    async () => service.getContextItems(sessionId, { afterId: first.id, tailLimit: 1 }),
    { statusCode: 400, code: "AGENT_CONTEXT_ITEMS_QUERY_INVALID" }
  );

  moveSessionHead(fixture.db, {
    workspaceId: workspace.id,
    sessionId,
    expectedHeadItemId: third.id,
    nextHeadItemId: first.id,
    updatedAt: createdAt + 4
  });
  await expectHttpError(
    async () => service.getContextItems(sessionId, { beforeId: third.id, limit: 1, expectedHeadItemId: third.id }),
    { statusCode: 409, code: "AGENT_CONTEXT_ITEMS_HEAD_MOVED" }
  );
  await expectHttpError(
    async () => service.getContextItem(sessionId, third.id),
    { statusCode: 404, message: "context item not found" }
  );
});

test("P0/P1 freezes revert validation and verifies runtime rejection keeps the committed success response", async () => {
  const fixture = await createAgentTestFixture({ withApp: true, agentWorkerConcurrency: 0 });
  fixtures.push(fixture);
  assert.ok(fixture.app);
  const workspace = await createTestWorkspace(fixture, { title: "P0 revert workspace" });
  const sessionId = createPrimarySession(fixture, workspace.id);
  const service = createAgentService(fixture.ctx, fixture.app.log);

  const user = appendContextItem(fixture.db, {
    workspaceId: workspace.id,
    sessionId,
    runId: null,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "first" },
    createdAt: Date.now()
  });
  const assistant = appendContextItem(fixture.db, {
    workspaceId: workspace.id,
    sessionId,
    runId: null,
    turnId: "turn-p0-revert",
    step: 1,
    prevId: user.id,
    kind: "assistant",
    status: "completed",
    output: { type: "assistant_text", text: "second" },
    createdAt: Date.now()
  });

  await expectHttpError(
    async () => service.revertSession({ sessionId, body: { workspaceId: workspace.id, itemId: 999_999, reason: "P0" }, runtime: createFakeAgentRuntime() }),
    { statusCode: 400, message: "itemId is invalid" }
  );

  fixture.db.prepare("update agent_context_item set archive_at = ? where id = ?").run(Date.now(), user.id);
  await expectHttpError(
    async () => service.revertSession({ sessionId, body: { workspaceId: workspace.id, itemId: user.id, reason: "P0" }, runtime: createFakeAgentRuntime() }),
    { statusCode: 400, code: "AGENT_ARCHIVED_ITEM_IMMUTABLE" }
  );
  fixture.db.prepare("update agent_context_item set archive_at = null where id = ?").run(user.id);

  const nonTerminal = appendContextItem(fixture.db, {
    workspaceId: workspace.id,
    sessionId,
    runId: null,
    turnId: "turn-p0-revert",
    step: 2,
    prevId: assistant.id,
    kind: "assistant",
    status: "streaming",
    output: { type: "assistant_text", text: "streaming" },
    createdAt: Date.now()
  });
  await expectHttpError(
    async () => service.revertSession({ sessionId, body: { workspaceId: workspace.id, itemId: assistant.id, reason: "P0" }, runtime: createFakeAgentRuntime() }),
    { statusCode: 409, code: "AGENT_REVERT_HAS_NON_TERMINAL_ITEMS" }
  );
  fixture.db.prepare("update agent_context_item set status = 'completed' where id = ?").run(nonTerminal.id);

  updateRunState(fixture.db, {
    workspaceId: workspace.id,
    sessionId,
    status: "running",
    activeRunId: "p0-running-run",
    activeAssistantItemId: null,
    runNoticeText: "",
    updatedAt: Date.now(),
    appliedItemId: assistant.id
  });
  await expectHttpError(
    async () => service.revertSession({ sessionId, body: { workspaceId: workspace.id, itemId: assistant.id, reason: "P0" }, runtime: createFakeAgentRuntime() }),
    { statusCode: 409, code: "AGENT_REVERT_NOT_IDLE" }
  );

  updateRunState(fixture.db, {
    workspaceId: workspace.id,
    sessionId,
    status: "idle",
    activeRunId: null,
    activeAssistantItemId: null,
    runNoticeText: "",
    updatedAt: Date.now(),
    appliedItemId: assistant.id
  });

  const route = Fastify({ logger: false });
  routeApps.push(route);
  const rejectingRuntime = createFakeAgentRuntime({ cancelSessionError: new Error("P0 future runtime rejection") });
  const eventHub = new AgentRunCompletedEventHub();
  await registerAgentRoutes(route, { service, runtime: rejectingRuntime, internalToken: fixture.internalToken, dataDir: fixture.ctx.dataDir, runCompletedEventHub: eventHub });
  await route.ready();

  const response = await route.inject({
    method: "POST",
    url: `/api/agent/sessions/${sessionId}/revert`,
    payload: { workspaceId: workspace.id, itemId: user.id, reason: "P0" }
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(rejectingRuntime.cancelSessionCalls, [sessionId]);
  assert.equal(getRunState(fixture.db, workspace.id, sessionId).status, "idle");
  assert.equal(
    getSessionTranscriptItems(fixture.db, workspace.id, sessionId).at(-1)?.id,
    user.id,
    "head has committed before the runtime rejection reaches the route"
  );
});

test("P0 runtime facts: local cancellation is synchronous queue removal and worker cancellation is covered as warning-only best effort", () => {
  const runtime = new AgentRuntime({
    getPromptContextForRun: async () => ({ workspaceId: "workspace", sessionId: "session", runId: "run", headItemId: null, system: "", messages: [] }),
    appendContextItemFromWorker: () => ({ ok: true, item: null }),
    updateContextItemFromWorker: async () => { throw new Error("not reached"); },
    updateRunStateFromWorker: () => undefined,
    completeRunFromWorker: () => undefined,
    getSession: () => null
  } as any, { error() {}, warn() {} } as any, 0);
  assert.doesNotThrow(() => runtime.cancelSession("session"));
});

test("P0 status-summary keeps application HttpError and bridges only unexpected errors", async () => {
  const fixture = await createAgentTestFixture({ withApp: true, agentWorkerConcurrency: 0 });
  fixtures.push(fixture);
  assert.ok(fixture.app);
  const route = Fastify({ logger: false });
  routeApps.push(route);
  const service = createAgentService(fixture.ctx, route.log);
  const runtime = createFakeAgentRuntime();
  const eventHub = new AgentRunCompletedEventHub();
  await registerAgentRoutes(route, { service, runtime, internalToken: fixture.internalToken, dataDir: fixture.ctx.dataDir, runCompletedEventHub: eventHub });
  await route.ready();

  Object.defineProperty(service, "getSessionStatusSummary", {
    value: () => { throw new Error("P0 unexpected status-summary failure"); },
    configurable: true
  });
  const unexpected = await route.inject({
    method: "POST",
    url: "/api/internal/agent/sessions/status-summary",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: { sessionId: "p0-session" }
  });
  assert.equal(unexpected.statusCode, 500, unexpected.body);
  assert.equal(unexpected.json().code, "SESSION_STATUS_SUMMARY_FAILED");

  Object.defineProperty(service, "getSessionStatusSummary", {
    value: () => { throw new HttpError(400, "P0 application error", "P0_APPLICATION_ERROR"); },
    configurable: true
  });
  const applicationError = await route.inject({
    method: "POST",
    url: "/api/internal/agent/sessions/status-summary",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: { sessionId: "p0-session" }
  });
  assert.equal(applicationError.statusCode, 400, applicationError.body);
  assert.equal(applicationError.json().code, "P0_APPLICATION_ERROR");
});

test("P4 architecture records route groups, composition and startup boundaries", async () => {
  const [serviceSource, compositionSource, sessionSource, contextQuerySource, peripheralQuerySource, routesSource, publicRoutesSource, workerRoutesSource, peripheralRoutesSource, statusSseRoutesSource, authSource, moduleSource, coordinatorSource, archiveStartupQuerySource, runtimeSource, workerClientSource] = await Promise.all([
    fs.readFile(new URL("./agent.service.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("./agent.composition.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("./session/session-interaction-application.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("./query/context-query-application.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("./query/peripheral-agent-query-application.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("./agent.routes.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("./routes/agent-public.routes.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("./routes/agent-worker.routes.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("./routes/agent-peripheral.routes.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("./routes/agent-status-sse.routes.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("./routes/agent-route-auth.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("./agent.module.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("./startup/agent-startup-coordinator.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("./archive/sqlite-archive-startup-session-query.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("./agent.runtime.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("./agent.worker-client.ts", import.meta.url), "utf8")
  ]);

  for (const method of ["listSessions", "createPrimarySession", "forkPrimarySession", "sendMessage", "getContextItems", "getRunState", "getSessionStatusSummary", "revertSession"]) {
    assert.match(serviceSource, new RegExp(`\\b${method}\\(`));
  }
  assert.match(serviceSource, /AgentServiceCapabilities/);
  assert.match(serviceSource, /this\.capabilities\./);
  assert.doesNotMatch(serviceSource, /agent\.store/);
  assert.doesNotMatch(serviceSource, /AppContext/);
  assert.doesNotMatch(serviceSource, /new (?:SessionInteractionApplication|ContextQueryApplication|RunLifecycleApplication)/);
  assert.match(compositionSource, /export function createAgentComposition/);
  assert.match(compositionSource, /function createAgentApplications/);
  assert.match(compositionSource, /function createArchiveCompactionAssembly/);
  assert.match(compositionSource, /function createLifecycleSessionSubtaskAssembly/);
  assert.match(compositionSource, /function createReadQueryWritebackAssembly/);
  assert.match(compositionSource, /function createSessionFacadeCapabilities/);
  assert.match(compositionSource, /function createQueryFacadeCapabilities/);
  assert.match(compositionSource, /function createLifecycleFacadeCapabilities/);
  assert.match(compositionSource, /function createWorkerFacadeCapabilities/);
  assert.match(compositionSource, /type AgentCompositionEnvironment/);
  assert.match(compositionSource, /function createAgentCompositionEnvironment/);
  assert.match(compositionSource, /function createLocalRuntimeExecutionPort/);
  assert.match(compositionSource, /function createArchiveStartupCoordinator/);
  const compositionRootSource = compositionSource.slice(compositionSource.indexOf("export function createAgentComposition"));
  assert.match(compositionSource, /function createCompositionTestReferences/);
  assert.match(compositionSource, /lifecycleActiveSubtaskChildQuery/);
  assert.match(compositionSource, /subtaskChildRunActivator/);
  assert.doesNotMatch(compositionSource, /(?:export )?class AgentApplicationComposition/);
  assert.doesNotMatch(compositionSource, /Pick<AgentApplicationComposition/);
  assert.doesNotMatch(compositionSource, /getRunLifecycleDependencies|getSubtaskDependencies/);
  assert.doesNotMatch(compositionSource, /function createFacadeCapabilities/);
  assert.doesNotMatch(compositionSource, /\btestProbe\b/);
  assert.doesNotMatch(compositionRootSource, /\bwiring\s*:/);
  assert.doesNotMatch(compositionRootSource, /return \{\s*capabilities,/);
  assert.doesNotMatch(compositionRootSource, /testProbe/);
  assert.match(compositionSource, /createLocalRuntimeExecutionPort/);
  assert.match(compositionSource, /createArchiveStartupCoordinator/);
  assert.match(compositionSource, /new AgentStartupCoordinator/);
  assert.match(compositionSource, /new SqliteArchiveStartupSessionQuery/);
  assert.match(sessionSource, /async revertSession\(command: RevertSessionCommand\)/);
  assert.match(sessionSource, /cancel session runtime after revert failed/);
  assert.doesNotMatch(contextQuerySource, /ContextWritebackApplication/);
  assert.doesNotMatch(contextQuerySource, /PeripheralAgentQueryApplication/);
  assert.doesNotMatch(peripheralQuerySource, /ContextQueryApplication/);
  assert.match(routesSource, /registerAgentPublicRoutes/);
  assert.match(routesSource, /registerAgentWorkerRoutes/);
  assert.match(routesSource, /registerAgentPeripheralRoutes/);
  assert.match(routesSource, /registerAgentStatusSseRoutes/);
  assert.doesNotMatch(routesSource, /app\.(get|post|route)\(/);
  assert.match(routesSource, /export async function registerAgentRoutes/);
  assert.doesNotMatch(routesSource, /params\.runtime\.cancelSession\(p\.sessionId\)/);
  assert.match(authSource, /internalToken/);
  assert.doesNotMatch(authSource, /getContext/);
  assert.doesNotMatch(publicRoutesSource, /runtime\.cancelSession/);
  assert.match(workerRoutesSource, /AgentApiEndpoints/);
  assert.match(peripheralRoutesSource, /dependencies\.service\.listAvailableAgents\(body\)/);
  assert.match(peripheralRoutesSource, /dependencies\.service\.listRecentSessions/);
  assert.match(peripheralRoutesSource, /dependencies\.service\.listRecentSessions\(req\.body as \{ limit\?: number; kind\?: "primary" \| "subtask" \| "all" \}\)/);
  assert.match(peripheralRoutesSource, /dependencies\.service\.listRecentWorkspaces\(req\.query as \{ limit\?: number \}\)/);
  assert.doesNotMatch(peripheralRoutesSource, /typeof body\.limit/);
  assert.doesNotMatch(peripheralRoutesSource, /body\.kind === "primary"/);
  assert.doesNotMatch(peripheralRoutesSource, /typeof query\.limit/);
  assert.match(peripheralRoutesSource, /dependencies\.service\.getRunFinalText/);
  assert.match(statusSseRoutesSource, /dependencies\.service\.getSessionStatusSummary/);
  assert.match(statusSseRoutesSource, /dependencies\.service\.getContextItems/);
  assert.match(statusSseRoutesSource, /SESSION_STATUS_SUMMARY_FAILED/);
  assert.match(statusSseRoutesSource, /PLUGIN_ID_MISMATCH/);
  assert.match(statusSseRoutesSource, /toSseEventChunk/);
  assert.match(statusSseRoutesSource, /runCompletedEventHub\.subscribe/);
  for (const source of [publicRoutesSource, workerRoutesSource, peripheralRoutesSource, statusSseRoutesSource]) {
    assert.doesNotMatch(source, /agent\.store/);
    assert.doesNotMatch(source, /AppContext/);
    assert.doesNotMatch(source, /node:fs/);
    assert.doesNotMatch(source, /node:path/);
    assert.doesNotMatch(source, /\.getContext\(\)/);
  }
  assert.doesNotMatch(serviceSource, /getContext\(/);
  assert.doesNotMatch(serviceSource, /reconcileArchivePendingForSessionBestEffort/);
  assert.doesNotMatch(serviceSource, /failRunOnEnqueueFailure/);
  assert.doesNotMatch(serviceSource, /cancelSessionCascade/);
  assert.doesNotMatch(serviceSource, /getContextItemById/);
  assert.doesNotMatch(serviceSource, /getLatestTerminalAssistantTextByRunId/);
  assert.doesNotMatch(serviceSource, /getLatestCompletedAssistantTextByRunId/);
  assert.match(moduleSource, /createAgentComposition/);
  assert.doesNotMatch(moduleSource, /agent\.store/);
  assert.doesNotMatch(moduleSource, /ArchiveStartupReconcileApplication/);
  assert.match(moduleSource, /startupCoordinator\.runPreListen\(\)/);
  assert.match(moduleSource, /startupCoordinator\.registerRecoverOnListen\(app, runtime\)/);
  assert.ok(moduleSource.indexOf("await registerAgentRoutes") < moduleSource.indexOf("startupCoordinator.runPreListen"));
  assert.ok(moduleSource.indexOf("startupCoordinator.runPreListen") < moduleSource.indexOf("workerManager.start"));
  assert.doesNotMatch(coordinatorSource, /agent\.store|Db|node:fs|node:path/);
  assert.match(coordinatorSource, /cleanupOrphans/);
  assert.match(coordinatorSource, /reconcileArchive/);
  assert.match(coordinatorSource, /registerRecoverOnListen/);
  assert.match(archiveStartupQuerySource, /listAgentSessionsForArchiveReconcile/);
  assert.ok(moduleSource.indexOf("await pluginHostManager.start()") < moduleSource.indexOf("await registerAgentRoutes"));
  assert.match(moduleSource, /pluginHostManager\?\.stop\(\)/);
  assert.match(moduleSource, /workerManager\?\.stop\(\)/);
  assert.match(runtimeSource, /cancelSession\(sessionId: string\)\s*\{/);
  assert.match(workerClientSource, /async cancelSession\(sessionId: string\)/);
  assert.match(workerClientSource, /cancel session in worker failed/);
});
