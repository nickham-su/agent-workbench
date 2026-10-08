export const MODEL_RETRY_BACKOFF_BASE_MS = 2_000;
const MODEL_RETRY_BACKOFF_DEFAULT_MAX_MS = 60_000;
const MODEL_RETRY_BACKOFF_MAX_ALLOWED_MS = 3_600_000;
const MODEL_REQUEST_MAX_RETRIES_DEFAULT = 5;
const MODEL_REQUEST_MAX_RETRIES_MAX = 100;

export function normalizeRetryBackoffMaxMs(raw: unknown) {
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    return MODEL_RETRY_BACKOFF_DEFAULT_MAX_MS;
  }
  return Math.min(MODEL_RETRY_BACKOFF_MAX_ALLOWED_MS, Math.max(MODEL_RETRY_BACKOFF_BASE_MS, raw));
}

export function normalizeModelRequestMaxRetries(raw: unknown) {
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    return MODEL_REQUEST_MAX_RETRIES_DEFAULT;
  }
  return Math.min(MODEL_REQUEST_MAX_RETRIES_MAX, Math.max(0, raw));
}

export function computeRetryBackoffMs(attemptIndex: number, rawMaxBackoffMs: unknown = MODEL_RETRY_BACKOFF_DEFAULT_MAX_MS) {
  if (!Number.isFinite(attemptIndex) || attemptIndex < 0) return MODEL_RETRY_BACKOFF_BASE_MS;
  const factor = 2 ** Math.floor(attemptIndex);
  const delay = MODEL_RETRY_BACKOFF_BASE_MS * factor;
  return Math.min(normalizeRetryBackoffMaxMs(rawMaxBackoffMs), Math.max(MODEL_RETRY_BACKOFF_BASE_MS, delay));
}
