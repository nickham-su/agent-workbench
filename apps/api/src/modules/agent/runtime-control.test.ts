import fs from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";
import { AgentApiEndpoints } from "@agent-workbench/shared/internal-contracts/agent-api";
import { registerAgentRuntimeControlRoutes } from "./runtime-control/runtime-control.routes.js";
import { workspaceDeletingFence } from "./lifecycle/workspace-deleting-fence.js";
import { createRepoGitEnvLease, inspectRepoGitEnvLease, assertNoRepoGitEnvLeaseHold } from "../git-env/git-env.lease.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import Database from "better-sqlite3";
import { runtimeStopTargetsHash } from "@agent-workbench/shared/node/agent-run-stop";
import type { AgentWorkerStopRunsResponse } from "@agent-workbench/shared/internal-contracts/agent-worker";
import { initSchema } from "../../infra/db/schema.js";
import { deleteWorkspaceAgentData } from "../../infra/db/workspace-agent-data-cleanup.js";
import { AgentMessageConflictError, moveMessageHead, appendMessage, forkMessageSession, forkHistoricalMessageSession, forkStableSourceSession, revertBeforeUserMessage, setManualMessageSessionTitle, createMessageSession, createMessageRunRecord, startMessageRun, getRunRecord, persistRunTerminalIntent, convergeRunTerminal } from "./agent-message.store.js";
import { AgentRuntimeControlStore, assertSessionRuntimeUnblocked, type RuntimeStopRecord } from "./runtime-control/runtime-control.store.js";
import { AgentRuntimeControlService } from "./runtime-control/runtime-control.service.js";
import { SqliteRunLifecyclePersistence } from "./lifecycle/sqlite-run-lifecycle-persistence.js";
import { AgentRuntime } from "./agent.runtime.js";
function fixture(t: TestContext) {
    const db = new Database(":memory:");
    db.pragma("foreign_keys=ON");
    initSchema(db);
    db.prepare("insert into workspaces(id,dir_name,title,path,created_at,updated_at) values('w','w','w','/fixture/w',1,1)").run();
    t.after(() => db.close());
    const store = new AgentRuntimeControlStore(db);
    const owner = randomUUID();
    function instance() {
        const id = randomUUID();
        store.createInstance({ runtimeInstanceId: id, ownerApiInstanceId: owner, runtimeKind: "worker" });
        store.readyInstance(id, { pid: 42, spawnNonce: randomUUID(), spawnObservedAt: 1 });
        return id;
    }
    function run(sessionId = "s", runId = "r", parentRunId?: string) {
        if (!db.prepare("select 1 from agent_session where id=?").get(sessionId))
            createMessageSession(db, { id: sessionId, workspaceId: "w", title: sessionId, kind: parentRunId ? "subtask" : "primary", createdAt: 1 });
        createMessageRunRecord(db, { workspaceId: "w", sessionId, runId, parentRunId, triggerMessageId: null, agentId: "a", providerId: "p", modelId: "m", status: "running", createdAt: 1 });
        startMessageRun(db, { workspaceId: "w", sessionId, runId, updatedAt: 1 });
        return { workspaceId: "w", sessionId, runId };
    }
    function exit(runtimeInstanceId: string) {
        const row = db.prepare("select process_identity_json as json from agent_runtime_instance where runtime_instance_id=?").get(runtimeInstanceId) as {
            json: string;
        };
        store.recordInstanceExit(runtimeInstanceId, owner, "child_exit", { ...JSON.parse(row.json), observedAt: Date.now(), code: 0, signal: null });
    }
    function state(operationId: string) {
        return (db.prepare("select state from agent_session_stop_barrier where operation_id=?").get(operationId) as {
            state: string;
        }).state;
    }
    function proof(record: RuntimeStopRecord, runtimeInstanceId: string): AgentWorkerStopRunsResponse {
        return { workspaceId: record.workspaceId, rootSessionId: record.rootSessionId, operationId: record.operationId, runtimeInstanceId,
            targetsHash: runtimeStopTargetsHash({ ...record, targets: record.targets.filter(target => target.runtimeInstanceId === runtimeInstanceId) }), state: "quiescent", proofId: randomUUID(), code: null };
    }
    function stop(operationId = "stop", rootSessionId = "s") { return store.stop({ workspaceId: "w", rootSessionId, operationId }, () => undefined).record; }
    return { db, store, owner, instance, run, state, proof, stop, exit };
}
test("Stop before binding retires never-sent admission, records empty barrier and stable queue version", t => {
    const f = fixture(t);
    const run = f.run();
    const instance = f.instance();
    const record = f.stop();
    assert.equal(record.targetCount, 0);
    assert.equal(f.state("stop"), "quiescent");
    assert.throws(() => f.store.bindAdmission(run, instance), /admiss|closed/i);
    const before = f.db.prepare("select * from agent_session_queue_control").get();
    let settled = false;
    const replay = f.store.stop({ workspaceId: "w", rootSessionId: "s", operationId: "stop" }, () => { settled = true; });
    assert.equal(replay.replayed, true);
    assert.equal(settled, false);
    assert.deepEqual(f.db.prepare("select * from agent_session_queue_control").get(), before);
    assert.equal("mode" in (before as object), false);
});
test("binding before physical enqueue commits exact stop target and rejects the delayed physical admission", t => {
    const f = fixture(t);
    const run = f.run();
    const instance = f.instance();
    f.store.bindAdmission(run, instance);
    const record = f.stop();
    assert.deepEqual(record.targets, [{ sessionId: "s", runId: "r", runtimeInstanceId: instance }]);
    assert.deepEqual(f.store.checkAdmission({ ...run, runtimeInstanceId: instance }), { bindingMatches: true, admitted: false });
    assert.throws(() => assertSessionRuntimeUnblocked(f.db, "w", "s"), /not confirmed/);
});
test("DB terminal and barrier are atomic; existing completed intent remains authoritative", t => {
    const f = fixture(t);
    const run = f.run();
    const instance = f.instance();
    f.store.bindAdmission(run, instance);
    persistRunTerminalIntent(f.db, { ...run, status: "completed", code: "run_completed", detail: null, updatedAt: 2 });
    const result = new SqliteRunLifecyclePersistence(f.db).cancelSessions({ workspaceId: "w", rootSessionId: "s", updatedAt: 3, listActiveChildSessionIds: () => [] });
    assert.equal(getRunRecord(f.db, "r")!.status, "completed");
    assert.equal(getRunRecord(f.db, "r")!.executionPhase, "terminal");
    assert.equal(f.state(result.stopOperationId!), "pending");
    assert.equal(result.terminalConvergences?.[0]?.result.kind, "transitioned");
    assert.throws(() => f.run("s", "new"), /not confirmed/);
});
test("terminal settlement failure rolls back closing, queue version, operation and barrier together", t => {
    const f = fixture(t);
    const run = f.run();
    const instance = f.instance();
    f.store.bindAdmission(run, instance);
    assert.throws(() => f.store.stop({ workspaceId: "w", rootSessionId: "s", operationId: "failed" }, () => { throw new Error("injected"); }), /injected/);
    assert.equal(f.db.prepare("select 1 from agent_session_stop_barrier").get(), undefined);
    assert.equal(f.store.checkAdmission({ ...run, runtimeInstanceId: instance }).admitted, true);
    assert.equal(f.db.prepare("select 1 from agent_session_queue_control").get(), undefined);
});
test("two independent Stops retain their own targets and proofs; old proof cannot clear the newer barrier", t => {
    const f = fixture(t);
    const run = f.run();
    const instance = f.instance();
    f.store.bindAdmission(run, instance);
    const first = f.stop("first");
    const second = f.stop("second");
    assert.ok(second.acceptedQueueVersion > first.acceptedQueueVersion);
    f.store.confirmStopGroup(first, instance, f.proof(first, instance));
    assert.equal(f.state("first"), "quiescent");
    assert.equal(f.state("second"), "pending");
    assert.throws(() => assertSessionRuntimeUnblocked(f.db, "w", "s"));
    f.store.confirmStopGroup(second, instance, f.proof(second, instance));
    assert.doesNotThrow(() => assertSessionRuntimeUnblocked(f.db, "w", "s"));
    assert.equal("mode" in (f.db.prepare("select * from agent_session_queue_control").get() as object), false);
    f.store.markGroupUnknown(first, instance, "late_error");
    assert.equal(f.state("first"), "quiescent");
});
test("proofs validate shape, operation, hash and the persisted full instance group, not a supplied subset", t => {
    const f = fixture(t);
    const run = f.run();
    const instance = f.instance();
    f.store.bindAdmission(run, instance);
    const child = f.run("child", "child-run", "r");
    f.store.bindAdmission(child, instance);
    const record = f.stop();
    for (const bad of [{ ...f.proof(record, instance), proofId: null }, { ...f.proof(record, instance), targetsHash: "a".repeat(64) }, { ...f.proof(record, instance), runtimeInstanceId: randomUUID() }]) {
        assert.throws(() => f.store.confirmStopGroup(record, instance, bad as AgentWorkerStopRunsResponse));
    }
    const subset = { ...record, targets: record.targets.slice(0, 1) };
    assert.throws(() => f.store.confirmStopGroup(subset, instance, f.proof(subset, instance)));
    assert.equal(f.state("stop"), "pending");
});
test("cascade captures terminal-but-unretired nested and queued work without pausing historical retired children", t => {
    const f = fixture(t);
    const root = f.run();
    const instance = f.instance();
    f.store.bindAdmission(root, instance);
    const child = f.run("child", "child-run", "r");
    f.store.bindAdmission(child, instance);
    const queued = f.run("queued", "queued-run", "r");
    const historical = f.run("historical", "historical-run", "r");
    f.store.bindAdmission(historical, instance);
    for (const scope of [child, historical]) {
        persistRunTerminalIntent(f.db, { ...scope, status: "completed", code: "run_completed", detail: null, updatedAt: 2 });
        convergeRunTerminal(f.db, { ...scope, updatedAt: 2 });
    }
    f.db.prepare("update agent_run_runtime_admission set state='retired' where run_id=?").run(historical.runId);
    const record = f.stop();
    assert.deepEqual(new Set(record.targets.map(target => target.runId)), new Set(["r", "child-run"]));
    assert.equal(f.db.prepare("select 1 from agent_session_queue_control where session_id='historical'").get(), undefined);
    assert.equal((f.db.prepare("select state from agent_run_runtime_admission where run_id=?").get(queued.runId) as {
        state: string;
    }).state, "retired");
    assert.throws(() => assertSessionRuntimeUnblocked(f.db, "w", "child"));
    assert.throws(() => f.run("late", "late-run", "r"));
});
test("parent and ancestor admissions are rechecked when binding a nested Run", t => {
    const f = fixture(t);
    const instance = f.instance();
    const root = f.run();
    f.store.bindAdmission(root, instance);
    const child = f.run("child", "child-run", "r");
    f.store.bindAdmission(child, instance);
    const leaf = f.run("leaf", "leaf-run", "child-run");
    f.db.prepare("update agent_run_runtime_admission set state='closed' where run_id='r'").run();
    assert.throws(() => f.store.bindAdmission(leaf, instance), /Parent Run/);
    assert.equal(f.store.checkAdmission({ ...child, runtimeInstanceId: instance }).admitted, false);
});
test("partial groups and new ready incarnation cannot turn old unknown into quiescent", t => {
    const f = fixture(t);
    const a = f.instance();
    const b = f.instance();
    const root = f.run();
    f.store.bindAdmission(root, a);
    const child = f.run("child", "child-run", "r");
    // A pre-existing historical incarnation remains a separate exact target group.
    f.db.prepare("update agent_run_runtime_admission set runtime_instance_id=?,state='bound' where run_id=?").run(b, child.runId);
    const record = f.stop();
    f.store.markGroupUnknown(record, b, "transport_unavailable");
    f.store.confirmStopGroup(record, a, f.proof(record, a));
    assert.equal(f.state("stop"), "unknown");
    f.instance();
    assert.equal(f.state("stop"), "unknown");
    assert.throws(() => f.store.recordInstanceExit(b, randomUUID(), "child_exit", {}));
    assert.equal(f.state("stop"), "unknown");
    f.exit(b);
    assert.equal(f.state("stop"), "quiescent");
    assert.deepEqual(f.db.pragma("foreign_key_check"), []);
});
test("exact exit evidence resolves all barriers, not only one reconciler page", t => {
    const f = fixture(t);
    const run = f.run();
    const instance = f.instance();
    f.store.bindAdmission(run, instance);
    for (let i = 0; i < 36; i++)
        f.stop(`stop-${i}`);
    f.exit(instance);
    assert.equal(f.db.prepare("select 1 from agent_session_stop_barrier where state<>'quiescent'").get(), undefined);
});
test("recovery is durable and idempotent; a legacy missing admission is unknown, not never-sent", t => {
    const f = fixture(t);
    const run = f.run();
    f.db.prepare("delete from agent_run_runtime_admission where run_id=?").run(run.runId);
    const runtime = { enqueueRun() { }, cancelSession() { }, async stopRunsAndWait() { throw new Error("unreachable"); } };
    const service = new AgentRuntimeControlService(f.store, runtime);
    service.recover();
    service.recover();
    assert.equal((f.db.prepare("select count(*) as n from agent_session_stop_barrier").get() as {
        n: number;
    }).n, 1);
    assert.equal(getRunRecord(f.db, run.runId)!.executionPhase, "terminal");
    assert.equal(getRunRecord(f.db, run.runId)!.status, "failed");
    assert.equal(f.store.getInstance(f.store.boundRuntimeInstance(run.runId)!)!.state, "unknown");
});
test("lost RPC response persists unknown; background retries only fixed operation/instance/targets", async (t) => {
    const f = fixture(t);
    const run = f.run();
    const instance = f.instance();
    f.store.bindAdmission(run, instance);
    const requests: unknown[] = [];
    let lost = true;
    let clock = Date.now();
    const record = f.stop();
    const service = new AgentRuntimeControlService(f.store, { enqueueRun() { }, cancelSession() { }, async stopRunsAndWait(input) {
            requests.push(input);
            if (lost)
                throw new Error("response lost");
            return f.proof(record, instance);
        } }, () => clock);
    service.ready(instance);
    await service.reconcileStops();
    assert.equal(f.state("stop"), "unknown");
    service.stopSession({ workspaceId: "w", rootSessionId: "s", operationId: "stop" });
    assert.equal(requests.length, 1, "public replay does not send cancellation");
    lost = false;
    await service.reconcileStops();
    assert.equal(requests.length, 1, "backoff avoids immediate retries");
    clock += 501;
    await service.reconcileStops();
    assert.equal(f.state("stop"), "quiescent");
    assert.deepEqual(requests[0], requests[1]);
});
test("fallback stays pending until the real asynchronous execution finally; no late writeback after Stop", async (t) => {
    const f = fixture(t);
    const run = f.run();
    const instance = f.instance();
    let release!: (context: any) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const context = new Promise<any>(resolve => { release = resolve; });
    let writes = 0;
    const raw = new AgentRuntime({ async getPromptContextForRun() { entered(); return await context; }, createStreamingAssistantFromWorker() { writes++; } } as any, { error() { }, warn() { } } as any, 1, undefined, {
        runtimeInstanceId: instance, bindingMatches: scope => f.store.checkAdmission({ ...scope, runtimeInstanceId: instance }).bindingMatches,
        admissionAllowed: scope => f.store.checkAdmission({ ...scope, runtimeInstanceId: instance }).admitted,
    });
    let clock = Date.now();
    const service = new AgentRuntimeControlService(f.store, raw, () => clock);
    service.ready(instance);
    await service.enqueueRun({ ...run, workspacePath: "/fixture/w", workspaceRepoDirNames: [] });
    await started;
    const { record } = service.stopSession({ workspaceId: "w", rootSessionId: "s", operationId: "stop" });
    assert.equal(getRunRecord(f.db, "r")!.executionPhase, "terminal");
    await service.reconcileStops();
    assert.equal(f.state("stop"), "pending");
    assert.equal(raw.quiescent, false);
    release({ pendingTools: [], messages: [] });
    while (!raw.quiescent)
        await new Promise(resolve => setImmediate(resolve));
    clock += 501;
    await service.reconcileStops();
    assert.equal(f.state(record.operationId), "quiescent");
    assert.equal(writes, 0);
    assert.equal("mode" in (f.db.prepare("select * from agent_session_queue_control").get() as object), false);
});
test("workspace cleanup refuses pending runtime evidence, and keeps runtime instance records after confirmed cleanup", t => {
    const f = fixture(t);
    const run = f.run();
    const instance = f.instance();
    f.store.bindAdmission(run, instance);
    const record = f.stop();
    assert.throws(() => f.db.transaction(() => deleteWorkspaceAgentData(f.db, "w"))(), /STOP_UNCONFIRMED/);
    f.store.confirmStopGroup(record, instance, f.proof(record, instance));
    f.db.transaction(() => deleteWorkspaceAgentData(f.db, "w"))();
    assert.ok(f.store.getInstance(instance));
    assert.deepEqual(f.db.pragma("foreign_key_check"), []);
});
test("history forks/revert/title and activation fence both root and target Sessions, without blocking safe reads", t => {
    const f = fixture(t);
    const instance = f.instance();
    const root = f.run();
    f.store.bindAdmission(root, instance);
    const child = f.run("child", "child-run", "r");
    f.store.bindAdmission(child, instance);
    f.stop();
    for (const sessionId of ["s", "child"]) {
        const scope = { workspaceId: "w", sessionId };
        const source = { id: "new", workspaceId: "w", sourceSessionId: sessionId, title: "new", createdAt: 2 };
        const mutations = [
            () => f.run(sessionId, "new-run"),
            () => moveMessageHead(f.db, { ...scope, expectedHeadMessageId: null, expectedRevision: 0, nextHeadMessageId: "missing", updatedAt: 2 }),
            () => startMessageRun(f.db, { ...scope, runId: "r", updatedAt: 2 }),
            () => forkStableSourceSession(f.db, source),
            () => forkHistoricalMessageSession(f.db, { ...source, targetMessageId: "missing" }),
            () => forkMessageSession(f.db, { ...source, expectedHeadMessageId: null, expectedRevision: 0, targetMessageId: "missing", kind: "primary" }),
            () => revertBeforeUserMessage(f.db, { ...scope, expectedHeadMessageId: null, expectedRevision: 0, targetMessageId: "missing", updatedAt: 2 }),
            () => setManualMessageSessionTitle(f.db, { ...scope, title: "changed" }),
        ];
        const expectedCode = f.state("stop") === "unknown" ? "AGENT_SESSION_STOP_UNKNOWN" : "AGENT_SESSION_STOP_PENDING";
        for (const mutate of mutations)
            assert.throws(mutate, error => (error as {
                code?: string;
            }).code === expectedCode);
        const record = f.store.listPendingStops()[0]!;
        f.store.markGroupUnknown(record, instance, "test_transport_unknown");
        for (const mutate of mutations)
            assert.throws(mutate, error => (error as {
                code?: string;
            }).code === "AGENT_SESSION_STOP_UNKNOWN");
        assert.ok(getRunRecord(f.db, sessionId === "s" ? "r" : "child-run"));
    }
});
test("partial target confirmation updates queueVersion even while whole barrier stays pending", t => {
    const f = fixture(t);
    const a = f.instance();
    const b = f.instance();
    const root = f.run();
    f.store.bindAdmission(root, a);
    const child = f.run("child", "child-run", "r");
    f.db.prepare("update agent_run_runtime_admission set runtime_instance_id=?,state='bound' where run_id=?").run(b, child.runId);
    const record = f.stop();
    const version = () => (f.db.prepare("select queue_version as n from agent_session_queue_control where session_id='s'").get() as {
        n: number;
    }).n;
    const before = version();
    f.store.confirmStopGroup(record, a, f.proof(record, a));
    assert.equal(f.state("stop"), "pending");
    assert.ok(version() > before);
    const unchanged = version();
    f.store.confirmStopGroup(record, a, f.proof(record, a));
    assert.equal(version(), unchanged);
});
test("deleting fence denies enqueue but authenticated binding checks remain available for stop reconciliation", async (t) => {
    const f = fixture(t);
    const scope = f.run();
    const instance = f.instance();
    f.store.bindAdmission(scope, instance);
    workspaceDeletingFence.begin("w");
    t.after(() => workspaceDeletingFence.end("w"));
    const app = Fastify();
    await registerAgentRuntimeControlRoutes(app, f.store, "runtime-test-token");
    t.after(() => app.close());
    const payload = { ...scope, runtimeInstanceId: instance };
    const unauthorized = await app.inject({ method: "POST", url: AgentApiEndpoints.checkRuntimeAdmission.path, payload });
    assert.equal(unauthorized.statusCode, 401);
    const checked = await app.inject({ method: "POST", url: AgentApiEndpoints.checkRuntimeAdmission.path, headers: { "x-awb-agent-internal-token": "runtime-test-token" }, payload });
    assert.equal(checked.statusCode, 200);
    assert.deepEqual(checked.json(), { bindingMatches: true, admitted: false });
    assert.equal((await app.inject({ method: "POST", url: "/api/internal/agent/runtime/exit", payload })).statusCode, 404);
});
test("cancel-and-wait budget does not wait indefinitely for transport; a late exact proof may still settle", async (t) => {
    const f = fixture(t);
    const scope = f.run();
    const instance = f.instance();
    f.store.bindAdmission(scope, instance);
    let release!: (response: AgentWorkerStopRunsResponse) => void;
    const gate = new Promise<AgentWorkerStopRunsResponse>(resolve => { release = resolve; });
    const service = new AgentRuntimeControlService(f.store, { enqueueRun() { }, cancelSession() { }, async stopRunsAndWait() { return await gate; } });
    service.ready(instance);
    assert.equal(await service.cancelSessionAndWait({ sessionId: "s", timeoutMs: 10 }), false);
    const record = f.store.listPendingStops()[0]!;
    release(f.proof(record, instance));
    await service.close();
    assert.equal(f.state(record.operationId), "quiescent");
});
test("offline evidence requires original identity and explicit exclusive verification; no online force-resume exists", t => {
    const f = fixture(t);
    const scope = f.run();
    const instance = f.instance();
    f.store.bindAdmission(scope, instance);
    f.stop();
    assert.throws(() => f.store.recordInstanceExit(instance, f.owner, "offline_exit", { observedAt: Date.now() }));
    const row = f.db.prepare("select process_identity_json as json from agent_runtime_instance where runtime_instance_id=?").get(instance) as {
        json: string;
    };
    f.store.recordInstanceExit(instance, f.owner, "offline_exit", { observedAt: Date.now(), exclusiveMaintenance: true, maintenanceId: randomUUID(), observer: "fixture operator", originalProcessIdentity: JSON.parse(row.json), verification: "fixture verified original identity and actual exit" });
    assert.equal(f.state("stop"), "quiescent");
    assert.equal((f.db.prepare("select exit_proof_kind as kind from agent_runtime_instance where runtime_instance_id=?").get(instance) as {
        kind: string;
    }).kind, "offline_exit");
});
test("Runner quiescent preserves Git processStopConfirmed=false, ToolExecution unknown, and filesystem lease deletion protection", async (t) => {
    const f = fixture(t);
    const scope = f.run();
    const instance = f.instance();
    f.store.bindAdmission(scope, instance);
    appendMessage(f.db, { id: "tool-call", workspaceId: "w", sessionId: "s", originRunId: "r", expectedHeadMessageId: null, expectedRevision: 0, type: "assistant", status: "completed", parts: [{ id: "git-call", position: 0, type: "tool_call", toolName: "git", input: { repo: "repo", args: ["status"] } }], createdAt: 2 });
    const result = JSON.stringify({ processStopConfirmed: false });
    f.db.prepare("insert into agent_tool_execution(id,call_part_id,origin_session_id,origin_run_id,status,structured_result_json,updated_revision,created_at,updated_at,started_at) values('exec','git-call','s','r','running',?,1,2,2,2)").run(result);
    const root = path.resolve(process.cwd(), "../../.tmp-tests");
    await fs.mkdir(root, { recursive: true });
    const dataDir = await fs.mkdtemp(path.join(root, "s3-git-hold-"));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    const leaseCreatedAt = Date.now(); // The lease validator requires an exact TTL, including milliseconds.
    const meta = { ...scope, toolExecutionId: "exec", schemaVersion: 2 as const, purpose: "git" as const, leaseId: "lease_00000000000000000000000000", repo: "repo", repoId: "repo-id", kind: "none" as const, createdAt: new Date(leaseCreatedAt).toISOString(), expiresAt: new Date(leaseCreatedAt + 900000).toISOString(), timeoutMs: 120000, stopState: "unconfirmed" as const };
    await createRepoGitEnvLease({ dataDir, meta });
    const service = new AgentRuntimeControlService(f.store, { enqueueRun() { }, cancelSession() { }, async stopRunsAndWait() { throw new Error("not used"); } });
    const { record } = service.stopSession({ workspaceId: "w", rootSessionId: "s", operationId: "stop" });
    f.store.confirmStopGroup(record, instance, f.proof(record, instance));
    assert.equal(f.state("stop"), "quiescent");
    assert.deepEqual(f.db.prepare("select status,structured_result_json as result from agent_tool_execution where id='exec'").get(), { status: "unknown", result });
    assert.equal((await inspectRepoGitEnvLease({ dataDir, leaseId: meta.leaseId }))!.state, "unconfirmed");
    await assert.rejects(assertNoRepoGitEnvLeaseHold({ dataDir, workspaceId: "w" }), error => (error as {
        code?: string;
    }).code === "REPO_GIT_BUSY");
});
test("current cancellation tree excludes historical unbound DB children but includes bound terminal runners", t => {
    const f = fixture(t);
    const instance = f.instance();
    const old = f.run();
    f.store.bindAdmission(old, instance);
    const unbound = f.run("unbound-child", "unbound", "r");
    const bound = f.run("bound-child", "bound", "r");
    f.store.bindAdmission(bound, instance);
    for (const run of [bound, old]) {
        persistRunTerminalIntent(f.db, { ...run, status: "completed", code: "run_completed", detail: null, updatedAt: 2 });
        convergeRunTerminal(f.db, { ...run, updatedAt: 2 });
    }
    const current = f.run("s", "current");
    const result = new SqliteRunLifecyclePersistence(f.db).cancelSessions({ workspaceId: "w", rootSessionId: "s", updatedAt: 3, listActiveChildSessionIds: () => [] });
    const record = f.db.prepare("select result_json as json from agent_queue_operation where operation_id=?").get(result.stopOperationId) as {
        json: string;
    };
    const stop = JSON.parse(record.json) as RuntimeStopRecord;
    assert.deepEqual(stop.targets.map(target => target.runId).sort(), ["bound", "r"]);
    assert.deepEqual(stop.notAdmittedRuns.map(run => run.runId), [current.runId]);
    assert.equal(getRunRecord(f.db, unbound.runId)?.status, "running");
    assert.equal((f.db.prepare("select state from agent_run_runtime_admission where run_id=?").get(unbound.runId) as {
        state: string;
    }).state, "unbound");
    assert.equal(f.db.prepare("select 1 from agent_session_queue_control where session_id=?").get(unbound.sessionId), undefined);
    assert.throws(() => assertSessionRuntimeUnblocked(f.db, "w", bound.sessionId));
    assert.equal(getRunRecord(f.db, bound.runId)?.status, "completed");
    f.store.confirmStopGroup(stop, instance, f.proof(stop, instance));
    assert.equal(f.state(stop.operationId), "quiescent");
});
test("rotating bounded scan reaches later operations behind more than 32 unchanged unknown barriers", async (t) => {
    const f = fixture(t);
    const old = f.instance();
    const current = f.instance();
    const records: RuntimeStopRecord[] = [];
    for (let index = 0; index < 40; index++) {
        const id = String(index).padStart(2, "0");
        const run = f.run(`session-${id}`, `run-${id}`);
        f.store.bindAdmission(run, index < 32 ? old : current);
        records.push(f.store.stop({ workspaceId: "w", rootSessionId: run.sessionId, operationId: `stop-${id}` }, () => { }).record);
    }
    const service = new AgentRuntimeControlService(f.store, { enqueueRun() { }, cancelSession() { }, async stopRunsAndWait(input) {
            return f.proof(records.find(record => record.operationId === input.operationId)!, current);
        } });
    service.ready(current);
    await service.reconcileStops();
    assert.equal(f.state("stop-00"), "unknown");
    assert.equal(f.state("stop-39"), "pending");
    await service.reconcileStops();
    assert.equal(f.state("stop-39"), "quiescent");
    assert.equal(f.state("stop-00"), "unknown");
});
test("fallback shutdown drain expires without inventing exit evidence and fences late context completion", async (t) => {
    const f = fixture(t);
    const run = f.run();
    const instance = f.instance();
    let release!: (context: any) => void;
    let writes = 0;
    const context = new Promise<any>(resolve => { release = resolve; });
    const raw = new AgentRuntime({ async getPromptContextForRun() { return await context; }, createStreamingAssistantFromWorker() { writes++; } } as any, { error() { }, warn() { } } as any, 1, undefined, {
        runtimeInstanceId: instance, bindingMatches: scope => f.store.checkAdmission({ ...scope, runtimeInstanceId: instance }).bindingMatches,
        admissionAllowed: scope => f.store.checkAdmission({ ...scope, runtimeInstanceId: instance }).admitted,
    });
    const service = new AgentRuntimeControlService(f.store, raw);
    service.ready(instance);
    await service.enqueueRun({ ...run, workspacePath: "/fixture/w", workspaceRepoDirNames: [] });
    service.stopSession({ workspaceId: "w", rootSessionId: "s", operationId: "stop" });
    await service.reconcileStops();
    assert.equal(await raw.drain(5), false);
    f.store.markInstanceUnknown(instance);
    await service.close();
    assert.equal(f.state("stop"), "unknown");
    assert.equal(f.store.getInstance(instance)?.state, "unknown");
    release({ pendingTools: [], messages: [] });
    assert.equal(await raw.drain(1000), true);
    assert.equal(writes, 0);
    assert.equal(f.state("stop"), "unknown", "late finally alone is not a persisted exit proof");
});
test("online exit requires the original nonce, PID and spawn observation; malformed offline identities stay unknown", t => {
    const f = fixture(t);
    const run = f.run();
    const instance = f.instance();
    f.store.bindAdmission(run, instance);
    f.stop();
    const row = f.db.prepare("select process_identity_json as json from agent_runtime_instance where runtime_instance_id=?").get(instance) as {
        json: string;
    };
    const identity = JSON.parse(row.json);
    for (const invalid of [{ ...identity, spawnNonce: randomUUID() }, { ...identity, pid: 43 }, { ...identity, spawnObservedAt: 2 }]) {
        assert.throws(() => f.store.recordInstanceExit(instance, f.owner, "child_exit", { ...invalid, observedAt: Date.now() }));
    }
    for (const originalProcessIdentity of [undefined, null, [], { pid: 42 }, { ...identity, extra: true }]) {
        assert.throws(() => f.store.recordInstanceExit(instance, f.owner, "offline_exit", { originalProcessIdentity, observedAt: Date.now(), exclusiveMaintenance: true, verification: "fixture" }));
    }
    assert.equal(f.state("stop"), "pending");
    f.exit(instance);
    assert.equal(f.state("stop"), "quiescent");
});
test("retirement cannot bypass a pending target, and an empty new Stop still advances its independent queue version", t => {
    const f = fixture(t);
    const run = f.run();
    const instance = f.instance();
    f.store.bindAdmission(run, instance);
    const service = new AgentRuntimeControlService(f.store, { enqueueRun() { }, cancelSession() { }, async stopRunsAndWait() { throw new Error("unused"); } });
    const record = service.stopSession({ workspaceId: "w", rootSessionId: "s", operationId: "stop" }).record;
    assert.deepEqual(f.store.retireAdmission({ ...run, runtimeInstanceId: instance }), { retired: false });
    f.store.confirmStopGroup(record, instance, f.proof(record, instance));
    assert.deepEqual(f.store.retireAdmission({ ...run, runtimeInstanceId: instance }), { retired: true });
    const next = f.stop("next");
    assert.equal(next.targetCount, 0);
    assert.ok(next.acceptedQueueVersion > record.acceptedQueueVersion);
    assert.deepEqual(f.stop("next"), next);
});
test("history CAS conflicts retain priority over a pending Stop without permitting mutations", t => {
    const f = fixture(t);
    const run = f.run();
    const instance = f.instance();
    f.store.bindAdmission(run, instance);
    f.stop();
    const scope = { workspaceId: "w", sessionId: "s", expectedHeadMessageId: null, expectedRevision: 1 };
    assert.throws(() => moveMessageHead(f.db, { ...scope, nextHeadMessageId: "missing", updatedAt: 2 }), AgentMessageConflictError);
    assert.throws(() => revertBeforeUserMessage(f.db, { ...scope, targetMessageId: "missing", updatedAt: 2 }), AgentMessageConflictError);
    assert.throws(() => forkMessageSession(f.db, { ...scope, id: "new", sourceSessionId: "s", targetMessageId: "missing", title: "new", kind: "primary", createdAt: 2 }), AgentMessageConflictError);
    assert.equal(f.db.prepare("select 1 from agent_session where id='new'").get(), undefined);
});
test("ready cannot substitute a different incarnation's spawn identity", t => {
    const f = fixture(t);
    const id = randomUUID();
    const identity = { pid: null, spawnNonce: randomUUID(), spawnObservedAt: 1 };
    f.store.createInstance({ runtimeInstanceId: id, ownerApiInstanceId: f.owner, runtimeKind: "worker" }, identity);
    assert.throws(() => f.store.readyInstance(id, { ...identity, pid: 42, spawnNonce: randomUUID() }));
    assert.equal(f.store.getInstance(id)?.state, "starting");
    f.store.readyInstance(id, { ...identity, pid: 42 });
    assert.equal(f.store.getInstance(id)?.state, "ready");
});


