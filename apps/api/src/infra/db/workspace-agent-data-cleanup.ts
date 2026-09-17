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

  // 来源外键为 SET NULL；先删除 Run 解除自身/Message/Execution 来源引用。
  db.prepare("delete from agent_run where workspace_id = ?").run(workspaceId);
  db.prepare("delete from agent_session_agent_model_override where session_id in (select id from agent_session where workspace_id = ?)").run(workspaceId);
  db.prepare("delete from agent_session where workspace_id = ?").run(workspaceId);

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

  // 清除同 Workspace 图内自引用后再删 Message，foreign_keys=ON 下仍保持原子性。
  db.prepare(`
    update agent_message
    set previous_message_id = null, replaces_message_id = null
    where workspace_id = ?
  `).run(workspaceId);
  db.prepare("delete from agent_message where workspace_id = ?").run(workspaceId);

  // 不删除其他 Workspace 使用的附件；附件实体本身按 Workspace 拥有。
  db.prepare("delete from agent_attachment where workspace_id = ?").run(workspaceId);
}
