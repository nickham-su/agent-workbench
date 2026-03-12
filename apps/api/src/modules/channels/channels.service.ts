import type { FastifyBaseLogger } from "fastify";
import type { AppContext } from "../../app/context.js";
import { HttpError } from "../../app/errors.js";
import { nowMs } from "../../utils/time.js";
import type { AgentService } from "../agent/agent.service.js";
import type { AgentRuntimePort } from "../agent/agent.runtime-port.js";
import {
  advanceWatermark,
  countReplyJobsForRun,
  createReplyJob,
  getConversationBinding,
  getInboundMessageByExternalMessageId,
  getInboundMessageIdByExternalMessageId,
  insertInboundMessageDedup,
  listInboundMessagesForAggregation,
  upsertConversationBinding,
  updateBindingSelectedAgentId
} from "./channels.store.js";

export const CHANNEL_SENDER_ALLOWLIST_ENV = "AWB_CHANNEL_SENDER_ALLOWLIST";

function parseAllowlist(raw: string | undefined | null): Set<string> {
  const text = String(raw || "").trim();
  if (!text) return new Set();
  const parts = text
    .split(/[\n,\s]+/g)
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set(parts);
}

export type ChannelRuntimeKey = {
  pluginId: string;
  channelName: string;
  accountId: string;
  conversationKey: string;
};

export type IngestInboundMessageInput = {
  pluginId: string;
  channelName: string;
  accountId: string;
  conversationKey: string;
  chatType: "direct" | "group";
  chatId: string;
  externalMessageId: string;
  createdAtExternalMs?: number;
  sender: { id: string; displayName?: string };
  mentionedBot?: boolean;
  text: string;
};

export type IngestInboundMessageResult =
  | { ok: true; deduplicated: boolean }
  | { ok: false; errorCode: "NOT_ALLOWED" | "PAYLOAD_INVALID"; message: string };

export type BuildAggregatedUserPromptInput = {
  pluginId: string;
  channelName: string;
  accountId: string;
  conversationKey: string;
  upperBoundExternalMessageId: string;
  maxMessages?: number;
  maxChars?: number;
};

export type BuildAggregatedUserPromptResult = { text: string; consumedExternalMessageId: string };

export type TryAppendUserMessageAndStartRunInput = {
  pluginId: string;
  channelName: string;
  accountId: string;
  conversationKey: string;
  triggerExternalMessageId: string;
  text: string;
  clientRequestId?: string;
  watermarkAdvanceExternalMessageId?: string;
};

export type TryAppendUserMessageAndStartRunResult =
  | { ok: true; runId: string; deduplicated: boolean }
  | {
      ok: false;
      errorCode:
        | "NOT_ALLOWED"
        | "BINDING_NOT_FOUND"
        | "INBOUND_NOT_FOUND"
        | "SESSION_NOT_FOUND"
        | "AGENT_NOT_SELECTED"
        | "SESSION_RUNNING"
        | "WORKSPACE_NOT_FOUND";
      message: string;
      statusSummary?: unknown;
    };

export class ChannelsService {
  constructor(
    private readonly ctx: AppContext,
    private readonly logger: FastifyBaseLogger,
    private readonly agentService: AgentService,
    private readonly runtime: AgentRuntimePort
  ) {
    // no-op
  }

  private assertAllowed(senderId: string): { ok: true } | { ok: false; message: string } {
    // Security-first decision:
    // - Default deny if allowlist is empty.
    // - Configure with env AWB_CHANNEL_SENDER_ALLOWLIST=open_id1,open_id2
    // Note: parse on each call (cheap) to support dynamic env in integration tests.
    const allowlist = parseAllowlist(process.env[CHANNEL_SENDER_ALLOWLIST_ENV]);
    if (allowlist.size === 0) {
      return { ok: false, message: "channel sender allowlist is empty" };
    }
    if (!allowlist.has(senderId)) {
      return { ok: false, message: "sender is not allowed" };
    }
    return { ok: true };
  }

  getConversationBinding(key: ChannelRuntimeKey) {
    return getConversationBinding(this.ctx.db, key);
  }

  upsertConversationBinding(input: {
    pluginId: string;
    channelName: string;
    accountId: string;
    conversationKey: string;
    chatId: string;
    chatType: "direct" | "group";
    sessionId: string;
  }) {
    const session = this.agentService.getSession(input.sessionId);
    if (!session) throw new HttpError(404, "session not found", "SESSION_NOT_FOUND");

    const ts = nowMs();
    const existing = getConversationBinding(this.ctx.db, input);
    const selectedAgentId = existing && existing.sessionId !== session.id ? null : existing?.selectedAgentId ?? null;

    upsertConversationBinding(this.ctx.db, {
      ...input,
      workspaceId: session.workspaceId,
      selectedAgentId,
      updatedAt: ts,
      createdAt: existing?.createdAt ?? ts
    });

    return getConversationBinding(this.ctx.db, input);
  }

