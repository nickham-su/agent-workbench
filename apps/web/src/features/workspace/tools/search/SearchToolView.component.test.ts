import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import { nextTick } from "vue";
import { mount, type DOMWrapper, type VueWrapper } from "@vue/test-utils";
import { Button, Checkbox, Input } from "ant-design-vue";
import { createI18n } from "vue-i18n";
import type { FileSearchResponse, WorkspaceFileSearchRequest } from "@agent-workbench/shared";
import { apiClient } from "@/shared/api";
import zhCN from "@/shared/i18n/locales/zh-CN";
import enUS from "@/shared/i18n/locales/en-US";
import { workspaceHostKey } from "../../host";
import SearchToolView from "./SearchToolView.vue";
import { createSearchRuntime } from "./runtime";
import { getSearchStore, type SearchStore } from "./store";

Object.defineProperties(globalThis, {
  self: { value: window, configurable: true },
  sessionStorage: { value: window.sessionStorage, configurable: true }
});

// vite-node 不注入 SFC 样式；使用项目配置编译真实工具类，验证标题栏的 CSS 契约。
const source = readFileSync(new URL("SearchToolView.vue", import.meta.url), "utf8");
const tailwindConfig = createRequire(import.meta.url)("../../../../../tailwind.config.cjs");
const utilities = await postcss([tailwindcss({
  ...tailwindConfig, content: [{ raw: source, extension: "vue" }]
})]).process(readFileSync(new URL("../../../../shared/styles/tailwind.css", import.meta.url), "utf8"), { from: undefined });
const styles = document.createElement("style");
styles.textContent = utilities.css;
document.head.appendChild(styles);

const originalAdapter = apiClient.defaults.adapter;
const requests: WorkspaceFileSearchRequest[] = [];
const fixtures: Array<{ wrapper: VueWrapper; store: SearchStore }> = [];
let workspaceSeq = 0;
let respond: (request: WorkspaceFileSearchRequest) => FileSearchResponse | Promise<FileSearchResponse>;

