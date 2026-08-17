import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";
import { afterEach, test } from "node:test";
import { parseSkillFrontmatter, parseStableSkillIdentifier } from "@agent-workbench/shared";
import { __testing, runReadTool, runSkillTool, runWriteTool } from "./fileTools.js";

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createWorkspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "awb-filetools-"));
  workspaces.push(dir);
  return dir;
}

test("read 允许读取包含少量非法 utf8 字节但整体像文本的文件", async () => {
  const workspacePath = await createWorkspace();
  const filePath = path.join(workspacePath, "lossy.txt");
  await fs.writeFile(filePath, Buffer.from([0x61, 0x6c, 0x70, 0x68, 0x61, 0x0a, 0x80, 0x62, 0x65, 0x74, 0x61, 0x0a]));

  const result = await runReadTool({
    workspacePath,
    workspaceRepoDirNames: [],
    filePath: "lossy.txt"
  });

  assert.match(result.content, /1: alpha/);
  assert.match(result.content, /2: €beta/);
});

test("read 允许读取 UTF-16 LE BOM 文本", async () => {
  const workspacePath = await createWorkspace();
  const filePath = path.join(workspacePath, "utf16.txt");
  await fs.writeFile(filePath, Buffer.from([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00, 0x0a, 0x00]));

  const result = await runReadTool({
    workspacePath,
    workspaceRepoDirNames: [],
    filePath: "utf16.txt"
  });

  assert.match(result.content, /1: AB/);
  assert.doesNotMatch(result.content, /2:/);
});

test("read 允许读取 UTF-32 LE BOM 文本", async () => {
  const workspacePath = await createWorkspace();
  const filePath = path.join(workspacePath, "utf32.txt");
  await fs.writeFile(filePath, Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x41, 0x00, 0x00, 0x00, 0x42, 0x00, 0x00, 0x00, 0x0a, 0x00, 0x00, 0x00]));

  const result = await runReadTool({
    workspacePath,
    workspaceRepoDirNames: [],
    filePath: "utf32.txt"
  });

  assert.match(result.content, /1: AB/);
  assert.doesNotMatch(result.content, /2:/);
});

test("read 允许读取非 UTF-8 但整体像文本的高位字节内容", async () => {
  const workspacePath = await createWorkspace();
  const filePath = path.join(workspacePath, "legacy.txt");
  await fs.writeFile(filePath, Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a]));

  const result = await runReadTool({
    workspacePath,
    workspaceRepoDirNames: [],
    filePath: "legacy.txt"
  });

  assert.match(result.content, /1: ÖÐÎÄ/);
});

test("write before 预览与 read 对少量坏字节文本保持一致的宽松解码", async () => {
  const workspacePath = await createWorkspace();
  const filePath = path.join(workspacePath, "before-lossy.txt");
  await fs.writeFile(filePath, Buffer.from([0x61, 0x6c, 0x70, 0x68, 0x61, 0x0a, 0x80, 0x62, 0x65, 0x74, 0x61, 0x0a]));

  const writeResult = await runWriteTool({
    workspacePath,
    filePath: "before-lossy.txt",
    content: "next"
  });

  assert.equal(writeResult.before.available, true);
  assert.equal(writeResult.before.encoding, "latin1");
  assert.match(String(writeResult.before.text || ""), /€beta/);
});

test("read 对以换行结尾的文件不额外多算空白尾行", async () => {
  const workspacePath = await createWorkspace();
  const filePath = path.join(workspacePath, "tail-newline.txt");
  await fs.writeFile(filePath, "alpha\nbeta\n", "utf8");

  const result = await runReadTool({
    workspacePath,
    workspaceRepoDirNames: [],
    filePath: "tail-newline.txt"
  });

  assert.match(result.content, /1: alpha/);
  assert.match(result.content, /2: beta/);
  assert.doesNotMatch(result.content, /3:/);
  assert.match(result.content, /End of file - total 2 lines\. No more content to read\./);
});

test("read 支持对大文件使用 offset 继续读取", async () => {
  const workspacePath = await createWorkspace();
  const filePath = path.join(workspacePath, "large.txt");
  const lines = Array.from({ length: 6000 }, (_, i) => `line-${i + 1}`);
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");

  const result = await runReadTool({
    workspacePath,
    workspaceRepoDirNames: [],
    filePath: "large.txt",
    offset: 5500,
    limit: 3
  });

  assert.match(result.content, /5500: line-5500/);
  assert.match(result.content, /5502: line-5502/);
  assert.match(result.content, /To continue reading this same file, use exactly offset=5503\. Do not guess the next offset\./);
});

test("read 在 offset 超过文件总行数时返回 EOF 说明而不是失败", async () => {
  const workspacePath = await createWorkspace();
  const filePath = path.join(workspacePath, "small.txt");
  await fs.writeFile(filePath, "alpha\nbeta\n", "utf8");

  const result = await runReadTool({ workspacePath, workspaceRepoDirNames: [], filePath: "small.txt", offset: 5, limit: 20 });

  assert.equal(result.summary, "读取文件 small.txt");
  assert.equal(result.content, "(End of file - total 2 lines. Requested offset=5 exceeds file length. No more content to read. Do not call read again for this file unless the file changes.)");
});

test("read 仍拒绝明显的二进制文件", async () => {
  const workspacePath = await createWorkspace();
  const filePath = path.join(workspacePath, "image.png");
  await fs.writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]));

  await assert.rejects(
    () =>
      runReadTool({
        workspacePath,
        workspaceRepoDirNames: [],
        filePath: "image.png"
      }),
    /binary file is not supported/
  );
});

test("read 读取目录行为保持不变", async () => {
  const workspacePath = await createWorkspace();
  await fs.mkdir(path.join(workspacePath, "nested"), { recursive: true });
  await fs.writeFile(path.join(workspacePath, "nested", "a.txt"), "ok", "utf8");

  const result = await runReadTool({
    workspacePath,
    workspaceRepoDirNames: [],
    filePath: "nested"
  });

  assert.match(result.summary, /读取目录 nested/);
  assert.match(result.content, /a.txt/);
});

test("read 在样本之后遇到少量坏 utf8 字节时仍保留后续有效文本", async () => {
  const workspacePath = await createWorkspace();
  const filePath = path.join(workspacePath, "late-lossy.txt");
  const prefix = `header=${"a".repeat(40_000)}\n`;
  const tail = "tail-line-1\n";
  await fs.writeFile(filePath, Buffer.concat([
    Buffer.from(prefix, "utf8"),
    Buffer.from([0x80]),
    Buffer.from(tail, "utf8")
  ]));

  const result = await runReadTool({
    workspacePath,
    workspaceRepoDirNames: [],
    filePath: "late-lossy.txt",
    offset: 2,
    limit: 2
  });

  assert.match(result.content, /2: �tail-line-1/);
});

