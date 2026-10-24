import type { TerminalRunLocator } from "./terminal-run-control.protocol.js";
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import {
  isWorkspaceEnvironmentUnicodeValid,
  validateWorkspaceEnvironmentCollection
} from "@agent-workbench/shared";

export const TERMINAL_ENV_LAUNCH_ROOT = "terminal-env-launch";
export const TERMINAL_ENV_PAYLOAD_NAME = "payload.json";
export const TERMINAL_ENV_STATUS_NAME = "status.json";
export const TERMINAL_ENV_PAYLOAD_MAX_BYTES = 1024 * 1024;
export const TERMINAL_ENV_STATUS_MAX_BYTES = 4096;
export const TERMINAL_ENV_ERROR_CODES = [
  "TERMINAL_ENV_PREPARE_FAILED", "TERMINAL_ENV_PROTOCOL_FAILED", "TERMINAL_ENV_START_TIMEOUT",
  "TERMINAL_ENV_SHELL_NOT_FOUND", "TERMINAL_ENV_SPAWN_FAILED", "TERMINAL_ENV_CLEANUP_PENDING"
] as const;
export type TerminalEnvironmentErrorCode = typeof TERMINAL_ENV_ERROR_CODES[number];
export class TerminalEnvironmentLaunchError extends Error {
  constructor(readonly code: TerminalEnvironmentErrorCode) {
    super(code); // Never retain filesystem/spawn causes or their arguments.
    this.name = "TerminalEnvironmentLaunchError";
  }
}
export function terminalEnvironmentProtocolError(): never {
  throw new TerminalEnvironmentLaunchError("TERMINAL_ENV_PROTOCOL_FAILED");
}
export type TerminalEnvironmentIdentity = { dev: string; ino: string };
export type TerminalEnvironmentPayload = {
  version: 1; attemptId: string; shell: string;
  baseEnv: Record<string, string>; systemEnv: Record<string, string>; workspaceEnv: Record<string, string>;
};
export const TERMINAL_ENV_STATUS_CODES = [
  "SHELL_NOT_FOUND", "SHELL_SPAWN_FAILED", "ENV_TOO_LARGE", "SNAPSHOT_INVALID", "STATUS_WRITE_FAILED"
] as const;
export type TerminalLaunchStatusCode = typeof TERMINAL_ENV_STATUS_CODES[number];
export type TerminalLaunchStatus =
  | { version: 1; attemptId: string; state: "pending" }
  | { version: 1; attemptId: string; state: "spawned" }
  | { version: 1; attemptId: string; state: "spawn-error"; code: TerminalLaunchStatusCode };
/** Only trusted non-secret metadata is permitted in launcher argv. */
export type TerminalEnvironmentLaunchLocator = {
  version: 1; attemptId: string; dataDir: string; directoryName: string; ownerUid: number;
  dataRoot: TerminalEnvironmentIdentity; launchRoot: TerminalEnvironmentIdentity;
  attemptDirectory: TerminalEnvironmentIdentity; payload: TerminalEnvironmentIdentity; status: TerminalEnvironmentIdentity;
  bootstrap?: TerminalEnvironmentIdentity;
  runControl?: TerminalRunLocator;
};

