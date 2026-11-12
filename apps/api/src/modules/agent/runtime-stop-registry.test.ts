import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { AgentRunStopRegistry, runtimeStopTargetsHash } from "@agent-workbench/shared/node/agent-run-stop";
import type { AgentWorkerStopRunsRequest } from "@agent-workbench/shared/internal-contracts/agent-worker";
function request(instance: string, runs = ["old"], operationId = "stop"): AgentWorkerStopRunsRequest {
    const scope = { workspaceId: "w", rootSessionId: "s", operationId };
    const targets = runs.map(runId => ({ sessionId: "s", runId }));
    return { ...scope, runtimeInstanceId: instance, targets, timeoutMs: 1,
        targetsHash: runtimeStopTargetsHash({ ...scope, targets: targets.map(target => ({ ...target, runtimeInstanceId: instance })) }) };
}
test("precise stop waits for root/nested finally, not DB terminal or abort dispatch", async () => {
    const registry = new AgentRunStopRegistry(randomUUID());
    const cancelled: string[] = [];
    const root = registry.register({ sessionId: "s", runId: "old" }, () => cancelled.push("root"))!;
    const nested = registry.register({ sessionId: "s", runId: "nested" }, () => cancelled.push("nested"))!;
    const input = request(registry.runtimeInstanceId, ["old", "nested"]);
    assert.equal((await registry.stopRunsAndWait(input, () => true)).state, "pending");
    assert.deepEqual(cancelled, ["root", "nested"]);
    registry.complete("old", root);
    assert.equal((await registry.stopRunsAndWait(input, () => true)).state, "pending");
    registry.complete("nested", nested);
    const proof = await registry.stopRunsAndWait(input, () => true);
    assert.equal(proof.state, "quiescent");
    assert.deepEqual(await registry.stopRunsAndWait({ ...input, timeoutMs: 20 }, () => true), proof);
});
test("admission reply delayed past quiescent cannot resurrect a queue/controller", async () => {
    const registry = new AgentRunStopRegistry(randomUUID());
    let release!: (admitted: boolean) => void;
    const admission = new Promise<boolean>(resolve => { release = resolve; });
    const lateEnqueue = (async () => {
        assert.equal(await admission, true);
        return registry.register({ sessionId: "s", runId: "old" }, () => assert.fail("late registration"));
    })();
    assert.equal((await registry.stopRunsAndWait(request(registry.runtimeInstanceId), () => true)).state, "quiescent");
    release(true);
    assert.equal(await lateEnqueue, null);
    assert.equal(registry.size, 0);
});
test("late old cancel never selects the new session controller", async () => {
    const registry = new AgentRunStopRegistry(randomUUID());
    let oldCancelled = 0;
    const token = registry.register({ sessionId: "s", runId: "old" }, () => { oldCancelled++; registry.complete("old", token!); })!;
    const input = request(registry.runtimeInstanceId);
    const proof = await registry.stopRunsAndWait(input, () => true);
    let freshCancelled = 0;
    registry.register({ sessionId: "s", runId: "fresh" }, () => freshCancelled++);
    assert.deepEqual(await registry.stopRunsAndWait(input, () => true), proof);
    assert.equal(oldCancelled, 1);
    assert.equal(freshCancelled, 0);
});
test("instance mismatch and untrusted binding cause zero cancellations", async () => {
    const registry = new AgentRunStopRegistry(randomUUID());
    let cancelled = 0;
    registry.register({ sessionId: "s", runId: "old" }, () => cancelled++);
    await assert.rejects(registry.stopRunsAndWait(request(randomUUID()), () => true), /INSTANCE_MISMATCH/);
    await assert.rejects(registry.stopRunsAndWait(request(registry.runtimeInstanceId), () => false), /BINDING_MISMATCH/);
    assert.equal(cancelled, 0);
    assert.equal(registry.mayRegister("old"), true);
});
test("operation fixes targets, excludes waiting budget, and rejects duplicate run IDs", async () => {
    const registry = new AgentRunStopRegistry(randomUUID());
    const input = request(registry.runtimeInstanceId);
    await registry.stopRunsAndWait(input, () => true);
    await assert.rejects(registry.stopRunsAndWait(request(registry.runtimeInstanceId, ["different"]), () => true), /OPERATION_CONFLICT/);
    await assert.rejects(registry.stopRunsAndWait(request(registry.runtimeInstanceId, ["old", "old"], "duplicate"), () => true), /OPERATION_CONFLICT/);
});
test("queued to active handoff requires the exact token; duplicates cannot overwrite tracked work", () => {
    const registry = new AgentRunStopRegistry(randomUUID());
    const scope = { sessionId: "s", runId: "old" };
    const queued = registry.register(scope, () => undefined)!;
    assert.throws(() => registry.register(scope, () => undefined), /BINDING_MISMATCH/);
    assert.equal(registry.activate(scope, Symbol(), () => undefined), null);
    const active = registry.activate(scope, queued, () => undefined)!;
    registry.complete("old", queued);
    assert.equal(registry.size, 1);
    assert.equal(registry.mayRegister("old"), true);
    registry.complete("old", active);
    assert.equal(registry.mayRegister("old"), false);
});
test("canonical target sorting is a UTF-8 tuple comparison, including embedded delimiters", () => {
    const instance = randomUUID();
    const scope = { workspaceId: "w", rootSessionId: "s", operationId: "stop" };
    const targets = [{ sessionId: "a\u0000b", runId: "c", runtimeInstanceId: instance }, { sessionId: "a", runId: "b\u0000c", runtimeInstanceId: instance }, { sessionId: "é", runId: "z", runtimeInstanceId: instance }];
    assert.equal(runtimeStopTargetsHash({ ...scope, targets }), runtimeStopTargetsHash({ ...scope, targets: [...targets].reverse() }));
});
