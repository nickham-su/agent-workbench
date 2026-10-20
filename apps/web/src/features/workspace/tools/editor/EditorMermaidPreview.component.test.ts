import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { nextTick } from "vue";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import mermaid from "mermaid";
import zhCN from "@/shared/i18n/locales/zh-CN";
import { sanitizeAgentMarkdown } from "../agent/assistantMarkdownSanitizer";
import { renderEditorMarkdown } from "./editorMarkdown";
import { MERMAID_MAX_NODES, MERMAID_MAX_EDGES, loadMermaid, renderMermaidPreview, sanitizeMermaidSvg } from "./editorMermaid";
import EditorMermaidPreview from "./EditorMermaidPreview.vue";

const originalRender = mermaid.render;
const wrappers: Array<ReturnType<typeof mount>> = [];
const calls: Array<{ id: string; text: string }> = [];
let response: ((id: string, text: string) => Promise<{ svg: string; diagramType: string }>) | undefined;
const sample = (id: string, text = "graph") => `<svg id="${id}" xmlns="http://www.w3.org/2000/svg"><defs><marker id="arrow"><path d="M0 0L1 1"/></marker></defs><text>${text}</text><path marker-end="url(#arrow)"/><style>#${id}{fill:red;}#${id} > .edge{marker-end:url(#arrow)}@keyframes dash{to{stroke-dashoffset:0}}</style></svg>`;
async function flushUpdates() { for (let i = 0; i < 5; i++) await nextTick(); }
async function waitFor(condition: () => boolean, message: string, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    assert.ok(Date.now() < deadline, `等待条件超时：${message}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await nextTick();
  }
  await flushUpdates();
}
const svgText = (wrapper: ReturnType<typeof mount>) => wrapper.find("svg text").exists() ? wrapper.get("svg text").text() : undefined;
function setup(text = "flowchart LR\nA-->B", scrollTop = 0) {
  mermaid.render = async (id, source) => {
    calls.push({ id, text: source });
    return response ? response(id, source) : { svg: sample(id, source.includes("new") ? "new" : "old"), diagramType: "flowchart-v2" };
  };
  const wrapper = mount(EditorMermaidPreview, { attachTo: document.body, props: { text, scrollTop }, global: { plugins: [createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } })] } });
  wrappers.push(wrapper); return wrapper;
}
afterEach(() => { for (const wrapper of wrappers.splice(0)) wrapper.unmount(); mermaid.render = originalRender; calls.length = 0; response = undefined; });

test("加载 Promise 被缓存，初始化严格配置一次且不自动启动", async () => {
  const original = mermaid.initialize;
  const configs: unknown[] = [];
  let fail = true;
  mermaid.initialize = (config) => { if (fail) throw new Error("fixture load failure"); configs.push(config); original(config); };
  try {
    await assert.rejects(() => loadMermaid(), (error: any) => error.reason === "loadFailed");
    fail = false;
    const first = loadMermaid();
    const second = loadMermaid();
    assert.equal(first, second); assert.equal(await first, mermaid);
    assert.equal(configs.length, 1);
    assert.equal((configs[0] as any).securityLevel, "strict");
    assert.equal((configs[0] as any).htmlLabels, false);
    assert.equal((configs[0] as any).startOnLoad, false);
    assert.equal(await loadMermaid(), mermaid); assert.equal(configs.length, 1);
  } finally { mermaid.initialize = original; }
});
test("实际SVG清洗保留箭头和样式，移除交互、外部资源及危险CSS", () => {
  const id = "editor-mermaid-safe";
  const clean = sanitizeMermaidSvg(sample(id).replace("</svg>", '<script>alert(1)</script><foreignObject><img src="https://evil.test/x"/></foreignObject><image href="https://evil.test/x"/><use href="https://evil.test/x"/><a href="https://evil.test/x"><text>link</text></a><style>body{color:red}</style><path onclick="alert(1)" style="fill:url(https://evil.test/x)" fill="url(https://evil.test/x)"/><path style="fill:u\\72l(https://evil.test/x)"/><style>@import "https://evil.test/x";</style></svg>'), id);
  const host = new window.DOMParser().parseFromString(clean, "image/svg+xml");
  assert.equal(host.querySelector("script,foreignObject,image,use,a"), null);
  assert.equal(host.querySelector("[onclick],[href],[xlink\\:href]"), null);
  assert.ok(host.querySelector('path[marker-end="url(#arrow)"]'));
  assert.ok(host.querySelector("style")?.textContent?.includes(`#${id} > .edge`));
  assert.ok(!host.querySelector("style")?.textContent?.includes("@keyframes"));
  assert.ok(!clean.includes("evil.test")); assert.ok(!clean.includes("body{"));
});
test("SVG与Markdown、Agent共享hook双向隔离", () => {
  const id = "editor-mermaid-isolation";
  const before = sanitizeMermaidSvg(sample(id), id);
  sanitizeAgentMarkdown('<img src="https://evil.test/x"><a href="javascript:alert(1)">x</a>');
  renderEditorMarkdown("![x](a.png)", "README.md");
  assert.equal(sanitizeMermaidSvg(sample(id), id), before);
  assert.ok(!sanitizeAgentMarkdown('<img src="x">').includes("<img"));
  assert.ok(renderEditorMarkdown("![x](a.png)", "README.md").html.includes("data-md-image"));
});
test("正常渲染恢复滚动并在内容变化后清空旧图", async () => {
  const wrapper = setup(undefined, 34);
  await waitFor(() => svgText(wrapper) === "old" && (wrapper.element as HTMLElement).scrollTop === 34, "初次 SVG 和滚动恢复");
  assert.equal(wrapper.get("svg text").text(), "old");
  assert.equal((wrapper.element as HTMLElement).scrollTop, 34);
  await wrapper.setProps({ text: "flowchart LR\nnew-->B" });
  assert.equal(wrapper.find("svg").exists(), false);
  await waitFor(() => svgText(wrapper) === "new", "修改后的 SVG");
  assert.equal(wrapper.get("svg text").text(), "new");
  assert.equal(new Set(calls.map((call) => call.id)).size, 2);
  assert.equal(document.querySelector("[data-editor-mermaid-layout]"), null);
});
test("快速修改只渲染最终内容，迟到结果不得覆盖新图", async () => {
  let finish: (() => void) | undefined;
  response = (id, text) => text.includes("old") ? new Promise((resolve) => { finish = () => resolve({ svg: sample(id, "old"), diagramType: "flowchart-v2" }); }) : Promise.resolve({ svg: sample(id, "new"), diagramType: "flowchart-v2" });
  const wrapper = setup("flowchart LR\nold-->B");
  await waitFor(() => !!finish, "旧布局已启动");
  await wrapper.setProps({ text: "flowchart LR\nnew-->B" });
  assert.equal(wrapper.find("svg").exists(), false);
  assert.equal(document.querySelector("[data-editor-mermaid-layout]"), null);
  assert.equal(calls.length, 1);
  // Real Mermaid serializes layout; the old parse/render must finish before the
  // next parse can safely use its shared DB. Its stale result is never published.
  finish?.(); await flushUpdates();
  assert.notEqual(svgText(wrapper), "old");
  await waitFor(() => svgText(wrapper) === "new", "旧布局完成后的新 SVG");
  await wrapper.setProps({ text: "flowchart LR\nignore-->B" });
  await wrapper.setProps({ text: "flowchart LR\nnewest-->B" });
  await waitFor(() => calls.some((call) => call.text.includes("newest")) && svgText(wrapper) === "new", "最终图源渲染");
  assert.ok(!calls.some((call) => call.text.includes("ignore")));
});
test("卸载后的迟到结果不回写且清理布局DOM", async () => {
  let finish: (() => void) | undefined;
  response = (id) => new Promise((resolve) => { finish = () => resolve({ svg: sample(id), diagramType: "flowchart-v2" }); });
  const wrapper = setup();
  await waitFor(() => !!finish, "卸载前布局已启动");
  wrapper.unmount(); wrappers.pop();
  assert.equal(document.querySelector("[data-editor-mermaid-layout]"), null);
  finish?.(); await flushUpdates();
  assert.equal(document.querySelector("[data-editor-mermaid-layout]"), null);
  assert.equal(document.querySelector("[data-editor-mermaid-preview]"), null);
});
test("语法错误可恢复、不显示旧图、解析失败也清理临时DOM", async () => {
  response = async () => { throw new Error("parse failure source must not leak"); };
  const wrapper = setup("flowchart LR\nA-->");
  await waitFor(() => wrapper.text().includes("请检查源码语法"), "解析错误状态");
  assert.equal(wrapper.find("svg").exists(), false);
  assert.ok(wrapper.text().includes("请检查源码语法"));
  assert.ok(!wrapper.text().includes("parse failure"));
  assert.equal(document.querySelector("[data-editor-mermaid-layout]"), null);
  await wrapper.setProps({ text: "flowchart LR\nA-->B" });
  await waitFor(() => calls.length === 1 && wrapper.text().includes("请检查源码语法"), "布局错误状态");
  assert.equal(calls.length, 1);
  assert.ok(wrapper.text().includes("请检查源码语法"));
  assert.equal(document.querySelector("[data-editor-mermaid-layout]"), null);
  response = undefined; await wrapper.setProps({ text: "flowchart LR\nnew-->B" });
  await waitFor(() => svgText(wrapper) === "new", "错误恢复后的 SVG");
  assert.equal(wrapper.get("svg text").text(), "new");
});
test("空内容与不安全资源在渲染库创建DOM之前失败", async () => {
  const wrapper = setup(""); assert.ok(wrapper.text().includes("图表内容为空")); assert.equal(calls.length, 0);
  await wrapper.setProps({ text: 'flowchart LR\nA@{ img: "https://evil.test/x" }' });
  await waitFor(() => wrapper.text().includes("外部资源"), "解析后的资源拒绝状态");
  assert.ok(wrapper.text().includes("外部资源")); assert.equal(calls.length, 0);
  assert.equal(document.querySelector("[data-editor-mermaid-layout]"), null);
});

