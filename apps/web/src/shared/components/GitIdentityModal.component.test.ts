import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { nextTick } from "vue";
import { shallowMount, type VueWrapper } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import type { GitTarget } from "@agent-workbench/shared";
import { apiClient } from "@/shared/api";
import zhCN from "@/shared/i18n/locales/zh-CN";
import GitIdentityModal from "./GitIdentityModal.vue";

const A: GitTarget = { kind: "workspaceRepo", workspaceId: "identity-modal", dirName: "A" };
const B: GitTarget = { ...A, dirName: "B" };
const originalAdapter = apiClient.defaults.adapter;
const wrappers: VueWrapper[] = [];
let handler: (target: GitTarget) => unknown | Promise<unknown>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
function identity(label: string) {
  return {
    effective: { source: "repo", name: label, email: `${label}@example.invalid` },
    repo: { name: label, email: `${label}@example.invalid` }, global: { name: null, email: null }
  };
}
async function settle() {
  for (let i = 0; i < 3; i++) { await nextTick(); await new Promise<void>((resolve) => setImmediate(resolve)); }
}
function mountIdentity(open = true) {
  const wrapper = shallowMount(GitIdentityModal, {
    props: { open, target: A },
    global: {
      plugins: [createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } })],
      stubs: { "a-modal": true, "a-form": true, "a-form-item": true, "a-input": true, "a-radio-group": true, "a-radio-button": true }
    }
  });
  wrappers.push(wrapper);
  return { wrapper, vm: (wrapper.vm as any).$.setupState as any };
}
beforeEach(() => {
  handler = (target) => identity(target.dirName);
  apiClient.defaults.adapter = async (config) => {
    const body = typeof config.data === "string" ? JSON.parse(config.data) : config.data;
    assert.equal(config.url, "/git/identity/status");
    return { data: await handler(body.target), status: 200, statusText: "OK", headers: {}, config };
  };
});
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  apiClient.defaults.adapter = originalAdapter;
});

test("打开即加载身份，B先返回后A返回也不能覆盖B预填内容", async () => {
  const a = deferred<unknown>(); const b = deferred<unknown>();
  handler = (target) => target.dirName === "A" ? a.promise : b.promise;
  const f = mountIdentity(); await settle();
  await f.wrapper.setProps({ target: B });
  assert.equal(f.vm.name, ""); assert.equal(f.vm.statusLoading, true);
  b.resolve(identity("B")); await settle();
  assert.equal(f.vm.name, "B"); assert.equal(f.vm.email, "B@example.invalid");
  a.resolve(identity("A")); await settle();
  assert.equal(f.vm.name, "B"); assert.equal(f.vm.status.effective.name, "B"); assert.equal(f.vm.statusLoading, false);
});

test("A旧请求先完成时不能清除仍在等待的B loading", async () => {
  const a = deferred<unknown>(); const b = deferred<unknown>();
  handler = (target) => target.dirName === "A" ? a.promise : b.promise;
  const f = mountIdentity(); await settle(); await f.wrapper.setProps({ target: B });
  a.resolve(identity("A")); await settle();
  assert.equal(f.vm.statusLoading, true); assert.equal(f.vm.status, null); assert.equal(f.vm.name, "");
  b.resolve(identity("B")); await settle(); assert.equal(f.vm.statusLoading, false); assert.equal(f.vm.name, "B");
});

test("同一仓库关闭再打开也有新弹窗代际，旧查询不回填或发出submit", async () => {
  const old = deferred<unknown>(); let calls = 0;
  handler = () => ++calls === 1 ? old.promise : identity("new-A");
  const f = mountIdentity(); await settle(); await f.wrapper.setProps({ open: false });
  assert.equal(f.vm.name, ""); assert.equal(f.vm.statusLoading, false);
  await f.wrapper.setProps({ open: true }); await settle();
  assert.equal(f.vm.name, "new-A");
  old.resolve(identity("old-A")); await settle();
  assert.equal(f.vm.name, "new-A"); assert.equal(f.vm.email, "new-A@example.invalid"); assert.equal(f.wrapper.emitted("submit"), undefined);
});

test("submit只同步发出当前身份；关闭重开不遗留旧submitting或延迟close", async () => {
  const f = mountIdentity(); await settle(); f.vm.onOk();
  assert.deepEqual(f.wrapper.emitted("submit")?.[0], [{ scope: "repo", name: "A", email: "A@example.invalid" }]);
  await f.wrapper.setProps({ open: false }); await f.wrapper.setProps({ open: true, target: B }); await settle();
  assert.equal(f.vm.name, "B"); assert.equal(f.vm.submitting, false);
  assert.equal(f.wrapper.emitted("update:open"), undefined); assert.equal(f.wrapper.emitted("submit")?.length, 1);
});

test("卸载后忽略在途身份响应", async () => {
  const old = deferred<unknown>(); handler = () => old.promise;
  const f = mountIdentity(); await settle(); f.wrapper.unmount(); wrappers.splice(wrappers.indexOf(f.wrapper), 1);
  old.resolve(identity("late")); await settle(); assert.equal(f.vm.status, null); assert.equal(f.vm.name, "");
});
