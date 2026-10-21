import assert from "node:assert/strict";
import test, { after, type TestContext } from "node:test";
import { mount, flushPromises } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { nextTick } from "vue";
import { apiClient } from "@/shared/api";
import type { TerminalRecord } from "@agent-workbench/shared";
import type { AxiosResponse } from "axios";
import { message } from "ant-design-vue";
import { workspaceHostKey } from "@/features/workspace/host";
import zhCN from "@/shared/i18n/locales/zh-CN";

// xterm is never mounted here, but its UMD dependency requires self on import.
const originalSelf = Object.getOwnPropertyDescriptor(globalThis, "self");
Object.defineProperty(globalThis, "self", { configurable: true, writable: true, value: window });
after(() => { if (originalSelf) Object.defineProperty(globalThis, "self", originalSelf); else Reflect.deleteProperty(globalThis, "self"); });
const { default: TerminalToolView } = await import("./TerminalToolView.vue");
async function settle() { await nextTick(); await flushPromises(); await nextTick(); }

test("configuration pane preserves terminal mounts and activates created terminals via the existing flow", async () => {
  const previous = apiClient.defaults.adapter;
  const first = { id: "first", workspaceId: "ws", sessionName: "first-session", status: "active", createdAt: 1, updatedAt: 1 };
  const second = { ...first, id: "second", sessionName: "second-session" };
  const terminals = [first];
  let terminalMounts = 0;
  apiClient.defaults.adapter = async (config) => ({ data: terminals.slice(), status: 200, statusText: "OK", headers: {}, config });
  const wrapper = mount(TerminalToolView, {
    attachTo: document.body,
    props: { workspaceId: "ws", toolId: "terminal" },
    global: {
      plugins: [createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } })],
      provide: { [workspaceHostKey as symbol]: { minimizeTool() {} } },
      stubs: {
        "a-tooltip": { template: "<span><slot /></span>" },
        "a-button": { emits: ["click"], template: '<button @click="$emit(\'click\')"><slot /><slot name="icon" /></button>' },
        "a-tabs": { props: ["activeKey"], template: '<div><slot name="rightExtra" /><slot /></div>' },
        "a-tab-pane": { template: '<div><slot name="tab" /><slot /></div>' },
        TerminalView: { name: "TestTerminal", props: ["terminal", "active"], mounted() { terminalMounts++; }, template: '<div :data-terminal="terminal.id" :data-active="active" />' },
        TerminalConfigPanel: { name: "TestConfigs", props: ["workspaceId"], emits: ["created", "close"], template: '<aside data-configs />' }
      }
    }
  });
  try {
    await settle();
    assert.equal(terminalMounts, 1);
    assert.equal(wrapper.get('[aria-label="配置"]').text(), "");
    await wrapper.get('[aria-label="配置"]').trigger("click"); await settle();
    assert.equal(wrapper.find('[aria-label="配置"]').exists(), false);
    const panel = wrapper.findComponent({ name: "TestConfigs" });
    panel.vm.$emit("close"); await settle();
    assert.equal(wrapper.get("[data-configs]").isVisible(), false);
    assert.equal(terminalMounts, 1);
    // A request can complete while its pane is hidden. The new terminal must
    // still be refreshed and selected, without reconnecting the existing one.
    terminals.push(second); panel.vm.$emit("created", second); await settle();
    assert.equal(wrapper.get('[data-terminal="second"]').attributes("data-active"), "true");
    assert.equal(wrapper.get('[data-terminal="first"]').attributes("data-active"), "false");
    assert.equal(terminalMounts, 2);
    await wrapper.get('[aria-label="配置"]').trigger("click"); await settle();
    assert.equal(terminalMounts, 2);
    assert.equal(wrapper.findComponent({ name: "TestConfigs" }).vm, panel.vm);
  } finally { wrapper.unmount(); apiClient.defaults.adapter = previous; }
});


