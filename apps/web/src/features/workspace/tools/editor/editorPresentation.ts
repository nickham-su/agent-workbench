import { getWorkspacePreviewResourceDescriptor } from "@agent-workbench/shared";

/** Presentation only: this is neither a text-read allowlist nor a Monaco language mapping. */
export type EditorFilePresentation = "source" | "markdown" | "mermaid" | "image" | "html";

export function getEditorFilePresentation(path: string): EditorFilePresentation {
  const resource = getWorkspacePreviewResourceDescriptor(path);
  if (resource?.kind === "image") return "image";
  // HTML keeps its existing external-preview action, not an inline renderer.
  if (resource?.kind === "html") return "html";
  if (path.includes("?") || path.includes("#")) return "source";
  const basename = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const extension = /^.+\.(md|mmd|mermaid)$/i.exec(basename)?.[1]?.toLowerCase();
  if (extension === "md") return "markdown";
  if (extension === "mmd" || extension === "mermaid") return "mermaid";
  return "source";
}
