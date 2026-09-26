import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import {
  ScheduledTaskCursorSchema, ScheduledExecutionCursorSchema
} from "@agent-workbench/shared";
import type { ScheduledTaskCursor, ScheduledExecutionCursor } from "@agent-workbench/shared";

export class CursorInvalidError extends Error {
  readonly code = "CURSOR_INVALID";
  constructor() { super("Invalid cursor"); }
}

/**
 * A fresh, process-local key is deliberately not persisted: after an API restart
 * old cursors fail with CURSOR_INVALID and clients restart pagination. There is no
 * cross-restart cursor guarantee. Do not log the key or include it in the token.
 */
export function createScheduledCursorCodec() {
  const key = randomBytes(32);
  const mac = (kind: string, workspaceId: string, scopeId: string, payload: string) =>
    createHmac("sha256", key).update(JSON.stringify([kind, workspaceId, scopeId, payload])).digest();
  function encode(kind: string, workspaceId: string, scopeId: string, cursor: unknown) {
    const payload = Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
    return `${payload}.${mac(kind, workspaceId, scopeId, payload).toString("base64url")}`;
  }
  function decode(value: string, kind: string, workspaceId: string, scopeId: string): unknown {
    if (typeof value !== "string" || value.length > 4096 || !workspaceId || (kind === "execution" && !scopeId)) {
      throw new CursorInvalidError();
    }
    const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(value);
    if (!match) throw new CursorInvalidError();
    const [, payload, signature] = match;
    try {
      const signatureBytes = Buffer.from(signature!, "base64url");
      if (signatureBytes.length !== 32 || signatureBytes.toString("base64url") !== signature ||
          !timingSafeEqual(signatureBytes, mac(kind, workspaceId, scopeId, payload!))) throw new CursorInvalidError();
      const bytes = Buffer.from(payload!, "base64url");
      if (bytes.toString("base64url") !== payload) throw new CursorInvalidError();
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch { throw new CursorInvalidError(); }
  }
  return {
    encodeTask(cursor: ScheduledTaskCursor, workspaceId: string): string {
      return encode("task", workspaceId, "", cursor);
    },
    decodeTask(value: string, filter: ScheduledTaskCursor["filter"], workspaceId: string): ScheduledTaskCursor {
      const parsed = decode(value, "task", workspaceId, "");
      if (!Value.Check(ScheduledTaskCursorSchema, parsed)) throw new CursorInvalidError();
      const cursor = parsed as ScheduledTaskCursor;
      if (cursor.filter.status !== filter.status || cursor.filter.q !== filter.q) throw new CursorInvalidError();
      return cursor;
    },
    encodeExecution(cursor: ScheduledExecutionCursor, workspaceId: string, taskId: string): string {
      return encode("execution", workspaceId, taskId, cursor);
    },
    decodeExecution(value: string, filter: ScheduledExecutionCursor["filter"], workspaceId: string, taskId: string): ScheduledExecutionCursor {
      const parsed = decode(value, "execution", workspaceId, taskId);
      if (!Value.Check(ScheduledExecutionCursorSchema, parsed)) throw new CursorInvalidError();
      const cursor = parsed as ScheduledExecutionCursor;
      if (cursor.filter.result !== filter.result || cursor.filter.triggerType !== filter.triggerType) throw new CursorInvalidError();
      return cursor;
    }
  };
}

const processCursorCodec = createScheduledCursorCodec();
export const encodeTaskCursor = processCursorCodec.encodeTask;
export const decodeTaskCursor = processCursorCodec.decodeTask;
export const encodeExecutionCursor = processCursorCodec.encodeExecution;
export const decodeExecutionCursor = processCursorCodec.decodeExecution;
