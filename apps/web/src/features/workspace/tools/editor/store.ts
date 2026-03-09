import { computed, markRaw, reactive, ref, type ComputedRef, type Ref } from "vue";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import { inferLanguageFromPath } from "@/shared/monaco/languageUtils";
import type { DiffEditorTab, EditorOpenFileRequest, EditorTab, PreviewEditorTab, QueuedEditorOpenFileRequest } from "./types";

export type EditorStore = {
  tabs: EditorTab[];
  activeTabKey: Ref<string>;
  activeTab: ComputedRef<EditorTab | null>;
  hasDirtyNotSaving: ComputedRef<boolean>;
  hasTabs: ComputedRef<boolean>;
  pendingOpenFiles: Ref<QueuedEditorOpenFileRequest[]>;
  activationEpoch: Ref<number>;
  setActiveTabKey: (key: string) => void;
  upsertTab: (tab: EditorTab, opts?: { activate?: boolean }) => void;
  closeTab: (key: string) => void;
  closeTabs: (keys: string[]) => void;
  closeAllTabs: () => void;
  enqueueOpenFile: (req: EditorOpenFileRequest) => void;
  drainPendingOpenFiles: () => QueuedEditorOpenFileRequest[];
  renamePath: (from: string, to: string) => void;
  renamePathTree: (from: string, to: string) => void;
  closePath: (path: string) => void;
  closePathTree: (path: string) => void;
  reset: () => void;
  bumpActivationEpoch: () => number;
};

const stores = new Map<string, EditorStore>();

function disposeTab(tab: EditorTab) {
  if (tab.kind !== "file") return;
  tab.disposable?.dispose();
  tab.disposable = undefined;
  tab.model?.dispose();
  tab.model = undefined;
}

function updateFileTabPath(tab: Extract<EditorTab, { kind: "file" }>, nextPath: string) {
  tab.path = nextPath;
  tab.key = `file:${nextPath}`;
  tab.title = nextPath.split("/").filter(Boolean).pop() || nextPath;
  tab.language = inferLanguageFromPath(nextPath);
  if (!tab.model) return;
  const value = tab.model.getValue();
  tab.disposable?.dispose();
  tab.disposable = undefined;
  tab.model.dispose();
  tab.model = markRaw(monaco.editor.createModel(value, tab.language || "plaintext", monaco.Uri.parse(`inmemory://editor/${encodeURIComponent(nextPath)}`)));
  tab.disposable = markRaw(
    tab.model.onDidChangeContent(() => {
      const current = tab.model?.getValue() ?? "";
      tab.dirty = current !== tab.savedContent;
    })
  );
}

function updateReadonlyTabPath(tab: PreviewEditorTab | DiffEditorTab, previousPath: string, nextPath: string): [string, string] {
  const previousKey = tab.key;
  tab.path = nextPath;
  tab.title = nextPath.split("/").filter(Boolean).pop() || nextPath;
  tab.language = inferLanguageFromPath(nextPath);

  if (tab.kind === "preview" && tab.key === `preview:path:${previousPath}`) {
    tab.key = `preview:path:${nextPath}`;
    return [previousKey, tab.key];
  }
  if (tab.kind === "diff" && tab.key === `diff:${previousPath}`) {
    tab.key = `diff:${nextPath}`;
    return [previousKey, tab.key];
  }
  return [previousKey, tab.key];
}

function renameTabPath(tab: EditorTab, previousPath: string, nextPath: string): [string, string] {
  const previousKey = tab.key;
  if (tab.kind === "file") {
    updateFileTabPath(tab, nextPath);
    return [previousKey, tab.key];
  }
  return updateReadonlyTabPath(tab, previousPath, nextPath);
}

