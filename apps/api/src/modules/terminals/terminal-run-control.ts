import fs, { type FileHandle } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type { Db } from "../../infra/db/db.js";
import { tmuxHasSession } from "../../infra/tmux/session.js";
import { isTerminalRunIdentity, readTerminalRunIdentity } from "./terminal-run-identity.js";
import { newId } from "../../utils/ids.js";
import { HttpError } from "../../app/errors.js";
import {
  openSecureRootDirectory, openSecureChildDirectory, openExistingSecureChildDirectory, closeSecureDirectories,
  assertSecureDirectoryCurrent, retireSecureEntry, removeRetiredSecureFile, removeRetiredEmptySecureDirectory,
  cleanupSecureRetiredFiles, securePrivateSlotIdentity, type SecureDirectory,
} from "../../infra/fs/secure-directory.js";
import { assertTerminalEnvironmentStat, terminalEnvironmentIdentity, terminalEnvironmentInode, terminalEnvironmentProtocolError, type TerminalEnvironmentIdentity } from "./terminal-env-launch.protocol.js";
import { readBoundedTerminalEnvironmentFile } from "./terminal-env-launch.files.js";
import {
  TERMINAL_RUN_ROOT, TERMINAL_RUN_REQUEST, TERMINAL_RUN_STATUS, TERMINAL_RUN_CLAIM,
  assertTerminalRunLocator, assertTerminalRunMessage, assertTerminalRunStatus,
  type TerminalRunLocator, type TerminalRunStatus, type TerminalRunMessage,
} from "./terminal-run-control.protocol.js";

