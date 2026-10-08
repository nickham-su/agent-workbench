import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { createOpenAI } from "@ai-sdk/openai";
import { streamText } from "ai";
import { AgentApiEndpoints, viewImagePathPreview } from "@agent-workbench/shared/internal-contracts/agent-api";
import { applyPatchUiArtifactPath, writeUiArtifactPath } from "../../../infra/fs/paths.js";
import { newSortableId } from "../../../utils/ids.js";
import { createAgentService } from "../agent.composition.js";
import { getMessageSessionHead } from "../agent-message.store.js";
import { createP4Fixture } from "./p4-fixture.helpers.js";
import { appendMessageFixture, completeToolExecutionFixture, createAssistantFixture, createMessageRunFixture, createSession } from "./context-writeback.helpers.js";
import { injectJson } from "../testkit/agent-testkit.js";

type Fixture = Awaited<ReturnType<typeof createP4Fixture>>;

function createTool(fixture: Fixture, sessionId: string, toolName: "apply_patch" | "write" | "view_image", input: Record<string, unknown>) {
  const run = createMessageRunFixture({ fixture, sessionId });
  const callPartId = newSortableId("part");
  const executionId = newSortableId("exec");
  const assistant = createAssistantFixture({ fixture, sessionId, runId: run.runId, parts: [{ id: callPartId, position: 0, type: "tool_call", toolName, input, providerToolCallId: newSortableId("call") }], executions: [{ id: executionId, callPartId, originSessionId: sessionId, originRunId: run.runId, status: "queued" }] });
  return { ...run, ...assistant, executionId };
}

test("view_image 仅按授权的本 Run completed call 持久化路径，不从 preview 恢复图", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const tool = createTool(fixture, session.id, "view_image", { path: "repo/screenshot.png" });
  const startedAt = Date.now();
  const base = { workspaceId: fixture.workspaceId, sessionId: session.id, runId: tool.runId, toolExecutionId: tool.executionId };
  const invalid = [
    null, { type: "image_ref", path: "../outside.png" }, { type: "image_ref", path: "repo/a.png", data: "ZmFrZQ==" },
    { type: "image_ref", path: "/absolute.png" }, [{ type: "image_ref", path: "repo/a.png" }]
  ];
  for (const structuredResult of invalid) {
    const response = await updateToolExecutionFromWorker(fixture, {
      ...base, status: "completed", resultPreview: "invalid", structuredResult, completedAt: startedAt, updatedAt: startedAt
    });
    assert.notEqual(response.statusCode, 200, "invalid image result must not be silently accepted");
  }
  assert.equal((await updateToolExecutionFromWorker(fixture, {
    ...base, status: "running", structuredResult: { type: "image_ref", path: "repo/screenshot.png" }, updatedAt: startedAt
  })).statusCode !== 200, true, "running status cannot persist media");
  assert.equal((await updateToolExecutionFromWorker(fixture, { ...base, status: "running", startedAt, updatedAt: startedAt })).json().result, "updated");
  const ref = { type: "image_ref", path: "repo/screenshot.png" };
  const completed = { ...base, status: "completed", resultPreview: viewImagePathPreview(ref.path), structuredResult: ref, completedAt: startedAt + 1, updatedAt: startedAt + 1 };
  for (const bad of [{ resultPreview: "spoofed-image-content" }, { resultTruncated: true }, { resultArtifactPath: "artifact.txt" }, { error: "bad" }]) {
    assert.notEqual((await updateToolExecutionFromWorker(fixture, { ...completed, ...bad })).statusCode, 200);
  }
  const other = await createSession(fixture.app, fixture.workspaceId);
  const crossSession = await updateToolExecutionFromWorker(fixture, { ...completed, sessionId: other.id });
  assert.deepEqual(crossSession.json(), { result: "ignored" });
  const crossRun = await updateToolExecutionFromWorker(fixture, { ...completed, runId: "run_forged" });
  assert.deepEqual(crossRun.json(), { result: "ignored" });
  const wrongCallPath = await updateToolExecutionFromWorker(fixture, {
    ...completed, resultPreview: viewImagePathPreview("repo/other.png"), structuredResult: { type: "image_ref", path: "repo/other.png" }
  });
  assert.deepEqual(wrongCallPath.json(), { result: "ignored" }, "image must match its call input path");
  const success = await updateToolExecutionFromWorker(fixture, completed);
  assert.equal(success.statusCode, 200, success.body);
  assert.deepEqual(success.json(), { result: "updated" });
  assert.deepEqual((await updateToolExecutionFromWorker(fixture, completed)).json(), { result: "updated" }, "identical terminal replay is idempotent");
  const row = fixture.db.prepare("select status, result_preview as preview, structured_result_json as structured from agent_tool_execution where id = ?")
    .get(tool.executionId) as { status: string; preview: string; structured: string };
  assert.equal(row.status, "completed");
  assert.equal(row.preview, viewImagePathPreview(ref.path));
  assert.deepEqual(JSON.parse(row.structured), ref);
  assert.doesNotMatch(JSON.stringify(row), /ZmFrZQ==|spoofed-image-content/);
  const sourceResponse = await injectJson(fixture.app, {
    method: AgentApiEndpoints.getCompactionSource.method,
    url: AgentApiEndpoints.getCompactionSource.path,
    internalToken: fixture.internalToken,
    payload: { workspaceId: fixture.workspaceId, sessionId: session.id, runId: tool.runId },
  });
  assert.equal(sourceResponse.statusCode, 200);
  const source = sourceResponse.json();
  const imageExecution = source.blocks.flatMap((block: { toolExecutions: unknown[] }) => block.toolExecutions)
    .find((execution: { id: string }) => execution.id === tool.executionId);
  assert.deepEqual(imageExecution.imageRef, ref);
  assert.equal(imageExecution.originRunId, tool.runId);
  assert.equal(JSON.stringify(source).includes("ZmFrZQ=="), false);
  assert.equal(JSON.stringify(source).includes("structuredResultJson"), false);
  assert.deepEqual((await updateToolExecutionFromWorker(fixture, {
    ...completed, resultPreview: viewImagePathPreview("repo/other.png"),
    structuredResult: { type: "image_ref", path: "repo/other.png" }
  })).json(), { result: "ignored" });
});