  setSelectedAgentId(input: ChannelRuntimeKey & { selectedAgentId: string | null }) {
    const ts = nowMs();
    updateBindingSelectedAgentId(this.ctx.db, { ...input, updatedAt: ts });
  }

  ingestInboundMessage(input: IngestInboundMessageInput): IngestInboundMessageResult {
    const senderId = String(input.sender?.id || "").trim();
    if (!senderId) return { ok: false, errorCode: "PAYLOAD_INVALID", message: "sender.id is required" };

    const allow = this.assertAllowed(senderId);
    if (!allow.ok) return { ok: false, errorCode: "NOT_ALLOWED", message: allow.message };

    const externalMessageId = String(input.externalMessageId || "").trim();
    const text = String(input.text || "").trim();
    if (!externalMessageId) return { ok: false, errorCode: "PAYLOAD_INVALID", message: "externalMessageId is required" };
    if (!text) return { ok: false, errorCode: "PAYLOAD_INVALID", message: "text is required" };

    const ts = nowMs();
    const res = insertInboundMessageDedup(this.ctx.db, {
      pluginId: input.pluginId,
      channelName: input.channelName,
      accountId: input.accountId,
      conversationKey: input.conversationKey,
      externalMessageId,
      senderId,
      senderName: input.sender.displayName?.trim() ? input.sender.displayName.trim() : null,
      mentionedBot: Boolean(input.mentionedBot),
      text,
      createdAtExternal: typeof input.createdAtExternalMs === "number" ? input.createdAtExternalMs : null,
      createdAtLocal: ts
    });

    return { ok: true, deduplicated: !res.inserted };
  }

  buildAggregatedUserPrompt(input: BuildAggregatedUserPromptInput): BuildAggregatedUserPromptResult {
    const maxMessages = typeof input.maxMessages === "number" ? input.maxMessages : 50;
    const maxChars = typeof input.maxChars === "number" ? input.maxChars : 8000;

    const binding = getConversationBinding(this.ctx.db, input);
    if (!binding) throw new HttpError(404, "conversation binding not found", "BINDING_NOT_FOUND");

    const upperBoundId = getInboundMessageIdByExternalMessageId(this.ctx.db, {
      pluginId: input.pluginId,
      channelName: input.channelName,
      accountId: input.accountId,
      conversationKey: input.conversationKey,
      externalMessageId: input.upperBoundExternalMessageId
    });
    if (!upperBoundId) {
      throw new HttpError(404, "upper bound inbound message not found", "INBOUND_UPPER_BOUND_NOT_FOUND");
    }

    let watermarkId: number | null = null;
    if (binding.watermarkExternalMessageId) {
      const wmId = getInboundMessageIdByExternalMessageId(this.ctx.db, {
        pluginId: input.pluginId,
        channelName: input.channelName,
        accountId: input.accountId,
        conversationKey: input.conversationKey,
        externalMessageId: binding.watermarkExternalMessageId
      });
      if (!wmId) {
        // Watermark might point to deleted/compacted inbound rows; fall back to earliest.
        // We warn to keep it diagnosable.
        this.logger.warn(
          {
            pluginId: input.pluginId,
            channelName: input.channelName,
            accountId: input.accountId,
            conversationKey: input.conversationKey,
            watermarkExternalMessageId: binding.watermarkExternalMessageId
          },
          "channels: watermark inbound message not found, falling back to start"
        );
      } else {
        watermarkId = wmId;
      }
    }

    const rows = listInboundMessagesForAggregation(this.ctx.db, {
      pluginId: input.pluginId,
      channelName: input.channelName,
      accountId: input.accountId,
      conversationKey: input.conversationKey,
      watermarkId,
      upperBoundId,
      maxMessages
    });

    if (rows.length === 0) {
      return { text: "", consumedExternalMessageId: input.upperBoundExternalMessageId };
    }

    let kept = rows;
    let dropped = false;
    if (kept.length > maxMessages) {
      dropped = true;
      kept = kept.slice(kept.length - maxMessages);
    }

    let lines = kept.map((m) => {
      const name = (m.senderName || m.senderId || "unknown").trim() || "unknown";
      const msg = String(m.text || "");
      return `${name}: ${msg}`;
    });

    const SEP = "---";
    const joinLines = () => lines.join(`\n${SEP}\n`);
    const hint = "（提示：已省略更早的群消息，或部分内容已截断）";
    const hintPrefix = `${hint}\n`;

    // Enforce maxChars while preserving tail messages near the trigger point.
    // Strategy:
    // - Prefer dropping earlier messages.
    // - When only one earliest message remains to adjust, tail-truncate it.
    // - Always account for hint line length when dropped=true.
    const calcTextLen = () => {
      const content = joinLines();
      return (dropped ? hintPrefix.length : 0) + content.length;
    };

    while (calcTextLen() > maxChars && lines.length > 0) {
      dropped = true;
      const prefixLen = hintPrefix.length;
      const totalSepLen = (lines.length - 1) * (`\n${SEP}\n`.length);
      const otherLen = lines.slice(1).reduce((acc, s) => acc + s.length, 0);
      const availableForFirst = Math.max(0, maxChars - prefixLen - totalSepLen - otherLen);

      // If even removing/truncating the first line cannot make it fit, drop the first line entirely.
      if (availableForFirst === 0) {
        if (lines.length === 1) {
          lines = [""]; // keep at least an empty line
          break;
        }
        lines = lines.slice(1);
        continue;
      }

      const first = lines[0] ?? "";
      if (first.length > availableForFirst) {
        lines[0] = first.slice(0, availableForFirst);
      }
      break;
    }

    const contentText = joinLines();
    let text = dropped ? `${hintPrefix}${contentText}` : contentText;
    if (text.length > maxChars) {
      // Should be rare; keep tail by trimming the start.
      text = text.slice(text.length - maxChars);
    }

    const consumedExternalMessageId = rows[rows.length - 1]?.externalMessageId ?? input.upperBoundExternalMessageId;
    return { text, consumedExternalMessageId };
  }

