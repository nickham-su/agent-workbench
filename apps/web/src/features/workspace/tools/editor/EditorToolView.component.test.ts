import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { markRaw, nextTick } from "vue";
import { AxiosError } from "axios";
import { createI18n } from "vue-i18n";
import { mount } from "@vue/test-utils";
import { message, Modal, Tooltip } from "ant-design-vue";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
// @ts-expect-error Monaco does not publish types for this internal registration-test entry.
import { EditorExtensionsRegistry as monacoRegistry } from "monaco-editor/esm/vs/editor/browser/editorExtensions.js";
import { WORKSPACE_PREVIEW_RESOURCES, type FileStatResponse } from "@agent-workbench/shared";
import zhCN from "@/shared/i18n/locales/zh-CN";
import { apiClient } from "@/shared/api/api";
import { workspaceHostKey } from "../../host";
import { getEditorStore } from "./store";
import { EDITOR_IMAGE_MAX_BYTES } from "./editorImages";
import type { FileEditorTab } from "./types";

Object.defineProperty(globalThis, "UIEvent", { value: window.UIEvent, configurable: true });
Object.defineProperty(globalThis, "CSS", { value: window.CSS, configurable: true });
const { default: EditorToolView } = await import("./EditorToolView.vue");
const EditorExtensionsRegistry = monacoRegistry as {
  getEditorActions(): Array<{ id: string }>;
  getEditorContributions(): Array<{ id: string }>;
};

const wrappers: Array<ReturnType<typeof mount>> = [];
const workspaceIds = new Set<string>();
const originalAdapter = apiClient.defaults.adapter;
const originalCreate = monaco.editor.create;
const originalCreateModel = monaco.editor.createModel;
const originalCreateURL = URL.createObjectURL;
const originalRevokeURL = URL.revokeObjectURL;
const originalSubmit = window.HTMLFormElement.prototype.submit;
const originalConfirm = Modal.confirm;
const confirmations: Array<Parameters<typeof Modal.confirm>[0]> = [];
const createdUrls: Array<{ url: string; blob: Blob }> = [];
const revokedUrls: string[] = [];
const requests: Array<{ type: string; path: string; workspaceId: string; data: any }> = [];
const forms: Array<{ target: string; action: string; path: string }> = [];
const editorOptions: any[] = [];
const editorActionRuns: string[] = [];
let editorActionsAvailable = true;
let modelsCreated = 0;
let refresh: (() => unknown) | undefined;
let blur: (() => unknown) | undefined;
let save: (() => unknown) | undefined;
let requestHandler: ((type: string, path: string, workspaceId: string, data: any) => unknown) | undefined;
let id = 0;
const turns = async () => { await nextTick(); await new Promise<void>((resolve) => setImmediate(resolve)); await nextTick(); };
const settle = async () => { for (let i = 0; i < 4; i++) await turns(); await new Promise((resolve) => setTimeout(resolve, 10)); };

function file(size = 8): FileStatResponse {
  return { path: "image.png", ok: true, kind: "file", version: { size, mtimeMs: 1 } };
}
function tab(workspaceId: string): FileEditorTab {
  const current = getEditorStore(workspaceId).activeTab.value;
  assert.equal(current?.kind, "file");
  return current as FileEditorTab;
}

