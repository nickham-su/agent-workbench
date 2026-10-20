import assert from "node:assert/strict";
import test, { afterEach, beforeEach, mock } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import { defineComponent, h, KeepAlive, nextTick, ref } from "vue";
import { mount, shallowMount, type VueWrapper } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { Dropdown, Menu, message } from "ant-design-vue";
import type { ChangeItem, GitTarget, WorkspaceDetail, WorkspaceGitStatusResponse } from "@agent-workbench/shared";
import { apiClient } from "@/shared/api";
import zhCN from "@/shared/i18n/locales/zh-CN";
import enUS from "@/shared/i18n/locales/en-US";
import { workspaceHostKey } from "../../host";

Object.defineProperties(globalThis, {
  self: { value: window, configurable: true }, localStorage: { value: window.localStorage, configurable: true },
  UIEvent: { value: window.UIEvent, configurable: true }, CSS: { value: window.CSS, configurable: true }
});
class TestResizeObserver {
  static instances: TestResizeObserver[] = [];
  targets = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) { TestResizeObserver.instances.push(this); }
  observe(target: Element) { this.targets.add(target); }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnect() { this.targets.clear(); }
  emit(target: Element, width: number) {
    this.callback([{ target, contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
}
Object.defineProperty(globalThis, "ResizeObserver", { value: TestResizeObserver, configurable: true });
const { default: Tool } = await import("./CodeReviewToolView.vue");
const { default: Panel } = await import("./CodeReviewPanel.vue");
const { default: Layout } = await import("../../views/WorkspaceLayout.vue");
const { default: Header } = await import("../../components/WorkspaceHeader.vue");
const wsId = "review-layout";
const repos: WorkspaceDetail["repos"] = Array.from({ length: 8 }, (_, index) => ({
  dirName: `repo-${index + 1}`, repo: { id: `id-${index + 1}`, url: `https://example.invalid/repo-${index + 1}.git` }
}));
const statuses: WorkspaceGitStatusResponse["repos"] = repos.map((repo, index) => ({
  repoId: repo.repo.id, dirName: repo.dirName, hasChanges: index % 2 === 0,
  head: { branch: index === 7 ? "feature/a-very-long-branch-name-for-overflow-checking" : "main", detached: false, sha: "abcdef123456" }
}));
const target = (dirName = "repo-1"): GitTarget => ({ kind: "workspaceRepo", workspaceId: wsId, dirName });
const wrappers: VueWrapper[] = [];
const originalAdapter = apiClient.defaults.adapter;
const originalSuccess = message.success;
const originalWarning = message.warning;
const originalBodyStyle = { userSelect: document.body.style.userSelect, cursor: document.body.style.cursor };
const repoWidthKey = (id = wsId) => `agent-workbench.workspace.codeReview.repoWidth.v1.${id}`;
const requests: Array<{ path: string; body: any }> = [];
let files: Record<string, ChangeItem[]> = {};
const turn = async () => { await nextTick(); await new Promise<void>((resolve) => setImmediate(resolve)); await nextTick(); };
const settle = async () => { for (let i = 0; i < 5; i++) await turn(); };
const i18n = (locale = "zh-CN") => createI18n({ legacy: false, locale, messages: { "zh-CN": zhCN, "en-US": enUS } });
const state = (wrapper: VueWrapper): any => (wrapper.vm as any).$?.setupState;
const host = { callFrom() {}, setToolDot() {}, registerToolCommands: () => () => {} };
const stubs = {
  "a-button": { template: '<button><slot /><slot name="icon" /></button>' },
  "a-tooltip": { template: "<span><slot /></span>" },
  "a-dropdown": { template: "<div><slot /></div>" },
  "a-modal": { props: ["open"], template: '<section data-modal v-if="open"><slot /><slot name="footer" /></section>' },
  "a-form": { template: "<div><slot /></div>" }, "a-form-item": { template: "<div><slot /></div>" },
  "a-space": { template: "<div><slot /></div>" }, "a-textarea": true,
  "a-layout": { template: "<div><slot /></div>" }, "a-layout-content": { template: "<div><slot /></div>" },
  "a-select": true, "a-menu": true, "a-menu-item": true, "a-menu-divider": true, "a-divider": true, WorkspaceDock: true
};
function mountTool(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ action: string; target: GitTarget }> = [];
  const selected: string[] = [];
  const wrapper = mount(Tool, {
    attachTo: document.body,
    props: { workspaceId: wsId, target: target(), toolId: "codeReview", gitBusy: false, beginGitOp: () => () => {},
      repos, repoStatuses: statuses, selectedRepoDirName: "repo-1", selectRepo: (dirName) => selected.push(dirName),
      checkout: async (target) => { calls.push({ action: "checkout", target }); },
      pull: async (target) => { calls.push({ action: "pull", target }); },
      push: async (target) => { calls.push({ action: "push", target }); }, ...overrides },
    global: { plugins: [i18n()], components: { ADropdown: Dropdown, AMenu: Menu, AMenuItem: Menu.Item },
      stubs: { CodeReviewPanel: true }, provide: { [workspaceHostKey as symbol]: host } }
  });
  wrappers.push(wrapper);
  return { wrapper, calls, selected };
}
function resize(wrapper: VueWrapper, width: number) {
  const element = wrapper.get(".code-review-tool").element;
  const observer = TestResizeObserver.instances.find((item) => item.targets.has(element));
  assert.ok(observer, "actual tool element must be observed"); observer.emit(element, width);
}
function displayedRepoWidth(wrapper: VueWrapper) {
  return Number((wrapper.get(".code-review-tool").element as HTMLElement).style.getPropertyValue("--review-repo-width").replace("px", ""));
}
function pointer(element: EventTarget, type: string, options: PointerEventInit = {}) {
  const event = new window.PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, isPrimary: true, clientX: 264, ...options });
  element.dispatchEvent(event);
  return event;
}
function dragTo(wrapper: VueWrapper, width: number) {
  pointer(wrapper.get(".review-repo-divider").element, "pointerdown", { clientX: displayedRepoWidth(wrapper) });
  pointer(window, "pointermove", { clientX: width });
}
function repositoryStyle(wrapper: VueWrapper) {
  const element = wrapper.get(".review-repositories").element;
  // happy-dom caches ancestor selectors on grandchildren after a root class
  // change. Invalidate that cache, without changing any production style rule.
  element.classList.add("css-contract-probe");
  element.classList.remove("css-contract-probe");
  return getComputedStyle(element);
}
function mountPanel(overrides: Record<string, unknown> = {}) {
  const wrapper = shallowMount(Panel, {
    attachTo: document.body,
    props: { workspaceId: wsId, toolId: "codeReview", target: target(), gitBusy: false, beginGitOp: () => () => {}, ...overrides },
    global: { plugins: [i18n()], stubs, provide: { [workspaceHostKey as symbol]: host } }
  });
  wrappers.push(wrapper); return wrapper;
}
// vite-node transforms SFC scripts without browser CSS injection. Load the actual
// scoped rules and compile their real Tailwind classes with the app config.
// These are CSS contract checks, not browser layout or rendered pixel testing.
const sources = ["CodeReviewToolView.vue", "CodeReviewPanel.vue"].map((file) => readFileSync(new URL(file, import.meta.url), "utf8"));
const tailwindConfig = createRequire(import.meta.url)("../../../../../tailwind.config.cjs");
const utilities = await postcss([tailwindcss({
  ...tailwindConfig, content: sources.map((raw) => ({ raw, extension: "vue" }))
})]).process(readFileSync(new URL("../../../../shared/styles/tailwind.css", import.meta.url), "utf8"), { from: undefined });
const styles = document.createElement("style");
styles.textContent = utilities.css + sources.map((source) => source.match(/<style scoped>([\s\S]*?)<\/style>/)?.[1] ?? "").join("\n");
document.head.appendChild(styles);
beforeEach(() => {
  window.localStorage.clear(); requests.length = 0;
  files = { unstaged: [{ path: "src/work.ts", status: "M" }], staged: [{ path: "src/staged.ts", status: "A" }] };
  message.success = (() => (() => {}) as any) as typeof message.success;
  message.warning = (() => (() => {}) as any) as typeof message.warning;
  apiClient.defaults.adapter = async (config) => {
    const path = config.url!; const body = typeof config.data === "string" ? JSON.parse(config.data) : config.data;
    requests.push({ path, body });
    const data = path.startsWith("/workspaces/") ? { id: wsId, title: "Review workspace", dirName: "review", repos, createdAt: 1, updatedAt: 1 } :
      path === "/git/workspace-status" ? { repos: statuses } :
      path === "/git/changes" ? { files: files[body.mode] ?? [] } :
      path === "/git/identity/status" ? { effective: { source: "repo" } } :
      path === "/git/commit" ? { sha: "123456789" } : {};
    return { data, status: 200, statusText: "OK", headers: {}, config };
  };
});
afterEach(async () => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  apiClient.defaults.adapter = originalAdapter; message.success = originalSuccess; message.warning = originalWarning;
  mock.restoreAll();
  document.body.style.userSelect = originalBodyStyle.userSelect; document.body.style.cursor = originalBodyStyle.cursor;
  TestResizeObserver.instances = []; await settle();
  document.body.innerHTML = "";
});

