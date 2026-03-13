import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDb, type Db } from "../../infra/db/db.js";
import { rmrf } from "../../infra/fs/fs.js";
import { listPendingReplyJobs } from "./channels.store.js";

type Fixture = { db: Db; dataDir: string };

async function createFixture(): Promise<Fixture> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "awb-channels-store-"));
  const db = await openDb(dataDir);
  return { db, dataDir };
}

async function disposeFixture(f: Fixture) {
  try {
    f.db.close();
  } finally {
    await rmrf(f.dataDir);
  }
}

test("listPendingReplyJobs skips jobs whose run is still running, then returns after completed", async () => {
  const fixture = await createFixture();
  try {
    const now = Date.now();
    const runId = "run_test_pending_filter";
    const workspaceId = "ws_test";
    const sessionId = "sess_test";

    fixture.db
      .prepare(
        `
          insert into workspaces (
            id, dir_name, title, path,
            terminal_credential_id,
            last_used_at,
            created_at, updated_at
          ) values (
            @id, @dirName, @title, @path,
            null,
            null,
            @createdAt, @updatedAt
          )
        `
      )
      .run({
        id: workspaceId,
        dirName: "ws-test",
        title: "ws-test",
        path: "/tmp/ws-test",
        createdAt: now,
        updatedAt: now
      });

    fixture.db
      .prepare(
        `
          insert into agent_session (
            id, workspace_id, title, kind,
            created_at, updated_at
          ) values (
            @id, @workspaceId, @title, 'default',
            @createdAt, @updatedAt
          )
        `
      )
      .run({ id: sessionId, workspaceId, title: "test-session", createdAt: now, updatedAt: now });

    fixture.db
      .prepare(
        `
          insert into agent_run (
            run_id, workspace_id, session_id, trigger_item_id,
            agent_id, provider_id, model_id,
            status, created_at, updated_at, ui_locale
          ) values (
            @runId, @workspaceId, @sessionId, @triggerItemId,
            @agentId, @providerId, @modelId,
            @status, @createdAt, @updatedAt, null
          )
        `
      )
      .run({
        runId,
        workspaceId,
        sessionId,
        triggerItemId: 1,
        agentId: "agent_test",
        providerId: "provider_test",
        modelId: "model_test",
        status: "running",
        createdAt: now,
        updatedAt: now
      });

    fixture.db
      .prepare(
        `
          insert into channel_reply_job (
            plugin_id, channel_name, account_id, conversation_key,
            workspace_id, session_id, run_id,
            reply_to_external_message_id,
            status, error_text,
            attempt_count, max_attempts,
            created_at, updated_at
          ) values (
            @pluginId, @channelName, @accountId, @conversationKey,
            @workspaceId, @sessionId, @runId,
            @replyToExternalMessageId,
            @status, null,
            @attemptCount, @maxAttempts,
            @createdAt, @updatedAt
          )
        `
      )
      .run({
        pluginId: "feishu",
        channelName: "im",
        accountId: "default",
        conversationKey: "feishu_default_chat_oc_test",
        workspaceId,
        sessionId,
        runId,
        replyToExternalMessageId: "om_test_msg",
        status: "pending",
        attemptCount: 0,
        maxAttempts: 5,
        createdAt: now,
        updatedAt: now
      });

    const whileRunning = listPendingReplyJobs(fixture.db, { limit: 10 });
    assert.equal(whileRunning.length, 0);

    fixture.db
      .prepare(
        `
          update agent_run
          set status='completed', updated_at=@updatedAt
          where run_id=@runId
        `
      )
      .run({ runId, updatedAt: now + 1000 });

    const afterCompleted = listPendingReplyJobs(fixture.db, { limit: 10 });
    assert.equal(afterCompleted.length, 1);
    assert.equal(afterCompleted[0]?.runId, runId);
    assert.equal(afterCompleted[0]?.status, "pending");
  } finally {
    await disposeFixture(fixture);
  }
});
