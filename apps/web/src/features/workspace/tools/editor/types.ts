import type * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import type { FileVersion } from "@agent-workbench/shared";

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
  savedContent: string;
  dirty: boolean;
  saving: boolean;
  pendingSave: boolean;
  conflictOpen?: boolean;
  error?: string;
  openAt?: EditorOpenAt;
  readOnly: boolean;
  disposable?: monaco.IDisposable;
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
