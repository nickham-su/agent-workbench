import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { buildSetCookieHeader, parseCookieHeader } from "../../infra/auth/sessionCookie.js";
import {
  assertPreviewRawUrlPath,
  type PreviewFileError,
  type PreviewFileService,
  type ResolvedPreviewFile
} from "./preview-file.service.js";
import { type PreviewRuntime } from "./preview-runtime.js";
import { assertPreviewExchangeBrowserRequest, PreviewBrowserRequestForbiddenError } from "./preview-security.js";
import {
  buildBootstrapHeaders,
  buildCommonPreviewHeaders,
  buildPreviewErrorHtml,
  buildPreviewErrorHtmlHeaders,
  createPreviewFileReadStream,
  createPreviewStreamPlan,
  getPreviewStaticMethodResult,
  type PreviewHeaders
} from "./preview-response.js";

const PREVIEW_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const PREVIEW_BOOTSTRAP_CODE_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const PREVIEW_ERROR_MESSAGE = "Preview unavailable";
const PREVIEW_UNAVAILABLE_MESSAGE = "预览已失效或不可用，请返回 Agent Workbench 重新打开。";

export type PreviewAppOptions = Readonly<{
  runtime: PreviewRuntime;
  fileService: PreviewFileService;
  nowMs?: () => number;
}>;

type StaticRouteParams = Readonly<{ sessionId: string; "*"?: string }>;

function setHeaders(reply: FastifyReply, headers: PreviewHeaders) {
  for (const [name, value] of Object.entries(headers)) reply.header(name, value);
}

function rawPathname(request: FastifyRequest) {
  return String(request.raw.url || request.url || "").split("?", 1)[0] || "";
}

function requestHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function acceptsHtml(request: FastifyRequest) {
  return requestHeader(request, "accept")?.toLowerCase().includes("text/html") === true;
}

function sendJsonError(reply: FastifyReply, statusCode: number) {
  setHeaders(reply, buildCommonPreviewHeaders());
  return reply.code(statusCode).send({ message: PREVIEW_ERROR_MESSAGE });
}

function sendStaticError(request: FastifyRequest, reply: FastifyReply, statusCode: number) {
  if (acceptsHtml(request)) {
    const body = buildPreviewErrorHtml();
    setHeaders(reply, { ...buildPreviewErrorHtmlHeaders(), "Content-Length": String(Buffer.byteLength(body)) });
    return reply.code(statusCode).send(request.method === "HEAD" ? undefined : body);
  }
  setHeaders(reply, {
    ...buildCommonPreviewHeaders(),
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(PREVIEW_UNAVAILABLE_MESSAGE))
  });
  return reply.code(statusCode).send(request.method === "HEAD" ? undefined : PREVIEW_UNAVAILABLE_MESSAGE);
}

function isPreviewFileError(error: unknown): error is PreviewFileError {
  return error instanceof Error && error.name === "PreviewFileError" && typeof (error as PreviewFileError).failure === "string";
}

function exchangeStatusFor(error: unknown) {
  if (!isPreviewFileError(error)) return 500;
  return error.failure === "workspace_missing" || error.failure === "path_missing" ? 410 : 403;
}

function staticStatusFor(error: unknown) {
  if (!isPreviewFileError(error)) return 500;
  if (error.failure === "workspace_missing") return 410;
  if (error.failure === "path_missing") return 404;
  return 403;
}

function isSafeEntry(target: Awaited<ReturnType<PreviewFileService["resolve"]>>): target is ResolvedPreviewFile {
  return target.kind === "file" && target.resource.entry;
}

function cookieIsSecure(publicOrigin: string) {
  return new URL(publicOrigin).protocol === "https:";
}

function buildPreviewSessionCookie(params: {
  name: string;
  value: string;
  path: string;
  expiresAt: number;
  publicOrigin: string;
  nowMs: number;
}) {
  return buildSetCookieHeader({
    name: params.name,
    value: params.value,
    path: params.path,
    maxAgeSeconds: Math.max(0, Math.ceil((params.expiresAt - params.nowMs) / 1000)),
    httpOnly: true,
    sameSite: "Strict",
    secure: cookieIsSecure(params.publicOrigin)
  });
}

