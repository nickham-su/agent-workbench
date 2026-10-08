import assert from "node:assert/strict";
import test from "node:test";

class FakeXMLHttpRequest {
  static requests: FakeXMLHttpRequest[] = [];
  static responder: (request: FakeXMLHttpRequest) => void = () => undefined;

  method = "";
  url = "";
  requestBody: unknown;
  status = 0;
  statusText = "";
  responseText = "";
  responseURL = "";
  responseType = "";
  readyState = 0;
  timeout = 0;
  withCredentials = false;
  onloadend: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  upload = { addEventListener() {} };
  private readonly headers = new Map<string, string>();

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
    this.responseURL = url;
  }

  setRequestHeader(name: string, value: string) {
    this.headers.set(name.toLowerCase(), value);
  }

  getAllResponseHeaders() {
    return "content-type: application/json\r\n";
  }

  addEventListener() {}

  send(body?: unknown) {
    this.requestBody = body;
    FakeXMLHttpRequest.requests.push(this);
    FakeXMLHttpRequest.responder(this);
  }

  abort() {
    this.onabort?.();
  }

  respond(status: number, body: unknown) {
    this.status = status;
    this.statusText = status >= 200 && status < 300 ? "OK" : "Request failed";
    this.responseText = JSON.stringify(body);
    queueMicrotask(() => this.onloadend?.());
  }
}

Object.defineProperty(globalThis, "XMLHttpRequest", { value: FakeXMLHttpRequest, configurable: true, writable: true });

const [{ mount }, component, { createI18n }, { KeepAlive, h, nextTick, ref }, { workspaceHostKey }, { message }, enUS, zhCN] = await Promise.all([
  import("@vue/test-utils"),
  import("./AgentToolView.vue"),
  import("vue-i18n"),
  import("vue"),
  import("@/features/workspace/host"),
  import("ant-design-vue"),
  import("@/shared/i18n/locales/en-US"),
  import("@/shared/i18n/locales/zh-CN"),
]);

const AgentToolView = component.default.__vccOpts ?? component.default;

type Session = {
  id: string;
  workspaceId: string;
  title: string;
  kind: "primary" | "subtask";
  headMessageId: string | null;
  contextRootMessageId: null;
  revision: number;
  forkedFromSessionId: string | null;
  forkedFromMessageId: string | null;
  createdAt: number;
  updatedAt: number;
};

