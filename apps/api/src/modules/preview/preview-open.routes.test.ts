import assert from "node:assert/strict";
import { test } from "node:test";
import type { FastifyInstance } from "fastify";
import { HttpError } from "../../app/errors.js";
import { registerWorkspacePreviewRoutes } from "./preview-open.routes.js";

type RegisteredRoute = { url: string; options: any; handler: (request: any, reply: any) => Promise<unknown> };

function routeRecorder() {
  const routes: RegisteredRoute[] = [];
  return {
    routes,
    app: {
      post(url: string, options: unknown, handler: RegisteredRoute["handler"]) {
        routes.push({ url, options, handler });
      }
    } as unknown as FastifyInstance
  };
}

function replyRecorder() {
  const headers: Record<string, string> = {};
  let redirect: { statusCode: number; location: string } | null = null;
  return {
    reply: {
      header(name: string, value: string) { headers[name] = value; return this; },
      redirect(location: string, statusCode: number) { redirect = { statusCode, location }; return redirect; }
    },
    headers,
    get redirect() { return redirect; }
  };
}

const entryTarget = {
  kind: "file" as const,
  workspaceId: "workspace",
  rootRealPath: "/workspace",
  relativePath: "demo/index.html",
  absolutePath: "/workspace/demo/index.html",
  stat: {} as any,
  resource: { extension: ".html", mime: "text/html", kind: "html" as const, entry: true, range: false }
};

function enabledContext() {
  return {
    preview: {
      enabled: true as const,
      runtime: {
        publicOrigin: "https://preview.example.test",
        issueBootstrap() { return { code: "bootstrap_code_0123456789abcdefg" }; }
      }
    }
  } as any;
}

test("open route only registers POST with the 8 KiB form limit and emits a no-store fragment redirect", async () => {
  const recorder = routeRecorder();
  await registerWorkspacePreviewRoutes(recorder.app, enabledContext(), {
    fileService: { async resolve() { return entryTarget; }, async open() { throw new Error("not used"); } }
  });
  assert.equal(recorder.routes.length, 1);
  const route = recorder.routes[0]!;
  assert.equal(route.url, "/api/workspaces/:workspaceId/preview/open");
  assert.equal(route.options.bodyLimit, 8 * 1024);

  const result = replyRecorder();
  await route.handler({
    headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" },
    params: { workspaceId: "workspace" },
    body: { path: "demo/index.html" }
  }, result.reply);
  assert.deepEqual(result.redirect, {
    statusCode: 303,
    location: "https://preview.example.test/__awb/bootstrap#bootstrap_code_0123456789abcdefg"
  });
  assert.deepEqual(result.headers, { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
});

test("open route rejects JSON rather than accepting a non-form bypass and disabled preview registers no route", async () => {
  const enabled = routeRecorder();
  await registerWorkspacePreviewRoutes(enabled.app, enabledContext(), {
    fileService: { async resolve() { return entryTarget; }, async open() { throw new Error("not used"); } }
  });
  await assert.rejects(
    enabled.routes[0]!.handler({ headers: { "content-type": "application/json" }, params: {}, body: { path: "demo/index.html" } }, replyRecorder().reply),
    (error: unknown) => error instanceof HttpError && error.statusCode === 415
  );

  const disabled = routeRecorder();
  await registerWorkspacePreviewRoutes(disabled.app, { preview: { enabled: false, runtime: null } } as any);
  assert.equal(disabled.routes.length, 0);
});
