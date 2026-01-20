import type { FastifyInstance, FastifyRequest } from "fastify";
import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import archiver from "archiver";
import type { AppContext } from "../../app/context.js";
import { HttpError } from "../../app/errors.js";
import {
  ErrorResponseSchema,
  FileCreateResponseSchema,
  FileDeleteResponseSchema,
  FileListResponseSchema,
  FileMkdirResponseSchema,
  FileReadResponseSchema,
  FileRenameResponseSchema,
  FileSearchResponseSchema,
  FileStatResponseSchema,
  FileWriteResponseSchema,
  WorkspaceFileDownloadRequestSchema,
  WorkspaceFileCreateRequestSchema,
  WorkspaceFileDeleteRequestSchema,
  WorkspaceFileListRequestSchema,
  WorkspaceFileMkdirRequestSchema,
  WorkspaceFileReadRequestSchema,
  WorkspaceFileRenameRequestSchema,
  WorkspaceFileSearchRequestSchema,
  WorkspaceFileStatRequestSchema,
  WorkspaceFileUploadRequestSchema,
  WorkspaceFileUploadResponseSchema,
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
  resolveWorkspaceDownloadTarget,
  resolveWorkspaceUploadTarget,
  searchWorkspaceFiles,
  saveWorkspaceUploadFile,
  statWorkspaceFile,
  withWorkspaceUploadLock,
  writeWorkspaceFileText
} from "./workspace-files.service.js";

type MultipartFilePart = {
  type: "file";
  fieldname: string;
  filename?: string;
  file: Readable;
};

type MultipartFieldPart = {
  type: "field";
  fieldname: string;
  value: string;
};

type MultipartPart = MultipartFilePart | MultipartFieldPart;

type MultipartRequest = FastifyRequest & {
  isMultipart: () => boolean;
  parts: () => AsyncIterableIterator<MultipartPart>;
};

function attachmentHeader(filename: string) {
  const safeName = filename.replace(/"/g, '\\"');
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${safeName}"; filename*=UTF-8''${encoded}`;
}

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
    "/api/workspaces/:workspaceId/files/search",
    {
      schema: {
        tags: ["workspaces"],
        body: WorkspaceFileSearchRequestSchema,
        response: { 200: FileSearchResponseSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema }
      }
    },
    async (req) => {
      const params = req.params as { workspaceId: string };
      return searchWorkspaceFiles(ctx, params.workspaceId, req.body);
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

  app.post(
    "/api/workspaces/:workspaceId/files/upload",
    {
      schema: {
        tags: ["workspaces"],
        querystring: WorkspaceFileUploadRequestSchema,
        response: { 200: WorkspaceFileUploadResponseSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema }
      }
    },
    async (req) => {
      const params = req.params as { workspaceId: string };
      const query = req.query as { dir?: string };
      const multipartReq = req as MultipartRequest;
      if (!multipartReq.isMultipart()) throw new HttpError(400, "Invalid form");

      const { dir, target } = await resolveWorkspaceUploadTarget(ctx, params.workspaceId, query?.dir);
      const results = [] as Awaited<ReturnType<typeof saveWorkspaceUploadFile>>[];

      await withWorkspaceUploadLock(target, async () => {
        for await (const part of multipartReq.parts()) {
          if (part.type !== "file") continue;
          const filename = typeof part.filename === "string" ? part.filename : "";
          const result = await saveWorkspaceUploadFile(target, { filename, stream: part.file });
          results.push(result);
        }
      });

      return { dir, results };
    }
  );

  app.get(
    "/api/workspaces/:workspaceId/files/download",
    {
      schema: {
        tags: ["workspaces"],
        querystring: WorkspaceFileDownloadRequestSchema
      }
    },
    async (req, reply) => {
      const params = req.params as { workspaceId: string };
      const query = req.query as { path?: string };
      const target = await resolveWorkspaceDownloadTarget(ctx, params.workspaceId, query?.path);

      if (target.kind === "file") {
        reply.header("Content-Type", "application/octet-stream");
        reply.header("Content-Disposition", attachmentHeader(target.fileName));
        reply.header("Content-Length", String(target.size));
        return reply.send(fs.createReadStream(target.absPath));
      }

      const rootName = target.zipRootName || "workspace";
      const filename = `${rootName}.zip`;
      reply.header("Content-Type", "application/zip");
      reply.header("Content-Disposition", attachmentHeader(filename));

      const archive = archiver("zip", { zlib: { level: 9 } });
      archive.on("error", (err) => {
        reply.raw.destroy(err);
      });
      reply.raw.on("close", () => {
        archive.abort();
      });

      for (const entry of target.entries) {
        const rel = entry.relPath ? `${rootName}/${entry.relPath}` : rootName;
        archive.file(entry.absPath, { name: rel });
      }

      reply.hijack();
      archive.pipe(reply.raw);
      void archive.finalize();
      return reply;
    }
  );
}
