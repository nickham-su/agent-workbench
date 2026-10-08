import assert from "node:assert/strict";
import test from "node:test";
import { AgentRunner } from "./runner.js";

test("shouldAutoCompact uses the active model context window", () => {
  const runner = new AgentRunner({} as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  const shouldAutoCompact = (runner as any).shouldAutoCompact.bind(runner) as (input: {
    context: { lastResponseTotalTokens: number | null };
    model: { contextWindowTokens: number };
    runtime: { autoCompactThresholdPct: number };
  }) => boolean;

  assert.equal(shouldAutoCompact({
    context: { lastResponseTotalTokens: 80_000 },
    model: { contextWindowTokens: 100_000 },
    runtime: { autoCompactThresholdPct: 80 },
  }), true);
  assert.equal(shouldAutoCompact({
    context: { lastResponseTotalTokens: 79_999 },
    model: { contextWindowTokens: 100_000 },
    runtime: { autoCompactThresholdPct: 80 },
  }), false);
  assert.equal(shouldAutoCompact({
    context: { lastResponseTotalTokens: null },
    model: { contextWindowTokens: 100_000 },
    runtime: { autoCompactThresholdPct: 80 },
  }), false);
});

test("Runner no longer exposes the legacy messages-context compaction path", () => {
  const runner = new AgentRunner({} as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  assert.equal(typeof (runner as any).generateCompactionSummary, "undefined");
  assert.equal(typeof (runner as any).compactContext, "undefined");
});
