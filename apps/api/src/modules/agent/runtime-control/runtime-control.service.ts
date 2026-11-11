import type { AgentApiConvergeRunTerminalRequest } from "@agent-workbench/shared/internal-contracts/agent-api";
import { randomUUID } from "node:crypto";
import { runtimeStopTargetsHash } from "@agent-workbench/shared/node/agent-run-stop";
import type { AgentWorkerStopRunsRequest, AgentWorkerStopRunsResponse } from "@agent-workbench/shared/internal-contracts/agent-worker";
import type { AgentRuntimePort, AgentRuntimeRun } from "../agent.runtime-port.js";
import { HttpError } from "../../../app/errors.js";
import { convergeRunTerminal, getPersistedRunTerminalIntent, persistRunTerminalIntent } from "../agent-message.store.js";
import { AgentRuntimeControlStore, type RuntimeStopRecord } from "./runtime-control.store.js";
type ExactRuntime = AgentRuntimePort & {
    stopRunsAndWait(input: AgentWorkerStopRunsRequest): Promise<AgentWorkerStopRunsResponse>;
};
/** API-owned admission and the bounded reconciler for durable, fixed-target stops. */
export class AgentRuntimeControlService implements AgentRuntimePort {
    private runtimeInstanceId: string | null = null;
    private accepting = false;
    private scanCursor: RuntimeStopRecord | undefined;
    private readonly groupCursor = new Map<string, number>();
    private readonly retries = new Map<string, {
        nextAt: number;
        attempt: number;
    }>();
    private timer: ReturnType<typeof setInterval> | null = null;
    private reconciling: Promise<void> | null = null;
    constructor(
        readonly store: AgentRuntimeControlStore,
        private readonly runtime: ExactRuntime,
        private readonly now = Date.now,
        private readonly publishCommittedTerminalConvergence?: (
            params: AgentApiConvergeRunTerminalRequest,
            result: ReturnType<typeof convergeRunTerminal>,
        ) => void,
    ) { }
    ready(runtimeInstanceId: string, accepting = true) { this.runtimeInstanceId = runtimeInstanceId; this.accepting = accepting; }
    openAdmission() { if (this.runtimeInstanceId)
        this.accepting = true; }
    get currentRuntimeInstanceId() { return this.runtimeInstanceId; }
    blockAdmission() { this.accepting = false; }
    async enqueueRun(run: AgentRuntimeRun) {
        if (!this.accepting || !this.runtimeInstanceId)
            throw new HttpError(503, "Agent runtime is not ready", "AGENT_RUNTIME_ADMISSION_CLOSED");
        const runtimeInstanceId = this.runtimeInstanceId;
        this.store.bindAdmission(run, runtimeInstanceId);
        // Binding must commit before the first possible physical send. Stop can now capture this exact incarnation.
        await this.runtime.enqueueRun({ ...run, runtimeInstanceId });
    }
    async cancelSession(sessionId: string) {
        const session = this.store.db.prepare("select workspace_id as workspaceId from agent_session where id=?").get(sessionId) as {
            workspaceId: string;
        } | undefined;
        if (!session)
            return;
        this.stopSession({ workspaceId: session.workspaceId, rootSessionId: sessionId, operationId: randomUUID() });
        await this.reconcileStops();
    }
    async cancelSessionAndWait(input: {
        sessionId: string;
        timeoutMs: number;
    }) {
        const session = this.store.db.prepare("select workspace_id as workspaceId from agent_session where id=?").get(input.sessionId) as {
            workspaceId: string;
        } | undefined;
        if (!session)
            return true;
        this.stopSession({ workspaceId: session.workspaceId, rootSessionId: input.sessionId, operationId: randomUUID() });
        const deadline = this.now() + input.timeoutMs;
        while (true) {
            const blocked = this.store.db.prepare(`select 1 from agent_session_stop_barrier where root_session_id=? and state<>'quiescent' union all select 1 from agent_session_stop_target where target_session_id=? and state<>'quiescent' limit 1`).get(input.sessionId, input.sessionId);
            if (!blocked)
                return true;
            const remaining = deadline - this.now();
            if (remaining <= 0)
                return false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([this.reconcileStops(), new Promise<void>(resolve => { timer = setTimeout(resolve, remaining); })]);
            }
            finally {
                if (timer)
                    clearTimeout(timer);
            }
            if (this.now() < deadline)
                await new Promise<void>(resolve => setTimeout(resolve, Math.min(20, Math.max(1, deadline - this.now()))));
        }
    }
    stopSession(input: {
        workspaceId: string;
        rootSessionId: string;
        operationId: string;
        reason?: "user_stop" | "recovery_required";
    }) {
        this.assertOutsideTransaction();
        const stopped = this.store.stop(input, runIds => this.settleClosedRuns(input.workspaceId, runIds, input.reason === "recovery_required"));
        if (!stopped.replayed) this.publishConvergences(stopped.result ?? []);
        return stopped;
    }
    private settleClosedRuns(workspaceId: string, runIds: string[], startupRecovery = false) {
        const runs = this.store.db.prepare(`select r.workspace_id as workspaceId,r.session_id as sessionId,r.run_id as runId
      from agent_run r join agent_run_runtime_admission a on a.run_id=r.run_id
      where r.execution_phase<>'terminal' and r.workspace_id=? and r.run_id in (select value from json_each(?))
        and (a.runtime_instance_id is not null or exists(select 1 from session_run_state s where s.active_run_id=r.run_id and s.status='running'))`)
            .all(workspaceId, JSON.stringify(runIds)) as {
            workspaceId: string;
            sessionId: string;
            runId: string;
        }[];
        return runs.map(run => {
            const updatedAt = this.now();
            if (!getPersistedRunTerminalIntent(this.store.db, run))
                persistRunTerminalIntent(this.store.db, { ...run, status: startupRecovery ? "failed" : "cancelled", code: startupRecovery ? "run_startup_recovery_failed" : "run_cancelled", detail: null, updatedAt });
            const result = convergeRunTerminal(this.store.db, { ...run, updatedAt });
            return { ...run, updatedAt, result };
        });
    }
    private assertOutsideTransaction() {
        if (this.store.db.inTransaction) throw new Error("Runtime control requires a top-level commit boundary");
    }
    private publishConvergences(convergences: ReturnType<AgentRuntimeControlService["settleClosedRuns"]>) {
        for (const { result, ...params } of convergences)
            this.publishCommittedTerminalConvergence?.(params, result);
    }
    recover() {
        this.assertOutsideTransaction();
        this.store.recoverUnretired(
            (workspaceId, runIds) => this.settleClosedRuns(workspaceId, runIds, true),
            results => this.publishConvergences(results),
        );
    }
    startReconciler() {
        if (this.timer)
            return;
        this.timer = setInterval(() => { void this.reconcileStops().catch(() => undefined); }, 500);
        this.timer.unref();
    }
    async close() {
        this.blockAdmission();
        if (this.timer)
            clearInterval(this.timer);
        this.timer = null;
        if (this.reconciling)
            await this.reconciling;
    }
    async stopAllForShutdown() {
        this.blockAdmission();
        const sessions = this.store.db.prepare(`select distinct workspace_id as workspaceId,session_id as sessionId from agent_run_runtime_admission where state<>'retired'`).all() as {
            workspaceId: string;
            sessionId: string;
        }[];
        for (const session of sessions)
            this.stopSession({ workspaceId: session.workspaceId, rootSessionId: session.sessionId, operationId: randomUUID(), reason: "recovery_required" });
        await this.reconcileStops();
    }
    reconcileStops(): Promise<void> {
        if (this.reconciling)
            return this.reconciling;
        this.reconciling = this.reconcileOnce().finally(() => { this.reconciling = null; });
        return this.reconciling;
    }
    private async reconcileOnce() {
        const deadline = this.now() + 1000;
        let records = this.store.listPendingStops(this.scanCursor);
        if (!records.length && this.scanCursor) {
            this.scanCursor = undefined;
            records = this.store.listPendingStops();
        }
        const visitedSessions = new Set<string>();
        for (const record of records) {
            if (this.now() >= deadline)
                return;
            // Advance even for unchanged unknown/backoff entries: old first-page
            // operations must not starve later durable Stops.
            this.scanCursor = record;
            const operationKey = JSON.stringify([record.workspaceId, record.rootSessionId, record.operationId]);
            const sessionKey = JSON.stringify([record.workspaceId, record.rootSessionId]);
            if (visitedSessions.has(sessionKey))
                continue;
            const groups = [...new Set(record.targets.map(target => target.runtimeInstanceId))];
            const first = (this.groupCursor.get(operationKey) ?? 0) % groups.length;
            for (let offset = 0; offset < groups.length; offset++) {
                const index = (first + offset) % groups.length;
                const runtimeInstanceId = groups[index]!;
                const key = JSON.stringify([operationKey, runtimeInstanceId]);
                const retry = this.retries.get(key);
                if (retry && retry.nextAt > this.now())
                    continue;
                const unfinished = this.store.db.prepare(`select 1 from agent_session_stop_target where workspace_id=? and root_session_id=? and operation_id=? and runtime_instance_id=? and state<>'quiescent' limit 1`)
                    .get(record.workspaceId, record.rootSessionId, record.operationId, runtimeInstanceId);
                if (!unfinished) {
                    this.retries.delete(key);
                    continue;
                }
                visitedSessions.add(sessionKey);
                this.groupCursor.set(operationKey, index + 1);
                const instance = this.store.getInstance(runtimeInstanceId);
                let settled = false;
                if (instance?.state === 'exited') {
                    this.store.confirmExitedInstance(runtimeInstanceId);
                    settled = true;
                }
                else if (runtimeInstanceId !== this.runtimeInstanceId)
                    this.store.markGroupUnknown(record, runtimeInstanceId, "runtime_exit_unproven");
                else {
                    const targets = record.targets.filter(target => target.runtimeInstanceId === runtimeInstanceId);
                    const request: AgentWorkerStopRunsRequest = { workspaceId: record.workspaceId, rootSessionId: record.rootSessionId, operationId: record.operationId, runtimeInstanceId, targets: targets.map(({ sessionId, runId }) => ({ sessionId, runId })), targetsHash: runtimeStopTargetsHash({ ...record, targets }), timeoutMs: 100 };
                    try {
                        const response = await this.runtime.stopRunsAndWait(request);
                        this.store.confirmStopGroup(record, runtimeInstanceId, response);
                        settled = response.state === 'quiescent';
                    }
                    catch {
                        this.store.markGroupUnknown(record, runtimeInstanceId, "transport_unavailable");
                    }
                }
                if (settled)
                    this.retries.delete(key);
                else {
                    const attempt = Math.min((retry?.attempt ?? 0) + 1, 7);
                    this.retries.set(key, { attempt, nextAt: this.now() + Math.min(30000, 250 * 2 ** attempt) });
                }
                // One exact instance group per root Session in each bounded scan.
                break;
            }
        }
    }
}
