import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { defineComponent, h, KeepAlive, nextTick, ref } from "vue";
import { mount, shallowMount, type VueWrapper } from "@vue/test-utils";
import { AxiosError, type InternalAxiosRequestConfig } from "axios";
import { createI18n } from "vue-i18n";
import type { WorkspaceEnvironmentVariable } from "@agent-workbench/shared";
import zhCN from "@/shared/i18n/locales/zh-CN";
import enUS from "@/shared/i18n/locales/en-US";
import {
  apiClient, ApiError, listWorkspaceEnvironmentVariables, createWorkspaceEnvironmentVariable,
  updateWorkspaceEnvironmentVariable, setWorkspaceEnvironmentVariableEnabled, deleteWorkspaceEnvironmentVariable
} from "@/shared/api";
import EnvironmentVariablesToolView from "./EnvironmentVariablesToolView.vue";
import EnvironmentVariablesIcon from "../../icons/EnvironmentVariablesIcon.vue";

// vite-node closes its transformer after entry evaluation, so load the Layout before tests run.
Object.defineProperties(globalThis, {
  self: { value: window, configurable: true },
  UIEvent: { value: window.UIEvent, configurable: true },
  CSS: { value: window.CSS, configurable: true }
});
const { default: WorkspaceLayout } = await import("../../views/WorkspaceLayout.vue");

// Native controls keep real form/input semantics; only Ant overlay/visual plumbing is stubbed.
const Button = {
  props: ["disabled", "loading", "htmlType"], emits: ["click"],
  template: `<button :type="htmlType || 'button'" :disabled="disabled" @click="!disabled && $emit('click', $event)"><slot name="icon" /><slot /></button>`
};
const stubs = {
  "a-button": Button,
  "a-input": { props: ["value"], emits: ["update:value"], template: `<input :value="value" @input="$emit('update:value', $event.target.value)" />` },
  "a-select": { props: ["value", "options"], emits: ["update:value"], template: `<select :value="value" @change="$emit('update:value', $event.target.value)"><option v-for="item in options" :key="item.value" :value="item.value">{{item.label}}</option></select>` },
  "a-switch": { props: ["checked", "disabled"], emits: ["update:checked", "change"], template: `<button type="button" role="switch" :disabled="disabled" :aria-checked="String(checked)" @click="!disabled && ($emit('update:checked', !checked), $emit('change', !checked))" />` },
  "a-drawer": { props: ["open", "title", "closable", "maskClosable", "keyboard"], emits: ["close"], template: `<section v-if="open" role="dialog" data-testid="drawer" tabindex="-1" @keydown.esc="keyboard && $emit('close')"><h2>{{title}}</h2><button v-if="closable" type="button" data-testid="drawer-close" @click="$emit('close')">close</button><button v-if="maskClosable" type="button" data-testid="drawer-mask" @click="$emit('close')">mask</button><slot /><slot name="footer" /></section>` },
  "a-modal": { props: ["open", "title", "okText", "cancelText", "okButtonProps", "cancelButtonProps"], emits: ["ok", "cancel"], template: `<section v-if="open" role="dialog" data-testid="delete-confirm"><h2>{{title}}</h2><slot /><button type="button" data-testid="delete-cancel" :disabled="cancelButtonProps?.disabled" @click="$emit('cancel')">{{cancelText}}</button><button type="button" data-testid="delete-ok" :disabled="okButtonProps?.disabled" @click="$emit('ok')">{{okText}}</button></section>` }
};
const originalAdapter = apiClient.defaults.adapter;
const wrappers: VueWrapper[] = [];
const tick = async () => { await nextTick(); await new Promise<void>((resolve) => setImmediate(resolve)); await nextTick(); };
const settle = async () => { for (let i = 0; i < 4; i++) await tick(); };
const base = "/workspaces/workspace-a/environment-variables";
const body = (config: InternalAxiosRequestConfig) => typeof config.data === "string" ? JSON.parse(config.data) : config.data;
const ok = (config: InternalAxiosRequestConfig, data: unknown, status = 200) => ({ data, status, statusText: "OK", headers: {}, config });
function row(overrides: Partial<WorkspaceEnvironmentVariable> = {}): WorkspaceEnvironmentVariable {
  return { id: "variable-a", workspaceId: "workspace-a", name: "NODE_ENV", value: "fixture-value", remark: "dev mode", enabled: true, createdAt: 1, updatedAt: 1, ...overrides };
}
function rejected(config: InternalAxiosRequestConfig, status: number, code: string) {
  return new AxiosError("private-error-marker", "ERR_BAD_RESPONSE", config, undefined, ok(config, { code, message: "private-response-marker" }, status));
}
function setup(handler: (config: InternalAxiosRequestConfig) => unknown | Promise<unknown>, workspaceId = "workspace-a", locale = "zh-CN") {
  apiClient.defaults.adapter = async (config) => {
    const data = await handler(config);
    return ok(config, data, config.method === "delete" ? 204 : config.method === "post" ? 201 : 200);
  };
  const i18n = createI18n({ legacy: false, locale, messages: { "zh-CN": zhCN, "en-US": enUS } });
  const wrapper = mount(EnvironmentVariablesToolView, { attachTo: document.body, props: { workspaceId }, global: { plugins: [i18n], stubs } });
  wrappers.push(wrapper);
  return wrapper;
}
async function edit(wrapper: VueWrapper, id = "variable-a") {
  await wrapper.get(`[data-variable-id="${id}"] [data-action="edit"]`).trigger("click");
  await tick();
}
async function create(wrapper: VueWrapper) { await wrapper.get('[data-testid="add-variable"]').trigger("click"); await tick(); }
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  apiClient.defaults.adapter = originalAdapter;
});