function result(label = "match"): FileSearchResponse {
  return {
    query: label, useRegex: false, caseSensitive: false, limit: 100,
    matches: [{ path: `${label}.ts`, line: 1, lineText: label, highlight: { kind: "line" } }],
    blocks: [{ path: `${label}.ts`, fromLine: 1, toLine: 1, hitLines: [1], lines: [{ line: 1, text: label }] }],
    truncated: false, timedOut: false, tookMs: 5, ignoredByVcs: true, ignoredByDotIgnore: true
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function settle() {
  for (let i = 0; i < 3; i++) {
    await nextTick();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function mountSearch(savedOptions?: Record<string, unknown>, locale = "zh-CN") {
  const workspaceId = `search-interactions-${++workspaceSeq}`;
  if (savedOptions) sessionStorage.setItem(`awb.search.options.v2.${workspaceId}`, JSON.stringify(savedOptions));
  const store = getSearchStore(workspaceId);
  const wrapper = mount(SearchToolView, {
    attachTo: document.body,
    props: { workspaceId, toolId: "search" },
    global: {
      plugins: [createI18n({ legacy: false, locale, messages: { "zh-CN": zhCN, "en-US": enUS } })],
      components: { AInput: Input, ACheckbox: Checkbox, AButton: Button },
      provide: { [workspaceHostKey as symbol]: { callFrom() {} } }
    }
  });
  fixtures.push({ wrapper, store });
  const fields = wrapper.findAll<HTMLInputElement>('input[type="text"]');
  assert.equal(fields.length, 2);
  return { wrapper, store, workspaceId, query: fields[0]!, path: fields[1]! };
}

async function enter(field: DOMWrapper<HTMLInputElement>, isComposing = false) {
  await field.trigger("keydown", { key: "Enter", keyCode: 13, which: 13, isComposing });
  await settle();
}

async function paste(field: DOMWrapper<HTMLInputElement>, value: string) {
  // 浏览器先发送 paste，再插入文本并发送 input；只在值已更新后搜索。
  field.element.dispatchEvent(new window.Event("paste", { bubbles: true }));
  (field.element as HTMLInputElement).value = value;
  field.element.dispatchEvent(new window.InputEvent("input", {
    bubbles: true, inputType: "insertFromPaste", data: value
  }));
  await settle();
}

beforeEach(() => {
  sessionStorage.clear();
  requests.length = 0;
  respond = () => result();
  apiClient.defaults.adapter = async (config) => {
    assert.match(config.url ?? "", /^\/workspaces\/search-interactions-\d+\/files\/search$/);
    const body = typeof config.data === "string" ? JSON.parse(config.data) : config.data;
    requests.push(body);
    return { data: await respond(body), status: 200, statusText: "OK", headers: {}, config };
  };
});

afterEach(async () => {
  for (const { wrapper, store } of fixtures.splice(0)) {
    wrapper.unmount();
    store.nextRequestSeq();
    store.resetResults();
    store.loading.value = false;
  }
  apiClient.defaults.adapter = originalAdapter;
  await settle();
});

test("搜索标题栏与文件及审查标题统一高度、字号、字重、左距及主题色，且位于表单之外", () => {
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const pixels = (value: string) => parseFloat(value) * (value.endsWith("rem") ? rem : 1);
  for (const locale of ["zh-CN", "en-US"]) {
    const { wrapper, query } = mountSearch(undefined, locale);
    const heading = wrapper.get(".search-tool-heading");
    assert.equal(heading.text(), locale === "zh-CN" ? "搜索" : "Search");
    assert.equal(wrapper.findAll(".search-tool-heading").length, 1);
    assert.equal(wrapper.element.firstElementChild, heading.element);
    assert.ok(heading.element.nextElementSibling?.contains(query.element), "标题不受表单内边距影响");
    const root = wrapper.element as HTMLElement;
    root.style.color = "var(--text-color)";
    root.style.setProperty("--border-color-secondary", "rgb(64, 64, 64)");
    for (const [background, foreground] of [["rgb(32, 32, 32)", "rgb(230, 230, 230)"], ["rgb(240, 240, 240)", "rgb(30, 30, 30)"]]) {
      root.style.setProperty("--panel-bg-elevated", background!);
      root.style.setProperty("--text-color", foreground!);
      const style = getComputedStyle(heading.element);
      assert.equal(style.height, "37px");
      assert.equal(style.boxSizing, "border-box");
      assert.equal(style.flexShrink, "0", "可用高度不足时也不压缩标题");
      assert.equal(pixels(style.fontSize), 12);
      assert.equal(style.fontWeight, "600");
      assert.equal(pixels(style.paddingLeft), 12);
      assert.equal(style.backgroundColor, background);
      assert.equal(style.color, foreground);
      assert.equal(style.borderBottomWidth, "1px");
      assert.equal(style.borderBottomColor, "rgb(64, 64, 64)");
    }
    assert.equal(heading.find("button").exists(), false, "不重新引入搜索按钮");
  }
});

test("两个输入框复用真实 Ant 默认尺寸，移除独立搜索按钮", () => {
  const { wrapper } = mountSearch();
  const inputs = wrapper.findAllComponents(Input);
  assert.equal(inputs.length, 2);
  for (const input of inputs) {
    assert.equal(input.props("size"), undefined);
    assert.ok(!input.classes().includes("ant-input-affix-wrapper-sm"));
    assert.ok(!input.classes().includes("ant-input-affix-wrapper-lg"));
  }
  const first = getComputedStyle(inputs[0]!.element);
  const second = getComputedStyle(inputs[1]!.element);
  for (const key of ["height", "paddingTop", "paddingBottom", "lineHeight"] as const) {
    assert.equal(first[key], second[key], key);
  }
  assert.equal(wrapper.find("button").exists(), false);
});

test("逐字修改查询或路径不搜索，两个输入框均可按回车提交最新值", async () => {
  const { query, path, store } = mountSearch();
  await query.setValue("  needle  ");
  await path.setValue("repo-a/src");
  await settle();
  assert.equal(requests.length, 0);
  await enter(query);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], {
    query: "needle", path: "repo-a/src", useRegex: false, caseSensitive: false, scope: "global"
  });
  await path.setValue("repo-b/src");
  assert.equal(requests.length, 1);
  await enter(path);
  assert.equal(requests.length, 2);
  assert.equal(requests[1]!.path, "repo-b/src");
  assert.equal(store.loading.value, false);
  assert.equal(store.tookMs.value, 5);
});

for (const [index, option] of ["caseSensitive", "wholeWord", "useRegex"].entries()) {
  test(`切换 ${option} 立即搜索，使用切换后的值且不重复请求`, async () => {
    const { wrapper, query } = mountSearch();
    await query.setValue("needle");
    const checkbox = wrapper.findAll<HTMLInputElement>('input[type="checkbox"]')[index]!;
    await checkbox.setValue(true);
    await settle();
    assert.equal(requests.length, 1);
    assert.equal(requests[0]![option as "caseSensitive" | "wholeWord" | "useRegex"], true);
    await checkbox.setValue(false);
    await settle();
    assert.equal(requests.length, 2);
    assert.equal(requests[1]![option as "caseSensitive" | "wholeWord" | "useRegex"], option === "wholeWord" ? undefined : false);
  });
}

test("粘贴查询后自动搜索完整新内容，不必回车且只发出一次请求", async () => {
  const { query, store } = mountSearch();
  await query.setValue("old");
  await paste(query, "new pasted query");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.query, "new pasted query");
  assert.equal(store.tookMs.value, 5);
});

test("粘贴路径使用新范围，路径 watcher 不会作废刚发出的搜索", async () => {
  const { query, path, store } = mountSearch();
  await query.setValue("needle");
  await path.setValue("old/path");
  await paste(path, "repo-c/src");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.path, "repo-c/src");
  assert.equal(store.matches.value.length, 1);
  assert.equal(store.tookMs.value, 5);
  assert.equal(store.loading.value, false);
});

