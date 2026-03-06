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

test("apply_patch git unified diff: 兼容尾部多余的 *** End Patch", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const target = path.join(workspacePath, "foo.txt");
    await fs.writeFile(target, "a\n", { encoding: "utf8" });

    const patchText = [
      "diff --git a/foo.txt b/foo.txt",
      "--- a/foo.txt",
      "+++ b/foo.txt",
      "@@ -1,1 +1,1 @@",
      "-a",
      "+b",
      "*** End Patch",
      ""
    ].join("\n");

    const prepared = await prepareApplyPatchTool({ workspacePath, patchText });
    await applyPreparedPatch({ workspacePath, prepared });

    const content = await fs.readFile(target, "utf8");
    assert.equal(content, "b\n");
  });
});

test("apply_patch git unified diff: 不应剥离 hunk context 行中的 ' *** End Patch'", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const target = path.join(workspacePath, "ctx.txt");
    await fs.writeFile(target, "keep\n*** End Patch\n", { encoding: "utf8" });

    const patchText = [
      "diff --git a/ctx.txt b/ctx.txt",
      "--- a/ctx.txt",
      "+++ b/ctx.txt",
      "@@ -1,2 +1,2 @@",
      "-keep",
      "+kept",
      " *** End Patch"
    ].join("\n");

    const prepared = await prepareApplyPatchTool({ workspacePath, patchText });
    await applyPreparedPatch({ workspacePath, prepared });

    const content = await fs.readFile(target, "utf8");
    assert.equal(content, "kept\n*** End Patch\n");
  });
});

test("apply_patch 支持 git unified diff 单文件单 hunk", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const target = path.join(workspacePath, "foo.txt");
    await fs.writeFile(target, "old\n", { encoding: "utf8" });

    const patchText = [
      "diff --git a/foo.txt b/foo.txt",
      "index 1111111..2222222 100644",
      "--- a/foo.txt",
      "+++ b/foo.txt",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new"
    ].join("\n");

    const prepared = await prepareApplyPatchTool({ workspacePath, patchText });
    await applyPreparedPatch({ workspacePath, prepared });

    const content = await fs.readFile(target, "utf8");
    assert.equal(content, "new\n");
  });
});

test("apply_patch 支持 git unified diff 单文件多个 @@ hunk", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const target = path.join(workspacePath, "multi-hunk.txt");
    await fs.writeFile(target, "a\nb\nc\nd\n", { encoding: "utf8" });

    const patchText = [
      "diff --git a/multi-hunk.txt b/multi-hunk.txt",
      "--- a/multi-hunk.txt",
      "+++ b/multi-hunk.txt",
      "@@ -1,2 +1,2 @@",
      " a",
      "-b",
      "+b-1",
      "@@ -3,2 +3,2 @@",
      " c",
      "-d",
      "+d-2"
    ].join("\n");

    const prepared = await prepareApplyPatchTool({ workspacePath, patchText });
    await applyPreparedPatch({ workspacePath, prepared });

    const content = await fs.readFile(target, "utf8");
    assert.equal(content, "a\nb-1\nc\nd-2\n");
  });
});

test("apply_patch 支持 git unified diff 多文件修改", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const a = path.join(workspacePath, "a.txt");
    const b = path.join(workspacePath, "b.txt");
    await fs.writeFile(a, "x\n", { encoding: "utf8" });
    await fs.writeFile(b, "y\n", { encoding: "utf8" });

    const patchText = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,1 +1,1 @@",
      "-x",
      "+x1",
      "diff --git a/b.txt b/b.txt",
      "--- a/b.txt",
      "+++ b/b.txt",
      "@@ -1,1 +1,1 @@",
      "-y",
      "+y1"
    ].join("\n");

    const prepared = await prepareApplyPatchTool({ workspacePath, patchText });
    await applyPreparedPatch({ workspacePath, prepared });

    assert.equal(await fs.readFile(a, "utf8"), "x1\n");
    assert.equal(await fs.readFile(b, "utf8"), "y1\n");
  });
});

test("apply_patch 支持 git unified diff 新增文件,并拒绝覆盖已存在路径", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const target = path.join(workspacePath, "new.txt");

    const patchText = [
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1,2 @@",
      "+line-1",
      "+line-2"
    ].join("\n");

    const prepared = await prepareApplyPatchTool({ workspacePath, patchText });
    await applyPreparedPatch({ workspacePath, prepared });
    assert.equal(await fs.readFile(target, "utf8"), "line-1\nline-2\n");

    const overwritePatch = [
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1,1 @@",
      "+oops"
    ].join("\n");

    await assert.rejects(
      () => prepareApplyPatchTool({ workspacePath, patchText: overwritePatch }),
      /add target already exists/
    );
    assert.equal(await fs.readFile(target, "utf8"), "line-1\nline-2\n");
  });
});