test("real list rendering is plaintext, preserves empty/multiline values and supports search/status/counts", async () => {
  const items = [row({ value: "<img src=x onerror=bad()>\n $PATH $(never) " }), row({ id: "empty", name: "EMPTY", value: "", remark: "another", enabled: false, createdAt: 2 })];
  const wrapper = setup((config) => { assert.equal(config.method, "get"); assert.equal(config.url, base); return items; });
  await settle();
  assert.equal(wrapper.findAll("tbody tr").length, 2);
  assert.equal(wrapper.find("tbody img").exists(), false);
  assert.equal(wrapper.get("pre").element.textContent, items[0]!.value);
  assert.match(wrapper.text(), /空字符串|显示 2\/2 条 · 1 条已启用/);
  assert.doesNotMatch(wrapper.text(), /虚构示例|仅在内存|草稿|隐藏值|显示值/);
  assert.ok(wrapper.get(".environment-heading").find('[data-testid="add-variable"]').exists());
  await wrapper.get('[data-testid="search"]').setValue("another");
  assert.equal(wrapper.findAll("tbody tr").length, 1);
  await wrapper.get('[data-testid="status-filter"]').setValue("enabled");
  assert.equal(wrapper.findAll("tbody tr").length, 0);
  assert.match(wrapper.get('[data-testid="empty"]').text(), /没有匹配/);
  await wrapper.get('[data-testid="search"]').setValue("");
  assert.equal(wrapper.findAll("tbody tr").length, 1);
});

test("empty server list has no demo rows and English translations cover the formal UI", async () => {
  const wrapper = setup(() => [], "workspace-a", "en-US");
  await settle();
  assert.equal(wrapper.findAll("tbody tr").length, 0);
  assert.match(wrapper.text(), /No environment variables yet/);
  assert.doesNotMatch(wrapper.text(), /workspace\.environmentVariables\./);
  await create(wrapper);
  assert.match(wrapper.get('[data-testid="drawer"]').text(), /Save writes directly/);
  assert.deepEqual(Object.keys(zhCN.workspace.environmentVariables).sort(), Object.keys(enUS.workspace.environmentVariables).sort());
  assert.deepEqual(Object.keys(zhCN.workspace.environmentVariables.errors).sort(), Object.keys(enUS.workspace.environmentVariables.errors).sort());
});

for (const close of ["cancel", "close", "mask", "escape"] as const) {
  test(`unsubmitted ${close} discards the editor without requests or list changes`, async () => {
    let calls = 0;
    const wrapper = setup(() => { calls++; return [row()]; });
    await settle();
    await edit(wrapper);
    await wrapper.get('input[name="name"]').setValue("UNSAVED");
    await wrapper.get('textarea[name="value"]').setValue("unsaved-fixture");
    if (close === "escape") await wrapper.get('[data-testid="drawer"]').trigger("keydown", { key: "Escape" });
    else await wrapper.get(`[data-testid="${close === 'cancel' ? 'cancel-editor' : `drawer-${close}`}" ]`).trigger("click");
    await tick();
    assert.equal(wrapper.find('[data-testid="drawer"]').exists(), false);
    assert.equal(calls, 1);
    assert.match(wrapper.get("tbody").text(), /NODE_ENV/);
    assert.doesNotMatch(wrapper.get("tbody").text(), /UNSAVED|unsaved-fixture/);
    await create(wrapper);
    assert.equal((wrapper.get('input[name="name"]').element as HTMLInputElement).value, "");
    assert.equal((wrapper.get('textarea[name="value"]').element as HTMLTextAreaElement).value, "");
  });
}

