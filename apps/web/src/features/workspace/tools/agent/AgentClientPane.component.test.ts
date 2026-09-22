import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage, AgentMessageSessionRunState } from "@agent-workbench/shared";
import { computed, defineComponent, h, KeepAlive, ref, type ComputedRef } from "vue";

const [{ mount }, component, { createI18n }, { nextTick, reactive }, { agentSessionStatusStoreKey }, { message, Modal }, { replaceAgentTimelineSnapshot }] = await Promise.all([
  import("@vue/test-utils"),
  import("./AgentClientPane.vue"),
  import("vue-i18n"),
  import("vue"),
  import("./useAgentSessionStatusStore"),
  import("ant-design-vue"),
  import("./agentMessageTimeline"),
]);

const AgentClientPane = component.default.__vccOpts ?? component.default;

const baseRunState = (overrides: Partial<AgentMessageSessionRunState> = {}): AgentMessageSessionRunState => reactive({
  workspaceId: "ws-a",
  sessionId: "session-a",
  status: "idle",
  activeRunId: null,
  runNoticeText: "",
  retryCount: 0,
  nextRetryAt: null,
  activeAssistantMessageId: null,
  nonTerminalMessageIds: [],
  nonTerminalToolExecutionIds: [],
  updatedAt: 1,
  ...overrides,
});

