export type MermaidSize = { width: number; height: number };
export type MermaidViewportState = {
  scale: number;
  left: number;
  top: number;
  contentRevision: number;
};

export const MERMAID_MIN_SCALE = 0.05;
export const MERMAID_MAX_SCALE = 8;
export const MERMAID_ZOOM_STEP = 1.2;
export const MERMAID_CANVAS_PADDING = { left: 16, right: 80, top: 16, bottom: 16 };

function positive(value: number) { return Number.isFinite(value) && value > 0; }
function absoluteLength(value: string | null): number {
  return value && /^\s*\d+(?:\.\d+)?(?:px)?\s*$/.test(value) ? parseFloat(value) : 0;
}

/** Percentage widths and non-zero viewBox origins must not become pixel dimensions. */
export function getMermaidSvgSize(viewBox: string | null, width: string | null, height: string | null, measured?: MermaidSize): MermaidSize | null {
  const box = viewBox?.trim().split(/[\s,]+/).map(Number);
  if (box?.length === 4 && box.every(Number.isFinite) && positive(box[2]) && positive(box[3])) {
    return { width: box[2], height: box[3] };
  }
  const w = absoluteLength(width);
  const h = absoluteLength(height);
  if (positive(w) && positive(h)) return { width: w, height: h };
  return measured && positive(measured.width) && positive(measured.height) ? measured : null;
}

/** Fit never enlarges a small diagram; exceptionally large diagrams can fit below the normal zoom floor. */
export function fitMermaidScale(size: MermaidSize, width: number, height: number): number {
  const availableWidth = width - MERMAID_CANVAS_PADDING.left - MERMAID_CANVAS_PADDING.right;
  const availableHeight = height - MERMAID_CANVAS_PADDING.top - MERMAID_CANVAS_PADDING.bottom;
  if (!positive(availableWidth) || !positive(availableHeight)) return 1;
  return Math.min(1, availableWidth / size.width, availableHeight / size.height);
}

export function clampMermaidScale(scale: number, fit: number): number {
  const min = Math.min(MERMAID_MIN_SCALE, positive(fit) ? fit : MERMAID_MIN_SCALE);
  return Math.max(min, Math.min(MERMAID_MAX_SCALE, Number.isFinite(scale) ? scale : 1));
}

/** Calculate scroll offsets keeping a diagram point under a viewport-local anchor. */
export function zoomMermaidViewport(current: { scale: number; left: number; top: number }, nextScale: number, anchor: { x: number; y: number }) {
  const ratio = nextScale / current.scale;
  return {
    left: Math.max(0, (current.left + anchor.x - MERMAID_CANVAS_PADDING.left) * ratio + MERMAID_CANVAS_PADDING.left - anchor.x),
    top: Math.max(0, (current.top + anchor.y - MERMAID_CANVAS_PADDING.top) * ratio + MERMAID_CANVAS_PADDING.top - anchor.y)
  };
}

export function isMermaidViewportState(value: MermaidViewportState | undefined, revision: number): value is MermaidViewportState {
  return !!value && value.contentRevision === revision && positive(value.scale) &&
    Number.isFinite(value.left) && value.left >= 0 && Number.isFinite(value.top) && value.top >= 0;
}