test("create saves directly once, uses authoritative row, blocks reentry/close while pending and restores focus", async () => {
  let finish!: (value: unknown) => void;
  const calls: InternalAxiosRequestConfig[] = [];
  const wrapper = setup((config) => {
    calls.push(config);
    return config.method === "get" ? [] : new Promise((resolve) => { finish = resolve; });
  });
  await settle();
  const opener = wrapper.get('[data-testid="add-variable"]');
  (opener.element as HTMLElement).focus();
  await create(wrapper);
  await wrapper.get('input[name="name"]').setValue("EMPTY");
  await wrapper.get('input[name="remark"]').setValue("  remark  ");
  await wrapper.get('[data-testid="save-variable"]').trigger("click");
  await tick();
  assert.equal(calls.length, 2);
  assert.deepEqual(body(calls[1]!), { name: "EMPTY", value: "", remark: "  remark  ", enabled: true });
  assert.equal(wrapper.get('[data-testid="save-variable"]').attributes("disabled"), "");
  assert.equal(wrapper.find('[data-testid="drawer-close"]').exists(), false);
  await wrapper.get("form").trigger("submit");
  await wrapper.get('[data-testid="cancel-editor"]').trigger("click");
  assert.equal(calls.length, 2);
  assert.ok(wrapper.find('[data-testid="drawer"]').exists());
  finish(row({ id: "server-id", name: "EMPTY", value: "server-authoritative-value", remark: "server-remark" }));
  await settle();
  assert.equal(wrapper.find('[data-testid="drawer"]').exists(), false);
  assert.match(wrapper.get("tbody").text(), /server-authoritative-value|server-remark/);
  assert.equal(document.activeElement === opener.element, true);
  assert.match(wrapper.get('[data-testid="notice"]').text(), /已保存/);
});

test("unchanged edit sends no empty PATCH and reports no changes", async () => {
  let calls = 0;
  const wrapper = setup(() => { calls++; return [row()]; });
  await settle(); await edit(wrapper);
  await wrapper.get('[data-testid="save-variable"]').trigger("click");
  await tick();
  assert.equal(calls, 1);
  assert.equal(wrapper.find('[data-testid="drawer"]').exists(), false);
  assert.match(wrapper.get('[data-testid="notice"]').text(), /没有更改/);
});

test("remark-only PATCH omits a CR/CRLF value normalized by textarea display", async () => {
  const original = row({ value: "first\r\nsecond\rthird\nlast" });
  const writes: InternalAxiosRequestConfig[] = [];
  const wrapper = setup((config) => {
    if (config.method === "get") return [original];
    writes.push(config); return { ...original, remark: "new remark", updatedAt: 2 };
  });
  await settle(); await edit(wrapper);
  const textarea = wrapper.get('textarea[name="value"]').element as HTMLTextAreaElement;
  // Explicitly simulate browsers that normalize line endings without dispatching input.
  textarea.value = original.value.replace(/\r\n?/g, "\n");
  await wrapper.get('input[name="remark"]').setValue("new remark");
  await wrapper.get('[data-testid="save-variable"]').trigger("click");
  await settle();
  assert.equal(writes.length, 1);
  assert.equal(writes[0]!.method, "patch");
  assert.deepEqual(body(writes[0]!), { remark: "new remark" });
  assert.equal(wrapper.get("pre").element.textContent, original.value);
});

test("active value editing saves literal current input including whitespace, Unicode, quotes and empty strings", async () => {
  let stored = row();
  const writes: unknown[] = [];
  const wrapper = setup((config) => {
    if (config.method === "get") return [stored];
    const patch = body(config); writes.push(patch); stored = { ...stored, ...patch }; return stored;
  });
  await settle(); await edit(wrapper);
  const literal = "  中文😀 '$PATH' $(not-run)\n next  ";
  await wrapper.get('textarea[name="value"]').setValue(literal);
  await wrapper.get('[data-testid="save-variable"]').trigger("click");
  await settle();
  assert.deepEqual(writes[0], { value: literal });
  await edit(wrapper); await wrapper.get('textarea[name="value"]').setValue("");
  await wrapper.get('[data-testid="save-variable"]').trigger("click"); await settle();
  assert.deepEqual(writes[1], { value: "" });
  assert.match(wrapper.get("tbody").text(), /空字符串/);
});

