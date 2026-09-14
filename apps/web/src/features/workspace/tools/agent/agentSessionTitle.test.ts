import assert from "node:assert/strict";
import test from "node:test";
import {
  isRequestResponseWritable,
  MANUAL_TITLE_RAW_MAX_LENGTH,
  mergeStaleProtectedSessionList,
  resolveTitleSaveResponseAction,
  resolveTitleSettingTrigger,
  shouldAllowTitleModalClose,
  shouldReleaseTitleSavingByToken,
  titleErrorCodeToFieldError,
  validateManualTitleInput,
  type TitleSaveToken
} from "./agentSessionTitle";

test("validateManualTitleInput 接受 1 与 50 个规范化字符", () => {
  const one = validateManualTitleInput("修复登录");
  assert.equal(one.ok, true);
  if (one.ok) {
    assert.equal(one.title, "修复登录");
    assert.equal(one.length, 4);
  }
  const fifty = validateManualTitleInput("a".repeat(50));
  assert.equal(fifty.ok, true);
  if (fifty.ok) assert.equal(fifty.length, 50);
});

test("validateManualTitleInput 压缩连续空白并 trim（规范化行为的权威入口）", () => {
  const result = validateManualTitleInput("  修复   登录\n问题\t ");
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.title, "修复 登录 问题");
  const ideographic = validateManualTitleInput("a　　b");
  assert.equal(ideographic.ok, true);
  if (ideographic.ok) assert.equal(ideographic.title, "a b");
  // 纯空白走 empty 错误，而不是静默产出空标题
  assert.deepEqual(validateManualTitleInput("   \n\t  "), { ok: false, error: "empty" });
});

test("validateManualTitleInput 拒绝空与纯空白", () => {
  assert.deepEqual(validateManualTitleInput(""), { ok: false, error: "empty" });
});

test("validateManualTitleInput 按规范化后长度判断超长", () => {
  assert.deepEqual(validateManualTitleInput("a".repeat(51)), { ok: false, error: "too_long" });
  // 原始超 50 但规范化后不超过 50：压缩空白后合法
  const spaced = `修复${" ".repeat(80)}登录`;
  assert.ok(spaced.length > 50);
  const result = validateManualTitleInput(spaced);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.title, "修复 登录");
});

test("validateManualTitleInput 拒绝原始长度超过防御上限", () => {
  const long = "a".repeat(MANUAL_TITLE_RAW_MAX_LENGTH + 1);
  assert.deepEqual(validateManualTitleInput(long), { ok: false, error: "raw_too_long" });
  // 恰好 1000 进入业务校验
  assert.deepEqual(validateManualTitleInput("a".repeat(MANUAL_TITLE_RAW_MAX_LENGTH)), {
    ok: false,
    error: "too_long"
  });
});

test("validateManualTitleInput 按 JavaScript string.length 计数（代理对）", () => {
  // 25 个 Emoji：JS length = 50，恰好合法
  const emoji25 = "😀".repeat(25);
  const ok = validateManualTitleInput(emoji25);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.length, 50);
  // 26 个 Emoji：JS length = 52，按 JS length 判定超长
  assert.deepEqual(validateManualTitleInput("😀".repeat(26)), { ok: false, error: "too_long" });
});

test("validateManualTitleInput 拒绝 C0/C1 控制字符", () => {
  assert.deepEqual(validateManualTitleInput("ab\u0007cd"), { ok: false, error: "invalid_characters" });
  // C1 控制字符（U+009F）同样被拒绝
  assert.deepEqual(validateManualTitleInput("ab\u009fcd"), { ok: false, error: "invalid_characters" });
  // 制表符与换行属于 \s，会在规范化阶段被压缩为空格，不视为非法字符
  const withTab = validateManualTitleInput("a\tb");
  assert.equal(withTab.ok, true);
  if (withTab.ok) assert.equal(withTab.title, "a b");
});

test("titleErrorCodeToFieldError 只映射三个固定 code", () => {
  assert.equal(titleErrorCodeToFieldError("AGENT_SESSION_TITLE_EMPTY"), "empty");
  assert.equal(titleErrorCodeToFieldError("AGENT_SESSION_TITLE_TOO_LONG"), "too_long");
  assert.equal(titleErrorCodeToFieldError("AGENT_SESSION_TITLE_INVALID_CHARACTERS"), "invalid_characters");
  assert.equal(titleErrorCodeToFieldError("AGENT_REQUEST_UNKNOWN_FIELD"), null);
  assert.equal(titleErrorCodeToFieldError(undefined), null);
});

type FakeSession = { id: string; title: string; headItemId: number; updatedAt: number };

function session(id: string, title: string, headItemId: number, updatedAt: number): FakeSession {
  return { id, title, headItemId, updatedAt };
}

