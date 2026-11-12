import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "@sinclair/typebox/value";
import { AGENT_QUEUE_MAX_PENDING_BYTES, AgentMessageQueueSnapshotSchema } from "@agent-workbench/shared";
import { convergeRunTerminal, getMessageSessionHead, getMessageRunState, getRunRecord, persistRunTerminalIntent, updateMessageRunNotice } from "../agent-message.store.js";
import { scope, queueFixture, errorIs } from "./message-queue.testkit.js";

const supplement = (runId: string, clientRequestId: string, text = "extra") => ({ ...scope, targetRunId: runId, clientRequestId, text });

test("ordinary send atomically creates one formal user and Run; duplicate never enqueues twice", async t => {
  const f = await queueFixture(t);
  const first = await f.accept("first", "hello");
  assert.equal(first.receipt.status, "injected");
  assert.equal(first.queue.pendingCount, 0);

  assert.equal(f.enqueued.length, 1);
  const again = await f.service.accept(scope.sessionId, { ...scope, clientRequestId: "first", text: "hello" });
  assert.equal(again.deduplicated, true);
  assert.deepEqual(again.receipt, first.receipt);
  assert.equal(f.enqueued.length, 1);
  assert.equal((f.db.prepare("select count(*) as n from agent_message where type='user'").get() as {n:number}).n, 1);
  assert.ok(Value.Check(AgentMessageQueueSnapshotSchema, first.queue));
  assert.equal("mode" in first.queue, false); assert.equal("pauseCode" in first.queue, false);
});

test("supplements are FIFO, Run-scoped, and do not change formal history or start another Run", async t => {
  const f = await queueFixture(t); const first = await f.accept("first");
  assert.equal(first.receipt.status, "injected");
  const head = getMessageSessionHead(f.db, scope);
  const [a,b] = await Promise.all([f.accept("a"), f.accept("b")]);
  assert.equal(a.receipt.status, "queued"); assert.equal(b.receipt.status, "queued");
  assert.deepEqual(f.store.listQueued(scope).map(row => row.client_request_id), ["a", "b"]);
  assert.equal(f.store.listQueued(scope)[0]!.target_run_id, first.receipt.runId);
  assert.deepEqual(getMessageSessionHead(f.db, scope), head);
  assert.equal(f.enqueued.length, 1);
  await assert.rejects(f.service.accept(scope.sessionId, supplement("another-run", "wrong")), errorIs(409, "AGENT_SUPPLEMENT_TARGET_CLOSED"));
  await assert.rejects(f.service.accept(scope.sessionId, { ...scope, clientRequestId: "ordinary-while-running", text: "hello" }), errorIs(409));
});

test("cancelled supplements keep dedup tombstones without retrying delivery", async t => {
  const f = await queueFixture(t); const first = await f.accept("first"); assert.equal(first.receipt.status,"injected");
  const payload = supplement(first.receipt.runId, "cancel-me", " exact text ");
  const accepted = await f.service.accept(scope.sessionId, payload);
  const cancelled = f.service.cancel(scope, accepted.receipt.id);
  assert.equal(cancelled.receipt.status,"cancelled");
  assert.equal(f.service.detail(scope, accepted.receipt.id).inputText, null);
  assert.equal((await f.service.accept(scope.sessionId, payload)).receipt.status,"cancelled");
  await assert.rejects(f.service.accept(scope.sessionId, {...payload,text:"changed"}), errorIs(409,"AGENT_REQUEST_PAYLOAD_CONFLICT"));
  assert.equal(f.enqueued.length, 1);
});

test("input validation rejects only the new supplement; count, UTF-8 and byte limits remain bounded", async t => {
  const f = await queueFixture(t); await f.accept("first");
  await assert.rejects(f.accept("wide","中".repeat(21846)),errorIs(413,"AGENT_QUEUE_TEXT_TOO_LARGE"));
  for (let i=0;i<100;i++) await f.accept(`q-${i}`);
  await assert.rejects(f.accept("over"),errorIs(429,"AGENT_QUEUE_CAPACITY_EXCEEDED"));
  assert.equal(f.store.snapshot(scope).pendingCount,100);
  const row=f.store.listQueued(scope)[0]!;
  f.service.cancel(scope,row.id);
  f.db.prepare("update agent_user_message_receipt set payload_bytes=? where id=?").run(AGENT_QUEUE_MAX_PENDING_BYTES,f.store.listQueued(scope)[0]!.id);
  await assert.rejects(f.accept("bytes"),errorIs(429));
  assert.equal(f.store.snapshot(scope).pendingCount,99);
});