test("八仓库保持注册顺序，仅变更仓库有紧随名称的红点，分支和菜单可收缩", async () => {
  const { wrapper, selected } = mountTool(); await settle();
  assert.deepEqual(wrapper.findAll(".review-repository").map((row) => row.attributes("data-repo")), repos.map((repo) => repo.dirName));
  assert.equal(wrapper.findAll(".review-repo-dot").length, 4);
  assert.equal(wrapper.findAll(".review-repository.selected").length, 1);
  assert.equal(wrapper.get(".review-repository.selected").attributes("data-repo"), "repo-1");
  assert.equal(wrapper.findAll(".review-repo-name > .review-repo-dot").length, 4);
  const last = wrapper.findAll(".review-repo-branch").at(-1)!;
  assert.equal(last.text(), statuses[7]!.head.branch); assert.equal(last.attributes("title"), last.text());
  assert.equal(getComputedStyle(last.element).textOverflow, "ellipsis");
  assert.equal(getComputedStyle(last.element).whiteSpace, "nowrap");
  assert.equal(getComputedStyle(last.element).maxWidth, "45%");
  for (const row of wrapper.findAll(".review-repository")) {
    assert.deepEqual([...row.element.children].map((child) => child.tagName), ["BUTTON", "BUTTON", "BUTTON"]);
    assert.equal(row.get(".review-repo-branch").element.parentElement, row.element);
    assert.equal(row.get(".review-repo-select").find(".review-repo-branch").exists(), false);
  }
  assert.equal(getComputedStyle(wrapper.get(".review-repo-more").element).flexShrink, "0");
  assert.equal(wrapper.find("button button").exists(), false);
  assert.equal(wrapper.get(".review-tool-heading").text(), "仓库");
  assert.equal(zhCN.workspace.tools.codeReview, "代码审查", "Dock tool name is unchanged");
  assert.equal(wrapper.get(".review-tool-heading").find("button").exists(), false);
  assert.equal(wrapper.text().includes("干净"), false);
  await wrapper.setProps({ repoStatuses: [...statuses].reverse().map((status) => status.dirName === "repo-8" ? { ...status, hasChanges: true, head: { ...status.head, branch: "develop" } } : status) });
  assert.deepEqual(wrapper.findAll(".review-repository").map((row) => row.attributes("data-repo")), repos.map((repo) => repo.dirName));
  assert.equal(wrapper.findAll(".review-repo-dot").length, 5);
  assert.equal(wrapper.get('[data-repo="repo-8"] .review-repo-branch').text(), "develop");
  await wrapper.findAll(".review-repo-select")[7]!.trigger("click");
  assert.deepEqual(selected, ["repo-8"]);
  assert.equal(wrapper.findAll(".review-repository.selected").length, 1, "selection is owned by host, not menus");
});

