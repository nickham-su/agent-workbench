import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { nextTick } from "vue";
import { shallowMount, type VueWrapper } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { AxiosError } from "axios";
import { Modal, message } from "ant-design-vue";
import { apiClient } from "@/shared/api";
import zhCN from "@/shared/i18n/locales/zh-CN";
import { workspaceHostKey } from "../../host";
import type { GitTarget } from "@agent-workbench/shared";

Object.defineProperties(globalThis, {
  self: { value: window, configurable: true }, localStorage: { value: window.localStorage, configurable: true },
  UIEvent: { value: window.UIEvent, configurable: true }, CSS: { value: window.CSS, configurable: true }
});
const { default: Panel } = await import("./CodeReviewPanel.vue");
const { default: Layout } = await import("../../views/WorkspaceLayout.vue");
const A: GitTarget = { kind: "workspaceRepo", workspaceId: "review-state", dirName: "A" };
const B: GitTarget = { ...A, dirName: "B" };
const originalAdapter = apiClient.defaults.adapter;
const originalConfirm = Modal.confirm;
const originalError = message.error;
const originalSuccess = message.success;
const wrappers: VueWrapper[] = [];
const requests: Array<{ path: string; body: any }> = [];
const confirmations: Array<Parameters<typeof Modal.confirm>[0]> = [];
const errors: unknown[] = [];
let handler: ((path: string, body: any) => unknown | Promise<unknown>) | undefined;
const turn = async () => { await nextTick(); await new Promise<void>((resolve) => setImmediate(resolve)); await nextTick(); };
const settle = async () => { for (let i = 0; i < 4; i++) await turn(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
function failure(code: string) {
  return new AxiosError("Request failed", "ERR_BAD_REQUEST", undefined, undefined, {
    data: { message: code, code }, status: 400, statusText: "Bad Request", headers: {}, config: {} as any
  });
}
function response(path: string, body: any) {
  if (path.startsWith("/workspaces/")) return {
    id: A.workspaceId, title: "Fixture", dirName: "fixture", createdAt: 1, updatedAt: 1, terminalCredentialId: null,
    repos: [A, B].map((target) => ({ dirName: target.dirName, repo: { id: target.dirName, url: `https://example.invalid/${target.dirName}.git` } }))
  };
  if (path === "/git/workspace-status") return { repos: [A, B].map((target) => ({
    repoId: target.dirName, dirName: target.dirName, hasChanges: target.dirName === "B", head: { branch: "main", detached: false, sha: "abc" }
  })) };
  if (path === "/git/changes") return { files: [{ path: `${body.target.dirName}.ts`, status: "M" }] };
  if (path === "/git/branches") return { branches: [{ name: "main" }, { name: "feature" }], defaultBranch: "main" };
  if (path === "/git/identity/status") return { effective: { source: "repo" } };
  if (path === "/git/commit") return { sha: "123456789" };
  if (path === "/git/push") return { remote: "origin", branch: "main" };
  if (path === "/git/pull") return { updated: true };
  return {};
}
const stubs = {
  "a-button": { template: '<button><slot /><slot name="icon" /></button>' },
  "a-tooltip": { template: "<span><slot /></span>" },
  "a-dropdown": { template: "<div><slot /></div>" },
  "a-modal": { props: ["open"], template: '<section v-if="open"><slot /><slot name="footer" /></section>' },
  "a-form": { template: "<div><slot /></div>" }, "a-form-item": { template: "<div><slot /></div>" },
  "a-space": { template: "<div><slot /></div>" }, "a-textarea": true,
  "a-layout": { template: "<div><slot /></div>" }, "a-layout-content": { template: "<div><slot /></div>" },
  "a-select": true, "a-menu": true, "a-menu-item": true, "a-menu-divider": true
};
function state(wrapper: VueWrapper): any { return (wrapper.vm as any).$?.setupState; }
function mountPanel(push?: (target: GitTarget) => Promise<void>, beginGitOp: () => () => void = () => () => {}) {
  const refreshes: number[] = [];
  const editorCalls: any[] = [];
  const wrapper = shallowMount(Panel, {
    props: { workspaceId: A.workspaceId, toolId: "codeReview", target: A, gitBusy: false, beginGitOp,
      push, refreshStatus: async () => { refreshes.push(1); } },
    global: { plugins: [createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } })], stubs,
      provide: { [workspaceHostKey as symbol]: { callFrom: (...args: any[]) => editorCalls.push(args), setToolDot() {}, registerToolCommands: () => () => {} } } }
  });
  wrappers.push(wrapper);
  return { wrapper, vm: state(wrapper), refreshes, editorCalls };
}
function mountLayout() {
  const wrapper = shallowMount(Layout, {
    props: { workspaceId: A.workspaceId, previewEnabled: false },
    global: { plugins: [createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } })], stubs }
  });
  wrappers.push(wrapper);
  const dock = () => wrapper.findComponent({ name: "WorkspaceDock" }).props() as any;
  return { wrapper, vm: state(wrapper), dock, review: () => dock().toolViewProps("codeReview") };
}
beforeEach(() => {
  window.localStorage.clear(); requests.length = 0; confirmations.length = 0; errors.length = 0; handler = undefined;
  (Modal as { confirm: typeof Modal.confirm }).confirm = ((options: Parameters<typeof Modal.confirm>[0]) => {
    confirmations.push(options); return { destroy() {}, update() {} };
  }) as typeof Modal.confirm;
  message.error = ((error: unknown) => { errors.push(error); return (() => {}) as any; }) as typeof message.error;
  message.success = (() => (() => {}) as any) as typeof message.success;
  apiClient.defaults.adapter = async (config) => {
    const path = config.url!; const body = typeof config.data === "string" ? JSON.parse(config.data) : config.data;
    requests.push({ path, body });
    const data = handler ? await handler(path, body) : response(path, body);
    return { data, status: 200, statusText: "OK", headers: {}, config };
  };
});
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  apiClient.defaults.adapter = originalAdapter; (Modal as { confirm: typeof Modal.confirm }).confirm = originalConfirm; message.error = originalError; message.success = originalSuccess;
  window.localStorage.clear();
});

