/**
 * 权威 Session 标题领域规则。
 *
 * 三类标题来源共用空白压缩实现，但保留各自的业务语义：
 *
 * - 首消息空白回退“新会话”、超长截断；
 * - `todolist.goal` 空白不更新、超长截断；
 * - 手动标题空白/超长/含禁止控制字符时返回校验错误，不静默修正。
 */

const AUTO_TITLE_MAX_LENGTH = 50;
const MANUAL_TITLE_MAX_LENGTH = 50;

function compactTitleText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function truncateAutoTitle(value: string) {
  if (value.length <= AUTO_TITLE_MAX_LENGTH) return value;
  return `${value.slice(0, AUTO_TITLE_MAX_LENGTH - 1)}…`;
}

export function toAutomaticSessionTitle(value: string, emptyFallback: string): string {
  const compact = compactTitleText(value);
  if (!compact) return emptyFallback;
  return truncateAutoTitle(compact);
}

export type ManualSessionTitleResult =
  | { ok: true; title: string }
  | { ok: false; reason: "empty" | "too_long" | "invalid_characters" };

function normalizeNamedText(value: string, maxLength: number): ManualSessionTitleResult {
  const compact = compactTitleText(value);
  if (!compact) return { ok: false, reason: "empty" };
  if ([...compact].length > maxLength) return { ok: false, reason: "too_long" };
  if (/[\u0000-\u001f\u007f-\u009f]/.test(compact)) return { ok: false, reason: "invalid_characters" };
  return { ok: true, title: compact };
}

export function normalizeManualSessionTitle(value: string): ManualSessionTitleResult {
  return normalizeNamedText(value, MANUAL_TITLE_MAX_LENGTH);
}

export function normalizeScheduledTaskName(value: string): ManualSessionTitleResult {
  return normalizeNamedText(value, 100);
}

/** The snapshot keeps the full name; only the Session's human-readable title is shortened. */
export function buildScheduledExecutionSessionTitle(taskName: string): string {
  const suffix = " · 定时任务";
  const title = [...taskName].slice(0, MANUAL_TITLE_MAX_LENGTH - [...suffix].length).join("") + suffix;
  const normalized = normalizeManualSessionTitle(title);
  if (!normalized.ok) throw new Error("Invalid scheduled execution session title");
  return normalized.title;
}