  async tryAppendUserMessageAndStartRun(input: TryAppendUserMessageAndStartRunInput): Promise<TryAppendUserMessageAndStartRunResult> {
    const binding = getConversationBinding(this.ctx.db, input);
    if (!binding) {
      return { ok: false, errorCode: "BINDING_NOT_FOUND", message: "conversation is not bound to a session" };
    }

    const inbound = getInboundMessageByExternalMessageId(this.ctx.db, {
      pluginId: input.pluginId,
      channelName: input.channelName,
      accountId: input.accountId,
      conversationKey: input.conversationKey,
      externalMessageId: input.triggerExternalMessageId
    });
    if (!inbound) {
      return { ok: false, errorCode: "INBOUND_NOT_FOUND", message: "trigger inbound message not found" };
    }

    // Re-check allowlist using inbound sender id to prevent bypassing ingest.
    const allow = this.assertAllowed(inbound.senderId);
    if (!allow.ok) {
      return { ok: false, errorCode: "NOT_ALLOWED", message: allow.message };
    }

    const session = this.agentService.getSession(binding.sessionId);
    if (!session) {
      return { ok: false, errorCode: "SESSION_NOT_FOUND", message: "session not found" };
    }

    const agentId = String(binding.selectedAgentId || "").trim();
    if (!agentId) {
      return { ok: false, errorCode: "AGENT_NOT_SELECTED", message: "agent is not selected" };
    }

    const clientRequestId = String(input.clientRequestId || "").trim() || `im_${input.pluginId}_${input.conversationKey}_${input.triggerExternalMessageId}`;

    let sendResult;
    try {
      sendResult = await this.agentService.sendMessage({
        sessionId: session.id,
        body: {
          workspaceId: session.workspaceId,
          text: input.text,
          clientRequestId,
          agentId
        }
      });
    } catch (err) {
      if (err instanceof HttpError && err.statusCode === 409) {
        const statusSummary = this.agentService.getSessionStatusSummary({ sessionId: session.id, selectedAgentId: agentId });
        return { ok: false, errorCode: "SESSION_RUNNING", message: err.message, statusSummary };
      }
      throw err;
    }

    const ts = nowMs();
    const jobRes = createReplyJob(this.ctx.db, {
      pluginId: input.pluginId,
      channelName: input.channelName,
      accountId: input.accountId,
      conversationKey: input.conversationKey,
      workspaceId: session.workspaceId,
      sessionId: session.id,
      runId: sendResult.runId,
      replyToExternalMessageId: input.triggerExternalMessageId,
      status: "pending",
      errorText: null,
      createdAt: ts,
      updatedAt: ts
    });

    if (!sendResult.deduplicated) {
      const workspace = this.agentService.getWorkspace(session.workspaceId);
      if (!workspace) {
        this.agentService.failRunOnEnqueueFailure({ workspaceId: session.workspaceId, sessionId: session.id, runId: sendResult.runId, updatedAt: ts });
        return { ok: false, errorCode: "WORKSPACE_NOT_FOUND", message: "workspace not found" };
      }
      try {
        await this.runtime.enqueueRun({
          workspaceId: session.workspaceId,
          sessionId: session.id,
          runId: sendResult.runId,
          workspacePath: workspace.path,
          inputText: input.text
        } as any);
      } catch (err) {
        this.agentService.failRunOnEnqueueFailure({ workspaceId: session.workspaceId, sessionId: session.id, runId: sendResult.runId, updatedAt: ts });
        throw err;
      }
    }

    // advance watermark only when we created a new reply job
    if (input.watermarkAdvanceExternalMessageId && jobRes.inserted) {
      advanceWatermark(this.ctx.db, {
        pluginId: input.pluginId,
        channelName: input.channelName,
        accountId: input.accountId,
        conversationKey: input.conversationKey,
        watermarkExternalMessageId: input.watermarkAdvanceExternalMessageId,
        updatedAt: ts
      });
    }

    const deduplicated = sendResult.deduplicated || !jobRes.inserted;
    return { ok: true, runId: sendResult.runId, deduplicated };
  }
}