test("shared validation rejects reserved/invalid/duplicate/Unicode/byte/quota inputs without serializing them into errors", async () => {
  let writes = 0;
  const items = [row(), row({ id: "disabled", name: "DISABLED", value: "x".repeat(16384), enabled: false })];
  const wrapper = setup((config) => { if (config.method === "get") return items; writes++; return row(); });
  await settle(); await create(wrapper);
  for (const name of ["AWB_TEST", "GIT_ASKPASS", "GIT_CONFIG_KEY_0", "bad name", "1INVALID", "NODE_ENV"]) {
    await wrapper.get('input[name="name"]').setValue(name);
    await wrapper.get('[data-testid="save-variable"]').trigger("click");
    assert.ok(wrapper.find('[data-testid="form-error"]').exists());
  }
  await wrapper.get('input[name="name"]').setValue("VALID");
  for (const value of ["private-fixture\0", "\ud800", "\udfff", "中".repeat(5462)]) {
    await wrapper.get('textarea[name="value"]').setValue(value);
    await wrapper.get('[data-testid="save-variable"]').trigger("click");
    assert.ok(wrapper.find('[data-testid="form-error"]').exists());
    assert.doesNotMatch(wrapper.get('[data-testid="form-error"]').text(), /private-fixture/);
  }
  await wrapper.get('textarea[name="value"]').setValue("");
  // maxlength only constrains interactive entry; programmatic invalid values still hit shared policy.
  await wrapper.get('input[name="remark"]').setValue("😀".repeat(81));
  await wrapper.get('[data-testid="save-variable"]').trigger("click");
  assert.match(wrapper.get('[data-testid="form-error"]').text(), /限额/);
  assert.equal(writes, 0);
});

test("enabling persists independently, failure keeps original checked state and emits only safe messages", async () => {
  let fail = true;
  let writes = 0;
  const wrapper = setup((config) => {
    if (config.method === "get") return [row()];
    writes++; assert.equal(config.method, "put"); assert.equal(config.url, `${base}/variable-a/enabled`);
    assert.deepEqual(body(config), { enabled: false });
    if (fail) throw rejected(config, 409, "WORKSPACE_DELETING");
    return row({ enabled: false });
  });
  await settle();
  const toggle = () => wrapper.get('tbody [role="switch"]');
  await toggle().trigger("click"); await settle();
  assert.equal(toggle().attributes("aria-checked"), "true");
  assert.match(wrapper.get('[data-testid="notice"]').text(), /正在删除/);
  assert.doesNotMatch(wrapper.text(), /private-error-marker|private-response-marker/);
  fail = false;
  await toggle().trigger("click"); await settle();
  assert.equal(writes, 2);
  assert.equal(toggle().attributes("aria-checked"), "false");
});

test("deletion requires confirmation; known failure preserves row and confirmation, success removes only the row", async () => {
  let deletes = 0, fail = true;
  const wrapper = setup((config) => {
    if (config.method === "get") return [row()];
    deletes++; if (fail) throw rejected(config, 409, "WORKSPACE_DELETING"); return undefined;
  });
  await settle();
  await wrapper.get('[data-action="delete"]').trigger("click");
  assert.equal(deletes, 0);
  await wrapper.get('[data-testid="delete-cancel"]').trigger("click");
  assert.equal(wrapper.find('[data-testid="delete-confirm"]').exists(), false);
  await wrapper.get('[data-action="delete"]').trigger("click");
  await wrapper.get('[data-testid="delete-ok"]').trigger("click"); await settle();
  assert.equal(deletes, 1); assert.equal(wrapper.findAll("tbody tr").length, 1);
  assert.match(wrapper.get('[data-testid="delete-confirm"]').text(), /正在删除/);
  fail = false;
  await wrapper.get('[data-testid="delete-ok"]').trigger("click"); await settle();
  assert.equal(deletes, 2); assert.equal(wrapper.findAll("tbody tr").length, 0);
  assert.equal(wrapper.find('[data-testid="delete-confirm"]').exists(), false);
});

test("known save rejection retains input and uses fixed conflict text, not server messages", async () => {
  const wrapper = setup((config) => {
    if (config.method === "get") return [];
    throw rejected(config, 409, "WORKSPACE_ENV_NAME_CONFLICT");
  });
  await settle(); await create(wrapper);
  await wrapper.get('input[name="name"]').setValue("CONFLICT");
  await wrapper.get('textarea[name="value"]').setValue("private-fixture-value");
  await wrapper.get('[data-testid="save-variable"]').trigger("click"); await settle();
  assert.equal((wrapper.get('textarea[name="value"]').element as HTMLTextAreaElement).value, "private-fixture-value");
  assert.match(wrapper.get('[data-testid="form-error"]').text(), /同名/);
  assert.doesNotMatch(wrapper.get('[data-testid="form-error"]').text(), /private-/);
  assert.equal(wrapper.findAll("tbody tr").length, 0);
});