export function isTerminalEnvironmentSafeSegment(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}
export function terminalEnvironmentDirectoryName(terminalId: string, attemptId: string): string {
  if (!isTerminalEnvironmentSafeSegment(terminalId) || !isTerminalEnvironmentSafeSegment(attemptId)) terminalEnvironmentProtocolError();
  return `${terminalId}-${attemptId}`;
}
export function terminalEnvironmentScopes(attemptId: string) {
  if (!isTerminalEnvironmentSafeSegment(attemptId)) terminalEnvironmentProtocolError();
  const token = createHash("sha256").update(attemptId, "utf8").digest("hex").slice(0, 32);
  return { payload: `ep-${token}`, status: `es-${token}`, bootstrap: `eb-${token}`, directory: `ed-${token}` };
}
export function terminalEnvironmentIdentity(stat: Pick<Stats, "dev" | "ino">): TerminalEnvironmentIdentity {
  if (![stat.dev, stat.ino].every((value) => Number.isSafeInteger(value) && value >= 0)) terminalEnvironmentProtocolError();
  return { dev: String(stat.dev), ino: String(stat.ino) };
}
export function isTerminalEnvironmentIdentity(value: unknown): value is TerminalEnvironmentIdentity {
  if (!object(value) || !exactKeys(value, ["dev", "ino"])) return false;
  return [value.dev, value.ino].every((part) => typeof part === "string" && /^(0|[1-9][0-9]*)$/.test(part)
    && Number.isSafeInteger(Number(part)));
}
export function terminalEnvironmentInode(identity: TerminalEnvironmentIdentity) {
  if (!isTerminalEnvironmentIdentity(identity)) terminalEnvironmentProtocolError();
  return { dev: Number(identity.dev), ino: Number(identity.ino) };
}
export function assertTerminalEnvironmentStat(
  stat: Stats, expected: TerminalEnvironmentIdentity | null, kind: "file" | "directory", ownerUid: number, privateMode = true
) {
  const actual = terminalEnvironmentIdentity(stat);
  if (stat.isSymbolicLink() || (kind === "file" ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())
    || stat.uid !== ownerUid || (expected && (actual.dev !== expected.dev || actual.ino !== expected.ino))
    || (privateMode ? (stat.mode & 0o7777) !== (kind === "file" ? 0o600 : 0o700) : (stat.mode & 0o022) !== 0)) {
    terminalEnvironmentProtocolError();
  }
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function validString(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\0") && isWorkspaceEnvironmentUnicodeValid(value);
}
function validateMap(value: unknown, workspace: boolean): value is Record<string, string> {
  if (!object(value)) return false;
  const entries = Object.entries(value);
  if (!entries.every(([name, item]) => validString(name) && name.length > 0 && !name.includes("=")
    && !name.startsWith("AWB_") && validString(item))) return false;
  return !workspace || !validateWorkspaceEnvironmentCollection(entries.map(([name, item]) => ({
    name, value: item as string, remark: "", enabled: true
  })));
}
/** Snapshot copies never modify process.env/cached Workspace maps. */
export function copyTerminalEnvironmentLayer(value: NodeJS.ProcessEnv | Record<string, string>, omitTmux = false) {
  const result: Record<string, string> = Object.create(null);
  for (const [name, item] of Object.entries(value)) {
    if (!name.startsWith("AWB_") && !(omitTmux && name === "TMUX") && item !== undefined) {
      if (!validString(item) || !validString(name) || !name || name.includes("=")) terminalEnvironmentProtocolError();
      result[name] = item;
    }
  }
  return result;
}
export function createTerminalEnvironmentPayload(params: {
  attemptId: string; shell: string; baseEnv: NodeJS.ProcessEnv;
  systemEnv: Record<string, string>; workspaceEnv: Readonly<Record<string, string>>;
}): TerminalEnvironmentPayload {
  // Workspace must be validated before copying/filtering: never silently remove an invalid protected override.
  if (!validateMap(params.workspaceEnv, true)) terminalEnvironmentProtocolError();
  const payload: TerminalEnvironmentPayload = {
    version: 1, attemptId: params.attemptId, shell: params.shell,
    baseEnv: copyTerminalEnvironmentLayer(params.baseEnv, true),
    systemEnv: copyTerminalEnvironmentLayer(params.systemEnv),
    workspaceEnv: copyTerminalEnvironmentLayer(params.workspaceEnv)
  };
  assertTerminalEnvironmentPayload(payload, params.attemptId);
  return payload;
}
export function assertTerminalEnvironmentPayload(value: unknown, attemptId: string): asserts value is TerminalEnvironmentPayload {
  if (!object(value) || !exactKeys(value, ["version", "attemptId", "shell", "baseEnv", "systemEnv", "workspaceEnv"])
    || value.version !== 1 || value.attemptId !== attemptId || !isTerminalEnvironmentSafeSegment(attemptId)
    || !validString(value.shell) || !value.shell || value.shell.length > 4096
    || !validateMap(value.baseEnv, false) || Object.hasOwn(value.baseEnv, "TMUX")
    || !validateMap(value.systemEnv, false) || !validateMap(value.workspaceEnv, true)) terminalEnvironmentProtocolError();
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > TERMINAL_ENV_PAYLOAD_MAX_BYTES) terminalEnvironmentProtocolError();
}
export function buildTerminalEnvironment(payload: TerminalEnvironmentPayload, runtimeEnv: NodeJS.ProcessEnv) {
  assertTerminalEnvironmentPayload(payload, payload.attemptId);
  const runtime: Record<string, string> = Object.create(null);
  for (const key of ["TERM", "TMUX", "TMUX_PANE"]) {
    const value = runtimeEnv[key];
    if (value !== undefined) runtime[key] = value;
  }
  return Object.assign(Object.create(null) as Record<string, string>, copyTerminalEnvironmentLayer(payload.baseEnv),
    copyTerminalEnvironmentLayer(runtime), copyTerminalEnvironmentLayer(payload.systemEnv), copyTerminalEnvironmentLayer(payload.workspaceEnv));
}
export function assertTerminalLaunchStatus(value: unknown, attemptId: string): asserts value is TerminalLaunchStatus {
  if (!object(value) || value.version !== 1 || value.attemptId !== attemptId) terminalEnvironmentProtocolError();
  if (value.state === "pending" || value.state === "spawned") {
    if (!exactKeys(value, ["version", "attemptId", "state"])) terminalEnvironmentProtocolError();
  } else if (value.state !== "spawn-error" || !exactKeys(value, ["version", "attemptId", "state", "code"])
    || !TERMINAL_ENV_STATUS_CODES.includes(value.code as TerminalLaunchStatusCode)) terminalEnvironmentProtocolError();
}
export function assertTerminalEnvironmentLaunchLocator(value: unknown): asserts value is TerminalEnvironmentLaunchLocator {
  if (!object(value) || !exactKeys(value, ["version", "attemptId", "dataDir", "directoryName", "ownerUid", "dataRoot", "launchRoot", "attemptDirectory", "payload", "status", ...(Object.hasOwn(value, "bootstrap") ? ["bootstrap"] : []), ...(Object.hasOwn(value, "runControl") ? ["runControl"] : [])])
    || (Object.hasOwn(value, "bootstrap") && !isTerminalEnvironmentIdentity(value.bootstrap))
    || (Object.hasOwn(value, "runControl") && (!object(value.runControl) || !Object.hasOwn(value, "bootstrap")))
    || value.version !== 1 || !isTerminalEnvironmentSafeSegment(value.attemptId) || !validString(value.dataDir) || !value.dataDir.startsWith("/")
    || typeof value.directoryName !== "string" || !/^[A-Za-z0-9_-]{3,129}$/.test(value.directoryName)
    || typeof value.ownerUid !== "number" || !Number.isSafeInteger(value.ownerUid) || value.ownerUid < 0
    || ![value.dataRoot, value.launchRoot, value.attemptDirectory, value.payload, value.status].every(isTerminalEnvironmentIdentity)) terminalEnvironmentProtocolError();
}
export function terminalLaunchSpawnErrorCode(error: unknown): TerminalLaunchStatusCode {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" ? "SHELL_NOT_FOUND" : code === "E2BIG" ? "ENV_TOO_LARGE" : "SHELL_SPAWN_FAILED";
}
