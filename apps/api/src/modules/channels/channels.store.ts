import type { Db } from "../../infra/db/db.js";

export type ConversationBindingRow = {
  pluginId: string;
  channelName: string;
  accountId: string;
  conversationKey: string;
  chatId: string;
  chatType: "direct" | "group";
  workspaceId: string;
  sessionId: string;
  selectedAgentId: string | null;
  groupMode: string | null;
  watermarkExternalMessageId: string | null;
  createdAt: number;
  updatedAt: number;
};

export function getConversationBinding(
  db: Db,
  key: { pluginId: string; channelName: string; accountId: string; conversationKey: string }
): ConversationBindingRow | null {
  const row = db
    .prepare(
      `
        select
          plugin_id as pluginId,
          channel_name as channelName,
          account_id as accountId,
          conversation_key as conversationKey,
          chat_id as chatId,
          chat_type as chatType,
          workspace_id as workspaceId,
          session_id as sessionId,
          selected_agent_id as selectedAgentId,
          group_mode as groupMode,
          watermark_external_message_id as watermarkExternalMessageId,
          created_at as createdAt,
          updated_at as updatedAt
        from channel_conversation_binding
        where plugin_id=@pluginId
          and channel_name=@channelName
          and account_id=@accountId
          and conversation_key=@conversationKey
      `
    )
    .get(key) as ConversationBindingRow | undefined;
  return row ?? null;
}

export function upsertConversationBinding(
  db: Db,
  input: {
    pluginId: string;
    channelName: string;
    accountId: string;
    conversationKey: string;
    chatId: string;
    chatType: "direct" | "group";
    workspaceId: string;
    sessionId: string;
    // when session changes, caller should clear selectedAgentId
    selectedAgentId?: string | null;
    updatedAt: number;
    createdAt?: number;
  }
) {
  const createdAt = input.createdAt ?? input.updatedAt;
  db.prepare(
    `
      insert into channel_conversation_binding (
        plugin_id, channel_name, account_id, conversation_key,
        chat_id, chat_type,
        workspace_id, session_id,
        selected_agent_id,
        created_at, updated_at
      ) values (
        @pluginId, @channelName, @accountId, @conversationKey,
        @chatId, @chatType,
        @workspaceId, @sessionId,
        @selectedAgentId,
        @createdAt, @updatedAt
      )
      on conflict(plugin_id, channel_name, account_id, conversation_key)
      do update set
        chat_id = excluded.chat_id,
        chat_type = excluded.chat_type,
        workspace_id = excluded.workspace_id,
        session_id = excluded.session_id,
        selected_agent_id = excluded.selected_agent_id,
        updated_at = excluded.updated_at
    `
  ).run({
    pluginId: input.pluginId,
    channelName: input.channelName,
    accountId: input.accountId,
    conversationKey: input.conversationKey,
    chatId: input.chatId,
    chatType: input.chatType,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    selectedAgentId: input.selectedAgentId ?? null,
    createdAt,
    updatedAt: input.updatedAt
  });
}

export function updateBindingGroupMode(
  db: Db,
  input: { pluginId: string; channelName: string; accountId: string; conversationKey: string; groupMode: string | null; updatedAt: number }
) {
  db.prepare(
    `
      update channel_conversation_binding
      set group_mode=@groupMode,
          updated_at=@updatedAt
      where plugin_id=@pluginId
        and channel_name=@channelName
        and account_id=@accountId
        and conversation_key=@conversationKey
    `
  ).run(input);
}

export type InboundMessageRow = {
  id: number;
  pluginId: string;
  channelName: string;
  accountId: string;
  conversationKey: string;
  externalMessageId: string;
  senderId: string;
  senderName: string | null;
  mentionedBot: number;
  text: string;
  createdAtExternal: number | null;
  createdAtLocal: number;
};