test("mergeStaleProtectedSessionList 命中 mutation 时完整保留本地 record", () => {
  const remote = [
    session("s1", "旧标题", 10, 100),
    session("s2", "其他", 1, 50)
  ];
  const apiRecord = session("s1", "手动标题", 12, 120);
  const context = {
    requestRevision: 5,
    mutationRevisionBySession: new Map([["s1", 6]]),
    mutationRecordBySession: new Map([["s1", apiRecord]])
  };
  const result = mergeStaleProtectedSessionList(remote, context, (item) => item.id);
  assert.deepEqual(result.protectedSessionIds, ["s1"]);
  // 完整保留 mutation record，不回退任何字段
  assert.deepEqual(result.merged[0], { id: "s1", title: "手动标题", headItemId: 12, updatedAt: 120 });
  assert.deepEqual(result.merged[1], { id: "s2", title: "其他", headItemId: 1, updatedAt: 50 });
});

test("mergeStaleProtectedSessionList 远端缺失时不复活", () => {
  const remote = [session("s2", "其他", 1, 50)];
  const context = {
    requestRevision: 5,
    mutationRevisionBySession: new Map([["s1", 6]]),
    mutationRecordBySession: new Map([["s1", session("s1", "手动", 12, 120)]])
  };
  const result = mergeStaleProtectedSessionList(remote, context, (item) => item.id);
  assert.deepEqual(result.protectedSessionIds, []);
  assert.equal(result.merged.length, 1);
  assert.equal(result.merged[0].id, "s2");
});

test("mergeStaleProtectedSessionList 无命中时完整采用远端", () => {
  const remote = [session("s1", "服务端", 11, 110)];
  const context = {
    requestRevision: 5,
    mutationRevisionBySession: new Map([["s1", 5]]),
    mutationRecordBySession: new Map([["s1", session("s1", "本地", 12, 120)]])
  };
  const result = mergeStaleProtectedSessionList(remote, context, (item) => item.id);
  assert.deepEqual(result.protectedSessionIds, []);
  assert.equal(result.merged[0].title, "服务端");
});

test("mergeStaleProtectedSessionList 无缓存 record 时不保护", () => {
  const remote = [session("s1", "服务端", 11, 110)];
  const context = {
    requestRevision: 5,
    mutationRevisionBySession: new Map([["s1", 6]]),
    mutationRecordBySession: new Map<string, unknown>()
  };
  const result = mergeStaleProtectedSessionList(remote, context, (item) => item.id);
  assert.equal(result.merged[0].title, "服务端");
});

test("isRequestResponseWritable 校验 disposed/generation/workspace", () => {
  const base = {
    disposed: false,
    currentGeneration: 2,
    requestGeneration: 2,
    currentWorkspaceId: "ws-a",
    requestWorkspaceId: "ws-a"
  };
  assert.equal(isRequestResponseWritable(base), true);
  assert.equal(isRequestResponseWritable({ ...base, disposed: true }), false);
  assert.equal(isRequestResponseWritable({ ...base, requestGeneration: 1 }), false);
  assert.equal(isRequestResponseWritable({ ...base, requestWorkspaceId: "ws-b" }), false);
});

function makeToken(overrides: Partial<TitleSaveToken> = {}): TitleSaveToken {
  return {
    generation: 1,
    workspaceId: "ws-a",
    sessionId: "sess-1",
    requestId: 1,
    epoch: 1,
    ...overrides
  };
}

test("shouldAllowTitleModalClose 保存中禁止一切用户关闭，强制重置不受限", () => {
  assert.equal(shouldAllowTitleModalClose({ saving: false, forceReset: false }), true);
  assert.equal(shouldAllowTitleModalClose({ saving: true, forceReset: false }), false);
  assert.equal(shouldAllowTitleModalClose({ saving: true, forceReset: true }), true);
});

test("resolveTitleSaveResponseAction 当前活动保存的成功/失败响应正常处置", () => {
  const token = makeToken();
  const base = {
    requestToken: token,
    activeToken: token,
    currentEditingEpoch: 1,
    editingSessionId: "sess-1",
    responseWritable: true
  };
  assert.equal(resolveTitleSaveResponseAction({ ...base, succeeded: true }), "apply-close");
  assert.equal(resolveTitleSaveResponseAction({ ...base, succeeded: false }), "apply-keep-open");
});

test("resolveTitleSaveResponseAction 旧请求 token vs 新 active token：响应不得串台", () => {
  const oldToken = makeToken({ requestId: 1 });
  const newToken = makeToken({ requestId: 2 });
  // 旧请求 A 的响应到达时，活动保存已是新请求 B：A 的成功响应不得用 B 的 token 判定
  assert.equal(
    resolveTitleSaveResponseAction({
      requestToken: oldToken,
      activeToken: newToken,
      currentEditingEpoch: 1,
      editingSessionId: "sess-1",
      responseWritable: true,
      succeeded: true
    }),
    "ignore"
  );
  assert.equal(
    resolveTitleSaveResponseAction({
      requestToken: oldToken,
      activeToken: newToken,
      currentEditingEpoch: 1,
      editingSessionId: "sess-1",
      responseWritable: true,
      succeeded: false
    }),
    "ignore"
  );
});

