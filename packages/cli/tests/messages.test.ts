import assert from "node:assert/strict";
import test from "node:test";
import { AgentApi } from "../src/agent-api.js";
import { CliError } from "../src/errors.js";
import type { HttpResult } from "../src/http.js";
import { HttpClient } from "../src/http.js";
import { completeHistory, parseMessage, parseMessageSelection, projectMessage, startHistory } from "../src/messages.js";
import { runCli } from "../src/program.js";
import { agentMessage, agentSession, connectionStore, jsonResult, messagePart, timelineFixture } from "./agent-fixture.js";
import { captureIO, httpServer } from "./helpers.js";

type RawMessage = ReturnType<typeof agentMessage>;
async function execute(selection: string[], handle: (path: string) => HttpResult | Promise<HttpResult>, extra: string[] = []) {
  const capture = captureIO(); const requests: string[] = [];
  const code = await runCli(["session", "messages", "-w", "w", "-s", "s", ...selection, ...extra], {
    io: capture.io, createConfigStore: () => connectionStore(), http: { request: async (_origin, path) => { requests.push(path); return handle(path); } }
  });
  return { code, stdout: capture.output(), stderr: capture.diagnostic(), requests };
}
function pageHandler(messages: RawMessage[], sessionOverrides: Record<string, unknown> = {}) {
  return (path: string): HttpResult => {
    const url = new URL(path, "http://fixture.test");
    const before = url.searchParams.get("beforeMessageId");
    const end = before === null ? messages.length : messages.findIndex((message) => message.id === before);
    assert.ok(end >= 0, "cursor must be a raw message id");
    const start = Math.max(0, end - 100);
    return jsonResult(timelineFixture(messages.slice(start, end), {
      session: agentSession({ headMessageId: messages.at(-1)?.id ?? null, ...sessionOverrides }), hasMore: start > 0,
      nextBeforeMessageId: messages[start]?.id ?? null
    }));
  };
}

test("normal messages output reports status and count without a final-answer disclaimer", async () => {
  for (const status of ["streaming", "completed", "failed", "cancelled"]) {
    const handle = pageHandler([agentMessage(0, { status })]);
    const human = await execute(["-n", "1"], handle);
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, new RegExp(`Message ID：m0；type=assistant；status=${status}\\n`));
    assert.ok(human.stdout.endsWith("消息快照结束：已输出 1 条普通消息。\n"));
    assert.doesNotMatch(human.stdout, /不代表|不保证|未来最终答案/);
    assert.equal(human.stderr, "");
    assert.ok(human.requests.every((path) => path.includes("/timeline?")));
    const json = await execute(["-n", "1"], handle, ["--json"]);
    assert.equal(json.code, 0, json.stderr);
    const result = JSON.parse(json.stdout);
    assert.deepEqual(Object.keys(result).sort(), ["command", "data", "ok", "schemaVersion"]);
    assert.equal(result.schemaVersion, 1); assert.equal(result.ok, true); assert.equal(result.command, "session messages");
    assert.deepEqual(Object.keys(result.data).sort(), ["complete", "count", "items", "selection", "sessionId", "workspaceId"]);
    assert.equal(result.data.complete, true); assert.equal(result.data.count, 1);
    assert.equal(result.data.items[0].status, status);
  }
  const empty = await execute(["-n", "1"], pageHandler([]));
  assert.equal(empty.code, 0, empty.stderr);
  assert.equal(empty.stdout, "消息快照结束：已输出 0 条普通消息。\n");
});

test("A-MESSAGES-EXCLUSIVE: selectors validate strictly before configuration/network", async () => {
  for (const selection of [[], ["--after", "m1", "-n", "1"], ...["0", "01", "-1", "1.5", "1e3", "+1", "9007199254740992", "1\n"].map((value) => ["-n", value]), ["--after", ".."]]) {
    const capture = captureIO(); let factories = 0;
    const code = await runCli(["session", "messages", "-w", "w", "-s", "s", ...selection, "--json"], { io: capture.io, createConfigStore: () => { factories++; throw Error("must not construct"); } });
    assert.equal(code, 2, JSON.stringify(selection)); assert.equal(factories, 0); assert.equal(capture.output(), "");
  }
  assert.deepEqual(parseMessageSelection({ last: "9007199254740991" }), { mode: "last", count: Number.MAX_SAFE_INTEGER });
});