test("lost create response re-reads committed state without POST retry or claiming rollback/success", async () => {
  let stored: WorkspaceEnvironmentVariable[] = [], gets = 0, posts = 0;
  const wrapper = setup((config) => {
    if (config.method === "get") { gets++; return stored; }
    posts++; stored = [row({ name: "CREATED", value: "committed-fixture" })];
    throw new AxiosError("private-network-marker", "ERR_NETWORK", config);
  });
  await settle(); await create(wrapper);
  await wrapper.get('input[name="name"]').setValue("CREATED");
  await wrapper.get('textarea[name="value"]').setValue("committed-fixture");
  await wrapper.get('[data-testid="save-variable"]').trigger("click"); await settle();
  assert.equal(posts, 1); assert.equal(gets, 2);
  assert.match(wrapper.get("tbody").text(), /committed-fixture/);
  assert.match(wrapper.get('[data-testid="notice"]').text(), /未确认.*重新读取/);
  assert.ok(wrapper.find('[data-testid="drawer"]').exists());
  assert.equal(wrapper.get('[data-testid="save-variable"]').attributes("disabled"), "");
  await wrapper.get("form").trigger("submit"); await settle();
  assert.equal(posts, 1);
  assert.doesNotMatch(wrapper.get('[data-testid="notice"]').text(), /已保存|private-/);
});

test("unconfirmed write plus failed re-read remains explicitly unresolved with a working refresh path", async () => {
  let gets = 0, recovered = false, posts = 0;
  const wrapper = setup((config) => {
    if (config.method === "get") {
      gets++; if (gets > 1 && !recovered) throw new AxiosError("private-reread-marker", "ERR_NETWORK", config);
      return recovered ? [row({ name: "CREATED" })] : [];
    }
    posts++; throw new AxiosError("private-network-marker", "ERR_NETWORK", config);
  });
  await settle(); await create(wrapper);
  await wrapper.get('input[name="name"]').setValue("CREATED");
  await wrapper.get('[data-testid="save-variable"]').trigger("click"); await settle();
  assert.ok(wrapper.find('[data-testid="unconfirmed"]').exists());
  assert.ok(wrapper.find('[data-testid="list-error"]').exists());
  assert.equal(wrapper.get('[data-testid="add-variable"]').attributes("disabled"), "");
  await wrapper.get('[data-testid="cancel-editor"]').trigger("click");
  recovered = true;
  await wrapper.get('[data-testid="refresh"]').trigger("click"); await settle();
  assert.equal(gets, 3); assert.equal(posts, 1);
  assert.equal(wrapper.find('[data-testid="unconfirmed"]').exists(), false);
  assert.match(wrapper.get("tbody").text(), /CREATED/);
});

for (const oldOutcome of ["resolve", "reject"] as const) {
  test(`Workspace switch aborts and ignores stale list ${oldOutcome}`, async () => {
    let complete!: (value?: unknown) => void;
    let oldSignal: AbortSignal | undefined;
    const wrapper = setup((config) => {
      if (config.url === base) {
        oldSignal = config.signal as AbortSignal;
        return new Promise((resolve, reject) => { complete = oldOutcome === "resolve" ? resolve : () => reject(new AxiosError("old-private-marker", "ERR_NETWORK", config)); });
      }
      return [row({ workspaceId: "workspace-b", name: "NEW_WORKSPACE", value: "new-fixture" })];
    });
    await tick(); await wrapper.setProps({ workspaceId: "workspace-b" }); await settle();
    assert.equal(oldSignal?.aborted, true);
    complete([row({ name: "OLD_WORKSPACE", value: "old-private-marker" })]); await settle();
    assert.match(wrapper.get("tbody").text(), /NEW_WORKSPACE/);
    assert.doesNotMatch(wrapper.text(), /OLD_WORKSPACE|old-private-marker/);
  });
}

test("Workspace switch during a committed write clears form and ignores old success/error/notice", async () => {
  let complete!: (value: unknown) => void;
  let signal: AbortSignal | undefined;
  const wrapper = setup((config) => {
    if (config.method === "get") return config.url === base ? [] : [row({ workspaceId: "workspace-b", name: "SECOND", value: "second-fixture" })];
    signal = config.signal as AbortSignal; return new Promise((resolve) => { complete = resolve; });
  });
  await settle(); await create(wrapper);
  await wrapper.get('input[name="name"]').setValue("FIRST");
  await wrapper.get('textarea[name="value"]').setValue("old-write-marker");
  await wrapper.get('[data-testid="save-variable"]').trigger("click"); await tick();
  await wrapper.setProps({ workspaceId: "workspace-b" }); await settle();
  assert.equal(signal?.aborted, true);
  assert.equal(wrapper.find('[data-testid="drawer"]').exists(), false);
  complete(row({ name: "FIRST", value: "old-write-marker" })); await settle();
  assert.match(wrapper.get("tbody").text(), /SECOND/);
  assert.doesNotMatch(wrapper.text(), /old-write-marker|已保存|未确认/);
});

