import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { defineComponent, getCurrentInstance, h, inject, nextTick, provide, ref, type InjectionKey } from "vue";
import { mount } from "@vue/test-utils";
import { AxiosError, type InternalAxiosRequestConfig } from "axios";
import { message } from "ant-design-vue";
import { createI18n } from "vue-i18n";
import type { FileEntry, WorkspaceFileExtractResponse } from "@agent-workbench/shared";
import { apiClient, ApiError, extractWorkspaceArchive } from "@/shared/api";
import zhCN from "@/shared/i18n/locales/zh-CN";
import enUS from "@/shared/i18n/locales/en-US";
import { workspaceHostKey } from "../../host";
import FileExplorerToolView from "./FileExplorerToolView.vue";
import type { TreeNode } from "./types";

// Keep the real tree/view and their event wiring. Stub only Ant overlay/render plumbing.
const selectedDropdown = ref(0);
let nextDropdown = 0;
const menuClick: InjectionKey<(key: string) => void> = Symbol("menu-click");
const Menu = defineComponent({
  emits: ["click"],
  setup(_props, { slots, emit }) {
    provide(menuClick, (key) => emit("click", { key }));
    return () => h("div", { role: "menu" }, slots.default?.());
  }
});
const MenuItem = defineComponent({
  props: { disabled: Boolean },
  setup(props, { slots }) {
    const key = String(getCurrentInstance()!.vnode.key);
    const click = inject(menuClick)!;
    return () => h("button", { type: "button", "data-action": key, disabled: props.disabled, onClick: () => { if (!props.disabled) click(key); } }, slots.default?.());
  }
});
const Dropdown = defineComponent({
  setup(_props, { slots }) {
    const id = ++nextDropdown;
    return () => h("div", { onContextmenu: () => { selectedDropdown.value = id; } }, [slots.default?.(), selectedDropdown.value === id ? slots.overlay?.() : null]);
  }
});
const Tree = defineComponent({
  props: ["treeData", "expandedKeys", "selectedKeys", "loadData", "blockNode", "showLine"],
  setup(props, { slots }) {
    const nodes = (items: TreeNode[]): ReturnType<typeof h>[] => items.flatMap((item) => [
      h("div", { key: item.key, "data-entry": item.data.path }, slots.title?.({ title: item.title, dataRef: item })),
      ...nodes(item.children ?? [])
    ]);
    return () => h("div", nodes(props.treeData ?? []));
  }
});
const stubs = {
  "a-tree": Tree, "a-dropdown": Dropdown, "a-menu": Menu, "a-menu-item": MenuItem,
  "a-menu-divider": { template: "<hr />" },
  "a-tooltip": { template: "<span><slot /></span>" },
  "a-button": { props: ["loading"], template: "<button><slot name='icon' /><slot /></button>" },
  "a-modal": { props: ["open"], template: "<section v-if='open'><slot /></section>" },
  "a-form": { template: "<form><slot /></form>" },
  "a-form-item": { template: "<label><slot /></label>" },
  "a-input": true
};
const wrappers: Array<ReturnType<typeof mount>> = [];
const originalAdapter = apiClient.defaults.adapter;
const originalMessages = { loading: message.loading, success: message.success, warning: message.warning, error: message.error, destroy: message.destroy };
const messages: Array<{ kind: string; content?: string; key?: string }> = [];
const requests: Array<{ action: string; workspaceId: string; path: string; url: string; signal: unknown; body: unknown }> = [];
const events: unknown[] = [];
let refreshCommand: (() => void | Promise<void>) | undefined;
let extract: (config: InternalAxiosRequestConfig, data: { path: string }) => Promise<WorkspaceFileExtractResponse>;
let list: (workspaceId: string, dir: string) => Promise<FileEntry[]>;

