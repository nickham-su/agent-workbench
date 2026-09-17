import type { AgentSessionRecord } from "@agent-workbench/shared/internal-contracts/agent-api-session";
import type { AgentMessageSessionRunState } from "@agent-workbench/shared";
import { HttpError } from "../../../app/errors.js";
import type { Db } from "../../../infra/db/db.js";
import {
  createMessageSession,
  forkMessageSession,
  getMessageRunState,
  getMessageSession,
  getMessageSessionById,
  hasNonTerminalVisibleMessageWork,
  moveMessageHead
} from "../agent-message.store.js";
import { findMessageClientRequestDedup, listMessageSessions, setManualMessageSessionTitle } from "../agent-message.store.js";
import type { SessionCloneInput, SessionCreateInput, SessionInteractionStore } from "./session-interaction-ports.js";

/**
 * Session 交互的持久化入口只操作 Message 图，不保留旧模型读写兼容路径。
 */
export class SqliteSessionInteractionStore implements SessionInteractionStore {
  constructor(private readonly dependencies: {
    db: Db;
    getControlRunState(sessionId: string): AgentMessageSessionRunState;
    workspaceExists(workspaceId: string): boolean;
  }) {}

  workspaceExists(workspaceId: string) { return this.dependencies.workspaceExists(workspaceId); }
  getSession(sessionId: string): AgentSessionRecord | null { return getMessageSessionById(this.dependencies.db, sessionId); }
  listSessions(workspaceId: string): AgentSessionRecord[] { return listMessageSessions(this.dependencies.db, workspaceId); }
  createSession(input: SessionCreateInput): void {
    createMessageSession(this.dependencies.db, input);
  }
  setManualTitle(input: { sessionId: string; workspaceId: string; title: string }): boolean {
    return setManualMessageSessionTitle(this.dependencies.db, input);
  }
  findClientRequestDedup(input: { workspaceId: string; sessionId: string; clientRequestId: string }) {
    return findMessageClientRequestDedup(this.dependencies.db, input);
  }
  getRunState(workspaceId: string, sessionId: string) {
    const state = getMessageRunState(this.dependencies.db, workspaceId, sessionId);
    return { status: state?.status ?? "idle" };
  }
  getControlRunState(sessionId: string) { return this.dependencies.getControlRunState(sessionId); }

  hasNonTerminalItems(workspaceId: string, sessionId: string): boolean {
    const state = getMessageRunState(this.dependencies.db, workspaceId, sessionId);
    return !!state && (state.nonTerminalMessageIds.length > 0 || state.nonTerminalToolExecutionIds.length > 0 || hasNonTerminalVisibleMessageWork(this.dependencies.db, { workspaceId, sessionId }));
  }
  moveHead(input: { workspaceId: string; sessionId: string; expectedHeadMessageId: string | null; expectedRevision: number; nextHeadMessageId: string; updatedAt: number }): void {
    moveMessageHead(this.dependencies.db, input);
  }

  async cloneSession(input: SessionCloneInput): Promise<AgentSessionRecord> {
    const source = getMessageSession(this.dependencies.db, input.fromSession.workspaceId, input.fromSession.id);
    if (!source) throw new HttpError(404, "source session not found");
    const forked = forkMessageSession(this.dependencies.db, {
      id: input.id,
      workspaceId: source.workspaceId,
      sourceSessionId: source.id,
      expectedHeadMessageId: source.headMessageId,
      expectedRevision: source.revision,
      targetMessageId: input.fromMessageId,
      title: (input.title || `${source.title} (fork)`).trim() || `${source.title} (fork)`,
      kind: input.targetKind,
      allowSourceWithActiveRun: input.allowSourceWithActiveRun,
      createdAt: input.createdAt
    });
    const result = getMessageSessionById(this.dependencies.db, forked.id);
    if (!result) throw new HttpError(500, "failed to create fork session");
    return result;
  }
}
