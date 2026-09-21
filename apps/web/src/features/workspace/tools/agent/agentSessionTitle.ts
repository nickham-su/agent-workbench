/**
 * Session 标题手动设置的纯函数集合。
 *
 * 约定：
 * - 规范化 = 压缩连续空白后 trim（与后端领域规则一致）；
 * - 校验与计数均按规范化后的 JavaScript `string.length`（UTF-16 code unit）；
 * - 原始输入另有防御上限，防止异常大请求；既有历史超长标题完整回填，绝不静默截断。
 */

export const MANUAL_TITLE_RAW_MAX_LENGTH = 1000;
export const MANUAL_TITLE_MAX_LENGTH = 50;

export type ManualTitleValidationError = "raw_too_long" | "empty" | "too_long" | "invalid_characters";

export type ManualTitleValidationResult =
  | { ok: true; title: string; length: number }
  | { ok: false; error: ManualTitleValidationError };

function compactTitleText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

// 注意：空白压缩的权威实现只有 compactTitleText（内部函数），
// 校验统一走 validateManualTitleInput，避免导出副本与权威路径漂移。

/** 手动标题完整校验。rawLength 指原始输入长度，length 指规范化后长度。 */
export function validateManualTitleInput(raw: string): ManualTitleValidationResult {
  if (raw.length > MANUAL_TITLE_RAW_MAX_LENGTH) {
    return { ok: false, error: "raw_too_long" };
  }
  const title = compactTitleText(raw);
  if (!title) return { ok: false, error: "empty" };
  if (title.length > MANUAL_TITLE_MAX_LENGTH) return { ok: false, error: "too_long" };
  if (/[\u0000-\u001f\u007f-\u009f]/.test(title)) return { ok: false, error: "invalid_characters" };
  return { ok: true, title, length: title.length };
}

/** API 错误 code 到字段错误的映射，未识别返回 null（调用方走通用错误提示）。 */
export function titleErrorCodeToFieldError(code: unknown): ManualTitleValidationError | null {
  if (code === "AGENT_SESSION_TITLE_EMPTY") return "empty";
  if (code === "AGENT_SESSION_TITLE_TOO_LONG") return "too_long";
  if (code === "AGENT_SESSION_TITLE_INVALID_CHARACTERS") return "invalid_characters";
  return null;
}

export type StaleMergeContext = {
  requestRevision: number;
  mutationRevisionBySession: ReadonlyMap<string, number>;
  mutationRecordBySession: ReadonlyMap<string, unknown>;
};

export type StaleMergeResult<T> = {
  /** 合并后的列表（顺序与远端一致）。 */
  merged: T[];
  /** 触发完整 record 保护并存在于远端的 Session ID。 */
  protectedSessionIds: string[];
};

/**
 * 陈旧列表响应合并。
 *
 * 规则：
 * - 若某 Session 的成功 mutation revision 大于本次请求开始时的 revision：
 *   - 远端列表仍包含该 Session -> 完整保留 mutation 缓存 record，不采用旧列表中的任何字段；
 *   - 远端不包含 -> 不复活；
 * - 其余 Session 完整采用远端 record。
 *
 * idOf 用于从 record 读取 Session ID；mutation record 缓存按调用方维护。
 */
export function mergeStaleProtectedSessionList<T>(
  remoteList: T[],
  context: StaleMergeContext,
  idOf: (record: T) => string
): StaleMergeResult<T> {
  const merged: T[] = [];
  const protectedSessionIds: string[] = [];
  for (const remote of remoteList) {
    const id = idOf(remote);
    const mutationRevision = context.mutationRevisionBySession.get(id);
    if (
      typeof mutationRevision === "number" &&
      mutationRevision > context.requestRevision &&
      context.mutationRecordBySession.has(id)
    ) {
      merged.push(context.mutationRecordBySession.get(id) as T);
      protectedSessionIds.push(id);
      continue;
    }
    merged.push(remote);
  }
  return { merged, protectedSessionIds };
}

/**
 * 将 Timeline 响应中的权威标题合并到 Session 列表。
 *
 * Timeline 与手动标题保存可能并发；存在 mutation 保护记录时，必须继续使用
 * 手动保存成功的标题，避免迟到的 Timeline 响应把它覆盖回旧值。
 */
