import assert from "node:assert/strict";
import test, { after, type TestContext } from "node:test";
import { mount, flushPromises } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { nextTick, shallowRef } from "vue";
import { Button, Popconfirm, Tabs, Tooltip, message } from "ant-design-vue";
import type { AxiosResponse } from "axios";
import type { TerminalRecord } from "@agent-workbench/shared";
import { apiClient } from "@/shared/api";
import zhCN from "@/shared/i18n/locales/zh-CN";

// TerminalView is stubbed, but its xterm dependency expects self during import.
const originalSelf = Object.getOwnPropertyDescriptor(globalThis, "self");
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "self", { configurable: true, writable: true, value: window });
Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: window.localStorage });
after(() => {
  if (originalSelf) Object.defineProperty(globalThis, "self", originalSelf);
  else Reflect.deleteProperty(globalThis, "self");
  if (originalLocalStorage) Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});
const { default: TerminalTabs } = await import("./TerminalTabs.vue");

async function settle() {
  await nextTick();
  await flushPromises();
  await new Promise((resolve) => setTimeout(resolve, 25));
  await nextTick();
}

function terminal(id: string, workspaceId = "ws"): TerminalRecord {
  return { id, workspaceId, sessionName: `${id}-session`, status: "active", createdAt: 1, updatedAt: 1 };
}

function fixture(t: TestContext) {
  localStorage.clear();
  const previousAdapter = apiClient.defaults.adapter;
  const requests: { url: string; resolve: () => void; reject: () => void }[] = [];
  const errors: unknown[] = [];
  t.mock.method(message, "error", (error: unknown) => { errors.push(error); });
  apiClient.defaults.adapter = (config) => new Promise<AxiosResponse>((resolve, reject) => {
    requests.push({
      url: config.url ?? "",
      resolve: () => resolve({ data: {}, status: 200, statusText: "OK", headers: {}, config }),
      reject: () => reject(new Error("close failed"))
    });
  });
  const wrapper = mount(TerminalTabs, {
    attachTo: document.body,
    props: { workspaceId: "ws", terminals: [terminal("first"), terminal("second")] },
    global: {
      plugins: [createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } })],
      components: { "a-button": Button, "a-popconfirm": Popconfirm, "a-tabs": Tabs, "a-tab-pane": Tabs.TabPane, "a-tooltip": Tooltip },
      stubs: { TerminalView: { props: ["terminal", "active"], template: '<div :data-terminal="terminal.id" :data-active="active" />' } }
    }
  });
  t.after(async () => {
    wrapper.unmount();
    apiClient.defaults.adapter = previousAdapter;
    await settle();
  });
  const confirmations = () => wrapper.findAllComponents(Popconfirm);
  const openIds = () => confirmations().flatMap((confirmation, index) => confirmation.props("open") ? [index] : []);
  async function open(index = 0) {
    await wrapper.findAll("button.terminal-tab-close")[index].trigger("mousedown");
    await wrapper.findAll("button.terminal-tab-close")[index].trigger("click");
    await settle();
  }
  async function clickOutside() {
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    // Ant Design Vue delays outside-click dismissal by 100 ms.
    await new Promise((resolve) => setTimeout(resolve, 125));
    await settle();
  }
  function popup() {
    const index = openIds()[0];
    assert.notEqual(index, undefined, "a confirmation must be open");
    const node = visiblePopups()[0];
    assert.ok(node, "real Popconfirm must render its popup");
    return node;
  }
  function ok() { return popup().querySelector<HTMLButtonElement>(".ant-popconfirm-buttons .ant-btn-dangerous")!; }
  function cancel() { return popup().querySelector<HTMLButtonElement>(".ant-popconfirm-buttons button:not(.ant-btn-dangerous)")!; }
  return { wrapper, requests, errors, confirmations, openIds, open, clickOutside, popup, ok, cancel };
}

function visiblePopups() {
  return Array.from(document.querySelectorAll<HTMLElement>(".ant-popconfirm")).filter(
    (element) => !element.classList.contains("ant-popover-hidden") && element.style.display !== "none"
  );
}

