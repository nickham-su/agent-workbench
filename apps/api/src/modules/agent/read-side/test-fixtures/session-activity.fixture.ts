import Database from "better-sqlite3";

type SessionSeed = {
  id: string;
  workspaceId?: string;
  title?: string;
  kind?: "primary" | "subtask";
  visibility?: "listed" | "unlisted";
  updatedAt?: number;
  createdAt?: number;
  headMessageId?: string | null;
  contextRootMessageId?: string | null;
  forkedFromSessionId?: string | null;
  // null deliberately creates a missing RunState; arbitrary strings exercise corruption handling.
  status?: string | null;
  activeRunId?: string | null;
};
type MessageSeed = {
  id: string;
  workspaceId?: string;
  originSessionId: string | null;
  originRunId?: string | null;
  type: "user" | "assistant" | "system" | "compaction" | "runtime";
  status?: "streaming" | "completed" | "failed" | "cancelled" | "superseded";
  createdAt?: number;
  updatedAt?: number;
};

/** Separate in-memory activity fixture: no Parts, model configuration or Analytics tables. */
export function createSessionActivityFixture() {
  const db = new Database(":memory:");
  db.exec(`
    create table workspaces (id text primary key);
    create table agent_session (
      id text primary key, workspace_id text, title text, kind text,
      head_message_id text, context_root_message_id text, revision integer,
      forked_from_session_id text, forked_from_message_id text, created_at integer, updated_at integer, visibility text
    );
    create table session_run_state (
      workspace_id text, session_id text, status text, active_run_id text,
      primary key (workspace_id, session_id)
    );
    create table agent_run (
      run_id text primary key, workspace_id text, session_id text, agent_id text,
      status text, run_kind text, created_at integer, updated_at integer
    );
    create table agent_message (
      id text primary key, workspace_id text, origin_session_id text, origin_run_id text,
      type text, status text, created_at integer, updated_at integer
    );
    create index idx_agent_message_origin_session on agent_message (origin_session_id);
    insert into workspaces values ('a'), ('b');
  `);
  const sessionInsert = db.prepare(`insert into agent_session
    (id, workspace_id, title, kind, head_message_id, context_root_message_id, revision,
      forked_from_session_id, forked_from_message_id, created_at, updated_at, visibility)
    values (?, ?, ?, ?, ?, ?, 0, ?, null, ?, ?, ?)`);
  const stateInsert = db.prepare("insert into session_run_state (workspace_id, session_id, status, active_run_id) values (?, ?, ?, ?)");
  const messageInsert = db.prepare(`insert into agent_message
    (id, workspace_id, origin_session_id, origin_run_id, type, status, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, ?)`);
  return {
    db,
    insertSession(seed: SessionSeed) {
      const workspaceId = seed.workspaceId ?? "a";
      sessionInsert.run(seed.id, workspaceId, seed.title ?? "", seed.kind ?? "primary",
        seed.headMessageId ?? null, seed.contextRootMessageId ?? null, seed.forkedFromSessionId ?? null,
        seed.createdAt ?? 1, seed.updatedAt ?? 10, seed.visibility ?? "listed");
      if (seed.status !== null) stateInsert.run(workspaceId, seed.id, seed.status ?? "idle", seed.activeRunId ?? null);
    },
    insertRun(seed: {
      id: string; sessionId: string; agentId: string; workspaceId?: string;
      status?: string; kind?: "user" | "manual_compaction" | "subtask";
      createdAt: number; updatedAt?: number;
    }) {
      db.prepare(`insert into agent_run
        (run_id, workspace_id, session_id, agent_id, status, run_kind, created_at, updated_at)
        values (?, ?, ?, ?, ?, ?, ?, ?)`).run(seed.id, seed.workspaceId ?? "a", seed.sessionId,
        seed.agentId, seed.status ?? "completed", seed.kind ?? "user", seed.createdAt, seed.updatedAt ?? seed.createdAt);
    },
    insertMessage(seed: MessageSeed) {
      messageInsert.run(seed.id, seed.workspaceId ?? "a", seed.originSessionId, seed.originRunId ?? null,
        seed.type, seed.status ?? "completed", seed.createdAt ?? 1, seed.updatedAt ?? seed.createdAt ?? 1);
    }
  };
}