const entry = (path: string, kind: "file" | "dir" = "file"): FileEntry => ({ path, name: path.slice(path.lastIndexOf("/") + 1), kind, mtimeMs: 0 });
const result = (count = 1): WorkspaceFileExtractResponse => ({ path: "A.ZIP", dir: "", format: "zip", topLevelCount: count, fileCount: count, directoryCount: 0, extractedBytes: count });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const turns = async () => { await nextTick(); await new Promise<void>((resolve) => setImmediate(resolve)); await nextTick(); };
function httpFailure(config: InternalAxiosRequestConfig, status: number, code?: string) {
  return new AxiosError("/private/fake-transport-path", "ERR_BAD_RESPONSE", config, undefined, {
    config, status, statusText: "Rejected", headers: {}, data: { code, message: "/private/fake-backend-content" }
  });
}
function setup() {
  messages.length = 0; requests.length = 0; events.length = 0;
  extract = async () => result();
  list = async (_workspaceId, dir) => dir ? [entry(`${dir}/nested.ZIP`)] : [
    ...["A.ZIP", "B.tar", "C.TaR.Gz", "D.tGz", "plain.gz", "a.rar", "a.7z", "a.tar.bz2", "a.zip.txt"].map((path) => entry(path)),
    entry("folder.zip", "dir"), entry("downloads", "dir")
  ];
  for (const kind of ["loading", "success", "warning", "error"] as const) {
    Object.assign(message, { [kind]: (value: string | { content: string; key?: string }) => {
      messages.push({ kind, ...(typeof value === "string" ? { content: value } : value) });
      return () => {};
    } });
  }
  message.destroy = ((key?: string) => { messages.push({ kind: "destroy", key }); }) as typeof message.destroy;
  apiClient.defaults.adapter = async (config) => {
    const match = /\/workspaces\/([^/]+)\/files\/(list|extract)$/.exec(config.url ?? "");
    assert.ok(match, `unexpected test endpoint: ${config.url}`);
    const workspaceId = decodeURIComponent(match[1]!);
    const action = match[2]!;
    const body = typeof config.data === "string" ? JSON.parse(config.data) : config.data;
    requests.push({ action, workspaceId, path: body?.path ?? body?.dir ?? "", url: config.url!, signal: config.signal, body });
    const data = action === "list" ? { entries: await list(workspaceId, body.dir ?? "") } : await extract(config, body);
    return { config, data, status: 200, statusText: "OK", headers: {} };
  };
}
async function mountView(workspaceId = "one", attachTo?: HTMLElement) {
  const i18n = createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN, "en-US": enUS } });
  const wrapper = mount(FileExplorerToolView, {
    attachTo,
    props: { workspaceId, toolId: "files", previewEnabled: false, workspaceRepos: [] },
    global: {
      plugins: [i18n], stubs,
      provide: { [workspaceHostKey as symbol]: {
        openTool() {}, minimizeTool() {}, toggleMinimize() {}, setToolDot() {},
        callFrom: (...args: unknown[]) => { events.push(args); },
        emitToolEvent: (...args: unknown[]) => { events.push(args); },
        registerToolCommands: (_toolId: string, commands: { refresh?: () => void | Promise<void> }) => {
          refreshCommand = commands.refresh;
          return () => { refreshCommand = undefined; };
        }
      } }
    }
  });
  wrappers.push(wrapper);
  await turns();
  return { wrapper, i18n };
}
async function context(wrapper: ReturnType<typeof mount>, path: string) {
  const row = wrapper.findAll("[data-entry]").find((item) => item.attributes("data-entry") === path);
  assert.ok(row, `missing test node ${path}`);
  await row.get("span").trigger("contextmenu");
  await nextTick();
}
const notices = () => messages.filter((item) => ["success", "error", "warning"].includes(item.kind));
const extractRequests = () => requests.filter((request) => request.action === "extract");

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  apiClient.defaults.adapter = originalAdapter;
  Object.assign(message, originalMessages);
  selectedDropdown.value = 0;
  refreshCommand = undefined;
});

test("文件标题使用统一的12px字号、600字重和12px左内边距", async () => {
  setup();
  const { wrapper } = await mountView("one", document.body);
  const title = wrapper.get(".font-semibold");
  assert.equal(title.text(), zhCN.files.title);
  assert.ok(title.classes().includes("text-xs"));
  const heading = title.element.parentElement!;
  assert.ok(heading.classList.contains("pl-3"));
  assert.ok(!heading.classList.contains("px-2"));
  const foreground = "rgb(230, 230, 230)";
  (wrapper.element as HTMLElement).style.color = foreground;
  assert.equal(getComputedStyle(title.element).color, foreground, "标题继承主文字色");
});

test("extract API wrapper uses shared request shape, encodes workspace IDs and preserves ApiError status/code", async () => {
  setup();
  const value = await extractWorkspaceArchive({ workspaceId: "team/a b?", path: " folder/源.ZIP " });
  assert.equal(value.topLevelCount, 1);
  assert.equal(requests[0]!.url, "/workspaces/team%2Fa%20b%3F/files/extract");
  assert.deepEqual(requests[0]!.body, { path: " folder/源.ZIP " });
  extract = async (config) => { throw httpFailure(config, 409, "ARCHIVE_TARGET_CONFLICT"); };
  await assert.rejects(extractWorkspaceArchive({ workspaceId: "one", path: "A.ZIP" }), (error: unknown) =>
    error instanceof ApiError && error.status === 409 && error.code === "ARCHIVE_TARGET_CONFLICT");
  extract = async (config) => { throw new AxiosError("/private/fake-network", "ERR_NETWORK", config); };
  await assert.rejects(extractWorkspaceArchive({ workspaceId: "one", path: "A.ZIP" }), (error: unknown) =>
    error instanceof ApiError && error.status === undefined);
});

