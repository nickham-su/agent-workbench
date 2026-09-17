import type { FastifyBaseLogger } from "fastify";
import type { AgentRuntimePort } from "./agent.runtime-port.js";

type RuntimeReadyLogger = Pick<FastifyBaseLogger, "warn">;

/**
 * A Worker is health-ready before this hook runs. Durable Workspace deletion
 * must get the first chance to drain that Worker: otherwise its restored fence
 * deliberately rejects startup Run recovery and can strand the tombstone.
 */
export async function recoverAfterAgentRuntimeReady(params: {
  runtime: AgentRuntimePort;
  generation: number;
  resumeWorkspaceDeletions(): Promise<void>;
  recoverRuns(input: { runtime: AgentRuntimePort; generation: number }): Promise<void>;
  reconcileTerminals(): Promise<void>;
  logger: RuntimeReadyLogger;
}) {
  try {
    await params.resumeWorkspaceDeletions();
  } catch (err) {
    // A deletion remains durable and fenced; a later ready generation or an
    // explicit DELETE may retry it. Do not kill a healthy Worker for this.
    params.logger.warn({ err }, "workspace deletion startup resume failed");
  }

  // Unexpected recovery failures remain fatal to this ready generation. The
  // lifecycle layer treats WORKSPACE_DELETING as a per-candidate skip.
  await params.recoverRuns({ runtime: params.runtime, generation: params.generation });

  try {
    await params.reconcileTerminals();
  } catch (err) {
    // Terminal records retain their durable intent and are retried later.
    params.logger.warn({ err }, "terminal startup reconciliation failed");
  }
}
