import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import type { AgentTimelineDeltaResponse } from "@agent-workbench/shared";
import { createApp } from "../../../app/createApp.js";
import {
  appendMessage, appendStreamingAssistant, completeAssistantWithExecutions, convergeRunTerminal,
  createMessageRunRecord, createMessageSession, flushStreamingParts, getMessageSessionHead,
  getRunRecord, persistRunTerminalIntent, replaceStreamingAssistant, startMessageRun
} from "../agent-message.store.js";
import { createAgentTestFixture, createTestWorkspace } from "../testkit/agent-testkit.js";

const repoRoot = fileURLToPath(new URL("../../../../../../", import.meta.url));
const cliEntry = path.join(repoRoot, "packages/cli/dist/cli.cjs");

/** Real processes and TCP, with all HOME/config/SQLite files owned by this fixture. */
async function fixture(t: TestContext) {
  const requests: Array<{ method: string; url: string }> = [];
  const timelines: Array<{ url: string; data: AgentTimelineDeltaResponse }> = [];
  const f = await createAgentTestFixture({
    repoRoot, dataDirPrefix: "cli-head-replacement-", withApp: true, agentWorkerConcurrency: 0,
    appFactory: async (ctx) => {
      const app = await createApp(ctx);
      app.addHook("preHandler", async (request) => { requests.push({ method: request.method, url: request.url }); });
      // Observe the real route's serialized response; never manufacture or edit a proof.
      app.addHook("onSend", async (request, _reply, payload) => {
        if (request.url.includes("/timeline?") && typeof payload === "string") {
          timelines.push({ url: request.url, data: JSON.parse(payload) as AgentTimelineDeltaResponse });
        }
        return payload;
      });
      return app;
    }
  });
  t.after(() => f.dispose());
  const workspace = await createTestWorkspace(f, { title: "CLI replacement proof E2E" });
  const home = path.join(f.dataDir, "home");
  await fs.mkdir(home);
  const origin = await f.app!.listen({ host: "127.0.0.1", port: 0 });
  function run(args: string[]) {
    const child = spawn(process.execPath, [cliEntry, ...args], {
      cwd: home, env: { HOME: home, USERPROFILE: home, TMPDIR: home, PATH: path.dirname(process.execPath), NODE_PATH: "" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = ""; let stderr = ""; let closed = false;
    const changed = new EventEmitter();
    child.stdout.on("data", (chunk) => { stdout += String(chunk); changed.emit("changed"); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => { closed = true; changed.emit("changed"); resolve({ code, stdout, stderr }); });
    });
    // A dead CLI must not keep the suite alive; this is a failure guard, not test sequencing.
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    void done.finally(() => clearTimeout(timer)).catch(() => {});
    t.after(async () => { if (!closed) child.kill("SIGKILL"); await done; });
    async function waitFor(text: string) {
      while (!stdout.includes(text)) {
        assert.equal(closed, false, `CLI closed before expected output: ${text}\n${stderr}`);
        await new Promise<void>((resolve) => changed.once("changed", resolve));
      }
    }
    return { done, waitFor, output: () => ({ stdout, stderr }) };
  }
  const login = await run(["login", "--url", origin]).done;
  assert.equal(login.code, 0, login.stderr);
  assert.equal(login.stderr, "");
  return { ...f, workspace, requests, timelines, run };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function seed(f: Fixture) {
  const workspaceId = f.workspace.id; const sessionId = "proof-session"; const runId = "proof-run-one";
  const identity = { workspaceId, sessionId, runId };
  createMessageSession(f.db, { id: sessionId, workspaceId, title: "proof session", kind: "primary", createdAt: 1 });
  appendMessage(f.db, { id: "proof-user", workspaceId, sessionId, expectedHeadMessageId: null, expectedRevision: 0,
    type: "user", status: "completed", parts: [], createdAt: 2 });
  createMessageRunRecord(f.db, { ...identity, triggerMessageId: "proof-user", agentId: "default", providerId: "fixture",
    modelId: "fixture", status: "running", createdAt: 3 });
  startMessageRun(f.db, { ...identity, updatedAt: 3 });
  appendStreamingAssistant(f.db, { ...identity, id: "draft-attempt-A", expectedHeadMessageId: "proof-user", expectedRevision: 1, createdAt: 4 });
  assert.equal(flushStreamingParts(f.db, { ...identity, messageId: "draft-attempt-A", updatedAt: 5,
    parts: [{ id: "part-A", position: 0, type: "text", text: "original draft shown before replacement" }] }), "updated");
  return identity;
}
function replaceAndComplete(f: Fixture, identity: ReturnType<typeof seed>) {
  for (const [oldMessageId, newMessageId, retryCount, text] of [
    ["draft-attempt-A", "draft-attempt-B", 1, "intermediate attempt never observed"],
    ["draft-attempt-B", "final-attempt-C", 2, "replacement answer from the original run"]
  ] as const) {
    const head = getMessageSessionHead(f.db, identity)!;
    assert.equal(replaceStreamingAssistant(f.db, { ...identity, oldMessageId, newMessageId,
      expectedHeadMessageId: head.headMessageId, expectedRevision: head.revision,
      retryCount, nextRetryAt: null, runNoticeText: "retrying", createdAt: 5 + retryCount * 2 }).result, "updated");
    assert.equal(flushStreamingParts(f.db, { ...identity, messageId: newMessageId, updatedAt: 6 + retryCount * 2,
      parts: [{ id: `part-${retryCount}`, position: 0, type: "text", text }] }), "updated");
  }
  assert.equal(completeAssistantWithExecutions(f.db, { ...identity, messageId: "final-attempt-C", executions: [], updatedAt: 11 }), "updated");
  persistRunTerminalIntent(f.db, { ...identity, status: "completed", code: "run_completed", detail: null, updatedAt: 12 });
  convergeRunTerminal(f.db, { ...identity, updatedAt: 13 });
}
function startLaterRunOutsideTail(f: Fixture, identity: ReturnType<typeof seed>) {
  const later = { ...identity, runId: "proof-run-two" };
  let head = getMessageSessionHead(f.db, identity)!;
  appendMessage(f.db, { id: "later-user", ...identity, expectedHeadMessageId: head.headMessageId,
    expectedRevision: head.revision, type: "user", status: "completed", parts: [], createdAt: 14 });
  createMessageRunRecord(f.db, { ...later, triggerMessageId: "later-user", agentId: "default", providerId: "fixture",
    modelId: "fixture", status: "running", createdAt: 15 });
  startMessageRun(f.db, { ...later, updatedAt: 15 });
  // More than the real CLI's 100-row page: C is neither head nor present in the reset tail.
  for (let i = 0; i < 105; i++) {
    head = getMessageSessionHead(f.db, identity)!;
    appendMessage(f.db, { id: `later-message-${i}`, ...identity, originRunId: later.runId,
      expectedHeadMessageId: head.headMessageId, expectedRevision: head.revision, type: "assistant", status: "completed",
      parts: [{ id: `later-part-${i}`, position: 0, type: i < 2 ? "text" : "reasoning",
        text: i < 2 ? `unselected later run answer ${i}` : "hidden later reasoning" }], createdAt: 16 + i });
  }
  head = getMessageSessionHead(f.db, identity)!;
  appendStreamingAssistant(f.db, { ...later, id: "later-streaming-head", expectedHeadMessageId: head.headMessageId,
    expectedRevision: head.revision, createdAt: 122 });
  assert.equal(flushStreamingParts(f.db, { ...later, messageId: "later-streaming-head", updatedAt: 123,
    parts: [{ id: "later-streaming-part", position: 0, type: "text", text: "unselected later run still running" }] }), "updated");
  return later;
}
function footers(text: string) { return [...text.matchAll(/^消息 ID：([^\n]+)$/gm)].map((match) => match[1]); }

test("ACC-PROOF-CHAIN/SLOT/RECONCILE-AUTO/SELECTION-FIXED: built CLI consumes real A→B→C proof outside the tail without following r2", { timeout: 20000 }, async (t) => {
  const f = await fixture(t); const identity = seed(f);
  const cli = f.run(["session", "messages", "-w", identity.workspaceId, "-s", identity.sessionId, "-n", "1", "-f", "--follow-timeout", "10s"]);
  await cli.waitFor("original draft shown before replacement");
  assert.deepEqual(footers(cli.output().stdout), []);
  assert.equal(cli.output().stdout.includes("draft-attempt-A"), false);
  // Both replacements happen synchronously before the CLI can issue its next TCP read.
  replaceAndComplete(f, identity);
  const later = startLaterRunOutsideTail(f, identity);
  const result = await cli.done;
  assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, "");
  assert.equal(result.stdout.split("original draft shown before replacement").length - 1, 1);
  assert.equal(result.stdout.split("上一段草稿已作废").length - 1, 1);
  assert.equal(result.stdout.split("replacement answer from the original run").length - 1, 1);
  assert.deepEqual(footers(result.stdout), ["final-attempt-C"]);
  for (const hidden of ["draft-attempt-A", "draft-attempt-B", "intermediate attempt never observed", "unselected later run", "later-streaming-head", later.runId]) {
    assert.equal((result.stdout + result.stderr).includes(hidden), false, hidden);
  }
  assert.ok(result.stdout.indexOf("original draft shown") < result.stdout.indexOf("上一段草稿已作废"));
  assert.ok(result.stdout.indexOf("上一段草稿已作废") < result.stdout.indexOf("replacement answer"));
  assert.ok(result.stdout.indexOf("replacement answer") < result.stdout.indexOf("消息 ID：final-attempt-C"));
  assert.ok(result.stdout.indexOf("消息 ID：final-attempt-C") < result.stdout.indexOf("监听结束："));
  assert.equal(result.stdout.split("监听结束：").length - 1, 1);
  assert.match(result.stdout, /runStatus=completed；resultCode=run_completed；消息读取完整；complete=true；exitCode=0/);
  const proven = f.timelines.find(({ data }) => data.headReplacement?.fromMessageId === "draft-attempt-A");
  assert.ok(proven, "the actual serialized public response must carry the proof consumed by the CLI");
  assert.equal(proven.data.headReplacement!.toMessageId, "final-attempt-C");
  assert.equal(proven.data.headReplacement!.replacementCount, 2);
  assert.equal(proven.data.headReplacement!.atRevision, proven.data.session.revision);
  assert.equal(proven.data.timelineReset, true);
  assert.equal(proven.data.messages.some((message) => message.id === "final-attempt-C"), false);
  assert.equal(proven.data.session.headMessageId, "later-streaming-head");
  assert.ok(f.timelines.some(({ url, data }) => url.includes("mode=before") && data.messages.some((message) => message.id === "final-attempt-C")));
  assert.ok(f.requests.some(({ url }) => url.includes(`/runs/${identity.runId}?`)));
  assert.equal(f.requests.some(({ url }) => url.includes(`/runs/${later.runId}?`)), false);
  assert.equal(f.requests.some(({ method }) => method !== "GET"), false);
  assert.equal(getRunRecord(f.db, later.runId)!.status, "running", "local observation must neither wait for nor cancel r2");
});

test("ACC-RECONCILE-EXPLICIT: real API proof cannot remap the built CLI's explicit --after A", { timeout: 20000 }, async (t) => {
  const f = await fixture(t); const identity = seed(f);
  const cli = f.run(["session", "messages", "-w", identity.workspaceId, "-s", identity.sessionId, "--after", "draft-attempt-A", "-f", "--follow-timeout", "10s"]);
  await cli.waitFor(`Run ID：${identity.runId}`);
  assert.deepEqual(footers(cli.output().stdout), []);
  replaceAndComplete(f, identity);
  const result = await cli.done;
  assert.equal(result.code, 6);
  assert.match(result.stderr, /TIMELINE_CHANGED|ANCHOR_NOT_FOUND/);
  assert.match(result.stdout, /complete=false/);
  assert.deepEqual(footers(result.stdout), []);
  for (const hidden of ["draft-attempt-A", "draft-attempt-B", "final-attempt-C", "replacement answer", "上一段草稿已作废"]) {
    assert.equal((result.stdout + result.stderr).includes(hidden), false, hidden);
  }
  assert.ok(f.timelines.some(({ data }) => data.headReplacement?.replacementCount === 2));
  assert.equal(f.requests.some(({ method }) => method !== "GET"), false);
});
