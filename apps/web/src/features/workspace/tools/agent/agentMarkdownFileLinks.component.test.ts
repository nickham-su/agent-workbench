import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import type { AgentMessage, AgentMessageSessionRunState, FileStatResponse } from "@agent-workbench/shared";
import { computed, nextTick } from "vue";
import { createI18n } from "vue-i18n";
import { mount } from "@vue/test-utils";
import { message, notification } from "ant-design-vue";
import zhCN from "@/shared/i18n/locales/zh-CN";
import { apiClient } from "@/shared/api/api";
import { workspaceContextKey } from "../../context";
import { workspaceHostKey } from "../../host";
import { agentSessionStatusStoreKey } from "./useAgentSessionStatusStore";
import AssistantMarkdownMessage from "./AssistantMarkdownMessage.vue";
import paneComponent from "./AgentClientPane.vue";

const AgentClientPane = paneComponent.__vccOpts ?? paneComponent;
const wrappers: Array<ReturnType<typeof mount>> = [];
const originalAdapter = apiClient.defaults.adapter;
const i18n = () => createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } });
const turns = async () => {
  await nextTick();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await nextTick();
};

afterEach(async () => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  apiClient.defaults.adapter = originalAdapter;
  await turns();
  message.destroy();
  notification.destroy();
  await turns();
});

function mountMarkdown(text: string, streaming = false) {
  const wrapper = mount(AssistantMarkdownMessage, {
    attachTo: document.body,
    props: { text, messageId: "markdown-message", streaming },
    global: { plugins: [i18n()] },
  });
  wrappers.push(wrapper);
  return wrapper;
}

function click(element: Element) {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  element.dispatchEvent(event);
  return event;
}

function file(path: string): FileStatResponse {
  return { path, normalizedPath: path, ok: true, kind: "file", version: { size: 1024 ** 3, mtimeMs: 1 } };
}
const missing = (path: string): FileStatResponse => ({ path, ok: false, reason: "missing" });

test("真实 Markdown→清洗→点击：根文件行列、范围及编码路径都发出统一语义事件", async () => {
  for (const [href, expected] of [
    ["README.md:12:3", { path: "README.md", line: 12, column: 3 }],
    ["src/a.ts:12", { path: "src/a.ts", line: 12 }],
    ["./src/a%20b.ts#L4-L8", { path: "src/a b.ts", line: 4 }],
    ["src/%E4%B8%AD%E6%96%87.ts#L2", { path: "src/中文.ts", line: 2 }],
  ] as const) {
    const wrapper = mountMarkdown(`[**文件**](${href})`);
    const link = wrapper.get("a");
    assert.ok(link.attributes("href")?.startsWith("./"));
    assert.equal(link.attributes("rel"), "noopener noreferrer");
    assert.equal(wrapper.emitted("open-file"), undefined);
    assert.equal(click(link.element.querySelector("strong")!).defaultPrevented, true);
    const [actual, isCurrent] = wrapper.emitted("open-file")![0] as [unknown, () => boolean];
    assert.deepEqual(actual, expected);
    assert.equal(isCurrent(), true);
    wrapper.unmount();
    wrappers.pop();
    assert.equal(isCurrent(), false);
  }
});

test("不安全/不支持的显式路径及异常行号被阻止，不进行文件打开", () => {
  for (const href of ["../a.ts", "src/%2e%2e/a.ts", "/repo/a.ts", "C:/repo/a.ts", "a.ts:0", "a.ts#L0", "src/a.ts:9007199254740992"]) {
    const wrapper = mountMarkdown(`[文件](${href})`);
    assert.equal(click(wrapper.get("a").element).defaultPrevented, true);
    assert.equal(wrapper.emitted("open-file"), undefined);
    assert.equal(wrapper.emitted("invalid-file-link")!.length, 1);
  }
  const dangerous = mountMarkdown("[bad](javascript:alert(1)) [local](file:///repo/a.ts)");
  assert.equal(dangerous.findAll("a").length, 0);
});

