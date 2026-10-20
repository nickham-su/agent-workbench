import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { nextTick } from "vue";
import { shallowMount, type VueWrapper } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { apiClient } from "@/shared/api";
import zhCN from "@/shared/i18n/locales/zh-CN";
import EnvironmentVariablesIcon from "./icons/EnvironmentVariablesIcon.vue";

Object.defineProperties(globalThis, {
  self: { value: window, configurable: true },
  localStorage: { value: window.localStorage, configurable: true },
  UIEvent: { value: window.UIEvent, configurable: true },
  CSS: { value: window.CSS, configurable: true }
});
const key = "agent-workbench.ui.toolLayout.v1";
const defaults = {
  leftTop: ["files", "search", "codeReview", "scheduledTasks", "environmentVariables", "agent"],
  leftBottom: ["terminal"], rightTop: ["editor"]
};
const saved = { ...defaults, leftTop: ["agent", "files", "search", "codeReview", "scheduledTasks"], leftBottom: ["terminal", "environmentVariables"] };
const originalSetItem = window.localStorage.setItem;
window.localStorage.setItem(key, JSON.stringify({ version: 1, toolOrderByArea: saved }));
const startupWrites: string[] = [];
mockStorageWrites((key, value) => { startupWrites.push(key); originalSetItem.call(window.localStorage, key, value); });
// Load before test execution: vite-node closes its transformer after entry evaluation.
const { globalToolLayout, TOOL_LAYOUT_STORAGE_KEY } = await import("./toolLayout");
const startupLayout = JSON.parse(JSON.stringify(globalToolLayout.value));
const { default: WorkspaceLayout } = await import("./views/WorkspaceLayout.vue");
mockStorageWrites(originalSetItem);

const originalAdapter = apiClient.defaults.adapter;
const wrappers: VueWrapper[] = [];
const storedKeys = new Set<string>([key]);
const tick = async () => { await nextTick(); await new Promise<void>((resolve) => setImmediate(resolve)); await nextTick(); };
const settle = async () => { for (let i = 0; i < 4; i++) await tick(); };
const waitForSave = async () => { await settle(); await new Promise((resolve) => setTimeout(resolve, 150)); await tick(); };
const layoutKey = (id: string) => `agent-workbench.workspace.dockLayout.v4.${id}`;

function mockStorageWrites(setItem: Storage["setItem"]) {
  // happy-dom's Storage proxy ignores assignment to native methods.
  Object.defineProperty(window.localStorage, "setItem", { value: setItem, configurable: true, writable: true });
}
function store(key: string, value: unknown) {
  storedKeys.add(key);
  window.localStorage.setItem(key, JSON.stringify(value));
}
function storageEvent(key: string | null = TOOL_LAYOUT_STORAGE_KEY, storageArea = window.localStorage) {
  window.dispatchEvent(new window.StorageEvent("storage", { key, storageArea }));
}
function localLayout(overrides: Record<string, unknown> = {}) {
  return {
    version: 4, updatedAt: 1, ratios: { topBottom: 0.6, topLeft: 0.4 },
    toolMinimized: { files: false, terminal: true, search: true, agent: false, codeReview: false, scheduledTasks: false, environmentVariables: false, editor: true },
    activeToolIdByArea: { leftTop: "files", leftBottom: "terminal", rightTop: null },
    ...overrides
  };
}
function mountLayout(id: string) {
  storedKeys.add(layoutKey(id));
  const wrapper = shallowMount(WorkspaceLayout, {
    props: { workspaceId: id, previewEnabled: false },
    global: {
      plugins: [createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } })],
      stubs: {
        "a-layout": { template: "<div><slot /></div>" },
        "a-layout-content": { template: "<div><slot /></div>" },
        "a-select": true, "a-button": true, "a-form": true, "a-form-item": true, "a-modal": true
      }
    }
  });
  wrappers.push(wrapper);
  return wrapper;
}
function dock(wrapper: VueWrapper) { return wrapper.findComponent({ name: "WorkspaceDock" }); }
function props(wrapper: VueWrapper): any { return dock(wrapper).props(); }
function order(wrapper: VueWrapper) {
  return { leftTop: [...props(wrapper).leftTopToolbarToolIds], leftBottom: [...props(wrapper).leftBottomToolbarToolIds] };
}
function snapshotLocal(wrapper: VueWrapper) {
  const value = props(wrapper);
  return JSON.parse(JSON.stringify({ active: value.activeToolIdByArea, minimized: value.toolMinimized, top: value.topStyle, center: value.centerStyle }));
}