export function mergeTimelineSessionTitle<T extends { id: string; title: string }>(
  records: T[],
  timelineSession: { id: string; title: string },
  protectedRecord?: { title: string } | null,
): T[] {
  const title = protectedRecord?.title ?? timelineSession.title;
  const index = records.findIndex((record) => record.id === timelineSession.id);
  if (index < 0 || records[index]?.title === title) return records;
  const next = [...records];
  next[index] = { ...records[index]!, title };
  return next;
}

/** 请求标识：generation 与 workspaceId 任一变化即视为过期。 */
export type RequestValidity = {
  disposed: boolean;
  currentGeneration: number;
  requestGeneration: number;
  currentWorkspaceId: string;
  requestWorkspaceId: string;
};

/** 在途请求是否仍可向组件写入状态。 */
export function isRequestResponseWritable(validity: RequestValidity): boolean {
  if (validity.disposed) return false;
  if (validity.requestGeneration !== validity.currentGeneration) return false;
  if (validity.requestWorkspaceId !== validity.currentWorkspaceId) return false;
  return true;
}

/** 标题保存 token：捕获发起保存时的编辑上下文，响应用它判断“是否仍属于当前弹窗”。 */
export type TitleSaveToken = {
  generation: number;
  workspaceId: string;
  sessionId: string;
  requestId: number;
  /** 打开弹窗时捕获的编辑上下文版本：重新打开弹窗/强制重置后递增，旧请求响应据此失效。 */
  epoch: number;
};

/**
 * 判定组件是否可关闭标题弹窗。
 *
 * 保存中（titleSaving）时任何用户关闭途径（cancel 按钮、右上角 X、遮罩点击、Esc）都必须被拒绝，
 * 否则“确认中”状态的请求会被静默丢弃。Workspace 强制重置（forceReset）不受此限制。
 */
export function shouldAllowTitleModalClose(input: { saving: boolean; forceReset: boolean }): boolean {
  if (input.forceReset) return true;
  return !input.saving;
}

export type TitleSaveResponseAction =
  | "apply-close"
  | "apply-keep-open"
  | "ignore";

/**
 * 归一化“在途标题保存响应”的处置动作（成功/失败/旧 finally 三路径共用）。
 *
 * 规则（任一不满足即 "ignore"，不得写 Session、mutation 缓存或弹窗状态）：
 * - responseWritable：请求上下文仍有效（未卸载、generation/workspace 未变）；
 * - activeToken === requestToken：该请求仍是当前活动保存（防旧请求响应串台）；
 * - requestToken.epoch === currentEditingEpoch：编辑上下文未被重置/重新打开；
 * - requestToken.sessionId === editingSessionId：响应对应的 Session 仍是当前正在编辑的 Session。
 *
 * 满足条件时：成功响应 "apply-close"（关闭弹窗）；失败响应 "apply-keep-open"（保留弹窗展示错误）。
 */
export function resolveTitleSaveResponseAction(input: {
  /** 本请求发起时捕获的 token。 */
  requestToken: TitleSaveToken;
  /** 响应到达时组件的当前活动保存 token。 */
  activeToken: TitleSaveToken | null;
  /** 响应到达时组件的当前编辑上下文版本。 */
  currentEditingEpoch: number;
  editingSessionId: string;
  responseWritable: boolean;
  succeeded: boolean;
}): TitleSaveResponseAction {
  if (!input.responseWritable) return "ignore";
  if (input.activeToken !== input.requestToken) return "ignore";
  if (input.requestToken.epoch !== input.currentEditingEpoch) return "ignore";
  if (!input.editingSessionId || input.editingSessionId !== input.requestToken.sessionId) return "ignore";
  return input.succeeded ? "apply-close" : "apply-keep-open";
}

/**
 * 旧保存请求的 finally 是否允许清理 saving 状态：
 * 仅当该请求仍是当前活动保存（token 引用一致）时才允许。
 */
export function shouldReleaseTitleSavingByToken(input: {
  activeToken: TitleSaveToken | null;
  requestToken: TitleSaveToken;
}): boolean {
  return input.activeToken === input.requestToken;
}

/**
 * Pane 标题栏“设置会话标题”入口的守卫：
 * - 仅真实 Session（非 draft，调用方以 sessionReady 表达）可触发；
 * - 返回 null 表示忽略本次点击。
 * 触发目标由调用方上下文决定，因此返回 "emit" 而非携带 Session ID。
 */
export function resolveTitleSettingTrigger(sessionReady: boolean): "emit" | null {
  return sessionReady ? "emit" : null;
}