function session(id: string, workspaceId: string, kind: Session["kind"] = "primary"): Session {
  return {
    id,
    workspaceId,
    title: id,
    kind,
    headMessageId: null,
    contextRootMessageId: null,
    revision: 1,
    forkedFromSessionId: null,
    forkedFromMessageId: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function tabState(workspaceId: string, overrides: Partial<{ closedSessionIds: string[]; openedSubtaskSessionIds: string[] }> = {}) {
  return { workspaceId, closedSessionIds: [], openedSubtaskSessionIds: [], ...overrides };
}

/** Scoped fixtures: tabs restore effective members; picker does not populate the cache. */
function respondSessions(request: FakeXMLHttpRequest, records: Session[], overrides: Partial<ReturnType<typeof tabState>> = {}) {
  const query = new URL(request.url, "http://local").searchParams;
  const workspaceId = query.get("workspaceId") ?? "ws-a";
  if (query.get("scope") === "continuable") {
    const items = records.filter((record) => record.kind === "primary" && record.headMessageId !== null && record.title.trim() && record.title.trim() !== "新会话");
    return request.respond(200, { scope: "continuable", items, nextCursor: null });
  }
  assert.equal(query.get("scope"), "tabs", "list fixtures require explicit scope");
  const state = tabState(workspaceId, overrides);
  const items = records.filter((record) => record.kind === "primary" ? !state.closedSessionIds.includes(record.id) : state.openedSubtaskSessionIds.includes(record.id));
  return request.respond(200, { scope: "tabs", items, tabState: state });
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function respondDefaults(request: FakeXMLHttpRequest, workspaceId = "ws-a") {
  if (request.method === "PUT" && request.url.includes("/agent-tab-state/")) {
    return request.respond(200, { workspaceId, sessionId: decodeURIComponent(request.url.split("?")[0]!.split("/").at(-1)!), visible: JSON.parse(String(request.requestBody)).visible });
  }
  if (request.url.includes("/agent/available") || request.url.includes("/agents/available")) return request.respond(200, { agents: [] });
  if (/\/agent\/sessions\/[^/?]+(?:\?|$)/.test(request.url)) return request.respond(200, session(decodeURIComponent(request.url.split("?")[0]!.split("/").at(-1)!), workspaceId));
  if (isListRead(request)) return respondSessions(request, [session("primary-a", workspaceId)]);
  return request.respond(200, {});
}

function mountView(workspaceId = "ws-a", openSessionRequest?: { sessionId: string; sequence: number }, options: { renderPicker?: boolean } = {}) {
  const i18n = createI18n({ legacy: false, locale: "en-US", messages: { "en-US": enUS.default, "zh-CN": zhCN.default } });
  return mount(AgentToolView, {
    attachTo: document.body,
    props: { workspaceId, toolId: "agent-tool", openSessionRequest },
    global: {
      plugins: [i18n],
      provide: {
        [workspaceHostKey as symbol]: {
          openTool() {}, minimizeTool() {}, toggleMinimize() {}, setToolDot() {},
          callFrom() {}, registerToolCommands() { return () => undefined; }, emitToolEvent() {},
        },
      },
      stubs: {
        "a-tabs": { template: "<div data-testid='agent-tabs'><slot /><slot name='rightExtra' /></div>" },
        "a-tab-pane": { template: "<div class='agent-tab-pane'><slot name='tab' /><slot /></div>" },
        "a-tooltip": { template: "<span><slot /></span>" },
        "a-button": { emits: ["click"], template: "<button @click='$emit(\"click\")'><slot /></button>" },
        "a-modal": options.renderPicker ? { props: ["open"], template: "<div v-if='open'><slot /></div>" } : true,
        "a-list": options.renderPicker ? { props: ["dataSource"], template: "<div><slot v-for='item in dataSource' name='renderItem' :item='item' /></div>" } : true,
        "a-list-item": options.renderPicker ? { emits: ["click"], template: "<div @click='$emit(\"click\")'><slot /></div>" } : true,
        "a-input": true,
        AgentClientPane: true,
        CloseOutlined: { template: "<button class='close-icon' @click='$emit(\"click\")' />" },
        MinusOutlined: true,
        PlusOutlined: true,
      },
    },
  });
}

function mountKeepAliveView(workspaceId = "ws-a", openSessionRequest?: { sessionId: string; sequence: number }) {
  const active = ref(true);
  const i18n = createI18n({ legacy: false, locale: "en-US", messages: { "en-US": enUS.default, "zh-CN": zhCN.default } });
  const wrapper = mount({
    setup: () => () => h(KeepAlive, null, {
      default: () => active.value ? h(AgentToolView, { workspaceId, toolId: "agent-tool", openSessionRequest }) : null
    })
  }, {
    attachTo: document.body,
    global: {
      plugins: [i18n],
      provide: {
        [workspaceHostKey as symbol]: {
          openTool() {}, minimizeTool() {}, toggleMinimize() {}, setToolDot() {},
          callFrom() {}, registerToolCommands() { return () => undefined; }, emitToolEvent() {},
        },
      },
      stubs: {
        "a-tabs": { template: "<div data-testid='agent-tabs'><slot /><slot name='rightExtra' /></div>" },
        "a-tab-pane": { template: "<div class='agent-tab-pane'><slot name='tab' /><slot /></div>" },
        "a-tooltip": { template: "<span><slot /></span>" },
        "a-button": { template: "<button @click='$emit(\"click\")'><slot /></button>" },
        "a-modal": true,
        "a-list": true,
        "a-list-item": true,
        "a-input": true,
        AgentClientPane: true,
        CloseOutlined: { template: "<button class='close-icon' @click='$emit(\"click\")' />" },
        MinusOutlined: true,
        PlusOutlined: true,
      },
    },
  });
  return { wrapper, setActive: (value: boolean) => { active.value = value; } };
}

async function settle() {
  await flush();
  await nextTick();
  await flush();
  await nextTick();
}

test("AgentToolView：一致性snapshot完成前保持loading，后台决定可见Tab且无独立Tab GET", async () => {
  let request: FakeXMLHttpRequest | undefined;
  FakeXMLHttpRequest.requests = [];
  FakeXMLHttpRequest.responder = (value) => {
    if (value.url.includes("/agent/available")) return value.respond(200, { agents: [] });
    if (value.url.includes("scope=tabs")) { request = value; return; }
    return respondDefaults(value);
  };
  const wrapper = mountView();
  try {
    assert.equal(wrapper.find("[data-testid='agent-tab-state-loading']").exists(), true);
    assert.equal(wrapper.find("[data-testid='agent-tabs']").exists(), false);
    respondSessions(request!, [session("primary-a", "ws-a"), session("subtask-a", "ws-a", "subtask")], { closedSessionIds: ["primary-a"], openedSubtaskSessionIds: ["subtask-a"] });
    await settle();
    assert.equal(wrapper.find("[data-testid='agent-tab-state-loading']").exists(), false);
    assert.equal((wrapper.vm as any).visibleSessions.map((item: Session) => item.id).join(","), "subtask-a");
    assert.equal(FakeXMLHttpRequest.requests.filter((value) => value.method === "GET" && value.url.includes("/agent-tab-state")).length, 0);
  } finally { wrapper.unmount(); }
});

test("AgentToolView：首次挂载带目标 Session 时等待初始化，并在第一次打开隐藏 Tab", async () => {
  let initialSessions: FakeXMLHttpRequest | undefined;
  let sessionReads = 0;
  FakeXMLHttpRequest.requests = [];
  FakeXMLHttpRequest.responder = (request) => {
    if (request.url.includes("/agent/available")) return request.respond(200, { agents: [] });
    if (request.url.split("?")[0]?.endsWith("/agent/sessions")) {
      sessionReads += 1;
      if (sessionReads === 1) { initialSessions = request; return; }
      return respondSessions(request, [session("primary-a", "ws-a"), session("subtask-a", "ws-a", "subtask")]);
    }
    if (request.url.includes("/agent/sessions/subtask-a?")) return request.respond(200, session("subtask-a", "ws-a", "subtask"));
    if (request.method === "PUT" && request.url.includes("subtask-a")) return request.respond(200, { workspaceId: "ws-a", sessionId: "subtask-a", visible: true });
    return request.respond(200, {});
  };
  const wrapper = mountView("ws-a", { sessionId: "subtask-a", sequence: 1 });
  try {
    assert.equal(wrapper.find("[data-testid='agent-tab-state-loading']").exists(), true);
    assert.equal(sessionReads, 1, "目标请求不得抢在初始化快照前刷新");
    respondSessions(initialSessions!, [session("primary-a", "ws-a"), session("subtask-a", "ws-a", "subtask")]);
    await settle();
    const vm = wrapper.vm as any;
    assert.equal(vm.effectiveActiveKey, "subtask-a");
    assert.equal(vm.visibleSessions.some((item: Session) => item.id === "subtask-a"), true);
    assert.equal(sessionReads, 1, "单目标打开不重读全量列表");
    assert.equal(FakeXMLHttpRequest.requests.some((request) => request.method === "PUT" && request.url.includes("subtask-a")), true);

    vm.onChangeTab("primary-a");
    await wrapper.setProps({ openSessionRequest: { sessionId: "subtask-a", sequence: 2 } });
    await settle();
    assert.equal(vm.effectiveActiveKey, "subtask-a", "后续再次跳转仍可打开指定 Session");
  } finally {
    wrapper.unmount();
  }
});

test("AgentToolView：关键读取失败显示 error，不创建草稿，显式重试后恢复", async () => {
  let fail = true;
  let creates = 0;
  FakeXMLHttpRequest.requests = [];
  FakeXMLHttpRequest.responder = (request) => {
    if (request.url.includes("/agent/available")) return request.respond(200, { agents: [] });
    if (request.url.includes("/agent/sessions")) return fail ? request.respond(500, { message: "snapshot unavailable" }) : respondSessions(request, [session("primary-a", "ws-a")]);
    if (request.method === "POST") creates += 1;
    return request.respond(200, {});
  };
  const wrapper = mountView();
  try {
    await settle();
    assert.equal(wrapper.find("[data-testid='agent-tab-state-error']").exists(), true);
    assert.equal(wrapper.find("[data-testid='agent-session-empty']").exists(), false);
    assert.equal(creates, 0);
    fail = false;
    await wrapper.get("[data-testid='agent-tab-state-error'] button").trigger("click");
    await settle();
    assert.equal(wrapper.find("[data-testid='agent-tab-state-error']").exists(), false);
    assert.equal((wrapper.vm as any).visibleSessions.map((item: Session) => item.id).join(","), "primary-a");
  } finally {
    wrapper.unmount();
  }
});

test("AgentToolView：Agent options 失败不阻止关键snapshot进入 ready", async () => {
  FakeXMLHttpRequest.requests = [];
  FakeXMLHttpRequest.responder = (request) => {
    if (request.url.includes("/agent/available")) return request.respond(500, { message: "agents unavailable" });
    if (isListRead(request)) return respondSessions(request, [session("primary-a", "ws-a")]);
    return request.respond(200, {});
  };
  const wrapper = mountView();
  try {
    await settle();
    assert.equal(wrapper.find("[data-testid='agent-tab-state-loading']").exists(), false);
    assert.equal(wrapper.find("[data-testid='agent-tab-state-error']").exists(), false);
    assert.equal((wrapper.vm as any).visibleSessions.map((item: Session) => item.id).join(","), "primary-a");
  } finally {
    wrapper.unmount();
  }
});

test("AgentToolView：已 ready 的 KeepAlive 激活不重读关键状态", async () => {
  let sessionGets = 0;
  const tabStateGets = () => FakeXMLHttpRequest.requests.filter((request) => request.method === "GET" && request.url.includes("/agent-tab-state")).length;
  FakeXMLHttpRequest.requests = [];
  FakeXMLHttpRequest.responder = (request) => {
    if (request.url.includes("/agent/available")) return request.respond(200, { agents: [] });
    if (isListRead(request)) {
      sessionGets += 1;
      return respondSessions(request, [session("primary-a", "ws-a")]);
    }
    return request.respond(200, {});
  };
  const { wrapper, setActive } = mountKeepAliveView();
  try {
    await settle();
    const sessionGetsBeforeReactivation = sessionGets;
    const tabStateGetsBeforeReactivation = tabStateGets();
    setActive(false);
    await settle();
    setActive(true);
    await settle();
    assert.equal(sessionGets, sessionGetsBeforeReactivation);
    assert.equal(tabStateGets(), tabStateGetsBeforeReactivation);
  } finally {
    wrapper.unmount();
  }
});

test("AgentToolView：error 状态的 KeepAlive 激活会重试关键snapshot并恢复", async () => {
  let fail = true;
  let sessionGets = 0;
  const tabStateGets = () => FakeXMLHttpRequest.requests.filter((request) => request.method === "GET" && request.url.includes("/agent-tab-state")).length;
  FakeXMLHttpRequest.requests = [];
  FakeXMLHttpRequest.responder = (request) => {
    if (request.url.includes("/agent/available")) return request.respond(200, { agents: [] });
    if (isListRead(request)) {
      sessionGets += 1;
      return fail ? request.respond(500, { message: "snapshot unavailable" }) : respondSessions(request, [session("primary-a", "ws-a")]);
    }
    return request.respond(200, {});
  };
  const { wrapper, setActive } = mountKeepAliveView();
  try {
    await settle();
    assert.equal(wrapper.find("[data-testid='agent-tab-state-error']").exists(), true);
    fail = false;
    setActive(false);
    await settle();
    const sessionGetsBeforeReactivation = sessionGets;
    setActive(true);
    await settle();
    assert.ok(sessionGets > sessionGetsBeforeReactivation);
    assert.equal(tabStateGets(), 0);
    assert.equal(wrapper.find("[data-testid='agent-tab-state-error']").exists(), false);
    assert.equal(wrapper.find("[data-testid='agent-tabs']").exists(), true);
  } finally {
    wrapper.unmount();
  }
});

test("AgentToolView：非 active Tab 的 PUT 404 只回滚自身，不重启初始化或抢焦点", async () => {
  let sessionGets = 0;
  const tabStateGets = () => FakeXMLHttpRequest.requests.filter((request) => request.method === "GET" && request.url.includes("/agent-tab-state")).length;
  const originalError = message.error;
  let errors = 0;
  message.error = (() => { errors += 1; }) as typeof message.error;
  FakeXMLHttpRequest.requests = [];
  FakeXMLHttpRequest.responder = (request) => {
    if (request.url.includes("/agent/available")) return request.respond(200, { agents: [] });
    if (request.method === "PUT" && request.url.includes("/agent-tab-state")) {
      return request.respond(404, { code: "AGENT_SESSION_NOT_FOUND_IN_WORKSPACE", message: "not found" });
    }
    if (isListRead(request)) {
      sessionGets += 1;
      return respondSessions(request, [session("primary-a", "ws-a"), session("primary-b", "ws-a")]);
    }
    return request.respond(200, {});
  };
  const wrapper = mountView();
  try {
    await settle();
    const sessionGetsBeforeMutation = sessionGets;
    const tabStateGetsBeforeMutation = tabStateGets();
    const vm = wrapper.vm as any;
    vm.activeKey = "primary-b";
    vm.closeSessionTab("primary-a");
    assert.equal(vm.visibleSessions.some((item: Session) => item.id === "primary-a"), false);
    await settle();
    assert.equal(wrapper.find("[data-testid='agent-tab-state-loading']").exists(), false);
    assert.equal(wrapper.find("[data-testid='agent-tab-state-error']").exists(), false);
    assert.equal(vm.visibleSessions.some((item: Session) => item.id === "primary-a"), true);
    assert.equal(vm.effectiveActiveKey, "primary-b");
    assert.equal(sessionGets, sessionGetsBeforeMutation);
    assert.equal(tabStateGets(), tabStateGetsBeforeMutation);
    assert.ok(errors >= 1);
  } finally {
    wrapper.unmount();
    message.error = originalError;
  }
});

test("AgentToolView：打开子任务仅查询目标，再乐观 PUT 持久化", async () => {
  FakeXMLHttpRequest.requests = [];
  FakeXMLHttpRequest.responder = (request) => {
    if (request.url.includes("/agent/available")) return request.respond(200, { agents: [] });
    if (request.url.includes("/agent/sessions/subtask-a?")) return request.respond(200, session("subtask-a", "ws-a", "subtask"));
    if (isListRead(request)) return respondSessions(request, [session("primary-a", "ws-a"), session("subtask-a", "ws-a", "subtask")]);
    if (request.method === "PUT" && request.url.includes("subtask-a")) return request.respond(200, { workspaceId: "ws-a", sessionId: "subtask-a", visible: true });
    return request.respond(200, {});
  };
  const wrapper = mountView();
  try {
    await settle();
    const opening = (wrapper.vm as any).onOpenSubtask("subtask-a");
    await opening;
    assert.equal((wrapper.vm as any).visibleSessions.some((item: Session) => item.id === "subtask-a"), true);
    await settle();
    assert.equal(FakeXMLHttpRequest.requests.some((request) => request.method === "PUT" && request.url.includes("subtask-a")), true);
  } finally {
    wrapper.unmount();
  }
});

test("AgentToolView：关闭创建中的草稿会将关闭意图转交给真实 Session，且不抢回活动 Tab", async () => {
  let createRequest: FakeXMLHttpRequest | undefined;
  FakeXMLHttpRequest.requests = [];
  FakeXMLHttpRequest.responder = (request) => {
    if (request.url.includes("/agents/available")) return request.respond(200, { agents: [] });
    if (request.method === "POST" && request.url.includes("/agent/sessions")) {
      createRequest = request;
      return;
    }
    if (request.method === "PUT" && request.url.includes("/agent-tab-state")) {
      return request.respond(200, { workspaceId: "ws-a", sessionId: "created-a", visible: false });
    }
    if (request.url.includes("created-a/model-overrides")) return request.respond(200, { sessionId: "created-a", items: [] });
    if (isListRead(request)) return respondSessions(request, []);
    return request.respond(200, {});
  };
  const wrapper = mountView();
  try {
    await settle();
    const vm = wrapper.vm as any;
    const draftId = vm.draftSessions[0].id as string;
    const creating = vm.ensureSessionCreated(draftId);
    assert.ok(createRequest);

    vm.closeSessionTab(draftId);
    await settle();
    const replacementDraftId = vm.activeKey as string;
    assert.notEqual(replacementDraftId, draftId);
    assert.equal(vm.draftSessions.some((item: Session) => item.id === replacementDraftId), true);

    createRequest!.respond(200, session("created-a", "ws-a"));
    assert.equal(await creating, "created-a");
    await settle();

    const visibilityWrites = FakeXMLHttpRequest.requests.filter((request) => request.method === "PUT" && request.url.includes("/agent-tab-state"));
    assert.equal(visibilityWrites.length, 1);
    assert.ok(visibilityWrites[0]!.url.includes("created-a"));
    assert.deepEqual(JSON.parse(String(visibilityWrites[0]!.requestBody)), { visible: false });
    assert.equal(visibilityWrites.some((request) => request.url.includes(encodeURIComponent(draftId))), false);
    assert.equal(vm.visibleSessions.some((item: Session) => item.id === "created-a"), false);
    assert.equal(vm.activeKey, replacementDraftId);
  } finally {
    wrapper.unmount();
  }
});

test("AgentToolView：切换 Workspace 后忽略旧 model overrides 失败，不提示也不污染 B 状态", async () => {
  let modelOverridesA: FakeXMLHttpRequest | undefined;
  const originalError = message.error;
  let errors = 0;
  message.error = (() => { errors += 1; }) as typeof message.error;
  FakeXMLHttpRequest.requests = [];
  FakeXMLHttpRequest.responder = (request) => {
    if (request.url.includes("/agents/available")) {
      return request.respond(200, { agents: [{ id: "agent-a", name: "Agent A", scope: "user", resolvedModel: null }] });
    }
    if (request.url.includes("primary-a/model-overrides")) {
      modelOverridesA = request;
      return;
    }
    if (request.url.includes("ws-a") && request.url.includes("/agent/sessions")) return respondSessions(request, [session("primary-a", "ws-a")]);
    if (request.url.includes("ws-b") && request.url.includes("/agent/sessions/primary-b?")) return request.respond(200, session("primary-b", "ws-b"));
    if (request.url.includes("ws-b") && request.url.includes("/agent/sessions")) return respondSessions(request, [session("primary-b", "ws-b")]);
    return request.respond(200, {});
  };
  const wrapper = mountView("ws-a");
  try {
    await settle();
    const opening = (wrapper.vm as any).onRequestSessionModelOpen({ sessionId: "primary-a", agentId: "agent-a" });
    assert.ok(modelOverridesA);

    await wrapper.setProps({ workspaceId: "ws-b" });
    await settle();
    modelOverridesA!.respond(500, { message: "old model state failed" });
    await opening;
    await settle();

    const vm = wrapper.vm as any;
    assert.equal(errors, 0);
    assert.equal(vm.serverSessions.map((item: Session) => item.id).join(","), "primary-b");
    assert.deepEqual(vm.pendingModelOpenIntentBySession, {});
    assert.deepEqual(vm.sessionModelStateLoads, {});
    assert.deepEqual(vm.sessionModelStates, {});
  } finally {
    wrapper.unmount();
    message.error = originalError;
  }
});

test("AgentToolView：切换 Workspace 后丢弃旧草稿创建响应，不污染新 Workspace", async () => {
  let createA: FakeXMLHttpRequest | undefined;
  FakeXMLHttpRequest.requests = [];
  FakeXMLHttpRequest.responder = (request) => {
    if (request.url.includes("/agent/available")) return request.respond(200, { agents: [] });
    if (request.method === "POST" && request.url.includes("/agent/sessions")) {
      createA = request;
      return;
    }
    if (request.url.includes("ws-a") && request.url.includes("/agent/sessions")) return respondSessions(request, [session("primary-a", "ws-a")]);
    if (request.url.includes("ws-b") && request.url.includes("/agent/sessions/primary-b?")) return request.respond(200, session("primary-b", "ws-b"));
    if (request.url.includes("ws-b") && request.url.includes("/agent/sessions")) return respondSessions(request, [session("primary-b", "ws-b")]);
    return request.respond(200, {});
  };
  const wrapper = mountView("ws-a");
  try {
    await settle();
    await (wrapper.vm as any).createOneSession();
    const draftId = (wrapper.vm as any).draftSessions[0].id as string;
    const creating = (wrapper.vm as any).ensureSessionCreated(draftId);
    assert.ok(createA);

    await wrapper.setProps({ workspaceId: "ws-b" });
    await settle();
    assert.equal((wrapper.vm as any).visibleSessions.map((item: Session) => item.id).join(","), "primary-b");

    createA!.respond(200, session("created-a", "ws-a"));
    await creating;
    await settle();

    const vm = wrapper.vm as any;
    assert.equal(vm.serverSessions.some((item: Session) => item.id === "created-a"), false);
    assert.equal(vm.visibleSessions.map((item: Session) => item.id).join(","), "primary-b");
    assert.equal(vm.effectiveActiveKey, "primary-b");
    assert.equal(FakeXMLHttpRequest.requests.some((request) => request.method === "PUT" && request.url.includes("ws-b")), false);
  } finally {
    wrapper.unmount();
  }
});

test("AgentToolView：卸载后草稿创建失败静默结束，不产生后续状态副作用", async () => {
  let createA: FakeXMLHttpRequest | undefined;
  FakeXMLHttpRequest.requests = [];
  FakeXMLHttpRequest.responder = (request) => {
    if (request.url.includes("/agent/available")) return request.respond(200, { agents: [] });
    if (request.method === "POST" && request.url.includes("/agent/sessions")) {
      createA = request;
      return;
    }
    if (isListRead(request)) return respondSessions(request, [session("primary-a", "ws-a")]);
    return request.respond(200, {});
  };
  const wrapper = mountView();
  await settle();
  await (wrapper.vm as any).createOneSession();
  const draftId = (wrapper.vm as any).draftSessions[0].id as string;
  const creating = (wrapper.vm as any).ensureSessionCreated(draftId);
  assert.ok(createA);
  wrapper.unmount();
  createA!.respond(500, { message: "create failed" });
  assert.equal(await creating, draftId);
});

test("AgentToolView：opened/closed localStorage 不再读取或写入，关闭真实 Session 乐观 PUT 且失败局部回滚", async () => {
  const storage = window.localStorage;
  const originalGetItem = storage.getItem.bind(storage);
  const originalSetItem = storage.setItem.bind(storage);
  const accessedLegacyKeys: string[] = [];
  const priorGlobalStorage = globalThis.localStorage;
  globalThis.localStorage = storage;
  storage.getItem = ((key: string) => {
    if (key.includes("closedSessions") || key.includes("openedSubtaskSessions")) accessedLegacyKeys.push(key);
    return originalGetItem(key);
  }) as typeof storage.getItem;
  storage.setItem = ((key: string, value: string) => {
    if (key.includes("closedSessions") || key.includes("openedSubtaskSessions")) accessedLegacyKeys.push(key);
    return originalSetItem(key, value);
  }) as typeof storage.setItem;
  const originalError = message.error;
  let errors = 0;
  message.error = (() => { errors += 1; }) as typeof message.error;
  FakeXMLHttpRequest.requests = [];
  FakeXMLHttpRequest.responder = (request) => {
    if (request.url.includes("/agent/available")) return request.respond(200, { agents: [] });
    if (isListRead(request)) return respondSessions(request, [session("primary-a", "ws-a"), session("primary-b", "ws-a")]);
    if (request.method === "PUT" && request.url.includes("/agent-tab-state")) return request.respond(500, { message: "write failed" });
    return request.respond(200, {});
  };
  const wrapper = mountView();
  try {
    await settle();
    (wrapper.vm as any).closeSessionTab("primary-a");
    assert.equal((wrapper.vm as any).visibleSessions.some((item: Session) => item.id === "primary-a"), false);
    await settle();
    assert.equal(FakeXMLHttpRequest.requests.some((request) => request.method === "PUT" && request.url.includes("primary-a")), true);
    assert.equal((wrapper.vm as any).visibleSessions.some((item: Session) => item.id === "primary-a"), true);
    assert.ok(errors >= 1);
    assert.deepEqual(accessedLegacyKeys, []);
  } finally {
    wrapper.unmount();
    storage.getItem = originalGetItem;
    storage.setItem = originalSetItem;
    globalThis.localStorage = priorGlobalStorage;
    message.error = originalError;
  }
});

test("AgentToolView：Workspace 切换后丢弃旧初始化响应，单目标刷新不覆盖 pending 可见性", async () => {
  const pendingA: FakeXMLHttpRequest[] = [];
  FakeXMLHttpRequest.requests = [];
  FakeXMLHttpRequest.responder = (request) => {
    if (request.url.includes("/agent/available")) return request.respond(200, { agents: [] });
    if (request.method === "PUT" && request.url.includes("/agent-tab-state")) return;
    if (request.url.includes("ws-b") && request.url.includes("/agent/sessions/primary-b?")) return request.respond(200, session("primary-b", "ws-b"));
    if (request.url.includes("ws-b") && request.url.includes("/agent/sessions")) return respondSessions(request, [session("primary-b", "ws-b")]);
    if (isListRead(request)) return respondSessions(request, [session("primary-b", "ws-b")]);
    return request.respond(200, {});
  };
  const wrapper = mountView("ws-a");
  try {
    await wrapper.setProps({ workspaceId: "ws-b" });
    for (const request of pendingA) {
      if (request.url.includes("/agent/sessions")) respondSessions(request, [session("primary-a", "ws-a")]);
      else request.respond(200, tabState("ws-a"));
    }
    await settle();
    assert.equal((wrapper.vm as any).visibleSessions.map((item: Session) => item.id).join(","), "primary-b");

    const vm = wrapper.vm as any;
    vm.closeSessionTab("primary-b");
    await vm.readFreshTarget("primary-b", () => true, new AbortController().signal);
    assert.equal(vm.visibleSessions.some((item: Session) => item.id === "primary-b"), false);
  } finally {
    wrapper.unmount();
  }
});

function metadataRecord(id: string, kind: Session["kind"] = "primary"): Session {
  return { ...session(id, "ws-a", kind), headMessageId: "head", title: "Usable title" };
}
function isListRead(request: FakeXMLHttpRequest) {
  return request.method === "GET" && request.url.split("?")[0]!.endsWith("/agent/sessions");
}

test("单目标父会话打开：GET 与目标 PUT 成功前保留来源，只有确认后关闭来源", async () => {
  const puts: FakeXMLHttpRequest[] = [];
  FakeXMLHttpRequest.requests = [];
  FakeXMLHttpRequest.responder = (request) => {
    if (request.method === "PUT") { puts.push(request); return; }
    if (request.url.includes("/agent/sessions/parent?")) return request.respond(200, metadataRecord("parent"));
    if (isListRead(request)) return respondSessions(request, [metadataRecord("parent"), metadataRecord("child", "subtask")], { closedSessionIds: ["parent"], openedSubtaskSessionIds: ["child"] });
    respondDefaults(request);
  };
  const wrapper = mountView();
  try {
    await settle();
    const vm = wrapper.vm as any;
    vm.onChangeTab("child");
    const opening = vm.onOpenParent("child", "parent");
    await settle();
    assert.equal(puts.length, 1);
    assert.ok(puts[0]!.url.endsWith("/parent"));
    assert.equal(vm.visibleSessions.some((item: Session) => item.id === "child"), true);
    puts[0]!.respond(200, { workspaceId: "ws-a", sessionId: "parent", visible: true });
    await opening;
    assert.equal(puts.length, 2);
    assert.ok(puts[1]!.url.endsWith("/child"));
    puts[1]!.respond(200, { workspaceId: "ws-a", sessionId: "child", visible: false });
    await settle();
    assert.equal(vm.effectiveActiveKey, "parent");
    assert.equal(FakeXMLHttpRequest.requests.filter(isListRead).length, 1);
  } finally { wrapper.unmount(); }
});

test("嵌套子任务逐级返回 c→b→a：父子会话不在 Tab 中也按 ID 打开，确认后才关闭来源", async () => {
  const records = [metadataRecord("a"), { ...metadataRecord("b", "subtask"), forkedFromSessionId: "a" }, { ...metadataRecord("c", "subtask"), forkedFromSessionId: "b" }];
  const puts: FakeXMLHttpRequest[] = [];
  const gets: FakeXMLHttpRequest[] = [];
  const warnings: unknown[] = [];
  const originalWarning = message.warning;
  message.warning = ((value: unknown) => { warnings.push(value); }) as typeof message.warning;
  FakeXMLHttpRequest.requests = [];
  FakeXMLHttpRequest.responder = (request) => {
    if (request.method === "PUT") { puts.push(request); return; }
    if (/\/agent\/sessions\/(a|b)\?/.test(request.url)) { gets.push(request); return; }
    if (isListRead(request)) return respondSessions(request, records, { closedSessionIds: ["a"], openedSubtaskSessionIds: ["c"] });
    respondDefaults(request);
  };
  const wrapper = mountView();
  try {
    await settle();
    const vm = wrapper.vm as any;
    vm.onChangeTab("c");
    for (const [sourceId, targetId] of [["c", "b"], ["b", "a"]] as const) {
      const putCount = puts.length;
      const getCount = gets.length;
      const opening = vm.onOpenParent(sourceId, targetId);
      await settle();
      assert.equal(gets.length, getCount + 1);
      assert.ok(gets[getCount]!.url.includes(`/sessions/${targetId}?`));
      assert.equal(puts.length, putCount);
      assert.equal(vm.visibleSessions.some((item: Session) => item.id === sourceId), true);
      gets[getCount]!.respond(200, records.find((record) => record.id === targetId)!);
      await settle();
      assert.equal(puts.length, putCount + 1);
      assert.ok(puts[putCount]!.url.endsWith(`/${targetId}`));
      assert.deepEqual(JSON.parse(String(puts[putCount]!.requestBody)), { visible: true });
      assert.equal(vm.visibleSessions.some((item: Session) => item.id === sourceId), true);
      puts[putCount]!.respond(200, { workspaceId: "ws-a", sessionId: targetId, visible: true });
      await opening;
      assert.equal(puts.length, putCount + 2);
      assert.ok(puts[putCount + 1]!.url.endsWith(`/${sourceId}`));
      assert.deepEqual(JSON.parse(String(puts[putCount + 1]!.requestBody)), { visible: false });
      puts[putCount + 1]!.respond(200, { workspaceId: "ws-a", sessionId: sourceId, visible: false });
      await settle();
      assert.equal(vm.effectiveActiveKey, targetId);
      assert.equal(vm.visibleSessions.some((item: Session) => item.id === sourceId), false);
      assert.equal(vm.visibleSessions.some((item: Session) => item.id === targetId), true);
    }
    assert.equal(FakeXMLHttpRequest.requests.filter(isListRead).length, 1);
    assert.deepEqual(warnings, []);
  } finally {
    wrapper.unmount();
    message.warning = originalWarning;
  }
});

for (const parentKind of ["primary", "subtask"] as const) {
  test(`目标 PUT 失败不关闭父会话来源、不发全量兜底（父会话类型：${parentKind}）`, async () => {
    const parent = metadataRecord("parent", parentKind);
    const child = { ...metadataRecord("child", "subtask"), forkedFromSessionId: "parent" };
    const warnings: unknown[] = [];
    const originalWarning = message.warning;
    message.warning = ((value: unknown) => { warnings.push(value); }) as typeof message.warning;
    FakeXMLHttpRequest.requests = [];
    FakeXMLHttpRequest.responder = (request) => {
      if (request.url.includes("/agent/sessions/parent?")) return request.respond(200, parent);
      if (request.method === "PUT") return request.respond(500, { message: "write failed" });
      if (isListRead(request)) return respondSessions(request, [parent, child], { closedSessionIds: ["parent"], openedSubtaskSessionIds: ["child"] });
      respondDefaults(request);
    };
    const wrapper = mountView();
    try {
      await settle();
      const vm = wrapper.vm as any;
      vm.onChangeTab("child");
      await vm.onOpenParent("child", "parent");
      assert.equal(vm.effectiveActiveKey, "child");
      assert.equal(vm.visibleSessions.some((item: Session) => item.id === "child"), true);
      assert.equal(FakeXMLHttpRequest.requests.filter((r) => r.method === "PUT" && r.url.endsWith("/parent")).length, 1);
      assert.equal(FakeXMLHttpRequest.requests.filter((r) => r.method === "PUT" && r.url.endsWith("/child")).length, 0);
      assert.equal(FakeXMLHttpRequest.requests.filter(isListRead).length, 1);
      assert.deepEqual(warnings, []);
    } finally {
      wrapper.unmount();
      message.warning = originalWarning;
    }
  });
}

test("连续外部打开 A/B：B 不等待 A 的 GET，A 迟到不提交或告警", async () => {
  const targets = new Map<string, FakeXMLHttpRequest>();
  FakeXMLHttpRequest.requests = [];
  FakeXMLHttpRequest.responder = (request) => {
    if (/\/agent\/sessions\/(A|B)\?/.test(request.url)) { targets.set(request.url.includes("/A?") ? "A" : "B", request); return; }
    respondDefaults(request);
  };
  const wrapper = mountView();
  try {
    await settle();
    await wrapper.setProps({ openSessionRequest: { sessionId: "A", sequence: 10 } });
    await settle();
    await wrapper.setProps({ openSessionRequest: { sessionId: "B", sequence: 11 } });
    await settle();
    assert.equal(targets.size, 2);
    targets.get("B")!.respond(200, metadataRecord("B"));
    await settle();
    targets.get("A")!.respond(404, { code: "SESSION_NOT_FOUND", message: "missing" });
    await settle();
    assert.equal((wrapper.vm as any).effectiveActiveKey, "B");
    assert.equal((wrapper.vm as any).serverSessions.some((item: Session) => item.id === "A"), false);
    assert.equal(FakeXMLHttpRequest.requests.filter(isListRead).length, 1);
  } finally { wrapper.unmount(); }
});

test("picker确认期间相同标题timeline事件推进读水位但不使完整选择证明失效", async () => {
  let targetPut: FakeXMLHttpRequest | undefined;
  FakeXMLHttpRequest.requests = [];
  FakeXMLHttpRequest.responder = (request) => {
    if (request.method === "PUT") { targetPut = request; return; }
    if (request.url.includes("/agent/sessions/target?")) return request.respond(200, metadataRecord("target"));
    if (isListRead(request)) return respondSessions(request, [metadataRecord("target")], { closedSessionIds: ["target"] });
    respondDefaults(request);
  };
  const wrapper = mountView();
  try {
    await settle();
    const vm = wrapper.vm as any;
    const draftId = vm.draftSessions[0].id;
    await vm.openChooseSessionModal(draftId);
    const choosing = vm.chooseSession("target");
    await settle();
    assert.ok(targetPut);
    assert.equal(vm.draftSessions.length, 1, "PUT未确认不能删除草稿");
    const token = vm.metadataReads.captureReadToken("ws-a", "target");
    wrapper.findAllComponents({ name: "AgentClientPane" })[0]!.vm.$emit("session-metadata-updated", { session: metadataRecord("target"), readToken: token });
    await nextTick();
    targetPut!.respond(200, { workspaceId: "ws-a", sessionId: "target", visible: true });
    await choosing;
    await settle();
    assert.equal(vm.draftSessions.length, 0);
    assert.equal(vm.effectiveActiveKey, "target");
    assert.equal(FakeXMLHttpRequest.requests.filter((r) => r.url.includes("/agent/sessions/target?")).length, 1);
    assert.equal(FakeXMLHttpRequest.requests.filter(isListRead).length, 2);
  } finally { wrapper.unmount(); }
});

test("picker取消在途打开：保留草稿并通过同一队列恢复原隐藏状态", async () => {
  const puts: FakeXMLHttpRequest[] = [];
  FakeXMLHttpRequest.requests = [];
  FakeXMLHttpRequest.responder = (request) => {
    if (request.method === "PUT") { puts.push(request); return; }
    if (request.url.includes("/agent/sessions/target?")) return request.respond(200, metadataRecord("target"));
    if (isListRead(request)) return respondSessions(request, [metadataRecord("target")], { closedSessionIds: ["target"] });
    respondDefaults(request);
  };
  const wrapper = mountView();
  try {
    await settle();
    const vm = wrapper.vm as any;
    const draftId = vm.draftSessions[0].id;
    await vm.openChooseSessionModal(draftId);
    const choosing = vm.chooseSession("target");
    await settle();
    assert.equal(puts.length, 1);
    vm.closeChooseSessionModal();
    assert.equal(puts.length, 1, "取消不清inFlight，不并发第二个PUT");
    puts[0]!.respond(200, { workspaceId: "ws-a", sessionId: "target", visible: true });
    await choosing;
    await settle();
    assert.equal(puts.length, 2);
    assert.deepEqual(JSON.parse(String(puts[1]!.requestBody)), { visible: false });
    puts[1]!.respond(200, { workspaceId: "ws-a", sessionId: "target", visible: false });
    await settle();
    assert.equal(vm.draftSessions[0].id, draftId);
    assert.equal(vm.effectiveActiveKey, draftId);
    assert.equal(vm.visibleSessions.some((item: Session) => item.id === "target"), false);
  } finally { wrapper.unmount(); }
});

test("窄metadata timeout分类保留、槽位释放、重试不读取全量列表", async () => {
  let target: FakeXMLHttpRequest | undefined;
  FakeXMLHttpRequest.requests = [];
  FakeXMLHttpRequest.responder = (request) => {
    if (request.url.includes("/agent/sessions/target?")) { target = request; return; }
    respondDefaults(request);
  };
  const wrapper = mountView();
  try {
    await settle();
    const vm = wrapper.vm as any;
    const first = vm.readFreshTarget("target", () => true, new AbortController().signal);
    await settle();
    assert.equal(target!.timeout, 15000);
    target!.ontimeout!();
    const result = await first;
    assert.equal(result.status, "failed");
    assert.equal(result.classification, "transportTimeout");
    const retry = vm.readFreshTarget("target", () => true, new AbortController().signal);
    await settle();
    target!.respond(200, metadataRecord("target"));
    assert.equal((await retry).status, "accepted");
    assert.equal(FakeXMLHttpRequest.requests.filter((r) => r.url.includes("/agent/sessions/target?")).length, 2);
    assert.equal(FakeXMLHttpRequest.requests.filter(isListRead).length, 1);
  } finally { wrapper.unmount(); }
});

test("Fork完整record沿组件事件局部加入并激活，不补目标或全量GET", async () => {
  FakeXMLHttpRequest.requests = [];
  FakeXMLHttpRequest.responder = (request) => respondDefaults(request);
  const wrapper = mountView();
  try {
    await settle();
    const fork = metadataRecord("fork-result");
    wrapper.findComponent({ name: "AgentClientPane" }).vm.$emit("forked", fork);
    await settle();
    assert.equal((wrapper.vm as any).effectiveActiveKey, fork.id);
    assert.deepEqual((wrapper.vm as any).serverSessions.find((item: Session) => item.id === fork.id), fork);
    assert.equal(FakeXMLHttpRequest.requests.filter(isListRead).length, 1);
    assert.equal(FakeXMLHttpRequest.requests.filter((r) => r.url.includes("/agent/sessions/fork-result?")).length, 0);
  } finally { wrapper.unmount(); }
});

test("picker受保护读取只补查一次：head变空、再次保护或失败均保留草稿，不PUT、不第三次GET", async () => {
  for (const secondResult of ["head-null", "protected", "failed"]) {
    const gets: FakeXMLHttpRequest[] = [];
    FakeXMLHttpRequest.requests = [];
    FakeXMLHttpRequest.responder = (request) => {
      if (request.url.includes("/agent/sessions/target?")) { gets.push(request); return; }
      if (isListRead(request)) return respondSessions(request, [metadataRecord("target")], { closedSessionIds: ["target"] });
      respondDefaults(request);
    };
    const wrapper = mountView();
    try {
      await settle();
      const vm = wrapper.vm as any;
      const draft = vm.draftSessions[0].id;
      await vm.openChooseSessionModal(draft);
      const selecting = vm.chooseSession("target");
      await settle();
      const emitTitle = (title: string) => wrapper.findAllComponents({ name: "AgentClientPane" })[0]!.vm.$emit("session-metadata-updated", {
        session: { ...metadataRecord("target"), title }, readToken: vm.metadataReads.captureReadToken("ws-a", "target")
      });
      emitTitle("New title 1");
      gets[0]!.respond(200, metadataRecord("target"));
      await settle();
      assert.equal(gets.length, 2);
      if (secondResult === "protected") {
        emitTitle("New title 2");
        gets[1]!.respond(200, metadataRecord("target"));
      } else if (secondResult === "head-null") gets[1]!.respond(200, { ...metadataRecord("target"), headMessageId: null });
      else gets[1]!.respond(500, { message: "read failed" });
      await selecting;
      await settle();
      assert.equal(gets.length, 2);
      assert.equal(vm.draftSessions[0].id, draft);
      assert.equal(vm.effectiveActiveKey, draft);
      assert.equal(FakeXMLHttpRequest.requests.filter((r) => r.method === "PUT").length, 0);
      assert.equal(FakeXMLHttpRequest.requests.filter(isListRead).length, 2);
    } finally { wrapper.unmount(); }
  }
});

test("实际手动标题保存后完整GET收敛，旧pane元数据事件不回滚，也不补第三次读取", async () => {
  const original = metadataRecord("primary-a");
  FakeXMLHttpRequest.requests = [];
  FakeXMLHttpRequest.responder = (request) => {
    if (request.method === "PUT" && request.url.includes("/title")) return request.respond(200, { ...original, title: "Manual title" });
    if (request.url.includes("/agent/sessions/primary-a?")) return request.respond(200, { ...original, title: "Manual title" });
    if (isListRead(request)) return respondSessions(request, [original]);
    respondDefaults(request);
  };
  const wrapper = mountView();
  try {
    await settle();
    const vm = wrapper.vm as any;
    const token = vm.metadataReads.captureReadToken("ws-a", "primary-a");
    vm.openTitleModal(original);
    vm.titleInput = "Manual title";
    await vm.saveTitle();
    assert.equal(vm.serverSessions[0].title, "Manual title");
    assert.equal((await vm.readFreshTarget("primary-a", () => true, new AbortController().signal)).status, "accepted");
    wrapper.findComponent({ name: "AgentClientPane" }).vm.$emit("session-metadata-updated", { session: original, readToken: token });
    await settle();
    assert.equal(vm.serverSessions[0].title, "Manual title");
    assert.equal(FakeXMLHttpRequest.requests.filter((r) => r.url.includes("/agent/sessions/primary-a?")).length, 1);
    assert.equal(FakeXMLHttpRequest.requests.filter(isListRead).length, 1);
  } finally { wrapper.unmount(); }
});

test("晚到Fork成功record仍局部保留，但较新用户意图禁止其抢回activeTab", async () => {
  FakeXMLHttpRequest.requests = [];
  FakeXMLHttpRequest.responder = (request) => respondDefaults(request);
  const wrapper = mountView();
  try {
    await settle();
    const fork = metadataRecord("late-fork");
    wrapper.findComponent({ name: "AgentClientPane" }).vm.$emit("forked", fork, false);
    await settle();
    assert.equal((wrapper.vm as any).effectiveActiveKey, "primary-a");
    assert.deepEqual((wrapper.vm as any).serverSessions.find((item: Session) => item.id === fork.id), fork);
    assert.equal(FakeXMLHttpRequest.requests.filter(isListRead).length, 1);
  } finally { wrapper.unmount(); }
});

test("picker确认UI期限只结束来源提交，并在原PUT队列补偿；晚失败提示按操作去重", async (t) => {
  const puts: FakeXMLHttpRequest[] = [];
  FakeXMLHttpRequest.requests = [];
  FakeXMLHttpRequest.responder = (request) => {
    if (request.method === "PUT") { puts.push(request); return; }
    if (request.url.includes("/agent/sessions/target?")) return request.respond(200, metadataRecord("target"));
    if (isListRead(request)) return respondSessions(request, [metadataRecord("target")], { closedSessionIds: ["target"] });
    respondDefaults(request);
  };
  const originalWarning = message.warning;
  const originalError = message.error;
  const notices: unknown[] = [];
  message.warning = ((...args: unknown[]) => { notices.push(args); }) as typeof message.warning;
  message.error = ((...args: unknown[]) => { notices.push(args); }) as typeof message.error;
  const wrapper = mountView();
  try {
    await settle();
    const vm = wrapper.vm as any;
    const draft = vm.draftSessions[0].id;
    await vm.openChooseSessionModal(draft);
    notices.length = 0; // Non-critical initial options errors belong to initialization, not this operation.
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const choosing = vm.chooseSession("target");
    await settle();
    assert.equal(puts.length, 1);
    t.mock.timers.tick(30000);
    await choosing;
    assert.equal(vm.chooseSessionSelecting, false);
    assert.equal(vm.draftSessions[0].id, draft);
    assert.equal(puts.length, 1, "UI期限不清真实inFlight，也不并发补偿");
    assert.equal(notices.length, 1, JSON.stringify(notices));
    assert.match(String((notices[0] as unknown[])[0]), /Opening may have been saved; restoring the hidden state is unconfirmed/);
    puts[0]!.respond(200, { workspaceId: "ws-a", sessionId: "target", visible: true });
    await settle();
    assert.equal(puts.length, 2);
    assert.deepEqual(JSON.parse(String(puts[1]!.requestBody)), { visible: false });
    puts[1]!.respond(500, { message: "failed", code: "INTERNAL_ERROR" });
    await settle();
    assert.equal(notices.length, 1, "同操作的真实晚失败不重复提示");
    assert.equal(vm.effectiveActiveKey, draft);
  } finally {
    wrapper.unmount();
    t.mock.timers.reset();
    message.warning = originalWarning;
    message.error = originalError;
  }
});

test("较新外部打开即使失败也终止旧picker选择，不遗留loading或替换草稿", async () => {
  let target: FakeXMLHttpRequest | undefined;
  FakeXMLHttpRequest.requests = [];
  FakeXMLHttpRequest.responder = (request) => {
    if (request.url.includes("/agent/sessions/target?")) { target = request; return; }
    if (request.url.includes("/agent/sessions/missing?")) return request.respond(500, { message: "failed", code: "INTERNAL_ERROR" });
    if (isListRead(request)) return respondSessions(request, [metadataRecord("target")], { closedSessionIds: ["target"] });
    respondDefaults(request);
  };
  const wrapper = mountView();
  try {
    await settle();
    const vm = wrapper.vm as any;
    const draft = vm.draftSessions[0].id;
    await vm.openChooseSessionModal(draft);
    const choosing = vm.chooseSession("target");
    await settle();
    await vm.openTargetSession("missing");
    await choosing;
    target!.respond(200, metadataRecord("target"));
    await settle();
    assert.equal(vm.chooseSessionModalOpen, false);
    assert.equal(vm.chooseSessionSelecting, false);
    assert.equal(vm.effectiveActiveKey, draft);
    assert.equal(FakeXMLHttpRequest.requests.filter((request) => request.method === "PUT").length, 0);
  } finally { wrapper.unmount(); }
});

test("真实visibility API保留专属timeout分类，窄15秒配置不改变Axios全局", async () => {
  const { apiClient, setWorkspaceAgentSessionTabVisibility } = await import("@/shared/api/api");
  let request: FakeXMLHttpRequest | undefined;
  FakeXMLHttpRequest.requests = [];
  FakeXMLHttpRequest.responder = (value) => { request = value; };
  const globalTimeout = apiClient.defaults.timeout;
  const pending = setWorkspaceAgentSessionTabVisibility("ws-a", "target", { visible: true }).then(() => { throw new Error("unexpected success"); }, (error) => error);
  await settle();
  assert.equal(request!.timeout, 15000);
  request!.ontimeout!();
  const error = await pending;
  assert.equal(error.code, "AGENT_TAB_VISIBILITY_TIMEOUT");
  assert.equal(apiClient.defaults.timeout, globalTimeout);
});

test("自动标题只同步当前目标；失败停止，不因空闲状态无限重试，显式重试可收敛", async () => {
  let reads = 0;
  let fail = true;
  FakeXMLHttpRequest.requests = [];
  FakeXMLHttpRequest.responder = (request) => {
    if (request.url.includes("/agent/sessions/primary-a?")) {
      reads++;
      return fail ? request.respond(500, { message: "failed", code: "INTERNAL_ERROR" }) : request.respond(200, { ...metadataRecord("primary-a"), title: "Automatic title" });
    }
    respondDefaults(request);
  };
  const wrapper = mountView();
  try {
    await settle();
    const vm = wrapper.vm as any;
    await vm.syncSessionTitle("primary-a");
    await settle();
    await settle();
    assert.equal(reads, 1);
    assert.equal(vm.failedSessionTitleSync["primary-a"], true);
    fail = false;
    await vm.syncSessionTitle("primary-a");
    await settle();
    assert.equal(reads, 2);
    assert.equal(vm.failedSessionTitleSync["primary-a"], undefined);
    assert.equal(vm.serverSessions.find((item: Session) => item.id === "primary-a").title, "Automatic title");
    assert.equal(FakeXMLHttpRequest.requests.filter(isListRead).length, 1);
  } finally { wrapper.unmount(); }
});

test("picker旧workspace在途PUT可能提交，但切换后不补偿、不告警、不替换当前来源", async () => {
  const puts: FakeXMLHttpRequest[] = [];
  FakeXMLHttpRequest.requests = [];
  FakeXMLHttpRequest.responder = (request) => {
    if (request.method === "PUT") { puts.push(request); return; }
    if (request.url.includes("workspaceId=ws-a") && request.url.includes("/agent/sessions/target?")) return request.respond(200, metadataRecord("target"));
    if (request.url.includes("workspaceId=ws-a") && isListRead(request)) return respondSessions(request, [metadataRecord("target")], { closedSessionIds: ["target"] });
    respondDefaults(request, request.url.includes("ws-b") ? "ws-b" : "ws-a");
  };
  const wrapper = mountView();
  try {
    await settle();
    const vm = wrapper.vm as any;
    await vm.openChooseSessionModal(vm.draftSessions[0].id);
    const choosing = vm.chooseSession("target");
    await settle();
    assert.equal(puts.length, 1);
    await wrapper.setProps({ workspaceId: "ws-b" });
    await choosing;
    await settle();
    const active = vm.effectiveActiveKey;
    const warning = tNotices();
    try {
      puts[0]!.respond(500, { code: "INTERNAL_ERROR", message: "old failure" });
      await settle();
      assert.equal(warning.notices.length, 0);
      assert.equal(puts.length, 1);
      assert.equal(vm.effectiveActiveKey, active);
      assert.equal(vm.chooseSessionModalOpen, false);
    } finally { warning.restore(); }
  } finally { wrapper.unmount(); }
});

function tNotices() {
  const original = message.error;
  const notices: unknown[] = [];
  message.error = ((...args: unknown[]) => { notices.push(args); }) as typeof message.error;
  return { notices, restore: () => { message.error = original; } };
}

function pickerReviewRequests() {
  const gets: FakeXMLHttpRequest[] = [];
  const puts: FakeXMLHttpRequest[] = [];
  FakeXMLHttpRequest.requests = [];
  FakeXMLHttpRequest.responder = (request) => {
    const workspaceId = request.url.includes("ws-b") ? "ws-b" : "ws-a";
    if (request.method === "PUT") { puts.push(request); return; }
    if (/\/agent\/sessions\/(target|other)\?/.test(request.url)) { gets.push(request); return; }
    if (isListRead(request)) return respondSessions(request, ["target", "other"].map((id) => ({ ...metadataRecord(id), workspaceId })), { closedSessionIds: ["target", "other"] });
    respondDefaults(request, workspaceId);
  };
  return { gets, puts };
}

function pickerRow(wrapper: ReturnType<typeof mountView>, id: string) {
  const row = wrapper.findAll(".choose-session-item").find((item) => item.text().includes(id));
  assert.ok(row, `expected picker row ${id}`);
  return row;
}

test("M1：真实当前SESSION_NOT_FOUND移除候选并终止选择，重开不恢复，缓存和提醒保留", async () => {
  const { gets, puts } = pickerReviewRequests();
  const storageKey = "agent-workbench.workspace.agent.sessionIndicators.v1.ws-a";
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const saved = new Map([[storageKey, JSON.stringify({ target: { lastTerminalAt: 123, lastSeenTerminalAt: 100 } })]]);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => { saved.set(key, value); },
    removeItem: (key: string) => { saved.delete(key); }
  } });
  const wrapper = mountView("ws-a", undefined, { renderPicker: true });
  try {
    await settle();
    const vm = wrapper.vm as any;
    const draft = vm.draftSessions[0].id;
    vm.upsertSession(metadataRecord("target")); // A previously loaded hidden cache entry.
    await settle();
    assert.equal(vm.statusStore.state.entries.target.lastTerminalAt, 123);
    await vm.openChooseSessionModal(draft);
    await pickerRow(wrapper, "target").trigger("click");
    await settle();
    gets[0]!.respond(404, { code: "SESSION_NOT_FOUND", message: "gone" });
    await settle();
    assert.equal(wrapper.findAll(".choose-session-item").some((item) => item.text().includes("target")), false);
    assert.equal(vm.chooseSessionSelecting, false);
    assert.equal(vm.failedPickerSelection, null);
    assert.equal(vm.serverSessions.some((item: Session) => item.id === "target"), true);
    assert.equal(vm.statusStore.state.entries.target.lastTerminalAt, 123);
    assert.equal(vm.statusStore.state.entries.target.lastSeenTerminalAt, 100);
    assert.deepEqual(JSON.parse(localStorage.getItem(storageKey)!).target, { lastTerminalAt: 123, lastSeenTerminalAt: 100 });
    assert.equal(vm.effectiveActiveKey, draft);
    assert.equal(puts.length, 0);
    vm.closeChooseSessionModal();
    await vm.openChooseSessionModal(draft);
    await settle();
    assert.equal(vm.chooseSessionItems.some((item: Session) => item.id === "target"), false);
    await vm.chooseSession("target");
    assert.equal(gets.length, 1, "unavailable目标不能经普通选择重新进入");
    assert.equal(FakeXMLHttpRequest.requests.filter(isListRead).length, 3);
  } finally {
    wrapper.unmount();
    if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

for (const failure of ["workspace404", "unauthorized", "network", "server500"] as const) {
  test(`M1：${failure}不删除候选，重开仍保留本地target`, async () => {
    const { gets, puts } = pickerReviewRequests();
    const wrapper = mountView("ws-a", undefined, { renderPicker: true });
    try {
      await settle();
      const vm = wrapper.vm as any;
      const draft = vm.draftSessions[0].id;
      await vm.openChooseSessionModal(draft);
      await pickerRow(wrapper, "target").trigger("click");
      await settle();
      if (failure === "network") gets[0]!.onerror!();
      else gets[0]!.respond(failure === "workspace404" ? 404 : failure === "unauthorized" ? 401 : 500, {
        code: failure === "workspace404" ? "WORKSPACE_NOT_FOUND" : failure === "unauthorized" ? "UNAUTHORIZED" : "INTERNAL_ERROR", message: "failed"
      });
      await settle();
      assert.ok(pickerRow(wrapper, "target"));
      assert.equal(vm.unavailableSessionIds.has("target"), false);
      assert.equal(puts.length, 0);
      vm.closeChooseSessionModal();
      await vm.openChooseSessionModal(draft);
      await settle();
      assert.ok(pickerRow(wrapper, "target"));
    } finally { wrapper.unmount(); }
  });
}

test("M1：404被较新元数据保护时最多补读一次，不移除候选；已取消的迟到404也不删除", async () => {
  const { gets, puts } = pickerReviewRequests();
  const wrapper = mountView("ws-a", undefined, { renderPicker: true });
  try {
    await settle();
    const vm = wrapper.vm as any;
    const draft = vm.draftSessions[0].id;
    await vm.openChooseSessionModal(draft);
    await pickerRow(wrapper, "target").trigger("click");
    await settle();
    vm.metadataReads.mutation("target");
    gets[0]!.respond(404, { code: "SESSION_NOT_FOUND", message: "late" });
    await settle();
    assert.equal(gets.length, 2);
    vm.metadataReads.mutation("target");
    gets[1]!.respond(404, { code: "SESSION_NOT_FOUND", message: "late again" });
    await settle();
    assert.ok(pickerRow(wrapper, "target"));
    assert.equal(vm.unavailableSessionIds.has("target"), false);
    assert.equal(vm.chooseSessionSelectionFailed, true);
    await pickerRow(wrapper, "target").trigger("click");
    assert.equal(gets.length, 2);
    vm.closeChooseSessionModal();
    await vm.openChooseSessionModal(draft);
    await pickerRow(wrapper, "target").trigger("click");
    await settle();
    assert.equal(gets.length, 3);
    vm.closeChooseSessionModal();
    gets[2]!.respond(404, { code: "SESSION_NOT_FOUND", message: "cancelled old read" });
    await settle();
    await vm.openChooseSessionModal(draft);
    await settle();
    assert.ok(pickerRow(wrapper, "target"));
    assert.equal(vm.unavailableSessionIds.has("target"), false);
    assert.equal(puts.length, 0);
  } finally { wrapper.unmount(); }
});

for (const phase of ["verification", "confirmation"] as const) {
  test(`M2：${phase}超时保留重试按钮和失败身份，普通重复点击无新GET，显式重试使用新请求`, async (t) => {
    const { gets, puts } = pickerReviewRequests();
    const wrapper = mountView("ws-a", undefined, { renderPicker: true });
    try {
      await settle();
      const vm = wrapper.vm as any;
      const draft = vm.draftSessions[0].id;
      await vm.openChooseSessionModal(draft);
      t.mock.timers.enable({ apis: ["setTimeout"] });
      await pickerRow(wrapper, "target").trigger("click");
      await settle();
      if (phase === "confirmation") {
        gets[0]!.respond(200, metadataRecord("target"));
        await settle();
        assert.equal(puts.length, 1);
      }
      t.mock.timers.tick(30000);
      await settle();
      assert.equal(vm.chooseSessionSelecting, false);
      assert.equal(vm.pickerSelection, null, "终止活动订阅，但保留独立失败身份");
      assert.equal(vm.failedPickerSelection.targetId, "target");
      assert.equal("abort" in vm.failedPickerSelection, false);
      assert.equal("receipt" in vm.failedPickerSelection, false);
      assert.ok(wrapper.find('[data-testid="agent-picker-retry"]').exists());
      const seq = vm.openParentIntentId;
      await pickerRow(wrapper, "target").trigger("click");
      await pickerRow(wrapper, "target").trigger("click");
      await settle();
      assert.equal(gets.length, 1);
      assert.equal(vm.openParentIntentId, seq);
      assert.equal(vm.effectiveActiveKey, draft);
      if (phase === "confirmation") {
        puts[0]!.respond(200, { workspaceId: "ws-a", sessionId: "target", visible: true });
        await settle();
        assert.equal(puts.length, 2);
        assert.deepEqual(JSON.parse(String(puts[1]!.requestBody)), { visible: false });
        puts[1]!.respond(200, { workspaceId: "ws-a", sessionId: "target", visible: false });
        await settle();
      }
      await wrapper.get('[data-testid="agent-picker-retry"]').trigger("click");
      await settle();
      assert.equal(gets.length, 2);
      assert.notEqual(gets[1], gets[0]);
      assert.ok(vm.openParentIntentId > seq);
      assert.equal(vm.failedPickerSelection, null);
      gets[1]!.respond(200, metadataRecord("target"));
      await settle();
      const put = puts.at(-1)!;
      assert.deepEqual(JSON.parse(String(put.requestBody)), { visible: true });
      put.respond(200, { workspaceId: "ws-a", sessionId: "target", visible: true });
      await settle();
      assert.equal(vm.draftSessions.some((item: Session) => item.id === draft), false);
      assert.equal(vm.effectiveActiveKey, "target");
      assert.equal(vm.chooseSessionModalOpen, false);
      assert.equal(FakeXMLHttpRequest.requests.filter(isListRead).length, 2);
    } finally { wrapper.unmount(); t.mock.timers.reset(); }
  });
}

test("M2：确认期间真实timeline改变证明，取消补偿后仍可显式重试，不允许普通点击开新代次", async () => {
  const { gets, puts } = pickerReviewRequests();
  const wrapper = mountView("ws-a", undefined, { renderPicker: true });
  try {
    await settle();
    const vm = wrapper.vm as any;
    const draft = vm.draftSessions[0].id;
    await vm.openChooseSessionModal(draft);
    await pickerRow(wrapper, "target").trigger("click");
    await settle();
    gets[0]!.respond(200, metadataRecord("target"));
    await settle();
    const changed = { ...metadataRecord("target"), title: "Changed qualification title" };
    const pane = wrapper.findAllComponents({ name: "AgentClientPane" }).find((item) => item.props("sessionId") === "target");
    assert.ok(pane);
    pane.vm.$emit("session-metadata-updated", { session: changed, readToken: vm.metadataReads.captureReadToken("ws-a", "target") });
    await nextTick();
    puts[0]!.respond(200, { workspaceId: "ws-a", sessionId: "target", visible: true });
    await settle();
    assert.equal(vm.effectiveActiveKey, draft);
    assert.equal(vm.pickerSelection, null);
    assert.equal(vm.failedPickerSelection.targetId, "target");
    assert.ok(wrapper.find('[data-testid="agent-picker-retry"]').exists());
    assert.equal(puts.length, 2);
    assert.deepEqual(JSON.parse(String(puts[1]!.requestBody)), { visible: false });
    await pickerRow(wrapper, "target").trigger("click");
    await settle();
    assert.equal(gets.length, 1);
    await wrapper.get('[data-testid="agent-picker-retry"]').trigger("click");
    await settle();
    assert.equal(gets.length, 2);
    gets[1]!.respond(200, changed);
    await settle();
    assert.equal(puts.length, 2, "重试打开不绕过在途补偿队列");
    puts[1]!.respond(200, { workspaceId: "ws-a", sessionId: "target", visible: false });
    await settle();
    assert.equal(puts.length, 3);
    puts[2]!.respond(200, { workspaceId: "ws-a", sessionId: "target", visible: true });
    await settle();
    assert.equal(vm.effectiveActiveKey, "target");
    assert.equal(vm.draftSessions.some((item: Session) => item.id === draft), false);
    assert.equal(vm.chooseSessionModalOpen, false);
  } finally { wrapper.unmount(); }
});

test("M2：失败后对其他target的明确点击可替代失败身份，不要求重开弹窗", async () => {
  const { gets } = pickerReviewRequests();
  const wrapper = mountView("ws-a", undefined, { renderPicker: true });
  try {
    await settle();
    const vm = wrapper.vm as any;
    await vm.openChooseSessionModal(vm.draftSessions[0].id);
    await pickerRow(wrapper, "target").trigger("click");
    await settle();
    gets[0]!.respond(500, { code: "INTERNAL_ERROR", message: "failed" });
    await settle();
    assert.ok(wrapper.find('[data-testid="agent-picker-retry"]').exists());
    await pickerRow(wrapper, "target").trigger("click");
    assert.equal(gets.length, 1);
    await pickerRow(wrapper, "other").trigger("click");
    await settle();
    assert.equal(gets.length, 2);
    assert.ok(gets[1]!.url.includes("/other?"));
    assert.equal(vm.failedPickerSelection, null);
    assert.equal(vm.chooseSessionSelecting, true);
    assert.equal(vm.chooseSessionModalOpen, true);
  } finally { wrapper.unmount(); }
});

for (const change of ["close", "source", "workspace"] as const) {
  test(`M2：${change}清理失败身份，旧显式重试不能跨来源或弹窗代次发GET`, async () => {
    const { gets } = pickerReviewRequests();
    const wrapper = mountView("ws-a", undefined, { renderPicker: true });
    try {
      await settle();
      const vm = wrapper.vm as any;
      const draft = vm.draftSessions[0].id;
      await vm.openChooseSessionModal(draft);
      await pickerRow(wrapper, "target").trigger("click");
      await settle();
      gets[0]!.respond(500, { code: "INTERNAL_ERROR", message: "failed" });
      await settle();
      assert.equal(vm.failedPickerSelection.sourceId, draft);
      const generation = vm.failedPickerSelection.generation;
      if (change === "close") vm.closeChooseSessionModal();
      else if (change === "source") await vm.createOneSession();
      else await wrapper.setProps({ workspaceId: "ws-b" });
      await settle();
      assert.equal(vm.failedPickerSelection, null);
      assert.equal(vm.chooseSessionSelectionFailed, false);
      assert.equal(wrapper.find('[data-testid="agent-picker-retry"]').exists(), false);
      await vm.openChooseSessionModal(vm.effectiveActiveKey);
      await settle();
      await vm.chooseSession("target", true);
      assert.equal(gets.length, 1, "旧显式retry没有当前失败身份，不得发请求");
      await pickerRow(wrapper, "target").trigger("click");
      await settle();
      assert.equal(gets.length, 2, "新弹窗允许明确普通选择");
      assert.ok(vm.pickerSelection.generation > generation);
    } finally { wrapper.unmount(); }
  });
}


test("M1：核实deadline已过但timer未执行时，迟到404按超时处理而非删除", async (t) => {
  const { gets, puts } = pickerReviewRequests();
  const wrapper = mountView("ws-a", undefined, { renderPicker: true });
  const now = performance.now.bind(performance);
  let elapsed = 0;
  try {
    await settle();
    const vm = wrapper.vm as any;
    await vm.openChooseSessionModal(vm.draftSessions[0].id);
    t.mock.method(performance, "now", () => now() + elapsed);
    await pickerRow(wrapper, "target").trigger("click");
    await settle();
    elapsed = 30001;
    gets[0]!.respond(404, { code: "SESSION_NOT_FOUND", message: "late past deadline" });
    await settle();
    assert.ok(pickerRow(wrapper, "target"));
    assert.equal(vm.unavailableSessionIds.has("target"), false);
    assert.equal(vm.chooseSessionSelecting, false);
    assert.ok(wrapper.find('[data-testid="agent-picker-retry"]').exists());
    assert.equal(puts.length, 0);
  } finally { wrapper.unmount(); t.mock.restoreAll(); }
});

function scopedPageHarness() {
  const pages: FakeXMLHttpRequest[] = [];
  const targets: FakeXMLHttpRequest[] = [];
  FakeXMLHttpRequest.requests = [];
  FakeXMLHttpRequest.responder = (request) => {
    if (request.url.includes("scope=tabs")) return respondSessions(request, [], { closedSessionIds: ["target"] });
    if (request.url.includes("scope=continuable")) { pages.push(request); return; }
    if (request.url.includes("/agent/sessions/target?")) { targets.push(request); return; }
    return respondDefaults(request);
  };
  return { pages, targets };
}
function respondPage(request: FakeXMLHttpRequest, ids: string[], cursor: string | null = null) {
  request.respond(200, { scope: "continuable", items: ids.map((id) => metadataRecord(id)), nextCursor: cursor });
}

test("scope分页：无本地primary也可打开，首屏50/更多单飞/失败保留cursor/去重/终止且候选不注册", async () => {
  const { pages } = scopedPageHarness();
  const wrapper = mountView("ws-a", undefined, { renderPicker: true });
  try {
    await settle();
    const vm = wrapper.vm as any;
    const draft = vm.draftSessions[0].id;
    assert.equal(vm.serverSessions.length, 0);
    assert.equal(vm.canChooseSessionFrom(draft), true);
    assert.equal(pages.length, 0, "按钮可见性不预取候选");
    const opening = vm.openChooseSessionModal(draft);
    await settle();
    assert.equal(pages.length, 1);
    assert.equal(pages[0]!.timeout, 15000);
    assert.ok(wrapper.find('[data-testid="agent-picker-loading"]').exists());
    respondPage(pages[0]!, Array.from({ length: 50 }, (_, i) => `candidate-${i}`), "page-two");
    await opening; await settle();
    assert.equal(vm.chooseSessionItems.length, 50);
    assert.equal(vm.serverSessions.length, 0);
    assert.equal(vm.statusStore.state.registeredSessionIds.size, 0);
    assert.equal(FakeXMLHttpRequest.requests.filter((request) => /candidate-.*(run-state|model)/.test(request.url)).length, 0);
    const more = vm.loadChooseSessionPage();
    void vm.loadChooseSessionPage();
    await settle();
    assert.equal(pages.length, 2);
    assert.equal(new URL(pages[1]!.url, "http://local").searchParams.get("cursor"), "page-two");
    pages[1]!.respond(500, { message: "failed" });
    await more; await settle();
    assert.equal(vm.chooseSessionItems.length, 50);
    assert.equal(vm.chooseSessionNextCursor, "page-two");
    assert.ok(wrapper.find('[data-testid="agent-picker-page-error"]').exists());
    const retry = vm.loadChooseSessionPage();
    respondPage(pages[2]!, ["candidate-0", "candidate-50"]);
    await retry; await settle();
    assert.equal(vm.chooseSessionItems.length, 51);
    assert.equal(vm.chooseSessionNextCursor, null);
    await vm.loadChooseSessionPage();
    assert.equal(pages.length, 3);
    assert.equal(FakeXMLHttpRequest.requests.filter((request) => request.method === "GET" && request.url.includes("/agent-tab-state")).length, 0);
  } finally { wrapper.unmount(); }
});

test("首屏失败不是空态，重试为空成功；非法cursor只能刷新首屏", async () => {
  const { pages } = scopedPageHarness();
  const wrapper = mountView("ws-a", undefined, { renderPicker: true });
  try {
    await settle(); const vm = wrapper.vm as any;
    const opening = vm.openChooseSessionModal(vm.draftSessions[0].id);
    pages[0]!.respond(500, { message: "failure" }); await opening; await settle();
    assert.ok(wrapper.find('[data-testid="agent-picker-page-error"]').exists());
    assert.equal(wrapper.find('[data-testid="agent-picker-empty"]').exists(), false);
    const retry = vm.loadChooseSessionPage(true);
    respondPage(pages[1]!, []); await retry; await settle();
    assert.ok(wrapper.find('[data-testid="agent-picker-empty"]').exists());
    const refresh = vm.loadChooseSessionPage(true);
    respondPage(pages[2]!, ["target"], "expired"); await refresh;
    const more = vm.loadChooseSessionPage();
    pages[3]!.respond(400, { code: "AGENT_SESSION_CURSOR_INVALID", message: "expired" }); await more;
    assert.equal(vm.chooseSessionPageError, "cursor"); assert.equal(vm.chooseSessionItems.length, 1);
    await vm.loadChooseSessionPage(); assert.equal(pages.length, 4, "非法cursor不循环重试");
    const restart = vm.loadChooseSessionPage(true);
    assert.equal(new URL(pages[4]!.url, "http://local").searchParams.has("cursor"), false);
    respondPage(pages[4]!, ["new"]); await restart;
    assert.deepEqual(vm.chooseSessionItems.map((item: { id: string }) => item.id), ["new"]);
  } finally { wrapper.unmount(); }
});

test("picker关闭、刷新、来源开始创建及工作区切换隔离旧页与finally", async () => {
  const { pages } = scopedPageHarness();
  const wrapper = mountView("ws-a", undefined, { renderPicker: true });
  try {
    await settle(); const vm = wrapper.vm as any;
    const source = vm.draftSessions[0].id;
    const old = vm.openChooseSessionModal(source);
    const fresh = vm.loadChooseSessionPage(true);
    await old;
    pages[0]!.respond(500, { message: "old error" }); await settle();
    assert.equal(vm.chooseSessionLoading, true);
    assert.equal(vm.chooseSessionPageError, null);
    respondPage(pages[1]!, ["fresh"]); await fresh;
    assert.deepEqual(vm.chooseSessionItems.map((item: { id: string }) => item.id), ["fresh"]);
    const closed = vm.loadChooseSessionPage(true);
    vm.closeChooseSessionModal(); pages[2]!.respond(200, { scope: "continuable", items: [metadataRecord("late")], nextCursor: null });
    await closed; assert.equal(vm.chooseSessionItems.length, 0);
    const switched = vm.openChooseSessionModal(source);
    await wrapper.setProps({ workspaceId: "ws-b" });
    respondPage(pages[3]!, ["late-a"]); await switched; await settle();
    assert.equal(vm.chooseSessionModalOpen, false); assert.equal(vm.chooseSessionItems.length, 0);
    assert.equal(vm.chooseSessionLoading, false);
    assert.equal(vm.serverSessions.some((record: Session) => record.id === "late-a"), false);
  } finally { wrapper.unmount(); }
});

for (const visible of [true, false]) {
  test(`snapshot前已在途${visible ? "open" : "close"} PUT于返回前完成：成员和confirmed均不回滚`, async () => {
    const snapshots: FakeXMLHttpRequest[] = [];
    const puts: FakeXMLHttpRequest[] = [];
    FakeXMLHttpRequest.requests = [];
    FakeXMLHttpRequest.responder = (request) => {
      if (request.method === "PUT") { puts.push(request); return; }
      if (request.url.includes("scope=tabs")) {
        snapshots.push(request);
        if (snapshots.length === 1) return respondSessions(request, [metadataRecord("target")], { closedSessionIds: visible ? ["target"] : [] });
        return;
      }
      return respondDefaults(request);
    };
    const wrapper = mountView();
    try {
      await settle(); const vm = wrapper.vm as any;
      if (visible) vm.upsertSession(metadataRecord("target"));
      vm.requestSessionVisibility("target", visible);
      const reload = vm.reloadTabsSnapshot();
      puts[0]!.respond(200, { workspaceId: "ws-a", sessionId: "target", visible }); await settle();
      respondSessions(snapshots[1]!, [metadataRecord("target")], { closedSessionIds: visible ? ["target"] : [] });
      await reload; await settle();
      assert.equal(vm.tabVisibilityController.getState("target").confirmed, visible);
      assert.equal(vm.visibleSessions.some((item: Session) => item.id === "target"), visible);
      assert.equal(vm.serverSessions.some((item: Session) => item.id === "target"), true);
    } finally { wrapper.unmount(); }
  });
}

test("partial snapshot不删除hidden缓存和覆盖；显式reload失败不切初始化或自动重试", async () => {
  const snapshots: FakeXMLHttpRequest[] = [];
  FakeXMLHttpRequest.requests = [];
  FakeXMLHttpRequest.responder = (request) => {
    if (request.url.includes("scope=tabs")) { snapshots.push(request); if (snapshots.length === 1) return respondSessions(request, [], { closedSessionIds: ["hidden"] }); return; }
    return respondDefaults(request);
  };
  const wrapper = mountView();
  try {
    await settle(); const vm = wrapper.vm as any;
    vm.upsertSession(metadataRecord("hidden")); await settle();
    assert.equal(vm.visibleSessions.some((item: Session) => item.id === "hidden"), false);
    const reload = vm.reloadTabsSnapshot();
    respondSessions(snapshots[1]!, []); await reload; await settle();
    assert.equal(vm.serverSessions.some((item: Session) => item.id === "hidden"), true);
    assert.equal(vm.tabVisibilityController.getState("hidden").confirmed, false, "snapshot absence cannot reset a cached hidden confirmation");
    assert.equal(vm.visibleSessions.some((item: Session) => item.id === "hidden"), false);
    const failed = vm.reloadTabsSnapshot(); snapshots[2]!.respond(500, { message: "failure" }); await failed; await settle();
    assert.equal(vm.initializationState, "ready"); assert.equal(vm.draftSessions.length, 1);
    assert.equal(snapshots.length, 3);
  } finally { wrapper.unmount(); }
});

test("unknown旧提醒跨partial持久化和workspace保留，重新加载hidden恢复原时间且无全历史轮询", async () => {
  const prefix = "agent-workbench.workspace.agent.sessionIndicators.v1.";
  const saved = new Map<string, string>([[prefix + "ws-a", JSON.stringify({ hidden: { lastTerminalAt: 999, lastSeenTerminalAt: 100 }, unknown: { lastTerminalAt: 200, lastSeenTerminalAt: null }, corrupt: { lastTerminalAt: -1, lastSeenTerminalAt: "invalid" }, array: [], nonObject: null })], [prefix + "ws-b", JSON.stringify({ other: { lastTerminalAt: 80, lastSeenTerminalAt: 70 } })]]);
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value), removeItem: (key: string) => saved.delete(key) } });
  FakeXMLHttpRequest.requests = [];
  FakeXMLHttpRequest.responder = (request) => request.url.includes("scope=tabs") ? respondSessions(request, []) : respondDefaults(request);
  const wrapper = mountView();
  try {
    await settle(); const vm = wrapper.vm as any;
    vm.statusStore.markSessionSeen(vm.draftSessions[0].id); await settle();
    assert.deepEqual(JSON.parse(saved.get(prefix + "ws-a")!).unknown, { lastTerminalAt: 200, lastSeenTerminalAt: null });
    assert.equal(FakeXMLHttpRequest.requests.some((request) => /hidden|unknown/.test(request.url)), false);
    assert.equal(JSON.parse(saved.get(prefix + "ws-a")!).corrupt, undefined);
    assert.equal(JSON.parse(saved.get(prefix + "ws-a")!).array, undefined);
    assert.equal(JSON.parse(saved.get(prefix + "ws-a")!).nonObject, undefined);
    vm.upsertSession(metadataRecord("hidden")); await settle();
    assert.equal(vm.statusStore.state.entries.hidden.lastTerminalAt, 999);
    assert.equal(vm.statusStore.state.entries.hidden.lastSeenTerminalAt, 100);
    assert.equal(FakeXMLHttpRequest.requests.some((request) => request.url.includes("hidden") && request.url.includes("run-state")), false);
    await wrapper.setProps({ workspaceId: "ws-b" }); await settle();
    assert.deepEqual(JSON.parse(saved.get(prefix + "ws-a")!).hidden, { lastTerminalAt: 999, lastSeenTerminalAt: 100 });
    assert.deepEqual(JSON.parse(saved.get(prefix + "ws-b")!).other, { lastTerminalAt: 80, lastSeenTerminalAt: 70 });
  } finally { wrapper.unmount(); if (previous) Object.defineProperty(globalThis, "localStorage", previous); else Reflect.deleteProperty(globalThis, "localStorage"); }
});


