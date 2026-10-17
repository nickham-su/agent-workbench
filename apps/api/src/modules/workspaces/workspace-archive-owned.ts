import { constants, type BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { archiveError, checkArchiveAbort } from "./workspace-archive-policy.js";

export function sameArchiveIdentity(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

const mode = (stat: BigIntStats) => stat.mode & 0o7777n;
const inode = (stat: BigIntStats) => `${stat.dev}:${stat.ino}`;
export function sameArchiveFileVersion(a: BigIntStats, b: BigIntStats): boolean {
  return a.isFile() && b.isFile() && sameArchiveIdentity(a, b) && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink && mode(a) === mode(b);
}

/** Private writes may change bytes/times, never identity, restrictive mode or link ownership. */
export function settledArchivePrivateWriter(previous: BigIntStats | undefined, current: BigIntStats): BigIntStats {
  if (!previous?.isFile() || !current.isFile() || !sameArchiveIdentity(previous, current)
    || mode(current) !== 0o600n || previous.nlink !== 1n || current.nlink !== previous.nlink) {
    // Keep the last trusted record on failure. Cleanup must not bless an unknown alias.
    throw archiveError("ARCHIVE_TARGET_CHANGED", 409);
  }
  return current;
}

/** Fresh observations, not a sandbox against a malicious process with the same uid. */
export class ArchiveParentGuard {
  private constructor(readonly root: string, readonly parent: string, private readonly chain: Map<string, BigIntStats>) {}

  static async open(workspaceRoot: string, parentRel: string, signal?: AbortSignal): Promise<ArchiveParentGuard> {
    const chain = new Map<string, BigIntStats>();
    // Include the lexical Workspace root itself, including when the source is in a repo.
    let abs = path.resolve(workspaceRoot);
    for (const part of ["", ...parentRel.split("/").filter(Boolean)]) {
      checkArchiveAbort(signal);
      if (part) abs = path.join(abs, part);
      const stat = await fs.lstat(abs, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw archiveError("ARCHIVE_PATH_INVALID");
      chain.set(abs, stat);
    }
    // Canonicalize only after checking every component from the trusted Workspace root.
    // The whole chain remains pinned and is rechecked by assert(), including during cleanup.
    const realRoot = await fs.realpath(path.resolve(workspaceRoot));
    const realParent = await fs.realpath(abs);
    if (realParent !== realRoot && !realParent.startsWith(realRoot + path.sep)) throw archiveError("ARCHIVE_PATH_INVALID");
    const guard = new ArchiveParentGuard(realRoot, realParent, chain);
    await guard.assert(signal);
    return guard;
  }

  async assert(signal?: AbortSignal): Promise<void> {
    for (const [abs, expected] of this.chain) {
      checkArchiveAbort(signal);
      const actual = await fs.lstat(abs, { bigint: true });
      if (!actual.isDirectory() || !sameArchiveIdentity(actual, expected)) throw archiveError("ARCHIVE_TARGET_CHANGED", 409);
    }
    const last = [...this.chain.keys()].at(-1)!;
    if (await fs.realpath(last) !== this.parent) throw archiveError("ARCHIVE_TARGET_CHANGED", 409);
  }
}

type OwnedNode = { abs: string; kind: "file" | "dir"; group: "temporary" | "output"; stat?: BigIntStats };
export type ArchiveCleanupStep = { action: "unlink" | "rmdir"; path: string };

/** Only this request's objects are eligible for cleanup. Unknown children are never recursively removed. */
export class ArchiveOwnedNodes {
  readonly nodes = new Map<string, OwnedNode>();
  private readonly aliases = new Map<string, Set<string>>();
  private readonly tainted = new Set<string>();
  private readonly children = new Map<string, Set<string>>();
  constructor(readonly guard: ArchiveParentGuard, private readonly signal?: AbortSignal) {}

  remember(abs: string, kind: "file" | "dir", group: OwnedNode["group"], stat?: BigIntStats): void {
    if (this.nodes.has(abs)) throw archiveError("ARCHIVE_TARGET_CHANGED", 409);
    this.nodes.set(abs, { abs, kind, group, stat });
    const parent = path.dirname(abs);
    let names = this.children.get(parent);
    if (!names) this.children.set(parent, names = new Set());
    names.add(path.basename(abs));
    if (stat && kind === "file") {
      let aliases = this.aliases.get(inode(stat));
      if (!aliases) this.aliases.set(inode(stat), aliases = new Set());
      aliases.add(abs);
    }
  }

  async assertParents(abs: string, signal?: AbortSignal): Promise<void> {
    await this.guard.assert(signal);
    const parents: string[] = [];
    let parent = path.dirname(abs);
    while (parent !== this.guard.parent) {
      if (!parent.startsWith(this.guard.parent + path.sep)) throw archiveError("ARCHIVE_TARGET_CHANGED", 409);
      parents.unshift(parent);
      parent = path.dirname(parent);
    }
    for (const item of parents) {
      checkArchiveAbort(signal);
      await this.assertNode(item);
    }
  }

  async assertNode(abs: string): Promise<BigIntStats> {
    const node = this.nodes.get(abs);
    if (!node?.stat) throw archiveError("ARCHIVE_TARGET_CHANGED", 409);
    const current = await fs.lstat(abs, { bigint: true });
    const good = node.kind === "dir"
      ? current.isDirectory() && sameArchiveIdentity(current, node.stat) && mode(current) === mode(node.stat)
      : !this.tainted.has(inode(node.stat)) && sameArchiveFileVersion(current, node.stat);
    if (!good) {
      if (node.kind === "file") this.tainted.add(inode(node.stat));
      throw archiveError("ARCHIVE_TARGET_CHANGED", 409);
    }
    return current;
  }

  private async assertAliases(stat: BigIntStats, signal?: AbortSignal): Promise<void> {
    for (const abs of this.aliases.get(inode(stat)) ?? []) {
      checkArchiveAbort(signal);
      await this.assertParents(abs, signal);
      await this.assertNode(abs);
    }
  }

  /** Refresh only changes caused by the stated operation, not arbitrary new filesystem state. */
  private async updateAliases(previous: BigIntStats, delta: bigint, newMode = mode(previous)): Promise<void> {
    try {
      const observations: [OwnedNode, BigIntStats][] = [];
      for (const abs of this.aliases.get(inode(previous)) ?? []) {
        await this.assertParents(abs);
        const node = this.nodes.get(abs)!;
        const actual = await fs.lstat(abs, { bigint: true });
        if (!actual.isFile() || !sameArchiveIdentity(actual, previous) || actual.size !== previous.size
          || actual.mtimeNs !== previous.mtimeNs || mode(actual) !== newMode || actual.nlink !== previous.nlink + delta) {
          throw archiveError("ARCHIVE_TARGET_CHANGED", 409);
        }
        observations.push([node, actual]);
      }
      for (const [node, actual] of observations) node.stat = actual;
    } catch (error) {
      this.tainted.add(inode(previous));
      throw error;
    }
  }

  async mkdir(abs: string, group: OwnedNode["group"]): Promise<void> {
    await this.assertParents(abs, this.signal);
    checkArchiveAbort(this.signal);
    await fs.mkdir(abs, { recursive: false, mode: 0o700 });
    this.remember(abs, "dir", group); // A successful creation stays recorded even if lstat fails.
    const node = this.nodes.get(abs)!;
    node.stat = await fs.lstat(abs, { bigint: true });
    if (!node.stat.isDirectory()) throw archiveError("ARCHIVE_TARGET_CHANGED", 409);
    if (mode(node.stat) !== 0o700n) await this.chmod(abs, 0o700);
  }

  async createFile(abs: string): Promise<fs.FileHandle> {
    await this.assertParents(abs, this.signal);
    checkArchiveAbort(this.signal);
    const handle = await fs.open(abs, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    this.remember(abs, "file", "temporary");
    try {
      const stat = await handle.stat({ bigint: true });
      const node = this.nodes.get(abs)!;
      node.stat = stat;
      this.aliases.set(inode(stat), new Set([abs]));
      await handle.chmod(0o600);
      // This is a just-created, empty, private file; registration precedes any writes.
      node.stat = settledArchivePrivateWriter(node.stat, await handle.stat({ bigint: true }));
      return handle;
    } catch (error) {
      try { await handle.close(); }
      catch { /* Initialization already failed; a later close error must not replace it. */ }
      throw error;
    }
  }

  /** After a private writer has settled, record the version returned by its still-open handle. */
  settleWriter(abs: string, stat: BigIntStats): void {
    const node = this.nodes.get(abs);
    const trusted = settledArchivePrivateWriter(node?.stat, stat);
    node!.stat = trusted;
  }

  async chmod(abs: string, permissions: number): Promise<void> {
    await this.assertParents(abs, this.signal);
    const previous = await this.assertNode(abs);
    const node = this.nodes.get(abs)!;
    if (node.kind === "file") await this.assertAliases(previous, this.signal);
    checkArchiveAbort(this.signal);
    await fs.chmod(abs, permissions);
    if (node.kind === "file") await this.updateAliases(previous, 0n, BigInt(permissions));
    else {
      const actual = await fs.lstat(abs, { bigint: true });
      if (!actual.isDirectory() || !sameArchiveIdentity(previous, actual) || mode(actual) !== BigInt(permissions)) throw archiveError("ARCHIVE_TARGET_CHANGED", 409);
      node.stat = actual;
    }
  }

  async link(source: string, target: string): Promise<void> {
    await this.assertParents(source, this.signal);
    await this.assertParents(target, this.signal);
    const previous = await this.assertNode(source);
    await this.assertAliases(previous, this.signal);
    checkArchiveAbort(this.signal);
    await fs.link(source, target);
    this.remember(target, "file", "output", previous);
    await this.updateAliases(previous, 1n);
  }

  async verify(group?: OwnedNode["group"], signal?: AbortSignal): Promise<void> {
    for (const node of this.nodes.values()) {
      checkArchiveAbort(signal);
      if (group && node.group !== group) continue;
      await this.assertParents(node.abs, signal);
      await this.assertNode(node.abs);
      if (node.kind === "dir") {
        const expected = this.children.get(node.abs) ?? new Set();
        const actual = await fs.readdir(node.abs);
        if (actual.length !== expected.size || actual.some((name) => !expected.has(name))) throw archiveError("ARCHIVE_TARGET_CHANGED", 409);
      }
    }
  }

  /** Continue independent cleanup after individual failures, but never retry or guess ownership. */
  async cleanup(committed: boolean, before?: (step: ArchiveCleanupStep) => Promise<void> | void): Promise<number> {
    const selected = [...this.nodes.values()].filter((node) => !committed || node.group === "temporary")
      .sort((a, b) => {
        // Roll publication back first; surviving staging aliases must then have
        // their own nlink/ctime baselines refreshed before temporary cleanup.
        if (a.group !== b.group) return a.group === "output" ? -1 : 1;
        return b.abs.split(path.sep).length - a.abs.split(path.sep).length || b.abs.localeCompare(a.abs);
      });
    let failures = 0;
    for (const node of selected) {
      try {
        await before?.({ action: node.kind === "file" ? "unlink" : "rmdir", path: node.abs });
        await this.assertParents(node.abs);
        const previous = await this.assertNode(node.abs);
        if (node.kind === "dir") await fs.rmdir(node.abs);
        else {
          await this.assertAliases(previous);
          await fs.unlink(node.abs);
        }
        this.nodes.delete(node.abs);
        this.children.get(path.dirname(node.abs))?.delete(path.basename(node.abs));
        if (node.kind === "file") {
          this.aliases.get(inode(previous))?.delete(node.abs);
          await this.updateAliases(previous, -1n);
        }
      } catch { failures++; }
    }
    return failures;
  }
}
