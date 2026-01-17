import * as monaco from "monaco-editor/esm/vs/editor/editor.api";

const PANEL_THEME_NAME = "panel-bg";
const DEFAULT_PANEL_BG = "#1e1e1e";

function resolvePanelBackground() {
  if (typeof document === "undefined") return DEFAULT_PANEL_BG;
  const value = getComputedStyle(document.documentElement).getPropertyValue("--panel-bg").trim();
  return value || DEFAULT_PANEL_BG;
}

export function applyMonacoPanelTheme() {
  const panelBg = resolvePanelBackground();
  monaco.editor.defineTheme(PANEL_THEME_NAME, {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": panelBg,
      "editorGutter.background": panelBg
    }
  });
  monaco.editor.setTheme(PANEL_THEME_NAME);
}