test("非选中仓库分支按钮复用该行切分支目标，不改审查选择也不把焦点退回旧菜单", async () => {
  const { wrapper, calls, selected } = mountTool(); await settle();
  const oldTrigger = wrapper.get('[data-repo-menu="repo-7"]');
  await oldTrigger.trigger("keydown", { key: "ArrowDown" }); await settle();
  const menu = document.getElementById(oldTrigger.attributes("aria-controls")!)!;
  menu.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await settle();
  assert.equal(document.activeElement, oldTrigger.element);
  const branch = wrapper.get('[data-repo="repo-8"] .review-repo-branch');
  assert.equal(branch.attributes("aria-label"), `切换仓库 repo-8 的分支（当前：${statuses[7]!.head.branch}）`);
  assert.equal(branch.attributes("aria-haspopup"), "dialog");
  (branch.element as HTMLButtonElement).focus();
  (branch.element as HTMLButtonElement).click(); await settle();
  assert.deepEqual(calls, [{ action: "checkout", target: target("repo-8") }]);
  assert.deepEqual(selected, []);
  assert.equal(wrapper.get(".review-repository.selected").attributes("data-repo"), "repo-1");
  assert.equal(document.activeElement, branch.element, "shortcut does not restore an unrelated menu trigger");
  await wrapper.get('[data-repo="repo-8"] .review-repo-select').trigger("click");
  assert.deepEqual(selected, ["repo-8"]); assert.equal(calls.length, 1);
});

test("分支快捷入口使用原生可聚焦按钮，Enter和Space保留默认激活语义", async () => {
  const { wrapper, calls, selected } = mountTool(); await settle();
  const branch = wrapper.get('[data-repo="repo-8"] .review-repo-branch').element as HTMLButtonElement;
  assert.equal(branch.tagName, "BUTTON"); assert.equal(branch.type, "button");
  assert.equal(branch.tabIndex, 0); assert.equal(branch.disabled, false);
  branch.focus(); assert.equal(document.activeElement, branch);
  for (const key of ["Enter", " "]) {
    const down = new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    const up = new window.KeyboardEvent("keyup", { key, bubbles: true, cancelable: true });
    branch.dispatchEvent(down); branch.dispatchEvent(up);
    assert.equal(down.defaultPrevented, false); assert.equal(up.defaultPrevented, false);
    // happy-dom does not synthesize a native button click from keyboard events.
    // Simulate that UA activation; production deliberately adds no key handler.
    branch.click(); await settle();
  }
  assert.deepEqual(calls, [1, 2].map(() => ({ action: "checkout", target: target("repo-8") })));
  assert.deepEqual(selected, []);
});

test("忙碌或缺少checkout时分支快捷入口与菜单切分支项保持禁用", async () => {
  for (const overrides of [{ gitBusy: true }, { checkout: undefined }]) {
    const { wrapper, calls, selected } = mountTool(overrides); await settle();
    const branch = wrapper.get('[data-repo="repo-8"] .review-repo-branch').element as HTMLButtonElement;
    assert.equal(branch.disabled, true); branch.click(); await settle();
    assert.deepEqual(calls, []); assert.deepEqual(selected, []);
    if (!overrides.gitBusy) {
      await wrapper.get('[data-repo-menu="repo-8"]').trigger("click"); await settle();
      const item = [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent === "切换分支");
      assert.equal(item?.getAttribute("aria-disabled"), "true");
    }
  }
});

for (const [key, label] of [["checkout", "切换分支"], ["pull", "拉取"], ["push", "推送"]]) {
  test(`非选中仓库的${label}菜单使用该行目标，不切换审查选择且浮层位于body`, async () => {
    const { wrapper, calls, selected } = mountTool(); await settle();
    const trigger = wrapper.get('[data-repo-menu="repo-8"]');
    await trigger.trigger("click"); await settle();
    const popup = document.querySelector(".ant-dropdown:not(.ant-dropdown-hidden)");
    assert.ok(popup); assert.equal(wrapper.element.contains(popup), false);
    const item = [...popup.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent === label);
    assert.ok(item); (item as HTMLElement).click(); await settle();
    assert.deepEqual(calls, [{ action: key, target: target("repo-8") }]);
    assert.deepEqual(selected, []); assert.equal(trigger.attributes("aria-expanded"), "false");
  });
}

test("仓库菜单支持方向键打开和Escape关闭并恢复焦点", async () => {
  const { wrapper } = mountTool(); await settle();
  const trigger = wrapper.get('[data-repo-menu="repo-8"]');
  (trigger.element as HTMLElement).focus();
  await trigger.trigger("keydown", { key: "ArrowDown" }); await settle();
  assert.equal(trigger.attributes("aria-expanded"), "true");
  const id = trigger.attributes("aria-controls"); assert.ok(id); const menu = document.getElementById(id)!;
  assert.ok(menu); assert.equal(document.activeElement, menu.querySelector('[role="menuitem"]'));
  menu.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await settle();
  assert.equal(trigger.attributes("aria-expanded"), "false"); assert.equal(document.activeElement, trigger.element);
});

test("菜单可用方向键与Enter执行操作，外部点击和仓库滚动均关闭浮层", async () => {
  const { wrapper, calls, selected } = mountTool(); await settle();
  const trigger = wrapper.get('[data-repo-menu="repo-8"]');
  await trigger.trigger("keydown", { key: "ArrowDown" }); await settle();
  const menu = document.getElementById(trigger.attributes("aria-controls")!)!;
  document.activeElement!.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", keyCode: 40, which: 40, bubbles: true })); await nextTick();
  assert.equal(document.activeElement?.textContent, "拉取");
  document.activeElement!.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", keyCode: 13, which: 13, bubbles: true })); await settle();
  assert.deepEqual(calls, [{ action: "pull", target: target("repo-8") }]); assert.deepEqual(selected, []);
  await trigger.trigger("click"); await settle();
  document.body.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 120)); await settle();
  assert.equal(trigger.attributes("aria-expanded"), "false");
  await trigger.trigger("click"); await settle();
  await wrapper.get(".review-repositories").trigger("scroll"); await settle();
  assert.equal(trigger.attributes("aria-expanded"), "false");
});

