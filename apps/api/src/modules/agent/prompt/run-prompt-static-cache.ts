export const RUN_PROMPT_STATIC_CACHE_TTL_MS = 30 * 60 * 1000;

export type RunPromptStaticCacheEntry<Value> = {
  expiresAt: number;
  promise: Promise<Value>;
};

/**
 * Run-scoped cache for the immutable portion of prompt-context. It preserves
 * the established runId key, 30-minute access-based expiry, and Promise reuse.
 * Lifecycle callers remain responsible for deciding when to clear a run.
 */
export class RunPromptStaticCache<Value> {
  private readonly entries = new Map<string, RunPromptStaticCacheEntry<Value>>();

  getOrCreate(runId: string, now: number, create: () => Promise<Value>): Promise<Value> {
    const cached = this.entries.get(runId);
    const promise = cached && cached.expiresAt > now ? cached.promise : create();
    this.entries.set(runId, {
      expiresAt: now + RUN_PROMPT_STATIC_CACHE_TTL_MS,
      promise
    });
    return promise;
  }

  clear(runId: string) {
    this.entries.delete(runId);
  }

  /** Test-only observability for the existing characterization evidence. */
  get(runId: string) {
    return this.entries.get(runId);
  }

  /** Test-only observability for the existing characterization evidence. */
  has(runId: string) {
    return this.entries.has(runId);
  }
}

export type RunPromptStaticCacheInvalidatorDependencies = {
  clearRunStaticPrompt: (runId: string) => void;
};

/** Narrow lifecycle capability; it does not decide terminal timing. */
export class RunPromptStaticCacheInvalidator {
  constructor(private readonly dependencies: RunPromptStaticCacheInvalidatorDependencies) {}

  clear(runId: string) {
    this.dependencies.clearRunStaticPrompt(runId);
  }
}
