import type { InjectionKey } from "vue";
import type { AgentSessionRecord } from "@agent-workbench/shared";

export type MetadataReadToken = {
  workspaceId: string;
  workspaceGeneration: number;
  sessionId: string;
  readOrder: number;
  mutationEpochAtStart: number;
};
export type TimelineMetadataEvent = { session: AgentSessionRecord; readToken: MetadataReadToken };
export type MetadataReadContext = {
  /** Fork may still populate metadata after a newer UI intent, but must not activate it. */
  captureActivationGuard?(): () => boolean;
  captureReadToken(workspaceId: string, sessionId: string): MetadataReadToken | null;
};
export const agentSessionMetadataReadContextKey: InjectionKey<MetadataReadContext> = Symbol("agentSessionMetadataReadContext");

type Context = { workspaceId: string; workspaceGeneration: number };
type Watermark = { acceptedReadOrder: number; mutationEpoch: number };

/** Local read ordering, not a database version or a cross-client consistency protocol. */
export function createAgentSessionMetadataReads(current: () => Context | null) {
  let nextOrder = 0;
  const watermarks = new Map<string, Watermark>();
  const watermark = (id: string) => {
    let value = watermarks.get(id);
    if (!value) watermarks.set(id, value = { acceptedReadOrder: 0, mutationEpoch: 0 });
    return value;
  };
  const isCurrent = (token: MetadataReadToken) => {
    const context = current();
    return !!context && context.workspaceId === token.workspaceId && context.workspaceGeneration === token.workspaceGeneration;
  };
  return {
    captureReadToken(workspaceId: string, sessionId: string): MetadataReadToken | null {
      const context = current();
      if (!context || context.workspaceId !== workspaceId) return null;
      return { ...context, sessionId, readOrder: ++nextOrder, mutationEpochAtStart: watermark(sessionId).mutationEpoch };
    },
    captureSnapshot() {
      const context = current();
      if (!context) return null;
      const readOrder = ++nextOrder;
      const epochs = new Map([...watermarks].map(([id, value]) => [id, value.mutationEpoch]));
      return (sessionId: string): MetadataReadToken => ({ ...context, sessionId, readOrder, mutationEpochAtStart: epochs.get(sessionId) ?? 0 });
    },
    accept(token: MetadataReadToken): "accepted" | "protected" | "supersededRead" | "contextInvalidated" {
      if (!isCurrent(token)) return "contextInvalidated";
      const value = watermark(token.sessionId);
      if (token.mutationEpochAtStart !== value.mutationEpoch) return "protected";
      if (token.readOrder <= value.acceptedReadOrder) return "supersededRead";
      value.acceptedReadOrder = token.readOrder;
      return "accepted";
    },
    mutation(sessionId: string) { watermark(sessionId).mutationEpoch += 1; },
    epoch(sessionId: string) { return watermark(sessionId).mutationEpoch; },
    reset() { watermarks.clear(); nextOrder = 0; },
  };
}

export function isContinuableSession(record: AgentSessionRecord) {
  const title = String(record.title || "").trim();
  return record.kind === "primary" && record.headMessageId !== null && title.length > 0 && title !== "新会话";
}

/** A harmless same-title read must not invalidate an already accepted full-record proof. */
export function sameContinuationQualification(a: AgentSessionRecord, b: AgentSessionRecord) {
  return a.kind === b.kind && a.headMessageId === b.headMessageId && a.title.trim() === b.title.trim();
}
