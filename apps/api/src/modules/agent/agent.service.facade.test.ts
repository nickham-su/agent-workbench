import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AgentMessage,
  AgentMessageSessionRunState,
  AgentMessageTimelineSnapshot,
  AgentSessionMessageState,
  AgentTimelineDeltaResponse
} from "@agent-workbench/shared";
import type { AgentServiceCapabilities } from "./agent.composition.js";
import { AgentService } from "./agent.service.js";

type ReadSideApplicationFacade = {
  getExecutionProfileForRun: (params: { workspaceId: string; sessionId: string; runId: string }) => unknown;
  getMessagesContext: (params: { workspaceId: string; sessionId: string; appendMessage?: { role: "system" | "user"; content: string } }) => Promise<unknown>;
  getPromptContextForRun: (params: { workspaceId: string; sessionId: string; runId: string }) => Promise<unknown>;
};

type WritebackApplicationFacade = {
  createStreamingAssistantFromWorker: AgentService["createStreamingAssistantFromWorker"];
  flushAssistantPartsFromWorker: AgentService["flushAssistantPartsFromWorker"];
  completeAssistantFromWorker?: AgentService["completeAssistantFromWorker"];
  updateToolExecutionFromWorker?: AgentService["updateToolExecutionFromWorker"];
  updateRunNoticeFromWorker?: AgentService["updateRunNoticeFromWorker"];
};

type SessionInteractionApplicationFacade = {
  listSessions: AgentService["listSessions"];
  createPrimarySession: AgentService["createPrimarySession"];
  forkPrimarySession: AgentService["forkPrimarySession"];
  sendMessage: AgentService["sendMessage"];
  revertSession: AgentService["revertSession"];
};

type MessageQueryFacade = {
  getMessageTimeline: AgentService["getMessageTimeline"];
  getMessageDetail: AgentService["getMessageDetail"];
  getMessageTimelineSnapshot: AgentService["getMessageTimelineSnapshot"];
  getMessageRunState: AgentService["getMessageRunState"];
  getApplyPatchUiArtifact: AgentService["getApplyPatchUiArtifact"];
  getWriteUiArtifact: AgentService["getWriteUiArtifact"];
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
  messageQuery?: MessageQueryFacade;
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
  const fork = { fromSessionId: "session", fromMessageId: "message-1" };
  const send = { sessionId: "session", body: { workspaceId: "workspace", text: "text", clientRequestId: "request" }, runtime: {} as any };
  const revert = { sessionId: "session", body: { workspaceId: "workspace", messageId: "message-1" }, runtime: {} as any };

  assert.deepEqual(service.listSessions("workspace"), [{ id: "session" }]);
  assert.deepEqual(service.createPrimarySession(create), { id: "created" });
  assert.deepEqual(await service.forkPrimarySession(fork), { id: "forked" });
  assert.deepEqual(await service.sendMessage(send), { runId: "run" });
  assert.deepEqual(await service.revertSession(revert), { ok: true });
  assert.deepEqual(calls, [["list", "workspace"], ["create", create], ["fork", fork], ["send", send], ["revert", revert]]);
});

