import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { readFileSync } from "node:fs";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { defineComponent, h, KeepAlive, nextTick } from "vue";
import { Button, Modal, message } from "ant-design-vue";
import { apiClient } from "@/shared/api";
import zhCN from "@/shared/i18n/locales/zh-CN";
import TerminalConfigPanel from "./TerminalConfigPanel.vue";
import type { TerminalConfigRecord } from "@agent-workbench/shared";

const source = readFileSync(new URL("TerminalConfigPanel.vue", import.meta.url), "utf8");
const style = document.createElement("style"); style.textContent = source.match(/<style scoped>([\s\S]*?)<\/style>/)?.[1] ?? ""; document.head.append(style);
const stubs = {
  "a-button": { props: ["loading", "disabled"], emits: ["click"], template: '<button :disabled="loading || disabled" @click="$emit(\'click\')"><slot /></button>' },
  "a-tooltip": { template: "<span><slot /></span>" },
  "a-dropdown": { template: '<div><slot /><slot name="overlay" /></div>' },
  "a-menu": { name: "TestMenu", emits: ["click"], template: "<div><slot /></div>" },
  "a-menu-item": { template: "<span><slot /></span>" },
  "a-drawer": { props: ["open", "title"], template: '<section v-if="open" data-editor><h2>{{title}}</h2><slot /><slot name="footer" /></section>' },
  "a-form": defineComponent({ setup(_props, { expose }) { expose({ validate: () => Promise.resolve() }); }, template: "<form><slot /></form>" }),
  "a-form-item": { props: ["label"], template: "<label>{{label}}<slot /></label>" },
  "a-input": { props: ["value"], emits: ["update:value"], template: '<input :value="value" @input="$emit(\'update:value\', $event.target.value)" />' },
  "a-textarea": { props: ["value"], emits: ["update:value"], template: '<textarea :value="value" @input="$emit(\'update:value\', $event.target.value)" />' },
  "a-auto-complete": { name: "TestDirectory", props: ["value", "options"], emits: ["update:value"], template: '<div data-directory><input :value="value" @input="$emit(\'update:value\', $event.target.value)" /></div>' },
  "a-spin": { template: "<span />" }, "a-alert": { props: ["message"], template: "<p>{{message}}</p>" }
};
const adapter = apiClient.defaults.adapter;
const wrappers: VueWrapper[] = [];
afterEach(() => { wrappers.splice(0).forEach((wrapper) => wrapper.unmount()); apiClient.defaults.adapter = adapter; });
async function settle() { await nextTick(); await flushPromises(); await nextTick(); }
const OtherTool = defineComponent({ template: "<div>其他工具</div>" });
const CachedPanelHost = defineComponent({
  props: { show: { type: Boolean, default: true }, workspaceId: { type: String, default: "ws" }, active: { type: Boolean, default: true } },
  setup(props) {
    return () => h(KeepAlive, null, { default: () => props.show
      ? h(TerminalConfigPanel, { workspaceId: props.workspaceId, active: props.active })
      : h(OtherTool) });
  }
});
function setup(options: { count?: number; listWait?: Promise<void>; keepAlive?: boolean; realButtons?: boolean } = {}) {
  let runs = 0, creates = 0, updates = 0, deletes = 0;
  const config = { id: "config", workspaceId: "ws", name: "前端开发", cwd: "repo/apps/web", command: "npm run dev", createdAt: 1, updatedAt: 1 };
  let items: TerminalConfigRecord[] = Array.from({ length: options.count ?? 1 }, (_, index) => ({ ...config, id: index ? `config-${index + 1}` : "config", name: index ? `配置${index + 1}` : config.name, createdAt: index + 1 }));
  const state = { failOrder: false, orderWait: undefined as Promise<void> | undefined, orders: [] as string[][], listWait: options.listWait, listCalls: 0 };
  apiClient.defaults.adapter = async (request) => {
    const url = String(request.url), method = request.method;
    let data: unknown;
    if (/^\/workspaces\/[^/]+$/.test(url)) data = { repos: [{ dirName: "repo", repo: { id: "r", url: "fixture" } }] };
    else if (url.endsWith("/run")) { runs++; data = { id: "terminal-config", configId: "config", workspaceId: "ws", sessionName: `session-${runs}`, status: "active", createdAt: 1, updatedAt: 1 }; }
    else if (method === "put" && url.endsWith("/order")) {
      const { orderedIds } = JSON.parse(request.data) as { orderedIds: string[] };
      state.orders.push(orderedIds);
      await state.orderWait;
      if (state.failOrder) throw new Error("排序保存失败");
      items = orderedIds.map((id) => items.find((item) => item.id === id)!); data = null;
    }
    else if (method === "post") { creates++; data = { ...config, ...JSON.parse(request.data), id: "new-config", createdAt: 0 }; items.push(data as TerminalConfigRecord); }
    else if (method === "patch") {
      updates++; const id = url.split("/").at(-1)!;
      data = { ...items.find((item) => item.id === id)!, ...JSON.parse(request.data) };
      items = items.map((item) => item.id === id ? data as TerminalConfigRecord : item);
    }
    else if (method === "delete") { deletes++; data = null; }
    else { state.listCalls++; const snapshot = items.map((item) => ({ ...item })); await state.listWait; data = snapshot; }
    return { data, status: 200, statusText: "OK", headers: {}, config: request };
  };
  const wrapper = mount(options.keepAlive ? CachedPanelHost : TerminalConfigPanel, { attachTo: document.body, props: { workspaceId: "ws" }, global: { plugins: [createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } })], components: { "a-button": Button }, stubs: { ...stubs, ...(options.realButtons ? { "a-button": false } : {}) } } });
  wrappers.push(wrapper);
  return { wrapper, state, counts: () => ({ runs, creates, updates, deletes }),
    setServerOrder(orderedIds: string[]) { items = orderedIds.map((id) => items.find((item) => item.id === id)!); }
  };
}

