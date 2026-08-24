import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentServiceCapabilities } from "./agent.composition.js";
import { AgentService } from "./agent.service.js";

type ReadSideApplicationFacade = {
  getExecutionProfileForRun: (params: { workspaceId: string; sessionId: string; runId: string }) => unknown;
  getMessagesContext: (params: { workspaceId: string; sessionId: string; appendMessage?: { role: "system" | "user"; content: string } }) => Promise<unknown>;
  getPromptContextForRun: (params: { workspaceId: string; sessionId: string; runId: string }) => Promise<unknown>;
};

type WritebackApplicationFacade = {
  appendContextItemFromWorker: AgentService["appendContextItemFromWorker"];
  updateContextItemFromWorker: AgentService["updateContextItemFromWorker"];
};

type SessionInteractionApplicationFacade = {
  listSessions: AgentService["listSessions"];
  createPrimarySession: AgentService["createPrimarySession"];
  forkPrimarySession: AgentService["forkPrimarySession"];
  sendMessage: AgentService["sendMessage"];
  revertSession: AgentService["revertSession"];
};

type ContextQueryApplicationFacade = {
  getContextItems: AgentService["getContextItems"];
  getContextItem: AgentService["getContextItem"];
  getApplyPatchUiArtifact: AgentService["getApplyPatchUiArtifact"];
  getWriteUiArtifact: AgentService["getWriteUiArtifact"];
  getRunState: AgentService["getRunState"];
  getSessionStatusSummary: AgentService["getSessionStatusSummary"];
};

type PeripheralAgentQueryApplicationFacade = {
  listRecentSessions: AgentService["listRecentSessions"];
  listRecentWorkspaces: AgentService["listRecentWorkspaces"];
  getRunFinalText: AgentService["getRunFinalText"];
  listAvailableAgents: AgentService["listAvailableAgents"];
};

function createFacadeService(params: {
  readSideApplication?: ReadSideApplicationFacade;
  writebackApplication?: WritebackApplicationFacade;
  sessionInteractionApplication?: SessionInteractionApplicationFacade;
  contextQueryApplication?: ContextQueryApplicationFacade;
  peripheralAgentQueryApplication?: PeripheralAgentQueryApplicationFacade;
}) {
  const applications = Object.values(params) as Array<Record<string, unknown> | undefined>;
  const capabilityGroup = new Proxy({}, {
    get(_target, method) {
      for (const application of applications) {
        const capability = application?.[String(method)];
        if (typeof capability === "function") return capability;
      }
      throw new Error(`unexpected capability: ${String(method)}`);
    }
  });
  const capabilities = new Proxy({}, {
    get(_target, group) {
      if (["session", "query", "lifecycle", "worker"].includes(String(group))) return capabilityGroup;
      throw new Error(`unexpected capability group: ${String(group)}`);
    }
  }) as AgentServiceCapabilities;
  return new AgentService(capabilities);
}

test("AgentService read-side facades delegate params and return values without local rules", async () => {
  const calls: unknown[][] = [];
  const profileResponse = { resolved: { runId: "run-profile" } };
  const messagesResponse = { messages: [{ role: "user", content: "message" }] };
  const promptResponse = { system: "system", messages: [] };
  const service = createFacadeService({ readSideApplication: {
    getExecutionProfileForRun(params) {
      calls.push(["profile", params]);
      return profileResponse;
    },
    async getMessagesContext(params) {
      calls.push(["messages", params]);
      return messagesResponse;
    },
    async getPromptContextForRun(params) {
      calls.push(["prompt", params]);
      return promptResponse;
    }
  } });
  const profileParams = { workspaceId: "workspace-profile", sessionId: "session-profile", runId: "run-profile" };
  const messagesParams = { workspaceId: "workspace-messages", sessionId: "session-messages", appendMessage: { role: "user" as const, content: "one-shot" } };
  const promptParams = { workspaceId: "workspace-prompt", sessionId: "session-prompt", runId: "run-prompt" };

  assert.strictEqual(service.getExecutionProfileForRun(profileParams), profileResponse);
  assert.strictEqual(await service.getMessagesContext(messagesParams), messagesResponse);
  assert.strictEqual(await service.getPromptContextForRun(promptParams), promptResponse);
  assert.deepEqual(calls, [
    ["profile", profileParams],
    ["messages", messagesParams],
    ["prompt", promptParams]
  ]);
});

