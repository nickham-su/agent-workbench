import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { applyPatchUiArtifactPath, writeUiArtifactPath } from "../../../infra/fs/paths.js";
import { newSortableId } from "../../../utils/ids.js";
import { createP4Fixture } from "./p4-fixture.helpers.js";
import { completeToolExecutionFixture, createAssistantFixture, createMessageRunFixture, createSession } from "./context-writeback.helpers.js";

type Fixture = Awaited<ReturnType<typeof createP4Fixture>>;

function createTool(fixture: Fixture, sessionId: string, toolName: "apply_patch" | "write", input: Record<string, unknown>) {
  const run = createMessageRunFixture({ fixture, sessionId });
  const callPartId = newSortableId("part");
  const executionId = newSortableId("exec");
  const assistant = createAssistantFixture({ fixture, sessionId, runId: run.runId, parts: [{ id: callPartId, position: 0, type: "tool_call", toolName, input, providerToolCallId: newSortableId("call") }], executions: [{ id: executionId, callPartId, originSessionId: sessionId, originRunId: run.runId, status: "queued" }] });
  return { ...run, ...assistant, executionId };
}
async function artifact(fixture: Fixture, sessionId: string, toolExecutionId: string, kind: "apply-patch-artifact" | "write-artifact") {
  return fixture.app.inject({ method: "GET", url: `/api/agent/sessions/${sessionId}/tool-executions/${toolExecutionId}/${kind}?workspaceId=${encodeURIComponent(fixture.workspaceId)}` });
}
async function writeArtifact(fixture: Fixture, executionId: string, toolName: "apply_patch" | "write", content: Record<string, unknown>) {
  const file = (toolName === "apply_patch" ? applyPatchUiArtifactPath : writeUiArtifactPath)(fixture.dataDir, fixture.workspaceId, executionId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ ...content, toolExecutionId: executionId }), "utf8");
  return file;
}

test("artifact 以 ToolExecution 唯一寻址，同一 Message 的同名调用不会串读", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const run = createMessageRunFixture({ fixture, sessionId: session.id });
  const firstPart = newSortableId("part"); const secondPart = newSortableId("part");
  const firstExecution = newSortableId("exec"); const secondExecution = newSortableId("exec");
  createAssistantFixture({ fixture, sessionId: session.id, runId: run.runId, parts: [
    { id: firstPart, position: 0, type: "tool_call", toolName: "apply_patch", input: { patchText: "first" }, providerToolCallId: newSortableId("call") },
    { id: secondPart, position: 1, type: "tool_call", toolName: "apply_patch", input: { patchText: "second" }, providerToolCallId: newSortableId("call") },
  ], executions: [
    { id: firstExecution, callPartId: firstPart, originSessionId: session.id, originRunId: run.runId, status: "queued" },
    { id: secondExecution, callPartId: secondPart, originSessionId: session.id, originRunId: run.runId, status: "queued" },
  ] });
  completeToolExecutionFixture({ fixture, sessionId: session.id, runId: run.runId, toolExecutionId: firstExecution });
  completeToolExecutionFixture({ fixture, sessionId: session.id, runId: run.runId, toolExecutionId: secondExecution });
  await writeArtifact(fixture, firstExecution, "apply_patch", { marker: "first" });
  await writeArtifact(fixture, secondExecution, "apply_patch", { marker: "second" });
  assert.equal((await artifact(fixture, session.id, firstExecution, "apply-patch-artifact")).json().marker, "first");
  assert.equal((await artifact(fixture, session.id, secondExecution, "apply-patch-artifact")).json().marker, "second");
  assert.equal((await artifact(fixture, session.id, firstExecution, "write-artifact")).statusCode, 404);
  const other = await createSession(fixture.app, fixture.workspaceId);
  assert.equal((await artifact(fixture, other.id, firstExecution, "apply-patch-artifact")).statusCode, 404);
  const crossWorkspace = await fixture.app.inject({
    method: "GET",
    url: `/api/agent/sessions/${session.id}/tool-executions/${firstExecution}/apply-patch-artifact?workspaceId=other-workspace`,
  });
  assert.equal(crossWorkspace.statusCode, 404);
});

test("apply_patch artifact 文件缺失时返回 404", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 }); const session = await createSession(fixture.app, fixture.workspaceId);
  const tool = createTool(fixture, session.id, "apply_patch", { patchText: "x" }); completeToolExecutionFixture({ fixture, sessionId: session.id, runId: tool.runId, toolExecutionId: tool.executionId });
  assert.equal((await artifact(fixture, session.id, tool.executionId, "apply-patch-artifact")).statusCode, 404);
});

test("artifact Query 在 workspace artifact 目录为越界 symlink 时保持当前 400", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 }); const session = await createSession(fixture.app, fixture.workspaceId);
  const tool = createTool(fixture, session.id, "apply_patch", { patchText: "x" }); completeToolExecutionFixture({ fixture, sessionId: session.id, runId: tool.runId, toolExecutionId: tool.executionId });
  const file = applyPatchUiArtifactPath(fixture.dataDir, fixture.workspaceId, tool.executionId); const dir = path.dirname(file); const outside = path.join(fixture.dataDir, "outside"); await fs.mkdir(outside, { recursive: true }); await fs.mkdir(path.dirname(dir), { recursive: true }); await fs.rm(dir, { recursive: true, force: true }); await fs.symlink(outside, dir, "dir");
  assert.equal((await artifact(fixture, session.id, tool.executionId, "apply-patch-artifact")).statusCode, 400);
});