const execFileAsync = promisify(execFile);
export const TERMINAL_RUN_PYTHON = "/usr/bin/python3";
export function terminalRunGuardPath() {
  return fileURLToPath(new URL("../../../scripts/terminal-run-guard.py", import.meta.url));
}
export async function preflightTerminalRunGuard() {
  try {
    if (process.platform !== "linux") throw new Error();
    await execFileAsync(TERMINAL_RUN_PYTHON, ["-I", "-S", terminalRunGuardPath(), "--check"], {
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, timeout: 3000, maxBuffer: 1024,
    });
  } catch {
    throw new HttpError(503, "Managed terminal runs require Linux, /usr/bin/python3 with pidfd support, and child-subreaper capability.", "TERMINAL_RUN_GUARD_UNAVAILABLE");
  }
}
// A partial preparation is cleanup authority only: never a launcher locator.
type TerminalRunPreparation = Omit<TerminalRunLocator, "request" | "status"> & {
  preparing: true; request: TerminalEnvironmentIdentity | null; status: TerminalEnvironmentIdentity | null;
};
export type TerminalRunControl = { terminalId: string; sessionName: string; phase: "preparing" | "prepared" | "launching" | "stopped"; locator: TerminalRunLocator | null; preparation?: TerminalRunPreparation };
export function getTerminalRunControl(db: Db, terminalId: string): TerminalRunControl | null {
  const row = db.prepare("select terminal_id as terminalId, session_name as sessionName, phase, locator_json as locatorJson from terminal_run_controls where terminal_id = ?").get(terminalId) as (Omit<TerminalRunControl, "locator"> & { locatorJson: string | null }) | undefined;
  if (!row) return null;
  let locator: unknown;
  try { locator = row.locatorJson === null ? null : JSON.parse(row.locatorJson); } catch { terminalEnvironmentProtocolError(); }
  if (locator === null && ["preparing", "stopped"].includes(row.phase)) return { terminalId: row.terminalId, sessionName: row.sessionName, phase: row.phase, locator: null };
  if (row.phase === "preparing" && locator && typeof locator === "object" && "preparing" in locator && locator.preparing === true) {
    const { preparing, ...partial } = locator as TerminalRunPreparation;
    assertTerminalRunLocator({ ...partial, request: partial.request === null ? partial.directory : partial.request, status: partial.status === null ? partial.directory : partial.status });
    if (partial.terminalId !== row.terminalId || partial.sessionName !== row.sessionName) terminalEnvironmentProtocolError();
    return { terminalId: row.terminalId, sessionName: row.sessionName, phase: row.phase, locator: null, preparation: locator as TerminalRunPreparation };
  }
  assertTerminalRunLocator(locator);
  if (locator.terminalId !== row.terminalId || locator.sessionName !== row.sessionName || !["prepared", "launching", "stopped"].includes(row.phase)) terminalEnvironmentProtocolError();
  return { terminalId: row.terminalId, sessionName: row.sessionName, phase: row.phase, locator };
}
export function armTerminalRunControl(db: Db, terminalId: string, sessionName: string) {
  db.prepare("insert into terminal_run_controls(terminal_id, session_name, phase, locator_json) values(?,?,'preparing',null)").run(terminalId, sessionName);
}
export function markTerminalRunLaunching(db: Db, terminalId: string) {
  if (db.prepare("update terminal_run_controls set phase = 'launching' where terminal_id = ? and phase = 'prepared'").run(terminalId).changes !== 1) terminalEnvironmentProtocolError();
}
export function clearTerminalRunControl(db: Db, terminalId: string) {
  db.prepare("delete from terminal_run_controls where terminal_id = ? and phase = 'stopped'").run(terminalId);
}
export type OpenTerminalRunControl = { data: SecureDirectory; root: SecureDirectory; directory: SecureDirectory; request: FileHandle; status: FileHandle; locator: TerminalRunLocator };
export async function closeTerminalRunControl(control?: Partial<OpenTerminalRunControl>) {
  await control?.request?.close().catch(() => undefined);
  await control?.status?.close().catch(() => undefined);
  await closeSecureDirectories(control?.directory, control?.root, control?.data);
}
export async function assertTerminalRunControlCurrent(control: OpenTerminalRunControl) {
  const l = control.locator;
  for (const [dir, identity, privateMode] of [[control.data, l.dataRoot, false], [control.root, l.runRoot, true], [control.directory, l.directory, true]] as const) {
    await assertSecureDirectoryCurrent(dir, control.data.realPath);
    assertTerminalEnvironmentStat(await dir.handle.stat(), identity, "directory", l.ownerUid, privateMode);
  }
  for (const [name, handle, identity] of [[TERMINAL_RUN_REQUEST, control.request, l.request], [TERMINAL_RUN_STATUS, control.status, l.status]] as const) {
    assertTerminalEnvironmentStat(await handle.stat(), identity, "file", l.ownerUid);
    assertTerminalEnvironmentStat(await fs.lstat(path.join(control.directory.fdPath, name)), identity, "file", l.ownerUid);
  }
}
export async function openTerminalRunControl(locator: TerminalRunLocator): Promise<OpenTerminalRunControl> {
  assertTerminalRunLocator(locator);
  const c: Partial<OpenTerminalRunControl> = { locator };
  try {
    c.data = await openSecureRootDirectory(locator.dataDir);
    assertTerminalEnvironmentStat(await c.data.handle.stat(), locator.dataRoot, "directory", locator.ownerUid, false);
    c.root = await openExistingSecureChildDirectory(c.data, TERMINAL_RUN_ROOT);
    assertTerminalEnvironmentStat(await c.root.handle.stat(), locator.runRoot, "directory", locator.ownerUid);
    c.directory = await openExistingSecureChildDirectory(c.root, locator.runId);
    assertTerminalEnvironmentStat(await c.directory.handle.stat(), locator.directory, "directory", locator.ownerUid);
    await assertSecureDirectoryCurrent(c.root, c.data.realPath);
    await assertSecureDirectoryCurrent(c.directory, c.data.realPath);
    for (const [key, name, identity] of [["request", TERMINAL_RUN_REQUEST, locator.request], ["status", TERMINAL_RUN_STATUS, locator.status]] as const) {
      assertTerminalEnvironmentStat(await fs.lstat(path.join(c.directory.fdPath, name)), identity, "file", locator.ownerUid);
      c[key] = await fs.open(path.join(c.directory.fdPath, name), constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      assertTerminalEnvironmentStat(await c[key]!.stat(), identity, "file", locator.ownerUid);
    }
    await assertTerminalRunControlCurrent(c as OpenTerminalRunControl);
    return c as OpenTerminalRunControl;
  } catch { await closeTerminalRunControl(c); terminalEnvironmentProtocolError(); }
}
async function writePinned(control: OpenTerminalRunControl, key: "request" | "status", value: TerminalRunMessage | TerminalRunStatus) {
  await assertTerminalRunControlCurrent(control);
  const handle = control[key], text = Buffer.from(JSON.stringify(value));
  // A partial image is invalid. Commit byte zero only after all other bytes and
  // the exact length are written, matching the existing launch-status protocol.
  await handle.write(Buffer.from("!"), 0, 1, 0);
  await handle.write(text.subarray(1), 0, text.length - 1, 1);
  await handle.truncate(text.length);
  await handle.sync();
  await assertTerminalRunControlCurrent(control);
  await handle.write(text.subarray(0, 1), 0, 1, 0);
  await handle.sync();
}
export async function writeTerminalRunStatus(control: OpenTerminalRunControl, status: TerminalRunStatus) {
  assertTerminalRunStatus(status, control.locator.runId);
  await writePinned(control, "status", status);
}
export async function readTerminalRunStatus(control: OpenTerminalRunControl): Promise<TerminalRunStatus> {
  await assertTerminalRunControlCurrent(control);
  const value: unknown = JSON.parse(await readBoundedTerminalEnvironmentFile(control.status, 2048));
  assertTerminalRunStatus(value, control.locator.runId);
  await assertTerminalRunControlCurrent(control);
  return value;
}
export async function readTerminalRunRequest(control: OpenTerminalRunControl): Promise<TerminalRunMessage | null> {
  await assertTerminalRunControlCurrent(control);
  // Readers may see an API writer's invalid partial image; it can never grant
  // stopped permission, so retrying the next poll is safe.
  let value: unknown;
  try { value = JSON.parse(await readBoundedTerminalEnvironmentFile(control.request, 2048)); } catch { return null; }
  assertTerminalRunMessage(value, control.locator.runId);
  return value;
}
/** A durable mailbox is the control endpoint: no socket path limit or inherited
 * listener. Only the gated API writes requests; only this run's launcher writes
 * status. Both use pinned private inodes. No command/env is stored here. */
export async function prepareTerminalRunControl(params: {
  db: Db; dataDir: string; terminalId: string; sessionName: string; readIdentity?: () => Promise<string>;
}): Promise<TerminalRunLocator> {
  const armed = getTerminalRunControl(params.db, params.terminalId);
  if (!armed || armed.phase !== "preparing" || armed.sessionName !== params.sessionName) terminalEnvironmentProtocolError();
  // Missing identity is compatible only with old runs deployed through a full
  // container/machine restart. Never authorize a new run without its identity.
  const runtimeIdentity = await (params.readIdentity ?? readTerminalRunIdentity)();
  if (!isTerminalRunIdentity(runtimeIdentity)) throw new HttpError(503, "The terminal runtime identity could not be confirmed. No new run was started.", "TERMINAL_RUN_IDENTITY_UNAVAILABLE");
  const runId = newId("tr"), uid = process.getuid!();
  let data: SecureDirectory | undefined, root: SecureDirectory | undefined, directory: SecureDirectory | undefined;
  let preparation: TerminalRunPreparation | undefined;
  const savePreparation = () => {
    if (params.db.prepare("update terminal_run_controls set locator_json = ? where terminal_id = ? and session_name = ? and phase = 'preparing'").run(JSON.stringify(preparation), params.terminalId, params.sessionName).changes !== 1) terminalEnvironmentProtocolError();
  };
  try {
    data = await openSecureRootDirectory(params.dataDir);
    assertTerminalEnvironmentStat(await data.handle.stat(), null, "directory", uid, false);
    root = await openSecureChildDirectory(data, TERMINAL_RUN_ROOT);
    assertTerminalEnvironmentStat(await root.handle.stat(), null, "directory", uid);
    // A run must not reuse an existing directory, even if its owner/mode match.
    await fs.mkdir(path.join(root.fdPath, runId), { mode: 0o700 });
    directory = await openExistingSecureChildDirectory(root, runId);
    preparation = {
      version: 1, preparing: true, runId, terminalId: params.terminalId, sessionName: params.sessionName, dataDir: path.resolve(params.dataDir), ownerUid: uid, runtimeIdentity,
      dataRoot: terminalEnvironmentIdentity(data.stat), runRoot: terminalEnvironmentIdentity(root.stat),
      directory: terminalEnvironmentIdentity(directory.stat), request: null, status: null,
    };
    savePreparation();
    assertTerminalEnvironmentStat(await directory.handle.stat(), null, "directory", uid);
    for (const [kind, name, value] of [["request", TERMINAL_RUN_REQUEST, { version: 1, runId, requestId: "initial", action: "status" }], ["status", TERMINAL_RUN_STATUS, { version: 1, runId, requestId: "initial", state: "prepared" }]] as const) {
      await assertSecureDirectoryCurrent(data, data.realPath); await assertSecureDirectoryCurrent(root, data.realPath); await assertSecureDirectoryCurrent(directory, data.realPath);
      const handle = await fs.open(path.join(directory.fdPath, name), constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      try {
        const stat = await handle.stat();
        assertTerminalEnvironmentStat(stat, null, "file", uid);
        preparation[kind] = terminalEnvironmentIdentity(stat);
        savePreparation(); // Retain identity even if write/sync or rollback fails.
        await handle.writeFile(JSON.stringify(value)); await handle.sync();
      }
      finally { await handle.close(); }
    }
    const { preparing, ...partial } = preparation;
    const locator = { ...partial, request: partial.request!, status: partial.status! };
    assertTerminalRunLocator(locator);
    await assertSecureDirectoryCurrent(data, data.realPath); await assertSecureDirectoryCurrent(root, data.realPath); await assertSecureDirectoryCurrent(directory, data.realPath);
    for (const [name, identity] of [[TERMINAL_RUN_REQUEST, locator.request], [TERMINAL_RUN_STATUS, locator.status]] as const) assertTerminalEnvironmentStat(await fs.lstat(path.join(directory.fdPath, name)), identity, "file", uid);
    await directory.handle.sync(); await root.handle.sync();
    if (params.db.prepare("update terminal_run_controls set phase = 'prepared', locator_json = ? where terminal_id = ? and session_name = ? and phase = 'preparing'").run(JSON.stringify(locator), params.terminalId, params.sessionName).changes !== 1) terminalEnvironmentProtocolError();
    return locator;
  } catch (error) {
    if (preparation) {
      try {
        await cleanupTerminalRunFiles(preparation, { data, root, directory });
        if (params.db.prepare("update terminal_run_controls set locator_json = null where terminal_id = ? and session_name = ? and phase = 'preparing'").run(params.terminalId, params.sessionName).changes !== 1) terminalEnvironmentProtocolError();
      } catch {
        // Keep the non-launchable preparation and exact identities for retry.
        throw new HttpError(503, "Managed terminal preparation cleanup remains pending. No run was authorized.", "TERMINAL_RUN_PREPARE_CLEANUP_PENDING");
      }
    }
    throw error;
  } finally { await closeSecureDirectories(directory, root, data); }
}
/** Atomic single-use start ownership. API cancellation and launcher startup race
 * for the same O_EXCL claim. Only the winner may create a guard/user process. */
export async function claimTerminalRunStart(control: OpenTerminalRunControl): Promise<boolean> {
  await assertTerminalRunControlCurrent(control);
  let handle: FileHandle;
  try { handle = await fs.open(path.join(control.directory.fdPath, TERMINAL_RUN_CLAIM), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
  await handle.close();
  await assertTerminalRunControlCurrent(control);
  return true;
}
export async function stopTerminalRunControl(params: {
  db: Db; dataDir: string; terminalId: string; sessionName: string; timeoutMs?: number;
  readIdentity?: () => Promise<string>; hasSession?: typeof tmuxHasSession;
}): Promise<void> {
  const record = getTerminalRunControl(params.db, params.terminalId);
  if (!record) return;
  if (record.sessionName !== params.sessionName) terminalEnvironmentProtocolError();
  if (record.phase === "stopped") return;
  if (record.phase === "preparing") {
    if (record.preparation) {
      if (path.resolve(params.dataDir) !== record.preparation.dataDir) terminalEnvironmentProtocolError();
      try { await cleanupTerminalRunFiles(record.preparation); }
      catch { throw new HttpError(503, "Managed terminal preparation cleanup remains pending. No run was authorized.", "TERMINAL_RUN_PREPARE_CLEANUP_PENDING"); }
    }
    if (params.db.prepare("update terminal_run_controls set phase = 'stopped', locator_json = null where terminal_id = ? and session_name = ? and phase = 'preparing'").run(params.terminalId, params.sessionName).changes !== 1) terminalEnvironmentProtocolError();
    return; // No launcher could have been authorized before a complete locator.
  }
  if (!record.locator || path.resolve(params.dataDir) !== record.locator.dataDir) terminalEnvironmentProtocolError();
  const locator = record.locator;
  const markStopped = () => {
    if (params.db.prepare("update terminal_run_controls set phase = 'stopped' where terminal_id = ? and session_name = ? and locator_json = ?").run(params.terminalId, params.sessionName, JSON.stringify(locator)).changes !== 1) terminalEnvironmentProtocolError();
  };
  let control: OpenTerminalRunControl | undefined;
  try {
    control = await openTerminalRunControl(locator);
    if (await claimTerminalRunStart(control)) {
      // We cancelled before a launcher won start ownership; it can never spawn.
      await writeTerminalRunStatus(control, { version: 1, runId: locator.runId, requestId: "cancelled", state: "stopped" });
    } else {
      let currentIdentity: string | undefined;
      try { currentIdentity = await (params.readIdentity ?? readTerminalRunIdentity)(); }
      catch { /* Unknown identity is not restart proof; retain the stop protocol. */ }
      if (isTerminalRunIdentity(currentIdentity) && locator.runtimeIdentity !== currentIdentity) {
        // DELETE/restart stop before probing tmux. Only a fresh probe inside the
        // same Workspace gate may authorize this cross-runtime shortcut.
        if (await (params.hasSession ?? tmuxHasSession)({ sessionName: params.sessionName, cwd: params.dataDir }) === "not_found") {
          await assertTerminalRunControlCurrent(control);
          markStopped();
          return;
        }
      }
      const request: TerminalRunMessage = { version: 1, runId: locator.runId, requestId: newId("stop"), action: "stop" };
      await writePinned(control, "request", request);
    }
    const deadline = performance.now() + (params.timeoutMs ?? 7000);
    while (performance.now() < deadline) {
      try {
        const status = await readTerminalRunStatus(control);
        if (status.state === "stopped") {
          markStopped();
          return;
        }
        if (status.state === "unknown") break;
      } catch { /* Partial/untrusted status is never success; bounded retry. */ }
      await delay(30);
    }
  } catch { /* No raw filesystem/protocol values in diagnostics. */ }
  finally { await closeTerminalRunControl(control); }
  throw new HttpError(503, "The previous service processes could not be confirmed stopped. No new run was started.", "TERMINAL_SESSION_STOP_UNCONFIRMED");
}
/** Filesystem-only cleanup, authorized by a durable stopped proof. Retain the
 * record through closed/retry; only the next-start transaction replaces it (or
 * terminal deletion cascades it). Missing files must not erase stop authority. */
export async function cleanupTerminalRunControl(db: Db, terminalId: string): Promise<void> {
  const record = getTerminalRunControl(db, terminalId);
  if (!record) return;
  if (record.phase !== "stopped") terminalEnvironmentProtocolError();
  if (!record.locator) return;
  await cleanupTerminalRunFiles(record.locator);
}
async function cleanupTerminalRunFiles(l: TerminalRunLocator | TerminalRunPreparation, opened?: Partial<Pick<OpenTerminalRunControl, "data" | "root" | "directory">>): Promise<void> {
  const scope = `run-${l.runId}`, preparing = "preparing" in l;
  let data = opened?.data, root = opened?.root, directory = opened?.directory;
  try {
    data ??= await openSecureRootDirectory(l.dataDir);
    assertTerminalEnvironmentStat(await data.handle.stat(), l.dataRoot, "directory", l.ownerUid, false);
    root ??= await openExistingSecureChildDirectory(data, TERMINAL_RUN_ROOT);
    assertTerminalEnvironmentStat(await root.handle.stat(), l.runRoot, "directory", l.ownerUid);
    const checkCurrent = async () => {
      await assertSecureDirectoryCurrent(data!, data!.realPath);
      await assertSecureDirectoryCurrent(root!, data!.realPath);
      if (directory) await assertSecureDirectoryCurrent(directory, data!.realPath);
    };
    await checkCurrent();
    const entries = await fs.readdir(root.fdPath);
    if (entries.some((name) => name.startsWith(".delete-replacement-pending-") && name.includes(scope))) terminalEnvironmentProtocolError();
    const retiredName = entries.find((name) => { const id = securePrivateSlotIdentity(name); return id?.scope === scope && id.kind === "directory" && id.dev === Number(l.directory.dev) && id.ino === Number(l.directory.ino); });
    const name = entries.includes(l.runId) ? l.runId : retiredName;
    if (!name) return;
    directory ??= await openExistingSecureChildDirectory(root, name);
    assertTerminalEnvironmentStat(await directory.handle.stat(), l.directory, "directory", l.ownerUid);
    await checkCurrent();
    if (preparing) {
      // Partial preparations authorize only identities actually created by this
      // attempt. Unknown files/claims/replacements must leave authority pending.
      for (const entry of await fs.readdir(directory.fdPath)) {
        const slot = securePrivateSlotIdentity(entry);
        const identity = entry === TERMINAL_RUN_REQUEST ? l.request : entry === TERMINAL_RUN_STATUS ? l.status
          : slot?.scope === "run-files" && slot.kind === "file"
            ? [l.request, l.status].find((id) => id && Number(id.dev) === slot.dev && Number(id.ino) === slot.ino) : null;
        if (!identity) terminalEnvironmentProtocolError();
        await checkCurrent();
        assertTerminalEnvironmentStat(await fs.lstat(path.join(directory.fdPath, entry)), identity, "file", l.ownerUid);
      }
    }
    if (await cleanupSecureRetiredFiles(directory, "run-files") !== "clean") terminalEnvironmentProtocolError();
    for (const entry of await fs.readdir(directory.fdPath)) {
      const identity = entry === TERMINAL_RUN_REQUEST ? l.request : entry === TERMINAL_RUN_STATUS ? l.status : null;
      if (!identity && (preparing || entry !== TERMINAL_RUN_CLAIM)) terminalEnvironmentProtocolError();
      await checkCurrent();
      const stat = await fs.lstat(path.join(directory.fdPath, entry));
      assertTerminalEnvironmentStat(stat, identity, "file", l.ownerUid);
      const retired = await retireSecureEntry({ parent: directory, name: entry, expected: { dev: stat.dev, ino: stat.ino }, kind: "file", privateSlotScope: "run-files" });
      await checkCurrent();
      if (!retired || !await removeRetiredSecureFile(directory, retired)) terminalEnvironmentProtocolError();
    }
    await assertSecureDirectoryCurrent(root, data.realPath);
    const retired = retiredName && name === retiredName ? { privateName: name, stat: await directory.handle.stat(), kind: "directory" as const }
      : await retireSecureEntry({ parent: root, name, expected: terminalEnvironmentInode(l.directory), kind: "directory", privateSlotScope: scope });
    if (!retired || !await removeRetiredEmptySecureDirectory(root, retired, { scope, ownerUid: l.ownerUid })) terminalEnvironmentProtocolError();
  } finally { await closeSecureDirectories(directory, root, data); }
}