test("AgentService read-side facades preserve application errors", async () => {
  const profileError = new Error("profile failure");
  const messagesError = new Error("messages failure");
  const promptError = new Error("prompt failure");
  const service = createFacadeService({ readSideApplication: {
    getExecutionProfileForRun() {
      throw profileError;
    },
    async getMessagesContext() {
      throw messagesError;
    },
    async getPromptContextForRun() {
      throw promptError;
    }
  } });

  assert.throws(
    () => service.getExecutionProfileForRun({ workspaceId: "workspace", sessionId: "session", runId: "run" }),
    (error: unknown) => error === profileError
  );
  await assert.rejects(
    () => service.getMessagesContext({ workspaceId: "workspace", sessionId: "session" }),
    (error: unknown) => error === messagesError
  );
  await assert.rejects(
    () => service.getPromptContextForRun({ workspaceId: "workspace", sessionId: "session", runId: "run" }),
    (error: unknown) => error === promptError
  );
});

test("AgentService Session facades delegate without local rules", async () => {
  const calls: unknown[][] = [];
  const application: SessionInteractionApplicationFacade = {
    listSessions(workspaceId) { calls.push(["list", workspaceId]); return [{ id: "session" }] as any; },
    createPrimarySession(params) { calls.push(["create", params]); return { id: "created" } as any; },
    async forkPrimarySession(params) { calls.push(["fork", params]); return { id: "forked" } as any; },
    async sendMessage(params) { calls.push(["send", params]); return { runId: "run" } as any; },
    async revertSession(params) { calls.push(["revert", params]); return { ok: true } as any; }
  };
  const service = createFacadeService({ sessionInteractionApplication: application });
  const create = { workspaceId: "workspace", title: "title" };
  const fork = { fromSessionId: "session", fromItemId: 1, mode: "visible_only" as const };
  const send = { sessionId: "session", body: { workspaceId: "workspace", text: "text", clientRequestId: "request" }, runtime: {} as any };
  const revert = { sessionId: "session", body: { workspaceId: "workspace", itemId: 1 }, runtime: {} as any };

  assert.deepEqual(service.listSessions("workspace"), [{ id: "session" }]);
  assert.deepEqual(service.createPrimarySession(create), { id: "created" });
  assert.deepEqual(await service.forkPrimarySession(fork), { id: "forked" });
  assert.deepEqual(await service.sendMessage(send), { runId: "run" });
  assert.deepEqual(await service.revertSession(revert), { ok: true });
  assert.deepEqual(calls, [["list", "workspace"], ["create", create], ["fork", fork], ["send", send], ["revert", revert]]);
});

test("AgentService Context Query facades delegate without local rules", async () => {
  const calls: unknown[][] = [];
  const application: ContextQueryApplicationFacade = {
    getContextItems(sessionId, query) { calls.push(["items", sessionId, query]); return { items: [] } as any; },
    getContextItem(sessionId, itemId) { calls.push(["item", sessionId, itemId]); return { id: itemId } as any; },
    async getApplyPatchUiArtifact(params) { calls.push(["apply", params]); return { kind: "apply" }; },
    async getWriteUiArtifact(params) { calls.push(["write", params]); return { kind: "write" }; },
    getRunState(sessionId) { calls.push(["state", sessionId]); return { sessionId } as any; },
    getSessionStatusSummary(params) { calls.push(["summary", params]); return { session: {} } as any; }
  };
  const service = createFacadeService({ contextQueryApplication: application });
  const query = { tailLimit: 3 };
  const artifact = { sessionId: "session", itemId: 1 };
  const summary = { sessionId: "session", selectedAgentId: "agent" };
  assert.deepEqual(service.getContextItems("session", query), { items: [] });
  assert.deepEqual(service.getContextItem("session", 1), { id: 1 });
  assert.deepEqual(await service.getApplyPatchUiArtifact(artifact), { kind: "apply" });
  assert.deepEqual(await service.getWriteUiArtifact(artifact), { kind: "write" });
  assert.deepEqual(service.getRunState("session"), { sessionId: "session" });
  assert.deepEqual(service.getSessionStatusSummary(summary), { session: {} });
  assert.deepEqual(calls, [["items", "session", query], ["item", "session", 1], ["apply", artifact], ["write", artifact], ["state", "session"], ["summary", summary]]);
});

