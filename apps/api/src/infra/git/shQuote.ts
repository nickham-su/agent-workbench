export function shQuote(raw: string) {
  const s = String(raw ?? "");
  // POSIX shell single-quote escaping: close, escape, reopen
  return `'${s.replace(/'/g, `'\"'\"'`)}'`;
}

