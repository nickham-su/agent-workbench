import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { nextTick } from "vue";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import zhCN from "@/shared/i18n/locales/zh-CN";
import { apiClient } from "@/shared/api/api";
import { sanitizeAgentMarkdown } from "../agent/assistantMarkdownSanitizer";
import { renderEditorMarkdown } from "./editorMarkdown";
import EditorMarkdownPreview from "./EditorMarkdownPreview.vue";

const originalAdapter = apiClient.defaults.adapter;
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
const originalScroll = window.HTMLElement.prototype.scrollIntoView;
const wrappers: Array<ReturnType<typeof mount>> = [];
const calls: Array<{ type: string; path: string }> = [];
const urls: string[] = [];
const revoked: string[] = [];
const scrolls: string[] = [];
let response: ((type: string, path: string) => unknown | Promise<unknown>) | undefined;
async function settle() {
  for (let i = 0; i < 8; i++) await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 30));
}
function setup(text: string, path = "repo/docs/README.md", scrollTop = 0) {
  URL.createObjectURL = () => { const url = `blob:markdown-${urls.length}`; urls.push(url); return url; };
  URL.revokeObjectURL = (url) => { revoked.push(url); };
  window.HTMLElement.prototype.scrollIntoView = function () { scrolls.push(this.id); };
  apiClient.defaults.adapter = async (config) => {
    const type = String(config.url).split("/").pop()!;
    const requestData = typeof config.data === "string" ? JSON.parse(config.data) : config.data;
    const path = String(requestData?.path ?? config.params?.path ?? "");
    calls.push({ type, path });
    const custom = response ? await response(type, path) : undefined;
    const data = custom ?? (type === "stat" ? { ok: true, path, kind: "file", version: { size: 5, mtimeMs: 1 } } : new Blob(["image"]));
    return { data, status: 200, statusText: "OK", headers: {}, config };
  };
  const wrapper = mount(EditorMarkdownPreview, {
    attachTo: document.body,
    props: { workspaceId: "markdown-test", path, text, scrollTop },
    global: { plugins: [createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } })] }
  });
  wrappers.push(wrapper);
  return wrapper;
}
afterEach(async () => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  apiClient.defaults.adapter = originalAdapter;
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
  window.HTMLElement.prototype.scrollIntoView = originalScroll;
  response = undefined;
  calls.length = urls.length = revoked.length = scrolls.length = 0;
  await settle();
});

test("真实 Markdown 渲染包含表格、列表、引用、代码和唯一章节，Mermaid 围栏仍是源码", async () => {
  const wrapper = setup("# 标题\n\n# 标题\n\n- item\n\n> quote\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```mermaid\ngraph TD; A-->B\n```\n\n[章节](#标题-1)");
  await settle();
  assert.equal(wrapper.findAll("h1").length, 2);
  assert.equal(wrapper.get("h1").attributes("id"), "editor-md-heading-标题");
  assert.equal(wrapper.findAll("h1")[1].attributes("id"), "editor-md-heading-标题-1");
  assert.equal(wrapper.get("li").text(), "item");
  assert.equal(wrapper.get("blockquote").text(), "quote");
  assert.equal(wrapper.findAll("td").length, 2);
  assert.equal(wrapper.get("code.language-mermaid").text(), "graph TD; A-->B");
  await wrapper.get("a").trigger("click");
  assert.deepEqual(scrolls, ["editor-md-heading-标题-1"]);
});

test("防 clobbering 清洗保留命名空间章节 ID，保留名、重复及中文标题均可点击定位", async () => {
  const titles = ["location", "name", "constructor", "location", "location-1", "中文标题", "中文标题"];
  const fragments = ["location", "name", "constructor", "location-1", "location-1-1", "中文标题", "中文标题-1"];
  const text = titles.map((title) => `# ${title}`).join("\n\n") + "\n\n" + fragments.map((fragment, index) =>
    `[跳转 ${index}](${index === 2 ? "./README.md" : ""}#${encodeURIComponent(fragment)})`
  ).join(" ");
  const wrapper = setup(text);
  await settle();
  const expectedIds = fragments.map((fragment) => `editor-md-heading-${fragment}`);
  assert.deepEqual(wrapper.findAll("h1").map((heading) => heading.attributes("id")), expectedIds);
  assert.equal(wrapper.find("[id=location], [id=name], [id=constructor]").exists(), false);
  const links = wrapper.findAll("article a");
  assert.equal(links.length, fragments.length);
  for (let index = 0; index < links.length; index++) {
    await links[index].trigger("click");
    assert.equal(scrolls.at(-1), expectedIds[index]);
    assert.equal(wrapper.find(".preview-error").exists(), false);
  }
  assert.deepEqual(scrolls, expectedIds);
  assert.equal(calls.length, 0);
});