test("compact configuration pane aligns headings and actions without extra row content", async () => {
  const { wrapper } = setup(); await settle();
  const row = wrapper.get(".config-row");
  assert.equal(row.element.children.length, 3); assert.equal(row.get(".config-name").text(), "前端开发");
  assert.equal(wrapper.get(".config-heading-title").text(), "运行");
  assert.match(getComputedStyle(row.get(".config-run").element).color, /^(?:#fff(?:fff)?|rgb\(255,\s*255,\s*255\))$/i);
  assert.equal(row.get(".config-run").element.parentElement, row.element);
  assert.equal(wrapper.findAll('.config-heading button').length, 3);
  const headingStyle = getComputedStyle(wrapper.get(".config-heading").element), rowStyle = getComputedStyle(row.element);
  for (const key of ["paddingLeft", "paddingRight", "gap", "height"] as const) assert.equal(rowStyle[key], headingStyle[key]);
  assert.equal(rowStyle.borderRadius, "0px");
  assert.equal(getComputedStyle(wrapper.get(".config-list").element).paddingLeft, "0px");
  await wrapper.get('[aria-label="收起配置"]').trigger("click"); assert.equal(wrapper.emitted("close")?.length, 1);
});

test("row, name and native keyboard activation only request selection without running or reloading", async () => {
  const { wrapper, state, counts } = setup(); await settle();
  const listCalls = state.listCalls, row = wrapper.get(".config-row"), name = row.get("button.config-select");
  assert.equal(name.attributes("type"), "button");
  assert.equal(name.text(), "前端开发");
  assert.equal(name.find("button").exists(), false);
  await row.trigger("click");
  await name.trigger("click");
  // Browsers activate native buttons with a detail=0 click for Enter/Space.
  // jsdom does not synthesize that default action from a keydown event.
  await name.trigger("click", { detail: 0 }); await settle();
  assert.deepEqual(wrapper.emitted("select"), Array.from({ length: 3 }, () => [{ workspaceId: "ws", configId: "config" }]));
  assert.equal(wrapper.emitted("runStarted"), undefined); assert.equal(wrapper.emitted("created"), undefined);
  assert.deepEqual(counts(), { runs: 0, creates: 0, updates: 0, deletes: 0 });
  assert.equal(state.listCalls, listCalls);
});

test("more and menu item clicks cannot select their configuration row", async () => {
  const { wrapper, counts } = setup(); await settle();
  await wrapper.get('[aria-label="更多"]').trigger("click");
  // The stub keeps the overlay inside its row; real overlays may be teleported.
  for (const item of wrapper.get(".config-menu").findAll("span")) await item.trigger("click");
  assert.equal(wrapper.emitted("select"), undefined);
  assert.equal(wrapper.emitted("runStarted"), undefined);
  assert.deepEqual(counts(), { runs: 0, creates: 0, updates: 0, deletes: 0 });
});

test("hidden or stale Workspace configurations cannot emit a selection", async () => {
  const { wrapper } = setup(); await settle();
  await wrapper.setProps({ active: false });
  await wrapper.get(".config-row").trigger("click");
  assert.equal(wrapper.emitted("select"), undefined);
  // This fixture deliberately still returns the former Workspace's records.
  await wrapper.setProps({ workspaceId: "ws2", active: true }); await settle();
  await wrapper.get(".config-row").trigger("click");
  assert.equal(wrapper.emitted("select"), undefined);
});

test("run events carry stable managed identity and each fresh physical session", async () => {
  const { wrapper, counts } = setup(); await settle();
  await wrapper.get('button[aria-label="运行"]').trigger("click"); await settle();
  await wrapper.get('button[aria-label="运行"]').trigger("click"); await settle();
  assert.equal(counts().runs, 2);
  const events = wrapper.emitted("created")!;
  assert.equal(events.length, 2);
  const first = events[0]![0] as { id: string; sessionName: string }, second = events[1]![0] as { id: string; sessionName: string };
  assert.equal(first.id, second.id); assert.notEqual(first.sessionName, second.sessionName);
  assert.deepEqual(wrapper.emitted("runStarted"), [[{ workspaceId: "ws", configId: "config" }], [{ workspaceId: "ws", configId: "config" }]]);
  assert.equal(wrapper.emitted("select"), undefined);
});

for (const outcome of ["success", "failure"] as const) {
  test(`run icon keeps one fixed slot through pending and ${outcome} without Ant loading-width animation`, async (t) => {
    const { wrapper } = setup({ realButtons: true }); await settle();
    const runButton = wrapper.get(".config-run");
    const iconSlot = runButton.get(".config-run-icon").element;
    const error = t.mock.method(message, "error", () => (() => {}) as ReturnType<typeof message.error>);
    let resolve!: (response: { data: unknown; status: number; statusText: string; headers: object; config: unknown }) => void;
    let reject!: (error: Error) => void;
    let request: unknown, calls = 0;
    apiClient.defaults.adapter = (config) => {
      calls++; request = config;
      return new Promise((done, fail) => { resolve = done as typeof resolve; reject = fail; });
    };
    const assertFixedSlot = () => {
      assert.equal(runButton.element, wrapper.get(".config-run").element);
      assert.equal(runButton.get(".config-run-icon").element, iconSlot);
      assert.equal(runButton.find(".ant-btn-loading-icon").exists(), false);
      assert.equal(runButton.classes().includes("ant-btn-loading"), false);
      assert.equal(runButton.classes().includes("ant-btn-icon-only"), false);
      // Verify the declared layout contract, not jsdom's non-existent geometry.
      const slotStyle = getComputedStyle(iconSlot);
      assert.equal(slotStyle.width, "14px"); assert.equal(slotStyle.height, "14px");
      assert.equal(slotStyle.flexShrink, "0");
      assert.equal(getComputedStyle(runButton.element).width, "28px");
      assert.equal(runButton.get(".config-run-icon").attributes("aria-hidden"), "true");
    };
    assert.equal(runButton.find(".anticon-caret-right").exists(), true);
    assert.equal(runButton.attributes("aria-busy"), "false"); assertFixedSlot();
    await runButton.trigger("click"); await settle();
    assert.equal(runButton.find(".anticon-loading.anticon-spin").exists(), true);
    assert.equal(runButton.find(".anticon-caret-right").exists(), false);
    assert.equal(runButton.attributes("aria-busy"), "true");
    assert.equal(runButton.attributes("disabled"), ""); assertFixedSlot();
    // Disabled controls' descendants can still bubble clicks in some browsers.
    iconSlot.dispatchEvent(new MouseEvent("click", { bubbles: true })); await settle();
    assert.equal(wrapper.emitted("select"), undefined);
    assert.equal(calls, 1);
    assert.deepEqual(wrapper.emitted("runStarted"), [[{ workspaceId: "ws", configId: "config" }]]);
    await runButton.trigger("click"); await settle(); assert.equal(calls, 1);
    if (outcome === "success") {
      resolve({ data: { id: "term", workspaceId: "ws", configId: "config", sessionName: "session", status: "active", createdAt: 1, updatedAt: 1 }, status: 200, statusText: "OK", headers: {}, config: request });
    } else {
      reject(new Error("fixture run failed"));
    }
    await settle();
    assert.equal(runButton.find(".anticon-caret-right").exists(), true);
    assert.equal(runButton.find(".anticon-loading").exists(), false);
    assert.equal(runButton.attributes("aria-busy"), "false");
    assert.equal(runButton.attributes("disabled"), undefined); assertFixedSlot();
    assert.equal(wrapper.emitted("created")?.length ?? 0, outcome === "success" ? 1 : 0);
    assert.equal(error.mock.callCount(), outcome === "failure" ? 1 : 0);
  });
}

test("new configuration supports repository choices and free relative cwd; saving never runs", async () => {
  const { wrapper, counts } = setup(); await settle();
  await wrapper.get('[aria-label="新建配置"]').trigger("click");
  const directory = wrapper.findComponent({ name: "TestDirectory" });
  assert.deepEqual(directory.props("options").map((option: { value: string }) => option.value), [".", "repo"]);
  await wrapper.get('input[aria-label="名称"]').setValue("API 服务");
  await wrapper.get("[data-directory] input").setValue("repo/custom/subdir");
  await wrapper.get('textarea[aria-label="启动命令"]').setValue("npm run dev\nprintf done");
  await wrapper.findAll("button").find((button) => button.text() === "保存配置")!.trigger("click"); await settle();
  assert.equal(counts().creates, 1); assert.equal(counts().runs, 0);
  assert.equal(wrapper.findAll(".config-row").length, 2); assert.equal(wrapper.find("[data-editor]").exists(), false);
});

test("editing and confirmed deletion only update configuration APIs, not terminals", async (t) => {
  const { wrapper, counts } = setup(); await settle();
  wrapper.findComponent({ name: "TestMenu" }).vm.$emit("click", { key: "edit" }); await settle();
  await wrapper.get('input[aria-label="名称"]').setValue("修改名称");
  await wrapper.findAll("button").find((button) => button.text() === "保存配置")!.trigger("click"); await settle();
  assert.equal(counts().updates, 1); assert.equal(counts().runs, 0);
  let confirmation: Parameters<typeof Modal.confirm>[0] | undefined;
  t.mock.method(Modal, "confirm", (options: Parameters<typeof Modal.confirm>[0]) => { confirmation = options; return { destroy() {}, update() {} }; });
  wrapper.findComponent({ name: "TestMenu" }).vm.$emit("click", { key: "delete" }); await settle();
  assert.equal(counts().deletes, 0); assert.ok(confirmation);
  await confirmation.onOk?.(); await settle();
  assert.equal(counts().deletes, 1); assert.equal(counts().runs, 0); assert.equal(wrapper.findAll(".config-row").length, 0);
  assert.equal(wrapper.emitted("select"), undefined);
});


const rowNames = (wrapper: VueWrapper) => wrapper.findAll(".config-name").map((node) => node.text());
const button = (wrapper: VueWrapper, label: string) => wrapper.get(`[aria-label="${label}"]`);
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }

test("reorder is disabled while loading or with fewer than two configurations", async () => {
  const wait = deferred();
  const { wrapper } = setup({ count: 1, listWait: wait.promise });
  assert.equal(button(wrapper, "调整顺序").attributes("disabled"), "");
  wait.resolve(); await settle();
  assert.equal(button(wrapper, "调整顺序").attributes("disabled"), "");
  await button(wrapper, "调整顺序").trigger("click");
  assert.equal(wrapper.find(".config-drag").exists(), false);
  const empty = setup({ count: 0 }); await settle();
  assert.equal(button(empty.wrapper, "调整顺序").attributes("disabled"), "");
});

test("order draft disables mutations, supports accessible moves and cancel/no-change never saves or runs", async () => {
  const { wrapper, state, counts } = setup({ count: 3 }); await settle();
  const initial = rowNames(wrapper);
  await button(wrapper, "调整顺序").trigger("click");
  assert.equal(wrapper.findAll(".config-drag").length, 3);
  for (const label of ["新建配置", "收起配置"]) assert.equal(wrapper.find(`[aria-label="${label}"]`).exists(), false);
  assert.deepEqual(wrapper.findAll(".config-heading button").map((node) => node.attributes("aria-label")), ["完成", "取消"]);
  assert.equal(wrapper.find(".config-run").exists(), false);
  assert.equal(wrapper.find("button.config-select").exists(), false);
  await wrapper.get(".config-row").trigger("click");
  await wrapper.get(".config-drag").trigger("click");
  assert.equal(wrapper.find('[aria-label="更多"]').exists(), false);
  assert.equal(wrapper.findAll('[aria-label="上移"]')[0].attributes("disabled"), "");
  assert.equal(wrapper.findAll('[aria-label="下移"]')[2].attributes("disabled"), "");
  await wrapper.findAll('[aria-label="下移"]')[0].trigger("click");
  assert.deepEqual(rowNames(wrapper), ["配置2", "前端开发", "配置3"]);
  await button(wrapper, "取消").trigger("click");
  assert.deepEqual(rowNames(wrapper), initial);
  for (const label of ["新建配置", "收起配置"]) assert.equal(wrapper.find(`[aria-label="${label}"]`).exists(), true);
  await button(wrapper, "调整顺序").trigger("click");
  await wrapper.findAll('[aria-label="下移"]')[0].trigger("click");
  await wrapper.findAll('[aria-label="上移"]')[1].trigger("click");
  await button(wrapper, "完成").trigger("click"); await settle();
  assert.equal(wrapper.find(".config-drag").exists(), false);
  assert.deepEqual(state.orders, []);
  assert.deepEqual(counts(), { runs: 0, creates: 0, updates: 0, deletes: 0 });
  assert.equal(wrapper.emitted("select"), undefined);
});

test("native drag/drop has feedback and completion saves one full ordered ID list; new configs append", async () => {
  const { wrapper, state, counts } = setup({ count: 3 }); await settle();
  await button(wrapper, "调整顺序").trigger("click");
  let rows = wrapper.findAll(".config-row");
  await rows[0].get(".config-drag").trigger("dragstart");
  await rows[2].trigger("dragover");
  assert.equal(rows[2].classes().includes("config-drop-after"), true);
  await rows[2].trigger("drop");
  await rows[0].trigger("click");
  assert.equal(wrapper.emitted("select"), undefined);
  assert.deepEqual(rowNames(wrapper), ["配置2", "配置3", "前端开发"]);
  rows = wrapper.findAll(".config-row");
  await rows[2].get(".config-drag").trigger("dragstart");
  await rows[1].trigger("dragover");
  assert.equal(rows[1].classes().includes("config-drop-before"), true);
  await rows[1].trigger("drop");
  assert.deepEqual(rowNames(wrapper), ["配置2", "前端开发", "配置3"]);
  assert.deepEqual(state.orders, []);
  await button(wrapper, "完成").trigger("click"); await settle();
  assert.deepEqual(state.orders, [["config-2", "config", "config-3"]]);
  assert.equal(wrapper.find(".config-drag").exists(), false);
  for (const label of ["新建配置", "收起配置"]) assert.equal(wrapper.find(`[aria-label="${label}"]`).exists(), true);
  assert.equal(counts().runs, 0);
  await wrapper.setProps({ active: false }); await wrapper.setProps({ active: true }); await settle();
  assert.deepEqual(rowNames(wrapper), ["配置2", "前端开发", "配置3"]);
  await button(wrapper, "新建配置").trigger("click");
  await wrapper.get('input[aria-label="名称"]').setValue("末尾配置");
  await wrapper.get('textarea[aria-label="启动命令"]').setValue("true");
  await wrapper.findAll("button").find((node) => node.text() === "保存配置")!.trigger("click"); await settle();
  assert.deepEqual(rowNames(wrapper), ["配置2", "前端开发", "配置3", "末尾配置"]);
  wrapper.findComponent({ name: "TestMenu" }).vm.$emit("click", { key: "edit" }); await settle();
  await wrapper.get('input[aria-label="名称"]').setValue("修改但不移动");
  await wrapper.findAll("button").find((node) => node.text() === "保存配置")!.trigger("click"); await settle();
  assert.deepEqual(rowNames(wrapper), ["修改但不移动", "前端开发", "配置3", "末尾配置"]);
});

test("failed order save retains the draft and can retry; saving blocks duplicate actions", async () => {
  const { wrapper, state, counts } = setup({ count: 2 }); await settle();
  await button(wrapper, "调整顺序").trigger("click");
  await wrapper.findAll('[aria-label="下移"]')[0].trigger("click");
  state.failOrder = true;
  await button(wrapper, "完成").trigger("click"); await settle();
  assert.match(wrapper.get(".config-order-error").text(), /排序保存失败/);
  assert.deepEqual(rowNames(wrapper), ["配置2", "前端开发"]);
  assert.equal(wrapper.findAll(".config-drag").length, 2);
  state.failOrder = false;
  const wait = deferred(); state.orderWait = wait.promise;
  await button(wrapper, "完成").trigger("click"); await nextTick();
  for (const label of ["完成", "取消"]) assert.equal(button(wrapper, label).attributes("disabled"), "");
  for (const label of ["新建配置", "收起配置"]) assert.equal(wrapper.find(`[aria-label="${label}"]`).exists(), false);
  assert.equal(wrapper.findAll(".config-heading button").length, 2);
  await button(wrapper, "完成").trigger("click");
  await button(wrapper, "取消").trigger("click");
  await wrapper.findAll('[aria-label="上移"]')[1].trigger("click");
  assert.equal(state.orders.length, 2);
  assert.deepEqual(rowNames(wrapper), ["配置2", "前端开发"]);
  wait.resolve(); await settle();
  assert.equal(wrapper.find(".config-order-error").exists(), false);
  assert.equal(wrapper.find(".config-drag").exists(), false);
  assert.equal(counts().runs, 0);
});

test("external hiding and Workspace switch discard drafts; normal collapse remains available", async () => {
  const { wrapper, state } = setup({ count: 2 }); await settle();
  const startAndMove = async () => {
    await button(wrapper, "调整顺序").trigger("click");
    await wrapper.findAll('[aria-label="下移"]')[0].trigger("click");
  };
  await startAndMove(); await wrapper.setProps({ active: false });
  assert.equal(wrapper.find(".config-drag").exists(), false);
  assert.deepEqual(rowNames(wrapper), ["前端开发", "配置2"]);
  await wrapper.setProps({ active: true }); await settle();
  assert.deepEqual(rowNames(wrapper), ["前端开发", "配置2"]);
  await button(wrapper, "收起配置").trigger("click");
  assert.equal(wrapper.emitted("close")?.length, 1);
  await startAndMove(); await wrapper.setProps({ workspaceId: "ws2" }); await settle();
  assert.equal(wrapper.find(".config-drag").exists(), false);
  assert.deepEqual(rowNames(wrapper), ["前端开发", "配置2"]);
  assert.deepEqual(state.orders, []);
});

test("late failed order save cannot alter another Workspace's new sorting session", async () => {
  const { wrapper, state } = setup({ count: 2 }); await settle();
  await button(wrapper, "调整顺序").trigger("click");
  await wrapper.findAll('[aria-label="下移"]')[0].trigger("click");
  const wait = deferred(); state.orderWait = wait.promise; state.failOrder = true;
  await button(wrapper, "完成").trigger("click");
  await wrapper.setProps({ workspaceId: "ws2" }); await settle();
  await button(wrapper, "调整顺序").trigger("click");
  wait.resolve(); await settle();
  assert.equal(wrapper.find(".config-order-error").exists(), false);
  assert.equal(wrapper.findAll(".config-drag").length, 2);
  assert.deepEqual(rowNames(wrapper), ["前端开发", "配置2"]);
  assert.equal(button(wrapper, "完成").attributes("disabled"), undefined);
});


test("late successful order save cannot overwrite a new Workspace draft or revive an unmounted panel", async () => {
  const { wrapper, state } = setup({ count: 2 }); await settle();
  await button(wrapper, "调整顺序").trigger("click");
  await wrapper.findAll('[aria-label="下移"]')[0].trigger("click");
  const wait = deferred(); state.orderWait = wait.promise;
  await button(wrapper, "完成").trigger("click");
  await wrapper.setProps({ workspaceId: "ws2" }); await settle();
  await button(wrapper, "调整顺序").trigger("click");
  wait.resolve(); await settle();
  assert.deepEqual(rowNames(wrapper), ["前端开发", "配置2"]);
  assert.equal(wrapper.findAll(".config-drag").length, 2);
  assert.equal(button(wrapper, "完成").attributes("disabled"), undefined);
  const pending = deferred(); state.orderWait = pending.promise;
  await wrapper.findAll('[aria-label="下移"]')[0].trigger("click");
  await button(wrapper, "完成").trigger("click");
  wrapper.unmount(); wrappers.splice(wrappers.indexOf(wrapper), 1);
  pending.resolve(); await settle();
  assert.equal(state.orders.length, 2);
});


test("real KeepAlive deactivation discards the draft and activation reloads exactly once", async () => {
  const { wrapper, state } = setup({ count: 2, keepAlive: true }); await settle();
  const panelUid = wrapper.findComponent(TerminalConfigPanel).vm.$.uid;
  assert.equal(state.listCalls, 1); // Immediate watch plus initial onActivated must not double-load.
  await button(wrapper, "调整顺序").trigger("click");
  await wrapper.findAll('[aria-label="下移"]')[0].trigger("click");
  assert.deepEqual(rowNames(wrapper), ["配置2", "前端开发"]);
  await wrapper.setProps({ show: false }); await settle();
  assert.equal(wrapper.find(".terminal-config-panel").exists(), false);
  assert.equal(state.listCalls, 1);
  await wrapper.setProps({ show: true }); await settle();
  assert.equal(wrapper.findComponent(TerminalConfigPanel).vm.$.uid, panelUid); // Reused, not unmounted/remounted.
  assert.equal(wrapper.find(".config-drag").exists(), false);
  assert.deepEqual(rowNames(wrapper), ["前端开发", "配置2"]);
  assert.equal(state.listCalls, 2);
  assert.deepEqual(state.orders, []);
  // Prop changes while cached cannot load; restoring and changing props together loads only once.
  await wrapper.setProps({ show: false });
  await wrapper.setProps({ active: false, workspaceId: "ws2" }); await settle();
  assert.equal(state.listCalls, 2);
  await wrapper.setProps({ show: true, active: true, workspaceId: "ws3" }); await settle();
  assert.equal(state.listCalls, 3);
});

test("KeepAlive restoration reads an order saved successfully while the panel was deactivated", async () => {
  const { wrapper, state } = setup({ count: 2, keepAlive: true }); await settle();
  await button(wrapper, "调整顺序").trigger("click");
  await wrapper.findAll('[aria-label="下移"]')[0].trigger("click");
  const wait = deferred(); state.orderWait = wait.promise;
  await button(wrapper, "完成").trigger("click");
  await wrapper.setProps({ show: false }); await settle();
  wait.resolve(); await settle();
  assert.equal(state.listCalls, 1);
  await wrapper.setProps({ show: true }); await settle();
  assert.deepEqual(rowNames(wrapper), ["配置2", "前端开发"]);
  assert.equal(wrapper.find(".config-drag").exists(), false);
  assert.equal(state.listCalls, 2);
});

for (const failOrder of [false, true]) {
  test(`KeepAlive ignores a late ${failOrder ? "failed" : "successful"} save after restoring a new draft`, async () => {
    const { wrapper, state } = setup({ count: 3, keepAlive: true }); await settle();
    await button(wrapper, "调整顺序").trigger("click");
    await wrapper.findAll('[aria-label="下移"]')[0].trigger("click");
    const wait = deferred(); state.orderWait = wait.promise; state.failOrder = failOrder;
    await button(wrapper, "完成").trigger("click");
    await wrapper.setProps({ show: false }); await settle();
    await wrapper.setProps({ show: true }); await settle();
    assert.deepEqual(rowNames(wrapper), ["前端开发", "配置2", "配置3"]);
    await button(wrapper, "调整顺序").trigger("click");
    await wrapper.findAll('[aria-label="下移"]')[1].trigger("click");
    wait.resolve(); await settle();
    assert.deepEqual(rowNames(wrapper), ["前端开发", "配置3", "配置2"]);
    assert.equal(wrapper.findAll(".config-drag").length, 3);
    assert.equal(button(wrapper, "完成").attributes("disabled"), undefined);
    assert.equal(wrapper.find(".config-order-error").exists(), false);
    assert.equal(state.listCalls, 2);
    assert.equal(state.orders.length, 1);
  });
}

test("KeepAlive invalidates an old pending load so it cannot overwrite the restored list", async () => {
  const wait = deferred();
  const { wrapper, state, setServerOrder } = setup({ count: 2, keepAlive: true, listWait: wait.promise }); await settle();
  assert.equal(state.listCalls, 1);
  await wrapper.setProps({ show: false }); await settle();
  setServerOrder(["config-2", "config"]); state.listWait = undefined;
  await wrapper.setProps({ show: true }); await settle();
  assert.equal(state.listCalls, 2);
  assert.deepEqual(rowNames(wrapper), ["配置2", "前端开发"]);
  wait.resolve(); await settle();
  assert.deepEqual(rowNames(wrapper), ["配置2", "前端开发"]);
  assert.equal(button(wrapper, "调整顺序").attributes("disabled"), undefined);
});

test("run starts synchronously and unconfirmed-stop errors use message.error without emitting a replacement", async (t) => {
  const f = setup(); await settle();
  let reject!: (error: Error) => void;
  apiClient.defaults.adapter = () => new Promise((_resolve, fail) => { reject = fail; });
  const error = t.mock.method(message, "error", () => (() => {}) as ReturnType<typeof message.error>);
  await f.wrapper.get('button[aria-label="运行"]').trigger("click"); await settle();
  assert.deepEqual(f.wrapper.emitted("runStarted"), [[{ workspaceId: "ws", configId: "config" }]]);
  assert.equal(f.wrapper.emitted("created"), undefined);
  reject(Object.assign(new Error("fixture stop error"), { isAxiosError: true, response: { status: 503, data: { message: "fixture stop error", code: "TERMINAL_SESSION_STOP_UNCONFIRMED" } } })); await settle();
  assert.equal(error.mock.callCount(), 1);
  assert.equal(error.mock.calls[0]?.arguments[0], zhCN.terminal.config.restartStoppedUnconfirmed);
  assert.equal(f.wrapper.emitted("created"), undefined);
});

test("a destroyed configuration panel cannot publish a late run generation", async () => {
  const f = setup(); await settle();
  let resolve!: (response: { data: unknown; status: number; statusText: string; headers: object; config: unknown }) => void;
  let request: unknown;
  apiClient.defaults.adapter = (config) => { request = config; return new Promise((done) => { resolve = done as typeof resolve; }); };
  await f.wrapper.get('button[aria-label="运行"]').trigger("click"); await settle();
  f.wrapper.unmount();
  resolve({ data: { id: "late", workspaceId: "ws", configId: "config", sessionName: "late-session", status: "active", createdAt: 1, updatedAt: 1 }, status: 200, statusText: "OK", headers: {}, config: request });
  await settle(); assert.equal(f.wrapper.emitted("created"), undefined);
});


for (const [code, key] of [["TERMINAL_RUN_LEGACY", "legacyRun"], ["TERMINAL_RUN_GUARD_UNAVAILABLE", "guardUnavailable"]] as const) {
  test(`${code} uses message.error without publishing a new terminal`, async (t) => {
    const f = setup(); await settle();
    apiClient.defaults.adapter = async () => { throw Object.assign(new Error("fixture"), { isAxiosError: true, response: { status: 503, data: { message: "fixture", code } } }); };
    const error = t.mock.method(message, "error", () => (() => {}) as ReturnType<typeof message.error>);
    await f.wrapper.get('button[aria-label="运行"]').trigger("click"); await settle();
    assert.equal(error.mock.callCount(), 1); assert.equal(error.mock.calls[0]?.arguments[0], zhCN.terminal.config[key]);
    assert.equal(f.wrapper.emitted("created"), undefined);
  });
}
