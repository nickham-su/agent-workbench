import type { FastifyInstance } from "fastify";
// Observes the production recovery barrier; callers cannot start recovery early.
const barriers = new WeakMap<FastifyInstance, Promise<void>>();
export function registerAgentRuntimeReadiness(app: FastifyInstance) {
    let complete!: () => void;
    let fail!: (error: unknown) => void;
    const promise = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject; });
    void promise.catch(() => undefined);
    barriers.set(app, promise);
    return { complete, fail };
}
export async function waitForAgentRuntimeReadiness(app: FastifyInstance) {
    await barriers.get(app);
}
