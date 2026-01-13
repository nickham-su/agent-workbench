import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import { AuthLoginRequestSchema, AuthLoginResponseSchema, ErrorResponseSchema } from "@agent-workbench/shared";
import { login } from "./auth.service.js";

export async function registerAuthRoutes(app: FastifyInstance, ctx: AppContext) {
  app.post(
    "/api/auth/login",
    {
      schema: {
        tags: ["auth"],
        body: AuthLoginRequestSchema,
        response: {
          200: AuthLoginResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema
        }
      }
    },
    async (req, reply) => login(ctx, reply, req.body)
  );
}

