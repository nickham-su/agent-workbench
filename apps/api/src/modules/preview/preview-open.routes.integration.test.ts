import assert from "node:assert/strict";
import { test } from "node:test";
import formbody from "@fastify/formbody";
import Fastify from "fastify";
import { registerWorkspacePreviewRoutes } from "./preview-open.routes.js";

const entryTarget = {
  kind: "file" as const,
  workspaceId: "workspace",
  rootRealPath: "/workspace",
  relativePath: "demo/index.html",
  absolutePath: "/workspace/demo/index.html",
  stat: {} as any,
  resource: { extension: ".html", mime: "text/html; charset=utf-8", kind: "html" as const, entry: true, range: false }
};

test("main preview open route accepts a parsed form without Fetch Metadata and sends a 303 fragment redirect", async (t) => {
  const app = Fastify();
  t.after(async () => await app.close());
  await app.register(formbody);
  await registerWorkspacePreviewRoutes(app, {
    preview: {
      enabled: true,
      runtime: {
        publicOrigin: "https://preview.example.test",
        issueBootstrap() { return { code: "bootstrap_code_0123456789abcdefg" }; }
      }
    }
  } as any, {
    fileService: { async resolve() { return entryTarget; }, async open() { throw new Error("not used"); } }
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/workspaces/workspace/preview/open",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    payload: "path=demo%2Findex.html"
  });

  assert.equal(response.statusCode, 303);
  assert.equal(response.headers.location, "https://preview.example.test/__awb/bootstrap#bootstrap_code_0123456789abcdefg");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["referrer-policy"], "no-referrer");
});

test("main preview open route rejects explicit cross-site forms", async (t) => {
  const app = Fastify();
  t.after(async () => await app.close());
  await app.register(formbody);
  await registerWorkspacePreviewRoutes(app, { preview: { enabled: true, runtime: { publicOrigin: "https://preview.example.test", issueBootstrap() { return { code: "unused" }; } } } } as any, {
    fileService: { async resolve() { throw new Error("not reached"); }, async open() { throw new Error("not used"); } }
  });

  const response = await app.inject({
    method: "POST", url: "/api/workspaces/workspace/preview/open",
    headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "cross-site" }, payload: "path=demo%2Findex.html"
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().code, "PREVIEW_REQUEST_FORBIDDEN");
});

test("disabled preview does not register the main open route", async (t) => {
  const app = Fastify();
  t.after(async () => await app.close());
  await app.register(formbody);
  await registerWorkspacePreviewRoutes(app, { preview: { enabled: false, runtime: null } } as any);

  const response = await app.inject({
    method: "POST",
    url: "/api/workspaces/workspace/preview/open",
    headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" },
    payload: "path=demo%2Findex.html"
  });
  assert.equal(response.statusCode, 404);
});
