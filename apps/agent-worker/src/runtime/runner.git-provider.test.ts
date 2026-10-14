import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { streamText } from "ai";
import { GitToolInputSchema } from "@agent-workbench/shared/internal-contracts/agent-api";
import { AgentRunner } from "./runner.js";
import type { ExecutionProfile } from "./apiClient.js";

for (const npm of ["@ai-sdk/openai", "@ai-sdk/openai-compatible", "@ai-sdk/anthropic", "@ai-sdk/deepseek", "@ai-sdk/moonshotai"]) {
  test(`AC-CONTEXT-PROVIDER: production Runner and ${npm} SDK serialize fresh Git description with string repo`, async () => {
    const requests: Array<Record<string, any>> = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      // A controlled rejection is intentional. This verifies the actual SDK
      // request boundary without claiming model inference/provider availability.
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { type: "invalid_request_error", message: "fixture request captured" } }));
    });
    await new Promise<void>((resolve, reject) => { server.listen(0, "127.0.0.1", resolve); server.once("error", reject); });
    try {
      const address = server.address(); assert(address && typeof address !== "string");
      const profile = { model: { id: "fixture-model", providerModelId: npm === "@ai-sdk/anthropic" ? "claude-sonnet-4-20250514" : "fixture-model", options: {} }, provider: { id: "fixture", npm, options: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: "fixture-only" } }, agent: { tools: ["git"], pluginTools: [], mcpServers: [] }, runtime: { modelIdleTimeoutMs: 2000, modelTotalTimeoutMs: 5000, modelRequestMaxRetries: 0, modelRequestRetryBackoffMaxMs: 1 } } as unknown as ExecutionProfile;
      const api = {
        async createStreamingAssistant() { return { result: "created" }; },
        async flushAssistantParts() { return { result: "updated" }; },
        async completeAssistant() { return { result: "updated" }; },
        async completeTerminalAssistant() { return { result: "updated" }; },
        async replaceStreamingAssistant() { return { result: "updated" }; },
        async discardStreamingAssistant() { return { result: "updated" }; },
        async updateRunNotice() { return { result: "updated" }; },
        async getPluginRuntimeSnapshots() { return { plugins: [] }; },
      };
      const runner = new AgentRunner(api as any, { async listTools() { return []; } } as any, { info() {}, warn() {}, error() {} }, 1, { streamText: (request: any) => streamText({ ...request, onError() {} }) });
      const staticTools = [{ name: "git", description: "Native Git fixture", inputSchema: GitToolInputSchema }];
      for (const repo of ["first-repo", 'second-"repo']) {
        try {
          await (runner as any).runModelStep({ profile, run: { workspaceId: "fixture-workspace", sessionId: "fixture-session", runId: "same-run", workspacePath: process.cwd(), workspaceRepoDirNames: ["stale-snapshot"], inputText: "fixture" }, context: { pendingTools: [], providerReplay: [], tools: staticTools, workspaceRepoNames: [repo], headMessageId: null, sessionRevision: 0, system: "", messages: [{ role: "user", content: "fixture" }], lastResponseTotalTokens: null, uiLocale: null, externalSkills: [] }, step: 1, signal: new AbortController().signal, recoveryContinuation: { messageId: null }, repeatedToolCallCounter: new Map() });
        } catch (error) { if (!requests.length) throw error; /* Controlled HTTP rejection after capture. */ }
      }
      assert.equal(requests.length, 2, "zero SDK/model retries; both description snapshots reach wire");
      requests.forEach((request, index) => {
        const raw = request.tools?.find((item: any) => item.name === "git" || item.function?.name === "git");
        const definition = raw?.function ?? raw;
        assert(definition);
        const schema = definition.parameters ?? definition.input_schema;
        assert.equal(schema.properties.repo.type, "string"); assert.equal(schema.properties.repo.enum, undefined);
        assert(definition.description.includes(JSON.stringify(index === 0 ? "first-repo" : 'second-"repo')));
        if (index === 1) assert(!definition.description.includes('"first-repo"'));
        assert(!definition.description.includes("stale-snapshot"));
      });
      assert.equal(staticTools[0]!.description, "Native Git fixture");
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });
}
