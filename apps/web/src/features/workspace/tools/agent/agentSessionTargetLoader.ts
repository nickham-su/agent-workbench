import type { AgentSessionRecord } from "@agent-workbench/shared";
import type { MetadataReadToken } from "./agentSessionMetadataReadContext";

export type TargetReadOutcome =
  | { status: "accepted"; record: AgentSessionRecord; token: MetadataReadToken; acceptedMutationEpoch: number }
  | { status: "protected" | "supersededRead"; token: MetadataReadToken }
  | { status: "failed"; error: unknown; classification: TargetReadFailureClassification }
  | { status: "contextInvalidated" | "cancelled" };
export type TargetReadFailureClassification = "sessionNotFound" | "workspaceNotFound" | "unauthorized" | "network" | "transportTimeout" | "serverError" | "invalidRequest" | "protocol";

type Consumer = { valid: () => boolean };
type Slot = { abort: AbortController; consumers: Set<Consumer>; result: Promise<TargetReadOutcome> };

export function classifyTargetReadError(error: unknown): TargetReadFailureClassification {
  const value = error as { code?: string; status?: number } | null;
  if (value?.status === 404 && value.code === "SESSION_NOT_FOUND") return "sessionNotFound";
  if (value?.status === 404 && value.code === "WORKSPACE_NOT_FOUND") return "workspaceNotFound";
  if (value?.code === "AGENT_METADATA_GET_TIMEOUT") return "transportTimeout";
  if (value?.status === 401) return "unauthorized";
  if (value?.status === 400) return "invalidRequest";
  if (value?.status && value.status >= 500) return "serverError";
  return "network";
}

export function isCompleteSessionRecord(record: AgentSessionRecord | null | undefined): record is AgentSessionRecord {
  if (!record || typeof record.id !== "string" || !record.id || typeof record.workspaceId !== "string" || !record.workspaceId
    || typeof record.title !== "string" || !record.title || (record.kind !== "primary" && record.kind !== "subtask")) return false;
  if (![record.createdAt, record.updatedAt, record.revision].every((value) => typeof value === "number" && Number.isFinite(value))
    || !Number.isInteger(record.revision) || record.revision < 0) return false;
  return [record.headMessageId, record.contextRootMessageId, record.forkedFromSessionId, record.forkedFromMessageId]
    .every((value) => value === null || (typeof value === "string" && value.length > 0));
}

/** One transport per workspace/target; UI subscriptions do not own shared transport state. */
export function createAgentSessionTargetLoader(options: {
  context(): { workspaceId: string; workspaceGeneration: number } | null;
  capture(sessionId: string): MetadataReadToken | null;
  request(token: MetadataReadToken, signal: AbortSignal): Promise<AgentSessionRecord>;
  accept(token: MetadataReadToken): "accepted" | "protected" | "supersededRead" | "contextInvalidated";
  commit(record: AgentSessionRecord): void;
  epoch(sessionId: string): number;
  confirmationEpoch(sessionId: string): number;
}) {
  const slots = new Map<string, Slot>();
  return {
    read(sessionId: string, consumerOptions: { valid: () => boolean; signal?: AbortSignal }): Promise<TargetReadOutcome> {
      if (!consumerOptions.valid() || consumerOptions.signal?.aborted) return Promise.resolve({ status: "cancelled" });
      const context = options.context();
      if (!context) return Promise.resolve({ status: "contextInvalidated" });
      const key = JSON.stringify([context.workspaceGeneration, context.workspaceId, sessionId]);
      let slot = slots.get(key);
      const consumer: Consumer = { valid: consumerOptions.valid };
      if (!slot) {
        const token = options.capture(sessionId);
        if (!token) return Promise.resolve({ status: "contextInvalidated" });
        const abort = new AbortController();
        const consumers = new Set<Consumer>();
        const confirmationEpoch = options.confirmationEpoch(sessionId);
        slot = { abort, consumers, result: Promise.resolve({ status: "cancelled" }) };
        const ownSlot = slot;
        slots.set(key, slot);
        slot.result = Promise.resolve().then(async (): Promise<TargetReadOutcome> => {
          if (abort.signal.aborted) return { status: "cancelled" };
          try {
            const record = await options.request(token, abort.signal);
            if (abort.signal.aborted || ![...consumers].some((item) => item.valid())) return { status: "cancelled" };
            if (!isCompleteSessionRecord(record) || record.id !== token.sessionId || record.workspaceId !== token.workspaceId) {
              return { status: "failed", classification: "protocol", error: new Error("Session metadata response does not match the request") };
            }
            const status = options.accept(token);
            if (status !== "accepted") return status === "contextInvalidated" ? { status } : { status, token };
            options.commit(record);
            return { status: "accepted", record, token, acceptedMutationEpoch: options.epoch(sessionId) };
          } catch (error) {
            if (abort.signal.aborted || ![...consumers].some((item) => item.valid())) return { status: "cancelled" };
            const classification = classifyTargetReadError(error);
            if (classification === "sessionNotFound") {
              if (options.confirmationEpoch(sessionId) !== confirmationEpoch) return { status: "protected", token };
              const status = options.accept(token);
              if (status !== "accepted") return status === "contextInvalidated" ? { status } : { status, token };
            }
            return { status: "failed", classification, error };
          } finally {
            if (slots.get(key) === ownSlot) slots.delete(key);
          }
        });
      }
      slot.consumers.add(consumer);
      const ownSlot = slot;
      return new Promise((resolve) => {
        let settled = false;
        const finish = (outcome: TargetReadOutcome) => {
          if (settled) return;
          settled = true;
          consumerOptions.signal?.removeEventListener("abort", cancel);
          ownSlot.consumers.delete(consumer);
          if (!ownSlot.consumers.size && slots.get(key) === ownSlot) {
            ownSlot.abort.abort(); // Late transport callbacks must fail the abort gate.
            if (slots.get(key) === ownSlot) slots.delete(key);
          }
          resolve(consumer.valid() ? outcome : { status: "cancelled" });
        };
        const cancel = () => finish({ status: "cancelled" });
        consumerOptions.signal?.addEventListener("abort", cancel, { once: true });
        ownSlot.result.then(finish);
      });
    },
    reset() { for (const slot of slots.values()) slot.abort.abort(); slots.clear(); },
  };
}
