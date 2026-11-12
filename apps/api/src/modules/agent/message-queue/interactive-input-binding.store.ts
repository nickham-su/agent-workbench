import { AGENT_QUEUE_INPUT_POLICY_VERSION, type AgentEffectiveInputPolicy } from "@agent-workbench/shared";
import type { AgentInteractiveInputBinding } from "@agent-workbench/shared/internal-contracts/agent-api";
import type { Db } from "../../../infra/db/db.js";
import { HttpError } from "../../../app/errors.js";
import { assertSessionRuntimeUnblocked } from "../runtime-control/runtime-control.store.js";

export type InteractiveScope = { workspaceId: string; sessionId: string; runId: string };
export type InputBindingSource = "worker_model" | "local_fallback";
type BindingRow = {
  workspace_id: string; session_id: string; run_id: string; assistant_message_id: string;
  snapshot_hash: string; input_revision: number; source: InputBindingSource;
  state: "active" | "superseded"; input_receipt_ids_json: string; replaces_assistant_id: string | null;
};
const conflict = (message: string) => new HttpError(409, message, "AGENT_INTERACTIVE_INPUT_BINDING_CONFLICT");

export function interactiveRunEnabled(db: Db, scope: InteractiveScope): boolean {
  return !!db.prepare("select 1 from agent_run where workspace_id=? and session_id=? and run_id=? and run_kind='user' and interactive_queue_enabled=1")
    .get(scope.workspaceId, scope.sessionId, scope.runId);
}

/** UNION, not UNION ALL: malformed cyclic historical pointers cannot make this query unbounded. */
export function inputAncestryMessageIds(db: Db, scope: { workspaceId: string; sessionId: string }): string[] {
  return (db.prepare(`with recursive ancestry(id) as (
    select head_message_id from agent_session where workspace_id=? and id=? and head_message_id is not null
    union select m.previous_message_id from agent_message m join ancestry a on m.id=a.id
      where m.workspace_id=? and m.previous_message_id is not null
  ) select m.id from agent_message m join ancestry a on a.id=m.id where m.workspace_id=? order by m.depth,m.id`)
    .all(scope.workspaceId, scope.sessionId, scope.workspaceId, scope.workspaceId) as Array<{ id: string }>).map(row => row.id);
}

/** Metadata is selected by authorized ancestry, including shared-source forks, never by an arbitrary receipt list. */
export function readEffectiveInputPolicy(db: Db, scope: { workspaceId: string; sessionId: string; runId?: string }, messageIds?: readonly string[]): AgentEffectiveInputPolicy {
  const ids = messageIds ?? inputAncestryMessageIds(db, scope);
  const rows = db.prepare(`select r.id,r.message_id,(r.injected_run_id=?) as current_run_input
    from agent_user_message_receipt r join agent_message m on m.id=r.message_id
    where r.workspace_id=? and r.status='injected' and r.message_id in (select value from json_each(?))
    order by m.depth,m.id`).all(scope.runId ?? "", scope.workspaceId, JSON.stringify(ids)) as Array<{
      id: string; message_id: string; current_run_input: number;
    }>;
  const inputs = rows.map(row => ({
    receiptId: row.id, messageId: row.message_id, currentRunInput: row.current_run_input === 1,
    attachments: db.prepare(`select a.id as attachmentId,ra.byte_sha256 as byteSha256,a.byte_size as byteSize
      from agent_user_message_receipt_attachment ra join agent_attachment a on a.id=ra.attachment_id
      where ra.receipt_id=? and a.workspace_id=? order by ra.position`).all(row.id, scope.workspaceId) as Array<{ attachmentId: string; byteSha256: string; byteSize: number }>
  }));
  // A fresh stream cannot merge unknown persisted Parts. Expose a reusable
  // claim only for an empty continuation; otherwise Worker replaces/rebinds.
  const active = scope.runId == null ? undefined : db.prepare(`select b.* from agent_queue_input_binding b
    join session_run_state s on s.workspace_id=b.workspace_id and s.session_id=b.session_id
      and s.active_run_id=b.run_id and s.active_assistant_message_id=b.assistant_message_id
    where b.workspace_id=? and b.session_id=? and b.run_id=? and b.state='active'
      and not exists(select 1 from agent_message_part p where p.message_id=b.assistant_message_id)`)
    .get(scope.workspaceId, scope.sessionId, scope.runId) as BindingRow | undefined;
  return { version: AGENT_QUEUE_INPUT_POLICY_VERSION,
    ...(active ? { activeAssistantBinding: { messageId: active.assistant_message_id, inputBinding: {
      inputReceiptIds: boundReceiptIds(db, active.assistant_message_id), effectiveInputPolicyVersion: AGENT_QUEUE_INPUT_POLICY_VERSION,
      snapshotHash: active.snapshot_hash, inputRevision: active.input_revision
    } } } : {}),
    interactive: scope.runId != null && interactiveRunEnabled(db, { ...scope, runId: scope.runId }),
    inputReceiptIds: inputs.filter(row => row.currentRunInput).map(row => row.receiptId), inputs };
}