test("A-UI-01/08: real tree menu only exposes supported ordinary files and translates Extract", async () => {
  setup();
  const { wrapper, i18n } = await mountView();
  for (const path of ["A.ZIP", "B.tar", "C.TaR.Gz", "D.tGz"]) {
    await context(wrapper, path);
    assert.equal(wrapper.get('[data-action="extract"]').text(), "解压");
  }
  for (const path of ["folder.zip", "plain.gz", "a.rar", "a.7z", "a.tar.bz2", "a.zip.txt", ""]) {
    await context(wrapper, path);
    assert.equal(wrapper.find('[data-action="extract"]').exists(), false, path);
  }
  i18n.global.locale.value = "en-US";
  await context(wrapper, "A.ZIP");
  assert.equal(wrapper.get('[data-action="extract"]').text(), "Extract");
});

test("A-UI-02/03/04: menu dispatch captures the current node, disables all extract menus and never emits editor upload events", async () => {
  setup();
  const reply = deferred<WorkspaceFileExtractResponse>();
  extract = () => reply.promise;
  const { wrapper } = await mountView();
  await context(wrapper, "A.ZIP");
  await wrapper.get('[data-action="extract"]').trigger("click");
  await context(wrapper, "B.tar");
  assert.equal(wrapper.get('[data-action="extract"]').attributes("disabled"), "");
  wrapper.findComponent(Menu).vm.$emit("click", { key: "extract" }); // Bypass disabled chrome to exercise the action guard too.
  await turns();
  assert.equal(extractRequests().length, 1);
  assert.equal(extractRequests()[0]!.path, "A.ZIP");
  reply.resolve(result());
  await turns();
  assert.equal(requests.filter((request) => request.action === "list").length, 2);
  assert.deepEqual(notices(), [{ kind: "success", content: zhCN.files.extract.success }]);
  assert.equal(wrapper.get('[data-action="extract"]').attributes("disabled"), undefined);
  assert.deepEqual(events, []);
  assert.equal(messages.filter((item) => item.kind === "destroy").length, 1);
});

test("A-UI-02: nested source refresh uses the captured parent after selection changes", async () => {
  setup();
  const reply = deferred<WorkspaceFileExtractResponse>();
  extract = () => reply.promise;
  const { wrapper } = await mountView();
  const folder = wrapper.findAll("[data-entry]").find((item) => item.attributes("data-entry") === "downloads")!;
  await folder.get("span").trigger("dblclick");
  await turns();
  await context(wrapper, "downloads/nested.ZIP");
  await wrapper.get('[data-action="extract"]').trigger("click");
  await context(wrapper, "B.tar");
  reply.resolve(result());
  await turns();
  assert.equal(extractRequests()[0]!.path, "downloads/nested.ZIP");
  assert.equal(requests.at(-1)!.action, "list");
  assert.equal(requests.at(-1)!.path, "downloads");
  assert.deepEqual(events, []);
});

test("A-UI-04/06: empty results and post-success refresh failures have distinct feedback", async () => {
  setup();
  const { wrapper } = await mountView();
  extract = async () => result(0);
  await context(wrapper, "A.ZIP");
  await wrapper.get('[data-action="extract"]').trigger("click");
  await turns();
  assert.equal(notices().at(-1)!.content, zhCN.files.extract.empty);
  extract = async () => result();
  list = async () => { throw new Error("/private/fake-refresh"); };
  await context(wrapper, "A.ZIP");
  await wrapper.get('[data-action="extract"]').trigger("click");
  await turns();
  assert.deepEqual(notices().at(-1), { kind: "warning", content: zhCN.files.extract.refreshFailed });
  assert.equal(notices().filter((item) => item.kind === "error").length, 0);
});

test("A-UI-07/08/API-03: localized business failure survives a failed refresh without leaking transport text", async () => {
  setup();
  const { wrapper, i18n } = await mountView();
  i18n.global.locale.value = "en-US";
  extract = async (config) => { throw httpFailure(config, 409, "ARCHIVE_TARGET_CONFLICT"); };
  list = async () => { throw new Error("/private/fake-refresh"); };
  await context(wrapper, "A.ZIP");
  await wrapper.get('[data-action="extract"]').trigger("click");
  await turns();
  assert.deepEqual(notices(), [{ kind: "error", content: enUS.files.extract.errors.targetConflict }]);
  assert.doesNotMatch(JSON.stringify(messages), /private|fake-backend|fake-refresh|fake-transport/);
});

