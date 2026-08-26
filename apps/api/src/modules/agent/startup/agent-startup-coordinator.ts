import type { FastifyInstance } from "fastify";
import type { AgentRuntimePort } from "../agent.runtime-port.js";

type StartupLogger = { warn(bindings: Record<string, unknown>, message: string): void };
type StartupRecoveryMode = "fail" | "recover";

export type AgentStartupCoordinatorDependencies = {
  cleanupOrphans(): void | Promise<void>;
  reconcileArchive(): void | Promise<void>;
  cleanupAttachmentTemps(): void | Promise<void>;
  failRuns(): void | Promise<void>;
  recoverRuns(params: { runtime: AgentRuntimePort }): void | Promise<void>;
  logger: StartupLogger;
  recoveryMode: StartupRecoveryMode;
};

/** Coordinates existing startup use-cases without owning their domain policy. */
export class AgentStartupCoordinator {
  constructor(private readonly dependencies: AgentStartupCoordinatorDependencies) {}

  async runPreListen() {
    try {
      await this.dependencies.cleanupOrphans();
    } catch (err) {
      this.dependencies.logger.warn({ err }, "subtask orphan startup scan failed");
    }
    try {
      await this.dependencies.reconcileArchive();
    } catch (err) {
      this.dependencies.logger.warn({ err }, "archive pending startup reconcile failed");
    }
    try {
      await this.dependencies.cleanupAttachmentTemps();
    } catch (err) {
      this.dependencies.logger.warn({ err }, "agent attachment temp startup cleanup failed");
    }
    if (this.dependencies.recoveryMode === "fail") await this.dependencies.failRuns();
  }

  registerRecoverOnListen(app: FastifyInstance, runtime: AgentRuntimePort) {
    if (this.dependencies.recoveryMode !== "recover") return;
    app.addHook("onListen", async () => {
      await this.dependencies.recoverRuns({ runtime });
    });
  }
}
