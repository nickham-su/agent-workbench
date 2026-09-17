export type TodoDisplay = {
  goal?: string;
  todos: Array<{
    content: string;
    status: "pending" | "in_progress" | "completed" | "cancelled";
  }>;
  summary: {
    total: number;
    pending: number;
    inProgress: number;
    completed: number;
    cancelled: number;
  };
};

export type ApplyPatchDisplay = {
  summary: { fileCount: number; additions: number; deletions: number };
  files: Array<{
    type: "add" | "update" | "delete" | "move";
    path: string;
    fromPath?: string;
    additions: number;
    deletions: number;
  }>;
  omittedFiles: number;
};

export type WriteDisplay = {
  summary: string;
  filePath: string;
  bytesWritten: number;
  existedBefore: boolean;
};

export type SubtaskDisplay = {
  description: string | null;
  agent: string | null;
  mode: string | null;
  resultText: string | null;
  subtaskSessionId: string | null;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonNegativeInt(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

export function formatToolInput(value: unknown) {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return String(value);
  }
}

/** Detail 的 structuredResult 是唯一富卡数据来源；绝不解析 timeline preview。 */
export function parseTodoDisplay(value: unknown): TodoDisplay | null {
  const source = record(value);
  if (!source) return null;
  const todos = (Array.isArray(source.todos) ? source.todos : []).flatMap(
    (item) => {
      const todo = record(item);
      const content = String(todo?.content ?? "").trim();
      const status = todo?.status;
      return content &&
        (status === "pending" ||
          status === "in_progress" ||
          status === "completed" ||
          status === "cancelled")
        ? [
            {
              content,
              status: status as TodoDisplay["todos"][number]["status"],
            },
          ]
        : [];
    },
  );
  const summary = record(source.summary);
  return {
    ...(typeof source.goal === "string" && source.goal.trim()
      ? { goal: source.goal }
      : {}),
    todos,
    summary: {
      total: nonNegativeInt(summary?.total ?? todos.length),
      pending: nonNegativeInt(
        summary?.pending ??
          todos.filter((todo) => todo.status === "pending").length,
      ),
      inProgress: nonNegativeInt(
        summary?.inProgress ??
          todos.filter((todo) => todo.status === "in_progress").length,
      ),
      completed: nonNegativeInt(
        summary?.completed ??
          todos.filter((todo) => todo.status === "completed").length,
      ),
      cancelled: nonNegativeInt(
        summary?.cancelled ??
          todos.filter((todo) => todo.status === "cancelled").length,
      ),
    },
  };
}

export function parseApplyPatchDisplay(
  value: unknown,
): ApplyPatchDisplay | null {
  const source = record(value);
  if (!source) return null;
  const files = (Array.isArray(source.files) ? source.files : []).flatMap(
    (item) => {
      const file = record(item);
      const path = String(
        file?.path ?? file?.relativePath ?? file?.filePath ?? "",
      ).trim();
      if (!path) return [];
      const type: ApplyPatchDisplay["files"][number]["type"] =
        file?.type === "add" || file?.type === "delete" || file?.type === "move"
          ? file.type
          : "update";
      const fromPath = String(
        file?.fromPath ?? file?.moveFromPath ?? "",
      ).trim();
      return [
        {
          type,
          path,
          ...(fromPath ? { fromPath } : {}),
          additions: nonNegativeInt(file?.additions),
          deletions: nonNegativeInt(file?.deletions),
        },
      ];
    },
  );
  const summary = record(source.summary);
  const fileCount = nonNegativeInt(summary?.fileCount ?? files.length);
  return {
    summary: {
      fileCount,
      additions: nonNegativeInt(
        summary?.additions ??
          files.reduce((total, file) => total + file.additions, 0),
      ),
      deletions: nonNegativeInt(
        summary?.deletions ??
          files.reduce((total, file) => total + file.deletions, 0),
      ),
    },
    files,
    omittedFiles: Math.max(0, fileCount - files.length),
  };
}

export function parseWriteDisplay(value: unknown): WriteDisplay | null {
  const source = record(value);
  if (!source) return null;
  const filePath = String(source.filePath ?? source.path ?? "").trim();
  if (!filePath) return null;
  const summary = record(source.summary);
  return {
    summary:
      typeof source.summary === "string" && source.summary.trim()
        ? source.summary
        : `write ${filePath}`,
    filePath,
    bytesWritten: nonNegativeInt(
      summary?.bytesWritten ?? source.bytesWritten ?? source.bytes,
    ),
    existedBefore:
      summary?.existedBefore === true || source.existedBefore === true,
  };
}

export function parseScratchpadContent(value: unknown): string | null {
  const source = record(value);
  if (!source) return null;
  const content =
    typeof source.content === "string"
      ? source.content
      : typeof source.text === "string"
        ? source.text
        : "";
  return content.trim() ? content : null;
}

/** input 只提供请求描述；详情 structuredResult 才能提供 result/session 等执行结果。 */
export function parseSubtaskDisplay(
  input: unknown,
  structuredResult: unknown,
): SubtaskDisplay {
  const request = record(input);
  const result = record(structuredResult);
  const value = (source: Record<string, unknown> | null, key: string) => {
    const text = typeof source?.[key] === "string" ? source[key].trim() : "";
    return text || null;
  };
  const session = record(request?.session);
  return {
    description: value(request, "description"),
    agent: value(request, "agent") ?? value(request, "agentId"),
    // 当前 subtask 请求把模式放在 session；顶层字段只服务于早期兼容数据。
    mode: value(session, "mode") ?? value(request, "mode"),
    resultText: value(result, "resultText"),
    // 绝不从 preview 或其他文本猜测会话 ID。
    subtaskSessionId: value(result, "subtaskSessionId"),
  };
}

/** @deprecated 新 Conversation 卡片请使用 parseSubtaskDisplay。 */
export function parseSubtaskSessionId(value: unknown): string | null {
  return parseSubtaskDisplay({}, value).subtaskSessionId;
}
