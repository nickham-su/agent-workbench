import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { HttpError } from "../../app/errors.js";
import type { AppContext } from "../../app/context.js";
import { createWorkspacePreviewFileService, type PreviewFileService } from "./preview-file.service.js";
import { openWorkspacePreview } from "./preview-open.service.js";

const WorkspacePreviewOpenRequestSchema = Type.Object(
  { path: Type.String({ minLength: 1, maxLength: 4096 }) },
  { additionalProperties: false }
);
const WorkspaceIdParamsSchema = Type.Object({ workspaceId: Type.String({ minLength: 1 }) });
const PREVIEW_OPEN_BODY_LIMIT = 8 * 1024;

function requestHeader(headers: Record<string, string | string[] | undefined>, name: string) {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Registers the main-origin form POST that creates a one-time preview bootstrap capability. */
export async function registerWorkspacePreviewRoutes(app: FastifyInstance, ctx: AppContext, options: { fileService?: PreviewFileService } = {}) {
  if (!ctx.preview.enabled) return;
  const previewRuntime = ctx.preview.runtime;
  const fileService = options.fileService ?? createWorkspacePreviewFileService(ctx);

  app.post(
    "/api/workspaces/:workspaceId/preview/open",
    {
      bodyLimit: PREVIEW_OPEN_BODY_LIMIT,
      schema: { tags: ["workspaces"], params: WorkspaceIdParamsSchema, body: WorkspacePreviewOpenRequestSchema }
    },
    async (request, reply) => {
      const contentType = requestHeader(request.headers, "content-type")?.toLowerCase() || "";
      if (!contentType.startsWith("application/x-www-form-urlencoded")) {
        throw new HttpError(415, "Unsupported Media Type");
      }
      const params = request.params as { workspaceId: string };
      const body = request.body as { path: string };
      const location = await openWorkspacePreview({
        runtime: previewRuntime,
        fileService,
        workspaceId: params.workspaceId,
        path: body.path,
        secFetchSite: requestHeader(request.headers, "sec-fetch-site"),
        origin: requestHeader(request.headers, "origin")
      });
      return reply
        .header("Cache-Control", "no-store")
        .header("Referrer-Policy", "no-referrer")
        .redirect(location, 303);
    }
  );
}
