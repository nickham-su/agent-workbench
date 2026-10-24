import type { TerminalRunLocator } from "./terminal-run-control.protocol.js";
import { buildTerminalStartupBootstrap, TERMINAL_STARTUP_BOOTSTRAP_NAME } from "./terminal-startup-bootstrap.js";
import fs from "node:fs/promises";
import { constants, existsSync, type Stats } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type { Db } from "../../infra/db/db.js";
import { newId } from "../../utils/ids.js";
import {
  assertSecureDirectoryCurrent, closeSecureDirectories, openSecureRootDirectory,
  openExistingSecureChildDirectory, openSecureChildDirectory,
  retireSecureEntry, removeRetiredSecureFile, removeRetiredEmptySecureDirectory,
  securePrivateSlotIdentity, type SecureDirectory, type RetiredSecureEntry
} from "../../infra/fs/secure-directory.js";
import {
  assertTerminalEnvironmentPayload, assertTerminalEnvironmentStat, assertTerminalLaunchStatus,
  createTerminalEnvironmentPayload, terminalEnvironmentDirectoryName, terminalEnvironmentIdentity,
  terminalEnvironmentInode, terminalEnvironmentScopes, terminalEnvironmentProtocolError,
  TerminalEnvironmentLaunchError, TERMINAL_ENV_LAUNCH_ROOT, TERMINAL_ENV_PAYLOAD_NAME,
  TERMINAL_ENV_STATUS_NAME, TERMINAL_ENV_STATUS_MAX_BYTES,
  type TerminalEnvironmentIdentity, type TerminalEnvironmentLaunchLocator, type TerminalLaunchStatus
} from "./terminal-env-launch.protocol.js";
import {
  insertTerminalEnvironmentLaunchAttempt, getTerminalEnvironmentLaunchAttempt,
  updateTerminalEnvironmentLaunchAttempt, type TerminalEnvironmentLaunchAttempt
} from "./terminal-env-launch-attempt.store.js";
import {
  assertTerminalEnvironmentDirectoriesCurrent, assertTerminalEnvironmentFileCurrent,
  closeTerminalEnvironmentDirectories, openTerminalEnvironmentDirectories,
  openTerminalEnvironmentFile, readBoundedTerminalEnvironmentFile
} from "./terminal-env-launch.files.js";

