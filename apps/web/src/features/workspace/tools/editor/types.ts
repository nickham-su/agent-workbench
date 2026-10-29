import type * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import type { FileVersion } from "@agent-workbench/shared";
import type { EditorImageFailure } from "./editorImages";
import type { MermaidViewportState } from "./mermaidViewport";

export type EditorOpenAtHighlight =
  | { kind: "none" }
  | { kind: "line" }
  | { kind: "range"; startCol: number; endCol: number };

export type EditorOpenAt = {
  line?: number;
  column?: number;
  reveal?: "center" | "top";
  highlight?: EditorOpenAtHighlight;
};

export type EditorOpenFileRequest = {
  path: string;
  line?: number;
  column?: number;
  reveal?: "center" | "top";
  highlight?: EditorOpenAtHighlight;
  mode?: "edit" | "preview";
  targetDirName?: string;
  title?: string;
};

export type QueuedEditorOpenFileRequest = {
  seq: number;
  epoch: number;
  req: EditorOpenFileRequest;
};

export type FileEditorTab = {
  key: string;
  kind: "file";
  title: string;
  path: string;
  language?: string;
  previewable: boolean;
  reason?: "too_large" | "binary" | "decode_failed" | "unsafe_path" | "missing";
  version?: FileVersion;
  model?: monaco.editor.ITextModel;
  /** Monotonic invalidation signal for model edits, replacement and disposal; absent means zero. */
  contentRevision?: number;
  /** Display state only; independent of the read-only open mode. */
  presentationMode?: "source" | "preview";
  previewScrollTop?: number;
  mermaidViewport?: MermaidViewportState;
  savedContent: string;
  dirty: boolean;
  saving: boolean;
  pendingSave: boolean;
  conflictOpen?: boolean;
  error?: string;
  openAt?: EditorOpenAt;
  readOnly: boolean;
  /** Caller open mode, preserved separately from image/media's forced read-only display. */
  requestedReadOnly?: boolean;
  disposable?: monaco.IDisposable;
  viewState?: monaco.editor.ICodeEditorViewState | null;
  image?: {
    status: "loading" | "ready" | "error";
    url?: string;
    reason?: EditorImageFailure;
  };
  /** Media bytes belong to the native player, never to a Blob or Monaco model. */
  media?: { kind: "audio" | "video" };
  /** Invalidates reads when the Tab is closed, renamed or refreshed. */
  loadVersion?: number;
  needsReload?: boolean;
};

export type PreviewEditorTab = {
  key: string;
  kind: "preview";
  title: string;
  path?: string;
  text: string;
  language?: string;
  source?: string;
  readOnly: true;
};

export type DiffEditorTab = {
  key: string;
  kind: "diff";
  title: string;
  path?: string;
  original: string;
  modified: string;
  language?: string;
  source?: string;
  readOnly: true;
};

export type EditorTab = FileEditorTab | PreviewEditorTab | DiffEditorTab;
