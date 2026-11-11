import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox";
import {
  AgentAcceptUserMessageResponseSchema, AgentMessageQueueSnapshotSchema, AgentReceiptResponseSchema,
  AgentReceiptDetailResponseSchema, AgentStopMessageQueueResponseSchema, AgentResumeMessageQueueResponseSchema,
  AgentAbandonUnconfirmedInputResponseSchema,
  type AgentAcceptUserMessageRequest, type AgentAcceptUserMessageResponse, type AgentMessageQueueSnapshot,
  type AgentReceiptResponse, type AgentReceiptDetailResponse, type AgentStopMessageQueueRequest,
  type AgentStopMessageQueueResponse, type AgentResumeMessageQueueRequest, type AgentResumeMessageQueueResponse,
  type AgentAbandonUnconfirmedInputRequest, type AgentAbandonUnconfirmedInputResponse,
} from "@agent-workbench/shared";
import { apiClient, ApiError, toApiError } from "./api";

const sessionPath = (sessionId: string) => `/agent/sessions/${encodeURIComponent(sessionId)}`;
async function queueRequest<T>(method: "GET" | "POST", url: string, schema: TSchema, options: {
  data?: unknown; params?: Record<string, string>; signal?: AbortSignal;
} = {}): Promise<T> {
  try {
    const response = await apiClient.request({ method, url, timeout: 15_000, ...options });
    if (!Value.Check(schema, response.data)) {
      // A malformed success can follow a committed transaction. Never report
      // rejection or allocate a new request identity based on this response.
      throw new ApiError({ message: "Invalid message queue response", code: "AGENT_QUEUE_RESPONSE_UNKNOWN" });
    }
    return response.data as T;
  } catch (error) { throw toApiError(error); }
}
export function acceptAgentUserMessage(sessionId: string, body: AgentAcceptUserMessageRequest | FormData) {
  return queueRequest<AgentAcceptUserMessageResponse>("POST", `${sessionPath(sessionId)}/receipts`, AgentAcceptUserMessageResponseSchema, { data: body });
}
export function getAgentMessageQueue(sessionId: string, workspaceId: string, signal?: AbortSignal) {
  return queueRequest<AgentMessageQueueSnapshot>("GET", `${sessionPath(sessionId)}/message-queue`, AgentMessageQueueSnapshotSchema, { params: { workspaceId }, signal });
}
export function getAgentReceiptByRequest(sessionId: string, workspaceId: string, clientRequestId: string) {
  return queueRequest<AgentReceiptResponse>("GET", `${sessionPath(sessionId)}/receipts/by-request`, AgentReceiptResponseSchema, { params: { workspaceId, clientRequestId } });
}
export function getAgentReceiptDetail(sessionId: string, workspaceId: string, receiptId: string) {
  return queueRequest<AgentReceiptDetailResponse>("GET", `${sessionPath(sessionId)}/receipts/${encodeURIComponent(receiptId)}`, AgentReceiptDetailResponseSchema, { params: { workspaceId } });
}
export function cancelAgentQueuedReceipt(sessionId: string, workspaceId: string, receiptId: string) {
  return queueRequest<AgentReceiptResponse>("POST", `${sessionPath(sessionId)}/receipts/${encodeURIComponent(receiptId)}/cancel`, AgentReceiptResponseSchema, { data: { workspaceId } });
}
export function stopAgentMessageQueue(sessionId: string, body: AgentStopMessageQueueRequest) {
  return queueRequest<AgentStopMessageQueueResponse>("POST", `${sessionPath(sessionId)}/message-queue/stop`, AgentStopMessageQueueResponseSchema, { data: body });
}
export function resumeAgentMessageQueue(sessionId: string, body: AgentResumeMessageQueueRequest) {
  return queueRequest<AgentResumeMessageQueueResponse>("POST", `${sessionPath(sessionId)}/message-queue/resume`, AgentResumeMessageQueueResponseSchema, { data: body });
}
export function abandonAgentUnconfirmedInput(sessionId: string, body: AgentAbandonUnconfirmedInputRequest) {
  return queueRequest<AgentAbandonUnconfirmedInputResponse>("POST", `${sessionPath(sessionId)}/message-queue/abandon-unconfirmed`, AgentAbandonUnconfirmedInputResponseSchema, { data: body });
}

export async function getAgentReceiptAttachmentContent(sessionId: string, workspaceId: string, receiptId: string, attachmentId: string): Promise<Blob> {
  try {
    const response = await apiClient.get(`${sessionPath(sessionId)}/receipts/${encodeURIComponent(receiptId)}/attachments/${encodeURIComponent(attachmentId)}/content`, { params: { workspaceId }, responseType: "blob", timeout: 15_000 });
    return response.data as Blob;
  } catch (error) { throw toApiError(error); }
}
