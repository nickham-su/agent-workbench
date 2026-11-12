import assert from "node:assert/strict";
import test from "node:test";
import { AgentRuntimeRetirementNotifier, MAX_RUNTIME_RETIREMENTS } from "../src/node/agent-runtime-retirement.js";
const identity = { workspaceId:"w",sessionId:"s",runId:"r",runtimeInstanceId:"original-instance" };
for (const mode of ["request_lost", "several_failures", "response_lost"] as const) test(`retirement retries fixed identity after ${mode} without re-executing`, async () => {
  let calls = 0, commits = 0, committed = false, warnings = 0;
  const notifier = new AgentRuntimeRetirementNotifier(async input => {
    assert.deepEqual(input,identity); calls++;
    if (mode === "request_lost" && calls === 1 || mode === "several_failures" && calls <= 3) throw new Error("offline");
    if (!committed) { committed = true; commits++; }
    if (mode === "response_lost" && calls === 1) throw new Error("lost reply");
    return {retired:true};
  }, () => warnings++, 1);
  const execution = {...identity, workspacePath:"synthetic-local-path", inputText:"synthetic-input-not-retained"};
  notifier.reserve(execution); notifier.notifyExited(execution); notifier.notifyExited(identity);
  assert.equal(await notifier.drain(1000),true);
  assert.equal(notifier.size,0); assert.equal(commits,1); assert.equal(warnings,1);
  assert.equal(calls,mode === "several_failures" ? 4 : 2);
});
test("retirement reservations bound active plus pending; unstarted release and shutdown drain never invent proof", async () => {
  const notifier = new AgentRuntimeRetirementNotifier(async () => ({retired:false}), () => {}, 1);
  for(let index=0;index<MAX_RUNTIME_RETIREMENTS;index++) notifier.reserve({...identity,runId:String(index)});
  assert.throws(() => notifier.reserve(identity), /CAPACITY/);
  notifier.releaseUnstarted({...identity,runId:"0"}); notifier.reserve(identity);
  assert.equal(notifier.size,MAX_RUNTIME_RETIREMENTS);
  assert.equal(await notifier.drain(1),false);
});
