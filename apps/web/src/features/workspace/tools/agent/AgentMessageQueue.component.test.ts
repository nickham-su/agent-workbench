import assert from "node:assert/strict";
import test from "node:test";
import { mount } from "@vue/test-utils";
import { defineComponent, h, nextTick, reactive, shallowRef } from "vue";
import { createI18n } from "vue-i18n";
import type { AgentAcceptUserMessageResponse, AgentMessageQueueSnapshot } from "@agent-workbench/shared";
import zhCN from "@/shared/i18n/locales/zh-CN";
import enUS from "@/shared/i18n/locales/en-US";
import { ApiError, apiClient } from "@/shared/api/api";
import * as api from "@/shared/api/agentMessageQueueApi";
import Panel from "./AgentMessageQueuePanel.vue";
import { useAgentMessageQueue, type QueueSubmission } from "./useAgentMessageQueue";

const identity = { agentId: "server-agent", providerId: "server-provider", modelId: "server-model" };
function snapshot(overrides: Partial<AgentMessageQueueSnapshot> = {}): AgentMessageQueueSnapshot {
  return { workspaceId: "queue-w", sessionId: "queue-s", queueVersion: 0, stopGeneration: "0".repeat(64), mode: "active", pauseCode: null,
    pendingCount: 0, pendingBytes: 0, inputIdentity: null, pendingIdentity: null, recoveryIdentity: null,
    unconfirmedInputCount: 0, unconfirmedInputSetHash: null, stop: { state: "none", unresolvedOperationCount: 0, unresolvedTargetCount: 0, code: null }, items: [], ...overrides };
}
function accepted(queue = snapshot()): AgentAcceptUserMessageResponse {
  return { queue, deduplicated: false, receipt: { id: "receipt", clientRequestId: "fixed-request", sequence: 1,
    createdAt: 1, updatedAt: 1, status: "queued", messageId: null, runId: null, confirmationState: null, confirmationSource: null } };
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function settle() { for (let i = 0; i < 8; i++) { await Promise.resolve(); await nextTick(); } }
function fixture(overrides: Partial<typeof api> = {}) {
  const scope = reactive({ workspaceId: "queue-w", sessionId: "queue-s", active: false, running: false });
  let queue!: ReturnType<typeof useAgentMessageQueue>;
  const wrapper = mount(defineComponent({ setup() { queue = useAgentMessageQueue(() => scope, { ...api, getAgentMessageQueue: async id => snapshot({ sessionId: id }), ...overrides }); return () => h("div"); } }));
  return { scope, queue, wrapper };
}
function submission(): QueueSubmission {
  return { sessionId: "queue-s", composerId: "queue-composer", payload: { workspaceId: "queue-w", clientRequestId: "fixed-request", text: "original", agentId: "server-agent", stopGeneration: "0".repeat(64) },
    draft: "original", draftRevision: 3, images: [] };
}
function panelGlobal(locale = "zh-CN") {
  return { plugins: [createI18n({ legacy: false, locale, messages: { "zh-CN": zhCN, "en-US": enUS } })],
    stubs: { "a-button": defineComponent({ props: { disabled: Boolean }, emits: ["click"], setup(props, { emit, slots }) { return () => h("button", { disabled: props.disabled, onClick: () => emit("click") }, slots.default?.()); } }) } };
}
function panel(props: Partial<InstanceType<typeof Panel>["$props"]> = {}, locale = "zh-CN") {
  return mount(Panel, { props: { snapshot: snapshot(), ...props }, global: panelGlobal(locale) });
}

test("队列面板：只显示服务端 queued 数量，N=0 无文字与间距，不展示内部状态或管理入口", async () => {
  const wrapper = panel({ snapshot: snapshot({ mode: "paused", pauseCode: "user_stop", pendingCount: 2,
    unconfirmedInputCount: 1, stop: { state: "unknown", code: "transport_timeout", unresolvedOperationCount: 1, unresolvedTargetCount: 1 },
    items: [{ ...queuedItem(), textPreview: "private queued text" }] }) });
  try {
    assert.equal(wrapper.text(), "有 2 条消息等待处理");
    assert.equal(wrapper.findAll("button, details, li").length, 0);
    await wrapper.setProps({ snapshot: snapshot({ mode: "paused", unconfirmedInputCount: 1 }) });
    assert.equal(wrapper.text(), "");
    assert.equal(wrapper.element.childElementCount, 0);
    assert.equal(wrapper.attributes("class"), undefined);
  } finally { wrapper.unmount(); }
});
test("队列面板：启动过渡仅隐藏展示，不修改快照，过渡结束恢复真实计数", async () => {
  const queued = snapshot({ pendingCount: 1 });
  const wrapper = panel({ snapshot: queued, hidePendingCount: true });
  try {
    assert.equal(wrapper.find('[data-testid="queue-pending-count"]').exists(), false);
    assert.equal(wrapper.element.childElementCount, 0);
    assert.equal(queued.pendingCount, 1);
    await wrapper.setProps({ hidePendingCount: false });
    assert.equal(wrapper.get('[data-testid="queue-pending-count"]').text(), "有 1 条消息等待处理");
  } finally { wrapper.unmount(); }
});
test("队列面板：英文只显示数量", () => {
  const wrapper = panel({ snapshot: snapshot({ pendingCount: 5 }) }, "en-US");
  try { assert.equal(wrapper.text(), "5 messages waiting to be processed"); } finally { wrapper.unmount(); }
});
test("队列状态：低版本与旧 Session 回包不能覆盖新快照，断网保留计数", async () => {
  const old = deferred<AgentMessageQueueSnapshot>();
  const f = fixture({ getAgentMessageQueue: async (id) => id === "queue-s" ? old.promise : snapshot({ sessionId: id, queueVersion: 7, pendingCount: 2 }) });
  try {
    f.scope.active = true; await settle();
    f.scope.sessionId = "new-s"; await settle();
    old.resolve(snapshot({ queueVersion: 99, pendingCount: 99 })); await settle();
    assert.equal(f.queue.snapshot.value?.sessionId, "new-s");
    f.queue.apply(snapshot({ sessionId: "new-s", queueVersion: 6, pendingCount: 6 }));
    assert.equal(f.queue.snapshot.value?.pendingCount, 2);
  } finally { f.wrapper.unmount(); }
  const disconnected = fixture({ getAgentMessageQueue: async () => { throw new ApiError({ message: "offline" }); } });
  try {
    disconnected.queue.apply(snapshot({ queueVersion: 4, pendingCount: 3 })); disconnected.scope.active = true; await settle();
    assert.equal(disconnected.queue.snapshot.value?.pendingCount, 3); assert.ok(disconnected.queue.error.value);
  } finally { disconnected.wrapper.unmount(); }
});
test("队列轮询：idle 3000ms，running/queued/paused/unconfirmed 800ms，可见性恢复立即查询", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  let server = snapshot();
  const f = fixture({ getAgentMessageQueue: async () => { calls++; return server; } });
  t.after(() => { f.wrapper.unmount(); t.mock.timers.reset(); });
  f.scope.active = true; await settle(); assert.equal(calls, 1);
  t.mock.timers.tick(2999); await settle(); assert.equal(calls, 1);
  t.mock.timers.tick(1); await settle(); assert.equal(calls, 2);
  f.scope.running = true; await settle(); assert.equal(calls, 3);
  t.mock.timers.tick(799); await settle(); assert.equal(calls, 3);
  t.mock.timers.tick(1); await settle(); assert.equal(calls, 4);
  f.scope.running = false; server = snapshot({ queueVersion: 1, pendingCount: 1 }); await settle();
  const before = calls; t.mock.timers.tick(800); await settle(); assert.equal(calls, before + 1);
  for (const next of [snapshot({ queueVersion: 2, mode: "paused" }), snapshot({ queueVersion: 3, unconfirmedInputCount: 1 })]) {
    server = next; await f.queue.refresh(); const n: number = calls; t.mock.timers.tick(800); await settle(); assert.equal(calls, n + 1);
  }
  document.dispatchEvent(new Event("visibilitychange")); await settle(); assert.ok(calls > before + 2);
});
test("权威执行身份：无 queued/unconfirmed 的 running Run 仍锁定服务端身份", () => {
  const f = fixture();
  try { f.queue.apply(snapshot({ inputIdentity: identity })); assert.deepEqual(f.queue.identity.value, identity); assert.equal(f.queue.snapshot.value?.pendingCount, 0); }
  finally { f.wrapper.unmount(); }
});
test("发送结果未知：查询 404 不清副本，原 ID 和图片字节重试；切 Session 隔离", async () => {
  const requests: Array<unknown> = [];
  const image = new File([new Uint8Array([1, 2, 3])], "capture.png", { type: "image/png" });
  let attempts = 0;
  const f = fixture({ acceptAgentUserMessage: async (_id, body) => { requests.push(body); if (++attempts === 1) throw new ApiError({ message: "timeout" }); return accepted(); },
    getAgentReceiptByRequest: async () => { throw new ApiError({ message: "not found", status: 404 }); } });
  try {
    const original = submission(); original.images = [{ id: "image-1", filename: "capture.png", file: image }];
    await assert.rejects(f.queue.submit(original));
    assert.equal(f.queue.snapshot.value, null, "HTTP unknown is not a queued receipt");
    await assert.rejects(f.queue.resolveUnknown(false)); assert.equal(f.queue.unknownSubmission.value?.images[0]?.file, image);
    f.scope.sessionId = "other-s"; await settle(); assert.equal(f.queue.unknownSubmission.value, null);
    f.scope.sessionId = "queue-s"; await settle(); assert.equal((f.queue.unknownSubmission.value as QueueSubmission | null)?.payload.clientRequestId, "fixed-request");
    await f.queue.resolveUnknown(true); assert.equal(f.queue.unknownSubmission.value, null);
    for (const body of requests as FormData[]) {
      assert.equal(JSON.parse(String(body.get("payload"))).clientRequestId, "fixed-request");
      const uploaded = body.get("images") as File;
      assert.deepEqual(new Uint8Array(await uploaded.arrayBuffer()), new Uint8Array([1, 2, 3]));
    }
  } finally { f.wrapper.unmount(); }
});
test("507 是明确拒收，草稿副本由输入框保留，不进入未知重发状态", async () => {
  const f = fixture({ acceptAgentUserMessage: async () => { throw new ApiError({ message: "retention full", status: 507 }); } });
  try { await assert.rejects(f.queue.submit(submission())); assert.equal(f.queue.unknownSubmission.value, null); } finally { f.wrapper.unmount(); }
});
test("Stop：未知结果复用原 operationId，成功后新 Stop 使用新 ID，且不带版本", async () => {
  const bodies: Array<{ workspaceId: string; operationId: string }> = [];
  const f = fixture({ stopAgentMessageQueue: async (_id, body) => { bodies.push(body); if (bodies.length === 1) throw new ApiError({ message: "timeout" }); return { stopOperation: { operationId: body.operationId, acceptedQueueVersion: 1, targetCount: 0 }, queue: snapshot({ mode: "paused" }) }; } });
  try {
    await assert.rejects(f.queue.stop()); assert.equal(f.queue.stopBlocked.value, true);
    await f.queue.stop(); assert.equal(bodies[0]!.operationId, bodies[1]!.operationId); assert.deepEqual(Object.keys(bodies[1]!).sort(), ["operationId", "workspaceId"]);
    await f.queue.stop(); assert.notEqual(bodies[1]!.operationId, bodies[2]!.operationId);
  } finally { f.wrapper.unmount(); }
});
test("继续与放弃：确认快照 CAS、全集 hash、显式不可逆确认；未知操作重放不换 ID", async () => {
  const bodies: unknown[] = [];
  const f = fixture({ abandonAgentUnconfirmedInput: async (_id, body) => { bodies.push(body); if (bodies.length === 1) throw new ApiError({ message: "timeout" }); return { abandonedReceiptIds: ["r1"], queue: snapshot({ queueVersion: 10 }) }; } });
  try {
    const confirmed = snapshot({ queueVersion: 7, mode: "paused", unconfirmedInputCount: 1, unconfirmedInputSetHash: "a".repeat(64) });
    f.queue.apply(confirmed); f.queue.apply(snapshot({ queueVersion: 8, unconfirmedInputCount: 2, unconfirmedInputSetHash: "b".repeat(64) }));
    await assert.rejects(f.queue.control("abandon", confirmed));
    await f.queue.control("abandon"); assert.deepEqual(bodies[0], bodies[1]);
    const sent = bodies[0] as Record<string, unknown>;
    assert.equal(sent.expectedQueueVersion, 7); assert.equal(sent.expectedUnconfirmedInputSetHash, "a".repeat(64)); assert.equal(sent.confirmIrreversible, true); assert.equal("receiptIds" in sent, false);
  } finally { f.wrapper.unmount(); }
});
test("版本冲突清除旧控制尝试并刷新，pending/unknown 停止屏障不发送恢复请求", async () => {
  let controls = 0, polls = 0;
  const f = fixture({ getAgentMessageQueue: async () => { polls++; return snapshot({ queueVersion: 3 }); }, resumeAgentMessageQueue: async () => { controls++; throw new ApiError({ message: "conflict", code: "AGENT_QUEUE_VERSION_CONFLICT", status: 409 }); } });
  try {
    f.scope.active = true; await settle();
    await assert.rejects(f.queue.control("resume")); await settle(); assert.equal(f.queue.unknownControl.value, null); assert.ok(polls >= 2);
    f.queue.apply(snapshot({ queueVersion: 4, stop: { state: "unknown", unresolvedOperationCount: 1, unresolvedTargetCount: 1, code: "transport_timeout" } }));
    await f.queue.control("resume"); await f.queue.control("abandon"); assert.equal(controls, 1);
  } finally { f.wrapper.unmount(); }
});
test("公共 API：坏的成功响应被判为结果未知，不伪造接收失败或运行 ID", async () => {
  const previous = apiClient.defaults.adapter;
  apiClient.defaults.adapter = async config => ({ config, status: 202, statusText: "Accepted", headers: {}, data: { runId: "not-a-receipt" } });
  try { await assert.rejects(api.acceptAgentUserMessage("s", { workspaceId: "w", clientRequestId: "fixed", text: "input" }), (error: unknown) => error instanceof ApiError && error.status === undefined && error.code === "AGENT_QUEUE_RESPONSE_UNKNOWN"); }
  finally { apiClient.defaults.adapter = previous; }
});