test("picker来源开始创建立即取消页面；迟到旧页不替换创建完成的Tab", async () => {
  const { pages } = scopedPageHarness();
  const wrapper = mountView("ws-a", undefined, { renderPicker: true });
  try {
    await settle(); const vm = wrapper.vm as any;
    const source = vm.draftSessions[0].id;
    const loading = vm.openChooseSessionModal(source);
    let post: FakeXMLHttpRequest | undefined;
    const prior = FakeXMLHttpRequest.responder;
    FakeXMLHttpRequest.responder = (request) => {
      if (request.method === "POST" && request.url.includes("/agent/sessions")) { post = request; return; }
      prior(request);
    };
    const creation = vm.ensureSessionCreated(source);
    await settle();
    assert.equal(vm.chooseSessionModalOpen, false);
    assert.ok(post);
    respondPage(pages[0]!, ["stale-candidate"]); await loading;
    post.respond(200, metadataRecord("created-session")); await creation; await settle();
    assert.equal(vm.effectiveActiveKey, "created-session");
    assert.equal(vm.serverSessions.some((record: Session) => record.id === "stale-candidate"), false);
    assert.equal(vm.chooseSessionLoading, false);
  } finally { wrapper.unmount(); }
});

for (const failure of ["unauthorized", "timeout", "partial-protocol"] as const) {
  test(`picker首屏${failure}不被解释为空成功、不污染缓存`, async () => {
    const { pages } = scopedPageHarness();
    const wrapper = mountView("ws-a", undefined, { renderPicker: true });
    try {
      await settle(); const vm = wrapper.vm as any;
      const loading = vm.openChooseSessionModal(vm.draftSessions[0].id);
      const request = pages[0]!;
      assert.equal(request.timeout, 15_000);
      if (failure === "unauthorized") request.respond(401, { code: "UNAUTHORIZED", message: "not authenticated" });
      else if (failure === "timeout") request.ontimeout?.();
      else request.respond(200, { scope: "continuable", items: [{ id: "partial" }], nextCursor: null });
      await loading; await settle();
      assert.ok(vm.chooseSessionPageError);
      assert.equal(vm.chooseSessionItems.length, 0);
      assert.equal(vm.chooseSessionLoading, false);
      assert.equal(vm.serverSessions.some((record: Session) => record.id === "partial"), false);
    } finally { wrapper.unmount(); }
  });
}

