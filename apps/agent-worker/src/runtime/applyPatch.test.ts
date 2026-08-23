import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { applyPreparedPatch, classifyApplyPatchFailureMessage, formatApplyPatchFailureTextFromMessage, prepareApplyPatchTool } from "./applyPatch.js";

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


test("apply_patch 支持 fenced code block 归一化", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const target = path.join(workspacePath, "fenced.txt");
    await fs.writeFile(target, "a\n", { encoding: "utf8" });

    const patchText = [
      "```diff",
      "diff --git a/fenced.txt b/fenced.txt",
      "--- a/fenced.txt",
      "+++ b/fenced.txt",
      "@@ -1,1 +1,1 @@",
      "-a",
      "+b",
      "```"
    ].join("\n");

    const prepared = await prepareApplyPatchTool({ workspacePath, patchText });
    assert.match(prepared.text, /Success\. Updated the following files:/);
    assert.match(prepared.text, /M fenced\.txt \(\+1 -1\)/);
    assert.match(prepared.text, /Notes:[\s\S]*Removed outer Markdown code block \(diff\)\./);
    await applyPreparedPatch({ workspacePath, prepared });

    assert.equal(await fs.readFile(target, "utf8"), "b\n");
  });
});

test("apply_patch 支持前置说明文字裁剪", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const target = path.join(workspacePath, "preface.txt");
    await fs.writeFile(target, "old\n", { encoding: "utf8" });

    const patchText = [
      "This patch updates the file below.",
      "Please review it carefully.",
      "diff --git a/preface.txt b/preface.txt",
      "--- a/preface.txt",
      "+++ b/preface.txt",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new"
    ].join("\n");

    const prepared = await prepareApplyPatchTool({ workspacePath, patchText });
    assert.match(prepared.text, /M preface\.txt \(\+1 -1\)/);
    assert.match(prepared.text, /Notes:[\s\S]*Removed leading explanatory text before diff --git\./);
    await applyPreparedPatch({ workspacePath, prepared });

    assert.equal(await fs.readFile(target, "utf8"), "new\n");
  });
});

test("apply_patch 支持 CRLF 输入归一化", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const target = path.join(workspacePath, "crlf.txt");
    await fs.writeFile(target, "x\n", { encoding: "utf8" });

    const patchText = [
      "diff --git a/crlf.txt b/crlf.txt",
      "--- a/crlf.txt",
      "+++ b/crlf.txt",
      "@@ -1,1 +1,1 @@",
      "-x",
      "+y"
    ].join("\r\n");

    const prepared = await prepareApplyPatchTool({ workspacePath, patchText });
    assert.match(prepared.text, /M crlf\.txt \(\+1 -1\)/);
    assert.match(prepared.text, /Notes:[\s\S]*Normalized line endings to LF\./);
    await applyPreparedPatch({ workspacePath, prepared });

    assert.equal(await fs.readFile(target, "utf8"), "y\n");
  });
});

test("apply_patch 失败文本模板可稳定生成", () => {
  const text = formatApplyPatchFailureTextFromMessage(
    "Failed to find expected lines in a.txt\nHunk: @@ -1,1 +1,1 @@\nTip: re-read the target file and regenerate the patch with more accurate context.",
    { repairAttempted: true }
  );

  assert.match(text, /apply_patch verification failed: CONTEXT_MISMATCH/);
  assert.match(text, /Retryable: yes/);
  assert.match(text, /Repair attempted: yes/);
  assert.match(text, /Failed files: a\.txt/);
  assert.doesNotMatch(text, /\/tmp\/workspace/);
  assert.match(text, /Details:/);
  assert.match(text, /Hint:/);
});

test("apply_patch 错误分类收敛到预期语义", () => {
  assert.equal(classifyApplyPatchFailureMessage("Detected legacy patch format: ...").code, "LEGACY_PATCH_FORMAT");
  assert.equal(classifyApplyPatchFailureMessage("Failed to find expected lines in a.txt").code, "CONTEXT_MISMATCH");
  assert.equal(classifyApplyPatchFailureMessage("prepare/apply snapshot mismatch: content changed after prepare").code, "CONFLICT");

  const legacyText = formatApplyPatchFailureTextFromMessage("Detected legacy patch format: ...", { repairAttempted: false });
  assert.match(legacyText, /Retryable: no/);
  assert.match(legacyText, /Repair attempted: no/);

  const contextText = formatApplyPatchFailureTextFromMessage("Failed to find expected lines in a.txt", { repairAttempted: false });
  assert.match(contextText, /Retryable: yes/);
});

