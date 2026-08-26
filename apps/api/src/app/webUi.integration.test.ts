import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import Fastify from "fastify";
import type { AppContext } from "./context.js";
import { registerWebUi } from "./webUi.js";

test("main web UI never falls back for preview-reserved paths while ordinary client paths still use index.html", async (t) => {
  const distDir = await fs.mkdtemp(path.join(os.tmpdir(), "awb-web-ui-preview-"));
  await fs.writeFile(path.join(distDir, "index.html"), "<main>awb client</main>");
  const app = Fastify();
  t.after(async () => {
    await app.close();
    await fs.rm(distDir, { recursive: true, force: true });
  });

  await registerWebUi(app, { serveWeb: true, webDistDir: distDir } as AppContext);

  for (const url of ["/s", "/s/session/index.html", "/__awb", "/__awb/bootstrap", "/preview", "/preview/x"]) {
    const response = await app.inject({ method: "GET", url, headers: { accept: "text/html" } });
    assert.equal(response.statusCode, 404, url);
    assert.notEqual(response.body, "<main>awb client</main>", url);
  }

  for (const url of ["/settings", "/settings2", "/__awb2", "/previewer"]) {
    const response = await app.inject({ method: "GET", url, headers: { accept: "text/html" } });
    assert.equal(response.statusCode, 200, url);
    assert.equal(response.body, "<main>awb client</main>", url);
  }
});
