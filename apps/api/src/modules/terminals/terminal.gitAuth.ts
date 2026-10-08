import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import {
  assertSecureDirectoryCurrent,
  closeSecureDirectories,
  openSecureRootDirectory,
  removeRetiredSecureFile,
  retireSecureEntry,
  securePrivateSlotIdentity,
  type RetiredSecureEntry,
  type SecureRetiredFileTestHooks,
  type SecureDirectory,
} from "../../infra/fs/secure-directory.js";
import type { TerminalAuthArtifactKind, TerminalAuthCleanupIntent } from "./terminal-auth-cleanup-intent.store.js";

const LIVE_PREFIX = ".terminal-auth-live-v1-";
const LEGACY_AUTH_CLEANUP_ROOT = ".terminal-auth-cleanup";
const LIVE_KINDS: Exclude<TerminalAuthArtifactKind, "legacy">[] = ["ssh-key", "askpass", "askpass-token"];

export { type TerminalAuthArtifactKind } from "./terminal-auth-cleanup-intent.store.js";

export class TerminalGitAuthCleanupPendingError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TerminalGitAuthCleanupPendingError";
  }
}

export function assertTerminalGitAuthTerminalId(terminalId: string) {
  if (!/^term_[A-Za-z0-9_-]+$/.test(terminalId)) throw new Error("invalid terminal ID for Git auth artifact");
  return terminalId;
}

export function terminalAuthArtifactName(kind: Exclude<TerminalAuthArtifactKind, "legacy">, terminalId: string) {
  const id = assertTerminalGitAuthTerminalId(terminalId);
  const name = `${LIVE_PREFIX}${kind}-${id}`;
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(name)) throw new Error("terminal Git auth artifact name is unsafe");
  return name;
}

function artifactScope(terminalId: string, kind: Exclude<TerminalAuthArtifactKind, "legacy">, name: string) {
  return `auth${createHash("sha256").update(`${terminalId}\u0000${kind}\u0000${name}`).digest("hex").slice(0, 24)}`;
}

export function terminalSshKeyPath(dataDir: string, terminalId: string) {
  return path.join(dataDir, terminalAuthArtifactName("ssh-key", terminalId));
}
export function terminalAskpassPath(dataDir: string, terminalId: string) {
  return path.join(dataDir, terminalAuthArtifactName("askpass", terminalId));
}
export function terminalAskpassTokenPath(dataDir: string, terminalId: string) {
  return path.join(dataDir, terminalAuthArtifactName("askpass-token", terminalId));
}

export type TerminalGitAuthUnresolvedLocator = {
  artifactName: string;
  expectedDev?: number | null;
  expectedIno?: number | null;
  rootDev: number;
  rootIno: number;
  diagnostic: string;
};

type ArtifactHooks = {
  afterArtifactCreatedForTest?: () => Promise<void> | void;
  afterRetireForTest?: (params: { parent: SecureDirectory; retired: RetiredSecureEntry }) => Promise<void> | void;
  removeRetiredForTest?: (params: { parent: SecureDirectory; retired: RetiredSecureEntry }) => Promise<boolean> | boolean;
  retiredFileHooks?: SecureRetiredFileTestHooks;
};

async function removeRetired(root: SecureDirectory, retired: RetiredSecureEntry, hooks?: ArtifactHooks) {
  return hooks?.removeRetiredForTest?.({ parent: root, retired }) ?? removeRetiredSecureFile(root, retired, hooks?.retiredFileHooks);
}

async function retireAndRemove(root: SecureDirectory, name: string, expected: import("node:fs").Stats, kind: Exclude<TerminalAuthArtifactKind, "legacy">, terminalId: string, hooks?: ArtifactHooks) {
  const retired = await retireSecureEntry({ parent: root, name, expected, kind: "file", privateSlotScope: artifactScope(terminalId, kind, name) });
  if (!retired) return false;
  await hooks?.afterRetireForTest?.({ parent: root, retired });
  return removeRetired(root, retired, hooks);
}

/**
 * 直接在已固定的 dataDir root dirfd 建立 live artifact。成功回调必须持久化本
 * artifact 的 recoverable identity；任何回调/拓扑失败均以 root 私有槽保留 locator。
 */