test("同版本队列冲突保留可信快照，诊断限次且不包含正文、身份、scope 或 hash", t => {
  const logs: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => logs.push(args));
  const f = fixture();
  try {
    const trusted = snapshot({ queueVersion: 8, pendingCount: 1, pendingIdentity: identity, unconfirmedInputSetHash: "private-hash" });
    f.queue.apply(trusted);
    const conflict = { ...trusted, pendingCount: 2, pendingIdentity: { ...identity, agentId: "private-agent" } };
    f.queue.apply(conflict); f.queue.apply(conflict);
    f.queue.apply({ ...trusted, items: [{ id: "private-receipt", clientRequestId: "private-request", sequence: 1, createdAt: 1, updatedAt: 1, status: "queued", messageId: null, runId: null, confirmationState: null, confirmationSource: null, textPreview: "private-body private-file.png", attachmentCount: 1 }] });
    assert.equal(f.queue.snapshot.value, trusted);
    assert.equal((f.queue.error.value as ApiError).code, "AGENT_QUEUE_SAME_VERSION_CONFLICT");
    assert.deepEqual(logs, [["AGENT_QUEUE_SAME_VERSION_CONFLICT", { queueVersion: 8 }]]);
    assert.doesNotMatch(JSON.stringify(logs), /private|queue-w|queue-s|server-agent/);
    f.queue.apply({ ...conflict, queueVersion: 9 });
    assert.equal(f.queue.snapshot.value?.pendingCount, 2); assert.equal(f.queue.error.value, null);
    f.queue.apply({ ...conflict, queueVersion: 9, pendingBytes: 77 });
    assert.equal(logs.length, 2);
  } finally { f.wrapper.unmount(); }
});

