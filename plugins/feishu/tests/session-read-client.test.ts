import assert from "node:assert/strict";
import test from "node:test";
import { createFeishuSessionReadClient, dispatchFeishuSessionReadCommand } from "../src/index.js";

test("Feishu Session 读侧仅请求 Message/ToolExecution 窄化接口", async () => {
  const calls: Array<{ path: string; options?: { pluginId?: string } }> = [];
  const client = createFeishuSessionReadClient({
    async get(path, options) {
      calls.push({ path, options });
      if (path.includes("last-assistant-text")) return { found: true, text: "  final assistant text  " };
      return {
        isRunning: true,
        execution: {
          structuredResult: { goal: "ship", todos: [{ content: "verify", status: "pending" }] },
          resultPreview: "fallback preview",
          ignoredLegacyShape: { kind: "tool", output: "must not be used" }
        }
      };
    }
  });

  const last = await client.getLastAssistantText({ workspaceId: "workspace / one", sessionId: "session / one" });
  const todo = await client.getLatestTodolist({ workspaceId: "workspace / one", sessionId: "session / one" });

  assert.deepEqual(last, { found: true, text: "final assistant text" });
  assert.deepEqual(todo, {
    isRunning: true,
    execution: {
      structuredResult: { goal: "ship", todos: [{ content: "verify", status: "pending" }] },
      resultPreview: "fallback preview"
    }
  });
  assert.deepEqual(calls, [
    {
      path: "/api/internal/agent/sessions/session%20%2F%20one/last-assistant-text?workspaceId=workspace%20%2F%20one",
      options: { pluginId: "feishu" }
    },
    {
      path: "/api/internal/agent/sessions/session%20%2F%20one/latest-todolist?workspaceId=workspace%20%2F%20one",
      options: { pluginId: "feishu" }
    }
  ]);
  assert.equal(calls.some(({ path }) => path.includes("context-items-tail") || path.includes("status-summary")), false);
});

function commandFixture(input: {
  command: "/l" | "/t";
  binding?: { workspaceId: string | null; sessionId: string | null } | null;
  last?: { found: boolean; text: string } | Error;
  todo?: { isRunning: boolean; execution: { structuredResult: unknown; resultPreview: string | null } | null } | Error;
}) {
  const replies: string[] = [];
  const calls: string[] = [];
  const sessionReads = {
    async getLastAssistantText() {
      calls.push("last");
      if (input.last instanceof Error) throw input.last;
      return input.last ?? { found: false, text: "" };
    },
    async getLatestTodolist() {
      calls.push("todo");
      if (input.todo instanceof Error) throw input.todo;
      return input.todo ?? { isRunning: false, execution: null };
    }
  };
  return {
    calls,
    replies,
    dispatch: () => dispatchFeishuSessionReadCommand({
      command: input.command,
      binding: input.binding === undefined ? { workspaceId: "workspace-1", sessionId: "session-1" } : input.binding,
      sessionReads,
      replyText: async (text) => { replies.push(text); }
    })
  };
}

test("Feishu /l dispatch 覆盖有结果、空结果、未绑定与 API 错误", async () => {
  const found = commandFixture({ command: "/l", last: { found: true, text: "final text" } });
  assert.equal(await found.dispatch(), true);
  assert.deepEqual(found.replies, ["final text"]);
  assert.deepEqual(found.calls, ["last"]);

  const empty = commandFixture({ command: "/l" });
  await empty.dispatch();
  assert.deepEqual(empty.replies, ["当前会话暂无 assistant 消息"]);

  const unbound = commandFixture({ command: "/l", binding: null });
  await unbound.dispatch();
  assert.deepEqual(unbound.replies, ["请先使用 /ss 绑定会话"]);
  assert.deepEqual(unbound.calls, []);

  const failed = commandFixture({ command: "/l", last: new Error("API unavailable") });
  await failed.dispatch();
  assert.deepEqual(failed.replies, ["读取最后一条 assistant 消息失败，请稍后重试"]);
});

test("Feishu /t dispatch 优先 structuredResult、回退 preview，并处理空、未绑定与 API 错误", async () => {
  const structured = commandFixture({
    command: "/t",
    todo: {
      isRunning: true,
      execution: {
        structuredResult: { goal: "ship", todos: [{ content: "verify", status: "pending" }] },
        resultPreview: "must not use"
      }
    }
  });
  assert.equal(await structured.dispatch(), true);
  assert.deepEqual(structured.replies, ["当前会话正在运行中\n目标：ship\n○ verify"]);
  assert.deepEqual(structured.calls, ["todo"]);

  const preview = commandFixture({
    command: "/t",
    todo: { isRunning: false, execution: { structuredResult: null, resultPreview: "preview fallback" } }
  });
  await preview.dispatch();
  assert.deepEqual(preview.replies, ["preview fallback"]);

  const empty = commandFixture({ command: "/t" });
  await empty.dispatch();
  assert.deepEqual(empty.replies, ["当前会话未找到 todolist 记录"]);

  const unbound = commandFixture({ command: "/t", binding: { workspaceId: null, sessionId: null } });
  await unbound.dispatch();
  assert.deepEqual(unbound.replies, ["请先使用 /ss 绑定会话"]);
  assert.deepEqual(unbound.calls, []);

  const failed = commandFixture({ command: "/t", todo: new Error("API unavailable") });
  await failed.dispatch();
  assert.deepEqual(failed.replies, ["读取 todolist 失败，请稍后重试"]);
});