test("unmount cancels requests and deactivation releases plaintext/form, activation refetches", async () => {
  let pendingSignal: AbortSignal | undefined, finish!: (value: unknown) => void;
  const wrapper = setup((config) => {
    pendingSignal = config.signal as AbortSignal;
    return new Promise((resolve) => { finish = resolve; });
  });
  await tick(); wrapper.unmount(); wrappers.splice(wrappers.indexOf(wrapper), 1);
  assert.equal(pendingSignal?.aborted, true);
  finish([row()]); await settle();
  let reads = 0;
  apiClient.defaults.adapter = async (config) => { reads++; return ok(config, [row({ value: `fresh-${reads}` })]); };
  const visible = ref(true);
  const Host = defineComponent({ setup: () => () => h(KeepAlive, null, { default: () => visible.value ? h(EnvironmentVariablesToolView, { workspaceId: "workspace-a" }) : null }) });
  const host = mount(Host, { attachTo: document.body, global: { plugins: [createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } })], stubs } });
  wrappers.push(host); await settle();
  await host.get('[data-testid="add-variable"]').trigger("click"); await tick();
  await host.get('textarea[name="value"]').setValue("unsaved-private-marker");
  visible.value = false; await settle();
  assert.doesNotMatch(document.body.textContent ?? "", /unsaved-private-marker/);
  visible.value = true; await settle();
  assert.equal(reads, 2);
  assert.equal(host.find('[data-testid="drawer"]').exists(), false);
  assert.match(host.get("tbody").text(), /fresh-2/);
});

test("dedicated API encodes IDs, uses bounded requests and strips raw errors/invalid responses", async () => {
  const workspaceId = "workspace /中文", variableId = "variable /中文";
  const expected = `/workspaces/${encodeURIComponent(workspaceId)}/environment-variables`;
  const calls: InternalAxiosRequestConfig[] = [];
  const value = row({ id: variableId, workspaceId, name: "__proto__", value: "private-fixture" });
  apiClient.defaults.adapter = async (config) => { calls.push(config); return ok(config, config.method === "get" ? [value] : config.method === "delete" ? undefined : value, config.method === "delete" ? 204 : 200); };
  const controller = new AbortController();
  assert.deepEqual(await listWorkspaceEnvironmentVariables(workspaceId, { signal: controller.signal }), [value]);
  await createWorkspaceEnvironmentVariable(workspaceId, { name: "__proto__", value: "private-fixture" });
  await updateWorkspaceEnvironmentVariable(workspaceId, variableId, { remark: "" });
  await setWorkspaceEnvironmentVariableEnabled(workspaceId, variableId, false);
  await deleteWorkspaceEnvironmentVariable(workspaceId, variableId);
  assert.deepEqual(calls.map((config) => [config.method, config.url]), [
    ["get", expected], ["post", expected], ["patch", `${expected}/${encodeURIComponent(variableId)}`],
    ["put", `${expected}/${encodeURIComponent(variableId)}/enabled`], ["delete", `${expected}/${encodeURIComponent(variableId)}`]
  ]);
  assert.ok(calls.every((config) => config.timeout === 15000));
  assert.equal(calls[0]!.signal, controller.signal);
  assert.equal(calls[0]!.data, undefined);
  for (const invalid of [[{ ...value, workspaceId: "wrong" }], [value, value], [{ ...value, name: "AWB_TEST" }], [{ ...value, value: "\ud800" }], [{ ...value, unexpected: "private-marker" }]]) {
    apiClient.defaults.adapter = async (config) => ok(config, invalid);
    await assert.rejects(listWorkspaceEnvironmentVariables(workspaceId), (error: unknown) => error instanceof ApiError && error.code === "WORKSPACE_ENV_RESPONSE_INVALID" && !JSON.stringify(error).includes("private-"));
  }
  apiClient.defaults.adapter = async (config) => { throw rejected(config, 500, "private-code-marker"); };
  await assert.rejects(createWorkspaceEnvironmentVariable(workspaceId, { name: "VALID", value: "private-fixture" }), (error: unknown) => {
    assert.ok(error instanceof ApiError); assert.equal(error.status, 500); assert.equal(error.code, "WORKSPACE_ENV_REQUEST_FAILED");
    assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, /private-/);
    assert.equal("config" in error, false); assert.equal("cause" in error, false); return true;
  });
});

