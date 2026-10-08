import {
  AGENT_SESSION_QUERY_ERROR_CODES,
  type AgentSessionQueryItem,
  type AgentSessionQueryResponse
} from "@agent-workbench/shared/contracts/agent-session-query";
import { HttpError } from "../../../app/errors.js";
import type { Db } from "../../../infra/db/db.js";
import type { SessionActivityQuery } from "./session-activity-query.js";

const DATE_LIMIT = 8_640_000_000_000_000;
const CANDIDATE_CONDITION = `s.workspace_id = @workspaceId
  and s.updated_at >= @updatedFrom and s.updated_at <= @updatedTo
  and (@kind = 'all' or s.kind = @kind)`;
const invalidState = () => new HttpError(500, "invalid session query state", AGENT_SESSION_QUERY_ERROR_CODES.stateInvalid);

type CandidateRow = { id: unknown; title: unknown; kind: unknown; status: unknown; createdAt: unknown; updatedAt: unknown };
type CountRow = { sessionId: string; userMessageCount: unknown; completedAssistantMessageCount: unknown };

function safeInteger(value: unknown): number {
  // Also tolerate a connection configured with defaultSafeIntegers without rounding its results.
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number)) throw invalidState();
  return number;
}

function timestamp(value: unknown): number {
  const number = safeInteger(value);
  if (Math.abs(number) > DATE_LIMIT) throw invalidState();
  return number;
}

function count(value: unknown): number {
  const number = safeInteger(value);
  if (number < 0) throw invalidState();
  return number;
}

/** Independent read side: metadata, current state and retained native message counts only. */
export class SqliteSessionActivityQuery {
  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {}

  querySessions(input: SessionActivityQuery): AgentSessionQueryResponse {
    return this.db.transaction((): AgentSessionQueryResponse => {
      if (!this.db.prepare("select 1 from workspaces where id = ?").get(input.workspaceId)) {
        throw new HttpError(404, "workspace not found", "WORKSPACE_NOT_FOUND");
      }
      const updatedTo = timestamp(this.now());
      const updatedFrom = timestamp(updatedTo - input.updatedWithinSeconds * 1000);
      const params = { ...input, updatedFrom, updatedTo };
      const rows = this.db.prepare(`select s.id, s.title, s.kind,
          s.created_at as createdAt, s.updated_at as updatedAt, r.status
        from agent_session s left join session_run_state r
          on r.workspace_id = s.workspace_id and r.session_id = s.id
        where ${CANDIDATE_CONDITION}
        order by s.updated_at desc, s.id collate binary desc`).all(params) as CandidateRow[];
      // Validate all time/kind candidates before status filtering. An INNER JOIN or SQL status
      // predicate here would conceal missing/corrupt RunState and turn failure into partial success.
      const candidates: AgentSessionQueryItem[] = rows.map((row) => {
        if (typeof row.id !== "string" || row.id.length === 0 || typeof row.title !== "string"
          || (row.kind !== "primary" && row.kind !== "subtask")
          || (row.status !== "idle" && row.status !== "running")) throw invalidState();
        return {
          id: row.id, title: row.title, kind: row.kind, status: row.status,
          createdAt: timestamp(row.createdAt), updatedAt: timestamp(row.updatedAt),
          userMessageCount: 0, completedAssistantMessageCount: 0
        };
      });
      const items = candidates.filter((item) => input.status === "all" || item.status === input.status);
      if (items.length > 0) {
        // One batched aggregate, not a join with multiple detail tables or an unbounded ID-IN list.
        // Message timestamps, current context pointers and Run terminal outcomes are irrelevant.
        const counts = this.db.prepare(`with candidates as (
          select s.id from agent_session s join session_run_state r
            on r.workspace_id = s.workspace_id and r.session_id = s.id
          where ${CANDIDATE_CONDITION} and (@status = 'all' or r.status = @status)
        ) select m.origin_session_id as sessionId,
          sum(case when m.type = 'user' then 1 else 0 end) as userMessageCount,
          sum(case when m.type = 'assistant' then 1 else 0 end) as completedAssistantMessageCount
        from agent_message m join candidates c on c.id = m.origin_session_id
        where m.workspace_id = @workspaceId and m.status = 'completed'
          and m.type in ('user', 'assistant')
        group by m.origin_session_id`).all(params) as CountRow[];
        const bySession = new Map(counts.map((row) => [row.sessionId, {
          userMessageCount: count(row.userMessageCount),
          completedAssistantMessageCount: count(row.completedAssistantMessageCount)
        }]));
        for (const item of items) Object.assign(item, bySession.get(item.id));
      }
      return {
        workspaceId: input.workspaceId, updatedWithinSeconds: input.updatedWithinSeconds,
        updatedFrom, updatedTo, kind: input.kind, status: input.status, total: items.length, items
      };
    }).deferred();
  }
}
