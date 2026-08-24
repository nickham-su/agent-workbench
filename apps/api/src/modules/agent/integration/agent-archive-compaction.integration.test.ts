import { test, type TestContext } from "node:test";
import type { FastifyInstance } from "fastify";
import { agentArchiveSessionDir, compactionSnippetPath } from "../../../infra/fs/paths.js";
import { createRunRecord } from "../agent.store.js";
import { newSortableId } from "../../../utils/ids.js";
import { createP4Fixture } from "./p4-fixture.helpers.js";
import { createSession, createContextItemInternal } from "./context-writeback.helpers.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";





























async function getContextItems(app: FastifyInstance, sessionId: string, afterId?: number) {
  const url = afterId ? `/api/agent/sessions/${sessionId}/context-items?afterId=${afterId}` : `/api/agent/sessions/${sessionId}/context-items`;
  const res = await app.inject({ method: "GET", url });
  assert.equal(res.statusCode, 200, `get context-items failed: ${res.body}`);
  return res.json() as {
    headItemId: number | null;
    items: Array<{
      id: number;
      kind: string;
      status: string;
      output: Record<string, any>;
      prevId: number | null;
      archiveAt: number | null;
      boundaryReason: string | null;
    }>;
  };
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

async function compactContextInternal(params: {
  app: FastifyInstance;
  internalToken: string;
  workspaceId: string;
  sessionId: string;
  runId: string;
  expectedHeadItemId: number | null;
  summaryText: string;
}) {
  const res = await params.app.inject({
    method: "POST",
    url: "/api/internal/agent/context/compact",
    headers: {
      "x-awb-agent-internal-token": params.internalToken
    },
    payload: {
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      runId: params.runId,
      expectedHeadItemId: params.expectedHeadItemId,
      summaryText: params.summaryText
    }
  });
  assert.equal(res.statusCode, 200, `compact context failed: ${res.body}`);
  return res.json() as { compacted: boolean; summaryItemId: number | null; archivedCount: number };
}

async function archiveSearchInternal(params: {
  app: FastifyInstance;
  internalToken: string;
  workspaceId: string;
  sessionId: string;
  query: string;
  beforePos?: number;
  maxHits?: number;
  maxChars?: number;
  snippet?: boolean;
  regex?: boolean;
}) {
  const res = await params.app.inject({
    method: "POST",
    url: "/api/internal/agent/archive/search",
    headers: {
      "x-awb-agent-internal-token": params.internalToken
    },
    payload: {
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      query: params.query,
      ...(params.beforePos != null ? { beforePos: params.beforePos } : {}),
      ...(params.maxHits ? { maxHits: params.maxHits } : {}),
      ...(params.maxChars ? { maxChars: params.maxChars } : {}),
      ...(params.snippet === true ? { snippet: true } : {}),
      ...(params.regex === true ? { regex: true } : {})
    }
  });
  assert.equal(res.statusCode, 200, `archive search failed: ${res.body}`);
  return res.json() as { text: string };
}

async function archiveReadInternal(params: {
  app: FastifyInstance;
  internalToken: string;
  workspaceId: string;
  sessionId: string;
  beforePos?: number;
  lineCount?: number;
  maxChars?: number;
}) {
  const res = await params.app.inject({
    method: "POST",
    url: "/api/internal/agent/archive/read",
    headers: {
      "x-awb-agent-internal-token": params.internalToken
    },
    payload: {
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      ...(params.beforePos != null ? { beforePos: params.beforePos } : {}),
      ...(params.lineCount ? { lineCount: params.lineCount } : {}),
      ...(params.maxChars ? { maxChars: params.maxChars } : {})
    }
  });
  assert.equal(res.statusCode, 200, `archive read failed: ${res.body}`);
  return res.json() as { text: string };
}

test("agent context 压缩后会归档并支持 archive_search/read", async (t: TestContext) => {
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
    uiLocale: "en-US",
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
    turnId: "turn_archive_1",
    step: 1,
    prevId: null,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "历史问题: 请整理最近的变更"
    }
  });

  const assistantItem = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_archive_1",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "completed",
    output: {
      type: "assistant_text",
      text: "已完成: 新增归档与压缩方案草稿"
    }
  });

  const compact = await compactContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    expectedHeadItemId: assistantItem.item.id,
    summaryText: "压缩摘要: 已归档旧上下文,后续从本摘要继续。"
  });
  assert.equal(compact.compacted, true);
  assert.equal(compact.archivedCount, 2);
  assert.ok((compact.summaryItemId ?? 0) > 0);

  const context = await getContextItems(fixture.app, session.id);
  assert.equal(context.items.length, 3, "transcript should keep archived items visible in UI");
  assert.equal(context.items[0]?.archiveAt == null, false);
  assert.equal(context.items[1]?.archiveAt == null, false);
  assert.equal(context.items[2]?.kind, "system");
  assert.equal(context.items[2]?.boundaryReason, "compaction");
  assert.ok(String(context.items[2]?.output?.text || "").includes("压缩摘要"));

  const promptContext = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });
  const compactSummaryMessage = promptContext.messages.find(
    (item) => item.role === "system" && String(item.content || "").includes("压缩摘要")
  );
  assert.ok(compactSummaryMessage, "compaction summary should participate in prompt messages");

  const summaryIndex = promptContext.messages.findIndex(
    (item) => item.role === "system" && String(item.content || "").includes("压缩摘要")
  );
  const snippetIndex = promptContext.messages.findIndex(
    (item) => item.role === "system" && (String(item.content || "").includes("压缩前尾部摘录") || String(item.content || "").includes("Pre-compaction tail excerpt"))
  );
  assert.ok(snippetIndex >= 0, "compaction snippet should be injected after summary");
  assert.ok(summaryIndex >= 0 && snippetIndex === summaryIndex + 1, "snippet should appear right after compaction summary");

  const snippetMessage = promptContext.messages[snippetIndex] as any;
  assert.ok(String(snippetMessage?.content || "").includes("pos="), "snippet should include pos lines");
  assert.ok(String(snippetMessage?.content || "").includes("archive_read"), "snippet should remind archive_read");
  const archivedUserLeak = promptContext.messages.find(
    (item) => item.role === "user" && String(item.content || "").includes("历史问题")
  );
  assert.equal(archivedUserLeak, undefined, "archived transcript items should not be included in model prompt");

  const forkArchivedVisibleOnlyRes = await fixture.app.inject({
    method: "POST",
    url: "/api/agent/sessions/fork",
    payload: {
      fromSessionId: session.id,
      fromItemId: userItem.item.id,
      mode: "visible_only"
    }
  });
  assert.equal(
    forkArchivedVisibleOnlyRes.statusCode,
    400,
    `fork archived item in visible_only mode should fail: ${forkArchivedVisibleOnlyRes.body}`
  );
  assert.equal(forkArchivedVisibleOnlyRes.json().code, "AGENT_ARCHIVED_ITEM_IMMUTABLE");

  const summaryItemId = context.items[2]?.id ?? 0;
  assert.ok(summaryItemId > 0);

  const forkSystemRes = await fixture.app.inject({
    method: "POST",
    url: "/api/agent/sessions/fork",
    payload: {
      fromSessionId: session.id,
      fromItemId: summaryItemId,
      mode: "with_archive"
    }
  });
  assert.equal(forkSystemRes.statusCode, 400, `fork from system should fail: ${forkSystemRes.body}`);
  assert.equal(forkSystemRes.json().code, "AGENT_FORK_ITEM_KIND_INVALID");

  const afterSummaryUser = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_archive_2",
    step: 1,
    prevId: summaryItemId,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "后续问题: 这个方案需要怎么落地?"
    }
  });

  const afterSummaryAssistant = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_archive_2",
    step: 1,
    prevId: afterSummaryUser.item.id,
    kind: "assistant",
    status: "completed",
    output: {
      type: "assistant_text",
      text: "后续答复: 先做字段与路由改造,再补充测试。"
    }
  });

  const forkArchivedWithArchiveRes = await fixture.app.inject({
    method: "POST",
    url: "/api/agent/sessions/fork",
    payload: {
      fromSessionId: session.id,
      fromItemId: userItem.item.id,
      mode: "with_archive"
    }
  });
  assert.equal(forkArchivedWithArchiveRes.statusCode, 201, `fork archived item in with_archive mode should succeed: ${forkArchivedWithArchiveRes.body}`);
  const forkArchivedWithArchiveSession = forkArchivedWithArchiveRes.json() as { id: string };
  const forkArchivedWithArchiveContext = await getContextItems(fixture.app, forkArchivedWithArchiveSession.id);
  assert.equal(forkArchivedWithArchiveContext.items.length, 1);
  assert.equal(forkArchivedWithArchiveContext.items[0]?.archiveAt, null);

  const forkWithArchiveRes = await fixture.app.inject({
    method: "POST",
    url: "/api/agent/sessions/fork",
    payload: {
      fromSessionId: session.id,
      fromItemId: afterSummaryAssistant.item.id,
      mode: "with_archive"
    }
  });
  assert.equal(forkWithArchiveRes.statusCode, 201, `fork with archive should succeed: ${forkWithArchiveRes.body}`);
  const forkWithArchiveSession = forkWithArchiveRes.json() as { id: string };
  const forkWithArchiveContext = await getContextItems(fixture.app, forkWithArchiveSession.id);
  assert.equal(forkWithArchiveContext.items.length, 5);
  assert.equal(forkWithArchiveContext.items[0]?.archiveAt == null, false);
  assert.equal(forkWithArchiveContext.items[1]?.archiveAt == null, false);
  assert.equal(forkWithArchiveContext.items[2]?.kind, "system");
  assert.equal(forkWithArchiveContext.items[3]?.kind, "user");
  assert.equal(forkWithArchiveContext.items[4]?.kind, "assistant");

  const forkArchiveFilePath = path.join(
    agentArchiveSessionDir(fixture.dataDir, fixture.workspaceId, forkWithArchiveSession.id),
    "00000001.log"
  );
  const forkArchiveContent = await fs.readFile(forkArchiveFilePath, "utf-8");
  assert.ok(forkArchiveContent.includes("历史问题"));
  assert.ok(forkArchiveContent.includes("新增归档与压缩方案草稿"));

  const revertArchivedRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/revert`,
    payload: {
      workspaceId: fixture.workspaceId,
      itemId: userItem.item.id,
      reason: "manual_revert"
    }
  });
  assert.equal(revertArchivedRes.statusCode, 400, `revert archived item should fail: ${revertArchivedRes.body}`);
  assert.equal(revertArchivedRes.json().code, "AGENT_ARCHIVED_ITEM_IMMUTABLE");

  const archiveFilePath = path.join(
    agentArchiveSessionDir(fixture.dataDir, fixture.workspaceId, session.id),
    "00000001.log"
  );
  const archiveContent = await fs.readFile(archiveFilePath, "utf-8");
  assert.ok(archiveContent.includes("历史问题"));
  assert.ok(archiveContent.includes("新增归档与压缩方案草稿"));

  const forkRollbackFixture = await createP4Fixture(t, {
    agentWorkerConcurrency: 0,
    agentTestFaults: {
      archiveWrite: {
        failAfterChunks: 1
      }
    }
  });
  const forkRollbackSession = await createSession(forkRollbackFixture.app, forkRollbackFixture.workspaceId);
  const forkRunId = newSortableId("run");
  const archivedUser = await createContextItemInternal({ fixture: forkRollbackFixture,
    app: forkRollbackFixture.app,
    internalToken: forkRollbackFixture.internalToken,
    workspaceId: forkRollbackFixture.workspaceId,
    sessionId: forkRollbackSession.id,
    runId: forkRunId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "需要被归档复制的历史问题" }
  });
  await createContextItemInternal({ fixture: forkRollbackFixture,
    app: forkRollbackFixture.app,
    internalToken: forkRollbackFixture.internalToken,
    workspaceId: forkRollbackFixture.workspaceId,
    sessionId: forkRollbackSession.id,
    runId: forkRunId,
    turnId: "turn_fork_archive_fail",
    step: 1,
    prevId: archivedUser.item.id,
    kind: "assistant",
    status: "completed",
    output: { type: "assistant_text", text: "需要被归档复制的历史回答" }
  });
  const clearRollbackRes = await forkRollbackFixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${forkRollbackSession.id}/clear`,
    payload: { workspaceId: forkRollbackFixture.workspaceId, reason: "触发归档" }
  });
  assert.equal(clearRollbackRes.statusCode, 200, `clear rollback session failed: ${clearRollbackRes.body}`);

  const liveUser = await createContextItemInternal({ fixture: forkRollbackFixture,
    app: forkRollbackFixture.app,
    internalToken: forkRollbackFixture.internalToken,
    workspaceId: forkRollbackFixture.workspaceId,
    sessionId: forkRollbackSession.id,
    runId: forkRunId,
    turnId: null,
    step: null,
    prevId: clearRollbackRes.json().session.headItemId,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "新的可见问题" }
  });

  const sessionsBefore = forkRollbackFixture.db.prepare(`select count(*) as c from agent_session where workspace_id = ?`).get(forkRollbackFixture.workspaceId) as { c: number };
  const itemsBefore = forkRollbackFixture.db.prepare(`select count(*) as c from agent_context_item where workspace_id = ?`).get(forkRollbackFixture.workspaceId) as { c: number };
  const forkFailRes = await forkRollbackFixture.app.inject({
    method: "POST",
    url: "/api/agent/sessions/fork",
    payload: { fromSessionId: forkRollbackSession.id, fromItemId: liveUser.item.id, mode: "with_archive" }
  });
  assert.equal(forkFailRes.statusCode, 500, `fork with archive failure should bubble: ${forkFailRes.body}`);
  assert.equal(forkFailRes.json().code, "AGENT_FORK_ARCHIVE_FAILED");

  const sessionsAfter = forkRollbackFixture.db.prepare(`select count(*) as c from agent_session where workspace_id = ?`).get(forkRollbackFixture.workspaceId) as { c: number };
  const itemsAfter = forkRollbackFixture.db.prepare(`select count(*) as c from agent_context_item where workspace_id = ?`).get(forkRollbackFixture.workspaceId) as { c: number };
  assert.equal(sessionsAfter.c, sessionsBefore.c, "failed fork should not leave a new session row behind");
  assert.equal(itemsAfter.c, itemsBefore.c, "failed fork should not leave cloned context items behind");

  const forkChildren = forkRollbackFixture.db.prepare(`select id from agent_session where workspace_id = ? and forked_from_session_id = ?`).all(forkRollbackFixture.workspaceId, forkRollbackSession.id) as Array<{ id: string }>;
  assert.equal(forkChildren.length, 0, "failed fork should not leave fork child sessions behind");
  const archiveEntries = await fs.readdir(path.join(forkRollbackFixture.dataDir, "agent", "archive", forkRollbackFixture.workspaceId)).catch(() => [] as string[]);
  assert.deepEqual(archiveEntries, [forkRollbackSession.id], "failed fork should not leave archive dir for forked session behind");

  const search = await archiveSearchInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    query: "归档"
  });
  const searchLines = search.text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  assert.ok(searchLines.length >= 1);
  assert.ok(/^pos=\d+ \| /.test(searchLines[0] || ""), "search output should include pos prefix");

  const searchPage1 = await archiveSearchInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    query: "item=",
    maxHits: 1
  });
  const searchPage1Line = searchPage1.text.trim();
  assert.ok(searchPage1Line.length > 0);
  const searchPage1PosMatch = /^pos=(\d+) \| /.exec(searchPage1Line);
  assert.ok(searchPage1PosMatch, "search page 1 should include pos prefix");
  const searchPage1Pos = Number(searchPage1PosMatch?.[1] || "0");
  assert.ok(searchPage1Pos > 0);

  const searchPage2 = await archiveSearchInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    query: "item=",
    maxHits: 1,
    beforePos: searchPage1Pos
  });
  const searchPage2Line = searchPage2.text.trim();
  const searchPage2PosMatch = /^pos=(\d+) \| /.exec(searchPage2Line);
  assert.ok(searchPage2PosMatch, "search page 2 should include pos prefix");
  const searchPage2Pos = Number(searchPage2PosMatch?.[1] || "0");
  assert.ok(searchPage2Pos > 0 && searchPage2Pos < searchPage1Pos, "beforePos should continue to older hits");

  const optionLikeQuery = await archiveSearchInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    query: "--glob"
  });
  assert.equal(typeof optionLikeQuery.text, "string");

  const readLatest = await archiveReadInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    lineCount: 5
  });
  const readLatestLines = readLatest.text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  assert.ok(readLatestLines.length >= 2);
  const latestFirstPos = Number(/^pos=(\d+) \| /.exec(readLatestLines[0] || "")?.[1] || "0");
  const latestSecondPos = Number(/^pos=(\d+) \| /.exec(readLatestLines[1] || "")?.[1] || "0");
  assert.ok(latestFirstPos > 0 && latestSecondPos > latestFirstPos, "read should be old->new order");

  const readOlder = await archiveReadInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    beforePos: latestSecondPos,
    lineCount: 5
  });
  const readOlderLine = readOlder.text.trim();
  const readOlderPos = Number(/^pos=(\d+) \| /.exec(readOlderLine)?.[1] || "0");
  assert.ok(readOlderPos > 0 && readOlderPos < latestSecondPos, "archive_read.beforePos should only return older lines");

  await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: null,
    step: null,
    prevId: afterSummaryAssistant.item.id,
    kind: "system",
    status: "completed",
    output: {
      type: "system_text",
      text: "[run] max steps exceeded"
    }
  });

  const promptContextAfterRunSystem = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });
  const leakedRunSystemMessage = promptContextAfterRunSystem.messages.find(
    (item) => item.role === "system" && String(item.content || "").includes("[run] max steps exceeded")
  );
  assert.equal(leakedRunSystemMessage, undefined, "runtime run-status system text should not leak into model prompt");
});

