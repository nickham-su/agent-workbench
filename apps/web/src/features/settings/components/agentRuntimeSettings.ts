import type { AgentRuntimeSettings, UpdateAgentRuntimeSettingsRequest } from "@agent-workbench/shared";

export type RuntimeModelReference = {
  providerId: string;
  modelId: string;
};

export const MAX_SUBTASK_DEPTH_MIN = 1;
export const MAX_SUBTASK_DEPTH_MAX = 5;
export const DEFAULT_MAX_SUBTASK_DEPTH = 1;

export const MODEL_REQUEST_RETRY_BACKOFF_MAX_SECONDS_MIN = 2;
export const MODEL_REQUEST_RETRY_BACKOFF_MAX_SECONDS_MAX = 3600;
export const DEFAULT_MODEL_REQUEST_RETRY_BACKOFF_MAX_SECONDS = 60;

export type RuntimeSettingsRetryBackoffFormState = {
  modelRequestRetryBackoffMaxSeconds: number;
};

/**
 * Keeps the settings form value valid before it is sent to the API. The API
 * remains authoritative and rejects invalid raw requests.
 */
export function normalizeMaxSubtaskDepth(value: unknown): number {
  const numeric = Math.floor(Number(value));
  if (!Number.isFinite(numeric)) return DEFAULT_MAX_SUBTASK_DEPTH;
  return Math.min(MAX_SUBTASK_DEPTH_MAX, Math.max(MAX_SUBTASK_DEPTH_MIN, numeric));
}

export function toRuntimeSettingsMaxSubtaskDepthPayload(value: unknown): number {
  return normalizeMaxSubtaskDepth(value);
}

export function normalizeModelRequestRetryBackoffMaxSeconds(value: unknown): number {
  const numeric = Math.floor(Number(value));
  if (!Number.isFinite(numeric)) return DEFAULT_MODEL_REQUEST_RETRY_BACKOFF_MAX_SECONDS;
  return Math.min(
    MODEL_REQUEST_RETRY_BACKOFF_MAX_SECONDS_MAX,
    Math.max(MODEL_REQUEST_RETRY_BACKOFF_MAX_SECONDS_MIN, numeric)
  );
}

export function modelRequestRetryBackoffMaxSecondsFromMs(value: unknown): number {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds)) return DEFAULT_MODEL_REQUEST_RETRY_BACKOFF_MAX_SECONDS;
  return normalizeModelRequestRetryBackoffMaxSeconds(Math.round(milliseconds / 1000));
}

export function toRuntimeSettingsModelRequestRetryBackoffMaxMsPayload(value: unknown): number {
  return normalizeModelRequestRetryBackoffMaxSeconds(value) * 1000;
}

export function mapRuntimeSettingsRetryBackoffToFormState(
  settings: Pick<AgentRuntimeSettings, "modelRequestRetryBackoffMaxMs">
): RuntimeSettingsRetryBackoffFormState {
  return {
    modelRequestRetryBackoffMaxSeconds: modelRequestRetryBackoffMaxSecondsFromMs(settings.modelRequestRetryBackoffMaxMs)
  };
}

export function toRuntimeSettingsRetryBackoffUpdatePayload(
  formState: RuntimeSettingsRetryBackoffFormState
): Pick<UpdateAgentRuntimeSettingsRequest, "modelRequestRetryBackoffMaxMs"> {
  return {
    modelRequestRetryBackoffMaxMs: toRuntimeSettingsModelRequestRetryBackoffMaxMsPayload(formState.modelRequestRetryBackoffMaxSeconds)
  };
}

export function modelPathFromReference(reference: RuntimeModelReference | null | undefined): string[] {
  return reference ? [reference.providerId, reference.modelId] : [];
}

export function modelReferenceFromPath(
  path: string[],
  hasModel: (providerId: string, modelId: string) => boolean
): RuntimeModelReference | null | undefined {
  if (!Array.isArray(path) || path.length === 0) return null;
  const [providerId, modelId] = path;
  if (!providerId || !modelId) return undefined;
  if (!hasModel(providerId, modelId)) return undefined;
  return { providerId, modelId };
}
