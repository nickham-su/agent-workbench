import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import type { AxiosResponse, InternalAxiosRequestConfig } from "axios";
import type { AgentMessage, AgentMessageSessionRunState, AgentMessageQueueSnapshot } from "@agent-workbench/shared";
import type { AgentSessionAgentModelState } from "@agent-workbench/shared/internal-contracts/agent-api-session";
import DOMPurify from "dompurify";
import { computed, defineComponent, h, KeepAlive, ref, type ComputedRef } from "vue";
import { agentSessionMetadataReadContextKey, createAgentSessionMetadataReads, type MetadataReadContext, type TimelineMetadataEvent } from "./agentSessionMetadataReadContext";
import zhCN from "@/shared/i18n/locales/zh-CN";
import enUS from "@/shared/i18n/locales/en-US";
import { ApiError, apiClient } from "@/shared/api/api";

const [{ mount }, component, markdownComponent, { createI18n }, { nextTick, reactive }, { agentSessionStatusStoreKey }, { message, notification, Modal, Input }, { replaceAgentTimelineSnapshot }] = await Promise.all([
  import("@vue/test-utils"),
  import("./AgentClientPane.vue"),
  import("./AssistantMarkdownMessage.vue"),
  import("vue-i18n"),
  import("vue"),
  import("./useAgentSessionStatusStore"),
  import("ant-design-vue"),
  import("./agentMessageTimeline"),
]);

const AgentClientPane = component.default.__vccOpts ?? component.default;

async function flushQueueUi() {
  for (let i = 0; i < 5; i++) { await nextTick(); await new Promise<void>(resolve => setTimeout(resolve, 0)); }
}

async function clearComponentNotifications() {
  // Let a queued notice initialize before destroying the singleton instance.
  await nextTick();
  await new Promise<void>((resolve) => setImmediate(resolve));
  Modal.destroyAll();
  // Static dialogs leave through rc-motion before their Teleport is unmounted.
  // Do not let closing dialogs from the previous test masquerade as current UI.
  await new Promise<void>((resolve) => setTimeout(resolve, 350));
  message.destroy();
  notification.destroy();
  // notification.destroy() schedules unmounts but does not return a Promise.
  await nextTick();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

afterEach(clearComponentNotifications);

function latestQueueDialog(): HTMLElement {
  // Ant's destroyed dialogs remain mounted during their leave transition.
  // Interact with the newest dialog, not an older closing DOM tree.
  const dialog = [...document.body.querySelectorAll<HTMLElement>(".ant-modal-confirm")].at(-1);
  assert.ok(dialog, "a real operation recovery dialog is rendered");
  return dialog;
}

function queueDialogButton(text: string, dialog = latestQueueDialog()): HTMLButtonElement {
  const button = [...dialog.querySelectorAll("button")].find(node => node.textContent?.replace(/\s/g, "") === text.replace(/\s/g, ""));
  assert.ok(button, `real dialog action ${text} is reachable`);
  return button;
}

function queueDialogConfirm(dialog = latestQueueDialog()): HTMLButtonElement {
  const button = dialog.querySelector<HTMLButtonElement>(".ant-modal-confirm-btns .ant-btn-primary");
  assert.ok(button, "real dialog confirmation action is reachable");
  return button;
}

function queueSnapshot(sessionId = "session-a"): AgentMessageQueueSnapshot {
  return { workspaceId: "ws-a", sessionId, queueVersion: 0, stopGeneration: "0".repeat(64), pendingCount: 0, pendingBytes: 0, pendingIdentity: null, inputIdentity: null, stop: { state: "none", unresolvedOperationCount: 0, unresolvedTargetCount: 0, code: null }, items: [] };
}
function injectedReceipt(runId: string, sessionId = "session-a") {
  return { receipt: { id: `receipt-${runId}`, clientRequestId: "test-request", sequence: 1, createdAt: 1, updatedAt: 1,
    status: "injected", messageId: `message-${runId}`, runId },
    deduplicated: true, queue: queueSnapshot(sessionId) };
}

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

function textPart(messageId: string, position = 0, text = "正文") {
  return {
    id: `${messageId}-text-${position}`, messageId, position, type: "text" as const,
    text, updatedRevision: 1, createdAt: 1, updatedAt: 1,
  };
}

function textMessage(overrides: Partial<AgentMessage> & Pick<AgentMessage, "id">): AgentMessage {
  const message = agentMessage(overrides);
  if (overrides.parts === undefined) message.parts = [{ ...textPart(overrides.id), position: 0 }];
  return message;
}

function timelineSnapshot(messages: AgentMessage[]) {
  return {
    session: {
      id: "session-a", workspaceId: "ws-a", title: "Session A", kind: "primary" as const, visibility: "listed" as const,
      headMessageId: messages.at(-1)?.id ?? null, contextRootMessageId: null, revision: 1,
      forkedFromSessionId: null, forkedFromMessageId: null, createdAt: 1, updatedAt: 1,
    },
    timelineReset: false,
    messages,
    toolExecutions: [],
  };
}

function createMountGlobal(
  statusStore: { getRunState: (sessionId: string) => ComputedRef<AgentMessageSessionRunState> },
  contextLocale?: "zh-CN" | "en-US",
) {
  const i18n = contextLocale
    ? createI18n({ legacy: false, locale: contextLocale, messages: { "zh-CN": zhCN, "en-US": enUS } })
    : createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": { agent: { client: { imageCount: "{count} 张图片" } } } } });
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
  initialQueue?: AgentMessageQueueSnapshot | null;
  ensureSession?: (sessionId: string) => Promise<string>;
  forkSession?: (request: { fromSessionId: string; fromMessageId: string }) => Promise<import("@agent-workbench/shared").AgentSessionRecord>;
  contextLocale?: "zh-CN" | "en-US";
  renderRealTextarea?: boolean;
  renderModalSlots?: boolean;
  renderRealModal?: boolean;
  metadataReadContext?: MetadataReadContext;
}) {
  const runState = options?.runState ?? baseRunState();
  const otherRunState = baseRunState({ sessionId: "session-b" });
  const statusStore = { getRunState: (sessionId: string) => computed(() => sessionId === "session-a" ? runState : otherRunState), bumpPollHint: () => undefined };
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
      agentSelectionState: "ready",
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
    global: options?.renderModalSlots ? {
      ...createMountGlobal(statusStore, options.contextLocale),
      stubs: {
        ...componentStubs,
        "a-modal": defineComponent({
          props: { open: Boolean },
          setup(props, { slots }) {
            return () => props.open ? h("section", { "data-testid": "visible-modal" }, slots.default?.()) : null;
          },
        }),
      },
    } : { ...createMountGlobal(statusStore, options?.contextLocale), stubs: { ...componentStubs, ...(options?.renderRealModal ? { "a-modal": false } : {}) }, components: options?.renderRealTextarea ? { ATextarea: Input.TextArea } : {}, provide: { ...createMountGlobal(statusStore).provide, ...(options?.metadataReadContext ? { [agentSessionMetadataReadContextKey as symbol]: options.metadataReadContext } : {}) } },
  });
  if (options?.initialQueue !== null) (wrapper.vm as any).queue.apply(options?.initialQueue ?? queueSnapshot());
  return {
    wrapper,
    runState,
    setRunState: (next: Partial<AgentMessageSessionRunState>) => Object.assign(runState, next),
  };
}

type ContextModalVm = {
  contextModalVisible: boolean;
  contextReady: boolean;
  contextLoading: boolean;
  contextSaving: boolean;
  contextError: string;
  skillCandidates: Array<{ skillId: string }>;
  instructionCandidates: Array<{ path: string }>;
  skillKeys: string[];
  instructionKeys: string[];
  saveContextSettings: () => Promise<void>;
};

function contextModalVm(wrapper: ReturnType<typeof mountPane>["wrapper"]): ContextModalVm {
  return wrapper.vm as unknown as ContextModalVm;
}

function mockContextRequests(options?: { autoTimeline?: boolean }) {
  const previousAdapter = apiClient.defaults.adapter;
  const requests: Array<{ config: InternalAxiosRequestConfig; reply: ReturnType<typeof deferred<AxiosResponse>> }> = [];
  apiClient.defaults.adapter = (config) => {
    if (options?.autoTimeline && config.url?.endsWith("/timeline"))
      return Promise.resolve({ config, data: timelineSnapshot([]), status: 200, statusText: "OK", headers: {} });
    const reply = deferred<AxiosResponse>();
    requests.push({ config, reply });
    return reply.promise;
  };
  return {
    requests,
    respond(index: number, data: unknown) {
      const request = requests[index];
      assert.ok(request);
      request.reply.resolve({ config: request.config, data, status: 200, statusText: "OK", headers: {} });
    },
    reject(index: number, error: unknown) {
      assert.ok(requests[index]); requests[index]!.reply.reject(error);
    },
    async waitFor(index: number) {
      for (let i = 0; i < 30 && !requests[index]; i++) await new Promise((resolve) => setTimeout(resolve, 0));
      assert.ok(requests[index], `context request ${index} should be dispatched`);
      return requests[index].config;
    },
    restore() { apiClient.defaults.adapter = previousAdapter; },
  };
}

function panePendingRuns(wrapper: ReturnType<typeof mountPane>["wrapper"]) {
  return (wrapper.vm as unknown as {
    pendingRunRegistry: ReturnType<typeof import("./agentPendingRunRegistry.js").createAgentPendingRunRegistry>;
  }).pendingRunRegistry;
}