test("agent prompt-context 未发生 compaction 时不应注入 compaction snippet", async (t: TestContext) => {
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
    turnId: "turn_nocompact_1",
    step: 1,
    prevId: null,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "hi"
    }
  });
  assert.ok(userItem.item.id > 0);

  const context = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });
  assert.equal(
    context.messages.some((m) => m.role === "system" && String(m.content || "").includes("压缩前尾部摘录")),
    false
  );
});

test("agent prompt-context compaction snippet 缓存缺失时应即时重建", async (t: TestContext) => {
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
    turnId: "turn_compact_cache_1",
    step: 1,
    prevId: null,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "历史问题: cache miss"
    }
  });
  const assistantItem = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_compact_cache_1",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "completed",
    output: {
      type: "assistant_text",
      text: "ok"
    }
  });

  const compact = await compactContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    expectedHeadItemId: assistantItem.item.id,
    summaryText: "压缩摘要: cache test"
  });
  assert.equal(compact.compacted, true);
  assert.ok((compact.summaryItemId ?? 0) > 0);
  const summaryItemId = compact.summaryItemId as number;

  // 首次调用触发生成并写入缓存.
  const ctx1 = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });
  assert.ok(ctx1.messages.some((m) => m.role === "system" && String(m.content || "").includes("Pre-compaction tail excerpt")));

  const cachePath = compactionSnippetPath(fixture.dataDir, fixture.workspaceId, session.id, summaryItemId);
  await fs.rm(cachePath, { force: true });

  // 删除缓存后再次调用,应即时重建并注入.
  const ctx2 = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });
  assert.ok(ctx2.messages.some((m) => m.role === "system" && String(m.content || "").includes("Pre-compaction tail excerpt")));
});