/** Real XHR seams: metadata GET and visibility PUT settle independently. */
function zeroVisibleTargetHarness(options: { origin?: boolean; deferInitial?: boolean } = {}) {
  const snapshots: FakeXMLHttpRequest[] = [];
  const gets: FakeXMLHttpRequest[] = [];
  const puts: FakeXMLHttpRequest[] = [];
  FakeXMLHttpRequest.requests = [];
  FakeXMLHttpRequest.responder = (request) => {
    if (request.url.includes("scope=tabs")) {
      snapshots.push(request);
      if (snapshots.length === 1 && !options.deferInitial) {
        return respondSessions(request, options.origin ? [session("origin", "ws-a")] : []);
      }
      return;
    }
    if (request.method === "GET" && /\/agent\/sessions\/[^/?]+(?:\?|$)/.test(request.url)) { gets.push(request); return; }
    if (request.method === "PUT" && request.url.includes("/agent-tab-state/")) { puts.push(request); return; }
    const workspaceId = new URL(request.url, "http://local").searchParams.get("workspaceId") ?? "ws-a";
    return respondDefaults(request, workspaceId);
  };
  return { snapshots, gets, puts };
}

function confirmTarget(request: FakeXMLHttpRequest, id = "target", workspaceId = "ws-a") {
  request.respond(200, { workspaceId, sessionId: id, visible: true });
}