type PendingResponse<T> = { workspaceId: string; resolve: (data: T) => void; reject: (error: Error) => void };
function terminal(workspaceId: string, id: string): TerminalRecord {
  return { id, workspaceId, sessionName: `session-${id}`, status: "active", createdAt: 1, updatedAt: 1 };
}
function responseFixture(t: TestContext, realConfigs = false) {
  const previous = apiClient.defaults.adapter;
  const lists: PendingResponse<TerminalRecord[]>[] = [], creates: PendingResponse<TerminalRecord>[] = [];
  let minimized = 0, runs = 0;
  apiClient.defaults.adapter = async (config) => {
    const url = String(config.url);
    const response = (data: unknown): AxiosResponse => ({ data, status: 200, statusText: "OK", headers: {}, config });
    if (url === "/workspaces/A/terminal-configs") return response([{ id: "config", workspaceId: "A", name: "开发服务", cwd: ".", command: "fixture", createdAt: 1, updatedAt: 1 }]);
    if (url === "/workspaces/A") return response({ repos: [] });
    if (url === "/workspaces/A/terminal-configs/config/run") { runs++; return response(terminal("A", "a-run")); }
    const workspaceId = String(config.url).match(/^\/workspaces\/([^/]+)\/terminals$/)?.[1];
    if (!workspaceId) throw new Error("Unexpected fixture request");
    return new Promise<AxiosResponse>((resolve, reject) => {
      if (config.method === "post") creates.push({ workspaceId, resolve: (data) => resolve(response(data)), reject });
      else lists.push({ workspaceId, resolve: (data) => resolve(response(data)), reject });
    });
  };
  const wrapper = mount(TerminalToolView, {
    attachTo: document.body,
    props: { workspaceId: "A", toolId: "terminal" },
    global: {
      plugins: [createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } })],
      provide: { [workspaceHostKey as symbol]: { minimizeTool() { minimized++; } } },
      stubs: {
        "a-tooltip": { template: "<span><slot /></span>" },
        "a-button": { emits: ["click"], template: '<button @click="$emit(\'click\')"><slot /><slot name="icon" /></button>' },
        "a-tabs": { props: ["activeKey"], template: '<div><slot name="rightExtra" /><slot /></div>' },
        "a-tab-pane": { template: '<div><slot name="tab" /><slot /></div>' },
        TerminalView: { name: "TestTerminal", props: ["terminal", "active"], emits: ["exited", "invalidated"], template: '<div :data-terminal="terminal.id" :data-workspace="terminal.workspaceId" :data-active="active" />' },
        ...(realConfigs ? {} : { TerminalConfigPanel: { name: "TestConfigs", props: ["workspaceId", "active"], emits: ["created", "close"], template: '<aside data-configs />' } }),
        "a-spin": { template: "<span />" },
        "a-alert": { props: ["message"], template: "<p>{{message}}</p>" },
        "a-dropdown": { template: "<span><slot /></span>" },
        "a-drawer": { props: ["open"], template: '<section v-if="open"><slot /></section>' },
        "a-menu": true, "a-menu-item": true, "a-form": true, "a-form-item": true,
        "a-input": true, "a-auto-complete": true, "a-textarea": true
      }
    }
  });
  let unmounted = false;
  function unmount() { if (!unmounted) { wrapper.unmount(); unmounted = true; } }
  t.after(() => { unmount(); apiClient.defaults.adapter = previous; });
  async function created(record: TerminalRecord) {
    if (!wrapper.findComponent({ name: "TestConfigs" }).exists()) {
      await wrapper.get('[aria-label="配置"]').trigger("click");
    }
    wrapper.findComponent({ name: "TestConfigs" }).vm.$emit("created", record);
    await settle();
  }
  return { wrapper, lists, creates, created, unmount, minimized: () => minimized, runs: () => runs };
}

test("a configuration-run refresh from A cannot overwrite B or activate A after switching Workspace", async (t) => {
  const f = responseFixture(t, true); await settle();
  f.lists[0]!.resolve([terminal("A", "a-first")]); await settle();
  await f.wrapper.get('[aria-label="配置"]').trigger("click"); await settle();
  await f.wrapper.get('[aria-label="运行"]').trigger("click"); await settle();
  assert.equal(f.runs(), 1);
  assert.equal(f.lists[1]!.workspaceId, "A");
  await f.wrapper.setProps({ workspaceId: "B" }); await settle();
  f.lists[2]!.resolve([terminal("B", "b-first")]); await settle();
  f.lists[1]!.resolve([terminal("A", "a-first"), terminal("A", "a-run")]); await settle();
  assert.equal(f.wrapper.findAll("[data-terminal]").length, 1);
  assert.equal(f.wrapper.get('[data-terminal="b-first"]').attributes("data-active"), "true");
  assert.equal(f.wrapper.find('[data-workspace="A"]').exists(), false);
  assert.equal(f.creates.length, 0);
});

test("same-Workspace refreshes accept only the latest response and preserve pending terminal activation", async (t) => {
  const f = responseFixture(t); await settle();
  const first = terminal("A", "first"), one = terminal("A", "run-one"), two = terminal("A", "run-two");
  f.lists[0]!.resolve([first]); await settle();
  await f.created(one); await f.created(two);
  f.lists[2]!.resolve([first, one, two]); await settle();
  f.lists[1]!.resolve([first, one]); await settle();
  assert.equal(f.wrapper.findAll("[data-terminal]").length, 3);
  assert.equal(f.wrapper.get('[data-terminal="run-two"]').attributes("data-active"), "true");
  assert.equal(f.wrapper.get('[data-terminal="run-one"]').attributes("data-active"), "false");
});

