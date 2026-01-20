function baseName(filePath: string) {
  const parts = filePath.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1]! : filePath;
}

export function normalizeMonacoLanguage(lang?: string | null) {
  const normalized = (lang ?? "").trim().toLowerCase();
  if (!normalized || normalized === "plaintext") return undefined;
  if (normalized === "c") return "cpp";
  return normalized;
}

export function inferLanguageFromPath(filePath: string) {
  const base = baseName(filePath);
  if (base === "Dockerfile") return "dockerfile";
  if (base.startsWith("Dockerfile.")) return "dockerfile";

  const dotIdx = filePath.lastIndexOf(".");
  const ext = dotIdx >= 0 ? filePath.slice(dotIdx).toLowerCase() : "";
  switch (ext) {
    case ".ts":
    case ".tsx":
      return "typescript";
    case ".js":
    case ".jsx":
      return "javascript";
    case ".vue":
      return "vue";
    case ".py":
      return "python";
    case ".java":
      return "java";
    case ".go":
      return "go";
    case ".rs":
      return "rust";
    case ".php":
      return "php";
    case ".rb":
      return "ruby";
    case ".kt":
    case ".kts":
      return "kotlin";
    case ".cs":
      return "csharp";
    case ".c":
    case ".h":
      return "cpp";
    case ".cc":
    case ".cpp":
    case ".cxx":
    case ".hh":
    case ".hpp":
    case ".hxx":
      return "cpp";
    case ".json":
    case ".jsonc":
      return "json";
    case ".md":
      return "markdown";
    case ".css":
    case ".scss":
    case ".less":
      return "css";
    case ".html":
    case ".htm":
      return "html";
    case ".yml":
    case ".yaml":
      return "yaml";
    case ".sql":
      return "sql";
    case ".sh":
    case ".bash":
      return "shell";
    case ".ps1":
      return "powershell";
    case ".xml":
      return "xml";
    case ".swift":
      return "swift";
    default:
      return undefined;
  }
}
