import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage, AgentMessageSessionRunState, AgentTimelineToolExecution, AgentToolCallPart } from "@agent-workbench/shared";
import { computed, nextTick } from "vue";
import { createI18n } from "vue-i18n";
import { mount } from "@vue/test-utils";
import { message } from "ant-design-vue";
import zhCN from "@/shared/i18n/locales/zh-CN";
import { apiClient } from "@/shared/api/api";
import { workspaceContextKey } from "../../context";
import { workspaceHostKey } from "../../host";
import { agentSessionStatusStoreKey } from "./useAgentSessionStatusStore";
import AgentConversationToolCall from "./AgentConversationToolCall.vue";
import AgentToolCallRow from "./AgentToolCallRow.vue";
import paneComponent from "./AgentClientPane.vue";

const i18n = () => createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } });
const execution: AgentTimelineToolExecution = {
  id: "execution-a", callPartId: "call-a", status: "completed", resultPreview: null,
  resultTruncated: false, error: null, updatedRevision: 1, startedAt: 1_000, completedAt: 2_000,
};
function part(path: unknown): AgentToolCallPart {
  return {
    id: "call-a", messageId: "message-a", position: 0, updatedRevision: 1, createdAt: 1, updatedAt: 1,
    type: "tool_call", toolName: "view_image", input: { path }, providerToolCallId: null,
  };
}
function mountTool(path: unknown, currentExecution: AgentTimelineToolExecution | null = execution) {
  return mount(AgentConversationToolCall, {
    props: {
      workspaceId: "ws-a", toolId: "agent-tool", sessionId: "session-a",
      part: part(path), execution: currentExecution, loading: false, now: 2_000,
    },
    global: { plugins: [i18n()] },
  });
}

test("成功 view_image 沿用通用按钮，原样发送 Workspace 路径，不请求历史详情或显示 tooltip", async () => {
  for (const path of ["shot.png", "repo-b/截图 1.JPG", "images/a.jpeg", "images/a.webp", "images/%20.png"]) {
    const wrapper = mountTool(path);
    try {
      assert.equal(wrapper.emitted("open-image"), undefined);
      assert.equal(wrapper.emitted("request-detail"), undefined);
      assert.equal(wrapper.get("button").attributes("title"), undefined);
      await wrapper.get("button").trigger("click");
      assert.deepEqual(wrapper.emitted("open-image"), [[path]]);
    } finally {
      wrapper.unmount();
    }
  }
});

test("未成功执行及无效路径不启用交互，即使手动触发 activate 也不打开图片", async () => {
  const invalidExecutions = [null, ...["queued", "running", "failed", "cancelled"].map((status) => ({
    ...execution, status: status as AgentTimelineToolExecution["status"],
  }))];
  const invalidPaths = [
    undefined, null, 42, "", " shot.png", "shot.png ", "/shot.png", "../shot.png", "repo/../shot.png",
    "./shot.png", "repo//shot.png", "repo/shot.png/", "C:/shot.png", "repo\\shot.png", "https://host/shot.png",
    "shot\u0000.png", "shot\n.png", "shot\u202e.png", "shot.png?x=1", "shot#1.png", "shot.svg", "shot.txt",
  ];
  for (const [path, currentExecution] of [
    ...invalidExecutions.map((item) => ["shot.png", item] as const),
    ...invalidPaths.map((path) => [path, execution] as const),
  ]) {
    const wrapper = mountTool(path, currentExecution);
    try {
      assert.equal(wrapper.find("button").exists(), false, String(path));
      assert.equal(wrapper.getComponent(AgentToolCallRow).attributes("title"), undefined);
      wrapper.getComponent(AgentToolCallRow).vm.$emit("activate");
      await nextTick();
      assert.equal(wrapper.emitted("open-image"), undefined);
    } finally {
      wrapper.unmount();
    }
  }
});

