import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { AgentApiEndpoints } from "@agent-workbench/shared/internal-contracts/agent-api";
import { applyPatchUiArtifactPath, writeUiArtifactPath } from "../../../infra/fs/paths.js";
import { newSortableId } from "../../../utils/ids.js";
import { createAgentService } from "../agent.composition.js";
import { createP4Fixture } from "./p4-fixture.helpers.js";
import { completeToolExecutionFixture, createAssistantFixture, createMessageRunFixture, createSession } from "./context-writeback.helpers.js";
import { injectJson } from "../testkit/agent-testkit.js";

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

async function updateToolExecutionFromWorker(fixture: Fixture, payload: Record<string, unknown>) {
  return injectJson(fixture.app, {
    method: AgentApiEndpoints.updateToolExecution.method,
    url: AgentApiEndpoints.updateToolExecution.path,
    internalToken: fixture.internalToken,
    payload,
  });
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

test("Worker completed apply_patch 写回自动生成完整 artifact，并只保存 slim structured result", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const tool = createTool(fixture, session.id, "apply_patch", { patchText: "*** Update File: a.ts" });
  const startedAt = Date.now();
  const fullResult = {
    text: "Applied 1 patch.",
    summary: { fileCount: 1, additions: 1, deletions: 1 },
    files: [{ type: "update", path: "a.ts", additions: 1, deletions: 1, before: "const a = 1;", after: "const a = 2;" }],
  };

  const running = await updateToolExecutionFromWorker(fixture, {
    workspaceId: fixture.workspaceId, sessionId: session.id, runId: tool.runId, toolExecutionId: tool.executionId,
    status: "running", startedAt, updatedAt: startedAt,
  });
  assert.equal(running.statusCode, 200, running.body);
  const completed = await updateToolExecutionFromWorker(fixture, {
    workspaceId: fixture.workspaceId, sessionId: session.id, runId: tool.runId, toolExecutionId: tool.executionId,
    status: "completed", resultPreview: "Applied 1 patch.", structuredResult: fullResult,
    completedAt: startedAt + 1, updatedAt: startedAt + 1,
  });
  assert.equal(completed.statusCode, 200, completed.body);
  assert.equal(completed.json().result, "updated");

  const expectedSlim = {
    text: "Applied 1 patch.",
    summary: { fileCount: 1, additions: 1, deletions: 1 },
    files: [{ type: "update", path: "a.ts", additions: 1, deletions: 1 }],
  };
  const detail = await fixture.app.inject({ method: "GET", url: `/api/agent/sessions/${session.id}/tool-executions/${tool.executionId}?workspaceId=${encodeURIComponent(fixture.workspaceId)}` });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.deepEqual(detail.json().structuredResult, expectedSlim);
  const stored = fixture.db.prepare("select structured_result_json as value from agent_tool_execution where id = ?").get(tool.executionId) as { value: string };
  assert.deepEqual(JSON.parse(stored.value), expectedSlim);

  const artifactRes = await artifact(fixture, session.id, tool.executionId, "apply-patch-artifact");
  assert.equal(artifactRes.statusCode, 200, artifactRes.body);
  assert.deepEqual(artifactRes.json().files, fullResult.files);
});

test("artifact 先于最终 fence 写入，最终 ignored 时仅留下不可见孤儿", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const tool = createTool(fixture, session.id, "apply_patch", { patchText: "*** Update File: a.ts" });
  const startedAt = Date.now();
  assert.equal((await updateToolExecutionFromWorker(fixture, {
    workspaceId: fixture.workspaceId, sessionId: session.id, runId: tool.runId, toolExecutionId: tool.executionId,
    status: "running", startedAt, updatedAt: startedAt,
  })).statusCode, 200);
  const service = createAgentService(fixture.ctx, fixture.app.log, null, {
    beforeFinalToolExecutionUpdate: () => {
      fixture.db.prepare(
        "update session_run_state set status = 'idle', active_run_id = null where workspace_id = ? and session_id = ?",
      ).run(fixture.workspaceId, session.id);
    },
  });
  const result = await service.updateToolExecutionFromWorker({
    workspaceId: fixture.workspaceId, sessionId: session.id, runId: tool.runId, toolExecutionId: tool.executionId,
    status: "completed", structuredResult: { files: [{ path: "a.ts", before: "before", after: "after" }] },
    completedAt: startedAt + 1, updatedAt: startedAt + 1,
  });
  assert.deepEqual(result, { result: "ignored" });
  const file = applyPatchUiArtifactPath(fixture.dataDir, fixture.workspaceId, tool.executionId);
  await fs.access(file);
  assert.equal((await artifact(fixture, session.id, tool.executionId, "apply-patch-artifact")).statusCode, 404);
});

