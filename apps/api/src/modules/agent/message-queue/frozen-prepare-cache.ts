export class PrepareCapacityError extends Error {
  constructor(readonly reason: "snapshot_too_large" | "cache_capacity") {
    super(`Frozen preparation capacity exceeded: ${reason}`);
    this.name = "PrepareCapacityError";
  }
}

/** One authority for UTF-8 serialized frozen payload limits. No time-based eviction. */
export const PREPARE_SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024;
export const PREPARE_CACHE_MAX_BYTES = 128 * 1024 * 1024;
type Slot = { operationId: string; json: string; bytes: number };
export class FrozenPrepareCache {
  private readonly slots = new Map<string, Slot>();
  private totalBytes = 0;
  get bytes() { return this.totalBytes; }
  get keys() { return this.slots.keys(); }
  get<T>(key: string, operationId: string): T | null {
    const slot = this.slots.get(key);
    return slot?.operationId === operationId ? JSON.parse(slot.json) as T : null;
  }
  /** Validate before DB commit, publish synchronously afterwards (no intervening await). */
  stage(key: string, operationId: string, value: unknown): () => void {
    const json = JSON.stringify(value), bytes = Buffer.byteLength(json, "utf8");
    if (bytes > PREPARE_SNAPSHOT_MAX_BYTES) throw new PrepareCapacityError("snapshot_too_large");
    if (this.totalBytes - (this.slots.get(key)?.bytes ?? 0) + bytes > PREPARE_CACHE_MAX_BYTES)
      throw new PrepareCapacityError("cache_capacity");
    return () => {
      this.release(key);
      this.slots.set(key, { operationId, json, bytes });
      this.totalBytes += bytes;
    };
  }
  release(key: string) {
    const slot = this.slots.get(key);
    if (slot) this.totalBytes -= slot.bytes;
    this.slots.delete(key);
  }
  clear() { this.slots.clear(); this.totalBytes = 0; }
}
