import createDOMPurify from "dompurify";
import MarkdownIt from "markdown-it";

export type MarkdownTarget =
  | { kind: "file"; path: string; fragment?: string }
  | { kind: "anchor"; fragment: string }
  | { kind: "external"; href: string }
  | { kind: "invalid" };

/** Resolve only workspace-relative paths. Backend realpath checks remain authoritative. */
export function resolveMarkdownTarget(documentPath: string, raw: string): MarkdownTarget {
  const href = raw.trim();
  if (!href || /[\u0000-\u0020\u007f\\]/.test(href)) return { kind: "invalid" };
  if (/^(https?:|mailto:)/i.test(href)) {
    try {
      const url = new URL(href);
      if ((url.protocol === "http:" || url.protocol === "https:") && !url.hostname) return { kind: "invalid" };
      return { kind: "external", href: url.href };
    } catch { return { kind: "invalid" }; }
  }
  if (href.startsWith("/") || /^[a-z][a-z\d+.-]*:/i.test(href) || href.includes("?")) return { kind: "invalid" };
  const hash = href.indexOf("#");
  let path: string;
  let fragment: string | undefined;
  try {
    path = decodeURIComponent(hash < 0 ? href : href.slice(0, hash));
    fragment = hash < 0 ? undefined : decodeURIComponent(href.slice(hash + 1));
  } catch { return { kind: "invalid" }; }
  // Reject double encoding and decoded separators/protocols rather than handing ambiguity to another layer.
  if (/[\u0000-\u001f\u007f\\%?#]/.test(path) || path.startsWith("/") || /^[a-z][a-z\d+.-]*:/i.test(path)) return { kind: "invalid" };
  if (fragment !== undefined && /[\u0000-\u001f\u007f]/.test(fragment)) return { kind: "invalid" };
  if (!path) return fragment ? { kind: "anchor", fragment } : { kind: "invalid" };
  const segments = documentPath.split("/").slice(0, -1);
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\\"))) return { kind: "invalid" };
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!segments.length) return { kind: "invalid" };
      segments.pop();
    } else segments.push(segment);
  }
  if (!segments.length) return { kind: "invalid" };
  return { kind: "file", path: segments.join("/"), ...(fragment ? { fragment } : {}) };
}

export type MarkdownImage = { id: string; target: MarkdownTarget };
export type RenderedEditorMarkdown = { html: string; images: MarkdownImage[]; links: MarkdownTarget[] };

/** Keep user-facing fragments unchanged while avoiding reserved DOM names in actual IDs. */
export function editorMarkdownHeadingId(fragment: string): string {
  return `editor-md-heading-${fragment}`;
}

// Factory-created instance is intentionally isolated from the Agent message sanitizer's hooks.
let purifier: ReturnType<typeof createDOMPurify> | undefined;
function sanitize(html: string) {
  purifier ??= createDOMPurify(window);
  return purifier.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "input", "textarea", "select", "meta", "link", "svg", "math"],
    FORBID_ATTR: ["style", "src", "srcset", "onerror", "onclick"],
    ADD_ATTR: ["target"],
    ALLOW_DATA_ATTR: true
  });
}

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false });
type RenderEnvironment = { documentPath: string; images: MarkdownImage[]; links: MarkdownTarget[]; headings: Set<string> };
const escape = (value: string) => markdown.utils.escapeHtml(value);

markdown.renderer.rules.image = (tokens, index, _options, env: RenderEnvironment) => {
  const token = tokens[index];
  const id = String(env.images.length);
  const target = resolveMarkdownTarget(env.documentPath, token.attrGet("src") ?? "");
  env.images.push({ id, target });
  const alt = escape(markdown.renderer.renderInlineAsText(token.children ?? [], markdown.options, env));
  // Never place the source URL in src/srcset, even temporarily, so parsing cannot issue requests.
  return `<span class="editor-markdown-image"><img data-md-image="${id}" alt="${alt}"><span data-md-image-status="${id}" role="status">${alt}</span></span>`;
};
markdown.renderer.rules.link_open = (tokens, index, _options, env: RenderEnvironment) => {
  const target = resolveMarkdownTarget(env.documentPath, tokens[index].attrGet("href") ?? "");
  const id = String(env.links.length);
  env.links.push(target);
  const attrs = target.kind === "external" ? ` href="${escape(target.href)}" target="_blank" rel="noopener noreferrer"` : " href=\"#\"";
  return `<a data-md-link="${id}"${attrs}>`;
};
markdown.renderer.rules.heading_open = (tokens, index, options, env: RenderEnvironment, renderer) => {
  const inline = tokens[index + 1];
  const text = inline?.children?.map((token) => token.content).join("") ?? "";
  const base = text.toLowerCase().trim().replace(/[^\p{L}\p{N}\p{M}_\s-]/gu, "").replace(/\s+/g, "-") || "section";
  let id = base;
  let count = 0;
  while (env.headings.has(id)) id = `${base}-${++count}`;
  env.headings.add(id);
  tokens[index].attrSet("id", editorMarkdownHeadingId(id));
  return renderer.renderToken(tokens, index, options);
};

export function renderEditorMarkdown(text: string, documentPath: string): RenderedEditorMarkdown {
  const env: RenderEnvironment = { documentPath, images: [], links: [], headings: new Set() };
  return { html: sanitize(markdown.render(text, env)), images: env.images, links: env.links };
}