export function getInboundMessageByExternalMessageId(
  db: Db,
  input: {
    pluginId: string;
    channelName: string;
    accountId: string;
    conversationKey: string;
    externalMessageId: string;
  }
): InboundMessageRow | null {
  const row = db
    .prepare(
      `
        select
          id,
          plugin_id as pluginId,
          channel_name as channelName,
          account_id as accountId,
          conversation_key as conversationKey,
          external_message_id as externalMessageId,
          sender_id as senderId,
          sender_name as senderName,
          mentioned_bot as mentionedBot,
          text,
          created_at_external as createdAtExternal,
          created_at_local as createdAtLocal
        from channel_inbound_message
        where plugin_id=@pluginId
          and channel_name=@channelName
          and account_id=@accountId
          and conversation_key=@conversationKey
          and external_message_id=@externalMessageId
        limit 1
      `
    )
    .get({
      pluginId: input.pluginId,
      channelName: input.channelName,
      accountId: input.accountId,
      conversationKey: input.conversationKey,
      externalMessageId: input.externalMessageId
    }) as InboundMessageRow | undefined;
  return row ?? null;
}

export function getInboundMessageIdByExternalMessageId(
  db: Db,
  input: { pluginId: string; channelName: string; accountId: string; conversationKey: string; externalMessageId: string }
): number | null {
  const row = db
    .prepare(
      `
        select id
        from channel_inbound_message
        where plugin_id=@pluginId
          and channel_name=@channelName
          and account_id=@accountId
          and conversation_key=@conversationKey
          and external_message_id=@externalMessageId
        limit 1
      `
    )
    .get(input) as { id: number } | undefined;
  return row?.id ?? null;
}

export function insertInboundMessageDedup(
  db: Db,
  input: {
    pluginId: string;
    channelName: string;
    accountId: string;
    conversationKey: string;
    externalMessageId: string;
    senderId: string;
    senderName: string | null;
    mentionedBot: boolean;
    text: string;
    createdAtExternal: number | null;
    createdAtLocal: number;
  }
): { inserted: boolean } {
  // rely on unique index: (plugin_id, channel_name, account_id, external_message_id)
  const res = db
    .prepare(
      `
        insert into channel_inbound_message (
          plugin_id, channel_name, account_id, conversation_key,
          external_message_id,
          sender_id, sender_name,
          mentioned_bot,
          text,
          created_at_external,
          created_at_local
        ) values (
          @pluginId, @channelName, @accountId, @conversationKey,
          @externalMessageId,
          @senderId, @senderName,
          @mentionedBot,
          @text,
          @createdAtExternal,
          @createdAtLocal
        )
        on conflict(plugin_id, channel_name, account_id, external_message_id)
        do nothing
      `
    )
    .run({
      pluginId: input.pluginId,
      channelName: input.channelName,
      accountId: input.accountId,
      conversationKey: input.conversationKey,
      externalMessageId: input.externalMessageId,
      senderId: input.senderId,
      senderName: input.senderName,
      mentionedBot: input.mentionedBot ? 1 : 0,
      text: input.text,
      createdAtExternal: input.createdAtExternal,
      createdAtLocal: input.createdAtLocal
    });
  return { inserted: res.changes > 0 };
}

export function listInboundMessagesForAggregation(
  db: Db,
  input: {
    pluginId: string;
    channelName: string;
    accountId: string;
    conversationKey: string;
    watermarkId: number | null;
    upperBoundId: number;
    maxMessages: number;
  }
): InboundMessageRow[] {
  const rows = db
    .prepare(
      `
        select
          id,
          plugin_id as pluginId,
          channel_name as channelName,
          account_id as accountId,
          conversation_key as conversationKey,
          external_message_id as externalMessageId,
          sender_id as senderId,
          sender_name as senderName,
          mentioned_bot as mentionedBot,
          text,
          created_at_external as createdAtExternal,
          created_at_local as createdAtLocal
        from channel_inbound_message
        where plugin_id=@pluginId
          and channel_name=@channelName
          and account_id=@accountId
          and conversation_key=@conversationKey
          and id > @watermarkId
          and id <= @upperBoundId
        order by id desc
        limit @maxMessages
      `
    )
    .all({
      pluginId: input.pluginId,
      channelName: input.channelName,
      accountId: input.accountId,
      conversationKey: input.conversationKey,
      watermarkId: input.watermarkId ?? 0,
      upperBoundId: input.upperBoundId,
      maxMessages: input.maxMessages
    }) as InboundMessageRow[];

  // Reverse to keep ascending order for prompt rendering.
  return rows.reverse();
}