test("an old initialization response cannot auto-create in another Workspace; the current empty Workspace still auto-creates", async (t) => {
  const f = responseFixture(t); await settle();
  await f.wrapper.setProps({ workspaceId: "B" }); await settle();
  f.lists[0]!.resolve([]); await settle();
  assert.equal(f.creates.length, 0);
  f.lists[1]!.resolve([]); await settle();
  assert.deepEqual(f.creates.map((request) => request.workspaceId), ["B"]);
  const record = terminal("B", "b-auto"); f.creates[0]!.resolve(record); await settle();
  assert.equal(f.lists[2]!.workspaceId, "B");
  f.lists[2]!.resolve([record]); await settle();
  assert.equal(f.wrapper.get('[data-terminal="b-auto"]').attributes("data-active"), "true");
});

test("an old auto-create completion neither refreshes its successor nor releases the successor's create guard", async (t) => {
  const f = responseFixture(t); await settle();
  f.lists[0]!.resolve([]); await settle();
  assert.equal(f.creates[0]!.workspaceId, "A");
  await f.wrapper.setProps({ workspaceId: "B" }); await settle();
  f.lists[1]!.resolve([]); await settle();
  assert.deepEqual(f.creates.map((request) => request.workspaceId), ["A", "B"]);
  f.creates[0]!.resolve(terminal("A", "a-auto")); await settle();
  assert.equal(f.lists.length, 2);
  f.wrapper.findComponent({ name: "TerminalTabs" }).vm.$emit("terminalInvalidated", "missing"); await settle();
  f.lists[2]!.resolve([]); await settle();
  assert.equal(f.creates.length, 2);
  const record = terminal("B", "b-auto"); f.creates[1]!.resolve(record); await settle();
  assert.equal(f.lists.length, 4); assert.equal(f.lists[3]!.workspaceId, "B");
  f.lists[3]!.resolve([record]); await settle();
  assert.equal(f.wrapper.get('[data-terminal="b-auto"]').attributes("data-active"), "true");
});

test("returning to the same Workspace does not revive an earlier visit's initialization", async (t) => {
  const f = responseFixture(t); await settle();
  await f.wrapper.setProps({ workspaceId: "B" }); await settle();
  await f.wrapper.setProps({ workspaceId: "A" }); await settle();
  f.lists[2]!.resolve([terminal("A", "current-a")]); await settle();
  f.lists[0]!.resolve([]); f.lists[1]!.resolve([]); await settle();
  assert.equal(f.creates.length, 0);
  assert.equal(f.wrapper.get('[data-terminal="current-a"]').attributes("data-active"), "true");
});

test("stale refresh errors are silent and stale close responses cannot minimize the current Workspace", async (t) => {
  const errors: unknown[] = [];
  t.mock.method(message, "error", (error: unknown) => { errors.push(error); });
  const f = responseFixture(t); await settle();
  f.lists[0]!.resolve([terminal("A", "a-first")]); await settle();
  f.wrapper.findComponent({ name: "TerminalTabs" }).vm.$emit("deleted"); await settle();
  await f.created(terminal("A", "a-run"));
  await f.wrapper.setProps({ workspaceId: "B" }); await settle();
  f.lists[3]!.resolve([terminal("B", "b-first")]); await settle();
  f.lists[1]!.resolve([]); f.lists[2]!.reject(new Error("stale fixture failure")); await settle();
  assert.equal(f.minimized(), 0); assert.equal(errors.length, 0);
  assert.equal(f.wrapper.get('[data-terminal="b-first"]').attributes("data-active"), "true");
});

test("unmount discards initialization results and prevents follow-up auto-creation", async (t) => {
  const f = responseFixture(t); await settle();
  f.unmount(); f.lists[0]!.resolve([]); await settle();
  assert.equal(f.creates.length, 0); assert.equal(f.lists.length, 1);
});

test("unmount silences a pending auto-create failure and prevents its follow-up refresh", async (t) => {
  const errors: unknown[] = [];
  t.mock.method(message, "error", (error: unknown) => { errors.push(error); });
  const f = responseFixture(t); await settle();
  f.lists[0]!.resolve([]); await settle();
  f.unmount(); f.creates[0]!.reject(new Error("unmounted fixture failure")); await settle();
  assert.equal(errors.length, 0); assert.equal(f.lists.length, 1);
});


test("same-Workspace stale failures are ignored while the current refresh failure still reports an error", async (t) => {
  const errors: unknown[] = [];
  t.mock.method(message, "error", (error: unknown) => { errors.push(error); });
  const f = responseFixture(t); await settle();
  const first = terminal("A", "first"), current = terminal("A", "current");
  f.lists[0]!.resolve([first]); await settle();
  await f.created(terminal("A", "old")); await f.created(current);
  f.lists[2]!.resolve([first, current]); await settle();
  f.lists[1]!.reject(new Error("stale same-Workspace failure")); await settle();
  assert.equal(errors.length, 0);
  f.wrapper.findComponent({ name: "TerminalTabs" }).vm.$emit("deleted"); await settle();
  f.lists[3]!.reject(new Error("current fixture failure")); await settle();
  assert.equal(errors.length, 1); assert.equal(f.minimized(), 0);
  assert.equal(f.wrapper.get('[data-terminal="current"]').attributes("data-active"), "true");
});