test("apply_patch 支持 git unified diff 删除文件(有 hunks)", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const target = path.join(workspacePath, "del.txt");
    await fs.writeFile(target, "a\nb\n", { encoding: "utf8" });

    const patchText = [
      "diff --git a/del.txt b/del.txt",
      "deleted file mode 100644",
      "--- a/del.txt",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-a",
      "-b"
    ].join("\n");

    const prepared = await prepareApplyPatchTool({ workspacePath, patchText });
    await applyPreparedPatch({ workspacePath, prepared });

    await assert.rejects(() => fs.readFile(target, "utf8"));
  });
});

test("apply_patch git unified diff 删除文件(无 hunks)仅允许空文件", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const empty = path.join(workspacePath, "empty.txt");
    const nonEmpty = path.join(workspacePath, "non-empty.txt");
    await fs.writeFile(empty, "", { encoding: "utf8" });
    await fs.writeFile(nonEmpty, "x\n", { encoding: "utf8" });

    const emptyDeletePatch = [
      "diff --git a/empty.txt b/empty.txt",
      "deleted file mode 100644",
      "--- a/empty.txt",
      "+++ /dev/null"
    ].join("\n");

    const prepared = await prepareApplyPatchTool({ workspacePath, patchText: emptyDeletePatch });
    await applyPreparedPatch({ workspacePath, prepared });
    await assert.rejects(() => fs.readFile(empty, "utf8"));

    const nonEmptyDeletePatch = [
      "diff --git a/non-empty.txt b/non-empty.txt",
      "deleted file mode 100644",
      "--- a/non-empty.txt",
      "+++ /dev/null"
    ].join("\n");

    await assert.rejects(
      () => prepareApplyPatchTool({ workspacePath, patchText: nonEmptyDeletePatch }),
      /must include hunks/
    );
    assert.equal(await fs.readFile(nonEmpty, "utf8"), "x\n");
  });
});

test("apply_patch 支持 git unified diff rename-only", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const source = path.join(workspacePath, "old.txt");
    const target = path.join(workspacePath, "new.txt");
    await fs.writeFile(source, "keep\n", { encoding: "utf8" });

    const patchText = [
      "diff --git a/old.txt b/new.txt",
      "similarity index 100%",
      "rename from old.txt",
      "rename to new.txt"
    ].join("\n");

    const prepared = await prepareApplyPatchTool({ workspacePath, patchText });
    await applyPreparedPatch({ workspacePath, prepared });

    await assert.rejects(() => fs.readFile(source, "utf8"));
    assert.equal(await fs.readFile(target, "utf8"), "keep\n");
  });
});

test("apply_patch 支持 git unified diff rename + modify", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const source = path.join(workspacePath, "from.txt");
    const target = path.join(workspacePath, "to.txt");
    await fs.writeFile(source, "a\nb\n", { encoding: "utf8" });

    const patchText = [
      "diff --git a/from.txt b/to.txt",
      "similarity index 50%",
      "rename from from.txt",
      "rename to to.txt",
      "--- a/from.txt",
      "+++ b/to.txt",
      "@@ -1,2 +1,2 @@",
      " a",
      "-b",
      "+b2"
    ].join("\n");

    const prepared = await prepareApplyPatchTool({ workspacePath, patchText });
    await applyPreparedPatch({ workspacePath, prepared });

    await assert.rejects(() => fs.readFile(source, "utf8"));
    assert.equal(await fs.readFile(target, "utf8"), "a\nb2\n");
  });
});

test("apply_patch 拒绝 git binary patch", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const patchText = [
      "diff --git a/a.bin b/a.bin",
      "GIT binary patch",
      "literal 0"
    ].join("\n");

    await assert.rejects(
      () => prepareApplyPatchTool({ workspacePath, patchText }),
      /binary patch is not supported/
    );
  });
});

test("apply_patch old-style unified diff(无 diff --git) 支持多文件", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const a = path.join(workspacePath, "a.txt");
    const b = path.join(workspacePath, "b.txt");
    await fs.writeFile(a, "x\n", { encoding: "utf8" });
    await fs.writeFile(b, "y\n", { encoding: "utf8" });

    const patchText = [
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,1 +1,1 @@",
      "-x",
      "+x1",
      "--- a/b.txt",
      "+++ b/b.txt",
      "@@ -1,1 +1,1 @@",
      "-y",
      "+y1"
    ].join("\n");

    const prepared = await prepareApplyPatchTool({ workspacePath, patchText });
    await applyPreparedPatch({ workspacePath, prepared });

    assert.equal(await fs.readFile(a, "utf8"), "x1\n");
    assert.equal(await fs.readFile(b, "utf8"), "y1\n");
  });
});

test("apply_patch 新增文件 diff 若包含 context 或 delete 行则拒绝", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const patchText = [
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1,2 @@",
      "+line-1",
      " line-2"
    ].join("\n");

    await assert.rejects(
      () => prepareApplyPatchTool({ workspacePath, patchText }),
      /Unsupported add-file hunk/
    );
  });
});