test("read 在 CRLF 跨 chunk 边界时不应额外产生空行", async () => {
  const workspacePath = await createWorkspace();
  const filePath = path.join(workspacePath, "crlf-boundary.txt");
  const prefix = "a".repeat(65535);
  await fs.writeFile(filePath, `${prefix}\r\nNEXT\r\n`, "utf8");

  const result = await runReadTool({
    workspacePath,
    workspaceRepoDirNames: [],
    filePath: "crlf-boundary.txt",
    offset: 2,
    limit: 2
  });

  assert.match(result.content, /2: NEXT/);
  assert.doesNotMatch(result.content, /3:/);
});

test("read 读取目录分页时提示使用返回的 offset", async () => {
  const workspacePath = await createWorkspace();
  await fs.mkdir(path.join(workspacePath, "nested"), { recursive: true });
  await fs.writeFile(path.join(workspacePath, "nested", "a.txt"), "a", "utf8");
  await fs.writeFile(path.join(workspacePath, "nested", "b.txt"), "b", "utf8");
  await fs.writeFile(path.join(workspacePath, "nested", "c.txt"), "c", "utf8");

  const result = await runReadTool({ workspacePath, workspaceRepoDirNames: [], filePath: "nested", offset: 1, limit: 2 });

  assert.match(result.content, /a\.txt/);
  assert.match(result.content, /b\.txt/);
  assert.doesNotMatch(result.content, /c\.txt/);
  assert.match(result.content, /To continue reading this same directory, use exactly offset=3\. Do not guess the next offset\./);
});

test("read 在目录 offset 超过条目数时返回 EOF 说明而不是失败", async () => {
  const workspacePath = await createWorkspace();
  await fs.mkdir(path.join(workspacePath, "nested"), { recursive: true });
  await fs.writeFile(path.join(workspacePath, "nested", "a.txt"), "a", "utf8");
  await fs.writeFile(path.join(workspacePath, "nested", "b.txt"), "b", "utf8");

  const result = await runReadTool({ workspacePath, workspaceRepoDirNames: [], filePath: "nested", offset: 5, limit: 20 });

  assert.equal(result.summary, "读取目录 nested");
  assert.equal(result.content, "(End of directory - total 2 entries. Requested offset=5 exceeds directory length. No more entries to read. Do not call read again for this directory unless the directory contents change.)");
});

test("read 根路径缺失时仍失败并提示单个登记 repo 候选", async () => {
  const workspacePath = await createWorkspace();
  await fs.mkdir(path.join(workspacePath, "repo-a", "src"), { recursive: true });
  await fs.writeFile(path.join(workspacePath, "repo-a", "src", "a.ts"), "export {};", "utf8");

  await assert.rejects(
    () => runReadTool({ workspacePath, workspaceRepoDirNames: ["repo-a"], filePath: "src/a.ts" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^ENOENT:/);
      assert.match(error.message, /\n\nPath exists in registered workspace repo\(s\)\. Retry read with one of:\n- repo-a\/src\/a\.ts$/);
      assert.equal(error.message.includes(workspacePath), true, "root error prefix remains unchanged");
      return true;
    }
  );
});

test("read repo 候选按 UTF-8 字节序稳定排序，且不自动读取", async () => {
  const workspacePath = await createWorkspace();
  for (const repoName of ["repo-z", "repo-a"]) {
    await fs.mkdir(path.join(workspacePath, repoName, "src"), { recursive: true });
    await fs.writeFile(path.join(workspacePath, repoName, "src", "a.ts"), "export {};", "utf8");
  }

  await assert.rejects(
    () => runReadTool({ workspacePath, workspaceRepoDirNames: ["repo-z", "repo-a"], filePath: "src/a.ts" }),
    /- repo-a\/src\/a\.ts\n- repo-z\/src\/a\.ts$/
  );
});

test("read repo 探测无候选或非法名称时保持原始错误", async () => {
  const workspacePath = await createWorkspace();
  await fs.mkdir(path.join(workspacePath, "repo-a"), { recursive: true });

  await assert.rejects(
    () => runReadTool({ workspacePath, workspaceRepoDirNames: ["..", "repo/a", "repo-a"], filePath: "src/a.ts" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^ENOENT:/);
      assert.doesNotMatch(error.message, /Path exists in registered workspace repo/);
      return true;
    }
  );
});

test("read 对 ENOTDIR 根错误提示 repo 候选", async () => {
  const workspacePath = await createWorkspace();
  await fs.writeFile(path.join(workspacePath, "src"), "not a directory", "utf8");
  await fs.mkdir(path.join(workspacePath, "repo-a", "src"), { recursive: true });
  await fs.writeFile(path.join(workspacePath, "repo-a", "src", "a.ts"), "export {};", "utf8");

  await assert.rejects(
    () => runReadTool({ workspacePath, workspaceRepoDirNames: ["repo-a"], filePath: "src/a.ts" }),
    /ENOTDIR:.*\n\nPath exists in registered workspace repo\(s\)\. Retry read with one of:\n- repo-a\/src\/a\.ts$/s
  );
});

