import assert from "node:assert/strict";
import test from "node:test";
import { createDashboardChartDisplay, knownStackTotal, splitLineSegments } from "./dashboard-chart-renderer";

test("display-only chart renderer preserves legal Ratio buckets and splits null coverage", () => {
  const display = createDashboardChartDisplay("ratio", [
    { from: 10, to: 20, ratio: .3 },
    { from: 20, to: 30, ratio: null },
    { from: 30, to: 40, ratio: .7 },
  ]);
  assert.equal(display.shape, "line");
  assert.deepEqual(display.buckets.map((bucket) => [bucket.from, bucket.to, bucket.values]), [[10, 20, [.3]], [20, 30, [null]], [30, 40, [.7]]]);
  assert.deepEqual(splitLineSegments(display.series[0].values), [[{ index: 0, value: .3 }], [{ index: 2, value: .7 }]]);
});

test("display-only chart renderer uses the fixed model, Token, Worker, and monitoring stacks", () => {
  const model = createDashboardChartDisplay("model_status", [{ from: 1, to: 2, completed: 5, failed: 2, timedOut: 1, other: 0 }]);
  assert.equal(model.shape, "stacked-bars");
  assert.deepEqual(model.series.map((series) => series.key), ["completed", "failed", "timedOut", "other"]);
  assert.equal(knownStackTotal(model.buckets[0].values), 8);

  const tokens = createDashboardChartDisplay("tokens", [{ from: 1, to: 2, inputTokens: 7, outputTokens: 2 }]);
  assert.equal(tokens.shape, "stacked-bars");
  assert.equal(knownStackTotal(tokens.buckets[0].values), 9);

  const worker = createDashboardChartDisplay("worker_events", [{ from: 1, to: 2, unexpectedExits: 2, restartAttempts: 3 }]);
  assert.equal(worker.shape, "stacked-bars");
  assert.deepEqual(worker.series.map((series) => series.values), [[2], [3]]);

  const monitoring = createDashboardChartDisplay("monitoring", [{ from: 1, to: 2, total: 9, run: 1, session: 1, message: 1, tool: 1, execution: 1, model: 1, worker: 1, git: 2 }]);
  assert.equal(monitoring.buckets[0].reportedTotal, 9);
  assert.equal(knownStackTotal(monitoring.buckets[0].values), 9);
});
