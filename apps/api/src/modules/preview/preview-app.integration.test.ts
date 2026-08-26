import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { createPreviewApp } from "./preview-app.js";
import { createPreviewFileService } from "./preview-file.service.js";
import { createPreviewRuntime } from "./preview-runtime.js";

const tempDirs: string[] = [];
const ORIGIN = "http://preview.test";
const TOKENS = [
  "bootstrap_code_0123456789abcdefg",
  "session_id_0123456789abcdefghijk",
  "session_secret_0123456789abcdefg"
];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => await fs.rm(dir, { recursive: true, force: true })));
});

async function fixture(options: { now?: number; origin?: string } = {}) {
  let now = options.now ?? 1_000;
  let workspaceAvailable = true;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "awb-preview-app-"));
  tempDirs.push(root);
  await fs.mkdir(path.join(root, "demo"));
  await fs.mkdir(path.join(root, "media"));
  await fs.writeFile(path.join(root, "demo", "index.html"), "<h1>preview</h1>");
  await fs.writeFile(path.join(root, "demo", "styles.css"), "body{}");
  await fs.writeFile(path.join(root, "media", "video.mp4"), "0123456789");

  const tokens = [...TOKENS];
  const runtime = createPreviewRuntime({
    publicOrigin: options.origin ?? ORIGIN,
    sessionTtlMs: 3_600_000,
    nowMs: () => now,
    randomToken: () => tokens.shift() ?? "unused_token_0123456789abcdefghi"
  });
  const fileService = createPreviewFileService({
    getWorkspaceById: (workspaceId) => workspaceAvailable && workspaceId === "workspace" ? { id: workspaceId, path: root } : null
  });
  const app = await createPreviewApp({ runtime, fileService, nowMs: () => now });
  return { app, runtime, setNow(value: number) { now = value; }, setWorkspaceAvailable(value: boolean) { workspaceAvailable = value; } };
}

function cookiePair(setCookie: string | string[] | undefined) {
  const value = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!value) throw new Error("expected Set-Cookie header");
  return value.split(";", 1)[0]!;
}

function headerValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

async function exchange(app: Awaited<ReturnType<typeof createPreviewApp>>, code: string) {
  return await app.inject({
    method: "POST",
    url: "/__awb/exchange",
    headers: {
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      origin: ORIGIN
    },
    payload: { code }
  });
}

test("preview app keeps bootstrap code client-side and exchanges it once into a scoped cookie session", async (t) => {
  const { app, runtime } = await fixture();
  t.after(async () => { runtime.close(); await app.close(); });
  const issued = runtime.issueBootstrap({ workspaceId: "workspace", entryPath: "demo/index.html" });

  const bootstrap = await app.inject({ method: "GET", url: "/__awb/bootstrap" });
  assert.equal(bootstrap.statusCode, 200);
  assert.equal(bootstrap.headers["cache-control"], "no-store");
  assert.equal(bootstrap.headers["cross-origin-opener-policy"], "same-origin");
  assert.match(headerValue(bootstrap.headers["content-security-policy"]), /connect-src 'self'/);
  assert.equal(bootstrap.body.includes(issued.code), false);
  assert.ok(bootstrap.body.indexOf("history.replaceState") < bootstrap.body.indexOf('fetch("/__awb/exchange"'));
  assert.match(bootstrap.body, /预览已失效或不可用，请返回 Agent Workbench 重新打开。/);

  const first = await exchange(app, issued.code);
  assert.equal(first.statusCode, 200);
  assert.deepEqual(Object.keys(first.json()), ["redirectPath"]);
  const redirectPath = first.json<{ redirectPath: string }>().redirectPath;
  assert.match(redirectPath, /^\/s\/[A-Za-z0-9_-]{32}\/demo\/index\.html$/);
  const setCookie = first.headers["set-cookie"];
  const cookie = Array.isArray(setCookie) ? setCookie[0]! : setCookie!;
  assert.match(cookie, /^awb_preview_[A-Za-z0-9_-]{32}=[A-Za-z0-9_-]{32}; /);
  assert.match(cookie, /Path=\/s\/[A-Za-z0-9_-]{32}\//);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Max-Age=3600/);
  assert.equal(cookie.includes("Secure"), false);
  assert.equal(cookie.includes("Domain="), false);

  const replay = await exchange(app, issued.code);
  assert.equal(replay.statusCode, 410);
  assert.deepEqual(replay.json(), { message: "Preview unavailable" });

  const staticPage = await app.inject({ method: "GET", url: redirectPath, headers: { cookie: cookiePair(setCookie) } });
  assert.equal(staticPage.statusCode, 200);
  assert.equal(staticPage.body, "<h1>preview</h1>");
  assert.equal(staticPage.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(staticPage.headers["cache-control"], "no-store");
  assert.equal(staticPage.headers["cross-origin-opener-policy"], "same-origin");
  assert.match(headerValue(staticPage.headers["content-security-policy"]), /sandbox allow-scripts allow-same-origin allow-modals/);
});

test("preview bootstrap, exchange, and scoped static access work through an ephemeral HTTP listener", async (t) => {
  const { app, runtime } = await fixture();
  t.after(async () => { runtime.close(); await app.close(); });
  const listenerOrigin = await app.listen({ host: "127.0.0.1", port: 0 });
  const issued = runtime.issueBootstrap({ workspaceId: "workspace", entryPath: "demo/index.html" });

  const bootstrap = await fetch(`${listenerOrigin}/__awb/bootstrap`);
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.headers.get("cache-control"), "no-store");

  const exchangeResponse = await fetch(`${listenerOrigin}/__awb/exchange`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      origin: ORIGIN
    },
    body: JSON.stringify({ code: issued.code })
  });
  assert.equal(exchangeResponse.status, 200);
  const { redirectPath } = await exchangeResponse.json() as { redirectPath: string };
  const cookie = exchangeResponse.headers.get("set-cookie");
  assert.ok(cookie);

  const page = await fetch(`${listenerOrigin}${redirectPath}`, {
    headers: { cookie: cookiePair(cookie) }
  });
  assert.equal(page.status, 200);
  assert.equal(await page.text(), "<h1>preview</h1>");
});