for (const action of ["recover","stop","deny"] as const) {
  test(`pump admission transport failure with real SQLite: ${action} leaves no running orphan`,async t=>{
    const {AgentRunner}=await import(new URL("../../../../agent-worker/src/runtime/runner.ts",import.meta.url).href);
    const f=fixture(t);const instance=f.instance();const scope=f.run();
    let release!:(retry:boolean)=>void;let entered!:()=>void;
    const waiting=new Promise<void>(resolve=>{entered=resolve;});
    const retry=new Promise<boolean>(resolve=>{release=resolve;});
    let checks=0;let executions=0;let transitions=0;
    const api={async checkRuntimeAdmission(input:any){if(++checks===2)throw new Error("fixture API outage");return f.store.checkAdmission(input);},async retireRuntimeAdmission(input:any){return f.store.retireAdmission(input);}};
    const runner=new AgentRunner(api as any,{} as any,{info(){},warn(){},error(){}},1,{runtimeInstanceId:instance,controlWriteSleep:async(_ms:number,signal:AbortSignal)=>{
      entered();return await new Promise<boolean>(resolve=>{
        const abort=()=>resolve(false);signal.addEventListener("abort",abort,{once:true});
        if(signal.aborted)abort();
        void retry.then(value=>{signal.removeEventListener("abort",abort);resolve(value);});
      });
    }});
    (runner as any).processRun=async()=>{
      executions++;persistRunTerminalIntent(f.db,{...scope,status:"completed",code:"run_completed",detail:null,updatedAt:2});
      if(convergeRunTerminal(f.db,{...scope,updatedAt:2}).kind==="transitioned")transitions++;
    };
    // The production Worker HTTP endpoint calls enqueueRunAdmitted, not the
    // synchronous queue primitive. Preserve that first admission read here.
    const service=new AgentRuntimeControlService(f.store,{
      enqueueRun: input => runner.enqueueRunAdmitted(input),
      cancelSession: () => undefined,
      stopRunsAndWait: input => runner.stopRunsAndWait(input),
    });service.ready(instance);
    const input={...scope,workspacePath:"/fixture/w",workspaceRepoDirNames:[]};
    await service.enqueueRun(input);await waiting;
    assert.equal(getRunRecord(f.db,scope.runId)?.status,"running");assert.equal(runner.analyticsLiveSnapshot().activeCount,1);
    await service.enqueueRun(input);assert.equal(executions,0);
    if(action==="recover")release(true);
    else {
      service.stopSession({workspaceId:"w",rootSessionId:"s",operationId:"stop"});
      if (action === "stop") {
        await service.reconcileStops();assert.equal(f.state("stop"),"quiescent");
      }
      // deny lets the retry read the authoritative closed admission without
      // first delivering Stop RPC; it must not enter business execution.
      release(true);
    }
    while(runner.analyticsLiveSnapshot().activeCount)await new Promise(resolve=>setImmediate(resolve));
    if (action === "deny") {
      await service.reconcileStops();
      assert.equal(f.state("stop"), "quiescent");
    }
    assert.equal(getRunRecord(f.db,scope.runId)?.status,action==="recover"?"completed":"cancelled");
    assert.equal(executions,action==="recover"?1:0);assert.equal(transitions,action==="recover"?1:0);
    assert.equal(convergeRunTerminal(f.db,{...scope,updatedAt:3}).kind,"already_converged");
    await assert.rejects(service.enqueueRun(input));assert.equal(runner.analyticsLiveSnapshot().activeCount,0);
  });
}

