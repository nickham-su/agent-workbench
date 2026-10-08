import assert from "node:assert/strict";
import test from "node:test";
import { APICallError, UnsupportedFunctionalityError } from "ai";
import { isAgentTerminalCodeAllowed } from "@agent-workbench/shared";
import { AgentRunner } from "./runner.js";

const secret = "fixture-secret-must-not-appear";
const profile = (npm: string) => ({
  model: { id: "local-model", providerModelId: "custom-model" },
  provider: { id: "config", npm, options: {} },
  agent: { tools: [], pluginTools: [], mcpServers: [] },
  runtime: { modelIdleTimeoutMs: 0, modelTotalTimeoutMs: 0, modelRequestMaxRetries: 0, modelRequestRetryBackoffMaxMs: 1 },
});
const run = { workspaceId: "ws", sessionId: "session", runId: "run", workspacePath: process.cwd(),
  workspaceRepoDirNames: [], inputText: "hello", runKind: "user" as const };
const context = { pendingTools: [], tools: [], headMessageId: null, sessionRevision: 0, system: "",
  messages: [], providerReplay: [], lastResponseTotalTokens: null, uiLocale: null, externalSkills: [] };

function providerHttpError(statusCode: number) {
  return new APICallError({ statusCode, message: secret, url: `https://${secret}.invalid/v1`,
    requestBodyValues: { apiKey: secret, messages: [secret] }, responseBody: secret,
    data: { error: { code: secret, message: secret } } });
}

async function persistFailure(providerNpm: string, error: unknown, stage: "model" | "profile" = "model") {
  const intents: Array<{ status: string; code: string; detail: unknown }> = [];
  const api = {
    async markRunWorkInProgress() { return { result: "updated" }; },
    async getExecutionProfile() {
      if (stage === "profile") throw error;
      return profile(providerNpm);
    },
    async getPromptContext() { return context; },
    async persistRunTerminalIntent(input: { status: string; code: string; detail: unknown }) {
      intents.push({ status: input.status, code: input.code, detail: input.detail });
      return { result: "updated" };
    },
    async convergeRunTerminal() { return { kind: "transitioned", finalStatus: "failed" }; },
  };
  const runner = new AgentRunner(api as any, { async listTools() { return []; } } as any,
    { info() {}, warn() {}, error() {} }, 1);
  if (stage === "model") (runner as any).runModelStep = async () => { throw error; };
  await (runner as any).processRun(run, new AbortController().signal);
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.status, "failed");
  assert.equal(intents[0]?.detail, null);
  assert.ok(isAgentTerminalCodeAllowed("user", "failed", intents[0]!.code as any));
  assert.doesNotMatch(JSON.stringify(intents), /fixture-secret-must-not-appear/);
  return intents[0]!.code;
}

for (const npm of ["@ai-sdk/moonshotai", "@ai-sdk/deepseek"]) {
  test(`${npm} writes only allowlisted provider error terminal codes`, async () => {
    for (const [status, code] of [[400, "run_provider_bad_request"], [401, "run_provider_unauthorized"],
      [404, "run_provider_not_found"]] as const) {
      assert.equal(await persistFailure(npm, providerHttpError(status)), code);
    }
    assert.equal(await persistFailure(npm,
      new UnsupportedFunctionalityError({ functionality: secret, message: secret })), "run_provider_unsupported");
  });
}

test("unknown errors, forged statuses, non-allowlisted HTTP statuses and non-model errors keep generic fallback", async () => {
  assert.equal(await persistFailure("@ai-sdk/deepseek", new Error(secret)), "run_failed");
  assert.equal(await persistFailure("@ai-sdk/moonshotai", Object.assign(new Error(secret), { statusCode: 401 })), "run_failed");
  assert.equal(await persistFailure("@ai-sdk/deepseek", providerHttpError(403)), "run_failed");
  assert.equal(await persistFailure("@ai-sdk/deepseek", providerHttpError(401), "profile"), "run_failed");
  assert.equal(await persistFailure("@ai-sdk/openai", providerHttpError(401)), "run_failed");
});
