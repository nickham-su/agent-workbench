import type { FastifyBaseLogger } from "fastify";
import type { TerminalRecord } from "@agent-workbench/shared";
import type { AppContext } from "../../app/context.js";
import { HttpError } from "../../app/errors.js";
import { newId } from "../../utils/ids.js";
import { nowMs } from "../../utils/time.js";
import { getWorkspace } from "../workspaces/workspace.store.js";
import { tmuxHasSession, tmuxKillSession, tmuxNewSession } from "../../infra/tmux/session.js";
import {
  insertTerminal,
  getTerminal,
  updateTerminalStatus,
  deleteTerminalRecord,
  listActiveTerminalsByWorkspace
} from "./terminal.store.js";

export async function createTerminal(
  ctx: AppContext,
  logger: FastifyBaseLogger,
  params: { workspaceId: string; shell?: string }
): Promise<TerminalRecord> {
  const workspaceId = params.workspaceId.trim();
  if (!workspaceId) throw new HttpError(400, "workspaceId is required");
  const ws = getWorkspace(ctx.db, workspaceId);
  if (!ws) throw new HttpError(404, "Workspace not found");

  const terminalId = newId("term");
  const sessionName = `term_${terminalId}`;
  const ts = nowMs();
  const term: TerminalRecord = {
    id: terminalId,
    workspaceId: ws.id,
    sessionName,
    status: "active",
    createdAt: ts,
    updatedAt: ts
  };

  const shell = params.shell?.trim() || "bash";
  try {
    await tmuxNewSession({ sessionName, cwd: ws.path, command: [shell] });
  } catch (err) {
    if (!params.shell) {
      // 默认 shell 失败时降级到 sh
      await tmuxNewSession({ sessionName, cwd: ws.path, command: ["sh"] });
    } else {
      throw err;
    }
  }

  insertTerminal(ctx.db, term);
  logger.info({ terminalId, workspaceId }, "terminal created");
  return term;
}

export async function getTerminalById(ctx: AppContext, terminalId: string): Promise<TerminalRecord> {
  const term = getTerminal(ctx.db, terminalId);
  if (!term) throw new HttpError(404, "Terminal not found");
  return term;
}

export async function deleteTerminal(ctx: AppContext, logger: FastifyBaseLogger, terminalId: string) {
  const term = await getTerminalById(ctx, terminalId);
  await safeKillTerminalSession(ctx, term);
  deleteTerminalRecord(ctx.db, term.id);
  logger.info({ terminalId: term.id }, "terminal deleted");
}

export async function safeKillTerminalSession(ctx: AppContext, term: TerminalRecord) {
  const exists = await tmuxHasSession({ sessionName: term.sessionName, cwd: ctx.dataDir });
  if (!exists) return;
  await tmuxKillSession({ sessionName: term.sessionName, cwd: ctx.dataDir });
  updateTerminalStatus(ctx.db, term.id, "closed", nowMs());
}

export async function reconcileWorkspaceActiveTerminals(ctx: AppContext, logger: FastifyBaseLogger, workspaceId: string) {
  const active = listActiveTerminalsByWorkspace(ctx.db, workspaceId);
  if (active.length === 0) return;

  await Promise.all(
    active.map(async (t) => {
      try {
        const exists = await tmuxHasSession({ sessionName: t.sessionName, cwd: ctx.dataDir });
        if (exists) return;
        updateTerminalStatus(ctx.db, t.id, "closed", nowMs());
      } catch (err) {
        logger.warn({ terminalId: t.id, err }, "reconcile terminal failed");
      }
    })
  );
}