test("resolveTitleSaveResponseAction 同 Session 重新打开弹窗（新 epoch）后旧响应失效", () => {
  const oldToken = makeToken({ epoch: 1 });
  const newToken = makeToken({ epoch: 2, requestId: 2 });
  // 用户在旧请求在途时关闭并重新打开同一 Session 的弹窗：epoch 递增，
  // 旧请求响应不得关闭/改动新弹窗
  assert.equal(
    resolveTitleSaveResponseAction({
      requestToken: oldToken,
      activeToken: newToken,
      currentEditingEpoch: 2,
      editingSessionId: "sess-1",
      responseWritable: true,
      succeeded: true
    }),
    "ignore"
  );
  // activeToken 仍是旧 token 但 epoch 已推进（关闭后未再保存）：同样失效
  assert.equal(
    resolveTitleSaveResponseAction({
      requestToken: oldToken,
      activeToken: oldToken,
      currentEditingEpoch: 2,
      editingSessionId: "sess-1",
      responseWritable: true,
      succeeded: true
    }),
    "ignore"
  );
});

test("resolveTitleSaveResponseAction 不同 Session 的新编辑上下文拒绝旧 Session 响应", () => {
  const oldToken = makeToken({ sessionId: "sess-1", epoch: 1 });
  const newToken = makeToken({ sessionId: "sess-2", epoch: 2, requestId: 2 });
  // 旧 sess-1 的响应：当前编辑目标已是 sess-2，requestToken.sessionId !== editingSessionId
  assert.equal(
    resolveTitleSaveResponseAction({
      requestToken: oldToken,
      activeToken: newToken,
      currentEditingEpoch: 2,
      editingSessionId: "sess-2",
      responseWritable: true,
      succeeded: true
    }),
    "ignore"
  );
  // 弹窗已关闭、无编辑目标：同样忽略
  assert.equal(
    resolveTitleSaveResponseAction({
      requestToken: oldToken,
      activeToken: null,
      currentEditingEpoch: 2,
      editingSessionId: "",
      responseWritable: true,
      succeeded: true
    }),
    "ignore"
  );
});

test("resolveTitleSaveResponseAction Workspace 切换 generation 失效后不写状态", () => {
  const token = makeToken();
  // Workspace 切换导致 generation 变化：isRequestResponseWritable 返回 false
  assert.equal(
    resolveTitleSaveResponseAction({
      requestToken: token,
      activeToken: token,
      currentEditingEpoch: 1,
      editingSessionId: "sess-1",
      responseWritable: false,
      succeeded: true
    }),
    "ignore"
  );
  assert.equal(
    resolveTitleSaveResponseAction({
      requestToken: token,
      activeToken: token,
      currentEditingEpoch: 1,
      editingSessionId: "sess-1",
      responseWritable: false,
      succeeded: false
    }),
    "ignore"
  );
});

test("resolveTitleSaveResponseAction 组件卸载（disposed）后不写状态", () => {
  const token = makeToken();
  // 组件卸载同样使 isRequestResponseWritable 返回 false
  assert.equal(
    resolveTitleSaveResponseAction({
      requestToken: token,
      activeToken: token,
      currentEditingEpoch: 1,
      editingSessionId: "sess-1",
      responseWritable: false,
      succeeded: true
    }),
    "ignore"
  );
});

test("shouldReleaseTitleSavingByToken 旧请求的 finally 不得清理新请求的 saving", () => {
  const oldToken = makeToken({ requestId: 1 });
  const newToken = makeToken({ requestId: 2 });
  // 旧请求 finally：当前活动保存已换成新 token -> 不清理
  assert.equal(
    shouldReleaseTitleSavingByToken({ activeToken: newToken, requestToken: oldToken }),
    false
  );
  // 新请求 finally：仍是当前活动保存 -> 清理
  assert.equal(
    shouldReleaseTitleSavingByToken({ activeToken: newToken, requestToken: newToken }),
    true
  );
  // Workspace 切换/卸载后 activeTitleSave 已清空 -> 不清理
  assert.equal(
    shouldReleaseTitleSavingByToken({ activeToken: null, requestToken: oldToken }),
    false
  );
});

test("resolveTitleSettingTrigger 仅在真实 Session 时允许触发弹窗", () => {
  assert.equal(resolveTitleSettingTrigger(true), "emit");
  assert.equal(resolveTitleSettingTrigger(false), null);
});
