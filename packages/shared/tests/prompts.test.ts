import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { getPromptText, renderPromptTemplate, renderPromptTemplateFile, resetPromptTextCacheForTests } from "../src/prompts.js";

test("getPromptText 可读取内置 prompts 文件", () => {
  const text = getPromptText("agent/language-instruction.en-US.txt");
  assert.ok(text.includes("Language requirement: use English consistently for this run."));
});

test("renderPromptTemplateFile 可替换模板占位符", () => {
  const text = renderPromptTemplateFile("agent/clear-summary-with-reason.en-US.tmpl.txt", {
    reason: "switch-task"
  });
  assert.equal(
    text,
    "A new task has started (switch-task). Previous context has been archived; use archive_search or archive_read if you need to recall earlier decisions."
  );
});

test("关键 locale 与模板替换行为正确（zh-CN）", () => {
  const zh = getPromptText("agent/language-instruction.zh-CN.txt");
  assert.ok(zh.includes("语言要求：本轮对话请统一使用简体中文。"));
  const snippet = renderPromptTemplateFile("agent/compaction-snippet-message.zh-CN.tmpl.txt", { body: "L1", minPos: 123 });
  assert.ok(snippet.includes("L1"));
  assert.ok(snippet.includes("beforePos=123"));
});

test("renderPromptTemplate 变量值包含 {{}} 时按字面量保留", () => {
  const text = renderPromptTemplate("prefix {{x}} suffix", { x: "a {{b}} c" });
  assert.equal(text, "prefix a {{b}} c suffix");
});

test("renderPromptTemplate 缺失变量时抛错", () => {
  assert.throws(() => renderPromptTemplate("hello {{name}}", {}), /missing template variable: name/);
});

test("AWB_PROMPTS_DIR 设置后优先使用该目录", async () => {
  const tmpDir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-prompts-"));
  const promptsRoot = path.join(tmpDir, "prompts");
  await fs.mkdir(path.join(promptsRoot, "agent"), { recursive: true });
  await fs.writeFile(path.join(promptsRoot, "agent", "language-instruction.en-US.txt"), "ENV-OVERRIDE", "utf8");

  const previous = process.env.AWB_PROMPTS_DIR;
  process.env.AWB_PROMPTS_DIR = promptsRoot;
  resetPromptTextCacheForTests();
  try {
    const text = getPromptText("agent/language-instruction.en-US.txt");
    assert.equal(text, "ENV-OVERRIDE");
  } finally {
    if (previous == null) delete process.env.AWB_PROMPTS_DIR;
    else process.env.AWB_PROMPTS_DIR = previous;
    resetPromptTextCacheForTests();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("AWB_PROMPTS_DIR 设置为无效路径时直接报错，不回退", () => {
  const previous = process.env.AWB_PROMPTS_DIR;
  process.env.AWB_PROMPTS_DIR = "./not-exists-prompts-dir";
  resetPromptTextCacheForTests();
  try {
    assert.throws(() => getPromptText("agent/language-instruction.en-US.txt"), /AWB_PROMPTS_DIR is set but invalid/);
  } finally {
    if (previous == null) delete process.env.AWB_PROMPTS_DIR;
    else process.env.AWB_PROMPTS_DIR = previous;
    resetPromptTextCacheForTests();
  }
});

test("缺失文件与空文件会抛出可诊断错误", async () => {
  const tmpDir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-prompts-"));
  const promptsRoot = path.join(tmpDir, "prompts");
  await fs.mkdir(path.join(promptsRoot, "agent"), { recursive: true });
  await fs.writeFile(path.join(promptsRoot, "agent", "empty.txt"), "\n\n", "utf8");

  const previous = process.env.AWB_PROMPTS_DIR;
  process.env.AWB_PROMPTS_DIR = promptsRoot;
  resetPromptTextCacheForTests();
  try {
    assert.throws(() => getPromptText("agent/missing.txt"), /failed to read prompt file/);
    assert.throws(() => getPromptText("agent/empty.txt"), /prompt file is empty/);
  } finally {
    if (previous == null) delete process.env.AWB_PROMPTS_DIR;
    else process.env.AWB_PROMPTS_DIR = previous;
    resetPromptTextCacheForTests();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