async function overflowFixture(t: TestContext) {
  const f = fixture(t);
  await settle();
  const operation = f.wrapper.findComponent({ name: "OperationNode" });
  const tab = f.wrapper.findAllComponents({ name: "TabNode" })[1].props("tab");
  // happy-dom has no layout. Supply the hiddenTabs input from a real TabNode,
  // retaining the real Tabs, OperationNode, Menu and Popconfirm render paths.
  const hiddenTabs = shallowRef([tab]);
  Object.defineProperty(operation.vm.$.props, "tabs", {
    configurable: true, get: () => hiddenTabs.value, set: () => {}
  });
  operation.vm.$forceUpdate();
  await settle();
  await operation.get("button.ant-tabs-nav-more").trigger("keydown", { which: 40, keyCode: 40, key: "ArrowDown" });
  await settle();
  const menuClose = document.querySelector<HTMLButtonElement>(".ant-tabs-dropdown button.terminal-tab-close");
  assert.ok(menuClose, "real overflow menu must contain the hidden terminal's close button");
  return { ...f, hiddenTabs, menuClose };
}

test("close uses a nearby Popconfirm without changing the active tab; cancel and outside click do not delete", async (t) => {
  const f = fixture(t);
  await settle();
  await f.open(1);
  assert.deepEqual(f.openIds(), [1]);
  assert.equal(f.wrapper.get('[data-terminal="first"]').attributes("data-active"), "true");
  assert.equal(f.confirmations()[1].props("placement"), "topRight");
  assert.match(f.popup().textContent ?? "", /确认关闭终端？/);
  assert.doesNotMatch(f.popup().textContent ?? "", /将终止对应的 tmux 会话。/);
  assert.equal(f.popup().querySelector(".ant-popconfirm-description"), null);
  f.cancel().click();
  await settle();
  assert.deepEqual(f.openIds(), []);
  assert.equal(f.requests.length, 0);
  await f.open(0);
  await f.open(1);
  assert.deepEqual(f.openIds(), [1], "only one confirmation may be open");
  await f.clickOutside();
  assert.deepEqual(f.openIds(), []);
  assert.equal(f.requests.length, 0);
});

test("successful close has loading and duplicate protection, then emits deleted without removing tabs optimistically", async (t) => {
  const f = fixture(t);
  await f.open();
  f.ok().click();
  f.ok().click();
  await settle();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, "/terminals/first");
  assert.equal(f.ok().classList.contains("ant-btn-loading"), true);
  assert.equal(f.cancel().disabled, true);
  await f.clickOutside();
  await f.open(1);
  assert.deepEqual(f.openIds(), [0], "pending close cannot be dismissed or replaced");
  assert.equal(f.wrapper.findAll("button.terminal-tab-close").length, 2);
  assert.equal(f.wrapper.emitted("deleted"), undefined);
  f.requests[0].resolve();
  await settle();
  assert.deepEqual(f.openIds(), []);
  assert.equal(f.wrapper.emitted("deleted")?.length, 1);
  assert.equal(f.wrapper.findAll("button.terminal-tab-close").length, 2, "parent refresh remains authoritative");
});

test("failed close keeps the real Popconfirm open and permits retry without an unhandled rejection", async (t) => {
  const f = fixture(t);
  await f.open();
  f.ok().click();
  await settle();
  f.requests[0].reject();
  await settle();
  assert.deepEqual(f.openIds(), [0]);
  assert.equal(f.errors.length, 1);
  assert.equal(f.ok().classList.contains("ant-btn-loading"), false);
  assert.equal(f.cancel().disabled, false);
  assert.equal(f.wrapper.emitted("deleted"), undefined);
  f.ok().click();
  await settle();
  assert.equal(f.requests.length, 2);
  f.requests[1].resolve();
  await settle();
  assert.deepEqual(f.openIds(), []);
  assert.equal(f.wrapper.emitted("deleted")?.length, 1);
});

test("workspace changes clear confirmation and stale success cannot dismiss or refresh a new target", async (t) => {
  const f = fixture(t);
  await f.open();
  f.ok().click();
  await settle();
  await f.wrapper.setProps({ workspaceId: "other", terminals: [terminal("third", "other")] });
  await settle();
  assert.deepEqual(f.openIds(), []);
  await f.open();
  f.requests[0].resolve();
  await settle();
  assert.deepEqual(f.openIds(), [0]);
  assert.equal(f.wrapper.emitted("deleted"), undefined);
});

