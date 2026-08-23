import { test, type TestContext } from "node:test";
import type { FastifyInstance } from "fastify";
import { applyPatchUiArtifactPath, writeUiArtifactPath } from "../../../infra/fs/paths.js";
import { createRunRecord, getAgentSession, updateRunState } from "../agent.store.js";
import { newSortableId } from "../../../utils/ids.js";
import { createP4Fixture } from "./p4-fixture.helpers.js";
import { createSession, createContextItemInternal, updateContextItemInternal, updateRunStateInternal } from "./context-writeback.helpers.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";





























async function getMessagesContextInternal(params: {
  app: FastifyInstance;
  internalToken: string;
  workspaceId: string;
  sessionId: string;
  appendMessage?: { role: "system" | "user"; content: string };
}) {
  const res = await params.app.inject({
    method: "POST",
    url: "/api/internal/agent/messages-context",
    headers: {
      "x-awb-agent-internal-token": params.internalToken
    },
    payload: {
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      ...(params.appendMessage ? { appendMessage: params.appendMessage } : {})
    }
  });
  assert.equal(res.statusCode, 200, `get messages-context failed: ${res.body}`);
  return res.json() as {
    headItemId: number | null;
    system: string;
    messages: Array<{ role: string; content: unknown }>;
  };
}

async function getContextItem(app: FastifyInstance, sessionId: string, itemId: number) {
  const res = await app.inject({ method: "GET", url: `/api/agent/sessions/${sessionId}/context-items/${itemId}` });
  assert.equal(res.statusCode, 200, `get context-item failed: ${res.body}`);
  return res.json() as { id: number; status: string; output: Record<string, unknown> };
}

async function getPromptContextInternal(params: {
  app: FastifyInstance;
  internalToken: string;
  workspaceId: string;
  sessionId: string;
  runId: string;
}) {
  const res = await params.app.inject({
    method: "POST",
    url: "/api/internal/agent/prompt-context",
    headers: {
      "x-awb-agent-internal-token": params.internalToken
    },
    payload: {
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      runId: params.runId
    }
  });
  assert.equal(res.statusCode, 200, `get prompt-context failed: ${res.body}`);
  return res.json() as {
    system: string;
    tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
    uiLocale: "zh-CN" | "en-US" | null;
    messages: Array<{ role: string; content: unknown }>;
    pendingTools: Array<{ itemId: number; status: string; toolName: string }>;
    externalSkillRoots: Array<{ sourceType: "workspace" | "repo"; repoId?: string; rootDir: string; rootPath: string }>;
  };
}

test("agent internal: 禁止 append completed apply_patch(必须走 update 写 artifact)", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);

  const res = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/context-items",
    headers: {
      "x-awb-agent-internal-token": fixture.internalToken
    },
    payload: {
      workspaceId: fixture.workspaceId,
      sessionId: session.id,
      runId: null,
      turnId: null,
      step: null,
      prevId: null,
      kind: "tool",
      status: "completed",
      output: {
        type: "tool",
        toolName: "apply_patch",
        toolCallId: "call_apply_patch_1",
        args: { patchText: "*** Begin Patch\n*** End Patch" },
        result: { text: "ok", summary: { fileCount: 0, additions: 0, deletions: 0 }, files: [] },
        text: "ok"
      }
    }
  });
  assert.equal(res.statusCode, 400);
});

test("apply_patch artifact 文件缺失时返回 404", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = Date.now();

  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt
  });

  const toolItem = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_apply_patch",
    step: 1,
    prevId: null,
    kind: "tool",
    status: "queued",
    output: {
      type: "tool",
      toolName: "apply_patch",
      toolCallId: "call_apply_patch_1",
      args: { patchText: "*** Begin Patch\n*** End Patch" },
      text: "queued"
    }
  });

  await updateContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    itemId: toolItem.item.id,
    status: "completed",
    output: {
      type: "tool",
      toolName: "apply_patch",
      toolCallId: "call_apply_patch_1",
      args: { patchText: "*** Begin Patch\n*** End Patch" },
      result: {
        text: "ok",
        summary: { fileCount: 1, additions: 1, deletions: 0 },
        files: [
          {
            type: "add",
            path: "foo.ts",
            before: "",
            after: "console.log(1)\n",
            additions: 1,
            deletions: 0
          }
        ]
      },
      text: "ok"
    }
  });

  const artifactPath = path.join(
    fixture.dataDir,
    "tmp",
    "agent",
    "ui-artifacts",
    "apply_patch",
    fixture.workspaceId,
    "call_apply_patch_1.json"
  );
  await fs.rm(artifactPath, { force: true });

  const artifactRes = await fixture.app.inject({
    method: "GET",
    url: `/api/agent/sessions/${session.id}/context-items/${toolItem.item.id}/apply-patch-artifact`
  });
  assert.equal(artifactRes.statusCode, 404);
});

