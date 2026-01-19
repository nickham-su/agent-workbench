import { ref } from "vue";

const DEFAULT_FONT_SIZE = 13;
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 24;

const TERMINAL_FONT_SIZE_KEY = "agent-workbench.ui.fontSize.terminal";
// 旧版本使用 diff 作为 key,但实际含义已调整为通用编辑器字号.
const LEGACY_DIFF_FONT_SIZE_KEY = "agent-workbench.ui.fontSize.diff";
const EDITOR_FONT_SIZE_KEY = "agent-workbench.ui.fontSize.editor";

function clampFontSize(input: unknown) {
  if (input === null || input === undefined) return DEFAULT_FONT_SIZE;
  if (typeof input === "string" && input.trim() === "") return DEFAULT_FONT_SIZE;
  const n = typeof input === "number" ? input : Number(String(input).trim());
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

function loadEditorFontSize() {
  try {
    const v = localStorage.getItem(EDITOR_FONT_SIZE_KEY);
    if (v !== null) return clampFontSize(v);

    // 兼容旧 key: 首次读取时做一次迁移,避免用户升级后丢失配置.
    const legacy = localStorage.getItem(LEGACY_DIFF_FONT_SIZE_KEY);
    if (legacy !== null) {
      const next = clampFontSize(legacy);
      localStorage.setItem(EDITOR_FONT_SIZE_KEY, String(next));
      return next;
    }
  } catch {
    // ignore
  }
  return DEFAULT_FONT_SIZE;
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
export const editorFontSize = ref<number>(loadEditorFontSize());

export function setTerminalFontSize(next: unknown) {
  const v = clampFontSize(next);
  terminalFontSize.value = v;
  saveFontSize(TERMINAL_FONT_SIZE_KEY, v);
}

export function setEditorFontSize(next: unknown) {
  const v = clampFontSize(next);
  editorFontSize.value = v;
  saveFontSize(EDITOR_FONT_SIZE_KEY, v);

  // 同步写入旧 key,保证多标签页/旧代码仍能读取到最新值.
  saveFontSize(LEGACY_DIFF_FONT_SIZE_KEY, v);
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (evt) => {
    if (!evt) return;
    if (evt.key === TERMINAL_FONT_SIZE_KEY) terminalFontSize.value = loadFontSize(TERMINAL_FONT_SIZE_KEY);
    if (evt.key === EDITOR_FONT_SIZE_KEY || evt.key === LEGACY_DIFF_FONT_SIZE_KEY) editorFontSize.value = loadEditorFontSize();
  });
}
