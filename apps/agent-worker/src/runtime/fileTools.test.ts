import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { runReadTool, runSkillTool, runWriteTool } from "./fileTools.js";

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

  const result = await runReadTool({ workspacePath, filePath: "small.txt", offset: 5, limit: 20 });

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

  const result = await runReadTool({ workspacePath, filePath: "nested", offset: 1, limit: 2 });

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

  const result = await runReadTool({ workspacePath, filePath: "nested", offset: 5, limit: 20 });

  assert.equal(result.summary, "读取目录 nested");
  assert.equal(result.content, "(End of directory - total 2 entries. Requested offset=5 exceeds directory length. No more entries to read. Do not call read again for this directory unless the directory contents change.)");
});

test("skill 读取 skill 节点时返回正文与 children（文件 + 直接子 skill）", async () => {
  const workspacePath = await createWorkspace();
  const repoRoot = await createWorkspace();
  await fs.mkdir(path.join(repoRoot, "skills", "tooling", "child"), { recursive: true });
  await fs.writeFile(
    path.join(repoRoot, "skills", "tooling", "SKILL.md"),
    "---\nname: Tooling\ndescription: Tooling desc\n---\n\nTooling body",
    "utf8"
  );
  await fs.writeFile(path.join(repoRoot, "skills", "tooling", "notes.txt"), "hello", "utf8");
  await fs.writeFile(
    path.join(repoRoot, "skills", "tooling", "child", "SKILL.md"),
    "---\nname: Child\ndescription: Child desc\n---\n\nchild body",
    "utf8"
  );

  const result = await runSkillTool({ workspacePath, repoRoot, id: "builtin/tooling" });

  assert.equal(result.type, "skill");
  assert.equal(result.id, "builtin/tooling");
  assert.equal(result.name, "Tooling");
  assert.equal(result.description, "Tooling desc");
  assert.equal(result.content.includes("Tooling body"), true);
  assert.deepEqual(
    result.children.map((item) => ({ id: item.id, type: item.type, name: item.name })),
    [
      { id: "builtin/tooling/child", type: "skill", name: "Child" },
      { id: "builtin/tooling/notes.txt", type: "file", name: "notes.txt" }
    ]
  );
});

test("skill 读取文件 id 时仅返回文件内容", async () => {
  const workspacePath = await createWorkspace();
  const repoRoot = await createWorkspace();
  await fs.mkdir(path.join(workspacePath, ".awb", "skills", "deploy"), { recursive: true });
  await fs.writeFile(path.join(workspacePath, ".awb", "skills", "deploy", "SKILL.md"), "Deploy skill", "utf8");
  await fs.writeFile(path.join(workspacePath, ".awb", "skills", "deploy", "template.yaml"), "kind: Pod", "utf8");

  const result = await runSkillTool({ workspacePath, repoRoot, id: "ws/deploy/template.yaml" });

  assert.equal(result.type, "file");
  assert.equal(result.id, "ws/deploy/template.yaml");
  assert.equal(result.content, "kind: Pod");
  assert.equal(Object.prototype.hasOwnProperty.call(result, "children"), false);
});

test("skill 在目标不存在时返回脱敏错误，且不泄露绝对路径", async () => {
  const workspacePath = await createWorkspace();
  const repoRoot = await createWorkspace();
  await fs.mkdir(path.join(repoRoot, "skills"), { recursive: true });

  let message = "";
  try {
    await runSkillTool({ workspacePath, repoRoot, id: "builtin/not-exists" });
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }

  assert.equal(message, "skill target not found");
  assert.equal(message.includes(repoRoot), false);
  assert.equal(message.includes(workspacePath), false);
  assert.equal(message.includes("/"), false);
});

test("skill 对非法 id 仍返回明确校验错误", async () => {
  const workspacePath = await createWorkspace();
  const repoRoot = await createWorkspace();

  await assert.rejects(
    () => runSkillTool({ workspacePath, repoRoot, id: "bad-id" }),
    /skill.id must start with builtin\/ or ws\//
  );
});
