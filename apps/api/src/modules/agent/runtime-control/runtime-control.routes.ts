import type { FastifyInstance } from "fastify";
import { AgentApiEndpoints, AgentApiCheckRuntimeAdmissionRequestSchema, AgentApiCheckRuntimeAdmissionResponseSchema, AgentApiRetireRuntimeAdmissionRequestSchema, AgentApiRetireRuntimeAdmissionResponseSchema, type AgentApiCheckRuntimeAdmissionRequest, type AgentApiRetireRuntimeAdmissionRequest } from "@agent-workbench/shared/internal-contracts/agent-api";
import { assertInternalToken } from "../routes/agent-route-auth.js";
import type { AgentRuntimeControlStore } from "./runtime-control.store.js";
export async function registerAgentRuntimeControlRoutes(app: FastifyInstance, store: AgentRuntimeControlStore, internalToken: string, onRetired?: () => void) {
    app.post(AgentApiEndpoints.checkRuntimeAdmission.path, {
        schema: { tags: ["agent"], body: AgentApiCheckRuntimeAdmissionRequestSchema, response: { 200: AgentApiCheckRuntimeAdmissionResponseSchema } },
        handler: req => { assertInternalToken(req, internalToken); return store.checkAdmission(req.body as AgentApiCheckRuntimeAdmissionRequest); }
    });
    app.post(AgentApiEndpoints.retireRuntimeAdmission.path, {
        schema: { tags: ["agent"], body: AgentApiRetireRuntimeAdmissionRequestSchema, response: { 200: AgentApiRetireRuntimeAdmissionResponseSchema } },
        handler: req => { assertInternalToken(req, internalToken); const result = store.retireAdmission(req.body as AgentApiRetireRuntimeAdmissionRequest); if (result.retired) onRetired?.(); return result; }
    });
}