test("慢的旧仓库列表及同仓库旧刷新均不能覆盖新列表", async () => {
  const oldA = deferred<unknown>();
  handler = (path, body) => path === "/git/changes" && body.target.dirName === "A" ? oldA.promise : response(path, body);
  const f = mountPanel(); await turn(); await f.wrapper.setProps({ target: B }); await settle();
  assert.equal(f.vm.staged[0].path, "B.ts");
  oldA.resolve({ files: [{ path: "late-A.ts", status: "M" }] }); await settle();
  assert.equal(f.vm.staged[0].path, "B.ts");
  const olderB = deferred<unknown>();
  handler = (path, body) => path === "/git/changes" ? olderB.promise : response(path, body);
  const pending = f.vm.refreshAll(); await turn(); handler = response;
  await f.vm.refreshAll(); olderB.resolve({ files: [{ path: "late-B.ts", status: "M" }] }); await pending;
  assert.equal(f.vm.staged[0].path, "B.ts");
});

test("提交弹窗打开后切换审查仓库，提交和推送仍固定原仓库", async () => {
  const pushes: GitTarget[] = [];
  const f = mountPanel(async (target) => { pushes.push(target); }); await settle();
  f.vm.openCommit(); f.vm.commitMessage = "commit A";
  await f.wrapper.setProps({ target: B }); await settle();
  await f.vm.submitCommit("commitAndPush");
  const commits = requests.filter((request) => request.path === "/git/commit");
  assert.equal(commits.length, 1); assert.deepEqual(commits[0]!.body.target, A);
  assert.equal(commits[0]!.body.message, "commit A"); assert.deepEqual(pushes, [A]);
  assert.equal(f.refreshes.length, 1);
});

