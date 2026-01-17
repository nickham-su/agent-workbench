export const SUPPORTED_LOCALES = ["zh-CN", "en-US"] as const;
export type AppLocale = (typeof SUPPORTED_LOCALES)[number];

const LOCALE_STORAGE_KEY = "agent-workbench.locale";

export function normalizeLocale(input: unknown): AppLocale | null {
  const s = String(input || "").trim();
  if (s === "zh-CN") return "zh-CN";
  if (s === "en-US") return "en-US";
  return null;
}

function pickFromLanguageTag(tagRaw: unknown): AppLocale | null {
  const tag = String(tagRaw || "").trim().toLowerCase();
  if (!tag) return null;
  if (tag === "zh-cn" || tag.startsWith("zh")) return "zh-CN";
  if (tag === "en-us" || tag.startsWith("en")) return "en-US";
  return null;
}

export function getStoredLocale(): AppLocale | null {
  try {
    return normalizeLocale(localStorage.getItem(LOCALE_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function setStoredLocale(locale: AppLocale) {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // ignore
  }
}

export function getBrowserLocale(): AppLocale | null {
  if (typeof navigator === "undefined") return null;
  const langs = Array.isArray((navigator as any).languages) ? (navigator as any).languages : [];
  for (const tag of langs) {
    const pick = pickFromLanguageTag(tag);
    if (pick) return pick;
  }
  return pickFromLanguageTag((navigator as any).language);
}

export function getInitialLocale(): AppLocale {
  return getStoredLocale() ?? getBrowserLocale() ?? "zh-CN";
}