function createKeyboardEvent(key: string, shiftKey = false) {
  const event = new Event("keydown", { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    key: { value: key },
    shiftKey: { value: shiftKey },
    isComposing: { value: false },
    ctrlKey: { value: false },
    altKey: { value: false },
    metaKey: { value: false },
  });
  return event;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const componentStubs = {
  "a-select": true,
  "a-modal": true,
  "a-tag": true,
  "a-alert": true,
  "a-checkbox": true,
  "a-checkbox-group": true,
  "a-cascader": true,
  EditOutlined: true,
  CopyOutlined: true,
  FileImageOutlined: true,
  RobotOutlined: true,
  AppstoreOutlined: true,
  DownOutlined: true,
  LoadingOutlined: true,
  AgentAttachmentPreviewModal: true,
  AgentConversationToolCall: true,
  AgentMessageActions: true,
  AgentUserMessage: true,
  AssistantMarkdownMessage: true,
};

function agentMessage(overrides: Partial<AgentMessage> & Pick<AgentMessage, "id">): AgentMessage {
  return {
    workspaceId: "ws-a",
    previousMessageId: null,
    replacesMessageId: null,
    depth: 0,
    type: "assistant",
    status: "completed",
    originSessionId: null,
    originRunId: null,
    inCurrentOperationRange: undefined,
    updatedRevision: 1,
    createdAt: 1,
    updatedAt: 1,
    parts: [],
    ...overrides,
  } as AgentMessage;
}

function timelineSnapshot(messages: AgentMessage[]) {
  return {
    session: {
      id: "session-a", workspaceId: "ws-a", title: "Session A", kind: "primary" as const,
      headMessageId: messages.at(-1)?.id ?? null, contextRootMessageId: null, revision: 1,
      forkedFromSessionId: null, forkedFromMessageId: null, createdAt: 1, updatedAt: 1,
    },
    timelineReset: false,
    messages,
    toolExecutions: [],
  };
}

function createMountGlobal(statusStore: { getRunState: () => ComputedRef<AgentMessageSessionRunState> }) {
  const i18n = createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": { agent: { client: { imageCount: "{count} 张图片" } } } } });
  return {
    plugins: [i18n],
    provide: { [agentSessionStatusStoreKey as symbol]: statusStore },
    stubs: componentStubs,
  };
}

function mountPane(options?: {
  runState?: AgentMessageSessionRunState;
  active?: boolean;
  sessionReady?: boolean;
  modelValue?: string;
  initialDraft?: string;
  ensureSession?: (sessionId: string) => Promise<string>;
  forkSession?: (request: { fromSessionId: string; fromMessageId: string }) => Promise<{ id: string }>;
}) {
  const runState = options?.runState ?? baseRunState();
  const statusStore = { getRunState: () => computed(() => runState) };
  const wrapper = mount(AgentClientPane, {
    attachTo: document.body,
    props: {
      workspaceId: "ws-a",
      toolId: "agent-tool",
      sessionId: "session-a",
      sessionKind: "primary",
      sessionTitle: "Session A",
      sessionReady: options?.sessionReady ?? false,
      active: options?.active ?? false,
      modelValue: options?.modelValue ?? "agent-b",
      agentOptions: [
        { value: "agent-a", label: "Agent A" },
        { value: "agent-b", label: "Agent B" },
        { value: "agent-c", label: "Agent C" },
      ],
      sessionModelStates: {},
      sessionModelStateLoading: false,
      sessionModelMutationPending: false,
      modelOpenIntent: null,
      initialDraft: options?.initialDraft,
      ensureSession: options?.ensureSession,
      forkSession: options?.forkSession,
    },
    global: createMountGlobal(statusStore),
  });
  return {
    wrapper,
    runState,
    setRunState: (next: Partial<AgentMessageSessionRunState>) => Object.assign(runState, next),
  };
}

async function setTimeline(wrapper: ReturnType<typeof mount>, messages: AgentMessage[]) {
  const vm = wrapper.vm as unknown as { timelineState: unknown };
  const state = replaceAgentTimelineSnapshot({ revision: 0, messages: [], toolExecutions: [] }, timelineSnapshot(messages));
  const exposed = vm.timelineState as { value?: unknown };
  if ("value" in exposed) exposed.value = state;
  else (vm as { timelineState: unknown }).timelineState = state;
  await nextTick();
}

function mountCachedPane() {
  const visible = ref(true);
  const runState = baseRunState();
  const statusStore = { getRunState: () => computed(() => runState) };
  const host = mount(defineComponent({
    setup() {
      return () => h(KeepAlive, null, {
        default: () => visible.value
          ? h(AgentClientPane, {
            workspaceId: "ws-a",
            toolId: "agent-tool",
            sessionId: "session-a",
            sessionKind: "primary",
            sessionTitle: "Session A",
            sessionReady: false,
            active: false,
            modelValue: "agent-b",
            agentOptions: [],
            sessionModelStates: {},
            sessionModelStateLoading: false,
            sessionModelMutationPending: false,
            modelOpenIntent: null,
          })
          : h("div"),
      });
    },
  }), {
    attachTo: document.body,
    global: createMountGlobal(statusStore),
  });
  return { host, visible };
}

function setScrollMetrics(el: HTMLElement, scrollHeight: number, clientHeight: number) {
  Object.defineProperties(el, {
    scrollHeight: { configurable: true, value: scrollHeight },
    clientHeight: { configurable: true, value: clientHeight },
  });
}

async function waitForScrollRestore() {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

function cachedPaneVm(host: ReturnType<typeof mount>) {
  return host.getComponent(AgentClientPane).vm as unknown as {
    loadingPreviousPageScope: unknown;
  };
}

test("真实 AgentClientPane：KeepAlive 切换工具后恢复会话滚动位置，底部保持跟随新内容", async () => {
  const { host, visible } = mountCachedPane();
  try {
    const scrollEl = host.get("main").element as HTMLElement;
    setScrollMetrics(scrollEl, 1_000, 200);
    scrollEl.scrollTop = 320;
    scrollEl.dispatchEvent(new Event("scroll"));

    visible.value = false;
    await nextTick();
    // 模拟浏览器在缓存 DOM 脱离可见树时丢失原生 scrollTop。
    scrollEl.scrollTop = 0;
    visible.value = true;
    await waitForScrollRestore();
    assert.equal(scrollEl.scrollTop, 320);

    scrollEl.scrollTop = 800;
    scrollEl.dispatchEvent(new Event("scroll"));
    visible.value = false;
    await nextTick();
    scrollEl.scrollTop = 0;
    // 缓存期间新增消息；回到会话时原先在底部的用户仍应留在新底部。
    setScrollMetrics(scrollEl, 1_400, 200);
    visible.value = true;
    await waitForScrollRestore();
    assert.equal(scrollEl.scrollTop, 1_200);
  } finally {
    host.unmount();
  }
});

test("真实 AgentClientPane：距底部不足 120px 但未到底时，切回后仍恢复原位置", async () => {
  const { host, visible } = mountCachedPane();
  try {
    const scrollEl = host.get("main").element as HTMLElement;
    setScrollMetrics(scrollEl, 1_000, 200);
    // 保持原有 120px 自动跟随语义，但这不是严格的滚动到底。
    scrollEl.scrollTop = 750;
    scrollEl.dispatchEvent(new Event("scroll"));

    visible.value = false;
    await nextTick();
    scrollEl.scrollTop = 0;
    setScrollMetrics(scrollEl, 1_400, 200);
    visible.value = true;
    await waitForScrollRestore();

    assert.equal(scrollEl.scrollTop, 750);
  } finally {
    host.unmount();
  }
});

test("真实 AgentClientPane：恢复窗口的临时顶部 scroll 不加载历史分页", async () => {
  const { host, visible } = mountCachedPane();
  try {
    const scrollEl = host.get("main").element as HTMLElement;
    setScrollMetrics(scrollEl, 1_000, 200);
    scrollEl.scrollTop = 320;
    scrollEl.dispatchEvent(new Event("scroll"));

    visible.value = false;
    await nextTick();
    scrollEl.scrollTop = 0;
    visible.value = true;
    await nextTick();
    // 在 rAF 恢复前模拟浏览器重挂载时发出的临时顶部 scroll 事件。
    scrollEl.dispatchEvent(new Event("scroll"));
    assert.equal(cachedPaneVm(host).loadingPreviousPageScope, null);
    await waitForScrollRestore();
    assert.equal(scrollEl.scrollTop, 320);
  } finally {
    host.unmount();
  }
});

test("真实 AgentClientPane：恢复窗口内的用户滚动意图会取消旧位置恢复", async () => {
  const { host, visible } = mountCachedPane();
  try {
    const scrollEl = host.get("main").element as HTMLElement;
    setScrollMetrics(scrollEl, 1_000, 200);
    scrollEl.scrollTop = 320;
    scrollEl.dispatchEvent(new Event("scroll"));

    visible.value = false;
    await nextTick();
    scrollEl.scrollTop = 0;
    visible.value = true;
    await nextTick();
    // wheel 在 window capture 阶段取消 pending restore，随后实际 scroll 更新用户选定的位置。
    scrollEl.dispatchEvent(new Event("wheel", { bubbles: true }));
    scrollEl.scrollTop = 450;
    scrollEl.dispatchEvent(new Event("scroll"));
    await waitForScrollRestore();

    assert.equal(scrollEl.scrollTop, 450);
  } finally {
    host.unmount();
  }
});

test("真实 AgentClientPane：历史与当前消息分别渲染 Fork/Revert 操作", async () => {
  const { wrapper } = mountPane({ sessionReady: false });
  try {
    const toolPart = (id: string, position: number, toolName: "bash" | "read") => ({
      id, messageId: "current-assistant", position, type: "tool_call" as const, toolName,
      input: {}, providerToolCallId: null, updatedRevision: 1, createdAt: 1_000, updatedAt: 1_000,
    });
    const timelineMessages = [
      agentMessage({ id: "old-user", type: "user", inCurrentOperationRange: false }),
      agentMessage({
        id: "old-assistant", type: "assistant", inCurrentOperationRange: false,
        createdAt: 1, updatedAt: 2_501,
      }),
      agentMessage({ id: "current-user", type: "user", inCurrentOperationRange: true }),
      agentMessage({
        id: "current-assistant", type: "assistant", inCurrentOperationRange: true,
        createdAt: 1, updatedAt: 3_201,
        parts: [
          toolPart("call-bash-a", 0, "bash"),
          toolPart("call-bash-b", 1, "bash"),
          toolPart("call-read", 2, "read"),
        ],
      }),
      agentMessage({ id: "summary", type: "compaction", inCurrentOperationRange: true }),
    ];
    await setTimeline(wrapper, timelineMessages);
    assert.deepEqual((wrapper.vm as unknown as { timelineState: { messages: AgentMessage[] } }).timelineState.messages.map((item) => [item.id, item.inCurrentOperationRange]), [...timelineMessages].sort((left, right) => left.id.localeCompare(right.id)).map((item) => [item.id, item.inCurrentOperationRange]));
    const actionComponents = wrapper.findAllComponents({ name: "AgentMessageActions" });
    const actionByMessageId = new Map(
      actionComponents.map((action) => [
        action.element.parentElement?.getAttribute("data-message-id"),
        {
          messageId: action.props("messageId"),
          showFork: action.props("showFork"),
          showRevert: action.props("showRevert"),
        },
      ]),
    );
    assert.deepEqual(actionByMessageId.get("old-user"), { messageId: "old-user", showFork: true, showRevert: false });
    assert.deepEqual(actionByMessageId.get("old-assistant"), { messageId: "old-assistant", showFork: true, showRevert: false });
    assert.deepEqual(actionByMessageId.get("current-user"), { messageId: "current-user", showFork: true, showRevert: true });
    assert.deepEqual(actionByMessageId.get("current-assistant"), { messageId: "current-assistant", showFork: true, showRevert: false });
    assert.equal(actionByMessageId.has("summary"), false);

    const actionFor = (messageId: string) => actionComponents.find(
      (action) => action.element.parentElement?.getAttribute("data-message-id") === messageId,
    )!;
    assert.notEqual(actionFor("old-user").props("timeText"), "");
    assert.equal(actionFor("old-user").props("toolsText"), "");
    assert.equal(actionFor("current-assistant").props("toolsText"), "bash ×2, read");
  } finally {
    wrapper.unmount();
  }
});

test("真实 AgentClientPane：无内容 Assistant 保留单个 Fork 的可交互锚点", async () => {
  const { wrapper } = mountPane({ sessionReady: false });
  try {
    await setTimeline(wrapper, [agentMessage({ id: "empty-assistant", type: "assistant", parts: [] })]);
    const row = wrapper.get('article[data-message-id="empty-assistant"]');
    assert.equal(row.attributes("style"), "min-height: 1.75rem;");
    assert.equal(row.findAllComponents({ name: "AgentMessageActions" }).length, 1);
    const action = row.getComponent({ name: "AgentMessageActions" });
    assert.equal(action.props("showFork"), true);
    assert.equal(action.props("showRevert"), false);
  } finally {
    wrapper.unmount();
  }
});

test("真实 AgentClientPane：同一消息的图片以无边框纯文字汇总张数", async () => {
  const { wrapper } = mountPane({ sessionReady: false });
  try {
    await setTimeline(wrapper, [
      agentMessage({
        id: "user-images",
        type: "user",
        parts: [
          { id: "text", messageId: "user-images", position: 0, type: "text", text: "查看图片", updatedRevision: 1, createdAt: 1, updatedAt: 1 },
          { id: "image-a", messageId: "user-images", position: 1, type: "image", attachmentId: "attachment-a", mediaType: "image/png", filename: "a.png", updatedRevision: 1, createdAt: 1, updatedAt: 1 },
          { id: "image-b", messageId: "user-images", position: 2, type: "image", attachmentId: "attachment-b", mediaType: "image/jpeg", filename: "b.jpg", updatedRevision: 1, createdAt: 1, updatedAt: 1 },
        ],
      }),
    ]);

    const rows = wrapper.findAll('article[data-message-id="user-images"]');
    assert.equal(rows.length, 2);
    assert.match(rows[0]!.classes().join(" "), /border-blue-500\/60/);
    assert.equal(rows[1]!.classes().includes("border"), false);

    const imageText = rows[1]!.get("button");
    assert.equal(imageText.text(), "2 张图片");
    assert.equal(imageText.findAllComponents({ name: "FileImageOutlined" }).length, 0);
    await imageText.trigger("click");
    assert.equal(wrapper.getComponent({ name: "AgentAttachmentPreviewModal" }).props("count"), 2);
  } finally {
    wrapper.unmount();
  }
});

test("真实 AgentClientPane：连续思考链合并展示，工具调用会断开分组", async () => {
  const { wrapper } = mountPane({ sessionReady: false });
  try {
    await setTimeline(wrapper, [
      agentMessage({
        id: "reasoning-assistant",
        parts: [
          { id: "reason-1", messageId: "reasoning-assistant", position: 0, type: "reasoning", text: "first", updatedRevision: 1, createdAt: 1, updatedAt: 1 },
          { id: "reason-2", messageId: "reasoning-assistant", position: 1, type: "reasoning", text: "second", updatedRevision: 1, createdAt: 1, updatedAt: 1 },
          { id: "call", messageId: "reasoning-assistant", position: 2, type: "tool_call", toolName: "read", input: {}, providerToolCallId: null, updatedRevision: 1, createdAt: 1, updatedAt: 1 },
          { id: "reason-3", messageId: "reasoning-assistant", position: 3, type: "reasoning", text: "third", updatedRevision: 1, createdAt: 1, updatedAt: 1 },
          { id: "reason-4", messageId: "reasoning-assistant", position: 4, type: "reasoning", text: "fourth", updatedRevision: 1, createdAt: 1, updatedAt: 1 },
        ],
      }),
    ]);

    const rows = wrapper.findAll('article[data-message-id="reasoning-assistant"]');
    assert.equal(rows.length, 3);

    const reasoningMessages = wrapper.findAllComponents({ name: "AssistantMarkdownMessage" });
    assert.equal(reasoningMessages.length, 2);
    assert.deepEqual(reasoningMessages.map((component) => component.props("text")), [
      "first\n\nsecond",
      "third\n\nfourth",
    ]);
  } finally {
    wrapper.unmount();
  }
});

test("真实 AgentClientPane：多 Part 消息只在排序首行渲染一个操作锚点", async () => {
  const { wrapper } = mountPane({ sessionReady: false });
  try {
    const toolParts = [
      { id: "tool-late", messageId: "tool-assistant", position: 9, type: "tool_call" as const, toolName: "read", input: {}, providerToolCallId: null, updatedRevision: 1, createdAt: 1, updatedAt: 1 },
      { id: "reason-early", messageId: "tool-assistant", position: 4, type: "reasoning" as const, text: "think", updatedRevision: 1, createdAt: 1, updatedAt: 1 },
    ];
    await setTimeline(wrapper, [
      agentMessage({ id: "tool-assistant", type: "assistant", parts: toolParts }),
      agentMessage({ id: "image-assistant", type: "assistant", parts: [{ id: "image", messageId: "image-assistant", position: 5, type: "image", attachmentId: "attachment", mediaType: "image/png", filename: "image.png", updatedRevision: 1, createdAt: 1, updatedAt: 1 }] }),
    ]);
    for (const messageId of ["tool-assistant", "image-assistant"]) {
      const rows = wrapper.findAll(`article[data-message-id="${messageId}"]`);
      assert.equal(rows.length, messageId === "tool-assistant" ? 2 : 1);
      assert.equal(rows.flatMap((row) => row.findAllComponents({ name: "AgentMessageActions" })).length, 1);
      assert.equal(rows[0]!.findAllComponents({ name: "AgentMessageActions" }).length, 1);
      assert.equal(rows.slice(1).flatMap((row) => row.findAllComponents({ name: "AgentMessageActions" })).length, 0);
    }
  } finally {
    wrapper.unmount();
  }
});

test("真实 AgentClientPane：Subtask Session 不显示任何结构操作", async () => {
  const subtask = mountPane({ sessionReady: false });
  try {
    await subtask.wrapper.setProps({ sessionKind: "subtask" });
    await setTimeline(subtask.wrapper, [
      agentMessage({ id: "subtask-user", type: "user", inCurrentOperationRange: true }),
      agentMessage({ id: "subtask-assistant", type: "assistant", inCurrentOperationRange: true }),
    ]);
    assert.equal(subtask.wrapper.findAllComponents({ name: "AgentMessageActions" }).length, 0);
  } finally {
    subtask.wrapper.unmount();
  }
});

const ForkActionsStub = defineComponent({
  name: "AgentMessageActions",
  props: { disabled: Boolean, showFork: Boolean, showRevert: Boolean },
  emits: ["fork", "revert"],
  setup(props, { emit }) {
    return () => h("div", [
      props.showFork
        ? h("button", {
          "data-testid": "fork-action",
          disabled: props.disabled,
          onClick: () => emit("fork"),
        })
        : null,
      props.showRevert
        ? h("button", {
          "data-testid": "revert-action",
          disabled: props.disabled,
          onClick: () => emit("revert"),
        })
        : null,
    ]);
  },
});

function mountForkPane(forkSession: NonNullable<Parameters<typeof mountPane>[0]>["forkSession"]) {
  return mount(AgentClientPane, {
    attachTo: document.body,
    props: {
      workspaceId: "ws-a", toolId: "agent-tool", sessionId: "session-a", sessionKind: "primary", sessionTitle: "Session A",
      sessionReady: false, active: true, agentOptions: [], sessionModelStates: {}, sessionModelStateLoading: false,
      sessionModelMutationPending: false, modelOpenIntent: null, forkSession,
    },
    global: {
      ...createMountGlobal({ getRunState: () => computed(() => baseRunState()) }),
      stubs: { ...componentStubs, AgentMessageActions: ForkActionsStub },
    },
  });
}

test("真实 AgentClientPane：点击历史 Fork 构造请求、pending 禁用并 emit 新 Session，且不调用确认", async () => {
  const completion = deferred<{ id: string }>();
  const requests: unknown[] = [];
  const originalConfirm = Modal.confirm;
  let confirmCalls = 0;
  const modal = Modal as unknown as { confirm: typeof Modal.confirm };
  modal.confirm = (() => { confirmCalls += 1; return { destroy() {}, update() {} }; }) as typeof Modal.confirm;
  const wrapper = mountForkPane(async (request) => { requests.push(request); return await completion.promise; });
  try {
    await setTimeline(wrapper, [agentMessage({ id: "historical-user", type: "user", inCurrentOperationRange: false })]);
    const action = wrapper.get('[data-testid="fork-action"]');
    await action.trigger("click");
    await nextTick();
    assert.deepEqual(requests, [{ fromSessionId: "session-a", fromMessageId: "historical-user" }]);
    assert.equal((action.element as HTMLButtonElement).disabled, true);
    assert.equal(confirmCalls, 0);
    completion.resolve({ id: "forked-session" });
    await new Promise((resolve) => setImmediate(resolve));
    await nextTick();
    assert.equal((action.element as HTMLButtonElement).disabled, false);
    assert.deepEqual(wrapper.emitted("forked"), [["forked-session"]]);
  } finally {
    modal.confirm = originalConfirm;
    wrapper.unmount();
  }
});

test("真实 AgentClientPane：Fork 失败不 emit、恢复 pending 且不改写来源 timeline", async () => {
  const completion = deferred<{ id: string }>();
  const wrapper = mountForkPane(async () => await completion.promise);
  try {
    await setTimeline(wrapper, [agentMessage({ id: "historical-assistant", type: "assistant", inCurrentOperationRange: false })]);
    const action = wrapper.get('[data-testid="fork-action"]');
    await action.trigger("click");
    await nextTick();
    assert.equal((action.element as HTMLButtonElement).disabled, true);
    completion.reject(new Error("fork failed"));
    await new Promise((resolve) => setImmediate(resolve));
    await nextTick();
    assert.equal((action.element as HTMLButtonElement).disabled, false);
    assert.equal(wrapper.emitted("forked"), undefined);
    assert.deepEqual((wrapper.vm as unknown as { timelineState: { messages: AgentMessage[] } }).timelineState.messages.map((item) => item.id), ["historical-assistant"]);
  } finally {
    wrapper.unmount();
  }
});

test("真实 AgentClientPane：点击 Revert 仍打开确认框", async () => {
  const originalConfirm = Modal.confirm;
  let confirmCalls = 0;
  const modal = Modal as unknown as { confirm: typeof Modal.confirm };
  modal.confirm = (() => {
    confirmCalls += 1;
    return { destroy() {}, update() {} };
  }) as unknown as typeof Modal.confirm;
  const wrapper = mountForkPane(async () => ({ id: "unused" }));
  try {
    await setTimeline(wrapper, [agentMessage({
      id: "current-user",
      type: "user",
      inCurrentOperationRange: true,
      parts: [{ id: "draft", messageId: "current-user", position: 3, type: "text", text: "draft", updatedRevision: 1, createdAt: 1, updatedAt: 1 }],
    })]);
    await wrapper.get('[data-testid="revert-action"]').trigger("click");
    assert.equal(confirmCalls, 1);
  } finally {
    modal.confirm = originalConfirm;
    wrapper.unmount();
  }
});

test("真实 AgentClientPane：输入框字号跟随 AI Agent 字号变量", () => {
  const { wrapper } = mountPane({ sessionReady: false });
  try {
    assert.equal(
      wrapper.get("a-textarea").attributes("style"),
      "font-size: var(--agent-font-size, 13px);",
    );
  } finally {
    wrapper.unmount();
  }
});

test("真实 AgentClientPane：输入内容为顿号时立即替换为 slash", async () => {
  const { wrapper } = mountPane({ sessionReady: false });
  try {
    const vm = wrapper.vm as unknown as { draft: string };
    const textarea = wrapper.get("a-textarea");
    // a-textarea 会先通过 v-model 更新 draft，再触发当前 input 处理器。
    vm.draft = "、";
    (textarea.element as HTMLTextAreaElement).value = "、";

    textarea.element.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();

    assert.equal(vm.draft, "/");
    assert.equal(wrapper.find('[role="listbox"]').exists(), true);
  } finally {
    wrapper.unmount();
  }
});

test("真实 AgentClientPane：草稿 Session 无候选项时 Tab/Shift+Tab 循环切换 Agent", async () => {
  const { wrapper } = mountPane({ sessionReady: false, modelValue: "agent-b" });
  try {
    const textarea = wrapper.get("a-textarea");
    const nextEvent = createKeyboardEvent("Tab");
    textarea.element.dispatchEvent(nextEvent);
    await nextTick();
    assert.equal(nextEvent.defaultPrevented, true);
    assert.deepEqual(wrapper.emitted("update:modelValue")?.[0], ["agent-c"]);

    const previousEvent = createKeyboardEvent("Tab", true);
    textarea.element.dispatchEvent(previousEvent);
    await nextTick();
    assert.equal(previousEvent.defaultPrevented, true);
    assert.deepEqual(wrapper.emitted("update:modelValue")?.[1], ["agent-a"]);
  } finally {
    wrapper.unmount();
  }
});

test("真实 AgentClientPane：存在 slash 候选时 Tab 选择候选而不切换 Agent", async () => {
  const { wrapper } = mountPane({ sessionReady: false, modelValue: "agent-b", initialDraft: "/" });
  try {
    (wrapper.vm as unknown as { promptItems: unknown[] }).promptItems = [{
      id: "prompt-review",
      title: "Review",
      command: "review",
    }];
    const textarea = wrapper.get("a-textarea");
    await nextTick();
    assert.equal(wrapper.find('[role="listbox"]').exists(), true);
    const options = wrapper.findAll('[role="option"]');
    assert.equal(options.length, 2);
    assert.equal(options[0]?.attributes("type"), "button");
    assert.equal(options[0]?.attributes("aria-selected"), "true");
    assert.equal(options[1]?.attributes("aria-selected"), "false");
    assert.match(options[0]?.attributes("class") || "", /appearance-none/);
    assert.match(options[0]?.attributes("class") || "", /bg-blue-500\/25/);
    assert.match(options[0]?.attributes("class") || "", /font-medium/);
    assert.doesNotMatch(options[0]?.attributes("class") || "", /border-l-/);
    assert.doesNotMatch(options[0]?.attributes("class") || "", /shadow-/);
    assert.match(options[1]?.attributes("class") || "", /bg-transparent/);

    const arrowDownEvent = createKeyboardEvent("ArrowDown");
    textarea.element.dispatchEvent(arrowDownEvent);
    await nextTick();
    assert.equal(arrowDownEvent.defaultPrevented, true);
    assert.equal(options[0]?.attributes("aria-selected"), "false");
    assert.equal(options[1]?.attributes("aria-selected"), "true");

    const arrowUpEvent = createKeyboardEvent("ArrowUp");
    textarea.element.dispatchEvent(arrowUpEvent);
    await nextTick();
    assert.equal(options[0]?.attributes("aria-selected"), "true");

    const tabEvent = createKeyboardEvent("Tab");
    textarea.element.dispatchEvent(tabEvent);
    await nextTick();
    assert.equal(tabEvent.defaultPrevented, true);
    assert.equal((wrapper.vm as unknown as { draft: string }).draft, "/compact");
    assert.equal(wrapper.emitted("update:modelValue"), undefined);
  } finally {
    wrapper.unmount();
  }
});

test("真实 AgentClientPane：精确匹配 slash 指令时隐藏候选且 Enter 直接发送", async () => {
  const ensuredSessionIds: string[] = [];
  const ensureSession = async (sessionId: string) => {
    ensuredSessionIds.push(sessionId);
    return await new Promise<string>(() => undefined);
  };
  const { wrapper } = mountPane({
    sessionReady: false,
    initialDraft: "/compact",
    ensureSession,
  });
  try {
    await nextTick();
    assert.equal(wrapper.find('[role="listbox"]').exists(), false);
    (wrapper.vm as unknown as { promptSettingsLoaded: boolean }).promptSettingsLoaded = true;

    const enterEvent = createKeyboardEvent("Enter");
    wrapper.get("a-textarea").element.dispatchEvent(enterEvent);
    await nextTick();
    assert.equal(enterEvent.defaultPrevented, true);
    assert.deepEqual(ensuredSessionIds, ["session-a"]);
  } finally {
    wrapper.unmount();
  }
});

test("真实 AgentClientPane：Session 与消息 ID 复制在 Clipboard API reject 后进入 fallback", async () => {
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const originalExecCommand = document.execCommand;
  const originalSuccess = message.success;
  const copiedContents: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async () => { throw new Error("denied"); } },
  });
  document.execCommand = ((command: string) => {
    assert.equal(command, "copy");
    copiedContents.push((document.activeElement as HTMLTextAreaElement).value);
    return true;
  }) as typeof document.execCommand;
  message.success = (() => undefined) as unknown as typeof message.success;
  const { wrapper } = mountPane({ sessionReady: true, active: false });
  try {
    const before = document.body.querySelectorAll("textarea").length;
    await wrapper.get('a-button[aria-label="agent.client.copySessionId"]').trigger("click");
    await setTimeline(wrapper, [agentMessage({ id: "message-copy", type: "user" })]);
    wrapper.getComponent({ name: "AgentMessageActions" }).vm.$emit("copy-message-id");
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(copiedContents, ["session-a", "message-copy"]);
    assert.equal(document.body.querySelectorAll("textarea").length, before);
  } finally {
    wrapper.unmount();
    if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
    else delete (navigator as { clipboard?: unknown }).clipboard;
    document.execCommand = originalExecCommand;
    message.success = originalSuccess;
  }
});