test("UI never writes variable values or editor text to browser storage", async () => {
  const storage = window.localStorage;
  const original = storage.setItem;
  const persisted: string[] = [];
  storage.setItem = (key, value) => { persisted.push(`${key}=${value}`); };
  try {
    const wrapper = setup((config) => config.method === "get" ? [row({ value: "private-storage-marker" })] : row({ value: "private-new-marker" }));
    await settle(); await edit(wrapper);
    await wrapper.get('textarea[name="value"]').setValue("private-new-marker");
    await wrapper.get('[data-testid="save-variable"]').trigger("click"); await settle();
    assert.deepEqual(persisted, []);
  } finally { storage.setItem = original; }
});

test("disabled entries count towards collection limits in UI validation", async () => {
  const items = Array.from({ length: 128 }, (_, i) => row({ id: `id-${i}`, name: `ITEM_${i}`, value: "", enabled: false }));
  let writes = 0;
  const wrapper = setup((config) => { if (config.method === "get") return items; writes++; return row(); });
  await settle(); await create(wrapper);
  await wrapper.get('input[name="name"]').setValue("EXTRA");
  await wrapper.get('[data-testid="save-variable"]').trigger("click");
  assert.equal(writes, 0);
  assert.match(wrapper.get('[data-testid="form-error"]').text(), /限额/);
});

test("successful-looking invalid write response is unconfirmed and triggers authoritative re-read", async () => {
  let gets = 0, posts = 0;
  const wrapper = setup((config) => {
    if (config.method === "get") { gets++; return gets === 1 ? [] : [row({ name: "CREATED" })]; }
    posts++; return { ...row({ name: "CREATED" }), workspaceId: "wrong-workspace" };
  });
  await settle(); await create(wrapper);
  await wrapper.get('input[name="name"]').setValue("CREATED");
  await wrapper.get('[data-testid="save-variable"]').trigger("click"); await settle();
  assert.equal(gets, 2); assert.equal(posts, 1);
  assert.match(wrapper.get('[data-testid="notice"]').text(), /未确认/);
  assert.ok(wrapper.find('[data-testid="drawer"]').exists());
  assert.equal(wrapper.get('[data-testid="save-variable"]').attributes("disabled"), "");
});

test("environment icon inherits the toolbar color and scales with its font size", () => {
  const wrapper = mount(EnvironmentVariablesIcon);
  try {
    const svg = wrapper.get("svg");
    assert.equal(svg.attributes("viewBox"), "0 0 1024 1024");
    assert.equal(svg.attributes("width"), "1em");
    assert.equal(svg.attributes("height"), "1em");
    assert.equal(svg.attributes("fill"), "currentColor");
    assert.equal(svg.attributes("aria-hidden"), "true");
    assert.equal(svg.attributes("focusable"), "false");
    assert.equal(svg.attributes("style"), undefined);
    const paths = wrapper.findAll("path");
    assert.equal(paths.length, 2);
    assert.ok(paths[0]!.attributes("d")?.startsWith("M158.016 125.248"));
    assert.ok(paths[1]!.attributes("d")?.startsWith("M418.048 299.328"));
    for (const path of paths) {
      assert.equal(path.attributes("fill"), undefined);
    }
  } finally {
    wrapper.unmount();
  }
});

