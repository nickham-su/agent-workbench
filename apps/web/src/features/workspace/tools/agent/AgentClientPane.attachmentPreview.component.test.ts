import assert from "node:assert/strict";
import test from "node:test";
import type { AxiosResponse, InternalAxiosRequestConfig } from "axios";
import type { AgentImagePart, AgentMessage } from "@agent-workbench/shared";
import { computed, nextTick } from "vue";
import { mount, flushPromises } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import AgentClientPane from "./AgentClientPane.vue";
import { replaceAgentTimelineSnapshot } from "./agentMessageTimeline";
import { agentSessionStatusStoreKey } from "./useAgentSessionStatusStore";
import { apiClient } from "@/shared/api/api";
import zhCN from "@/shared/i18n/locales/zh-CN";

async function settle() {
  await flushPromises();
  await nextTick();
}
async function mountPane(realPreview = false) {
  const wrapper = mount(AgentClientPane, {
    attachTo: document.body,
    props: {
      workspaceId: "ws-a", toolId: "agent-tool", sessionId: "session-a", sessionKind: "primary", sessionTitle: "Session A",
      sessionReady: false, active: false, modelValue: "agent-a", agentOptions: [],
      sessionModelStates: {}, sessionModelStateLoading: false, sessionModelMutationPending: false, modelOpenIntent: null,
    },
    global: {
      plugins: [createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } })],
      provide: { [agentSessionStatusStoreKey as symbol]: { getRunState: () => computed(() => ({ status: "idle", activeRunId: null })), bumpPollHint: () => undefined } },
      stubs: {
        "a-select": true, "a-modal": true, "a-tag": true, "a-alert": true, "a-checkbox": true, "a-checkbox-group": true, "a-cascader": true,
        "a-button": true, "a-tooltip": true, "a-textarea": true,
        AgentAttachmentPreviewModal: !realPreview, AgentConversationToolCall: true, AgentMessageActions: true, AgentUserMessage: true, AssistantMarkdownMessage: true,
      },
    },
  });
  const parts = ["a", "b"].map((id, index) => ({
    id: `image-${id}`, messageId: "user-images", position: index, type: "image", attachmentId: `attachment-${id}`,
    mediaType: "image/png", filename: `${id}.png`, updatedRevision: 1, createdAt: 1, updatedAt: 1,
  } as AgentImagePart));
  const message = {
    id: "user-images", workspaceId: "ws-a", previousMessageId: null, replacesMessageId: null, depth: 0, type: "user", status: "completed",
    originSessionId: null, originRunId: null, updatedRevision: 1, createdAt: 1, updatedAt: 1, parts,
  } as AgentMessage;
  const vm = wrapper.vm as unknown as { timelineState: ReturnType<typeof replaceAgentTimelineSnapshot> };
  vm.timelineState = replaceAgentTimelineSnapshot(vm.timelineState, {
    session: { id: "session-a", workspaceId: "ws-a", title: "Session A", kind: "primary", headMessageId: message.id, contextRootMessageId: null, revision: 1, forkedFromSessionId: null, forkedFromMessageId: null, createdAt: 1, updatedAt: 1 },
    timelineReset: false, messages: [message], toolExecutions: [],
  });
  await settle();
  return {
    wrapper,
    preview: () => wrapper.getComponent({ name: "AgentAttachmentPreviewModal" }),
    open: async () => {
      const button = wrapper.findAll('article[data-message-id="user-images"] button').find((button) => button.text() === "2 张图片");
      assert.ok(button);
      await button.trigger("click");
      await settle();
    },
  };
}
function mockAttachments() {
  const adapter = apiClient.defaults.adapter;
  const create = URL.createObjectURL;
  const revoke = URL.revokeObjectURL;
  const requests: Array<{ config: InternalAxiosRequestConfig; resolve: (response: AxiosResponse) => void; reject: (error: Error) => void }> = [];
  const revoked: string[] = [];
  let urls = 0;
  URL.createObjectURL = () => `blob:preview-${++urls}`;
  URL.revokeObjectURL = (url) => revoked.push(url);
  apiClient.defaults.adapter = (config) => new Promise((resolve, reject) => { requests.push({ config, resolve, reject }); });
  return {
    requests, revoked,
    async respond(index: number) {
      const request = requests[index]!;
      request.resolve({ config: request.config, data: new Blob(["image"]), status: 200, statusText: "OK", headers: {} });
      await settle();
    },
    restore() { apiClient.defaults.adapter = adapter; URL.createObjectURL = create; URL.revokeObjectURL = revoke; },
  };
}

test("附件数据流：只加载选中的图片，失败后可切回缓存图片，关闭回收 URL", async () => {
  const mock = mockAttachments();
  const pane = await mountPane();
  try {
    await pane.open();
    assert.equal(mock.requests.length, 1);
    assert.match(mock.requests[0]!.config.url!, /attachment-a/);
    assert.equal(pane.preview().props("loading"), true);
    await mock.respond(0);
    assert.equal(pane.preview().props("url"), "blob:preview-1");
    pane.preview().vm.$emit("select", 1);
    await settle();
    assert.equal(pane.preview().props("index"), 1);
    assert.equal(pane.preview().props("url"), "");
    assert.equal(mock.requests.length, 2);
    assert.match(mock.requests[1]!.config.url!, /attachment-b/);
    mock.requests[1]!.reject(new Error("load failed"));
    await settle();
    assert.match(pane.preview().props("error"), /图片加载失败/);
    assert.equal(pane.preview().props("count"), 2);
    pane.preview().vm.$emit("select", 0);
    await settle();
    assert.equal(pane.preview().props("url"), "blob:preview-1");
    assert.equal(pane.preview().props("error"), "");
    assert.equal(mock.requests.length, 2);
    pane.preview().vm.$emit("close");
    await settle();
    assert.equal(pane.preview().props("open"), false);
    assert.equal(pane.preview().props("loading"), false);
    assert.deepEqual(mock.revoked, ["blob:preview-1"]);
  } finally {
    pane.wrapper.unmount();
    mock.restore();
  }
});