test("read 不提示 repo 根或最终候选自身为 symlink", async (t) => {
  const workspacePath = await createWorkspace();
  const outsidePath = await createWorkspace();
  const targetPath = path.join(outsidePath, "target");
  await fs.mkdir(path.join(targetPath, "src"), { recursive: true });
  await fs.writeFile(path.join(targetPath, "src", "a.ts"), "export {};", "utf8");
  try {
    await fs.symlink(targetPath, path.join(workspacePath, "repo-root-link"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") t.skip("symlink is unavailable on this platform");
    else throw error;
  }
  await fs.mkdir(path.join(workspacePath, "repo-file-link", "src"), { recursive: true });
  await fs.symlink(path.join(targetPath, "src", "a.ts"), path.join(workspacePath, "repo-file-link", "src", "a.ts"));

  await assert.rejects(
    () => runReadTool({ workspacePath, workspaceRepoDirNames: ["repo-root-link", "repo-file-link"], filePath: "src/a.ts" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /Path exists in registered workspace repo/);
      return true;
    }
  );
});

test("read 可提示 workspace 内中间 symlink，但不提示逃逸中间 symlink", async (t) => {
  const workspacePath = await createWorkspace();
  const internalTarget = path.join(workspacePath, "internal-target");
  const outsidePath = await createWorkspace();
  await fs.mkdir(internalTarget, { recursive: true });
  await fs.mkdir(path.join(outsidePath, "external-target"), { recursive: true });
  await fs.writeFile(path.join(internalTarget, "a.ts"), "export {};", "utf8");
  await fs.writeFile(path.join(outsidePath, "external-target", "a.ts"), "export {};", "utf8");
  await fs.mkdir(path.join(workspacePath, "repo-internal"), { recursive: true });
  await fs.mkdir(path.join(workspacePath, "repo-external"), { recursive: true });
  try {
    await fs.symlink(internalTarget, path.join(workspacePath, "repo-internal", "src"));
    await fs.symlink(path.join(outsidePath, "external-target"), path.join(workspacePath, "repo-external", "src"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return t.skip("symlink is unavailable on this platform");
    else throw error;
  }

  await assert.rejects(
    () => runReadTool({ workspacePath, workspaceRepoDirNames: ["repo-external", "repo-internal"], filePath: "src/a.ts" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /- repo-internal\/src\/a\.ts/);
      assert.doesNotMatch(error.message, /repo-external\/src\/a\.ts/);
      return true;
    }
  );
});

test("read repo 提示最多显示十项并报告剩余数量", async () => {
  const workspacePath = await createWorkspace();
  const repoNames = Array.from({ length: 12 }, (_, index) => `repo-${String(index).padStart(2, "0")}`);
  for (const repoName of repoNames) {
    await fs.mkdir(path.join(workspacePath, repoName, "src"), { recursive: true });
    await fs.writeFile(path.join(workspacePath, repoName, "src", "a.ts"), "export {};", "utf8");
  }

  await assert.rejects(
    () => runReadTool({ workspacePath, workspaceRepoDirNames: [...repoNames].reverse(), filePath: "src/a.ts" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /- repo-00\/src\/a\.ts/);
      assert.match(error.message, /- repo-09\/src\/a\.ts/);
      assert.doesNotMatch(error.message, /- repo-10\/src\/a\.ts/);
      assert.match(error.message, /- \.\.\. and 2 more candidate\(s\) not shown$/);
      return true;
    }
  );
});

test("read probe 在已取消时不追加候选提示", async () => {
  const workspacePath = await createWorkspace();
  await fs.mkdir(path.join(workspacePath, "repo-a", "src"), { recursive: true });
  await fs.writeFile(path.join(workspacePath, "repo-a", "src", "a.ts"), "export {};", "utf8");
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => runReadTool({ workspacePath, workspaceRepoDirNames: ["repo-a"], filePath: "src/a.ts", signal: controller.signal }),
    /operation aborted/
  );
});

test("repo probe 在中途取消后不派发后续候选，也不返回已完成匹配", async () => {
  const workspacePath = await createWorkspace();
  for (const repoName of ["repo-a", "repo-b"]) {
    await fs.mkdir(path.join(workspacePath, repoName, "src"), { recursive: true });
    await fs.writeFile(path.join(workspacePath, repoName, "src", "a.ts"), "export {};", "utf8");
  }
  const controller = new AbortController();
  let releaseFirstProbe!: () => void;
  const firstProbeGate = new Promise<void>((resolve) => {
    releaseFirstProbe = resolve;
  });
  const originalLstat = fs.lstat;
  let repoRootCalls = 0;
  (fs as any).lstat = async (targetPath: string) => {
    if (targetPath === path.join(workspacePath, "repo-a")) {
      repoRootCalls += 1;
      await firstProbeGate;
    }
    return await originalLstat(targetPath);
  };
  try {
    const probe = __testing.probeRegisteredRepoCandidates({
      workspacePath,
      repoDirNames: ["repo-a", "repo-b"],
      safePath: "src/a.ts",
      signal: controller.signal
    });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    releaseFirstProbe();
    assert.deepEqual(await probe, []);
    assert.equal(repoRootCalls, 1);
  } finally {
    (fs as any).lstat = originalLstat;
  }
});

test("repo probe 忽略单个候选内部异常并继续其他候选", async () => {
  const workspacePath = await createWorkspace();
  await fs.mkdir(path.join(workspacePath, "repo-a", "src"), { recursive: true });
  await fs.mkdir(path.join(workspacePath, "repo-b", "src"), { recursive: true });
  await fs.writeFile(path.join(workspacePath, "repo-a", "src", "a.ts"), "export {};", "utf8");
  await fs.writeFile(path.join(workspacePath, "repo-b", "src", "a.ts"), "export {};", "utf8");
  const originalLstat = fs.lstat;
  (fs as any).lstat = async (targetPath: string) => {
    if (targetPath === path.join(workspacePath, "repo-a")) throw new Error("probe fixture failure");
    return await originalLstat(targetPath);
  };
  try {
    assert.deepEqual(
      await __testing.probeRegisteredRepoCandidates({
        workspacePath,
        repoDirNames: ["repo-a", "repo-b"],
        safePath: "src/a.ts"
      }),
      ["repo-b/src/a.ts"]
    );
  } finally {
    (fs as any).lstat = originalLstat;
  }
});

test("read 对登记 repo 下的目录候选仍失败并给出重试提示", async () => {
  const workspacePath = await createWorkspace();
  await fs.mkdir(path.join(workspacePath, "repo-a", "docs"), { recursive: true });

  await assert.rejects(
    () => runReadTool({ workspacePath, workspaceRepoDirNames: ["repo-a"], filePath: "docs" }),
    (error: unknown) => {
      const message = String(error);
      return message.includes("ENOENT:") && message.includes("- repo-a/docs");
    }
  );
});

test("仅 ENOENT 和 ENOTDIR 根错误会触发 repo probe", () => {
  assert.equal(__testing.isMissingRootPathError({ code: "ENOENT" }), true);
  assert.equal(__testing.isMissingRootPathError({ code: "ENOTDIR" }), true);
  assert.equal(__testing.isMissingRootPathError({ code: "EACCES" }), false);
  assert.equal(__testing.isMissingRootPathError(new Error("ENOENT in message only")), false);
});

test("read 根 lstat 的非缺失错误不探测登记 repo", async () => {
  const workspacePath = await createWorkspace();
  const accessError = new Error("permission denied") as NodeJS.ErrnoException;
  accessError.code = "EACCES";
  const messageOnlyError = new Error("ENOENT appears only in this error message");

  for (const rootError of [accessError, messageOnlyError]) {
    let probeCalls = 0;
    await assert.rejects(
      () =>
        __testing.runReadTool(
          {
            workspacePath,
            workspaceRepoDirNames: ["repo-a"],
            filePath: "src/a.ts"
          },
          {
            rootLstat: async () => {
              throw rootError;
            },
            probeCandidates: async () => {
              probeCalls += 1;
              return ["repo-a/src/a.ts"];
            }
          }
        ),
      (error: unknown) => {
        assert.equal(error, rootError);
        assert.equal(String(error).includes("Path exists in registered workspace repo(s). Retry read with one of:"), false);
        return true;
      }
    );
    assert.equal(probeCalls, 0);
  }
});

test("repo probe 的部分内部异常不会丢失其他有效候选", async () => {
  const workspacePath = "/workspace";
  const stat = { isSymbolicLink: () => false } as any;
  const fileSystem = {
    async lstat(target: string) {
      if (target.endsWith("repo-b/src/a.ts")) {
        const error = new Error("candidate io failure") as NodeJS.ErrnoException;
        error.code = "EIO";
        throw error;
      }
      return stat;
    },
    async realpath(target: string) {
      return target;
    }
  };

  const matches = await __testing.probeRegisteredRepoCandidates({
    workspacePath,
    repoDirNames: ["repo-b", "repo-a"],
    safePath: "src/a.ts"
  }, fileSystem);

  assert.deepEqual(matches, ["repo-a/src/a.ts"]);
});

test("repo probe 的全部内部异常只产生空候选，由调用方保留根错误", async () => {
  const workspacePath = "/workspace";
  const fileSystem = {
    async lstat() {
      const error = new Error("probe unavailable") as NodeJS.ErrnoException;
      error.code = "EIO";
      throw error;
    },
    async realpath(target: string) {
      return target;
    }
  };

  const matches = await __testing.probeRegisteredRepoCandidates({
    workspacePath,
    repoDirNames: ["repo-a", "repo-b"],
    safePath: "src/a.ts"
  }, fileSystem);

  assert.deepEqual(matches, []);
});

test("候选在 lstat 后、realpath 前消失时不作为匹配提示", async () => {
  const workspacePath = "/workspace";
  const stat = { isSymbolicLink: () => false } as any;
  const fileSystem = {
    async lstat() {
      return stat;
    },
    async realpath(target: string) {
      if (target.endsWith("repo-a/src/a.ts")) {
        const error = new Error("candidate disappeared") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return target;
    }
  };

  const matches = await __testing.probeRegisteredRepoCandidates({
    workspacePath,
    repoDirNames: ["repo-a"],
    safePath: "src/a.ts"
  }, fileSystem);

  assert.deepEqual(matches, []);
});

test("skill V2 共用 frontmatter helper 保留根正文并遵守完整边界", () => {
  assert.deepEqual(
    parseSkillFrontmatter("---\r\nNAME: \"  First  \"\r\ndescription:\r\nDescription: '  desc  '\r\n---\r\nbody\r\n"),
    { name: "First", description: "desc", body: "body\r\n" }
  );
  assert.deepEqual(
    parseSkillFrontmatter("\ufeff---\nname: ignored\n---\nbody"),
    { name: "", description: "", body: "\ufeff---\nname: ignored\n---\nbody" }
  );
  assert.deepEqual(
    parseSkillFrontmatter("---\rname: ignored\r---\rbody"),
    { name: "", description: "", body: "---\rname: ignored\r---\rbody" }
  );
});

test("skill V2 stable identifier 只修剪 ASCII 空格和 tab", () => {
  assert.deepEqual(parseStableSkillIdentifier(" \tbuiltin/tooling\t "), {
    kind: "valid",
    value: { skill: "builtin/tooling", namespace: "builtin", skillDir: "tooling" }
  });
  assert.deepEqual(parseStableSkillIdentifier("\nbuiltin/tooling"), { kind: "invalid" });
  assert.deepEqual(parseStableSkillIdentifier("\u00a0"), { kind: "invalid" });
  assert.deepEqual(parseStableSkillIdentifier("  \t"), { kind: "required" });
});

test("skill V2 根读取返回正文和扁平可复制文件路径", async () => {
  const workspacePath = await createWorkspace();
  const repoRoot = await createWorkspace();
  const skillRoot = path.join(repoRoot, "skills", "tooling");
  await fs.mkdir(path.join(skillRoot, "nested"), { recursive: true });
  await fs.writeFile(path.join(skillRoot, "SKILL.md"), "---\r\nname: Tooling\r\ndescription: Tooling desc\r\n---\r\n\r\nTooling body\r\n", "utf8");
  await fs.writeFile(path.join(skillRoot, "notes.txt"), "notes", "utf8");
  await fs.writeFile(path.join(skillRoot, "nested", "SKILL.md"), "---\nname: ordinary helper\n---\nnested body", "utf8");

  const result = await runSkillTool({ workspacePath, repoRoot, skillId: " builtin/tooling " });

  assert.equal(result.skillId, "builtin/tooling");
  assert.equal(result.filePath, "SKILL.md");
  assert.deepEqual(Object.keys(result).sort(), ["content", "filePath", "skillId", "truncated"]);
  assert.equal(result.truncated, false);
  assert.match(result.content, /Tooling body\r\n/);
  assert.match(result.content, /\n\n---\n\n## Skill files\n\n```text\nnested\/SKILL\.md\nnotes\.txt\n```$/);
  assert.equal(result.content.includes("Tooling desc"), false);
});

test("skill V2 指定辅助文件保持通用读取器规范化且不剥离嵌套 frontmatter", async () => {
  const workspacePath = await createWorkspace();
  const repoRoot = await createWorkspace();
  const skillRoot = path.join(repoRoot, "skills", "tooling");
  await fs.mkdir(path.join(skillRoot, "nested"), { recursive: true });
  await fs.writeFile(path.join(skillRoot, "SKILL.md"), "root", "utf8");
  await fs.writeFile(path.join(skillRoot, "nested", "SKILL.md"), "---\r\nname: helper\r\n---\r\nline", "utf8");

  const result = await runSkillTool({ workspacePath, repoRoot, skillId: "builtin/tooling", filePath: "nested/SKILL.md" });

  assert.equal(result.filePath, "nested/SKILL.md");
  assert.deepEqual(Object.keys(result).sort(), ["content", "filePath", "skillId", "truncated"]);
  assert.equal(result.content, "---\nname: helper\n---\nline");
  assert.equal(result.truncated, false);
});

test("skill V2 列表中的平级、嵌套与 Unicode 路径均可按原字符串回读", async () => {
  const workspacePath = await createWorkspace();
  const repoRoot = await createWorkspace();
  const skillRoot = path.join(repoRoot, "skills", "roundtrip");
  const expected = new Map([
    ["plain.txt", "plain"],
    ["nested/guide.md", "nested"],
    ["unicode/real-�.txt", "replacement is valid"]
  ]);
  await fs.mkdir(path.join(skillRoot, "nested"), { recursive: true });
  await fs.mkdir(path.join(skillRoot, "unicode"), { recursive: true });
  await fs.writeFile(path.join(skillRoot, "SKILL.md"), "root", "utf8");
  for (const [relativePath, content] of expected) {
    await fs.writeFile(path.join(skillRoot, ...relativePath.split("/")), content, "utf8");
  }

  const root = await runSkillTool({ workspacePath, repoRoot, skillId: "builtin/roundtrip" });
  const listed = root.content.match(/```text\n([\s\S]*?)\n```/)?.[1]?.split("\n") || [];
  assert.deepEqual(listed, [...expected.keys()].sort());
  for (const [relativePath, content] of expected) {
    const file = await runSkillTool({ workspacePath, repoRoot, skillId: "builtin/roundtrip", filePath: relativePath });
    assert.equal(file.content, content, `listed path ${relativePath} must round-trip`);
  }
});

test("skill V2 指定辅助文件将 CRLF 和孤立 CR 规范为 LF，并去除 BOM", async () => {
  const workspacePath = await createWorkspace();
  const repoRoot = await createWorkspace();
  const skillRoot = path.join(repoRoot, "skills", "normalized");
  await fs.mkdir(skillRoot, { recursive: true });
  await fs.writeFile(path.join(skillRoot, "SKILL.md"), "root", "utf8");
  await fs.writeFile(path.join(skillRoot, "normalized.txt"), Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from("alpha\r\nbeta\rgamma\n", "utf8")
  ]));

  const result = await runSkillTool({ workspacePath, repoRoot, skillId: "builtin/normalized", filePath: "normalized.txt" });
  assert.equal(result.content, "alpha\nbeta\ngamma");
  assert.equal(result.content.includes("\ufeff"), false);
});

test("skill V2 接受且只接受根读取 filePath 特例", async () => {
  const workspacePath = await createWorkspace();
  const repoRoot = await createWorkspace();
  const skillRoot = path.join(repoRoot, "skills", "tooling");
  await fs.mkdir(skillRoot, { recursive: true });
  await fs.writeFile(path.join(skillRoot, "SKILL.md"), "root", "utf8");

  for (const skillPath of [undefined, "", " \t", "SKILL.md"]) {
    const result = await runSkillTool({ workspacePath, repoRoot, skillId: "builtin/tooling", ...(skillPath === undefined ? {} : { filePath: skillPath }) });
    assert.equal(result.filePath, "SKILL.md");
  }
  for (const skillPath of [" SKILL.md", "SKILL.md ", "./SKILL.md", "\n", "\u00a0"]) {
    await assert.rejects(
      () => runSkillTool({ workspacePath, repoRoot, skillId: "builtin/tooling", filePath: skillPath }),
      { message: "invalid skill path" }
    );
  }
});

test("skill V2 production 入口不兼容旧 payload 字段", async () => {
  const workspacePath = await createWorkspace();
  const repoRoot = await createWorkspace();
  await assert.rejects(
    () => runSkillTool({ workspacePath, repoRoot, skill: "builtin/tooling" } as unknown as Parameters<typeof runSkillTool>[0]),
    { message: "skill is required" }
  );
});

test("skill V2 使用固定 identifier 和 path 错误合同", async () => {
  const workspacePath = await createWorkspace();
  const repoRoot = await createWorkspace();
  const skillRoot = path.join(repoRoot, "skills", "tooling");
  await fs.mkdir(path.join(skillRoot, "dir"), { recursive: true });
  await fs.writeFile(path.join(skillRoot, "SKILL.md"), "root", "utf8");
  await fs.writeFile(path.join(skillRoot, "binary.bin"), Buffer.from([0, 1, 2]));
  await fs.mkdir(path.join(repoRoot, "skills", "missing-root"), { recursive: true });
  await fs.mkdir(path.join(repoRoot, "skills", "nul-root"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "skills", "nul-root", "SKILL.md"), Buffer.from([0x61, 0x00]));

  await assert.rejects(() => runSkillTool({ workspacePath, repoRoot, skillId: "" }), { message: "skill is required" });
  await assert.rejects(() => runSkillTool({ workspacePath, repoRoot, skillId: "builtin/tooling/extra" }), { message: "invalid skill identifier" });
  await assert.rejects(() => runSkillTool({ workspacePath, repoRoot, skillId: "builtin/missing" }), { message: "skill not found" });
  await assert.rejects(() => runSkillTool({ workspacePath, repoRoot, skillId: "builtin/missing-root" }), { message: "skill root is not readable" });
  await assert.rejects(() => runSkillTool({ workspacePath, repoRoot, skillId: "builtin/nul-root" }), { message: "skill root is not readable" });
  await assert.rejects(() => runSkillTool({ workspacePath, repoRoot, skillId: "builtin/tooling", filePath: "dir" }), { message: "skill path must reference a file" });
  await assert.rejects(() => runSkillTool({ workspacePath, repoRoot, skillId: "builtin/tooling", filePath: "missing.txt" }), { message: "skill file not found" });
  await assert.rejects(() => runSkillTool({ workspacePath, repoRoot, skillId: "builtin/tooling", filePath: "binary.bin" }), { message: "binary file is not supported" });
});

test("skill V2 根正文和文件列表均遵守容量与排序", async () => {
  const workspacePath = await createWorkspace();
  const repoRoot = await createWorkspace();
  const skillRoot = path.join(repoRoot, "skills", "tooling");
  await fs.mkdir(skillRoot, { recursive: true });
  await fs.writeFile(path.join(skillRoot, "SKILL.md"), "😀".repeat(30_000), "utf8");
  await Promise.all(["z.txt", "A.txt", ".notes.md"].map((name) => fs.writeFile(path.join(skillRoot, name), "text", "utf8")));

  const result = await runSkillTool({ workspacePath, repoRoot, skillId: "builtin/tooling" });

  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.content, "utf8") <= 50 * 1024);
  assert.equal((result.content.match(/Root skill content truncated\./g) || []).length, 1);
  assert.ok(result.content.indexOf(".notes.md") < result.content.indexOf("A.txt"));
  assert.ok(result.content.indexOf("A.txt") < result.content.indexOf("z.txt"));
});

test("skill V2 支持 workspace 和 repo external roots", async () => {
  const workspacePath = await createWorkspace();
  const repoRoot = await createWorkspace();
  const workspaceSkills = path.join(workspacePath, "workspace-skills");
  const repoSkills = path.join(workspacePath, "repo-skills");
  await fs.mkdir(path.join(workspaceSkills, "deploy"), { recursive: true });
  await fs.mkdir(path.join(repoSkills, "review"), { recursive: true });
  await fs.writeFile(path.join(workspaceSkills, "deploy", "SKILL.md"), "workspace root", "utf8");
  await fs.writeFile(path.join(repoSkills, "review", "SKILL.md"), "repo root", "utf8");
  const externalSkillRoots = [
    { sourceType: "workspace" as const, rootDir: "workspace-skills", rootPath: workspaceSkills },
    { sourceType: "repo" as const, repoId: "repo_a", rootDir: "repo-skills", rootPath: repoSkills }
  ];

  assert.equal((await runSkillTool({ workspacePath, repoRoot, skillId: "workspace/workspace-skills/deploy", externalSkillRoots })).content.startsWith("workspace root"), true);
  assert.equal((await runSkillTool({ workspacePath, repoRoot, skillId: "repo/repo_a/repo-skills/review", externalSkillRoots })).content.startsWith("repo root"), true);
});

test("skill V2 排除 symlink 文件并拒绝其直接读取", async () => {
  const workspacePath = await createWorkspace();
  const repoRoot = await createWorkspace();
  const skillRoot = path.join(repoRoot, "skills", "tooling");
  const outside = path.join(repoRoot, "outside.txt");
  await fs.mkdir(skillRoot, { recursive: true });
  await fs.writeFile(path.join(skillRoot, "SKILL.md"), "root", "utf8");
  await fs.writeFile(outside, "outside", "utf8");
  await fs.symlink(outside, path.join(skillRoot, "link.txt"));

  const root = await runSkillTool({ workspacePath, repoRoot, skillId: "builtin/tooling" });
  assert.equal(root.content.includes("link.txt"), false);
  await assert.rejects(
    () => runSkillTool({ workspacePath, repoRoot, skillId: "builtin/tooling", filePath: "link.txt" }),
    { message: "skill path is not a readable file" }
  );
});

test("skill V2 标记辅助文件长行截断和 500 项文件列表截断", async () => {
  const workspacePath = await createWorkspace();
  const repoRoot = await createWorkspace();
  const skillRoot = path.join(repoRoot, "skills", "tooling");
  await fs.mkdir(skillRoot, { recursive: true });
  await fs.writeFile(path.join(skillRoot, "SKILL.md"), "root", "utf8");
  await fs.writeFile(path.join(skillRoot, "long.txt"), "x".repeat(3000), "utf8");
  await Promise.all(Array.from({ length: 501 }, (_, index) => fs.writeFile(path.join(skillRoot, `file-${String(index).padStart(3, "0")}.txt`), "text", "utf8")));

  const long = await runSkillTool({ workspacePath, repoRoot, skillId: "builtin/tooling", filePath: "long.txt" });
  assert.equal(long.truncated, true);
  assert.match(long.content, /line truncated to 2000 chars/);

  const root = await runSkillTool({ workspacePath, repoRoot, skillId: "builtin/tooling" });
  assert.equal(root.truncated, true);
  assert.match(root.content, /file-000\.txt/);
  assert.equal(root.content.includes("file-500.txt"), false);
  assert.match(root.content, /Skill file list truncated; additional files may be accessed if their paths are known\./);
});

test("skill V2 后代枚举失败时跳过故障项、继续兄弟项且不泄露路径", async () => {
  const workspacePath = await createWorkspace();
  const repoRoot = await createWorkspace();
  const skillRoot = path.join(repoRoot, "skills", "enumeration");
  await fs.mkdir(path.join(skillRoot, "gone"), { recursive: true });
  await fs.writeFile(path.join(skillRoot, "SKILL.md"), "root", "utf8");
  await fs.writeFile(path.join(skillRoot, "gone", "hidden.txt"), "hidden", "utf8");
  await fs.writeFile(path.join(skillRoot, "sibling.txt"), "visible", "utf8");
  const diagnostics: Array<{ source: string; reason: string }> = [];

  const root = await __testing.runSkillTool({ workspacePath, repoRoot, skillId: "builtin/enumeration" }, {
    async beforeEnumeratingSkillEntry({ relativePath, kind }) {
      if (relativePath === "gone" && kind === "directory") {
        await fs.rm(path.join(skillRoot, "gone"), { recursive: true, force: true });
      }
    },
    onSkillDiagnostic: (diagnostic) => { diagnostics.push(diagnostic); }
  });

  assert.match(root.content, /sibling\.txt/);
  assert.equal(root.content.includes("gone"), false);
  assert.equal(root.content.includes(skillRoot), false);
  assert.ok(diagnostics.some((diagnostic) => diagnostic.reason === "unreadable_directory"));
  assert.equal(JSON.stringify(diagnostics).includes(skillRoot), false);
});

test("skill V2 后代文件在枚举后消失时跳过该文件、继续兄弟项且不泄露路径", async () => {
  const workspacePath = await createWorkspace();
  const repoRoot = await createWorkspace();
  const skillRoot = path.join(repoRoot, "skills", "enumeration-file");
  await fs.mkdir(skillRoot, { recursive: true });
  await fs.writeFile(path.join(skillRoot, "SKILL.md"), "root", "utf8");
  await fs.writeFile(path.join(skillRoot, "gone.txt"), "hidden", "utf8");
  await fs.writeFile(path.join(skillRoot, "sibling.txt"), "visible", "utf8");
  const diagnostics: Array<{ source: string; reason: string }> = [];

  const root = await __testing.runSkillTool({ workspacePath, repoRoot, skillId: "builtin/enumeration-file" }, {
    async beforeEnumeratingSkillEntry({ relativePath, kind }) {
      if (relativePath === "gone.txt" && kind === "file") await fs.rm(path.join(skillRoot, "gone.txt"));
    },
    onSkillDiagnostic: (diagnostic) => { diagnostics.push(diagnostic); }
  });

  assert.match(root.content, /sibling\.txt/);
  assert.equal(root.content.includes("gone.txt"), false);
  assert.equal(root.content.includes(skillRoot), false);
  assert.ok(diagnostics.some((diagnostic) => diagnostic.reason === "unreadable_file"));
  assert.equal(JSON.stringify(diagnostics).includes(skillRoot), false);
});

test("skill V2 非法 callable identifier 无法命中 Worker mapping", async () => {
  const workspacePath = await createWorkspace();
  const repoRoot = await createWorkspace();
  const skillsRoot = path.join(repoRoot, "skills");
  await fs.mkdir(path.join(skillsRoot, " invalid"), { recursive: true });
  await fs.writeFile(path.join(skillsRoot, " invalid", "SKILL.md"), "root", "utf8");

  await assert.rejects(
    () => runSkillTool({ workspacePath, repoRoot, skillId: "builtin/ invalid" }),
    { message: "invalid skill identifier" }
  );
});

test("skill V2 根读取通过同一安全 fd 拒绝根文件替换竞态", async () => {
  const workspacePath = await createWorkspace();
  const repoRoot = await createWorkspace();
  const skillRoot = path.join(repoRoot, "skills", "tooling");
  await fs.mkdir(skillRoot, { recursive: true });
  await fs.writeFile(path.join(skillRoot, "SKILL.md"), "safe root", "utf8");

  await assert.rejects(
    () => __testing.runSkillTool({ workspacePath, repoRoot, skillId: "builtin/tooling" }, {
      async beforeOpenRootSkillFile({ rootSkillPath }) {
        await fs.rename(rootSkillPath, `${rootSkillPath}.old`);
        await fs.writeFile(rootSkillPath, "replaced root", "utf8");
      }
    }),
    { message: "skill root is not readable" }
  );
});

test("skill V2 根目录在打开前删除时精确返回 skill not found", async () => {
  const workspacePath = await createWorkspace();
  const repoRoot = await createWorkspace();
  const skillRoot = path.join(repoRoot, "skills", "tooling");
  await fs.mkdir(skillRoot, { recursive: true });
  await fs.writeFile(path.join(skillRoot, "SKILL.md"), "safe root", "utf8");

  await assert.rejects(
    () => __testing.runSkillTool({ workspacePath, repoRoot, skillId: "builtin/tooling" }, {
      beforeOpenRootSkillFile: () => fs.rm(skillRoot, { recursive: true, force: true })
    }),
    { message: "skill not found" }
  );
});

test("skill V2 根目录在打开后删除时精确返回 skill not found", async () => {
  const workspacePath = await createWorkspace();
  const repoRoot = await createWorkspace();
  const skillRoot = path.join(repoRoot, "skills", "tooling");
  await fs.mkdir(skillRoot, { recursive: true });
  await fs.writeFile(path.join(skillRoot, "SKILL.md"), "safe root", "utf8");

  await assert.rejects(
    () => __testing.runSkillTool({ workspacePath, repoRoot, skillId: "builtin/tooling" }, {
      beforeFinalRootSkillFileRevalidation: () => fs.rm(skillRoot, { recursive: true, force: true })
    }),
    { message: "skill not found" }
  );
});

test("skill V2 根文件在打开后、最终重检前删除时返回 skill root is not readable", async () => {
  const workspacePath = await createWorkspace();
  const repoRoot = await createWorkspace();
  const skillRoot = path.join(repoRoot, "skills", "tooling");
  const rootSkillPath = path.join(skillRoot, "SKILL.md");
  await fs.mkdir(skillRoot, { recursive: true });
  await fs.writeFile(rootSkillPath, "safe root", "utf8");

  await assert.rejects(
    () => __testing.runSkillTool({ workspacePath, repoRoot, skillId: "builtin/tooling" }, {
      beforeFinalRootSkillFileRevalidation: () => fs.rm(rootSkillPath)
    }),
    (err: unknown) => {
      assert.equal(err instanceof Error ? err.message : String(err), "skill root is not readable");
      assert.equal(err instanceof Error ? err.message.includes(skillRoot) : false, false);
      return true;
    }
  );
});

test("skill V2 根文件在打开后、最终重检前替换或变为 symlink 时返回 skill root is not readable", async () => {
  for (const mutation of ["replace", "symlink"] as const) {
    const workspacePath = await createWorkspace();
    const repoRoot = await createWorkspace();
    const skillRoot = path.join(repoRoot, "skills", `tooling-${mutation}`);
    const rootSkillPath = path.join(skillRoot, "SKILL.md");
    const outsidePath = path.join(repoRoot, `${mutation}-outside.md`);
    await fs.mkdir(skillRoot, { recursive: true });
    await fs.writeFile(rootSkillPath, "safe root", "utf8");
    await fs.writeFile(outsidePath, "outside", "utf8");

    await assert.rejects(
      () => __testing.runSkillTool({ workspacePath, repoRoot, skillId: `builtin/tooling-${mutation}` }, {
        async beforeFinalRootSkillFileRevalidation() {
          await fs.rename(rootSkillPath, `${rootSkillPath}.old`);
          if (mutation === "replace") {
            await fs.writeFile(rootSkillPath, "replacement", "utf8");
          } else {
            await fs.symlink(outsidePath, rootSkillPath);
          }
        }
      }),
      (err: unknown) => {
        assert.equal(err instanceof Error ? err.message : String(err), "skill root is not readable");
        assert.equal(err instanceof Error ? err.message.includes(skillRoot) : false, false);
        return true;
      }
    );
  }
});

test("skill V2 根目录在初始 lstat 后 realpath 前、以及 root lstat/open 前消失时返回 skill not found", async () => {
  for (const phase of ["initial", "before-root-lstat"] as const) {
    const workspacePath = await createWorkspace();
    const repoRoot = await createWorkspace();
    const skillRoot = path.join(repoRoot, "skills", `race-${phase}`);
    await fs.mkdir(skillRoot, { recursive: true });
    await fs.writeFile(path.join(skillRoot, "SKILL.md"), "safe root", "utf8");

    await assert.rejects(
      () => __testing.runSkillTool({ workspacePath, repoRoot, skillId: `builtin/race-${phase}` }, phase === "initial"
        ? { afterInitialRootDirectoryLstat: () => fs.rm(skillRoot, { recursive: true, force: true }) }
        : { afterRootDirectoryRevalidationBeforeRootFileLstat: () => fs.rm(skillRoot, { recursive: true, force: true }) }),
      { message: "skill not found" }
    );
  }
});

test("skill V2 根目录在 root open 后、after-lstat 前消失时返回 skill not found", async () => {
  const workspacePath = await createWorkspace();
  const repoRoot = await createWorkspace();
  const skillRoot = path.join(repoRoot, "skills", "after-open-race");
  await fs.mkdir(skillRoot, { recursive: true });
  await fs.writeFile(path.join(skillRoot, "SKILL.md"), "safe root", "utf8");

  await assert.rejects(
    () => __testing.runSkillTool({ workspacePath, repoRoot, skillId: "builtin/after-open-race" }, {
      afterOpenRootSkillFileBeforeAfterLstat: () => fs.rm(skillRoot, { recursive: true, force: true })
    }),
    { message: "skill not found" }
  );
});

test("skill V2 用 post-open fd size 分类，不信任打开前 size", async () => {
  const workspacePath = await createWorkspace();
  const repoRoot = await createWorkspace();
  const skillRoot = path.join(repoRoot, "skills", "tooling");
  await fs.mkdir(skillRoot, { recursive: true });
  await fs.writeFile(path.join(skillRoot, "SKILL.md"), "root", "utf8");
  await fs.writeFile(path.join(skillRoot, "mutable.txt"), "x", "utf8");

  const result = await __testing.runSkillTool({
    workspacePath,
    repoRoot,
    skillId: "builtin/tooling",
    filePath: "mutable.txt"
  }, {
    async afterOpenSkillFileBeforeStat({ targetPath }) {
      await fs.truncate(targetPath, 0);
      await fs.writeFile(targetPath, "updated via same inode", "utf8");
    }
  });

  assert.equal(result.content, "updated via same inode");
  assert.equal(result.truncated, false);
});

test("skill V2 根读取不设 source cap，能在 1 MiB 后剥离 frontmatter", async () => {
  const workspacePath = await createWorkspace();
  const repoRoot = await createWorkspace();
  const skillRoot = path.join(repoRoot, "skills", "late-frontmatter");
  await fs.mkdir(skillRoot, { recursive: true });
  const padding = "comment: x\n".repeat(110_000);
  await fs.writeFile(path.join(skillRoot, "SKILL.md"), `---\n${padding}name: Late\n---\nbody after late boundary`, "utf8");

  const result = await runSkillTool({ workspacePath, repoRoot, skillId: "builtin/late-frontmatter" });

  assert.equal(result.content.startsWith("body after late boundary"), true);
  assert.equal(result.content.includes("comment: x"), false);
  assert.equal(result.truncated, false);
});

test("skill V2 在 section 预算无法容纳首条路径时使用零前缀", async () => {
  const result = __testing.buildSkillFilesSection({
    body: "",
    paths: ["a".repeat(10_300)],
    candidateCount: 1
  });

  assert.equal(result.content, "## Skill files\n\nSkill file list truncated; additional files may be accessed if their paths are known.");
  assert.equal(result.truncated, true);
});

test("skill V2 final 50KiB 防御分支只缩减 section 并保持有效输出", async () => {
  const workspacePath = await createWorkspace();
  const repoRoot = await createWorkspace();
  const skillRoot = path.join(repoRoot, "skills", "fallback");
  const body = "b".repeat(39 * 1024);
  const paths = Array.from({ length: 500 }, (_, index) => `file-${String(index).padStart(3, "0")}-${"x".repeat(40)}.txt`);
  await fs.mkdir(skillRoot, { recursive: true });
  await fs.writeFile(path.join(skillRoot, "SKILL.md"), body, "utf8");
  await Promise.all(paths.map((filePath) => fs.writeFile(path.join(skillRoot, filePath), "text", "utf8")));

  const initialSection = __testing.buildSkillFilesSection({
    body,
    paths,
    candidateCount: paths.length,
    budget: 12 * 1024
  });
  let fallbackCount = 0;
  const result = await __testing.runSkillTool({
    workspacePath,
    repoRoot,
    skillId: "builtin/fallback"
  }, {
    rootFilesSectionBudgetOverride: 12 * 1024,
    onRootContentInvariantFallback: () => { fallbackCount += 1; }
  });
  const section = result.content.slice(body.length);
  const listedPaths = section.match(/```text\n([\s\S]*?)\n```/)?.[1]?.split("\n") || [];

  assert.equal(fallbackCount, 1, "test seam should prove the defensive branch ran");
  assert.equal(result.content.slice(0, body.length), body, "fallback must preserve root body byte-for-byte");
  assert.ok(Buffer.byteLength(section, "utf8") < Buffer.byteLength(initialSection.content, "utf8"), "fallback must reduce only the section");
  assert.ok(Buffer.byteLength(result.content, "utf8") <= 50 * 1024);
  assert.equal(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(result.content, "utf8")), result.content);
  assert.ok(section.includes("```text\n") && section.includes("\n```"), "section fence must be closed");
  assert.ok(listedPaths.length > 0 && listedPaths.every((filePath) => paths.includes(filePath)), "section must contain complete paths only");
  assert.equal(result.truncated, true);
});