test("仓库行复用文件行的整行矩形、间距、hover及选中蓝线样式，宽窄一致", async () => {
  const { wrapper } = mountTool(); const panel = mountPanel(); await settle();
  const fileRow = panel.get(".review-file-list .group");
  state(panel).selectFile("unstaged", "src/work.ts", undefined, false); await nextTick();
  const fileStyle = getComputedStyle(fileRow.element);
  const sharedClasses = ["w-full", "text-left", "pl-3", "pr-1", "py-1.5", "hover:bg-[var(--hover-bg)]", "border-l-2", "bg-[var(--fill-secondary)]", "border-l-[var(--info-color)]"];
  for (const width of [479, 480, 639]) {
    resize(wrapper, width); await nextTick();
    const row = wrapper.get(".review-repository.selected");
    for (const className of sharedClasses) {
      assert.ok(fileRow.classes().includes(className), `file row remains the style authority: ${className}`);
      assert.ok(row.classes().includes(className), `repo row uses the same class: ${className}`);
    }
    const rowStyle = getComputedStyle(row.element);
    for (const property of ["width", "paddingTop", "paddingBottom", "paddingLeft", "paddingRight", "borderLeftWidth", "borderLeftColor", "backgroundColor"] as const) {
      assert.equal(rowStyle[property], fileStyle[property], `${width}px: ${property}`);
    }
    assert.equal(rowStyle.borderLeftWidth, "2px");
    assert.equal(rowStyle.gap, "8px");
    assert.equal(rowStyle.boxSizing, "border-box");
    const listStyle = repositoryStyle(wrapper);
    assert.equal(listStyle.padding, "0px");
    for (const item of wrapper.findAll(".review-repository")) {
      const style = getComputedStyle(item.element);
      assert.ok(["", "0px"].includes(style.borderRadius), "no rounded cards");
      assert.ok(["", "0px"].includes(style.marginTop), "no row gaps");
      assert.ok(["", "0px"].includes(style.marginLeft), "no outer gutters");
      assert.ok(["", "0px"].includes(style.marginRight), "no outer gutters");
    }
    // Match the file row's py-1.5 around Ant's small (24px) action control.
    assert.equal(fileRow.get("button").attributes("size"), "small");
    assert.equal(getComputedStyle(wrapper.get(".review-repo-select").element).height, "24px");
    assert.equal(getComputedStyle(wrapper.get(".review-repo-select").element).padding, "0px");
    assert.equal(getComputedStyle(wrapper.get(".review-repo-more").element).height, "24px");
    const unselected = wrapper.get('[data-repo="repo-2"]');
    assert.ok(unselected.classes().includes("border-l-transparent"));
    assert.ok(!unselected.classes().includes("bg-[var(--fill-secondary)]"));
  }
});

test("窄布局少量仓库按内容自然收缩，上限基于整个标题下区域而非自身网格区", async () => {
  const { wrapper } = mountTool({ repos: repos.slice(0, 1) }); await settle();
  for (const count of [1, 2]) {
    await wrapper.setProps({ repos: repos.slice(0, count) });
    assert.equal(wrapper.findAll(".review-repository").length, count);
    const rootStyle = getComputedStyle(wrapper.element);
    const bodyStyle = getComputedStyle(wrapper.get(".review-body").element);
    const listStyle = repositoryStyle(wrapper);
    assert.equal(rootStyle.height, "100%");
    assert.equal(rootStyle.gridTemplateRows, "43px minmax(0, 1fr)");
    assert.equal(bodyStyle.height, "100%", "definite full remaining track for percentage cap");
    assert.equal(bodyStyle.display, "flex"); assert.equal(bodyStyle.flexDirection, "column");
    assert.equal(bodyStyle.gridTemplateRows, "", "no fixed 1:2 grid areas");
    assert.equal(bodyStyle.minHeight, "0");
    assert.equal(listStyle.flexGrow, "0", "small lists must not grow to the cap");
    assert.equal(listStyle.flexBasis, "auto", "natural content, not a forced third");
    assert.ok(["", "auto"].includes(listStyle.height), "no fixed list height");
    assert.equal(listStyle.maxHeight, "calc(100% / 3)");
    assert.equal(listStyle.boxSizing, "border-box", "cap includes separator and padding");
    const changesStyle = getComputedStyle(wrapper.get(".review-changes-region").element);
    assert.equal(changesStyle.flexGrow, "1", "changes get all remaining space");
    assert.equal(changesStyle.minHeight, "0"); assert.equal(changesStyle.overflow, "hidden");
  }
});

test("多仓库窄布局封顶三分之一且内滚动，切到宽布局解除上限并占满全高", async () => {
  const { wrapper } = mountTool(); await settle();
  resize(wrapper, 479); await nextTick();
  assert.equal(wrapper.classes().includes("review-wide"), false);
  assert.equal(wrapper.findAll(".review-repository").length, 8);
  assert.equal(getComputedStyle(wrapper.get(".review-body").element).display, "flex");
  const listStyle = repositoryStyle(wrapper);
  assert.equal(listStyle.maxHeight, "calc(100% / 3)");
  assert.equal(listStyle.overflowY, "auto"); assert.equal(listStyle.overflowX, "hidden"); assert.equal(listStyle.minHeight, "0");
  resize(wrapper, 480); await nextTick(); assert.equal(wrapper.classes().includes("review-wide"), true);
  assert.equal(getComputedStyle(wrapper.get(".review-body").element).display, "grid");
  assert.equal(getComputedStyle(wrapper.get(".review-body").element).height, "100%");
  assert.equal(getComputedStyle(wrapper.get(".review-body").element).gridTemplateRows, "minmax(0, 1fr)");
  assert.equal(getComputedStyle(wrapper.get(".review-body").element).gridTemplateColumns, "264px minmax(0, 1fr)");
  assert.equal(repositoryStyle(wrapper).maxHeight, "none");
  resize(wrapper, 639); await nextTick(); assert.equal(wrapper.classes().includes("review-wide"), true);
  resize(wrapper, 1000); await nextTick(); assert.equal(wrapper.classes().includes("review-wide"), true);
  resize(wrapper, 300); await nextTick(); assert.equal(wrapper.classes().includes("review-wide"), false);
  assert.equal(repositoryStyle(wrapper).maxHeight, "calc(100% / 3)");
  const panel = mountPanel(); await settle();
  assert.equal(getComputedStyle(panel.get(".review-change-groups").element).gridTemplateRows, "minmax(0, 1fr) minmax(0, 1fr)");
  assert.equal(panel.findAll(".review-file-list").length, 2);
  for (const list of panel.findAll(".review-file-list")) assert.equal(getComputedStyle(list.element).overflow, "auto");
  assert.equal(panel.findAll(".review-change-heading")[0]!.text().includes("未暂存"), true);
  assert.equal(panel.findAll(".review-change-heading")[1]!.text().includes("已暂存"), true);
});