for (const status of ["completed","failed","cancelled"] as const) test(`${status} terminal drops only unconsumed supplements and preserves formal inputs`,async t=>{
  const f=await queueFixture(t); const first=await f.accept("first"); assert.equal(first.receipt.status,"injected");
  const queued=await f.accept("remaining");
  f.finish(first.receipt.runId,status);
  assert.equal(f.store.get(scope,queued.receipt.id).status,"cancelled");
  assert.equal(f.store.get(scope,first.receipt.id).injected_run_id,first.receipt.runId);
  assert.equal(f.store.snapshot(scope).pendingCount,0);
  assert.equal((f.db.prepare("select count(*) as n from agent_message where type='user'").get() as {n:number}).n,1);
  assert.equal(f.enqueued.length,1);
});

test("terminal failure notice closes input immediately, before final convergence; replay cannot touch a later Run",async t=>{
  const f=await queueFixture(t); const first=await f.accept("first"); assert.equal(first.receipt.status,"injected");
  const run={...scope,runId:first.receipt.runId}; await f.accept("extra");
  const notice={...run,runNoticeText:"budget_exhausted",terminalFailure:true,updatedAt:Date.now()};
  assert.equal(updateMessageRunNotice(f.db,notice),"updated");
  assert.equal(getRunRecord(f.db,run.runId)!.executionPhase,"terminal_intent_persisted");
  assert.equal(f.store.snapshot(scope).pendingCount,0);
  await assert.rejects(f.service.accept(scope.sessionId,supplement(run.runId,"too-late")),errorIs(409));
  f.finish(run.runId,"failed"); f.runtimeStore.retireAdmission({...run,runtimeInstanceId:f.runtimeInstanceId});
  const next=await f.accept("new-explicit-send"); assert.equal(next.receipt.status,"injected");
  const newExtra=await f.accept("new-extra");
  assert.equal(updateMessageRunNotice(f.db,notice),"ignored");
  convergeRunTerminal(f.db,{...run,updatedAt:Date.now()});
  assert.equal(f.store.get(scope,newExtra.receipt.id).status,"queued");
});

for (const image of [false,true]) test(`late ${image?"image":"text"} supplement spanning terminal and next Run cannot leak to it`,async t=>{
  const f=await queueFixture(t); const first=await f.accept("first"); assert.equal(first.receipt.status,"injected");
  let entered!:()=>void, release!:()=>void;
  const started=new Promise<void>(r=>entered=r), gate=new Promise<void>(r=>release=r);
  const publish=f.publications.publishAndCommit.bind(f.publications);
  f.publications.publishAndCommit=async(...args)=>{ entered(); await gate; return publish(...args); };
  const pending=f.service.accept(scope.sessionId,{...supplement(first.receipt.runId,"late"),images:image?[await f.upload()]:[]});
  const rejected=assert.rejects(pending,errorIs(409,"AGENT_SUPPLEMENT_TARGET_CLOSED")); await started;
  f.finish(first.receipt.runId,"failed"); f.runtimeStore.retireAdmission({...scope,runId:first.receipt.runId,runtimeInstanceId:f.runtimeInstanceId});
  f.publications.publishAndCommit=publish;
  await f.accept("next"); release(); await rejected;
  assert.equal(f.store.getByRequest({...scope,clientRequestId:"late"}),null);
  assert.equal(f.enqueued.length,2); assert.equal(f.store.snapshot(scope).pendingCount,0);
});

for (const image of [false,true]) test(`in-flight ordinary ${image?"image":"text"} send spanning Stop retains the Stop-generation fence`,async t=>{
  const f=await queueFixture(t); let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
  const publish=f.publications.publishAndCommit.bind(f.publications);
  f.publications.publishAndCommit=async(...args)=>{entered();await gate;return publish(...args);};
  const pending=f.service.accept(scope.sessionId,{...scope,clientRequestId:"old",text:"hello",images:image?[await f.upload()]:[]});
  const rejected=assert.rejects(pending,errorIs(409,"AGENT_QUEUE_STOP_GENERATION_CHANGED")); await started;
  f.service.stop(scope,"crossed-stop");release();await rejected;
  assert.equal(f.enqueued.length,0);assert.equal(f.store.snapshot(scope).pendingCount,0);
});