test("真实解析后阻断 YAML 转义图片、icon 和转义 HTML 标签，绝不进入布局", async () => {
  let layouts = 0;
  mermaid.render = async (id) => { layouts++; return { svg: sample(id), diagramType: "flowchart-v2" }; };
  for (const text of [
    'flowchart LR\nA@{ img: "https://example.invalid/pixel.png" }',
    'flowchart LR\nA@{ "img": "data:image/svg+xml,x" }',
    'flowchart LR\nA@{label: "}", "i\\u006dg": "https://example.invalid/pixel.png"}',
    'flowchart-elk LR\nA@{label: "}", "i\\u006dg": "https://example.invalid/pixel.png"}',
    'flowchart LR\nA@{label: "} \\"quoted\\"", "i\\u006dg": "https://example.invalid/pixel.png"}',
    'flowchart LR\nA@{label: "\\u007d", "i\\x6dg": "https://example.invalid/pixel.png"}',
    'flowchart LR\nA@{ "ic\\u006fn": "logos:aws" }',
    'flowchart LR\nA@{ shape: icon }',
    'flowchart LR\nA@{label: "\\u003cimg src=https://example.invalid/pixel.png>"}',
    'kanban\n  Todo\n    A@{ "ic\\u006fn": "logos:aws" }',
    'sequenceDiagram\nparticipant Alice\nproperties Alice: {"ic\\u006fn":"https://example.invalid/pixel.png"}',
  ]) {
    await assert.rejects(() => renderMermaidPreview(text), (error: any) => error.reason === "unsafe", text);
  }
  assert.equal(layouts, 0);
  assert.equal(document.querySelector("[data-editor-mermaid-layout]"), null);
});