test("内部宽布局分隔线默认264px，透明6px命中区不占列，窄布局隐藏", async () => {
  const { wrapper } = mountTool(); await settle();
  assert.equal(wrapper.find(".review-repo-divider").exists(), false);
  resize(wrapper, 900); await nextTick();
  const divider = wrapper.get(".review-repo-divider");
  assert.equal(displayedRepoWidth(wrapper), 264);
  assert.equal(divider.attributes("role"), "separator"); assert.equal(divider.attributes("tabindex"), "0");
  assert.equal(divider.attributes("aria-orientation"), "vertical");
  assert.equal(divider.attributes("aria-label"), zhCN.codeReview.repositories.resize);
  assert.equal(divider.attributes("aria-valuemin"), "200"); assert.equal(divider.attributes("aria-valuemax"), "700");
  assert.equal(divider.attributes("aria-valuenow"), "264");
  const css = getComputedStyle(divider.element);
  assert.equal(css.position, "absolute"); assert.equal(css.width, "6px"); assert.equal(css.cursor, "col-resize");
  assert.equal(css.touchAction, "none");
  resize(wrapper, 479); await nextTick(); assert.equal(wrapper.find(".review-repo-divider").exists(), false);
  assert.equal(repositoryStyle(wrapper).maxHeight, "calc(100% / 3)");
});

test("480px已为宽布局，默认264px且拖动保持仓库与变更区双侧至少200px", async () => {
  const { wrapper } = mountTool(); await settle(); resize(wrapper, 479); await nextTick();
  assert.equal(wrapper.classes().includes("review-wide"), false);
  assert.equal(wrapper.find(".review-repo-divider").exists(), false);
  resize(wrapper, 480); await nextTick();
  assert.equal(wrapper.classes().includes("review-wide"), true);
  assert.equal(displayedRepoWidth(wrapper), 264);
  assert.equal(wrapper.get(".review-repo-divider").attributes("aria-valuemax"), "280");
  dragTo(wrapper, 9999); await nextTick();
  assert.equal(displayedRepoWidth(wrapper), 280);
  assert.equal(480 - displayedRepoWidth(wrapper), 200);
  pointer(window, "pointercancel"); await nextTick();
  dragTo(wrapper, -9999); await nextTick();
  assert.equal(displayedRepoWidth(wrapper), 200);
  assert.equal(480 - displayedRepoWidth(wrapper), 280);
  pointer(window, "pointercancel"); await nextTick();
  assert.equal(displayedRepoWidth(wrapper), 264);
});

test("主指针仅调整内部列，两侧至少200px，阻止外层启动且松开只保存一次", async () => {
  const { wrapper } = mountTool(); await settle(); resize(wrapper, 900); await nextTick();
  const write = mock.method(window.Storage.prototype, "setItem");
  document.body.style.userSelect = "text"; document.body.style.cursor = "crosshair";
  let outsideStarts = 0;
  wrapper.element.addEventListener("pointerdown", () => outsideStarts++);
  const divider = wrapper.get(".review-repo-divider").element as HTMLElement;
  let capture: number | null = null; let released = 0;
  Object.assign(divider, {
    setPointerCapture(id: number) { capture = id; }, hasPointerCapture(id: number) { return id === capture; },
    releasePointerCapture(id: number) { released++; capture = null; pointer(divider, "lostpointercapture", { pointerId: id }); }
  });
  const event = pointer(divider, "pointerdown");
  assert.equal(event.defaultPrevented, true); assert.equal(outsideStarts, 0); assert.equal(capture, 1);
  assert.equal(document.body.style.userSelect, "none"); assert.equal(document.body.style.cursor, "col-resize");
  pointer(window, "pointermove", { clientX: 9999 }); await nextTick();
  assert.equal(displayedRepoWidth(wrapper), 700, "right region retains 200px");
  pointer(window, "pointermove", { clientX: -9999 }); await nextTick(); assert.equal(displayedRepoWidth(wrapper), 200);
  pointer(window, "pointermove", { clientX: 350 }); await nextTick(); assert.equal(displayedRepoWidth(wrapper), 350);
  assert.equal(getComputedStyle(wrapper.get(".review-body").element).gridTemplateColumns, "350px minmax(0, 1fr)");
  assert.equal(wrapper.classes().includes("review-wide"), true, "internal drag does not alter the tool breakpoint");
  assert.equal(wrapper.get(".review-repo-divider").attributes("aria-valuenow"), "350");
  assert.equal(write.mock.callCount(), 0, "pointer moves never write storage");
  pointer(window, "pointerup"); await nextTick();
  assert.equal(released, 1); assert.equal(document.body.style.userSelect, "text"); assert.equal(document.body.style.cursor, "crosshair");
  assert.equal(write.mock.callCount(), 1); assert.equal(localStorage.getItem(repoWidthKey()), "350");
  pointer(window, "pointermove", { clientX: 500 }); pointer(window, "pointerup"); await nextTick();
  assert.equal(displayedRepoWidth(wrapper), 350); assert.equal(write.mock.callCount(), 1);
});

test("非主按钮和次指针不能开始或接管内部拖动", async () => {
  const { wrapper } = mountTool(); await settle(); resize(wrapper, 900); await nextTick();
  const divider = wrapper.get(".review-repo-divider").element;
  pointer(divider, "pointerdown", { button: 2 }); pointer(window, "pointermove", { clientX: 500 });
  pointer(divider, "pointerdown", { isPrimary: false }); pointer(window, "pointermove", { clientX: 500 }); await nextTick();
  assert.equal(displayedRepoWidth(wrapper), 264); assert.equal(document.body.style.userSelect, originalBodyStyle.userSelect);
  pointer(divider, "pointerdown");
  pointer(window, "pointermove", { pointerId: 2, clientX: 500 });
  pointer(window, "pointerup", { pointerId: 2 }); pointer(window, "pointercancel", { pointerId: 2 });
  pointer(divider, "lostpointercapture", { pointerId: 2 }); await nextTick();
  assert.equal(displayedRepoWidth(wrapper), 264); assert.equal(document.body.style.userSelect, "none");
  pointer(window, "pointermove", { clientX: 400 }); pointer(window, "pointerup"); await nextTick();
  assert.equal(displayedRepoWidth(wrapper), 400); assert.equal(localStorage.getItem(repoWidthKey()), "400");
});