test("skill V2 501 bounded selection 独立于创建顺序并返回固定排序前缀", async () => {
  const workspacePath = await createWorkspace();
  const repoRoot = await createWorkspace();
  const skillRoot = path.join(repoRoot, "skills", "ordered");
  await fs.mkdir(skillRoot, { recursive: true });
  await fs.writeFile(path.join(skillRoot, "SKILL.md"), "root", "utf8");
  const names = Array.from({ length: 520 }, (_, index) => `file-${String(index).padStart(3, "0")}.txt`).reverse();
  for (const name of names) await fs.writeFile(path.join(skillRoot, name), "text", "utf8");

  const result = await runSkillTool({ workspacePath, repoRoot, skillId: "builtin/ordered" });
  const block = result.content.match(/```text\n([\s\S]*?)\n```/)?.[1]?.split("\n") || [];

  assert.equal(block.length, 500);
  assert.deepEqual(block, Array.from({ length: 500 }, (_, index) => `file-${String(index).padStart(3, "0")}.txt`));
  assert.equal(result.truncated, true);
});

test("skill V2 拒绝 identifier/path 中的格式和分隔字符", async () => {
  const workspacePath = await createWorkspace();
  const repoRoot = await createWorkspace();
  const skillRoot = path.join(repoRoot, "skills", "tooling");
  await fs.mkdir(skillRoot, { recursive: true });
  await fs.writeFile(path.join(skillRoot, "SKILL.md"), "root", "utf8");
  await fs.writeFile(path.join(skillRoot, "plain.txt"), "text", "utf8");

  for (const skillId of ["builtin/tool`ing", `builtin/tool${String.fromCodePoint(0x200b)}ing`, `builtin/tool${String.fromCodePoint(0x2028)}ing`, `builtin/${String.fromCharCode(0xd800)}`]) {
    await assert.rejects(() => runSkillTool({ workspacePath, repoRoot, skillId }), { message: "invalid skill identifier" });
  }
  for (const skillPath of ["plain`.txt", `plain${String.fromCodePoint(0x200b)}.txt`, `plain${String.fromCodePoint(0x2028)}.txt`, `${String.fromCharCode(0xd800)}.txt`]) {
    await assert.rejects(
      () => runSkillTool({ workspacePath, repoRoot, skillId: "builtin/tooling", filePath: skillPath }),
      { message: "invalid skill path" }
    );
  }
});

