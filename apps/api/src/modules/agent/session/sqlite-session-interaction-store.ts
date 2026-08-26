import fs from "node:fs/promises";
import type { AgentContextItemRecord, AgentSessionRecord, AgentSessionRunState } from "@agent-workbench/shared";
import { HttpError } from "../../../app/errors.js";
import { agentArchiveSessionDir } from "../../../infra/fs/paths.js";
import type { Db } from "../../../infra/db/db.js";
import {
  appendContextItem,
  createAgentSession,
  findClientRequestDedup,
  getAgentSession,
  getRunState,
  getSessionTranscriptItems,
  getSessionVisibleItems,
  getTranscriptItemById,
  hasNonTerminalSessionItems,
  listAgentSessions,
  moveSessionHead,
  setContextItemsArchiveAt
} from "../agent.store.js";
import type { ArchiveStorage } from "../archive/archive-storage.js";
import type { SessionCloneInput, SessionCreateInput, SessionInteractionStore } from "./session-interaction-ports.js";

export class SqliteSessionInteractionStore implements SessionInteractionStore {
  constructor(private readonly dependencies: {
    db: Db;
    dataDir: string;
    archiveStorage: ArchiveStorage;
    isBoundaryMarkerItem(item: AgentContextItemRecord): boolean;
    buildArchiveLine(item: AgentContextItemRecord): string | null;
    getControlRunState(sessionId: string): AgentSessionRunState;
    workspaceExists(workspaceId: string): boolean;
  }) {}

  workspaceExists(workspaceId: string): boolean {
    return this.dependencies.workspaceExists(workspaceId);
  }

  getSession(sessionId: string): AgentSessionRecord | null {
    return getAgentSession(this.dependencies.db, sessionId);
  }

  listSessions(workspaceId: string): AgentSessionRecord[] {
    return listAgentSessions(this.dependencies.db, workspaceId);
  }

  createSession(input: SessionCreateInput): void {
    createAgentSession(this.dependencies.db, input);
  }

  findClientRequestDedup(input: { workspaceId: string; sessionId: string; clientRequestId: string }) {
    return findClientRequestDedup(this.dependencies.db, input);
  }

  getRunState(workspaceId: string, sessionId: string) {
    return getRunState(this.dependencies.db, workspaceId, sessionId);
  }

  getControlRunState(sessionId: string) {
    return this.dependencies.getControlRunState(sessionId);
  }

  getTranscriptItem(sessionId: string, workspaceId: string, itemId: number) {
    return getTranscriptItemById(this.dependencies.db, workspaceId, sessionId, itemId);
  }

  hasNonTerminalItems(workspaceId: string, sessionId: string): boolean {
    return hasNonTerminalSessionItems(this.dependencies.db, workspaceId, sessionId);
  }

  moveHead(input: { workspaceId: string; sessionId: string; expectedHeadItemId: number | null; nextHeadItemId: number; updatedAt: number }): void {
    moveSessionHead(this.dependencies.db, input);
  }

