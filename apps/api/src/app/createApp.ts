import Fastify from "fastify";
import websocket from "@fastify/websocket";
import multipart from "@fastify/multipart";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { isHttpError } from "./errors.js";
import type { AppContext } from "./context.js";
import { registerWebUi } from "./webUi.js";
import { registerAuthGuards } from "./auth.js";
import { registerHealthModule } from "../modules/health/health.module.js";
import { registerAuthModule } from "../modules/auth/auth.module.js";
import { registerReposModule } from "../modules/repos/repos.module.js";
import { registerWorkspacesModule } from "../modules/workspaces/workspaces.module.js";
import { registerTerminalsModule } from "../modules/terminals/terminals.module.js";
import { registerGitModule } from "../modules/git/git.module.js";
import { registerFilesModule } from "../modules/files/files.module.js";
import { registerCredentialsModule } from "../modules/credentials/credentials.module.js";
import { registerSettingsModule } from "../modules/settings/settings.module.js";

export async function createApp(ctx: AppContext) {
  const app = Fastify({
    logger: {
      transport: {
        target: "pino-pretty",
        options: { colorize: true }
      }
    }
  });

  await app.register(websocket);
  await app.register(multipart);

	  await app.register(swagger, {
	    openapi: {
	      info: { title: "AgentWorkbench", version: ctx.version }
	    }
	  });

  await app.register(swaggerUi, {
    routePrefix: "/api/docs"
  });

  await registerAuthGuards(app, ctx);

  app.get("/api/openapi.json", async () => {
    return app.swagger();
  });

  app.setErrorHandler((err, _req, reply) => {
    if (isHttpError(err)) {
      return reply.code(err.statusCode).send({ message: err.message, code: err.code });
    }
    if (typeof (err as any)?.statusCode === "number" && (err as any).statusCode < 500) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code((err as any).statusCode).send({ message });
    }
    app.log.error({ err }, "unhandled error");
    return reply.code(500).send({ message: "Internal Server Error" });
  });

  await registerHealthModule(app, ctx);
  await registerAuthModule(app, ctx);
  await registerReposModule(app, ctx);
  await registerCredentialsModule(app, ctx);
  await registerSettingsModule(app, ctx);
  await registerWorkspacesModule(app, ctx);
  await registerTerminalsModule(app, ctx);
  await registerGitModule(app, ctx);
  await registerFilesModule(app, ctx);
  await registerWebUi(app, ctx);

  return app;
}