export type PreparedTerminalEnvironmentLaunch = { attempt: TerminalEnvironmentLaunchAttempt; command: string[] };
export type TerminalEnvironmentLaunchTestHooks = {
  /** Crash windows before the newly created object's identity is durable. Never receives payload contents. */
  afterCreate?: (kind: "directory" | "payload" | "status" | "bootstrap") => Promise<void> | void;
  /** Crash after rename but before unlink/rmdir, exercising restart recovery from durable identity. */
  afterRetire?: (params: { kind: "file" | "directory"; parentFdPath: string; privateName: string }) => Promise<void> | void;
};
export function terminalEnvironmentLaunchLocator(dataDir: string, attempt: TerminalEnvironmentLaunchAttempt): TerminalEnvironmentLaunchLocator {
  if (!attempt.launchRoot || !attempt.attemptDirectory || !attempt.payload || !attempt.status) terminalEnvironmentProtocolError();
  return {
    version: 1, attemptId: attempt.id, dataDir: path.resolve(dataDir), directoryName: attempt.directoryName,
    ownerUid: attempt.ownerUid, dataRoot: attempt.dataRoot, launchRoot: attempt.launchRoot,
    attemptDirectory: attempt.attemptDirectory, payload: attempt.payload, status: attempt.status,
    ...(attempt.bootstrap ? { bootstrap: attempt.bootstrap } : {})
  };
}
/** Resolves only alongside this trusted API module; never via Workspace PATH/cwd or arbitrary execArgv. */
export function resolveTerminalEnvironmentLauncherCommand(locator: TerminalEnvironmentLaunchLocator): string[] {
  const sourceMode = import.meta.url.endsWith(".ts");
  const entry = fileURLToPath(new URL(sourceMode ? "./terminal-env-launcher.ts" : "./terminal-env-launcher.js", import.meta.url));
  if (!existsSync(entry) || !existsSync(process.execPath) || !existsSync("/usr/bin/env")) {
    throw new TerminalEnvironmentLaunchError("TERMINAL_ENV_PREPARE_FAILED");
  }
  const args: string[] = ["/usr/bin/env", "-u", "NODE_OPTIONS", "-u", "NODE_PATH", process.execPath];
  if (sourceMode) {
    // Absolute, project-resolved loader. Do not accept inherited --import, debugger or --env-file options.
    const loader = createRequire(import.meta.url).resolve("tsx");
    args.push("--import", pathToFileURL(loader).href);
  }
  args.push(entry, JSON.stringify(locator));
  return args;
}
async function checkDirectory(directory: SecureDirectory, data: SecureDirectory, expected: TerminalEnvironmentIdentity | null, uid: number, privateMode = true) {
  await assertSecureDirectoryCurrent(directory, data.realPath);
  assertTerminalEnvironmentStat(await directory.handle.stat(), expected, "directory", uid, privateMode);
}
/** The caller must already own Workspace admission and have inserted terminal.creating. */
export async function prepareTerminalEnvironmentLaunch(params: {
  db: Db; dataDir: string; terminalId: string; shell: string;
  workspaceEnv: Readonly<Record<string, string>>; systemEnv: Record<string, string>;
  baseEnv?: NodeJS.ProcessEnv; hooks?: TerminalEnvironmentLaunchTestHooks; startupCommand?: string; runControl?: TerminalRunLocator;
}): Promise<PreparedTerminalEnvironmentLaunch> {
  const id = newId("te");
  const directoryName = terminalEnvironmentDirectoryName(params.terminalId, id);
  const payload = createTerminalEnvironmentPayload({ attemptId: id, shell: params.shell,
    baseEnv: params.baseEnv ?? process.env, systemEnv: params.systemEnv, workspaceEnv: params.workspaceEnv });
  const bootstrap = params.startupCommand === undefined ? undefined : buildTerminalStartupBootstrap(params.startupCommand, id);
  if (bootstrap !== undefined && params.shell !== "bash") terminalEnvironmentProtocolError();
  const ownerUid = process.getuid?.();
  if (ownerUid === undefined) throw new TerminalEnvironmentLaunchError("TERMINAL_ENV_PREPARE_FAILED");
  let data: SecureDirectory | undefined, root: SecureDirectory | undefined, directory: SecureDirectory | undefined;
  let armed = false;
  try {
    data = await openSecureRootDirectory(params.dataDir);
    await checkDirectory(data, data, null, ownerUid, false);
    const now = Date.now();
    let attempt: TerminalEnvironmentLaunchAttempt = {
      id, terminalId: params.terminalId, directoryName, phase: "armed", ownerUid,
      dataRoot: terminalEnvironmentIdentity(await data.handle.stat()), launchRoot: null, attemptDirectory: null,
      payload: null, status: null, directoryArmed: false, payloadArmed: false, statusArmed: false,
      errorCode: null, createdAt: now, updatedAt: now
    };
    insertTerminalEnvironmentLaunchAttempt(params.db, attempt);
    armed = true;
    // The shared root contains no attempt secrets until its identity is durable.
    root = await openSecureChildDirectory(data, TERMINAL_ENV_LAUNCH_ROOT);
    await checkDirectory(root, data, null, ownerUid);
    await checkDirectory(data, data, attempt.dataRoot, ownerUid, false);
    attempt = updateTerminalEnvironmentLaunchAttempt(params.db, id, { launchRoot: terminalEnvironmentIdentity(await root.handle.stat()) });
    attempt = updateTerminalEnvironmentLaunchAttempt(params.db, id, { directoryArmed: true });
    await checkDirectory(root, data, attempt.launchRoot, ownerUid);
    // Unlike shared-root creation, an attempt directory must not reuse a pre-existing object.
    await fs.mkdir(path.join(root.fdPath, directoryName), { mode: 0o700 });
    await params.hooks?.afterCreate?.("directory");
    directory = await openExistingSecureChildDirectory(root, directoryName);
    await checkDirectory(directory, data, null, ownerUid);
    attempt = updateTerminalEnvironmentLaunchAttempt(params.db, id, { attemptDirectory: terminalEnvironmentIdentity(await directory.handle.stat()) });
    for (const kind of (bootstrap === undefined ? ["payload", "status"] as const : ["payload", "status", "bootstrap"] as const)) {
      const name = kind === "payload" ? TERMINAL_ENV_PAYLOAD_NAME : kind === "status" ? TERMINAL_ENV_STATUS_NAME : TERMINAL_STARTUP_BOOTSTRAP_NAME;
      attempt = updateTerminalEnvironmentLaunchAttempt(params.db, id, { [`${kind}Armed`]: true });
      await checkDirectory(data, data, attempt.dataRoot, ownerUid, false);
      await checkDirectory(root, data, attempt.launchRoot, ownerUid);
      await checkDirectory(directory, data, attempt.attemptDirectory, ownerUid);
      const handle = await fs.open(path.join(directory.fdPath, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await params.hooks?.afterCreate?.(kind);
        const stat = await handle.stat();
        assertTerminalEnvironmentStat(stat, null, "file", ownerUid);
        await checkDirectory(data, data, attempt.dataRoot, ownerUid, false);
        await checkDirectory(root, data, attempt.launchRoot, ownerUid);
        await checkDirectory(directory, data, attempt.attemptDirectory, ownerUid);
        const identity = terminalEnvironmentIdentity(stat);
        // Persist identity BEFORE writing plaintext, so the secret-write stage has durable authority.
        attempt = updateTerminalEnvironmentLaunchAttempt(params.db, id, { [kind]: identity });
        await assertTerminalEnvironmentFileCurrent({ directory, name, handle, identity, ownerUid });
        const body = kind === "payload" ? JSON.stringify(payload) : kind === "bootstrap" ? bootstrap! : JSON.stringify({ version: 1, attemptId: id, state: "pending" });
        await handle.writeFile(body, "utf8");
        await handle.sync();
        await assertTerminalEnvironmentFileCurrent({ directory, name, handle, identity, ownerUid });
        await checkDirectory(data, data, attempt.dataRoot, ownerUid, false);
        await checkDirectory(root, data, attempt.launchRoot, ownerUid);
        await checkDirectory(directory, data, attempt.attemptDirectory, ownerUid);
      } finally { await handle.close().catch(() => undefined); }
    }
    assertTerminalEnvironmentPayload(payload, id);
    attempt = updateTerminalEnvironmentLaunchAttempt(params.db, id, { phase: "prepared" });
    const locator = terminalEnvironmentLaunchLocator(params.dataDir, attempt);
    if (params.runControl) locator.runControl = params.runControl;
    const command = resolveTerminalEnvironmentLauncherCommand(locator);
    return { attempt, command };
  } catch (error) {
    if (armed) {
      try { updateTerminalEnvironmentLaunchAttempt(params.db, id, { phase: "cleanup_pending", errorCode: "TERMINAL_ENV_PREPARE_FAILED" }); } catch { /* Keep original authority on storage failure. */ }
    }
    if (error instanceof TerminalEnvironmentLaunchError) throw error;
    throw new TerminalEnvironmentLaunchError("TERMINAL_ENV_PREPARE_FAILED");
  } finally { await closeSecureDirectories(directory, root, data); }
}
/** Persist immediately before the tmux side effect, still inside the same Workspace admission. */
export function markTerminalEnvironmentLaunchStarting(db: Db, attemptId: string): TerminalEnvironmentLaunchAttempt {
  const attempt = getTerminalEnvironmentLaunchAttempt(db, attemptId);
  if (!attempt || attempt.phase !== "prepared") terminalEnvironmentProtocolError();
  return updateTerminalEnvironmentLaunchAttempt(db, attemptId, { phase: "launching" });
}
/** Only proves shell spawn. The caller must independently require session presence before activation. */
export async function waitTerminalEnvironmentLaunch(params: {
  dataDir: string; attempt: TerminalEnvironmentLaunchAttempt; timeoutMs?: number; pollMs?: number; abortSignal?: AbortSignal;
}): Promise<Exclude<TerminalLaunchStatus, { state: "pending" }>> {
  const locator = terminalEnvironmentLaunchLocator(params.dataDir, params.attempt);
  const timeout = Math.min(params.timeoutMs ?? 10_000, 10_000), interval = Math.min(params.pollMs ?? 50, 1000);
  if (!(timeout > 0) || !(interval > 0)) terminalEnvironmentProtocolError();
  const deadline = performance.now() + timeout;
  const dirs = await openTerminalEnvironmentDirectories(locator);
  try {
    while (performance.now() < deadline) {
      if (params.abortSignal?.aborted) terminalEnvironmentProtocolError();
      await assertTerminalEnvironmentDirectoriesCurrent(dirs, locator);
      const handle = await openTerminalEnvironmentFile({ directory: dirs.directory, name: TERMINAL_ENV_STATUS_NAME, identity: locator.status, ownerUid: locator.ownerUid });
      let text: string;
      try {
        text = await readBoundedTerminalEnvironmentFile(handle, TERMINAL_ENV_STATUS_MAX_BYTES);
        await assertTerminalEnvironmentFileCurrent({ directory: dirs.directory, name: TERMINAL_ENV_STATUS_NAME, handle, identity: locator.status, ownerUid: locator.ownerUid });
      } finally { await handle.close().catch(() => undefined); }
      let status: unknown;
      try { status = JSON.parse(text); } catch { /* Same-inode updates can temporarily have partial JSON. */ }
      if (status !== undefined) {
        assertTerminalLaunchStatus(status, locator.attemptId);
        if (status.state !== "pending") return status;
      }
      await delay(Math.min(interval, Math.max(1, deadline - performance.now())), undefined, { signal: params.abortSignal });
    }
    throw new TerminalEnvironmentLaunchError("TERMINAL_ENV_START_TIMEOUT");
  } catch (error) {
    if (error instanceof TerminalEnvironmentLaunchError) throw error;
    terminalEnvironmentProtocolError();
  } finally { await closeTerminalEnvironmentDirectories(dirs); }
}

type Candidate = { name: string; stat: Stats; retired: boolean };
function relatedSlot(name: string, scope: string) {
  const ordinary = name.startsWith(".delete-replacement-pending-") ? name.slice(".delete-replacement-pending-".length) : name;
  const exactPrefix = (prefix: string) => ordinary === `${prefix}${scope}` || ordinary.startsWith(`${prefix}${scope}-`);
  return securePrivateSlotIdentity(ordinary)?.scope === scope
    || exactPrefix(".delete-v1-") || exactPrefix(".terminal-auth-cleanup-v1-");
}
/** Only inspect this attempt's business name and exact scope. Other root objects neither authorize deletion nor globally block it. */
async function locateEntry(params: {
  parent: SecureDirectory; name: string; scope: string; kind: "file" | "directory"; expected: TerminalEnvironmentIdentity | null; uid: number;
}): Promise<Candidate | null> {
  const entries = await fs.readdir(params.parent.fdPath);
  const relevant = entries.filter((name) => name === params.name || relatedSlot(name, params.scope));
  if (relevant.length === 0) return null;
  if (relevant.length !== 1 || !params.expected) terminalEnvironmentProtocolError();
  const name = relevant[0]!;
  const retired = name !== params.name;
  if (retired) {
    if (name.startsWith(".delete-replacement-pending-")) terminalEnvironmentProtocolError();
    const slot = securePrivateSlotIdentity(name);
    if (!slot || slot.scope !== params.scope || slot.kind !== params.kind
      || String(slot.dev) !== params.expected.dev || String(slot.ino) !== params.expected.ino) terminalEnvironmentProtocolError();
  }
  const stat = await fs.lstat(path.join(params.parent.fdPath, name));
  assertTerminalEnvironmentStat(stat, params.expected, params.kind, params.uid);
  return { name, stat, retired };
}
/**
 * This is filesystem convergence only. 'stopped' requires a fresh, certain absence/stop;
 * 'spawned' requires the consumed trusted handshake and certain presence. C2 owns that authorization.
 * The attempt row is deliberately NOT removed here: activation/deletion removes it in the final DB transaction.
 */
export async function cleanupTerminalEnvironmentLaunch(params: {
  db: Db; dataDir: string; attemptId: string; consumption: "stopped" | "spawned"; hooks?: TerminalEnvironmentLaunchTestHooks;
}): Promise<"clean" | "pending"> {
  let data: SecureDirectory | undefined, root: SecureDirectory | undefined, directory: SecureDirectory | undefined;
  try {
    if (params.consumption !== "stopped" && params.consumption !== "spawned") terminalEnvironmentProtocolError();
    const attempt = getTerminalEnvironmentLaunchAttempt(params.db, params.attemptId);
    if (!attempt) return "clean";
    data = await openSecureRootDirectory(params.dataDir);
    await checkDirectory(data, data, attempt.dataRoot, attempt.ownerUid, false);
    if (!attempt.launchRoot) {
      if (attempt.directoryArmed || attempt.payloadArmed || attempt.statusArmed || attempt.bootstrapArmed) terminalEnvironmentProtocolError();
      return "clean"; // Shared-root establishment window has not armed any secret child.
    }
    root = await openExistingSecureChildDirectory(data, TERMINAL_ENV_LAUNCH_ROOT);
    await checkDirectory(root, data, attempt.launchRoot, attempt.ownerUid);
    const scopes = terminalEnvironmentScopes(attempt.id);
    const candidate = await locateEntry({ parent: root, name: attempt.directoryName, scope: scopes.directory,
      expected: attempt.attemptDirectory, uid: attempt.ownerUid, kind: "directory" });
    if (!candidate) return "clean";
    directory = await openExistingSecureChildDirectory(root, candidate.name);
    await checkDirectory(directory, data, attempt.attemptDirectory, attempt.ownerUid);
    for (const kind of ["payload", "status", "bootstrap"] as const) {
      const name = kind === "payload" ? TERMINAL_ENV_PAYLOAD_NAME : kind === "status" ? TERMINAL_ENV_STATUS_NAME : TERMINAL_STARTUP_BOOTSTRAP_NAME;
      await checkDirectory(data, data, attempt.dataRoot, attempt.ownerUid, false);
      await checkDirectory(root, data, attempt.launchRoot, attempt.ownerUid);
      await checkDirectory(directory, data, attempt.attemptDirectory, attempt.ownerUid);
      const file = await locateEntry({ parent: directory, name, scope: scopes[kind], expected: attempt[kind] ?? null, uid: attempt.ownerUid, kind: "file" });
      if (!file) continue;
      const retired = file.retired ? { privateName: file.name, stat: file.stat, kind: "file" as const }
        : await retireSecureEntry({ parent: directory, name, expected: terminalEnvironmentInode(attempt[kind]!), kind: "file", privateSlotScope: scopes[kind] });
      if (!retired) terminalEnvironmentProtocolError();
      assertTerminalEnvironmentStat(retired.stat, attempt[kind] ?? null, "file", attempt.ownerUid);
      if (!file.retired) await params.hooks?.afterRetire?.({ kind: "file", parentFdPath: directory.fdPath, privateName: retired.privateName });
      await checkDirectory(data, data, attempt.dataRoot, attempt.ownerUid, false);
      await checkDirectory(root, data, attempt.launchRoot, attempt.ownerUid);
      await checkDirectory(directory, data, attempt.attemptDirectory, attempt.ownerUid);
      const current = await fs.lstat(path.join(directory.fdPath, retired.privateName));
      assertTerminalEnvironmentStat(current, attempt[kind] ?? null, "file", attempt.ownerUid);
      if (!await removeRetiredSecureFile(directory, retired)) terminalEnvironmentProtocolError();
      if (await locateEntry({ parent: directory, name, scope: scopes[kind], expected: attempt[kind] ?? null, uid: attempt.ownerUid, kind: "file" })) terminalEnvironmentProtocolError();
    }
    if ((await fs.readdir(directory.fdPath)).length !== 0) terminalEnvironmentProtocolError();
    await checkDirectory(data, data, attempt.dataRoot, attempt.ownerUid, false);
    await checkDirectory(root, data, attempt.launchRoot, attempt.ownerUid);
    await checkDirectory(directory, data, attempt.attemptDirectory, attempt.ownerUid);
    const retiredDirectory: RetiredSecureEntry | null = candidate.retired
      ? { privateName: candidate.name, stat: candidate.stat, kind: "directory" }
      : await retireSecureEntry({ parent: root, name: attempt.directoryName, expected: terminalEnvironmentInode(attempt.attemptDirectory!),
        kind: "directory", privateSlotScope: scopes.directory });
    if (!retiredDirectory) terminalEnvironmentProtocolError();
    if (!candidate.retired) await params.hooks?.afterRetire?.({ kind: "directory", parentFdPath: root.fdPath, privateName: retiredDirectory.privateName });
    await checkDirectory(data, data, attempt.dataRoot, attempt.ownerUid, false);
    await checkDirectory(root, data, attempt.launchRoot, attempt.ownerUid);
    if (!await removeRetiredEmptySecureDirectory(root, retiredDirectory, { scope: scopes.directory, ownerUid: attempt.ownerUid })) terminalEnvironmentProtocolError();
    if (await locateEntry({ parent: root, name: attempt.directoryName, scope: scopes.directory,
      expected: attempt.attemptDirectory, uid: attempt.ownerUid, kind: "directory" })) terminalEnvironmentProtocolError();
    return "clean";
  } catch {
    try { updateTerminalEnvironmentLaunchAttempt(params.db, params.attemptId, { phase: "cleanup_pending", errorCode: "TERMINAL_ENV_CLEANUP_PENDING" }); }
    catch { /* Never discard the original locator if a diagnostic write fails. */ }
    return "pending";
  } finally { await closeSecureDirectories(directory, root, data); }
}