test("身份补配重试保留原提交目标、信息和提交并推送模式", async () => {
  let attempts = 0; const pushes: GitTarget[] = [];
  handler = (path, body) => { if (path === "/git/commit" && attempts++ === 0) throw failure("GIT_IDENTITY_REQUIRED"); return response(path, body); };
  const f = mountPanel(async (target) => { pushes.push(target); }); await settle();
  f.vm.openCommit(); f.vm.commitMessage = "identity A"; await f.vm.submitCommit("commitAndPush");
  assert.equal(f.vm.identityOpen, true);
  await f.wrapper.setProps({ target: B }); await settle();
  assert.equal(f.wrapper.findComponent({ name: "GitIdentityModal" }).props("target").dirName, "A");
  await f.vm.onIdentitySubmit({ scope: "session", name: "Fixture", email: "fixture@example.invalid" });
  const commits = requests.filter((request) => request.path === "/git/commit");
  assert.equal(commits.length, 2); assert.ok(commits.every((request) => request.body.target.dirName === "A" && request.body.message === "identity A"));
  assert.deepEqual(pushes, [A]); assert.equal(f.vm.identityOpen, false);
});

test("旧提交完成不能关闭另一个仓库的新弹窗或清除其草稿", async () => {
  const commit = deferred<unknown>(); handler = (path, body) => path === "/git/commit" ? commit.promise : response(path, body);
  const f = mountPanel(); await settle(); f.vm.openCommit(); f.vm.commitMessage = "A message";
  const pending = f.vm.submitCommit("commit"); await turn();
  await f.wrapper.setProps({ target: B }); await settle(); f.vm.openCommit(); f.vm.commitMessage = "B draft";
  commit.resolve({ sha: "123456789" }); await pending;
  assert.equal(f.vm.commitOpen, true); assert.equal(f.vm.commitMessage, "B draft"); assert.equal(f.vm.commitDialog.target.dirName, "B");
});

test("未打开审查面板也聚合全部仓库，摘要保存在宿主且不轮询旧单仓库接口", async () => {
  const f = mountLayout(); await settle();
  assert.equal(f.dock().toolDots.codeReview, true);
  assert.equal(f.review().repoStatuses.length, 2);
  assert.equal(f.review().repoStatuses[1].hasChanges, true);
  assert.equal(requests.some((request) => request.path === "/git/status"), false);
});

test("非选中行的切分支入口不改变审查选择，确认前后选择变化不改变操作目标", async () => {
  const f = mountLayout(); await settle();
  await f.review().checkout(B); assert.equal(f.review().selectedRepoDirName, "A");
  f.vm.checkoutBranch = "feature"; await f.vm.submitCheckout(); assert.equal(confirmations.length, 1);
  f.review().selectRepo("B"); await settle(); f.review().selectRepo("A"); await settle();
  await confirmations[0]!.onOk!();
  const operation = requests.find((request) => request.path === "/git/checkout");
  assert.equal(operation?.body.target.dirName, "B"); assert.equal(operation?.body.branch, "feature");
});

test("拉取确认后改选另一仓库仍拉取原仓库，预检查失败不当作无变更", async () => {
  const f = mountLayout(); await settle(); await f.review().pull(A); assert.equal(confirmations.length, 1);
  f.review().selectRepo("B"); await settle(); await confirmations[0]!.onOk!();
  assert.equal(requests.find((request) => request.path === "/git/pull")?.body.target.dirName, "A");
  handler = (path, body) => { if (path === "/git/changes") throw failure("CHANGES_FAILED"); return response(path, body); };
  await f.review().pull(B);
  assert.equal(requests.filter((request) => request.path === "/git/pull").length, 1); assert.equal(confirmations.length, 1);
  assert.ok(errors.some((error) => String(error).includes("CHANGES_FAILED")));
});

test("推送补配身份及无 upstream 确认重试都固定原行目标", async () => {
  let identitySet = false;
  handler = (path, body) => {
    if (path === "/git/identity/status") return { effective: { source: identitySet ? "repo" : "none" } };
    if (path === "/git/identity") identitySet = true;
    if (path === "/git/push" && !body.setUpstream) throw failure("GIT_NO_UPSTREAM");
    return response(path, body);
  };
  const f = mountLayout(); await settle(); await f.review().push(A); assert.equal(f.vm.pushIdentityOpen, true);
  f.review().selectRepo("B"); await settle();
  await f.vm.onPushIdentitySubmit({ scope: "repo", name: "Fixture", email: "fixture@example.invalid" });
  assert.equal(requests.find((request) => request.path === "/git/identity")?.body.target.dirName, "A");
  assert.equal(confirmations.length, 1); await confirmations[0]!.onOk!();
  const pushes = requests.filter((request) => request.path === "/git/push");
  assert.equal(pushes.length, 2); assert.ok(pushes.every((request) => request.body.target.dirName === "A")); assert.equal(pushes[1]!.body.setUpstream, true);
});


