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
  headMessageId: null;
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

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function respondDefaults(request: FakeXMLHttpRequest, workspaceId = "ws-a") {
  if (request.url.includes("/agent/available")) return request.respond(200, { agents: [] });
  if (request.url.includes("/agent/sessions")) return request.respond(200, [session("primary-a", workspaceId)]);
  if (request.url.includes("/agent-tab-state")) return request.respond(200, tabState(workspaceId));
  return request.respond(200, {});
}

function mountView(workspaceId = "ws-a") {
  const i18n = createI18n({ legacy: false, locale: "en-US", messages: { "en-US": enUS.default, "zh-CN": zhCN.default } });
  return mount(AgentToolView, {
    attachTo: document.body,
    props: { workspaceId, toolId: "agent-tool" },
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
}

function mountKeepAliveView(workspaceId = "ws-a") {
  const active = ref(true);
  const i18n = createI18n({ legacy: false, locale: "en-US", messages: { "en-US": enUS.default, "zh-CN": zhCN.default } });
  const wrapper = mount({
    setup: () => () => h(KeepAlive, null, {
      default: () => active.value ? h(AgentToolView, { workspaceId, toolId: "agent-tool" }) : null
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

test("AgentToolView：两个关键读取完成前保持 loading，后端快照决定可见 Tab", async () => {
  let sessionsRequest: FakeXMLHttpRequest | undefined;
  let tabStateRequest: FakeXMLHttpRequest | undefined;
  FakeXMLHttpRequest.requests = [];
  FakeXMLHttpRequest.responder = (request) => {
    if (request.url.includes("/agent/available")) return request.respond(200, { agents: [] });
    if (request.url.includes("/agent/sessions")) { sessionsRequest = request; return; }
    if (request.url.includes("/agent-tab-state")) { tabStateRequest = request; return; }
  };
  const wrapper = mountView();
  try {
    assert.equal(wrapper.find("[data-testid='agent-tab-state-loading']").exists(), true);
    assert.equal(wrapper.find("[data-testid='agent-session-empty']").exists(), false);
    assert.equal(wrapper.find("[data-testid='agent-tabs']").exists(), false);
    sessionsRequest!.respond(200, [session("primary-a", "ws-a"), session("subtask-a", "ws-a", "subtask")]);
    await settle();
    assert.equal(wrapper.find("[data-testid='agent-tab-state-loading']").exists(), true);
    tabStateRequest!.respond(200, tabState("ws-a", { closedSessionIds: ["primary-a"], openedSubtaskSessionIds: ["subtask-a"] }));
    await settle();
    assert.equal(wrapper.find("[data-testid='agent-tab-state-loading']").exists(), false);
    assert.equal((wrapper.vm as any).visibleSessions.map((item: Session) => item.id).join(","), "subtask-a");
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
    if (request.url.includes("/agent/sessions")) return request.respond(200, [session("primary-a", "ws-a")]);
    if (request.method === "POST") creates += 1;
    if (request.url.includes("/agent-tab-state")) {
      return request.respond(fail ? 500 : 200, fail ? { message: "failed" } : tabState("ws-a"));
    }
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

test("AgentToolView：Agent options 失败不阻止关键双读进入 ready", async () => {
  FakeXMLHttpRequest.requests = [];
  FakeXMLHttpRequest.responder = (request) => {
    if (request.url.includes("/agent/available")) return request.respond(500, { message: "agents unavailable" });
    if (request.url.includes("/agent/sessions")) return request.respond(200, [session("primary-a", "ws-a")]);
    if (request.url.includes("/agent-tab-state")) return request.respond(200, tabState("ws-a"));
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
  let tabStateGets = 0;
  FakeXMLHttpRequest.requests = [];
  FakeXMLHttpRequest.responder = (request) => {
    if (request.url.includes("/agent/available")) return request.respond(200, { agents: [] });
    if (request.url.includes("/agent/sessions")) {
      sessionGets += 1;
      return request.respond(200, [session("primary-a", "ws-a")]);
    }
    if (request.url.includes("/agent-tab-state")) {
      tabStateGets += 1;
      return request.respond(200, tabState("ws-a"));
    }
    return request.respond(200, {});
  };
  const { wrapper, setActive } = mountKeepAliveView();
  try {
    await settle();
    const sessionGetsBeforeReactivation = sessionGets;
    const tabStateGetsBeforeReactivation = tabStateGets;
    setActive(false);
    await settle();
    setActive(true);
    await settle();
    assert.equal(sessionGets, sessionGetsBeforeReactivation);
    assert.equal(tabStateGets, tabStateGetsBeforeReactivation);
  } finally {
    wrapper.unmount();
  }
});

test("AgentToolView：error 状态的 KeepAlive 激活会重试关键双读并恢复", async () => {
  let fail = true;
  let sessionGets = 0;
  let tabStateGets = 0;
  FakeXMLHttpRequest.requests = [];
  FakeXMLHttpRequest.responder = (request) => {
    if (request.url.includes("/agent/available")) return request.respond(200, { agents: [] });
    if (request.url.includes("/agent/sessions")) {
      sessionGets += 1;
      return request.respond(200, [session("primary-a", "ws-a")]);
    }
    if (request.url.includes("/agent-tab-state")) {
      tabStateGets += 1;
      return request.respond(fail ? 500 : 200, fail ? { message: "tab state unavailable" } : tabState("ws-a"));
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
    const tabStateGetsBeforeReactivation = tabStateGets;
    setActive(true);
    await settle();
    assert.ok(sessionGets > sessionGetsBeforeReactivation);
    assert.ok(tabStateGets > tabStateGetsBeforeReactivation);
    assert.equal(wrapper.find("[data-testid='agent-tab-state-error']").exists(), false);
    assert.equal(wrapper.find("[data-testid='agent-tabs']").exists(), true);
  } finally {
    wrapper.unmount();
  }
});

test("AgentToolView：非 active Tab 的 PUT 404 只回滚自身，不重启初始化或抢焦点", async () => {
  let sessionGets = 0;
  let tabStateGets = 0;
  const originalError = message.error;
  let errors = 0;
  message.error = (() => { errors += 1; }) as typeof message.error;
  FakeXMLHttpRequest.requests = [];
  FakeXMLHttpRequest.responder = (request) => {
    if (request.url.includes("/agent/available")) return request.respond(200, { agents: [] });
    if (request.method === "PUT" && request.url.includes("/agent-tab-state")) {
      return request.respond(404, { code: "AGENT_SESSION_NOT_FOUND_IN_WORKSPACE", message: "not found" });
    }
    if (request.url.includes("/agent/sessions")) {
      sessionGets += 1;
      return request.respond(200, [session("primary-a", "ws-a"), session("primary-b", "ws-a")]);
    }
    if (request.url.includes("/agent-tab-state")) {
      tabStateGets += 1;
      return request.respond(200, tabState("ws-a"));
    }
    return request.respond(200, {});
  };
  const wrapper = mountView();
  try {
    await settle();
    const sessionGetsBeforeMutation = sessionGets;
    const tabStateGetsBeforeMutation = tabStateGets;
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
    assert.equal(tabStateGets, tabStateGetsBeforeMutation);
    assert.ok(errors >= 1);
  } finally {
    wrapper.unmount();
    message.error = originalError;
  }
});

test("AgentToolView：打开子任务先乐观显示，再通过 PUT 持久化", async () => {
  FakeXMLHttpRequest.requests = [];
  FakeXMLHttpRequest.responder = (request) => {
    if (request.url.includes("/agent/available")) return request.respond(200, { agents: [] });
    if (request.url.includes("/agent/sessions")) return request.respond(200, [session("primary-a", "ws-a"), session("subtask-a", "ws-a", "subtask")]);
    if (request.method === "PUT" && request.url.includes("subtask-a")) return request.respond(200, { workspaceId: "ws-a", sessionId: "subtask-a", visible: true });
    if (request.url.includes("/agent-tab-state")) return request.respond(200, tabState("ws-a"));
    return request.respond(200, {});
  };
  const wrapper = mountView();
  try {
    await settle();
    const opening = (wrapper.vm as any).onOpenSubtask("subtask-a");
    assert.equal((wrapper.vm as any).visibleSessions.some((item: Session) => item.id === "subtask-a"), true);
    await opening;
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
    if (request.url.includes("/agent/sessions")) return request.respond(200, []);
    if (request.url.includes("/agent-tab-state")) return request.respond(200, tabState("ws-a"));
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
    if (request.url.includes("ws-a") && request.url.includes("/agent/sessions")) return request.respond(200, [session("primary-a", "ws-a")]);
    if (request.url.includes("ws-a") && request.url.includes("/agent-tab-state")) return request.respond(200, tabState("ws-a"));
    if (request.url.includes("ws-b") && request.url.includes("/agent/sessions")) return request.respond(200, [session("primary-b", "ws-b")]);
    if (request.url.includes("ws-b") && request.url.includes("/agent-tab-state")) return request.respond(200, tabState("ws-b"));
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
    if (request.url.includes("ws-a") && request.url.includes("/agent/sessions")) return request.respond(200, [session("primary-a", "ws-a")]);
    if (request.url.includes("ws-a") && request.url.includes("/agent-tab-state")) return request.respond(200, tabState("ws-a"));
    if (request.url.includes("ws-b") && request.url.includes("/agent/sessions")) return request.respond(200, [session("primary-b", "ws-b")]);
    if (request.url.includes("ws-b") && request.url.includes("/agent-tab-state")) return request.respond(200, tabState("ws-b"));
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
    if (request.url.includes("/agent/sessions")) return request.respond(200, [session("primary-a", "ws-a")]);
    if (request.url.includes("/agent-tab-state")) return request.respond(200, tabState("ws-a"));
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
    if (request.url.includes("/agent/sessions")) return request.respond(200, [session("primary-a", "ws-a"), session("primary-b", "ws-a")]);
    if (request.method === "PUT" && request.url.includes("/agent-tab-state")) return request.respond(500, { message: "write failed" });
    if (request.url.includes("/agent-tab-state")) return request.respond(200, tabState("ws-a"));
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

test("AgentToolView：Workspace 切换后丢弃旧初始化响应，普通刷新不覆盖 pending 可见性", async () => {
  const pendingA: FakeXMLHttpRequest[] = [];
  FakeXMLHttpRequest.requests = [];
  FakeXMLHttpRequest.responder = (request) => {
    if (request.url.includes("/agent/available")) return request.respond(200, { agents: [] });
    if (request.url.includes("ws-a") && (request.url.includes("/agent/sessions") || request.url.includes("/agent-tab-state"))) {
      pendingA.push(request);
      return;
    }
    if (request.method === "PUT" && request.url.includes("/agent-tab-state")) return;
    if (request.url.includes("ws-b") && request.url.includes("/agent/sessions")) return request.respond(200, [session("primary-b", "ws-b")]);
    if (request.url.includes("ws-b") && request.url.includes("/agent-tab-state")) return request.respond(200, tabState("ws-b"));
    if (request.url.includes("/agent/sessions")) return request.respond(200, [session("primary-b", "ws-b")]);
    if (request.url.includes("/agent-tab-state")) return request.respond(200, tabState("ws-b"));
    return request.respond(200, {});
  };
  const wrapper = mountView("ws-a");
  try {
    await wrapper.setProps({ workspaceId: "ws-b" });
    for (const request of pendingA) {
      if (request.url.includes("/agent/sessions")) request.respond(200, [session("primary-a", "ws-a")]);
      else request.respond(200, tabState("ws-a"));
    }
    await settle();
    assert.equal((wrapper.vm as any).visibleSessions.map((item: Session) => item.id).join(","), "primary-b");

    const vm = wrapper.vm as any;
    vm.closeSessionTab("primary-b");
    await vm.refreshSessions();
    assert.equal(vm.visibleSessions.some((item: Session) => item.id === "primary-b"), false);
  } finally {
    wrapper.unmount();
  }
});