test("apply_patch 在 prepare 后 update 内容漂移时会失败且不覆盖", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const target = path.join(workspacePath, "drift.txt");
    await fs.writeFile(target, "old\n", { encoding: "utf8" });

    const patchText = [
      "diff --git a/drift.txt b/drift.txt",
      "--- a/drift.txt",
      "+++ b/drift.txt",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new"
    ].join("\n");

    const prepared = await prepareApplyPatchTool({ workspacePath, patchText });
    await fs.writeFile(target, "external\n", { encoding: "utf8" });

    await assert.rejects(() => applyPreparedPatch({ workspacePath, prepared }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^prepare\/apply snapshot mismatch: content changed after prepare\nFailed file: drift\.txt/m);
      assert.doesNotMatch(error.message, /\nPath:/);
      assert.equal(error.message.includes(workspacePath), false);
      return true;
    });
    assert.equal(await fs.readFile(target, "utf8"), "external\n");
  });
});

test("apply_patch 在 prepare 后源文件消失时阻断多文件 patch 且不部分写入", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const fileA = path.join(workspacePath, "a.txt");
    const fileB = path.join(workspacePath, "b.txt");
    await fs.writeFile(fileA, "a-old\n", { encoding: "utf8" });
    await fs.writeFile(fileB, "b-old\n", { encoding: "utf8" });

    const patchText = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,1 +1,1 @@",
      "-a-old",
      "+a-new",
      "diff --git a/b.txt b/b.txt",
      "--- a/b.txt",
      "+++ b/b.txt",
      "@@ -1,1 +1,1 @@",
      "-b-old",
      "+b-new"
    ].join("\n");

    const prepared = await prepareApplyPatchTool({ workspacePath, patchText });
    await fs.rm(fileB);

    await assert.rejects(() => applyPreparedPatch({ workspacePath, prepared }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^prepare\/apply snapshot mismatch: source disappeared before apply\nFailed file: b\.txt/m);
      assert.doesNotMatch(error.message, /\nPath:/);
      assert.equal(error.message.includes(workspacePath), false);
      return true;
    });
    assert.equal(await fs.readFile(fileA, "utf8"), "a-old\n");
    await assert.rejects(() => fs.readFile(fileB, "utf8"));
  });
});

test("apply_patch apply 阶段已分类写入错误使用相对路径", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const cases = [
      {
        name: "add EEXIST",
        target: "added.txt",
        code: "EEXIST",
        expected: "add target already exists: added.txt",
        patchText: [
          "diff --git a/added.txt b/added.txt",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/added.txt",
          "@@ -0,0 +1,1 @@",
          "+added"
        ].join("\n")
      },
      {
        name: "update ENOENT",
        target: "updated.txt",
        code: "ENOENT",
        expected: "MISSING_PARENT_DIR: update failed for updated.txt",
        setup: () => fs.writeFile(path.join(workspacePath, "updated.txt"), "old\n", { encoding: "utf8" }),
        patchText: [
          "diff --git a/updated.txt b/updated.txt",
          "--- a/updated.txt",
          "+++ b/updated.txt",
          "@@ -1,1 +1,1 @@",
          "-old",
          "+new"
        ].join("\n")
      },
      {
        name: "move EBUSY",
        target: "moved.txt",
        code: "EBUSY",
        expected: "IO_RETRYABLE: move failed for moved.txt (EBUSY)",
        setup: () => fs.writeFile(path.join(workspacePath, "source.txt"), "source\n", { encoding: "utf8" }),
        patchText: [
          "diff --git a/source.txt b/moved.txt",
          "similarity index 100%",
          "rename from source.txt",
          "rename to moved.txt"
        ].join("\n")
      }
    ];

    for (const item of cases) {
      await item.setup?.();
      const prepared = await prepareApplyPatchTool({ workspacePath, patchText: item.patchText });
      const targetPath = path.join(workspacePath, item.target);
      const originalWriteFile = fs.writeFile;
      (fs as any).writeFile = async (filePath: string, ...args: unknown[]) => {
        if (filePath === targetPath) {
          const error = new Error(`simulated ${item.code}`) as NodeJS.ErrnoException;
          error.code = item.code;
          throw error;
        }
        return (originalWriteFile as any)(filePath, ...args);
      };
      try {
        await assert.rejects(() => applyPreparedPatch({ workspacePath, prepared }), (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.message, item.expected, item.name);
          assert.equal(error.message.includes(workspacePath), false, item.name);
          return true;
        });
      } finally {
        (fs as any).writeFile = originalWriteFile;
      }
    }
  });
});

