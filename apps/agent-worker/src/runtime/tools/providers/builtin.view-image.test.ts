import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { BuiltinToolProvider } from "./builtin.js";
import { buildToolSuccessTextForTest } from "../../runner.js";
import type { ToolExecutionContext } from "../types.js";
import { viewImagePathPreview } from "@agent-workbench/shared/internal-contracts/agent-api";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x01]);
const webp = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);

async function fixture(t: TestContext) {
  // Keep fixtures inside the project and only remove the directory created by this test.
  const base = await fs.mkdtemp(path.join(process.cwd(), ".stage3-view-image-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const workspacePath = path.join(base, "workspace");
  await fs.mkdir(path.join(workspacePath, "repo", "screenshots"), { recursive: true });
  await fs.mkdir(path.join(workspacePath, ".awb", "agent", "attachments"), { recursive: true });
  return { base, workspacePath, provider: new BuiltinToolProvider(), ctx: { run: { workspacePath } } as ToolExecutionContext };
}

test("view_image accepts genuine uploaded images and screenshots but returns only a path", async (t) => {
  const { workspacePath, provider, ctx } = await fixture(t);
  for (const [relativePath, bytes] of [
    ["repo/screenshots/page.png", png],
    [".awb/agent/attachments/att_123.jpg", jpeg],
    ["repo/screenshots/page.webp", webp]
  ] as const) {
    await fs.writeFile(path.join(workspacePath, relativePath), bytes);
    assert.deepEqual(await provider.execute("view_image", { path: relativePath }, ctx), { type: "image_ref", path: relativePath });
  }
  const output = buildToolSuccessTextForTest({ toolName: "view_image", args: { path: "repo/screenshots/page.png" }, result: { type: "image_ref", path: "repo/screenshots/page.png" } });
  assert.equal(output, viewImagePathPreview("repo/screenshots/page.png"));
  assert.throws(() => buildToolSuccessTextForTest({ toolName: "view_image", args: {}, result: { type: "image_ref", path: "a.png", data: png } }), /invalid view_image result/);
  assert.equal(provider.canHandle("view_image"), true);
  assert.equal(provider.isToolEnabled("view_image", { profile: { agent: { tools: ["view_image"] } } } as never), true);
  assert.equal(provider.isToolEnabled("view_image", { profile: { agent: { tools: [] } } } as never), false);
  const independent = await Promise.allSettled([
    provider.execute("view_image", { path: "repo/screenshots/page.png" }, ctx),
    provider.execute("view_image", { path: "repo/screenshots/not-found.png" }, ctx)
  ]);
  assert.deepEqual(independent.map((item) => item.status), ["fulfilled", "rejected"]);
});

test("view_image rejects traversal, forged types, symlinks, empty and oversized files", async (t) => {
  const { base, workspacePath, provider, ctx } = await fixture(t);
  const sibling = path.join(base, "private.png");
  await fs.writeFile(sibling, png);
  await fs.symlink(sibling, path.join(workspacePath, "repo", "screenshots", "link.png"));
  await fs.symlink(path.dirname(sibling), path.join(workspacePath, "linked"));
  await fs.writeFile(path.join(workspacePath, "repo", "screenshots", "bad.png"), jpeg);
  await fs.writeFile(path.join(workspacePath, "repo", "screenshots", "empty.png"), Buffer.alloc(0));
  await fs.writeFile(path.join(workspacePath, "repo", "screenshots", "huge.png"), Buffer.alloc(10 * 1024 * 1024 + 1));
  await fs.writeFile(path.join(workspacePath, "repo", "screenshots", "unsupported.gif"), png);
  for (const relativePath of ["../private.png", sibling, "repo//screenshots/page.png", "repo/./screenshots/page.png", "repo/screenshots/../page.png", "repo/screenshots/bad.png", "repo/screenshots/empty.png", "repo/screenshots/huge.png", "repo/screenshots/link.png", "linked/private.png", "repo/screenshots/unsupported.gif", "repo/screenshots/missing.png", "repo/screenshots", "repo/screenshots/a\u2028.png"]) {
    await assert.rejects(() => provider.execute("view_image", { path: relativePath }, ctx));
  }
  await assert.rejects(() => provider.execute("view_image", { path: "repo/screenshots/missing.png" }, ctx), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "view_image cannot read a valid Workspace image at this path");
    assert.doesNotMatch(error.stack ?? "", new RegExp(base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    return true;
  });
  await assert.rejects(() => provider.execute("view_image", { path: "repo/screenshots/page.png", paths: [] }, ctx));
  await assert.rejects(() => provider.execute("view_image", { path: "repo/screenshots/page.png" }, { ...ctx, run: { ...ctx.run, workspacePath: path.join(base, "other-workspace") } }));
});

test("view_image inode competition never returns bytes or reads a sibling file", async (t) => {
  const { base, workspacePath, provider, ctx } = await fixture(t);
  const image = path.join(workspacePath, "repo", "screenshots", "page.png");
  const outside = path.join(base, "outside.png");
  await fs.writeFile(outside, png);
  for (let attempt = 0; attempt < 20; attempt++) {
    await fs.writeFile(image, png);
    const pending = provider.execute("view_image", { path: "repo/screenshots/page.png" }, ctx);
    await fs.rename(image, `${image}.old`);
    await fs.symlink(outside, image);
    const outcome = await pending.then((value) => value, () => null);
    if (outcome) assert.deepEqual(outcome, { type: "image_ref", path: "repo/screenshots/page.png" });
    await fs.unlink(image);
    await fs.unlink(`${image}.old`);
  }
});
