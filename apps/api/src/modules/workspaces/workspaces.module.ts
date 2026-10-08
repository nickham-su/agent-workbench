import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import { workspaceDeletingFence } from "../agent/lifecycle/workspace-deleting-fence.js";
import { listWorkspaceDeletionIntents } from "./workspace-deletion.store.js";
import { registerWorkspaceFilesRoutes } from "./workspace-files.routes.js";
import { registerWorkspacesRoutes } from "./workspaces.routes.js";

export async function registerWorkspacesModule(app: FastifyInstance, ctx: AppContext) {
  // 路由注册前先从 durable intent 恢复拒写 fence；运行时续作由 Agent 模块 ready 后执行。
  for (const intent of listWorkspaceDeletionIntents(ctx.db)) workspaceDeletingFence.restore(intent.workspaceId);
  await registerWorkspacesRoutes(app, ctx);
  await registerWorkspaceFilesRoutes(app, ctx);
}
