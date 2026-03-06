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

test("apply_patch legacy patch 会被明确提示改用 unified diff", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const target = path.join(workspacePath, "multi.txt");
    await fs.writeFile(target, "foo\nbar\n", { encoding: "utf8" });

    const patchText = [
      "*** Begin Patch",
      "*** Update File: multi.txt",
      "@@",
      "-foo",
      "+foo-1",
      "*** End Patch"
    ].join("\n");

    await assert.rejects(
      () => prepareApplyPatchTool({ workspacePath, patchText }),
      /only supports git unified diff[\s\S]*Detected legacy patch format[\s\S]*diff --git a\/<path> b\/<path>[\s\S]*@@ -1,1 \+1,1 @@/
    );
  });
});

test("apply_patch legacy patch 首行不是 Begin Patch 时也会被明确提示", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const patchText = [
      "*** Update File: foo.txt",
      "@@",
      "-old",
      "+new"
    ].join("\n");

    await assert.rejects(
      () => prepareApplyPatchTool({ workspacePath, patchText }),
      /only supports git unified diff[\s\S]*\*\*\* Update File:[\s\S]*@@ -1,1 \+1,1 @@/
    );
  });
});

test("apply_patch move 目标已存在时拒绝覆盖", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const source = path.join(workspacePath, "source.txt");
    const target = path.join(workspacePath, "target.txt");
    await fs.writeFile(source, "source\n", { encoding: "utf8" });
    await fs.writeFile(target, "target\n", { encoding: "utf8" });

    const patchText = [
      "diff --git a/source.txt b/target.txt",
      "similarity index 50%",
      "rename from source.txt",
      "rename to target.txt",
      "--- a/source.txt",
      "+++ b/target.txt",
      "@@ -1,1 +1,1 @@",
      "-source",
      "+moved"
    ].join("\n");

    await assert.rejects(() => prepareApplyPatchTool({ workspacePath, patchText }), /move target already exists/);
    assert.equal(await fs.readFile(source, "utf8"), "source\n");
    assert.equal(await fs.readFile(target, "utf8"), "target\n");
  });
});

test("apply_patch verify 失败时不写入任何变更", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const target = path.join(workspacePath, "verify.txt");
    await fs.writeFile(target, "line-a\n", { encoding: "utf8" });

    const patchText = [
      "diff --git a/verify.txt b/verify.txt",
      "--- a/verify.txt",
      "+++ b/verify.txt",
      "@@ -1,1 +1,1 @@",
      "-line-b",
      "+line-c"
    ].join("\n");

    await assert.rejects(() => prepareApplyPatchTool({ workspacePath, patchText }));
    assert.equal(await fs.readFile(target, "utf8"), "line-a\n");
  });
});

test("apply_patch 拒绝越界路径", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const patchText = [
      "diff --git a/../escape.txt b/../escape.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/../escape.txt",
      "@@ -0,0 +1,1 @@",
      "+oops"
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
      "diff --git a/linkdir/escape.txt b/linkdir/escape.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/linkdir/escape.txt",
      "@@ -0,0 +1,1 @@",
      "+blocked"
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

test("apply_patch 上下文不匹配时返回 nearby actual lines 与搜索起始行", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const target = path.join(workspacePath, "verify.txt");
    await fs.writeFile(target, "line-a\nline-b\nline-c\n", { encoding: "utf8" });

    const patchText = [
      "diff --git a/verify.txt b/verify.txt",
      "--- a/verify.txt",
      "+++ b/verify.txt",
      "@@ -1,1 +1,1 @@",
      "-line-x",
      "+line-z"
    ].join("\n");

    await assert.rejects(
      () => prepareApplyPatchTool({ workspacePath, patchText }),
      /Failed to find expected lines in[\s\S]*Search started from line 1\.[\s\S]*Expected block:[\s\S]*line-x[\s\S]*Nearby actual lines:[\s\S]*1\| line-a[\s\S]*re-read the target file[\s\S]*git diff -U5/
    );
    assert.equal(await fs.readFile(target, "utf8"), "line-a\nline-b\nline-c\n");
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
