export function extractGitHost(rawUrl: string): string | null {
  const s = String(rawUrl || "").trim();
  if (!s) return null;

  try {
    if (s.includes("://")) {
      const u = new URL(s);
      return u.hostname ? u.hostname.toLowerCase() : null;
    }
  } catch {
    // ignore
  }

  // scp-like: git@github.com:org/repo
  const m = s.match(/^[^@]+@([^:]+):/);
  if (m?.[1]) return m[1].toLowerCase();

  // ssh://git@host/...
  try {
    if (s.toLowerCase().startsWith("ssh://")) {
      const u = new URL(s);
      return u.hostname ? u.hostname.toLowerCase() : null;
    }
  } catch {
    // ignore
  }

  return null;
}

export function inferGitCredentialKindFromUrl(rawUrl: string): "https" | "ssh" | null {
  const s = String(rawUrl || "").trim();
  if (!s) return null;

  const lower = s.toLowerCase();
  if (lower.startsWith("http://") || lower.startsWith("https://")) return "https";
  if (lower.startsWith("ssh://")) return "ssh";
  // scp-like: git@github.com:org/repo
  if (/^[^@]+@[^:]+:/.test(s)) return "ssh";
  return null;
}