const pendingStop: AgentMessageQueueSnapshot["stop"] = {
  state: "pending", unresolvedOperationCount: 1, unresolvedTargetCount: 1, code: "stop_requested",
};
const stopConflicts: Array<[string, Partial<AgentMessageQueueSnapshot["stop"]>]> = [
  ["pending → unknown", { state: "unknown", code: "runtime_exit_unproven" }],
  ["pending → quiescent", { state: "quiescent", unresolvedOperationCount: 0, unresolvedTargetCount: 0, code: null }],
  ["仅 state", { state: "unknown" }],
  ["仅 unresolvedOperationCount", { unresolvedOperationCount: 2 }],
  ["仅 unresolvedTargetCount", { unresolvedTargetCount: 2 }],
  ["仅 code", { code: "transport_timeout" }],
  ["仅 code 变为 null", { code: null }],
];
for (const [name, change] of stopConflicts) test(`同版本公开 Stop ${name} 冲突保留可信快照并安全限次诊断`, t => {
  const logs: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => logs.push(args));
  const f = fixture();
  try {
    const trusted = snapshot({ queueVersion: 3, mode: "paused", pauseCode: "user_stop", stop: pendingStop });
    const changed = { ...trusted, stop: { ...pendingStop, ...change } };
    f.queue.apply(trusted); f.queue.apply(changed); f.queue.apply(changed);
    assert.equal(f.queue.snapshot.value, trusted);
    assert.equal((f.queue.error.value as ApiError).code, "AGENT_QUEUE_SAME_VERSION_CONFLICT");
    assert.deepEqual(logs, [["AGENT_QUEUE_SAME_VERSION_CONFLICT", { queueVersion: 3 }]]);
    f.queue.apply({ ...changed, queueVersion: 4 });
    assert.deepEqual(f.queue.snapshot.value?.stop, changed.stop);
    assert.equal(f.queue.error.value, null); assert.equal(logs.length, 1);
  } finally { f.wrapper.unmount(); }
});