test("compaction snippet 在 zh-CN locale 下保持中文提示", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    uiLocale: "zh-CN",
    status: "running",
    createdAt: Date.now()
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
    output: { type: "user_text", text: "旧上下文" }
  });
  const compact = await compactContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    expectedHeadItemId: userItem.item.id,
    summaryText: "压缩摘要"
  });
  assert.equal(compact.compacted, true);
  const ctx = await getPromptContextInternal({ app: fixture.app, internalToken: fixture.internalToken, workspaceId: fixture.workspaceId, sessionId: session.id, runId });
  assert.ok(ctx.messages.some((m) => m.role === "system" && String(m.content || "").includes("压缩前尾部摘录")));
});

test("archive v2 边界行为: 校验/大小写/跨文件pos/截断/半行过滤", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);

  const archiveDir = agentArchiveSessionDir(fixture.dataDir, fixture.workspaceId, session.id);
  await fs.mkdir(archiveDir, { recursive: true });

  const file1Lines = Array.from({ length: 100 }, (_, idx) => {
    const n = idx + 1;
    const tail = n === 100 ? "BoundaryToken" : `line-${n}`;
    return `item=${n} ts=${n} kind=user status=completed tool=- | ${tail}`;
  });
  const longText = `LONG-${"x".repeat(1300)}`;
  const file2Line1 = `item=101 ts=101 kind=assistant status=completed tool=- | ${longText}`;
  const file2PartialLine = "item=102 ts=102 kind=assistant status=completed tool=- | PartialOnlyToken";

  await fs.writeFile(path.join(archiveDir, "00000001.log"), `${file1Lines.join("\n")}\n`, "utf-8");
  await fs.writeFile(path.join(archiveDir, "00000002.log"), `${file2Line1}\n${file2PartialLine}`, "utf-8");

  const invalidBeforePosRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/archive/search",
    headers: {
      "x-awb-agent-internal-token": fixture.internalToken
    },
    payload: {
      workspaceId: fixture.workspaceId,
      sessionId: session.id,
      query: "token",
      beforePos: 1
    }
  });
  assert.equal(invalidBeforePosRes.statusCode, 400, "beforePos<2 should be rejected");

  const caseInsensitiveSearch = await archiveSearchInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    query: "boundarytoken",
    maxHits: 1
  });
  assert.ok(caseInsensitiveSearch.text.startsWith("pos=100 |"), "search should be case-insensitive and return pos=100");

  const readLatest = await archiveReadInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    lineCount: 1
  });
  assert.ok(readLatest.text.startsWith("pos=101 |"), "latest line should come from file2 line1 with pos=101");

  const readOlder = await archiveReadInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    beforePos: 101,
    lineCount: 1
  });
  assert.ok(readOlder.text.startsWith("pos=100 |"), "beforePos should read strictly older line across file boundary");

  const halfLineSearch = await archiveSearchInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    query: "PartialOnlyToken"
  });
  assert.equal(halfLineSearch.text.trim(), "", "search should ignore unfinished last line without trailing newline");

  const truncatedRead = await archiveReadInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    lineCount: 1,
    maxChars: 1000
  });
  assert.ok(truncatedRead.text.startsWith("pos=101 |"), "truncated output should keep pos prefix");
  assert.ok(
    truncatedRead.text.includes("[超过最大字符数限制,从此处截断内容]"),
    "truncated output should include truncation marker"
  );
});

