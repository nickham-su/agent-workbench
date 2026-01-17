export function normalizeRepoUrl(raw: string) {
  let s = raw.trim();
  if (!s) return "";
  while (s.endsWith("/")) s = s.slice(0, -1);
  if (s.toLowerCase().endsWith(".git")) s = s.slice(0, -4);
  return s;
}

