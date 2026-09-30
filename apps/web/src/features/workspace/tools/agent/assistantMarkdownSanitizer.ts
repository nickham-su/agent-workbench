import DOMPurify from "dompurify";
import type { Config as DOMPurifyConfig } from "dompurify";

const MARKDOWN_SANITIZE_CONFIG: DOMPurifyConfig = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ["img", "script", "style", "iframe", "object", "embed", "form", "input", "textarea", "select", "option", "meta", "link"],
  FORBID_ATTR: ["style"],
};

function isSafeHref(raw: string) {
  const value = String(raw || "").trim();
  if (!value) return false;
  if (value.startsWith("#")) return true;
  if (value.startsWith("/") || value.startsWith("./") || value.startsWith("../")) return true;
  try {
    const url = new URL(value, "https://awb.local");
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:";
  } catch {
    return false;
  }
}

// DOMPurify 是共享实例；不能在每条 Markdown 消息的组件 setup 中注册 hook。
let hookInstalled = false;

function ensurePurifyHook() {
  if (hookInstalled) return;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    for (const attr of Array.from(node.attributes || [])) {
      if (attr.name.toLowerCase().startsWith("on")) {
        node.removeAttribute(attr.name);
      }
    }

    const tagName = node.tagName?.toLowerCase?.() || "";
    if (tagName === "img") {
      node.remove();
      return;
    }

    if (tagName === "a") {
      const href = node.getAttribute("href") || "";
      if (!isSafeHref(href)) {
        node.removeAttribute("href");
      } else {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
      }
    }

    if (node.hasAttribute("xlink:href")) {
      node.removeAttribute("xlink:href");
    }
  });
  hookInstalled = true;
}

export function sanitizeAgentMarkdown(html: string): string {
  ensurePurifyHook();
  const sanitized = DOMPurify.sanitize(html, MARKDOWN_SANITIZE_CONFIG);
  return typeof sanitized === "string" ? sanitized : String(sanitized);
}
