import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openSecureAnalyticsRoot } from "../src/node/analytics-root.js";

async function fixture(t: import("node:test").TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "awb-analytics-root-"));
  const data = path.join(root, "data");
  const outside = path.join(root, "outside");
  await fs.mkdir(data, { mode: 0o700 });
  await fs.mkdir(outside, { mode: 0o700 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, data, outside };
}

test("Analytics root and child symlinks are rejected without external writes", async (t) => {
  const { data, outside } = await fixture(t);
  await fs.symlink(outside, path.join(data, "analytics"));
  await assert.rejects(() => openSecureAnalyticsRoot(data));
  assert.deepEqual(await fs.readdir(outside), []);
  await fs.unlink(path.join(data, "analytics"));
  const root = await openSecureAnalyticsRoot(data);
  await fs.symlink(outside, root.path("model-outbox"));
  await assert.rejects(() => root.openDirectory(["model-outbox"]));
  await root.close();
  assert.deepEqual(await fs.readdir(outside), []);
});

test("an opened root capability remains anchored when its pathname is replaced", async (t) => {
  const { data, outside } = await fixture(t);
  const root = await openSecureAnalyticsRoot(data);
  const original = path.join(data, "analytics");
  const moved = path.join(data, "analytics-original");
  await fs.rename(original, moved);
  await fs.symlink(outside, original);
  await root.publishJson("anchored.json", { ok: true });
  await root.close();
  assert.equal(await fs.readFile(path.join(moved, "anchored.json"), "utf8"), '{"ok":true}\n');
  assert.deepEqual(await fs.readdir(outside), []);
});