function readBinding(db: Db, messageId: string): BindingRow | null {
  return db.prepare("select * from agent_queue_input_binding where assistant_message_id=?").get(messageId) as BindingRow | undefined ?? null;
}
function boundReceiptIds(db: Db, messageId: string): string[] {
  const row = readBinding(db, messageId);
  return row ? JSON.parse(row.input_receipt_ids_json) as string[] : [];
}
const equalIds = (a: readonly string[], b: readonly string[]) => {
  const left = [...a].sort(), right = [...b].sort();
  return left.length === right.length && left.every((id, index) => id === right[index]);
};

function assertMetadataMatches(row: BindingRow, binding: AgentInteractiveInputBinding, ids: readonly string[], source: InputBindingSource) {
  if (row.snapshot_hash !== binding.snapshotHash || row.input_revision !== binding.inputRevision || row.source !== source || !equalIds(ids, binding.inputReceiptIds))
    throw conflict("Assistant input snapshot changed");
}

/** Called inside the same transaction as Assistant creation. */
export function bindInteractiveAssistant(db: Db, input: InteractiveScope & {
  messageId: string; inputBinding?: AgentInteractiveInputBinding; source: InputBindingSource; createdAt: number;
}) {
  const enabled = interactiveRunEnabled(db, input);
  if (!enabled) { if (input.inputBinding) throw conflict("Non-interactive Run cannot bind queued inputs"); return; }
  const binding = input.inputBinding;
  if (!binding || binding.effectiveInputPolicyVersion !== AGENT_QUEUE_INPUT_POLICY_VERSION) throw conflict("Interactive Run requires a trusted input snapshot");
  const existing = readBinding(db, input.messageId);
  if (existing) {
    if (existing.workspace_id !== input.workspaceId || existing.session_id !== input.sessionId || existing.run_id !== input.runId) throw conflict("Assistant input scope changed");
    assertMetadataMatches(existing, binding, boundReceiptIds(db, input.messageId), input.source);
    return;
  }
  assertSessionRuntimeUnblocked(db, input.workspaceId, input.sessionId);
  const policy = readEffectiveInputPolicy(db, input);
  if (!equalIds(policy.inputReceiptIds, binding.inputReceiptIds)) throw conflict("Prepared input set is stale");
  // appendStreamingAssistant has just moved revision once; a replay never comes through this branch.
  const session = db.prepare("select revision from agent_session where workspace_id=? and id=?").get(input.workspaceId, input.sessionId) as { revision: number };
  if (session.revision !== binding.inputRevision + 1) throw conflict("Prepared input revision is stale");
  insertBinding(db, input, binding, null);
}

function insertBinding(db: Db, input: InteractiveScope & { messageId: string; source: InputBindingSource; createdAt: number }, binding: AgentInteractiveInputBinding, replaces: string | null) {
  db.prepare(`insert into agent_queue_input_binding(workspace_id,session_id,assistant_message_id,run_id,snapshot_hash,input_revision,source,state,replaces_assistant_id,input_receipt_ids_json,created_at)
    values (?,?,?,?,?,?,?,'active',?,?,?)`).run(input.workspaceId, input.sessionId, input.messageId, input.runId,
      binding.snapshotHash, binding.inputRevision, input.source, replaces, JSON.stringify([...binding.inputReceiptIds].sort()), input.createdAt);

}