test("真实解析允许标签中的 image/src/icon 词汇及普通 YAML 转义", async () => {
  let layouts = 0;
  mermaid.render = async (id) => { layouts++; return { svg: sample(id), diagramType: "flowchart-v2" }; };
  for (const text of [
    "sequenceDiagram\nAlice->>Bob: image: upload complete",
    'flowchart LR\nA["src: local path"]',
    'flowchart LR\nA@{label: "} \\u0073rc: local path"}',
  ]) assert.ok((await renderMermaidPreview(text)).includes("<svg"));
  assert.equal(layouts, 3);
});

test("真实解析按展开后的节点和边预算拒绝少行分组、长链和笛卡尔积", async () => {
  let layouts = 0;
  mermaid.render = async (id) => { layouts++; return { svg: sample(id), diagramType: "flowchart-v2" }; };
  const group = (n: number, prefix = "N") => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(" & ");
  for (const text of [
    `flowchart LR\n${group(3000)}`,
    `flowchart-elk LR\n${group(MERMAID_MAX_NODES + 1)}`,
    `flowchart LR\n${group(MERMAID_MAX_NODES + 1)}`,
    `flowchart LR\n${Array.from({ length: MERMAID_MAX_NODES + 1 }, (_, i) => `N${i}`).join(" --> ")}`,
    `flowchart LR\n${Array.from({ length: MERMAID_MAX_EDGES + 2 }, () => "A").join(" --> ")}`,
    `flowchart LR\n${group(18, "A")} --> ${group(18, "B")}`,
  ]) await assert.rejects(() => renderMermaidPreview(text), (error: any) => error.reason === "tooLarge", text.slice(0, 70));
  assert.equal(layouts, 0);
  assert.equal(document.querySelector("[data-editor-mermaid-layout]"), null);
  await renderMermaidPreview(`flowchart LR\n${group(MERMAID_MAX_NODES)}`);
  await renderMermaidPreview(`flowchart LR\n${Array.from({ length: MERMAID_MAX_EDGES + 1 }, () => "A").join(" --> ")}`);
  assert.equal(layouts, 2);
});

