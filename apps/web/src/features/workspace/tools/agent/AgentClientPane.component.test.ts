import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessageSessionRunState } from "@agent-workbench/shared";

const [{ mount }, component, { createI18n }, { nextTick, reactive }, { agentSessionStatusStoreKey }, { message }] = await Promise.all([
  import("@vue/test-utils"),
  import("./AgentClientPane.vue"),
  import("vue-i18n"),
  import("vue"),
  import("./useAgentSessionStatusStore"),
  import("ant-design-vue"),
]);

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

function createMountGlobal(statusStore: { runStateOf: () => AgentMessageSessionRunState }) {
  const i18n = createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": {} } });
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
}) {
  const runState = options?.runState ?? baseRunState();
  const statusStore = { runStateOf: () => runState };
  const wrapper = mount(component.default.__vccOpts ?? component.default, {
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
    },
    global: createMountGlobal(statusStore),
  });
  return {
    wrapper,
    runState,
    setRunState: (next: Partial<AgentMessageSessionRunState>) => Object.assign(runState, next),
  };
}

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
    const textarea = wrapper.get("a-textarea");
    await nextTick();
    assert.equal(wrapper.find('[role="listbox"]').exists(), true);

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

test("真实 AgentClientPane：Clipboard API reject 后进入 execCommand fallback 并清理临时 textarea", async () => {
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const originalExecCommand = document.execCommand;
  const originalSuccess = message.success;
  let execCalls = 0;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async () => { throw new Error("denied"); } },
  });
  document.execCommand = ((command: string) => {
    assert.equal(command, "copy");
    execCalls += 1;
    return true;
  }) as typeof document.execCommand;
  message.success = (() => undefined) as unknown as typeof message.success;
  const { wrapper } = mountPane({ sessionReady: true, active: false });
  try {
    const before = document.body.querySelectorAll("textarea").length;
    await wrapper.get('a-button[aria-label="agent.client.copySessionId"]').trigger("click");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(execCalls, 1);
    assert.equal(document.body.querySelectorAll("textarea").length, before);
  } finally {
    wrapper.unmount();
    if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
    else delete (navigator as { clipboard?: unknown }).clipboard;
    document.execCommand = originalExecCommand;
    message.success = originalSuccess;
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
