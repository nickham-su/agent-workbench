import type { FastifyInstance } from "fastify";
import type { AgentRuntimePort } from "../agent.runtime-port.js";

type StartupLogger = { warn(bindings: Record<string, unknown>, message: string): void };

export type AgentStartupCoordinatorDependencies = {
  cleanupOrphans(): void | Promise<void>;
  cleanupAttachmentTemps(): void | Promise<void>;
  recoverRuns(params: { runtime: AgentRuntimePort }): void | Promise<void>;
  logger: StartupLogger;
};

/** Coordinates existing startup use-cases without owning their domain policy. */
export class AgentStartupCoordinator {
  private recoveryInFlight: Promise<void> | null = null;
  private activeGeneration: number | null = null;
  private pendingReady: { generation: number; runtime: AgentRuntimePort } | null = null;
  constructor(private readonly dependencies: AgentStartupCoordinatorDependencies) {}

  async runPreListen() {
    try {
      await this.dependencies.cleanupOrphans();
    } catch (err) {
      this.dependencies.logger.warn({ err }, "subtask orphan startup scan failed");
    }
    try {
      await this.dependencies.cleanupAttachmentTemps();
    } catch (err) {
      this.dependencies.logger.warn({ err }, "agent attachment temp startup cleanup failed");
    }
  }

  /**
   * Recovery belongs to the Worker generation, not just the API process.
   * Coalescing prevents API onListen and a just-ready replacement Worker from
   * scanning/re-enqueueing the same durable Runs concurrently.
   */
  async recoverWhenRuntimeReady(runtime: AgentRuntimePort, generation = 0) {
    if (this.recoveryInFlight) {
      // Repeated ready notifications for one Worker generation are harmless.
      // A newer generation arriving while its predecessor scans must cause one
      // follow-up scan: the old Worker may have lost its in-memory queue after
      // the first candidate list was read.
      if (generation !== this.activeGeneration) {
        this.pendingReady = { generation, runtime };
      }
      return await this.recoveryInFlight;
    }

    const recovery = (async () => {
      let current = { generation, runtime };
      while (true) {
        this.activeGeneration = current.generation;
        try {
          await this.dependencies.recoverRuns({ runtime: current.runtime });
        } catch (err) {
          // A ready replacement Worker has an empty in-memory queue even when
          // its predecessor's scan failed. Drain that newer generation before
          // returning the old failure; do not retry the failed generation.
          const pendingAfterFailure = this.pendingReady;
          this.pendingReady = null;
          if (pendingAfterFailure && pendingAfterFailure.generation !== current.generation) {
            this.dependencies.logger.warn(
              { err, generation: current.generation, pendingGeneration: pendingAfterFailure.generation },
              "agent run recovery scan failed; continuing with newer Worker generation",
            );
            current = pendingAfterFailure;
            continue;
          }
          throw err;
        }
        const pending = this.pendingReady;
        this.pendingReady = null;
        if (!pending || pending.generation === current.generation) return;
        current = pending;
      }
    })();
    this.recoveryInFlight = recovery;
    try {
      await recovery;
    } finally {
      if (this.recoveryInFlight === recovery) {
        this.recoveryInFlight = null;
        this.activeGeneration = null;
      }
    }
  }

  registerRecoverOnListen(app: FastifyInstance, runtime: AgentRuntimePort) {
    app.addHook("onListen", async () => {
      await this.recoverWhenRuntimeReady(runtime);
    });
  }
}