test("CR-only/CRLF 配置、样式及超限语句在解析和布局前拒绝", async () => {
  let parses = 0;
  let layouts = 0;
  const originalApi = mermaid.mermaidAPI;
  mermaid.mermaidAPI = {
    ...originalApi,
    getDiagramFromText: (...args) => { parses++; return originalApi.getDiagramFromText(...args); },
  };
  mermaid.render = async (id) => { layouts++; return { svg: sample(id), diagramType: "flowchart-v2" }; };
  try {
    for (const newline of ["\r", "\r\n"]) {
      for (const [lines, reason] of [
        [["---", "config:", "  theme: dark", "---", "flowchart LR", "A-->B"], "unsafe"],
        [["flowchart LR", "A-->B", "classDef default fill:red}body{background:red"], "unsafe"],
        [["flowchart LR", "A-->B", "style A filter:blur(2px)"], "unsafe"],
        [["flowchart LR", "A-->B", "linkStyle default stroke-linecap:square"], "unsafe"],
        [["flowchart LR", ...Array<string>(500).fill("A")], "tooLarge"],
      ] as const) {
        await assert.rejects(() => renderMermaidPreview(lines.join(newline)), (error: any) => error.reason === reason);
      }
    }
    assert.equal(parses, 0);
    assert.equal(layouts, 0);
    assert.equal(document.querySelector("[data-editor-mermaid-layout]"), null);
  } finally { mermaid.mermaidAPI = originalApi; }
});

test("防抖使用可控时钟，仅在最终修改满 120ms 后启动布局", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let wrapper: ReturnType<typeof mount>;
  try {
    wrapper = setup("flowchart LR\ninitial-->B");
    context.mock.timers.tick(119); await nextTick();
    assert.equal(calls.length, 0);
    await wrapper.setProps({ text: "flowchart LR\nnewest-->B" });
    context.mock.timers.tick(119); await nextTick();
    assert.equal(calls.length, 0);
    context.mock.timers.tick(1);
  } finally { context.mock.timers.reset(); }
  await waitFor(() => svgText(wrapper) === "new", "防抖后的 SVG");
  assert.deepEqual(calls.map((call) => call.text), ["flowchart LR\nnewest-->B"]);
});

