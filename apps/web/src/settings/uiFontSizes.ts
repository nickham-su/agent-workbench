import { ref } from "vue";

const DEFAULT_FONT_SIZE = 13;
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 24;

const TERMINAL_FONT_SIZE_KEY = "agent-workbench.ui.fontSize.terminal";
const DIFF_FONT_SIZE_KEY = "agent-workbench.ui.fontSize.diff";

function clampFontSize(input: unknown) {
  const n = typeof input === "number" ? input : Number(String(input ?? "").trim());
  if (!Number.isFinite(n)) return DEFAULT_FONT_SIZE;
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(n)));
}

function loadFontSize(key: string) {
  try {
    return clampFontSize(localStorage.getItem(key));
  } catch {
    return DEFAULT_FONT_SIZE;
  }
}

function saveFontSize(key: string, size: number) {
  try {
    localStorage.setItem(key, String(size));
  } catch {
    // ignore
  }
}

export const uiFontSizeDefaults = {
  default: DEFAULT_FONT_SIZE,
  min: MIN_FONT_SIZE,
  max: MAX_FONT_SIZE
} as const;

export const terminalFontSize = ref<number>(loadFontSize(TERMINAL_FONT_SIZE_KEY));
export const diffFontSize = ref<number>(loadFontSize(DIFF_FONT_SIZE_KEY));

export function setTerminalFontSize(next: unknown) {
  const v = clampFontSize(next);
  terminalFontSize.value = v;
  saveFontSize(TERMINAL_FONT_SIZE_KEY, v);
}

export function setDiffFontSize(next: unknown) {
  const v = clampFontSize(next);
  diffFontSize.value = v;
  saveFontSize(DIFF_FONT_SIZE_KEY, v);
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (evt) => {
    if (!evt) return;
    if (evt.key === TERMINAL_FONT_SIZE_KEY) terminalFontSize.value = loadFontSize(TERMINAL_FONT_SIZE_KEY);
    if (evt.key === DIFF_FONT_SIZE_KEY) diffFontSize.value = loadFontSize(DIFF_FONT_SIZE_KEY);
  });
}

