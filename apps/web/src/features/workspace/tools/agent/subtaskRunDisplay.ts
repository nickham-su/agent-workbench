import type { AgentContextItemRecord, AgentSubtaskRunSummary } from "@agent-workbench/shared";

export type SubtaskDisplayStatus = AgentContextItemRecord["status"];

export function formatElapsedDuration(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}min ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}min ${seconds}s`;
  }
  return `${seconds}s`;
}

export function formatSubtaskDuration(durationMs: number | null) {
  return durationMs === null ? "" : formatElapsedDuration(durationMs);
}

function localDateTimeParts(epochMs: number, timeZone?: string) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(new Date(epochMs));
    const values = new Map(parts.map((part) => [part.type, part.value]));
    const year = values.get("year");
    const month = values.get("month");
    const day = values.get("day");
    const hour = values.get("hour");
    const minute = values.get("minute");
    if (!year || !month || !day || !hour || !minute) return null;
    return { year, month, day, hour, minute };
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

export function formatSubtaskStartedAt(
  startedAt: number,
  options?: { timeZone?: string; now?: number }
) {
  if (!Number.isFinite(startedAt) || startedAt <= 0) return "";

  const started = localDateTimeParts(startedAt, options?.timeZone);
  if (!started) return "";

  const now = options?.now ?? Date.now();
  const current = Number.isFinite(now) ? localDateTimeParts(now, options?.timeZone) : null;
  const time = `${started.hour}:${started.minute}`;
  if (current && current.year === started.year && current.month === started.month && current.day === started.day) {
    return time;
  }
  return `${started.month}-${started.day} ${time}`;
}

export function resolveSubtaskDisplayStatus(
  parentStatus: AgentContextItemRecord["status"],
  subtaskRun?: AgentSubtaskRunSummary
): SubtaskDisplayStatus {
  return subtaskRun?.status ?? parentStatus;
}

export function subtaskRunForDisplay(item: AgentContextItemRecord) {
  if (item.kind !== "tool" || item.output.type !== "tool" || item.output.toolName !== "subtask") return undefined;
  return item.subtaskRun;
}

export function hasSubtaskRunChanged(
  current: AgentSubtaskRunSummary | undefined,
  latest: AgentSubtaskRunSummary | undefined
) {
  if (current === latest) return false;
  if (!current || !latest) return true;
  return current.runId !== latest.runId
    || current.status !== latest.status
    || current.startedAt !== latest.startedAt
    || current.endedAt !== latest.endedAt
    || current.durationMs !== latest.durationMs;
}

export function upsertAgentContextItem(
  items: AgentContextItemRecord[],
  next: AgentContextItemRecord
) {
  const index = items.findIndex((item) => item.id === next.id);
  if (index < 0) return [...items, next].sort((left, right) => left.id - right.id);
  const copy = [...items];
  copy[index] = next;
  return copy;
}
