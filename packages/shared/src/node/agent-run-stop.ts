import { createHash, randomUUID } from "node:crypto";
import type { AgentWorkerStopRunsRequest, AgentWorkerStopRunsResponse } from "../internal-contracts/agent-worker.js";
export type RuntimeStopTarget = {
    sessionId: string;
    runId: string;
    runtimeInstanceId: string;
};
export function canonicalRuntimeStopJson(value: unknown): string {
    if (value === null || typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(canonicalRuntimeStopJson).join(",")}]`;
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalRuntimeStopJson(object[key])}`).join(",")}}`;
}
export function runtimeStopTargetsHash(input: {
    workspaceId: string;
    rootSessionId: string;
    operationId: string;
    targets: RuntimeStopTarget[];
}) {
    const targets = [...input.targets].sort((a, b) => {
        for (const key of ["runtimeInstanceId", "sessionId", "runId"] as const) {
            const order = Buffer.compare(Buffer.from(a[key]), Buffer.from(b[key]));
            if (order)
                return order;
        }
        return 0;
    });
    return createHash("sha256").update(canonicalRuntimeStopJson({ version: "agent-stop-target-set-v1", workspaceId: input.workspaceId, rootSessionId: input.rootSessionId, operationId: input.operationId, targets })).digest("hex");
}
export class AgentRuntimeStopError extends Error {
    constructor(readonly code: "AGENT_RUNTIME_INSTANCE_MISMATCH" | "AGENT_STOP_OPERATION_CONFLICT" | "AGENT_RUNTIME_BINDING_MISMATCH") { super(code); }
}
/** The narrow in-process half of the durable stop protocol. All final checks and registration are synchronous. */
export class AgentRunStopRegistry {
    private readonly tombstones = new Set<string>();
    private readonly tracked = new Map<string, {
        sessionId: string;
        token: symbol;
        cancel(): void;
    }>();
    private readonly operations = new Map<string, {
        hash: string;
        proofId: string | null;
    }>();
    constructor(readonly runtimeInstanceId: string) { }
    mayRegister(runId: string) { return !this.tombstones.has(runId); }
    register(input: {
        sessionId: string;
        runId: string;
    }, cancel: () => void): symbol | null {
        if (!this.mayRegister(input.runId))
            return null;
        if (this.tracked.has(input.runId))
            throw new AgentRuntimeStopError("AGENT_RUNTIME_BINDING_MISMATCH");
        const token = Symbol(input.runId);
        this.tracked.set(input.runId, { sessionId: input.sessionId, cancel, token });
        return token;
    }
    activate(input: {
        sessionId: string;
        runId: string;
    }, queuedToken: symbol, cancel: () => void): symbol | null {
        const tracked = this.tracked.get(input.runId);
        if (!this.mayRegister(input.runId) || tracked?.token !== queuedToken || tracked.sessionId !== input.sessionId)
            return null;
        const token = Symbol(input.runId);
        this.tracked.set(input.runId, { sessionId: input.sessionId, token, cancel });
        return token;
    }
    unregister(runId: string, token: symbol) {
        if (this.tracked.get(runId)?.token === token)
            this.tracked.delete(runId);
    }
    complete(runId: string, token: symbol) {
        if (this.tracked.get(runId)?.token !== token)
            return;
        this.tombstones.add(runId);
        this.unregister(runId, token);
    }
    get size() { return this.tracked.size; }
    async stopRunsAndWait(request: AgentWorkerStopRunsRequest, bindingMatches: (target: {
        sessionId: string;
        runId: string;
    }) => boolean | Promise<boolean>): Promise<AgentWorkerStopRunsResponse> {
        if (request.runtimeInstanceId !== this.runtimeInstanceId)
            throw new AgentRuntimeStopError("AGENT_RUNTIME_INSTANCE_MISMATCH");
        const hash = runtimeStopTargetsHash({ ...request, targets: request.targets.map((target) => ({ ...target, runtimeInstanceId: request.runtimeInstanceId })) });
        if (hash !== request.targetsHash || new Set(request.targets.map((target) => target.runId)).size !== request.targets.length)
            throw new AgentRuntimeStopError("AGENT_STOP_OPERATION_CONFLICT");
        const key = canonicalRuntimeStopJson([request.workspaceId, request.rootSessionId, request.operationId]);
        let operation = this.operations.get(key);
        if (operation && operation.hash !== hash)
            throw new AgentRuntimeStopError("AGENT_STOP_OPERATION_CONFLICT");
        if (!operation) {
            operation = { hash, proofId: null };
            this.operations.set(key, operation);
        }
        const scope = { workspaceId: request.workspaceId, rootSessionId: request.rootSessionId, operationId: request.operationId, runtimeInstanceId: this.runtimeInstanceId, targetsHash: hash };
        if (operation.proofId)
            return { ...scope, state: "quiescent", proofId: operation.proofId, code: null };
        // Read trusted binding even when the Run is terminal or admission is closed.
        for (const target of request.targets) {
            if (!await bindingMatches(target))
                throw new AgentRuntimeStopError("AGENT_RUNTIME_BINDING_MISMATCH");
            const tracked = this.tracked.get(target.runId);
            if (tracked && tracked.sessionId !== target.sessionId)
                throw new AgentRuntimeStopError("AGENT_RUNTIME_BINDING_MISMATCH");
        }
        // No await between installing all tombstones and cancelling the exact registrations.
        for (const target of request.targets)
            this.tombstones.add(target.runId);
        for (const target of request.targets)
            this.tracked.get(target.runId)?.cancel();
        const deadline = Date.now() + request.timeoutMs;
        while (request.targets.some((target) => this.tracked.has(target.runId))) {
            if (Date.now() >= deadline)
                return { ...scope, state: "pending", proofId: null, code: "runner_not_quiescent" };
            await new Promise<void>((resolve) => setTimeout(resolve, Math.min(10, Math.max(1, deadline - Date.now()))));
        }
        operation.proofId ??= randomUUID();
        return { ...scope, state: "quiescent", proofId: operation.proofId, code: null };
    }
}
