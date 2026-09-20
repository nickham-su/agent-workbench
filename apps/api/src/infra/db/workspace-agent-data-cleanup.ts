import type { Db } from "./db.js";

/**
 * Workspace 删除中的 Agent 数据库清理原语。
 *
 * 这是纯数据库事务步骤：调用方负责 deleting fence 与 Worker 收敛；本阶段不提前
 * 实现这些运行时协调。所有删除都显式绑定 workspaceId，避免共享 Message 图误伤。
 */
export function deleteWorkspaceAgentData(db: Db, workspaceId: string) {
  const ftsRowIds = db.prepare(`
    select map.fts_rowid as ftsRowid
    from agent_text_part_fts_map map
    join agent_message_part part on part.id = map.part_id
    join agent_message message on message.id = part.message_id
    where message.workspace_id = ?
  `).all(workspaceId) as Array<{ ftsRowid: number }>;

  const deleteFtsRow = db.prepare("delete from agent_archived_text_fts where rowid = ?");
  for (const row of ftsRowIds) deleteFtsRow.run(row.ftsRowid);

  db.prepare(`
    delete from agent_text_part_fts_map
    where part_id in (
      select part.id
      from agent_message_part part
      join agent_message message on message.id = part.message_id
      where message.workspace_id = ?
    )
  `).run(workspaceId);

  db.prepare("delete from agent_client_request where workspace_id = ?").run(workspaceId);
  db.prepare("delete from session_run_state where workspace_id = ?").run(workspaceId);

  db.prepare("delete from agent_session_agent_model_override where session_id in (select id from agent_session where workspace_id = ?)").run(workspaceId);

  // ToolExecution 的 call_part_id 为 RESTRICT，必须先于 MessagePart 删除。
  db.prepare(`
    delete from agent_tool_execution
    where call_part_id in (
      select part.id
      from agent_message_part part
      join agent_message message on message.id = part.message_id
      where message.workspace_id = ?
    )
  `).run(workspaceId);

  db.prepare(`
    delete from agent_message_part
    where message_id in (select id from agent_message where workspace_id = ?)
  `).run(workspaceId);

  // Run/Session 对 Message 的外键均为 RESTRICT；按设计固定顺序显式解除。
  // 删除 Run/Session 会分别以 SET NULL 解除 Message/Execution 的 origin 引用。
  db.prepare("delete from agent_run where workspace_id = ?").run(workspaceId);
  db.prepare("delete from agent_session where workspace_id = ?").run(workspaceId);

  // Message 三条边均不可改写；按“引用者先于被引用者”的逆拓扑批量删除。
  const selectLeaves = db.prepare(`
    select message.id
    from agent_message message
    where message.workspace_id = @workspaceId
      and not exists (
        select 1 from agent_message ref
        where ref.workspace_id = @workspaceId and (
          ref.previous_message_id = message.id
          or ref.replaces_message_id = message.id
          or ref.retained_from_message_id = message.id
        )
      )
    order by message.depth desc, message.id asc
    limit 200
  `);
  const deleteMessage = db.prepare("delete from agent_message where id = ? and workspace_id = ?");
  while (true) {
    const ids = (selectLeaves.all({ workspaceId }) as Array<{ id: string }>).map((row) => row.id);
    if (ids.length === 0) break;
    for (const id of ids) deleteMessage.run(id, workspaceId);
  }
  const remaining = db.prepare("select count(*) as count from agent_message where workspace_id = ?").get(workspaceId) as { count: number };
  if (remaining.count !== 0) throw new Error("agent message graph contains a cycle during workspace cleanup");

  // 不删除其他 Workspace 使用的附件；附件实体本身按 Workspace 拥有。
  db.prepare("delete from agent_attachment where workspace_id = ?").run(workspaceId);
}