/** Same-model retries inherit; a recovery attempt must explicitly prove its freshly prepared input. */
export function replaceInteractiveAssistantBinding(db: Db, input: InteractiveScope & {
  oldMessageId: string; newMessageId: string; mode?: "retry_same_input" | "recovery_reprepare";
  inputBinding?: AgentInteractiveInputBinding; source: InputBindingSource; createdAt: number;
}) {
  if (!interactiveRunEnabled(db, input)) { if (input.inputBinding) throw conflict("Non-interactive binding"); return; }
  if (!input.inputBinding || !input.mode) throw conflict("Interactive replacement requires an explicit input binding mode");
  const old = readBinding(db, input.oldMessageId);
  if (!old || old.run_id !== input.runId || old.workspace_id !== input.workspaceId || old.session_id !== input.sessionId || old.source !== input.source) throw conflict("Original input binding is unavailable");
  const ids = boundReceiptIds(db, input.oldMessageId);
  const inherited: AgentInteractiveInputBinding = { inputReceiptIds: ids, effectiveInputPolicyVersion: AGENT_QUEUE_INPUT_POLICY_VERSION, snapshotHash: old.snapshot_hash, inputRevision: old.input_revision };
  const binding = input.inputBinding ?? inherited;
  if (input.mode !== "recovery_reprepare") assertMetadataMatches(old, binding, ids, input.source);
  const existing = readBinding(db, input.newMessageId);
  if (existing) {
    if (existing.replaces_assistant_id !== input.oldMessageId || existing.run_id !== input.runId) throw conflict("Replacement binding changed");
    assertMetadataMatches(existing, binding, boundReceiptIds(db, input.newMessageId), input.source); return;
  }
  if (input.mode === "recovery_reprepare") {
    if (!input.inputBinding || binding.effectiveInputPolicyVersion !== AGENT_QUEUE_INPUT_POLICY_VERSION || !equalIds(readEffectiveInputPolicy(db, input).inputReceiptIds, binding.inputReceiptIds)) throw conflict("Recovery input set changed");
    const session = db.prepare("select revision from agent_session where workspace_id=? and id=?").get(input.workspaceId, input.sessionId) as { revision: number };
    if (session.revision !== binding.inputRevision + 1) throw conflict("Recovery input revision changed");
  }
  if (old.state !== "active") throw conflict("Original input binding is not active");
  db.prepare("update agent_queue_input_binding set state='superseded' where assistant_message_id=? and state='active'").run(input.oldMessageId);
  insertBinding(db, { ...input, messageId: input.newMessageId }, binding, input.oldMessageId);
}

export function claimInteractiveAssistantBinding(db: Db, input: InteractiveScope & { messageId: string; inputBinding?: AgentInteractiveInputBinding; source: InputBindingSource }): boolean {
  if (!interactiveRunEnabled(db, input)) return !input.inputBinding;
  const row = readBinding(db, input.messageId);
  if (!row || row.state !== "active" || row.workspace_id !== input.workspaceId || row.session_id !== input.sessionId
    || row.run_id !== input.runId || !input.inputBinding
    || input.inputBinding.effectiveInputPolicyVersion !== AGENT_QUEUE_INPUT_POLICY_VERSION
    || db.prepare("select 1 from agent_message_part where message_id=? limit 1").get(input.messageId)
    || !equalIds(readEffectiveInputPolicy(db, input).inputReceiptIds, input.inputBinding.inputReceiptIds)) return false;
  try { assertMetadataMatches(row, input.inputBinding, boundReceiptIds(db, input.messageId), input.source); return true; } catch { return false; }
}

/** Completion still validates snapshot ownership; it does not acknowledge or change inputs. */
export function assertInteractiveAssistantBinding(db: Db, input: InteractiveScope & { messageId: string; source: InputBindingSource }) {
  if (!interactiveRunEnabled(db, input)) return;
  const binding = readBinding(db, input.messageId);
  if (!binding || binding.workspace_id !== input.workspaceId || binding.session_id !== input.sessionId
    || binding.run_id !== input.runId || binding.source !== input.source || binding.state !== "active")
    throw conflict("Assistant input snapshot is unavailable");
}