  async cloneSession(input: SessionCloneInput): Promise<AgentSessionRecord> {
    const { fromSession } = input;
    const transcript = getSessionTranscriptItems(this.dependencies.db, fromSession.workspaceId, fromSession.id);
    const targetIndex = transcript.findIndex((item) => item.id === input.fromItemId);
    if (targetIndex < 0) throw new HttpError(400, "invalid fromItemId");
    const target = transcript[targetIndex];
    if (!target) throw new HttpError(400, "invalid fromItemId");
    if (input.boundaryPolicy === "public-user-assistant" && target.kind !== "user" && target.kind !== "assistant") {
      throw new HttpError(400, "fromItemId must be user or assistant", "AGENT_FORK_ITEM_KIND_INVALID");
    }

    let cloned: AgentContextItemRecord[] = [];
    const archivedSourceItemIds = new Set<number>();
    if (input.mode === "visible_only") {
      if (target.archiveAt != null) throw new HttpError(400, "fromItemId is archived", "AGENT_ARCHIVED_ITEM_IMMUTABLE");
      const visible = getSessionVisibleItems(this.dependencies.db, fromSession.workspaceId, fromSession.id);
      const visibleIndex = visible.findIndex((item) => item.id === input.fromItemId);
      if (visibleIndex < 0) throw new HttpError(400, "invalid fromItemId");
      cloned = visible.slice(0, visibleIndex + 1);
    } else {
      cloned = transcript.slice(0, targetIndex + 1);
      if (target.archiveAt == null) {
        for (const item of cloned) if (item.archiveAt != null) archivedSourceItemIds.add(item.id);
      } else {
        let boundaryIndex = -1;
        for (let i = targetIndex; i >= 0; i -= 1) {
          const item = transcript[i];
          if (item && this.dependencies.isBoundaryMarkerItem(item)) {
            boundaryIndex = i;
            break;
          }
        }
        if (boundaryIndex > 0) {
          for (let i = 0; i < boundaryIndex; i += 1) {
            const item = transcript[i];
            if (item) archivedSourceItemIds.add(item.id);
          }
        }
      }
    }

    const newSessionId = input.id;
    const createdAt = input.createdAt;
    const title = (input.title || `${fromSession.title} (fork)`).trim() || `${fromSession.title} (fork)`;
    const archiveAt = input.archiveAt;
    const clonedIdMap = new Map<number, number>();
    this.dependencies.db.transaction(() => {
      createAgentSession(this.dependencies.db, {
        id: newSessionId,
        workspaceId: fromSession.workspaceId,
        title,
        kind: input.targetKind,
        createdAt,
        forkedFromSessionId: fromSession.id,
        forkedFromItemId: input.fromItemId
      });
      let prevId: number | null = null;
      for (const item of cloned) {
        const status = item.status === "streaming" || item.status === "queued" || item.status === "running" ? "completed" : item.status;
        const next = appendContextItem(this.dependencies.db, {
          workspaceId: fromSession.workspaceId,
          sessionId: newSessionId,
          runId: null,
          turnId: null,
          step: null,
          prevId,
          kind: item.kind,
          status,
          boundaryReason: item.boundaryReason,
          output: item.output,
          createdAt: Math.max(createdAt, item.createdAt)
        });
        prevId = next.id;
        clonedIdMap.set(item.id, next.id);
      }
      const insertAttachmentRelation = this.dependencies.db.prepare(
        "insert into agent_context_item_attachment (context_item_id, attachment_id, position) select ?, attachment_id, position from agent_context_item_attachment where context_item_id = ? order by position asc"
      );
      for (const sourceItem of cloned) {
        const targetItemId = clonedIdMap.get(sourceItem.id);
        if (targetItemId != null) insertAttachmentRelation.run(targetItemId, sourceItem.id);
      }
      if (input.mode === "with_archive" && archivedSourceItemIds.size > 0) {
        const itemIds = cloned.flatMap((item) => archivedSourceItemIds.has(item.id) ? [clonedIdMap.get(item.id)] : []).filter((id): id is number => id != null);
        if (itemIds.length > 0) {
          setContextItemsArchiveAt(this.dependencies.db, {
            workspaceId: fromSession.workspaceId,
            sessionId: newSessionId,
            itemIds,
            archiveAt,
            updatedAt: archiveAt
          });
        }
      }
    })();

    if (input.mode === "with_archive" && archivedSourceItemIds.size > 0) {
      const lines = getSessionTranscriptItems(this.dependencies.db, fromSession.workspaceId, newSessionId)
        .filter((item) => item.archiveAt != null)
        .map((item) => this.dependencies.buildArchiveLine(item))
        .filter((line): line is string => line != null);
      if (lines.length > 0) {
        try {
          await this.dependencies.archiveStorage.appendLines({
            operation: "fork",
            workspaceId: fromSession.workspaceId,
            sessionId: newSessionId,
            lines
          });
        } catch {
          this.dependencies.db.prepare("delete from agent_session where id = @sessionId and workspace_id = @workspaceId").run({
            sessionId: newSessionId,
            workspaceId: fromSession.workspaceId
          });
          await fs.rm(agentArchiveSessionDir(this.dependencies.dataDir, fromSession.workspaceId, newSessionId), { recursive: true, force: true }).catch(() => undefined);
          throw new HttpError(500, "failed to write fork archive", "AGENT_FORK_ARCHIVE_FAILED");
        }
      }
    }

    const session = getAgentSession(this.dependencies.db, newSessionId);
    if (!session) throw new HttpError(500, "failed to create fork session");
    return session;
  }
}