test("外链和章节保留原行为，裸路径/行内代码不自动链接，代码复制继续工作", async (t) => {
  const copied: string[] = [];
  const clipboard = navigator.clipboard;
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { copied.push(text); } } });
  t.mock.method(message, "success", () => undefined);
  try {
    const wrapper = mountMarkdown("[网站](https://example.com) [邮箱](mailto:a@example.com) [协议相对](//example.com/a) [章节](#section)\n\n<https://example.org>\n\nsrc/a.ts:12 `src/b.ts:2`\n\n```ts\nconst n = 1;\n```");
    for (const link of wrapper.findAll("a")) {
      assert.equal(link.attributes("data-agent-file-link"), undefined);
      assert.equal(link.attributes("target"), "_blank");
      assert.equal(link.attributes("rel"), "noopener noreferrer");
      assert.equal(click(link.element).defaultPrevented, false);
    }
    assert.equal(wrapper.findAll("a").length, 5);
    assert.equal(wrapper.emitted("open-file"), undefined);
    click(wrapper.get("[data-copy-code='1']").element);
    await turns();
    assert.deepEqual(copied, ["const n = 1;\n"]);
  } finally {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
  }
});

test("流式 Markdown 仍按现有 debounce 渲染，渲染本身不打开文件", async () => {
  const wrapper = mountMarkdown("[文件](README.md:2)", true);
  assert.equal(wrapper.findAll("a").length, 0);
  await new Promise((resolve) => setTimeout(resolve, 310));
  await nextTick();
  assert.equal(wrapper.findAll("a").length, 1);
  assert.equal(wrapper.emitted("open-file"), undefined);
});

async function mountPane(stat: (path: string) => FileStatResponse | Promise<FileStatResponse>, texts = ["[正文](README.md:12:3)", "[推理](src/reason.ts#L4-L8)"]) {
  const calls: unknown[][] = [];
  const requests: Array<{ workspaceId: string; path: string }> = [];
  apiClient.defaults.adapter = async (config) => {
    if (config.url?.endsWith("/files/stat")) {
      const path = JSON.parse(config.data).path as string;
      requests.push({ workspaceId: config.url.split("/")[2], path });
      return { config, data: await stat(path), status: 200, statusText: "OK", headers: {} };
    }
    throw new Error("unexpected API request in Markdown link test");
  };
  const wrapper = mount(AgentClientPane, {
    attachTo: document.body,
    props: {
      workspaceId: "ws-a", toolId: "agent-tool", sessionId: "session-a", sessionKind: "primary",
      sessionReady: false, active: false, agentOptions: [], sessionModelStates: {},
      sessionModelStateLoading: false, sessionModelMutationPending: false, modelOpenIntent: null,
    },
    global: {
      plugins: [i18n()],
      provide: {
        [workspaceContextKey as symbol]: {
          repos: computed(() => [{ dirName: "repo-a" }, { dirName: "repo-b" }]),
          currentRepo: computed(() => ({ dirName: "repo-a" })),
          currentTarget: computed(() => ({ kind: "workspaceRepo", workspaceId: "ws-a", dirName: "repo-a" })),
          setCurrentRepo() {}, statusByDirName: {},
        },
        [workspaceHostKey as symbol]: {
          openTool() {}, minimizeTool() {}, toggleMinimize() {}, setToolDot() {},
          registerToolCommands() { return () => undefined; }, emitToolEvent() {},
          callFrom(...args: unknown[]) { calls.push(args); },
        },
        [agentSessionStatusStoreKey as symbol]: {
          getRunState: () => computed(() => ({ status: "idle", nonTerminalMessageIds: [], nonTerminalToolExecutionIds: [] }) as unknown as AgentMessageSessionRunState),
        },
      },
      stubs: {
        "a-button": true, "a-tooltip": true, "a-input": true,
        "a-select": true, "a-modal": true, "a-tag": true, "a-alert": true,
        "a-checkbox": true, "a-checkbox-group": true, "a-cascader": true,
        EditOutlined: true, CopyOutlined: true, FileImageOutlined: true, RobotOutlined: true,
        AppstoreOutlined: true, DownOutlined: true, LoadingOutlined: true,
        AgentAttachmentPreviewModal: true, AgentConversationToolCall: true,
        AgentMessageActions: true, AgentUserMessage: true,
      },
    },
  });
  wrappers.push(wrapper);
  const setTexts = async (values: string[]) => {
    const messages = values.length ? [{
      id: "message-a", workspaceId: "ws-a", type: "assistant", status: "completed", createdAt: 1,
      parts: values.map((text, position) => ({ id: `part-${position}`, messageId: "message-a", position, type: position === 1 ? "reasoning" : "text", text })),
    } as AgentMessage] : [];
    const vm = wrapper.vm as unknown as { timelineState: { revision: number; messages: AgentMessage[]; toolExecutions: [] } };
    vm.timelineState = { revision: 1, messages, toolExecutions: [] };
    await nextTick();
  };
  await setTexts(texts);
  return { wrapper, requests, calls, setTexts };
}

