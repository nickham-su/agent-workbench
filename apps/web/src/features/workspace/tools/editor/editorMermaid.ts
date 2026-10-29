import createDOMPurify from "dompurify";
import type { Mermaid } from "mermaid";

export const MERMAID_MAX_TEXT = 30_000;
export const MERMAID_MAX_NODES = 300;
export const MERMAID_MAX_EDGES = 300;
export type MermaidPreviewFailure = "empty" | "tooLarge" | "unsafe" | "unsupported" | "loadFailed" | "renderFailed";
export class MermaidPreviewError extends Error {
  constructor(readonly reason: MermaidPreviewFailure) { super(reason); }
}

// These labels can otherwise become active HTML/CSS during Mermaid's temporary layout,
// before we get a chance to sanitize the returned SVG.
function decodeEntities(text: string) {
  const named: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'", colon: ":", sol: "/", bsol: "\\", lpar: "(", rpar: ")", tab: "\t", newline: "\n" };
  for (let pass = 0; pass < 3; pass++) {
    text = text.replace(/(?:&|#)(?:#(x[\da-f]+|\d+)|([a-z]+)|(\d+));/gi, (raw, numeric: string | undefined, name: string | undefined, mermaidNumber: string | undefined) => {
      if (name) return named[name.toLowerCase()] ?? raw;
      const code = numeric?.toLowerCase().startsWith("x") ? parseInt(numeric.slice(1), 16) : Number(numeric ?? mermaidNumber);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : raw;
    });
  }
  return text;
}