function failTargetRead(request: FakeXMLHttpRequest, failure: "network" | "401" | "404" | "500" | "timeout") {
  if (failure === "network") request.onerror?.();
  else if (failure === "timeout") request.ontimeout?.();
  else request.respond(Number(failure), { code: failure === "404" ? "SESSION_NOT_FOUND" : "REQUEST_FAILED", message: "synthetic target failure" });
}

test("M1回退：空snapshot有待派发外部意图，GET及visibility confirmed前均不造草稿，成功仅目标", async () => {
  const { snapshots, gets, puts } = zeroVisibleTargetHarness({ deferInitial: true });
  const wrapper = mountView("ws-a", { sessionId: "target", sequence: 1 });
  try {
    await settle(); const vm = wrapper.vm as any;
    assert.equal(gets.length, 0);
    respondSessions(snapshots[0]!, []); await settle();
    assert.equal(vm.initializationState, "ready");
    assert.equal(gets.length, 1);
    assert.equal(vm.draftSessions.length, 0, "ready与外部watch派发之间不能提前回退");
    assert.equal(vm.targetOpeningSessionId, "target");
    gets[0]!.respond(200, session("target", "ws-a", "subtask")); await settle();
    assert.equal(puts.length, 1);
    assert.equal(vm.targetOpeningSessionId, "target", "GET成功不等于打开终态");
    assert.equal(vm.draftSessions.length, 0);
    confirmTarget(puts[0]!); await settle();
    assert.equal(vm.targetOpeningSessionId, "");
    assert.equal(vm.effectiveActiveKey, "target");
    assert.deepEqual(vm.visibleSessions.map((item: Session) => item.id), ["target"]);
    assert.equal(vm.draftSessions.length, 0);
  } finally { wrapper.unmount(); }
});