test("view_image 失败和取消不能写入 image_ref，重复终态不改写先前结果", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  for (const terminalStatus of ["failed", "cancelled"] as const) {
    const session = await createSession(fixture.app, fixture.workspaceId);
    const tool = createTool(fixture, session.id, "view_image", { path: "repo/image.png" });
    const now = Date.now();
    const base = { workspaceId: fixture.workspaceId, sessionId: session.id, runId: tool.runId, toolExecutionId: tool.executionId };
    const start = await updateToolExecutionFromWorker(fixture, { ...base, status: "running", startedAt: now, updatedAt: now });
    assert.deepEqual(start.json(), { result: "updated" });
    const injection = await updateToolExecutionFromWorker(fixture, {
      ...base, status: terminalStatus, structuredResult: { type: "image_ref", path: "repo/image.png" }, completedAt: now + 1, updatedAt: now + 1
    });
    assert.notEqual(injection.statusCode, 200);
    const finish = await updateToolExecutionFromWorker(fixture, {
      ...base, status: terminalStatus, resultPreview: "image could not be read", completedAt: now + 1, updatedAt: now + 1
    });
    assert.deepEqual(finish.json(), { result: "updated" });
    assert.deepEqual((await updateToolExecutionFromWorker(fixture, {
      ...base, status: "completed", resultPreview: viewImagePathPreview("repo/image.png"),
      structuredResult: { type: "image_ref", path: "repo/image.png" }, completedAt: now + 2, updatedAt: now + 2
    })).json(), { result: "ignored" });
    const row = fixture.db.prepare("select status, structured_result_json as structured from agent_tool_execution where id = ?")
      .get(tool.executionId) as { status: string; structured: string | null };
    assert.equal(row.status, terminalStatus);
    assert.equal(row.structured, null);
  }
});
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
test("persisted view_image execution reaches a real Worker model request as media, never as persisted bytes", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const relativePath = "screens/page.png";
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x61]);
  await fs.mkdir(path.join(fixture.workspacePath, "screens"), { recursive: true });
  await fs.writeFile(path.join(fixture.workspacePath, relativePath), bytes);
  const created = createTool(fixture, session.id, "view_image", { path: relativePath });
  const { AgentRunner, executeToolForTest } = await import(new URL("../../../../../agent-worker/src/runtime/runner.ts", import.meta.url).href);
  const profile = { model: { id: "gpt-4o-mini" }, provider: { npm: "@ai-sdk/openai", options: { apiKey: "fixture" } },
    agent: { tools: ["view_image"], pluginTools: [], mcpServers: [] }, runtime: {} };
  const run = { workspaceId: fixture.workspaceId, sessionId: session.id, runId: created.runId,
    workspacePath: fixture.workspacePath, workspaceRepoDirNames: [], inputText: "look" };
  const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  const runner = new AgentRunner({
    async updateToolExecution(payload: Record<string, unknown>) {
      const response = await updateToolExecutionFromWorker(fixture, payload);
      assert.equal(response.statusCode, 200, response.body);
      return response.json();
    },
    async createStreamingAssistant() { return { result: "updated" }; },
    async flushAssistantParts() { return { result: "updated" }; },
    async completeAssistant() { return { result: "updated" }; },
    async completeTerminalAssistant() { return { result: "updated" }; },
  } as any, {} as any, { info() {}, warn() {}, error() {} }, 1, {
    streamText: ((request: (typeof requests)[number]) => {
      requests.push(request);
      return { fullStream: (async function* () {
        yield { type: "text-delta", text: "saw image" };
        yield { type: "raw", rawValue: { type: "response.completed", response: { output: [] } } };
        yield { type: "finish" };
      })() };
    }) as any,
  });
  await executeToolForTest(runner, { profile, run, tool: {
    toolExecutionId: created.executionId, callPartId: created.parts[0]!.id,
    assistantMessageId: created.assistantMessageId, status: "queued", toolName: "view_image",
    toolCallId: (created.parts[0] as { providerToolCallId: string }).providerToolCallId,
    args: { path: relativePath },
  }, parentSessionId: session.id, signal: new AbortController().signal, promptContext: { messages: [], tools: [] } });
  const prompt = await fixture.app.inject({ method: "POST", url: AgentApiEndpoints.getPromptContext.path,
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: { workspaceId: fixture.workspaceId, sessionId: session.id, runId: created.runId } });
  assert.equal(prompt.statusCode, 200, prompt.body);
  assert.match(prompt.body, /"type":"image_ref","path":"screens\/page\.png"/);
  assert.doesNotMatch(prompt.body, /iVBOR/);
  (runner as any).toolRegistry.listTools = async () => [];
  await (runner as any).runModelStep({ profile, run, context: prompt.json(), step: 1,
    signal: new AbortController().signal, repeatedToolCallCounter: new Map() });
  assert.equal(requests.length, 1);
  const tool = requests[0]!.messages.find((item) => item.role === "tool")!;
  const result = (tool.content as Array<{ output: { type: string; value: Array<{ type: string; data: string }> } }>)[0]!;
  assert.equal(result.output.type, "content");
  assert.equal(result.output.value[0]?.type, "media");
  assert.deepEqual(Buffer.from(result.output.value[0]!.data, "base64"), bytes);
  const persisted = fixture.db.prepare("select structured_result_json as structuredResultJson from agent_tool_execution where id = ?")
    .get(created.executionId) as { structuredResultJson: string };
  assert.deepEqual(JSON.parse(persisted.structuredResultJson), { type: "image_ref", path: relativePath });
});

