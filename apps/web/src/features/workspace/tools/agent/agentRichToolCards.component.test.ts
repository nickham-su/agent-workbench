import assert from "node:assert/strict";
import test from "node:test";
import type { AgentToolExecutionStatus } from "@agent-workbench/shared";

const [{ mount, flushPromises }, { createI18n }, conversationToolCall, subtaskCard, toolCallRow, { message, Button }, zhCN, enUS] = await Promise.all([
  import("@vue/test-utils"),
  import("vue-i18n"),
  import("./AgentConversationToolCall.vue"),
  import("./AgentSubtaskCard.vue"),
  import("./AgentToolCallRow.vue"),
  import("ant-design-vue"),
  import("@/shared/i18n/locales/zh-CN"),
  import("@/shared/i18n/locales/en-US"),
]);

function timelineExecution(status: AgentToolExecutionStatus) {
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
    "zh-CN": zhCN.default,
    "en-US": enUS.default,
  },
});

const mountGlobal = { plugins: [i18n], components: { AButton: Button } };

// 复用实际 SFC 与复制回退；仅替换浏览器剪贴板及全局通知，结束后还原。
function mockCopyEnvironment(
  writeText: ((content: string) => Promise<void>) | undefined,
  execCommand: (command: string) => boolean,
) {
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const originalExecCommand = document.execCommand;
  const originalSuccess = message.success;
  const originalError = message.error;
  const successes: unknown[] = [];
  const errors: unknown[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: writeText ? { writeText } : undefined,
  });
  document.execCommand = execCommand as typeof document.execCommand;
  message.success = ((content: unknown) => { successes.push(content); }) as typeof message.success;
  message.error = ((content: unknown) => { errors.push(content); }) as typeof message.error;
  return {
    successes,
    errors,
    restore() {
      if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
      else delete (navigator as { clipboard?: unknown }).clipboard;
      document.execCommand = originalExecCommand;
      message.success = originalSuccess;
      message.error = originalError;
    },
  };
}

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

test("subtask 卡片从完整 Agent 名称映射显示 subtask 专属角色，并在未匹配时回退 ID", () => {
  const part = {
    id: "call-subtask",
    messageId: "message-a",
    position: 0,
    updatedRevision: 1,
    createdAt: 1,
    updatedAt: 1,
    type: "tool_call" as const,
    toolName: "subtask",
    input: {
      description: "检查实现",
      agentId: "subtask-only",
      session: { mode: "fork" },
    },
    providerToolCallId: null,
  };
  const baseProps = {
    workspaceId: "ws-a",
    toolId: "agent-tool",
    sessionId: "session-a",
    part,
    execution: timelineExecution("completed"),
    detail: detail({ subtaskSessionId: "sess_child", resultText: "done" }),
    loading: false,
    now: 3_000,
  };

  const resolved = mount(conversationToolCall.default, {
    props: {
      ...baseProps,
      subtaskAgentLabels: { "subtask-only": "子任务审查专家" },
    },
    global: mountGlobal,
  });
  assert.match(resolved.text(), /Agent: 子任务审查专家/);
  resolved.unmount();

  const unmatched = mount(conversationToolCall.default, {
    props: {
      ...baseProps,
      subtaskAgentLabels: {},
    },
    global: mountGlobal,
  });
  assert.match(unmatched.text(), /Agent: subtask-only/);
  unmatched.unmount();
});

test("普通工具完成态不显示图标，弱化为浅灰耗时文本", () => {
  const wrapper = mount(toolCallRow.default, {
    props: {
      toolName: "bash",
      input: { command: "pwd" },
      execution: timelineExecution("completed"),
      now: 4_000,
    },
  });
  assert.equal(wrapper.findComponent({ name: "CheckCircleOutlined" }).exists(), false);
  assert.match(wrapper.text(), /2s/);
  wrapper.unmount();
});

test("普通工具非完成状态显示对应图标", () => {
  const cases = [
    ["running", "LoadingOutlined"],
    ["failed", "ExclamationCircleOutlined"],
    ["queued", "ClockCircleOutlined"],
    ["cancelled", "CloseCircleOutlined"],
    ["unknown", "QuestionCircleOutlined"],
  ] as const;

  for (const [status, iconName] of cases) {
    const wrapper = mount(toolCallRow.default, {
      props: {
        toolName: "bash",
        input: { command: "pwd" },
        execution: timelineExecution(status),
        now: 4_000,
      },
    });
    const icon = wrapper.findComponent({ name: iconName });
    assert.equal(icon.exists(), true, status);
    if (status === "running") {
      assert.equal(wrapper.find(".anticon-spin").exists(), true);
    }
    wrapper.unmount();
  }
});

