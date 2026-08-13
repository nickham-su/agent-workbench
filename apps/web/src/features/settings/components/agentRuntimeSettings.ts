export type RuntimeModelReference = {
  providerId: string;
  modelId: string;
};

export const MAX_SUBTASK_DEPTH_MIN = 1;
export const MAX_SUBTASK_DEPTH_MAX = 5;
export const DEFAULT_MAX_SUBTASK_DEPTH = 1;

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