test("archive_search snippet 模式返回命中窗口并限制单行窗口数量", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const archiveDir = agentArchiveSessionDir(fixture.dataDir, fixture.workspaceId, session.id);
  await fs.mkdir(archiveDir, { recursive: true });

  const repeatedText = `${Array.from({ length: 7 }, (_, idx) => `seg${idx + 1}-${"x".repeat(140)} KEYWORD`).join(" ")} TAILMARK`;
  const line = `item=1 ts=1 kind=user status=completed tool=- | ${repeatedText}`;
  await fs.writeFile(path.join(archiveDir, "00000001.log"), `${line}\n`, "utf-8");

  const fullLineSearch = await archiveSearchInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    query: "keyword",
    maxHits: 1
  });
  const fullLineOutput = fullLineSearch.text.trim();
  assert.ok(fullLineOutput.startsWith("pos=1 | item=1 ts=1 kind=user status=completed tool=- |"));
  assert.equal((fullLineOutput.match(/KEYWORD/g) || []).length, 7, "default search should keep full line by default");

  const regexZeroWidth = await archiveSearchInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    query: "\\b",
    regex: true,
    maxHits: 1
  });
  assert.ok(regexZeroWidth.text.startsWith("pos=1 | item=1 ts=1 kind=user status=completed tool=- |"));

  const regexZeroWidthSnippet = await archiveSearchInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    query: "$",
    regex: true,
    maxHits: 1,
    snippet: true
  });
  assert.ok(regexZeroWidthSnippet.text.includes("TAILMARK"), "snippet+regex zero-width should include tail window");

  const snippetSearch = await archiveSearchInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    query: "keyword",
    maxHits: 1,
    snippet: true
  });
  const snippetOutput = snippetSearch.text.trim();
  assert.ok(snippetOutput.startsWith("pos=1 | item=1 ts=1 kind=user status=completed tool=- |"));
  const keywordCount = (snippetOutput.match(/KEYWORD/g) || []).length;
  assert.ok(keywordCount > 0, "snippet search should include keyword windows");
  assert.ok(keywordCount <= 5, "snippet mode should cap windows per line to 5");
  assert.ok(snippetOutput.includes("..."), "snippet mode should include omission marker between windows");
});