test("真实压缩提交后同 Run 尾部工具图重读并进入 SDK；源文件丢失时请求前失败", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  appendMessageFixture({ fixture, sessionId: session.id, type: "user", text: "old prefix" });
  const relativePath = "screens/retained.png";
  const imagePath = path.join(fixture.workspacePath, relativePath);
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x61]);
  await fs.mkdir(path.dirname(imagePath), { recursive: true });
  await fs.writeFile(imagePath, bytes);
  const created = createTool(fixture, session.id, "view_image", { path: relativePath });
  const { AgentRunner, executeToolForTest } = await import(new URL("../../../../../agent-worker/src/runtime/runner.ts", import.meta.url).href);
  const profile = { model: { id: "gpt-4o-mini" }, provider: { npm: "@ai-sdk/openai", options: { apiKey: "fixture" } },
    agent: { tools: ["view_image"], pluginTools: [], mcpServers: [] }, runtime: {} };
  const run = { workspaceId: fixture.workspaceId, sessionId: session.id, runId: created.runId,
    workspacePath: fixture.workspacePath, workspaceRepoDirNames: [], inputText: "look" };
  const requests: Array<{ messages: Parameters<typeof streamText>[0]["messages"] }> = [];
  const runner = new AgentRunner({
    async updateToolExecution(payload: Record<string, unknown>) {
      const response = await updateToolExecutionFromWorker(fixture, payload);
      assert.equal(response.statusCode, 200, response.body);
      return response.json();
    },
    async createStreamingAssistant() { return { result: "updated" }; },
    async flushAssistantParts() { return { result: "updated" }; },
    async completeAssistant() { return { result: "updated" }; },
    async completeTerminalAssistant() { return { result: "updated" }; },
  } as any, {} as any, { info() {}, warn() {}, error() {} }, 1, {
    streamText: ((request: (typeof requests)[number]) => {
      requests.push(request);
      return { fullStream: (async function* () {
        yield { type: "text-delta", text: "seen" };
        yield { type: "raw", rawValue: { type: "response.completed", response: { output: [] } } };
        yield { type: "finish" };
      })() };
    }) as any,
  });
  await executeToolForTest(runner, { profile, run, tool: {
    toolExecutionId: created.executionId, callPartId: created.parts[0]!.id,
    assistantMessageId: created.assistantMessageId, status: "queued", toolName: "view_image",
    toolCallId: (created.parts[0] as { providerToolCallId: string }).providerToolCallId,
    args: { path: relativePath },
  }, parentSessionId: session.id, signal: new AbortController().signal, promptContext: { messages: [], tools: [] } });
  const head = getMessageSessionHead(fixture.db, { workspaceId: fixture.workspaceId, sessionId: session.id })!;
  const committed = await injectJson(fixture.app, {
    method: AgentApiEndpoints.commitCompactionWithTerminalIntent.method,
    url: AgentApiEndpoints.commitCompactionWithTerminalIntent.path,
    internalToken: fixture.internalToken,
    payload: { workspaceId: fixture.workspaceId, sessionId: session.id, runId: created.runId,
      messageId: newSortableId("msg"), textPartId: newSortableId("part"),
      expectedHeadMessageId: head.headMessageId, expectedRevision: head.revision,
      retainedFromMessageId: created.triggerMessageId, summaryText: "summary of old prefix", createdAt: Date.now() },
  });
  assert.equal(committed.statusCode, 200, committed.body);
  assert.equal(committed.json().result, "updated");
  const getContext = async () => {
    const response = await injectJson(fixture.app, { method: AgentApiEndpoints.getPromptContext.method,
      url: AgentApiEndpoints.getPromptContext.path, internalToken: fixture.internalToken,
      payload: { workspaceId: fixture.workspaceId, sessionId: session.id, runId: created.runId } });
    assert.equal(response.statusCode, 200, response.body);
    assert.match(response.body, /"type":"image_ref","path":"screens\/retained\.png"/);
    assert.doesNotMatch(response.body, /iVBOR/);
    return response.json();
  };
  (runner as any).toolRegistry.listTools = async () => [];
  const execute = async () => (runner as any).runModelStep({ profile, run, context: await getContext(), step: 1,
    signal: new AbortController().signal, repeatedToolCallCounter: new Map() });
  await execute();
  assert.equal(requests.length, 1);
  let wire: Record<string, unknown> | undefined;
  const model = createOpenAI({ apiKey: "fixture", fetch: async (_url, init) => {
    wire = JSON.parse(String(init?.body));
    return new Response("fixture failure", { status: 400, headers: { "content-type": "text/plain" } });
  } }).responses("gpt-4o-mini");
  const sdk = streamText({ model, messages: requests[0]!.messages!, maxRetries: 0, onError() {} });
  try { for await (const _part of sdk.fullStream) { /* capture actual SDK request */ } } catch { /* mocked provider */ }
  assert.ok(wire);
  assert.match(JSON.stringify(wire), /input_image/);
  assert.match(JSON.stringify(wire), new RegExp(bytes.toString("base64")));
  await fs.rm(imagePath);
  await assert.rejects(execute(), /cannot read a valid tool image/);
  assert.equal(requests.length, 1, "missing source must fail before another SDK request");
});
