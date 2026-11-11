import { Type } from "@sinclair/typebox";
import { createHash, randomUUID } from "node:crypto";
import { canonicalRuntimeStopJson, runtimeStopTargetsHash, type RuntimeStopTarget } from "@agent-workbench/shared/node/agent-run-stop";
import { Value } from "@sinclair/typebox/value";
import { AgentWorkerStopRunsResponseSchema, type AgentWorkerStopRunsResponse } from "@agent-workbench/shared/internal-contracts/agent-worker";
import type { Db } from "../../../infra/db/db.js";
import { HttpError } from "../../../app/errors.js";
import { workspaceDeletingFence } from "../lifecycle/workspace-deleting-fence.js";
export type RunScope = {
    workspaceId: string;
    sessionId: string;
    runId: string;
};
export type RuntimeInstance = {
    runtimeInstanceId: string;
    ownerApiInstanceId: string;
    runtimeKind: "worker" | "local_fallback";
    state: "starting" | "ready" | "unknown" | "exited";
};
export type RuntimeStopRecord = {
    workspaceId: string;
    rootSessionId: string;
    operationId: string;
    acceptedQueueVersion: number;
    targetCount: number;
    targets: RuntimeStopTarget[];
    targetsHash: string;
    notAdmittedRuns: Array<{
        sessionId: string;
        runId: string;
        reason: string;
    }>;
};
type Admission = RunScope & {
    runtimeInstanceId: string | null;
    state: "unbound" | "bound" | "closed" | "retired";
};
const uuidSchema = Type.String({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" });
const workerIdentitySchema = Type.Object({
    pid: Type.Union([Type.Null(), Type.Integer({ minimum: 1 })]),
    spawnObservedAt: Type.Integer({ minimum: 0 }), spawnNonce: uuidSchema,
    osBootId: Type.Optional(Type.String({ minLength: 1 })), processStartIdentity: Type.Optional(Type.String({ minLength: 1 }))
}, { additionalProperties: false });
const localIdentitySchema = Type.Object({ pid: Type.Integer({ minimum: 1 }), ownerApiInstanceId: uuidSchema }, { additionalProperties: false });
const legacyIdentitySchema = Type.Object({ legacyUnknown: Type.Literal(true) }, { additionalProperties: false });
/** Current Session state and parentRunId define the cancellation tree; historical DB rows alone do not. */
export function listCurrentRunScopesForStop(db: Db, workspaceId: string, rootSessionId: string, listChildren?: (run: RunScope) => string[]): RunScope[] {
    const queue = [rootSessionId];
    const visited = new Set<string>();
    const runs: RunScope[] = [];
    while (queue.length) {
        const sessionId = queue.shift()!;
        if (visited.has(sessionId))
            continue;
        visited.add(sessionId);
        const state = db.prepare(`select active_run_id as runId from session_run_state
      where workspace_id=? and session_id=? and status='running' and active_run_id is not null`).get(workspaceId, sessionId) as {
            runId: string;
        } | undefined;
        if (!state)
            continue;
        const run = { workspaceId, sessionId, runId: state.runId };
        runs.push(run);
        const children = listChildren ? listChildren(run) : (db.prepare(`select distinct r.session_id as sessionId
      from agent_run r join session_run_state s on s.active_run_id=r.run_id and s.status='running'
      where r.workspace_id=? and r.parent_run_id=?`).all(workspaceId, run.runId) as {
            sessionId: string;
        }[]).map(row => row.sessionId);
        queue.push(...children);
    }
    return runs;
}
/** Shared transaction fence for old and new execution/history entry points. It does not block safe reads or receiving queued messages. */
export function assertSessionRuntimeUnblocked(db: Db, workspaceId: string, sessionId: string) {
    const blocked = db.prepare(`select state from agent_session_stop_barrier where workspace_id=? and root_session_id=? and state<>'quiescent'
    union all select state from agent_session_stop_target where workspace_id=? and target_session_id=? and state<>'quiescent' limit 1`).get(workspaceId, sessionId, workspaceId, sessionId) as {
        state: string;
    } | undefined;
    if (blocked)
        throw new HttpError(409, "Agent runtime stop is not confirmed", blocked.state === "unknown" ? "AGENT_SESSION_STOP_UNKNOWN" : "AGENT_SESSION_STOP_PENDING");
}
export function registerRunRuntimeAdmission(db: Db, input: RunScope & {
    status: string;
    createdAt: number;
    parentRunId?: string | null;
}) {
    assertSessionRuntimeUnblocked(db, input.workspaceId, input.sessionId);
    if (input.status === "running" && input.parentRunId)
        assertRunAncestorsAdmissible(db, input.workspaceId, input.parentRunId);
    db.prepare(`insert into agent_run_runtime_admission(workspace_id,session_id,run_id,runtime_instance_id,state,created_at,updated_at) values(?,?,?,null,?,?,?)`).run(input.workspaceId, input.sessionId, input.runId, input.status === "running" ? "unbound" : "retired", input.createdAt, input.createdAt);
}
function assertRunAncestorsAdmissible(db: Db, workspaceId: string, parentRunId: string, runtimeInstanceId?: string) {
    const parents = db.prepare(`with recursive parents(run_id, session_id, parent_run_id, status, execution_phase) as (
    select run_id,session_id,parent_run_id,status,execution_phase from agent_run where workspace_id=? and run_id=?
    union select r.run_id,r.session_id,r.parent_run_id,r.status,r.execution_phase from agent_run r join parents p on r.run_id=p.parent_run_id where r.workspace_id=?
  ) select p.*,a.state as admission_state,a.runtime_instance_id from parents p left join agent_run_runtime_admission a on a.run_id=p.run_id`).all(workspaceId, parentRunId, workspaceId) as Array<{
        session_id: string;
        status: string;
        execution_phase: string;
        admission_state: string | null;
        runtime_instance_id: string | null;
    }>;
    if (!parents.length)
        throw new HttpError(409, "Parent Run is missing", "AGENT_RUNTIME_ADMISSION_CLOSED");
    for (const parent of parents) {
        assertSessionRuntimeUnblocked(db, workspaceId, parent.session_id);
        if (parent.status !== "running" || !["work_pending", "work_in_progress"].includes(parent.execution_phase) || parent.admission_state === "closed" || parent.admission_state === "retired" || (runtimeInstanceId && parent.runtime_instance_id !== runtimeInstanceId)) {
            throw new HttpError(409, "Parent Run is no longer admissible", "AGENT_RUNTIME_ADMISSION_CLOSED");
        }
    }
}
export class AgentRuntimeControlStore {
    constructor(readonly db: Db, private readonly now = Date.now) { }
    createInstance(input: Omit<RuntimeInstance, "state">, processIdentity: unknown = null) {
        this.db.prepare(`insert into agent_runtime_instance(runtime_instance_id,owner_api_instance_id,runtime_kind,state,process_identity_json,created_at,updated_at) values(?,?,?,'starting',?,?,?)`).run(input.runtimeInstanceId, input.ownerApiInstanceId, input.runtimeKind, processIdentity == null ? null : canonicalRuntimeStopJson(processIdentity), this.now(), this.now());
    }
    readyInstance(runtimeInstanceId: string, processIdentity: unknown) {
        const instance = this.getInstance(runtimeInstanceId);
        if (!instance || !Value.Check(instance.runtimeKind === "worker" ? workerIdentitySchema : localIdentitySchema, processIdentity)) {
            throw new HttpError(409, "Runtime process identity is invalid", "AGENT_RUNTIME_INSTANCE_MISMATCH");
        }
        const original = this.db.prepare("select process_identity_json as json from agent_runtime_instance where runtime_instance_id=?").get(runtimeInstanceId) as {
            json: string | null;
        };
        const originalIdentity = original.json ? JSON.parse(original.json) : null;
        if (instance.runtimeKind === 'worker' && originalIdentity !== null && (!Value.Check(workerIdentitySchema, originalIdentity)
            || !Value.Check(workerIdentitySchema, processIdentity) || originalIdentity.spawnNonce !== processIdentity.spawnNonce
            || originalIdentity.spawnObservedAt !== processIdentity.spawnObservedAt || originalIdentity.pid !== null && originalIdentity.pid !== processIdentity.pid)) {
            throw new HttpError(409, "Runtime spawn identity changed", "AGENT_RUNTIME_INSTANCE_MISMATCH");
        }
        const result = this.db.prepare(`update agent_runtime_instance set state='ready',process_identity_json=?,updated_at=? where runtime_instance_id=? and state='starting'`).run(canonicalRuntimeStopJson(processIdentity), this.now(), runtimeInstanceId);
        if (result.changes !== 1)
            throw new HttpError(409, "Runtime identity cannot become ready", "AGENT_RUNTIME_INSTANCE_MISMATCH");
    }
    getInstance(runtimeInstanceId: string) {
        return this.db.prepare(`select runtime_instance_id as runtimeInstanceId,owner_api_instance_id as ownerApiInstanceId,runtime_kind as runtimeKind,state from agent_runtime_instance where runtime_instance_id=?`).get(runtimeInstanceId) as RuntimeInstance | undefined;
    }
    recordInstanceExit(runtimeInstanceId: string, ownerApiInstanceId: string, kind: "child_exit" | "local_shutdown" | "offline_exit", evidence: unknown) {
        this.db.transaction(() => {
            const instance = this.getInstance(runtimeInstanceId);
            if (!instance || instance.ownerApiInstanceId !== ownerApiInstanceId)
                throw new HttpError(409, "Runtime exit identity mismatch", "AGENT_RUNTIME_INSTANCE_MISMATCH");
            if (instance.state === "exited")
                return;
            const original = this.db.prepare("select process_identity_json as identity from agent_runtime_instance where runtime_instance_id=?").get(runtimeInstanceId) as {
                identity: string | null;
            };
            const processIdentity = original.identity ? JSON.parse(original.identity) as Record<string, unknown> : null;
            const proof = evidence as Record<string, unknown> | null;
            const validTime = proof && Number.isSafeInteger(proof.observedAt) && Number(proof.observedAt) >= 0;
            const workerIdentity = Value.Check(workerIdentitySchema, processIdentity);
            const localIdentity = Value.Check(localIdentitySchema, processIdentity);
            const validKind = kind === "child_exit"
                ? instance.runtimeKind === "worker" && workerIdentity && proof?.spawnNonce === processIdentity.spawnNonce
                    && proof.spawnObservedAt === processIdentity.spawnObservedAt && Number(proof.observedAt) >= processIdentity.spawnObservedAt
                    && (proof.code === null || Number.isInteger(proof.code)) && (proof.signal === null || typeof proof.signal === 'string' && /^SIG[A-Z0-9]+$/.test(proof.signal))
                    && (processIdentity.pid === null ? proof.pid === null || Number.isSafeInteger(proof.pid) && Number(proof.pid) > 0 : proof.pid === processIdentity.pid)
                : kind === "local_shutdown"
                    ? instance.runtimeKind === "local_fallback" && localIdentity && processIdentity.ownerApiInstanceId === ownerApiInstanceId && processIdentity.pid === process.pid && proof?.pid === processIdentity.pid
                    : proof?.exclusiveMaintenance === true && Value.Check(uuidSchema, proof.maintenanceId) && typeof proof.observer === 'string' && proof.observer.trim().length > 0
                        && typeof proof.verification === "string" && proof.verification.trim().length > 0
                        && (Value.Check(workerIdentitySchema, proof.originalProcessIdentity) || Value.Check(localIdentitySchema, proof.originalProcessIdentity) || Value.Check(legacyIdentitySchema, proof.originalProcessIdentity))
                        && canonicalRuntimeStopJson(proof.originalProcessIdentity) === canonicalRuntimeStopJson(processIdentity);
            if (!validTime || !validKind)
                throw new HttpError(409, "Runtime exit evidence is invalid", "AGENT_RUNTIME_INSTANCE_MISMATCH");
            this.db.prepare(`update agent_runtime_instance set state='exited',exit_proof_kind=?,exit_proof_id=?,exit_proof_json=?,exit_observed_at=?,updated_at=? where runtime_instance_id=?`).run(kind, randomUUID(), canonicalRuntimeStopJson({ runtimeInstanceId, ownerApiInstanceId, processIdentity, evidence }), this.now(), this.now(), runtimeInstanceId);
            this.confirmExitedInstance(runtimeInstanceId);
            this.db.prepare("update agent_run_runtime_admission set state='retired',updated_at=? where runtime_instance_id=? and not exists(select 1 from agent_session_stop_target t where t.run_id=agent_run_runtime_admission.run_id and t.state<>'quiescent')").run(this.now(), runtimeInstanceId);
        })();
    }
    private admission(input: RunScope) {
        return this.db.prepare(`select workspace_id as workspaceId,session_id as sessionId,run_id as runId,runtime_instance_id as runtimeInstanceId,state from agent_run_runtime_admission where workspace_id=? and session_id=? and run_id=?`).get(input.workspaceId, input.sessionId, input.runId) as Admission | undefined;
    }
    bindAdmission(input: RunScope, runtimeInstanceId: string) {
        return this.db.transaction(() => {
            workspaceDeletingFence.assertWritable(input.workspaceId);
            assertSessionRuntimeUnblocked(this.db, input.workspaceId, input.sessionId);
            const instance = this.getInstance(runtimeInstanceId);
            if (instance?.state !== "ready")
                throw new HttpError(503, "Runtime is not ready", "AGENT_RUNTIME_INSTANCE_MISMATCH");
            const run = this.db.prepare(`select status,execution_phase as phase,parent_run_id as parentRunId from agent_run where workspace_id=? and session_id=? and run_id=?`).get(input.workspaceId, input.sessionId, input.runId) as {
                status: string;
                phase: string;
                parentRunId: string | null;
            } | undefined;
            if (!run || run.status !== "running" || !["work_pending", "work_in_progress"].includes(run.phase))
                throw new HttpError(409, "Run is no longer admissible", "AGENT_RUNTIME_ADMISSION_CLOSED");
            if (run.parentRunId)
                assertRunAncestorsAdmissible(this.db, input.workspaceId, run.parentRunId, runtimeInstanceId);
            const admission = this.admission(input);
            if (admission?.state === "bound" && admission.runtimeInstanceId === runtimeInstanceId)
                return;
            if (admission?.state !== "unbound")
                throw new HttpError(409, "Runtime admission is closed", "AGENT_RUNTIME_ADMISSION_CLOSED");
            this.db.prepare(`update agent_run_runtime_admission set runtime_instance_id=?,state='bound',updated_at=? where run_id=? and state='unbound'`).run(runtimeInstanceId, this.now(), input.runId);
        })();
    }
    checkAdmission(input: RunScope & {
        runtimeInstanceId: string;
    }) {
        const admission = this.admission(input);
        const bindingMatches = admission?.runtimeInstanceId === input.runtimeInstanceId;
        if (!bindingMatches || admission?.state !== "bound")
            return { bindingMatches, admitted: false };
        try {
            workspaceDeletingFence.assertWritable(input.workspaceId);
            assertSessionRuntimeUnblocked(this.db, input.workspaceId, input.sessionId);
            const run = this.db.prepare(`select status,execution_phase as phase,parent_run_id as parentRunId from agent_run where run_id=?`).get(input.runId) as {
                status: string;
                phase: string;
                parentRunId: string | null;
            };
            if (!run)
                return { bindingMatches, admitted: false };
            if (run.parentRunId)
                assertRunAncestorsAdmissible(this.db, input.workspaceId, run.parentRunId, input.runtimeInstanceId);
            return { bindingMatches, admitted: run.status === "running" && ["work_pending", "work_in_progress"].includes(run.phase) };
        }
        catch (error) {
            if (error instanceof HttpError)
                return { bindingMatches, admitted: false };
            throw error;
        }
    }
    boundRuntimeInstance(runId: string): string | null {
        return (this.db.prepare("select runtime_instance_id as id from agent_run_runtime_admission where run_id=?").get(runId) as {
            id: string | null;
        } | undefined)?.id ?? null;
    }
    retireAdmission(input: RunScope & {
        runtimeInstanceId: string;
    }) {
        const binding = this.checkAdmission(input);
        if (!binding.bindingMatches)
            throw new HttpError(409, "Runtime binding mismatch", "AGENT_RUNTIME_INSTANCE_MISMATCH");
        const run = this.db.prepare("select execution_phase as phase from agent_run where run_id=?").get(input.runId) as {
            phase: string;
        };
        if (run.phase !== "terminal")
            return { retired: false };
        this.db.prepare("update agent_run_runtime_admission set state='retired',updated_at=? where run_id=? and not exists(select 1 from agent_session_stop_target where run_id=? and state<>'quiescent')").run(this.now(), input.runId, input.runId);
        return { retired: this.admission(input)?.state === "retired" };
    }
    private ensureControl(workspaceId: string, sessionId: string) {
        this.db.prepare(`insert into agent_session_queue_control(workspace_id,session_id,mode,pause_code,queue_version,next_sequence,updated_at) values(?,?,'active',null,0,1,?) on conflict(session_id) do nothing`).run(workspaceId, sessionId, this.now());
    }
    private pause(workspaceId: string, sessionId: string, code: string) {
        this.ensureControl(workspaceId, sessionId);
        const result = this.db.prepare(`update agent_session_queue_control set mode='paused',pause_code=?,queue_version=queue_version+1,updated_at=? where workspace_id=? and session_id=? and queue_version<9007199254740991`).run(code, this.now(), workspaceId, sessionId);
        if (result.changes !== 1)
            throw new HttpError(409, "Queue version exhausted", "AGENT_QUEUE_VERSION_CONFLICT");
    }
    /** Called around the existing terminal authority, never a second implementation of terminal transitions. */
    stop<T>(input: {
        workspaceId: string;
        rootSessionId: string;
        operationId: string;
        reason?: "user_stop" | "recovery_required";
    }, settle: (runIds: string[]) => T, selectCurrentRuns?: () => RunScope[]): {
        record: RuntimeStopRecord;
        result?: T;
        replayed: boolean;
    } {
        return this.db.transaction(() => {
            const requestHash = createHash("sha256").update(canonicalRuntimeStopJson({ workspaceId: input.workspaceId, rootSessionId: input.rootSessionId, operationId: input.operationId })).digest("hex");
            const existing = this.db.prepare(`select kind,request_hash as requestHash,result_json as resultJson from agent_queue_operation where workspace_id=? and session_id=? and operation_id=?`).get(input.workspaceId, input.rootSessionId, input.operationId) as {
                kind: string;
                requestHash: string;
                resultJson: string;
            } | undefined;
            if (existing) {
                if (existing.kind !== "stop" || existing.requestHash !== requestHash)
                    throw new HttpError(409, "Stop operation conflicts", "AGENT_STOP_OPERATION_CONFLICT");
                return { record: JSON.parse(existing.resultJson) as RuntimeStopRecord, replayed: true };
            }
            const root = this.db.prepare(`select id from agent_session where workspace_id=? and id=?`).get(input.workspaceId, input.rootSessionId);
            if (!root)
                throw new HttpError(404, "Session not found");
            const sessions = new Set<string>([input.rootSessionId]);
            const selected = new Map((selectCurrentRuns?.() ?? listCurrentRunScopesForStop(this.db, input.workspaceId, input.rootSessionId)).map(run => [run.runId, run]));
            if (input.reason === 'recovery_required') {
                const recoveryRuns = this.db.prepare(`select workspace_id as workspaceId,session_id as sessionId,run_id as runId
          from agent_run_runtime_admission where workspace_id=? and session_id=? and state<>'retired'`).all(input.workspaceId, input.rootSessionId) as RunScope[];
                for (const run of recoveryRuns)
                    selected.set(run.runId, run);
            }
            // Only physically bound, unretired historical work is execution evidence.
            const oldExecutions = this.db.prepare(`with recursive lineage(run_id) as (
        select run_id from agent_run where workspace_id=? and session_id=?
        union select r.run_id from agent_run r join lineage p on r.parent_run_id=p.run_id where r.workspace_id=?
      ) select a.workspace_id as workspaceId,a.session_id as sessionId,a.run_id as runId
        from agent_run_runtime_admission a join lineage l on l.run_id=a.run_id
        where a.runtime_instance_id is not null and a.state<>'retired'`).all(input.workspaceId, input.rootSessionId, input.workspaceId) as RunScope[];
            for (const run of oldExecutions)
                selected.set(run.runId, run);
            const previous = this.db.prepare(`select target_session_id as sessionId,run_id as runId,runtime_instance_id as runtimeInstanceId from agent_session_stop_target where workspace_id=? and root_session_id=? and state<>'quiescent'`).all(input.workspaceId, input.rootSessionId) as RuntimeStopTarget[];
            for (const target of previous)
                selected.set(target.runId, { workspaceId: input.workspaceId, sessionId: target.sessionId, runId: target.runId });
            const targets = new Map<string, RuntimeStopTarget>(previous.map((target) => [target.runId, target]));
            const notAdmittedRuns: Array<{
                sessionId: string;
                runId: string;
                reason: string;
            }> = [];
            for (const run of selected.values()) {
                sessions.add(run.sessionId);
                const admission = this.admission(run);
                if (!admission || admission.state === 'retired')
                    continue;
                if (admission.runtimeInstanceId)
                    targets.set(run.runId, { sessionId: run.sessionId, runId: run.runId, runtimeInstanceId: admission.runtimeInstanceId });
                else
                    notAdmittedRuns.push({ sessionId: run.sessionId, runId: run.runId, reason: "admission_closed_before_binding" });
                this.db.prepare(`update agent_run_runtime_admission set state='closed',updated_at=? where run_id=? and state<>'retired'`).run(this.now(), run.runId);
            }
            for (const sessionId of sessions)
                this.pause(input.workspaceId, sessionId, input.reason ?? "user_stop");
            const acceptedQueueVersion = (this.db.prepare(`select queue_version as version from agent_session_queue_control where session_id=?`).get(input.rootSessionId) as {
                version: number;
            }).version;
            const fixedTargets = [...targets.values()].sort((a, b) => Buffer.compare(Buffer.from(a.runId), Buffer.from(b.runId)));
            const targetsHash = runtimeStopTargetsHash({ ...input, targets: fixedTargets });
            const record: RuntimeStopRecord = { workspaceId: input.workspaceId, rootSessionId: input.rootSessionId, operationId: input.operationId, acceptedQueueVersion, targetCount: fixedTargets.length, targets: fixedTargets, targetsHash, notAdmittedRuns };
            this.db.prepare(`insert into agent_queue_operation(workspace_id,session_id,operation_id,kind,request_hash,result_json,created_at) values(?,?,?,'stop',?,?,?)`).run(input.workspaceId, input.rootSessionId, input.operationId, requestHash, JSON.stringify(record), this.now());
            this.db.prepare(`insert into agent_session_stop_barrier(workspace_id,root_session_id,operation_id,state,targets_hash,accepted_queue_version,created_at,updated_at,resolved_at) values(?,?,?,?,?,?,?,?,?)`).run(input.workspaceId, input.rootSessionId, input.operationId, fixedTargets.length ? "pending" : "quiescent", targetsHash, acceptedQueueVersion, this.now(), this.now(), fixedTargets.length ? null : this.now());
            for (const target of fixedTargets)
                this.db.prepare(`insert into agent_session_stop_target(workspace_id,root_session_id,operation_id,target_session_id,run_id,runtime_instance_id,state,updated_at) values(?,?,?,?,?,?,'pending',?)`).run(input.workspaceId, input.rootSessionId, input.operationId, target.sessionId, target.runId, target.runtimeInstanceId, this.now());
            const result = settle([...selected.keys()]);
            for (const runId of selected.keys())
                this.db.prepare(`update agent_run_runtime_admission set state='retired',updated_at=? where run_id=? and state='closed' and runtime_instance_id is null`).run(this.now(), runId);
            return { record, result, replayed: false };
        })();
    }
    listPendingStops(after?: {
        workspaceId: string;
        rootSessionId: string;
        operationId: string;
    }): RuntimeStopRecord[] {
        const cursor = after ? "and (o.workspace_id,o.session_id,o.operation_id) > (?,?,?)" : "";
        return (this.db.prepare(`select o.result_json as json from agent_queue_operation o
      join agent_session_stop_barrier b on b.workspace_id=o.workspace_id and b.root_session_id=o.session_id and b.operation_id=o.operation_id
      where b.state<>'quiescent' ${cursor} order by o.workspace_id,o.session_id,o.operation_id limit 32`)
            .all(...(after ? [after.workspaceId, after.rootSessionId, after.operationId] : [])) as {
            json: string;
        }[])
            .map(row => JSON.parse(row.json) as RuntimeStopRecord);
    }
    markInstanceUnknown(runtimeInstanceId: string) {
        this.db.transaction(() => {
            this.db.prepare("update agent_runtime_instance set state='unknown',updated_at=? where runtime_instance_id=? and state<>'exited'").run(this.now(), runtimeInstanceId);
            const stops = this.db.prepare(`select distinct workspace_id as workspaceId,root_session_id as rootSessionId,operation_id as operationId
        from agent_session_stop_target where runtime_instance_id=? and state<>'quiescent'`).all(runtimeInstanceId) as RuntimeStopRecord[];
            for (const stop of stops)
                this.markGroupUnknown(this.persistedStop(stop), runtimeInstanceId, "runtime_shutdown_unconfirmed");
        })();
    }
    private persistedStop(record: Pick<RuntimeStopRecord, "workspaceId" | "rootSessionId" | "operationId">): RuntimeStopRecord {
        const row = this.db.prepare(`select result_json as json from agent_queue_operation where workspace_id=? and session_id=? and operation_id=? and kind='stop'`).get(record.workspaceId, record.rootSessionId, record.operationId) as {
            json: string;
        } | undefined;
        if (!row)
            throw new HttpError(409, "Stop operation is missing", "AGENT_STOP_OPERATION_CONFLICT");
        return JSON.parse(row.json) as RuntimeStopRecord;
    }
    private targetStateSignature(record: RuntimeStopRecord) {
        return JSON.stringify(this.db.prepare(`select run_id,state,last_error_code from agent_session_stop_target where workspace_id=? and root_session_id=? and operation_id=? order by run_id`).all(record.workspaceId, record.rootSessionId, record.operationId));
    }
    confirmStopGroup(record: RuntimeStopRecord, runtimeInstanceId: string, response: AgentWorkerStopRunsResponse) {
        record = this.persistedStop(record);
        if (!Value.Check(AgentWorkerStopRunsResponseSchema, response))
            throw new HttpError(409, "Invalid stop proof", "AGENT_STOP_OPERATION_CONFLICT");
        const targets = record.targets.filter(target => target.runtimeInstanceId === runtimeInstanceId);
        const hash = runtimeStopTargetsHash({ ...record, targets });
        if (response.workspaceId !== record.workspaceId || response.rootSessionId !== record.rootSessionId || response.operationId !== record.operationId || response.runtimeInstanceId !== runtimeInstanceId || response.targetsHash !== hash)
            throw new HttpError(409, "Stop proof mismatch", "AGENT_STOP_OPERATION_CONFLICT");
        this.db.transaction(() => {
            const before = this.targetStateSignature(record);
            for (const target of targets) {
                if (response.state === "quiescent")
                    this.db.prepare(`update agent_session_stop_target set state='quiescent',evidence_kind='rpc_quiescent',evidence_id=?,evidence_json=?,confirmed_at=?,last_error_code=null,updated_at=? where workspace_id=? and root_session_id=? and operation_id=? and run_id=? and runtime_instance_id=? and state<>'quiescent'`).run(response.proofId, JSON.stringify(response), this.now(), this.now(), record.workspaceId, record.rootSessionId, record.operationId, target.runId, runtimeInstanceId);
                else
                    this.db.prepare(`update agent_session_stop_target set state=?,last_error_code=?,updated_at=? where workspace_id=? and root_session_id=? and operation_id=? and run_id=? and runtime_instance_id=? and state<>'quiescent'`).run(response.state, response.code, this.now(), record.workspaceId, record.rootSessionId, record.operationId, target.runId, runtimeInstanceId);
            }
            this.aggregate(record, before !== this.targetStateSignature(record));
        })();
    }
    markGroupUnknown(record: RuntimeStopRecord, runtimeInstanceId: string, code: string) {
        record = this.persistedStop(record);
        this.db.transaction(() => {
            const before = this.targetStateSignature(record);
            this.db.prepare(`update agent_session_stop_target set state='unknown',last_error_code=?,updated_at=? where workspace_id=? and root_session_id=? and operation_id=? and runtime_instance_id=? and state<>'quiescent'`).run(code, this.now(), record.workspaceId, record.rootSessionId, record.operationId, runtimeInstanceId);
            this.aggregate(record, before !== this.targetStateSignature(record));
        })();
    }
    confirmExitedInstance(runtimeInstanceId: string) {
        const instance = this.db.prepare(`select exit_proof_id as proofId,exit_proof_json as proofJson from agent_runtime_instance where runtime_instance_id=? and state='exited'`).get(runtimeInstanceId) as {
            proofId: string;
            proofJson: string;
        } | undefined;
        if (!instance)
            return;
        this.db.transaction(() => {
            const barriers = this.db.prepare(`select distinct workspace_id as workspaceId,root_session_id as rootSessionId,operation_id as operationId from agent_session_stop_target where runtime_instance_id=?`).all(runtimeInstanceId) as Array<Pick<RuntimeStopRecord, "workspaceId" | "rootSessionId" | "operationId">>;
            const before = new Map(barriers.map(barrier => { const record = this.persistedStop(barrier); return [canonicalRuntimeStopJson([record.workspaceId, record.rootSessionId, record.operationId]), this.targetStateSignature(record)]; }));
            this.db.prepare(`update agent_session_stop_target set state='quiescent',evidence_kind='instance_exit',evidence_id=?,evidence_json=?,confirmed_at=?,last_error_code=null,updated_at=? where runtime_instance_id=? and state<>'quiescent'`).run(instance.proofId, instance.proofJson, this.now(), this.now(), runtimeInstanceId);
            for (const barrier of barriers) {
                const record = this.persistedStop(barrier);
                this.aggregate(record, before.get(canonicalRuntimeStopJson([record.workspaceId, record.rootSessionId, record.operationId])) !== this.targetStateSignature(record));
            }
        })();
    }
    private aggregate(record: RuntimeStopRecord, targetsChanged = false) {
        const states = this.db.prepare(`select state from agent_session_stop_target where workspace_id=? and root_session_id=? and operation_id=?`).all(record.workspaceId, record.rootSessionId, record.operationId) as {
            state: string;
        }[];
        const state = states.every(row => row.state === "quiescent") ? "quiescent" : states.some(row => row.state === "unknown") ? "unknown" : "pending";
        const old = this.db.prepare(`select state from agent_session_stop_barrier where workspace_id=? and root_session_id=? and operation_id=?`).get(record.workspaceId, record.rootSessionId, record.operationId) as {
            state: string;
        };
        if (old.state === "quiescent")
            return;
        this.db.prepare(`update agent_session_stop_barrier set state=?,last_error_code=?,resolved_at=?,updated_at=? where workspace_id=? and root_session_id=? and operation_id=?`).run(state, state === "unknown" ? "runtime_exit_unproven" : null, state === "quiescent" ? this.now() : null, this.now(), record.workspaceId, record.rootSessionId, record.operationId);
        if (targetsChanged || old.state !== state) {
            for (const sessionId of new Set([record.rootSessionId, ...record.targets.map(target => target.sessionId)]))
                this.db.prepare(`update agent_session_queue_control set queue_version=queue_version+1,updated_at=? where workspace_id=? and session_id=?`).run(this.now(), record.workspaceId, sessionId);
        }
        if (state === "quiescent") {
            for (const target of record.targets)
                this.db.prepare(`update agent_run_runtime_admission set state='retired',updated_at=? where run_id=? and runtime_instance_id=? and not exists(select 1 from agent_session_stop_target where run_id=? and state<>'quiescent')`).run(this.now(), target.runId, target.runtimeInstanceId, target.runId);
        }
    }
    /** Legacy pre-v26 running records have no proof of never having been sent. Give them a durable unknown incarnation. */
    recoverUnretired<T>(settle: (workspaceId: string, runIds: string[]) => T, afterCommit?: (result: T) => void) {
        const legacy = this.db.prepare(`select workspace_id as workspaceId,session_id as sessionId,run_id as runId from agent_run r where execution_phase<>'terminal' and not exists(select 1 from agent_run_runtime_admission a where a.run_id=r.run_id)`).all() as RunScope[];
        for (const run of legacy)
            this.db.transaction(() => {
                const runtimeInstanceId = randomUUID();
                this.createInstance({ runtimeInstanceId, ownerApiInstanceId: randomUUID(), runtimeKind: "worker" }, { legacyUnknown: true });
                this.db.prepare(`update agent_runtime_instance set state='unknown' where runtime_instance_id=?`).run(runtimeInstanceId);
                this.db.prepare(`insert into agent_run_runtime_admission(workspace_id,session_id,run_id,runtime_instance_id,state,created_at,updated_at) values(?,?,?,?,'bound',?,?)`).run(run.workspaceId, run.sessionId, run.runId, runtimeInstanceId, this.now(), this.now());
            })();
        const candidates = this.db.prepare(`select distinct a.workspace_id as workspaceId,a.session_id as sessionId from agent_run_runtime_admission a where a.state<>'retired' and not exists(select 1 from agent_session_stop_target t where t.run_id=a.run_id and t.state<>'quiescent')`).all() as {
            workspaceId: string;
            sessionId: string;
        }[];
        for (const candidate of candidates) {
            const uncovered = this.db.prepare(`select 1 from agent_run_runtime_admission a where a.workspace_id=? and a.session_id=? and a.state<>'retired' and not exists(select 1 from agent_session_stop_target t where t.run_id=a.run_id and t.state<>'quiescent') limit 1`).get(candidate.workspaceId, candidate.sessionId);
            if (uncovered) {
                const stopped = this.stop({ ...candidate, rootSessionId: candidate.sessionId, operationId: randomUUID(), reason: "recovery_required" }, runIds => settle(candidate.workspaceId, runIds));
                // Each Stop has committed independently. Publish now, before a
                // later candidate can fail, never from the settle transaction.
                if (!stopped.replayed) afterCommit?.(stopped.result as T);
            }
        }
        for (const instance of this.db.prepare(`select runtime_instance_id as id from agent_runtime_instance where state='exited'`).all() as {
            id: string;
        }[])
            this.confirmExitedInstance(instance.id);
    }
}