test("A-MESSAGES-PROJECTION: strict text/image projection, ordinary counting and origin preservation", async () => {
  const messages = [
    agentMessage(0, { type: "user", originRunId: null, parts: [messagePart("m0", "image")] }),
    agentMessage(1, { parts: [messagePart("m1", "reasoning", { text: "hidden reasoning" })] }),
    agentMessage(2, { parts: [messagePart("m2", "tool_call")] }),
    agentMessage(3, { parts: [messagePart("m3", "text", { text: " \n" })] }),
    agentMessage(4, { type: "system" }), agentMessage(5, { type: "runtime" }),
    agentMessage(6, { type: "compaction", retainedFromMessageId: null }),
    agentMessage(7, { status: "superseded" }),
    agentMessage(8, { originSessionId: "parent", originRunId: "parent-run", parts: [
      messagePart("m8", "text", { id: "p2", position: 2, text: "last" }),
      messagePart("m8", "reasoning", { id: "p1", position: 1, text: "hidden reasoning" }),
      messagePart("m8", "image", { id: "p0", position: 0, filename: "image\n\u001b[31m.png" })
    ] })
  ];
  const output = await execute(["-n", "99"], pageHandler(messages), ["--json"]);
  assert.equal(output.code, 0, output.stderr);
  const data = JSON.parse(output.stdout).data;
  assert.deepEqual(data.items.map((item: { id: string }) => item.id), ["m0", "m8"]);
  assert.deepEqual(data.items[1].parts.map((part: { type: string }) => part.type), ["image", "text"]);
  assert.equal(data.items[1].originSessionId, "parent"); assert.equal(data.items[1].originRunId, "parent-run");
  for (const hidden of ["hidden reasoning", "hidden tool input", "replacesMessageId", "retainedFromMessageId", "toolExecutions", "position", "workspaceId\":\"w\",\"previous"]) assert.equal(output.stdout.includes(hidden), false, hidden);
  const human = await execute(["-n", "99"], pageHandler(messages));
  assert.equal(human.stdout.includes("\u001b"), false); assert.ok(human.stdout.includes("\\u001b"));
  assert.equal(data.items[1].parts[0].filename.includes("\u001b"), true);
});

test("A-MESSAGES-AFTER: any current raw type can anchor; exclusion, order and empty suffix", async () => {
  const messages = Array.from({ length: 6 }, (_, index) => agentMessage(index));
  messages[2] = agentMessage(2, { type: "compaction", retainedFromMessageId: null });
  messages[3] = agentMessage(3, { parts: [messagePart("m3", "tool_call")] });
  for (const [anchor, expected] of [["m1", ["m4", "m5"]], ["m2", ["m4", "m5"]], ["m3", ["m4", "m5"]], ["m5", []]] as const) {
    const output = await execute(["--after", anchor], pageHandler(messages), ["--json"]);
    assert.equal(output.code, 0); assert.deepEqual(JSON.parse(output.stdout).data.items.map((item: { id: string }) => item.id), expected);
  }
  for (const anchor of ["missing", "foreign-session-anchor", "old-branch"]) {
    const output = await execute(["--after", anchor], pageHandler(messages), ["--json"]);
    assert.equal(output.code, 6); assert.equal(output.stdout, "");
    assert.equal(JSON.parse(output.stderr).error.code, "ANCHOR_NOT_FOUND");
  }
});

test("A-MESSAGES-PAGES: over 500 sparse raw rows use raw cursor and never impose a CLI total page cap", async () => {
  const messages = Array.from({ length: 651 }, (_, index) => agentMessage(index, index % 101 ? { parts: [messagePart(`m${index}`, "tool_call")] } : {}));
  const last = await execute(["-n", "3"], pageHandler(messages), ["--json"]);
  assert.equal(last.code, 0, last.stderr); assert.equal(last.requests.length, 3);
  assert.deepEqual(JSON.parse(last.stdout).data.items.map((item: { id: string }) => item.id), ["m404", "m505", "m606"]);
  const all = await execute(["-n", "1000"], pageHandler(messages), ["--json"]);
  assert.equal(all.code, 0, all.stderr); assert.equal(all.requests.length, 7);
  assert.deepEqual(JSON.parse(all.stdout).data.items.map((item: { id: string }) => item.id), ["m0", "m101", "m202", "m303", "m404", "m505", "m606"]);
  const after = await execute(["--after", "m23"], pageHandler(messages), ["--json"]);
  assert.equal(after.code, 0); assert.equal(after.requests.length, 7);
  assert.deepEqual(JSON.parse(after.stdout).data.items.map((item: { id: string }) => item.id), ["m101", "m202", "m303", "m404", "m505", "m606"]);
  assert.ok(all.requests.slice(1).every((path) => path.includes("mode=before") && path.includes("beforeMessageId=")));
});

test("A-MESSAGES-CURSOR: malformed, duplicate, looping, wrong-identity or failed pages publish no partial success", async () => {
  const messages = Array.from({ length: 201 }, (_, index) => agentMessage(index));
  const base = pageHandler(messages);
  for (const corruption of ["cursor-null", "cursor-wrong", "duplicate", "session-identity", "message-identity", "page-repeat", "404", "revision-regress", "incomplete-prefix", "broken-link"]) {
    let requests = 0;
    const output = await execute(["-n", "999"], (path) => {
      requests++;
      const result = base(path); const body = JSON.parse(result.body);
      if (corruption === "cursor-null") body.nextBeforeMessageId = null;
      else if (corruption === "cursor-wrong") body.nextBeforeMessageId = "m200";
      else if (corruption === "duplicate") body.messages.push(body.messages[0]);
      else if (corruption === "session-identity") body.session.workspaceId = "other";
      else if (corruption === "message-identity") body.messages[0].workspaceId = "other";
      else if (requests > 1) {
        if (corruption === "page-repeat") return base("/api/agent/sessions/s/timeline?mode=snapshot");
        if (corruption === "404") return jsonResult({ message: "private missing cursor" }, 404);
        if (corruption === "revision-regress") body.session.revision = 0;
        if (corruption === "incomplete-prefix") body.hasMore = false;
        if (corruption === "broken-link") body.messages.at(-1).id = "not-predecessor";
      }
      return jsonResult(body);
    }, ["--json"]);
    assert.equal(output.code, 6, corruption); assert.equal(output.stdout, "", corruption); assert.ok(requests <= 2, corruption);
    assert.equal(output.stderr.includes("private missing cursor"), false);
  }
});