test("A-UI-07/PUB-14: proxy failure is an unknown result, not a definite failure or automatic retry", async () => {
  setup();
  const { wrapper } = await mountView();
  extract = async (config) => { throw httpFailure(config, 504); };
  await context(wrapper, "A.ZIP");
  await wrapper.get('[data-action="extract"]').trigger("click");
  await turns();
  assert.deepEqual(notices(), [{ kind: "warning", content: zhCN.files.extract.resultUnknown }]);
  assert.equal(extractRequests().length, 1);
  assert.equal(extractRequests()[0]!.signal, undefined);
  assert.equal(requests.filter((request) => request.action === "list").length, 2);
});

test("A-UI-05: changing Workspace invalidates old work without clearing a newer request", async () => {
  setup();
  const old = deferred<WorkspaceFileExtractResponse>();
  const current = deferred<WorkspaceFileExtractResponse>();
  extract = (config) => config.url!.includes("/one/") ? old.promise : current.promise;
  const { wrapper } = await mountView();
  await context(wrapper, "A.ZIP");
  await wrapper.get('[data-action="extract"]').trigger("click");
  const oldKey = messages.find((item) => item.kind === "loading")!.key;
  await wrapper.setProps({ workspaceId: "two" });
  await turns();
  assert.ok(messages.some((item) => item.kind === "destroy" && item.key === oldKey));
  await context(wrapper, "B.tar");
  await wrapper.get('[data-action="extract"]').trigger("click");
  old.resolve(result());
  await turns();
  assert.equal(notices().length, 0);
  assert.equal(wrapper.get('[data-action="extract"]').attributes("disabled"), "");
  assert.equal(requests.filter((request) => request.action === "list" && request.workspaceId === "one").length, 1);
  current.resolve(result());
  await turns();
  assert.equal(notices().length, 1);
  assert.equal(wrapper.get('[data-action="extract"]').attributes("disabled"), undefined);
  assert.equal(requests.filter((request) => request.action === "list" && request.workspaceId === "two").length, 2);
});

test("A-UI-05/09: hidden view stays busy, visible refresh is unchanged, and unmount releases loading without cancelling the backend", async () => {
  setup();
  const reply = deferred<WorkspaceFileExtractResponse>();
  extract = () => reply.promise;
  const { wrapper } = await mountView();
  await context(wrapper, "A.ZIP");
  await wrapper.get('[data-action="extract"]').trigger("click");
  (wrapper.element as HTMLElement).style.display = "none";
  await turns();
  assert.equal(messages.filter((item) => item.kind === "destroy").length, 0);
  (wrapper.element as HTMLElement).style.display = "";
  await refreshCommand?.();
  await context(wrapper, "A.ZIP");
  assert.equal(wrapper.get('[data-action="extract"]').attributes("disabled"), "");
  const listCount = requests.filter((request) => request.action === "list").length;
  wrapper.unmount();
  wrappers.splice(wrappers.indexOf(wrapper), 1);
  assert.equal(refreshCommand, undefined);
  assert.equal(messages.filter((item) => item.kind === "destroy").length, 1);
  reply.reject(new Error("/private/fake-after-unmount"));
  await turns();
  assert.equal(notices().length, 0);
  assert.equal(requests.filter((request) => request.action === "list").length, listCount);
  assert.equal(extractRequests()[0]!.signal, undefined);
});

test("A-UI-08/09: stale menu delegates source revalidation to API and cleanup failure warns about possible output", async () => {
  setup();
  const { wrapper } = await mountView();
  extract = async (config) => { throw httpFailure(config, 404, "ARCHIVE_SOURCE_NOT_FOUND"); };
  await context(wrapper, "A.ZIP");
  await wrapper.get('[data-action="extract"]').trigger("click");
  await turns();
  assert.equal(notices().at(-1)!.content, zhCN.files.extract.errors.sourceNotFound);
  extract = async (config) => { throw httpFailure(config, 500, "ARCHIVE_CLEANUP_INCOMPLETE"); };
  await context(wrapper, "A.ZIP");
  await wrapper.get('[data-action="extract"]').trigger("click");
  await turns();
  assert.deepEqual(notices().at(-1), { kind: "warning", content: zhCN.files.extract.errors.cleanupIncomplete });
  assert.equal(extractRequests().length, 2);
});
