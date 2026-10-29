import assert from "node:assert/strict";
import test from "node:test";
import { CliError, errorObject } from "../src/errors.js";
import { FollowLifetime } from "../src/follow-lifetime.js";
import { FollowOutput } from "../src/follow-output.js";
import { agentSession, jsonResult } from "./agent-fixture.js";
import { executeFollow, msg, page, run, state } from "./follow-fixture.js";
import { captureIO } from "./helpers.js";

test("全面审查M2: failure adds only a validated captured Run and preserves more precise error evidence", () => {
  const capture = captureIO(); const lifetime = new FollowLifetime(capture.io.stdout);
  try {
    for (const target of ["target-run", null]) {
      const output = new FollowOutput(capture.io, true, lifetime, { workspaceId: "w", sessionId: "s" }, target);
      const error = output.error(new CliError(4, "fixture auth", { code: "AUTH_REQUIRED", phase: "history", effect: "rejected", context: { messageId: "anchor" } }));
      const value = errorObject(error).error;
      assert.equal(value.category, "AUTH"); assert.equal(value.code, "AUTH_REQUIRED"); assert.equal(value.phase, "history"); assert.equal(value.effect, "rejected");
      assert.deepEqual(value.context, { workspaceId: "w", sessionId: "s", messageId: "anchor", ...(target === null ? {} : { runId: target }) });
      assert.equal(output.error(new CliError(6, "fixture precise", { context: { runId: "more-precise-run" } })).details.context?.runId, "more-precise-run");
    }
  } finally { lifetime.dispose(); }
});

test("全面审查M2: delta, refill and final-drain failures retain the captured messages Run in stderr", async () => {
  for (const where of ["delta", "refill", "drain"] as const) for (const failure of ["network", "auth"] as const) {
    const a = msg("a", 0, null); let deltas = 0;
    const result = await executeFollow(["messages", "-w", "w", "-s", "s", "-n", "1", "-f"], (url) => {
      if (url.pathname.endsWith("/run-state")) return jsonResult(state("target-run"));
      if (url.pathname.includes("/runs/")) return jsonResult(run("target-run"));
      if (url.searchParams.get("mode") === "snapshot") return jsonResult(page([a]));
      const fail = () => { if (failure === "auth") return jsonResult({}, 401); throw new CliError(5, "fixture transport", { code: "TRANSPORT_FAILED" }); };
      if (url.searchParams.has("beforeMessageId")) return fail();
      deltas++;
      if (where === "refill") return jsonResult(page([msg("b", 1, "a", { updatedRevision: 11 })], 11, { timelineReset: true, hasMore: true }));
      if (where === "delta" || deltas === 2) return fail();
      return jsonResult(page([], 10, { session: agentSession({ headMessageId: "a", revision: 10 }) }));
    });
    assert.equal(result.code, failure === "auth" ? 4 : 5, `${where}: ${result.stderr}`);
    const diagnostic = JSON.parse(result.stderr).error;
    assert.equal(diagnostic.category, failure === "auth" ? "AUTH" : "NETWORK");
    assert.equal(diagnostic.code, failure === "auth" ? "AUTH_REQUIRED" : "TRANSPORT_FAILED");
    assert.deepEqual(diagnostic.context, { workspaceId: "w", sessionId: "s", runId: "target-run" });
    assert.equal(result.events[0].runId, "target-run"); assert.equal(result.events.at(-1)?.complete, false);
    assert.equal(result.requests.some(({ url }) => url.pathname.endsWith("/cancel")), false);
  }
});