function safeDeclarations(value: string) {
  return value.split(",").every((entry) => {
    const match = /^\s*([a-z-]+)\s*:\s*([^:]+)\s*$/i.exec(entry);
    if (!match) return false;
    const [, property, raw] = match;
    const val = raw.trim();
    if (["fill", "stroke", "color"].includes(property.toLowerCase())) return /^(?:#[\da-f]{3,8}|[a-z]+)$/i.test(val);
    if (["stroke-width", "font-size", "opacity", "fill-opacity", "stroke-opacity"].includes(property.toLowerCase())) return /^\d+(?:\.\d+)?(?:px|em|rem|%)?$/.test(val);
    if (property === "stroke-dasharray") return /^\d+(?:[ .]\d+)*$/.test(val);
    if (property === "font-weight") return /^(?:normal|bold|bolder|[1-9]00)$/.test(val);
    if (property === "font-style") return /^(?:normal|italic|oblique)$/.test(val);
    return false;
  });
}

/** Reject active features before layout and return the canonical source to parse/render. */
export function validateMermaidSource(text: string) {
  if (!text.trim()) throw new MermaidPreviewError("empty");
  if (text.length > MERMAID_MAX_TEXT) throw new MermaidPreviewError("tooLarge");
  // Match Mermaid 11's cleanupText before checking statement/config boundaries.
  // Its other cleanupText step rewrites HTML attributes; HTML is forbidden below.
  // Do not strip frontmatter/directives/comments here: validate before Mermaid's
  // preprocessDiagram can consume configuration or remove statement boundaries.
  text = text.replace(/\r\n?/g, "\n");
  if (text.split(/[;\n]/).length > 500) throw new MermaidPreviewError("tooLarge");
  const decoded = decodeEntities(text);
  if (/%%\s*\{|(?:^|\n)\s*---\s*(?:\n|$)/.test(decoded) ||
      /<\s*\/?\s*[a-z!]|!\s*\[|::icon\s*\(|\$\$/i.test(decoded) ||
      /(?:url\s*\(|@import|expression\s*\(|javascript\s*:|vbscript\s*:)/i.test(decoded.replace(/\/\*[\s\S]*?\*\//g, ""))) throw new MermaidPreviewError("unsafe");
  // Mermaid's style statements are CSS, so accept only a small useful declaration subset.
  for (const statement of decoded.split(/[;\n]/)) {
    const style = /^\s*(classDef|style|linkStyle)\s+(\S+)\s+(.+)$/i.exec(statement);
    if (style) {
      const selector = style[1].toLowerCase() === "linkstyle"
        ? /^(?:default|\d+(?:,\d+)*)$/.test(style[2])
        : /^[\p{L}\p{N}_-]+(?:,[\p{L}\p{N}_-]+)*$/u.test(style[2]);
      if (!selector || !safeDeclarations(style[3])) throw new MermaidPreviewError("unsafe");
    }
  }
  return text;
}

let loading: Promise<Mermaid> | undefined;
export function loadMermaid(): Promise<Mermaid> {
  loading ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false, securityLevel: "strict", htmlLabels: false,
      suppressErrorRendering: true, maxTextSize: MERMAID_MAX_TEXT, maxEdges: MERMAID_MAX_EDGES,
      flowchart: { htmlLabels: false },
      secure: ["secure", "securityLevel", "startOnLoad", "htmlLabels", "maxTextSize", "maxEdges", "suppressErrorRendering", "themeCSS", "fontFamily"],
    });
    return mermaid;
  }).catch(() => { loading = undefined; throw new MermaidPreviewError("loadFailed"); });
  return loading;
}

type ParsedNode = { img?: unknown; icon?: unknown; type?: unknown; shape?: unknown; text?: unknown; label?: unknown };
type ParsedDiagram = Awaited<ReturnType<Mermaid["mermaidAPI"]["getDiagramFromText"]>>;

function validateNode(node: ParsedNode) {
  // Inspect decoded YAML fields, not source keywords: quoted/escaped keys and braces
  // inside labels must not hide image/icon capabilities from the pre-layout guard.
  if (node.img || node.icon || /^(?:image|icon)/i.test(String(node.type ?? node.shape ?? ""))) {
    throw new MermaidPreviewError("unsafe");
  }
  for (const label of [node.text, node.label]) {
    if (typeof label === "string" && label.trim()) validateMermaidSource(label);
  }
}

function validateBudget(nodes: number, edges: number) {
  // Fail closed if a Mermaid DB adapter no longer returns its expected counts.
  if (!Number.isSafeInteger(nodes) || nodes < 0 || !Number.isSafeInteger(edges) || edges < 0) {
    throw new MermaidPreviewError("unsupported");
  }
  if (nodes > MERMAID_MAX_NODES || edges > MERMAID_MAX_EDGES) throw new MermaidPreviewError("tooLarge");
}

function validateParsedDiagram(diagram: ParsedDiagram) {
  // Mermaid 11's public Diagram exposes diagram-specific DB methods. Keep this
  // small adapter next to the loader and exercise it against the real parsers.
  if (["flowchart", "flowchart-v2", "flowchart-elk"].includes(diagram.type)) {
    const db = diagram.db as typeof diagram.db & {
      getVertices(): Map<string, ParsedNode>;
      getEdges(): unknown[];
      getSubGraphs(): Array<{ id: string }>;
    };
    const vertices = db.getVertices();
    const nodeIds = new Set([...vertices.keys(), ...db.getSubGraphs().map((group) => group.id)]);
    validateBudget(nodeIds.size, db.getEdges().length);
    for (const node of vertices.values()) validateNode(node);
  } else if (["kanban", "class", "classDiagram", "state", "stateDiagram", "er"].includes(diagram.type)) {
    // getData is the renderer's own flattened graph, including nested groups,
    // notes, synthetic state endpoints and note-connector edges. StateDB builds
    // it in setRootDoc during parsing; counting only getStates misses children.
    const db = diagram.db as typeof diagram.db & { getData(): { nodes: ParsedNode[]; edges: unknown[] } };
    const { nodes, edges } = db.getData();
    validateBudget(nodes.length, edges.length);
    for (const node of nodes) validateNode(node);
  } else if (diagram.type === "sequence") {
    const db = diagram.db as typeof diagram.db & {
      getActors(): Map<string, { properties?: { icon?: unknown } }>;
      getMessages(): unknown[];
    };
    const actors = db.getActors();
    validateBudget(actors.size, db.getMessages().length);
    for (const actor of actors.values()) {
      if (actor.properties?.icon) throw new MermaidPreviewError("unsafe");
    }
  } else if (diagram.type === "pie") {
    const db = diagram.db as typeof diagram.db & { getSections(): Map<string, number> };
    validateBudget(db.getSections().size, 0); // Slices have no layout edges.
  } else if (diagram.type === "gantt") {
    const db = diagram.db as typeof diagram.db & { getTasks(): unknown[]; getSections(): unknown[] };
    // Bars/milestones and section headings are layout items. Date dependencies
    // schedule bars; Mermaid does not draw them as graph edges.
    validateBudget(db.getTasks().length + db.getSections().length, 0);
  } else {
    // In particular architecture's built-in icons need not load externally, but
    // its graph/icon-pack paths have not been audited: do not enter layout.
    throw new MermaidPreviewError("unsupported");
  }
}

let purifier: ReturnType<typeof createDOMPurify> | undefined;
function safeCss(value: string) {
  const css = value.replace(/\/\*[\s\S]*?\*\//g, "");
  if (/[\\@<]|expression\s*\(|behavior\s*:|-moz-binding/i.test(css)) return false;
  // Only local fragment references are needed for SVG markers, filters and clipping.
  return !/url\s*\(/i.test(css.replace(/url\(\s*(["']?)#[a-z_][\w:.-]*\1\s*\)/gi, ""));
}

/** Isolated from both Agent Markdown hooks and the document Markdown sanitizer. */
export function sanitizeMermaidSvg(svg: string, id: string): string {
  purifier ??= createDOMPurify(window);
  const forbiddenTags = ["script", "foreignobject", "image", "feimage", "use", "a", "iframe", "object", "embed", "animate", "animatemotion", "animatetransform", "set"];
  const forbiddenAttributes = ["href", "xlink:href", "src", "srcset"];
  if (/<!DOCTYPE|<!ENTITY/i.test(svg)) throw new MermaidPreviewError("renderFailed");
  // Parse inert XML, not HTML: SVG styles and namespaces must retain their semantics.
  const parsed = new window.DOMParser().parseFromString(svg, "image/svg+xml");
  const root = parsed.documentElement;
  if (root?.localName !== "svg" || root.id !== id || parsed.querySelector("parsererror")) throw new MermaidPreviewError("renderFailed");
  purifier.sanitize(root, {
    USE_PROFILES: { svg: true, svgFilters: true }, IN_PLACE: true,
    FORBID_TAGS: forbiddenTags,
    FORBID_ATTR: forbiddenAttributes,
  });
  for (const node of Array.from(root.querySelectorAll("*"))) {
    if (forbiddenTags.includes(node.localName.toLowerCase())) { node.remove(); continue; }
    for (const attribute of Array.from(node.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on") || forbiddenAttributes.includes(name) || !safeCss(attribute.value)) node.removeAttribute(attribute.name);
    }
  }
  for (const attribute of Array.from(root.attributes)) {
    const name = attribute.name.toLowerCase();
    if (name.startsWith("on") || forbiddenAttributes.includes(name) || !safeCss(attribute.value)) root.removeAttribute(attribute.name);
  }
  for (const style of Array.from(root.querySelectorAll("style"))) {
    // Static preview does not need animation keyframes. Remove them rather than
    // discarding Mermaid's entire stylesheet (which also contains node/label styling).
    const css = (style.textContent ?? "").replace(/@keyframes\s+[\w-]+\s*\{(?:[^{}]|\{[^{}]*\})*\}/gi, "");
    style.textContent = css;
    const selectors = Array.from(css.matchAll(/(?:^|})\s*([^{}]+)\{/g), (match) => match[1]);
    if (!safeCss(css) || !selectors.length || selectors.some((selector) => selector.split(",").some((part) => !part.trim().startsWith(`#${id} `) && !part.trim().startsWith(`#${id}:`) && part.trim() !== `#${id}`))) style.remove();
  }
  return root.outerHTML;
}

let renderId = 0;
let renderQueue: Promise<unknown> = Promise.resolve();
/** Own and always remove Mermaid's layout DOM, including any parse-error leftovers. */
export async function renderMermaidPreview(text: string, signal?: AbortSignal): Promise<string> {
  text = validateMermaidSource(text);
  const mermaid = await loadMermaid();
  // The parser DB/config are shared by Mermaid diagrams. Serialize the entire
  // parse/validate/render operation, not just render(), to avoid clearing the DB
  // while another preview is in layout. Rejections must not poison the queue.
  const result = renderQueue.then(() => renderValidatedMermaid(mermaid, text, signal));
  renderQueue = result.catch(() => {});
  return result;
}

async function renderValidatedMermaid(mermaid: Mermaid, text: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new MermaidPreviewError("renderFailed");
  try {
    // Parse only: no layout DOM and no Image/src or icon loading before validation.
    validateParsedDiagram(await mermaid.mermaidAPI.getDiagramFromText(text));
  } catch (error) {
    if (error instanceof MermaidPreviewError) throw error;
    if (error instanceof Error && error.name === "UnknownDiagramError") throw new MermaidPreviewError("unsupported");
    // Keep Mermaid's parser-side cap: group edges expand as a Cartesian product,
    // and materializing every edge just to count them would itself be unbounded.
    if (error instanceof Error && error.message.startsWith("Edge limit exceeded")) throw new MermaidPreviewError("tooLarge");
    throw new MermaidPreviewError("renderFailed");
  }
  if (signal?.aborted) throw new MermaidPreviewError("renderFailed");
  const id = `editor-mermaid-${++renderId}`;
  const container = document.createElement("div");
  container.dataset.editorMermaidLayout = id;
  container.style.cssText = "position:absolute;left:-100000px;top:0;visibility:hidden;pointer-events:none";
  const cleanup = () => container.remove();
  signal?.addEventListener("abort", cleanup, { once: true });
  document.body.appendChild(container);
  try {
    const result = await mermaid.render(id, text, container);
    if (signal?.aborted) throw new MermaidPreviewError("renderFailed");
    return sanitizeMermaidSvg(result.svg, id);
  } catch (error) {
    if (error instanceof MermaidPreviewError) throw error;
    throw new MermaidPreviewError("renderFailed");
  } finally { signal?.removeEventListener("abort", cleanup); cleanup(); }
}
