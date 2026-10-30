import assert from "node:assert/strict";
import test from "node:test";
import { agentSession, jsonResult } from "./agent-fixture.js";
import { executeFollow, msg, page, run, state, type Handler } from "./follow-fixture.js";

test("全面审查M3: stateful cancel targets processing-time Run after precheck, while idle never scans historical orphans", async () => {
  for (const scenario of ["switch", "idle"] as const) {
    let current: string | null = scenario === "switch" ? "old" : null;
    const statuses = new Map([["old", scenario === "switch" ? "running" : "completed"], ["new", scenario === "switch" ? "pending" : "running"], ["historical-orphan", "running"]]);
    let checked = false;
    const result = await executeFollow(["cancel", "-w", "w", "-s", "s"], (url, request) => {
      if (url.pathname === "/api/agent/sessions/s") {
        assert.equal(checked, false); checked = true;
        if (scenario === "switch") {
          assert.equal(current, "old"); assert.equal(statuses.get("old"), "running");
          statuses.set("old", "completed"); statuses.set("new", "running"); current = "new";
        }
        return jsonResult(agentSession());
      }
      assert.equal(url.pathname, "/api/agent/sessions/s/cancel"); assert.equal(checked, true);
      assert.equal(request.method, "POST"); assert.deepEqual(request.body, { workspaceId: "w" });
      if (current) statuses.set(current, "cancelled"); current = null;
      return jsonResult({ ok: true, session: agentSession(), runState: state() });
    });
    assert.equal(result.code, 0, result.stderr); assert.equal(result.requests.length, 2);
    assert.equal(statuses.get("old"), "completed"); assert.equal(statuses.get("new"), scenario === "switch" ? "cancelled" : "running");
    assert.equal(statuses.get("historical-orphan"), "running");
  }
});

function controls(options: { kind?: string; busy?: boolean; conflict?: boolean; empty?: boolean; status?: string; resultCode?: string; dedup?: boolean } = {}): Handler {
  return (url, request) => {
    if (url.pathname === "/api/agent/sessions/s") return jsonResult(agentSession({ kind: options.kind ?? "primary", headMessageId: "old" }));
    if (url.pathname.endsWith("/run-state")) return jsonResult(state(options.busy ? "r" : null));
    if (url.pathname.endsWith("/agents/available")) return jsonResult({ agents: [{ id: "first", name: "first", summary: "" }, { id: "second", name: "second", summary: "" }] });
    if (url.pathname.endsWith("/cancel")) { assert.equal(request.method, "POST"); assert.deepEqual(request.body, { workspaceId: "w" }); return jsonResult({ ok: true, session: agentSession(), runState: state(options.busy ? "r" : null) }); }
    if (url.pathname.endsWith("/compact")) {
      assert.equal(request.method, "POST"); assert.equal((request.body as { agentId: string }).agentId, "first");
      if (options.conflict || options.empty) return jsonResult({ code: options.empty ? "AGENT_COMPACTION_EMPTY" : "SESSION_RUNNING" }, options.empty ? 400 : 409);
      return jsonResult({ ok: true, session: agentSession(), runState: state("r"), runId: "r", scheduled: !options.dedup, ...(options.dedup ? { skippedReason: "deduplicated" } : {}) }, 201);
    }
    if (url.pathname.endsWith("/runs/r")) return jsonResult(run("r", options.status ?? "completed", "manual_compaction", options.resultCode ?? "compaction_not_needed"));
    if (url.searchParams.get("mode") === "snapshot") return jsonResult(page([msg("old", 0, null, { originRunId: "old-run" })]));
    if (url.searchParams.get("mode") === "delta") return jsonResult(page([], 10, { session: agentSession({ headMessageId: "old", revision: 10 }) }));
    assert.fail(`unexpected route ${url.pathname}`);
  };
}

test("normal cancel output reports the returned state without inventing a cancelled Run", async () => {
  for (const busy of [false, true]) {
    const expectedStatus = busy ? "running" : "idle";
    const human = await executeFollow(["cancel", "-w", "w", "-s", "s"], controls({ busy }), false);
    assert.equal(human.code, 0, human.stderr);
    assert.equal(human.stdout, `取消请求已处理。\n状态：${expectedStatus}\n`);
    assert.equal(human.stderr, "");
    assert.equal(human.requests.length, 2);
    const json = await executeFollow(["cancel", "-w", "w", "-s", "s"], controls({ busy }));
    assert.equal(json.code, 0, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout), {
      schemaVersion: 1, ok: true, command: "session cancel",
      data: { workspaceId: "w", sessionId: "s", requested: true, status: expectedStatus }
    });
  }
});