function setup(workspaceId = `editor-test-${++id}`, previewEnabled = true) {
  (Modal as { confirm: typeof Modal.confirm }).confirm = ((options) => {
    confirmations.push(options);
    return { destroy() {}, update() {} };
  }) as typeof Modal.confirm;
  workspaceIds.add(workspaceId);
  (monaco.editor as any).createModel = (...args: Parameters<typeof monaco.editor.createModel>) => { modelsCreated++; return originalCreateModel(...args); };
  (monaco.editor as any).create = (element: HTMLElement, options: any) => {
    editorOptions.push(options);
    element.dataset.testEditorText = "";
    let model: monaco.editor.ITextModel | null = null;
    return {
      getModel: () => model, setModel: (next: monaco.editor.ITextModel | null) => { model = next; },
      updateOptions: (next: any) => editorOptions.push(next), layout() {}, dispose() {},
      deltaDecorations: () => [], saveViewState: () => null, restoreViewState() {},
      onDidBlurEditorText: (callback: () => unknown) => { blur = callback; return { dispose() {} }; },
      addCommand: (_key: number, callback: () => unknown) => { save = callback; return "save"; },
      getDomNode: () => element, hasTextFocus: () => false,
      getAction: (actionId: string) => editorActionsAvailable && EditorExtensionsRegistry.getEditorActions().some((action) => action.id === actionId)
        ? { run: () => { editorActionRuns.push(actionId); } }
        : null,
      setPosition() {}, setSelection() {}, focus() {}, setScrollTop() {},
      getLayoutInfo: () => ({ height: 400, contentWidth: 600 }),
      getScrollHeight: () => 400, getTopForLineNumber: () => 0,
      getOption: () => 20,
    };
  };
  URL.createObjectURL = (blob) => { const url = `blob:editor-test-${createdUrls.length + 1}`; createdUrls.push({ url, blob: blob as Blob }); return url; };
  URL.revokeObjectURL = (url) => { revokedUrls.push(url); };
  window.HTMLFormElement.prototype.submit = function () {
    forms.push({ target: this.target, action: this.action, path: this.querySelector<HTMLInputElement>('input[name="path"]')?.value ?? "" });
  };
  apiClient.defaults.adapter = async (config) => {
    const type = String(config.url).split("/").pop()!;
    const ws = String(config.url).split("/")[2]!;
    const data = typeof config.data === "string" ? JSON.parse(config.data) : config.data;
    const path = data?.path ?? config.params?.path ?? "";
    requests.push({ type, path, workspaceId: ws, data });
    const fallback = type === "stat" ? file() : type === "download" ? new Blob(["image"], { type: "application/octet-stream" }) : type === "write-text" ? { path, version: { size: data.content.length, mtimeMs: 2 } } : { path, previewable: true, content: "<html>saved</html>", version: { size: 18, mtimeMs: 1 }, language: "plaintext" };
    const response = requestHandler ? await requestHandler(type, path, ws, data) : fallback;
    return { data: response === undefined ? fallback : response, status: 200, statusText: "OK", headers: {}, config };
  };
  const wrapper = mount(EditorToolView, {
    attachTo: document.body, props: { workspaceId, toolId: "editor", previewEnabled },
    global: {
      plugins: [createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } })],
      provide: { [workspaceHostKey as symbol]: {
        minimizeTool() {}, registerToolCommands(_toolId: string, commands: any) { refresh = commands.refresh; return () => {}; },
      } },
      stubs: { EditorTabs: { name: "EditorTabs", props: ["tabs", "requestCloseTab", "requestCloseOtherTabs", "requestCloseAllTabs"], template: '<div data-editor-tabs></div>' }, MonacoCodeViewer: { props: ["value"], template: '<pre data-memory-preview>{{ value }}</pre>' }, MonacoDiffViewer: { props: ["original", "modified"], methods: { goToFirstDiff() {}, goToPreviousDiff() {}, goToNextDiff() {} }, template: '<pre data-diff>{{ original }}→{{ modified }}</pre>' } },
    },
  });
  wrappers.push(wrapper);
  return { wrapper, workspaceId, store: getEditorStore(workspaceId) };
}
async function open(store: ReturnType<typeof getEditorStore>, path: string, mode: "edit" | "preview" = "edit") {
  store.enqueueOpenFile({ path, mode, line: 12, column: 4, highlight: { kind: "line" } });
  await settle();
}

afterEach(async () => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  for (const ws of workspaceIds) getEditorStore(ws).reset();
  workspaceIds.clear();
  apiClient.defaults.adapter = originalAdapter;
  (monaco.editor as any).create = originalCreate;
  (monaco.editor as any).createModel = originalCreateModel;
  URL.createObjectURL = originalCreateURL;
  URL.revokeObjectURL = originalRevokeURL;
  window.HTMLFormElement.prototype.submit = originalSubmit;
  (Modal as { confirm: typeof Modal.confirm }).confirm = originalConfirm;
  confirmations.length = 0;
  createdUrls.length = revokedUrls.length = requests.length = forms.length = editorOptions.length = 0;
  editorActionRuns.length = 0;
  editorActionsAvailable = true;
  modelsCreated = 0;
  refresh = blur = save = undefined;
  requestHandler = undefined;
  message.destroy();
  Modal.destroyAll();
  await settle();
});

function dispatchFindShortcut(target: Element, options: KeyboardEventInit = {}) {
  const event = new window.KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true, ...options });
  target.dispatchEvent(event);
  return event;
}

test("编辑器显式加载真实 Monaco 查找动作及控制器，不依赖其他工具注册", () => {
  const actionIds = EditorExtensionsRegistry.getEditorActions().map((action) => action.id);
  assert.ok(actionIds.includes("actions.find"));
  assert.ok(actionIds.includes("editor.action.startFindReplaceAction"));
  assert.ok(EditorExtensionsRegistry.getEditorContributions().some((contribution) => contribution.id === "editor.contrib.findController"));
});