test("原始 HTML、恶意协议和事件属性不执行；独立清洗不受 Agent 共享 hook 顺序影响", async () => {
  assert.equal(sanitizeAgentMarkdown('<img src="https://example.com/a"><a onclick="bad()">a</a>').includes("<img"), false);
  const result = renderEditorMarkdown('![local](./x.png)\n\n<script>alert(1)</script>\n\n<img src="https://example.com/b" onerror="bad()">\n\n[bad](javascript:alert(1))', "repo/docs/a.md");
  const wrapper = setup('![local](./x.png)\n\n<script>alert(1)</script>\n\n<img src="https://example.com/b" onerror="bad()">\n\n[bad](javascript:alert(1))');
  assert.equal(result.images.length, 1);
  const inert = document.createElement("div");
  inert.innerHTML = result.html;
  assert.equal(inert.querySelectorAll("[src], [srcset]").length, 0);
  assert.equal(result.html.includes("<script"), false);
  await settle();
  assert.equal(wrapper.findAll("img").length, 1);
  assert.equal(wrapper.get("img").attributes("src"), "blob:markdown-0");
  assert.equal(wrapper.find("script").exists(), false);
  assert.equal(wrapper.find("[onerror]").exists(), false);
  assert.equal(sanitizeAgentMarkdown('<img src="blob:test">').includes("<img"), false);
});

test("相对图片经 stat/download 安全加载，相同路径去重；外部、越界及含查询/章节图片不发请求", async () => {
  const wrapper = setup('![one](../images/a.svg) ![two](../images/a.svg) ![remote](https://example.com/x.png) ![escape](../../../escape.png) ![query](a.png?raw=1) ![fragment](a.svg#id) ![encoded](%252e%252e/a.png)');
  await settle();
  assert.deepEqual(calls, [{ type: "stat", path: "repo/images/a.svg" }, { type: "download", path: "repo/images/a.svg" }]);
  const images = wrapper.findAll("img");
  assert.equal(images.length, 7);
  assert.equal(images[0].attributes("src"), images[1].attributes("src"));
  for (const image of images.slice(2)) assert.equal(image.attributes("src"), undefined);
  assert.match(wrapper.text(), /远程图片未自动加载/);
  assert.match(wrapper.text(), /图片路径不受支持/);
});

test("更新、卸载释放 Blob URL，迟到下载不得覆盖新文档或创建 URL", async () => {
  const wrapper = setup("![a](a.png)");
  await settle();
  assert.deepEqual(urls, ["blob:markdown-0"]);
  await wrapper.setProps({ text: "new content" });
  await settle();
  assert.deepEqual(revoked, ["blob:markdown-0"]);
  let complete!: (value: unknown) => void;
  response = (type) => type === "download" ? new Promise((resolve) => { complete = resolve; }) : undefined;
  await wrapper.setProps({ text: "![late](b.png)" });
  await settle();
  assert.equal(typeof complete, "function");
  wrapper.unmount();
  wrappers.splice(wrappers.indexOf(wrapper), 1);
  complete(new Blob(["late"]));
  await settle();
  assert.deepEqual(urls, ["blob:markdown-0"]);
});

test("旧图片下载在同一组件切换文件后失效，不覆盖新文档", async () => {
  let complete!: (value: unknown) => void;
  response = (type) => type === "download" ? new Promise((resolve) => { complete = resolve; }) : undefined;
  const wrapper = setup("![late](old.png)");
  await settle();
  await wrapper.setProps({ path: "other/README.md", workspaceId: "new-workspace", text: "# New document" });
  complete(new Blob(["old image"]));
  await settle();
  assert.equal(wrapper.get("h1").text(), "New document");
  assert.equal(wrapper.find("img").exists(), false);
  assert.equal(urls.length, 0);
});

