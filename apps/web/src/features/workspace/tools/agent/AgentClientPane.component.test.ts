import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import type { AxiosResponse, InternalAxiosRequestConfig } from "axios";
import type { AgentMessage, AgentMessageSessionRunState } from "@agent-workbench/shared";
import DOMPurify from "dompurify";
import { computed, defineComponent, h, KeepAlive, ref, type ComputedRef } from "vue";
import { agentSessionMetadataReadContextKey, createAgentSessionMetadataReads, type MetadataReadContext, type TimelineMetadataEvent } from "./agentSessionMetadataReadContext";
import zhCN from "@/shared/i18n/locales/zh-CN";
import enUS from "@/shared/i18n/locales/en-US";
import { apiClient } from "@/shared/api/api";

const [{ mount }, component, markdownComponent, { createI18n }, { nextTick, reactive }, { agentSessionStatusStoreKey }, { message, notification, Modal }, { replaceAgentTimelineSnapshot }] = await Promise.all([
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

async function clearComponentNotifications() {
  // Let a queued notice initialize before destroying the singleton instance.
  await nextTick();
  await new Promise<void>((resolve) => setImmediate(resolve));
  message.destroy();
  notification.destroy();
  // notification.destroy() schedules unmounts but does not return a Promise.
  await nextTick();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

afterEach(clearComponentNotifications);

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
  ensureSession?: (sessionId: string) => Promise<string>;
  forkSession?: (request: { fromSessionId: string; fromMessageId: string }) => Promise<import("@agent-workbench/shared").AgentSessionRecord>;
  contextLocale?: "zh-CN" | "en-US";
  renderModalSlots?: boolean;
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
    } : { ...createMountGlobal(statusStore), provide: { ...createMountGlobal(statusStore).provide, ...(options?.metadataReadContext ? { [agentSessionMetadataReadContextKey as symbol]: options.metadataReadContext } : {}) } },
  });
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

function mockContextRequests() {
  const previousAdapter = apiClient.defaults.adapter;
  const requests: Array<{ config: InternalAxiosRequestConfig; reply: ReturnType<typeof deferred<AxiosResponse>> }> = [];
  apiClient.defaults.adapter = (config) => {
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
    assert.match(request.url || "", /messages/);
    http.respond(0, { runId: "new-run" });
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
    assert.match(oldRequest.url || "", /session-a\/messages/);
    await wrapper.setProps({ sessionId: "session-b" });
    setRunState({ status: "running", activeRunId: "old-run-after-switch" });
    await nextTick();
    assert.equal(wrapper.find('[data-testid="agent-run-loading"]').exists(), false, "旧会话运行状态不能在新会话显示");
    vm.draft = "new";
    const newSend = vm.onSend();
    await nextTick();
    assert.equal(wrapper.find('[data-testid="agent-run-loading"]').exists(), true);

    http.respond(0, { runId: "old-run-after-switch" });
    await oldSend;
    await nextTick();
    assert.deepEqual(panePendingRuns(wrapper).list("ws-a", "session-a").map((run) => run.runId), ["old-run-after-switch"]);
    assert.equal(vm.awaitingRunStateRunId, null);
    assert.equal(wrapper.find('[data-testid="agent-run-loading"]').exists(), true, "旧请求的 finally 不能关掉新会话 loading");

    newSessionReady.resolve("session-b");
    const newRequest = await http.waitFor(1);
    assert.match(newRequest.url || "", /session-b\/messages/);
    http.respond(1, { runId: "new-run-after-switch" });
    await newSend;
    assert.equal(vm.awaitingRunStateRunId, "new-run-after-switch");
  } finally {
    panePendingRuns(wrapper).remove({ workspaceId: "ws-a", sessionId: "session-a", runKind: "user", runId: "old-run-after-switch" });
    panePendingRuns(wrapper).remove({ workspaceId: "ws-a", sessionId: "session-b", runKind: "user", runId: "new-run-after-switch" });
    wrapper.unmount();
    http.restore();
  }
});

test("真实 AgentClientPane：上一 Run 的 running 状态不会提前清除本次 Run 桥接", async () => {
  const http = mockContextRequests();
  const { wrapper, setRunState } = mountPane({ sessionReady: false, initialDraft: "next", runState: baseRunState({ status: "running", activeRunId: "old-run" }) });
  const vm = wrapper.vm as unknown as { onSend: () => Promise<void>; awaitingRunStateRunId: string | null };
  try {
    const send = vm.onSend();
    await http.waitFor(0);
    http.respond(0, { runId: "overlap-run" });
    await send;
    assert.equal(vm.awaitingRunStateRunId, "overlap-run");
    setRunState({ status: "idle", activeRunId: null });
    await nextTick();
    assert.equal(wrapper.get("main").findAllComponents({ name: "LoadingOutlined" }).length, 1);
    setRunState({ status: "running", activeRunId: "overlap-run" });
    await nextTick();
    assert.equal(vm.awaitingRunStateRunId, null);
    setRunState({ status: "idle", activeRunId: null });
    await nextTick();
    assert.equal(wrapper.find('[data-testid="agent-run-loading"]').exists(), false);
  } finally {
    panePendingRuns(wrapper).remove({ workspaceId: "ws-a", sessionId: "session-a", runKind: "user", runId: "overlap-run" });
    wrapper.unmount();
    http.restore();
  }
});

