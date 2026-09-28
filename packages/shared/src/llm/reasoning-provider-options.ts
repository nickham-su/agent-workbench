import type { JSONValue } from "ai";

/** Fixed protocol fields are never supplied by model settings. */
export const RESERVED_REASONING_PROVIDER_OPTION_KEYS = new Set([
  "thinking", "reasoninghistory", "reasoningeffort",
]);

const unsafeKeys = new Set(["__proto__", "prototype", "constructor"]);

export function canonicalTopLevelProviderOptionKey(key: string): string {
  return key.trim().replace(/[_-]/g, "").toLowerCase();
}

export function isReasoningProviderNpm(npm: string): npm is "@ai-sdk/moonshotai" | "@ai-sdk/deepseek" {
  return npm === "@ai-sdk/moonshotai" || npm === "@ai-sdk/deepseek";
}

function sanitizeJson(value: unknown): JSONValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const items: JSONValue[] = [];
    for (const entry of value) {
      const sanitized = sanitizeJson(entry);
      if (sanitized === undefined) return undefined;
      items.push(sanitized);
    }
    return items;
  }
  if (typeof value !== "object") return undefined;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return undefined;
  const result: Record<string, JSONValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (unsafeKeys.has(key.trim())) continue;
    const sanitized = sanitizeJson(entry);
    if (sanitized === undefined) return undefined;
    result[key] = sanitized;
  }
  return result;
}

/** Only the namespace payload's top-level protocol fields are reserved. */
export function sanitizeReasoningProviderOptions(value: unknown): Record<string, JSONValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return {};
  const result: Record<string, JSONValue> = {};
  for (const [rawKey, entry] of Object.entries(value)) {
    const key = rawKey.trim();
    if (!key || unsafeKeys.has(key) || RESERVED_REASONING_PROVIDER_OPTION_KEYS.has(canonicalTopLevelProviderOptionKey(key))) continue;
    const sanitized = sanitizeJson(entry);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  return result;
}

export function mergeReasoningProviderOptions(
  rawNamespacePayload: unknown,
  fixedOptions: Readonly<Record<string, JSONValue>>,
): Record<string, JSONValue> {
  const fixed = sanitizeJson(fixedOptions);
  if (!fixed || typeof fixed !== "object" || Array.isArray(fixed)) {
    throw new Error("invalid fixed reasoning provider options");
  }
  return { ...sanitizeReasoningProviderOptions(rawNamespacePayload), ...fixed };
}