export function getEditorStore(workspaceId: string): EditorStore {
  const key = String(workspaceId || "").trim() || "__default__";
  const existing = stores.get(key);
  if (existing) return existing;

  const tabs = reactive<EditorTab[]>([]);
  const activeTabKey = ref("");
  const pendingOpenFiles = ref<QueuedEditorOpenFileRequest[]>([]);
  let nextOpenFileSeq = 0;
  const activeTab = computed<EditorTab | null>(() => tabs.find((tab) => tab.key === activeTabKey.value) ?? null);
  const activationEpoch = ref(0);
  const hasDirtyNotSaving = computed(() => tabs.some((tab) => tab.kind === "file" && tab.dirty && !tab.saving));
  const hasTabs = computed(() => tabs.length > 0);

  const store: EditorStore = {
    tabs,
    activeTabKey,
    activeTab,
    hasDirtyNotSaving,
    hasTabs,
    pendingOpenFiles,
    activationEpoch,
    setActiveTabKey: (next) => {
      activeTabKey.value = next;
    },
    upsertTab: (tab, opts) => {
      const idx = tabs.findIndex((item) => item.key === tab.key);
      if (idx >= 0) {
        if (tabs[idx] !== tab) disposeTab(tabs[idx]!);
        tabs[idx] = tab;
      } else {
        tabs.push(tab);
      }
      if (opts?.activate !== false) activeTabKey.value = tab.key;
    },
    closeTab: (keyToClose) => {
      const idx = tabs.findIndex((tab) => tab.key === keyToClose);
      if (idx < 0) return;
      const tab = tabs[idx]!;
      disposeTab(tab);
      const wasActive = activeTabKey.value === keyToClose;
      tabs.splice(idx, 1);
      if (!wasActive) return;
      activationEpoch.value += 1;
      if (activeTabKey.value === keyToClose) {
        const next = tabs[idx] ?? tabs[idx - 1] ?? null;
        activeTabKey.value = next?.key ?? "";
      }
    },
    closeTabs: (keysToClose) => {
      if (keysToClose.length === 0) return;
      const closeSet = new Set(keysToClose);
      const currentTabs = [...tabs];
      if (!currentTabs.some((tab) => closeSet.has(tab.key))) return;

      const activeIndex = currentTabs.findIndex((tab) => tab.key === activeTabKey.value);
      const activeWillClose = !!activeTabKey.value && closeSet.has(activeTabKey.value);
      const remainingTabs = currentTabs.filter((tab) => !closeSet.has(tab.key));

      for (const tab of currentTabs) {
        if (!closeSet.has(tab.key)) continue;
        disposeTab(tab);
      }

      tabs.splice(0, tabs.length, ...remainingTabs);

      if (!activeWillClose) return;
      activationEpoch.value += 1;
      const nextRight = activeIndex >= 0 ? currentTabs.slice(activeIndex + 1).find((tab) => !closeSet.has(tab.key)) ?? null : null;
      const nextLeft = activeIndex >= 0 ? [...currentTabs.slice(0, activeIndex)].reverse().find((tab) => !closeSet.has(tab.key)) ?? null : null;
      activeTabKey.value = nextRight?.key ?? nextLeft?.key ?? "";
    },
    closeAllTabs: () => {
      if (tabs.length === 0) return;
      store.closeTabs(tabs.map((tab) => tab.key));
    },
    enqueueOpenFile: (req) => {
      pendingOpenFiles.value = [...pendingOpenFiles.value, { seq: ++nextOpenFileSeq, epoch: activationEpoch.value, req }];
    },
    drainPendingOpenFiles: () => {
      const next = pendingOpenFiles.value;
      pendingOpenFiles.value = [];
      return next;
    },
    renamePath: (from, to) => {
      for (const tab of tabs) {
        if ("path" in tab && tab.path === from) {
          const [previousKey, nextKey] = renameTabPath(tab, from, to);
          if (activeTabKey.value === previousKey) activeTabKey.value = nextKey;
        }
      }
    },
    renamePathTree: (from, to) => {
      for (const tab of tabs) {
        if (!("path" in tab) || !tab.path) continue;
        const previousPath = tab.path;
        if (previousPath !== from && !previousPath.startsWith(from + "/")) continue;
        const previousKey = tab.key;
        const nextPath = to + previousPath.slice(from.length);
        const [, nextKey] = renameTabPath(tab, previousPath, nextPath);
        if (activeTabKey.value === previousKey) activeTabKey.value = nextKey;
      }
    },
    closePath: (path) => {
      const keys = tabs.filter((tab) => "path" in tab && tab.path === path).map((tab) => tab.key);
      store.closeTabs(keys);
    },
    closePathTree: (path) => {
      const keys = tabs
        .filter((tab) => "path" in tab && tab.path && (tab.path === path || tab.path.startsWith(path + "/")))
        .map((tab) => tab.key);
      store.closeTabs(keys);
    },
    reset: () => {
      for (const tab of tabs) disposeTab(tab);
      tabs.splice(0, tabs.length);
      activeTabKey.value = "";
      activationEpoch.value += 1;
      pendingOpenFiles.value = [];
    },
    bumpActivationEpoch: () => {
      activationEpoch.value += 1;
      return activationEpoch.value;
    }
  };

  stores.set(key, store);
  return store;
}