test("清空路径按钮自动以全局范围搜索，清空查询则仅清理结果", async () => {
  const { wrapper, query, path, store } = mountSearch();
  await query.setValue("needle");
  await path.setValue("repo-a");
  const inputs = wrapper.findAllComponents(Input);
  await inputs[1]!.get(".ant-input-clear-icon").trigger("click");
  await settle();
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.path, "");
  assert.equal(store.matches.value.length, 1);
  await inputs[0]!.get(".ant-input-clear-icon").trigger("click");
  await settle();
  assert.equal(requests.length, 1);
  assert.equal(store.matches.value.length, 0);
  assert.equal(store.tookMs.value, null);
  assert.equal(store.loading.value, false);
});

test("查询为空或只有空白时，回车、粘贴路径及checkbox均不发请求", async () => {
  const { wrapper, query, path, store } = mountSearch();
  await enter(query);
  await query.setValue("   ");
  await enter(path);
  await paste(query, "    ");
  await paste(path, "repo-a");
  for (const checkbox of wrapper.findAll<HTMLInputElement>('input[type="checkbox"]')) {
    await checkbox.setValue(true);
    await settle();
  }
  assert.equal(requests.length, 0);
  assert.equal(store.loading.value, false);
  assert.equal(store.error.value, "");
});

test("输入法候选确认的回车不搜索，组合输入结束后可正常回车搜索", async () => {
  const { query } = mountSearch();
  await query.setValue("中文查询");
  await enter(query, true);
  assert.equal(requests.length, 0);
  await enter(query);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.query, "中文查询");
});

test("恢复选项及程序预填路径不自动搜索，保持运行时预填契约", async () => {
  const { query, store, workspaceId } = mountSearch({ path: "saved/path", caseSensitive: true, useRegex: true, wholeWord: true });
  await query.setValue("needle");
  assert.equal(store.caseSensitive.value, true);
  assert.equal(store.path.value, "saved/path");
  const runtime = createSearchRuntime({
    workspaceId, toolId: "search", host: { call() {}, setToolDot() {} },
    getCurrentTarget: () => null, getVisible: () => true
  });
  runtime.onEvent?.({ type: "search.prefillPath", payload: { path: "prefilled/path" } });
  await settle();
  assert.equal(store.path.value, "prefilled/path");
  assert.equal(requests.length, 0);
  await enter(query);
  assert.equal(requests[0]!.path, "prefilled/path");
  assert.equal(requests[0]!.caseSensitive, true);
  assert.equal(requests[0]!.wholeWord, true);
  assert.equal(requests[0]!.useRegex, true);
});

test("连续自动搜索以最新请求为准，旧请求延迟完成不覆盖结果", async () => {
  const old = deferred<FileSearchResponse>();
  respond = (request) => request.caseSensitive ? result("latest") : old.promise;
  const { wrapper, query, store } = mountSearch();
  await paste(query, "needle");
  assert.equal(store.loading.value, true);
  await wrapper.get('input[type="checkbox"]').setValue(true);
  await settle();
  assert.equal(requests.length, 2);
  assert.equal(store.matches.value[0]!.path, "latest.ts");
  old.resolve(result("stale"));
  await settle();
  assert.equal(store.matches.value[0]!.path, "latest.ts");
  assert.equal(store.loading.value, false);
});

test("清空查询使自动搜索中的请求失效，旧结果不会重新出现", async () => {
  const pending = deferred<FileSearchResponse>();
  respond = () => pending.promise;
  const { wrapper, query, store } = mountSearch();
  await paste(query, "needle");
  assert.equal(store.loading.value, true);
  await wrapper.findAllComponents(Input)[0]!.get(".ant-input-clear-icon").trigger("click");
  await settle();
  pending.resolve(result("stale"));
  await settle();
  assert.equal(requests.length, 1);
  assert.equal(store.matches.value.length, 0);
  assert.equal(store.tookMs.value, null);
  assert.equal(store.loading.value, false);
});
