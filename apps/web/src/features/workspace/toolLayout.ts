import { readonly, shallowRef } from "vue";
import type { DockArea } from "./host";
import type { ToolId } from "./types";

export const TOOL_LAYOUT_STORAGE_KEY = "agent-workbench.ui.toolLayout.v1";
export const DOCK_AREAS: DockArea[] = ["leftTop", "leftBottom", "rightTop"];
export type ToolLayout = Record<DockArea, ToolId[]>;

// The single source of truth for default ordering and area constraints.
const DEFAULT_LAYOUT: ToolLayout = {
  leftTop: ["files", "search", "codeReview", "scheduledTasks", "environmentVariables", "agent"],
  leftBottom: ["terminal"],
  rightTop: ["editor"]
};
export const TOOL_IDS: ToolId[] = DOCK_AREAS.flatMap((area) => DEFAULT_LAYOUT[area]);

export function allowedToolAreas(toolId: ToolId): DockArea[] {
  return toolId === "editor" ? ["rightTop"] : ["leftTop", "leftBottom"];
}

export function normalizeToolLayout(raw: unknown): ToolLayout {
  const result: ToolLayout = { leftTop: [], leftBottom: [], rightTop: [] };
  const seen = new Set<ToolId>();
  const source = raw && typeof raw === "object" ? raw as Partial<Record<DockArea, unknown>> : {};
  for (const area of DOCK_AREAS) {
    const list = source[area];
    if (!Array.isArray(list)) continue;
    for (const id of list) {
      if (!TOOL_IDS.includes(id) || seen.has(id) || !allowedToolAreas(id).includes(area)) continue;
      result[area].push(id);
      seen.add(id);
    }
  }
  for (const area of DOCK_AREAS) {
    for (const id of DEFAULT_LAYOUT[area]) {
      if (!seen.has(id)) result[area].push(id);
    }
  }
  return result;
}

function loadToolLayout(): ToolLayout {
  try {
    const raw = JSON.parse(window.localStorage.getItem(TOOL_LAYOUT_STORAGE_KEY) ?? "null");
    if (raw?.version === 1) return normalizeToolLayout(raw.toolOrderByArea);
  } catch {
    // Missing/unavailable storage or malformed data uses defaults without writing them back.
  }
  return normalizeToolLayout(null);
}

const layout = shallowRef<ToolLayout>(loadToolLayout());
export const globalToolLayout = readonly(layout);

export function toolLayoutArea(toolId: ToolId, value = globalToolLayout.value): DockArea {
  return DOCK_AREAS.find((area) => value[area].includes(toolId)) ?? "leftTop";
}

function saveUserLayout(next: ToolLayout) {
  if (JSON.stringify(next) === JSON.stringify(layout.value)) return;
  layout.value = next;
  try {
    window.localStorage.setItem(TOOL_LAYOUT_STORAGE_KEY, JSON.stringify({ version: 1, toolOrderByArea: next }));
  } catch {
    // Still usable for this page if browser storage is unavailable.
  }
}

export function moveGlobalToolByStep(toolId: ToolId, step: -1 | 1) {
  const next = normalizeToolLayout(layout.value);
  const list = next[toolLayoutArea(toolId)];
  const index = list.indexOf(toolId);
  const target = index + step;
  if (index < 0 || target < 0 || target >= list.length) return;
  list.splice(index, 1);
  list.splice(target, 0, toolId);
  saveUserLayout(next);
}

export function moveGlobalTool(toolId: ToolId, targetArea: DockArea) {
  if (!TOOL_IDS.includes(toolId) || !allowedToolAreas(toolId).includes(targetArea)) return;
  const from = toolLayoutArea(toolId);
  if (from === targetArea) return;
  const next = normalizeToolLayout(layout.value);
  next[from] = next[from].filter((id) => id !== toolId);
  next[targetArea].push(toolId);
  saveUserLayout(next);
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.storageArea && event.storageArea !== window.localStorage) return;
    if (event.key !== TOOL_LAYOUT_STORAGE_KEY && event.key !== null) return;
    const next = loadToolLayout();
    if (JSON.stringify(next) !== JSON.stringify(layout.value)) layout.value = next;
  });
}
