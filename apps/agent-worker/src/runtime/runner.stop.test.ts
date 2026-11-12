import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { test } from "node:test";
import { runtimeStopTargetsHash } from "@agent-workbench/shared/node/agent-run-stop";
import { AgentWorkerEndpoints } from "@agent-workbench/shared/internal-contracts/endpoints";
import type { AgentWorkerStopRunsRequest } from "@agent-workbench/shared/internal-contracts/agent-worker";
import { AgentRunner, processNestedRunWithControllerForTest, getRegisteredControllerForTest } from "./runner.js";
import { createWorkerServer } from "../server.js";
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}
function run(instance: string, sessionId = "s", runId = "r") {
    return { workspaceId: "w", sessionId, runId, runtimeInstanceId: instance, workspacePath: process.cwd(), workspaceRepoDirNames: [] };
}
function stop(instance: string, targets = [{ sessionId: "s", runId: "r" }], operationId = "stop"): AgentWorkerStopRunsRequest {
    const scope = { workspaceId: "w", rootSessionId: "s", operationId };
    return { ...scope, runtimeInstanceId: instance, targets, timeoutMs: 1, targetsHash: runtimeStopTargetsHash({ ...scope, targets: targets.map(target => ({ ...target, runtimeInstanceId: instance })) }) };
}
function fixture(concurrency = 1) {
    const instance = randomUUID();
    const api = { async checkRuntimeAdmission() { return { admitted: true, bindingMatches: true }; }, async retireRuntimeAdmission() { return { retired: true }; } };
    const runner = new AgentRunner(api as any, {} as any, { info() { }, warn() { }, error() { } }, concurrency, { runtimeInstanceId: instance });
    return { instance, api, runner };
}
test("production enqueue rechecks tombstone after asynchronous admission returns", async () => {
    const { instance, api, runner } = fixture(0);
    const gate = deferred<{
        admitted: boolean;
        bindingMatches: boolean;
    }>();
    let calls = 0;
    api.checkRuntimeAdmission = async () => ++calls === 1 ? await gate.promise : { admitted: true, bindingMatches: true };
    const enqueue = runner.enqueueRunAdmitted(run(instance));
    assert.equal((await runner.stopRunsAndWait(stop(instance))).state, "quiescent");
    gate.resolve({ admitted: true, bindingMatches: true });
    await assert.rejects(enqueue, /BINDING_MISMATCH/);
    assert.equal(runner.analyticsLiveSnapshot().queueLength, 0);
});
test("precise cancellation tracks nested outside root activeRunIds, aborts exact controller and waits finally", async () => {
    const { instance, runner } = fixture();
    const entered = deferred<AbortSignal>();
    const finish = deferred<void>();
    (runner as any).processRun = async (_run: unknown, signal: AbortSignal) => { entered.resolve(signal); await finish.promise; };
    const processing = processNestedRunWithControllerForTest(runner, { parentSessionId: "parent", run: run(instance), parentSignal: new AbortController().signal });
    const signal = await entered.promise;
    assert.equal((runner as any).activeRunIds.has("r"), false);
    assert.equal((await runner.stopRunsAndWait(stop(instance))).state, "pending");
    assert.equal(signal.aborted, true);
    assert.ok(getRegisteredControllerForTest(runner, "s"));
    finish.resolve();
    await processing;
    const proof = await runner.stopRunsAndWait(stop(instance));
    assert.equal(proof.state, "quiescent");
    const fresh = new AbortController();
    (runner as any).controllers.set("s", fresh);
    await runner.stopRunsAndWait(stop(instance));
    assert.equal(fresh.signal.aborted, false);
});
test("root finally remains tracked while abort-ignoring tool work is pending", async () => {
    const { instance, runner } = fixture();
    const entered = deferred<AbortSignal>();
    const finish = deferred<void>();
    (runner as any).processRun = async (_run: unknown, signal: AbortSignal) => { entered.resolve(signal); await finish.promise; };
    await runner.enqueueRunAdmitted(run(instance));
    const signal = await entered.promise;
    assert.equal((await runner.stopRunsAndWait(stop(instance))).state, "pending");
    assert.equal(signal.aborted, true);
    finish.resolve();
    while (runner.analyticsLiveSnapshot().activeCount)
        await new Promise(resolve => setImmediate(resolve));
    assert.equal((await runner.stopRunsAndWait(stop(instance))).state, "quiescent");
});
test("real HTTP precise stop is authenticated, strict, incarnation-bound and idempotent", async (t) => {
    const { instance, runner } = fixture(0);
    const portServer = createServer();
    await new Promise<void>(resolve => portServer.listen(0, "127.0.0.1", resolve));
    const address = portServer.address();
    assert.ok(address && typeof address !== "string");
    const port = address.port;
    await new Promise<void>(resolve => portServer.close(() => resolve()));
    const server = createWorkerServer({ host: "127.0.0.1", port, socketPath: null, internalToken: "stop-test-token", runner });
    await server.listen();
    t.after(() => server.close());
    const origin = `http://127.0.0.1:${port}`;
    async function post(body: unknown, authenticated = true) {
        return await fetch(origin + AgentWorkerEndpoints.stopRunsAndWait.path, { method: "POST", headers: { "content-type": "application/json", ...(authenticated ? { "x-awb-agent-internal-token": "stop-test-token" } : {}) }, body: JSON.stringify(body) });
    }
    assert.equal((await post(stop(instance), false)).status, 401);
    const identity = await fetch(origin + AgentWorkerEndpoints.runtimeIdentity.path, { headers: { "x-awb-agent-internal-token": "stop-test-token" } });
    assert.equal((await identity.json() as {
        runtimeInstanceId: string;
    }).runtimeInstanceId, instance);
    await runner.enqueueRunAdmitted(run(instance));
    assert.equal((await post({ ...stop(instance), extra: true })).status, 400);
    assert.equal((await post(stop(randomUUID()))).status, 409);
    assert.equal(runner.analyticsLiveSnapshot().queueLength, 1, "wrong instance must cancel nothing");
    const proof = await (await post(stop(instance))).json();
    assert.equal((proof as {
        state: string;
    }).state, "quiescent");
    assert.equal(runner.analyticsLiveSnapshot().queueLength, 0);
    assert.deepEqual(await (await post({ ...stop(instance), timeoutMs: 10 })).json(), proof);
    assert.equal((await post(stop(instance, [{ sessionId: "s", runId: "different" }]))).status, 409);
    await assert.rejects(runner.enqueueRunAdmitted({ ...run(instance), runtimeInstanceId: undefined }), /INSTANCE_MISMATCH/);
});
for (const lateReply of ["allow", "error"] as const) {
test(`root pump admission after Stop (${lateReply}) cannot execute, reenter, or disturb its successor`, async () => {
    const { instance, api, runner } = fixture();
    const entered = deferred<void>();
    const gate = deferred<{
        admitted: boolean;
        bindingMatches: boolean;
    }>();
    const successorEntered = deferred<void>();
    const successorFinished = deferred<void>();
    let checks = 0;
    const executed: string[] = [];
    api.checkRuntimeAdmission = async () => {
        checks++;
        if (checks === 2) {
            entered.resolve();
            return await gate.promise;
        }
        return { admitted: true, bindingMatches: true };
    };
    (runner as any).processRun = async (input: { runId: string }) => {
        executed.push(input.runId);
        successorEntered.resolve();
        await successorFinished.promise;
    };
    await runner.enqueueRunAdmitted(run(instance));
    await entered.promise;
    const proof = await runner.stopRunsAndWait({ ...stop(instance), timeoutMs: 100 });
    // The abort-aware tracked promise has finished its finally, although the
    // read-only transport is still pending. This is real registry quiescence.
    assert.equal(proof.state, "quiescent");
    assert.equal(runner.analyticsLiveSnapshot().activeCount, 0);
    assert.equal((runner as any).stopRegistry.size, 0);
    assert.equal(getRegisteredControllerForTest(runner, "s"), undefined);
    assert.deepEqual(executed, []);
    await assert.rejects(runner.enqueueRunAdmitted(run(instance)), /BINDING_MISMATCH/);

    // A different Run in the same Session must retain its own controller and
    // registration when the old transport finally answers or rejects.
    await runner.enqueueRunAdmitted(run(instance, "s", "successor"));
    await successorEntered.promise;
    const successorController = getRegisteredControllerForTest(runner, "s")!;
    assert.equal(successorController.signal.aborted, false);
    if (lateReply === "allow") gate.resolve({ admitted: true, bindingMatches: true });
    else gate.reject(new Error("late transport failure"));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(await runner.stopRunsAndWait(stop(instance)), proof);
    await assert.rejects(runner.enqueueRunAdmitted(run(instance)), /BINDING_MISMATCH/);
    assert.equal(runner.analyticsLiveSnapshot().activeCount, 1);
    assert.equal((runner as any).stopRegistry.size, 1);
    assert.equal(getRegisteredControllerForTest(runner, "s"), successorController);
    assert.equal(successorController.signal.aborted, false);
    assert.deepEqual(executed, ["successor"]);
    successorFinished.resolve();
    while (runner.analyticsLiveSnapshot().activeCount)
        await new Promise(resolve => setImmediate(resolve));
    assert.equal((runner as any).stopRegistry.size, 0);
    assert.equal(getRegisteredControllerForTest(runner, "s"), undefined);
    assert.deepEqual(executed, ["successor"]);
    assert.deepEqual(await runner.stopRunsAndWait(stop(instance)), proof);
});
}