test("公开 Stop 高版本 pending → unknown → quiescent 合法更新状态、计数和 code", t => {
  const warn = t.mock.method(console, "warn", () => undefined);
  const f = fixture();
  try {
    const stops: AgentMessageQueueSnapshot["stop"][] = [pendingStop,
      { ...pendingStop, state: "unknown", code: "runtime_exit_unproven" },
      { state: "quiescent", unresolvedOperationCount: 0, unresolvedTargetCount: 0, code: null }];
    for (const [index, stop] of stops.entries()) {
      f.queue.apply(snapshot({ queueVersion: index + 3, mode: "paused", pauseCode: "user_stop", stop }));
      assert.deepEqual(f.queue.snapshot.value?.stop, stop); assert.equal(f.queue.error.value, null);
    }
    assert.equal(warn.mock.calls.length, 0);
  } finally { f.wrapper.unmount(); }
});

test("同版本 inputIdentity 及未进入公开 snapshot 的内部 proof 变化不误报，Stop 字段顺序不影响比较", async t => {
  const warn = t.mock.method(console, "warn", () => undefined);
  // The simulated server owns proof metadata; its public queue response contains
  // only the four aggregate Stop fields, just like the production snapshot query.
  const server = { inputIdentity: null as AgentMessageQueueSnapshot["inputIdentity"], proofId: "private-proof-1", observedAt: 1,
    queue: snapshot({ queueVersion: 3, stop: pendingStop }) };
  const f = fixture({ getAgentMessageQueue: async () => ({ ...server.queue, inputIdentity: server.inputIdentity }) });
  try {
    f.queue.apply(server.queue); f.scope.active = true; await settle();
    server.proofId = "private-proof-2"; server.observedAt = 2; server.inputIdentity = identity;
    server.queue = { ...server.queue, stop: { code: pendingStop.code, unresolvedTargetCount: 1, unresolvedOperationCount: 1, state: "pending" } };
    await f.queue.refresh();
    assert.deepEqual(f.queue.identity.value, identity); assert.deepEqual(f.queue.snapshot.value?.stop, pendingStop);
    assert.equal("proofId" in f.queue.snapshot.value!.stop, false);
    assert.equal(f.queue.error.value, null);
    server.inputIdentity = null; await f.queue.refresh();
    assert.equal(f.queue.identity.value, null); assert.equal(f.queue.snapshot.value?.queueVersion, 3);
    assert.equal(warn.mock.calls.length, 0);
  } finally { f.wrapper.unmount(); }
});

