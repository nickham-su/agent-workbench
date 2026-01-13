import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import {
  CreateCredentialRequestSchema,
  CredentialRecordSchema,
  GenerateSshKeypairResponseSchema,
  ErrorResponseSchema,
  UpdateCredentialRequestSchema
} from "@agent-workbench/shared";
import {
  createCredential,
  deleteCredential,
  generateSshKeypair,
  listCredentials,
  updateCredential
} from "./credentials.service.js";

export async function registerCredentialsRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get(
    "/api/credentials",
    {
      schema: {
        tags: ["credentials"],
        response: { 200: { type: "array", items: CredentialRecordSchema } }
      }
    },
    async () => listCredentials(ctx)
  );

  app.post(
    "/api/credentials/ssh/keypair/generate",
    {
      schema: {
        tags: ["credentials"],
        response: { 200: GenerateSshKeypairResponseSchema, 500: ErrorResponseSchema }
      }
    },
    async (_req, reply) => {
      const res = await generateSshKeypair(ctx, app.log);
      reply.header("Cache-Control", "no-store");
      return res;
    }
  );

  app.post(
    "/api/credentials",
    {
      schema: {
        tags: ["credentials"],
        body: CreateCredentialRequestSchema,
        response: { 201: CredentialRecordSchema, 400: ErrorResponseSchema, 409: ErrorResponseSchema }
      }
    },
    async (req, reply) => {
      const body = (req.body ?? {}) as any;
      const created = await createCredential(ctx, app.log, body);
      return reply.code(201).send(created);
    }
  );

  app.patch(
    "/api/credentials/:credentialId",
    {
      schema: {
        tags: ["credentials"],
        body: UpdateCredentialRequestSchema,
        response: { 200: CredentialRecordSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema }
      }
    },
    async (req) => {
      const params = req.params as { credentialId: string };
      const body = (req.body ?? {}) as any;
      return updateCredential(ctx, app.log, params.credentialId, body);
    }
  );

  app.delete(
    "/api/credentials/:credentialId",
    {
      schema: {
        tags: ["credentials"],
        response: { 204: { type: "null" }, 404: ErrorResponseSchema, 409: ErrorResponseSchema }
      }
    },
    async (req, reply) => {
      const params = req.params as { credentialId: string };
      await deleteCredential(ctx, app.log, params.credentialId);
      return reply.code(204).send();
    }
  );
}