test("artifact Query 在 workspace artifact 目录为越界 symlink 时保持当前 400", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const externalDir = path.join(fixture.dataDir, "outside-artifacts");
  let prevId: number | null = null;

  for (const entry of [
    {
      toolName: "apply_patch",
      toolCallId: "call_apply_patch_symlink",
      artifactPath: applyPatchUiArtifactPath,
      suffix: "apply-patch-artifact"
    },
    {
      toolName: "write",
      toolCallId: "call_write_symlink",
      artifactPath: writeUiArtifactPath,
      suffix: "write-artifact"
    }
  ] as const) {
    const item = await createContextItemInternal({ fixture,
      app: fixture.app,
      internalToken: fixture.internalToken,
      workspaceId: fixture.workspaceId,
      sessionId: session.id,
      runId: null,
      turnId: null,
      step: null,
      prevId,
      kind: "tool",
      status: "queued",
      output: { type: "tool", toolName: entry.toolName, toolCallId: entry.toolCallId, text: "queued" }
    });
    prevId = item.item.id;
    const artifactFile = entry.artifactPath(fixture.dataDir, fixture.workspaceId, entry.toolCallId);
    const artifactDir = path.dirname(artifactFile);
    await fs.mkdir(artifactDir, { recursive: true });
    await fs.rm(artifactDir, { recursive: true, force: true });
    await fs.mkdir(externalDir, { recursive: true });
    await fs.writeFile(path.join(externalDir, path.basename(artifactFile)), "{}", "utf8");
    await fs.symlink(externalDir, artifactDir, "dir");

    const response = await fixture.app.inject({
      method: "GET",
      url: `/api/agent/sessions/${session.id}/context-items/${item.item.id}/${entry.suffix}`
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.match(response.body, /Invalid path/);
    await fs.rm(artifactDir, { recursive: true, force: true });
  }
});

test("artifact 写入目录为越界 symlink 时仍以 slim result 完成 update", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const externalDir = path.join(fixture.dataDir, "outside-artifacts");
  const previousLogLevel = fixture.app.log.level;
  fixture.app.log.level = "fatal";
  try {
  const toolCallId = "call_write_write_symlink";
  const toolItem = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: null,
    step: null,
    prevId: null,
    kind: "tool",
    status: "queued",
    output: {
      type: "tool",
      toolName: "write",
      toolCallId,
      args: { filePath: "result.txt", content: "complete content" },
      text: "queued"
    }
  });
  const artifactFile = writeUiArtifactPath(fixture.dataDir, fixture.workspaceId, toolCallId);
  const artifactDir = path.dirname(artifactFile);
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.rm(artifactDir, { recursive: true, force: true });
  await fs.mkdir(externalDir, { recursive: true });
  await fs.symlink(externalDir, artifactDir, "dir");

  const response = await fixture.app.inject({
    method: "PATCH",
    url: `/api/internal/agent/context-items/${toolItem.item.id}`,
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: {
      status: "completed",
      output: {
        type: "tool",
        toolName: "write",
        toolCallId,
        args: { filePath: "result.txt", content: "complete content" },
        result: {
          text: "wrote result.txt",
          filePath: "result.txt",
          bytesWritten: 16,
          existedBefore: false,
          before: { available: true, text: "" },
          after: { available: true, text: "complete content" }
        },
        text: "completed"
      }
    }
  });
  assert.equal(response.statusCode, 200, response.body);
  const output = (response.json() as { item: { output: { result: Record<string, unknown> } } }).item.output.result;
  assert.equal(Object.hasOwn(output, "before"), false);
  assert.equal(Object.hasOwn(output, "after"), false);
  assert.equal(output.filePath, "result.txt");
  assert.equal(await fs.lstat(artifactDir).then((st) => st.isSymbolicLink()), true);
  await fs.rm(artifactDir, { recursive: true, force: true });
  } finally {
  fixture.app.log.level = previousLogLevel;
  }
});

