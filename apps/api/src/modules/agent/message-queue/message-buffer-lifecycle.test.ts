import assert from "node:assert/strict";
import { test } from "node:test";
import { createMessageSession } from "../agent-message.store.js";
import { createAgentMessageQueueAssembly } from "./message-queue.assembly.js";
import { queueFixture, scope, identity } from "./message-queue.testkit.js";

test("API startup discards every legacy buffer once; Worker ready/reconnect preserves new supplements", async t => {
  const f = await queueFixture(t);
  const initial = await f.accept("ordinary"); assert.equal(initial.receipt.status,"injected");
  const old = await f.accept("old-extra");
  createMessageSession(f.db,{id:"orphan",workspaceId:scope.workspaceId,kind:"primary",title:"orphan",createdAt:1});
  const orphan={...scope,sessionId:"orphan"};
  const leftover=f.store.insert({...orphan,clientRequestId:"legacy-paused",payloadHash:"0".repeat(64),inputText:"orphaned",text:"orphaned",payloadBytes:8,identity,uiLocale:null,images:[]});
  const assembly=createAgentMessageQueueAssembly({db:f.db,dataDir:f.dataDir,lifecycle:f.lifecycle,runtimeControl:f.runtime,resolveProfile:f.resolveProfile});
  t.after(()=>assembly.close());
  assembly.openAfterRuntimeRecovery();
  assert.equal(f.store.get(scope,old.receipt.id).status,"cancelled");
  assert.equal(f.store.get(orphan,leftover.id).status,"cancelled");
  assert.equal(f.store.get(scope,initial.receipt.id).status,"injected");
  const fresh=await assembly.service.accept(scope.sessionId,{...scope,targetRunId:initial.receipt.runId,clientRequestId:"after-ready",text:"fresh"});
  assembly.openAfterRuntimeRecovery();assembly.openAfterRuntimeRecovery();
  assert.equal(f.store.get(scope,fresh.receipt.id).status,"queued");assert.equal(f.enqueued.length,1);
});
