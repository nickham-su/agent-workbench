import { computed, reactive, ref, type ComputedRef, type Ref } from "vue";
import type { FileTab } from "./types";

export type FileOpenAtRequest =
  | {
      path: string;
      line: number;
      highlight: { kind: "range"; startCol: number; endCol: number };
    }
  | {
      path: string;
      line: number;
      highlight: { kind: "line" };
    };

export type FileExplorerStore = {
  tabs: FileTab[];
  activeTabKey: Ref<string>;
  activeTab: ComputedRef<FileTab | null>;
  hasDirtyNotSaving: ComputedRef<boolean>;
  pendingOpenAt: Ref<FileOpenAtRequest | null>;
  getTargetKey: () => string;
  setTargetKey: (key: string) => boolean;
  setActiveTabKey: (key: string) => void;
  getTab: (path: string) => FileTab | null;
  addTab: (tab: FileTab) => void;
  removeTab: (path: string) => FileTab | null;
  setPendingOpenAt: (req: FileOpenAtRequest | null) => void;
  resetTabs: () => void;
};

const stores = new Map<string, FileExplorerStore>();

function disposeTab(tab: FileTab) {
  tab.disposable?.dispose();
  tab.disposable = undefined;
  tab.model?.dispose();
  tab.model = undefined;
}

export function getFileExplorerStore(workspaceId: string): FileExplorerStore {
  const key = String(workspaceId || "").trim() || "__default__";
  const existing = stores.get(key);
  if (existing) return existing;

  const tabs = reactive<FileTab[]>([]);
  const activeTabKey = ref<string>("");
  const targetKey = ref<string>("");
  const activeTab = computed<FileTab | null>(() => {
    const current = activeTabKey.value;
    if (!current) return null;
    return tabs.find((t) => t.path === current) ?? null;
  });
  const hasDirtyNotSaving = computed(() => tabs.some((tab) => tab.dirty && !tab.saving));
  const pendingOpenAt = ref<FileOpenAtRequest | null>(null);

  const store: FileExplorerStore = {
    tabs,
    activeTabKey,
    activeTab,
    hasDirtyNotSaving,
    pendingOpenAt,
    getTargetKey: () => targetKey.value,
    setTargetKey: (next) => {
      if (targetKey.value === next) return false;
      targetKey.value = next;
      return true;
    },
    setActiveTabKey: (next) => {
      activeTabKey.value = next;
    },
    getTab: (path) => tabs.find((t) => t.path === path) ?? null,
    addTab: (tab) => {
      tabs.push(tab);
    },
    removeTab: (path) => {
      const idx = tabs.findIndex((t) => t.path === path);
      if (idx < 0) return null;
      const removed = tabs[idx]!;
      disposeTab(removed);
      tabs.splice(idx, 1);
      if (activeTabKey.value === path) activeTabKey.value = "";
      return removed;
    },
    setPendingOpenAt: (req) => {
      pendingOpenAt.value = req;
    },
    resetTabs: () => {
      for (const tab of tabs) disposeTab(tab);
      tabs.splice(0, tabs.length);
      activeTabKey.value = "";
      pendingOpenAt.value = null;
    }
  };

  stores.set(key, store);
  return store;
}
