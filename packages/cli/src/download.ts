import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { AgentApi } from "./agent-api.js";
import type { ReadCommandDependencies } from "./discovery.js";
import { CliError, withErrorDetails, type ErrorContext } from "./errors.js";
import { FollowLifetime } from "./follow-lifetime.js";
import { writeSuccess } from "./output.js";
import { escapeDisplayText } from "./session-list-output.js";
import { encodeId } from "./validation.js";

export interface DownloadOptions { workspaceId: string; path: string; output: string; }
export interface DownloadHandle {
  write(buffer: Uint8Array, offset: number, length: number): Promise<{ bytesWritten: number }>;
  sync(): Promise<void>;
  close(): Promise<void>;
}
/** Narrow filesystem seam: production uses exclusive open and atomic hard-link, never rename. */
export interface DownloadFileSystem {
  stat(path: string): Promise<{ isDirectory(): boolean }>;
  lstat(path: string): Promise<unknown>;
  open(path: string, flags: "wx", mode: number): Promise<DownloadHandle>;
  link(source: string, target: string): Promise<void>;
  unlink(path: string): Promise<void>;
}
export interface DownloadDependencies extends ReadCommandDependencies { files?: DownloadFileSystem; }
const files: DownloadFileSystem = fs;
function errno(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
function localError(message: string, code = "LOCAL_IO_FAILED"): CliError { return new CliError(7, message, { code }); }
export function validateDownloadPath(path: string): string {
  if (typeof path !== "string" || !path.trim() || /^[/:\-]/.test(path) || /^[a-z]:/i.test(path)
    || /[\\\u0000-\u001f\u007f-\u009f]/.test(path) || path.split("/").includes("..")) {
    throw new CliError(2, "远端路径必须为使用 / 分隔的安全相对路径；整个工作区请显式使用 .。", { phase: "input", effect: "not_sent" });
  }
  return path;
}
export function validateDownloadOptions(options: DownloadOptions): DownloadOptions {
  validateDownloadPath(options.path);
  if (typeof options.output !== "string" || !options.output.trim() || /[\u0000-\u001f\u007f-\u009f]/.test(options.output)) {
    throw new CliError(2, "必须显式提供有效的本地输出文件。", { phase: "input", effect: "not_sent" });
  }
  return options;
}
function responseFormat(headers: Headers): "file" | "zip" {
  const type = headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (type === "application/octet-stream") return "file";
  if (type === "application/zip") return "zip";
  throw new CliError(6, "下载响应类型无效，未发布本地文件。");
}
function expectedLength(headers: Headers): number | undefined {
  const value = headers.get("content-length");
  if (value === null) return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new CliError(6, "下载响应长度无效。");
  // Fetch transparently decodes encoded bodies, so their length is not comparable.
  if (headers.has("content-encoding") && headers.get("content-encoding") !== "identity") throw new CliError(6, "下载响应编码不受支持，无法验证完整长度。");
  return Number(value);
}

export async function downloadFile(options: DownloadOptions, dependencies: DownloadDependencies): Promise<void> {
  validateDownloadOptions(options);
  const disk = dependencies.files ?? files;
  const target = resolve(options.output);
  const lifetime = new FollowLifetime(dependencies.io.stdout, dependencies.signal, "download");
  const context: ErrorContext = { workspaceId: options.workspaceId, published: false };
  let temporary: string | undefined;
  let handle: DownloadHandle | undefined;
  let phase: "download" | "publish" = "download";
  try {
    lifetime.check();
    try {
      if (!(await disk.stat(dirname(target))).isDirectory()) throw localError("本地输出父路径不是目录。");
      try { await disk.lstat(target); throw localError("本地输出目标已存在，拒绝覆盖。", "OUTPUT_EXISTS"); }
      catch (error) { if (errno(error) !== "ENOENT") throw error; }
    } catch (error) { throw error instanceof CliError ? error : localError("无法访问本地输出目录或目标。"); }
    const api = await AgentApi.connect({ ...dependencies, signal: lifetime.signal });
    lifetime.check();
    const path = `/api/workspaces/${encodeId(options.workspaceId)}/files/download?${new URLSearchParams({ path: options.path })}`;
    const received = await api.stream(path, { phase: "download", context, consume: async (response) => {
      const format = responseFormat(response.headers);
      const expected = expectedLength(response.headers);
      if (!response.body) throw new CliError(5, "下载响应没有完整的数据流。");
      lifetime.check();
      const candidate = join(dirname(target), `.awb-download-${randomUUID()}.tmp`);
      try { handle = await disk.open(candidate, "wx", 0o600); temporary = candidate; }
      catch { throw localError("无法创建本次下载的独占临时文件。"); }
      const reader = response.body.getReader();
      let bytes = 0;
      try {
        for (;;) {
          lifetime.check();
          const next = await reader.read();
          lifetime.check();
          if (next.done) break;
          if (!Number.isSafeInteger(bytes + next.value.byteLength)) throw new CliError(6, "下载字节数超过安全计数范围。");
          bytes += next.value.byteLength;
          if (expected !== undefined && bytes > expected) throw new CliError(5, "下载响应长度与声明不符，未发布文件。");
          try {
            for (let offset = 0; offset < next.value.byteLength;) {
              lifetime.check();
              const { bytesWritten } = await handle.write(next.value, offset, next.value.byteLength - offset);
              if (!Number.isInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > next.value.byteLength - offset) throw localError("本地临时文件未能完整写入。");
              offset += bytesWritten;
            }
          } catch (error) { throw error instanceof CliError ? error : localError("写入本地临时文件失败。"); }
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      if (expected !== undefined && bytes !== expected) throw new CliError(5, "下载响应被截断，未发布文件。");
      lifetime.check();
      try { await handle.sync(); await handle.close(); handle = undefined; }
      catch { throw localError("无法刷新或关闭本地临时文件，未发布目标。"); }
      lifetime.check();
      return { bytes, format };
    } });
    lifetime.check();
    phase = "publish";
    try { await disk.link(temporary!, target); context.published = true; }
    catch (error) {
      const code = errno(error);
      if (code === "EEXIST") throw localError("本地目标已被创建，拒绝覆盖。", "OUTPUT_EXISTS");
      if (["ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "EPERM"].includes(code ?? "")) throw localError("当前文件系统不支持可靠的原子无覆盖发布，未降级写入。", "PUBLISH_UNSUPPORTED");
      throw localError("发布本地文件失败，未覆盖目标。");
    }
    lifetime.check();
    try { await disk.unlink(temporary!); temporary = undefined; }
    catch { throw localError("完整文件已发布，但本次临时文件清理失败。"); }
    lifetime.check();
    const summary = { workspaceId: options.workspaceId, path: options.path, output: options.output, ...received, published: true };
    await lifetime.wait(writeSuccess(dependencies.io, dependencies.json ?? false, "file download", summary,
      `下载完成：${escapeDisplayText(options.output)}（${received.format}，${received.bytes} bytes，published=true）\n`, { phase, effect: "not_applicable", context }));
  } catch (error) {
    throw withErrorDetails(lifetime.failure(error), { phase, effect: "not_applicable", context });
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (temporary) await disk.unlink(temporary).catch(() => {});
    lifetime.dispose();
  }
}
