import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentService } from "./agent.service.js";

type ReadSideApplicationFacade = {
  getExecutionProfileForRun: (params: { workspaceId: string; sessionId: string; runId: string }) => unknown;
  getMessagesContext: (params: { workspaceId: string; sessionId: string; appendMessage?: { role: "system" | "user"; content: string } }) => Promise<unknown>;
  getPromptContextForRun: (params: { workspaceId: string; sessionId: string; runId: string }) => Promise<unknown>;
};

function createFacadeService(readSideApplication: ReadSideApplicationFacade) {
  const service = Object.create(AgentService.prototype) as AgentService;
  Object.defineProperty(service, "readSideApplication", { value: readSideApplication });
  return service;
}

test("AgentService read-side facades delegate params and return values without local rules", async () => {
  const calls: unknown[][] = [];
  const profileResponse = { resolved: { runId: "run-profile" } };
  const messagesResponse = { messages: [{ role: "user", content: "message" }] };
  const promptResponse = { system: "system", messages: [] };
  const service = createFacadeService({
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
  });
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
  const service = createFacadeService({
    getExecutionProfileForRun() {
      throw profileError;
    },
    async getMessagesContext() {
      throw messagesError;
    },
    async getPromptContextForRun() {
      throw promptError;
    }
  });

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