for (const failure of ["network", "401", "404", "500", "timeout"] as const) {
  test(`M1回退：空workspace目标GET ${failure}终态只回退一个可见草稿`, async () => {
    const { gets } = zeroVisibleTargetHarness();
    const wrapper = mountView("ws-a", { sessionId: "target", sequence: 1 });
    try {
      await settle(); const vm = wrapper.vm as any;
      assert.equal(vm.draftSessions.length, 0);
      failTargetRead(gets[0]!, failure); await settle();
      assert.equal(vm.initializationState, "ready");
      assert.equal(vm.targetOpeningSessionId, "");
      assert.equal(vm.draftSessions.length, 1);
      assert.equal(vm.visibleSessions.length, 1);
      assert.equal(vm.effectiveActiveKey, vm.draftSessions[0].id);
      assert.equal(FakeXMLHttpRequest.requests.some((request) => request.method === "POST"), false);
    } finally { wrapper.unmount(); }
  });
}

for (const failure of ["network", "401"] as const) {
  test(`M1回退：目标${failure}失败保留已有origin，不额外创建草稿`, async () => {
    const { gets } = zeroVisibleTargetHarness({ origin: true });
    const wrapper = mountView("ws-a", { sessionId: "target", sequence: 1 });
    try {
      await settle(); failTargetRead(gets[0]!, failure); await settle();
      const vm = wrapper.vm as any;
      assert.equal(vm.draftSessions.length, 0);
      assert.equal(vm.effectiveActiveKey, "origin");
      assert.deepEqual(vm.visibleSessions.map((item: Session) => item.id), ["origin"]);
    } finally { wrapper.unmount(); }
  });
}