export async function writeTerminalGitAuthArtifact(input: {
  dataDir: string;
  terminalId: string;
  kind: Exclude<TerminalAuthArtifactKind, "legacy">;
  content: string;
  mode: number;
  rootDev: number;
  rootIno: number;
  markRecoverableCleanup?: (intent: TerminalGitAuthUnresolvedLocator) => Promise<void> | void;
  persistUnresolvedCleanup?: (intent: TerminalGitAuthUnresolvedLocator) => Promise<void> | void;
} & ArtifactHooks): Promise<void> {
  const name = terminalAuthArtifactName(input.kind, input.terminalId);
  const root = await openSecureRootDirectory(input.dataDir);
  let handle: fs.FileHandle | null = null;
  let created: import("node:fs").Stats | null = null;
  try {
    await assertSecureDirectoryCurrent(root, root.realPath);
    if (root.stat.dev !== input.rootDev || root.stat.ino !== input.rootIno) {
      throw new TerminalGitAuthCleanupPendingError("terminal Git auth root anchor changed before artifact creation");
    }
    const target = path.join(root.fdPath, name);
    try {
      handle = await fs.open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, input.mode);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new TerminalGitAuthCleanupPendingError("terminal Git auth live artifact already exists without writer cleanup authority", { cause: error });
      }
      throw error;
    }
    created = await handle.stat();
    if (!created.isFile()) throw new Error("terminal Git auth artifact is not a regular file");
    await handle.writeFile(input.content, "utf8");
    await handle.close();
    handle = null;
    await input.afterArtifactCreatedForTest?.();
    const current = await fs.lstat(target);
    if (current.isSymbolicLink() || !current.isFile() || current.dev !== created.dev || current.ino !== created.ino) {
      throw new Error("terminal Git auth artifact changed during creation");
    }
    await assertSecureDirectoryCurrent(root, root.realPath);
    if (!input.markRecoverableCleanup) throw new Error("terminal Git auth artifact has no durable locator callback");
    await input.markRecoverableCleanup({ artifactName: name, expectedDev: created.dev, expectedIno: created.ino, rootDev: root.stat.dev, rootIno: root.stat.ino, diagnostic: "auth live artifact anchored in dataDir root" });
    return;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (!created) throw error;
    try {
      const removed = await retireAndRemove(root, name, created, input.kind, input.terminalId, input);
      if (!removed) throw new TerminalGitAuthCleanupPendingError("terminal Git auth artifact cleanup is pending", { cause: error });
    } catch (cleanupError) {
      if (input.persistUnresolvedCleanup) {
        await input.persistUnresolvedCleanup({ artifactName: name, expectedDev: created.dev, expectedIno: created.ino, rootDev: root.stat.dev, rootIno: root.stat.ino, diagnostic: `auth cleanup locator unresolved: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}` });
      }
      throw cleanupError instanceof TerminalGitAuthCleanupPendingError ? cleanupError : new TerminalGitAuthCleanupPendingError("terminal Git auth artifact cleanup is pending", { cause: cleanupError });
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
    await closeSecureDirectories(root);
  }
}

async function cleanupRetiredSlots(root: SecureDirectory, intent: TerminalAuthCleanupIntent, hooks?: ArtifactHooks) {
  if (intent.artifactKind === "legacy") return false;
  const scope = artifactScope(intent.terminalId, intent.artifactKind, intent.artifactName);
  let pending = false;
  for (const entry of await fs.readdir(root.fdPath, { withFileTypes: true })) {
    // replacement marker 不再是标准 v1 名，但其后缀仍携带原 private slot 的
    // identity。只要属于当前 artifact scope，绝不能忽略或自动删除。
    const markerPrefix = ".delete-replacement-pending-";
    if (entry.name.startsWith(markerPrefix)) {
      const markedIdentity = securePrivateSlotIdentity(entry.name.slice(markerPrefix.length));
      if (markedIdentity?.scope === scope) pending = true;
      continue;
    }
    const identity = securePrivateSlotIdentity(entry.name);
    if (!identity || identity.scope !== scope) continue;
    if (identity.kind !== "file") { pending = true; continue; }
    const stat = await fs.lstat(path.join(root.fdPath, entry.name)).catch(() => null);
    if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.dev !== identity.dev || stat.ino !== identity.ino) {
      pending = true;
      continue;
    }
    if (!(await removeRetired(root, { privateName: entry.name, stat, kind: "file" }, hooks))) pending = true;
  }
  return !pending;
}