test("preview app requires a valid scoped cookie and exposes no main API or UI routes", async (t) => {
  const { app, runtime } = await fixture();
  t.after(async () => { runtime.close(); await app.close(); });
  const issued = runtime.issueBootstrap({ workspaceId: "workspace", entryPath: "demo/index.html" });
  const session = await exchange(app, issued.code);
  const redirectPath = session.json<{ redirectPath: string }>().redirectPath;

  const noCookie = await app.inject({ method: "GET", url: redirectPath, headers: { accept: "text/html" } });
  assert.equal(noCookie.statusCode, 401);
  assert.match(noCookie.headers["content-type"] ?? "", /^text\/html/);
  assert.match(noCookie.body, /预览已失效或不可用/);
  assert.equal(noCookie.body.includes("/tmp/"), false);

  const noCookieHead = await app.inject({ method: "HEAD", url: redirectPath, headers: { accept: "text/html" } });
  assert.equal(noCookieHead.statusCode, 401);
  assert.equal(noCookieHead.body, "");
  assert.equal(noCookieHead.headers["content-length"], noCookie.headers["content-length"]);

  const api = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(api.statusCode, 404);
  assert.deepEqual(api.json(), { message: "Preview unavailable" });
  const root = await app.inject({ method: "GET", url: "/", headers: { accept: "text/html" } });
  assert.equal(root.statusCode, 404);
  assert.equal(root.body.includes("<html"), false);

  const exact = await app.inject({ method: "GET", url: redirectPath.replace("/demo/index.html", "") });
  assert.equal(exact.statusCode, 308);
  assert.equal(exact.headers.location, `${redirectPath.replace("demo/index.html", "")}`);
  assert.equal(exact.headers["cache-control"], "no-store");
});

