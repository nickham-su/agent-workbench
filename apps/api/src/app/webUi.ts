import path from "node:path";
import fs from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "./context.js";
import fastifyStatic from "@fastify/static";

async function dirExists(dirPath: string) {
  try {
    const st = await fs.stat(dirPath);
    return st.isDirectory();
  } catch {
    return false;
  }
}

function acceptsHtml(accept: string | undefined) {
  const v = String(accept || "").toLowerCase();
  if (!v) return true;
  return v.includes("text/html") || v.includes("*/*");
}

export async function registerWebUi(app: FastifyInstance, ctx: AppContext) {
  if (!ctx.serveWeb) return;
  const distDir =
    ctx.webDistDir ??
    path.resolve(process.cwd(), "apps/web/dist");

  if (!(await dirExists(distDir))) {
    app.log.warn({ distDir }, "serveWeb 已启用，但 WEB_DIST_DIR 不存在或不是目录");
    return;
  }

  await app.register(fastifyStatic, {
    root: distDir,
    prefix: "/",
    decorateReply: true
  });

  app.setNotFoundHandler(async (req, reply) => {
    const url = String(req.raw.url || "");
    if (url.startsWith("/api/")) {
      return reply.code(404).send({ message: "Not Found" });
    }

    if (req.raw.method !== "GET") {
      return reply.code(404).send({ message: "Not Found" });
    }

    if (!acceptsHtml(req.headers.accept)) {
      return reply.code(404).send({ message: "Not Found" });
    }

    // SPA history fallback：把未知页面路由交给前端处理。
    return reply.sendFile("index.html");
  });
}