beforeEach(() => {
  window.localStorage.removeItem(key);
  storageEvent();
  apiClient.defaults.adapter = async (config) => ({
    data: config.url === "/git/workspace-status" ? { repos: [] } : { id: config.url?.split("/").at(-1), title: "Fixture", dirName: "fixture", repos: [], createdAt: 1, updatedAt: 1, terminalCredentialId: null },
    status: 200, statusText: "OK", headers: {}, config
  });
});
afterEach(() => {
  mockStorageWrites(originalSetItem);
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  for (const key of storedKeys) window.localStorage.removeItem(key);
  storageEvent();
  apiClient.defaults.adapter = originalAdapter;
});

test("a fresh page loads saved browser-wide order and areas without writing storage", () => {
  assert.deepEqual(startupLayout, saved);
  assert.deepEqual(startupWrites, []);
});

test("without new global settings old workspace layouts are ignored and no configuration is created", async () => {
  const oldKey = "agent-workbench.workspace.dockLayout.v3.old";
  const old = { version: 3, toolArea: { files: "leftBottom" }, toolOrderByArea: { leftTop: ["agent"], leftBottom: ["files"] } };
  store(oldKey, old);
  const wrapper = mountLayout("old"); await settle();
  assert.deepEqual(order(wrapper), { leftTop: defaults.leftTop, leftBottom: ["terminal"] });
  assert.equal(props(wrapper).toolTitle("environmentVariables"), "环境变量");
  assert.equal(props(wrapper).toolIcon("environmentVariables"), EnvironmentVariablesIcon);
  assert.equal(props(wrapper).isKeepAlive("environmentVariables"), false);
  props(wrapper).moveToolUp("files");
  props(wrapper).moveToolDown("terminal");
  props(wrapper).moveTool("files", "leftTop");
  props(wrapper).moveTool("editor", "leftBottom");
  props(wrapper).moveTool("files", "rightTop");
  await waitForSave();
  assert.equal(window.localStorage.getItem(key), null);
  assert.deepEqual(JSON.parse(window.localStorage.getItem(oldKey)!), old);
  await wrapper.setProps({ workspaceId: "new" }); storedKeys.add(layoutKey("new")); await waitForSave();
  assert.equal(window.localStorage.getItem(key), null);
  assert.deepEqual(order(wrapper).leftBottom, ["terminal"]);
});

test("user reordering and area moves are shared by all workspaces and survive switching and remounting", async () => {
  store(layoutKey("a"), localLayout());
  store(layoutKey("b"), localLayout({ ratios: { topBottom: 0.7, topLeft: 0.3 }, activeToolIdByArea: { leftTop: "agent", leftBottom: "terminal", rightTop: null } }));
  const a = mountLayout("a"), b = mountLayout("b"); await settle();
  const aBefore = snapshotLocal(a), bBefore = snapshotLocal(b);
  props(a).moveToolDown("files"); await tick();
  assert.deepEqual(order(a), order(b));
  assert.deepEqual(order(a).leftTop.slice(0, 2), ["search", "files"]);
  assert.deepEqual(snapshotLocal(a), aBefore);
  assert.deepEqual(snapshotLocal(b), bBefore);
  props(a).moveTool("environmentVariables", "leftBottom"); await tick();
  assert.deepEqual(order(a).leftBottom, ["terminal", "environmentVariables"]);
  assert.deepEqual(order(a), order(b));
  assert.deepEqual(snapshotLocal(a), aBefore);
  assert.deepEqual(snapshotLocal(b), bBefore);
  const persisted = JSON.parse(window.localStorage.getItem(key)!);
  assert.equal(persisted.version, 1);
  assert.deepEqual(persisted.toolOrderByArea, JSON.parse(JSON.stringify(globalToolLayout.value)));
  assert.ok(globalToolLayout.value.leftTop.includes("codeReview"), "code review preference is retained");
  await a.setProps({ workspaceId: "c" }); storedKeys.add(layoutKey("c")); await settle();
  assert.deepEqual(order(a), order(b));
  const remounted = mountLayout("d"); await settle();
  assert.deepEqual(order(remounted), order(b));
});

test("active/minimized state and ratios remain workspace-local and never contain global ordering fields", async () => {
  store(layoutKey("a"), localLayout());
  store(layoutKey("b"), localLayout({ ratios: { topBottom: 0.7, topLeft: 0.3 }, activeToolIdByArea: { leftTop: "agent", leftBottom: "terminal", rightTop: null } }));
  const wrapper = mountLayout("a"); await settle();
  props(wrapper).onToolIconClick("search");
  props(wrapper).onToolIconClick("terminal");
  await waitForSave();
  const aSaved = JSON.parse(window.localStorage.getItem(layoutKey("a"))!);
  assert.deepEqual(aSaved.ratios, { topBottom: 0.6, topLeft: 0.4 });
  assert.equal(aSaved.activeToolIdByArea.leftTop, "search");
  assert.equal(aSaved.toolMinimized.terminal, false);
  assert.equal("toolArea" in aSaved, false);
  assert.equal("toolOrderByArea" in aSaved, false);
  assert.equal(window.localStorage.getItem(key), null);
  await wrapper.setProps({ workspaceId: "b" }); await settle();
  assert.equal(props(wrapper).activeToolIdByArea.leftTop, "agent");
  assert.equal(props(wrapper).toolMinimized.terminal, true);
  await wrapper.setProps({ workspaceId: "a" }); await settle();
  assert.equal(props(wrapper).activeToolIdByArea.leftTop, "search");
  assert.equal(props(wrapper).toolMinimized.terminal, false);
});