test("fixed H0 survives append while history loads, later head never slides selection or initial follow revision", async () => {
  const messages = Array.from({ length: 201 }, (_, index) => agentMessage(index));
  let requests = 0; let details = 0;
  const api = await AgentApi.connect({ config: connectionStore(), http: { request: async (_origin, path) => {
    if (path.includes("/messages/")) { details++; return jsonResult({ message: messages.at(-1) }); }
    const body = JSON.parse(pageHandler(messages)(path).body);
    if (++requests > 1) { body.session.headMessageId = "new-head"; body.session.revision = 20_000; }
    return jsonResult(body);
  } } });
  const frame = await startHistory(api, "w", "s");
  const result = await completeHistory(api, frame, { mode: "last", count: 201 });
  assert.equal(result.length, 201); assert.equal(result.at(-1)?.id, "m200");
  assert.equal(frame.initial.session.headMessageId, "m200"); assert.equal(frame.initial.session.revision, 10_000); assert.equal(details, 2);
  const failed = await execute(["-n", "201"], (path) => {
    if (path.includes("/messages/")) return jsonResult({}, 404);
    const body = JSON.parse(pageHandler(messages)(path).body);
    if (path.includes("mode=before")) body.session.headMessageId = "replacement-head";
    return jsonResult(body);
  }, ["--json"]);
  assert.equal(failed.code, 6); assert.equal(failed.stdout, ""); assert.equal(JSON.parse(failed.stderr).error.code, "TIMELINE_CHANGED");
});

test("A-MESSAGES-STREAMING/LAST/SUBTASK/LONG: real TCP snapshots preserve full body, statuses, inheritance and safe human text", async () => {
  const text = `开头\n${"完整正文".repeat(1500)}\n\u001b[31m末尾`;
  let fixture = timelineFixture([agentMessage(0, { originSessionId: "parent", originRunId: "old-run", status: "streaming", parts: [messagePart("m0", "text", { text })] })], { session: agentSession({ kind: "subtask", headMessageId: "m0" }) });
  const server = await httpServer((_request, response) => { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(fixture)); });
  try {
    for (const status of ["streaming", "completed", "failed", "cancelled"]) {
      fixture.messages[0].status = status;
      const capture = captureIO();
      assert.equal(await runCli(["session", "messages", "-w", "w", "-s", "s", "-n", "1", "--json"], { io: capture.io, createConfigStore: () => connectionStore(server.origin), http: new HttpClient() }), 0);
      const data = JSON.parse(capture.output()).data;
      assert.equal(data.items[0].parts[0].text, text); assert.equal(data.items[0].status, status); assert.equal(data.complete, true);
      assert.equal(data.items[0].originSessionId, "parent");
    }
    const user = await execute(["-n", "1"], pageHandler([agentMessage(0, { type: "user", originRunId: null })]), ["--json"]);
    assert.equal(JSON.parse(user.stdout).data.items[0].type, "user");
    const human = await execute(["-n", "1"], pageHandler(fixture.messages));
    assert.equal(human.stdout.includes("\u001b"), false); assert.ok(human.stdout.includes("\\u001b")); assert.ok(human.stdout.includes("开头\n")); assert.ok(human.stdout.length > 3000);
    const empty = await execute(["-n", "1"], () => jsonResult(timelineFixture([])), ["--json"]);
    assert.equal(empty.code, 0); assert.deepEqual(JSON.parse(empty.stdout).data.items, []);
  } finally { await server.close(); }
});

test("DTO parts reject invalid identity/positions/revisions while tool/reasoning are never retained", () => {
  for (const parts of [
    [messagePart("other")], [messagePart("m0", "text", { position: -1 })], [messagePart("m0", "text", { updatedRevision: -1 })],
    [messagePart("m0"), messagePart("m0", "text", { id: "another" })], [messagePart("m0", "unknown")]
  ]) assert.throws(() => parseMessage(agentMessage(0, { parts }), "w"), (error) => error instanceof CliError && error.exitCode === 6);
  const invisible = parseMessage(agentMessage(0, { parts: [messagePart("m0", "tool_call")] }), "w");
  assert.deepEqual(invisible.parts, []); assert.equal(projectMessage(invisible), null);
  assert.equal(JSON.stringify(invisible).includes("hidden"), false);
});