function clearPreviewSessionCookie(reply: FastifyReply, params: { name: string; path: string; publicOrigin: string }) {
  reply.header("Set-Cookie", buildSetCookieHeader({
    name: params.name,
    value: "",
    path: params.path,
    maxAgeSeconds: 0,
    httpOnly: true,
    sameSite: "Strict",
    secure: cookieIsSecure(params.publicOrigin)
  }));
}

/** Trusted, self-contained bootstrap document. It intentionally never receives a code from the server. */
export function buildPreviewBootstrapHtml(): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>正在打开预览</title></head><body><p id="status">正在打开预览…</p><script>(()=>{const status=document.getElementById("status");const unavailable="预览已失效或不可用，请返回 Agent Workbench 重新打开。";const code=location.hash.startsWith("#")?location.hash.slice(1):"";history.replaceState(null,"","/__awb/bootstrap");if(!code){status.textContent=unavailable;return;}fetch("/__awb/exchange",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code}),credentials:"same-origin"}).then(async response=>{if(!response.ok)throw new Error("exchange failed");const payload=await response.json();if(typeof payload.redirectPath!=="string"||!payload.redirectPath.startsWith("/s/"))throw new Error("invalid redirect");location.replace(payload.redirectPath);}).catch(()=>{status.textContent=unavailable;});})();</script></body></html>`;
}

/**
 * Creates the isolated preview-origin Fastify app. It deliberately registers no
 * main app modules, authentication, Web UI, websocket, multipart, or Swagger.
 */
export async function createPreviewApp(options: PreviewAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.setErrorHandler((error, request, reply) => {
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === "number" && (error as { statusCode: number }).statusCode < 500
      ? (error as { statusCode: number }).statusCode
      : 500;
    const pathname = rawPathname(request);
    if (pathname === "/s" || pathname.startsWith("/s/")) return sendStaticError(request, reply, statusCode);
    return sendJsonError(reply, statusCode);
  });

  app.get("/__awb/bootstrap", async (_request, reply) => {
    setHeaders(reply, buildBootstrapHeaders());
    return reply.send(buildPreviewBootstrapHtml());
  });

  app.post("/__awb/exchange", async (request, reply) => {
    try {
      assertPreviewExchangeBrowserRequest({
        secFetchSite: requestHeader(request, "sec-fetch-site"),
        origin: requestHeader(request, "origin"),
        expectedOrigin: options.runtime.publicOrigin
      });
    } catch (error) {
      if (error instanceof PreviewBrowserRequestForbiddenError) return sendJsonError(reply, 403);
      throw error;
    }

    const code = typeof (request.body as { code?: unknown } | undefined)?.code === "string"
      ? (request.body as { code: string }).code
      : "";
    if (!PREVIEW_BOOTSTRAP_CODE_PATTERN.test(code)) return sendJsonError(reply, 400);

    const bootstrap = options.runtime.consumeBootstrap(code);
    if (!bootstrap) return sendJsonError(reply, 410);

    let target: Awaited<ReturnType<PreviewFileService["resolve"]>>;
    try {
      target = await options.fileService.resolve({
        workspaceId: bootstrap.workspaceId,
        decodedPath: bootstrap.entryPath,
        trailingSlash: true
      });
    } catch (error) {
      return sendJsonError(reply, exchangeStatusFor(error));
    }
    if (!isSafeEntry(target) || target.relativePath !== bootstrap.entryPath) return sendJsonError(reply, 403);

    const session = options.runtime.createSession({ workspaceId: bootstrap.workspaceId, entryPath: target.relativePath });
    reply.header("Set-Cookie", buildPreviewSessionCookie({
      name: session.cookieName,
      value: session.cookieSecret,
      path: session.cookiePath,
      expiresAt: session.expiresAt,
      publicOrigin: options.runtime.publicOrigin,
      nowMs: (options.nowMs ?? Date.now)()
    }));
    setHeaders(reply, buildCommonPreviewHeaders());
    return reply.send({ redirectPath: session.redirectPath });
  });

  const serveStatic = async (request: FastifyRequest<{ Params: StaticRouteParams }>, reply: FastifyReply, exactSessionPath: boolean) => {
    const method = getPreviewStaticMethodResult(request.method);
    if (!method.allowed) {
      setHeaders(reply, method.headers);
      return reply.code(method.statusCode).send();
    }

    const sessionId = request.params.sessionId;
    if (!PREVIEW_SESSION_ID_PATTERN.test(sessionId)) return sendStaticError(request, reply, 404);
    if (exactSessionPath) {
      setHeaders(reply, buildCommonPreviewHeaders());
      return reply.code(308).redirect(`/s/${sessionId}/`);
    }

    try {
      assertPreviewRawUrlPath(String(request.raw.url || request.url || ""));
    } catch (error) {
      const statusCode = isPreviewFileError(error) && error.failure === "invalid_path" ? 400 : 403;
      return sendStaticError(request, reply, statusCode);
    }

    const state = options.runtime.getSessionState(sessionId);
    const cookieName = `awb_preview_${sessionId}`;
    const cookiePath = `/s/${sessionId}/`;
    if (state === "expired") {
      options.runtime.revokeSession(sessionId);
      clearPreviewSessionCookie(reply, { name: cookieName, path: cookiePath, publicOrigin: options.runtime.publicOrigin });
      return sendStaticError(request, reply, 410);
    }
    const cookieSecret = parseCookieHeader(requestHeader(request, "cookie"))[cookieName] ?? null;
    const session = options.runtime.authenticateSession({ sessionId, cookieSecret });
    if (!session) {
      if (options.runtime.getSessionState(sessionId) === "expired") {
        options.runtime.revokeSession(sessionId);
        clearPreviewSessionCookie(reply, { name: cookieName, path: cookiePath, publicOrigin: options.runtime.publicOrigin });
        return sendStaticError(request, reply, 410);
      }
      return sendStaticError(request, reply, 401);
    }

    const pathname = rawPathname(request);
    const trailingSlash = pathname.endsWith("/");
    const decodedPath = request.params["*"] ?? "";
    let target: Awaited<ReturnType<PreviewFileService["resolve"]>>;
    try {
      target = await options.fileService.resolve({ workspaceId: session.workspaceId, decodedPath, trailingSlash });
    } catch (error) {
      const statusCode = staticStatusFor(error);
      if (statusCode === 410) {
        options.runtime.revokeSession(sessionId);
        clearPreviewSessionCookie(reply, { name: session.cookieName, path: cookiePath, publicOrigin: options.runtime.publicOrigin });
      }
      return sendStaticError(request, reply, statusCode);
    }

    if (target.kind === "redirect") {
      const suffix = target.relativePath ? `${target.relativePath}/` : "";
      setHeaders(reply, buildCommonPreviewHeaders());
      return reply.code(308).redirect(`/s/${sessionId}/${suffix}`);
    }

    try {
      const opened = await options.fileService.open(target);
      const plan = await createPreviewStreamPlan({
        method: method.head ? "HEAD" : "GET",
        rangeHeader: requestHeader(request, "range"),
        resource: opened.target.resource,
        filePath: opened.target.absolutePath,
        size: opened.stat.size,
        handle: opened.handle,
        createReadStream: createPreviewFileReadStream
      });
      setHeaders(reply, plan.headers);
      reply.raw.once("close", () => { void plan.close().catch(() => undefined); });
      return reply.code(plan.statusCode).send(plan.body);
    } catch (error) {
      return sendStaticError(request, reply, staticStatusFor(error));
    }
  };

  app.all<{ Params: StaticRouteParams }>("/s/:sessionId", async (request, reply) => await serveStatic(request, reply, true));
  app.all<{ Params: StaticRouteParams }>("/s/:sessionId/*", async (request, reply) => await serveStatic(request, reply, false));

  app.setNotFoundHandler((request, reply) => sendJsonError(reply, 404));
  return app;
}
