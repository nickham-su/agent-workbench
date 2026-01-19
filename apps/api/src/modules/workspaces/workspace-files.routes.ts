import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import {
  ErrorResponseSchema,
  FileCreateResponseSchema,
  FileDeleteResponseSchema,
  FileListResponseSchema,
  FileMkdirResponseSchema,
  FileReadResponseSchema,
  FileRenameResponseSchema,
  FileStatResponseSchema,
  FileWriteResponseSchema,
  WorkspaceFileCreateRequestSchema,
  WorkspaceFileDeleteRequestSchema,
  WorkspaceFileListRequestSchema,
  WorkspaceFileMkdirRequestSchema,
  WorkspaceFileReadRequestSchema,
  WorkspaceFileRenameRequestSchema,
  WorkspaceFileStatRequestSchema,
  WorkspaceFileWriteRequestSchema
} from "@agent-workbench/shared";
import {
  WorkspaceFileConflictError,
  createWorkspaceFile,
  deleteWorkspacePath,
  listWorkspaceFiles,
  mkdirWorkspacePath,
  readWorkspaceFileText,
  renameWorkspacePath,
  statWorkspaceFile,
  writeWorkspaceFileText
} from "./workspace-files.service.js";

export async function registerWorkspaceFilesRoutes(app: FastifyInstance, ctx: AppContext) {
  app.post(
    "/api/workspaces/:workspaceId/files/list",
    {
      schema: {
        tags: ["workspaces"],
        body: WorkspaceFileListRequestSchema,
        response: { 200: FileListResponseSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema }
      }
    },
    async (req) => {
      const params = req.params as { workspaceId: string };
      return listWorkspaceFiles(ctx, params.workspaceId, req.body);
    }
  );

  app.post(
    "/api/workspaces/:workspaceId/files/stat",
    {
      schema: {
        tags: ["workspaces"],
        body: WorkspaceFileStatRequestSchema,
        response: { 200: FileStatResponseSchema, 400: ErrorResponseSchema, 403: ErrorResponseSchema, 404: ErrorResponseSchema }
      }
    },
    async (req) => {
      const params = req.params as { workspaceId: string };
      return statWorkspaceFile(ctx, params.workspaceId, req.body);
    }
  );

  app.post(
    "/api/workspaces/:workspaceId/files/read-text",
    {
      schema: {
        tags: ["workspaces"],
        body: WorkspaceFileReadRequestSchema,
        response: { 200: FileReadResponseSchema, 400: ErrorResponseSchema, 403: ErrorResponseSchema, 404: ErrorResponseSchema }
      }
    },
    async (req) => {
      const params = req.params as { workspaceId: string };
      return readWorkspaceFileText(ctx, params.workspaceId, req.body);
    }
  );

  app.post(
    "/api/workspaces/:workspaceId/files/write-text",
    {
      schema: {
        tags: ["workspaces"],
        body: WorkspaceFileWriteRequestSchema,
        response: { 200: FileWriteResponseSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: FileWriteResponseSchema }
      }
    },
    async (req, reply) => {
      const params = req.params as { workspaceId: string };
      try {
        return await writeWorkspaceFileText(ctx, params.workspaceId, req.body);
      } catch (err) {
        if (err instanceof WorkspaceFileConflictError) {
          return reply.code(409).send(err.payload);
        }
        throw err;
      }
    }
  );

  app.post(
    "/api/workspaces/:workspaceId/files/create",
    {
      schema: {
        tags: ["workspaces"],
        body: WorkspaceFileCreateRequestSchema,
        response: { 200: FileCreateResponseSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema }
      }
    },
    async (req) => {
      const params = req.params as { workspaceId: string };
      return createWorkspaceFile(ctx, params.workspaceId, req.body);
    }
  );

  app.post(
    "/api/workspaces/:workspaceId/files/mkdir",
    {
      schema: {
        tags: ["workspaces"],
        body: WorkspaceFileMkdirRequestSchema,
        response: { 200: FileMkdirResponseSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema }
      }
    },
    async (req) => {
      const params = req.params as { workspaceId: string };
      return mkdirWorkspacePath(ctx, params.workspaceId, req.body);
    }
  );

  app.post(
    "/api/workspaces/:workspaceId/files/rename",
    {
      schema: {
        tags: ["workspaces"],
        body: WorkspaceFileRenameRequestSchema,
        response: { 200: FileRenameResponseSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema }
      }
    },
    async (req) => {
      const params = req.params as { workspaceId: string };
      return renameWorkspacePath(ctx, params.workspaceId, req.body);
    }
  );

  app.post(
    "/api/workspaces/:workspaceId/files/delete",
    {
      schema: {
        tags: ["workspaces"],
        body: WorkspaceFileDeleteRequestSchema,
        response: { 200: FileDeleteResponseSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema }
      }
    },
    async (req) => {
      const params = req.params as { workspaceId: string };
      return deleteWorkspacePath(ctx, params.workspaceId, req.body);
    }
  );
}
