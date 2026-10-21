import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { readFileSync } from "node:fs";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { defineComponent, nextTick } from "vue";
import { Modal } from "ant-design-vue";
import { apiClient } from "@/shared/api";
import zhCN from "@/shared/i18n/locales/zh-CN";
import TerminalConfigPanel from "./TerminalConfigPanel.vue";

const source = readFileSync(new URL("TerminalConfigPanel.vue", import.meta.url), "utf8");
const style = document.createElement("style"); style.textContent = source.match(/<style scoped>([\s\S]*?)<\/style>/)?.[1] ?? ""; document.head.append(style);
const stubs = {
  "a-button": { props: ["loading", "disabled"], emits: ["click"], template: '<button :disabled="loading || disabled" @click="$emit(\'click\')"><slot /></button>' },
  "a-tooltip": { template: "<span><slot /></span>" },
  "a-dropdown": { template: '<div><slot /><slot name="overlay" /></div>' },
  "a-menu": { name: "TestMenu", emits: ["click"], template: "<div><slot /></div>" },
  "a-menu-item": { template: "<span><slot /></span>" },
  "a-drawer": { props: ["open", "title"], template: '<section v-if="open" data-editor><h2>{{title}}</h2><slot /><slot name="footer" /></section>' },
  "a-form": defineComponent({ setup(_props, { expose }) { expose({ validate: () => Promise.resolve() }); }, template: "<form><slot /></form>" }),
  "a-form-item": { props: ["label"], template: "<label>{{label}}<slot /></label>" },
  "a-input": { props: ["value"], emits: ["update:value"], template: '<input :value="value" @input="$emit(\'update:value\', $event.target.value)" />' },
  "a-textarea": { props: ["value"], emits: ["update:value"], template: '<textarea :value="value" @input="$emit(\'update:value\', $event.target.value)" />' },
  "a-auto-complete": { name: "TestDirectory", props: ["value", "options"], emits: ["update:value"], template: '<div data-directory><input :value="value" @input="$emit(\'update:value\', $event.target.value)" /></div>' },
  "a-spin": { template: "<span />" }, "a-alert": { props: ["message"], template: "<p>{{message}}</p>" }
};
const adapter = apiClient.defaults.adapter;
const wrappers: VueWrapper[] = [];
afterEach(() => { wrappers.splice(0).forEach((wrapper) => wrapper.unmount()); apiClient.defaults.adapter = adapter; });
async function settle() { await nextTick(); await flushPromises(); await nextTick(); }
function setup() {
  let runs = 0, creates = 0, updates = 0, deletes = 0;
  const config = { id: "config", workspaceId: "ws", name: "前端开发", cwd: "repo/apps/web", command: "npm run dev", createdAt: 1, updatedAt: 1 };
  apiClient.defaults.adapter = async (request) => {
    const url = String(request.url), method = request.method;
    let data: unknown;
    if (url === "/workspaces/ws") data = { repos: [{ dirName: "repo", repo: { id: "r", url: "fixture" } }] };
    else if (url.endsWith("/run")) { runs++; data = { id: `terminal-${runs}`, workspaceId: "ws", sessionName: `session-${runs}`, status: "active", createdAt: 1, updatedAt: 1 }; }
    else if (method === "post") { creates++; data = { ...config, ...JSON.parse(request.data), id: "new-config", createdAt: 2 }; }
    else if (method === "patch") { updates++; data = { ...config, ...JSON.parse(request.data) }; }
    else if (method === "delete") { deletes++; data = null; }
    else data = [config];
    return { data, status: 200, statusText: "OK", headers: {}, config: request };
  };
  const wrapper = mount(TerminalConfigPanel, { attachTo: document.body, props: { workspaceId: "ws" }, global: { plugins: [createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } })], stubs } });
  wrappers.push(wrapper);
  return { wrapper, counts: () => ({ runs, creates, updates, deletes }) };
}

test("compact configuration pane aligns headings and actions without extra row content", async () => {
  const { wrapper } = setup(); await settle();
  const row = wrapper.get(".config-row");
  assert.equal(row.element.children.length, 3); assert.equal(row.get(".config-name").text(), "前端开发");
  assert.equal(wrapper.get(".config-heading-title").text(), "运行");
  assert.match(getComputedStyle(row.get(".config-run").element).color, /^(?:#fff(?:fff)?|rgb\(255,\s*255,\s*255\))$/i);
  assert.equal(row.get(".config-run").element.parentElement, row.element);
  assert.equal(wrapper.findAll('.config-heading button').length, 2);
  const headingStyle = getComputedStyle(wrapper.get(".config-heading").element), rowStyle = getComputedStyle(row.element);
  for (const key of ["paddingLeft", "paddingRight", "gap", "height"] as const) assert.equal(rowStyle[key], headingStyle[key]);
  assert.equal(rowStyle.borderRadius, "0px");
  assert.equal(getComputedStyle(wrapper.get(".config-list").element).paddingLeft, "0px");
  await wrapper.get('[aria-label="收起配置"]').trigger("click"); assert.equal(wrapper.emitted("close")?.length, 1);
});

test("each completed run request creates and emits a new terminal without session reuse", async () => {
  const { wrapper, counts } = setup(); await settle();
  await wrapper.get('button[aria-label="运行"]').trigger("click"); await settle();
  await wrapper.get('button[aria-label="运行"]').trigger("click"); await settle();
  assert.equal(counts().runs, 2);
  const events = wrapper.emitted("created")!;
  assert.equal(events.length, 2); assert.notDeepEqual(events[0], events[1]);
});

test("new configuration supports repository choices and free relative cwd; saving never runs", async () => {
  const { wrapper, counts } = setup(); await settle();
  await wrapper.get('[aria-label="新建配置"]').trigger("click");
  const directory = wrapper.findComponent({ name: "TestDirectory" });
  assert.deepEqual(directory.props("options").map((option: { value: string }) => option.value), [".", "repo"]);
  await wrapper.get('input[aria-label="名称"]').setValue("API 服务");
  await wrapper.get("[data-directory] input").setValue("repo/custom/subdir");
  await wrapper.get('textarea[aria-label="启动命令"]').setValue("npm run dev\nprintf done");
  await wrapper.findAll("button").find((button) => button.text() === "保存配置")!.trigger("click"); await settle();
  assert.equal(counts().creates, 1); assert.equal(counts().runs, 0);
  assert.equal(wrapper.findAll(".config-row").length, 2); assert.equal(wrapper.find("[data-editor]").exists(), false);
});

test("editing and confirmed deletion only update configuration APIs, not terminals", async (t) => {
  const { wrapper, counts } = setup(); await settle();
  wrapper.findComponent({ name: "TestMenu" }).vm.$emit("click", { key: "edit" }); await settle();
  await wrapper.get('input[aria-label="名称"]').setValue("修改名称");
  await wrapper.findAll("button").find((button) => button.text() === "保存配置")!.trigger("click"); await settle();
  assert.equal(counts().updates, 1); assert.equal(counts().runs, 0);
  let confirmation: Parameters<typeof Modal.confirm>[0] | undefined;
  t.mock.method(Modal, "confirm", (options: Parameters<typeof Modal.confirm>[0]) => { confirmation = options; return { destroy() {}, update() {} }; });
  wrapper.findComponent({ name: "TestMenu" }).vm.$emit("click", { key: "delete" }); await settle();
  assert.equal(counts().deletes, 0); assert.ok(confirmation);
  await confirmation.onOk?.(); await settle();
  assert.equal(counts().deletes, 1); assert.equal(counts().runs, 0); assert.equal(wrapper.findAll(".config-row").length, 0);
});
