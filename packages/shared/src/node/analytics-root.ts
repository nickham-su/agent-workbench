import { constants as fsConstants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const DIRECTORY = fsConstants.O_DIRECTORY ?? 0;
const DIRECTORY_OPEN = fsConstants.O_RDONLY | DIRECTORY | NOFOLLOW;
type Inode = { dev: number; ino: number };

function fdPath(fd: number) {
  if (process.platform === "linux") return `/proc/self/fd/${fd}`;
  if (process.platform === "darwin") return `/dev/fd/${fd}`;
  throw new Error("secure analytics root requires directory fd path support");
}
function sameInode(left: Inode, right: Inode) { return left.dev === right.dev && left.ino === right.ino; }
function name(value: string) {
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(value) || value === "." || value === "..")
    throw new Error("unsafe analytics path component");
  return value;
}
async function verifiedDirectory(directory: string) {
  const entry = await fs.lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("unsafe analytics directory");
  const handle = await fs.open(directory, DIRECTORY_OPEN);
  const opened = await handle.stat();
  const current = await fs.lstat(directory);
  if (!opened.isDirectory() || current.isSymbolicLink() || !sameInode(opened, current)) {
    await handle.close();
    throw new Error("analytics directory changed while opening");
  }
  return handle;
}

export class SecureAnalyticsDirectory {
  constructor(
    private readonly handle: FileHandle,
    private readonly temporaryParentFd: number | null = null,
    private readonly temporaryName: string | null = null,
  ) {}
  get fd() { return this.handle.fd; }
  get fdPath() { return fdPath(this.handle.fd); }
  path(file: string) { return path.join(this.fdPath, name(file)); }
  async close() { await this.handle.close(); }
  async openDirectory(parts: string[], create = true): Promise<SecureAnalyticsDirectory> {
    let parent = this.handle;
    let ownsParent = false;
    try {
      for (const part of parts) {
        const child = path.join(fdPath(parent.fd), name(part));
        if (create) {
          try { await fs.mkdir(child, { mode: 0o700 }); }
          catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        }
        const entry = await fs.lstat(child);
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("unsafe analytics directory");
        const opened = await fs.open(child, DIRECTORY_OPEN);
        const current = await fs.lstat(child);
        const stat = await opened.stat();
        if (current.isSymbolicLink() || !stat.isDirectory() || !sameInode(stat, current)) {
          await opened.close();
          throw new Error("analytics directory changed while opening");
        }
        await opened.chmod(0o700);
        if (ownsParent) await parent.close();
        parent = opened;
        ownsParent = true;
      }
      if (!ownsParent) throw new Error("secure child directory requires a component");
      return new SecureAnalyticsDirectory(parent);
    } catch (error) {
      if (ownsParent) await parent.close().catch(() => undefined);
      throw error;
    }
  }
  async list() {
    return (await fs.readdir(this.fdPath, { withFileTypes: true }))
      .filter((entry) => !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort();
  }
  async readFileBuffer(file: string, options?: { requirePrivate?: boolean }) {
    const target = this.path(file);
    const before = await fs.lstat(target);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error("unsafe analytics file");
    const input = await fs.open(target, fsConstants.O_RDONLY | NOFOLLOW);
    try {
      const opened = await input.stat();
      const current = await fs.lstat(target);
      if (!opened.isFile() || current.isSymbolicLink() || !sameInode(opened, current))
        throw new Error("analytics file changed while opening");
      if (options?.requirePrivate && (opened.mode & 0o077) !== 0)
        throw new Error("analytics file is not private");
      return await input.readFile();
    } finally { await input.close(); }
  }
  async readFile(file: string) {
    return (await this.readFileBuffer(file)).toString("utf8");
  }
  /** Opens and pins a regular child without following its final component. */
  async openRegularFile(file: string, create = false): Promise<FileHandle> {
    const target = this.path(file);
    let output: FileHandle;
    if (create) {
      try {
        output = await fs.open(target, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | NOFOLLOW, 0o600);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        output = await fs.open(target, fsConstants.O_RDWR | NOFOLLOW);
      }
    } else output = await fs.open(target, fsConstants.O_RDWR | NOFOLLOW);
    try {
      const opened = await output.stat();
      const current = await fs.lstat(target);
      if (!opened.isFile() || current.isSymbolicLink() || !current.isFile() || !sameInode(opened, current))
        throw new Error("analytics file changed while opening");
      await output.chmod(0o600);
      return output;
    } catch (error) {
      await output.close().catch(() => undefined);
      throw error;
    }
  }
  async deleteFile(file: string) {
    const target = this.path(file);
    const entry = await fs.lstat(target).catch(() => null);
    if (!entry) return;
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("unsafe analytics file");
    await fs.unlink(target);
    await this.handle.sync();
  }
  async renameFile(from: string, to: string) {
    const source = this.path(from);
    const entry = await fs.lstat(source);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("unsafe analytics file");
    await fs.rename(source, this.path(to));
    await this.handle.sync();
  }
  async writeExclusiveFile(file: string, value: string | Buffer) {
    const output = await fs.open(
      this.path(file),
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | NOFOLLOW,
      0o600,
    );
    try {
      await output.chmod(0o600);
      await output.writeFile(value);
      await output.sync();
    } finally { await output.close(); }
  }
  async linkFile(from: string, to: string) {
    const source = this.path(from);
    const entry = await fs.lstat(source);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("unsafe analytics file");
    await fs.link(source, this.path(to));
    await this.handle.sync();
  }
  async temporaryDirectory(prefix = "tmp") {
    const child = `${name(prefix)}-${randomUUID()}`;
    await fs.mkdir(this.path(child), { mode: 0o700 });
    const directory = await this.openDirectory([child], false);
    return new SecureAnalyticsDirectory(directory.handle, this.handle.fd, child);
  }
  async removeTemporaryDirectory() {
    if (this.temporaryParentFd === null || this.temporaryName === null)
      throw new Error("not a temporary analytics directory");
    await this.handle.close();
    await fs.rmdir(path.join(fdPath(this.temporaryParentFd), this.temporaryName));
  }
  async publishJson(file: string, value: unknown) {
    const target = this.path(file);
    const temporary = this.path(`.${name(file)}.${randomUUID()}.tmp`);
    let output: FileHandle | null = null;
    try {
      output = await fs.open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | NOFOLLOW, 0o600);
      await output.chmod(0o600);
      await output.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await output.sync();
      await output.close();
      output = null;
      await fs.rename(temporary, target);
      await this.handle.sync();
    } finally {
      await output?.close().catch(() => undefined);
      await fs.unlink(temporary).catch(() => undefined);
    }
  }
}

/** Opens the Analytics root as an FD capability. Keep it open for every I/O. */
export async function openSecureAnalyticsRoot(dataDir: string): Promise<SecureAnalyticsDirectory> {
  const logicalDataDir = path.resolve(dataDir);
  const data = await verifiedDirectory(logicalDataDir);
  try {
    const child = path.join(fdPath(data.fd), "analytics");
    try { await fs.mkdir(child, { mode: 0o700 }); }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const root = await verifiedDirectory(child);
    try {
      await root.chmod(0o700);
      // Recheck through the still-open parent FD after chmod; this catches a
      // pathname replacement without ever following the replacement.
      const current = await fs.lstat(child);
      if (current.isSymbolicLink() || !sameInode(current, await root.stat()))
        throw new Error("analytics root changed while opening");
      return new SecureAnalyticsDirectory(root);
    } catch (error) { await root.close(); throw error; }
  } finally { await data.close(); }
}

/** Compatibility helper for read-only callers that do not retain a capability. */
export async function ensureSecureAnalyticsRoot(dataDir: string): Promise<string> {
  const root = await openSecureAnalyticsRoot(dataDir);
  try { return await fs.realpath(root.fdPath); }
  finally { await root.close(); }
}
