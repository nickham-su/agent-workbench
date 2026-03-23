import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import { ErrorResponseSchema } from "@agent-workbench/shared";
import {
  AttachWorkspaceRepoRequestSchema,
  CreateWorkspaceRequestSchema,
  UpdateWorkspaceRequestSchema,
  WorkspaceDetailSchema
} from "@agent-workbench/shared";
import {
  attachRepoToWorkspace,
  createWorkspace,
  detectWorkspaceExternalSkillRoots,
  deleteWorkspace,
  detectWorkspaceAgentsInstructions,
  detachRepoFromWorkspace,
  getWorkspaceAgentsInstructionsSettings,
  getWorkspaceDetailById,
  getWorkspaceAgentEnablementSettings,
  getWorkspaceExternalSkillRootsSettings,
  listWorkspaceDetails,
  detectWorkspaceAgentEnablement,
  filterAgentsByWorkspaceEnablement,
  listWorkspaceTopLevelSkills,
  updateWorkspaceAgentsInstructionsSettings,
  updateWorkspaceExternalSkillRootsSettings,
  updateWorkspaceAgentEnablementSettings,
  updateWorkspaceById
} from "./workspace.service.js";
import { listAvailableAgentsForSurface } from "../settings/settings.service.js";
import {
  WorkspaceAgentEnablementDetectResponseSchema,
  WorkspaceAgentEnablementSettingsResponseSchema,
  UpdateWorkspaceAgentEnablementSettingsRequestSchema,
  UpdateWorkspaceExternalSkillRootsSettingsRequestSchema,
  WorkspaceExternalSkillRootsDetectResponseSchema,
  WorkspaceExternalSkillRootsSettingsResponseSchema,
  AgentListAvailableAgentsResponseSchema,
  WorkspaceAgentsInstructionsDetectResponseSchema,
  WorkspaceAgentsInstructionsSettingsResponseSchema,
  UpdateWorkspaceAgentsInstructionsSettingsRequestSchema,
  WorkspaceTopLevelSkillsResponseSchema
} from "@agent-workbench/shared";
import { nowMs } from "../../utils/time.js";
import { touchWorkspaceLastUsedAt } from "./workspace.store.js";
export async function registerWorkspacesRoutes(app: FastifyInstance, ctx: AppContext) {
  const WorkspaceIdParamsSchema = Type.Object({ workspaceId: Type.String({ minLength: 1 }) });

  app.get(
    "/api/workspaces",
    {
      schema: { tags: ["workspaces"], response: { 200: { type: "array", items: WorkspaceDetailSchema } } }
    },
    async () => listWorkspaceDetails(ctx)
  );

  app.post(
    "/api/workspaces",
    {
      schema: {
        tags: ["workspaces"],
        body: CreateWorkspaceRequestSchema,
        response: { 201: WorkspaceDetailSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema }
      }
    },
    async (req, reply) => {
      const body = req.body as { repoIds: string[]; title?: string; useTerminalCredential?: boolean };
      const ws = await createWorkspace(ctx, app.log, {
        repoIds: body.repoIds,
        title: body.title,
        useTerminalCredential: body.useTerminalCredential
      });
      const detail = await getWorkspaceDetailById(ctx, ws.id);
      return reply.code(201).send(detail);
    }
  );

  app.get(
    "/api/workspaces/:workspaceId",
    {
      schema: { tags: ["workspaces"], response: { 200: WorkspaceDetailSchema, 404: ErrorResponseSchema } }
    },
    async (req) => {
      const params = req.params as { workspaceId: string };
      const detail = await getWorkspaceDetailById(ctx, params.workspaceId);
      // “最近使用”以用户进入 workspace 页并拉取详情为准（不要求强一致）。
      try {
        touchWorkspaceLastUsedAt(ctx.db, params.workspaceId, nowMs());
      } catch {
        // ignore
      }
      return detail;
    }
  );

  app.patch(
    "/api/workspaces/:workspaceId",
    {
      schema: {
        tags: ["workspaces"],
        body: UpdateWorkspaceRequestSchema,
        response: { 200: WorkspaceDetailSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema }
      }
    },
    async (req) => {
      const params = req.params as { workspaceId: string };
      const body = req.body as { title?: string; useTerminalCredential?: boolean };
      return updateWorkspaceById(ctx, app.log, params.workspaceId, {
        title: body.title,
        useTerminalCredential: body.useTerminalCredential
      });
    }
  );

  app.delete(
    "/api/workspaces/:workspaceId",
    {
      schema: { tags: ["workspaces"], response: { 204: { type: "null" }, 404: ErrorResponseSchema, 409: ErrorResponseSchema } }
    },
    async (req, reply) => {
      const params = req.params as { workspaceId: string };
      await deleteWorkspace(ctx, app.log, params.workspaceId);
      return reply.code(204).send();
    }
  );

  app.post(
    "/api/workspaces/:workspaceId/repos",
    {
      schema: {
        tags: ["workspaces"],
        body: AttachWorkspaceRepoRequestSchema,
        response: { 200: WorkspaceDetailSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema }
      }
    },
    async (req) => {
      const params = req.params as { workspaceId: string };
      const body = req.body as { repoId: string; branch?: string };
      return attachRepoToWorkspace(ctx, app.log, params.workspaceId, { repoId: body.repoId, branch: body.branch });
    }
  );

  app.delete(
    "/api/workspaces/:workspaceId/repos/:repoId",
    {
      schema: {
        tags: ["workspaces"],
        response: { 200: WorkspaceDetailSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema }
      }
    },
    async (req) => {
      const params = req.params as { workspaceId: string; repoId: string };
      return detachRepoFromWorkspace(ctx, app.log, params.workspaceId, params.repoId);
    }
  );

  app.get(
    "/api/workspaces/:workspaceId/agents-instructions/detect",
    {
      schema: {
        tags: ["workspaces"],
        params: WorkspaceIdParamsSchema,
        response: { 200: WorkspaceAgentsInstructionsDetectResponseSchema, 404: ErrorResponseSchema }
      }
    },
    async (req) => {
      const params = req.params as { workspaceId: string };
      return detectWorkspaceAgentsInstructions(ctx, app.log, params.workspaceId);
    }
  );

  app.get(
    "/api/workspaces/:workspaceId/agents-instructions/settings",
    {
      schema: {
        tags: ["workspaces"],
        params: WorkspaceIdParamsSchema,
        response: { 200: WorkspaceAgentsInstructionsSettingsResponseSchema, 404: ErrorResponseSchema }
      }
    },
    async (req) => {
      const params = req.params as { workspaceId: string };
      return getWorkspaceAgentsInstructionsSettings(ctx, params.workspaceId);
    }
  );

  app.put(
    "/api/workspaces/:workspaceId/agents-instructions/settings",
    {
      schema: {
        tags: ["workspaces"],
        params: WorkspaceIdParamsSchema,
        body: UpdateWorkspaceAgentsInstructionsSettingsRequestSchema,
        response: { 200: WorkspaceAgentsInstructionsSettingsResponseSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema }
      }
    },
    async (req) => {
      const params = req.params as { workspaceId: string };
      return updateWorkspaceAgentsInstructionsSettings(ctx, app.log, params.workspaceId, req.body as any);
    }
  );

  app.get(
    "/api/workspaces/:workspaceId/external-skill-roots/detect",
    {
      schema: {
        tags: ["workspaces"],
        params: WorkspaceIdParamsSchema,
        response: { 200: WorkspaceExternalSkillRootsDetectResponseSchema, 404: ErrorResponseSchema }
      }
    },
    async (req) => {
      const params = req.params as { workspaceId: string };
      return detectWorkspaceExternalSkillRoots(ctx, app.log, params.workspaceId);
    }
  );

  app.get(
    "/api/workspaces/:workspaceId/external-skill-roots/settings",
    {
      schema: {
        tags: ["workspaces"],
        params: WorkspaceIdParamsSchema,
        response: { 200: WorkspaceExternalSkillRootsSettingsResponseSchema, 404: ErrorResponseSchema }
      }
    },
    async (req) => {
      const params = req.params as { workspaceId: string };
      return getWorkspaceExternalSkillRootsSettings(ctx, params.workspaceId);
    }
  );

  app.put(
    "/api/workspaces/:workspaceId/external-skill-roots/settings",
    {
      schema: {
        tags: ["workspaces"],
        params: WorkspaceIdParamsSchema,
        body: UpdateWorkspaceExternalSkillRootsSettingsRequestSchema,
        response: { 200: WorkspaceExternalSkillRootsSettingsResponseSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema }
      }
    },
    async (req) => {
      const params = req.params as { workspaceId: string };
      return updateWorkspaceExternalSkillRootsSettings(ctx, app.log, params.workspaceId, req.body as any);
    }
  );

  app.get(
    "/api/workspaces/:workspaceId/skills/top-level",
    {
      schema: {
        tags: ["workspaces"],
        params: WorkspaceIdParamsSchema,
        response: { 200: WorkspaceTopLevelSkillsResponseSchema, 404: ErrorResponseSchema }
      }
    },
    async (req) => {
      const params = req.params as { workspaceId: string };
      return listWorkspaceTopLevelSkills(ctx, app.log, params.workspaceId);
    }
  );

  app.get(
    "/api/workspaces/:workspaceId/agent-enablement/detect",
    {
      schema: {
        tags: ["workspaces"],
        params: WorkspaceIdParamsSchema,
        response: { 200: WorkspaceAgentEnablementDetectResponseSchema, 404: ErrorResponseSchema }
      }
    },
    async (req) => {
      const params = req.params as { workspaceId: string };
      return detectWorkspaceAgentEnablement(ctx, params.workspaceId);
    }
  );

  app.get(
    "/api/workspaces/:workspaceId/agent-enablement/settings",
    {
      schema: {
        tags: ["workspaces"],
        params: WorkspaceIdParamsSchema,
        response: { 200: WorkspaceAgentEnablementSettingsResponseSchema, 404: ErrorResponseSchema }
      }
    },
    async (req) => {
      const params = req.params as { workspaceId: string };
      return getWorkspaceAgentEnablementSettings(ctx, params.workspaceId);
    }
  );

  app.put(
    "/api/workspaces/:workspaceId/agent-enablement/settings",
    {
      schema: {
        tags: ["workspaces"],
        params: WorkspaceIdParamsSchema,
        body: UpdateWorkspaceAgentEnablementSettingsRequestSchema,
        response: { 200: WorkspaceAgentEnablementSettingsResponseSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema }
      }
    },
    async (req) => {
      const params = req.params as { workspaceId: string };
      return updateWorkspaceAgentEnablementSettings(ctx, params.workspaceId, req.body as any);
    }
  );

  app.get(
    "/api/workspaces/:workspaceId/agents/available",
    {
      schema: {
        tags: ["workspaces"],
        params: WorkspaceIdParamsSchema,
        querystring: Type.Object({ surface: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("subtask")])) }),
        response: { 200: AgentListAvailableAgentsResponseSchema, 404: ErrorResponseSchema }
      }
    },
    async (req) => {
      const params = req.params as { workspaceId: string };
      await getWorkspaceDetailById(ctx, params.workspaceId);
      const query = req.query as { surface?: "user" | "subtask" };
      const surface = query.surface === "subtask" ? "subtask" : "user";
      const all = listAvailableAgentsForSurface(ctx, surface);
      const enabled = await getWorkspaceAgentEnablementSettings(ctx, params.workspaceId);
      const filtered = filterAgentsByWorkspaceEnablement({
        agents: all,
        enabledAgentIds: enabled.enabledAgentIds,
        mode: enabled.mode
      });
      return { agents: filtered };
    }
  );
}
