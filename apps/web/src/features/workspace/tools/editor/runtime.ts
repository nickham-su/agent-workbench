import { effectScope, watch } from "vue";
import type { ToolRuntime, ToolRuntimeContext } from "@/features/workspace/runtime";
import { getEditorStore } from "./store";
import type { DiffEditorTab, EditorOpenFileRequest, PreviewEditorTab } from "./types";

function toKey(prefix: string, value?: string) {
  const raw = String(value || "").trim();
  return raw ? `${prefix}:${raw}` : `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeOpenFileRequest(payload: Record<string, unknown>): EditorOpenFileRequest | null {
  const path = typeof payload.path === "string" ? payload.path.trim() : "";
  if (!path) return null;
  const line = typeof payload.line === "number" && Number.isFinite(payload.line) ? payload.line : undefined;
  const column = typeof payload.column === "number" && Number.isFinite(payload.column) ? payload.column : undefined;
  const reveal = payload.reveal === "top" || payload.reveal === "center" ? payload.reveal : undefined;
  const mode = payload.mode === "preview" ? "preview" : "edit";
  const highlightRaw = payload.highlight;
  let highlight: EditorOpenFileRequest["highlight"];
  if (highlightRaw && typeof highlightRaw === "object") {
    const kind = (highlightRaw as any).kind;
    if (kind === "none" || kind === "line") {
      highlight = { kind };
    } else if (kind === "range") {
      const startCol = (highlightRaw as any).startCol;
      const endCol = (highlightRaw as any).endCol;
      if (typeof startCol === "number" && typeof endCol === "number") {
        highlight = { kind: "range", startCol, endCol };
      }
    }
  }
  return {
    path,
    line,
    column,
    reveal,
    highlight,
    mode,
    targetDirName: typeof payload.targetDirName === "string" ? payload.targetDirName : undefined,
    title: typeof payload.title === "string" ? payload.title : undefined
  };
}

export function createEditorRuntime(ctx: ToolRuntimeContext): ToolRuntime {
  const store = getEditorStore(ctx.workspaceId);
  let scope = effectScope();

  const syncDot = () => {
    ctx.host.setToolDot(ctx.toolId, store.hasDirtyNotSaving.value);
  };

  return {
    start() {
      scope.run(() => {
        watch(
          store.hasDirtyNotSaving,
          () => {
            syncDot();
          },
          { immediate: true }
        );
      });
    },
    dispose() {
      store.reset();
      ctx.host.setToolDot(ctx.toolId, false);
      scope.stop();
      scope = effectScope();
    },
    onRepoChange() {
      // no-op: editor state由显式调用驱动
    },
    onVisibilityChange() {
      // no-op
    },
    onCall(envelope) {
      const payload = (envelope.payload ?? {}) as Record<string, unknown>;
      if (envelope.type === "editor.openFile") {
        const req = normalizeOpenFileRequest(payload);
        if (!req) return;
        store.enqueueOpenFile(req);
        return;
      }
      if (envelope.type === "editor.openPreview") {
        store.bumpActivationEpoch();
        const title = String(payload.title || payload.path || "Preview");
        const text = typeof payload.text === "string" ? payload.text : "";
        const path = typeof payload.path === "string" ? payload.path : undefined;
        const language = typeof payload.language === "string" ? payload.language : undefined;
        const key = typeof payload.tabKey === "string" && payload.tabKey.trim() ? payload.tabKey.trim() : (path ? `preview:path:${path}` : toKey("preview", title));
        const tab: PreviewEditorTab = { key, kind: "preview", title, path, text, language, source: typeof payload.source === "string" ? payload.source : undefined, readOnly: true };
        store.upsertTab(tab);
        return;
      }
      if (envelope.type === "editor.openDiff") {
        store.bumpActivationEpoch();
        const title = String(payload.title || payload.path || "Diff");
        const original = typeof payload.original === "string" ? payload.original : "";
        const modified = typeof payload.modified === "string" ? payload.modified : "";
        const path = typeof payload.path === "string" ? payload.path : undefined;
        const language = typeof payload.language === "string" ? payload.language : undefined;
        const key = typeof payload.tabKey === "string" && payload.tabKey.trim() ? payload.tabKey.trim() : (path ? `diff:${path}` : toKey("diff", title));
        const tab: DiffEditorTab = { key, kind: "diff", title, path, original, modified, language, source: typeof payload.source === "string" ? payload.source : undefined, readOnly: true };
        store.upsertTab(tab);
        return;
      }
    },
    onEvent(event) {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      if (event.type === "editor.fsRenamed") {
        const from = typeof payload.from === "string" ? payload.from.trim() : "";
        const to = typeof payload.to === "string" ? payload.to.trim() : "";
        const kind = payload.kind === "dir" ? "dir" : "file";
        if (!from || !to) return;
        if (kind === "dir") store.renamePathTree(from, to);
        else store.renamePath(from, to);
        return;
      }
      if (event.type === "editor.fsDeleted") {
        const path = typeof payload.path === "string" ? payload.path.trim() : "";
        const kind = payload.kind === "dir" ? "dir" : "file";
        if (!path) return;
        if (kind === "dir") store.closePathTree(path);
        else store.closePath(path);
        return;
      }
      if (event.type === "editor.fsCreated" || event.type === "editor.fsUploaded") {
        return;
      }
    }
  };
}
