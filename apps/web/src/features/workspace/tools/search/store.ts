import { ref, watch, type Ref } from "vue";
import type { FileSearchBlock, FileSearchMatch } from "@agent-workbench/shared";

export type SearchStore = {
  query: Ref<string>;
  path: Ref<string>;
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
  store: Pick<SearchStore, "useRegex" | "caseSensitive" | "wholeWord" | "path">
) {
  try {
    const raw = sessionStorage.getItem(searchOptionsStorageKey(workspaceId));
    const fallbackRaw = raw ? null : sessionStorage.getItem(searchOptionsStorageKey(workspaceId, SEARCH_OPTIONS_STORAGE_KEY_PREFIX_V1));
    const payload = raw ?? fallbackRaw;
    if (!payload) return;
    const data = JSON.parse(payload) as Partial<
      Record<"useRegex" | "caseSensitive" | "wholeWord" | "path" | "scope" | "repoDirNames", unknown>
    >;
    if (typeof data.useRegex === "boolean") store.useRegex.value = data.useRegex;
    if (typeof data.caseSensitive === "boolean") store.caseSensitive.value = data.caseSensitive;
    if (typeof data.wholeWord === "boolean") store.wholeWord.value = data.wholeWord;

    // v3: path（当前版本）
    if (typeof data.path === "string") {
      const v = data.path.trim();
      // 统一口径：空字符串表示全局；不在 UI 上自动填入 '.'
      if (v === "." || v === "./") {
        store.path.value = "";
      } else {
        store.path.value = v;
      }
      return;
    }

    // v2/v1 兼容迁移：scope/repoDirNames -> path
    // - 旧scope=global -> path='.'
    // - 旧scope=repos 且 repoDirNames 只有1项 -> path=该dirName
    // - 旧scope=repos 且多项 -> path='.'
    const scope = typeof data.scope === "string" ? data.scope.trim() : "";
    const repoDirNames = Array.isArray(data.repoDirNames)
      ? data.repoDirNames.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean)
      : [];

    if (scope === "global") {
      store.path.value = "";
      return;
    }
    if (scope === "repos") {
      store.path.value = repoDirNames.length === 1 ? repoDirNames[0] : "";
      return;
    }
  } catch {
    // ignore
  }
}

function persistSearchOptionsToStorage(
  workspaceId: string,
  store: Pick<SearchStore, "useRegex" | "caseSensitive" | "wholeWord" | "path">
) {
  try {
    const data = {
      useRegex: store.useRegex.value,
      caseSensitive: store.caseSensitive.value,
      wholeWord: store.wholeWord.value,
      path: store.path.value
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
  const path = ref("");
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
    path,
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
      path.value = "";
      useRegex.value = false;
      caseSensitive.value = false;
      wholeWord.value = false;
      loading.value = false;
      requestSeq.value = 0;
      store.resetResults();
    }
  };

  restoreSearchOptionsFromStorage(workspaceId, store);
  watch([useRegex, caseSensitive, wholeWord, path], () => {
    persistSearchOptionsToStorage(workspaceId, store);
  });

  stores.set(key, store);
  return store;
}