test("显式 Fork 卡片在加载、失败和历史终态均显示请求来源，目标仍来自详情", () => {
  for (const status of ["queued", "running", "failed", "completed", "cancelled", "unknown"] as const) {
    const wrapper = mount(subtaskCard.default, {
      props: {
        input: { description: "指定来源", session: { mode: "fork", sourceSessionId: "  session-a \n" } },
        execution: { ...timelineExecution(status), error: status === "failed" ? "start failed" : null },
        detail: status === "completed" ? detail({ subtaskSessionId: "sess_child", sourceSessionId: "sess_conflict" }) : undefined,
        now: 3_000,
      },
      global: mountGlobal,
    });
    try {
      assert.match(wrapper.text(), /来源 Session ID: session-a/);
      assert.equal(wrapper.text().includes("sess_conflict"), false);
      assert.equal(wrapper.find('[aria-label="复制来源 Session ID"]').exists(), true);
      assert.equal(wrapper.find('[aria-label="复制 Session ID"]').exists(), status === "completed");
      if (status === "completed") assert.match(wrapper.text(), /Session ID: sess_child/);
      if (status === "failed") assert.match(wrapper.text(), /Error: start failed/);
    } finally {
      wrapper.unmount();
    }
  }
});

test("卡片拒绝非显式模式、兼容 mode 和非法来源，不从结果推断来源", () => {
  const inputs: Record<string, unknown>[] = [
    ...["new", "existing", "unknown", " fork ", undefined].map((mode) => ({
      mode: "fork", session: { mode, sourceSessionId: "sess_source" },
    })),
    { session: { mode: "fork" } },
    { mode: "fork", sourceSessionId: "sess_source" },
    { mode: "fork", session: { sourceSessionId: "sess_source" } },
    { session: { mode: "fork", sessionId: "sess_alias" }, sessionId: "sess_caller" },
    ...[null, 1, true, [], ["sess_source"], {}, "", " \n\t "].map((sourceSessionId) => ({
      session: { mode: "fork", sourceSessionId },
    })),
  ];
  for (const input of inputs) {
    const wrapper = mount(subtaskCard.default, {
      props: {
        input,
        execution: timelineExecution("completed"),
        detail: detail({ subtaskSessionId: "sess_child", sourceSessionId: "sess_result", resultText: "sourceSessionId=sess_text" }),
        now: 3_000,
      },
      global: mountGlobal,
    });
    try {
      assert.equal(wrapper.text().includes("来源 Session ID"), false, JSON.stringify(input));
      assert.equal(wrapper.find('[aria-label="复制来源 Session ID"]').exists(), false);
      assert.match(wrapper.text(), /Session ID: sess_child/);
    } finally {
      wrapper.unmount();
    }
  }
});

test("会话工具卡直接传递指定来源，并始终仅打开执行目标 Child", async () => {
  const wrapper = mount(conversationToolCall.default, {
    props: {
      workspaceId: "ws-a",
      toolId: "agent-tool",
      sessionId: "session-a",
      part: {
        id: "call-a", messageId: "message-a", position: 0, updatedRevision: 1, createdAt: 1, updatedAt: 1,
        type: "tool_call", toolName: "subtask", providerToolCallId: null,
        input: { session: { mode: "fork", sourceSessionId: "session-a" } },
      },
      execution: timelineExecution("completed"),
      detail: detail({ subtaskSessionId: "sess_child" }),
      loading: false,
      now: 3_000,
    },
    global: mountGlobal,
  });
  try {
    assert.match(wrapper.text(), /来源 Session ID: session-a/);
    await wrapper.get(".subtask-card").trigger("click");
    assert.deepEqual(wrapper.emitted("open-subtask"), [["sess_child"]]);
  } finally {
    wrapper.unmount();
  }
});

test("长来源 ID 使用可换行文本及独立复制按钮，不注入 HTML 或隐藏目标 ID", () => {
  const sourceSessionId = `sess_${"long-id-".repeat(80)}<img src=x>`;
  const wrapper = mount(subtaskCard.default, {
    props: {
      input: { session: { mode: "fork", sourceSessionId } },
      execution: timelineExecution("completed"),
      detail: detail({ subtaskSessionId: "sess_child" }),
      now: 3_000,
    },
    global: mountGlobal,
  });
  try {
    assert.equal(wrapper.text().includes(sourceSessionId), true);
    assert.equal(wrapper.find("img").exists(), false);
    const sourceButton = wrapper.get('[aria-label="复制来源 Session ID"]');
    const sourceText = sourceButton.element.parentElement?.querySelector("span");
    assert.equal(sourceText?.classList.contains("[overflow-wrap:anywhere]"), true);
    assert.equal(sourceButton.classes().includes("shrink-0"), true);
    assert.match(wrapper.text(), /Session ID: sess_child/);
    assert.equal(wrapper.find('[aria-label="复制 Session ID"]').exists(), true);
  } finally {
    wrapper.unmount();
  }
});