test("真实 AgentClientPane：run-state 响应字段更新后同步刷新头部 Token、上下文比例和完成耗时", async () => {
  const runState = baseRunState();
  const { wrapper, setRunState } = mountPane({ runState, sessionReady: false });
  try {
    assert.equal(wrapper.find('[data-testid="agent-header-tokens"]').exists(), false);
    assert.equal(wrapper.find('[data-testid="agent-header-elapsed"]').exists(), false);

    setRunState({
      lastResponseTotalTokens: 9898,
      contextTokenRatio: 0.04949,
      lastRunDurationMs: 27_501,
      updatedAt: 2,
    });
    await nextTick();

    const tokensText = wrapper.get('[data-testid="agent-header-tokens"]').text();
    assert.match(tokensText, /9[,.]?898 tokens/);
    assert.match(tokensText, /4[,.]?9%/);
    assert.equal(wrapper.get('[data-testid="agent-header-elapsed"]').text(), "27s");

    setRunState({
      lastResponseTotalTokens: 12_345,
      contextTokenRatio: 0.1,
      lastRunDurationMs: 61_000,
      updatedAt: 3,
    });
    await nextTick();

    assert.match(wrapper.get('[data-testid="agent-header-tokens"]').text(), /12[,.]?345 tokens/);
    assert.match(wrapper.get('[data-testid="agent-header-tokens"]').text(), /10%/);
    assert.equal(wrapper.get('[data-testid="agent-header-elapsed"]').text(), "1min 1s");
  } finally {
    wrapper.unmount();
  }
});