test("M1回退：GET成功但visibility失败后才回退，不能留下空界面", async () => {
  const { gets, puts } = zeroVisibleTargetHarness();
  const wrapper = mountView("ws-a", { sessionId: "target", sequence: 1 });
  try {
    await settle(); const vm = wrapper.vm as any;
    assert.equal(vm.draftSessions.length, 0);
    gets[0]!.respond(200, session("target", "ws-a", "subtask")); await settle();
    assert.equal(vm.targetOpeningSessionId, "target");
    assert.equal(vm.draftSessions.length, 0);
    puts[0]!.respond(500, { message: "synthetic visibility failure" }); await settle();
    assert.equal(vm.targetOpeningSessionId, "");
    assert.equal(vm.draftSessions.length, 1);
    assert.equal(vm.effectiveActiveKey, vm.draftSessions[0].id);
    assert.equal(vm.visibleSessions.some((item: Session) => item.id === "target"), false);
  } finally { wrapper.unmount(); }
});

test("M1回退：较新外部意图supersede旧GET，旧finally不造草稿，新目标成功不多造", async () => {
  const { gets, puts } = zeroVisibleTargetHarness();
  const wrapper = mountView("ws-a", { sessionId: "old", sequence: 1 });
  try {
    await settle(); const vm = wrapper.vm as any;
    assert.equal(vm.draftSessions.length, 0);
    await wrapper.setProps({ openSessionRequest: { sessionId: "new", sequence: 2 } }); await settle();
    assert.equal(gets.length, 2);
    failTargetRead(gets[0]!, "500"); await settle();
    assert.equal(vm.targetOpeningSessionId, "new");
    assert.equal(vm.draftSessions.length, 0);
    gets[1]!.respond(200, session("new", "ws-a", "subtask")); await settle();
    confirmTarget(puts[0]!, "new"); await settle();
    assert.equal(vm.effectiveActiveKey, "new");
    assert.equal(vm.draftSessions.length, 0);
  } finally { wrapper.unmount(); }
});

test("M1回退：较新GET等待时旧visibility失败造成零可见，不回退；新意图失败才回退", async () => {
  const { gets, puts } = zeroVisibleTargetHarness();
  const wrapper = mountView("ws-a", { sessionId: "old", sequence: 1 });
  try {
    await settle(); const vm = wrapper.vm as any;
    assert.equal(vm.draftSessions.length, 0);
    gets[0]!.respond(200, session("old", "ws-a", "subtask")); await settle();
    await wrapper.setProps({ openSessionRequest: { sessionId: "new", sequence: 2 } }); await settle();
    puts[0]!.respond(500, { message: "old visibility failure" }); await settle();
    assert.equal(vm.visibleSessions.length, 0);
    assert.equal(vm.draftSessions.length, 0, "旧确认终态不能替较新在途意图回退");
    assert.equal(vm.targetOpeningSessionId, "new");
    failTargetRead(gets[1]!, "401"); await settle();
    assert.equal(vm.draftSessions.length, 1);
    assert.equal(vm.effectiveActiveKey, vm.draftSessions[0].id);
  } finally { wrapper.unmount(); }
});

for (const result of ["success", "failure"] as const) {
  test(`M1回退：切workspace后旧GET终态不触发新workspace回退，新意图${result}独立收敛`, async () => {
    const { snapshots, gets, puts } = zeroVisibleTargetHarness();
    const wrapper = mountView("ws-a", { sessionId: "old", sequence: 1 });
    try {
      await settle(); const vm = wrapper.vm as any;
      assert.equal(vm.draftSessions.length, 0);
      await wrapper.setProps({ workspaceId: "ws-b", openSessionRequest: { sessionId: "new", sequence: 2 } });
      await settle(); respondSessions(snapshots[1]!, []); await settle();
      assert.equal(gets.length, 2);
      failTargetRead(gets[0]!, "500"); await settle();
      assert.equal(vm.targetOpeningSessionId, "new");
      assert.equal(vm.draftSessions.length, 0);
      if (result === "success") {
        gets[1]!.respond(200, session("new", "ws-b", "subtask")); await settle();
        confirmTarget(puts[0]!, "new", "ws-b"); await settle();
        assert.equal(vm.effectiveActiveKey, "new");
        assert.equal(vm.draftSessions.length, 0);
      } else {
        failTargetRead(gets[1]!, "500"); await settle();
        assert.equal(vm.draftSessions.length, 1);
        assert.equal(vm.draftSessions[0].workspaceId, "ws-b");
      }
      assert.equal(vm.serverSessions.some((item: Session) => item.workspaceId === "ws-a"), false);
    } finally { wrapper.unmount(); }
  });
}

for (const result of ["success", "failure"] as const) {
  test(`M1回退：reload空snapshot时targetGET仍在途不造草稿，target ${result}终态收敛`, async () => {
    const { snapshots, gets, puts } = zeroVisibleTargetHarness({ origin: true });
    const wrapper = mountView();
    try {
      await settle(); const vm = wrapper.vm as any;
      await wrapper.setProps({ openSessionRequest: { sessionId: "target", sequence: 1 } }); await settle();
      const reload = vm.reloadTabsSnapshot(); respondSessions(snapshots[1]!, []); await reload; await settle();
      assert.equal(vm.initializationState, "ready");
      assert.equal(vm.visibleSessions.length, 0);
      assert.equal(vm.draftSessions.length, 0);
      if (result === "success") {
        gets[0]!.respond(200, session("target", "ws-a", "subtask")); await settle();
        assert.equal(vm.draftSessions.length, 0);
        confirmTarget(puts[0]!); await settle();
        assert.equal(vm.effectiveActiveKey, "target");
        assert.equal(vm.draftSessions.length, 0);
      } else {
        failTargetRead(gets[0]!, "500"); await settle();
        assert.equal(vm.draftSessions.length, 1);
        assert.equal(vm.effectiveActiveKey, vm.draftSessions[0].id);
      }
    } finally { wrapper.unmount(); }
  });
}