test("图片加载与浏览器解码失败显示局部错误，不影响正文", async () => {
  response = (type, path) => type === "stat" && path.endsWith("missing.png") ? { ok: false, path, reason: "missing" } : undefined;
  const wrapper = setup("# 正文\n\n![missing](missing.png) ![bad](bad.png)");
  await settle();
  assert.match(wrapper.text(), /图片加载失败/);
  await wrapper.findAll("img")[1].trigger("error");
  assert.equal(wrapper.findAll("img")[1].attributes("src"), undefined);
  assert.match(wrapper.text(), /正文/);
});

test("图片限制数量、并发与整篇预算，限制仅影响资源不影响文档", async () => {
  let active = 0;
  let maxActive = 0;
  response = async (type) => {
    if (type === "download") {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
    }
  };
  const wrapper = setup(Array.from({ length: 34 }, (_, index) => `![${index}](image${index}.png)`).join("\n"));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(calls.filter((call) => call.type === "download").length, 32);
  assert.ok(maxActive <= 3 && maxActive > 1);
  assert.match(wrapper.text(), /图片数量超过预览限制/);
  calls.length = 0;
  response = (type) => type === "stat" ? { ok: true, kind: "file", version: { size: 20 * 1024 * 1024, mtimeMs: 1 } } : undefined;
  await wrapper.setProps({ text: "![a](a.png) ![b](b.png) ![c](c.png)" });
  await settle();
  assert.equal(calls.filter((call) => call.type === "download").length, 2);
});

test("文件链接以文档目录解析、stat后打开；外链有安全属性", async () => {
  const wrapper = setup("[文件](../src/app.ts) [外链](https://example.com/path)");
  await settle();
  const external = wrapper.findAll("a")[1];
  assert.equal(external.attributes("href"), "https://example.com/path");
  assert.equal(external.attributes("target"), "_blank");
  assert.equal(external.attributes("rel"), "noopener noreferrer");
  await wrapper.findAll("a")[0].trigger("click");
  await settle();
  assert.deepEqual(calls, [{ type: "stat", path: "repo/src/app.ts" }]);
  assert.deepEqual(wrapper.emitted("open-file"), [["repo/src/app.ts"]]);
});

test("非法/缺失链接、缺失章节及跨文件章节给出明确提示", async () => {
  const wrapper = setup("[越界](../../../secret) [章节](#missing) [跨文件](other.md#heading) [缺失](missing.md)");
  await settle();
  await wrapper.findAll("a")[0].trigger("click");
  assert.match(wrapper.text(), /链接地址不受支持/);
  await wrapper.findAll("a")[1].trigger("click");
  assert.match(wrapper.text(), /未找到对应章节/);
  await wrapper.findAll("a")[2].trigger("click");
  assert.match(wrapper.text(), /暂不支持跳转到其他文件的章节/);
  assert.equal(calls.length, 0);
  response = () => ({ ok: false, reason: "missing" });
  await wrapper.findAll("a")[3].trigger("click");
  await settle();
  assert.match(wrapper.text(), /文件不存在/);
  assert.equal(wrapper.emitted("open-file"), undefined);
});

test("链接异步结果在内容更新或切工作区后失效", async () => {
  let complete!: (value: unknown) => void;
  response = () => new Promise((resolve) => { complete = resolve; });
  const wrapper = setup("[file](a.md)");
  await settle();
  await wrapper.get("a").trigger("click");
  await wrapper.setProps({ text: "new document", workspaceId: "other-workspace" });
  complete({ ok: true, kind: "file", version: { size: 1, mtimeMs: 1 } });
  await settle();
  assert.equal(wrapper.emitted("open-file"), undefined);
});

test("预览滚动可恢复并向宿主报告", async () => {
  const wrapper = setup("# heading", "repo/docs/README.md", 123);
  await settle();
  const root = wrapper.get("[data-editor-markdown-preview]");
  assert.equal(root.element.scrollTop, 123);
  root.element.scrollTop = 234;
  await root.trigger("scroll");
  assert.deepEqual(wrapper.emitted("scroll-position")?.at(-1), [234]);
});