test("拖动宽度按Workspace缓存，组件重建恢复且其他工作区不互相覆盖", async () => {
  const { wrapper } = mountTool(); await settle(); resize(wrapper, 1000); await nextTick();
  dragTo(wrapper, 380); pointer(window, "pointerup"); await nextTick();
  assert.equal(localStorage.getItem(repoWidthKey()), "380");
  const restored = mountTool().wrapper; await settle(); resize(restored, 1000); await nextTick();
  assert.equal(displayedRepoWidth(restored), 380);
  const other = mountTool({ workspaceId: "other" }).wrapper; await settle(); resize(other, 1000); await nextTick();
  assert.equal(displayedRepoWidth(other), 264);
  dragTo(other, 450); pointer(window, "pointerup"); await nextTick();
  assert.equal(localStorage.getItem(repoWidthKey("other")), "450"); assert.equal(localStorage.getItem(repoWidthKey()), "380");
  await restored.setProps({ workspaceId: "other" }); assert.equal(displayedRepoWidth(restored), 450);
});

test("非法宽度和读取异常回退默认值，缓存写入异常不影响拖动", async () => {
  for (const raw of ["", "bad", "0", "199", "-100", "Infinity", "NaN", "{}"] ) {
    localStorage.setItem(repoWidthKey(), raw);
    const { wrapper } = mountTool(); await settle(); resize(wrapper, 900); await nextTick();
    assert.equal(displayedRepoWidth(wrapper), 264, raw);
  }
  const original = globalThis.localStorage;
  let reads = 0; let writes = 0;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem() { reads++; throw new Error("denied"); }, setItem() { writes++; throw new Error("full"); }
  } });
  try {
    const { wrapper } = mountTool(); await settle(); resize(wrapper, 900); await nextTick();
    assert.equal(reads, 1); assert.equal(displayedRepoWidth(wrapper), 264);
    dragTo(wrapper, 400); pointer(window, "pointerup"); await nextTick();
    assert.equal(writes, 1); assert.equal(displayedRepoWidth(wrapper), 400);
  } finally { Object.defineProperty(globalThis, "localStorage", { configurable: true, value: original }); }
});

test("自动限制和宽窄切换仅影响显示，不写回或丢失原宽度偏好", async () => {
  localStorage.setItem(repoWidthKey(), "1200");
  const write = mock.method(window.Storage.prototype, "setItem");
  const { wrapper } = mountTool(); await settle(); resize(wrapper, 480); await nextTick();
  assert.equal(displayedRepoWidth(wrapper), 280);
  resize(wrapper, 1000); await nextTick(); assert.equal(displayedRepoWidth(wrapper), 800);
  resize(wrapper, 479); await nextTick(); assert.equal(wrapper.find(".review-repo-divider").exists(), false);
  resize(wrapper, 1600); await nextTick(); assert.equal(displayedRepoWidth(wrapper), 1200);
  assert.equal(write.mock.callCount(), 0); assert.equal(localStorage.getItem(repoWidthKey()), "1200");
  resize(wrapper, 480); await nextTick();
  pointer(wrapper.get(".review-repo-divider").element, "pointerdown", { clientX: 280 }); pointer(window, "pointerup");
  dragTo(wrapper, 600); pointer(window, "pointerup"); await nextTick();
  assert.equal(write.mock.callCount(), 0, "a click or motion stuck at the cap must not overwrite the preference");
  resize(wrapper, 1600); await nextTick(); assert.equal(displayedRepoWidth(wrapper), 1200);
});

for (const reason of ["pointercancel", "blur", "lostpointercapture"] as const) {
  test(`${reason}取消后恢复拖动前偏好及正文样式，注销全部拖动监听`, async () => {
    localStorage.setItem(repoWidthKey(), "400");
    const { wrapper } = mountTool(); await settle(); resize(wrapper, 1000); await nextTick();
    const add = mock.method(window, "addEventListener"); const remove = mock.method(window, "removeEventListener");
    dragTo(wrapper, 500); await nextTick(); assert.equal(displayedRepoWidth(wrapper), 500);
    if (reason === "blur") window.dispatchEvent(new window.Event("blur"));
    else pointer(reason === "lostpointercapture" ? wrapper.get(".review-repo-divider").element : window, reason);
    await nextTick(); assert.equal(displayedRepoWidth(wrapper), 400); assert.equal(localStorage.getItem(repoWidthKey()), "400");
    assert.equal(document.body.style.userSelect, originalBodyStyle.userSelect); assert.equal(document.body.style.cursor, originalBodyStyle.cursor);
    for (const call of add.mock.calls.filter((call) => ["pointermove", "pointerup", "pointercancel", "blur"].includes(String(call.arguments[0])))) {
      assert.ok(remove.mock.calls.some((removed) => removed.arguments[0] === call.arguments[0] && removed.arguments[1] === call.arguments[1]), String(call.arguments[0]));
    }
    pointer(window, "pointermove", { clientX: 600 }); pointer(window, "pointerup"); await nextTick(); assert.equal(displayedRepoWidth(wrapper), 400);
  });
}

test("拖动中跨入窄模式、移除仓库或卸载均取消，恢复偏好且不保存临时值", async () => {
  localStorage.setItem(repoWidthKey(), "900");
  const { wrapper } = mountTool(); await settle(); resize(wrapper, 1200); await nextTick();
  dragTo(wrapper, 800); resize(wrapper, 479); await nextTick();
  assert.equal(wrapper.find(".review-repo-divider").exists(), false); assert.equal(localStorage.getItem(repoWidthKey()), "900");
  assert.equal(document.body.style.userSelect, originalBodyStyle.userSelect);
  resize(wrapper, 1400); await nextTick(); assert.equal(displayedRepoWidth(wrapper), 900);
  dragTo(wrapper, 700); await wrapper.setProps({ repos: [] });
  assert.equal(document.body.style.cursor, originalBodyStyle.cursor); assert.equal(localStorage.getItem(repoWidthKey()), "900");
  await wrapper.setProps({ repos }); await nextTick();
  dragTo(wrapper, 750); wrapper.unmount(); wrappers.splice(wrappers.indexOf(wrapper), 1);
  assert.equal(document.body.style.userSelect, originalBodyStyle.userSelect); assert.equal(document.body.style.cursor, originalBodyStyle.cursor);
  pointer(window, "pointermove", { clientX: 600 }); pointer(window, "pointerup"); assert.equal(localStorage.getItem(repoWidthKey()), "900");
});

