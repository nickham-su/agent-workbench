import assert from "node:assert/strict";
import test from "node:test";

const [{ mount }, { createI18n }, conversationToolCall, subtaskCard] = await Promise.all([
  import("@vue/test-utils"),
  import("vue-i18n"),
  import("./AgentConversationToolCall.vue"),
  import("./AgentSubtaskCard.vue"),
]);

function timelineExecution(status: "queued" | "running" | "completed") {
  return {
    id: "execution-a",
    callPartId: "call-a",
    status,
    resultPreview: null,
    resultTruncated: false,
    error: null,
    updatedRevision: 2,
    startedAt: 1_000,
    completedAt: status === "completed" ? 3_000 : null,
  } as const;
}

function detail(structuredResult: unknown) {
  return {
    ...timelineExecution("completed"),
    originSessionId: "session-a",
    originRunId: "run-a",
    resultArtifactPath: null,
    structuredResult,
    createdAt: 1_000,
    updatedAt: 3_000,
  } as const;
}

const i18n = createI18n({
  legacy: false,
  locale: "zh-CN",
  messages: {
    "zh-CN": {
      agent: {
        client: {
          subtaskCardTitle: "子任务",
          subtaskAgent: "Agent",
          subtaskMode: "模式",
          subtaskModeFork: "继承上下文",
          subtaskSessionId: "Session ID",
          subtaskStartedAt: "开始时间",
          subtaskDuration: "持续时间",
          copySessionId: "复制 Session ID",
          sessionIdCopied: "已复制 Session ID",
          todoListGoal: "目标",
          todoListEmpty: "当前清单为空",
        },
      },
      common: { copyFailed: "复制失败: {reason}" },
    },
  },
});

const mountGlobal = { plugins: [i18n] };

test("todolist 直接恢复富卡，并在详情失效后自动重新请求", async () => {
  const wrapper = mount(conversationToolCall.default, {
    props: {
      workspaceId: "ws-a",
      toolId: "agent-tool",
      sessionId: "session-a",
      part: {
        id: "call-a",
        messageId: "message-a",
        position: 0,
        updatedRevision: 1,
        createdAt: 1,
        updatedAt: 1,
        type: "tool_call",
        toolName: "todolist",
        input: { goal: "完成改造" },
        providerToolCallId: null,
      },
      execution: timelineExecution("completed"),
      detail: detail({
        goal: "完成改造",
        todos: [{ content: "恢复 UI", status: "completed" }],
      }),
      loading: false,
      now: 3_000,
      todoCollapsed: false,
    },
    global: mountGlobal,
  });

  assert.equal(wrapper.findComponent({ name: "AgentTodoListCard" }).exists(), true);
  assert.equal(wrapper.findComponent({ name: "AgentToolCallRow" }).exists(), false);
  assert.equal(wrapper.text().includes("显示详情"), false);
  assert.equal(wrapper.emitted("request-detail"), undefined);
  await wrapper.setProps({ detail: undefined });
  assert.deepEqual(wrapper.emitted("request-detail"), [["execution-a"]]);
  wrapper.unmount();

  const loadingWrapper = mount(conversationToolCall.default, {
    props: {
      workspaceId: "ws-a",
      toolId: "agent-tool",
      sessionId: "session-a",
      part: {
        id: "call-a",
        messageId: "message-a",
        position: 0,
        updatedRevision: 1,
        createdAt: 1,
        updatedAt: 1,
        type: "tool_call",
        toolName: "todolist",
        input: {},
        providerToolCallId: null,
      },
      execution: timelineExecution("running"),
      loading: true,
      now: 2_000,
    },
    global: mountGlobal,
  });
  assert.equal(loadingWrapper.emitted("request-detail"), undefined);
  await loadingWrapper.setProps({ loading: false });
  assert.deepEqual(loadingWrapper.emitted("request-detail"), [["execution-a"]]);
  loadingWrapper.unmount();
});

test("subtask 完成态显示完成图标，运行态显示 loading 图标", () => {
  const baseProps = {
    input: {
      description: "最终复审 P2 闭环",
      agentId: "reviewer",
      session: { mode: "fork" },
    },
    detail: detail({ subtaskSessionId: "sess_child", resultText: "done" }),
    agentName: "代码审查专家",
    now: 3_000,
  };
  const completed = mount(subtaskCard.default, {
    props: { ...baseProps, execution: timelineExecution("completed") },
    global: mountGlobal,
  });
  assert.equal(completed.findComponent({ name: "CheckCircleOutlined" }).exists(), true);
  assert.equal(completed.findComponent({ name: "LoadingOutlined" }).exists(), false);
  assert.match(completed.text(), /子任务: 最终复审 P2 闭环/);
  assert.match(completed.text(), /Agent: 代码审查专家/);
  completed.unmount();

  const running = mount(subtaskCard.default, {
    props: {
      ...baseProps,
      detail: undefined,
      execution: timelineExecution("running"),
    },
    global: mountGlobal,
  });
  const loadingIcon = running.findComponent({ name: "LoadingOutlined" });
  assert.equal(loadingIcon.exists(), true);
  assert.equal(running.findComponent({ name: "CheckCircleOutlined" }).exists(), false);
  running.unmount();
});