test("正文和推理都接入：只在点击后 stat，大文件直接委托只读编辑器", async () => {
  const fixture = await mountPane((path) => file(path));
  assert.deepEqual(fixture.requests, []);
  assert.equal(fixture.wrapper.findAll("a[data-agent-file-link]").length, 2);
  click(fixture.wrapper.get("a[data-agent-file-link]").element);
  await turns();
  assert.deepEqual(fixture.requests, [{ workspaceId: "ws-a", path: "README.md" }]);
  assert.deepEqual(fixture.calls[0], ["agent-tool", "editor", { type: "editor.openFile", payload: { path: "README.md", mode: "preview", line: 12, column: 3, highlight: { kind: "line" } } }]);
  click(fixture.wrapper.get(".assistant-reasoning-markdown a").element);
  await turns();
  assert.deepEqual(fixture.calls[1], ["agent-tool", "editor", { type: "editor.openFile", payload: { path: "src/reason.ts", mode: "preview", line: 4, highlight: { kind: "line" } } }]);
  assert.equal(fixture.requests.length, 2);
});

test("即使路径带仓库前缀也搜索全部仓库，不使用当前仓库猜测", async () => {
  const fixture = await mountPane((path) => path === "repo-b/repo-a/src/a.ts" ? file(path) : missing(path), ["[文件](repo-a/src/a.ts:2)"]);
  click(fixture.wrapper.get("a[data-agent-file-link]").element);
  await turns();
  assert.deepEqual(fixture.requests.map((request) => request.path), ["repo-a/src/a.ts", "repo-a/repo-a/src/a.ts", "repo-b/repo-a/src/a.ts"]);
  assert.equal((fixture.calls[0][2] as { payload: { path: string } }).payload.path, "repo-b/repo-a/src/a.ts");
});

for (const scenario of ["missing", "multiple", "failed"] as const) {
  test(`${scenario} 候选不打开文件，并显示对应默认提示`, async (t) => {
    const warnings: unknown[] = [];
    t.mock.method(message, "warning", (text: unknown) => { warnings.push(text); });
    const fixture = await mountPane((path) => {
      if (path === "src/a.ts") return missing(path);
      if (scenario === "failed" && path.startsWith("repo-b/")) throw new Error("request failed");
      return scenario === "missing" ? missing(path) : file(path);
    }, ["[文件](src/a.ts)"]);
    click(fixture.wrapper.get("a[data-agent-file-link]").element);
    await turns();
    assert.deepEqual(fixture.calls, []);
    assert.deepEqual(warnings, [scenario === "failed" ? "链接文件探测失败，请重试" : "链接文件不存在或者位置不确定"]);
  });
}

test("非法路径通过真实组件接线提示，不发起 stat", async (t) => {
  const warnings: unknown[] = [];
  t.mock.method(message, "warning", (text: unknown) => { warnings.push(text); });
  const fixture = await mountPane((path) => file(path), ["[文件](src/%2e%2e/a.ts)"]);
  click(fixture.wrapper.get("a[data-agent-file-link]").element);
  await turns();
  assert.deepEqual(fixture.requests, []);
  assert.deepEqual(fixture.calls, []);
  assert.deepEqual(warnings, [zhCN.agent.client.fileLinkInvalidPath]);
});