test("KeepAlive停用时取消拖动，重新显示恢复原宽度且不遗留全局样式", async () => {
  localStorage.setItem(repoWidthKey(), "400");
  const active = ref(true);
  const wrapper = mount(defineComponent({ setup: () => () => h(KeepAlive, () => active.value ? h(Tool, {
    workspaceId: wsId, toolId: "codeReview", target: target(), gitBusy: false, beginGitOp: () => () => {}, repos
  }) : null) }), {
    attachTo: document.body, global: { plugins: [i18n()], stubs: { CodeReviewPanel: true, ADropdown: true, AMenu: true, AMenuItem: true }, provide: { [workspaceHostKey as symbol]: host } }
  });
  wrappers.push(wrapper); await settle();
  const tool = wrapper.findComponent(Tool); resize(tool, 1000); await nextTick();
  dragTo(tool, 500); active.value = false; await settle();
  assert.equal(document.body.style.userSelect, originalBodyStyle.userSelect); assert.equal(document.body.style.cursor, originalBodyStyle.cursor);
  pointer(window, "pointermove", { clientX: 600 }); pointer(window, "pointerup"); assert.equal(localStorage.getItem(repoWidthKey()), "400");
  active.value = true; await settle(); assert.equal(displayedRepoWidth(wrapper.findComponent(Tool)), 400);
});

test("分隔线左右键以10px调整并保存，ARIA及时更新且不覆盖自动限制的原偏好", async () => {
  localStorage.setItem(repoWidthKey(), "200");
  const { wrapper } = mountTool(); await settle(); resize(wrapper, 480); await nextTick();
  const divider = wrapper.get(".review-repo-divider");
  await divider.trigger("keydown", { key: "ArrowLeft" }); assert.equal(localStorage.getItem(repoWidthKey()), "200");
  await divider.trigger("keydown", { key: "ArrowRight" });
  assert.equal(displayedRepoWidth(wrapper), 210); assert.equal(divider.attributes("aria-valuenow"), "210");
  assert.equal(localStorage.getItem(repoWidthKey()), "210");
  await divider.trigger("keydown", { key: "ArrowLeft" }); assert.equal(localStorage.getItem(repoWidthKey()), "200");
  await divider.trigger("keydown", { key: "Enter" }); assert.equal(displayedRepoWidth(wrapper), 200);
  localStorage.setItem(repoWidthKey("clamped"), "1200");
  const clamped = mountTool({ workspaceId: "clamped" }).wrapper; await settle(); resize(clamped, 480); await nextTick();
  await clamped.get(".review-repo-divider").trigger("keydown", { key: "ArrowRight" });
  assert.equal(localStorage.getItem(repoWidthKey("clamped")), "1200");
});

test("无仓库与干净仓库空态不同，干净仅展示指定文案且不指向其他仓库", async () => {
  const { wrapper } = mountTool({ repos: [], target: null }); await settle();
  assert.equal(wrapper.find(".review-repositories").exists(), false); assert.ok(wrapper.text().includes("当前工作区没有注册仓库"));
  files = { unstaged: [], staged: [] }; const panel = mountPanel(); await settle();
  assert.equal(panel.get(".review-clean-state").text(), "当前仓库没有未提交变更");
  assert.equal(panel.text(), "当前仓库没有未提交变更"); assert.equal(panel.find("a, button").exists(), false);
});

test("提交按钮位于已暂存组，弹窗展示冻结仓库及已暂存范围并保留三个操作", async () => {
  const pushes: GitTarget[] = []; const panel = mountPanel({ push: async (target: GitTarget) => { pushes.push(target); } }); await settle();
  assert.equal(panel.find("[data-modal]").exists(), false);
  const groups = panel.findAll(".review-change-heading");
  assert.equal(groups[0]!.find('[aria-label="提交"]').exists(), false);
  await groups[1]!.get('[aria-label="提交"]').trigger("click"); await settle();
  const modal = panel.get("[data-modal]"); assert.equal(modal.get("[data-commit-target]").text(), "目标仓库：repo-1");
  assert.ok(modal.text().includes("1 个已暂存文件")); assert.ok(modal.text().includes("仅提交该仓库的已暂存变更"));
  assert.deepEqual(modal.findAll("button").map((button) => button.text()), ["取消", "提交", "提交并推送"]);
  await panel.setProps({ target: target("repo-8") }); await settle();
  assert.equal(panel.get("[data-commit-target]").text(), "目标仓库：repo-1");
  state(panel).commitMessage = "feat: review"; await nextTick();
  await panel.get("[data-modal]").findAll("button")[2]!.trigger("click"); await settle();
  assert.deepEqual(requests.filter((item) => item.path === "/git/commit").map((item) => item.body.target), [target()]);
  assert.deepEqual(pushes, [target()]); assert.equal(panel.find("[data-modal]").exists(), false);
});

test("目录和子模块有非文本图标说明，不能以普通编辑文件入口打开", async () => {
  files = { unstaged: [{ path: "nested", status: "??", kind: "directory" }, { path: "vendor/sub", status: "M", kind: "submodule" }], staged: [] };
  const panel = mountPanel(); await settle(); const vm = state(panel);
  assert.equal(panel.findAll('span.whitespace-nowrap[title="目录（不支持文本预览）"]').length, 1);
  assert.equal(panel.findAll('span.whitespace-nowrap[title="子模块（不支持文本预览）"]').length, 1);
  for (const file of files.unstaged!) assert.equal(vm.isOpenFileDisabled(file), true);
});

test("页头仅保留Workspace及非Git操作，选中仓库不影响标题和其他工具范围", async () => {
  const layout = shallowMount(Layout, { props: { workspaceId: wsId, previewEnabled: false }, global: { plugins: [i18n()], stubs } });
  wrappers.push(layout); await settle();
  const dock = () => layout.findComponent({ name: "WorkspaceDock" }).props() as any;
  const headerProps = () => layout.findComponent(Header).props() as any;
  assert.deepEqual(Object.keys(headerProps()).sort(), ["headerActionGroups", "workspace"]);
  assert.equal(headerProps().headerActionGroups.some((group: any) => group.key === "always:codeReview"), false);
  assert.equal(document.title, `Review workspace - ${zhCN.app.title}`);
  const beforeAgent = dock().toolViewProps("agent"), beforeFiles = dock().toolViewProps("files"), beforeTerminal = dock().toolViewProps("terminal");
  dock().toolViewProps("codeReview").selectRepo("repo-8"); await settle();
  assert.equal(document.title, `Review workspace - ${zhCN.app.title}`);
  assert.deepEqual(dock().toolViewProps("agent"), beforeAgent); assert.deepEqual(dock().toolViewProps("files"), beforeFiles); assert.deepEqual(dock().toolViewProps("terminal"), beforeTerminal);
  const actions: string[] = [];
  const header = shallowMount(Header, { props: { workspace: headerProps().workspace, headerActionGroups: [{ key: "editor", actions: [{ id: "next", label: "下一处变更", onClick: () => actions.push("next") }] }] }, global: { plugins: [i18n()], stubs: { "a-layout-header": { template: "<header><slot /></header>" }, ...stubs } } });
  wrappers.push(header);
  assert.equal(header.find("a-select-stub").exists(), false); assert.equal(header.text().includes("切换分支"), false); assert.equal(header.text().includes("拉取"), false); assert.equal(header.text().includes("推送"), false);
  await header.get("button").trigger("click"); assert.deepEqual(actions, ["next"]);
});