for (const mode of ["edit", "preview"] as const) {
  for (const modifier of ["ctrlKey", "metaKey"] as const) {
    for (const key of ["f", "h"] as const) {
      test(`${mode} 文本的 ${modifier}+${key} 调用已注册的查找/替换动作`, async () => {
        const { wrapper, store } = setup();
        await open(store, "repo/page.html", mode);
        const event = dispatchFindShortcut(wrapper.get("[data-test-editor-text]").element, { key, ctrlKey: false, [modifier]: true });
        assert.equal(event.defaultPrevented, true);
        assert.deepEqual(editorActionRuns, [key === "h" ? "editor.action.startFindReplaceAction" : "actions.find"]);
      });
    }
  }
}

test("查找动作缺失时不吞快捷键", async () => {
  const { wrapper, store } = setup();
  await open(store, "repo/page.html");
  editorActionsAvailable = false;
  const event = dispatchFindShortcut(wrapper.get("[data-test-editor-text]").element);
  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(editorActionRuns, []);
});

test("焦点在其他工具或预览按钮时不拦截查找快捷键", async () => {
  const { wrapper, store } = setup();
  await open(store, "repo/page.html");
  const input = document.createElement("input");
  document.body.appendChild(input);
  try {
    input.focus();
    assert.equal(dispatchFindShortcut(input).defaultPrevented, false);
    const button = wrapper.get("button[data-editor-html-preview]").element as HTMLButtonElement;
    button.focus();
    assert.equal(dispatchFindShortcut(button).defaultPrevented, false);
    assert.deepEqual(editorActionRuns, []);
  } finally {
    input.remove();
  }
});

test("非查找组合键不被拦截", async () => {
  const { wrapper, store } = setup();
  await open(store, "repo/page.html");
  const element = wrapper.get("[data-test-editor-text]").element;
  for (const options of [{ ctrlKey: false }, { altKey: true }, { key: "s" }]) {
    assert.equal(dispatchFindShortcut(element, options).defaultPrevented, false);
  }
  assert.deepEqual(editorActionRuns, []);
});

for (const kind of ["image", "preview", "diff"] as const) {
  test(`${kind} 激活时不会由隐藏的文本编辑器拦截快捷键`, async () => {
    const { wrapper, store } = setup();
    await open(store, "repo/page.html");
    const element = wrapper.get("[data-test-editor-text]").element;
    if (kind === "image") {
      await open(store, "repo/image.png");
    } else if (kind === "preview") {
      store.upsertTab({ kind: "preview", key: "memory", title: "memory", text: "text", readOnly: true });
    } else {
      store.upsertTab({ kind: "diff", key: "diff", title: "diff", original: "old", modified: "new", readOnly: true });
    }
    await settle();
    assert.equal(dispatchFindShortcut(element).defaultPrevented, false);
    assert.deepEqual(editorActionRuns, []);
  });
}

for (const resource of Object.values(WORKSPACE_PREVIEW_RESOURCES).filter((resource) => resource.kind === "image")) {
  test(`图片 ${resource.extension} 通过共享 MIME 和 img 展示，edit/行列不会进入文本链`, async () => {
    const { wrapper, workspaceId, store } = setup();
    await open(store, `repo/图片${resource.extension.toUpperCase()}`);
    assert.equal(wrapper.findAll("img").length, 1);
    assert.equal(wrapper.find("img").attributes("src"), createdUrls[0]?.url);
    assert.equal(createdUrls[0]?.blob.type, resource.mime);
    assert.equal(modelsCreated, 0);
    assert.equal(tab(workspaceId).readOnly, true);
    assert.equal(tab(workspaceId).model, undefined);
    assert.equal(tab(workspaceId).openAt, undefined);
    assert.equal(tab(workspaceId).dirty, false);
    assert.deepEqual(requests.map((request) => request.type), ["stat", "download"]);
    assert.equal(wrapper.find("iframe, object, embed").exists(), false);
    await open(store, `repo/图片${resource.extension.toUpperCase()}`, "edit");
    assert.equal(tab(workspaceId).readOnly, true);
    assert.deepEqual(requests.map((request) => request.type), ["stat", "download"]);
  });
}

