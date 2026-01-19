import { ref, watch, type Ref } from "vue";
import type { FileSearchBlock, FileSearchMatch, WorkspaceFileSearchScope } from "@agent-workbench/shared";

export type SearchScope = WorkspaceFileSearchScope;

export type SearchStore = {
  query: Ref<string>;
  useRegex: Ref<boolean>;
  caseSensitive: Ref<boolean>;
  wholeWord: Ref<boolean>;
  scope: Ref<SearchScope>;
  repoDirNames: Ref<string[]>;
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

const SEARCH_OPTIONS_STORAGE_KEY_PREFIX = "awb.search.options.v2";
const SEARCH_OPTIONS_STORAGE_KEY_PREFIX_V1 = "awb.search.options.v1";

function searchOptionsStorageKey(workspaceId: string, prefix = SEARCH_OPTIONS_STORAGE_KEY_PREFIX) {
  const id = String(workspaceId || "").trim();
  if (!id) return prefix;
  return `${prefix}.${id}`;
}

// 用 sessionStorage 记住搜索选项(正则/大小写/整词)，刷新页面后可以恢复(仅当前标签页会话)。
function restoreSearchOptionsFromStorage(
  workspaceId: string,
  store: Pick<SearchStore, "useRegex" | "caseSensitive" | "wholeWord" | "scope" | "repoDirNames">
) {
  try {
    const raw = sessionStorage.getItem(searchOptionsStorageKey(workspaceId));
    const fallbackRaw = raw ? null : sessionStorage.getItem(searchOptionsStorageKey(workspaceId, SEARCH_OPTIONS_STORAGE_KEY_PREFIX_V1));
    const payload = raw ?? fallbackRaw;
    if (!payload) return;
    const data = JSON.parse(payload) as Partial<Record<"useRegex" | "caseSensitive" | "wholeWord" | "scope" | "repoDirNames", unknown>>;
    if (typeof data.useRegex === "boolean") store.useRegex.value = data.useRegex;
    if (typeof data.caseSensitive === "boolean") store.caseSensitive.value = data.caseSensitive;
    if (typeof data.wholeWord === "boolean") store.wholeWord.value = data.wholeWord;
    if (data.scope === "global" || data.scope === "repos") store.scope.value = data.scope;
    if (Array.isArray(data.repoDirNames)) {
      store.repoDirNames.value = data.repoDirNames
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean);
    }
  } catch {
    // ignore
  }
}

function persistSearchOptionsToStorage(
  workspaceId: string,
  store: Pick<SearchStore, "useRegex" | "caseSensitive" | "wholeWord" | "scope" | "repoDirNames">
) {
  try {
    const data = {
      useRegex: store.useRegex.value,
      caseSensitive: store.caseSensitive.value,
      wholeWord: store.wholeWord.value,
      scope: store.scope.value,
      repoDirNames: store.repoDirNames.value
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
  const scope = ref<SearchScope>("global");
  const repoDirNames = ref<string[]>([]);

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
    scope,
    repoDirNames,
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
      scope.value = "global";
      repoDirNames.value = [];
      loading.value = false;
      requestSeq.value = 0;
      store.resetResults();
    }
  };

  restoreSearchOptionsFromStorage(workspaceId, store);
  watch([useRegex, caseSensitive, wholeWord, scope, repoDirNames], () => {
    persistSearchOptionsToStorage(workspaceId, store);
  });

  stores.set(key, store);
  return store;
}