// Match AgentClientPane's getter: constructing the scope reads the Run ref even
// when the watcher only wants workspaceId/sessionId. A bare reactive scope hides
// these dependencies and cannot catch BROWSER-1.
function productionScopeFixture(overrides: Partial<typeof api>) {
  const scope = reactive({ workspaceId: "browser-watch-w", sessionId: "browser-watch-s", active: true });
  const runState = shallowRef({ status: "running", revision: 0 });
  let queue!: ReturnType<typeof useAgentMessageQueue>;
  const wrapper = mount(defineComponent({ setup() {
    queue = useAgentMessageQueue(() => ({ workspaceId: scope.workspaceId, sessionId: scope.sessionId,
      active: scope.active, running: runState.value.status === "running" }), { ...api, ...overrides });
    return () => h(Panel, { snapshot: queue.snapshot.value });
  } }), { global: panelGlobal() });
  const currentSnapshot = (overrides: Partial<AgentMessageQueueSnapshot> = {}) => snapshot({ workspaceId: scope.workspaceId, sessionId: scope.sessionId, ...overrides });
  return { scope, runState, queue, wrapper, currentSnapshot };
}
function queuedItem() {
  const receipt = accepted().receipt;
  assert.equal(receipt.status, "queued");
  if (receipt.status !== "queued") throw new Error("fixture must be queued");
  return { ...receipt, textPreview: "browser watch message", attachmentCount: 0 };
}

