import crypto from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

export type SecureDirectory = {
  handle: fs.FileHandle;
  fdPath: string;
  logicalPath: string;
  realPath: string;
  stat: import("node:fs").Stats;
};

type Inode = { dev: number; ino: number };

function fdDirectoryPath(fd: number) {
  if (process.platform === "linux") return `/proc/self/fd/${fd}`;
  if (process.platform === "darwin") return `/dev/fd/${fd}`;
  throw new Error("secure directory operations require directory fd path support");
}

function safeSegment(value: string) {
  return /^[A-Za-z0-9._-]{1,160}$/.test(value) && value !== "." && value !== "..";
}

function sameInode(stat: Inode, expected: Inode) {
  return stat.dev === expected.dev && stat.ino === expected.ino;
}

function isInside(rootPath: string, targetPath: string) {
  const relative = path.relative(rootPath, targetPath);
  return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isInsideOrSame(rootPath: string, targetPath: string) {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function openDirectoryAt(logicalPath: string) {
  const stat = await fs.lstat(logicalPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("secure directory must be a non-symlink directory");
  const handle = await fs.open(logicalPath, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try {
    const fdPath = fdDirectoryPath(handle.fd);
    const [openedStat, realPath] = await Promise.all([handle.stat(), fs.realpath(fdPath)]);
    if (!openedStat.isDirectory()) throw new Error("secure directory handle is not a directory");
    const current = await fs.lstat(logicalPath);
    if (current.isSymbolicLink() || !sameInode(current, openedStat)) throw new Error("secure directory changed while opening");
    return { handle, fdPath, logicalPath, realPath, stat: openedStat } satisfies SecureDirectory;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

/** 打开可信根目录；不支持目录 fd 能力的平台 fail-closed。 */
export async function openSecureRootDirectory(rootPath: string) {
  return openDirectoryAt(path.resolve(rootPath));
}

async function openSecureChildDirectoryInternal(parent: SecureDirectory, name: string, create: boolean) {
  if (!safeSegment(name)) throw new Error("invalid secure directory segment");
  const childPath = path.join(parent.fdPath, name);
  if (create) {
    try {
      await fs.mkdir(childPath, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const child = await openDirectoryAt(childPath);
  try {
    if (!isInside(parent.realPath, child.realPath)) throw new Error("secure child directory escapes parent");
    const current = await fs.lstat(path.join(parent.fdPath, name));
    if (current.isSymbolicLink() || !sameInode(current, child.stat)) throw new Error("secure child directory changed while opening");
    return { ...child, logicalPath: path.join(parent.logicalPath, name) } satisfies SecureDirectory;
  } catch (error) {
    await child.handle.close().catch(() => undefined);
    throw error;
  }
}

export async function openSecureChildDirectory(parent: SecureDirectory, name: string) {
  return openSecureChildDirectoryInternal(parent, name, true);
}

export async function openExistingSecureChildDirectory(parent: SecureDirectory, name: string) {
  return openSecureChildDirectoryInternal(parent, name, false);
}

export async function assertSecureDirectoryCurrent(directory: SecureDirectory, trustedRootRealPath: string) {
  const [current, currentRealPath] = await Promise.all([fs.lstat(directory.logicalPath), fs.realpath(directory.logicalPath)]);
  if (current.isSymbolicLink() || !sameInode(current, directory.stat) || !isInsideOrSame(trustedRootRealPath, currentRealPath)) {
    throw new Error("secure directory changed or escaped its trusted root");
  }
}

export async function closeSecureDirectories(...directories: Array<SecureDirectory | null | undefined>) {
  // 调用方已按子→父顺序传入；顺序关闭避免子目录 fd 存活期间父能力提前失效。
  for (const directory of directories) {
    await directory?.handle.close().catch(() => undefined);
  }
}

export function isSecurePathInside(rootPath: string, targetPath: string) {
  return isInside(rootPath, targetPath);
}

export type SecureDirectoryRemovalResult = "removed" | "not_found" | "replacement_pending";

export type RetiredSecureEntry = {
  privateName: string;
  stat: import("node:fs").Stats;
  kind: SecureEntryKind;
};

export type SecureEntryKind = "file" | "directory";

function expectedEntryMatches(current: import("node:fs").Stats, expected: Inode, kind: SecureEntryKind) {
  return !current.isSymbolicLink()
    && sameInode(current, expected)
    && (kind === "directory" ? current.isDirectory() : current.isFile());
}

type PrivateSlotIdentity = Inode & { kind: SecureEntryKind; scope: string };

const PRIVATE_SLOT_PREFIX = ".delete-v1-";
const TERMINAL_AUTH_ROOT_SLOT_PREFIX = ".terminal-auth-cleanup-v1-";
const PRIVATE_SLOT_NONCE_LENGTH = 32;
const PRIVATE_SLOT_RE = /^\.delete-v1-([A-Za-z0-9_-]{1,48})-([fd])-([0-9a-z]+)-([0-9a-z]+)-([0-9a-f]{32})$/;

function assertPrivateSlotScope(scope: string) {
  if (!/^[A-Za-z0-9_-]{1,48}$/.test(scope)) throw new Error("invalid secure private deletion scope");
  return scope;
}

function encodePrivateSlotNumber(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid secure private deletion identity");
  return value.toString(36);
}

function decodePrivateSlotNumber(value: string) {
  const parsed = Number.parseInt(value, 36);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed.toString(36) === value ? parsed : null;
}

function privateDeleteName(identity: PrivateSlotIdentity) {
  const kind = identity.kind === "file" ? "f" : "d";
  return `${PRIVATE_SLOT_PREFIX}${assertPrivateSlotScope(identity.scope)}-${kind}-${encodePrivateSlotNumber(identity.dev)}-${encodePrivateSlotNumber(identity.ino)}-${crypto.randomBytes(PRIVATE_SLOT_NONCE_LENGTH / 2).toString("hex")}`;
}

/** 暴露给跨受控目录迁移的调用方：新名称仍携带同一 expected identity 与业务 scope。 */
export function securePrivateDeleteName(identity: PrivateSlotIdentity) {
  return privateDeleteName(identity);
}

function parsePrivateDeleteName(name: string): PrivateSlotIdentity | null {
  const canonicalName = name.startsWith(TERMINAL_AUTH_ROOT_SLOT_PREFIX) ? `${PRIVATE_SLOT_PREFIX}${name.slice(TERMINAL_AUTH_ROOT_SLOT_PREFIX.length)}` : name;
  const match = PRIVATE_SLOT_RE.exec(canonicalName);
  if (!match) return null;
  const dev = decodePrivateSlotNumber(match[3]!);
  const ino = decodePrivateSlotNumber(match[4]!);
  if (dev === null || ino === null) return null;
  return { scope: match[1]!, kind: match[2] === "f" ? "file" : "directory", dev, ino };
}

function replacementPendingName(privateName: string) {
  return `.delete-replacement-pending-${privateName}`;
}

export function isReplacementPendingName(name: string) {
  return name.startsWith(".delete-replacement-pending-");
}

function isOrdinaryPrivateDeleteName(name: string) {
  return name.startsWith(".delete-") && !isReplacementPendingName(name);
}

function privateSlotMatches(current: import("node:fs").Stats, identity: PrivateSlotIdentity) {
  return expectedEntryMatches(current, identity, identity.kind);
}

async function assertPrivateDirectory(directory: SecureDirectory) {
  const stat = await directory.handle.stat();
  if ((stat.mode & 0o777) !== 0o700) {
    throw new Error("secure private deletion directory must have mode 0700");
  }
}

/** 已检测到 replacement 后永久标记该私有槽；后续 stale cleanup 必须跳过它。 */
async function retainDetectedReplacement(parent: SecureDirectory, privateName: string) {
  try {
    await fs.rename(
      path.join(parent.fdPath, privateName),
      path.join(parent.fdPath, replacementPendingName(privateName)),
    );
  } catch {
    // rename 失败时不能把结果误判成已安全清理；调用者仍会得到 fail-closed 错误。
  }
}

/** 调用方已验证到 private slot replacement 时，将该未知对象保留为 durable marker。 */
export async function retainSecureEntryReplacement(parent: SecureDirectory, privateName: string) {
  if (!safeSegment(privateName)) throw new Error("invalid secure private entry name");
  await retainDetectedReplacement(parent, privateName);
}

/**
 * 将业务名称隔离到不可预测的私有删除槽。之后所有删除只针对该槽名称，绝不再
 * 对原业务名称执行 unlink/rmdir。已检测到 inode/type 不匹配时将对象标记为
 * replacement pending，后续 stale cleanup 也不会触碰它。
 */
export async function retireSecureEntry(params: {
  parent: SecureDirectory;
  name: string;
  expected: Inode;
  kind: SecureEntryKind;
  /** 关联业务对象的安全 token；与 dev/ino/type 一同编码进私有槽。 */
  privateSlotScope?: string;
}): Promise<RetiredSecureEntry | null> {
  if (!safeSegment(params.name)) throw new Error("invalid secure entry name");
  await assertPrivateDirectory(params.parent);
  const source = path.join(params.parent.fdPath, params.name);
  const privateName = privateDeleteName({ ...params.expected, kind: params.kind, scope: params.privateSlotScope ?? "tree" });
  if (!safeSegment(privateName)) throw new Error("secure private deletion name is too long");
  const privatePath = path.join(params.parent.fdPath, privateName);
  try {
    await fs.rename(source, privatePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const retired = await fs.lstat(privatePath);
  if (!retired || !expectedEntryMatches(retired, params.expected, params.kind)) {
    // 不尝试把未知对象 rename 回业务名：业务名可能已被并发创建，覆盖会破坏该对象。
    await retainDetectedReplacement(params.parent, privateName);
    throw new Error("secure entry replacement retained in private deletion slot");
  }
  return { privateName, stat: retired, kind: params.kind };
}

/**
 * 收敛受控目录中前一次失败遗留的普通 file 私有删除槽。replacement marker 是
 * 已识别的未知对象，绝不自动删除，调用方必须将结果保留为 durable pending。
 */
export async function cleanupSecureRetiredFiles(directory: SecureDirectory, scope?: string): Promise<"clean" | "replacement_pending"> {
  await assertPrivateDirectory(directory);
  if (scope) assertPrivateSlotScope(scope);
  let replacementPending = false;
  const entries = await fs.readdir(directory.fdPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!safeSegment(entry.name)) throw new Error("unsafe secure private entry");
    if (isReplacementPendingName(entry.name)) {
      replacementPending = true;
      continue;
    }
    if (!isOrdinaryPrivateDeleteName(entry.name)) continue;
    const identity = parsePrivateDeleteName(entry.name);
    // 旧格式、未知格式和 scope 不属于可证明可删的普通私有槽；即使 marker rename
    // 失败，原始 identity 编码也会在下次 restart/retry 保持这个 pending 判定。
    if (!identity || (scope && identity.scope !== scope)) {
      replacementPending = true;
      if (!identity) await retainDetectedReplacement(directory, entry.name);
      continue;
    }
    const privatePath = path.join(directory.fdPath, entry.name);
    const current = await fs.lstat(privatePath).catch(() => null);
    if (!current || !privateSlotMatches(current, identity)) {
      replacementPending = true;
      if (current) await retainDetectedReplacement(directory, entry.name);
      continue;
    }
    if (identity.kind !== "file") {
      replacementPending = true;
      continue;
    }
    try {
      await fs.unlink(privatePath);
    } catch {
      // 保留 identity encoded slot，下一次仍按同一 expected identity 复验。
      replacementPending = true;
    }
  }
  return replacementPending ? "replacement_pending" : "clean";
}

export type SecureRetiredFileTestHooks = {
  /** 仅测试注入：replacement 已检测后替代诊断 marker rename。 */
  retainReplacementForTest?: (params: { parent: SecureDirectory; privateName: string }) => Promise<void> | void;
};

/** 删除已 retire 的普通 file；失败时保留 identity-encoded slot 供后续安全重试。 */
export async function removeRetiredSecureFile(parent: SecureDirectory, retired: RetiredSecureEntry, hooks?: SecureRetiredFileTestHooks): Promise<boolean> {
  if (retired.kind !== "file") throw new Error("secure retired entry is not a file");
  try {
    await assertRetiredSlotCurrent(parent, retired, hooks?.retainReplacementForTest);
  } catch {
    // identity 验证失败时 assertRetiredSlotCurrent 已尽力保留诊断 marker；无论 marker
    // rename 是否 EIO，原 v1 槽仍保留 expected identity 供后续 pending 判定。
    return false;
  }
  try {
    await fs.unlink(path.join(parent.fdPath, retired.privateName));
    return true;
  } catch {
    // unlink 的 EIO/不确定结果并不等于 observed replacement；保留 v1 槽，以便
    // attachment fallback 移入 stable root，或由后续严格 identity scan 重试。
    return false;
  }
}

function secureReplacementPendingError() {
  return new Error("secure replacement pending");
}

/**
 * 私有删除槽必须按名称编码的 expected identity 处理，禁止再次 retire 成业务对象。
 */
async function removeValidatedRetiredEntry(
  parent: SecureDirectory,
  retired: RetiredSecureEntry,
  afterPinned?: (params: { parentFdPath: string; name: string }) => Promise<void> | void,
  afterRetireForTest?: (params: { parentFdPath: string; name: string; kind: "file" | "directory" }) => Promise<void> | void,
): Promise<void> {
  const identity = privateSlotIdentityForRetired(retired);
  if (!identity || identity.kind !== retired.kind) {
    await retainDetectedReplacement(parent, retired.privateName);
    throw secureReplacementPendingError();
  }
  try {
    await assertRetiredSlotCurrent(parent, retired);
  } catch {
    throw secureReplacementPendingError();
  }
  const privatePath = path.join(parent.fdPath, retired.privateName);
  if (retired.kind === "file") {
    try {
      await fs.unlink(privatePath);
      return;
    } catch {
      // EIO 等不确定结果保留原 v1 槽，供下一次严格复验。
      throw secureReplacementPendingError();
    }
  }

  let pinned: SecureDirectory;
  try {
    pinned = await openPinnedDirectoryAt(parent, retired.privateName, retired.stat);
  } catch {
    await retainDetectedReplacement(parent, retired.privateName);
    throw secureReplacementPendingError();
  }
  try {
    await afterPinned?.({ parentFdPath: parent.fdPath, name: retired.privateName });
    await removePinnedDirectoryContents(pinned, afterRetireForTest);
  } finally {
    await pinned.handle.close().catch(() => undefined);
  }
  try {
    await assertRetiredSlotCurrent(parent, retired);
    await fs.rmdir(privatePath);
  } catch {
    throw secureReplacementPendingError();
  }
}

export function securePrivateSlotIdentity(name: string): PrivateSlotIdentity | null {
  return parsePrivateDeleteName(name);
}

function privateSlotIdentityForRetired(retired: RetiredSecureEntry): PrivateSlotIdentity | null {
  return parsePrivateDeleteName(retired.privateName);
}

async function assertRetiredSlotCurrent(
  parent: SecureDirectory,
  retired: RetiredSecureEntry,
  retainReplacementForTest?: SecureRetiredFileTestHooks["retainReplacementForTest"],
) {
  const current = await fs.lstat(path.join(parent.fdPath, retired.privateName));
  const identity = privateSlotIdentityForRetired(retired);
  if (!identity || !privateSlotMatches(current, identity) || !expectedEntryMatches(current, retired.stat, retired.kind)) {
    if (retainReplacementForTest) await retainReplacementForTest({ parent, privateName: retired.privateName });
    else await retainDetectedReplacement(parent, retired.privateName);
    throw new Error("secure retired entry replacement retained");
  }
}

async function openPinnedDirectoryAt(parent: SecureDirectory, name: string, expected: Inode) {
  const entryPath = path.join(parent.fdPath, name);
  const handle = await fs.open(entryPath, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory() || !sameInode(stat, expected)) throw new Error("secure directory inode changed while opening");
    return { handle, fdPath: fdDirectoryPath(handle.fd), logicalPath: entryPath, realPath: await fs.realpath(fdDirectoryPath(handle.fd)), stat } satisfies SecureDirectory;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

/** 从固定 fd 递归清理。私有槽先按身份协议处理，普通业务项才会 retire。 */
async function removePinnedDirectoryContents(
  directory: SecureDirectory,
  afterRetireForTest?: (params: { parentFdPath: string; name: string; kind: "file" | "directory" }) => Promise<void> | void,
): Promise<void> {
  // 目录已隔离且不再属于业务路径，收紧权限后才在其中创建随机私有删除槽。
  await fs.chmod(directory.fdPath, 0o700);
  await assertPrivateDirectory(directory);
  const entries = await fs.readdir(directory.fdPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!safeSegment(entry.name)) throw new Error("unsafe entry in secure directory");
    if (isReplacementPendingName(entry.name)) throw secureReplacementPendingError();
    if (isOrdinaryPrivateDeleteName(entry.name)) {
      const identity = parsePrivateDeleteName(entry.name);
      if (!identity) {
        await retainDetectedReplacement(directory, entry.name);
        throw secureReplacementPendingError();
      }
      let current: import("node:fs").Stats;
      try {
        current = await fs.lstat(path.join(directory.fdPath, entry.name));
      } catch {
        throw secureReplacementPendingError();
      }
      if (!privateSlotMatches(current, identity)) {
        await retainDetectedReplacement(directory, entry.name);
        throw secureReplacementPendingError();
      }
      await removeValidatedRetiredEntry(directory, { privateName: entry.name, stat: current, kind: identity.kind }, undefined, afterRetireForTest);
      continue;
    }
    const entryPath = path.join(directory.fdPath, entry.name);
    const before = await fs.lstat(entryPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!before) continue;
    const kind = before.isDirectory() && !before.isSymbolicLink() ? "directory" : "file";
    if (before.isSymbolicLink() || (kind === "file" && !before.isFile())) {
      throw new Error("unsafe entry in secure directory");
    }
    const retired = await retireSecureEntry({ parent: directory, name: entry.name, expected: before, kind });
    if (!retired) continue;
    await afterRetireForTest?.({ parentFdPath: directory.fdPath, name: retired.privateName, kind });
    await removeValidatedRetiredEntry(directory, retired, undefined, afterRetireForTest);
  }
}

async function removeRetiredDirectory(parent: SecureDirectory, retired: RetiredSecureEntry, afterPinned?: (params: { parentFdPath: string; name: string }) => Promise<void> | void, afterRetireForTest?: (params: { parentFdPath: string; name: string; kind: "file" | "directory" }) => Promise<void> | void) {
  if (retired.kind !== "directory") throw new Error("secure retired entry is not a directory");
  await removeValidatedRetiredEntry(parent, retired, afterPinned, afterRetireForTest);
}

async function removeQuarantineEntries(quarantine: SecureDirectory, afterPinned?: (params: { parentFdPath: string; name: string }) => Promise<void> | void, afterRetireForTest?: (params: { parentFdPath: string; name: string; kind: "file" | "directory" }) => Promise<void> | void): Promise<boolean> {
  const entries = await fs.readdir(quarantine.fdPath, { withFileTypes: true });
  let replacementPending = false;
  for (const entry of entries) {
    if (!safeSegment(entry.name)) throw new Error("unsafe quarantine entry");
    if (isReplacementPendingName(entry.name)) {
      replacementPending = true;
      continue;
    }
    if (isOrdinaryPrivateDeleteName(entry.name)) {
      const identity = parsePrivateDeleteName(entry.name);
      const current = await fs.lstat(path.join(quarantine.fdPath, entry.name)).catch(() => null);
      if (!identity || !current || !privateSlotMatches(current, identity) || identity.kind !== "directory") {
        replacementPending = true;
        if (current) await retainDetectedReplacement(quarantine, entry.name);
        continue;
      }
      const retired: RetiredSecureEntry = { privateName: entry.name, stat: current, kind: "directory" };
      try {
        await removeRetiredDirectory(quarantine, retired, afterPinned, afterRetireForTest);
      } catch (error) {
        if (error instanceof Error && (error.message.includes("replacement") || error.message.includes("pending"))) replacementPending = true;
        else throw error;
      }
      continue;
    }
    const before = await fs.lstat(path.join(quarantine.fdPath, entry.name));
    if (before.isSymbolicLink() || !before.isDirectory()) throw new Error("unsafe quarantine entry");
    const retired = await retireSecureEntry({ parent: quarantine, name: entry.name, expected: before, kind: "directory" });
    if (retired) {
      try {
        await removeRetiredDirectory(quarantine, retired, afterPinned, afterRetireForTest);
      } catch (error) {
        // 第二次 retry 进入一个带 marker 的已隔离树时，须将其作为域级 pending
        // 向上返回，不能被外层当作普通 not_found/removed。
        if (error instanceof Error && error.message.includes("replacement pending")) return true;
        throw error;
      }
    }
  }
  return replacementPending;
}

/**
 * 将目标目录先隔离到根内 mode 0700 quarantine 的随机私有槽，再在固定 dirfd 中
 * 递归删除。原名称在 rename 后不再参与删除决策。
 */
export async function removeSecureDirectoryTree(input: {
  root: SecureDirectory;
  relativeSegments: string[];
  quarantineDirectory: string;
  afterPinnedForTest?: (params: { parentFdPath: string; name: string }) => Promise<void> | void;
  afterRetireForTest?: (params: { parentFdPath: string; name: string; kind: "file" | "directory" }) => Promise<void> | void;
}): Promise<SecureDirectoryRemovalResult> {
  if (input.relativeSegments.length === 0 || input.relativeSegments.some((segment) => !safeSegment(segment))) throw new Error("invalid secure removal path");
  if (!safeSegment(input.quarantineDirectory)) throw new Error("invalid secure quarantine directory");
  const opened: SecureDirectory[] = [];
  try {
    const quarantine = await openSecureChildDirectory(input.root, input.quarantineDirectory);
    opened.push(quarantine);
    await fs.chmod(quarantine.fdPath, 0o700);
    const staleReplacementPending = await removeQuarantineEntries(quarantine, input.afterPinnedForTest, input.afterRetireForTest);

    let parent = input.root;
    for (const segment of input.relativeSegments.slice(0, -1)) {
      try {
        parent = await openExistingSecureChildDirectory(parent, segment);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return staleReplacementPending ? "replacement_pending" : "not_found";
        throw error;
      }
      opened.push(parent);
    }
    const targetName = input.relativeSegments.at(-1)!;
    const before = await fs.lstat(path.join(parent.fdPath, targetName)).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (!before) return staleReplacementPending ? "replacement_pending" : "not_found";
    if (before.isSymbolicLink() || !before.isDirectory()) throw new Error("secure removal target must be a non-symlink directory");
    await assertSecureDirectoryCurrent(input.root, input.root.realPath);
    // 根对象直接移动到受控 0700 quarantine 的不可预测槽；业务名不再参与后续删除。
    const movedName = privateDeleteName({
      dev: before.dev,
      ino: before.ino,
      kind: "directory",
      scope: "tree",
    });
    await fs.rename(path.join(parent.fdPath, targetName), path.join(quarantine.fdPath, movedName));
    const moved = await fs.lstat(path.join(quarantine.fdPath, movedName));
    if (!expectedEntryMatches(moved, before, "directory")) {
      await retainDetectedReplacement(quarantine, movedName);
      throw new Error("secure quarantined directory replacement retained");
    }
    await removeRetiredDirectory(quarantine, { privateName: movedName, stat: moved, kind: "directory" }, input.afterPinnedForTest, input.afterRetireForTest);
    return staleReplacementPending ? "replacement_pending" : "removed";
  } finally {
    await closeSecureDirectories(...opened.reverse());
  }
}