test("runtime recovery/Stop publish committed convergence exactly once and never publish rollback/exit metadata",t=>{
  const f=fixture(t);const first=f.run();const published:string[]=[];
  const service=new AgentRuntimeControlService(f.store,{enqueueRun(){},cancelSession(){},async stopRunsAndWait(){throw new Error("unused");}},Date.now,(params,result)=>{
    assert.equal(f.db.inTransaction,false);assert.equal(getRunRecord(f.db,params.runId)?.executionPhase,"terminal");
    assert.equal(result.kind,"transitioned");published.push(params.runId);
  });
  service.recover();service.recover();assert.deepEqual(published,[first.runId]);
  const second=f.run("second","second-run");const instance=f.instance();f.store.bindAdmission(second,instance);
  service.stopSession({workspaceId:"w",rootSessionId:second.sessionId,operationId:"normal-stop"});
  service.stopSession({workspaceId:"w",rootSessionId:second.sessionId,operationId:"normal-stop"});
  assert.deepEqual(published,[first.runId,second.runId]);f.exit(instance);assert.deepEqual(published,[first.runId,second.runId]);
  const bad=f.run("bad","bad-run");
  f.db.exec("create trigger reject_test_terminal before update on agent_run when new.run_id='bad-run' begin select raise(abort,'fixture rollback'); end");
  assert.throws(()=>service.stopSession({workspaceId:"w",rootSessionId:bad.sessionId,operationId:"rollback"}),/fixture rollback/);
  assert.deepEqual(published,[first.runId,second.runId]);assert.equal(getRunRecord(f.db,bad.runId)?.status,"running");
});

