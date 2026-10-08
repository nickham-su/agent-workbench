import fs from "node:fs/promises";
import path from "node:path";
import { HttpError } from "../../../app/errors.js";
import { applyPatchUiArtifactPath, tmpRoot, writeUiArtifactPath } from "../../../infra/fs/paths.js";
import { ensureDirSafeUnderRoot, ensureRealPathUnderRoot, readFileNoFollow, writeFileNoFollow } from "./safe-file-io.js";

export type UiArtifactWriteResult =
  | { kind: "written"; filePath: string }
  | { kind: "outside-tmp-root"; filePath: string };

/** A narrow port for fixed apply_patch/write UI artifact I/O, not a general filesystem service. */
export interface UiArtifactCapabilityPort {
  writeApplyPatch(input: { workspaceId: string; toolExecutionId: string; createdAt: number; artifact: unknown }): Promise<UiArtifactWriteResult>;
  writeWrite(input: { workspaceId: string; toolExecutionId: string; createdAt: number; artifact: unknown }): Promise<UiArtifactWriteResult>;
  readApplyPatch(input: { workspaceId: string; toolExecutionId: string }): Promise<unknown>;
  readWrite(input: { workspaceId: string; toolExecutionId: string }): Promise<unknown>;
}

export class UiArtifactCapability implements UiArtifactCapabilityPort {
  constructor(private readonly dataDir: string) {}

  writeApplyPatch(input: { workspaceId: string; toolExecutionId: string; createdAt: number; artifact: unknown }) {
    return this.writeJson(applyPatchUiArtifactPath(this.dataDir, input.workspaceId, input.toolExecutionId), {
      ...toRecord(input.artifact),
      workspaceId: input.workspaceId,
      toolExecutionId: input.toolExecutionId,
      createdAt: input.createdAt
    });
  }

  writeWrite(input: { workspaceId: string; toolExecutionId: string; createdAt: number; artifact: unknown }) {
    return this.writeJson(writeUiArtifactPath(this.dataDir, input.workspaceId, input.toolExecutionId), {
      ...toRecord(input.artifact),
      workspaceId: input.workspaceId,
      toolExecutionId: input.toolExecutionId,
      createdAt: input.createdAt
    });
  }

  readApplyPatch(input: { workspaceId: string; toolExecutionId: string }) {
    return this.readJson(applyPatchUiArtifactPath(this.dataDir, input.workspaceId, input.toolExecutionId), "apply_patch artifact not found");
  }

  readWrite(input: { workspaceId: string; toolExecutionId: string }) {
    return this.readJson(writeUiArtifactPath(this.dataDir, input.workspaceId, input.toolExecutionId), "write artifact not found");
  }

  private async writeJson(filePath: string, payload: unknown): Promise<UiArtifactWriteResult> {
    const tmpAbs = path.resolve(tmpRoot(this.dataDir));
    const dirAbs = path.resolve(path.dirname(filePath));
    if (!isUnderRoot(tmpAbs, dirAbs)) return { kind: "outside-tmp-root", filePath };
    await ensureDirSafeUnderRoot(tmpAbs, dirAbs);
    await ensureRealPathUnderRoot(tmpAbs, dirAbs);
    await writeFileNoFollow(filePath, JSON.stringify(payload));
    return { kind: "written", filePath };
  }

  private async readJson(filePath: string, notFoundMessage: string): Promise<unknown> {
    const tmpAbs = path.resolve(tmpRoot(this.dataDir));
    const fileAbs = path.resolve(filePath);
    if (!isUnderRoot(tmpAbs, fileAbs)) throw new HttpError(404, notFoundMessage);
    const st = await fs.lstat(fileAbs).catch(() => null);
    if (!st) {
      const parentReal = await fs.realpath(path.dirname(fileAbs)).catch(() => null);
      const rootReal = await fs.realpath(tmpAbs).catch(() => null);
      if (parentReal && rootReal && parentReal !== rootReal && !parentReal.startsWith(`${rootReal}${path.sep}`)) {
        throw new HttpError(400, "Invalid path");
      }
      throw new HttpError(404, notFoundMessage);
    }
    if (!st.isFile()) throw new HttpError(404, notFoundMessage);
    await ensureRealPathUnderRoot(tmpAbs, fileAbs);
    let text = "";
    try {
      text = await readFileNoFollow(fileAbs);
    } catch {
      throw new HttpError(404, notFoundMessage);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new HttpError(404, notFoundMessage);
    }
  }
}

function isUnderRoot(rootAbs: string, targetAbs: string) {
  return targetAbs.startsWith(rootAbs + path.sep) || targetAbs === rootAbs;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
