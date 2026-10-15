import fs, { type FileHandle } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import {
  assertSecureDirectoryCurrent, closeSecureDirectories, openExistingSecureChildDirectory,
  openSecureRootDirectory, type SecureDirectory
} from "../../infra/fs/secure-directory.js";
import {
  assertTerminalEnvironmentLaunchLocator, assertTerminalEnvironmentStat, assertTerminalLaunchStatus,
  TERMINAL_ENV_LAUNCH_ROOT, TERMINAL_ENV_PAYLOAD_NAME, TERMINAL_ENV_STATUS_NAME,
  TERMINAL_ENV_STATUS_MAX_BYTES, terminalEnvironmentProtocolError,
  type TerminalEnvironmentIdentity, type TerminalEnvironmentLaunchLocator, type TerminalLaunchStatus
} from "./terminal-env-launch.protocol.js";

export type TerminalEnvironmentDirectories = { data: SecureDirectory; root: SecureDirectory; directory: SecureDirectory };
/** Every open is pinned to the durable identity; a pathname cannot authorize a replacement. */
export async function openTerminalEnvironmentDirectories(locator: TerminalEnvironmentLaunchLocator): Promise<TerminalEnvironmentDirectories> {
  assertTerminalEnvironmentLaunchLocator(locator);
  let data: SecureDirectory | undefined, root: SecureDirectory | undefined, directory: SecureDirectory | undefined;
  try {
    data = await openSecureRootDirectory(locator.dataDir);
    assertTerminalEnvironmentStat(await data.handle.stat(), locator.dataRoot, "directory", locator.ownerUid, false);
    root = await openExistingSecureChildDirectory(data, TERMINAL_ENV_LAUNCH_ROOT);
    assertTerminalEnvironmentStat(await root.handle.stat(), locator.launchRoot, "directory", locator.ownerUid);
    directory = await openExistingSecureChildDirectory(root, locator.directoryName);
    assertTerminalEnvironmentStat(await directory.handle.stat(), locator.attemptDirectory, "directory", locator.ownerUid);
    const directories = { data, root, directory };
    await assertTerminalEnvironmentDirectoriesCurrent(directories, locator);
    return directories;
  } catch {
    await closeSecureDirectories(directory, root, data);
    terminalEnvironmentProtocolError();
  }
}
export async function assertTerminalEnvironmentDirectoriesCurrent(dirs: TerminalEnvironmentDirectories, locator: TerminalEnvironmentLaunchLocator) {
  for (const [directory, identity, privateMode] of [
    [dirs.data, locator.dataRoot, false], [dirs.root, locator.launchRoot, true], [dirs.directory, locator.attemptDirectory, true]
  ] as const) {
    await assertSecureDirectoryCurrent(directory, dirs.data.realPath);
    assertTerminalEnvironmentStat(await directory.handle.stat(), identity, "directory", locator.ownerUid, privateMode);
  }
}
export async function openTerminalEnvironmentFile(params: {
  directory: SecureDirectory; name: typeof TERMINAL_ENV_PAYLOAD_NAME | typeof TERMINAL_ENV_STATUS_NAME;
  identity: TerminalEnvironmentIdentity; ownerUid: number; writable?: boolean;
}): Promise<FileHandle> {
  let handle: FileHandle | undefined;
  try {
    const name = path.join(params.directory.fdPath, params.name);
    assertTerminalEnvironmentStat(await fs.lstat(name), params.identity, "file", params.ownerUid);
    // O_NONBLOCK prevents a replacement FIFO/device from indefinitely blocking before fstat rejects it.
    handle = await fs.open(name, (params.writable ? constants.O_RDWR : constants.O_RDONLY)
      | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    assertTerminalEnvironmentStat(await handle.stat(), params.identity, "file", params.ownerUid);
    assertTerminalEnvironmentStat(await fs.lstat(name), params.identity, "file", params.ownerUid);
    return handle;
  } catch {
    await handle?.close().catch(() => undefined);
    terminalEnvironmentProtocolError();
  }
}
export async function assertTerminalEnvironmentFileCurrent(params: {
  directory: SecureDirectory; name: string; handle: FileHandle; identity: TerminalEnvironmentIdentity; ownerUid: number;
}) {
  assertTerminalEnvironmentStat(await params.handle.stat(), params.identity, "file", params.ownerUid);
  assertTerminalEnvironmentStat(await fs.lstat(path.join(params.directory.fdPath, params.name)), params.identity, "file", params.ownerUid);
}
/** A bounded read remains bounded even if a corrupt writer grows the file after fstat. */
export async function readBoundedTerminalEnvironmentFile(handle: FileHandle, maxBytes: number): Promise<string> {
  const stat = await handle.stat();
  if (stat.size > maxBytes || !Number.isSafeInteger(stat.size) || stat.size < 0) terminalEnvironmentProtocolError();
  const buffer = Buffer.alloc(maxBytes + 1);
  let total = 0;
  while (total < buffer.length) {
    const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  if (total > maxBytes) terminalEnvironmentProtocolError();
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, total)); }
  catch { terminalEnvironmentProtocolError(); }
}
/** Write at position zero and truncate the SAME inode, never rename or recreate the status. */
export async function writeTerminalEnvironmentStatus(params: {
  dirs: TerminalEnvironmentDirectories; locator: TerminalEnvironmentLaunchLocator; handle: FileHandle; status: TerminalLaunchStatus;
  cancelled?: () => boolean;
}): Promise<void> {
  const { locator, dirs, handle } = params;
  const assertActive = () => {
    if (params.status.state === "spawned" && params.cancelled?.()) terminalEnvironmentProtocolError();
  };
  assertTerminalLaunchStatus(params.status, locator.attemptId);
  await assertTerminalEnvironmentDirectoriesCurrent(dirs, locator);
  const file = { directory: dirs.directory, name: TERMINAL_ENV_STATUS_NAME, identity: locator.status, ownerUid: locator.ownerUid, handle };
  await assertTerminalEnvironmentFileCurrent(file);
  assertActive();
  const text = Buffer.from(JSON.stringify(params.status), "utf8");
  if (text.length > TERMINAL_ENV_STATUS_MAX_BYTES) terminalEnvironmentProtocolError();
  // Prepare an invalid/partial JSON image FIRST. Valid final JSON is the public commit boundary:
  // API may immediately retire/unlink the consumed files once it observes that final status.
  // Never validate the pathname, truncate or sync after publication: those would race legitimate
  // API cleanup and could incorrectly stop an already successfully spawned target.
  await handle.truncate(0);
  assertActive();
  await handle.truncate(text.length);
  let offset = 0;
  while (offset < text.length) {
    assertActive();
    const { bytesWritten } = await handle.write(text, offset, text.length - offset, offset);
    if (!bytesWritten) terminalEnvironmentProtocolError();
    offset += bytesWritten;
  }
  // Only close operations are allowed after the final byte; no protocol resource is consumed again.
}
export async function closeTerminalEnvironmentDirectories(dirs?: TerminalEnvironmentDirectories) {
  if (dirs) await closeSecureDirectories(dirs.directory, dirs.root, dirs.data);
}
