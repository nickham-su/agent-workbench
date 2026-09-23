import assert from "node:assert/strict";
import test from "node:test";
import { AgentRunner } from "./runner.js";

const neverSettlingUsage = new Promise<never>(() => undefined);

test("runner completes a terminal provider attempt when fullStream usage never settles", async () => {
  const modelSignals: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  const apiClient = {
    async createStreamingAssistant() { return { result: "created" }; },
    async flushAssistantParts() { return { result: "updated" }; },
    async completeTerminalAssistant() { return { result: "updated" }; },
    async updateRunNotice() { return { result: "updated" }; },
    async replaceStreamingAssistant() { return { result: "updated" }; },
    async getPluginRuntimeSnapshots() { return { plugins: [] }; },
  };
  const runner = new AgentRunner(apiClient as any, { async listTools() { return []; } } as any, { info() {}, warn() {}, error() {} }, 1, {
    analyticsSignals: { emitModel(payload: Record<string, unknown>, eventType: string) { modelSignals.push({ eventType, payload }); } } as any,
    streamText: (() => ({
      usage: neverSettlingUsage,
      totalUsage: neverSettlingUsage,
      response: neverSettlingUsage,
      fullStream: (async function* () {
        yield { type: "text-delta", id: "part-1", text: "completed" };
        yield { type: "finish", totalUsage: null };
        yield { type: "raw", rawValue: { type: "response.completed", response: { output: [] } } };
      })(),
    })) as any,
  });

  const result = await Promise.race([
    (runner as any).runModelStep({
      profile: {
        model: { id: "gpt-4o-mini", options: undefined },
        provider: { id: "provider", npm: "@ai-sdk/openai", options: {} },
        agent: { tools: [], pluginTools: [], mcpServers: [] },
        runtime: { modelIdleTimeoutMs: 0, modelTotalTimeoutMs: 0, modelRequestMaxRetries: 1, modelRequestRetryBackoffMaxMs: 1 },
      },
      run: { workspaceId: "ws", sessionId: "session", runId: "run", workspacePath: process.cwd(), workspaceRepoDirNames: [], inputText: "hello" },
      context: { pendingTools: [], tools: [], headMessageId: null, sessionRevision: 0, system: "", messages: [], lastResponseTotalTokens: null, uiLocale: null, externalSkillRoots: [] },
      step: 1,
      signal: new AbortController().signal,
      recoveryContinuation: { messageId: null },
      repeatedToolCallCounter: new Map(),
    }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("runModelStep was blocked by optional usage")), 750)),
  ]);

  assert.equal(result.aborted, false);
  assert.equal(result.hasVisibleText, true);
  const finished = modelSignals.find((signal) => signal.eventType === "model_finished");
  assert.ok(finished);
  assert.equal(finished.payload.totalSource, "unavailable");
  assert.equal(finished.payload.totalTokens, null);
  assert.equal(finished.payload.inputTokens, null);
  assert.equal(finished.payload.outputTokens, null);
});
