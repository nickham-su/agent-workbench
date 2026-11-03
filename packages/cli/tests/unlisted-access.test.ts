import assert from "node:assert/strict";
import test from "node:test";
import { agentSession, jsonResult } from "./agent-fixture.js";
import { executeFollow, msg, page, run, state } from "./follow-fixture.js";
import { textField, messageIds } from "./helpers.js";

const hidden = () => agentSession({ visibility: "unlisted", headMessageId: "a" });

for (const action of ["show", "status", "send", "messages", "follow"] as const) {
  test(`known unlisted Session remains usable by ${action} without global discovery or SSE`, async () => {
    const args = action === "follow" ? ["messages", "-w", "w", "-s", "s", "-n", "1", "-f"]
      : [action, "-w", "w", "-s", "s", ...(action === "messages" ? ["-n", "1"] : action === "send" ? ["--prompt", "fixture prompt"] : [])];
    const result = await executeFollow(args, (url, request) => {
      if (url.pathname.endsWith("/agents/available")) return jsonResult({ agents: [{ id: "a", name: "Fixture", summary: "" }] });
      if (url.pathname.endsWith("/run-state")) return jsonResult(state(action === "follow" ? "r" : null));
      if (url.pathname.endsWith("/runs/r")) return jsonResult(run());
      if (url.pathname.endsWith("/messages")) {
        assert.equal(request.method, "POST");
        return jsonResult({ sessionId: "s", messageId: "u", runId: "r", deduplicated: false }, 201);
      }
      if (url.pathname.endsWith("/timeline")) return jsonResult(page(url.searchParams.get("mode") === "delta" ? [] : [msg("a", 0, null)], 10, { session: hidden() }));
      assert.equal(url.pathname, "/api/agent/sessions/s");
      return jsonResult(hidden());
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.requests.filter(({ request }) => request.method === "POST").length, action === "send" ? 1 : 0);
    assert.equal(result.requests.some(({ url }) => url.pathname.endsWith("/sessions") || url.pathname.includes("/events")), false);
    if (action === "messages" || action === "follow") assert.deepEqual(messageIds(result.stdout), ["a"]);
    if (action === "follow") assert.equal(textField(result.stdout, "outcome"), "run_completed");
    if (action === "send") assert.equal(textField(result.stdout, "sessionCreated"), "false");
  });
}