test("来源标签及复制按钮使用实际中英文翻译，区分目标 Session", () => {
  for (const [locale, label, copyLabel] of [
    ["zh-CN", "来源 Session ID", "复制来源 Session ID"],
    ["en-US", "Source Session ID", "Copy source Session ID"],
  ] as const) {
    const localeI18n = createI18n({ legacy: false, locale, messages: { "zh-CN": zhCN.default, "en-US": enUS.default } });
    const wrapper = mount(subtaskCard.default, {
      props: {
        input: { session: { mode: "fork", sourceSessionId: "sess_source" } },
        execution: timelineExecution("completed"),
        detail: detail({ subtaskSessionId: "sess_child" }),
        now: 3_000,
      },
      global: { plugins: [localeI18n], components: { AButton: Button } },
    });
    try {
      assert.equal(wrapper.text().includes(`${label}: sess_source`), true);
      assert.equal(wrapper.find(`[aria-label="${copyLabel}"]`).exists(), true);
      assert.equal(wrapper.find(`[aria-label="${localeI18n.global.t("agent.client.copySessionId")}"]`).exists(), true);
    } finally {
      wrapper.unmount();
    }
  }
});

test("来源与目标分别复制规范 ID 并反馈成功，复制不触发 Child 导航", async (t) => {
  const copied: string[] = [];
  const environment = mockCopyEnvironment(async (content) => { copied.push(content); }, () => {
    throw new Error("fallback should not run");
  });
  t.after(() => environment.restore());
  const wrapper = mount(subtaskCard.default, {
    props: {
      input: { session: { mode: "fork", sourceSessionId: "  sess_source  " } },
      execution: timelineExecution("completed"),
      detail: detail({ subtaskSessionId: "sess_child" }),
      now: 3_000,
    },
    global: mountGlobal,
  });
  t.after(() => wrapper.unmount());
  await wrapper.get('[aria-label="复制来源 Session ID"]').trigger("click");
  await wrapper.get('[aria-label="复制 Session ID"]').trigger("click");
  await flushPromises();
  assert.deepEqual(copied, ["sess_source", "sess_child"]);
  assert.equal(environment.successes.length, 2);
  assert.deepEqual(environment.errors, []);
  assert.equal(wrapper.emitted("open-subtask"), undefined);
  await wrapper.get(".subtask-card").trigger("click");
  assert.deepEqual(wrapper.emitted("open-subtask"), [["sess_child"]]);
});

test("Clipboard 缺失或拒绝后来源与目标均复用 execCommand 回退并清理临时节点", async () => {
  for (const writeText of [undefined, async () => { throw new Error("denied"); }]) {
    const copied: string[] = [];
    const environment = mockCopyEnvironment(writeText, (command) => {
      assert.equal(command, "copy");
      copied.push((document.activeElement as HTMLTextAreaElement).value);
      return true;
    });
    const wrapper = mount(subtaskCard.default, {
      props: {
        input: { session: { mode: "fork", sourceSessionId: "sess_source" } },
        execution: timelineExecution("completed"),
        detail: detail({ subtaskSessionId: "sess_child" }),
        now: 3_000,
      },
      global: mountGlobal,
    });
    try {
      const before = document.body.querySelectorAll("textarea").length;
      await wrapper.get('[aria-label="复制来源 Session ID"]').trigger("click");
      await wrapper.get('[aria-label="复制 Session ID"]').trigger("click");
      await flushPromises();
      assert.deepEqual(copied, ["sess_source", "sess_child"]);
      assert.equal(environment.successes.length, 2);
      assert.deepEqual(environment.errors, []);
      assert.equal(document.body.querySelectorAll("textarea").length, before);
      assert.equal(wrapper.emitted("open-subtask"), undefined);
    } finally {
      wrapper.unmount();
      environment.restore();
    }
  }
});

test("来源复制回退失败保留错误反馈，不产生导航或成功通知", async () => {
  for (const execCommand of [() => false, () => { throw new Error("copy denied"); }]) {
    const environment = mockCopyEnvironment(undefined, execCommand);
    const wrapper = mount(subtaskCard.default, {
      props: {
        input: { session: { mode: "fork", sourceSessionId: "sess_source" } },
        execution: timelineExecution("queued"),
        now: 3_000,
      },
      global: mountGlobal,
    });
    try {
      const before = document.body.querySelectorAll("textarea").length;
      await wrapper.get('[aria-label="复制来源 Session ID"]').trigger("click");
      await flushPromises();
      assert.deepEqual(environment.successes, []);
      assert.equal(environment.errors.length, 1);
      assert.match(String(environment.errors[0]), /复制失败/);
      assert.equal(document.body.querySelectorAll("textarea").length, before);
      assert.equal(wrapper.emitted("open-subtask"), undefined);
    } finally {
      wrapper.unmount();
      environment.restore();
    }
  }
});