test("HTML 仍创建代码 model，干净只读文件点击浏览器按钮复用新标签表单", async () => {
  const { wrapper, workspaceId, store } = setup("html-readonly");
  await open(store, "repo/中文 page.HTM", "preview");
  assert.equal(modelsCreated, 1);
  assert.equal(tab(workspaceId).model?.getValue(), "<html>saved</html>");
  assert.equal(tab(workspaceId).readOnly, true);
  const button = wrapper.get("button[data-editor-html-preview]");
  assert.equal(button.attributes("disabled"), undefined);
  assert.equal(button.attributes("type"), "button");
  assert.equal(button.attributes("aria-label"), "在浏览器中预览");
  assert.equal(wrapper.findComponent(Tooltip).props("placement"), "left");
  const trigger = button.element.parentElement!;
  for (const name of ["inline-flex", "w-7", "h-7"]) assert.ok(trigger.classList.contains(name));
  const controls = button.element.closest(".absolute")!;
  assert.ok(controls.classList.contains("right-8"));
  assert.ok(controls.classList.contains("top-20"));
  await button.trigger("click");
  assert.deepEqual(forms, [{ target: "_blank", action: "http://localhost/api/workspaces/html-readonly/preview/open", path: "repo/中文 page.HTM" }]);
  assert.equal(document.querySelector('form[action*="preview/open"]'), null);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test("超过 20 MiB 时不下载；恰好上限仍显示；Blob 增长超限不创建 URL", async () => {
  const { wrapper, store } = setup();
  requestHandler = (type, path) => type === "stat" ? file(path === "large.png" ? EDITOR_IMAGE_MAX_BYTES + 1 : EDITOR_IMAGE_MAX_BYTES) : undefined;
  await open(store, "large.png");
  assert.match(wrapper.text(), /图片超过 20 MiB/);
  assert.deepEqual(requests.map((request) => request.type), ["stat"]);
  assert.equal(createdUrls.length, 0);
  await open(store, "exact.png", "preview");
  assert.equal(wrapper.findAll("img").length, 1);
  requestHandler = (type) => type === "download" ? new Blob([new Uint8Array(EDITOR_IMAGE_MAX_BYTES + 1)]) : undefined;
  await open(store, "grown.svg");
  assert.match(wrapper.text(), /图片超过 20 MiB/);
  assert.equal(wrapper.find("img").exists(), false);
  assert.equal(createdUrls.length, 1);
  assert.equal(modelsCreated, 0);
});

test("损坏图片和请求失败显示默认失败提示，不保存、不创建 model", async () => {
  const { wrapper, workspaceId, store } = setup();
  await open(store, "broken.png", "preview");
  const url = createdUrls[0]!.url;
  await wrapper.get("img").trigger("error");
  assert.match(wrapper.text(), /图片加载失败或格式不受支持/);
  assert.equal(wrapper.find("img").exists(), false);
  assert.deepEqual(revokedUrls, [url]);
  assert.equal(tab(workspaceId).readOnly, true);
  requestHandler = (type) => { if (type === "download") throw new Error("offline"); };
  await refresh?.();
  await settle();
  assert.match(wrapper.text(), /图片加载失败或格式不受支持/);
  assert.equal(createdUrls.length, 1);
  assert.equal(modelsCreated, 0);
  assert.equal(requests.some((request) => request.type === "write-text"), false);
});

for (const action of ["close", "closeOthers", "closeAll", "delete", "reset", "replace"] as const) {
  test(`图片 ${action} 集中释放 URL 且不重复释放`, async () => {
    const { store } = setup();
    await open(store, "a.png");
    const first = createdUrls[0]!.url;
    await open(store, "b.png");
    const second = createdUrls[1]!.url;
    if (action === "close") store.closeTab("file:a.png");
    else if (action === "closeOthers") store.closeTabs(["file:a.png"]);
    else if (action === "delete") store.closePathTree("a.png");
    else if (action === "closeAll") store.closeAllTabs();
    else if (action === "reset") store.reset();
    else {
      const previous = store.tabs.find((item) => item.key === "file:a.png") as FileEditorTab;
      store.upsertTab({ ...previous, image: { status: "error", reason: "load_failed" } });
    }
    assert.equal(revokedUrls.filter((url) => url === first).length, 1);
    if (action === "closeAll" || action === "reset") assert.ok(revokedUrls.includes(second));
    store.closeAllTabs();
    assert.equal(revokedUrls.filter((url) => url === first).length, 1);
    assert.equal(revokedUrls.filter((url) => url === second).length, 1);
  });
}

test("图片刷新替换 URL，旧刷新晚到不会覆盖更新结果", async () => {
  const { wrapper, store } = setup();
  await open(store, "a.png");
  const initial = createdUrls[0]!.url;
  const old = deferred<Blob>();
  let downloads = 0;
  requestHandler = (type) => type === "download" ? (++downloads === 1 ? old.promise : new Blob(["new"])) : undefined;
  const oldRefresh = refresh?.();
  await settle();
  assert.deepEqual(revokedUrls, [initial]);
  assert.match(wrapper.text(), /正在加载图片/);
  await refresh?.();
  await settle();
  const current = wrapper.get("img").attributes("src");
  old.resolve(new Blob(["old"]));
  await oldRefresh;
  await settle();
  assert.equal(wrapper.get("img").attributes("src"), current);
  assert.equal(createdUrls.length, 2);
});

for (const action of ["close", "reset", "rename", "renameTree", "unmount"] as const) {
  test(`图片加载尚未完成时 ${action}：迟到 Blob 不复活 Tab 或创建 URL`, async () => {
    const { wrapper, store } = setup();
    const pending = deferred<Blob>();
    requestHandler = (type, path) => type === "download" && path === "dir/a.png" ? pending.promise : undefined;
    store.enqueueOpenFile({ path: "dir/a.png", mode: "preview" });
    await settle();
    assert.match(wrapper.text(), /正在加载图片/);
    if (action === "close") store.closePath("dir/a.png");
    else if (action === "reset") store.reset();
    else if (action === "rename") store.renamePath("dir/a.png", "dir/new.svg");
    else if (action === "renameTree") store.renamePathTree("dir", "renamed");
    else wrapper.unmount();
    await settle();
    const accepted = createdUrls.length;
    pending.resolve(new Blob(["old"]));
    await settle();
    assert.equal(createdUrls.length, accepted);
    assert.equal(store.tabs.some((item) => "path" in item && item.path === "dir/a.png"), action === "unmount");
    if (action === "rename") {
      assert.equal(createdUrls[0]?.blob.type, "image/svg+xml");
      assert.ok(requests.some((request) => request.type === "download" && request.path === "dir/new.svg"));
    }
    if (action === "renameTree") assert.ok(requests.some((request) => request.type === "download" && request.path === "renamed/a.png"));
  });
}

test("已加载图片重命名采用新路径和 MIME，并释放旧 URL", async () => {
  const { wrapper, store } = setup();
  await open(store, "dir/a.png");
  const initial = createdUrls[0]!.url;
  store.renamePath("dir/a.png", "dir/a.svg");
  await settle();
  assert.equal(createdUrls[1]?.blob.type, "image/svg+xml");
  assert.equal(wrapper.get("img").attributes("src"), createdUrls[1]?.url);
  assert.deepEqual(revokedUrls, [initial]);
  store.renamePathTree("dir", "newdir");
  await settle();
  assert.ok(requests.some((request) => request.type === "download" && request.path === "newdir/a.svg"));
  assert.equal(revokedUrls.length, 2);
});

test("Workspace 切换释放旧图片且同路径迟到响应不能覆盖新 Workspace", async () => {
  const { wrapper, store } = setup("images-workspace-a");
  await open(store, "ready.png");
  const oldUrl = createdUrls[0]!.url;
  const pending = deferred<Blob>();
  requestHandler = (type, path, ws) => type === "download" && ws === "images-workspace-a" && path === "same.png" ? pending.promise : undefined;
  store.enqueueOpenFile({ path: "same.png" });
  await settle();
  workspaceIds.add("images-workspace-b");
  await wrapper.setProps({ workspaceId: "images-workspace-b" });
  const nextStore = getEditorStore("images-workspace-b");
  await open(nextStore, "same.png");
  const current = wrapper.get("img").attributes("src");
  pending.resolve(new Blob(["late"]));
  await settle();
  assert.equal(wrapper.get("img").attributes("src"), current);
  assert.ok(revokedUrls.includes(oldUrl));
  assert.equal(store.tabs.length, 0);
  assert.equal(createdUrls.length, 2);
  assert.ok(requests.some((request) => request.type === "download" && request.workspaceId === "images-workspace-b"));
});

test("图片改为文本后刷新展示代码；未保存文本改为图片保留内容直到保存后刷新", async () => {
  const { wrapper, workspaceId, store } = setup();
  await open(store, "a.png");
  store.renamePath("a.png", "a.txt");
  await settle();
  assert.equal(wrapper.find("img").exists(), false);
  assert.equal(tab(workspaceId).image, undefined);
  assert.equal(tab(workspaceId).model?.getValue(), "<html>saved</html>");
  await open(store, "a.txt", "edit");
  tab(workspaceId).model?.setValue("unsaved text");
  store.renamePath("a.txt", "renamed.svg");
  await settle();
  assert.equal(tab(workspaceId).model?.getValue(), "unsaved text");
  assert.equal(tab(workspaceId).dirty, true);
  assert.equal(tab(workspaceId).image, undefined);
  assert.equal(wrapper.find("img").exists(), false);
  await refresh?.();
  assert.equal(tab(workspaceId).model?.getValue(), "unsaved text");
  await save?.();
  await settle();
  assert.equal(tab(workspaceId).dirty, false);
  await refresh?.();
  await settle();
  assert.equal(wrapper.find("img").exists(), true);
  assert.equal(tab(workspaceId).readOnly, true);
  assert.equal(tab(workspaceId).model, undefined);
});

for (const blocked of ["dirty", "saving", "conflictOpen"] as const) {
  test(`HTML ${blocked} 时禁用预览并提示先保存，handler 二次检查拦截强制点击`, async () => {
    const { wrapper, workspaceId, store } = setup();
    await open(store, "page.html");
    const current = tab(workspaceId);
    current[blocked] = true;
    await settle();
    const button = wrapper.get("button[data-editor-html-preview]");
    assert.equal(button.attributes("disabled"), "");
    assert.equal(wrapper.findComponent(Tooltip).props("title"), "请先完成保存并解决冲突，再打开预览");
    assert.equal(wrapper.findComponent(Tooltip).props("placement"), "left");
    for (const name of ["inline-flex", "w-7", "h-7"]) assert.ok(button.element.parentElement?.classList.contains(name));
    (button.element as HTMLButtonElement).disabled = false;
    await button.trigger("click");
    assert.equal(forms.length, 0);
    current[blocked] = false;
    await settle();
    await wrapper.get("button[data-editor-html-preview]").trigger("click");
    assert.equal(forms.length, 1);
  });
}

test("HTML 失焦保存尚未完成不能预览，保存成功后保持代码并可同步打开", async () => {
  const { wrapper, workspaceId, store } = setup();
  await open(store, "page.html");
  const pending = deferred<{ path: string; version: { size: number; mtimeMs: number } }>();
  requestHandler = (type) => type === "write-text" ? pending.promise : undefined;
  tab(workspaceId).model?.setValue("<html>changed</html>");
  await settle();
  assert.equal(wrapper.get("button[data-editor-html-preview]").attributes("disabled"), "");
  blur?.();
  await settle();
  assert.equal(tab(workspaceId).saving, true);
  const button = wrapper.get("button[data-editor-html-preview]");
  assert.equal(button.attributes("disabled"), "");
  const status = wrapper.get(".absolute.right-2.top-2");
  assert.match(status.text(), /正在保存/);
  assert.notEqual(button.element.closest(".absolute"), status.element);
  assert.equal(status.element.contains(button.element), false);
  (button.element as HTMLButtonElement).disabled = false;
  await button.trigger("click");
  assert.equal(forms.length, 0);
  pending.resolve({ path: "page.html", version: { size: 20, mtimeMs: 2 } });
  await settle();
  assert.equal(tab(workspaceId).saving, false);
  assert.equal(tab(workspaceId).dirty, false);
  assert.equal(tab(workspaceId).model?.getValue(), "<html>changed</html>");
  await wrapper.get("button[data-editor-html-preview]").trigger("click");
  assert.equal(forms.length, 1);
  assert.equal(forms[0]?.path, "page.html");
  assert.equal(requests.find((request) => request.type === "write-text")?.data.content, "<html>changed</html>");
});

test("previewEnabled 关闭隐藏按钮，内存预览和 diff 不进入文件浏览器预览", async () => {
  const { wrapper, store } = setup(undefined, false);
  await open(store, "page.html");
  assert.equal(wrapper.find("button[data-editor-html-preview]").exists(), false);
  await wrapper.setProps({ previewEnabled: true });
  assert.equal(wrapper.find("button[data-editor-html-preview]").exists(), true);
  store.upsertTab({ kind: "preview", key: "preview", path: "page.html", title: "Memory", text: "unsaved memory", readOnly: true });
  await settle();
  assert.equal(wrapper.get("[data-memory-preview]").text(), "unsaved memory");
  assert.equal(wrapper.find("button[data-editor-html-preview]").exists(), false);
  store.upsertTab({ kind: "diff", key: "diff", title: "Diff", path: "page.html", original: "before", modified: "after", readOnly: true });
  await settle();
  assert.equal(wrapper.get("[data-diff]").text(), "before→after");
  assert.equal(wrapper.find("button[data-editor-html-preview]").exists(), false);
  assert.deepEqual(wrapper.emitted("diffTabActiveChange")?.at(-1), [true]);
});

for (const [reason, text] of [["too_large", "文件过大"], ["binary", "二进制文件"], ["decode_failed", "文件无法解码"]] as const) {
  test(`保留原文本 ${reason} 提示，不转入图片下载或 Monaco`, async () => {
    const { wrapper, store } = setup();
    requestHandler = (type) => type === "read-text" ? { path: "a.txt", previewable: false, reason } : undefined;
    await open(store, "a.txt", "preview");
    assert.match(wrapper.text(), new RegExp(text));
    assert.equal(modelsCreated, 0);
    assert.deepEqual(requests.map((request) => request.type), ["read-text"]);
  });
}

test("图片视图卸载释放 URL，重新挂载同 Workspace 会重新读取", async () => {
  const { wrapper, store } = setup("image-remount");
  await open(store, "a.png");
  const first = createdUrls[0]!.url;
  wrapper.unmount();
  assert.deepEqual(revokedUrls, [first]);
  const next = setup("image-remount");
  await settle();
  assert.equal(next.wrapper.get("img").attributes("src"), createdUrls[1]?.url);
  assert.equal(revokedUrls.filter((url) => url === first).length, 1);
});

test("图片在 stat 等待期间关闭时不发起迟到下载", async () => {
  const { store } = setup();
  const pending = deferred<FileStatResponse>();
  requestHandler = (type) => type === "stat" ? pending.promise : undefined;
  store.enqueueOpenFile({ path: "pending.png" });
  await settle();
  store.closePath("pending.png");
  pending.resolve(file());
  await settle();
  assert.deepEqual(requests.map((request) => request.type), ["stat"]);
  assert.equal(createdUrls.length, 0);
});

type ConfirmationChange = "workspace" | "reopen" | "replace" | "rename" | "renameBack";
async function changeConfirmationTarget(context: ReturnType<typeof setup>, change: ConfirmationChange) {
  let { workspaceId, store } = context;
  if (change === "workspace") {
    workspaceId = `confirmation-workspace-${++id}`;
    workspaceIds.add(workspaceId);
    await context.wrapper.setProps({ workspaceId });
    store = getEditorStore(workspaceId);
    await open(store, "keep.txt", "preview");
    await open(store, "same.html");
  } else if (change === "reopen") {
    store.closePath("same.html");
    await open(store, "same.html");
  } else if (change === "replace") {
    const previous = tab(workspaceId);
    store.upsertTab({
      ...previous, disposable: undefined,
      model: markRaw(monaco.editor.createModel("replacement", "plaintext", monaco.Uri.parse(`inmemory://confirmation-replacement/${++id}`))),
      dirty: true, saving: false, pendingSave: false
    });
  } else {
    store.renamePath("same.html", "renamed.html");
    if (change === "renameBack") store.renamePath("renamed.html", "same.html");
  }
  const current = tab(workspaceId);
  current.model?.setValue("new unsaved content");
  // Also verify an old cancellation cannot clear the current Tab's conflict state.
  current.conflictOpen = true;
  await settle();
  return { current, store };
}

async function openSaveConflict(context: ReturnType<typeof setup>, path = "same.html") {
  await open(context.store, "keep.txt", "preview");
  await open(context.store, path);
  tab(context.workspaceId).model?.setValue("old unsaved content");
  requestHandler = (type) => {
    if (type === "write-text") throw new AxiosError("Conflict", undefined, undefined, undefined, {
      data: { message: "File changed" }, status: 409, statusText: "Conflict", headers: {}, config: {} as any
    });
  };
  save?.();
  await settle();
  assert.equal(tab(context.workspaceId).conflictOpen, true);
  assert.equal(confirmations.length, 1);
  const dialog = confirmations[0]!;
  requestHandler = undefined;
  return dialog;
}

for (const action of ["onOk", "onCancel"] as const) {
  for (const change of ["workspace", "reopen", "replace", "rename", "renameBack"] as const) {
    test(`H1 保存 409 后 ${change}，旧冲突 ${action} 不读取/保存或改变新 Tab`, async () => {
      const context = setup();
      const dialog = await openSaveConflict(context);
      const { current, store } = await changeConfirmationTarget(context, change);
      const requestCount = requests.length;
      const keys = store.tabs.map((item) => item.key);
      await (dialog[action] as () => unknown)();
      await settle();
      assert.equal(current.model?.getValue(), "new unsaved content");
      assert.equal(current.dirty, true);
      assert.equal(current.conflictOpen, true);
      assert.deepEqual(store.tabs.map((item) => item.key), keys);
      assert.equal(requests.length, requestCount);
    });
  }
}

for (const mode of ["single", "others", "all"] as const) {
  for (const change of ["workspace", "reopen", "replace", "rename", "renameBack"] as const) {
    test(`H2 ${mode} 关闭确认后 ${change}，旧 onOk 不关闭新 Tab`, async () => {
      const context = setup();
      await open(context.store, "keep.txt", "preview");
      await open(context.store, "same.html");
      tab(context.workspaceId).model?.setValue("old unsaved content");
      const tabs = context.wrapper.findComponent({ name: "EditorTabs" });
      if (mode === "single") tabs.props("requestCloseTab")("file:same.html");
      else if (mode === "others") tabs.props("requestCloseOtherTabs")("file:keep.txt");
      else tabs.props("requestCloseAllTabs")();
      assert.equal(confirmations.length, 1);
      const dialog = confirmations[0]!;
      const { current, store } = await changeConfirmationTarget(context, change);
      const requestCount = requests.length;
      const keys = store.tabs.map((item) => item.key);
      await (dialog.onOk as () => unknown)();
      await settle();
      assert.equal(current.model?.isDisposed(), false);
      assert.equal(current.model?.getValue(), "new unsaved content");
      assert.equal(current.dirty, true);
      assert.deepEqual(store.tabs.map((item) => item.key), keys);
      assert.equal(requests.length, requestCount);
    });
  }
}

for (const action of ["onOk", "onCancel"] as const) {
  test(`当前保存冲突 ${action} 仍可执行原重新加载/强制保存`, async () => {
    const context = setup();
    const dialog = await openSaveConflict(context);
    const previous = requests.length;
    await (dialog[action] as () => unknown)();
    await settle();
    assert.equal(tab(context.workspaceId).conflictOpen, false);
    assert.equal(tab(context.workspaceId).dirty, false);
    if (action === "onOk") assert.equal(requests[previous]?.type, "read-text");
    else {
      assert.equal(requests[previous]?.type, "write-text");
      assert.equal(requests[previous]?.data.force, true);
      assert.equal(requests[previous]?.data.content, "old unsaved content");
    }
  });
}

for (const mode of ["single", "others", "all"] as const) {
  test(`当前 ${mode} 关闭确认仍关闭选定旧 Tab`, async () => {
    const context = setup();
    await open(context.store, "keep.txt", "preview");
    await open(context.store, "same.html");
    tab(context.workspaceId).model?.setValue("old unsaved content");
    const tabs = context.wrapper.findComponent({ name: "EditorTabs" });
    if (mode === "single") tabs.props("requestCloseTab")("file:same.html");
    else if (mode === "others") tabs.props("requestCloseOtherTabs")("file:keep.txt");
    else tabs.props("requestCloseAllTabs")();
    await (confirmations[0]!.onOk as () => unknown)();
    assert.deepEqual(context.store.tabs.map((item) => item.key), mode === "all" ? [] : ["file:keep.txt"]);
  });
}

function renameConflictedFile(store: ReturnType<typeof getEditorStore>, kind: "file" | "tree" | "back") {
  if (kind === "tree") store.renamePathTree("dir", "renamed");
  else {
    store.renamePath("dir/same.html", "dir/renamed.html");
    if (kind === "back") store.renamePath("dir/renamed.html", "dir/same.html");
  }
  return kind === "tree" ? "renamed/same.html" : kind === "back" ? "dir/same.html" : "dir/renamed.html";
}

for (const kind of ["file", "tree", "back"] as const) {
  for (const action of ["onOk", "onCancel"] as const) {
    test(`M1 真实 409→${kind} rename→旧 ${action} 后保留内容，新路径可保存/刷新/预览`, async () => {
      const context = setup();
      const oldDialog = await openSaveConflict(context, "dir/same.html");
      const path = renameConflictedFile(context.store, kind);
      await settle();
      const current = tab(context.workspaceId);
      assert.equal(current.conflictOpen, false);
      const previous = requests.length;
      await (oldDialog[action] as () => unknown)();
      await settle();
      assert.equal(current.model?.getValue(), "old unsaved content");
      assert.equal(current.dirty, true);
      assert.equal(current.conflictOpen, false);
      assert.equal(requests.length, previous);
      save?.();
      await settle();
      assert.equal(requests[previous]?.type, "write-text");
      assert.equal(requests[previous]?.path, path);
      assert.equal(current.model?.getValue(), "old unsaved content");
      assert.equal(current.dirty, false);
      assert.equal(context.wrapper.get("button[data-editor-html-preview]").attributes("disabled"), undefined);
      await context.wrapper.get("button[data-editor-html-preview]").trigger("click");
      assert.equal(forms[0]?.path, path);
      await refresh?.();
      assert.equal(requests.at(-1)?.type, "read-text");
      assert.equal(requests.at(-1)?.path, path);
      assert.equal(current.conflictOpen, false);
    });

    test(`M1 真实 409→${kind} rename→再次 409，旧 ${action} 不清除新冲突`, async () => {
      const context = setup();
      const oldDialog = await openSaveConflict(context, "dir/same.html");
      const path = renameConflictedFile(context.store, kind);
      await settle();
      assert.equal(tab(context.workspaceId).conflictOpen, false);
      requestHandler = (type) => {
        if (type === "write-text") throw new AxiosError("Conflict", undefined, undefined, undefined, {
          data: { message: "File changed again" }, status: 409, statusText: "Conflict", headers: {}, config: {} as any
        });
      };
      save?.();
      await settle();
      assert.equal(confirmations.length, 2);
      assert.equal(tab(context.workspaceId).conflictOpen, true);
      const previous = requests.length;
      await (oldDialog[action] as () => unknown)();
      await settle();
      assert.equal(tab(context.workspaceId).conflictOpen, true);
      assert.equal(tab(context.workspaceId).model?.getValue(), "old unsaved content");
      assert.equal(requests.length, previous);
      requestHandler = undefined;
      await (confirmations[1]!.onCancel as () => unknown)();
      await settle();
      assert.equal(requests.at(-1)?.path, path);
      assert.equal(requests.at(-1)?.data.force, true);
      assert.equal(tab(context.workspaceId).conflictOpen, false);
      assert.equal(tab(context.workspaceId).dirty, false);
    });
  }
}