test("AgentService Message Query facades delegate without local rules", async () => {
  const calls: unknown[][] = [];
  const session: AgentSessionMessageState = {
    id: "session", workspaceId: "workspace", title: "Session", kind: "primary",
    headMessageId: "message", contextRootMessageId: "message", revision: 3,
    forkedFromSessionId: null, forkedFromMessageId: null, createdAt: 1, updatedAt: 1
  };
  const message: AgentMessage = {
    id: "message", workspaceId: "workspace", previousMessageId: null, replacesMessageId: null,
    depth: 0, type: "user", status: "completed", originSessionId: "session", originRunId: null,
    updatedRevision: 3, createdAt: 1, updatedAt: 1, parts: []
  };
  const timelineResponse: AgentTimelineDeltaResponse & { hasMore: boolean; nextBeforeMessageId: string | null } = {
    session, timelineReset: false, messages: [], toolExecutions: [], hasMore: false, nextBeforeMessageId: null
  };
  const runState: AgentMessageSessionRunState = {
    workspaceId: "workspace", sessionId: "session", status: "idle", activeRunId: null,
    runNoticeText: "", retryCount: 0, nextRetryAt: null, activeAssistantMessageId: null,
    nonTerminalMessageIds: [], nonTerminalToolExecutionIds: [], updatedAt: 1
  };
  const snapshotResponse: AgentMessageTimelineSnapshot & { hasMore: boolean; nextBeforeMessageId: string | null } = { ...timelineResponse, runState };
  const application: MessageQueryFacade = {
    getMessageTimeline(params) {
      calls.push(["timeline", params]);
      return timelineResponse;
    },
    getMessageDetail(params) {
      calls.push(["message", params]);
      return message;
    },
    getMessageTimelineSnapshot(params) {
      calls.push(["snapshot", params]);
      return snapshotResponse;
    },
    getMessageRunState(params) {
      calls.push(["state", params]);
      return runState;
    },
    async getApplyPatchUiArtifact(params) { calls.push(["apply", params]); return { kind: "apply" }; },
    async getWriteUiArtifact(params) { calls.push(["write", params]); return { kind: "write" }; }
  };
  const service = createFacadeService({ messageQuery: application });
  const timeline = { workspaceId: "workspace", sessionId: "session", sinceRevision: 3 };
  const detail = { workspaceId: "workspace", sessionId: "session", messageId: "message" };
  const artifact = { workspaceId: "workspace", sessionId: "session", toolExecutionId: "execution" };
  assert.strictEqual(service.getMessageTimeline(timeline), timelineResponse);
  assert.strictEqual(service.getMessageDetail(detail), message);
  assert.strictEqual(service.getMessageTimelineSnapshot(timeline), snapshotResponse);
  assert.strictEqual(service.getMessageRunState({ workspaceId: "workspace", sessionId: "session" }), runState);
  assert.deepEqual(await service.getApplyPatchUiArtifact(artifact), { kind: "apply" });
  assert.deepEqual(await service.getWriteUiArtifact(artifact), { kind: "write" });
  assert.deepEqual(calls, [
    ["timeline", timeline], ["message", detail], ["snapshot", timeline],
    ["state", { workspaceId: "workspace", sessionId: "session" }], ["apply", artifact], ["write", artifact]
  ]);
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
  const appendResponse = { append: "response" } as unknown as ReturnType<AgentService["createStreamingAssistantFromWorker"]>;
  const updateResponse = { update: "response" } as unknown as Awaited<ReturnType<AgentService["flushAssistantPartsFromWorker"]>>;
  const service = createFacadeService({ writebackApplication: {
    createStreamingAssistantFromWorker(params) {
      calls.push(["append", params]);
      return appendResponse;
    },
    flushAssistantPartsFromWorker(params) {
      calls.push(["update", params]);
      return updateResponse;
    }
  } });
  const appendParams = { workspaceId: "workspace", sessionId: "session", runId: "run", messageId: "message", createdAt: 1 };
  const updateParams = { workspaceId: "workspace", sessionId: "session", runId: "run", messageId: "message", parts: [], updatedAt: 1 };

  assert.strictEqual(service.createStreamingAssistantFromWorker(appendParams), appendResponse);
  assert.strictEqual(await service.flushAssistantPartsFromWorker(updateParams), updateResponse);
  assert.deepEqual(calls, [["append", appendParams], ["update", updateParams]]);
});

test("AgentService writeback facades preserve application errors", async () => {
  const appendError = new Error("append failure");
  const updateError = new Error("update failure");
  const service = createFacadeService({ writebackApplication: {
    createStreamingAssistantFromWorker() {
      throw appendError;
    },
    flushAssistantPartsFromWorker() {
      throw updateError;
    }
  } });

  assert.throws(
    () => service.createStreamingAssistantFromWorker({} as Parameters<AgentService["createStreamingAssistantFromWorker"]>[0]),
    (error: unknown) => error === appendError
  );
  assert.throws(
    () => service.flushAssistantPartsFromWorker({} as Parameters<AgentService["flushAssistantPartsFromWorker"]>[0]),
    (error: unknown) => error === updateError
  );
});