/** Model browser clamping and async scroll events, which happy-dom does not calculate. */
function scrollGeometry(root: HTMLElement, initialMax = 0) {
  let top = 0;
  let max = initialMax;
  Object.defineProperty(root, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      const next = Math.min(max, Math.max(0, value));
      if (next === top) return;
      top = next;
      queueMicrotask(() => root.dispatchEvent(new window.Event("scroll")));
    }
  });
  Object.defineProperty(root, "clientHeight", { configurable: true, get: () => 400 });
  Object.defineProperty(root, "scrollHeight", { configurable: true, get: () => max + 400 });
  return { setMax: (value: number) => { max = value; root.scrollTop = top; } };
}

test("延迟下载及图片 decode 后恢复目标滚动，中间截断不回写宿主", async () => {
  let complete!: (value: unknown) => void;
  response = (type) => type === "download" ? new Promise((resolve) => { complete = resolve; }) : undefined;
  const wrapper = setup("# Short\n\n![tall](tall.png)", "repo/docs/README.md", 900);
  const root = wrapper.get("[data-editor-markdown-preview]").element as HTMLElement;
  const geometry = scrollGeometry(root);
  await settle();
  root.dispatchEvent(new window.Event("scroll"));
  assert.equal(root.scrollTop, 0);
  assert.equal(wrapper.emitted("scroll-position"), undefined);
  complete(new Blob(["image waiting for decode"]));
  await settle();
  assert.ok(wrapper.get("img").attributes("src")?.startsWith("blob:"));
  assert.equal(root.scrollTop, 0);
  assert.equal(wrapper.emitted("scroll-position"), undefined);
  geometry.setMax(1800);
  await wrapper.get("img").trigger("load");
  await settle();
  assert.equal(root.scrollTop, 900);
  assert.deepEqual(wrapper.emitted("scroll-position")?.at(-1), [900]);
});

test("用户主动滚动取消待恢复目标，图片撑开后不抢回旧位置", async () => {
  const wrapper = setup("# Short\n\n![tall](tall.png)", "repo/docs/README.md", 900);
  const root = wrapper.get("[data-editor-markdown-preview]");
  const geometry = scrollGeometry(root.element as HTMLElement);
  await settle();
  await root.trigger("wheel");
  geometry.setMax(1800);
  root.element.scrollTop = 140;
  await root.trigger("scroll");
  await wrapper.get("img").trigger("load");
  await settle();
  assert.equal(root.element.scrollTop, 140);
  assert.deepEqual(wrapper.emitted("scroll-position")?.at(-1), [140]);
});

test("图片解码失败、下载失败及无图文档均结束恢复并允许后续正常滚动", async () => {
  const wrapper = setup("![bad](bad.png)", "repo/docs/README.md", 900);
  const root = wrapper.get("[data-editor-markdown-preview]");
  const geometry = scrollGeometry(root.element as HTMLElement);
  await settle();
  await wrapper.get("img").trigger("error");
  await settle();
  assert.deepEqual(wrapper.emitted("scroll-position")?.at(-1), [0]);
  response = () => { throw new Error("offline"); };
  await wrapper.setProps({ path: "repo/docs/other.md", text: "![offline](offline.png)", scrollTop: 600 });
  await settle();
  assert.deepEqual(wrapper.emitted("scroll-position")?.at(-1), [0]);
  await wrapper.setProps({ text: "# No images", scrollTop: 0 });
  await settle();
  geometry.setMax(1000);
  root.element.scrollTop = 230;
  await root.trigger("scroll");
  assert.deepEqual(wrapper.emitted("scroll-position")?.at(-1), [230]);
});

test("旧图片 load 与已排队恢复在文档变化或卸载后不得回写", async () => {
  const wrapper = setup("![old](old.png)", "repo/docs/README.md", 900);
  const root = wrapper.get("[data-editor-markdown-preview]").element as HTMLElement;
  const geometry = scrollGeometry(root);
  await settle();
  const oldImage = wrapper.get("img");
  await wrapper.setProps({ workspaceId: "new-workspace", path: "other/README.md", text: "# New", scrollTop: 40 });
  geometry.setMax(1000);
  await oldImage.trigger("load");
  await settle();
  assert.equal(root.scrollTop, 40);
  assert.deepEqual(wrapper.emitted("scroll-position")?.at(-1), [40]);
  const positions = wrapper.emitted("scroll-position")!;
  const count = positions.length;
  await wrapper.setProps({ text: "![new](new.png)" });
  wrapper.unmount();
  wrappers.splice(wrappers.indexOf(wrapper), 1);
  await oldImage.trigger("error");
  await settle();
  assert.equal(positions.length, count);
});