test("生产同形scope：重复Run快照保留数量节点、内部取消busy与800ms轮询期限", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const cancelled = deferred<Awaited<ReturnType<typeof api.cancelAgentQueuedReceipt>>>();
  let polls = 0, cancels = 0;
  const f = productionScopeFixture({
    getAgentMessageQueue: async () => { polls++; return snapshot({ workspaceId: "browser-watch-w", sessionId: "browser-watch-s", pendingCount: 1, items: [queuedItem()] }); },
    cancelAgentQueuedReceipt: async () => { cancels++; return cancelled.promise; },
  });
  t.after(() => { f.wrapper.unmount(); t.mock.timers.reset(); });
  await settle();
  const baselinePolls = polls;
  const trusted = f.queue.snapshot.value;
  const countNode = f.wrapper.get('[data-testid="queue-pending-count"]').element;
  t.mock.timers.tick(799);
  f.runState.value = { status: "running", revision: 1 }; await settle();
  assert.equal(f.queue.snapshot.value, trusted);
  assert.equal(polls, baselinePolls, "same primitive values must not trigger refresh or abort the poll");
  assert.equal(f.wrapper.get('[data-testid="queue-pending-count"]').element, countNode);
  t.mock.timers.tick(1); await settle(); assert.equal(polls, baselinePolls + 1, "original poll deadline is preserved");
  const cancellation = f.queue.cancel("receipt");
  assert.equal(cancels, 1); assert.equal(f.queue.busy.value, true);
  f.runState.value = { status: "running", revision: 2 }; await settle();
  assert.equal(f.queue.busy.value, true); assert.equal(polls, baselinePolls + 1);
  assert.equal(f.wrapper.get('[data-testid="queue-pending-count"]').element, countNode);
  cancelled.resolve({ receipt: { ...queuedItem(), status: "cancelled" }, queue: f.currentSnapshot({ queueVersion: 1 }) });
  await cancellation; await settle();
  assert.equal(f.queue.busy.value, false); assert.equal(f.queue.snapshot.value?.pendingCount, 0);
  assert.equal(f.wrapper.find('[data-testid="queue-pending-count"]').exists(), false);
});

for (const kind of ["stop", "resume"] as const) test(`生产同形scope：重复Run快照保留${kind}未知操作与在途确认`, async () => {
  const completion = deferred<AgentMessageQueueSnapshot>();
  const f = productionScopeFixture({
    getAgentMessageQueue: async (_id, workspaceId) => snapshot({ workspaceId, sessionId: "browser-watch-s" }),
    stopAgentMessageQueue: async (_id, body) => ({ stopOperation: { operationId: body.operationId, acceptedQueueVersion: 1, targetCount: 0 }, queue: await completion.promise }),
    resumeAgentMessageQueue: async () => ({ action: "continued_unconfirmed", runId: "continued-run", queue: await completion.promise }),
  });
  try {
    await settle();
    const action = kind === "stop" ? f.queue.stop() : f.queue.control("resume");
    await settle(); assert.equal(f.queue.busy.value, true);
    if (kind === "stop") assert.equal(f.queue.unknownStop.value, true);
    else assert.equal(f.queue.unknownControl.value?.kind, "resume");
    f.runState.value = { status: "running", revision: 1 }; await settle();
    assert.equal(f.queue.busy.value, true);
    if (kind === "stop") assert.equal(f.queue.unknownStop.value, true);
    else assert.equal(f.queue.unknownControl.value?.kind, "resume");
    completion.resolve(f.currentSnapshot({ queueVersion: 1, pendingCount: 2 })); await action; await settle();
    assert.equal(f.queue.snapshot.value?.pendingCount, 2);
    assert.equal(f.queue.busy.value, false); assert.equal(f.queue.unknownStop.value, false); assert.equal(f.queue.unknownControl.value, null);
  } finally { f.wrapper.unmount(); }
});