const lines = (count: number, make: (index: number) => string) => Array.from({ length: count }, (_, index) => make(index)).join("\n");
const budgetCases: Array<[string, (count: number) => string]> = [
  ["class 声明", (n) => `classDiagram\n${lines(n, (i) => `class C${i}`)}`],
  ["class 关系", (n) => `classDiagram\n${lines(n, () => "A --> B")}`],
  ["class 命名空间也计入节点", (n) => `classDiagram\nnamespace Group {\n${lines(n - 1, (i) => `class C${i}`)}\n}`],
  ["class 注释节点及连接", (n) => `classDiagram\nclass A\n${lines(n - 1, (i) => `note for A "Note${i}"`)}`],
  ["state 声明", (n) => `stateDiagram-v2\n${lines(n, (i) => `S${i}`)}`],
  ["state 带标签声明", (n) => `stateDiagram-v2\n${lines(n, (i) => `state "State${i}" as S${i}`)}`],
  ["state 关系", (n) => `stateDiagram-v2\n${lines(n, () => "A --> B")}`],
  ["state 嵌套子图也计入节点", (n) => `stateDiagram-v2\nstate Group {\n${lines(n - 1, (i) => `S${i}`)}\n}`],
  ["ER 实体", (n) => `erDiagram\n${lines(n, (i) => `E${i}`)}`],
  ["ER 关系", (n) => `erDiagram\n${lines(n, () => "A ||--o{ B : owns")}`],
  ["pie 切片", (n) => `pie\n${lines(n, (i) => `"Slice${i}" : 1`)}`],
  ["gantt 任务", (n) => `gantt\ndateFormat YYYY-MM-DD\n${lines(n, (i) => `Task${i} :t${i}, 2026-10-20, 1d`)}`],
  ["gantt 分组和任务合计", (n) => `gantt\ndateFormat YYYY-MM-DD\n${lines(n - 1, (i) => `section Section${i}`)}\nTask :t, 2026-10-20, 1d`],
  ["sequence 参与者", (n) => `sequenceDiagram\n${lines(n, (i) => `participant P${i}`)}`],
  ["sequence 消息", (n) => `sequenceDiagram\n${lines(n, () => "A->>B: hello")}`],
  ["kanban 卡片及列", (n) => `kanban\n  Todo\n${lines(n - 1, (i) => `    Card${i}`)}`],
];
for (const [name, source] of budgetCases) {
  test(`真实 parser 预算边界：${name}，301 拒绝且 300 允许`, async () => {
    let layouts = 0;
    mermaid.render = async (id) => { layouts++; return { svg: sample(id), diagramType: "fixture" }; };
    await assert.rejects(() => renderMermaidPreview(source(301)), (error: any) => error.reason === "tooLarge");
    assert.equal(layouts, 0);
    assert.equal(document.querySelector("[data-editor-mermaid-layout]"), null);
    assert.ok((await renderMermaidPreview(source(300))).includes("<svg"));
    assert.equal(layouts, 1);
  });
}

test("未审计图型显式不支持，包括 architecture 内置静态和自定义包图标", async () => {
  let layouts = 0;
  mermaid.render = async (id) => { layouts++; return { svg: sample(id), diagramType: "fixture" }; };
  for (const text of [
    "futureDiagram\nA-->B",
    "architecture-beta\nservice db(database)[Database]",
    "architecture-beta\nservice api(logos:aws-lambda)[API]",
    "mindmap\n  root((Root))\n    Child",
    "timeline\n  title Plan\n  2026 : Work",
    "journey\n  title Work\n  section Tasks\n    Task: 5: Alice",
  ]) await assert.rejects(() => renderMermaidPreview(text), (error: any) => error.reason === "unsupported");
  assert.equal(layouts, 0);
  assert.equal(document.querySelector("[data-editor-mermaid-layout]"), null);
});