test("recovery publishes each committed candidate even if the next candidate rolls back", t => {
  const f = fixture(t);
  f.run("first", "first-run");
  f.run("second", "second-run");
  const published: string[] = [];
  const service = new AgentRuntimeControlService(f.store, {
    enqueueRun() {}, cancelSession() {}, async stopRunsAndWait() { throw new Error("unused"); },
  }, Date.now, (params, result) => {
    assert.equal(f.db.inTransaction, false);
    assert.equal(result.kind, "transitioned");
    published.push(params.runId);
  });
  // Independent of scan order: allow one candidate to commit, then reject
  // another candidate's terminal transition inside its own Stop transaction.
  f.db.exec(`create trigger reject_second_terminal before update on agent_run
    when new.execution_phase='terminal' and exists (
      select 1 from agent_run where execution_phase='terminal' and run_id<>new.run_id
    ) begin select raise(abort,'fixture second candidate rollback'); end`);
  assert.throws(() => service.recover(), /fixture second candidate rollback/);
  const terminal = f.db.prepare("select run_id as runId from agent_run where execution_phase='terminal'").all() as { runId: string }[];
  assert.equal(terminal.length, 1);
  assert.deepEqual(published, [terminal[0]!.runId]);
  f.db.exec("drop trigger reject_second_terminal");
  service.recover();
  service.recover();
  assert.equal(published.length, 2);
  assert.equal(new Set(published).size, 2);
});

