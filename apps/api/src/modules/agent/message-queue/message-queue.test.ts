import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { Value } from "@sinclair/typebox/value";
import { AGENT_QUEUE_INITIAL_STOP_GENERATION, AGENT_QUEUE_MAX_PENDING_BYTES, AgentMessageQueueSnapshotSchema } from "@agent-workbench/shared";
import { HttpError } from "../../../app/errors.js";
import { deleteWorkspaceAgentData } from "../../../infra/db/workspace-agent-data-cleanup.js";
import { createMessageSession, createMessageRunRecord, startMessageRun, getMessageSessionHead, moveMessageHead } from "../agent-message.store.js";
import { AgentAttachmentPublicationService } from "../attachments/agent-attachment-publication.service.js";
import { workspaceDeletingFence } from "../lifecycle/workspace-deleting-fence.js";
import { AgentMessageQueueStore } from "./message-queue.store.js";
import { AgentMessageQueueService } from "./message-queue.service.js";
import { queueFixture, scope, identity, errorIs, PNG } from "./message-queue.testkit.js";

test("busy receipts persist FIFO without changing formal head/revision, including legacy noninteractive Runs", async t => {
  const f = await queueFixture(t);
  createMessageRunRecord(f.db, { ...scope, runId: "old", triggerMessageId: null, ...identity, status: "running", createdAt: 1 });
  startMessageRun(f.db, { ...scope, runId: "old", updatedAt: 1 });
  const head = getMessageSessionHead(f.db, scope);
  const [a, b] = await Promise.all([f.accept("a"), f.accept("b")]);
  assert.deepEqual([a.receipt.sequence, b.receipt.sequence].sort(), [1, 2]);
  assert.equal(a.receipt.status, "queued"); assert.equal(a.receipt.runId, null);
  assert.deepEqual(getMessageSessionHead(f.db, scope), head);
  assert.equal(await f.dispatcher.dispatchSession(scope), null);
  assert.equal(f.enqueued.length, 0);
  assert.equal(f.store.snapshot(scope).queueVersion, 2);
});

test("payload fingerprint, request namespace, cancellation tombstones and send-driven activation", async t => {
  const f = await queueFixture(t);
  const a = await f.accept("a", " hello ");
  const duplicate = await f.accept("a", " hello ");
  assert.equal(duplicate.deduplicated, true); assert.equal(duplicate.receipt.id, a.receipt.id);
  await assert.rejects(f.accept("a", "hello"), errorIs(409, "AGENT_REQUEST_PAYLOAD_CONFLICT"));
  await assert.rejects(f.service.accept("s1", { workspaceId: "w1", clientRequestId: "a", text: " hello ", uiLocale: "en-US" }), errorIs(409));
  const cancelled = f.service.cancel(scope, a.receipt.id);
  assert.equal(cancelled.queue.pendingCount, 0); assert.equal(cancelled.queue.queueVersion, 2);
  assert.equal(f.service.cancel(scope, a.receipt.id).queue.queueVersion, 2);
  assert.equal((await f.accept("a", " hello ")).receipt.status, "cancelled");
  const detail = f.service.detail(scope, a.receipt.id);
  assert.equal(detail.text, null); assert.equal(detail.inputText, null);
  assert.throws(() => f.persistence.activateUserRun({ ...scope, runId: "illegal", createdAt: 5, clientRequestId: "a", text: "legacy", ...identity, uiLocale: null, images: [] }), errorIs(409, "AGENT_REQUEST_ID_NAMESPACE_CONFLICT"));
  f.store.pause(scope, "user_stop");
  await f.accept("b");
  assert.equal(f.service.snapshot(scope).mode, "active");
  assert.ok(await f.dispatcher.dispatchSession(scope));
});

test("legacy execution request identity cannot be reused by a receipt", async t => {
  const f = await queueFixture(t);
  f.persistence.activateUserRun({ ...scope, runId: "legacy", createdAt: 5, clientRequestId: "old", text: "legacy", ...identity, uiLocale: null, images: [] });
  await assert.rejects(f.accept("old"), errorIs(409, "AGENT_REQUEST_ID_NAMESPACE_CONFLICT"));
  assert.equal(f.store.snapshot(scope).pendingCount, 0);
});

