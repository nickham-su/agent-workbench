import { computed, reactive, ref, type ComputedRef, type Ref } from "vue";
import type { FileTab } from "./types";

export type FileExplorerStore = {
  tabs: FileTab[];
  activeTabKey: Ref<string>;
  activeTab: ComputedRef<FileTab | null>;
  hasDirtyNotSaving: ComputedRef<boolean>;
  getTargetKey: () => string;
  setTargetKey: (key: string) => boolean;
  setActiveTabKey: (key: string) => void;
  getTab: (path: string) => FileTab | null;
  addTab: (tab: FileTab) => void;
  removeTab: (path: string) => FileTab | null;
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

  const store: FileExplorerStore = {
    tabs,
    activeTabKey,
    activeTab,
    hasDirtyNotSaving,
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
    resetTabs: () => {
      for (const tab of tabs) disposeTab(tab);
      tabs.splice(0, tabs.length);
      activeTabKey.value = "";
    }
  };

  stores.set(key, store);
  return store;
}