test("pump admission outage keeps the exact Runner until recovery, including duplicate enqueue",async()=>{
  const instance=randomUUID();const waiting=deferred<void>();const retry=deferred<boolean>();const executed=deferred<void>();
  let checks=0;let executions=0;let terminalWrites=0;
  const api={async checkRuntimeAdmission(){if(++checks===2)throw new Error("fixture transport unavailable");return {admitted:true,bindingMatches:true};},async retireRuntimeAdmission(){return {retired:true};}};
  const runner=new AgentRunner(api as any,{} as any,{info(){},warn(){},error(){}},1,{runtimeInstanceId:instance,controlWriteSleep:async(ms,signal)=>{assert.equal(ms,100);assert.equal(signal.aborted,false);waiting.resolve();return await retry.promise;}});
  (runner as any).processRun=async()=>{executions++;terminalWrites++;executed.resolve();};
  await runner.enqueueRunAdmitted(run(instance));await waiting.promise;
  assert.equal(runner.analyticsLiveSnapshot().activeCount,1);assert.equal(executions,0);
  await runner.enqueueRunAdmitted(run(instance));assert.equal(runner.analyticsLiveSnapshot().activeCount,1);
  retry.resolve(true);await executed.promise;
  while(runner.analyticsLiveSnapshot().activeCount) await new Promise(resolve=>setImmediate(resolve));
  assert.equal(executions,1);assert.equal(terminalWrites,1);
  await assert.rejects(runner.enqueueRunAdmitted(run(instance)),/BINDING_MISMATCH/);
});