test("text UTF-8, count and byte capacity use shared limits; dedup precedes capacity", async t => {
  const f = await queueFixture(t);
  await assert.rejects(f.accept("wide", "中".repeat(21846)), errorIs(413, "AGENT_QUEUE_TEXT_TOO_LARGE"));
  const first = await f.accept("0", "x".repeat(65536));
  for (let i = 1; i < 100; i++) await f.accept(String(i));
  await assert.rejects(f.accept("full"), errorIs(429, "AGENT_QUEUE_CAPACITY_EXCEEDED"));
  assert.equal((await f.accept("0", "x".repeat(65536))).receipt.id, first.receipt.id);
  f.service.cancel(scope, first.receipt.id);
  await f.accept("replacement");
  f.db.prepare("update agent_user_message_receipt set payload_bytes=? where client_request_id='1'").run(AGENT_QUEUE_MAX_PENDING_BYTES);
  f.service.cancel(scope, f.store.getByRequest({ ...scope, clientRequestId: "2" })!.id);
  await assert.rejects(f.accept("bytes-full"), errorIs(429));
});

test("two SQLite connections recheck identity and capacity in the actual receipt transaction", async t => {
  const f = await queueFixture(t);
  const db2 = new Database(f.dbPath); db2.pragma("foreign_keys=ON"); t.after(() => db2.close());
  const store2 = new AgentMessageQueueStore(db2);
  const second = new AgentMessageQueueService(store2, { dataDir: f.dataDir, publications: new AgentAttachmentPublicationService({ db: db2, dataDir: f.dataDir }), runtimeControl: f.runtime, resolveProfile: f.resolveProfile });
  const results = await Promise.all([f.accept("same"), second.accept("s1", { workspaceId: "w1", clientRequestId: "same", text: "hello" })]);
  assert.equal(results[0].receipt.id, results[1].receipt.id);
  for (let i = 0; i < 98; i++) await f.accept(`fill-${i}`);
  const last = await Promise.allSettled([f.accept("last-a"), second.accept("s1", { workspaceId: "w1", clientRequestId: "last-b", text: "hello" })]);
  assert.equal(last.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(f.store.snapshot(scope).pendingCount, 100);
  assert.equal(new Set(f.store.listQueued(scope).map(row => row.sequence)).size, 100);
});

test("identity stays fixed across default changes, rejects explicit conflict and revalidates configuration", async t => {
  const f = await queueFixture(t);
  await f.accept("a");
  f.setDefaultIdentity({ agentId: "new", providerId: "other", modelId: "other" });
  await f.accept("b");
  assert.deepEqual(f.store.snapshot(scope).pendingIdentity, identity);
  await assert.rejects(f.service.accept("s1", { workspaceId: "w1", clientRequestId: "c", text: "hello", agentId: "new" }), errorIs(409, "AGENT_QUEUE_AGENT_CONFLICT"));
  f.setProfileError(new HttpError(400, "Profile unavailable", "AGENT_NOT_FOUND"));
  await assert.rejects(f.accept("d"), errorIs(400));
  assert.equal((await f.accept("a")).deduplicated, true, "accepted receipts stay retrievable after configuration loss");
  await f.dispatcher.dispatchSession(scope);
  assert.equal(f.store.snapshot(scope).pauseCode, "profile_unavailable");
  assert.equal(f.store.snapshot(scope).pendingCount, 2);
});

test("scope is primary-only and honors deleting fences without admitting receipts", async t => {
  const f = await queueFixture(t);
  createMessageSession(f.db, { id: "child", workspaceId: "w1", kind: "subtask", title: "child", createdAt: 1 });
  await assert.rejects(f.service.accept("child", { workspaceId: "w1", clientRequestId: "x", text: "hi" }), errorIs(400, "AGENT_SUBTASK_READONLY"));
  await assert.rejects(f.service.accept("s1", { workspaceId: "other", clientRequestId: "x", text: "hi" }), errorIs(404));
  workspaceDeletingFence.begin("w1");
  await assert.rejects(f.accept("x"), errorIs(409, "WORKSPACE_DELETING"));
  workspaceDeletingFence.end("w1");
  assert.equal(f.store.snapshot(scope).pendingCount, 0);
});

test("same image bytes with fresh random IDs deduplicate; cancel revokes access but retains files and charged bytes", async t => {
  const f = await queueFixture(t);
  const accept = async (filename = "image.png", bytes = PNG) => f.service.accept("s1", { workspaceId: "w1", clientRequestId: "image", text: "", images: [await f.upload(filename, bytes)] });
  const a = await accept(); const b = await accept();
  assert.equal(a.receipt.id, b.receipt.id); assert.equal(b.deduplicated, true);
  await assert.rejects(accept("different.png"), errorIs(409, "AGENT_REQUEST_PAYLOAD_CONFLICT"));
  await assert.rejects(accept("image.png", Buffer.concat([PNG, Buffer.from([1])])), errorIs(409));
  const image = f.service.detail(scope, a.receipt.id).attachments[0]!;
  assert.deepEqual((await f.service.attachment(scope, a.receipt.id, image.id)).content, PNG);
  const retained = f.service.retention();
  f.service.cancel(scope, a.receipt.id);
  await assert.rejects(f.service.attachment(scope, a.receipt.id, image.id), errorIs(404));
  assert.deepEqual(f.service.retention(), retained);
  const files = await fs.readdir(path.join(f.workspacePath, ".awb", "agent", "attachments"));
  assert.equal(files.length, 1);
  assert.equal((await accept()).receipt.status, "cancelled");
});

test("published receipt transaction rollback preserves quota and files; safe retry binds the original publication", async t => {
  const f = await queueFixture(t);
  f.db.exec("create trigger reject_receipt before insert on agent_user_message_receipt begin select raise(abort,'test rollback'); end");
  const input = () => f.upload();
  await assert.rejects(f.service.accept("s1", { workspaceId: "w1", clientRequestId: "rollback", text: "", images: [await input()] }), errorIs(503));
  assert.equal(f.store.snapshot(scope).pendingCount, 0);
  assert.equal((f.db.prepare("select count(*) as n from agent_attachment").get() as { n: number }).n, 0);
  const retention = f.service.retention();
  f.db.exec("drop trigger reject_receipt");
  const retried = await f.service.accept("s1", { workspaceId: "w1", clientRequestId: "rollback", text: "", images: [await input()] });
  assert.equal(retried.receipt.status, "queued"); assert.deepEqual(f.service.retention(), retention);
});

test("workspace logical cleanup preserves publication accounting after receipt and Run FK associations", async t => {
  const f = await queueFixture(t);
  const accepted = await f.service.accept("s1", { workspaceId: "w1", clientRequestId: "image", images: [await f.upload()] });
  const activation = f.persistence.activateQueuedUserRun({ ...scope, receiptId: accepted.receipt.id, runId: "unbound", createdAt: 2 });
  assert.equal(activation.kind, "activated");
  f.finish("unbound");
  const retained = f.service.retention();
  f.db.transaction(() => deleteWorkspaceAgentData(f.db, "w1")).immediate();
  assert.equal((f.db.prepare("select count(*) as n from agent_user_message_receipt").get() as { n: number }).n, 0);
  assert.equal((f.db.prepare("pragma foreign_key_check").all()).length, 0);
  assert.deepEqual(f.service.retention(), retained);
});

test("snapshot has independent queueVersion and strict shared shape; legacy history cannot overtake pending input", async t => {
  const f = await queueFixture(t);
  assert.equal(Value.Check(AgentMessageQueueSnapshotSchema, f.store.snapshot(scope)), true);
  const before = getMessageSessionHead(f.db, scope)!;
  await f.accept("a");
  assert.throws(() => moveMessageHead(f.db, { ...scope, nextHeadMessageId: "unreachable", expectedHeadMessageId: before.headMessageId, expectedRevision: before.revision, updatedAt: 5 }), errorIs(409, "SESSION_HAS_PENDING_INPUT"));
  const snapshot = f.store.snapshot(scope);
  assert.equal(Value.Check(AgentMessageQueueSnapshotSchema, snapshot), true);
  assert.equal(snapshot.queueVersion, 1); assert.equal(snapshot.stop.state, "none");
  assert.deepEqual(getMessageSessionHead(f.db, scope), before);
});

// Esc increment: clear fixed targets, and send is the only Web start/recovery action.
test("clear fixed targets is effect-idempotent, skips injected inputs and never cancels newer receipts", async t => {
  const f = await queueFixture(t);
  const a = await f.accept("clear-a"), b = await f.accept("clear-b");
  const targets = [a.receipt.id, b.receipt.id];
  const active = await f.dispatcher.dispatchSession(scope); assert.ok(active);
  const first = f.service.clear(scope, targets);
  assert.equal(first.cancelledCount, 1); assert.equal(first.queue.mode, "active");
  assert.equal(f.store.get(scope, a.receipt.id).status, "injected");
  assert.equal(f.store.get(scope, b.receipt.id).status, "cancelled");
  const later = await f.accept("clear-later");
  const repeat = f.service.clear(scope, targets);
  assert.equal(repeat.cancelledCount, 0); assert.equal(repeat.queue.pendingCount, 1);
  assert.equal(repeat.queue.items[0]!.id, later.receipt.id);
  assert.equal(f.enqueued.length, 1); assert.equal(repeat.queue.mode, "active");
});

test("clear validates the entire scoped target set before mutation and accepts an empty set", async t => {
  const f = await queueFixture(t); const a = await f.accept("scope-clear");
  const before = f.store.snapshot(scope);
  assert.throws(() => f.service.clear(scope, [a.receipt.id, "missing"]), errorIs(404));
  assert.deepEqual(f.store.snapshot(scope), before);
  createMessageSession(f.db, { id: "other", workspaceId: "w1", kind: "primary", title: "Other", createdAt: 1 });
  const other = await f.service.accept("other", { workspaceId: "w1", clientRequestId: "other", text: "other" });
  assert.throws(() => f.service.clear(scope, [a.receipt.id, other.receipt.id]), errorIs(404));
  assert.deepEqual(f.store.snapshot(scope), before);
  assert.equal(f.service.clear(scope, []).cancelledCount, 0);
});

test("clear images revokes receipt authorization but retains the published files and charged bytes", async t => {
  const f = await queueFixture(t); const image = await f.upload();
  const accepted = await f.service.accept("s1", { workspaceId: "w1", clientRequestId: "clear-image", images: [image] });
  const before = f.service.retention(); const attachments = f.store.attachments(scope, accepted.receipt.id);
  const cleared = f.service.clear(scope, [accepted.receipt.id]);
  assert.equal(cleared.cancelledCount, 1); assert.equal(cleared.queue.pendingCount, 0);
  assert.equal(f.store.detail(scope, accepted.receipt.id).inputText, null);
  assert.deepEqual(f.store.attachments(scope, accepted.receipt.id), []);
  assert.deepEqual(f.service.retention(), before);
  assert.ok(attachments.length);
});

test("Web Stop clears queued in its acceptance transaction; old operation replay leaves a later send active", async t => {
  const f = await queueFixture(t); const first = await f.accept("stop-clear-a"); await f.accept("stop-clear-b");
  const initialGeneration = f.store.snapshot(scope).stopGeneration;
  const stopped = f.service.stop(scope, "stop-clear");
  assert.equal(stopped.queue.pendingCount, 0); assert.equal(stopped.queue.mode, "paused");
  assert.equal(stopped.queue.stop.state, "quiescent");
  assert.notEqual(stopped.queue.stopGeneration, initialGeneration);
  assert.equal(stopped.stopOperation.acceptedQueueVersion, stopped.queue.queueVersion);
  assert.equal(f.store.get(scope, first.receipt.id).status, "cancelled");
  const next = await f.accept("after-clear-stop");
  assert.equal(next.queue.mode, "active"); assert.equal(next.queue.pendingCount, 1);
  const replay = f.service.stop(scope, "stop-clear");
  assert.deepEqual(replay.stopOperation, stopped.stopOperation);
  assert.deepEqual(replay.queue, next.queue);
  assert.ok(await f.dispatcher.dispatchSession(scope));
});

for (const withImage of [false, true]) test(`in-flight ${withImage ? "image" : "text"} send spanning a fully completed Stop is fenced and retains no queued receipt`, async t => {
  const f = await queueFixture(t);
  let reached!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const publish = f.publications.publishAndCommit.bind(f.publications);
  f.publications.publishAndCommit = async (...args) => { reached(); await gate; return publish(...args); };
  const images = withImage ? [await f.upload()] : [];
  const pending = f.service.accept("s1", { workspaceId: "w1", clientRequestId: "spanning-stop", text: "old send", images });
  const rejected = assert.rejects(pending, errorIs(409, "AGENT_QUEUE_STOP_GENERATION_CHANGED"));
  await started;
  const stopped = f.service.stop(scope, "crossed-stop"); assert.equal(stopped.queue.stop.state, "quiescent");
  release(); await rejected;
  assert.equal(f.store.snapshot(scope).mode, "paused"); assert.equal(f.store.snapshot(scope).pendingCount, 0);
  assert.equal(f.store.getByRequest({ ...scope, clientRequestId: "spanning-stop" }), null);
  assert.equal(f.enqueued.length, 0);
  const next = await f.accept("explicit-new-send"); assert.equal(next.queue.mode, "active");
});

test("pending and unknown Stop reject new sends; accepted request replay does not restart or change Stop", async t => {
  const f = await queueFixture(t); const original = await f.accept("already-accepted");
  const active = await f.dispatcher.dispatchSession(scope); assert.ok(active);
  const stopped = f.service.stop(scope, "pending-stop"); assert.equal(stopped.queue.stop.state, "pending");
  await assert.rejects(f.accept("blocked-pending"), errorIs(409, "AGENT_SESSION_STOP_PENDING"));
  f.db.prepare("update agent_session_stop_barrier set state='unknown' where operation_id='pending-stop'").run();
  await assert.rejects(f.accept("blocked-unknown"), errorIs(409, "AGENT_SESSION_STOP_UNKNOWN"));
  const before = f.store.snapshot(scope), enqueued = f.enqueued.length;
  const replay = await f.accept("already-accepted");
  assert.equal(replay.deduplicated, true); assert.equal(replay.receipt.id, original.receipt.id);
  assert.deepEqual(f.store.snapshot(scope), before); assert.equal(f.enqueued.length, enqueued);
});

test("sending after failed Run atomically resumes original unconfirmed inputs without another user or old tool replay", async t => {
  const f = await queueFixture(t); const original = await f.accept("original-input"); await f.accept("older-queued");
  const active = await f.dispatcher.dispatchSession(scope); assert.ok(active);
  const trigger = f.store.get(scope, original.receipt.id).message_id;
  f.finish(active.runId, "failed");
  f.runtimeStore.retireAdmission({ ...scope, runId: active.runId, runtimeInstanceId: f.runtimeInstanceId });
  const usersBefore = f.db.prepare("select count(*) as n from agent_message where type='user'").get();
  const accepted = await f.accept("new-send-resumes");
  assert.equal(accepted.queue.mode, "active"); assert.equal(accepted.queue.pendingCount, 2);
  assert.equal(f.enqueued.length, 2); const continued = f.enqueued[1]!;
  assert.notEqual(continued.runId, active.runId);
  const row = f.db.prepare("select trigger_message_id from agent_run where run_id=?").get(continued.runId) as { trigger_message_id: string };
  assert.equal(row.trigger_message_id, trigger);
  assert.deepEqual(f.db.prepare("select count(*) as n from agent_message where type='user'").get(), usersBefore);
  assert.deepEqual(f.db.prepare("select receipt_id from agent_interactive_run_input where run_id=?").all(continued.runId), [{ receipt_id: original.receipt.id }]);
  assert.equal((f.db.prepare("select count(*) as n from agent_tool_execution").get() as { n: number }).n, 0);
});

test("send recovery activation failure rolls back receipt and paused control together", async t => {
  const f = await queueFixture(t); f.store.pause(scope, "user_stop");
  const { AgentQueueRecoveryStore } = await import("./queue-recovery.store.js");
  const activate = AgentQueueRecoveryStore.prototype.activateForSend;
  AgentQueueRecoveryStore.prototype.activateForSend = () => { throw new Error("controlled activation failure"); };
  const before = f.store.snapshot(scope);
  try { await assert.rejects(f.accept("rollback-send"), errorIs(503)); }
  finally { AgentQueueRecoveryStore.prototype.activateForSend = activate; }
  assert.deepEqual(f.store.snapshot(scope), before);
  assert.equal(f.store.getByRequest({ ...scope, clientRequestId: "rollback-send" }), null);
  assert.equal((f.db.prepare("select count(*) as n from agent_run").get() as { n: number }).n, 0);
});

test("Stop COMMIT failure rolls back cancellation, pause, barrier and operation together", async t => {
  const f = await queueFixture(t); const receipt = await f.accept("stop-rollback"); const before = f.store.snapshot(scope);
  f.db.exec(`create temp table stop_commit_parent(id integer primary key);
    create temp table stop_commit_child(id integer references stop_commit_parent(id) deferrable initially deferred);
    create temp trigger reject_web_stop after insert on agent_queue_operation when new.operation_id='rollback-stop'
    begin insert into stop_commit_child values(1); end`);
  assert.throws(() => f.service.stop(scope, "rollback-stop"), /FOREIGN KEY constraint failed/);
  assert.deepEqual(f.store.snapshot(scope), before); assert.equal(f.store.get(scope, receipt.receipt.id).status, "queued");
  assert.equal(f.db.prepare("select 1 from agent_queue_operation where operation_id='rollback-stop'").get(), undefined);
});

test("generic recovery Stop does not inherit the Web-only clear policy", async t => {
  const f = await queueFixture(t); const receipt = await f.accept("recovery-keeps-queued");
  f.runtime.stopSession({ workspaceId: scope.workspaceId, rootSessionId: scope.sessionId, operationId: "generic-recovery", reason: "recovery_required" });
  assert.equal(f.store.get(scope, receipt.receipt.id).status, "queued");
  assert.equal(f.store.snapshot(scope).pauseCode, "recovery_required");
});

test("send rechecks profile inside final publication transaction and does not clear a failed pause", async t => {
  const f = await queueFixture(t); f.store.pause(scope, "run_failed");
  const before = f.store.snapshot(scope);
  const publish = f.publications.publishAndCommit.bind(f.publications);
  f.publications.publishAndCommit = async (...args) => { f.setProfileError(new HttpError(409, "Profile unavailable", "AGENT_QUEUE_AGENT_CONFLICT")); return publish(...args); };
  await assert.rejects(f.accept("profile-changed"), errorIs(409, "AGENT_QUEUE_AGENT_CONFLICT"));
  assert.deepEqual(f.store.snapshot(scope), before); assert.equal(f.store.getByRequest({ ...scope, clientRequestId: "profile-changed" }), null);
});


test("fresh Session uses shared initial Stop generation; Stop during creation response fences its first send", async t => {
  const f = await queueFixture(t);
  assert.equal(f.service.captureStopGeneration(scope.sessionId), AGENT_QUEUE_INITIAL_STOP_GENERATION);
  assert.equal(f.store.snapshot(scope).stopGeneration, AGENT_QUEUE_INITIAL_STOP_GENERATION);
  const image = await f.upload();
  const beforeStop = { ...scope, clientRequestId: "fresh-first-send", text: "retained first draft", images: [image], stopGeneration: AGENT_QUEUE_INITIAL_STOP_GENERATION };
  const stopped = f.service.stop(scope, "stop-before-first-send");
  assert.equal(stopped.queue.stop.state, "quiescent"); assert.notEqual(stopped.queue.stopGeneration, AGENT_QUEUE_INITIAL_STOP_GENERATION);
  await assert.rejects(f.service.accept(scope.sessionId, beforeStop), errorIs(409, "AGENT_QUEUE_STOP_GENERATION_CHANGED"));
  assert.deepEqual(f.store.snapshot(scope), stopped.queue); assert.equal(f.enqueued.length, 0);
  // A new HTTP attempt stages the retained File again; rejected request temps are cleaned.
  const explicit = await f.service.accept(scope.sessionId, { ...beforeStop, images: [await f.upload()], stopGeneration: stopped.queue.stopGeneration });
  assert.equal(explicit.queue.mode, "active"); assert.equal(explicit.receipt.status, "queued");
  assert.equal(f.store.attachments(scope, explicit.receipt.id).length, 1);
});