export function advanceWatermark(
  db: Db,
  input: { pluginId: string; channelName: string; accountId: string; conversationKey: string; watermarkExternalMessageId: string; updatedAt: number }
) {
  db.prepare(
    `
      update channel_conversation_binding
      set watermark_external_message_id=@watermarkExternalMessageId,
          updated_at=@updatedAt
      where plugin_id=@pluginId
        and channel_name=@channelName
        and account_id=@accountId
        and conversation_key=@conversationKey
    `
  ).run({
    pluginId: input.pluginId,
    channelName: input.channelName,
    accountId: input.accountId,
    conversationKey: input.conversationKey,
    watermarkExternalMessageId: input.watermarkExternalMessageId,
    updatedAt: input.updatedAt
  });
}

export function createReplyJob(
  db: Db,
  input: {
    pluginId: string;
    channelName: string;
    accountId: string;
    conversationKey: string;
    workspaceId: string;
    sessionId: string;
    runId: string;
    replyToExternalMessageId: string;
    status: "pending" | "sent" | "failed";
    errorText: string | null;
    createdAt: number;
    updatedAt: number;
  }
): { inserted: boolean } {
  const res = db
    .prepare(
      `
        insert into channel_reply_job (
           plugin_id, channel_name, account_id, conversation_key,
           workspace_id, session_id, run_id,
           reply_to_external_message_id,
           status, error_text,
           created_at, updated_at
         ) values (
           @pluginId, @channelName, @accountId, @conversationKey,
           @workspaceId, @sessionId, @runId,
           @replyToExternalMessageId,
           @status, @errorText,
           @createdAt, @updatedAt
         )
        on conflict(run_id) do nothing
      `
    )
    .run({
      pluginId: input.pluginId,
      channelName: input.channelName,
      accountId: input.accountId,
      conversationKey: input.conversationKey,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      runId: input.runId,
      replyToExternalMessageId: input.replyToExternalMessageId,
      status: input.status,
      errorText: input.errorText,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt
    });
  return { inserted: res.changes > 0 };
}

export type ReplyJobRow = {
  id: number;
  pluginId: string;
  channelName: string;
  accountId: string;
  conversationKey: string;
  workspaceId: string;
  sessionId: string;
  runId: string;
  replyToExternalMessageId: string | null;
  status: "pending" | "sending" | "sent" | "failed";
  errorText: string | null;
  attemptCount: number;
  lastAttemptAt: number | null;
  maxAttempts: number;
  createdAt: number;
  updatedAt: number;
};

export function listPendingReplyJobs(db: Db, params: { limit: number }) {
  const limit = Math.max(1, Math.min(100, Math.floor(params.limit || 20)));
  const rows = db
    .prepare(
      `
        select
          id,
          rj.plugin_id as pluginId,
          rj.channel_name as channelName,
          rj.account_id as accountId,
          rj.conversation_key as conversationKey,
          rj.workspace_id as workspaceId,
          rj.session_id as sessionId,
          rj.run_id as runId,
          rj.reply_to_external_message_id as replyToExternalMessageId,
          rj.status,
          rj.error_text as errorText,
          rj.attempt_count as attemptCount,
          rj.last_attempt_at as lastAttemptAt,
          rj.max_attempts as maxAttempts,
          rj.created_at as createdAt,
          rj.updated_at as updatedAt
        from channel_reply_job rj
        left join agent_run
          on agent_run.run_id = rj.run_id
        where rj.status = 'pending'
          and rj.attempt_count < rj.max_attempts
          and (agent_run.status is null or agent_run.status != 'running')
        order by rj.updated_at asc, rj.id asc
        limit ?
      `
    )
    .all(limit) as ReplyJobRow[];
  return rows ?? [];
}

export function claimReplyJobSending(db: Db, params: { jobId: number; updatedAt: number }) {
  const res = db
    .prepare(
      `
        update channel_reply_job
        set status='sending',
            error_text=null,
            attempt_count=attempt_count+1,
            last_attempt_at=@updatedAt,
            updated_at=@updatedAt
        where id=@jobId
          and status='pending'
          and attempt_count < max_attempts
      `
    )
    .run({ jobId: params.jobId, updatedAt: params.updatedAt });
  return { claimed: res.changes > 0 };
}