test("runtime convergence refuses an outer transaction rather than publishing before its commit", t => {
  const f = fixture(t);
  const run = f.run();
  const service = new AgentRuntimeControlService(f.store, {
    enqueueRun() {}, cancelSession() {}, async stopRunsAndWait() { throw new Error("unused"); },
  }, Date.now, () => assert.fail("must not publish from an outer transaction"));
  f.db.transaction(() => {
    assert.throws(() => service.recover(), /top-level commit boundary/);
    assert.throws(() => service.stopSession({ workspaceId: "w", rootSessionId: "s", operationId: "outer" }), /top-level commit boundary/);
  })();
  assert.equal(getRunRecord(f.db, run.runId)?.status, "running");
});

test("observed original instance exit retires lost finally notifications but never a successor incarnation",t=>{
  const f=fixture(t),old=f.instance(),successor=f.instance();
  const first=f.run("s","old");f.store.bindAdmission(first,old);
  persistRunTerminalIntent(f.db,{...first,status:"completed",code:"run_completed",detail:null,updatedAt:2});convergeRunTerminal(f.db,{...first,updatedAt:3});
  const next=f.run("next-session","next");f.store.bindAdmission(next,successor);
  f.exit(old);
  assert.equal((f.db.prepare("select state from agent_run_runtime_admission where run_id='old'").get() as {state:string}).state,"retired");
  assert.deepEqual(f.store.checkAdmission({...next,runtimeInstanceId:successor}),{bindingMatches:true,admitted:true});
});
