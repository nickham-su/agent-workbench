import type * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import type { FileEntry, FileReadResponse, FileVersion } from "@agent-workbench/shared";

export type TreeNode = {
  key: string;
  title: string;
  isLeaf: boolean;
  children?: TreeNode[];
  selectable?: boolean;
  data: FileEntry;
};

export type FileTab = {
  path: string;
  title: string;
  previewable: boolean;
  reason?: FileReadResponse["reason"];
  version?: FileVersion;
  model?: monaco.editor.ITextModel;
  savedContent: string;
  dirty: boolean;
  saving: boolean;
  pendingSave: boolean;
  conflictOpen?: boolean;
  error?: string;
  language?: string;
  disposable?: monaco.IDisposable;
};