for (const field of ["workspaceId", "sessionId"] as const) test(`生产同形scope：真实切换${field}清理状态并隔离旧轮询、旧操作及其finally`, async () => {
  const oldPoll = deferred<AgentMessageQueueSnapshot>(), newPoll = deferred<AgentMessageQueueSnapshot>();
  const oldCancel = deferred<Awaited<ReturnType<typeof api.cancelAgentQueuedReceipt>>>();
  const newCancel = deferred<Awaited<ReturnType<typeof api.cancelAgentQueuedReceipt>>>();
  let polls = 0, cancels = 0;
  const f = productionScopeFixture({
    getAgentMessageQueue: async () => ++polls === 1 ? snapshot({ workspaceId: "browser-watch-w", sessionId: "browser-watch-s", pendingCount: 3 }) : polls === 2 ? oldPoll.promise : newPoll.promise,
    cancelAgentQueuedReceipt: async () => ++cancels === 1 ? oldCancel.promise : newCancel.promise,
  });
  try {
    await settle(); assert.equal(f.queue.snapshot.value?.pendingCount, 3);
    const stale = f.currentSnapshot({ queueVersion: 99, pendingCount: 99 });
    const oldRefresh = f.queue.refresh(); const oldAction = f.queue.cancel("old-receipt");
    await settle(); assert.equal(f.queue.busy.value, true);
    f.scope[field] = `changed-${field}`; await settle();
    assert.equal(f.queue.snapshot.value, null); assert.equal(f.queue.busy.value, false);
    assert.equal(f.queue.unknownStop.value, false); assert.equal(f.queue.unknownControl.value, null);
    const newAction = f.queue.cancel("new-receipt"); await settle(); assert.equal(f.queue.busy.value, true);
    oldPoll.resolve(stale); oldCancel.resolve({ receipt: { ...queuedItem(), status: "cancelled" }, queue: stale });
    await Promise.all([oldRefresh, oldAction]); await settle();
    assert.equal(f.queue.snapshot.value, null); assert.equal(f.queue.busy.value, true, "old finally cannot clear the new operation's busy flag");
    newPoll.resolve(f.currentSnapshot({ queueVersion: 7, pendingCount: 2 })); await settle();
    const applied = f.queue.snapshot.value as AgentMessageQueueSnapshot | null;
    assert.equal(applied?.[field], f.scope[field]); assert.equal(applied?.pendingCount, 2);
    newCancel.resolve({ receipt: { ...queuedItem(), status: "cancelled" }, queue: f.currentSnapshot({ queueVersion: 8, pendingCount: 1 }) });
    await newAction; await settle(); assert.equal((f.queue.snapshot.value as AgentMessageQueueSnapshot | null)?.pendingCount, 1); assert.equal(f.queue.busy.value, false);
  } finally { f.wrapper.unmount(); }
});

test("队列面板：pending、unknown 与 quiescent 停止状态均不产生常驻提示", async () => {
  const wrapper = panel();
  try {
    for (const state of ["pending", "unknown", "quiescent"] as const) {
      await wrapper.setProps({ snapshot: snapshot({ stop: { state, code: "runner_not_quiescent", unresolvedOperationCount: 1, unresolvedTargetCount: 1 } }) });
      assert.equal(wrapper.text(), "");
      assert.equal(wrapper.find('[data-testid="queue-stop-barrier"]').exists(), false);
    }
  } finally { wrapper.unmount(); }
});