test("write completed 后保留完整 args、瘦身 result 并支持 artifact 拉取", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = Date.now();

  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt
  });

  const userItem = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "请写入文件"
    }
  });

  const assistantItem = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_write",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "completed",
    output: {
      type: "assistant_text",
      text: "开始写文件"
    }
  });

  const writeContent = [
    "# 完整历史写入内容",
    "中文多行内容必须原样保留。",
    "x".repeat(320),
    "最后一行不能被截断。"
  ].join("\n");
  const writeBytes = Buffer.byteLength(writeContent, "utf8");

  const toolItem = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_write",
    step: 1,
    prevId: assistantItem.item.id,
    kind: "tool",
    status: "queued",
    output: {
      type: "tool",
      toolName: "write",
      toolCallId: "call_write_1",
      args: {
        filePath: "foo.txt",
        content: writeContent
      },
      text: "write queued"
    }
  });

  updateRunState(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    status: "running",
    activeRunId: runId,
    activeAssistantItemId: null,
    updatedAt: Date.now(),
    appliedItemId: 0
  });
  await updateContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    itemId: toolItem.item.id,
    status: "completed",
    output: {
      type: "tool",
      toolName: "write",
      toolCallId: "call_write_1",
      args: {
        filePath: "foo.txt",
        content: writeContent
      },
      result: {
        summary: "Wrote file foo.txt",
        filePath: "foo.txt",
        bytesWritten: writeBytes,
        existedBefore: false,
        before: {
          available: false,
          truncated: false,
          bytes: 0,
          reason: "missing_file"
        },
        after: {
          available: true,
          text: writeContent,
          truncated: false,
          bytes: writeBytes
        }
      },
      text: "ok: wrote file"
    }
  });

  const storedTool = await getContextItem(fixture.app, session.id, toolItem.item.id);
  const storedOutput = storedTool.output as { args?: Record<string, unknown>; result?: Record<string, unknown> };
  const storedArgs = storedOutput.args || {};
  assert.equal(storedArgs.filePath, "foo.txt");
  assert.equal(storedArgs.content, writeContent, "write args should preserve complete content");
  assert.equal(Object.prototype.hasOwnProperty.call(storedArgs, "contentBytes"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(storedArgs, "contentPreview"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(storedArgs, "contentTruncated"), false);

  const storedResult = storedOutput.result || {};
  assert.equal(Object.prototype.hasOwnProperty.call(storedResult, "before"), false, "write result should strip before");
  assert.equal(Object.prototype.hasOwnProperty.call(storedResult, "after"), false, "write result should strip after");

  const artifactRes = await fixture.app.inject({
    method: "GET",
    url: `/api/agent/sessions/${session.id}/context-items/${toolItem.item.id}/write-artifact`
  });
  assert.equal(artifactRes.statusCode, 200, `write artifact fetch failed: ${artifactRes.body}`);
  const artifact = artifactRes.json() as { before?: Record<string, unknown>; after?: Record<string, unknown> };
  assert.equal(artifact.before?.available, false);
  assert.equal(artifact.after?.available, true);
  assert.equal(typeof artifact.after?.text, "string");

  const context = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });

  const assistantWithToolCall = context.messages.find((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return false;
    return message.content.some((part) => {
      if (!part || typeof part !== "object") return false;
      return (part as { type?: string; toolName?: string }).type === "tool-call" &&
        (part as { toolName?: string }).toolName === "write";
    });
  });
  assert.ok(assistantWithToolCall, "assistant message should include write tool-call part");

  const toolCallPart = Array.isArray(assistantWithToolCall?.content)
    ? assistantWithToolCall.content.find((part) => {
        if (!part || typeof part !== "object") return false;
        return (part as { type?: string; toolName?: string }).type === "tool-call" &&
          (part as { toolName?: string }).toolName === "write";
      })
    : null;
  const input = (toolCallPart as { input?: Record<string, unknown> } | null)?.input ?? {};
  assert.equal(input.filePath, "foo.txt");
  assert.equal(input.content, writeContent, "write tool-call input should preserve complete content");
  assert.equal(Object.prototype.hasOwnProperty.call(input, "contentBytes"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(input, "contentPreview"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(input, "contentTruncated"), false);
  assert.equal(artifact.after?.text, writeContent);

  const messagesContext = await getMessagesContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id
  });
  const messagesAssistant = messagesContext.messages.find((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return false;
    return message.content.some((part) => {
      if (!part || typeof part !== "object") return false;
      return (part as { type?: string; toolName?: string }).type === "tool-call" &&
        (part as { toolName?: string }).toolName === "write";
    });
  });
  const messagesToolCallPart = Array.isArray(messagesAssistant?.content)
    ? messagesAssistant.content.find((part) => {
        if (!part || typeof part !== "object") return false;
        return (part as { type?: string; toolName?: string }).type === "tool-call" &&
          (part as { toolName?: string }).toolName === "write";
      })
    : null;
  const messagesInput = (messagesToolCallPart as { input?: Record<string, unknown> } | null)?.input ?? {};
  assert.equal(messagesInput.content, writeContent, "messages-context should preserve complete write content");

  const forkBoundary = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: null,
    step: null,
    prevId: toolItem.item.id,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "继续处理"
    }
  });
  const forkRes = await fixture.app.inject({
    method: "POST",
    url: "/api/agent/sessions/fork",
    payload: {
      fromSessionId: session.id,
      fromItemId: forkBoundary.item.id,
      mode: "visible_only"
    }
  });
  assert.equal(forkRes.statusCode, 201, `fork write session failed: ${forkRes.body}`);
  const forked = forkRes.json() as { id: string };
  const forkContext = await getMessagesContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: forked.id
  });
  const forkedWriteAssistant = forkContext.messages.find((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return false;
    return message.content.some((part) => {
      if (!part || typeof part !== "object") return false;
      return (part as { type?: string; toolName?: string }).type === "tool-call" &&
        (part as { toolName?: string }).toolName === "write";
    });
  });
  const forkedWritePart = Array.isArray(forkedWriteAssistant?.content)
    ? forkedWriteAssistant.content.find((part) => {
        if (!part || typeof part !== "object") return false;
        return (part as { type?: string; toolName?: string }).type === "tool-call" &&
          (part as { toolName?: string }).toolName === "write";
      })
    : null;
  const forkedWriteInput = (forkedWritePart as { input?: Record<string, unknown> } | null)?.input ?? {};
  assert.equal(forkedWriteInput.content, writeContent, "forked Prompt should preserve complete write content");

  const legacyAssistantItem = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_write_legacy",
    step: 2,
    prevId: forkBoundary.item.id,
    kind: "assistant",
    status: "completed",
    output: {
      type: "assistant_text",
      text: "处理旧 write 记录"
    }
  });
  const legacyCompletedItem = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_write_legacy",
    step: 2,
    prevId: legacyAssistantItem.item.id,
    kind: "tool",
    status: "completed",
    output: {
      type: "tool",
      toolName: "write",
      toolCallId: "call_write_legacy",
      args: {
        filePath: "legacy.txt",
        contentBytes: 123,
        contentPreview: "legacy preview"
      },
      text: "legacy write completed"
    }
  });
  await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_write_legacy",
    step: 2,
    prevId: legacyCompletedItem.item.id,
    kind: "tool",
    status: "failed",
    output: {
      type: "tool",
      toolName: "write",
      toolCallId: "call_write_legacy_failed",
      args: {
        filePath: "legacy-failed.txt",
        contentBytes: 456
      },
      text: "legacy write fallback text",
      error: "legacy write failure"
    }
  });

  const legacyContext = await getMessagesContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id
  });
  const legacyAssistant = legacyContext.messages.find((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return false;
    return message.content.some((part) => {
      if (!part || typeof part !== "object") return false;
      return (part as { type?: string; text?: string }).type === "text" &&
        String((part as { text?: string }).text || "").includes("Historical write input unavailable: legacy.txt");
    });
  });
  assert.ok(legacyAssistant, "legacy metadata-only writes should degrade to text records");
  const legacyParts = Array.isArray(legacyAssistant?.content) ? legacyAssistant.content : [];
  const legacyText = legacyParts
    .filter((part): part is { type: "text"; text: string } => !!part && typeof part === "object" && (part as { type?: string }).type === "text")
    .map((part) => part.text)
    .join("\n");
  assert.ok(legacyText.includes("Historical write input unavailable: legacy.txt"));
  assert.ok(legacyText.includes("legacy write completed"), "completed legacy result should remain in history");
  assert.ok(legacyText.includes("Historical write input unavailable: legacy-failed.txt"));
  assert.ok(legacyText.includes("legacy write failure"), "failed legacy error should remain in history");
  const legacyWriteCalls = legacyParts.filter((part) => {
    if (!part || typeof part !== "object") return false;
    return (part as { type?: string; toolName?: string }).type === "tool-call" &&
      (part as { toolName?: string }).toolName === "write";
  });
  assert.equal(legacyWriteCalls.length, 0, "legacy metadata-only writes must not become schema-invalid tool-calls");
  const legacyToolResults = legacyContext.messages
    .filter((message) => message.role === "tool" && Array.isArray(message.content))
    .flatMap((message) => message.content)
    .filter((part) => {
      if (!part || typeof part !== "object") return false;
      return (part as { type?: string; toolName?: string }).type === "tool-result" &&
        (part as { toolName?: string }).toolName === "write";
    });
  assert.equal(legacyToolResults.length, 1, "only the complete write should retain a tool-result");
});

