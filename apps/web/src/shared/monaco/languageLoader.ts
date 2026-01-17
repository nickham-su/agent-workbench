// 按需加载 Monaco 语言高亮(contribution),避免把所有语言一次性打进首包
// 注意: 这里只提供语法高亮(tokenization),不包含语言服务(诊断/补全/跳转等)

const loaded = new Set<string>();
const inflight = new Map<string, Promise<void>>();

// Vite 需要静态可分析的 import 路径,用映射表方便分 chunk
const loaders: Record<string, () => Promise<unknown>> = {
  // Monaco 自带语言包
  javascript: () => import("monaco-editor/esm/vs/language/typescript/monaco.contribution"),
  typescript: () => import("monaco-editor/esm/vs/language/typescript/monaco.contribution"),
  json: () => import("monaco-editor/esm/vs/language/json/monaco.contribution"),
  css: () => import("monaco-editor/esm/vs/language/css/monaco.contribution"),
  html: () => import("monaco-editor/esm/vs/language/html/monaco.contribution"),

  // basic-languages
  markdown: () => import("monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution"),
  yaml: () => import("monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution"),
  sql: () => import("monaco-editor/esm/vs/basic-languages/sql/sql.contribution"),
  python: () => import("monaco-editor/esm/vs/basic-languages/python/python.contribution"),
  java: () => import("monaco-editor/esm/vs/basic-languages/java/java.contribution"),
  csharp: () => import("monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution"),
  cpp: () => import("monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution"),
  go: () => import("monaco-editor/esm/vs/basic-languages/go/go.contribution"),
  rust: () => import("monaco-editor/esm/vs/basic-languages/rust/rust.contribution"),
  php: () => import("monaco-editor/esm/vs/basic-languages/php/php.contribution"),
  ruby: () => import("monaco-editor/esm/vs/basic-languages/ruby/ruby.contribution"),
  kotlin: () => import("monaco-editor/esm/vs/basic-languages/kotlin/kotlin.contribution"),
  shell: () => import("monaco-editor/esm/vs/basic-languages/shell/shell.contribution"),
  powershell: () => import("monaco-editor/esm/vs/basic-languages/powershell/powershell.contribution"),
  dockerfile: () => import("monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution"),
  xml: () => import("monaco-editor/esm/vs/basic-languages/xml/xml.contribution"),
  swift: () => import("monaco-editor/esm/vs/basic-languages/swift/swift.contribution")
};

export async function ensureMonacoLanguage(languageId?: string | null) {
  const lang = (languageId ?? "").trim().toLowerCase();
  if (!lang || lang === "plaintext") return;
  if (loaded.has(lang)) return;

  const existing = inflight.get(lang);
  if (existing) return existing;

  const loader = loaders[lang];
  if (!loader) return;

  const p = (async () => {
    try {
      await loader();
      loaded.add(lang);
    } finally {
      inflight.delete(lang);
    }
  })();

  inflight.set(lang, p);
  return p;
}