test("清空未知结果始终重试原 targets，不误删后来消息，busy 真实互斥", async () => {
  const bodies: Array<{ workspaceId: string; receiptIds: string[] }> = [];
  const blocked = deferred<Awaited<ReturnType<typeof api.clearAgentMessageQueue>>>();
  let calls = 0;
  const receipt = accepted().receipt; assert.equal(receipt.status, "queued"); if (receipt.status !== "queued") return;
  const item = { ...receipt, textPreview: "old", attachmentCount: 0 };
  const f = fixture({ clearAgentMessageQueue: async (_id, body) => { bodies.push(body); if (++calls === 1) return blocked.promise; return { cancelledCount: 0, queue: snapshot({ queueVersion: 3, pendingCount: 1, items: [{ ...item, id: "later" }] }) }; } });
  try {
    f.queue.apply(snapshot({ queueVersion: 1, pendingCount: 1, items: [item] }));
    const first = f.queue.clear();
    await assert.rejects(f.queue.clear(), /already in progress/);
    blocked.reject(new ApiError({ message: "timeout" })); await assert.rejects(first);
    assert.equal(f.queue.unknownClear.value, true);
    f.queue.apply(snapshot({ queueVersion: 2, pendingCount: 1, items: [{ ...item, id: "later" }] }));
    await f.queue.clear();
    assert.deepEqual(bodies.map(body => body.receiptIds), [["receipt"], ["receipt"]]);
    assert.equal(f.queue.snapshot.value?.items[0]?.id, "later"); assert.equal(f.queue.unknownClear.value, false);
  } finally { f.wrapper.unmount(); }
});

test("发送保留的重试副本冻结 Stop generation，明确停止拒收保留 File 与草稿", async () => {
  const bodies: Array<FormData> = [];
  const f = fixture({ acceptAgentUserMessage: async (_id, body) => { bodies.push(body as FormData); throw new ApiError({ message: "Stop superseded send", status: 409, code: "AGENT_QUEUE_STOP_GENERATION_CHANGED" }); } });
  try {
    f.queue.apply(snapshot({ stopGeneration: "a".repeat(64) }));
    const original = submission(); original.payload.stopGeneration = "a".repeat(64); const file = new File([new Uint8Array([1])], "kept.png", { type: "image/png" });
    original.images = [{ id: "kept", filename: "kept.png", file }];
    await assert.rejects(f.queue.submit(original));
    assert.equal(f.queue.handoff.value?.phase, "rejected"); assert.equal(f.queue.handoff.value?.submission.images[0]?.file, file);
    f.queue.apply(snapshot({ queueVersion: 1, stopGeneration: "b".repeat(64) }));
    await assert.rejects(f.queue.resolveUnknown(true));
    assert.equal(bodies.length, 2);
    for (const body of bodies) assert.equal(JSON.parse(String(body.get("payload"))).stopGeneration, "a".repeat(64));
  } finally { f.wrapper.unmount(); }
});

test("submit requires action-frozen generation: a first snapshot after Stop never resumes a blocked submission", async () => {
  const loaded = deferred<AgentMessageQueueSnapshot>(); let posts = 0;
  const f = fixture({ getAgentMessageQueue: async () => loaded.promise, acceptAgentUserMessage: async (_id, body) => {
    posts++; assert.ok(!(body instanceof FormData)); assert.equal(body.stopGeneration, "b".repeat(64));
    return accepted(snapshot({ queueVersion: 3, stopGeneration: "b".repeat(64) }));
  } });
  try {
    if (f.queue.handoff.value) f.queue.acknowledgeHandoff(f.queue.handoff.value.submission);
    f.scope.active = true; await settle();
    const original = submission(); delete original.payload.stopGeneration;
    const file = new File(["retained"], "retained.png", { type: "image/png" });
    original.images = [{ id: "retained-image", filename: file.name, file }];
    await assert.rejects(f.queue.submit(original), { code: "AGENT_QUEUE_STATE_UNKNOWN" });
    assert.equal(posts, 0); assert.equal(f.queue.handoff.value, null);
    loaded.resolve(snapshot({ queueVersion: 2, stopGeneration: "b".repeat(64), mode: "paused", pauseCode: "user_stop",
      stop: { state: "quiescent", unresolvedOperationCount: 0, unresolvedTargetCount: 0, code: null } }));
    await settle(); assert.equal(posts, 0); assert.equal(original.payload.stopGeneration, undefined);
    assert.equal(original.draft, "original"); assert.equal(original.images[0]!.file, file);
    // Even an already loaded snapshot must not backfill missing action metadata.
    await assert.rejects(f.queue.submit(original), { code: "AGENT_QUEUE_STATE_UNKNOWN" }); assert.equal(posts, 0);
    const explicit = submission(); explicit.payload.stopGeneration = f.queue.snapshot.value!.stopGeneration;
    await f.queue.submit(explicit); assert.equal(posts, 1);
  } finally { f.wrapper.unmount(); }
});