function contextSnapshot(workspaceId: string, skillId: string, instructionPath: string) {
  return {
    workspaceId, updatedAt: 1,
    skills: [{ skillId, skillFilePath: `${skillId}/SKILL.md`, enabled: true }],
    agentsInstructions: [{ path: instructionPath, enabled: true }],
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

async function waitForTimelineRequest(http: ReturnType<typeof mockContextRequests>, after = -1) {
  for (let i = 0; i < 30; i++) {
    const index = http.requests.findIndex((request, at) => at > after && request.config.url?.endsWith("/timeline"));
    if (index >= 0) return index;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("expected a timeline request");
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
            active: true,
            agentSelectionState: "ready",
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
  // Restoration uses the window RAF queue, not the Node timer queue.
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  await nextTick();
}

function cachedPaneVm(host: ReturnType<typeof mount>) {
  return host.getComponent(AgentClientPane).vm as unknown as {
    loadingPreviousPageScope: unknown;
  };
}

test("上下文管理弹窗在中英文均显示新 run 生效提示", async () => {
  for (const [locale, expected] of [
    ["zh-CN", zhCN.agent.client.contextManagerHint],
    ["en-US", enUS.agent.client.contextManagerHint],
  ] as const) {
    assert.match(expected, locale === "zh-CN" ? /新 run.*重新判定.*不会自动刷新/ : /new run.*not automatically refreshed/);
    const { wrapper } = mountPane({ contextLocale: locale, renderModalSlots: true });
    try {
      assert.equal(wrapper.text().includes(expected), false, `closed modal should not expose ${locale} hint`);
      await wrapper.get(`[aria-label="${locale === "zh-CN" ? zhCN.agent.client.contextManagerTitle : enUS.agent.client.contextManagerTitle}"]`).trigger("click");
      await nextTick();
      assert.ok(wrapper.get('[data-testid="visible-modal"]').text().includes(expected), `${locale} hint should be visible in the open modal`);
    } finally {
      wrapper.unmount();
    }
  }
});

test("上下文管理忽略关闭重开及 workspace 切换后的乱序 detect 成功、失败和 finally", async () => {
  const http = mockContextRequests();
  const { wrapper } = mountPane({ contextLocale: "zh-CN", renderModalSlots: true });
  const vm = contextModalVm(wrapper);
  try {
    const button = `[aria-label="${zhCN.agent.client.contextManagerTitle}"]`;
    await wrapper.get(button).trigger("click");
    assert.equal((await http.waitFor(0)).url, "/workspaces/ws-a/context-files/detect");
    vm.contextModalVisible = false;
    await nextTick();
    await wrapper.get(button).trigger("click");
    await http.waitFor(1);
    http.respond(0, contextSnapshot("ws-a", "stale/skill", "stale/AGENTS.md"));
    await nextTick();
    assert.equal(vm.contextLoading, true, "stale finally must not clear the active spinner");
    assert.equal(vm.contextReady, false);
    assert.deepEqual(vm.skillCandidates, []);
    http.respond(1, contextSnapshot("ws-a", "current/skill", "current/AGENTS.md"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(vm.contextReady, true);
    assert.deepEqual(vm.skillKeys, ["current/skill"]);
    assert.deepEqual(vm.instructionKeys, ["current/AGENTS.md"]);

    await wrapper.get(button).trigger("click");
    await http.waitFor(2);
    await wrapper.setProps({ workspaceId: "ws-b" });
    assert.equal((await http.waitFor(3)).url, "/workspaces/ws-b/context-files/detect");
    http.requests[2].reply.reject(new Error("stale workspace failure"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(vm.contextError, "");
    assert.equal(vm.contextLoading, true);
    assert.equal(vm.contextReady, false);
    http.respond(3, contextSnapshot("ws-b", "new/skill", "new/AGENTS.md"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(vm.contextError, "");
    assert.equal(vm.contextReady, true);
    assert.deepEqual(vm.skillKeys, ["new/skill"]);
    assert.deepEqual(vm.instructionKeys, ["new/AGENTS.md"]);
  } finally {
    wrapper.unmount();
    http.restore();
  }
});

test("上下文探测失败不能保存；统一 PUT 失败保留选择，关闭重开后旧 PUT 不能关闭新弹窗", async () => {
  const http = mockContextRequests();
  const { wrapper } = mountPane({ contextLocale: "zh-CN", renderModalSlots: true });
  const vm = contextModalVm(wrapper);
  try {
    const button = `[aria-label="${zhCN.agent.client.contextManagerTitle}"]`;
    await wrapper.get(button).trigger("click");
    await http.waitFor(0);
    http.requests[0].reply.reject(new Error("detect failed"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(vm.contextReady, false);
    assert.equal(vm.contextLoading, false);
    assert.match(vm.contextError, /detect failed/);
    await vm.saveContextSettings();
    assert.equal(http.requests.length, 1, "a failed detect must not dispatch PUT");

    await wrapper.get(button).trigger("click");
    await http.waitFor(1);
    http.respond(1, contextSnapshot("ws-a", "skill/old", "AGENTS.md"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    vm.skillKeys = ["skill/selected"];
    vm.instructionKeys = ["AGENTS.md"];
    void vm.saveContextSettings();
    const put = await http.waitFor(2);
    assert.equal(put.method, "put");
    assert.equal(put.url, "/workspaces/ws-a/context-files/settings");
    assert.deepEqual(JSON.parse(String(put.data)), { enabledSkillIds: ["skill/selected"], enabledAgentsInstructionPaths: ["AGENTS.md"] });
    http.requests[2].reply.reject(new Error("save failed"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(vm.contextModalVisible, true);
    assert.equal(vm.contextReady, true);
    assert.equal(vm.contextSaving, false);
    assert.match(vm.contextError, /save failed/);
    assert.deepEqual(vm.skillKeys, ["skill/selected"]);
    assert.deepEqual(vm.instructionKeys, ["AGENTS.md"]);

    void vm.saveContextSettings();
    await http.waitFor(3);
    vm.contextModalVisible = false;
    await nextTick();
    await wrapper.get(button).trigger("click");
    await http.waitFor(4);
    http.respond(3, { workspaceId: "ws-a", updatedAt: 2, enabledSkillIds: ["skill/selected"], enabledAgentsInstructionPaths: ["AGENTS.md"] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(vm.contextModalVisible, true, "stale PUT must not close a reopened modal");
    assert.equal(vm.contextLoading, true, "stale finally must not change the new detect state");
    assert.equal(wrapper.emitted("agent-settings-updated"), undefined);
    http.respond(4, contextSnapshot("ws-a", "skill/fresh", "fresh/AGENTS.md"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(vm.skillKeys, ["skill/fresh"]);
    assert.deepEqual(vm.instructionKeys, ["fresh/AGENTS.md"]);
    void vm.saveContextSettings();
    await http.waitFor(5);
    http.respond(5, { workspaceId: "ws-a", updatedAt: 3, enabledSkillIds: ["skill/fresh"], enabledAgentsInstructionPaths: ["fresh/AGENTS.md"] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(vm.contextModalVisible, false);
    assert.equal(wrapper.emitted("agent-settings-updated")?.length, 1);
  } finally {
    wrapper.unmount();
    http.restore();
  }
});

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

test("多个 Markdown 消息挂载及卸载后，共享 DOMPurify 只注册一次 hook 且保持安全清洗", async () => {
  const originalAddHook = DOMPurify.addHook;
  let installations = 0;
  DOMPurify.addHook = (entryPoint, hook) => {
    if (entryPoint === "afterSanitizeAttributes") installations += 1;
    return Reflect.apply(originalAddHook, DOMPurify, [entryPoint, hook]);
  };
  const i18n = createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } });
  const wrappers: Array<ReturnType<typeof mount>> = [];
  try {
    for (let index = 0; index < 3; index++) {
      const wrapper = mount(markdownComponent.default, {
        props: { messageId: `markdown-${index}`, text: "[安全链接](https://example.com)" },
        global: { plugins: [i18n] },
      });
      wrappers.push(wrapper);
      const link = wrapper.get("a");
      assert.equal(link.attributes("target"), "_blank");
      assert.equal(link.attributes("rel"), "noopener noreferrer");
      wrapper.unmount();
      wrappers.pop();
    }
    assert.equal(installations, 1);
    const { sanitizeAgentMarkdown } = await import("./assistantMarkdownSanitizer");
    const cleaned = sanitizeAgentMarkdown('<a href="javascript:alert(1)" onclick="bad()">bad</a><img src="x">');
    assert.doesNotMatch(cleaned, /javascript:|onclick|<img/i);
    assert.equal(installations, 1);
  } finally {
    for (const wrapper of wrappers) wrapper.unmount();
    DOMPurify.addHook = originalAddHook;
  }
});

test("真实 AgentClientPane：会话 tab 切回时恢复像素位置，迟到的 delta 不抢走阅读位置", async () => {
  const http = mockContextRequests();
  const { wrapper } = mountPane({ active: true, sessionReady: true });
  try {
    const initial = await waitForTimelineRequest(http);
    assert.equal(http.requests[initial].config.params?.mode, "snapshot");
    http.respond(initial, timelineSnapshot([agentMessage({ id: "initial" })]));
    await waitForScrollRestore();
    const paneVm = wrapper.vm as unknown as { conversation: Array<{ message: { id: string } }>; timelineState: { revision: number } };
    const initialRows = paneVm.conversation;
    const scrollEl = wrapper.get("main").element as HTMLElement;
    setScrollMetrics(scrollEl, 1_000, 200);
    scrollEl.scrollTop = 750; // 在 120px 自动跟随范围内，但并未真正到底。
    scrollEl.dispatchEvent(new Event("scroll"));

    // 模拟真实 a-tabs 先把非活动 pane display:none，再更新子组件的 active prop。
    // 隐藏后的 clientHeight/scrollHeight/scrollTop 都可能变为 0。
    setScrollMetrics(scrollEl, 0, 0);
    scrollEl.scrollTop = 0;
    scrollEl.dispatchEvent(new Event("scroll"));
    await wrapper.setProps({ active: false });
    setScrollMetrics(scrollEl, 1_000, 200);
    await wrapper.setProps({ active: true });
    const refreshed = await waitForTimelineRequest(http, initial);
    assert.equal(http.requests[refreshed].config.params?.mode, "delta");
    assert.equal(http.requests[refreshed].config.params?.sinceRevision, 1);
    await waitForScrollRestore();
    assert.equal(scrollEl.scrollTop, 750);

    setScrollMetrics(scrollEl, 1_400, 200);
    const delta = timelineSnapshot([agentMessage({ id: "updated", previousMessageId: "initial" })]);
    http.respond(refreshed, {
      ...delta,
      session: { ...delta.session, revision: 2 },
    });
    await waitForScrollRestore();
    assert.equal(scrollEl.scrollTop, 750);
    assert.notEqual(paneVm.conversation, initialRows);
    assert.deepEqual(paneVm.conversation.map((row) => row.message.id), ["initial", "updated"]);

    const conversationBefore = paneVm.conversation;
    await wrapper.setProps({ active: false });
    await wrapper.setProps({ active: true });
    const unchanged = await waitForTimelineRequest(http, refreshed);
    assert.equal(http.requests[unchanged].config.params?.mode, "delta");
    assert.equal(http.requests[unchanged].config.params?.sinceRevision, 2);
    http.respond(unchanged, { ...delta, session: { ...delta.session, revision: 3 }, messages: [] });
    await waitForScrollRestore();
    assert.equal(paneVm.timelineState.revision, 3);
    assert.equal(paneVm.conversation, conversationBefore, "revision 变化但行数据不变时不重建列表");
    assert.equal(scrollEl.scrollTop, 750);
  } finally {
    wrapper.unmount();
    http.restore();
  }
});

test("真实 AgentClientPane：仅工具执行变化时重建列表行并关联最新 execution", async () => {
  const http = mockContextRequests();
  const { wrapper } = mountPane({ active: true, sessionReady: true });
  try {
    const initial = await waitForTimelineRequest(http);
    const assistant = agentMessage({
      id: "assistant-with-tool",
      parts: [{
        id: "call", messageId: "assistant-with-tool", position: 0, type: "tool_call",
        toolName: "read", input: {}, providerToolCallId: null,
        updatedRevision: 1, createdAt: 1, updatedAt: 1,
      }],
    });
    http.respond(initial, timelineSnapshot([assistant]));
    await waitForScrollRestore();
    const paneVm = wrapper.vm as unknown as {
      conversation: Array<{ execution: { id: string } | null }>;
    };
    const before = paneVm.conversation;
    assert.equal(before[0]?.execution, null);

    await wrapper.setProps({ active: false });
    await wrapper.setProps({ active: true });
    const refreshed = await waitForTimelineRequest(http, initial);
    assert.equal(http.requests[refreshed].config.params?.mode, "delta");
    const response = timelineSnapshot([]);
    http.respond(refreshed, {
      ...response,
      session: { ...response.session, revision: 2, headMessageId: assistant.id },
      toolExecutions: [{
        id: "execution", callPartId: "call", status: "completed", resultPreview: "ok",
        resultTruncated: false, error: null, updatedRevision: 2, startedAt: 1, completedAt: 2,
      }],
    });
    await waitForScrollRestore();
    assert.notEqual(paneVm.conversation, before);
    assert.equal(paneVm.conversation[0]?.execution?.id, "execution");
  } finally {
    wrapper.unmount();
    http.restore();
  }
});

test("真实 AgentClientPane：隐藏后的 scroll 既不分页也不污染已缓存的可见位置及跟随状态", async () => {
  const { wrapper } = mountPane({ active: true, sessionReady: false });
  try {
    const scrollEl = wrapper.get("main").element as HTMLElement;
    const vm = wrapper.vm as unknown as { loadingPreviousPageScope: unknown; stickToBottom: boolean };
    setScrollMetrics(scrollEl, 1_000, 200);
    scrollEl.scrollTop = 320;
    scrollEl.dispatchEvent(new Event("scroll"));
    assert.equal(vm.stickToBottom, false);

    setScrollMetrics(scrollEl, 0, 0);
    scrollEl.scrollTop = 0;
    scrollEl.dispatchEvent(new Event("scroll")); // 仍是 active=true，但 DOM 已隐藏。
    await wrapper.setProps({ active: false });
    setScrollMetrics(scrollEl, 1_000, 200);
    scrollEl.dispatchEvent(new Event("scroll")); // inactive 的意外 scroll 不能加载历史页。
    assert.equal(vm.loadingPreviousPageScope, null);
    assert.equal(vm.stickToBottom, false);

    await wrapper.setProps({ active: true });
    await waitForScrollRestore();
    assert.equal(scrollEl.scrollTop, 320);
  } finally {
    wrapper.unmount();
  }
});

test("真实 AgentClientPane：首次加载的程序化滚底无需 scroll 事件，也能在隐藏后正确保持底部", async () => {
  const http = mockContextRequests();
  const { wrapper } = mountPane({ active: true, sessionReady: true });
  try {
    const initial = await waitForTimelineRequest(http);
    const scrollEl = wrapper.get("main").element as HTMLElement;
    setScrollMetrics(scrollEl, 1_000, 200);
    http.respond(initial, timelineSnapshot([agentMessage({ id: "initial" })]));
    await waitForScrollRestore();
    assert.equal(scrollEl.scrollTop, 800); // 没有手动派发 scroll 事件。

    setScrollMetrics(scrollEl, 0, 0);
    scrollEl.scrollTop = 0;
    await wrapper.setProps({ active: false });
    setScrollMetrics(scrollEl, 1_400, 200);
    await wrapper.setProps({ active: true });
    const refreshed = await waitForTimelineRequest(http, initial);
    await waitForScrollRestore();
    assert.equal(scrollEl.scrollTop, 1_200);
    http.respond(refreshed, timelineSnapshot([agentMessage({ id: "updated" })]));
  } finally {
    wrapper.unmount();
    http.restore();
  }
});

test("真实 AgentClientPane：切换前未完成的 snapshot 与切回后排队的 snapshot 都不抢走位置", async () => {
  const http = mockContextRequests();
  const { wrapper } = mountPane({ active: true, sessionReady: true });
  try {
    const initial = await waitForTimelineRequest(http);
    const scrollEl = wrapper.get("main").element as HTMLElement;
    setScrollMetrics(scrollEl, 1_000, 200);
    scrollEl.scrollTop = 750;
    scrollEl.dispatchEvent(new Event("scroll"));
    await wrapper.setProps({ active: false });
    scrollEl.scrollTop = 0;
    await wrapper.setProps({ active: true });
    await waitForScrollRestore();
    assert.equal(scrollEl.scrollTop, 750);

    setScrollMetrics(scrollEl, 1_400, 200);
    http.respond(initial, timelineSnapshot([agentMessage({ id: "first" })]));
    const refreshed = await waitForTimelineRequest(http, initial);
    http.respond(refreshed, timelineSnapshot([agentMessage({ id: "second" })]));
    await waitForScrollRestore();
    assert.equal(scrollEl.scrollTop, 750);
  } finally {
    wrapper.unmount();
    http.restore();
  }
});

test("真实 AgentClientPane：会话 tab 原先确实到底部则随新内容到底", async () => {
  const http = mockContextRequests();
  const { wrapper } = mountPane({ active: true, sessionReady: true });
  try {
    const initial = await waitForTimelineRequest(http);
    http.respond(initial, timelineSnapshot([agentMessage({ id: "initial" })]));
    await nextTick();
    const scrollEl = wrapper.get("main").element as HTMLElement;
    setScrollMetrics(scrollEl, 1_000, 200);
    scrollEl.scrollTop = 800;
    scrollEl.dispatchEvent(new Event("scroll"));

    setScrollMetrics(scrollEl, 0, 0);
    scrollEl.scrollTop = 0;
    await wrapper.setProps({ active: false });
    setScrollMetrics(scrollEl, 1_400, 200);
    await wrapper.setProps({ active: true });
    const refreshed = await waitForTimelineRequest(http, initial);
    await waitForScrollRestore();
    assert.equal(scrollEl.scrollTop, 1_200);
    setScrollMetrics(scrollEl, 1_600, 200);
    http.respond(refreshed, timelineSnapshot([agentMessage({ id: "updated" })]));
    await waitForScrollRestore();
    assert.equal(scrollEl.scrollTop, 1_400);
  } finally {
    wrapper.unmount();
    http.restore();
  }
});

test("真实 AgentClientPane：会话 tab 快速往返不以尚未恢复的临时顶部覆盖保存位置", async () => {
  const { wrapper } = mountPane({ active: true, sessionReady: false });
  try {
    const scrollEl = wrapper.get("main").element as HTMLElement;
    setScrollMetrics(scrollEl, 1_000, 200);
    scrollEl.scrollTop = 320;
    scrollEl.dispatchEvent(new Event("scroll"));
    await wrapper.setProps({ active: false });
    scrollEl.scrollTop = 0;
    await wrapper.setProps({ active: true });
    // 下一帧的旧恢复尚未运行，用户已经再次切走。
    await wrapper.setProps({ active: false });
    await wrapper.setProps({ active: true });
    await waitForScrollRestore();
    assert.equal(scrollEl.scrollTop, 320);
  } finally {
    wrapper.unmount();
  }
});

test("真实 AgentClientPane：消息列表底部在空流、文本流和工具调用期间只显示一个 Run loading，idle 后隐藏", async () => {
  const { wrapper, setRunState } = mountPane({ sessionReady: false, runState: baseRunState({ status: "running" }) });
  const loadingCount = () => wrapper.get("main").findAllComponents({ name: "LoadingOutlined" }).length;
  try {
    assert.equal(loadingCount(), 1, "消息快照到达前也显示 loading");
    await setTimeline(wrapper, [agentMessage({ id: "empty-stream", status: "streaming" })]);
    assert.equal(loadingCount(), 1);
    assert.equal(wrapper.find('main > [data-testid="agent-run-loading"]').exists(), true);

    await setTimeline(wrapper, [agentMessage({
      id: "text-stream", status: "streaming",
      parts: [{ id: "text-part", messageId: "text-stream", position: 0, type: "text", text: "Hello", updatedRevision: 1, createdAt: 1, updatedAt: 1 }],
    })]);
    assert.equal(loadingCount(), 1);

    await setTimeline(wrapper, [agentMessage({
      id: "tool-assistant", status: "completed",
      parts: [{ id: "call-part", messageId: "tool-assistant", position: 0, type: "tool_call", toolName: "read", input: {}, providerToolCallId: null, updatedRevision: 1, createdAt: 1, updatedAt: 1 }],
    })]);
    assert.equal(loadingCount(), 1);
    assert.equal(wrapper.find('main > [data-testid="agent-run-loading"]').exists(), true);

    setRunState({ status: "idle" });
    await nextTick();
    assert.equal(loadingCount(), 0);
    await setTimeline(wrapper, [agentMessage({ id: "stale-stream", status: "streaming" })]);
    assert.equal(loadingCount(), 0, "历史 streaming 消息不能在 Run 结束后重现 loading");
    assert.equal(wrapper.get("main").find('[data-testid="agent-run-loading"]').exists(), false);
  } finally {
    wrapper.unmount();
  }
});

test("真实 AgentClientPane：发送和状态轮询间隙保持 Run loading，Run 完成后消失", async () => {
  const ensured = deferred<string>();
  const http = mockContextRequests();
  const { wrapper, setRunState } = mountPane({ sessionReady: false, initialDraft: "Hello", ensureSession: () => ensured.promise });
  const loadingCount = () => wrapper.get("main").findAllComponents({ name: "LoadingOutlined" }).length;
  try {
    const send = (wrapper.vm as unknown as { onSend: () => Promise<void> }).onSend();
    await nextTick();
    assert.equal(loadingCount(), 1, "等待会话就绪时显示 loading");
    ensured.resolve("session-a");
    const request = await http.waitFor(0);
    assert.match(request.url || "", /receipts/);
    http.respond(0, injectedReceipt("new-run", "session-a"));
    await send;
    await nextTick();
    assert.equal(loadingCount(), 1, "发送完成但状态仍为 idle 时不能闪烁");

    setRunState({ status: "running", activeRunId: "new-run" });
    await nextTick();
    assert.equal(loadingCount(), 1, "状态同步后仍只显示一个 loading");
    setRunState({ status: "idle" });
    await nextTick();
    assert.equal(loadingCount(), 0);
  } finally {
    panePendingRuns(wrapper).remove({ workspaceId: "ws-a", sessionId: "session-a", runKind: "user", runId: "new-run" });
    wrapper.unmount();
    http.restore();
  }
});

test("真实 AgentClientPane：ensureSession 未返回前切会话不发送旧请求", async () => {
  const ensured = deferred<string>();
  const http = mockContextRequests();
  const { wrapper } = mountPane({ sessionReady: false, initialDraft: "old", ensureSession: () => ensured.promise });
  try {
    const send = (wrapper.vm as unknown as { onSend: () => Promise<void> }).onSend();
    await nextTick();
    await wrapper.setProps({ sessionId: "session-b" });
    ensured.resolve("session-a");
    await send;
    assert.equal(http.requests.length, 0);
    assert.equal(wrapper.find('[data-testid="agent-run-loading"]').exists(), false);
  } finally {
    wrapper.unmount();
    http.restore();
  }
});

test("真实 AgentClientPane：旧会话请求回执只登记原 Run，不污染新会话发送状态", async () => {
  const newSessionReady = deferred<string>();
  const http = mockContextRequests();
  const { wrapper, setRunState } = mountPane({ sessionReady: false, initialDraft: "old", ensureSession: (id) => id === "session-b" ? newSessionReady.promise : Promise.resolve(id) });
  const vm = wrapper.vm as unknown as { onSend: () => Promise<void>; draft: string; awaitingRunStateRunId: string | null };
  try {
    const oldSend = vm.onSend();
    const oldRequest = await http.waitFor(0);
    assert.match(oldRequest.url || "", /session-a\/receipts/);
    await wrapper.setProps({ sessionId: "session-b" });
    setRunState({ status: "running", activeRunId: "old-run-after-switch" });
    await nextTick();
    assert.equal(wrapper.find('[data-testid="agent-run-loading"]').exists(), false, "旧会话运行状态不能在新会话显示");
    (wrapper.vm as any).queue.apply(queueSnapshot("session-b"));
    vm.draft = "new";
    const newSend = vm.onSend();
    await nextTick();
    assert.equal(wrapper.find('[data-testid="agent-run-loading"]').exists(), true);

    http.respond(0, injectedReceipt("old-run-after-switch", "session-a"));
    await oldSend;
    await nextTick();
    assert.deepEqual(panePendingRuns(wrapper).list("ws-a", "session-a").map((run) => run.runId), ["old-run-after-switch"]);
    assert.equal(vm.awaitingRunStateRunId, null);
    assert.equal(wrapper.find('[data-testid="agent-run-loading"]').exists(), true, "旧请求的 finally 不能关掉新会话 loading");

    newSessionReady.resolve("session-b");
    const newRequest = await http.waitFor(1);
    assert.match(newRequest.url || "", /session-b\/receipts/);
    http.respond(1, injectedReceipt("new-run-after-switch", "session-b"));
    await newSend;
    assert.equal(vm.awaitingRunStateRunId, "new-run-after-switch");
  } finally {
    panePendingRuns(wrapper).remove({ workspaceId: "ws-a", sessionId: "session-a", runKind: "user", runId: "old-run-after-switch" });
    panePendingRuns(wrapper).remove({ workspaceId: "ws-a", sessionId: "session-b", runKind: "user", runId: "new-run-after-switch" });
    wrapper.unmount();
    http.restore();
  }
});

test("真实 AgentClientPane：运行中补充冻结目标 Run，迟到响应不注册新 Run", async () => {
  const http = mockContextRequests();
  const { wrapper, setRunState } = mountPane({ sessionReady: false, initialDraft: "extra", runState: baseRunState({ status: "running", activeRunId: "old-run" }) });
  const vm = wrapper.vm as any;
  try {
    const sending = vm.onSend(); const request = await http.waitFor(0);
    assert.equal(sendPayload(request).targetRunId, "old-run");
    setRunState({ status: "idle", activeRunId: null }); await nextTick();
    http.respond(0, injectedReceipt("old-run", "session-a")); await sending;
    assert.equal(vm.awaitingRunStateRunId, null);
    assert.equal(wrapper.find('[data-testid="agent-run-loading"]').exists(), false);
  } finally { wrapper.unmount(); http.restore(); }
});

test("真实 AgentClientPane：连续 Run 均先终态、状态轮询滞后时只保留相关的终态确认", async () => {
  const http = mockContextRequests();
  const { wrapper, setRunState } = mountPane({ sessionReady: false, runState: baseRunState({ status: "running", activeRunId: "overlap-r" }) });
  const vm = wrapper.vm as unknown as {
    bridgeRunState: (runId: string) => void;
    terminalRunIds: Set<string>;
    pendingRunController: { start: (scope: { workspaceId: string; sessionId: string }) => void };
  };
  const registry = panePendingRuns(wrapper);
  const register = (runId: string) => registry.register({ workspaceId: "ws-a", sessionId: "session-a", runKind: "user", runId });
  const terminal = (runId: string) => ({ workspaceId: "ws-a", sessionId: "session-a", runKind: "user", runId, status: "completed", code: "run_completed", detail: null, updatedAt: 1 });
  const hasLoading = () => wrapper.find('[data-testid="agent-run-loading"]').exists();
  try {
    vm.pendingRunController.start({ workspaceId: "ws-a", sessionId: "session-a" });
    register("overlap-r");
    await http.waitFor(0);
    http.respond(0, terminal("overlap-r"));
    for (let i = 0; i < 30 && hasLoading(); i++) await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(hasLoading(), false);

    vm.bridgeRunState("overlap-s");
    register("overlap-s");
    await nextTick();
    assert.equal(hasLoading(), true, "新 Run 等待状态同步时仍有 loading");
    await http.waitFor(1);
    http.respond(1, terminal("overlap-s"));
    for (let i = 0; i < 30 && hasLoading(); i++) await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(hasLoading(), false, "第二次终态不能让滞后的 R running 重新显示");
    assert.deepEqual([...vm.terminalRunIds].sort(), ["overlap-r", "overlap-s"]);
    setRunState({ status: "running", activeRunId: "overlap-s" });
    await nextTick();
    assert.equal(hasLoading(), false);
    assert.deepEqual([...vm.terminalRunIds], ["overlap-s"], "轮询进入 S 后丢弃 R");
    setRunState({ status: "idle", activeRunId: null });
    await nextTick();
    assert.equal(vm.terminalRunIds.size, 0);
  } finally {
    for (const runId of ["overlap-r", "overlap-s"]) registry.remove({ workspaceId: "ws-a", sessionId: "session-a", runKind: "user", runId });
    wrapper.unmount();
    http.restore();
  }
});

test("真实 AgentClientPane：新 loading 出现时仅底部附近自动跟随", async () => {
  const { wrapper, setRunState } = mountPane({ active: true, sessionReady: false });
  try {
    const el = wrapper.get("main").element as HTMLElement;
    setScrollMetrics(el, 1_000, 200);
    el.scrollTop = 800;
    el.dispatchEvent(new Event("scroll"));
    setScrollMetrics(el, 1_040, 200);
    setRunState({ status: "running", activeRunId: "scroll-run" });
    await nextTick();
    assert.equal(el.scrollTop, 840, "原先在底部时保持新图标可见");

    setRunState({ status: "idle", activeRunId: null });
    await nextTick();
    el.scrollTop = 320;
    el.dispatchEvent(new Event("scroll"));
    setScrollMetrics(el, 1_080, 200);
    setRunState({ status: "running", activeRunId: "scroll-run-2" });
    await nextTick();
    assert.equal(el.scrollTop, 320, "翻阅历史时不能强制滚到底部");
  } finally {
    wrapper.unmount();
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
      textMessage({ id: "old-user", type: "user", inCurrentOperationRange: false }),
      textMessage({
        id: "old-assistant", type: "assistant", inCurrentOperationRange: false,
        createdAt: 1, updatedAt: 2_501,
      }),
      textMessage({ id: "current-user", type: "user", inCurrentOperationRange: true }),
      agentMessage({
        id: "current-assistant", type: "assistant", inCurrentOperationRange: true,
        createdAt: 1, updatedAt: 3_201,
        parts: [
          toolPart("call-bash-a", 0, "bash"),
          toolPart("call-bash-b", 1, "bash"),
          toolPart("call-read", 2, "read"),
          textPart("current-assistant", 3),
        ],
      }),
      textMessage({ id: "summary", type: "compaction", inCurrentOperationRange: true }),
      textMessage({ id: "system", type: "system", inCurrentOperationRange: true }),
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
    assert.equal(actionByMessageId.has("system"), false);

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

test("真实 AgentClientPane：无内容 Assistant 不渲染工具栏或专用操作空白", async () => {
  const { wrapper } = mountPane({ sessionReady: false });
  try {
    await setTimeline(wrapper, [agentMessage({ id: "empty-assistant", type: "assistant", parts: [] })]);
    const row = wrapper.get('article[data-message-id="empty-assistant"]');
    assert.equal(row.attributes("style"), undefined);
    assert.equal(row.findAllComponents({ name: "AgentMessageActions" }).length, 0);
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
    assert.equal(rows[0]!.findAllComponents({ name: "AgentMessageActions" }).length, 1);
    assert.equal(rows[1]!.findAllComponents({ name: "AgentMessageActions" }).length, 0);

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

for (const firstPartType of ["reasoning", "tool_call"] as const) {
  test(`真实 AgentClientPane：Assistant 首 Part 为 ${firstPartType} 时工具栏跟随后续正文`, async () => {
    const { wrapper } = mountPane({ sessionReady: false });
    try {
      const id = `first-${firstPartType}`;
      const base = { id: `${id}-first`, messageId: id, position: 0, updatedRevision: 1, createdAt: 1, updatedAt: 1 };
      const firstPart = firstPartType === "reasoning"
        ? { ...base, type: "reasoning" as const, text: "" }
        : { ...base, type: "tool_call" as const, toolName: "read", input: {}, providerToolCallId: null };
      await setTimeline(wrapper, [agentMessage({ id, parts: [textPart(id, 1), firstPart] })]);
      const rows = wrapper.findAll(`article[data-message-id="${id}"]`);
      assert.equal(rows.length, 2);
      assert.equal(rows[0]!.findAllComponents({ name: "AgentMessageActions" }).length, 0);
      assert.equal(rows[1]!.findAllComponents({ name: "AgentMessageActions" }).length, 1);
      assert.ok(rows[1]!.classes().includes("group"), "正文与工具栏处于同一个 hover group");
      assert.equal(rows[1]!.getComponent({ name: "AssistantMarkdownMessage" }).props("text"), "正文");
      assert.equal(rows[1]!.getComponent({ name: "AgentMessageActions" }).props("messageId"), id);
    } finally {
      wrapper.unmount();
    }
  });
}

for (const type of ["user", "assistant"] as const) {
  test(`真实 AgentClientPane：${type} 每个非空 TextPart 独立展示消息级工具栏，原文与空行保留`, async () => {
    const { wrapper } = mountPane({ sessionReady: false });
    try {
      const id = `multiple-${type}`;
      await setTimeline(wrapper, [agentMessage({
        id, type, inCurrentOperationRange: true,
        parts: [
          textPart(id, 0, ""),
          textPart(id, 1, "  first\n"),
          textPart(id, 2, " \t\n　"),
          textPart(id, 3, "second"),
        ],
      })]);
      const rows = wrapper.findAll(`article[data-message-id="${id}"]`);
      assert.equal(rows.length, 4, "空白 TextPart 不删除或过滤");
      assert.deepEqual(rows.map((row) => row.findAllComponents({ name: "AgentMessageActions" }).length), [0, 1, 0, 1]);
      for (const index of [1, 3]) {
        const row = rows[index]!;
        assert.ok(row.classes().includes("group"));
        const action = row.getComponent({ name: "AgentMessageActions" });
        assert.equal(action.element.parentElement, row.element);
        assert.equal(action.props("messageId"), id);
        assert.equal(action.props("showFork"), true);
        assert.equal(action.props("showRevert"), type === "user");
        assert.equal(action.props("outside"), type === "user");
      }
      const textComponents = wrapper.findAllComponents({ name: type === "user" ? "AgentUserMessage" : "AssistantMarkdownMessage" });
      assert.deepEqual(textComponents.map((item) => item.props("text")), ["", "  first\n", " \t\n　", "second"]);
    } finally {
      wrapper.unmount();
    }
  });
}

test("真实 AgentClientPane：空文本、无 Part 和纯思考或工具消息均不展示工具栏", async () => {
  const { wrapper } = mountPane({ sessionReady: false });
  try {
    const messages = (["user", "assistant"] as const).flatMap((type) => [
      agentMessage({ id: `no-parts-${type}`, type }),
      textMessage({ id: `blank-${type}`, type, parts: [textPart(`blank-${type}`, 0, " \n\t　")] }),
      textMessage({ id: `empty-${type}`, type, parts: [textPart(`empty-${type}`, 0, "")] }),
    ]);
    messages.push(
      agentMessage({ id: "reasoning-only", parts: [{ id: "reason", messageId: "reasoning-only", position: 0, type: "reasoning", text: "think", updatedRevision: 1, createdAt: 1, updatedAt: 1 }] }),
      agentMessage({ id: "tool-only", parts: [{ id: "call", messageId: "tool-only", position: 0, type: "tool_call", toolName: "read", input: {}, providerToolCallId: null, updatedRevision: 1, createdAt: 1, updatedAt: 1 }] }),
    );
    await setTimeline(wrapper, messages);
    assert.equal(wrapper.findAllComponents({ name: "AgentMessageActions" }).length, 0);
    assert.equal(wrapper.findAll("article[data-message-id]").length, messages.length);
  } finally {
    wrapper.unmount();
  }
});

test("真实 AgentClientPane：流式 TextPart 从空白变为正文时展示工具栏", async () => {
  const { wrapper } = mountPane({ sessionReady: false });
  try {
    for (const text of ["", " \n", "回答"]) {
      await setTimeline(wrapper, [agentMessage({ id: "streaming-text", status: "streaming", parts: [textPart("streaming-text", 0, text)] })]);
      assert.equal(wrapper.findAllComponents({ name: "AgentMessageActions" }).length, text.trim() ? 1 : 0);
      assert.equal(wrapper.getComponent({ name: "AssistantMarkdownMessage" }).props("text"), text);
    }
  } finally {
    wrapper.unmount();
  }
});

test("真实 AgentClientPane：无 TextPart 的思考、工具与图片消息不渲染工具栏", async () => {
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
      assert.equal(rows.flatMap((row) => row.findAllComponents({ name: "AgentMessageActions" })).length, 0);
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
      textMessage({ id: "subtask-user", type: "user", inCurrentOperationRange: true }),
      textMessage({ id: "subtask-assistant", type: "assistant", inCurrentOperationRange: true }),
    ]);
    assert.equal(subtask.wrapper.findAllComponents({ name: "AgentMessageActions" }).length, 2);
    for (const actions of subtask.wrapper.findAllComponents({ name: "AgentMessageActions" })) {
      assert.equal(actions.props("showFork"), false); assert.equal(actions.props("showRevert"), false);
    }
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

function mountForkPane(forkSession: NonNullable<Parameters<typeof mountPane>[0]>["forkSession"], metadataReadContext?: MetadataReadContext) {
  const global = createMountGlobal({ getRunState: () => computed(() => baseRunState()) });
  const wrapper = mount(AgentClientPane, {
    attachTo: document.body,
    props: {
      workspaceId: "ws-a", toolId: "agent-tool", sessionId: "session-a", sessionKind: "primary", sessionTitle: "Session A",
      sessionReady: false, active: true, agentSelectionState: "ready", agentOptions: [], sessionModelStates: {}, sessionModelStateLoading: false,
      sessionModelMutationPending: false, modelOpenIntent: null, forkSession,
    },
    global: {
      ...global,
      provide: { ...global.provide, [agentSessionMetadataReadContextKey as symbol]: metadataReadContext },
      stubs: { ...componentStubs, AgentMessageActions: ForkActionsStub },
    },
  });
  (wrapper.vm as any).queue.apply(queueSnapshot());
  return wrapper;
}

test("真实 AgentClientPane：点击历史 Fork 构造请求、pending 禁用并 emit 新 Session，且不调用确认", async () => {
  const forkRecord = { ...timelineSnapshot([]).session, id: "forked-session", headMessageId: "historical-user", forkedFromSessionId: "session-a", forkedFromMessageId: "historical-user" };
  const completion = deferred<typeof forkRecord>();
  const requests: unknown[] = [];
  const originalConfirm = Modal.confirm;
  let confirmCalls = 0;
  const modal = Modal as unknown as { confirm: typeof Modal.confirm };
  modal.confirm = (() => { confirmCalls += 1; return { destroy() {}, update() {} }; }) as typeof Modal.confirm;
  const wrapper = mountForkPane(async (request) => { requests.push(request); return await completion.promise; });
  try {
    await setTimeline(wrapper, [textMessage({
      id: "historical-user", type: "user", inCurrentOperationRange: false,
      parts: [textPart("historical-user"), textPart("historical-user", 1, "后续正文")],
    })]);
    const action = wrapper.findAll('[data-testid="fork-action"]')[1]!;
    await action.trigger("click");
    await nextTick();
    assert.deepEqual(requests, [{ fromSessionId: "session-a", fromMessageId: "historical-user" }]);
    assert.equal((action.element as HTMLButtonElement).disabled, true);
    assert.equal(confirmCalls, 0);
    completion.resolve(forkRecord);
    await new Promise((resolve) => setImmediate(resolve));
    await nextTick();
    assert.equal((action.element as HTMLButtonElement).disabled, false);
    assert.deepEqual(wrapper.emitted("forked"), [[forkRecord, true]]);
  } finally {
    modal.confirm = originalConfirm;
    wrapper.unmount();
  }
});

test("真实 AgentClientPane：Fork 失败不 emit、恢复 pending 且不改写来源 timeline", async () => {
  const completion = deferred<import("@agent-workbench/shared").AgentSessionRecord>();
  const wrapper = mountForkPane(async () => await completion.promise);
  try {
    await setTimeline(wrapper, [textMessage({ id: "historical-assistant", type: "assistant", inCurrentOperationRange: false })]);
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

test("真实 AgentClientPane：后续 TextPart 的 Revert 确认后仍作用于整条消息", async () => {
  const http = mockContextRequests();
  const originalConfirm = Modal.confirm;
  let confirmCalls = 0;
  let confirmOnOk: (() => Promise<void>) | undefined;
  const modal = Modal as unknown as { confirm: typeof Modal.confirm };
  modal.confirm = ((options: { onOk: () => Promise<void> }) => {
    confirmCalls += 1;
    confirmOnOk = options.onOk;
    return { destroy() {}, update() {} };
  }) as unknown as typeof Modal.confirm;
  const wrapper = mountForkPane(async () => ({ ...timelineSnapshot([]).session, id: "unused" }));
  try {
    await setTimeline(wrapper, [agentMessage({
      id: "current-user",
      type: "user",
      inCurrentOperationRange: true,
      parts: [textPart("current-user", 3, "draft"), textPart("current-user", 4, " continuation")],
    })]);
    await wrapper.findAll('[data-testid="revert-action"]')[1]!.trigger("click");
    assert.equal(confirmCalls, 1);
    assert.equal(http.requests.length, 0, "确认前不能请求 Revert");
    assert.ok(confirmOnOk);
    const reverting = confirmOnOk();
    const request = await http.waitFor(0);
    assert.equal(request.url, "/agent/sessions/session-a/revert");
    assert.deepEqual(JSON.parse(request.data as string), { workspaceId: "ws-a", messageId: "current-user" });
    http.respond(0, {});
    await reverting;
    assert.equal((wrapper.vm as unknown as { draft: string }).draft, "draft continuation");
  } finally {
    modal.confirm = originalConfirm;
    wrapper.unmount();
    http.restore();
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
    assert.doesNotMatch(options[0]?.attributes("class") || "", /bg-transparent/, "选中背景不能被透明背景覆盖");
    assert.match(options[0]?.attributes("class") || "", /font-medium/);
    assert.doesNotMatch(options[0]?.attributes("class") || "", /border-l-/);
    assert.doesNotMatch(options[0]?.attributes("class") || "", /shadow-/);
    assert.match(options[1]?.attributes("class") || "", /bg-transparent/);

    const arrowDownEvent = createKeyboardEvent("ArrowDown");
    textarea.element.dispatchEvent(arrowDownEvent);
    await nextTick();
    assert.equal(arrowDownEvent.defaultPrevented, true);
    assert.equal(options[0]?.attributes("aria-selected"), "false");
    assert.match(options[0]?.attributes("class") || "", /bg-transparent/);
    assert.equal(options[1]?.attributes("aria-selected"), "true");
    assert.match(options[1]?.attributes("class") || "", /bg-blue-500\/25/);
    assert.doesNotMatch(options[1]?.attributes("class") || "", /bg-transparent/);

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
    await setTimeline(wrapper, [textMessage({
      id: "message-copy", type: "user",
      parts: [textPart("message-copy"), textPart("message-copy", 1, "后续正文")],
    })]);
    wrapper.findAllComponents({ name: "AgentMessageActions" })[1]!.vm.$emit("copy-message-id");
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

test("真实pane timeline在实际GET发起捕获token，手动标题后新GET收敛不能让旧timeline标题复活，正文仍接受", async () => {
  const http = mockContextRequests();
  const reads = createAgentSessionMetadataReads(() => ({ workspaceId: "ws-a", workspaceGeneration: 1 }));
  const { wrapper } = mountPane({ active: true, sessionReady: true, metadataReadContext: reads });
  try {
    const initial = await waitForTimelineRequest(http);
    // T is already in flight; manual success advances the local mutation watermark.
    reads.mutation("session-a");
    const current = reads.captureReadToken("ws-a", "session-a")!;
    assert.equal(reads.accept(current), "accepted");
    // Clearing an optional protected record does not clear the watermark.
    http.respond(initial, timelineSnapshot([agentMessage({ id: "late-body" })]));
    await new Promise((resolve) => setImmediate(resolve));
    await nextTick();
    const emitted = wrapper.emitted("session-metadata-updated") as Array<[TimelineMetadataEvent]>;
    assert.ok(emitted?.length);
    assert.ok(emitted[0]![0].readToken.readOrder < current.readOrder, "token来自请求发起，而不是响应到达");
    assert.equal(reads.accept(emitted[0]![0].readToken), "protected");
    const vm = wrapper.vm as any;
    assert.equal(vm.conversation.some((item: any) => item.message.id === "late-body"), true);
    assert.equal(http.requests.filter((r) => /\/sessions\/session-a$/.test(r.config.url ?? "")).length, 0, "旧标题拒绝不产生元数据dirty补查");
  } finally { wrapper.unmount(); http.restore(); }
});


test("真实pane Fork在请求发起时捕获激活意图，较新用户意图不抢回Tab", async () => {
  let current = true;
  const forkRecord = { ...timelineSnapshot([]).session, id: "late-fork", headMessageId: "historical-user" };
  const completion = deferred<typeof forkRecord>();
  const wrapper = mountForkPane(async () => completion.promise, {
    captureReadToken: () => null,
    captureActivationGuard: () => () => current,
  });
  try {
    await setTimeline(wrapper, [textMessage({ id: "historical-user", type: "user", inCurrentOperationRange: false })]);
    await wrapper.get('[data-testid="fork-action"]').trigger("click");
    current = false;
    completion.resolve(forkRecord);
    await new Promise((resolve) => setImmediate(resolve));
    await nextTick();
    assert.deepEqual(wrapper.emitted("forked"), [[forkRecord, false]]);
  } finally { wrapper.unmount(); }
});

for (const pending of [false, true]) {
  test(`通知资源清理：${pending ? "微任务内尚未初始化" : "已显示"}的真实 message/notification 销毁 DOM 和长计时器`, async (t) => {
    const messageText = "cleanup-regression-message";
    const notificationText = "cleanup-regression-notification";
    const insertedText: string[] = [];
    const observe = (records: MutationRecord[]) => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) insertedText.push(node.textContent ?? "");
      }
    };
    const observer = new window.MutationObserver(observe);
    observer.observe(document.body, { childList: true, subtree: true });
    // Spies call the real timers: these 30s notices must be explicitly destroyed.
    const clearNoticeTimer = globalThis.clearTimeout.bind(globalThis);
    const timers = t.mock.method(globalThis, "setTimeout");
    const cleared = t.mock.method(globalThis, "clearTimeout");
    const openNotices = () => {
      message.open({ content: messageText, duration: 30 });
      notification.open({ message: notificationText, description: "real notice", duration: 30 });
    };
    let testFailure: unknown;
    let hasTestFailure = false;
    try {
      if (pending) {
        queueMicrotask(openNotices);
      } else {
        openNotices();
        await nextTick();
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.ok(document.querySelector(".ant-message-notice"));
        assert.ok(document.querySelector(".ant-notification-notice"));
      }

      await clearComponentNotifications();
      observe(observer.takeRecords());
      assert.ok(insertedText.some((text) => text.includes(messageText)), "real message content was inserted");
      assert.ok(insertedText.some((text) => text.includes(notificationText)), "real notification content was inserted");
      const longTimers = timers.mock.calls.filter((call) => call.arguments[1] === 30_000);
      assert.equal(longTimers.length, 2, "both notices initialized their real long-duration close timers");
      for (const call of longTimers) {
        assert.ok(cleared.mock.calls.some((cancel) => cancel.arguments[0] === call.result), "destroy cancelled the notice timer");
      }
      assert.equal(document.querySelector(".ant-message"), null);
      assert.equal(document.querySelector(".ant-notification"), null);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(timers.mock.calls.filter((call) => call.arguments[1] === 30_000).length, 2, "no late notice recreated a timer");
    } catch (error) {
      testFailure = error;
      hasTestFailure = true;
      throw error;
    } finally {
      try {
        await nextTick();
        await clearComponentNotifications();
      } catch (cleanupError) {
        if (hasTestFailure) {
          throw new AggregateError([testFailure, cleanupError], "Notice assertion and cleanup both failed", { cause: testFailure });
        }
        throw cleanupError;
      } finally {
        try {
          // Independent safety net only after the cancellation assertions above.
          // Never leave this test's 30s handles alive if the helper regresses.
          for (const call of timers.mock.calls) {
            if (call.arguments[1] === 30_000) clearNoticeTimer(call.result);
          }
        } finally {
          try {
            observer.disconnect();
          } finally {
            try {
              timers.mock.restore();
            } finally {
              cleared.mock.restore();
            }
          }
        }
      }
    }
  });
}


test("真实 AgentClientPane：Agent 初始化中/失败禁止普通发送和 compact，失败可重试", async () => {
  const http = mockContextRequests();
  let ensured = 0;
  const { wrapper } = mountPane({ initialDraft: "Hello", ensureSession: async (id) => { ensured += 1; return id; } });
  const vm = wrapper.vm as any;
  try {
    for (const state of ["loading", "error"] as const) {
      await wrapper.setProps({ agentSelectionState: state });
      assert.equal(wrapper.find('[data-testid="agent-selection-status"]').exists(), true);
      vm.draft = "Hello"; await vm.onSend();
      vm.draft = "/compact"; await vm.onSend();
      assert.equal(http.requests.length, 0);
      assert.equal(ensured, 0);
    }
    await wrapper.get('[data-testid="agent-selection-retry"]').trigger("click");
    assert.equal(wrapper.emitted("retry-agent-selection")?.length, 1);
    await wrapper.setProps({ agentSelectionState: "ready", agentOptions: [] });
    vm.draft = "Hello"; await vm.onSend();
    vm.draft = "/compact"; await vm.onSend();
    assert.equal(http.requests.length, 0, "no available Agent also blocks all sends");
    await wrapper.setProps({ agentOptions: [{ value: "agent-b", label: "Agent B" }] });
    vm.draft = "Hello";
    const send = vm.onSend();
    const request = await http.waitFor(0);
    assert.match(request.url || "", /receipts/);
    http.respond(0, injectedReceipt("selection-ready-run", "session-a")); await send;
  } finally {
    panePendingRuns(wrapper).remove({ workspaceId: "ws-a", sessionId: "session-a", runKind: "user", runId: "selection-ready-run" });
    wrapper.unmount(); http.restore();
  }
});


for (const text of ["Hello", "/compact"]) {
  test(`真实 AgentClientPane：${text} 等待 Session 创建期间 Agent 状态失效时不发送`, async () => {
    const ensured = deferred<string>();
    const http = mockContextRequests();
    const { wrapper } = mountPane({ initialDraft: text, ensureSession: () => ensured.promise });
    const vm = wrapper.vm as any;
    try {
      await wrapper.setProps({ agentSelectionState: "ready" });
      vm.promptSettingsLoaded = true;
      const send = vm.onSend();
      await nextTick();
      await wrapper.setProps({ agentSelectionState: "error" });
      ensured.resolve("session-a"); await send;
      assert.equal(http.requests.length, 0);
    } finally { wrapper.unmount(); http.restore(); }
  });
}

test("真实 AgentClientPane：初始化完成后 compact 使用已恢复的 Agent；初始化前 Enter 不触发", async () => {
  const http = mockContextRequests();
  const { wrapper } = mountPane({ initialDraft: "/compact", modelValue: "agent-c" });
  const vm = wrapper.vm as any;
  try {
    vm.promptSettingsLoaded = true;
    await wrapper.setProps({ agentSelectionState: "loading" });
    wrapper.get("a-textarea").element.dispatchEvent(createKeyboardEvent("Enter")); await nextTick();
    assert.equal(http.requests.length, 0);
    await wrapper.setProps({ agentSelectionState: "ready" });
    const send = vm.onSend();
    const request = await http.waitFor(0);
    assert.match(request.url || "", /compact/);
    assert.equal(JSON.parse(String(request.data)).agentId, "agent-c");
    http.respond(0, { runId: "compact-selection-run" }); await send;
  } finally {
    panePendingRuns(wrapper).remove({ workspaceId: "ws-a", sessionId: "session-a", runKind: "manual_compaction", runId: "compact-selection-run" });
    wrapper.unmount(); http.restore();
  }
});

test("错误提示单行截断，详情固定尾部；弹窗用纯文本快照且切换会话清理", async () => {
  const detail = { statusCode: 503, responseBody: '<script>not executable</script>\n{"error":"busy"}', message: "upstream failed", truncated: true };
  const { wrapper, setRunState } = mountPane({
    runState: baseRunState({ runNoticeText: "Request failed, retrying in 4s: Error", modelRequestError: detail }),
    contextLocale: "zh-CN", renderModalSlots: true,
  });
  try {
    const notice = wrapper.get('[data-testid="run-notice"]');
    assert.ok(notice.get("span").classes().includes("truncate"));
    const button = wrapper.get('[data-testid="model-error-details-button"]');
    assert.ok(button.classes().includes("shrink-0"));
    assert.equal(button.text(), "详情");
    await button.trigger("click");
    const body = wrapper.get('[data-testid="model-error-response-body"]');
    assert.equal(body.text(), detail.responseBody);
    assert.equal(body.find("script").exists(), false);
    assert.match(wrapper.get('[data-testid="visible-modal"]').text(), /HTTP 503/);
    assert.match(wrapper.get('[data-testid="visible-modal"]').text(), /已截断/);
    setRunState({ runNoticeText: "next retry", modelRequestError: { ...detail, responseBody: "new response" } });
    await nextTick();
    assert.equal(body.text(), detail.responseBody, "polling must not replace the open failure snapshot");
    setRunState({ runNoticeText: "", modelRequestError: null });
    await nextTick();
    assert.equal(wrapper.find('[data-testid="model-error-details-button"]').exists(), false);
    assert.equal(body.text(), detail.responseBody, "recovery must not erase a dialog already being read");
    await wrapper.setProps({ sessionId: "session-b" });
    assert.equal(wrapper.find('[data-testid="visible-modal"]').exists(), false);
    assert.equal((wrapper.vm as unknown as { modelErrorSnapshot: unknown }).modelErrorSnapshot, null);
  } finally { wrapper.unmount(); }
});

test("没有响应体时详情明确提示原因，普通运行提示没有详情按钮", async () => {
  const { wrapper, setRunState } = mountPane({ contextLocale: "zh-CN", renderModalSlots: true,
    runState: baseRunState({ runNoticeText: "Request failed", modelRequestError: { statusCode: null, responseBody: null, message: "Model idle timeout after 60000ms", truncated: false } }),
  });
  try {
    await wrapper.get('[data-testid="model-error-details-button"]').trigger("click");
    const modal = wrapper.get('[data-testid="visible-modal"]');
    assert.match(modal.text(), /未收到响应体/);
    assert.match(modal.text(), /idle timeout after 60000ms/);
    assert.equal(modal.find("pre").exists(), false);
    setRunState({ runNoticeText: "正在压缩上下文", modelRequestError: null }); await nextTick();
    assert.equal(wrapper.find('[data-testid="model-error-details-button"]').exists(), false);
  } finally { wrapper.unmount(); }
});


test("错误详情复制使用当前弹窗快照", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const copied: string[] = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { copied.push(value); } } });
  const { wrapper, setRunState } = mountPane({ contextLocale: "zh-CN", renderModalSlots: true,
    runState: baseRunState({ runNoticeText: "Request failed", modelRequestError: { statusCode: 429, responseBody: "rate limited", message: "HTTP 429", truncated: false } }),
  });
  try {
    await wrapper.get('[data-testid="model-error-details-button"]').trigger("click");
    setRunState({ modelRequestError: null, runNoticeText: "" }); await nextTick();
    await (wrapper.vm as unknown as { copyModelErrorDetails: () => Promise<void> }).copyModelErrorDetails();
    assert.equal(copied.length, 1); assert.match(copied[0]!, /HTTP 429/); assert.match(copied[0]!, /rate limited/);
  } finally {
    wrapper.unmount();
    if (descriptor) Object.defineProperty(navigator, "clipboard", descriptor);
    else delete (navigator as { clipboard?: unknown }).clipboard;
  }
});


test("切换会话 Tab 即使保留 Pane 实例，也关闭错误详情并清空快照", async () => {
  const { wrapper } = mountPane({ active: true, contextLocale: "zh-CN", renderModalSlots: true,
    runState: baseRunState({ runNoticeText: "Request failed", modelRequestError: { statusCode: 503, responseBody: "busy", message: "HTTP 503", truncated: false } }),
  });
  try {
    await wrapper.get('[data-testid="model-error-details-button"]').trigger("click");
    assert.equal(wrapper.find('[data-testid="visible-modal"]').exists(), true);
    await wrapper.setProps({ active: false });
    assert.equal(wrapper.find('[data-testid="visible-modal"]').exists(), false);
    assert.equal((wrapper.vm as unknown as { modelErrorSnapshot: unknown }).modelErrorSnapshot, null);
  } finally { wrapper.unmount(); }
});


function queuedStartupResponse(clientRequestId: string) {
  const result = acceptedQueuedSubmission(clientRequestId);
  return { ...result, queue: { ...result.queue, pendingCount: 1,
    pendingIdentity: { agentId: "agent-b", providerId: "p", modelId: "m" },
    items: [{ ...result.receipt, textPreview: "start", attachmentCount: 0 }] } };
}

for (const first of ["queue", "state"] as const) test(`空闲首条消息：隐藏短暂排队并保持 loading，${first} 先更新均无闪现或虚假 Run`, async () => {
  const http = mockContextRequests({ autoTimeline: true });
  const { wrapper, setRunState } = mountPane({ initialDraft: "start", contextLocale: "zh-CN" }); const vm = wrapper.vm as any;
  try {
    const sending = vm.onSend(), request = await http.waitFor(0);
    const accepted = queuedStartupResponse(sendPayload(request).clientRequestId);
    http.respond(0, accepted); await sending; await nextTick();
    assert.equal(vm.queue.snapshot.value.pendingCount, 1, "presentation never alters authoritative count");
    assert.equal(wrapper.find('[data-testid="queue-pending-count"]').exists(), false);
    assert.equal(wrapper.find('[data-testid="agent-run-loading"]').exists(), true);
    assert.equal(panePendingRuns(wrapper).list("ws-a", "session-a").length, 0);
    const updateQueue = () => vm.queue.apply({ ...queueSnapshot(), queueVersion: 2 });
    const updateState = () => setRunState({ status: "running", activeRunId: "real-startup-run" });
    (first === "queue" ? updateQueue : updateState)(); await nextTick();
    assert.equal(wrapper.find('[data-testid="queue-pending-count"]').exists(), false);
    assert.equal(wrapper.find('[data-testid="agent-run-loading"]').exists(), true);
    (first === "queue" ? updateState : updateQueue)(); await nextTick();
    assert.equal(vm.queueStartupRequestId, null);
    assert.equal(wrapper.find('[data-testid="agent-run-loading"]').exists(), true);
    setRunState({ status: "idle", activeRunId: null }); await nextTick();
    assert.equal(wrapper.find('[data-testid="agent-run-loading"]').exists(), false);
  } finally { wrapper.unmount(); http.restore(); }
});

test("空闲首条消息：1 秒后仍未调度则显示真实等待数量，不继续虚假 loading", async () => {
  const http = mockContextRequests({ autoTimeline: true });
  const { wrapper } = mountPane({ initialDraft: "start", contextLocale: "zh-CN" }); const vm = wrapper.vm as any;
  try {
    const sending = vm.onSend(), request = await http.waitFor(0);
    http.respond(0, queuedStartupResponse(sendPayload(request).clientRequestId)); await sending; await nextTick();
    assert.equal(wrapper.find('[data-testid="queue-pending-count"]').exists(), false);
    await new Promise(resolve => setTimeout(resolve, 1050)); await nextTick();
    assert.equal(wrapper.get('[data-testid="queue-pending-count"]').text(), "有 1 条消息等待处理");
    assert.equal(wrapper.find('[data-testid="agent-run-loading"]').exists(), false);
    assert.equal(vm.queue.snapshot.value.pendingCount, 1);
  } finally { wrapper.unmount(); http.restore(); }
});

for (const backlog of ["second", "other"] as const) test(`空闲首条消息：${backlog} 排队时立即恢复真实数量`, async () => {
  const http = mockContextRequests({ autoTimeline: true });
  const { wrapper } = mountPane({ initialDraft: "start", contextLocale: "zh-CN" }); const vm = wrapper.vm as any;
  try {
    const sending = vm.onSend(), request = await http.waitFor(0);
    const accepted = queuedStartupResponse(sendPayload(request).clientRequestId);
    http.respond(0, accepted); await sending; await nextTick();
    vm.queue.apply({ ...accepted.queue, queueVersion: 2, pendingCount: backlog === "second" ? 2 : 1,
      items: backlog === "second" ? [...accepted.queue.items, { ...accepted.queue.items[0], id: "second", clientRequestId: "other" }]
        : [{ ...accepted.queue.items[0], clientRequestId: "other" }] });
    await nextTick();
    assert.equal(wrapper.get('[data-testid="queue-pending-count"]').text(), `有 ${backlog === "second" ? 2 : 1} 条消息等待处理`);
    assert.equal(wrapper.find('[data-testid="agent-run-loading"]').exists(), false);
    vm.queue.apply({ ...accepted.queue, queueVersion: 3, items: [{ ...accepted.queue.items[0], clientRequestId: "other" }] });
    await nextTick();
    assert.equal(wrapper.get('[data-testid="queue-pending-count"]').text(), "有 1 条消息等待处理");
  } finally { wrapper.unmount(); http.restore(); }
});

for (const blocked of ["stop_pending", "stop_unknown"] as const) test(`空闲首条消息：${blocked} 不隐藏真实等待`, async () => {
  const http = mockContextRequests({ autoTimeline: true });
  const { wrapper } = mountPane({ initialDraft: "start", contextLocale: "zh-CN" }); const vm = wrapper.vm as any;
  try {
    const sending = vm.onSend(), request = await http.waitFor(0);
    const accepted = queuedStartupResponse(sendPayload(request).clientRequestId);
    http.respond(0, accepted); await sending; await nextTick();
    vm.queue.apply({ ...accepted.queue, queueVersion: 2,
      ...(blocked.startsWith("stop_") ? { stop: { state: blocked === "stop_pending" ? "pending" : "unknown",
        unresolvedOperationCount: 1, unresolvedTargetCount: 1, code: "transport_timeout" } } : {}),
    });
    await nextTick();
    assert.equal(wrapper.get('[data-testid="queue-pending-count"]').text(), "有 1 条消息等待处理");
    assert.equal(vm.queueStartupRequestId, null);
    assert.equal(wrapper.find('[data-testid="agent-run-loading"]').exists(), false);
  } finally { wrapper.unmount(); http.restore(); }
});

for (const failure of ["rejected", "unknown"] as const) test(`空闲首条消息：${failure} 和作用域切换均清理过渡及定时器`, async (t) => {
  const timers = t.mock.method(globalThis, "setTimeout");
  const cleared = t.mock.method(globalThis, "clearTimeout");
  const http = mockContextRequests({ autoTimeline: true });
  const { wrapper } = mountPane({ initialDraft: "start", contextLocale: "zh-CN" }); const vm = wrapper.vm as any;
  try {
    const sending = vm.onSend(); await http.waitFor(0);
    assert.ok(vm.queueStartupRequestId);
    http.reject(0, failure === "rejected"
      ? new ApiError({ status: 409, code: "AGENT_QUEUE_STOP_GENERATION_CHANGED", message: "retry explicitly" }) : new Error("connection lost"));
    await sending; await nextTick();
    assert.equal(vm.queueStartupRequestId, null);
    assert.equal(wrapper.find('[data-testid="agent-run-loading"]').exists(), false);
    forgetTestSubmission(vm);
    const retry = vm.onSend(), request = await http.waitFor(1);
    http.respond(1, queuedStartupResponse(sendPayload(request).clientRequestId)); await retry; await nextTick();
    assert.ok(vm.queueStartupRequestId);
    const startupTimer = timers.mock.calls.find(call => call.arguments[0] === vm.clearQueueStartup && call.arguments[1] === 1000)?.result;
    assert.ok(startupTimer);
    await wrapper.setProps(failure === "rejected" ? { sessionId: "session-b" } : { workspaceId: "ws-b" });
    assert.ok(cleared.mock.calls.some(call => call.arguments[0] === startupTimer));
    assert.equal(vm.queueStartupRequestId, null);
    assert.equal(wrapper.find('[data-testid="agent-run-loading"]').exists(), false);
  } finally { forgetTestSubmission(vm); wrapper.unmount(); http.restore(); }
});

test("空闲首条消息：发送期间组件重建，真实 Session 接续启动展示", async () => {
  const http = mockContextRequests({ autoTimeline: true });
  const original = mountPane({ initialDraft: "start", contextLocale: "zh-CN" }).wrapper;
  let successor: ReturnType<typeof mountPane>["wrapper"] | null = null;
  try {
    const sending = (original.vm as any).onSend(), request = await http.waitFor(0);
    original.unmount();
    successor = mountPane({ contextLocale: "zh-CN" }).wrapper;
    const vm = successor.vm as any;
    assert.equal(successor.find('[data-testid="agent-run-loading"]').exists(), true);
    const accepted = queuedStartupResponse(sendPayload(request).clientRequestId);
    http.respond(0, accepted); await sending;
    vm.queue.apply(accepted.queue); await nextTick();
    assert.equal(successor.find('[data-testid="queue-pending-count"]').exists(), false);
    assert.equal(successor.find('[data-testid="agent-run-loading"]').exists(), true);
    assert.equal(panePendingRuns(successor).list("ws-a", "session-a").length, 0);
  } finally { successor?.unmount(); if (!successor) original.unmount(); http.restore(); }
});

test("真实 AgentClientPane：运行中普通消息使用 receipt，N 位于输入框上方，不登记虚假 Run，并保留等待期间新草稿", async () => {
  const http = mockContextRequests();
  const { wrapper } = mountPane({ initialDraft: "first", runState: baseRunState({ status: "running", activeRunId: "existing-run" }), contextLocale: "zh-CN", renderModalSlots: true });
  const vm = wrapper.vm as any;
  try {
    const send = vm.onSend(); const request = await http.waitFor(0);
    assert.match(request.url || "", /\/receipts$/);
    assert.equal(wrapper.get("a-textarea").attributes("readonly"), undefined);
    vm.draft = "new draft entered while receipt was pending";
    const receipt = { id: "queued-receipt", clientRequestId: JSON.parse(String(request.data)).clientRequestId, sequence: 1, createdAt: 1, updatedAt: 1,
      status: "queued", messageId: null, runId: null };
    http.respond(0, { receipt, deduplicated: false, queue: { ...queueSnapshot(), queueVersion: 1, pendingCount: 1,
      items: [{ ...receipt, textPreview: "first", attachmentCount: 0 }] } });
    await send; await nextTick();
    assert.equal(vm.draft, "new draft entered while receipt was pending");
    assert.equal(vm.awaitingRunStateRunId, null); assert.equal(panePendingRuns(wrapper).list("ws-a", "session-a").length, 0);
    const count = wrapper.get('[data-testid="queue-pending-count"]'); assert.equal(count.text(), "有 1 条消息等待处理");
    const textarea = wrapper.get("a-textarea").element;
    assert.ok(count.element.compareDocumentPosition(textarea) & Node.DOCUMENT_POSITION_FOLLOWING);
  } finally { wrapper.unmount(); http.restore(); }
});
test("真实 AgentClientPane：未知提交按原 ID 查询，确认旧提交不清掉后来编辑的文字和图片", async () => {
  const http = mockContextRequests(); const { wrapper } = mountPane({ initialDraft: "original input", contextLocale: "zh-CN", active: true, renderRealModal: true });
  const vm = wrapper.vm as any;
  try {
    const originalImage = { id: "old-image", filename: "old.png", file: new File(["old"], "old.png", { type: "image/png" }) };
    const newImage = { id: "new-image", filename: "new.png", file: new File(["new"], "new.png", { type: "image/png" }) };
    vm.pendingImages = [originalImage];
    const sending = vm.onSend(); const original = await http.waitFor(0);
    const requestId = JSON.parse(String((original.data as FormData).get("payload"))).clientRequestId;
    vm.draft = "later input"; vm.pendingImages = [originalImage, newImage];
    http.reject(0, new Error("connection lost")); await sending; await flushQueueUi();
    assert.equal(wrapper.find('[data-testid="queue-submission-unknown"]').exists(), false);
    assert.equal(vm.$props.active, true);
    assert.equal(vm.queueSubmissionHandoff?.phase, "unknown");
    assert.match(document.body.textContent ?? "", /查询接收结果/);
    assert.equal(wrapper.find('[data-testid="queue-pending-count"]').exists(), false);
    const lookupButton = [...document.body.querySelectorAll("button")].find(button => button.textContent === "查询接收结果");
    assert.ok(lookupButton); lookupButton.click();
    const request = await http.waitFor(1);
    assert.match(request.url || "", /receipts\/by-request$/); assert.equal(request.params.clientRequestId, requestId);
    const acknowledged = injectedReceipt("actual-recovered-run");
    http.respond(1, { receipt: acknowledged.receipt, queue: acknowledged.queue }); await flushQueueUi();
    assert.equal(vm.draft, "later input"); assert.deepEqual(vm.pendingImages.map((image: { id: string }) => image.id), ["new-image"]);
    assert.equal(wrapper.find('[data-testid="queue-submission-unknown"]').exists(), false);
  } finally { wrapper.unmount(); http.restore(); }
});
for (const stopState of ["pending", "unknown", "quiescent"] as const) test(`真实 AgentClientPane：取消后 ${stopState} 的 Fork/回退只受执行屏障约束`, async () => {
  const { wrapper } = mountPane({ sessionReady: false }); const vm = wrapper.vm as any;
  try {
    await setTimeline(wrapper, [
      textMessage({ id: "cancelled-user", type: "user", inCurrentOperationRange: true }),
      textMessage({ id: "cancelled-response", depth: 1, type: "assistant", status: "cancelled", inCurrentOperationRange: true }),
    ]);
    vm.queue.apply({ ...queueSnapshot(), queueVersion: 1, stop: { state: stopState,
      unresolvedOperationCount: stopState === "quiescent" ? 0 : 1, unresolvedTargetCount: stopState === "quiescent" ? 0 : 1, code: null } });
    await nextTick();
    const actions = wrapper.findAllComponents({ name: "AgentMessageActions" });
    assert.equal(actions.length, 2);
    for (const action of actions) assert.equal(action.props("showFork"), stopState === "quiescent");
    assert.equal(actions[0]!.props("showRevert"), stopState === "quiescent");
    assert.equal(actions[1]!.props("showRevert"), false);
    assert.equal(vm.queue.historyBlocked.value, stopState !== "quiescent");
  } finally { wrapper.unmount(); }
});

test("真实 AgentClientPane：安全取消后不展示输入状态或恢复入口", async () => {
  const http = mockContextRequests(); const { wrapper } = mountPane({ contextLocale: "zh-CN" }); const vm = wrapper.vm as any;
  try {
    vm.queue.apply({ ...queueSnapshot(), queueVersion: 4, stop: { state: "quiescent", unresolvedOperationCount: 0, unresolvedTargetCount: 0, code: null } });
    await nextTick();
    assert.equal(wrapper.get('[data-testid="agent-message-queue"]').text(), "");
    assert.equal(wrapper.find('[data-testid="message-input-receipt"]').exists(), false);
    assert.equal(wrapper.find('[data-testid="queue-items"]').exists(), false);
    assert.equal(wrapper.text().includes("放弃全部未确认输入"), false);
    assert.equal(http.requests.length, 0);
  } finally { wrapper.unmount(); http.restore(); }
});
function readyQueueModelState(): AgentSessionAgentModelState {
  return {
    sessionId: "session-a", agentId: "agent-c", agentName: "Agent C", editable: false,
    agentDefaultModel: { providerId: "p", modelId: "default" },
    override: { providerId: "p", modelId: "m", updatedAt: 1 },
    effectiveModel: { providerId: "p", modelId: "m", providerName: "Provider", modelName: "Override Model", contextWindowTokens: 1000 },
    source: "session_override", status: "ready", reasonCode: null, message: null,
  };
}

test("真实 AgentClientPane：运行前中后保持会话覆盖模型名称，运行时仍锁定选择", async () => {
  const { wrapper, runState } = mountPane({ modelValue: "agent-c" });
  const vm = wrapper.vm as any;
  try {
    await wrapper.setProps({
      agentOptions: [{ value: "agent-c", resolvedModel: { providerId: "p", modelId: "default", providerName: "Default Provider", modelName: "Default Model" } }],
      sessionModelStates: { "agent-c": readyQueueModelState() },
    });
    assert.equal(vm.sessionModelLabel, "Provider / Override Model");
    runState.status = "running"; runState.activeRunId = "run-model";
    vm.queue.apply({ ...queueSnapshot(), queueVersion: 1, inputIdentity: { agentId: "agent-c", providerId: "p", modelId: "m" } });
    await nextTick();
    assert.equal(vm.sessionModelLabel, "Provider / Override Model");
    assert.ok(wrapper.text().includes("Provider / Override Model"));
    assert.equal(wrapper.getComponent({ name: "ASelect" }).attributes("disabled"), "true");
    runState.status = "idle"; runState.activeRunId = null;
    vm.queue.apply({ ...queueSnapshot(), queueVersion: 2 });
    await nextTick();
    assert.equal(vm.sessionModelLabel, "Provider / Override Model");
    assert.equal(vm.queueIdentityLocked, false);
  } finally { wrapper.unmount(); }
});

test("真实 AgentClientPane：执行、恢复和等待身份均使用锁定 Agent 的匹配名称", async () => {
  const { wrapper } = mountPane({ modelValue: "agent-a" }); const vm = wrapper.vm as any;
  try {
    const staleState = readyQueueModelState();
    staleState.effectiveModel = { ...staleState.effectiveModel!, modelId: "old", modelName: "Old Model" };
    await wrapper.setProps({
      agentOptions: [
        { value: "agent-a", resolvedModel: { providerId: "p", modelId: "m", providerName: "Wrong Agent Provider", modelName: "Wrong Agent Model" } },
        { value: "agent-c", resolvedModel: { providerId: "p", modelId: "m", providerName: "Provider", modelName: "Model" } },
      ],
      sessionModelStates: { "agent-c": staleState },
    });
    let version = 0;
    for (const field of ["inputIdentity", "pendingIdentity"] as const) {
      vm.queue.apply({ ...queueSnapshot(), queueVersion: ++version, [field]: { agentId: "agent-c", providerId: "p", modelId: "m" } });
      await nextTick();
      assert.equal(vm.effectiveAgentId, "agent-c");
      assert.equal(vm.sessionModelLabel, "Provider / Model", field);
      assert.equal(vm.queueIdentityLocked, true);
    }
  } finally { wrapper.unmount(); }
});

test("真实 AgentClientPane：名称必须同时匹配 provider/model，未知名称降级 ID 并响应后续加载", async () => {
  const { wrapper } = mountPane({ modelValue: "agent-c" }); const vm = wrapper.vm as any;
  try {
    vm.queue.apply({ ...queueSnapshot(), queueVersion: 1, inputIdentity: { agentId: "agent-c", providerId: "p", modelId: "m" } });
    for (const ref of [{ providerId: "other", modelId: "m" }, { providerId: "p", modelId: "other" }]) {
      const state = readyQueueModelState();
      state.effectiveModel = { ...state.effectiveModel!, ...ref };
      await wrapper.setProps({
        agentOptions: [{ value: "agent-c", resolvedModel: { ...ref, providerName: "Wrong Provider", modelName: "Wrong Model" } }],
        sessionModelStates: { "agent-c": state },
      });
      assert.equal(vm.sessionModelLabel, "p / m");
    }
    await wrapper.setProps({ agentOptions: [{ value: "agent-c" }], sessionModelStates: {}, sessionModelStateLoading: true });
    assert.equal(vm.sessionModelLabel, "p / m");
    const invalidState = { ...readyQueueModelState(), status: "invalid" as const };
    await wrapper.setProps({ sessionModelStates: { "agent-c": invalidState } });
    assert.equal(vm.sessionModelLabel, "p / m", "unavailable state must not supply stale names");
    await wrapper.setProps({ sessionModelStates: { "agent-c": readyQueueModelState() }, sessionModelStateLoading: false });
    assert.equal(vm.sessionModelLabel, "Provider / Override Model");
    assert.equal(vm.queueIdentityLocked, true);
  } finally { wrapper.unmount(); }
});

test("真实 AgentClientPane：服务端执行身份锁定 Agent/model，停止未知时隐藏历史写操作但仍可编辑输入", async () => {
  const { wrapper } = mountPane({ modelValue: "agent-a" }); const vm = wrapper.vm as any;
  try {
    vm.queue.apply({ ...queueSnapshot(), queueVersion: 1, inputIdentity: { agentId: "agent-c", providerId: "authoritative-provider", modelId: "authoritative-model" },
      stop: { state: "unknown", unresolvedOperationCount: 1, unresolvedTargetCount: 1, code: "transport_timeout" } });
    await setTimeline(wrapper, [textMessage({ id: "history", type: "user" })]);
    assert.equal(vm.effectiveAgentId, "agent-c"); assert.equal(vm.sessionModelLabel, "authoritative-provider / authoritative-model");
    assert.equal(wrapper.getComponent({ name: "ASelect" }).attributes("disabled"), "true");
    assert.equal(wrapper.findComponent({ name: "AgentMessageActions" }).props("showFork"), false);
    assert.equal(wrapper.findComponent({ name: "AgentMessageActions" }).props("showRevert"), false);
    assert.equal(wrapper.get("a-textarea").attributes("readonly"), undefined);
  } finally { wrapper.unmount(); }
});

test("真实 AgentClientPane：组件重建后查询原未知提交不清除新编辑器中同文案的草稿", async () => {
  const http = mockContextRequests(); let wrapper = mountPane({ initialDraft: "same draft", active: true, contextLocale: "zh-CN", renderRealModal: true }).wrapper;
  try {
    const send = (wrapper.vm as any).onSend(); await http.waitFor(0);
    http.reject(0, new Error("timeout")); await send; wrapper.unmount();
    wrapper = mountPane({ initialDraft: "same draft", active: true, contextLocale: "zh-CN", renderRealModal: true }).wrapper;
    const vm = wrapper.vm as any;
    await flushQueueUi();
    queueDialogButton("查询接收结果").click(); await http.waitFor(1);
    const acknowledged = injectedReceipt("old-composer-run");
    http.respond(1, { receipt: acknowledged.receipt, queue: acknowledged.queue }); await flushQueueUi();
    assert.equal(vm.draft, "same draft", "a different composer never owns the previous submission's draft version");
  } finally { wrapper.unmount(); http.restore(); }
});

test("真实 textarea Tab/Shift+Tab 和 select 更新均不能绕过队列身份锁，解锁保留原选择", async () => {
  const { wrapper } = mountPane({ modelValue: "agent-a", renderRealTextarea: true }); const vm = wrapper.vm as any;
  try {
    vm.queue.apply({ ...queueSnapshot(), queueVersion: 1, inputIdentity: { agentId: "agent-c", providerId: "p", modelId: "m" } });
    await nextTick();
    await wrapper.get("textarea").trigger("keydown", { key: "Tab" });
    await wrapper.get("textarea").trigger("keydown", { key: "Tab", shiftKey: true });
    wrapper.getComponent({ name: "ASelect" }).vm.$emit("update:value", "agent-b"); await nextTick();
    assert.equal(wrapper.emitted("update:modelValue"), undefined);
    assert.equal((wrapper.props() as { modelValue: string }).modelValue, "agent-a"); assert.equal(vm.effectiveAgentId, "agent-c");
    vm.queue.apply({ ...queueSnapshot(), queueVersion: 2 }); await nextTick();
    assert.equal(vm.effectiveAgentId, "agent-a");
    await wrapper.get("textarea").trigger("keydown", { key: "Tab" });
    assert.deepEqual(wrapper.emitted("update:modelValue"), [["agent-b"]]);
  } finally { wrapper.unmount(); }
});

test("真实 textarea：Esc 两次独立按键先清队列再停止，repeat/IME/busy 不会误停，四态 Placeholder 同步", async () => {
  const http = mockContextRequests();
  const { wrapper } = mountPane({ contextLocale: "zh-CN", renderRealTextarea: true, runState: baseRunState({ status: "running", activeRunId: "esc-running" }), initialDraft: "keep draft" });
  const vm = wrapper.vm as any;
  const item = { id: "esc-queued", clientRequestId: "esc-request", sequence: 1, createdAt: 1, updatedAt: 1, status: "queued" as const,
    messageId: null, runId: null, textPreview: "waiting", attachmentCount: 0 };
  try {
    assert.equal(wrapper.get("textarea").attributes("placeholder"), "输入消息加入队列，Esc 停止运行");
    assert.equal(wrapper.text().includes("取消运行"), false); assert.equal(wrapper.text().includes("继续处理"), false);
    vm.queue.apply({ ...queueSnapshot(), queueVersion: 1, pendingCount: 1, items: [item] }); await nextTick();
    assert.equal(wrapper.get("textarea").attributes("placeholder"), "输入消息加入队列，Esc 清空等待消息");
    await wrapper.get("textarea").trigger("keydown", { key: "Escape", isComposing: true });
    await wrapper.get("textarea").trigger("keydown", { key: "Escape", repeat: true }); assert.equal(http.requests.length, 0);
    await wrapper.get("textarea").trigger("keydown", { key: "Escape" });
    const first = await http.waitFor(0); assert.match(first.url || "", /message-queue\/clear$/);
    assert.deepEqual(JSON.parse(String(first.data)).receiptIds, ["esc-queued"]);
    await wrapper.get("textarea").trigger("keydown", { key: "Escape" });
    await wrapper.get("textarea").trigger("keydown", { key: "Escape", repeat: true }); assert.equal(http.requests.length, 1);
    http.respond(0, { cancelledCount: 1, queue: { ...queueSnapshot(), queueVersion: 2 } });
    for (let i = 0; i < 8; i++) await nextTick();
    assert.equal(wrapper.get("textarea").attributes("placeholder"), "输入消息加入队列，Esc 停止运行");
    assert.equal(http.requests.filter(row => row.config.url?.endsWith("/stop")).length, 0);
    await wrapper.get("textarea").trigger("keydown", { key: "Escape", repeat: true }); assert.equal(http.requests.length, 1);
    await wrapper.get("textarea").trigger("keydown", { key: "Escape" });
    const stop = await http.waitFor(1); assert.match(stop.url || "", /message-queue\/stop$/);
    assert.equal(wrapper.get("textarea").attributes("placeholder"), "正在停止，请稍候…");
    const stopped = { ...queueSnapshot(), queueVersion: 3,
      stop: { state: "pending" as const, unresolvedOperationCount: 1, unresolvedTargetCount: 1, code: "stop_requested" as const } };
    http.respond(1, { stopOperation: { operationId: JSON.parse(String(stop.data)).operationId, acceptedQueueVersion: 3, targetCount: 1 }, queue: stopped });
    for (let i = 0; i < 8; i++) await nextTick();
    assert.equal(vm.draft, "keep draft");
    await vm.onSend(); assert.equal(http.requests.filter(row => row.config.url?.endsWith("/receipts")).length, 0);
    assert.equal(wrapper.get("textarea").attributes("placeholder"), "正在停止，请稍候…");
  } finally { wrapper.unmount(); http.restore(); }
});

test("真实 textarea：过期快照清空实际0条仍不停止；停止完成后正常 Enter 发送，无继续按钮", async () => {
  const http = mockContextRequests(); const { wrapper, setRunState } = mountPane({ contextLocale: "zh-CN", renderRealTextarea: true, runState: baseRunState({ status: "running", activeRunId: "r" }) });
  const vm = wrapper.vm as any;
  try {
    vm.queue.apply({ ...queueSnapshot(), queueVersion: 1, pendingCount: 1, items: [{ id: "stale", clientRequestId: "stale", sequence: 1, createdAt: 1, updatedAt: 1, status: "queued", messageId: null, runId: null, textPreview: "stale", attachmentCount: 0 }] }); await nextTick();
    await wrapper.get("textarea").trigger("keydown", { key: "Escape" }); const clear = await http.waitFor(0);
    assert.match(clear.url || "", /\/clear$/);
    http.respond(0, { cancelledCount: 0, queue: { ...queueSnapshot(), queueVersion: 2 } });
    for (let i = 0; i < 8; i++) await nextTick();
    assert.equal(http.requests.filter(row => row.config.url?.endsWith("/stop")).length, 0);
    setRunState({ status: "idle", activeRunId: null });
    vm.queue.apply({ ...queueSnapshot(), queueVersion: 3, stopGeneration: "b".repeat(64),
      stop: { state: "quiescent", unresolvedOperationCount: 0, unresolvedTargetCount: 0, code: null } });
    await nextTick(); assert.equal(wrapper.get("textarea").attributes("placeholder"), "输入消息，Enter 发送");
    assert.equal(wrapper.text().includes("继续处理"), false);
    vm.draft = "start again"; const pending = vm.onSend(); const request = await http.waitFor(1);
    assert.match(request.url || "", /\/receipts$/); assert.equal(JSON.parse(String(request.data)).stopGeneration, "b".repeat(64));
    http.respond(1, { ...injectedReceipt("next-run"), queue: { ...queueSnapshot(), queueVersion: 4, stopGeneration: "b".repeat(64) } });
    await pending; assert.equal(vm.draft, "");
  } finally { wrapper.unmount(); http.restore(); }
});

function sendPayload(config: InternalAxiosRequestConfig) {
  return config.data instanceof FormData ? JSON.parse(String(config.data.get("payload"))) : JSON.parse(config.data);
}
const stoppedQueue = (sessionId = "session-a"): AgentMessageQueueSnapshot => ({ ...queueSnapshot(sessionId), queueVersion: 2,
  stopGeneration: "b".repeat(64), stop: { state: "quiescent", unresolvedOperationCount: 0, unresolvedTargetCount: 0, code: null } });

test("已有Session首个snapshot跨完整Stop：原发送不开始、不自动续发，草稿File保留且可信新发送成功", async () => {
  const http = mockContextRequests({ autoTimeline: true }); let ensures = 0;
  const { wrapper } = mountPane({ sessionReady: true, initialQueue: null, initialDraft: "before first snapshot", active: true,
    ensureSession: async id => { ensures++; return id; } });
  const vm = wrapper.vm as any, file = new File(["original bytes"], "original.png", { type: "image/png" });
  vm.pendingImages = [{ id: "first-snapshot-image", filename: file.name, file }];
  try {
    const firstAction = vm.onSend(); await firstAction;
    assert.equal(ensures, 0); assert.equal(http.requests.some(r => r.config.url?.endsWith("/receipts")), false);
    const pendingSnapshots = http.requests.map((r, i) => [r, i] as const).filter(([r]) => r.config.url?.endsWith("/message-queue"));
    assert.ok(pendingSnapshots.length > 0, "the initial snapshot really is in flight");
    for (const [, i] of pendingSnapshots) http.respond(i, stoppedQueue());
    await new Promise<void>(resolve => setImmediate(resolve)); await nextTick();
    assert.equal(http.requests.some(r => r.config.url?.endsWith("/receipts")), false);
    assert.equal(vm.draft, "before first snapshot"); assert.equal(vm.pendingImages[0].file, file);
    assert.equal(vm.queue.snapshot.value.stopGeneration, "b".repeat(64));
    const nextAction = vm.onSend();
    for (let i = 0; i < 20 && !http.requests.some(r => r.config.url?.endsWith("/receipts")); i++) await new Promise(resolve => setImmediate(resolve));
    const index = http.requests.findIndex(r => r.config.url?.endsWith("/receipts")); assert.ok(index >= 0);
    assert.equal(ensures, 1); assert.equal(sendPayload(http.requests[index]!.config).stopGeneration, "b".repeat(64));
    assert.equal((http.requests[index]!.config.data as FormData).getAll("images").length, 1);
    http.respond(index, { ...injectedReceipt("explicit-after-snapshot"), queue: { ...stoppedQueue(), queueVersion: 3, } });
    await nextAction; assert.equal(vm.draft, ""); assert.equal(vm.pendingImages.length, 0);
  } finally {
    panePendingRuns(wrapper).remove({ workspaceId: "ws-a", sessionId: "session-a", runKind: "user", runId: "explicit-after-snapshot" });
    wrapper.unmount(); http.restore();
  }
});

for (const wrong of ["workspace", "session"] as const) test(`已有Session不使用${wrong}不匹配snapshot的generation`, async () => {
  const http = mockContextRequests(); let ensures = 0;
  const { wrapper } = mountPane({ sessionReady: true, initialQueue: null, initialDraft: "retained", ensureSession: async id => { ensures++; return id; } });
  const vm = wrapper.vm as any, file = new File(["retained"], "retained.png", { type: "image/png" });
  try {
    vm.pendingImages = [{ id: `wrong-${wrong}`, filename: file.name, file }];
    vm.queue.snapshot.value = { ...queueSnapshot(), ...(wrong === "workspace" ? { workspaceId: "other-workspace" } : { sessionId: "other-session" }) };
    await vm.onSend(); assert.equal(ensures, 0); assert.equal(http.requests.length, 0);
    assert.equal(vm.draft, "retained"); assert.equal(vm.pendingImages[0].file, file);
  } finally { wrapper.unmount(); http.restore(); }
});

for (const stage of ["ensureSession", "prompt preparation"] as const) test(`已有Session ${stage} await期间Stop：发送保留动作开始时generation并拒收，不替换为新值`, async () => {
  const http = mockContextRequests({ autoTimeline: true }), ensured = deferred<string>();
  const draft = stage === "ensureSession" ? "before ensure" : "/ordinary-prompt";
  const { wrapper } = mountPane({ sessionReady: true, initialDraft: draft, ensureSession: stage === "ensureSession" ? () => ensured.promise : async id => id });
  const vm = wrapper.vm as any, file = new File(["keep"], "keep.png", { type: "image/png" });
  vm.pendingImages = [{ id: `stage-${stage}`, filename: file.name, file }];
  try {
    const sending = vm.onSend(); await nextTick(); vm.queue.apply(stoppedQueue());
    if (stage === "ensureSession") ensured.resolve("session-a");
    else { const prompt = await http.waitFor(0); assert.match(prompt.url || "", /global-prompts/); http.respond(0, { items: [] }); }
    const index = stage === "ensureSession" ? 0 : 1;
    const request = await http.waitFor(index); assert.match(request.url || "", /receipts/);
    assert.equal(sendPayload(http.requests[index]!.config).stopGeneration, "0".repeat(64));
    http.reject(index, new ApiError({ status: 409, code: "AGENT_QUEUE_STOP_GENERATION_CHANGED", message: "Stop generation changed" }));
    await sending; assert.equal(vm.draft, draft); assert.equal(vm.pendingImages[0].file, file);
    assert.equal(vm.queue.handoff.value.phase, "rejected");
    assert.equal(vm.queue.handoff.value.submission.payload.stopGeneration, "0".repeat(64));
    assert.equal(http.requests.filter(r => r.config.url?.endsWith("/receipts")).length, 1);
    const explicit = vm.onSend(); const next = await http.waitFor(index + 1);
    assert.match(next.url || "", /receipts/); assert.equal(sendPayload(http.requests[index + 1]!.config).stopGeneration, "b".repeat(64));
    http.respond(index + 1, { ...injectedReceipt(`explicit-after-${stage}`), queue: { ...stoppedQueue(), queueVersion: 3, } });
    await explicit; assert.equal(vm.draft, ""); assert.equal(vm.pendingImages.length, 0); assert.equal(vm.queue.handoff.value, null);
    panePendingRuns(wrapper).remove({ workspaceId: "ws-a", sessionId: "session-a", runKind: "user", runId: `explicit-after-${stage}` });
  } finally { wrapper.unmount(); http.restore(); }
});

test("fresh draft未实际创建新Session时不能使用初始generation提交", async () => {
  const http = mockContextRequests();
  const { wrapper } = mountPane({ initialQueue: null, initialDraft: "keep draft", ensureSession: async id => id });
  const vm = wrapper.vm as any, file = new File(["keep"], "keep.png", { type: "image/png" });
  try {
    vm.pendingImages = [{ id: "not-created", filename: file.name, file }]; await vm.onSend();
    assert.equal(http.requests.length, 0); assert.equal(vm.draft, "keep draft"); assert.equal(vm.pendingImages[0].file, file);
  } finally { wrapper.unmount(); http.restore(); }
});


for (const changed of ["workspace", "session"] as const) test(`fresh draft ensureSession期间切换${changed}后不发送旧动作`, async () => {
  const http = mockContextRequests(), created = deferred<string>();
  const { wrapper } = mountPane({ initialQueue: null, initialDraft: "old fresh draft", ensureSession: () => created.promise });
  const vm = wrapper.vm as any, file = new File(["old bytes"], "old.png", { type: "image/png" });
  try {
    vm.pendingImages = [{ id: `old-fresh-${changed}`, filename: file.name, file }]; const sending = vm.onSend(); await nextTick();
    await wrapper.setProps(changed === "workspace" ? { workspaceId: "ws-other" } : { sessionId: "other-draft" });
    vm.draft = "new scope draft"; created.resolve("newly-created-old-scope"); await sending;
    assert.equal(http.requests.length, 0); assert.equal(vm.draft, "new scope draft"); assert.equal(vm.queue.handoff.value, null);
  } finally { wrapper.unmount(); http.restore(); }
});

function acceptedQueuedSubmission(clientRequestId: string, version = 1) {
  return { receipt: { ...injectedReceipt("recovery").receipt, id: `queued-${clientRequestId}`, clientRequestId,
    status: "queued", messageId: null, runId: null },
    deduplicated: false, queue: { ...queueSnapshot(), queueVersion: version } };
}

function forgetTestSubmission(vm: any, submission = vm.queue.handoff.value?.submission) {
  if (submission) vm.queue.acknowledgeHandoff(submission);
}

test("恢复弹窗关闭后 Enter 只重开恢复，不重发；原重试保留 requestId、generation 和真实 File", async () => {
  const http = mockContextRequests({ autoTimeline: true });
  const { wrapper } = mountPane({ initialDraft: "original", active: true, contextLocale: "zh-CN", renderRealTextarea: true, renderRealModal: true });
  const vm = wrapper.vm as any, file = new File(["original-image"], "original.png", { type: "image/png" });
  try {
    vm.pendingImages = [{ id: "reopen-image", filename: file.name, file }];
    await wrapper.get("textarea").trigger("keydown", { key: "Enter" });
    const first = await http.waitFor(0), payload = sendPayload(first);
    http.reject(0, new Error("unknown receipt")); await flushQueueUi();
    const oldDialog = latestQueueDialog(), oldRetry = queueDialogButton("重试原提交", oldDialog);
    queueDialogConfirm(oldDialog).click(); await flushQueueUi();
    assert.equal(http.requests.length, 1, "closing recovery neither retries nor abandons");
    vm.draft = "new user input";
    await wrapper.get("textarea").trigger("keydown", { key: "Enter" }); await flushQueueUi();
    const currentDialog = latestQueueDialog(); assert.notEqual(currentDialog, oldDialog);
    oldRetry.click(); await flushQueueUi(); assert.equal(http.requests.length, 1, "closing invalidates old saved DOM actions");
    assert.equal(vm.draft, "new user input"); assert.equal(vm.pendingImages[0].file, file);
    queueDialogButton("重试原提交", currentDialog).click();
    const retry = await http.waitFor(1);
    assert.deepEqual(sendPayload(retry), payload);
    assert.equal(vm.queue.handoff.value.submission.images[0].file, file);
    const sentImage = (retry.data as FormData).get("images") as File;
    assert.equal(sentImage.name, file.name); assert.deepEqual(await sentImage.arrayBuffer(), await file.arrayBuffer());
    http.respond(1, acceptedQueuedSubmission(payload.clientRequestId)); await flushQueueUi();
    assert.equal(vm.draft, "new user input"); assert.equal(vm.pendingImages.length, 0);
    assert.equal(vm.queue.handoff.value, null);
  } finally { forgetTestSubmission(vm); wrapper.unmount(); http.restore(); }
});

for (const control of ["clear", "stop"] as const) test(`${control} 失败：清空静默结束，Stop 仅重试原操作`, async () => {
  const http = mockContextRequests({ autoTimeline: true });
  const { wrapper } = mountPane({ initialDraft: "keep draft", active: true, contextLocale: "zh-CN", renderRealTextarea: true, renderRealModal: true,
    runState: baseRunState({ status: "running", activeRunId: `unknown-${control}` }) });
  const vm = wrapper.vm as any;
  const item = (id: string, sequence: number) => ({ id, clientRequestId: `request-${id}`, sequence, createdAt: 1, updatedAt: 1,
    status: "queued" as const, messageId: null, runId: null, textPreview: id, attachmentCount: 0 });
  try {
    if (control === "clear") vm.queue.apply({ ...queueSnapshot(), queueVersion: 1, pendingCount: 1, items: [item("original", 1)] });
    const dialogsBefore = document.querySelectorAll(".ant-modal-confirm").length;
    await wrapper.get("textarea").trigger("keydown", { key: "Escape" });
    const first = await http.waitFor(0), body = JSON.parse(String(first.data));
    assert.match(first.url || "", new RegExp(`/${control}$`));
    http.reject(0, new Error("reply lost")); await flushQueueUi();
    assert.equal(vm.draft, "keep draft");
    // A newer snapshot must not grow a previously frozen clear request.
    vm.queue.apply({ ...queueSnapshot(), queueVersion: 2, pendingCount: 2, items: [item("original", 1), item("later", 2)] });
    if (control === "clear") {
      assert.equal(http.requests.length, 1); assert.equal(vm.queue.handoff.value, null);
      assert.equal(document.querySelectorAll(".ant-modal-confirm").length, dialogsBefore); return;
    }
    queueDialogButton("重试原停止操作").click();
    const retry = await http.waitFor(1);
    assert.deepEqual(JSON.parse(String(retry.data)), body);
    {
      assert.equal(typeof body.operationId, "string");
      http.respond(1, { stopOperation: { operationId: body.operationId, acceptedQueueVersion: 3, targetCount: 1 }, queue: { ...queueSnapshot(), queueVersion: 3,
        stop: { state: "quiescent", unresolvedOperationCount: 0, unresolvedTargetCount: 0, code: null } } });
    }
    await flushQueueUi();
    assert.equal(http.requests.length, 2, "recovery dispatches only the original control, never a fallback Stop or new send");
    assert.equal(vm.queue.unknownStop.value, false);
    assert.equal(vm.draft, "keep draft");
  } finally { wrapper.unmount(); http.restore(); }
});

for (const change of ["session", "inactive", "unmount"] as const) test(`恢复弹窗的旧按钮在 ${change} 后失效`, async () => {
  const http = mockContextRequests({ autoTimeline: true });
  const { wrapper } = mountPane({ initialDraft: "old draft", active: true, contextLocale: "zh-CN", renderRealTextarea: true, renderRealModal: true });
  const vm = wrapper.vm as any; let unmounted = false;
  try {
    const sending = vm.onSend(); await http.waitFor(0); http.reject(0, new Error("unknown")); await sending; await flushQueueUi();
    const dialog = latestQueueDialog(), lookup = queueDialogButton("查询接收结果", dialog), retry = queueDialogButton("重试原提交", dialog), restore = queueDialogButton("恢复提交草稿", dialog);
    const original = vm.queue.handoff.value.submission;
    if (change === "session") await wrapper.setProps({ sessionId: "session-b" });
    else if (change === "inactive") await wrapper.setProps({ active: false });
    else { wrapper.unmount(); unmounted = true; }
    vm.draft = "later draft";
    lookup.click(); retry.click(); restore.click(); queueDialogConfirm(dialog).click(); await flushQueueUi();
    assert.equal(http.requests.length, 1); assert.equal(vm.draft, "later draft");
    assert.equal(original.draft, "old draft");
    vm.queue.acknowledgeHandoff(original);
  } finally { forgetTestSubmission(vm); if (!unmounted) wrapper.unmount(); http.restore(); }
});

for (const change of ["edit", "session", "inactive", "unmount"] as const) test(`恢复草稿覆盖确认在 ${change} 后不能覆盖后来输入`, async () => {
  const http = mockContextRequests({ autoTimeline: true });
  const { wrapper } = mountPane({ initialDraft: "original", active: true, contextLocale: "zh-CN", renderRealTextarea: true, renderRealModal: true });
  const vm = wrapper.vm as any, originalFile = new File(["original"], "original.png", { type: "image/png" }), laterFile = new File(["later"], "later.png", { type: "image/png" });
  let unmounted = false, originalSubmission: any;
  try {
    vm.pendingImages = [{ id: "original", filename: originalFile.name, file: originalFile }];
    const sending = vm.onSend(); await http.waitFor(0);
    http.reject(0, new ApiError({ status: 507, code: "AGENT_QUEUE_RETENTION_FULL", message: "retention full" })); await sending; await flushQueueUi();
    originalSubmission = vm.queue.handoff.value.submission;
    vm.draft = "before confirmation";
    queueDialogButton("恢复提交草稿").click(); await flushQueueUi();
    const confirmation = latestQueueDialog(), confirm = queueDialogConfirm(confirmation);
    assert.match(confirmation.textContent || "", /替换当前草稿/);
    if (change === "session") await wrapper.setProps({ sessionId: "session-b" });
    else if (change === "inactive") await wrapper.setProps({ active: false });
    else if (change === "unmount") { wrapper.unmount(); unmounted = true; }
    vm.draft = "later edited draft"; vm.pendingImages = [{ id: "later", filename: laterFile.name, file: laterFile }];
    confirm.click(); await flushQueueUi();
    assert.equal(vm.draft, "later edited draft"); assert.equal(vm.pendingImages[0].file, laterFile);
    assert.equal(http.requests.length, 1);
  } finally { forgetTestSubmission(vm, originalSubmission); if (!unmounted) wrapper.unmount(); http.restore(); }
});

test("sending handoff 期间新 Pane 的 Enter 不展示失败恢复，也不自动重发", async () => {
  const http = mockContextRequests({ autoTimeline: true });
  const origin = mountPane({ initialDraft: "still sending", active: true, contextLocale: "zh-CN", renderRealTextarea: true, renderRealModal: true }).wrapper;
  let successor: typeof origin | undefined;
  try {
    const sending = (origin.vm as any).onSend(); const first = await http.waitFor(0);
    origin.unmount();
    successor = mountPane({ active: true, contextLocale: "zh-CN", renderRealTextarea: true, renderRealModal: true }).wrapper;
    await flushQueueUi();
    const before = document.body.querySelectorAll(".ant-modal-confirm").length;
    await successor.get("textarea").trigger("keydown", { key: "Enter" }); await flushQueueUi();
    assert.equal((successor.vm as any).queueSubmissionHandoff.phase, "sending");
    assert.equal(document.body.querySelectorAll(".ant-modal-confirm").length, before);
    assert.equal(http.requests.length, 1);
    http.respond(0, acceptedQueuedSubmission(sendPayload(first).clientRequestId)); await sending; await flushQueueUi();
    assert.equal((successor.vm as any).draft, ""); assert.equal((successor.vm as any).queueSubmissionHandoff, null);
  } finally { if (successor) { forgetTestSubmission(successor.vm); successor.unmount(); } else origin.unmount(); http.restore(); }
});

for (const outcome of ["rejected", "unknown", "accepted"] as const) {
  for (const edit of ["none", "new", "same-text"] as const) test(`运行中补充跨重挂：${outcome}/${edit} 不接管旧草稿，保留后继输入`, async t => {
    const http = mockContextRequests({ autoTimeline: true });
    const recovery = t.mock.method(Modal, "info");
    const options = { active: true, contextLocale: "zh-CN" as const, renderRealTextarea: true, renderRealModal: true,
      runState: baseRunState({ status: "running", activeRunId: "supplement-target" }) };
    const origin = mountPane({ ...options, initialDraft: "original supplement" }).wrapper;
    const originalFile = new File(["original"], "original.png", { type: "image/png" });
    const laterFile = new File(["later"], "later.png", { type: "image/png" });
    let successor: typeof origin | undefined, sending: Promise<void> | undefined, settled = false;
    try {
      (origin.vm as any).pendingImages = [{ id: "original-supplement", filename: originalFile.name, file: originalFile }];
      sending = (origin.vm as any).onSend();
      const first = await http.waitFor(0), payload = sendPayload(first);
      assert.equal(payload.targetRunId, "supplement-target");
      origin.unmount();
      successor = mountPane(options).wrapper;
      const vm = successor.vm as any;
      await flushQueueUi();
      assert.equal(vm.queue.handoff.value?.phase, "sending");
      assert.equal(vm.draft, "", "补充不使用首发草稿的跨实例接管");
      assert.equal(vm.pendingImages.length, 0);
      if (edit !== "none") {
        // Even matching text is new input belonging to the successor composer.
        await successor.get("textarea").setValue(edit === "new" ? "later user input" : "original supplement");
        vm.pendingImages = [{ id: "later-image", filename: laterFile.name, file: laterFile }];
      }
      if (outcome === "accepted") http.respond(0, acceptedQueuedSubmission(payload.clientRequestId));
      else http.reject(0, outcome === "rejected"
        ? new ApiError({ status: 409, code: "AGENT_SUPPLEMENT_TARGET_CLOSED", message: "target closed" })
        : new Error("connection lost"));
      settled = true; await sending; await flushQueueUi();
      assert.equal(vm.queue.handoff.value, null);
      assert.equal(vm.queue.unknownSubmission.value, null);
      assert.equal(vm.draft, edit === "none" ? "" : edit === "new" ? "later user input" : "original supplement");
      assert.equal(successor.get("textarea").element.value, vm.draft);
      assert.deepEqual(vm.pendingImages.map((image: { id: string }) => image.id), edit === "none" ? [] : ["later-image"]);
      if (edit !== "none") assert.equal(vm.pendingImages[0].file, laterFile);
      assert.equal(vm.pendingAttempt, null);
      assert.equal(recovery.mock.callCount(), 0, "补充结果不增加恢复 UI");
      assert.equal(http.requests.length, 1, "不查询或重试补充");
    } finally {
      if (sending && !settled) { http.reject(0, new Error("test cleanup")); await sending; }
      if (successor) { forgetTestSubmission(successor.vm); successor.unmount(); }
      else origin.unmount();
      http.restore();
    }
  });
}

for (const failure of ["unknown", "rejected"] as const) test(`普通首发跨重挂：${failure} 仍保留文字、File 和原请求恢复`, async () => {
  const http = mockContextRequests({ autoTimeline: true });
  const options = { active: true, contextLocale: "zh-CN" as const, renderRealTextarea: true, renderRealModal: true };
  const origin = mountPane({ ...options, initialDraft: "ordinary first send" }).wrapper;
  const file = new File(["ordinary image"], "ordinary.png", { type: "image/png" });
  const runId = `ordinary-remount-${failure}`;
  let successor: typeof origin | undefined, sending: Promise<void> | undefined, settled = false;
  try {
    (origin.vm as any).pendingImages = [{ id: "ordinary-image", filename: file.name, file }];
    sending = (origin.vm as any).onSend();
    const first = await http.waitFor(0), payload = sendPayload(first);
    assert.equal(payload.targetRunId, null);
    origin.unmount(); successor = mountPane(options).wrapper;
    const vm = successor.vm as any;
    await flushQueueUi();
    assert.equal(vm.draft, "ordinary first send"); assert.equal(vm.pendingImages[0].file, file);
    assert.equal(vm.queue.handoff.value?.phase, "sending");
    http.reject(0, failure === "unknown" ? new Error("connection lost")
      : new ApiError({ status: 409, code: "AGENT_QUEUE_STOP_GENERATION_CHANGED", message: "generation changed" }));
    settled = true; await sending; await flushQueueUi();
    assert.equal(vm.queue.handoff.value?.phase, failure);
    assert.equal(vm.draft, "ordinary first send"); assert.equal(vm.pendingImages[0].file, file);
    assert.equal(vm.queue.handoff.value.submission.payload.clientRequestId, payload.clientRequestId);
    let retryIndex = 1;
    if (failure === "unknown") {
      queueDialogButton("查询接收结果").click();
      const lookup = await http.waitFor(1);
      assert.match(lookup.url || "", /receipts\/by-request$/);
      assert.equal(lookup.params.clientRequestId, payload.clientRequestId);
      http.reject(1, new ApiError({ status: 404, message: "not found" })); await flushQueueUi();
      assert.equal(vm.queue.handoff.value?.phase, "unknown"); assert.equal(vm.pendingImages[0].file, file);
      retryIndex = 2;
    }
    queueDialogButton("重试原提交").click();
    const retry = await http.waitFor(retryIndex);
    assert.deepEqual(sendPayload(retry), payload);
    assert.equal(vm.queue.handoff.value.submission.images[0].file, file);
    const sentImage = (retry.data as FormData).get("images") as File;
    assert.equal(sentImage.name, file.name); assert.deepEqual(await sentImage.arrayBuffer(), await file.arrayBuffer());
    const accepted = injectedReceipt(runId);
    http.respond(retryIndex, { ...accepted, receipt: { ...accepted.receipt, clientRequestId: payload.clientRequestId } });
    await flushQueueUi();
    assert.equal(vm.queue.handoff.value, null); assert.equal(vm.draft, ""); assert.equal(vm.pendingImages.length, 0);
  } finally {
    if (sending && !settled) { http.reject(0, new Error("test cleanup")); await sending; }
    if (successor) {
      panePendingRuns(successor).remove({ workspaceId: "ws-a", sessionId: "session-a", runKind: "user", runId });
      forgetTestSubmission(successor.vm); successor.unmount();
    } else { forgetTestSubmission(origin.vm); origin.unmount(); }
    http.restore();
  }
});

test("明确拒绝后：恢复副本保留真实 File，原重试冻结旧 generation，新 Enter 使用新 ID 和可信 generation", async () => {
  const http = mockContextRequests({ autoTimeline: true });
  const { wrapper } = mountPane({ initialDraft: "original", active: true, contextLocale: "zh-CN", renderRealTextarea: true, renderRealModal: true });
  const vm = wrapper.vm as any, file = new File(["original"], "original.png", { type: "image/png" });
  try {
    vm.pendingImages = [{ id: "rejected-original", filename: file.name, file }];
    const sending = vm.onSend(); const first = await http.waitFor(0), original = sendPayload(first);
    http.reject(0, new ApiError({ status: 507, code: "AGENT_QUEUE_RETENTION_FULL", message: "retention full" })); await sending; await flushQueueUi();
    vm.draft = "newer input"; vm.pendingImages = [];
    queueDialogButton("恢复提交草稿").click(); await flushQueueUi(); queueDialogConfirm().click(); await flushQueueUi();
    assert.equal(vm.draft, "original"); assert.equal(vm.pendingImages[0].file, file);
    assert.equal(http.requests.length, 1, "restoring the copy never resends it");
    await wrapper.get("textarea").trigger("keydown", { key: "Enter" });
    const explicit = await http.waitFor(1), next = sendPayload(explicit);
    assert.notEqual(next.clientRequestId, original.clientRequestId, "ordinary sending after a definite rejection is a new request, not a mutated original retry");
    http.reject(1, new ApiError({ status: 409, code: "AGENT_QUEUE_STOP_GENERATION_CHANGED", message: "generation changed" })); await flushQueueUi();
    vm.queue.apply({ ...stoppedQueue(), queueVersion: 2 });
    queueDialogButton("重试原提交").click(); const retry = await http.waitFor(2);
    assert.deepEqual(sendPayload(retry), next, "explicit original retry keeps its rejected generation");
    assert.equal(vm.queue.handoff.value.submission.images[0].file, file);
    const sentImage = (retry.data as FormData).get("images") as File;
    assert.equal(sentImage.name, file.name); assert.deepEqual(await sentImage.arrayBuffer(), await file.arrayBuffer());
    http.reject(2, new ApiError({ status: 409, code: "AGENT_QUEUE_STOP_GENERATION_CHANGED", message: "still stale" })); await flushQueueUi();
    queueDialogConfirm().click(); await flushQueueUi();
    await wrapper.get("textarea").trigger("keydown", { key: "Enter" });
    const fresh = await http.waitFor(3), freshPayload = sendPayload(fresh);
    assert.notEqual(freshPayload.clientRequestId, next.clientRequestId);
    assert.equal(freshPayload.stopGeneration, "b".repeat(64)); assert.equal(vm.queue.handoff.value.submission.images[0].file, file);
    assert.deepEqual(await ((fresh.data as FormData).get("images") as File).arrayBuffer(), await file.arrayBuffer());
    http.respond(3, { ...acceptedQueuedSubmission(freshPayload.clientRequestId, 3), queue: { ...queueSnapshot(), queueVersion: 3, stopGeneration: "b".repeat(64) } });
    await flushQueueUi(); assert.equal(vm.draft, ""); assert.equal(vm.pendingImages.length, 0);
  } finally { forgetTestSubmission(vm); wrapper.unmount(); http.restore(); }
});

test("明确拒绝后新编辑的文字和 File 可作为独立请求发送，旧弹窗不能重发旧副本", async () => {
  const http = mockContextRequests({ autoTimeline: true });
  const { wrapper } = mountPane({ initialDraft: "rejected draft", active: true, contextLocale: "zh-CN", renderRealTextarea: true, renderRealModal: true });
  const vm = wrapper.vm as any, oldFile = new File(["old"], "old.png", { type: "image/png" }), newFile = new File(["new"], "new.png", { type: "image/png" });
  try {
    vm.pendingImages = [{ id: "old-rejected", filename: oldFile.name, file: oldFile }];
    const sending = vm.onSend(); const first = await http.waitFor(0), payload = sendPayload(first);
    http.reject(0, new ApiError({ status: 507, code: "AGENT_QUEUE_RETENTION_FULL", message: "retention full" })); await sending; await flushQueueUi();
    const original = vm.queue.handoff.value.submission, dialog = latestQueueDialog(), retry = queueDialogButton("重试原提交", dialog);
    queueDialogConfirm(dialog).click(); await flushQueueUi();
    vm.draft = "new independent draft"; vm.pendingImages = [{ id: "new-independent", filename: newFile.name, file: newFile }];
    vm.queue.apply(stoppedQueue());
    await wrapper.get("textarea").trigger("keydown", { key: "Enter" }); const fresh = await http.waitFor(1), next = sendPayload(fresh);
    assert.notEqual(next.clientRequestId, payload.clientRequestId); assert.equal(next.stopGeneration, "b".repeat(64));
    assert.equal(next.text, "new independent draft"); assert.equal(vm.queue.handoff.value.submission.images[0].file, newFile);
    assert.deepEqual(await ((fresh.data as FormData).get("images") as File).arrayBuffer(), await newFile.arrayBuffer());
    retry.click(); await flushQueueUi(); assert.equal(http.requests.length, 2);
    assert.equal(original.draft, "rejected draft"); assert.equal(original.images[0].file, oldFile);
    assert.equal(vm.draft, "new independent draft"); assert.equal(vm.pendingImages[0].file, newFile);
    http.respond(1, { ...acceptedQueuedSubmission(next.clientRequestId, 3), queue: { ...queueSnapshot(), queueVersion: 3, stopGeneration: "b".repeat(64) } });
    await flushQueueUi(); assert.equal(vm.draft, ""); assert.equal(vm.pendingImages.length, 0);
  } finally { forgetTestSubmission(vm); wrapper.unmount(); http.restore(); }
});
