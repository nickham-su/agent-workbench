import { getWorkspacePreviewResourceDescriptor, type FileStatResponse, type FileVersion } from "@agent-workbench/shared";

export const EDITOR_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export type EditorImageFailure = "too_large" | "missing" | "unsafe_path" | "load_failed";
export type EditorImageResult =
  | { ok: true; blob: Blob; version: FileVersion }
  | { ok: false; reason: EditorImageFailure };

/** The download API is reused: these checks limit display, not server-side transfer. */
export async function loadEditorImage(params: {
  path: string;
  stat: () => Promise<FileStatResponse>;
  download: () => Promise<Blob>;
}): Promise<EditorImageResult> {
  const resource = getWorkspacePreviewResourceDescriptor(params.path);
  if (resource?.kind !== "image") return { ok: false, reason: "load_failed" };
  try {
    const stat = await params.stat();
    if (!stat.ok || stat.kind !== "file") {
      const reason = stat.reason === "missing" ? "missing" : stat.reason === "unsafe_path" ? "unsafe_path" : "load_failed";
      return { ok: false, reason };
    }
    if (!stat.version || !Number.isSafeInteger(stat.version.size) || stat.version.size < 0) return { ok: false, reason: "load_failed" };
    if (stat.version.size > EDITOR_IMAGE_MAX_BYTES) return { ok: false, reason: "too_large" };
    const blob = await params.download();
    if (blob.size > EDITOR_IMAGE_MAX_BYTES) return { ok: false, reason: "too_large" };
    return { ok: true, blob: new Blob([blob], { type: resource.mime }), version: stat.version };
  } catch {
    return { ok: false, reason: "load_failed" };
  }
}