test("AgentService Peripheral Agent Query facades delegate without local rules", () => {
  const calls: unknown[][] = [];
  const application: PeripheralAgentQueryApplicationFacade = {
    listRecentSessions(params) { calls.push(["sessions", params]); return { items: [] } as any; },
    listRecentWorkspaces(params) { calls.push(["workspaces", params]); return { items: [] } as any; },
    getRunFinalText(params) { calls.push(["final", params]); return { found: false, text: "" }; },
    listAvailableAgents(params) { calls.push(["agents", params]); return { agents: [] } as any; }
  };
  const service = createFacadeService({ peripheralAgentQueryApplication: application });
  const sessions = { limit: 2, kind: "primary" as const };
  const workspaces = { limit: 3 };
  const final = { runId: "run" };
  const agents = { workspaceId: "workspace", surface: "user" };
  assert.deepEqual(service.listRecentSessions(sessions), { items: [] });
  assert.deepEqual(service.listRecentWorkspaces(workspaces), { items: [] });
  assert.deepEqual(service.getRunFinalText(final), { found: false, text: "" });
  assert.deepEqual(service.listAvailableAgents(agents), { agents: [] });
  assert.deepEqual(calls, [["sessions", sessions], ["workspaces", workspaces], ["final", final], ["agents", agents]]);
});

test("AgentService writeback facades delegate params and return values without local rules", async () => {
  const calls: unknown[][] = [];
  const appendResponse = { append: "response" } as unknown as ReturnType<AgentService["appendContextItemFromWorker"]>;
  const updateResponse = { update: "response" } as unknown as Awaited<ReturnType<AgentService["updateContextItemFromWorker"]>>;
  const service = createFacadeService({ writebackApplication: {
    appendContextItemFromWorker(params) {
      calls.push(["append", params]);
      return appendResponse;
    },
    async updateContextItemFromWorker(params) {
      calls.push(["update", params]);
      return updateResponse;
    }
  } });
  const appendParams = { workspaceId: "workspace-append" } as Parameters<AgentService["appendContextItemFromWorker"]>[0];
  const updateParams = { itemId: 7 } as Parameters<AgentService["updateContextItemFromWorker"]>[0];

  assert.strictEqual(service.appendContextItemFromWorker(appendParams), appendResponse);
  assert.strictEqual(await service.updateContextItemFromWorker(updateParams), updateResponse);
  assert.deepEqual(calls, [["append", appendParams], ["update", updateParams]]);
});

test("AgentService writeback facades preserve application errors", async () => {
  const appendError = new Error("append failure");
  const updateError = new Error("update failure");
  const service = createFacadeService({ writebackApplication: {
    appendContextItemFromWorker() {
      throw appendError;
    },
    async updateContextItemFromWorker() {
      throw updateError;
    }
  } });

  assert.throws(
    () => service.appendContextItemFromWorker({} as Parameters<AgentService["appendContextItemFromWorker"]>[0]),
    (error: unknown) => error === appendError
  );
  await assert.rejects(
    () => service.updateContextItemFromWorker({} as Parameters<AgentService["updateContextItemFromWorker"]>[0]),
    (error: unknown) => error === updateError
  );
});