test("skill V2 POSIX 枚举跳过非 UTF-8 名称，但保留真实 U+FFFD 名称", { skip: process.platform === "win32" ? "POSIX buffer filename enumeration only" : false }, async () => {
  const workspacePath = await createWorkspace();
  const repoRoot = await createWorkspace();
  const skillRoot = path.join(repoRoot, "skills", "filenames");
  await fs.mkdir(skillRoot, { recursive: true });
  await fs.writeFile(path.join(skillRoot, "SKILL.md"), "root", "utf8");
  await fs.writeFile(path.join(skillRoot, "real-�.txt"), "replacement is valid", "utf8");
  const invalidName = Buffer.from([0x69, 0x6e, 0x76, 0x61, 0x6c, 0x69, 0x64, 0x2d, 0xff, 0x2e, 0x74, 0x78, 0x74]);
  fsSync.writeFileSync(Buffer.concat([Buffer.from(`${skillRoot}${path.sep}`), invalidName]), "bad");
  const diagnostics: Array<{ source: string; reason: string }> = [];

  const root = await __testing.runSkillTool({ workspacePath, repoRoot, skillId: "builtin/filenames" }, {
    onSkillDiagnostic: (diagnostic) => { diagnostics.push(diagnostic); }
  });
  assert.match(root.content, /real-�\.txt/);
  assert.equal(root.content.includes("invalid-�.txt"), false);
  assert.ok(diagnostics.some((diagnostic) => diagnostic.reason === "non_utf8_filename"));
  const serializedDiagnostics = JSON.stringify(diagnostics);
  assert.equal(serializedDiagnostics.includes(skillRoot), false);
  assert.equal(serializedDiagnostics.includes(invalidName.toString("hex")), false);
  assert.equal(serializedDiagnostics.includes("invalid-�.txt"), false);
  const file = await runSkillTool({ workspacePath, repoRoot, skillId: "builtin/filenames", filePath: "real-�.txt" });
  assert.equal(file.content, "replacement is valid");
});