test("Stop interrupts pump admission backoff and a late positive reply after transport recovery cannot resurrect it",async()=>{
  const {instance,api,runner}=fixture();const waiting=deferred<void>();const late=deferred<{admitted:boolean;bindingMatches:boolean}>();
  let checks=0;let executions=0;
  api.checkRuntimeAdmission=async()=>{
    checks++;
    if(checks===2) throw new Error("fixture transport unavailable");
    if(checks===3) {waiting.resolve();return await late.promise;}
    return {admitted:true,bindingMatches:true};
  };
  (runner as any).processRun=async()=>{executions++;};
  await runner.enqueueRunAdmitted(run(instance));await waiting.promise;
  const proof=await runner.stopRunsAndWait({...stop(instance),timeoutMs:100});
  assert.equal(proof.state,"quiescent");assert.equal(executions,0);
  late.resolve({admitted:true,bindingMatches:true});
  await assert.rejects(runner.enqueueRunAdmitted(run(instance)),/BINDING_MISMATCH/);
  assert.deepEqual(await runner.stopRunsAndWait(stop(instance)),proof);
  assert.equal(runner.analyticsLiveSnapshot().activeCount,0);assert.equal(executions,0);
});

test("pump admission retries keep their registration and cap control-plane backoff without Provider attempts", async () => {
    const instance = randomUUID();
    const delays: number[] = [];
    const executed = deferred<void>();
    let checks = 0;
    const api = {
        async checkRuntimeAdmission() {
            if (++checks > 1 && checks <= 10) throw new Error("fixture API unavailable");
            return { admitted: true, bindingMatches: true };
        },
        async retireRuntimeAdmission() { return { retired: true }; },
    };
    const runner = new AgentRunner(api as any, {} as any, { info() {}, warn() {}, error() {} }, 1, {
        runtimeInstanceId: instance,
        controlWriteSleep: async (ms, signal) => {
            assert.equal(signal.aborted, false);
            assert.equal(runner.analyticsLiveSnapshot().activeCount, 1);
            assert.equal((runner as any).stopRegistry.size, 1);
            delays.push(ms);
            return true;
        },
    });
    (runner as any).processRun = async () => { executed.resolve(); };
    await runner.enqueueRunAdmitted(run(instance));
    await executed.promise;
    while (runner.analyticsLiveSnapshot().activeCount) await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(delays, [100, 200, 400, 800, 1600, 3200, 5000, 5000, 5000]);
    assert.equal(checks, 11);
    assert.equal((runner as any).stopRegistry.size, 0);
});

for (const nested of [false,true]) test(`real ${nested ? "nested" : "ordinary"} finally retries retirement with fixed incarnation`, async () => {
    const {instance,api,runner}=fixture(); let attempts=0,executions=0;
    const retired=deferred<void>();
    api.retireRuntimeAdmission=async (...args: unknown[])=>{assert.equal((args[0] as any).runtimeInstanceId,instance);if(++attempts<=3) throw new Error("offline");retired.resolve();return {retired:true};};
    (runner as any).processRun=async ()=>{executions++;};
    if(nested) await processNestedRunWithControllerForTest(runner,{parentSessionId:"p",run:run(instance),parentSignal:new AbortController().signal});
    else runner.enqueueRun(run(instance));
    await Promise.race([retired.promise,new Promise((_,reject)=>setTimeout(()=>reject(new Error("retirement did not recover")),3000).unref())]);
    assert.equal(executions,1);assert.equal(attempts,4);assert.equal((runner as any).stopRegistry.size,0);
    assert.equal(await runner.shutdownRetirements(),true);
});