export function resetReplyJobPendingFromSending(db: Db, params: { jobId: number; updatedAt: number }) {
  const res = db
    .prepare(
      `
        update channel_reply_job
        set status='pending', error_text=null, updated_at=@updatedAt
        where id=@jobId and status='sending'
      `
    )
    .run({ jobId: params.jobId, updatedAt: params.updatedAt });
  return { changed: res.changes > 0 };
}

export function resetStaleSendingReplyJobs(db: Db, params: { maxAgeMs: number; limit: number; updatedAt: number }) {
  const maxAgeMs = Math.max(1000, Math.min(24 * 60 * 60 * 1000, Math.floor(params.maxAgeMs || 0)));
  const limit = Math.max(1, Math.min(200, Math.floor(params.limit || 50)));
  const cutoff = Math.max(0, Math.floor(params.updatedAt - maxAgeMs));

  // sqlite does not support UPDATE ... ORDER BY ... LIMIT directly in all versions;
  // use a subquery.
  const res = db
    .prepare(
      `
        update channel_reply_job
        set status='pending', error_text=null, updated_at=@updatedAt
        where id in (
          select id
          from channel_reply_job
          where status='sending'
            and updated_at <= @cutoff
            and attempt_count < max_attempts
          order by updated_at asc, id asc
          limit @limit
        )
      `
    )
    .run({ updatedAt: params.updatedAt, cutoff, limit });
  return { changed: res.changes > 0, changes: res.changes };
}

export function failReplyJobsExceededMaxAttempts(db: Db, params: { limit: number; updatedAt: number }) {
  const limit = Math.max(1, Math.min(200, Math.floor(params.limit || 50)));
  const res = db
    .prepare(
      `
        update channel_reply_job
        set status='failed',
            error_text='max attempts exceeded',
            updated_at=@updatedAt
        where id in (
          select id
          from channel_reply_job
          where status in ('pending', 'sending')
            and attempt_count >= max_attempts
          order by updated_at asc, id asc
          limit @limit
        )
      `
    )
    .run({ updatedAt: params.updatedAt, limit });
  return { changed: res.changes > 0, changes: res.changes };
}

export function markReplyJobSent(db: Db, params: { jobId: number; updatedAt: number }) {
  const res = db
    .prepare(
      `
        update channel_reply_job
        set status='sent', error_text=null, updated_at=@updatedAt
        where id=@jobId and status='sending'
      `
    )
    .run({ jobId: params.jobId, updatedAt: params.updatedAt });
  return { changed: res.changes > 0 };
}

export function markReplyJobFailed(db: Db, params: { jobId: number; errorText: string; updatedAt: number }) {
  const res = db
    .prepare(
      `
        update channel_reply_job
        set status='failed', error_text=@errorText, updated_at=@updatedAt
        where id=@jobId and status='sending'
      `
    )
    .run({ jobId: params.jobId, errorText: params.errorText, updatedAt: params.updatedAt });
  return { changed: res.changes > 0 };
}

export function countReplyJobsForRun(db: Db, runId: string) {
  const row = db.prepare(`select count(1) as cnt from channel_reply_job where run_id = ?`).get(runId) as { cnt: number };
  return row?.cnt ?? 0;
}

export function updateBindingSelectedAgentId(
  db: Db,
  input: { pluginId: string; channelName: string; accountId: string; conversationKey: string; selectedAgentId: string | null; updatedAt: number }
) {
  db.prepare(
    `
      update channel_conversation_binding
      set selected_agent_id=@selectedAgentId,
          updated_at=@updatedAt
      where plugin_id=@pluginId
        and channel_name=@channelName
        and account_id=@accountId
        and conversation_key=@conversationKey
    `
  ).run({
    pluginId: input.pluginId,
    channelName: input.channelName,
    accountId: input.accountId,
    conversationKey: input.conversationKey,
    selectedAgentId: input.selectedAgentId,
    updatedAt: input.updatedAt
  });
}
