import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox";
import {
  DashboardQueryErrorResponseSchema,
  DashboardQueryRequestSchema,
  DashboardQuerySuccessResponseSchema,
  type DashboardQueryErrorResponse,
  type DashboardQueryRequest,
  type DashboardQuerySuccessResponse
} from "@agent-workbench/shared";
import {
  AnalyticsSignalResultSchema,
  AnalyticsSignalSchema,
  type AnalyticsSignal,
  type AnalyticsSignalResult,
  isCanonicalAnalyticsSignal
} from "@agent-workbench/shared";

function StrictObject(properties: Record<string, TSchema>) {
  return Type.Object(properties, { additionalProperties: false });
}

const RequestIdSchema = Type.String({ minLength: 1, maxLength: 128 });
const TrustedOutboxCorruptMessageSchema = StrictObject({ type: Type.Literal("outbox_corrupt"), requestId: RequestIdSchema, producerNamespace: Type.Literal("agent_worker"), producerId: Type.Literal("agent_runner"), producerGeneration: Type.String({ minLength: 1, maxLength: 160 }), recordedAt: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }) });
const TrustedLocalFallbackAbandonMessageSchema = StrictObject({ type: Type.Literal("local_fallback_abandon"), requestId: RequestIdSchema, producerNamespace: Type.Literal("api_local_fallback"), producerId: Type.Literal("api_local_fallback"), producerGeneration: Type.String({ minLength: 1, maxLength: 160 }), recordedAt: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }) });

/**
 * Analytics dataDir is a child startup environment setting, not an IPC field.
 * Runtime messages are intentionally DTO-only and never carry paths, errors,
 * stack traces, SQL, secrets, or arbitrary payloads.
 */
export const AnalyticsInitializeMessageSchema = StrictObject({ type: Type.Literal("initialize"), requestId: RequestIdSchema });
export const AnalyticsDashboardQueryMessageSchema = StrictObject({ type: Type.Literal("dashboard_query"), requestId: RequestIdSchema, request: DashboardQueryRequestSchema });
export const AnalyticsSignalMessageSchema = StrictObject({ type: Type.Literal("signal"), requestId: RequestIdSchema, signal: AnalyticsSignalSchema });
export const AnalyticsShutdownMessageSchema = StrictObject({ type: Type.Literal("shutdown"), requestId: RequestIdSchema });
export const AnalyticsParentMessageSchema = Type.Union([
  AnalyticsInitializeMessageSchema,
  AnalyticsDashboardQueryMessageSchema,
  AnalyticsSignalMessageSchema,
  TrustedOutboxCorruptMessageSchema,
  TrustedLocalFallbackAbandonMessageSchema,
  AnalyticsShutdownMessageSchema
]);
export type AnalyticsParentMessage =
  | { type: "initialize"; requestId: string }
  | { type: "dashboard_query"; requestId: string; request: DashboardQueryRequest }
  | { type: "signal"; requestId: string; signal: AnalyticsSignal }
  | { type: "outbox_corrupt"; requestId: string; producerNamespace: "agent_worker"; producerId: "agent_runner"; producerGeneration: string; recordedAt: number }
  | { type: "local_fallback_abandon"; requestId: string; producerNamespace: "api_local_fallback"; producerId: "api_local_fallback"; producerGeneration: string; recordedAt: number }
  | { type: "shutdown"; requestId: string };

export const AnalyticsReadyMessageSchema = StrictObject({ type: Type.Literal("ready"), requestId: RequestIdSchema });
export const AnalyticsInitializationFailedMessageSchema = StrictObject({ type: Type.Literal("initialization_failed"), requestId: RequestIdSchema });
export const AnalyticsDashboardResultMessageSchema = StrictObject({
  type: Type.Literal("dashboard_result"),
  requestId: RequestIdSchema,
  response: Type.Union([DashboardQuerySuccessResponseSchema, DashboardQueryErrorResponseSchema])
});
export const AnalyticsSignalResultMessageSchema = StrictObject({ type: Type.Literal("signal_result"), requestId: RequestIdSchema, result: AnalyticsSignalResultSchema });
export const AnalyticsShutdownCompleteMessageSchema = StrictObject({ type: Type.Literal("shutdown_complete"), requestId: RequestIdSchema });
export const AnalyticsChildMessageSchema = Type.Union([
  AnalyticsReadyMessageSchema,
  AnalyticsInitializationFailedMessageSchema,
  AnalyticsDashboardResultMessageSchema,
  AnalyticsSignalResultMessageSchema,
  AnalyticsShutdownCompleteMessageSchema
]);
export type AnalyticsChildMessage =
  | { type: "ready"; requestId: string }
  | { type: "initialization_failed"; requestId: string }
  | { type: "dashboard_result"; requestId: string; response: DashboardQuerySuccessResponse | DashboardQueryErrorResponse }
  | { type: "signal_result"; requestId: string; result: AnalyticsSignalResult }
  | { type: "shutdown_complete"; requestId: string };

export function isAnalyticsParentMessage(value: unknown): value is AnalyticsParentMessage {
  if (!Value.Check(AnalyticsParentMessageSchema, value)) return false;
  return !(value as { type?: string }).type || (value as { type?: string }).type !== "signal"
    || isCanonicalAnalyticsSignal((value as { signal: unknown }).signal);
}

export function isAnalyticsChildMessage(value: unknown): value is AnalyticsChildMessage {
  return Value.Check(AnalyticsChildMessageSchema, value);
}
