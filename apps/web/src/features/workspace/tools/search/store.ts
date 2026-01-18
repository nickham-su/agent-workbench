import { ref, watch, type Ref } from "vue";
import type { FileSearchBlock, FileSearchMatch } from "@agent-workbench/shared";

export type SearchStore = {
  query: Ref<string>;
  useRegex: Ref<boolean>;
  caseSensitive: Ref<boolean>;
  wholeWord: Ref<boolean>;
  matches: Ref<FileSearchMatch[]>;
  blocks: Ref<FileSearchBlock[]>;
  loading: Ref<boolean>;
  error: Ref<string>;
  truncated: Ref<boolean>;
  timedOut: Ref<boolean>;
  tookMs: Ref<number | null>;
  activeMatchKey: Ref<string>;
  requestSeq: Ref<number>;
  nextRequestSeq: () => number;
  resetResults: () => void;
  resetAll: () => void;
};

const stores = new Map<string, SearchStore>();

const SEARCH_OPTIONS_STORAGE_KEY_PREFIX = "awb.search.options";

function searchOptionsStorageKey(workspaceId: string) {
  const id = String(workspaceId || "").trim();
  if (!id) return `${SEARCH_OPTIONS_STORAGE_KEY_PREFIX}.v1`;
  return `${SEARCH_OPTIONS_STORAGE_KEY_PREFIX}.v1.${id}`;
}

// 用 sessionStorage 记住搜索选项(正则/大小写/整词)，刷新页面后可以恢复(仅当前标签页会话)。
function restoreSearchOptionsFromStorage(workspaceId: string, store: Pick<SearchStore, "useRegex" | "caseSensitive" | "wholeWord">) {
  try {
    const raw = sessionStorage.getItem(searchOptionsStorageKey(workspaceId));
    if (!raw) return;
    const data = JSON.parse(raw) as Partial<Record<"useRegex" | "caseSensitive" | "wholeWord", unknown>>;
    if (typeof data.useRegex === "boolean") store.useRegex.value = data.useRegex;
    if (typeof data.caseSensitive === "boolean") store.caseSensitive.value = data.caseSensitive;
    if (typeof data.wholeWord === "boolean") store.wholeWord.value = data.wholeWord;
  } catch {
    // ignore
  }
}

function persistSearchOptionsToStorage(workspaceId: string, store: Pick<SearchStore, "useRegex" | "caseSensitive" | "wholeWord">) {
  try {
    const data = {
      useRegex: store.useRegex.value,
      caseSensitive: store.caseSensitive.value,
      wholeWord: store.wholeWord.value
    };
    sessionStorage.setItem(searchOptionsStorageKey(workspaceId), JSON.stringify(data));
  } catch {
    // ignore
  }
}

export function getSearchStore(workspaceId: string): SearchStore {
  const key = String(workspaceId || "").trim() || "__default__";
  const existing = stores.get(key);
  if (existing) return existing;

  const query = ref("");
  const useRegex = ref(false);
  const caseSensitive = ref(false);
  const wholeWord = ref(false);

  const matches = ref<FileSearchMatch[]>([]);
  const blocks = ref<FileSearchBlock[]>([]);
  const loading = ref(false);
  const error = ref("");
  const truncated = ref(false);
  const timedOut = ref(false);
  const tookMs = ref<number | null>(null);
  const activeMatchKey = ref("");
  const requestSeq = ref(0);

  const store: SearchStore = {
    query,
    useRegex,
    caseSensitive,
    wholeWord,
    matches,
    blocks,
    loading,
    error,
    truncated,
    timedOut,
    tookMs,
    activeMatchKey,
    requestSeq,
    nextRequestSeq: () => {
      requestSeq.value += 1;
      return requestSeq.value;
    },
    resetResults: () => {
      matches.value = [];
      blocks.value = [];
      error.value = "";
      truncated.value = false;
      timedOut.value = false;
      tookMs.value = null;
      activeMatchKey.value = "";
    },
    resetAll: () => {
      query.value = "";
      useRegex.value = false;
      caseSensitive.value = false;
      wholeWord.value = false;
      loading.value = false;
      requestSeq.value = 0;
      store.resetResults();
    }
  };

  restoreSearchOptionsFromStorage(workspaceId, store);
  watch([useRegex, caseSensitive, wholeWord], () => {
    persistSearchOptionsToStorage(workspaceId, store);
  });

  stores.set(key, store);
  return store;
}
