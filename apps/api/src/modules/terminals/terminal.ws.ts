import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import { HttpError } from "../../app/errors.js";
import { AUTH_COOKIE_NAME, parseCookieHeader, verifySessionCookieValue } from "../../infra/auth/sessionCookie.js";
import { tmuxCountClients, tmuxHasSession } from "../../infra/tmux/session.js";
import { nowMs } from "../../utils/time.js";
import { getTerminal, updateTerminalStatus } from "./terminal.store.js";
import { getWorkspace } from "../workspaces/workspace.store.js";
import { cleanupTerminalGitAuthArtifacts } from "./terminal.gitAuth.js";
import * as pty from "node-pty";

type WsClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

type WsServerMessage =
  | { type: "output"; data: string }
  | { type: "exit"; exitCode: number }
  | { type: "error"; message: string };

function closeCodeFromHttpStatus(statusCode: number) {
  // 使用 4xxx 的自定义 close code，便于前端精确判断原因（尤其是“占用”）
  // https://www.rfc-editor.org/rfc/rfc6455#section-7.4.2
  switch (statusCode) {
    case 400:
      return 4400;
    case 401:
      return 4401;
    case 403:
      return 4403;
    case 404:
      return 4404;
    case 409:
      return 4409; // occupied
    case 410:
      return 4410;
    default:
      return 4500;
  }
}

function safeSend(log: FastifyInstance["log"], socket: any, msg: WsServerMessage) {
  try {
    if (!socket) return false;
    if (typeof socket.readyState === "number" && socket.readyState !== 1) return false;
    socket.send(JSON.stringify(msg));
    return true;
  } catch (err) {
    log.warn({ err }, "terminal ws send failed");
    try {
      socket?.close?.();
    } catch {
      // ignore
    }
    return false;
  }
}

export async function registerTerminalWsRoute(app: FastifyInstance, ctx: AppContext) {
  app.get(
    "/api/terminals/:terminalId/ws",
    {
      websocket: true,
      schema: {
        tags: ["terminals"],
        description: "WebSocket attach to a tmux session; rejects if occupied by default (use force=1 to take over)"
      }
    },
    async (socket, req) => {
      const params = req.params as { terminalId: string };
      const query = (req.query ?? {}) as { force?: string };
      const force = query.force === "1" || query.force === "true";

      app.log.info({ terminalId: params.terminalId, force }, "terminal ws connected");
      socket.on("error", (err: any) => {
        app.log.warn({ err, terminalId: params.terminalId }, "terminal ws socket error");
      });

      let p: pty.IPty | null = null;
      const closeSoon = () => setTimeout(() => socket.close(), 50);
      const sendErrorAndClose = (message: string, opts?: { code?: number; reason?: string }) => {
        safeSend(app.log, socket, { type: "error", message });
        try {
          if (opts?.code) socket.close(opts.code, opts.reason || "");
        } catch {
          // ignore
        }
        closeSoon();
      };

      let termId: string | null = null;
      try {
        if (ctx.authToken) {
          const cookies = parseCookieHeader(req.headers.cookie);
          const v = cookies[AUTH_COOKIE_NAME];
          const ok = v ? verifySessionCookieValue({ authToken: ctx.authToken, value: v, nowMs: nowMs() }) : false;
          if (!ok) throw new HttpError(401, "Unauthorized");
        }

        const term = getTerminal(ctx.db, params.terminalId);
        if (!term) throw new HttpError(404, "Terminal not found");
        termId = term.id;

        const ws = getWorkspace(ctx.db, term.workspaceId);
        if (!ws) throw new HttpError(404, "Workspace not found");

        const exists = await tmuxHasSession({ sessionName: term.sessionName, cwd: ctx.dataDir });
        if (!exists) {
          updateTerminalStatus(ctx.db, term.id, "closed", nowMs());
          await cleanupTerminalGitAuthArtifacts(ctx.dataDir, term.id);
          throw new HttpError(410, "tmux session not found (may have exited)");
        }

        if (!force) {
          const clients = await tmuxCountClients({ sessionName: term.sessionName, cwd: ctx.dataDir });
          if (clients > 0) {
            throw new HttpError(409, "Terminal is connected elsewhere. Retry with force=1 to take over.");
          }
        }

        const attachArgs = force ? ["attach", "-d", "-t", term.sessionName] : ["attach", "-t", term.sessionName];
        const env = { ...process.env, TERM: "xterm-256color", LANG: process.env.LANG || "C.UTF-8" };
        // 避免把 AWB_* 泄漏到用户侧终端进程(这里主要是 tmux client,但保持一致更安全)。
        for (const k of Object.keys(env)) {
          if (k.startsWith("AWB_")) delete (env as any)[k];
        }
        delete (env as any).TMUX;

        p = pty.spawn("tmux", attachArgs, {
          name: "xterm-256color",
          cols: 120,
          rows: 30,
          cwd: ws.path,
          env
        });

        p.onData((data) => {
          const ok = safeSend(app.log, socket, { type: "output", data });
          if (!ok) {
            try {
              p?.kill();
            } catch {
              // ignore
            }
          }
        });

        p.onExit(({ exitCode }) => {
          try {
            safeSend(app.log, socket, { type: "exit", exitCode });
          } finally {
            closeSoon();
          }
        });

        socket.on("message", (raw: any) => {
          try {
            const msg = JSON.parse(raw.toString("utf-8")) as WsClientMessage;
            if (msg.type === "input") {
              p?.write(msg.data);
              return;
            }
            if (msg.type === "resize") {
              const cols = Math.max(10, Math.floor(msg.cols));
              const rows = Math.max(5, Math.floor(msg.rows));
              p?.resize(cols, rows);
              return;
            }
          } catch (err) {
            safeSend(app.log, socket, { type: "error", message: err instanceof Error ? err.message : String(err) });
          }
        });
      } catch (err) {
        if (err instanceof HttpError) {
          app.log.info({ terminalId: params.terminalId, statusCode: err.statusCode }, "terminal ws rejected");
          sendErrorAndClose(err.message, { code: closeCodeFromHttpStatus(err.statusCode), reason: String(err.statusCode) });
          return;
        }

        const message = (err instanceof Error ? err.message : String(err))
          .trim()
          .replace(/\s+/g, " ");
        app.log.warn({ err, terminalId: params.terminalId }, "terminal ws handler failed");
        sendErrorAndClose(`Internal error: ${message}`, { code: 4500, reason: "internal" });
      }

      socket.on("close", () => {
        app.log.info({ terminalId: params.terminalId }, "terminal ws closed");
        try {
          p?.kill();
        } catch {
          // ignore
        }
        p = null;
      });
    }
  );
}
