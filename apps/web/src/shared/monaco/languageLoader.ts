// 按需加载 Monaco 语言高亮(contribution),避免把所有语言一次性打进首包
// 注意: 这里只提供语法高亮(tokenization),不包含语言服务(诊断/补全/跳转等)

const loaded = new Set<string>();
const inflight = new Map<string, Promise<void>>();

// Vite 需要静态可分析的 import 路径,用映射表方便分 chunk
const loaders: Record<string, () => Promise<unknown>> = {
  // 这里只需要语法高亮(tokenization),不要引入语言服务(诊断/补全/跳转等)
  javascript: () => import("monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js"),
  typescript: () => import("monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js"),
  json: () => import("monaco-editor/esm/vs/language/json/monaco.contribution.js"),
  css: () => import("monaco-editor/esm/vs/basic-languages/css/css.contribution.js"),
  html: () => import("monaco-editor/esm/vs/basic-languages/html/html.contribution.js"),
  vue: () => import("./languages/vue.js").then((mod) => mod.registerVueLanguage()),

  // basic-languages
  markdown: () => import("monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js"),
  yaml: () => import("monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js"),
  sql: () => import("monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js"),
  python: () => import("monaco-editor/esm/vs/basic-languages/python/python.contribution.js"),
  java: () => import("monaco-editor/esm/vs/basic-languages/java/java.contribution.js"),
  csharp: () => import("monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution.js"),
  cpp: () => import("monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution.js"),
  go: () => import("monaco-editor/esm/vs/basic-languages/go/go.contribution.js"),
  rust: () => import("monaco-editor/esm/vs/basic-languages/rust/rust.contribution.js"),
  php: () => import("monaco-editor/esm/vs/basic-languages/php/php.contribution.js"),
  ruby: () => import("monaco-editor/esm/vs/basic-languages/ruby/ruby.contribution.js"),
  kotlin: () => import("monaco-editor/esm/vs/basic-languages/kotlin/kotlin.contribution.js"),
  shell: () => import("monaco-editor/esm/vs/basic-languages/shell/shell.contribution.js"),
  powershell: () => import("monaco-editor/esm/vs/basic-languages/powershell/powershell.contribution.js"),
  dockerfile: () => import("monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution.js"),
  xml: () => import("monaco-editor/esm/vs/basic-languages/xml/xml.contribution.js"),
  swift: () => import("monaco-editor/esm/vs/basic-languages/swift/swift.contribution.js")
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