test("M1回退：终止当前打开意图后统一收敛一个草稿，迟到旧GET不再回退", async () => {
  const { gets } = zeroVisibleTargetHarness();
  const wrapper = mountView("ws-a", { sessionId: "target", sequence: 1 });
  try {
    await settle(); const vm = wrapper.vm as any;
    assert.equal(vm.draftSessions.length, 0);
    vm.invalidateOpenParentIntent(); await settle();
    assert.equal(vm.draftSessions.length, 1);
    const draft = vm.draftSessions[0].id;
    failTargetRead(gets[0]!, "500"); await settle();
    assert.equal(vm.draftSessions.length, 1);
    assert.equal(vm.effectiveActiveKey, draft);
  } finally { wrapper.unmount(); }
});


test("M1回退：KeepAlive在GET及visibility待确认期间激活不造草稿，确认失败后仅一个", async () => {
  const { gets, puts } = zeroVisibleTargetHarness();
  const { wrapper, setActive } = mountKeepAliveView("ws-a", { sessionId: "target", sequence: 1 });
  try {
    await settle(); const vm = wrapper.findComponent(AgentToolView).vm as any;
    assert.equal(vm.draftSessions.length, 0);
    setActive(false); await settle(); setActive(true); await settle();
    assert.equal(vm.draftSessions.length, 0);
    assert.equal(gets.length, 1, "KeepAlive不重新初始化或补发metadata");
    gets[0]!.respond(200, session("target", "ws-a", "subtask")); await settle();
    assert.equal(vm.targetOpeningSessionId, "target");
    setActive(false); await settle(); setActive(true); await settle();
    assert.equal(vm.targetOpeningSessionId, "target");
    assert.equal(vm.draftSessions.length, 0);
    puts[0]!.respond(500, { message: "synthetic confirmation failure" }); await settle();
    assert.equal(vm.draftSessions.length, 1);
    const draft = vm.draftSessions[0].id;
    setActive(false); await settle(); setActive(true); await settle();
    assert.equal(vm.draftSessions.length, 1);
    assert.equal(vm.effectiveActiveKey, draft);
  } finally { wrapper.unmount(); }
});

test("M1回退：visibility UI超时不清真实PUT，迟到失败转为零可见仍会收敛草稿", async (t) => {
  const { gets, puts } = zeroVisibleTargetHarness();
  const wrapper = mountView("ws-a", { sessionId: "target", sequence: 1 });
  try {
    await settle(); const vm = wrapper.vm as any;
    assert.equal(vm.draftSessions.length, 0);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    gets[0]!.respond(200, session("target", "ws-a", "subtask")); await settle();
    assert.equal(puts.length, 1);
    assert.equal(vm.targetOpeningSessionId, "target");
    t.mock.timers.tick(30_000); await settle();
    assert.equal(vm.targetOpeningSessionId, "");
    assert.ok(vm.tabVisibilityController.getState("target").inFlight);
    assert.equal(vm.draftSessions.length, 0, "不确定在途提交仍有效可见，不伪造隐藏或多造草稿");
    puts[0]!.respond(500, { message: "late confirmation failure" }); await settle();
    assert.equal(vm.visibleSessions.some((item: Session) => item.id === "target"), false);
    assert.equal(vm.draftSessions.length, 1);
    assert.equal(vm.effectiveActiveKey, vm.draftSessions[0].id);
  } finally { wrapper.unmount(); t.mock.timers.reset(); }
});


// Final independent audit regressions: use the same real SFC/KeepAlive/request chain.
for (const stage of ["page", "target", "visibility", "failed"] as const) {
  test(`FINAL-H1 KeepAlive deactivation during ${stage} invalidates only the picker interaction`, async () => {
    const pages: FakeXMLHttpRequest[] = [];
    const targets: FakeXMLHttpRequest[] = [];
    const puts: FakeXMLHttpRequest[] = [];
    FakeXMLHttpRequest.requests = [];
    FakeXMLHttpRequest.responder = (request) => {
      if (request.method === "PUT") { puts.push(request); return; }
      if (request.url.includes("scope=continuable")) {
        pages.push(request);
        if (stage !== "page") return respondSessions(request, [metadataRecord("target")]);
        return;
      }
      if (request.url.includes("/agent/sessions/target?")) {
        targets.push(request);
        if (stage === "visibility") request.respond(200, metadataRecord("target"));
        if (stage === "failed") request.respond(500, { message: "current selection failure" });
        return;
      }
      if (isListRead(request)) return respondSessions(request, [], { closedSessionIds: ["target"] });
      respondDefaults(request);
    };
    const warnings: unknown[] = [];
    const oldWarning = message.warning; const oldError = message.error;
    message.warning = ((...args: unknown[]) => { warnings.push(args); }) as typeof message.warning;
    message.error = ((...args: unknown[]) => { warnings.push(args); }) as typeof message.error;
    const { wrapper, setActive } = mountKeepAliveView();
    try {
      await settle(); const vm = wrapper.findComponent(AgentToolView).vm as any;
      const source = vm.draftSessions[0].id;
      const opening = vm.openChooseSessionModal(source);
      if (stage !== "page") await opening;
      const choosing = stage !== "page" ? vm.chooseSession("target") : Promise.resolve();
      await settle();
      if (stage === "failed") assert.ok(vm.failedPickerSelection);
      warnings.length = 0;
      const tabs = FakeXMLHttpRequest.requests.filter((request) => request.url.includes("scope=tabs")).length;
      setActive(false); await settle();
      assert.equal(vm.chooseSessionModalOpen, false);
      assert.equal(vm.chooseSessionSelecting, false);
      assert.equal(vm.failedPickerSelection, null);
      assert.equal(vm.tabVisibilityController.subscriptions.size, 0);
      if (stage === "page") pages[0]!.respond(500, { message: "late page failure" });
      if (stage === "target") targets[0]!.respond(200, metadataRecord("target"));
      if (stage === "visibility") {
        assert.equal(puts.length, 1, "deactivation cannot clear the real in-flight write");
        puts[0]!.respond(200, { workspaceId: "ws-a", sessionId: "target", visible: true });
        await settle();
        assert.equal(puts.length, 2, "same-workspace hidden-source cancellation can compensate on the old queue");
        puts[1]!.respond(500, { message: "late compensation failure" });
      }
      await opening; await choosing; await settle();
      assert.equal(vm.draftSessions.some((item: Session) => item.id === source), true);
      assert.equal(vm.effectiveActiveKey, source);
      assert.equal(warnings.length, 0);
      setActive(true); await settle();
      assert.equal(vm.chooseSessionModalOpen, false);
      assert.equal(vm.effectiveActiveKey, source);
      assert.equal(FakeXMLHttpRequest.requests.filter((request) => request.url.includes("scope=tabs")).length, tabs);
      assert.equal(warnings.length, 0);
      if (stage === "page") {
        const fresh = vm.openChooseSessionModal(source); await settle();
        pages[0]!.respond(200, { scope: "continuable", items: [], nextCursor: null }); await settle();
        assert.equal(vm.chooseSessionLoading, true, "old page/finally cannot release a reactivated request");
        pages[1]!.respond(200, { scope: "continuable", items: [], nextCursor: null }); await fresh;
        assert.equal(vm.chooseSessionLoading, false);
      }
    } finally { wrapper.unmount(); message.warning = oldWarning; message.error = oldError; }
  });
}

for (const terminal of ["confirmed", "failed", "transportTimeout", "uiTimeout", "superseded", "newIntent", "workspace"] as const) {
  test(`FINAL-M1 cancellation compensation owns a bounded receipt: ${terminal}`, async (t) => {
    const puts: FakeXMLHttpRequest[] = [];
    FakeXMLHttpRequest.requests = [];
    FakeXMLHttpRequest.responder = (request) => {
      if (request.method === "PUT") { puts.push(request); return; }
      if (request.url.includes("/agent/sessions/target?")) return request.respond(200, metadataRecord("target"));
      if (isListRead(request)) return respondSessions(request, [], { closedSessionIds: ["target"] });
      respondDefaults(request);
    };
    const notices: unknown[][] = [];
    const oldWarning = message.warning; const oldError = message.error;
    message.warning = ((...args: unknown[]) => { notices.push(args); }) as typeof message.warning;
    message.error = ((...args: unknown[]) => { notices.push(args); }) as typeof message.error;
    const wrapper = mountView();
    try {
      await settle(); const vm = wrapper.vm as any; const source = vm.draftSessions[0].id;
      await vm.openChooseSessionModal(source); notices.length = 0;
      if (terminal === "uiTimeout") t.mock.timers.enable({ apis: ["setTimeout"] });
      const choosing = vm.chooseSession("target"); await settle();
      vm.closeChooseSessionModal(); await choosing; await settle();
      assert.equal(vm.tabVisibilityController.subscriptions.size, 1, "cancelled open receipt is replaced by compensation receipt");
      assert.equal(vm.pickerCompensations.size, 1);
      assert.equal(puts.length, 1, "queued compensation must not create a second write queue");
      assert.equal(vm.tabVisibilityController.getState("target").desired.visible, false);
      if (terminal === "workspace") {
        await wrapper.setProps({ workspaceId: "ws-b" }); await settle();
        puts[0]!.respond(200, { workspaceId: "ws-a", sessionId: "target", visible: true }); await settle();
        assert.equal(puts.length, 1, "old context cannot send its queued compensation");
      } else if (terminal === "uiTimeout") {
        t.mock.timers.tick(30_000); await settle();
        assert.equal(vm.tabVisibilityController.subscriptions.size, 0);
        assert.equal(puts.length, 1);
        assert.ok(vm.tabVisibilityController.getState("target").inFlight);
        puts[0]!.respond(200, { workspaceId: "ws-a", sessionId: "target", visible: true }); await settle();
        puts[1]!.respond(500, { message: "later transport failure" }); await settle();
      } else {
        puts[0]!.respond(200, { workspaceId: "ws-a", sessionId: "target", visible: true }); await settle();
        assert.equal(puts.length, 2);
        assert.deepEqual(JSON.parse(String(puts[1]!.requestBody)), { visible: false });
        if (terminal === "superseded") vm.requestSessionVisibility("target", true);
        if (terminal === "newIntent") vm.onChangeTab(source);
        if (terminal === "transportTimeout") puts[1]!.ontimeout!();
        else puts[1]!.respond(terminal === "confirmed" ? 200 : 500,
          terminal === "confirmed" ? { workspaceId: "ws-a", sessionId: "target", visible: false } : { message: "failed compensation" });
        await settle();
        if (terminal === "superseded") {
          assert.equal(puts.length, 3);
          puts[2]!.respond(200, { workspaceId: "ws-a", sessionId: "target", visible: true }); await settle();
        }
      }
      const uncertain = ["failed", "transportTimeout", "uiTimeout"].includes(terminal);
      assert.equal(notices.length, uncertain ? 1 : 0, JSON.stringify(notices));
      if (uncertain) assert.match(String(notices[0]![0]), /Opening may have been saved; restoring the hidden state is unconfirmed/);
      assert.equal(vm.tabVisibilityController.subscriptions.size, 0);
      assert.equal(vm.pickerCompensations.size, 0);
      if (terminal !== "workspace") {
        assert.equal(vm.draftSessions.some((item: Session) => item.id === source), true);
        assert.equal(vm.effectiveActiveKey, source);
      }
    } finally { wrapper.unmount(); t.mock.timers.reset(); message.warning = oldWarning; message.error = oldError; }
  });
}

test("FINAL-M2 background Fork cache cannot consume the next visible Tab number", async () => {
  FakeXMLHttpRequest.requests = [];
  FakeXMLHttpRequest.responder = (request) => respondDefaults(request);
  const wrapper = mountView();
  try {
    await settle(); const vm = wrapper.vm as any;
    assert.equal(vm.tabNoMap["primary-a"], 1);
    wrapper.findComponent({ name: "AgentClientPane" }).vm.$emit("forked", metadataRecord("background"), false);
    await settle();
    assert.equal(vm.serverSessions.some((item: Session) => item.id === "background"), true);
    assert.equal(vm.visibleSessions.some((item: Session) => item.id === "background"), false);
    assert.equal(vm.tabNoMap.background, undefined);
    await vm.createOneSession(); await settle();
    assert.equal(vm.tabNoMap[vm.draftSessions[0].id], 2);
    assert.equal(vm.tabNoMap["primary-a"], 1);
  } finally { wrapper.unmount(); }
});

for (const cause of ["snapshot", "notFound", "close"] as const) {
  test(`FINAL-M2 ${cause} removes numbering only for non-rendered members and reuses it`, async () => {
    FakeXMLHttpRequest.requests = [];
    FakeXMLHttpRequest.responder = (request) => {
      if (request.url.includes("/agent/sessions/b?")) return request.respond(404, { code: "SESSION_NOT_FOUND", message: "missing" });
      if (isListRead(request)) return respondSessions(request, [{ ...session("a", "ws-a"), updatedAt: 200 }, { ...session("b", "ws-a"), updatedAt: 100 }]);
      respondDefaults(request);
    };
    const wrapper = mountView();
    try {
      await settle(); const vm = wrapper.vm as any;
      const aNumber = vm.tabNoMap.a;
      if (cause === "snapshot") {
        FakeXMLHttpRequest.responder = (request) => isListRead(request)
          ? respondSessions(request, [session("a", "ws-a")], { closedSessionIds: ["b"] }) : respondDefaults(request);
        await vm.reloadTabsSnapshot();
      } else if (cause === "notFound") await vm.openTargetSession("b");
      else vm.closeSessionTab("b");
      await settle();
      assert.equal(vm.tabNoMap.a, aNumber);
      assert.equal(vm.tabNoMap.b, undefined);
      assert.equal(vm.serverSessions.some((item: Session) => item.id === "b"), true, "number release does not prune the metadata cache");
      await vm.createOneSession(); await settle();
      assert.equal(vm.tabNoMap[vm.draftSessions[0].id], 2);
      assert.equal(vm.tabNoMap.a, 1);
    } finally { wrapper.unmount(); }
  });
}
