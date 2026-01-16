import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import {
  ErrorResponseSchema,
  FileCreateRequestSchema,
  FileCreateResponseSchema,
  FileDeleteRequestSchema,
  FileDeleteResponseSchema,
  FileListRequestSchema,
  FileListResponseSchema,
  FileMkdirRequestSchema,
  FileMkdirResponseSchema,
  FileReadRequestSchema,
  FileReadResponseSchema,
  FileRenameRequestSchema,
  FileRenameResponseSchema,
  FileWriteRequestSchema,
  FileWriteResponseSchema
} from "@agent-workbench/shared";
import {
  FileConflictError,
  createFile,
  deletePath,
  listFiles,
  mkdirPath,
  readFileText,
  renamePath,
  writeFileText
} from "./files.service.js";

export async function registerFilesRoutes(app: FastifyInstance, ctx: AppContext) {
  app.post(
    "/api/files/list",
    {
      schema: {
        tags: ["files"],
        body: FileListRequestSchema,
        response: { 200: FileListResponseSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema }
      }
    },
    async (req) => {
      return listFiles(ctx, req.body);
    }
  );

  app.post(
    "/api/files/read-text",
    {
      schema: {
        tags: ["files"],
        body: FileReadRequestSchema,
        response: { 200: FileReadResponseSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema }
      }
    },
    async (req) => {
      return readFileText(ctx, req.body);
    }
  );

  app.post(
    "/api/files/write-text",
    {
      schema: {
        tags: ["files"],
        body: FileWriteRequestSchema,
        response: { 200: FileWriteResponseSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: FileWriteResponseSchema }
      }
    },
    async (req, reply) => {
      try {
        return await writeFileText(ctx, req.body);
      } catch (err) {
        if (err instanceof FileConflictError) {
          return reply.code(409).send(err.payload);
        }
        throw err;
      }
    }
  );

  app.post(
    "/api/files/create",
    {
      schema: {
        tags: ["files"],
        body: FileCreateRequestSchema,
        response: { 200: FileCreateResponseSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema }
      }
    },
    async (req) => {
      return createFile(ctx, req.body);
    }
  );

  app.post(
    "/api/files/mkdir",
    {
      schema: {
        tags: ["files"],
        body: FileMkdirRequestSchema,
        response: { 200: FileMkdirResponseSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema }
      }
    },
    async (req) => {
      return mkdirPath(ctx, req.body);
    }
  );

  app.post(
    "/api/files/rename",
    {
      schema: {
        tags: ["files"],
        body: FileRenameRequestSchema,
        response: { 200: FileRenameResponseSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema }
      }
    },
    async (req) => {
      return renamePath(ctx, req.body);
    }
  );

  app.post(
    "/api/files/delete",
    {
      schema: {
        tags: ["files"],
        body: FileDeleteRequestSchema,
        response: { 200: FileDeleteResponseSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema }
      }
    },
    async (req) => {
      return deletePath(ctx, req.body);
    }
  );
}