test("已有左右分割器可拖过480，编辑器显示或关闭时审查使用可用宽度", async () => {
  // Keep the shallow host as the last mounted root: VTU's process-wide vnode
  // transformer otherwise stops stubbing newly-visible dynamic Dock children.
  const { wrapper } = mountTool(); await settle();
  const layout = shallowMount(Layout, { props: { workspaceId: wsId, previewEnabled: false }, global: { plugins: [i18n()], stubs } }); wrappers.push(layout); await settle();
  const dock = () => layout.findComponent({ name: "WorkspaceDock" }).props() as any;
  const vm = state(layout); dock().onToolIconClick("codeReview"); await settle();
  vm.hostApi.callFrom("codeReview", "editor", { type: "editor.openDiff", payload: { tabKey: "review", title: "work.ts", original: "a", modified: "b" } }); await settle();
  assert.equal(dock().visibleToolIdByArea.leftTop, "codeReview"); assert.equal(dock().visibleToolIdByArea.rightTop, "editor");
  assert.equal(dock().showTopColsSplitter, true);
  const top = document.createElement("div"); top.getBoundingClientRect = () => ({ width: 1200, height: 800, left: 0, top: 0 } as DOMRect); dock().onTopEl(top);
  dock().onTopColsSplitterPointerDown({ preventDefault() {}, stopPropagation() {} } as PointerEvent);
  resize(wrapper, 479); await nextTick(); assert.equal(wrapper.classes().includes("review-wide"), false);
  window.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 500 })); await nextTick();
  const leftRatio = Number(dock().topStyle.gridTemplateColumns.split("fr")[0]); assert.ok(leftRatio * 1200 >= 480);
  resize(wrapper, leftRatio * 1200); await nextTick(); assert.equal(wrapper.classes().includes("review-wide"), true);
  window.dispatchEvent(new window.PointerEvent("pointerup"));
  vm.hostApi.minimizeTool("editor"); await settle(); assert.equal(dock().showTopColsSplitter, false); assert.equal(dock().topStyle.gridTemplateColumns, "1fr");
  resize(wrapper, 1200); await nextTick(); assert.equal(wrapper.classes().includes("review-wide"), true);
});

test("零仓库仍常驻查询摘要，可从真实 Dock 打开审查空态且不强制打开工具", async () => {
  apiClient.defaults.adapter = async (config) => {
    const path = config.url!;
    const body = typeof config.data === "string" ? JSON.parse(config.data) : config.data;
    requests.push({ path, body });
    const data = path.startsWith("/workspaces/")
      ? { id: wsId, title: "Empty workspace", dirName: "empty", repos: [], createdAt: 1, updatedAt: 1 }
      : path === "/git/workspace-status" ? { repos: [] }
      : path === "/git/changes" ? { files: [] } : {};
    return { data, status: 200, statusText: "OK", headers: {}, config };
  };
  const wrapper = mount(Layout, {
    attachTo: document.body,
    props: { workspaceId: wsId, previewEnabled: false },
    global: { plugins: [i18n()], stubs: {
      ...stubs, WorkspaceDock: false, WorkspaceHeader: true, GitIdentityModal: true,
      files: true, search: true, terminal: true, scheduledTasks: true,
      EnvironmentVariablesToolView: true, agent: true, editor: true
    } }
  });
  wrappers.push(wrapper); await settle();
  const reviewButton = () => wrapper.findAllComponents({ name: "WorkspaceToolButton" })
    .find((button) => button.props("title") === zhCN.workspace.tools.codeReview)!;
  assert.ok(reviewButton(), "实际工具栏保留代码审查入口");
  assert.equal(reviewButton().props("dot"), false);
  assert.equal(wrapper.find(".review-empty").exists(), false, "不自动抢占默认工具");
  assert.equal(requests.filter((request) => request.path === "/git/workspace-status").length, 1);
  await reviewButton().get("button").trigger("click"); await settle();
  assert.equal(wrapper.get(".review-empty").text(), zhCN.codeReview.placeholder.noRepos);
  assert.equal(wrapper.get(".review-empty").isVisible(), true);
  assert.equal(wrapper.find(".review-repository").exists(), false);
  assert.equal(reviewButton().props("dot"), false);
  // 有无仓库变化不能重建后台轮询，也不能改变当前工具。
  state(wrapper).workspace = { ...state(wrapper).workspace, repos };
  await settle();
  state(wrapper).workspace = { ...state(wrapper).workspace, repos: [] };
  await settle();
  assert.equal(wrapper.get(".review-empty").isVisible(), true);
  assert.equal(requests.filter((request) => request.path === "/git/workspace-status").length, 1);
  state(wrapper).hostApi.minimizeTool("codeReview"); await settle();
  state(wrapper).workspace = { ...state(wrapper).workspace, repos };
  await settle();
  state(wrapper).workspace = { ...state(wrapper).workspace, repos: [] };
  await settle();
  assert.equal(wrapper.find(".review-empty").exists(), false, "保留用户最小化偏好");
  assert.equal(requests.filter((request) => request.path === "/git/workspace-status").length, 1);
});

test("英文新增仓库、提交范围和空态文案均有对应翻译", () => {
  const en = i18n("en-US");
  for (const key of ["codeReview.placeholder.noRepos", "codeReview.repositories.title", "codeReview.repositories.switchBranch", "codeReview.repositories.resize", "codeReview.repositories.actions", "codeReview.repositories.select", "codeReview.file.directory", "codeReview.file.submodule", "codeReview.commit.target", "codeReview.commit.scope", "codeReview.status.noUnstagedChanges", "codeReview.status.noStagedChanges"]) {
    assert.equal(en.global.te(key), true, key);
  }
});
