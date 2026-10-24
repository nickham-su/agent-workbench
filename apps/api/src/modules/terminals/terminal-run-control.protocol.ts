import path from "node:path";
import { isTerminalEnvironmentIdentity, isTerminalEnvironmentSafeSegment, terminalEnvironmentProtocolError, type TerminalEnvironmentIdentity } from "./terminal-env-launch.protocol.js";

export const TERMINAL_RUN_ROOT = "terminal-runs";
export const TERMINAL_RUN_REQUEST = "request.json";
export const TERMINAL_RUN_STATUS = "status.json";
export const TERMINAL_RUN_CLAIM = "start.claim";
export type TerminalRunState = "prepared" | "running" | "stopping" | "stopped" | "unknown";
export type TerminalRunLocator = {
  version: 1; runId: string; terminalId: string; sessionName: string; dataDir: string; ownerUid: number;
  dataRoot: TerminalEnvironmentIdentity; runRoot: TerminalEnvironmentIdentity; directory: TerminalEnvironmentIdentity;
  request: TerminalEnvironmentIdentity; status: TerminalEnvironmentIdentity;
};
export type TerminalRunMessage = { version: 1; runId: string; requestId: string; action: "stop" | "status" };
export type TerminalRunStatus = { version: 1; runId: string; requestId: string; state: TerminalRunState };
export function assertTerminalRunLocator(value: unknown): asserts value is TerminalRunLocator {
  if (!value || typeof value !== "object" || Array.isArray(value)) terminalEnvironmentProtocolError();
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== 11 || v.version !== 1 || !isTerminalEnvironmentSafeSegment(v.runId)
    || !isTerminalEnvironmentSafeSegment(v.terminalId) || typeof v.sessionName !== "string" || !/^term_[A-Za-z0-9_-]{1,140}$/.test(v.sessionName)
    || typeof v.dataDir !== "string" || !path.isAbsolute(v.dataDir) || v.dataDir.includes("\0")
    || !Number.isSafeInteger(v.ownerUid) || (v.ownerUid as number) < 0
    || ![v.dataRoot, v.runRoot, v.directory, v.request, v.status].every(isTerminalEnvironmentIdentity)) terminalEnvironmentProtocolError();
}
export function assertTerminalRunMessage(value: unknown, runId: string): asserts value is TerminalRunMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) terminalEnvironmentProtocolError();
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== 4 || v.version !== 1 || v.runId !== runId || !isTerminalEnvironmentSafeSegment(v.requestId)
    || !["stop", "status"].includes(String(v.action))) terminalEnvironmentProtocolError();
}
export function assertTerminalRunStatus(value: unknown, runId: string): asserts value is TerminalRunStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) terminalEnvironmentProtocolError();
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== 4 || v.version !== 1 || v.runId !== runId || !isTerminalEnvironmentSafeSegment(v.requestId)
    || !["prepared", "running", "stopping", "stopped", "unknown"].includes(String(v.state))) terminalEnvironmentProtocolError();
}