test("preview app expires sessions as 410 and clears the session-scoped cookie", async (t) => {
  const { app, runtime, setNow } = await fixture({ now: 1_000 });
  t.after(async () => { runtime.close(); await app.close(); });
  const issued = runtime.issueBootstrap({ workspaceId: "workspace", entryPath: "demo/index.html" });
  const exchangeResult = await exchange(app, issued.code);
  const redirectPath = exchangeResult.json<{ redirectPath: string }>().redirectPath;
  const cookie = cookiePair(exchangeResult.headers["set-cookie"]);

  setNow(3_601_000);
  const expired = await app.inject({ method: "GET", url: redirectPath, headers: { cookie, accept: "text/html" } });
  assert.equal(expired.statusCode, 410);
  assert.match(headerValue(expired.headers["set-cookie"]), /Max-Age=0/);
  assert.match(headerValue(expired.headers["set-cookie"]), /Path=\/s\/[A-Za-z0-9_-]{32}\//);
  assert.match(expired.body, /预览已失效或不可用/);
});

test("preview app revokes a session and clears its cookie when the workspace is deleted", async (t) => {
  const { app, runtime, setWorkspaceAvailable } = await fixture();
  t.after(async () => { runtime.close(); await app.close(); });
  const issued = runtime.issueBootstrap({ workspaceId: "workspace", entryPath: "demo/index.html" });
  const exchangeResult = await exchange(app, issued.code);
  const redirectPath = exchangeResult.json<{ redirectPath: string }>().redirectPath;
  const cookie = cookiePair(exchangeResult.headers["set-cookie"]);

  setWorkspaceAvailable(false);
  const deleted = await app.inject({ method: "GET", url: redirectPath, headers: { cookie, accept: "text/html" } });
  assert.equal(deleted.statusCode, 410);
  assert.match(headerValue(deleted.headers["set-cookie"]), /Max-Age=0/);
  const repeated = await app.inject({ method: "GET", url: redirectPath, headers: { cookie } });
  assert.equal(repeated.statusCode, 401);
});

test("preview static routes apply resolver redirects, methods, HEAD, and media Range semantics", async (t) => {
  const { app, runtime } = await fixture();
  t.after(async () => { runtime.close(); await app.close(); });
  const issued = runtime.issueBootstrap({ workspaceId: "workspace", entryPath: "demo/index.html" });
  const session = await exchange(app, issued.code);
  const cookie = cookiePair(session.headers["set-cookie"]);
  const sessionId = session.json<{ redirectPath: string }>().redirectPath.split("/")[2]!;

  const directory = await app.inject({ method: "GET", url: `/s/${sessionId}/demo`, headers: { cookie } });
  assert.equal(directory.statusCode, 308);
  assert.equal(directory.headers.location, `/s/${sessionId}/demo/`);

  const method = await app.inject({ method: "POST", url: `/s/${sessionId}/demo/index.html`, headers: { cookie } });
  assert.equal(method.statusCode, 405);
  assert.equal(method.headers.allow, "GET, HEAD");
  assert.equal(method.headers["cache-control"], "no-store");

  const head = await app.inject({ method: "HEAD", url: `/s/${sessionId}/demo/index.html`, headers: { cookie } });
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, "");
  assert.equal(head.headers["content-length"], String("<h1>preview</h1>".length));

  const range = await app.inject({ method: "GET", url: `/s/${sessionId}/media/video.mp4`, headers: { cookie, range: "bytes=2-5" } });
  assert.equal(range.statusCode, 206);
  assert.equal(range.body, "2345");
  assert.equal(range.headers["content-range"], "bytes 2-5/10");
  assert.equal(range.headers["accept-ranges"], "bytes");

  const invalidRange = await app.inject({ method: "HEAD", url: `/s/${sessionId}/media/video.mp4`, headers: { cookie, range: "bytes=50-" } });
  assert.equal(invalidRange.statusCode, 416);
  assert.equal(invalidRange.body, "");
  assert.equal(invalidRange.headers["content-range"], "bytes */10");
});

test("exchange fails closed before code consumption and maps revalidation failures without leaking details", async (t) => {
  const { app, runtime } = await fixture();
  t.after(async () => { runtime.close(); await app.close(); });
  const issued = runtime.issueBootstrap({ workspaceId: "workspace", entryPath: "demo/index.html" });

  const forbidden = await app.inject({ method: "POST", url: "/__awb/exchange", payload: { code: issued.code } });
  assert.equal(forbidden.statusCode, 403);
  const valid = await exchange(app, issued.code);
  assert.equal(valid.statusCode, 200);

  const missing = runtime.issueBootstrap({ workspaceId: "missing", entryPath: "demo/index.html" });
  const missingResult = await exchange(app, missing.code);
  assert.equal(missingResult.statusCode, 410);

  const unsafe = runtime.issueBootstrap({ workspaceId: "workspace", entryPath: "demo/styles.css" });
  const unsafeResult = await exchange(app, unsafe.code);
  assert.equal(unsafeResult.statusCode, 403);
  assert.equal(unsafeResult.body.includes("/tmp/"), false);

  const directory = runtime.issueBootstrap({ workspaceId: "workspace", entryPath: "demo" });
  const directoryResult = await exchange(app, directory.code);
  assert.equal(directoryResult.statusCode, 403);
});

test("preview exchange cookies are Secure only for an HTTPS public origin", async (t) => {
  const origin = "https://preview.test";
  const { app, runtime } = await fixture({ origin });
  t.after(async () => { runtime.close(); await app.close(); });
  const issued = runtime.issueBootstrap({ workspaceId: "workspace", entryPath: "demo/index.html" });
  const response = await app.inject({
    method: "POST",
    url: "/__awb/exchange",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", origin },
    payload: { code: issued.code }
  });
  assert.equal(response.statusCode, 200);
  assert.match(headerValue(response.headers["set-cookie"]), /Secure/);
});