test("未来未知 parser 类型不能因缺少适配而静默放行", async () => {
  const originalApi = mermaid.mermaidAPI;
  let layouts = 0;
  mermaid.render = async (id) => { layouts++; return { svg: sample(id), diagramType: "fixture" }; };
  mermaid.mermaidAPI = {
    ...originalApi,
    getDiagramFromText: async (...args) => {
      const diagram = await originalApi.getDiagramFromText(...args);
      diagram.type = "future-unknown-type";
      return diagram;
    },
  };
  try {
    await assert.rejects(() => renderMermaidPreview("flowchart LR\nA-->B"), (error: any) => error.reason === "unsupported");
    assert.equal(layouts, 0);
  } finally { mermaid.mermaidAPI = originalApi; }
});

test("DB 计数接口不再返回有效数量时也拒绝布局", async () => {
  const originalApi = mermaid.mermaidAPI;
  let layouts = 0;
  mermaid.render = async (id) => { layouts++; return { svg: sample(id), diagramType: "fixture" }; };
  mermaid.mermaidAPI = {
    ...originalApi,
    getDiagramFromText: async (...args) => {
      const diagram = await originalApi.getDiagramFromText(...args);
      diagram.type = "pie";
      diagram.db = { ...diagram.db, getSections: () => ({}) } as typeof diagram.db;
      return diagram;
    },
  };
  try {
    await assert.rejects(() => renderMermaidPreview("flowchart LR\nA-->B"), (error: any) => error.reason === "unsupported");
    assert.equal(layouts, 0);
  } finally { mermaid.mermaidAPI = originalApi; }
});

test("不支持图型展示明确状态且保留原始源码，恢复常用图后正常预览", async () => {
  const source = "architecture-beta\nservice db(database)[Database]";
  const wrapper = setup(source);
  await waitFor(() => wrapper.text().includes("暂不支持此图表类型"), "不支持图型状态");
  assert.equal(calls.length, 0);
  assert.equal(wrapper.find("svg").exists(), false);
  assert.equal(wrapper.props("text"), source);
  await wrapper.setProps({ text: "flowchart LR\nnew-->B" });
  await waitFor(() => svgText(wrapper) === "new", "切回支持图型后的 SVG");
});

test("组件前置校验立即拒绝 CR-only/CRLF 配置、样式和超限语句", async () => {
  const wrapper = setup();
  for (const newline of ["\r", "\r\n"]) {
    for (const [lines, message] of [
      [["---", "config:", "  theme: dark", "---", "flowchart LR", "A-->B"], "外部资源"],
      [["flowchart LR", "A-->B", "style A filter:blur(2px)"], "外部资源"],
      [["flowchart LR", ...Array<string>(500).fill("A")], "超过"],
    ] as const) {
      await wrapper.setProps({ text: lines.join(newline) });
      assert.ok(wrapper.text().includes(message));
      assert.equal(wrapper.find("svg").exists(), false);
    }
  }
  assert.equal(calls.length, 0);
});

test("组件与直接入口向真实解析器及布局传递相同的正规化图源", async () => {
  const parsed: string[] = [];
  const originalApi = mermaid.mermaidAPI;
  mermaid.mermaidAPI = {
    ...originalApi,
    getDiagramFromText: (text, ...args) => { parsed.push(text); return originalApi.getDiagramFromText(text, ...args); },
  };
  const source = "flowchart LR\nA-->B\nclassDef default fill:#fff,stroke:#333";
  try {
    const wrapper = setup(source.replace(/\n/g, "\r"));
    await waitFor(() => wrapper.find("svg").exists(), "CR 图源 SVG");
    assert.ok(wrapper.find("svg").exists());
    await wrapper.setProps({ text: source.replace(/\n/g, "\r\n") });
    await waitFor(() => wrapper.find("svg").exists(), "CRLF 图源 SVG");
    await renderMermaidPreview(source.replace(/\n/g, "\r"));
    await renderMermaidPreview(source.replace(/\n/g, "\r\n"));
    assert.deepEqual(parsed, Array<string>(4).fill(source));
    assert.deepEqual(calls.map((call) => call.text), parsed);
    assert.equal(wrapper.props("text"), source.replace(/\n/g, "\r\n"));
  } finally { mermaid.mermaidAPI = originalApi; }
});