test("真实父子集成：Ant 单层预览中按需切图、失败回退缓存和内置关闭可用", async () => {
  const mock = mockAttachments();
  const pane = await mountPane(true);
  try {
    await pane.open();
    assert.equal(document.querySelectorAll(".ant-image-preview-wrap").length, 1);
    assert.ok(document.querySelector('[role="status"]'));
    assert.equal(mock.requests.length, 1);
    await mock.respond(0);
    const previewImage = () => document.querySelector<HTMLImageElement>(".ant-image-preview-img")!;
    assert.equal(previewImage().getAttribute("src"), "blob:preview-1");
    document.querySelector<HTMLButtonElement>('button[aria-label="下一张图片"]')!.click();
    await settle();
    assert.equal(mock.requests.length, 2);
    assert.match(previewImage().getAttribute("src")!, /^data:image\/gif/);
    mock.requests[1]!.reject(new Error("load failed"));
    await settle();
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /图片加载失败/);
    document.querySelector<HTMLButtonElement>('button[aria-label="上一张图片"]')!.click();
    await settle();
    assert.equal(mock.requests.length, 2);
    assert.equal(previewImage().getAttribute("src"), "blob:preview-1");
    assert.equal(document.querySelectorAll(".ant-image-preview-wrap").length, 1);
    document.querySelector(".ant-image-preview-operations .anticon-close")!.closest("li")!.click();
    await settle();
    assert.equal(pane.preview().props("open"), false);
    assert.equal(document.querySelector(".attachment-preview-feedback"), null);
    assert.deepEqual(mock.revoked, ["blob:preview-1"]);
  } finally {
    pane.wrapper.unmount();
    await settle();
    mock.restore();
  }
});

test("附件数据流：快速切图与关闭期间的迟到响应不覆盖当前图片，URL 被回收", async () => {
  const mock = mockAttachments();
  const pane = await mountPane();
  try {
    await pane.open();
    pane.preview().vm.$emit("select", 1);
    await settle();
    await mock.respond(1);
    assert.equal(pane.preview().props("url"), "blob:preview-1");
    await mock.respond(0);
    assert.equal(pane.preview().props("index"), 1);
    assert.equal(pane.preview().props("url"), "blob:preview-1");
    assert.deepEqual(mock.revoked, ["blob:preview-2"]);
    pane.preview().vm.$emit("select", 0);
    await settle();
    assert.equal(mock.requests.length, 3);
    pane.preview().vm.$emit("close");
    await settle();
    await mock.respond(2);
    assert.equal(pane.preview().props("open"), false);
    assert.equal(pane.preview().props("url"), "");
    assert.equal(pane.preview().props("loading"), false);
    assert.deepEqual(mock.revoked, ["blob:preview-2", "blob:preview-1", "blob:preview-3"]);
    pane.preview().vm.$emit("select", 0);
    await settle();
    assert.equal(mock.requests.length, 3);
  } finally {
    pane.wrapper.unmount();
    mock.restore();
  }
});

test("附件数据流：会话切换与卸载都使在途请求过期，迟到 URL 不会泄漏", async () => {
  for (const end of ["session", "unmount"] as const) {
    const mock = mockAttachments();
    const pane = await mountPane();
    try {
      await pane.open();
      if (end === "session") {
        await pane.wrapper.setProps({ sessionId: "session-b" });
        assert.equal(pane.preview().props("open"), false);
      } else {
        pane.wrapper.unmount();
      }
      await mock.respond(0);
      assert.deepEqual(mock.revoked, ["blob:preview-1"]);
    } finally {
      if (end !== "unmount") pane.wrapper.unmount();
      mock.restore();
    }
  }
});

test("附件数据流：关闭重开后旧成功响应被丢弃，切回后旧失败响应不污染反馈", async () => {
  const mock = mockAttachments();
  const pane = await mountPane();
  try {
    await pane.open();
    pane.preview().vm.$emit("close");
    await settle();
    await pane.open();
    await mock.respond(0);
    assert.equal(pane.preview().props("loading"), true);
    assert.equal(pane.preview().props("url"), "");
    await mock.respond(1);
    assert.equal(pane.preview().props("url"), "blob:preview-2");
    pane.preview().vm.$emit("select", 1);
    await settle();
    pane.preview().vm.$emit("select", 0);
    await settle();
    assert.equal(mock.requests.length, 3);
    mock.requests[2]!.reject(new Error("stale failure"));
    await settle();
    assert.equal(pane.preview().props("index"), 0);
    assert.equal(pane.preview().props("url"), "blob:preview-2");
    assert.equal(pane.preview().props("loading"), false);
    assert.equal(pane.preview().props("error"), "");
    assert.deepEqual(mock.revoked, ["blob:preview-1"]);
  } finally {
    pane.wrapper.unmount();
    mock.restore();
  }
});