test("write artifact 文件缺失时返回 404", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = Date.now();

  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt
  });

  const toolItem = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_write",
    step: 1,
    prevId: null,
    kind: "tool",
    status: "queued",
    output: {
      type: "tool",
      toolName: "write",
      toolCallId: "call_write_1",
      args: { filePath: "foo.txt", content: "hello" },
      text: "queued"
    }
  });

  await updateContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    itemId: toolItem.item.id,
    status: "completed",
    output: {
      type: "tool",
      toolName: "write",
      toolCallId: "call_write_1",
      args: { filePath: "foo.txt", content: "hello" },
      result: {
        summary: "Wrote file foo.txt",
        filePath: "foo.txt",
        bytesWritten: 5,
        existedBefore: false,
        before: { available: false, truncated: false, bytes: 0, reason: "missing_file" },
        after: { available: true, text: "hello", truncated: false, bytes: 5 }
      },
      text: "ok"
    }
  });

  const artifactPath = path.join(
    fixture.dataDir,
    "tmp",
    "agent",
    "ui-artifacts",
    "write",
    fixture.workspaceId,
    "call_write_1.json"
  );
  await fs.rm(artifactPath, { force: true });

  const artifactRes = await fixture.app.inject({
    method: "GET",
    url: `/api/agent/sessions/${session.id}/context-items/${toolItem.item.id}/write-artifact`
  });
  assert.equal(artifactRes.statusCode, 404);
});

