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
  writeApplyPatch(input: { workspaceId: string; toolCallId: string; createdAt: number; artifact: unknown }): Promise<UiArtifactWriteResult>;
  writeWrite(input: { workspaceId: string; toolCallId: string; createdAt: number; artifact: unknown }): Promise<UiArtifactWriteResult>;
  readApplyPatch(input: { workspaceId: string; toolCallId: string }): Promise<unknown>;
  readWrite(input: { workspaceId: string; toolCallId: string }): Promise<unknown>;
}

export class UiArtifactCapability implements UiArtifactCapabilityPort {
  constructor(private readonly dataDir: string) {}

  writeApplyPatch(input: { workspaceId: string; toolCallId: string; createdAt: number; artifact: unknown }) {
    return this.writeJson(applyPatchUiArtifactPath(this.dataDir, input.workspaceId, input.toolCallId), {
      ...toRecord(input.artifact),
      workspaceId: input.workspaceId,
      toolCallId: input.toolCallId,
      createdAt: input.createdAt
    });
  }

  writeWrite(input: { workspaceId: string; toolCallId: string; createdAt: number; artifact: unknown }) {
    return this.writeJson(writeUiArtifactPath(this.dataDir, input.workspaceId, input.toolCallId), {
      ...toRecord(input.artifact),
      workspaceId: input.workspaceId,
      toolCallId: input.toolCallId,
      createdAt: input.createdAt
    });
  }

  readApplyPatch(input: { workspaceId: string; toolCallId: string }) {
    return this.readJson(applyPatchUiArtifactPath(this.dataDir, input.workspaceId, input.toolCallId), "apply_patch artifact not found");
  }

  readWrite(input: { workspaceId: string; toolCallId: string }) {
    return this.readJson(writeUiArtifactPath(this.dataDir, input.workspaceId, input.toolCallId), "write artifact not found");
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
    if (!st || !st.isFile()) throw new HttpError(404, notFoundMessage);
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
