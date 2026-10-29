import { markRaw } from "vue";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import type { FileEditorTab } from "./types";

function releaseModel(tab: FileEditorTab) {
  tab.disposable?.dispose();
  tab.disposable = undefined;
  tab.model?.dispose();
  tab.model = undefined;
}

function invalidateContent(tab: FileEditorTab) {
  tab.contentRevision = (tab.contentRevision ?? 0) + 1;
}

/** The model remains the only current-content source; the revision makes raw model changes observable. */
export function replaceFileModel(tab: FileEditorTab, content: string, language = "plaintext") {
  releaseModel(tab);
  const uri = monaco.Uri.parse(`inmemory://editor/${encodeURIComponent(tab.path)}`);
  const model = markRaw(monaco.editor.createModel(content, language, uri));
  tab.model = model;
  tab.disposable = markRaw(model.onDidChangeContent(() => {
    if (tab.model !== model) return;
    tab.dirty = model.getValue() !== tab.savedContent;
    invalidateContent(tab);
  }));
  tab.dirty = content !== tab.savedContent;
  invalidateContent(tab);
  return model;
}

/** Closing/resetting a file session disposes its model; hiding/unmounting a view must not. */
export function disposeFileModel(tab: FileEditorTab) {
  const hadModel = !!tab.model;
  releaseModel(tab);
  if (hadModel) invalidateContent(tab);
}
