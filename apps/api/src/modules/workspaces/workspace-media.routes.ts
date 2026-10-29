import type { FastifyInstance } from "fastify";
import { WorkspaceFileMediaRequestSchema, type WorkspaceFileMediaRequest } from "@agent-workbench/shared";
import type { AppContext } from "../../app/context.js";
import { HttpError } from "../../app/errors.js";
import { createWorkspacePreviewFileService, PreviewFileError } from "../preview/preview-file.service.js";
import { buildCommonPreviewHeaders, createPreviewFileReadStream, createPreviewStreamPlan } from "../preview/preview-response.js";

/** Same-origin media only: HTML, scripts and SVG must stay on the isolated preview origin. */
export async function registerWorkspaceMediaRoutes(app: FastifyInstance, ctx: Pick<AppContext, "db">) {
  const fileService = createWorkspacePreviewFileService(ctx);
  app.route<{ Params: { workspaceId: string }; Querystring: WorkspaceFileMediaRequest }>({
    method: ["GET", "HEAD"],
    url: "/api/workspaces/:workspaceId/files/media",
    exposeHeadRoute: false,
    schema: {
      tags: ["workspaces"],
      querystring: WorkspaceFileMediaRequestSchema
    },
    async handler(request, reply) {
      for (const [name, value] of Object.entries(buildCommonPreviewHeaders())) reply.header(name, value);
      try {
        // Query parameters have already been decoded once by Fastify; never decode again.
        const target = await fileService.resolve({
          workspaceId: request.params.workspaceId,
          decodedPath: request.query.path,
          trailingSlash: false
        });
        if (target.kind !== "file" || (target.resource.kind !== "audio" && target.resource.kind !== "video")) {
          throw new HttpError(415, "Only audio and video files can be played here");
        }
        const opened = await fileService.open(target);
        const plan = await createPreviewStreamPlan({
          method: request.method === "HEAD" ? "HEAD" : "GET",
          rangeHeader: request.headers.range,
          resource: target.resource,
          filePath: target.absolutePath,
          size: opened.stat.size,
          handle: opened.handle,
          createReadStream: createPreviewFileReadStream
        });
        for (const [name, value] of Object.entries(plan.headers)) reply.header(name, value);
        const release = () => {
          plan.body?.destroy();
          void plan.close().catch(() => undefined);
        };
        reply.raw.once("close", release);
        // The client may have gone away during asynchronous path/open validation.
        if (reply.raw.destroyed) {
          release();
          return reply;
        }
        return reply.code(plan.statusCode).send(plan.body);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        if (error instanceof PreviewFileError) {
          if (error.failure === "workspace_missing" || error.failure === "path_missing") {
            throw new HttpError(404, "Media file not found");
          }
          if (error.failure === "unsupported_type") throw new HttpError(415, "Unsupported media type");
          throw new HttpError(403, "Media path is not accessible");
        }
        throw new HttpError(500, "Unable to read media file");
      }
    }
  });
}