test("Stop clears supplements, rejects pending/unknown inputs, and replay never re-targets",async t=>{
  const f=await queueFixture(t); const first=await f.accept("first"); await f.accept("extra");
  const stopped=f.service.stop(scope,"stop");assert.equal(stopped.queue.pendingCount,0);assert.equal(stopped.queue.stop.state,"pending");
  await assert.rejects(f.accept("blocked"),errorIs(409,"AGENT_SESSION_STOP_PENDING"));
  f.db.prepare("update agent_session_stop_barrier set state='unknown' where operation_id='stop'").run();
  await assert.rejects(f.accept("blocked-again"),errorIs(409,"AGENT_SESSION_STOP_UNKNOWN"));
  assert.equal((await f.service.accept(scope.sessionId,{...scope,clientRequestId:"first",text:"hello"})).receipt.id,first.receipt.id);
  assert.equal(f.service.stop(scope,"stop").stopOperation.operationId,"stop");
  assert.equal(f.enqueued.length,1);
});

test("explicit ordinary send after failure triggers a new message without reclaiming old receipts",async t=>{
  const f=await queueFixture(t);const old=await f.accept("old");assert.equal(old.receipt.status,"injected");await f.accept("discard");
  f.finish(old.receipt.runId,"failed");f.runtimeStore.retireAdmission({...scope,runId:old.receipt.runId,runtimeInstanceId:f.runtimeInstanceId});
  const next=await f.accept("next");assert.equal(next.receipt.status,"injected");
  assert.equal((f.db.prepare("select count(*) as n from agent_message where type='user'").get() as {n:number}).n,2);
  const bound=f.db.prepare("select id from agent_user_message_receipt where injected_run_id=?").all(next.receipt.runId) as Array<{id:string}>;
  assert.deepEqual(bound.map(r=>r.id),[next.receipt.id]);
  assert.equal(f.store.get(scope,old.receipt.id).injected_run_id,old.receipt.runId);
  assert.notEqual(next.receipt.runId,old.receipt.runId);
  assert.notEqual(next.receipt.messageId,old.receipt.messageId);
  assert.equal(getRunRecord(f.db,next.receipt.runId)!.triggerMessageId,next.receipt.messageId);
  assert.equal(getMessageRunState(f.db,scope.workspaceId,scope.sessionId)!.activeRunId,next.receipt.runId);
});

test("dropping image supplements preserves publication retention charge and formal history",async t=>{
  const f=await queueFixture(t);const first=await f.accept("first");assert.equal(first.receipt.status,"injected");
  const accepted=await f.service.accept(scope.sessionId,{...supplement(first.receipt.runId,"image"),images:[await f.upload()]});
  const before=f.service.retention().chargedBytes;
  f.finish(first.receipt.runId,"failed");
  assert.equal(f.store.get(scope,accepted.receipt.id).status,"cancelled");
  assert.equal(f.store.attachments(scope,accepted.receipt.id).length,0);
  assert.equal(f.service.retention().chargedBytes,before);
  assert.equal((f.db.prepare("select state from agent_attachment_publication_intent where receipt_id=?").get(accepted.receipt.id) as {state:string}).state,"retained");
});


test("Stop wins over a late terminal-failure notice without changing its terminal tuple", async t => {
  const f = await queueFixture(t), first = await f.accept("stop-notice");
  assert.equal(first.receipt.status, "injected"); const runId = first.receipt.runId; await f.accept("discarded");
  f.service.stop(scope, "stop-before-failure-notice");
  const before = getRunRecord(f.db, first.receipt.runId)!;
  assert.equal(updateMessageRunNotice(f.db, { ...scope, runId,
    runNoticeText: "budget_exhausted", terminalFailure: true, updatedAt: Date.now() }), "ignored");
  assert.deepEqual(getRunRecord(f.db, first.receipt.runId), before);
  assert.equal(f.store.snapshot(scope).pendingCount, 0);
});


test("ordinary send with an unknown handoff retains exactly one formal user and Run under request replay", async t => {
  const f = await queueFixture(t);
  f.setEnqueueError(new Error("lost handoff acknowledgement"));
  const request = { ...scope, clientRequestId: "unknown-ordinary", text: "hello" };
  await assert.rejects(f.service.accept(scope.sessionId, request), errorIs(503, "AGENT_WORKER_ENQUEUE_UNKNOWN"));
  const retained = f.service.byRequest({ ...scope, clientRequestId: request.clientRequestId });
  assert.equal(retained.receipt.status, "injected");
  assert.equal(f.store.snapshot(scope).pendingCount, 0);
  const replay = await f.service.accept(scope.sessionId, request);
  assert.equal(replay.deduplicated, true); assert.equal(replay.receipt.id, retained.receipt.id);
  assert.equal(f.enqueued.length, 1);
  assert.equal((f.db.prepare("select count(*) as n from agent_message where type='user'").get() as { n: number }).n, 1);
  assert.equal((f.db.prepare("select count(*) as n from agent_run").get() as { n: number }).n, 1);
});