test("invalid apply_patch structuredResult 保持原样且不生成空 artifact", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const tool = createTool(fixture, session.id, "apply_patch", { patchText: "*** Update File: a.ts" });
  const startedAt = Date.now();
  assert.equal((await updateToolExecutionFromWorker(fixture, {
    workspaceId: fixture.workspaceId, sessionId: session.id, runId: tool.runId, toolExecutionId: tool.executionId,
    status: "running", startedAt, updatedAt: startedAt,
  })).statusCode, 200);
  const invalidResult = { text: "result without files" };
  const completed = await updateToolExecutionFromWorker(fixture, {
    workspaceId: fixture.workspaceId, sessionId: session.id, runId: tool.runId, toolExecutionId: tool.executionId,
    status: "completed", structuredResult: invalidResult, completedAt: startedAt + 1, updatedAt: startedAt + 1,
  });
  assert.equal(completed.statusCode, 200, completed.body);
  const detail = await fixture.app.inject({ method: "GET", url: `/api/agent/sessions/${session.id}/tool-executions/${tool.executionId}?workspaceId=${encodeURIComponent(fixture.workspaceId)}` });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.deepEqual(detail.json().structuredResult, invalidResult);
  assert.equal((await artifact(fixture, session.id, tool.executionId, "apply-patch-artifact")).statusCode, 404);
});

test("terminal apply_patch replay 不覆盖已生成 artifact", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const tool = createTool(fixture, session.id, "apply_patch", { patchText: "*** Update File: a.ts" });
  const startedAt = Date.now();
  assert.equal((await updateToolExecutionFromWorker(fixture, {
    workspaceId: fixture.workspaceId, sessionId: session.id, runId: tool.runId, toolExecutionId: tool.executionId,
    status: "running", startedAt, updatedAt: startedAt,
  })).statusCode, 200);
  const original = { files: [{ path: "a.ts", additions: 1, deletions: 0, before: "before", after: "after" }] };
  const completed = {
    workspaceId: fixture.workspaceId, sessionId: session.id, runId: tool.runId, toolExecutionId: tool.executionId,
    status: "completed" as const, structuredResult: original, completedAt: startedAt + 1, updatedAt: startedAt + 1,
  };
  assert.equal((await updateToolExecutionFromWorker(fixture, completed)).statusCode, 200);
  const replay = await updateToolExecutionFromWorker(fixture, {
    ...completed,
    structuredResult: { files: [{ path: "a.ts", additions: 1, deletions: 0, before: "replayed-before", after: "after" }] },
  });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().result, "updated");
  const artifactRes = await artifact(fixture, session.id, tool.executionId, "apply-patch-artifact");
  assert.equal(artifactRes.statusCode, 200, artifactRes.body);
  assert.equal(artifactRes.json().files[0].before, "before");
});

test("artifact Query 在 workspace artifact 目录为越界 symlink 时保持当前 400", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 }); const session = await createSession(fixture.app, fixture.workspaceId);
  const tool = createTool(fixture, session.id, "apply_patch", { patchText: "x" }); completeToolExecutionFixture({ fixture, sessionId: session.id, runId: tool.runId, toolExecutionId: tool.executionId });
  const file = applyPatchUiArtifactPath(fixture.dataDir, fixture.workspaceId, tool.executionId); const dir = path.dirname(file); const outside = path.join(fixture.dataDir, "outside"); await fs.mkdir(outside, { recursive: true }); await fs.mkdir(path.dirname(dir), { recursive: true }); await fs.rm(dir, { recursive: true, force: true }); await fs.symlink(outside, dir, "dir");
  assert.equal((await artifact(fixture, session.id, tool.executionId, "apply-patch-artifact")).statusCode, 400);
});

