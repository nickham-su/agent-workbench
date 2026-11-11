import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { Value } from "@sinclair/typebox/value";
import { AGENT_QUEUE_MAX_PENDING_BYTES, AgentMessageQueueSnapshotSchema } from "@agent-workbench/shared";
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

test("payload fingerprint, request namespace, cancellation tombstones and paused acceptance", async t => {
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
  assert.equal(f.service.snapshot(scope).mode, "paused");
  assert.equal(await f.dispatcher.dispatchSession(scope), null);
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