function intentMatchesLiveFile(intent: TerminalAuthCleanupIntent, stat: import("node:fs").Stats) {
  return stat.isFile() && !stat.isSymbolicLink() && intent.expectedDev !== null && intent.expectedIno !== null
    && stat.dev === intent.expectedDev && stat.ino === intent.expectedIno;
}

async function assertIntentRootAnchors(root: SecureDirectory, intents: TerminalAuthCleanupIntent[]) {
  if (intents.some((intent) => intent.phase !== "recoverable" || intent.artifactKind === "legacy"
    || intent.rootDev === null || intent.rootIno === null
    || intent.rootDev !== root.stat.dev || intent.rootIno !== root.stat.ino)) {
    throw new TerminalGitAuthCleanupPendingError("terminal Git auth cleanup locator is not recoverable");
  }
}

/** 在外部 cleanup callback 前验证 authority rows 仍绑定当前 dataDir root。 */
export async function assertTerminalGitAuthCleanupRootAnchors(dataDir: string, intents: TerminalAuthCleanupIntent[]) {
  const root = await openSecureRootDirectory(dataDir);
  try {
    await assertSecureDirectoryCurrent(root, root.realPath);
    await assertIntentRootAnchors(root, intents);
  } finally {
    await closeSecureDirectories(root);
  }
}

/** 逐 intent 以 dataDir-root business name 与其 identity 私有槽收敛。 */
export async function cleanupTerminalGitAuthArtifacts(
  dataDir: string,
  terminalId: string,
  intentsOrHooks?: TerminalAuthCleanupIntent[] | ArtifactHooks,
  maybeHooks?: ArtifactHooks,
) {
  const intents = Array.isArray(intentsOrHooks) ? intentsOrHooks : undefined;
  const hooks = (Array.isArray(intentsOrHooks) ? maybeHooks : intentsOrHooks) as ArtifactHooks | undefined;
  const root = await openSecureRootDirectory(dataDir);
  try {
    await assertSecureDirectoryCurrent(root, root.realPath);
    // live 文件只能由 durable intent 的 identity 授权删除；没有 intent 时绝不按
    // pathname 或可推导 scope 猜测回收。
    const expected = intents ?? [];
    await assertIntentRootAnchors(root, expected);
    let pending = false;
    const byName = new Map(expected.map((intent) => [intent.artifactName, intent]));
    for (const kind of LIVE_KINDS) {
      const name = terminalAuthArtifactName(kind, terminalId);
      const stat = await fs.lstat(path.join(root.fdPath, name)).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
      if (!stat) continue;
      const intent = byName.get(name);
      if (!intent || !intentMatchesLiveFile(intent, stat)) { pending = true; continue; }
      if (!(await retireAndRemove(root, name, stat, kind, terminalId, hooks))) pending = true;
    }
    for (const intent of expected) if (!(await cleanupRetiredSlots(root, intent, hooks))) pending = true;
    // tmp 不属于 root-level live protocol；其移动、替换或普通内容绝不能影响本轮
    // artifact 的创建与清理。仅精确识别旧中间协议的已知名称；不遍历 symlink，
    // 也不因普通 tmp 内容或 topology 改变而阻断新协议。
    const legacyTmp = path.join(root.fdPath, "tmp");
    const tmpStat = await fs.lstat(legacyTmp).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (tmpStat?.isDirectory() && !tmpStat.isSymbolicLink()) {
      const legacyNames = new Set([
        `term-ssh-key-${terminalId}`,
        `term-git-askpass-${terminalId}.sh`,
        `term-git-askpass-token-${terminalId}`,
      ]);
      const names = await fs.readdir(legacyTmp);
      if (names.some((name) => legacyNames.has(name))) pending = true;
    }
    const legacyRoot = await fs.lstat(path.join(root.fdPath, LEGACY_AUTH_CLEANUP_ROOT)).catch(() => null);
    if (legacyRoot) pending = true;
    await assertSecureDirectoryCurrent(root, root.realPath);
    if (pending) throw new TerminalGitAuthCleanupPendingError("terminal Git auth artifact cleanup is pending");
  } finally {
    await closeSecureDirectories(root);
  }
}