test("复用工具行时重新读取输入和状态，其他工具保留既有 title", async () => {
  const wrapper = mountTool("old.png");
  try {
    await wrapper.setProps({ workspaceId: "ws-b", sessionId: "session-b", part: part("new.webp") });
    await wrapper.get("button").trigger("click");
    assert.deepEqual(wrapper.emitted("open-image"), [["new.webp"]]);
    await wrapper.setProps({ execution: { ...execution, status: "failed" } });
    assert.equal(wrapper.find("button").exists(), false);
    await wrapper.setProps({ part: { ...part("new.webp"), toolName: "read" }, execution });
    assert.equal(wrapper.find("button").exists(), false);
    assert.match(wrapper.getComponent(AgentToolCallRow).attributes("title")!, /^read/);
  } finally {
    wrapper.unmount();
  }
});

test("真实 Pane：历史 view_image 复用 write 的 hover 样式，仅点击时直接委托 editor.openFile", async (t) => {
  const calls: unknown[][] = [];
  const requests: unknown[] = [];
  const notices: unknown[] = [];
  for (const method of ["success", "warning", "error"] as const) {
    t.mock.method(message, method, (text: unknown) => { notices.push(text); });
  }
  const originalAdapter = apiClient.defaults.adapter;
  apiClient.defaults.adapter = async (config) => {
    requests.push(config.url);
    throw new Error("view_image should not probe or request tool details");
  };
  const wrapper = mount(paneComponent.__vccOpts ?? paneComponent, {
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
        "a-button": true, "a-tooltip": true, "a-input": true, "a-textarea": true, "a-select": true, "a-modal": true,
        "a-tag": true, "a-alert": true, "a-checkbox": true, "a-checkbox-group": true, "a-cascader": true,
        EditOutlined: true, CopyOutlined: true, FileImageOutlined: true, RobotOutlined: true,
        AppstoreOutlined: true, DownOutlined: true, LoadingOutlined: true,
        AgentAttachmentPreviewModal: true, AgentMessageActions: true, AgentUserMessage: true,
      },
    },
  });
  const setTimeline = async (parts: AgentToolCallPart[], executions: AgentTimelineToolExecution[]) => {
    const vm = wrapper.vm as unknown as { timelineState: unknown };
    vm.timelineState = {
      revision: 1,
      messages: [{ id: "message-a", workspaceId: "ws-a", type: "assistant", status: "completed", createdAt: 1, parts } as AgentMessage],
      toolExecutions: executions,
    };
    await nextTick();
  };
  try {
    const writePart = { ...part("unused"), id: "call-write", position: 1, toolName: "write", input: { filePath: "file.ts" } };
    const writeExecution = { ...execution, id: "execution-write", callPartId: "call-write" };
    await setTimeline([part("repo-b/shot.png"), writePart], [execution, writeExecution]);
    const rows = wrapper.findAll("article");
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0].classes(), rows[1].classes());
    assert.ok(rows[0].classes().includes("hover:bg-[var(--hover-bg)]"));
    assert.deepEqual(calls, []);
    await rows[0].get("button").trigger("click");
    await rows[0].get("button").trigger("click");
    assert.deepEqual(calls, Array.from({ length: 2 }, () => ["agent-tool", "editor", {
      type: "editor.openFile", payload: { path: "repo-b/shot.png", mode: "preview" },
    }]));
    assert.deepEqual(requests, []);
    assert.deepEqual(notices, []);
    await setTimeline([part("repo/../shot.png")], [execution]);
    assert.equal(wrapper.get("article").classes().includes("hover:bg-[var(--hover-bg)]"), false);
    assert.equal(wrapper.get("article").find("button").exists(), false);
    await setTimeline([part("shot.png")], [{ ...execution, status: "failed" }]);
    assert.equal(wrapper.get("article").classes().includes("hover:bg-[var(--hover-bg)]"), false);
    await wrapper.setProps({ workspaceId: "ws-b", sessionId: "session-b" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(wrapper.findComponent(AgentConversationToolCall).exists(), false);
    assert.equal(calls.length, 2);
  } finally {
    wrapper.unmount();
    apiClient.defaults.adapter = originalAdapter;
  }
});
