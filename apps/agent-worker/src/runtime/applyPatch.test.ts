import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { applyPreparedPatch, prepareApplyPatchTool } from "./applyPatch.js";

async function withTempWorkspace(fn: (workspacePath: string) => Promise<void>) {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "awb-apply-patch-"));
  try {
    await fn(workspacePath);
  } finally {
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
}

test("apply_patch 支持同一文件多段 update 连续生效", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const target = path.join(workspacePath, "multi.txt");
    await fs.writeFile(target, "foo\nbar\n", { encoding: "utf8" });

    const patchText = [
      "*** Begin Patch",
      "*** Update File: multi.txt",
      "@@",
      "-foo",
      "+foo-1",
      "*** Update File: multi.txt",
      "@@",
      "-bar",
      "+bar-2",
      "*** End Patch"
    ].join("\n");

    const prepared = await prepareApplyPatchTool({ workspacePath, patchText });
    await applyPreparedPatch({ workspacePath, prepared });

    const content = await fs.readFile(target, "utf8");
    assert.equal(content, "foo-1\nbar-2\n");
  });
});

test("apply_patch 同一路径别名会命中同一虚拟文件状态", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const target = path.join(workspacePath, "alias.txt");
    await fs.writeFile(target, "old-1\nold-2\n", { encoding: "utf8" });

    const patchText = [
      "*** Begin Patch",
      "*** Update File: alias.txt",
      "@@",
      "-old-1",
      "+new-1",
      "*** Update File: ./alias.txt",
      "@@",
      "-old-2",
      "+new-2",
      "*** End Patch"
    ].join("\n");

    const prepared = await prepareApplyPatchTool({ workspacePath, patchText });
    await applyPreparedPatch({ workspacePath, prepared });

    const content = await fs.readFile(target, "utf8");
    assert.equal(content, "new-1\nnew-2\n");
  });
});

test("apply_patch move 目标已存在时拒绝覆盖", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const source = path.join(workspacePath, "source.txt");
    const target = path.join(workspacePath, "target.txt");
    await fs.writeFile(source, "source\n", { encoding: "utf8" });
    await fs.writeFile(target, "target\n", { encoding: "utf8" });

    const patchText = [
      "*** Begin Patch",
      "*** Update File: source.txt",
      "*** Move to: target.txt",
      "@@",
      "-source",
      "+moved",
      "*** End Patch"
    ].join("\n");

    await assert.rejects(
      () => prepareApplyPatchTool({ workspacePath, patchText }),
      /move target already exists/
    );

    const sourceContent = await fs.readFile(source, "utf8");
    const targetContent = await fs.readFile(target, "utf8");
    assert.equal(sourceContent, "source\n");
    assert.equal(targetContent, "target\n");
  });
});

test("apply_patch move 在 apply 阶段也拒绝覆盖新出现的目标文件", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const source = path.join(workspacePath, "source.txt");
    const target = path.join(workspacePath, "target.txt");
    await fs.writeFile(source, "source\n", { encoding: "utf8" });

    const patchText = [
      "*** Begin Patch",
      "*** Update File: source.txt",
      "*** Move to: target.txt",
      "@@",
      "-source",
      "+moved",
      "*** End Patch"
    ].join("\n");

    const prepared = await prepareApplyPatchTool({ workspacePath, patchText });
    await fs.writeFile(target, "created-later\n", { encoding: "utf8" });

    await assert.rejects(
      () => applyPreparedPatch({ workspacePath, prepared }),
      /move target already exists/
    );

    const sourceContent = await fs.readFile(source, "utf8");
    const targetContent = await fs.readFile(target, "utf8");
    assert.equal(sourceContent, "source\n");
    assert.equal(targetContent, "created-later\n");
  });
});

test("apply_patch 支持在 update hunk 后声明 move 目标", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const source = path.join(workspacePath, "source.txt");
    const target = path.join(workspacePath, "target.txt");
    await fs.writeFile(source, "source\n", { encoding: "utf8" });

    const patchText = [
      "*** Begin Patch",
      "*** Update File: source.txt",
      "@@",
      "-source",
      "+moved",
      "*** Move to: target.txt",
      "*** End Patch"
    ].join("\n");

    const prepared = await prepareApplyPatchTool({ workspacePath, patchText });
    assert.equal(prepared.files[0]?.type, "move");
    assert.equal(prepared.files[0]?.path, "target.txt");
    assert.equal(prepared.files[0]?.fromPath, "source.txt");

    await applyPreparedPatch({ workspacePath, prepared });

    await assert.rejects(() => fs.readFile(source, "utf8"));
    const targetContent = await fs.readFile(target, "utf8");
    assert.equal(targetContent, "moved\n");
  });
});

test("apply_patch verify 失败时不写入任何变更", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const target = path.join(workspacePath, "verify.txt");
    await fs.writeFile(target, "line-a\n", { encoding: "utf8" });

    const patchText = [
      "*** Begin Patch",
      "*** Update File: verify.txt",
      "@@",
      "-line-b",
      "+line-c",
      "*** End Patch"
    ].join("\n");

    await assert.rejects(() => prepareApplyPatchTool({ workspacePath, patchText }));
    const content = await fs.readFile(target, "utf8");
    assert.equal(content, "line-a\n");
  });
});

test("apply_patch 拒绝越界路径", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const patchText = [
      "*** Begin Patch",
      "*** Add File: ../escape.txt",
      "+oops",
      "*** End Patch"
    ].join("\n");

    await assert.rejects(() => prepareApplyPatchTool({ workspacePath, patchText }), /outside workspace/);
  });
});

test("apply_patch 在 verify 阶段拒绝 symlink 父目录并且无外部副作用", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "awb-apply-patch-outside-"));
    const linkDir = path.join(workspacePath, "linkdir");
    await fs.symlink(outsideDir, linkDir);

    const patchText = [
      "*** Begin Patch",
      "*** Add File: linkdir/escape.txt",
      "+blocked",
      "*** End Patch"
    ].join("\n");

    try {
      await assert.rejects(() => prepareApplyPatchTool({ workspacePath, patchText }), /symlink path is not allowed/);
      const outsideTarget = path.join(outsideDir, "escape.txt");
      await assert.rejects(() => fs.readFile(outsideTarget, "utf8"));
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });
});
