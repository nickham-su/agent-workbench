import type { SessionRuntimeHandoffCoordinatorPort } from "./run-lifecycle-ports.js";

/**
 * Serializes the short durable-state-to-runtime handoff for one Agent Session.
 *
 * This is intentionally process-local: Agent Workbench runs one API process in
 * its supported personal self-hosted deployment. It is not a distributed lock
 * and must be replaced deliberately if that deployment assumption changes.
 */
export class SessionRuntimeHandoffCoordinator
  implements SessionRuntimeHandoffCoordinatorPort
{
  private readonly tails = new Map<string, Promise<void>>();

  async runExclusive<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const predecessor = this.tails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chainedTail = predecessor.catch(() => undefined).then(() => tail);
    this.tails.set(sessionId, chainedTail);

    await predecessor.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(sessionId) === chainedTail) this.tails.delete(sessionId);
    }
  }

  async runExclusiveMany<T>(sessionIds: readonly string[], operation: () => Promise<T>): Promise<T> {
    const ordered = [...new Set(sessionIds)].sort();
    const acquire = async (index: number): Promise<T> => {
      const sessionId = ordered[index];
      if (sessionId == null) return await operation();
      return await this.runExclusive(sessionId, async () => await acquire(index + 1));
    };
    return await acquire(0);
  }
}
