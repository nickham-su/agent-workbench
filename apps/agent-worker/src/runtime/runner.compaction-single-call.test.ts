import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { AgentRunner } from "./runner.js";

for (const providerNpm of ["@ai-sdk/moonshotai", "@ai-sdk/deepseek"] as const) {
  test(`${providerNpm} compaction summary delegates custom ID and fixed thinking to shared single-call`, async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const delta of [{ content: "summary" }, {}]) {
        res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1,
          model: "summary-alias", choices: [{ index: 0, delta, finish_reason: delta.content ? null : "stop" }] })}\n\n`);
      }
      res.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve, reject) => { server.listen(0, "127.0.0.1", resolve); server.once("error", reject); });
    try {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const runner = new AgentRunner({} as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
      const result = await (runner as any).generateSingleCallSummary({
        profile: { provider: { id: "provider", npm: providerNpm,
          options: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: "fixture" } },
          model: { id: "local-summary", providerModelId: "summary-alias", options: {
            providerOptionsByKey: { [providerNpm === "@ai-sdk/moonshotai" ? "moonshotai" : "deepseek"]:
              { thinking: { type: "disabled" }, reasoningEffort: "low" } },
          } } },
        input: { messages: [{ role: "user", content: "summarize" }], timeoutMs: 5_000,
          abortSignal: new AbortController().signal },
      });
      assert.equal(result.text, "summary");
      assert.equal(bodies.length, 1);
      assert.equal(bodies[0]?.model, "summary-alias");
      assert.deepEqual(bodies[0]?.thinking, { type: "enabled" });
      assert.doesNotMatch(JSON.stringify(bodies[0]), /disabled|reasoningEffort/);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  });
}
