import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "../../app/context.js";
import { ErrorResponseSchema } from "@agent-workbench/shared";
import {
  AttachWorkspaceRepoRequestSchema,
  CreateWorkspaceRequestSchema,
  UpdateWorkspaceAgentSessionTabVisibilityRequestSchema,
  UpdateWorkspaceRequestSchema,
  WorkspaceAgentSessionTabStateParamsSchema,
  WorkspaceAgentSessionTabVisibilityMutationSchema,
  WorkspaceAgentTabStateSchema,
  WorkspaceDetailSchema
} from "@agent-workbench/shared";
import { HttpError } from "../../app/errors.js";
import { AgentListAvailableAgentsResponseSchema } from "@agent-workbench/shared/internal-contracts/agent-api-session";
import {
  attachRepoToWorkspace,
  createWorkspace,
  deleteWorkspace,
  detachRepoFromWorkspace,
  getWorkspaceAgentTabState,
  getWorkspaceDetailById,
  getWorkspaceAgentEnablementSettings,
  listWorkspaceDetails,
  detectWorkspaceAgentEnablement,
  filterAgentsByWorkspaceEnablement,
  setWorkspaceAgentSessionTabVisibility,
  updateWorkspaceAgentEnablementSettings,
  updateWorkspaceById
} from "./workspace.service.js";
import { detectWorkspaceContextFiles, getWorkspaceContextFilesSettings, updateWorkspaceContextFilesSettings, listWorkspaceContextTopLevelSkills } from "./workspace-context.service.js";
import { listAvailableAgentsForListSurface, type AgentListSurface } from "../settings/settings.service.js";
import {
  WorkspaceAgentEnablementDetectResponseSchema,
  WorkspaceAgentEnablementSettingsResponseSchema,
  UpdateWorkspaceAgentEnablementSettingsRequestSchema,
  WorkspaceTopLevelSkillsResponseSchema,
  WorkspaceContextFilesDetectResponseSchema,
  WorkspaceContextFilesSettingsResponseSchema,
  UpdateWorkspaceContextFilesSettingsRequestSchema,
  type UpdateWorkspaceContextFilesSettingsRequest
} from "@agent-workbench/shared";
import { nowMs } from "../../utils/time.js";
import { touchWorkspaceLastUsedAt } from "./workspace.store.js";
import { workspaceLifecycleCoordinator } from "../../infra/locks/workspace-lifecycle-coordinator.js";

const AGENT_TAB_STATE_BODY_KEYS = new Set(["visible"]);

async function assertOnlyAgentTabStateBodyKeys(req: FastifyRequest) {
  const body = req.body;
  if (body == null || typeof body !== "object" || Array.isArray(body)) return;
  const tabStateBody = body as Record<string, unknown>;
  for (const key of Object.keys(tabStateBody)) {
    if (!AGENT_TAB_STATE_BODY_KEYS.has(key)) {
      throw new HttpError(400, "request body contains unknown field", "WORKSPACE_AGENT_TAB_STATE_UNKNOWN_FIELD");
    }
  }
  if (Object.hasOwn(tabStateBody, "visible") && typeof tabStateBody.visible !== "boolean") {
    throw new HttpError(400, "visible must be a boolean");
  }
}

export async function registerWorkspacesRoutes(app: FastifyInstance, ctx: AppContext) {
  const WorkspaceIdParamsSchema = Type.Object({ workspaceId: Type.String({ minLength: 1 }) });

  app.get(
    "/api/workspaces",
    {
      schema: { tags: ["workspaces"], response: { 200: { type: "array", items: WorkspaceDetailSchema } } }
    },
    async () => listWorkspaceDetails(ctx)
  );

  app.get(
    "/api/workspaces/:workspaceId/agent-tab-state",
    {
      schema: {
        tags: ["workspaces"],
        params: WorkspaceIdParamsSchema,
        response: { 200: WorkspaceAgentTabStateSchema, 404: ErrorResponseSchema }
      }
    },
    async (req) => {
      const params = req.params as { workspaceId: string };
      return getWorkspaceAgentTabState(ctx, params.workspaceId);
    }
  );

  app.put(
    "/api/workspaces/:workspaceId/agent-tab-state/:sessionId",
    {
      preValidation: assertOnlyAgentTabStateBodyKeys,
      schema: {
        tags: ["workspaces"],
        params: WorkspaceAgentSessionTabStateParamsSchema,
        body: UpdateWorkspaceAgentSessionTabVisibilityRequestSchema,
        response: {
          200: WorkspaceAgentSessionTabVisibilityMutationSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema
        }
      }
    },
    async (req) => {
      const params = req.params as { workspaceId: string; sessionId: string };
      const body = req.body as { visible: boolean };
      return setWorkspaceAgentSessionTabVisibility(ctx, { ...params, visible: body.visible });
    }
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
        await workspaceLifecycleCoordinator.withMutation(params.workspaceId, async () => {
          touchWorkspaceLastUsedAt(ctx.db, params.workspaceId, nowMs());
        });
      } catch {
        // 详情读取不因 best-effort 元数据写失败而失败；deleting fence 仍阻止该写入。
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

  app.get("/api/workspaces/:workspaceId/context-files/detect", {
    schema: { tags: ["workspaces"], params: WorkspaceIdParamsSchema,
      response: { 200: WorkspaceContextFilesDetectResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema } }
  }, async (req) => detectWorkspaceContextFiles(ctx, (req.params as { workspaceId: string }).workspaceId));

  app.get("/api/workspaces/:workspaceId/context-files/settings", {
    schema: { tags: ["workspaces"], params: WorkspaceIdParamsSchema,
      response: { 200: WorkspaceContextFilesSettingsResponseSchema, 404: ErrorResponseSchema } }
  }, async (req) => getWorkspaceContextFilesSettings(ctx, (req.params as { workspaceId: string }).workspaceId));

  app.put("/api/workspaces/:workspaceId/context-files/settings", {
    schema: { tags: ["workspaces"], params: WorkspaceIdParamsSchema, body: UpdateWorkspaceContextFilesSettingsRequestSchema,
      response: { 200: WorkspaceContextFilesSettingsResponseSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema } }
  }, async (req) => updateWorkspaceContextFilesSettings(ctx, (req.params as { workspaceId: string }).workspaceId, req.body as UpdateWorkspaceContextFilesSettingsRequest));

  app.get(
    "/api/workspaces/:workspaceId/skills/top-level",
    {
      schema: {
        tags: ["workspaces"],
        params: WorkspaceIdParamsSchema,
        response: { 200: WorkspaceTopLevelSkillsResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema }
      }
    },
    async (req) => {
      const params = req.params as { workspaceId: string };
      return listWorkspaceContextTopLevelSkills(ctx, app.log, params.workspaceId);
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
        querystring: Type.Object({ surface: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("subtask"), Type.Literal("all")])) }),
        response: { 200: AgentListAvailableAgentsResponseSchema, 404: ErrorResponseSchema }
      }
    },
    async (req) => {
      const params = req.params as { workspaceId: string };
      await getWorkspaceDetailById(ctx, params.workspaceId);
      const query = req.query as { surface?: AgentListSurface };
      const surface = query.surface ?? "user";
      const all = listAvailableAgentsForListSurface(ctx, surface);
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
