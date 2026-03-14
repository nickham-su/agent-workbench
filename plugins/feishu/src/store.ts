import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type ChatBinding = {
  chatKey: string;
  chatId: string;
  chatType: "direct" | "group";
  workspaceId: string | null;
  sessionId: string | null;
  agentId: string | null;
  updatedAt: number;
};

export type ChatPolicy = "self_only" | "session_all";

function ensureDir(dirPath: string) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function moveFileWithFallback(fromPath: string, toPath: string) {
  try {
    fs.renameSync(fromPath, toPath);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") {
      throw error;
    }
  }

  fs.copyFileSync(fromPath, toPath);
  fs.unlinkSync(fromPath);
}

function removeLegacyPluginDir(legacyPluginDir: string) {
  if (!fs.existsSync(legacyPluginDir)) return;
  try {
    fs.rmSync(legacyPluginDir, { recursive: true, force: true });
  } catch {
  }
}

function migrateLegacyDbIfNeeded(params: {
  legacyPluginDir: string;
  legacyDbPath: string;
  currentDbDir: string;
  currentDbPath: string;
}) {
  const legacyManifestPath = path.join(params.legacyPluginDir, "agent-workbench.plugin.json");
  if (!fs.existsSync(params.legacyDbPath) || fs.existsSync(legacyManifestPath)) {
    return;
  }

  ensureDir(params.currentDbDir);

  if (!fs.existsSync(params.currentDbPath)) {
    moveFileWithFallback(params.legacyDbPath, params.currentDbPath);
  } else {
    fs.rmSync(params.legacyDbPath, { force: true });
  }

  for (const suffix of ["-wal", "-shm"]) {
    const legacySidecar = `${params.legacyDbPath}${suffix}`;
    const currentSidecar = `${params.currentDbPath}${suffix}`;
    if (!fs.existsSync(legacySidecar)) {
      continue;
    }
    if (!fs.existsSync(currentSidecar)) {
      moveFileWithFallback(legacySidecar, currentSidecar);
    } else {
      fs.rmSync(legacySidecar, { force: true });
    }
  }

  removeLegacyPluginDir(params.legacyPluginDir);
}

