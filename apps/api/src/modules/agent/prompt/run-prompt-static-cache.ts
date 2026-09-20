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
  private readonly generations = new Map<string, number>();

  generation(runId: string) {
    return this.generations.get(runId) ?? 0;
  }

  isCurrent(runId: string, generation: number) {
    return this.generation(runId) === generation;
  }

  getOrCreate(
    runId: string,
    now: number,
    create: () => Promise<Value>,
    expectedGeneration = this.generation(runId),
  ): Promise<Value> {
    if (!this.isCurrent(runId, expectedGeneration)) return create();
    const cached = this.entries.get(runId);
    const promise = cached && cached.expiresAt > now ? cached.promise : create();
    this.entries.set(runId, {
      expiresAt: now + RUN_PROMPT_STATIC_CACHE_TTL_MS,
      promise
    });
    return promise;
  }

  clear(runId: string) {
    this.generations.set(runId, this.generation(runId) + 1);
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