test("apply_patch snapshot 校验目录错误使用相对路径", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const target = path.join(workspacePath, "snapshot-target.txt");
    await fs.writeFile(target, "old\n", { encoding: "utf8" });
    const patchText = [
      "diff --git a/snapshot-target.txt b/snapshot-target.txt",
      "--- a/snapshot-target.txt",
      "+++ b/snapshot-target.txt",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new"
    ].join("\n");

    const prepared = await prepareApplyPatchTool({ workspacePath, patchText });
    await fs.rm(target);
    await fs.mkdir(target);

    await assert.rejects(() => applyPreparedPatch({ workspacePath, prepared }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Path is a directory: snapshot-target.txt");
      assert.equal(error.message.includes(workspacePath), false);
      return true;
    });
  });
});

test("apply_patch snapshot 校验 symlink 错误使用相对路径", async (t) => {
  await withTempWorkspace(async (workspacePath) => {
    const target = path.join(workspacePath, "snapshot-target.txt");
    const outside = path.join(workspacePath, "outside.txt");
    await fs.writeFile(target, "old\n", { encoding: "utf8" });
    await fs.writeFile(outside, "outside\n", { encoding: "utf8" });
    const patchText = [
      "diff --git a/snapshot-target.txt b/snapshot-target.txt",
      "--- a/snapshot-target.txt",
      "+++ b/snapshot-target.txt",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new"
    ].join("\n");

    const prepared = await prepareApplyPatchTool({ workspacePath, patchText });
    await fs.rm(target);
    try {
      await fs.symlink(outside, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return t.skip("symlink is unavailable on this platform");
      throw error;
    }

    await assert.rejects(() => applyPreparedPatch({ workspacePath, prepared }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "symlink path is not allowed: snapshot-target.txt");
      assert.equal(error.message.includes(workspacePath), false);
      return true;
    });
  });
});

test("apply_patch 在 prepare 后 add 目标被创建时会失败且不覆盖", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const other = path.join(workspacePath, "other.txt");
    await fs.writeFile(other, "other-old\n", { encoding: "utf8" });

    const patchText = [
      "diff --git a/newdir/new.txt b/newdir/new.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/newdir/new.txt",
      "@@ -0,0 +1,1 @@",
      "+hello",
      "diff --git a/other.txt b/other.txt",
      "--- a/other.txt",
      "+++ b/other.txt",
      "@@ -1,1 +1,1 @@",
      "-other-old",
      "+other-new"
    ].join("\n");

    const prepared = await prepareApplyPatchTool({ workspacePath, patchText });
    await fs.writeFile(other, "other-external\n", { encoding: "utf8" });

    await assert.rejects(
      () => applyPreparedPatch({ workspacePath, prepared }),
      /snapshot mismatch|content changed after prepare/i
    );
    assert.equal(await fs.readFile(other, "utf8"), "other-external\n");
    await assert.rejects(() => fs.stat(path.join(workspacePath, "newdir")));
  });
});