test("artifact 写入目录为越界 symlink 时仍以 slim result 完成 update", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 }); const session = await createSession(fixture.app, fixture.workspaceId);
  const tool = createTool(fixture, session.id, "write", { filePath: "a.txt", content: "body" }); completeToolExecutionFixture({ fixture, sessionId: session.id, runId: tool.runId, toolExecutionId: tool.executionId, resultPreview: "written" });
  assert.equal((await artifact(fixture, session.id, tool.executionId, "write-artifact")).statusCode, 404);
});

test("write completed 后保留完整 args、瘦身 result 并支持 artifact 拉取", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 }); const session = await createSession(fixture.app, fixture.workspaceId); const content = "完整内容";
  const tool = createTool(fixture, session.id, "write", { filePath: "a.txt", content }); completeToolExecutionFixture({ fixture, sessionId: session.id, runId: tool.runId, toolExecutionId: tool.executionId, resultPreview: "written" }); await writeArtifact(fixture, tool.executionId, "write", { after: { text: content } });
  const res = await artifact(fixture, session.id, tool.executionId, "write-artifact"); assert.equal(res.statusCode, 200); assert.equal(res.json().toolExecutionId, tool.executionId); assert.equal(res.json().after.text, content);
});

test("write artifact 文件缺失时返回 404", async (t: TestContext) => { const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 }); const session = await createSession(fixture.app, fixture.workspaceId); const tool = createTool(fixture, session.id, "write", { filePath: "x", content: "x" }); completeToolExecutionFixture({ fixture, sessionId: session.id, runId: tool.runId, toolExecutionId: tool.executionId }); assert.equal((await artifact(fixture, session.id, tool.executionId, "write-artifact")).statusCode, 404); });
test("write 在 cancel 终态会保留完整 args.content", async (t: TestContext) => { const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 }); const session = await createSession(fixture.app, fixture.workspaceId); const tool = createTool(fixture, session.id, "write", { filePath: "x", content: "cancel-content" }); completeToolExecutionFixture({ fixture, sessionId: session.id, runId: tool.runId, toolExecutionId: tool.executionId, status: "cancelled" }); await writeArtifact(fixture, tool.executionId, "write", { content: "cancel-content" }); const res = await artifact(fixture, session.id, tool.executionId, "write-artifact"); assert.equal(res.statusCode, 200); assert.equal(res.json().content, "cancel-content"); });
test("write 在 failed 终态会保留完整 args.content", async (t: TestContext) => { const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 }); const session = await createSession(fixture.app, fixture.workspaceId); const tool = createTool(fixture, session.id, "write", { filePath: "x", content: "failed-content" }); completeToolExecutionFixture({ fixture, sessionId: session.id, runId: tool.runId, toolExecutionId: tool.executionId, status: "failed", error: "failure" }); await writeArtifact(fixture, tool.executionId, "write", { content: "failed-content" }); const res = await artifact(fixture, session.id, tool.executionId, "write-artifact"); assert.equal(res.statusCode, 200); assert.equal(res.json().content, "failed-content"); });
test("agent tool 字符串结果保持原始字符串语义", async (t: TestContext) => { const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 }); const session = await createSession(fixture.app, fixture.workspaceId); const tool = createTool(fixture, session.id, "write", { filePath: "x", content: "x" }); completeToolExecutionFixture({ fixture, sessionId: session.id, runId: tool.runId, toolExecutionId: tool.executionId, resultPreview: "raw result" }); await writeArtifact(fixture, tool.executionId, "write", { result: "raw result" }); const res = await artifact(fixture, session.id, tool.executionId, "write-artifact"); assert.equal(res.json().result, "raw result"); });
test("agent 兼容部分迁移数据: 缺失 execution artifact 返回 404", async (t: TestContext) => { const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 }); const session = await createSession(fixture.app, fixture.workspaceId); const missing = await artifact(fixture, session.id, newSortableId("exec"), "write-artifact"); assert.equal(missing.statusCode, 404); });
test("agent 兼容早期拆分数据: 缺少 resultFormat 时保留结构化工具结果", async (t: TestContext) => { const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 }); const session = await createSession(fixture.app, fixture.workspaceId); const tool = createTool(fixture, session.id, "write", { filePath: "x", content: "x" }); completeToolExecutionFixture({ fixture, sessionId: session.id, runId: tool.runId, toolExecutionId: tool.executionId, structuredResult: { bytesWritten: 1 } }); await writeArtifact(fixture, tool.executionId, "write", { structuredResult: { bytesWritten: 1 } }); const res = await artifact(fixture, session.id, tool.executionId, "write-artifact"); assert.deepEqual(res.json().structuredResult, { bytesWritten: 1 }); });