test("跨仓库同路径 Diff 不复用标签，旧仓库慢 Diff 不打开错误文件", async () => {
  const oldCompare = deferred<unknown>();
  const compare = (body: any) => ({ path: body.path, base: { previewable: true, content: "before", bytes: 6 }, current: { previewable: true, content: body.target.dirName, bytes: 1 } });
  handler = (path, body) => path === "/git/file-compare" ? (body.target.dirName === "A" ? oldCompare.promise : compare(body)) : response(path, body);
  const f = mountPanel(); await settle(); f.vm.selectFile("unstaged", "shared.ts"); await turn();
  await f.wrapper.setProps({ target: B }); await settle(); f.vm.selectFile("unstaged", "shared.ts"); await settle();
  assert.equal(f.editorCalls.length, 1); assert.match(f.editorCalls[0][2].payload.tabKey, /review-state\/B/);
  oldCompare.resolve({ path: "shared.ts", base: { previewable: true, content: "before", bytes: 6 }, current: { previewable: true, content: "A", bytes: 1 } }); await settle();
  assert.equal(f.editorCalls.length, 1);
  handler = (path, body) => path === "/git/file-compare" ? compare(body) : response(path, body);
  await f.wrapper.setProps({ target: A }); await settle(); f.vm.selectFile("unstaged", "shared.ts"); await settle();
  assert.equal(f.editorCalls.length, 2); assert.notEqual(f.editorCalls[0][2].payload.tabKey, f.editorCalls[1][2].payload.tabKey);
});


test("提交并推送先取得实际宿主busy，再进行被动刷新，等待刷新时的新操作不能吞掉push", async () => {
  const host = mountLayout(); await settle();
  const detail = deferred<unknown>(); let committed = false; let releaseOther: (() => void) | undefined;
  handler = (path, body) => {
    if (path === "/git/commit") committed = true;
    if (path === "/git/changes" && committed) {
      releaseOther ??= host.review().beginGitOp();
      return detail.promise;
    }
    return response(path, body);
  };
  const panel = mountPanel(host.review().push, host.review().beginGitOp); await settle();
  panel.vm.openCommit(); panel.vm.commitMessage = "commit and push A";
  const operation = panel.vm.submitCommit("commitAndPush"); await settle();
  try {
    assert.equal(requests.filter((request) => request.path === "/git/push").length, 1);
    assert.equal(requests.find((request) => request.path === "/git/push")?.body.target.dirName, "A");
    assert.equal(host.review().gitBusy, true);
  } finally {
    detail.resolve({ files: [] }); await operation; releaseOther?.();
  }
});

test("身份A保存延迟完成不关闭新B弹窗、不清新loading，也不续接旧push覆盖B pending", async () => {
  const save = deferred<unknown>();
  handler = (path, body) => {
    if (path === "/git/identity/status") return { effective: { source: "none" } };
    if (path === "/git/identity") return save.promise;
    return response(path, body);
  };
  const host = mountLayout(); await settle(); await host.review().push(A);
  const pendingSave = host.vm.onPushIdentitySubmit({ scope: "repo", name: "Fixture A", email: "a@example.invalid" }); await turn();
  host.vm.pushIdentityOpen = false;
  host.vm.pendingPush = { target: B, params: {} };
  host.vm.pushIdentityOpen = true;
  host.vm.pushIdentitySubmitting = true;
  save.resolve({}); await pendingSave; await settle();
  assert.equal(requests.find((request) => request.path === "/git/identity")?.body.target.dirName, "A");
  assert.equal(requests.filter((request) => request.path === "/git/push").length, 0);
  assert.equal(host.vm.pendingPush.target.dirName, "B"); assert.equal(host.vm.pushIdentityOpen, true);
  assert.equal(host.vm.pushIdentitySubmitting, true);
});