test("normal compact output reports acceptance and keeps all Run identities", async () => {
  const result = await executeFollow(["compact", "-w", "w", "-s", "s"], controls(), false);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^压缩请求已受理。\n/);
  assert.doesNotMatch(result.stdout, /不代表|不是排队|已经改变上下文/);
  for (const entry of ["workspaceId：w", "sessionId：s", "agentId：first", "runId：r", "accepted：true", "scheduled：true", "deduplicated：false"]) {
    assert.ok(result.stdout.includes(`${entry}\n`), entry);
  }
  const posted = result.requests.find(({ url }) => url.pathname.endsWith("/compact"));
  assert.ok(posted);
  assert.ok(result.stdout.includes(`clientRequestId：${(posted.request.body as { clientRequestId: string }).clientRequestId}\n`));
  assert.equal(result.stderr, "");
});

test("A-CONTROL-CANCEL-TYPE/RACE: one primary precheck and one cancel, subtask refuses with zero writes", async () => {
  for (const kind of ["primary", "subtask"]) {
    const result = await executeFollow(["cancel", "-w", "w", "-s", "s"], controls({ kind }));
    assert.equal(result.code, kind === "primary" ? 0 : 2, result.stderr);
    if (kind === "primary") assert.deepEqual(JSON.parse(result.stdout).data, { workspaceId: "w", sessionId: "s", requested: true, status: "idle" });
    assert.equal(result.requests.filter(({ url }) => url.pathname === "/api/agent/sessions/s").length, 1);
    assert.equal(result.requests.filter(({ request }) => request.method === "POST").length, kind === "primary" ? 1 : 0);
    assert.equal(result.requests.filter(({ url }) => url.pathname.endsWith("/run-state")).length, 0);
  }
});

test("A-COMPACT-TYPE-BUSY/EMPTY: local boundaries and backend conflict never queue or retry", async () => {
  for (const options of [{ kind: "subtask" }, { busy: true }, { conflict: true }, { empty: true }]) {
    const result = await executeFollow(["compact", "-w", "w", "-s", "s"], controls(options));
    assert.equal(result.code, "kind" in options ? 2 : 6, result.stderr);
    assert.equal(result.requests.filter(({ request }) => request.method === "POST").length, "conflict" in options || "empty" in options ? 1 : 0);
    if ("empty" in options) assert.equal(JSON.parse(result.stderr).error.serviceCode, "AGENT_COMPACTION_EMPTY");
  }
});

test("A-COMPACT-ACCEPT/SKIP/FAIL: default exits on acceptance, follow uses run result and unchanged history anchor", async () => {
  const accepted = await executeFollow(["compact", "-w", "w", "-s", "s"], controls());
  assert.equal(accepted.code, 0, accepted.stderr); assert.equal(accepted.requests.some(({ url }) => url.pathname.endsWith("/timeline")), false);
  for (const resultCode of ["compaction_completed", "compaction_not_needed", "compaction_no_progress", "compaction_oversized_tail", "compaction_media_requires_resend", "compaction_pending_tools", "compaction_provider_unavailable", "compaction_failed"]) {
    const failed = ["compaction_pending_tools", "compaction_provider_unavailable", "compaction_failed"].includes(resultCode);
    const result = await executeFollow(["compact", "-w", "w", "-s", "s", "-f"], controls({ status: failed ? "failed" : "completed", resultCode }));
    assert.equal(result.code, failed ? 8 : 0, result.stderr); assert.equal(result.events[0].type, "metadata"); assert.equal(result.events[0].agentId, "first");
    assert.equal(result.events.at(-1)?.complete, true); assert.equal(result.events.at(-1)?.resultCode, resultCode); assert.equal(result.events.filter((event) => event.type === "message").length, 0);
  }
});

test("A-COMPACT-DEDUP: fresh request cannot prove earlier Agent; preserve accepted run instead of faking skip success", async () => {
  const result = await executeFollow(["compact", "-w", "w", "-s", "s", "-f"], controls({ dedup: true }));
  assert.equal(result.code, 6); const error = JSON.parse(result.stderr).error;
  assert.equal(error.effect, "accepted"); assert.equal(error.context.runId, "r"); assert.equal(error.context.agentId, undefined);
  assert.equal(result.stdout, ""); assert.equal(result.requests.filter(({ request }) => request.method === "POST").length, 1);
});

test("A-COMPACT request IDs: successive send and compact invocations use independent random identities", async () => {
  const ids: string[] = [];
  const handler = controls();
  for (const command of ["send", "compact", "compact"]) {
    const result = await executeFollow([command, "-w", "w", "-s", "s", ...(command === "send" ? ["--prompt", "fixture"] : [])], (url, request) => {
      if (request.method === "POST") ids.push((request.body as { clientRequestId: string }).clientRequestId);
      if (url.pathname.endsWith("/messages")) return jsonResult({ sessionId: "s", messageId: "new", runId: "r", deduplicated: false }, 201);
      return handler(url, request);
    });
    assert.equal(result.code, 0, result.stderr);
  }
  assert.equal(new Set(ids).size, 3); for (const id of ids) assert.match(id, /^[0-9a-f-]{36}$/);
});
