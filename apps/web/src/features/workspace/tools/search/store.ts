import { ref, type Ref } from "vue";
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

  stores.set(key, store);
  return store;
}