test("artifact 写入失败不影响 apply_patch 的 completed 写回", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const tool = createTool(fixture, session.id, "apply_patch", { patchText: "*** Update File: a.ts" });
  const startedAt = Date.now();
  assert.equal((await updateToolExecutionFromWorker(fixture, {
    workspaceId: fixture.workspaceId, sessionId: session.id, runId: tool.runId, toolExecutionId: tool.executionId,
    status: "running", startedAt, updatedAt: startedAt,
  })).statusCode, 200);
  const file = applyPatchUiArtifactPath(fixture.dataDir, fixture.workspaceId, tool.executionId);
  const dir = path.dirname(file);
  const outside = path.join(fixture.dataDir, "outside");
  await fs.mkdir(outside, { recursive: true });
  await fs.mkdir(path.dirname(dir), { recursive: true });
  await fs.symlink(outside, dir, "dir");
  const completed = await updateToolExecutionFromWorker(fixture, {
    workspaceId: fixture.workspaceId, sessionId: session.id, runId: tool.runId, toolExecutionId: tool.executionId,
    status: "completed", structuredResult: { files: [{ path: "a.ts", before: "before", after: "after" }] },
    completedAt: startedAt + 1, updatedAt: startedAt + 1,
  });
  assert.equal(completed.statusCode, 200, completed.body);
  assert.equal(completed.json().result, "updated");
  const detail = await fixture.app.inject({ method: "GET", url: `/api/agent/sessions/${session.id}/tool-executions/${tool.executionId}?workspaceId=${encodeURIComponent(fixture.workspaceId)}` });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.deepEqual(detail.json().structuredResult, {
    text: "", summary: { fileCount: 1, additions: 0, deletions: 0 }, files: [{ type: "update", path: "a.ts", additions: 0, deletions: 0 }],
  });
});

test("Worker completed write 写回同样生成 artifact", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const tool = createTool(fixture, session.id, "write", { filePath: "a.txt", content: "after" });
  const startedAt = Date.now();
  assert.equal((await updateToolExecutionFromWorker(fixture, {
    workspaceId: fixture.workspaceId, sessionId: session.id, runId: tool.runId, toolExecutionId: tool.executionId,
    status: "running", startedAt, updatedAt: startedAt,
  })).statusCode, 200);
  const completed = await updateToolExecutionFromWorker(fixture, {
    workspaceId: fixture.workspaceId, sessionId: session.id, runId: tool.runId, toolExecutionId: tool.executionId,
    status: "completed", structuredResult: {
      filePath: "a.txt", bytesWritten: 5, existedBefore: true,
      before: { available: true, text: "before", truncated: false, bytes: 6 },
      after: { available: true, text: "after", truncated: false, bytes: 5 },
    }, completedAt: startedAt + 1, updatedAt: startedAt + 1,
  });
  assert.equal(completed.statusCode, 200, completed.body);
  const detail = await fixture.app.inject({ method: "GET", url: `/api/agent/sessions/${session.id}/tool-executions/${tool.executionId}?workspaceId=${encodeURIComponent(fixture.workspaceId)}` });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.deepEqual(detail.json().structuredResult, {
    summary: "Wrote file a.txt", filePath: "a.txt", bytesWritten: 5, existedBefore: true,
  });
  const artifactRes = await artifact(fixture, session.id, tool.executionId, "write-artifact");
  assert.equal(artifactRes.statusCode, 200, artifactRes.body);
  assert.equal(artifactRes.json().after.text, "after");
});

test("invalid write structuredResult 保持原样且不生成空 artifact", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const tool = createTool(fixture, session.id, "write", { filePath: "a.txt", content: "after" });
  const startedAt = Date.now();
  assert.equal((await updateToolExecutionFromWorker(fixture, {
    workspaceId: fixture.workspaceId, sessionId: session.id, runId: tool.runId, toolExecutionId: tool.executionId,
    status: "running", startedAt, updatedAt: startedAt,
  })).statusCode, 200);
  const invalidResult = { summary: "missing path" };
  const completed = await updateToolExecutionFromWorker(fixture, {
    workspaceId: fixture.workspaceId, sessionId: session.id, runId: tool.runId, toolExecutionId: tool.executionId,
    status: "completed", structuredResult: invalidResult, completedAt: startedAt + 1, updatedAt: startedAt + 1,
  });
  assert.equal(completed.statusCode, 200, completed.body);
  const detail = await fixture.app.inject({ method: "GET", url: `/api/agent/sessions/${session.id}/tool-executions/${tool.executionId}?workspaceId=${encodeURIComponent(fixture.workspaceId)}` });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.deepEqual(detail.json().structuredResult, invalidResult);
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
