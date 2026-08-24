export type ArchiveStartupReconcileDependencies = {
  listSessions(): Array<{ workspaceId: string; sessionId: string }>;
  reconcilePendingBestEffort(params: { workspaceId: string; sessionId: string }): Promise<boolean>;
  logger: { warn(bindings: Record<string, unknown>, message: string): void };
};

/** Explicit startup use-case; module triggers it without owning reconciliation policy. */
export class ArchiveStartupReconcileApplication {
  constructor(private readonly dependencies: ArchiveStartupReconcileDependencies) {}

  async reconcileAllPendingBestEffort() {
    for (const session of this.dependencies.listSessions()) {
      try {
        await this.dependencies.reconcilePendingBestEffort(session);
      } catch (err) {
        this.dependencies.logger.warn({ err, workspaceId: session.workspaceId, sessionId: session.sessionId }, "archive pending startup reconcile failed");
      }
    }
  }
}
