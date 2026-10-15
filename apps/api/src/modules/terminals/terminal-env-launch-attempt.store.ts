import type { Db } from "../../infra/db/db.js";
import {
  isTerminalEnvironmentIdentity, isTerminalEnvironmentSafeSegment, TERMINAL_ENV_ERROR_CODES,
  terminalEnvironmentDirectoryName, terminalEnvironmentProtocolError,
  type TerminalEnvironmentErrorCode, type TerminalEnvironmentIdentity
} from "./terminal-env-launch.protocol.js";

export type TerminalEnvironmentLaunchAttempt = {
  id: string; terminalId: string; directoryName: string;
  phase: "armed" | "prepared" | "launching" | "cleanup_pending";
  ownerUid: number; dataRoot: TerminalEnvironmentIdentity;
  launchRoot: TerminalEnvironmentIdentity | null; attemptDirectory: TerminalEnvironmentIdentity | null;
  payload: TerminalEnvironmentIdentity | null; status: TerminalEnvironmentIdentity | null;
  directoryArmed: boolean; payloadArmed: boolean; statusArmed: boolean;
  errorCode: TerminalEnvironmentErrorCode | null; createdAt: number; updatedAt: number;
};
const columns = `id, terminal_id as terminalId, directory_name as directoryName, phase, owner_uid as ownerUid,
  data_root_dev as dataRootDev, data_root_ino as dataRootIno,
  launch_root_dev as launchRootDev, launch_root_ino as launchRootIno,
  attempt_dir_dev as attemptDirectoryDev, attempt_dir_ino as attemptDirectoryIno,
  payload_dev as payloadDev, payload_ino as payloadIno, status_dev as statusDev, status_ino as statusIno,
  directory_armed as directoryArmed, payload_armed as payloadArmed, status_armed as statusArmed,
  error_code as errorCode, created_at as createdAt, updated_at as updatedAt`;
function assertAttempt(attempt: TerminalEnvironmentLaunchAttempt) {
  if (!isTerminalEnvironmentSafeSegment(attempt.id) || !isTerminalEnvironmentSafeSegment(attempt.terminalId)
    || attempt.directoryName !== terminalEnvironmentDirectoryName(attempt.terminalId, attempt.id)
    || !["armed", "prepared", "launching", "cleanup_pending"].includes(attempt.phase)
    || !Number.isSafeInteger(attempt.ownerUid) || attempt.ownerUid < 0 || !isTerminalEnvironmentIdentity(attempt.dataRoot)
    || ![attempt.launchRoot, attempt.attemptDirectory, attempt.payload, attempt.status].every((value) => value === null || isTerminalEnvironmentIdentity(value))
    || ![attempt.directoryArmed, attempt.payloadArmed, attempt.statusArmed].every((value) => typeof value === "boolean")
    || (attempt.errorCode !== null && !TERMINAL_ENV_ERROR_CODES.includes(attempt.errorCode))
    || ![attempt.createdAt, attempt.updatedAt].every((value) => Number.isSafeInteger(value) && value >= 0)
    || (attempt.directoryArmed && !attempt.launchRoot)
    || (attempt.attemptDirectory && !attempt.directoryArmed)
    || ((attempt.payloadArmed || attempt.statusArmed) && !attempt.attemptDirectory)
    || (attempt.payload && !attempt.payloadArmed) || (attempt.status && !attempt.statusArmed)
    || (["prepared", "launching"].includes(attempt.phase) && (!attempt.attemptDirectory || !attempt.payload || !attempt.status))) {
    terminalEnvironmentProtocolError();
  }
}
function decode(row: Record<string, unknown>): TerminalEnvironmentLaunchAttempt {
  const identity = (prefix: string): TerminalEnvironmentIdentity | null => {
    const dev = row[`${prefix}Dev`], ino = row[`${prefix}Ino`];
    if (dev === null && ino === null) return null;
    const value = { dev, ino };
    if (!isTerminalEnvironmentIdentity(value)) terminalEnvironmentProtocolError();
    return value;
  };
  const armed = (name: string) => {
    if (row[name] !== 0 && row[name] !== 1) terminalEnvironmentProtocolError();
    return row[name] === 1;
  };
  const attempt: TerminalEnvironmentLaunchAttempt = {
    id: row.id as string, terminalId: row.terminalId as string, directoryName: row.directoryName as string,
    phase: row.phase as TerminalEnvironmentLaunchAttempt["phase"], ownerUid: row.ownerUid as number,
    dataRoot: identity("dataRoot")!, launchRoot: identity("launchRoot"), attemptDirectory: identity("attemptDirectory"),
    payload: identity("payload"), status: identity("status"), directoryArmed: armed("directoryArmed"),
    payloadArmed: armed("payloadArmed"), statusArmed: armed("statusArmed"), errorCode: row.errorCode as TerminalEnvironmentErrorCode | null,
    createdAt: row.createdAt as number, updatedAt: row.updatedAt as number
  };
  assertAttempt(attempt);
  return attempt;
}
function bindings(attempt: TerminalEnvironmentLaunchAttempt) {
  assertAttempt(attempt);
  return {
    id: attempt.id, terminalId: attempt.terminalId, directoryName: attempt.directoryName, phase: attempt.phase,
    ownerUid: attempt.ownerUid, dataRootDev: attempt.dataRoot.dev, dataRootIno: attempt.dataRoot.ino,
    launchRootDev: attempt.launchRoot?.dev ?? null, launchRootIno: attempt.launchRoot?.ino ?? null,
    attemptDirectoryDev: attempt.attemptDirectory?.dev ?? null, attemptDirectoryIno: attempt.attemptDirectory?.ino ?? null,
    payloadDev: attempt.payload?.dev ?? null, payloadIno: attempt.payload?.ino ?? null,
    statusDev: attempt.status?.dev ?? null, statusIno: attempt.status?.ino ?? null,
    directoryArmed: Number(attempt.directoryArmed), payloadArmed: Number(attempt.payloadArmed), statusArmed: Number(attempt.statusArmed),
    errorCode: attempt.errorCode, createdAt: attempt.createdAt, updatedAt: attempt.updatedAt
  };
}
function assertPersistedAttempt(db: Db, attempt: TerminalEnvironmentLaunchAttempt) {
  const persisted = getTerminalEnvironmentLaunchAttempt(db, attempt.id);
  if (!persisted || JSON.stringify(bindings(persisted)) !== JSON.stringify(bindings(attempt))) {
    terminalEnvironmentProtocolError();
  }
}