for (const terminal of [
  { status: "completed", code: "run_completed" },
  { status: "failed", code: "run_enqueue_failed" },
  { status: "cancelled", code: "run_cancelled" },
] as const) {
  test(`真实 AgentClientPane：${terminal.status} 终态优先于滞后 running，后续新 Run 仍显示 loading`, async () => {
    const http = mockContextRequests();
    const runId = `fast-${terminal.status}`;
    const { wrapper, setRunState } = mountPane({ sessionReady: true, active: false, initialDraft: "fast" });
    const vm = wrapper.vm as unknown as {
      onSend: () => Promise<void>;
      terminalRunIds: Set<string>;
      pendingRunController: { start: (scope: { workspaceId: string; sessionId: string }) => void };
    };
    try {
      vm.pendingRunController.start({ workspaceId: "ws-a", sessionId: "session-a" });
      const send = vm.onSend();
      await http.waitFor(0);
      http.respond(0, { runId });
      const timelineIndex = await waitForTimelineRequest(http);
      let statusIndex = -1;
      for (let i = 0; i < 30 && statusIndex < 0; i++) {
        statusIndex = http.requests.findIndex((request) => request.config.url?.endsWith(`/runs/${runId}`));
        if (statusIndex < 0) await new Promise((resolve) => setTimeout(resolve, 0));
      }
      assert.ok(statusIndex >= 0, "应登记并轮询本次 Run");
      setRunState({ status: "running", activeRunId: runId });
      await nextTick();
      assert.equal(wrapper.find('[data-testid="agent-run-loading"]').exists(), true);
      http.respond(statusIndex, { workspaceId: "ws-a", sessionId: "session-a", runId, runKind: "user", ...terminal, detail: null, updatedAt: 1 });
      for (let i = 0; i < 30 && wrapper.find('[data-testid="agent-run-loading"]').exists(); i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      assert.equal(wrapper.find('[data-testid="agent-run-loading"]').exists(), false, "timeline 仍在等待时 Run 已终结");
      assert.equal(vm.terminalRunIds.has(runId), true);
      setRunState({ status: "running", activeRunId: runId, updatedAt: 2 });
      await nextTick();
      assert.equal(wrapper.find('[data-testid="agent-run-loading"]').exists(), false, "下一次轮询仍为已终结 Run 时不能重现");
      if (terminal.status !== "completed") {
        setRunState({ status: "idle", activeRunId: null });
        await nextTick();
        assert.equal(vm.terminalRunIds.size, 0, "状态收敛后释放终态标记");
        assert.equal(wrapper.find('[data-testid="agent-run-loading"]').exists(), false);
      }
      setRunState({ status: "running", activeRunId: `next-${terminal.status}` });
      await nextTick();
      assert.equal(wrapper.find('[data-testid="agent-run-loading"]').exists(), true, "不同 ID 的 Run 不受终态标记影响");
      assert.equal(vm.terminalRunIds.size, 0);
      http.respond(timelineIndex, timelineSnapshot([]));
      await send;
      assert.equal(wrapper.find('[data-testid="agent-run-loading"]').exists(), true);
      setRunState({ status: "idle", activeRunId: null });
      await nextTick();
      assert.equal(vm.terminalRunIds.size, 0, "切换 Run 或收敛后释放终态标记");
      assert.equal(wrapper.find('[data-testid="agent-run-loading"]').exists(), false);
      setRunState({ status: "running", activeRunId: `next-${terminal.status}` });
      await nextTick();
      assert.equal(wrapper.find('[data-testid="agent-run-loading"]').exists(), true, "不同 ID 的新 Run 继续显示");
      await wrapper.setProps({ sessionId: "session-b" });
      assert.equal(vm.terminalRunIds.size, 0);
      assert.equal(wrapper.find('[data-testid="agent-run-loading"]').exists(), false, "切换会话不沿用旧 Run 状态");
    } finally {
      panePendingRuns(wrapper).remove({ workspaceId: "ws-a", sessionId: "session-a", runKind: "user", runId });
      wrapper.unmount();
      http.restore();
    }
  });
}

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

function mountForkPane(forkSession: NonNullable<Parameters<typeof mountPane>[0]>["forkSession"], metadataReadContext?: MetadataReadContext) {
  const global = createMountGlobal({ getRunState: () => computed(() => baseRunState()) });
  return mount(AgentClientPane, {
    attachTo: document.body,
    props: {
      workspaceId: "ws-a", toolId: "agent-tool", sessionId: "session-a", sessionKind: "primary", sessionTitle: "Session A",
      sessionReady: false, active: true, agentOptions: [], sessionModelStates: {}, sessionModelStateLoading: false,
      sessionModelMutationPending: false, modelOpenIntent: null, forkSession,
    },
    global: {
      ...global,
      provide: { ...global.provide, [agentSessionMetadataReadContextKey as symbol]: metadataReadContext },
      stubs: { ...componentStubs, AgentMessageActions: ForkActionsStub },
    },
  });
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
    await setTimeline(wrapper, [agentMessage({ id: "historical-user", type: "user", inCurrentOperationRange: false })]);
    const action = wrapper.get('[data-testid="fork-action"]');
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
  const wrapper = mountForkPane(async () => ({ ...timelineSnapshot([]).session, id: "unused" }));
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
    await setTimeline(wrapper, [agentMessage({ id: "historical-user", type: "user", inCurrentOperationRange: false })]);
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