test("真实 AgentClientPane：运行耗时 interval 随 active/status 状态转换创建和清理", async () => {
  const setIntervalDescriptor = Object.getOwnPropertyDescriptor(window, "setInterval");
  const clearIntervalDescriptor = Object.getOwnPropertyDescriptor(window, "clearInterval");
  let nextId = 100;
  const created: number[] = [];
  const cleared: number[] = [];
  const setIntervalStub = ((_handler: TimerHandler, delay?: number) => {
    assert.equal(delay, 1000);
    const id = nextId++;
    created.push(id);
    return id;
  }) as typeof window.setInterval;
  const clearIntervalStub = ((id?: number) => {
    cleared.push(id as number);
  }) as typeof window.clearInterval;
  Object.defineProperty(window, "setInterval", {
    configurable: true,
    writable: true,
    value: setIntervalStub,
  });
  Object.defineProperty(window, "clearInterval", {
    configurable: true,
    writable: true,
    value: clearIntervalStub,
  });
  const runState = baseRunState({
    status: "running",
    activeRunId: "run-a",
    activeRunStartedAt: 10,
  });
  const { wrapper, setRunState } = mountPane({ runState, active: true, sessionReady: false });
  try {
    assert.deepEqual(created, [100]);
    assert.deepEqual(cleared, []);

    await wrapper.setProps({ active: false });
    await nextTick();
    assert.equal(created.length, 1);
    assert.equal(created[0], 100);
    assert.equal(cleared.length, 1);
    assert.equal(cleared[0], 100);

    await wrapper.setProps({ active: true });
    await nextTick();
    assert.equal(created.length, 2);
    assert.equal(created[1], 101);
    assert.equal(cleared.length, 1);
    assert.equal(cleared[0], 100);

    setRunState({
      status: "idle",
      activeRunId: null,
    });
    await nextTick();
    assert.equal(created.length, 2);
    assert.equal(cleared.length, 2);
    assert.equal(cleared[1], 101);

    wrapper.unmount();
    assert.equal(cleared.length, 2);
    assert.equal(cleared[1], 101);
  } finally {
    if (wrapper.exists()) wrapper.unmount();
    if (setIntervalDescriptor) Object.defineProperty(window, "setInterval", setIntervalDescriptor);
    else delete (window as { setInterval?: unknown }).setInterval;
    if (clearIntervalDescriptor) Object.defineProperty(window, "clearInterval", clearIntervalDescriptor);
    else delete (window as { clearInterval?: unknown }).clearInterval;
  }
});