export function insertTerminalEnvironmentLaunchAttempt(db: Db, attempt: TerminalEnvironmentLaunchAttempt) {
  db.prepare(`insert into terminal_env_launch_attempts (
    id, terminal_id, directory_name, phase, owner_uid, data_root_dev, data_root_ino, launch_root_dev, launch_root_ino,
    attempt_dir_dev, attempt_dir_ino, payload_dev, payload_ino, status_dev, status_ino,
    directory_armed, payload_armed, status_armed, error_code, created_at, updated_at
  ) values (@id, @terminalId, @directoryName, @phase, @ownerUid, @dataRootDev, @dataRootIno, @launchRootDev, @launchRootIno,
    @attemptDirectoryDev, @attemptDirectoryIno, @payloadDev, @payloadIno, @statusDev, @statusIno,
     @directoryArmed, @payloadArmed, @statusArmed, @errorCode, @createdAt, @updatedAt)`).run(bindings(attempt));
  assertPersistedAttempt(db, attempt);
}
export function getTerminalEnvironmentLaunchAttempt(db: Db, id: string): TerminalEnvironmentLaunchAttempt | null {
  const row = db.prepare(`select ${columns} from terminal_env_launch_attempts where id = ?`).get(id);
  return row ? decode(row as Record<string, unknown>) : null;
}
export function listTerminalEnvironmentLaunchAttempts(db: Db, terminalId: string): TerminalEnvironmentLaunchAttempt[] {
  const rows = db.prepare(`select ${columns} from terminal_env_launch_attempts where terminal_id = ? order by created_at, id`).all(terminalId);
  return (rows as Record<string, unknown>[]).map(decode);
}
/** Must be called under the caller's Workspace admission; there is no async window in this write. */
export function updateTerminalEnvironmentLaunchAttempt(
  db: Db, id: string, patch: Partial<Omit<TerminalEnvironmentLaunchAttempt, "id" | "terminalId" | "directoryName" | "dataRoot" | "ownerUid" | "createdAt">>
): TerminalEnvironmentLaunchAttempt {
  const previous = getTerminalEnvironmentLaunchAttempt(db, id);
  if (!previous) terminalEnvironmentProtocolError();
  const next = { ...previous, ...patch, updatedAt: Date.now() };
  const transitions: Record<TerminalEnvironmentLaunchAttempt["phase"], readonly TerminalEnvironmentLaunchAttempt["phase"][]> = {
    armed: ["armed", "prepared", "cleanup_pending"], prepared: ["prepared", "launching", "cleanup_pending"],
    launching: ["launching", "cleanup_pending"], cleanup_pending: ["cleanup_pending"]
  };
  if (!transitions[previous.phase].includes(next.phase)) terminalEnvironmentProtocolError();
  // Arms and durable locators are monotonic. Never replace deletion authority with a fresh stat.
  for (const key of ["directoryArmed", "payloadArmed", "statusArmed"] as const) {
    if (previous[key] && !next[key]) terminalEnvironmentProtocolError();
  }
  for (const key of ["launchRoot", "attemptDirectory", "payload", "status"] as const) {
    if (previous[key] && (!next[key] || previous[key].dev !== next[key].dev || previous[key].ino !== next[key].ino)) terminalEnvironmentProtocolError();
  }
  db.prepare(`update terminal_env_launch_attempts set phase=@phase,
    launch_root_dev=@launchRootDev, launch_root_ino=@launchRootIno, attempt_dir_dev=@attemptDirectoryDev, attempt_dir_ino=@attemptDirectoryIno,
    payload_dev=@payloadDev, payload_ino=@payloadIno, status_dev=@statusDev, status_ino=@statusIno,
    directory_armed=@directoryArmed, payload_armed=@payloadArmed, status_armed=@statusArmed,
     error_code=@errorCode, updated_at=@updatedAt where id=@id`).run(bindings(next));
  assertPersistedAttempt(db, next);
  return next;
}
/** Only after exact filesystem convergence; C2 combines this with terminal activation/deletion in its transaction. */
export function clearTerminalEnvironmentLaunchAttempt(db: Db, id: string): void {
  db.prepare("delete from terminal_env_launch_attempts where id = ?").run(id);
  if (getTerminalEnvironmentLaunchAttempt(db, id)) terminalEnvironmentProtocolError();
}