test("moving a visible tool preserves occupied destinations and follows it into an empty destination in other workspaces", async () => {
  store(layoutKey("occupied"), localLayout({ toolMinimized: { terminal: false } }));
  const a = mountLayout("occupied"), b = mountLayout("empty"); await settle();
  const editorState = [props(a).toolMinimized.editor, props(b).toolMinimized.editor];
  props(a).moveTool("files", "leftBottom"); await tick();
  assert.equal(props(a).activeToolIdByArea.leftBottom, "terminal");
  assert.equal(props(b).activeToolIdByArea.leftBottom, "files");
  for (const [index, wrapper] of [a, b].entries()) {
    const p = props(wrapper);
    assert.equal(p.activeToolIdByArea.leftTop, "search");
    assert.equal(p.visibleToolIdByArea.leftTop, "search");
    assert.ok(!p.keepAliveIncludeByArea.leftTop.includes("files"));
    assert.ok(p.keepAliveIncludeByArea.leftBottom.includes("files"));
    assert.equal(p.toolMinimized.files, false);
    assert.equal(p.toolMinimized.editor, editorState[index]);
  }
});

test("storage events synchronize order/areas, repair invalid data and never echo a global write", async () => {
  const a = mountLayout("a"), b = mountLayout("b"); await settle();
  store(key, { version: 1, toolOrderByArea: { leftTop: ["agent", "editor", "agent", "unknown"], leftBottom: ["files", "terminal"], rightTop: ["search", "editor"] } });
  const writes: string[] = [];
  mockStorageWrites((key, value) => { writes.push(key); originalSetItem.call(window.localStorage, key, value); });
  storageEvent(); await waitForSave();
  assert.deepEqual(order(a), order(b));
  assert.deepEqual(order(a), { leftTop: ["agent", "search", "codeReview", "scheduledTasks", "environmentVariables"], leftBottom: ["files", "terminal"] });
  assert.deepEqual([...globalToolLayout.value.rightTop], ["editor"]);
  assert.equal(props(a).activeToolIdByArea.leftBottom, "files");
  assert.equal(writes.includes(key), false);
  const before = order(a);
  originalSetItem.call(window.localStorage, key, JSON.stringify({ version: 1, toolOrderByArea: defaults }));
  storageEvent("unrelated-key"); storageEvent(key, window.sessionStorage); await tick();
  assert.deepEqual(order(a), before);
  storageEvent(); await tick();
  assert.deepEqual(order(a).leftBottom, ["terminal"]);
  assert.equal(writes.includes(key), false);
});

test("malformed/removed/cleared global storage falls back to defaults without persisting a repair", async () => {
  const wrapper = mountLayout("a"); await settle();
  for (const invalid of ["{broken", "null", JSON.stringify({ version: 2 }), JSON.stringify({ version: 1, toolOrderByArea: "wrong" })]) {
    originalSetItem.call(window.localStorage, key, invalid);
    storageEvent(); await tick();
    assert.deepEqual(order(wrapper).leftTop, defaults.leftTop);
    assert.equal(window.localStorage.getItem(key), invalid);
  }
  props(wrapper).moveTool("agent", "leftBottom"); await tick();
  window.localStorage.removeItem(key); storageEvent(); await tick();
  assert.deepEqual(order(wrapper).leftBottom, ["terminal"]);
  assert.equal(window.localStorage.getItem(key), null);
  props(wrapper).moveTool("agent", "leftBottom"); await tick();
  window.localStorage.removeItem(key); storageEvent(null); await waitForSave();
  assert.deepEqual(order(wrapper).leftBottom, ["terminal"]);
  assert.equal(window.localStorage.getItem(key), null);
});

test("blocked browser writes do not break user adjustment or sharing within the page", async () => {
  const a = mountLayout("a"), b = mountLayout("b"); await settle();
  mockStorageWrites(() => { throw new Error("storage unavailable"); });
  props(a).moveTool("agent", "leftBottom"); await tick();
  assert.deepEqual(order(a).leftBottom, ["terminal", "agent"]);
  assert.deepEqual(order(a), order(b));
  assert.equal(window.localStorage.getItem(key), null);
});
