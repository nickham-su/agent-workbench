import type { FastifyBaseLogger } from "fastify";
import path from "node:path";
import { compactionSnippetPath, tmpRoot } from "../../../infra/fs/paths.js";
import { ensureDirSafeUnderRoot, ensureRealPathUnderRoot, readFileNoFollow, writeFileNoFollow } from "../artifact/safe-file-io.js";

const MAX_BYTES = 256 * 1024;

/** Read-side-owned best-effort cache capability; it never owns archive content. */
export class CompactionSnippetCache {
  constructor(private readonly options: { dataDir: string; logger: FastifyBaseLogger }) {}

  async readBestEffort(params: { workspaceId: string; sessionId: string; summaryItemId: number }) {
    const filePath = compactionSnippetPath(this.options.dataDir, params.workspaceId, params.sessionId, params.summaryItemId);
    const root = path.resolve(tmpRoot(this.options.dataDir));
    const fileAbs = path.resolve(filePath);
    if (!fileAbs.startsWith(root + path.sep) && fileAbs !== root) return "";
    const stat = await import("node:fs/promises").then(({ default: fs }) => fs.lstat(fileAbs)).catch(() => null);
    if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) return "";
    await ensureRealPathUnderRoot(root, fileAbs);
    return readFileNoFollow(fileAbs).catch(() => "");
  }

  async writeBestEffort(params: { workspaceId: string; sessionId: string; summaryItemId: number; text: string }) {
    const filePath = compactionSnippetPath(this.options.dataDir, params.workspaceId, params.sessionId, params.summaryItemId);
    const root = path.resolve(tmpRoot(this.options.dataDir));
    const fileAbs = path.resolve(filePath);
    if (!fileAbs.startsWith(root + path.sep) && fileAbs !== root) {
      this.options.logger.warn({ filePath }, "compaction snippet cache path is outside tmpRoot");
      return;
    }
    try {
      const dir = path.dirname(fileAbs);
      await ensureDirSafeUnderRoot(root, dir);
      await ensureRealPathUnderRoot(root, dir);
      await writeFileNoFollow(fileAbs, params.text);
    } catch (err) {
      this.options.logger.warn({ err, filePath }, "failed to write compaction snippet cache");
    }
  }
}