test("apply_patch 在 prepare 后 rename+modify 目标被创建时会失败且不覆盖", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const source = path.join(workspacePath, "rename-source.txt");
    const target = path.join(workspacePath, "rename-target.txt");
    await fs.writeFile(source, "source-old\n", { encoding: "utf8" });

    const patchText = [
      "diff --git a/rename-source.txt b/rename-target.txt",
      "similarity index 50%",
      "rename from rename-source.txt",
      "rename to rename-target.txt",
      "--- a/rename-source.txt",
      "+++ b/rename-target.txt",
      "@@ -1,1 +1,1 @@",
      "-source-old",
      "+source-new"
    ].join("\n");

    const prepared = await prepareApplyPatchTool({ workspacePath, patchText });
    await fs.writeFile(target, "external-target\n", { encoding: "utf8" });

    await assert.rejects(
      () => applyPreparedPatch({ workspacePath, prepared }),
      /snapshot mismatch|target already exists before apply/i
    );
    assert.equal(await fs.readFile(source, "utf8"), "source-old\n");
    assert.equal(await fs.readFile(target, "utf8"), "external-target\n");
  });
});

test("apply_patch 多文件 patch 任一文件漂移时不会写入其他文件", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const fileA = path.join(workspacePath, "a.txt");
    const fileB = path.join(workspacePath, "b.txt");
    await fs.writeFile(fileA, "a-old\n", { encoding: "utf8" });
    await fs.writeFile(fileB, "b-old\n", { encoding: "utf8" });

    const patchText = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,1 +1,1 @@",
      "-a-old",
      "+a-new",
      "diff --git a/b.txt b/b.txt",
      "--- a/b.txt",
      "+++ b/b.txt",
      "@@ -1,1 +1,1 @@",
      "-b-old",
      "+b-new"
    ].join("\n");

    const prepared = await prepareApplyPatchTool({ workspacePath, patchText });
    await fs.writeFile(fileA, "a-external\n", { encoding: "utf8" });

    await assert.rejects(() => applyPreparedPatch({ workspacePath, prepared }), /snapshot mismatch|content changed after prepare/i);
    assert.equal(await fs.readFile(fileA, "utf8"), "a-external\n");
    assert.equal(await fs.readFile(fileB, "utf8"), "b-old\n");
  });
});

test("apply_patch move 在 prepare 后 source 漂移时会失败且不移动", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const source = path.join(workspacePath, "move-source.txt");
    const target = path.join(workspacePath, "move-target.txt");
    await fs.writeFile(source, "source-old\n", { encoding: "utf8" });

    const patchText = [
      "diff --git a/move-source.txt b/move-target.txt",
      "similarity index 100%",
      "rename from move-source.txt",
      "rename to move-target.txt"
    ].join("\n");

    const prepared = await prepareApplyPatchTool({ workspacePath, patchText });
    await fs.writeFile(source, "source-external\n", { encoding: "utf8" });

    await assert.rejects(() => applyPreparedPatch({ workspacePath, prepared }), /snapshot mismatch|content changed after prepare/i);
    assert.equal(await fs.readFile(source, "utf8"), "source-external\n");
    await assert.rejects(() => fs.readFile(target, "utf8"));
  });
});

test("apply_patch 多文件 patch 中先 update 后 rename+modify 时任一目标漂移不会写入前者", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const fileA = path.join(workspacePath, "a.txt");
    const source = path.join(workspacePath, "move-source.txt");
    const target = path.join(workspacePath, "move-target.txt");
    await fs.writeFile(fileA, "a-old\n", { encoding: "utf8" });
    await fs.writeFile(source, "source-old\n", { encoding: "utf8" });

    const patchText = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,1 +1,1 @@",
      "-a-old",
      "+a-new",
      "diff --git a/move-source.txt b/move-target.txt",
      "similarity index 50%",
      "rename from move-source.txt",
      "rename to move-target.txt",
      "--- a/move-source.txt",
      "+++ b/move-target.txt",
      "@@ -1,1 +1,1 @@",
      "-source-old",
      "+source-new"
    ].join("\n");

    const prepared = await prepareApplyPatchTool({ workspacePath, patchText });
    await fs.writeFile(target, "external-target\n", { encoding: "utf8" });

    await assert.rejects(() => applyPreparedPatch({ workspacePath, prepared }), /snapshot mismatch|target already exists before apply/i);
    assert.equal(await fs.readFile(fileA, "utf8"), "a-old\n");
    assert.equal(await fs.readFile(source, "utf8"), "source-old\n");
    assert.equal(await fs.readFile(target, "utf8"), "external-target\n");
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

    await assert.rejects(() => prepareApplyPatchTool({ workspacePath, patchText }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "move target already exists: target.txt");
      assert.equal(error.message.includes(workspacePath), false);
      return true;
    });
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
      await assert.rejects(() => prepareApplyPatchTool({ workspacePath, patchText }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "symlink path is not allowed: linkdir");
        assert.equal(error.message.includes(workspacePath), false);
        return true;
      });
      const outsideTarget = path.join(outsideDir, "escape.txt");
      await assert.rejects(() => fs.readFile(outsideTarget, "utf8"));
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });
});