test("write 在 cancel 终态会保留完整 args.content", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");

  const toolItem = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_write_cancel",
    step: 1,
    prevId: null,
    kind: "tool",
    status: "running",
    output: {
      type: "tool",
      toolName: "write",
      toolCallId: "call_write_cancel",
      args: {
        filePath: "cancel.txt",
        content: "secret cancel payload"
      }
    }
  });

  await updateRunStateInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    status: "running",
    activeRunId: runId,
    activeAssistantItemId: null,
  });

  const cancelRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/cancel`,
    payload: {
      workspaceId: fixture.workspaceId
    }
  });
  assert.equal(cancelRes.statusCode, 200, `cancel write run failed: ${cancelRes.body}`);

  const cancelledItem = await getContextItem(fixture.app, session.id, toolItem.item.id);
  assert.equal(cancelledItem.status, "cancelled");
  const args = (cancelledItem.output as { args?: Record<string, unknown> }).args || {};
  assert.equal(args.filePath, "cancel.txt");
  assert.equal(args.content, "secret cancel payload");
  assert.equal(Object.prototype.hasOwnProperty.call(args, "contentBytes"), false);
});

test("write 在 failed 终态会保留完整 args.content", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const writeContent = "失败时也必须保留完整写入意图\n".repeat(30);
  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt: Date.now()
  });
  updateRunState(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    status: "running",
    activeRunId: runId,
    activeAssistantItemId: null,
    updatedAt: Date.now(),
    appliedItemId: 0
  });

  const toolItem = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_write_failed",
    step: 1,
    prevId: null,
    kind: "tool",
    status: "running",
    output: {
      type: "tool",
      toolName: "write",
      toolCallId: "call_write_failed",
      args: {
        filePath: "failed.txt",
        content: writeContent
      }
    }
  });

  await updateContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    itemId: toolItem.item.id,
    status: "failed",
    output: {
      type: "tool",
      toolName: "write",
      toolCallId: "call_write_failed",
      args: {
        filePath: "failed.txt",
        content: writeContent
      },
      text: "write failed",
      error: "simulated failure"
    }
  });

  const failedItem = await getContextItem(fixture.app, session.id, toolItem.item.id);
  assert.equal(failedItem.status, "failed");
  const args = (failedItem.output as { args?: Record<string, unknown> }).args || {};
  assert.equal(args.filePath, "failed.txt");
  assert.equal(args.content, writeContent);
  assert.equal(Object.prototype.hasOwnProperty.call(args, "contentBytes"), false);
});

test("agent tool 字符串结果保持原始字符串语义", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = Date.now();

  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt
  });

  const userItem = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "测试字符串结果"
    }
  });

  const assistantItem = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_string_result",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "completed",
    output: {
      type: "assistant_text",
      text: "调用工具获取字符串"
    }
  });

  const rawString = '{"ok":true}';
  const toolItem = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_string_result",
    step: 1,
    prevId: assistantItem.item.id,
    kind: "tool",
    status: "completed",
    output: {
      type: "tool",
      toolName: "bash",
      toolCallId: "call_string_result",
      args: {
        command: "echo test"
      },
      result: rawString
    }
  });

  const detail = await getContextItem(fixture.app, session.id, toolItem.item.id);
  assert.equal(detail.output.type, "tool");
  assert.equal(typeof detail.output.result, "string");
  assert.equal(String(detail.output.result || ""), rawString);
});

test("agent 兼容部分迁移数据: tool_call_json 缺失时回退 legacy output", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = Date.now();

  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt
  });

  const userItem = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "请读取文件"
    }
  });

  const assistantItem = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_legacy_fallback",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "completed",
    output: {
      type: "assistant_text",
      text: "准备调用 read"
    }
  });

  const legacyToolOutput = {
    type: "tool",
    toolName: "read",
    toolCallId: "call_legacy_read",
    args: {
      filePath: "README.md"
    }
  };

  const toolItem = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_legacy_fallback",
    step: 1,
    prevId: assistantItem.item.id,
    kind: "tool",
    status: "queued",
    output: legacyToolOutput
  });

  fixture.db
    .prepare(
      `
        update agent_context_item
        set tool_name = @toolName,
            tool_call_id = null,
            tool_call_json = null,
            tool_result_json = null,
            output_text = '',
            output_json = @outputJson
        where id = @id
      `
    )
    .run({
      id: toolItem.item.id,
      toolName: "read",
      outputJson: JSON.stringify(legacyToolOutput)
    });

  const detail = await getContextItem(fixture.app, session.id, toolItem.item.id);
  assert.equal(detail.output.type, "tool");
  assert.equal(String(detail.output.toolName || ""), "read");
  assert.equal(String(detail.output.toolCallId || ""), "call_legacy_read");
  assert.equal(String((detail.output.args as { filePath?: string } | undefined)?.filePath || ""), "README.md");

  const promptContext = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });
  assert.equal(promptContext.pendingTools.length, 1);
});

test("agent 兼容早期拆分数据: 缺少 resultFormat 时保留结构化工具结果", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = Date.now();

  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt
  });

  const userItem = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "测试结构化兼容"
    }
  });

  const assistantItem = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_compat_result",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "completed",
    output: {
      type: "assistant_text",
      text: "调用 todolist"
    }
  });

  const structuredResult = {
    summary: { total: 1, pending: 0, inProgress: 0, completed: 1, cancelled: 0 },
    todos: [{ content: "完成兼容", status: "completed" }]
  };

  const toolItem = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_compat_result",
    step: 1,
    prevId: assistantItem.item.id,
    kind: "tool",
    status: "completed",
    output: {
      type: "tool",
      toolName: "todolist",
      toolCallId: "call_compat_todolist",
      args: {
        todos: [{ content: "完成兼容", status: "completed" }]
      },
      result: structuredResult
    }
  });

  fixture.db
    .prepare(
      `
        update agent_context_item
        set output_text = @outputText,
            tool_result_json = @toolResultJson,
            output_json = '{}'
        where id = @id
      `
    )
    .run({
      id: toolItem.item.id,
      outputText: JSON.stringify(structuredResult),
      toolResultJson: JSON.stringify({ status: "completed" })
    });

  const detail = await getContextItem(fixture.app, session.id, toolItem.item.id);
  assert.equal(detail.output.type, "tool");
  assert.equal(typeof detail.output.result, "object");
  assert.equal(
    Array.isArray((detail.output.result as { todos?: unknown[] } | undefined)?.todos),
    true,
    "result should remain structured object"
  );

  const sessionAfterCompat = getAgentSession(fixture.db, session.id);
  assert.ok(sessionAfterCompat, "compat session should exist");
  assert.equal(sessionAfterCompat?.title, "it-session", "compat todolist without goal should not change session title");
});
