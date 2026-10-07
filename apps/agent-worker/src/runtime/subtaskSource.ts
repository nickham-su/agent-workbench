/** Optional display metadata, not a source proof or a fallback to request input. */
export function readSubtaskSourceSessionId(carrier: unknown): string | undefined {
  if (!carrier || (typeof carrier !== "object" && typeof carrier !== "function")) return undefined;
  try {
    // Do not execute accessors or inherit a field. Descriptor failures (for
    // example revoked/hostile proxies) cannot make optional display mandatory.
    const descriptor = Object.getOwnPropertyDescriptor(carrier, "sourceSessionId");
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") {
      return undefined;
    }
    return descriptor.value.trim() || undefined;
  } catch {
    return undefined;
  }
}
