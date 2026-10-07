import Database from "better-sqlite3";
import { registerAgentQueryFunctions } from "../../../infra/db/agent-query-functions.js";
import { SqliteSessionQuery } from "./sqlite-session-query.js";

export function createSessionListFixture(filename = ":memory:") {
  const db = new Database(filename);
  registerAgentQueryFunctions(db);
  db.exec(`create table workspaces(id text primary key);
    create table agent_session(id text primary key, workspace_id text, title text, kind text,
      head_message_id text, context_root_message_id text, revision integer,
      forked_from_session_id text, forked_from_message_id text, created_at integer, updated_at integer);
    create table workspace_session_tab_state(workspace_id text,session_id text,visible integer,updated_at integer,primary key(workspace_id,session_id));
    create index idx_agent_session_workspace_updated on agent_session(workspace_id,updated_at desc);
    insert into workspaces values ('a'),('b');`);
  const insert = db.prepare(`insert into agent_session values (@id,@workspaceId,@title,@kind,@head,null,0,null,null,1,@time)`);
  const add = (id: string, options: { title?: string; kind?: string; head?: string | null; time?: number; workspaceId?: string } = {}) => insert.run({
    id, workspaceId: options.workspaceId ?? "a", title: options.title ?? id, kind: options.kind ?? "primary", head: options.head === undefined ? "head" : options.head, time: options.time ?? 1
  });
  const query = new SqliteSessionQuery(db);
  return { db, add, query };
}
