import type { FastifyBaseLogger } from "fastify";
import type { AppContext } from "../../app/context.js";
import { nowMs } from "../../utils/time.js";
import type { AgentPluginHostClient } from "../agent/agent.plugin-host-client.js";
import type { AgentService } from "../agent/agent.service.js";
import { getRunRecord } from "../agent/agent.store.js";
import { HttpError } from "../../app/errors.js";
import {
  claimReplyJobSending,
  getConversationBinding,
  listPendingReplyJobs,
  markReplyJobFailed,
  markReplyJobSent,
  resetStaleSendingReplyJobs,
  failReplyJobsExceededMaxAttempts,
  resetReplyJobPendingFromSending
} from "./channels.store.js";

type ReplyDispatcher = {
  start: () => void;
  stop: () => Promise<void>;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createReplyDispatcher(params: {
  ctx: AppContext;
  logger: FastifyBaseLogger;
  agentService: AgentService;
  pluginHost: AgentPluginHostClient;
  pollIntervalMs?: number;
  batchSize?: number;
}): ReplyDispatcher {
  const pollIntervalMs = Math.max(200, Math.min(30_000, Math.floor(params.pollIntervalMs ?? 1000)));
  const batchSize = Math.max(1, Math.min(50, Math.floor(params.batchSize ?? 10)));
  const sendingLeaseMs = 10 * 60_000;

  let stopped = false;
  let loopPromise: Promise<void> | null = null;

  async function processOne(job: any) {
    const ts = nowMs();
    const claim = claimReplyJobSending(params.ctx.db, { jobId: job.id, updatedAt: ts });
    if (!claim.claimed) return;

    try {
      // MVP: only feishu.
      if (job.pluginId !== "feishu") {
        markReplyJobFailed(params.ctx.db, {
          jobId: job.id,
          errorText: `unsupported pluginId: ${String(job.pluginId)}`,
          updatedAt: nowMs()
        });
        return;
      }

      const binding = getConversationBinding(params.ctx.db, {
        pluginId: job.pluginId,
        channelName: job.channelName,
        accountId: job.accountId,
        conversationKey: job.conversationKey
      });
      if (!binding) {
        markReplyJobFailed(params.ctx.db, {
          jobId: job.id,
          errorText: "conversation binding not found",
          updatedAt: nowMs()
        });
        return;
      }

      const run = getRunRecord(params.ctx.db, job.runId);
      if (!run) {
        markReplyJobFailed(params.ctx.db, {
          jobId: job.id,
          errorText: "run not found",
          updatedAt: nowMs()
        });
        return;
      }

      // Only dispatch when run is completed.
      if (run.status === "running") {
        // Put back to pending to retry later.
        resetReplyJobPendingFromSending(params.ctx.db, { jobId: job.id, updatedAt: nowMs() });
        return;
      }

      if (run.status !== "completed") {
        markReplyJobFailed(params.ctx.db, {
          jobId: job.id,
          errorText: `run is ${run.status}`,
          updatedAt: nowMs()
        });
        return;
      }

      const result = params.agentService.getLatestCompletedAssistantTextByRunId({ runId: job.runId });
      const text = String(result.text || "").trim();
      if (!text) {
        markReplyJobFailed(params.ctx.db, {
          jobId: job.id,
          errorText: "empty assistant output",
          updatedAt: nowMs()
        });
        return;
      }

      const replyTo = String(job.replyToExternalMessageId || "").trim();
      if (!replyTo) {
        markReplyJobFailed(params.ctx.db, {
          jobId: job.id,
          errorText: "missing reply_to_external_message_id",
          updatedAt: nowMs()
        });
        return;
      }

      await params.pluginHost.feishuReplyText({
        chatId: binding.chatId,
        messageId: replyTo,
        text
      });

      markReplyJobSent(params.ctx.db, { jobId: job.id, updatedAt: nowMs() });
    } catch (err) {
      // Retry transient errors (plugin-host unavailable / gateway not running).
      if (err instanceof HttpError && err.statusCode === 503) {
        resetReplyJobPendingFromSending(params.ctx.db, { jobId: job.id, updatedAt: nowMs() });
        return;
      }

      const message = err instanceof Error ? err.message : String(err);
      markReplyJobFailed(params.ctx.db, {
        jobId: job.id,
        errorText: message,
        updatedAt: nowMs()
      });
      params.logger.error({ err, jobId: job.id }, "reply dispatcher: send failed");
    }
  }

  async function tickOnce() {
    // Recover stuck jobs due to process crash/restart.
    resetStaleSendingReplyJobs(params.ctx.db, { maxAgeMs: sendingLeaseMs, limit: batchSize, updatedAt: nowMs() });
    // Ensure jobs do not retry forever.
    failReplyJobsExceededMaxAttempts(params.ctx.db, { limit: batchSize, updatedAt: nowMs() });

    const jobs = listPendingReplyJobs(params.ctx.db, { limit: batchSize });
    for (const job of jobs) {
      if (stopped) return;
      // sequential for MVP
      await processOne(job);
    }
  }

  async function loop() {
    while (!stopped) {
      try {
        await tickOnce();
      } catch (err) {
        params.logger.error({ err }, "reply dispatcher: tick failed");
      }
      if (stopped) break;
      await sleep(pollIntervalMs);
    }
  }

  return {
    start() {
      if (loopPromise) return;
      stopped = false;
      loopPromise = loop();
    },
    async stop() {
      stopped = true;
      await loopPromise;
      loopPromise = null;
    }
  };
}