export function createFeishuStore(params: { dataDir: string }) {
  const dbDir = path.join(params.dataDir, "plugin-data", "feishu");
  ensureDir(dbDir);

  const legacyPluginDir = path.join(params.dataDir, "plugins", "feishu");
  const legacyDbPath = path.join(legacyPluginDir, "feishu.sqlite");
  const dbPath = path.join(dbDir, "feishu.sqlite");

  migrateLegacyDbIfNeeded({
    legacyPluginDir,
    legacyDbPath,
    currentDbDir: dbDir,
    currentDbPath: dbPath
  });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    create table if not exists chat_binding (
      chat_key text primary key,
      chat_id text not null,
      chat_type text not null,
      workspace_id text,
      session_id text,
      agent_id text,
      updated_at integer not null
    );

    create table if not exists chat_policy (
      chat_key text primary key,
      policy text not null,
      updated_at integer not null
    );

    create table if not exists run_map (
      run_id text primary key,
      chat_key text not null,
      message_id text not null,
      created_at integer not null
    );

    create table if not exists sent_dedup (
      event_id text not null,
      chat_key text not null,
      run_id text not null,
      created_at integer not null,
      primary key(event_id, chat_key)
    );

    create index if not exists idx_chat_binding_session_id on chat_binding(session_id);
    create index if not exists idx_run_map_chat_key on run_map(chat_key);
  `);

  function now() {
    return Date.now();
  }

  function normalizePolicy(raw: unknown): ChatPolicy {
    return raw === "session_all" ? "session_all" : "self_only";
  }

  return {
    close() {
      db.close();
    },
    getBinding(chatKey: string): ChatBinding | null {
      const row = db
        .prepare(
          `select chat_key as chatKey, chat_id as chatId, chat_type as chatType, workspace_id as workspaceId, session_id as sessionId, agent_id as agentId, updated_at as updatedAt from chat_binding where chat_key=?`
        )
        .get(chatKey) as ChatBinding | undefined;
      return row ?? null;
    },
    upsertBinding(input: { chatKey: string; chatId: string; chatType: "direct" | "group"; workspaceId?: string | null; sessionId?: string | null; agentId?: string | null }) {
      const ts = now();
      db.prepare(
        `
        insert into chat_binding(chat_key,chat_id,chat_type,workspace_id,session_id,agent_id,updated_at)
        values(@chatKey,@chatId,@chatType,@workspaceId,@sessionId,@agentId,@updatedAt)
        on conflict(chat_key) do update set
          chat_id=excluded.chat_id,
          chat_type=excluded.chat_type,
          workspace_id=excluded.workspace_id,
          session_id=excluded.session_id,
          agent_id=excluded.agent_id,
          updated_at=excluded.updated_at
      `
      ).run({
        chatKey: input.chatKey,
        chatId: input.chatId,
        chatType: input.chatType,
        workspaceId: input.workspaceId ?? null,
        sessionId: input.sessionId ?? null,
        agentId: input.agentId ?? null,
        updatedAt: ts
      });
      return this.getBinding(input.chatKey);
    },
    setSession(chatKey: string, sessionId: string, workspaceId: string) {
      const current = this.getBinding(chatKey);
      if (!current) return null;
      return this.upsertBinding({
        chatKey,
        chatId: current.chatId,
        chatType: current.chatType,
        workspaceId,
        sessionId,
        agentId: current.agentId
      });
    },
    setAgent(chatKey: string, agentId: string) {
      const current = this.getBinding(chatKey);
      if (!current) return null;
      return this.upsertBinding({
        chatKey,
        chatId: current.chatId,
        chatType: current.chatType,
        workspaceId: current.workspaceId,
        sessionId: current.sessionId,
        agentId
      });
    },
    getPolicy(chatKey: string): ChatPolicy {
      const row = db.prepare(`select policy from chat_policy where chat_key=?`).get(chatKey) as { policy: string } | undefined;
      return normalizePolicy(row?.policy);
    },
    togglePolicy(chatKey: string): ChatPolicy {
      const current = this.getPolicy(chatKey);
      const next: ChatPolicy = current === "self_only" ? "session_all" : "self_only";
      db.prepare(
        `insert into chat_policy(chat_key,policy,updated_at) values(?,?,?) on conflict(chat_key) do update set policy=excluded.policy, updated_at=excluded.updated_at`
      ).run(chatKey, next, now());
      return next;
    },
    mapRun(runId: string, chatKey: string, messageId: string) {
      db.prepare(`insert or replace into run_map(run_id,chat_key,message_id,created_at) values(?,?,?,?)`).run(runId, chatKey, messageId, now());
    },
    getRunMap(runId: string): { chatKey: string; messageId: string } | null {
      const row = db.prepare(`select chat_key as chatKey, message_id as messageId from run_map where run_id=?`).get(runId) as
        | { chatKey: string; messageId: string }
        | undefined;
      return row ?? null;
    },
    deleteRunMap(runId: string) {
      db.prepare(`delete from run_map where run_id=?`).run(runId);
    },
    hasSent(eventId: string, chatKey: string): boolean {
      const row = db.prepare(`select 1 as ok from sent_dedup where event_id=? and chat_key=?`).get(eventId, chatKey) as { ok: number } | undefined;
      return Boolean(row?.ok);
    },
    saveSent(eventId: string, chatKey: string, runId: string): boolean {
      const result = db.prepare(`insert or ignore into sent_dedup(event_id,chat_key,run_id,created_at) values(?,?,?,?)`).run(eventId, chatKey, runId, now());
      return Number(result.changes) > 0;

    },
    listBindingsBySession(sessionId: string): ChatBinding[] {
      const rows = db
        .prepare(
          `select chat_key as chatKey, chat_id as chatId, chat_type as chatType, workspace_id as workspaceId, session_id as sessionId, agent_id as agentId, updated_at as updatedAt from chat_binding where session_id=?`
        )
        .all(sessionId) as ChatBinding[];
      return rows;
    }
  };
}

export type FeishuStore = ReturnType<typeof createFeishuStore>;