for (const change of ["workspace", "unmount", "source-unmount", "newer-click"] as const) {
  test(`探测期间 ${change}，丢弃迟到结果`, async (t) => {
    const warnings: unknown[] = [];
    t.mock.method(message, "warning", (text: unknown) => { warnings.push(text); });
    let resolve!: (result: FileStatResponse) => void;
    const pending = new Promise<FileStatResponse>((done) => { resolve = done; });
    const fixture = await mountPane((path) => path === "old.ts" ? pending : file(path), ["[旧文件](old.ts)", "[新文件](new.ts)"]);
    click(fixture.wrapper.get("a[data-agent-file-link]").element);
    await turns();
    assert.equal(fixture.requests.length, 1);
    if (change === "workspace") await fixture.wrapper.setProps({ workspaceId: "ws-b" });
    if (change === "unmount") { fixture.wrapper.unmount(); wrappers.pop(); }
    if (change === "source-unmount") await fixture.setTexts([]);
    if (change === "newer-click") {
      click(fixture.wrapper.get(".assistant-reasoning-markdown a").element);
      await turns();
      assert.equal(fixture.calls.length, 1);
      assert.equal((fixture.calls[0][2] as { payload: { path: string } }).payload.path, "new.ts");
    }
    resolve(file("old.ts"));
    await turns();
    assert.equal(fixture.calls.length, change === "newer-click" ? 1 : 0);
    assert.deepEqual(warnings, []);
  });
}

for (const target of ["body-to-reasoning", "reasoning-to-body", "different-message"] as const) {
  for (const invalid of ["path", "position"] as const) {
    for (const lateResult of ["file", "failed"] as const) {
      test(`M1：${target} 点击无效 ${invalid} 后，丢弃先前 ${lateResult} 结果`, async (t) => {
        const warnings: unknown[] = [];
        t.mock.method(message, "warning", (text: unknown) => { warnings.push(text); });
        let resolve!: (result: FileStatResponse) => void;
        const pending = new Promise<FileStatResponse>((done) => { resolve = done; });
        const invalidHref = invalid === "path" ? "../bad.ts" : "bad.ts:0";
        const texts = ["[旧文件](old.ts)", `[无效文件](${invalidHref})`];
        if (target === "reasoning-to-body") texts.reverse();
        const fixture = await mountPane(() => pending, texts);

        if (target === "different-message") {
          const vm = fixture.wrapper.vm as unknown as { timelineState: { revision: number; messages: AgentMessage[]; toolExecutions: [] } };
          const current = vm.timelineState;
          const original = current.messages[0];
          assert.ok(original.type === "assistant");
          const otherPart = original.parts[1];
          assert.ok(otherPart.type === "reasoning");
          vm.timelineState = {
            ...current,
            messages: [
              { ...original, parts: original.parts.slice(0, 1) },
              { ...original, id: "message-b", createdAt: 2, parts: [{ ...otherPart, id: "part-b", messageId: "message-b", position: 0, type: "text" }] },
            ],
          };
          await nextTick();
        }

        const source = fixture.wrapper.findAllComponents(AssistantMarkdownMessage).find((component) => component.find("a[data-agent-file-link='old.ts']").exists())!;
        click(source.get("a").element);
        await turns();
        assert.deepEqual(fixture.requests, [{ workspaceId: "ws-a", path: "old.ts" }]);
        const invalidLink = fixture.wrapper.findAll("a[data-agent-file-link]").find((link) => link.attributes("data-agent-file-link") === invalidHref)!;
        assert.equal(click(invalidLink.element).defaultPrevented, true);
        const expectedWarning = invalid === "path" ? zhCN.agent.client.fileLinkInvalidPath : zhCN.agent.client.fileLinkInvalidPosition;
        assert.deepEqual(warnings, [expectedWarning]);
        // A click in another instance cannot invalidate the source's own sequence.
        const isSourceCurrent = source.emitted("open-file")![0][1] as () => boolean;
        assert.equal(isSourceCurrent(), true);
        resolve(lateResult === "file" ? file("old.ts") : { path: "old.ts", ok: false, reason: "permission_denied" });
        await turns();
        assert.deepEqual(fixture.calls, []);
        assert.deepEqual(warnings, [expectedWarning]);
        assert.equal(fixture.requests.length, 1);
      });
    }
  }
}