test("old Dock layouts gain the environment entry without losing existing preferences and reset it for another Workspace", async () => {
  const globals = ["localStorage", "UIEvent", "CSS"] as const;
  const descriptors = globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.defineProperties(globalThis, {
    localStorage: { value: window.localStorage, configurable: true },
    UIEvent: { value: window.UIEvent, configurable: true },
    CSS: { value: window.CSS, configurable: true }
  });
  const key = "agent-workbench.workspace.dockLayout.v3.dock-fixture";
  const old = {
    version: 3, updatedAt: 1, ratios: { topBottom: 0.6, topLeft: 0.4 },
    toolArea: { files: "leftBottom", terminal: "leftBottom", search: "leftTop", agent: "leftTop", codeReview: "leftTop", scheduledTasks: "leftTop", editor: "rightTop" },
    toolMinimized: { files: true, terminal: false, search: true, agent: false, codeReview: false, scheduledTasks: false, editor: true },
    activeToolIdByArea: { leftTop: "agent", leftBottom: "terminal", rightTop: null },
    toolOrderByArea: { leftTop: ["agent", "search", "scheduledTasks", "codeReview"], leftBottom: ["terminal", "files"], rightTop: ["editor"] }
  };
  window.localStorage.setItem(key, JSON.stringify(old));
  let wrapper: VueWrapper | undefined;
  try {
    apiClient.defaults.adapter = async (config) => ok(config, { id: "dock-fixture", title: "Fixture", dirName: "fixture", repos: [], createdAt: 1, updatedAt: 1, terminalCredentialId: null });
    wrapper = shallowMount(WorkspaceLayout, { props: { workspaceId: "dock-fixture", previewEnabled: false }, global: { plugins: [createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } })], stubs: { "a-layout": { template: "<div><slot /></div>" }, "a-layout-content": { template: "<div><slot /></div>" }, "a-select": true, "a-button": true, "a-form": true, "a-form-item": true, "a-modal": true } } });
    wrappers.push(wrapper); await settle();
    const dock = wrapper.findComponent({ name: "WorkspaceDock" });
    assert.ok(dock.exists());
    const props = dock.props() as any;
    assert.deepEqual([...props.leftTopToolbarToolIds], ["agent", "search", "scheduledTasks", "environmentVariables"]);
    assert.deepEqual([...props.leftBottomToolbarToolIds], ["terminal", "files"]);
    assert.equal(props.toolMinimized.files, true);
    assert.equal(props.activeToolIdByArea.leftTop, "agent");
    assert.equal(props.toolTitle("environmentVariables"), "环境变量");
    assert.equal(props.toolIcon("environmentVariables"), EnvironmentVariablesIcon);
    assert.equal(props.isKeepAlive("environmentVariables"), false);
    props.moveTool("environmentVariables", "leftBottom"); await tick();
    assert.ok((dock.props("leftBottomToolbarToolIds") as string[]).includes("environmentVariables"));
    await wrapper.setProps({ workspaceId: "dock-fixture-next" }); await settle();
    assert.ok((dock.props("leftTopToolbarToolIds") as string[]).includes("environmentVariables"));
    assert.equal((dock.props("leftBottomToolbarToolIds") as string[]).includes("environmentVariables"), false);
    assert.equal((dock.props("toolMinimized") as Record<string, boolean>).environmentVariables, false);
  } finally {
    if (wrapper) { wrapper.unmount(); wrappers.splice(wrappers.indexOf(wrapper), 1); }
    window.localStorage.removeItem(key);
    window.localStorage.removeItem("agent-workbench.workspace.dockLayout.v3.dock-fixture-next");
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("total UTF-8 quota counts disabled entries and accepts the exact 64 KiB boundary", async () => {
  const items = ["A", "B", "C"].map((name) => row({ id: name, name, value: "x".repeat(16384), enabled: false }));
  let writes = 0;
  const wrapper = setup((config) => {
    if (config.method === "get") return items;
    writes++; return row({ id: "D", ...body(config) });
  });
  await settle(); await create(wrapper);
  await wrapper.get('input[name="name"]').setValue("D");
  await wrapper.get('textarea[name="value"]').setValue("x".repeat(16373));
  await wrapper.get('[data-testid="save-variable"]').trigger("click");
  assert.equal(writes, 0); assert.match(wrapper.get('[data-testid="form-error"]').text(), /限额/);
  await wrapper.get('textarea[name="value"]').setValue("x".repeat(16372));
  await wrapper.get('[data-testid="save-variable"]').trigger("click"); await settle();
  assert.equal(writes, 1); assert.equal(wrapper.find('[data-testid="drawer"]').exists(), false);
});

test("a stale write rejection cannot create a new Workspace's error or unconfirmed re-read", async () => {
  let rejectOld!: () => void;
  const reads: string[] = [];
  const wrapper = setup((config) => {
    if (config.method === "get") { reads.push(String(config.url)); return []; }
    return new Promise((_resolve, reject) => { rejectOld = () => reject(rejected(config, 500, "WORKSPACE_ENV_PERSIST_FAILED")); });
  });
  await settle(); await create(wrapper);
  await wrapper.get('input[name="name"]').setValue("FIRST");
  await wrapper.get('[data-testid="save-variable"]').trigger("click"); await tick();
  await wrapper.setProps({ workspaceId: "workspace-b" }); await settle();
  rejectOld(); await settle();
  assert.deepEqual(reads, [base, "/workspaces/workspace-b/environment-variables"]);
  assert.equal(wrapper.find('[data-testid="notice"]').exists(), false);
  assert.equal(wrapper.find('[data-testid="unconfirmed"]').exists(), false);
  assert.equal(wrapper.find('[data-testid="list-error"]').exists(), false);
});