test("target disappearance clears confirmation and stale failure does not affect a newly opened target", async (t) => {
  const f = fixture(t);
  await f.open();
  f.ok().click();
  await settle();
  await f.wrapper.setProps({ terminals: [terminal("second")] });
  await settle();
  assert.deepEqual(f.openIds(), []);
  await f.open();
  f.requests[0].reject();
  await settle();
  assert.deepEqual(f.openIds(), [0]);
  assert.equal(f.errors.length, 0);
  assert.equal(f.ok().classList.contains("ant-btn-loading"), false);
});

test("keyboard events on the accessible close trigger do not activate a different tab", async (t) => {
  const f = fixture(t);
  await settle();
  const close = f.wrapper.findAll("button.terminal-tab-close")[1];
  assert.equal(close.attributes("aria-label"), "关闭终端");
  await close.trigger("keydown", { key: "Enter", code: "Enter", keyCode: 13 });
  assert.equal(f.wrapper.get('[data-terminal="first"]').attributes("data-active"), "true");
  await close.trigger("click");
  await settle();
  assert.deepEqual(f.openIds(), [1]);
});

test("overflow and ordinary tab entries own separate confirmation instances while sharing delete state", async (t) => {
  const f = await overflowFixture(t);
  assert.equal(f.confirmations().length, 3, "one terminal is rendered in both the tab bar and overflow menu");
  f.menuClose.click();
  await settle();
  assert.equal(f.openIds().length, 1);
  assert.equal(visiblePopups().length, 1);
  assert.equal(f.confirmations()[1].props("open"), false, "clipped ordinary tab must not open its popup");
  f.cancel().click();
  await settle();
  assert.deepEqual(f.openIds(), []);
  assert.equal(visiblePopups().length, 0);
  assert.equal(f.requests.length, 0);

  await f.open(1);
  assert.deepEqual(f.openIds(), [1], "previously mounted menu must not mirror the ordinary tab popup");
  assert.equal(visiblePopups().length, 1);
  f.cancel().click();
  await settle();

  f.menuClose.click();
  await settle();
  f.ok().click();
  f.ok().click();
  await settle();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, "/terminals/second");
  assert.equal(f.ok().classList.contains("ant-btn-loading"), true);
  assert.equal(f.cancel().disabled, true);
  await f.open(1);
  await f.clickOutside();
  assert.equal(f.openIds().length, 1);
  assert.equal(visiblePopups().length, 1);
  assert.equal(f.confirmations()[1].props("open"), false);
  f.requests[0].reject();
  await settle();
  assert.equal(f.openIds().length, 1);
  assert.equal(visiblePopups().length, 1);
  assert.equal(f.errors.length, 1);
  assert.equal(f.ok().classList.contains("ant-btn-loading"), false);
  f.ok().click();
  await settle();
  f.requests[1].resolve();
  await settle();
  assert.equal(visiblePopups().length, 0);
  assert.equal(f.wrapper.emitted("deleted")?.length, 1);
});

test("removing an overflow entry clears its confirmation rather than transferring it to the ordinary tab", async (t) => {
  const f = await overflowFixture(t);
  f.menuClose.click();
  await settle();
  f.hiddenTabs.value = [];
  await settle();
  assert.deepEqual(f.openIds(), []);
  assert.equal(visiblePopups().length, 0);
  assert.equal(f.requests.length, 0);
  await f.open(1);
  assert.deepEqual(f.openIds(), [1]);
  assert.equal(visiblePopups().length, 1);
});

test("removing a pending close entry hides its popup but keeps duplicate protection and refresh on success", async (t) => {
  const f = await overflowFixture(t);
  f.menuClose.click();
  await settle();
  f.ok().click();
  await settle();
  f.hiddenTabs.value = [];
  await settle();
  assert.deepEqual(f.openIds(), []);
  assert.equal(visiblePopups().length, 0);
  await f.open(1);
  assert.deepEqual(f.openIds(), []);
  assert.equal(f.requests.length, 1);
  f.requests[0].resolve();
  await settle();
  assert.deepEqual(f.openIds(), []);
  assert.equal(visiblePopups().length, 0);
  assert.equal(f.wrapper.emitted("deleted")?.length, 1);
});
