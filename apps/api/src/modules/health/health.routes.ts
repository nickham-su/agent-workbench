import type { FastifyInstance } from "fastify";
import { getHealth } from "./health.service.js";
import { HealthResponseSchema } from "./health.model.js";
import type { AppContext } from "../../app/context.js";

export async function registerHealthRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/api/health", {
    schema: {
      tags: ["health"],
      response: { 200: HealthResponseSchema }
    }
  }, async () => getHealth(ctx));
}