test("apply_patch 父组件遍历补强：普通文件不能作为父目录", async () => {
  await withTempWorkspace(async (workspacePath) => {
    await fs.writeFile(path.join(workspacePath, "blocked"), "not a directory\n", "utf8");
    const patchText = [
      "diff --git a/blocked/new.txt b/blocked/new.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/blocked/new.txt",
      "@@ -0,0 +1,1 @@",
      "+blocked"
    ].join("\n");

    await assert.rejects(() => prepareApplyPatchTool({ workspacePath, patchText }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Path is not a directory: blocked");
      assert.equal(error.message.includes(workspacePath), false);
      return true;
    });
    assert.equal(await fs.readFile(path.join(workspacePath, "blocked"), "utf8"), "not a directory\n");
  });
});

test("apply_patch prepare 阶段最终目标为目录时使用相对路径", async () => {
  await withTempWorkspace(async (workspacePath) => {
    await fs.mkdir(path.join(workspacePath, "target.txt"));
    const patchText = [
      "diff --git a/target.txt b/target.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/target.txt",
      "@@ -0,0 +1,1 @@",
      "+content"
    ].join("\n");

    await assert.rejects(() => prepareApplyPatchTool({ workspacePath, patchText }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Path is a directory: target.txt");
      assert.equal(error.message.includes(workspacePath), false);
      return true;
    });
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

    await assert.rejects(() => prepareApplyPatchTool({ workspacePath, patchText }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Failed to find expected lines in verify\.txt[\s\S]*Search started from line 1\.[\s\S]*Expected block:[\s\S]*line-x[\s\S]*Nearby actual lines:[\s\S]*1\| line-a[\s\S]*re-read the target file[\s\S]*git diff -U5/);
      assert.equal(error.message.includes(workspacePath), false);
      const formatted = formatApplyPatchFailureTextFromMessage(error.message);
      assert.match(formatted, /Failed files: verify\.txt/);
      assert.match(formatted, /Failed to find expected lines in verify\.txt/);
      assert.equal(formatted.includes(workspacePath), false);
      return true;
    });
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
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "add target already exists: new.txt");
        assert.equal(error.message.includes(workspacePath), false);
        return true;
      }
    );
    assert.equal(await fs.readFile(target, "utf8"), "line-1\nline-2\n");
  });
});

test("apply_patch prepare 阶段缺失源文件错误使用相对路径", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const cases = [
      {
        expected: "Failed to read file to delete: missing-delete.txt",
        patchText: [
          "diff --git a/missing-delete.txt b/missing-delete.txt",
          "deleted file mode 100644",
          "--- a/missing-delete.txt",
          "+++ /dev/null",
          "@@ -1,1 +0,0 @@",
          "-old"
        ].join("\n")
      },
      {
        expected: "Failed to read file to move: missing-source.txt",
        patchText: [
          "diff --git a/missing-source.txt b/moved.txt",
          "similarity index 100%",
          "rename from missing-source.txt",
          "rename to moved.txt"
        ].join("\n")
      },
      {
        expected: "Failed to read file to update: missing-update.txt",
        patchText: [
          "diff --git a/missing-update.txt b/missing-update.txt",
          "--- a/missing-update.txt",
          "+++ b/missing-update.txt",
          "@@ -1,1 +1,1 @@",
          "-old",
          "+new"
        ].join("\n")
      }
    ];

    for (const item of cases) {
      await assert.rejects(() => prepareApplyPatchTool({ workspacePath, patchText: item.patchText }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, item.expected);
        assert.equal(error.message.includes(workspacePath), false);
        return true;
      });
    }
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
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "delete patch for non-empty file must include hunks: non-empty.txt");
        assert.equal(error.message.includes(workspacePath), false);
        return true;
      }
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
