import type { FastifyBaseLogger } from "fastify";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { TextDecoder } from "node:util";
import type {
  AgentCancelSessionRequest,
  AgentContextItemRecord,
  AgentContextItemStatus,
  AgentContextItemsResponse,
  AgentControlResult,
  AgentForkSessionRequest,
  AgentPermissionDecision,
  AgentClearSessionRequest,
  AgentCompactSessionRequest,
  AgentCompactSessionResponse,
  AgentRevertSessionRequest,
  AgentRunStatus,
  AgentSendMessageRequest,
  AgentSendMessageResponse,
  AgentSessionRecord,
  AgentSessionRunState,
  AgentContextToolName,
  AgentToolPermissionRequest
} from "@agent-workbench/shared";
import { HttpError } from "../../app/errors.js";
import type { AppContext } from "../../app/context.js";
import { nowMs } from "../../utils/time.js";
import { newSortableId } from "../../utils/ids.js";
import { getWorkspace } from "../workspaces/workspace.store.js";
import {
  agentArchiveSessionDir,
  applyPatchUiArtifactPath,
  compactionSnippetPath,
  tmpRoot,
  writeUiArtifactPath
} from "../../infra/fs/paths.js";
import {
  AgentConflictError,
  appendContextItem,
  createAgentSession,
  createRunRecord,
  findClientRequestDedup,
  getAgentSession,
  getContextItemById,
  getLatestSessionItemId,
  getRunRecord,
  getRunState,
  getSessionHead,
  getSessionTranscriptBeforeWindow,
  getSessionTranscriptItems,
  getSessionTranscriptItemsAfterIdWindow,
  getSessionTranscriptTailWindow,
  getTranscriptItemById,
  getSessionVisibleItems,
  insertClientRequestDedup,
  listAgentSessions,
  listNonTerminalVisibleItemIds,
  moveSessionHead,
  setContextItemsArchiveAt,
  setRunStateIdle,
  updateContextItem,
  updateRunRecordStatus,
  updateAgentSessionTitle,
  updateRunState,
  appendSystemSummaryAndArchiveItems
} from "./agent.store.js";
import {
  getAgentGlobalPromptSettings,
  getAgentMcpSettings,
  getAgentRuntimeSettings,
  getAgentSettings,
  resolveGlobalDefaultModelProfile,
  resolveExecutionProfile
} from "../settings/settings.service.js";
import { projectToolCallInputForPrompt } from "./prompt/tool-projectors/index.js";

export type AgentQueuedRun = {
  workspaceId: string;
  sessionId: string;
  runId: string;
};

function conflictToHttpError(err: AgentConflictError): HttpError {
  return new HttpError(409, "session head conflict", `conflict_head:${String(err.currentHeadItemId ?? "null")}`);
}

function toolArgsSchema(toolName: AgentContextToolName) {
  if (toolName === "bash") {
    return {
      type: "object",
      required: ["command"],
      additionalProperties: false,
      properties: {
        command: { type: "string", minLength: 1 },
        workdir: { type: "string", minLength: 1 },
        timeout: {
          type: "integer",
          minimum: 1,
          default: 120,
          description: "超时秒数(整数),默认 120 秒。注意: 单位是秒,不是毫秒。"
        }
      }
    };
  }
  if (toolName === "read") {
    return {
      type: "object",
      required: ["filePath"],
      additionalProperties: false,
      properties: {
        filePath: { type: "string", minLength: 1 },
        offset: { type: "number", minimum: 1 },
        limit: { type: "number", minimum: 1 }
      }
    };
  }
  if (toolName === "apply_patch") {
    return {
      type: "object",
      required: ["patchText"],
      additionalProperties: false,
      properties: {
        patchText: { type: "string", minLength: 1 }
      }
    };
  }
  if (toolName === "todolist") {
    return {
      type: "object",
      required: ["todos"],
      additionalProperties: false,
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            required: ["content", "status"],
            additionalProperties: false,
            properties: {
              content: { type: "string", minLength: 1, pattern: "\\S" },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed", "cancelled"]
              }
            }
          }
        }
      }
    };
  }
  if (toolName === "archive_search") {
    return {
      type: "object",
      required: ["query"],
      additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 1 },
        beforePos: { type: "integer", minimum: 2 },
        maxHits: { type: "integer", minimum: 1, maximum: 100 },
        maxChars: { type: "integer", minimum: 1000, maximum: 10000 },
        snippet: { type: "boolean" },
        regex: { type: "boolean" }
      }
    };
  }
  if (toolName === "archive_read") {
    return {
      type: "object",
      required: [],
      additionalProperties: false,
      properties: {
        beforePos: { type: "integer", minimum: 2 },
        lineCount: { type: "integer", minimum: 1, maximum: 200 },
        maxChars: { type: "integer", minimum: 1000, maximum: 10000 }
      }
    };
  }
  if (toolName === "subtask") {
    return {
      type: "object",
      required: ["description", "prompt", "agentId", "session"],
      additionalProperties: false,
      properties: {
        description: {
          type: "string",
          minLength: 1,
          maxLength: 20,
          description: "用20字以内介绍任务目标"
        },
        prompt: {
          type: "string",
          minLength: 1,
          description: "子任务详细指令,建议写清输入范围、约束和期望输出格式"
        },
        agentId: {
          type: "string",
          minLength: 1,
          description: "执行子任务的Agent ID"
        },
        session: {
          description: "子任务会话策略",
          oneOf: [
            {
              type: "object",
              required: ["mode"],
              additionalProperties: false,
              properties: {
                mode: { const: "new" }
              },
              description: "new: 从头开始,或需要独立思考时使用"
            },
            {
              type: "object",
              required: ["mode", "sessionId"],
              additionalProperties: false,
              properties: {
                mode: { const: "existing" },
                sessionId: { type: "string", minLength: 1 }
              },
              description: "existing: 基于既有工作成果继续推进"
            },
            {
              type: "object",
              required: ["mode"],
              additionalProperties: false,
              properties: {
                mode: { const: "fork" }
              },
              description: "fork: 需要完整背景信息,仅靠提示词无法充分表达时使用"
            }
          ]
        }
      }
    };
  }
  return {
    type: "object",
    required: ["filePath", "content"],
    additionalProperties: false,
    properties: {
      filePath: { type: "string", minLength: 1 },
      content: { type: "string" }
    }
  };
}

function buildSubtaskToolDescription(agentItems: Array<{ id: string; name: string; summary: string }>) {
  const header = [
    "将任务放到子会话执行,再把结果带回主会话。",
    "适用场景:",
    "- 控制主会话上下文质量: 高噪声或长过程任务先在子会话处理,仅回传提炼后的有效信息",
    "- 只关注结果、不关注过程: 主会话只保留结论和关键依据",
    "- 复杂任务分治: 仅在复杂或可并行拆分场景使用; 简单任务不建议拆分,否则会增加协调成本",
    "",
    "session.mode 选择建议:",
    "- new: 从头开始,或需要独立思考时使用",
    "  示例: 网络调研可因“从头开始”使用new; 代码审查可因“独立思考”使用new",
    "- fork: 需要完整背景信息,仅靠提示词无法充分表达时使用",
    "- existing: 基于既有工作成果继续推进,避免重复劳动",
    "",
    "结果: 成功后返回 subtaskSessionId 与子任务结果文本。"
  ];

  const normalizedAgents = agentItems
    .map((item) => ({
      id: String(item.id || "").trim(),
      name: String(item.name || "").trim(),
      summary: String(item.summary || "").trim()
    }))
    .filter((item) => item.id.length > 0 && item.name.length > 0);

  if (normalizedAgents.length === 0) {
    return `${header.join("\n")}\n\n可选Agent:\n- 当前无可用Agent`;
  }

  const lines = normalizedAgents.map((item) =>
    item.summary ? `- ${item.id}: ${item.name} - ${item.summary}` : `- ${item.id}: ${item.name}`
  );
  return `${header.join("\n")}\n\n可选Agent:\n${lines.join("\n")}`;
}

function toolDescription(toolName: AgentContextToolName, options?: { subtaskDescription?: string }) {
  if (toolName === "bash") {
    return [
      "执行一个 bash 命令并返回 stdout/stderr。",
      "内部等价于: bash -lc <command>",
      "",
      "参数:",
      "- command: 必填,字符串。直接写要执行的命令,不要传数组,也不要在 command 里再写 bash -lc。",
      "- workdir: 可选,工作目录。强烈建议不填(默认就是工作区根目录)。如需指定,尽量使用相对路径(相对工作区),避免写 /workspace 之类的绝对路径。",
      "- timeout: 可选,超时秒数(整数),默认 120。",
      "  注意: timeout 的单位是秒(不是毫秒),不要传 120000 这类毫秒值。",
      "",
      "建议:",
      "- 尽量在工作区内行动,路径优先使用相对路径。",
      "",
      "示例:",
      "- {\"command\":\"pwd\"}",
      "- {\"command\":\"pwd && ls -la\"}",
      "- {\"command\":\"rg -n \\\"TODO\\\" .\",\"workdir\":\"apps/api\"}"
    ].join("\n");
  }
  if (toolName === "read") {
    return "读取工作区内目录或UTF-8文本文件,支持offset/limit,超长行截断,输出上限50KB,不支持非文本或特殊文件类型。";
  }
  if (toolName === "apply_patch") {
    return "按 apply_patch 协议批量修改文件,优先用于最小改动与多文件联动,输入 patchText 需使用 *** Begin Patch 与 *** End Patch 包裹,支持 Add/Update/Delete/Move。";
  }
  if (toolName === "todolist") {
    return "这是管理任务进度的强制工具,不是可选项。除极其简单且可一步完成的请求外,必须先用此工具给出任务清单,再开始执行。每次调用都提交完整 todos 数组,语义为全量替换,不是增量 patch。todos 从上到下即优先级,先规划再执行。在任务状态发生变化时必须立即更新清单,包括开始(in_progress),完成(completed),取消(cancelled),回退或新增任务。每项必须包含 content 和 status。content trim 后不能为空。status 仅允许 pending | in_progress | completed | cancelled。允许同时存在多个 in_progress。目标是让用户持续看到清晰、可信、实时的进度窗口,并约束执行过程可追踪,避免无计划推进。";
  }
  if (toolName === "archive_search") {
    return (
      "在当前会话归档日志中检索关键词,输出按旧到新排序的纯文本行,每行包含 pos 前缀。" +
      "默认返回整行;传 snippet=true 时返回命中窗口片段。" +
      "可通过 beforePos 继续读取更旧命中。" +
      "提示: 你也可以直接搜索归档元数据字段来过滤,例如 kind/status/tool/item/ts。" +
      "示例(整行,找最近5条用户或assistant消息): {\"query\":\"kind=(user|assistant)\",\"regex\":true,\"maxHits\":5}" +
      "示例(关键词命中多时先限制并可翻页): {\"query\":\"timeout\",\"snippet\":true,\"maxHits\":10,\"maxChars\":3000} 然后用 beforePos=<pos> 翻页。"
    );
  }
  if (toolName === "archive_read") {
    return "读取归档日志中的最近若干行,输出按旧到新排序的纯文本行,每行包含 pos 前缀。可通过 beforePos 限定只读更旧内容。";
  }
  if (toolName === "subtask") return options?.subtaskDescription || "在子会话中执行任务。";
  if (toolName.startsWith("mcp_")) return `调用 MCP 工具 ${toolName}`;
  return "写入工作区内文件并全量覆盖,作为确定性兜底工具,当需要直接重写完整内容或 patch 匹配不稳定时使用。";
}

function stringifyToolResult(raw: unknown) {
  if (typeof raw === "string") return raw;
  try {
    const serialized = JSON.stringify(raw, null, 2);
    if (typeof serialized === "string") return serialized;
    return "";
  } catch {
    return raw == null ? "" : String(raw);
  }
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function toNonNegativeInt(value: unknown) {
  const raw = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(raw) || raw < 0) return 0;
  return Math.floor(raw);
}

type ApplyPatchSlimFile = {
  type: "add" | "update" | "delete" | "move";
  path: string;
  fromPath?: string;
  additions: number;
  deletions: number;
};

type ApplyPatchSlimResult = {
  text: string;
  summary: { fileCount: number; additions: number; deletions: number };
  files: ApplyPatchSlimFile[];
};

type ApplyPatchUiArtifactV1 = {
  schemaVersion: 1;
  toolName: "apply_patch";
  workspaceId: string;
  toolCallId: string;
  createdAt: number;
  summary: { fileCount: number; additions: number; deletions: number };
  files: Array<ApplyPatchSlimFile & { before: string; after: string }>;
};

type WriteSlimResult = {
  summary: string;
  filePath: string;
  bytesWritten: number;
  existedBefore: boolean;
};

type WriteUiArtifactSide = {
  available: boolean;
  text?: string;
  truncated: boolean;
  bytes: number;
  reason?: string;
};

type WriteUiArtifactV1 = {
  schemaVersion: 1;
  toolName: "write";
  workspaceId: string;
  toolCallId: string;
  createdAt: number;
  filePath: string;
  summary: {
    bytesWritten: number;
    existedBefore: boolean;
  };
  before: WriteUiArtifactSide;
  after: WriteUiArtifactSide;
};

const WRITE_ARGS_PREVIEW_MAX_CHARS = 280;

function splitApplyPatchResult(raw: unknown): {
  slim: ApplyPatchSlimResult;
  artifact: Omit<ApplyPatchUiArtifactV1, "workspaceId" | "toolCallId" | "createdAt">;
} {
  const src = toRecord(raw) || {};
  const text = typeof src.text === "string" ? src.text : "";
  const summaryRaw = toRecord(src.summary) || {};
  const filesRaw = Array.isArray(src.files) ? src.files : [];

  const filesSlim: ApplyPatchSlimFile[] = [];
  const filesArtifact: Array<ApplyPatchSlimFile & { before: string; after: string }> = [];

  for (const row of filesRaw) {
    const file = toRecord(row);
    if (!file) continue;
    const typeRaw = String(file.type || "update").trim();
    const type = (typeRaw === "add" || typeRaw === "update" || typeRaw === "delete" || typeRaw === "move")
      ? (typeRaw as ApplyPatchSlimFile["type"])
      : "update";
    const p = String(file.path || file.relativePath || file.filePath || "").trim();
    if (!p) continue;
    const fromPath = String(file.fromPath || file.moveFromPath || "").trim();
    const additions = toNonNegativeInt(file.additions);
    const deletions = toNonNegativeInt(file.deletions);
    const before = typeof file.before === "string" ? file.before : "";
    const after = typeof file.after === "string" ? file.after : "";

    const slim: ApplyPatchSlimFile = {
      type,
      path: p,
      ...(fromPath ? { fromPath } : {}),
      additions,
      deletions
    };
    filesSlim.push(slim);
    filesArtifact.push({ ...slim, before, after });
  }

  const summary = {
    fileCount: toNonNegativeInt(summaryRaw.fileCount ?? filesSlim.length),
    additions: toNonNegativeInt(summaryRaw.additions ?? filesSlim.reduce((sum, f) => sum + f.additions, 0)),
    deletions: toNonNegativeInt(summaryRaw.deletions ?? filesSlim.reduce((sum, f) => sum + f.deletions, 0))
  };

  return {
    slim: {
      text,
      summary,
      files: filesSlim
    },
    artifact: {
      schemaVersion: 1,
      toolName: "apply_patch",
      summary,
      files: filesArtifact
    }
  };
}

function normalizeWriteUiSide(raw: unknown, fallbackReason: string): WriteUiArtifactSide {
  const side = toRecord(raw);
  if (!side) {
    return {
      available: false,
      truncated: false,
      bytes: 0,
      reason: fallbackReason
    };
  }
  const available = side.available === true;
  const text = typeof side.text === "string" ? side.text : "";
  const bytes = toNonNegativeInt(side.bytes ?? Buffer.byteLength(text, "utf8"));
  const truncated = side.truncated === true;
  const reason = typeof side.reason === "string" && side.reason.trim() ? side.reason.trim() : fallbackReason;

  if (!available) {
    return {
      available: false,
      truncated: false,
      bytes,
      reason
    };
  }

  return {
    available: true,
    text,
    truncated,
    bytes
  };
}

function splitWriteResult(raw: unknown): {
  slim: WriteSlimResult;
  artifact: Omit<WriteUiArtifactV1, "workspaceId" | "toolCallId" | "createdAt">;
} {
  const src = toRecord(raw) || {};
  const filePath = String(src.filePath || src.path || "").trim();
  const bytesWritten = toNonNegativeInt(src.bytesWritten ?? src.bytes);
  const existedBefore = src.existedBefore === true;
  const summary = typeof src.summary === "string" && src.summary.trim()
    ? src.summary
    : filePath
      ? `写入文件 ${filePath}`
      : "write completed";
  const before = normalizeWriteUiSide(src.before, "missing_file");
  const after = normalizeWriteUiSide(src.after, "missing_content");

  return {
    slim: {
      summary,
      filePath,
      bytesWritten,
      existedBefore
    },
    artifact: {
      schemaVersion: 1,
      toolName: "write",
      filePath,
      summary: {
        bytesWritten,
        existedBefore
      },
      before,
      after
    }
  };
}

function toWriteSlimArgs(raw: unknown) {
  const src = toRecord(raw) || {};
  const filePath = typeof src.filePath === "string" ? src.filePath : "";
  const content = typeof src.content === "string" ? src.content : "";
  if (!content && !Object.prototype.hasOwnProperty.call(src, "content")) {
    const contentBytes = toNonNegativeInt(src.contentBytes ?? 0);
    const contentPreview = typeof src.contentPreview === "string" ? src.contentPreview : "";
    const contentTruncated = src.contentTruncated === true;
    return {
      ...(filePath ? { filePath } : {}),
      contentBytes,
      ...(contentPreview ? { contentPreview } : {}),
      ...(contentTruncated ? { contentTruncated: true } : {})
    };
  }

  const contentBytes = Buffer.byteLength(content, "utf8");
  const contentPreview = content.slice(0, WRITE_ARGS_PREVIEW_MAX_CHARS);
  const contentTruncated = contentPreview.length < content.length;

  return {
    ...(filePath ? { filePath } : {}),
    contentBytes,
    ...(contentPreview ? { contentPreview } : {}),
    ...(contentTruncated ? { contentTruncated: true } : {})
  };
}

function toTerminalWriteOutput(output: AgentContextItemRecord["output"]) {
  if (!output || output.type !== "tool" || output.toolName !== "write") return output;
  return {
    ...output,
    args: toWriteSlimArgs(output.args)
  };
}

async function ensureRealPathUnderRoot(rootAbs: string, targetAbs: string) {
  const rootReal = await fs.realpath(rootAbs);
  const targetReal = await fs.realpath(targetAbs);
  const withSep = rootReal.endsWith(path.sep) ? rootReal : `${rootReal}${path.sep}`;
  if (targetReal !== rootReal && !targetReal.startsWith(withSep)) {
    throw new HttpError(400, "Invalid path");
  }
}

async function ensureDirSafeUnderRoot(rootAbs: string, dirAbs: string) {
  const rootResolved = path.resolve(rootAbs);
  const dirResolved = path.resolve(dirAbs);
  const rel = path.relative(rootResolved, dirResolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new HttpError(400, "Invalid path");
  }

  let current = rootResolved;
  await fs.mkdir(current, { recursive: true });
  await ensureRealPathUnderRoot(rootResolved, current);

  for (const segment of rel.split(path.sep)) {
    current = path.join(current, segment);
    const st = await fs.lstat(current).catch(() => null);
    if (!st) {
      try {
        await fs.mkdir(current);
      } catch (err: any) {
        if (!err || err.code !== "EEXIST") throw err;
      }
    } else {
      if (st.isSymbolicLink()) throw new HttpError(400, "Invalid path");
      if (!st.isDirectory()) throw new HttpError(409, "Parent is not a directory");
    }
    await ensureRealPathUnderRoot(rootResolved, current);
  }
}

async function writeFileNoFollow(fileAbs: string, content: string) {
  const handle = await fs.open(
    fileAbs,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | (fsConstants.O_NOFOLLOW ?? 0),
    0o644
  );
  try {
    await handle.writeFile(content, { encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

async function readFileNoFollow(fileAbs: string) {
  const handle = await fs.open(fileAbs, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    return await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

function resolveToolOutputText(output: { text?: unknown; result?: unknown }) {
  if (typeof output.text === "string") return output.text;
  return stringifyToolResult(output.result);
}

function toSessionTitleFromFirstMessage(text: string) {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "新会话";
  if (compact.length <= 50) return compact;
  return `${compact.slice(0, 49)}…`;
}

function buildClearSummaryText(reason?: string) {
  const rawReason = typeof reason === "string" ? reason.trim() : "";
  const normalizedReason = rawReason.length > 200 ? `${rawReason.slice(0, 200)}...` : rawReason;
  if (!normalizedReason) {
    return "已开始新任务。之前的上下文已归档,如需回忆历史决策请使用 archive_search 或 archive_read。";
  }
  return `已开始新任务(${normalizedReason})。之前的上下文已归档,如需回忆历史决策请使用 archive_search 或 archive_read。`;
}

const NON_TERMINAL_ITEM_STATUS = new Set<AgentContextItemStatus>([
  "streaming",
  "queued",
  "running",
  "awaiting_permission"
]);

const TERMINAL_TOOL_ITEM_STATUS = new Set<AgentContextItemStatus>([
  "completed",
  "failed",
  "denied",
  "cancelled"
]);
const TERMINAL_RUN_RECORD_STATUS = new Set(["completed", "failed", "cancelled"] as const);

const WORKSPACE_AGENTS_FILENAME = "AGENTS.md";
const WORKSPACE_AGENTS_MAX_BYTES = 32 * 1024;
const ARCHIVE_FILE_NAME_WIDTH = 8;
const ARCHIVE_FILE_LINE_LIMIT = 100;
const ARCHIVE_SEARCH_MAX_HITS_DEFAULT = 10;
const ARCHIVE_SEARCH_MAX_HITS_MAX = 100;
const ARCHIVE_MAX_CHARS_DEFAULT = 8_000;
const ARCHIVE_MAX_CHARS_MIN = 1_000;
const ARCHIVE_MAX_CHARS_MAX = 10_000;
const ARCHIVE_SEARCH_SNIPPET_CTX_CHARS = 40;
const ARCHIVE_SEARCH_SNIPPET_MERGE_GAP_CHARS = 12;
const ARCHIVE_SEARCH_SNIPPET_MAX_WINDOWS_PER_LINE = 5;
const ARCHIVE_SEARCH_SNIPPET_FALLBACK_CHARS = 100;
const ARCHIVE_READ_LINE_COUNT_DEFAULT = 40;
const ARCHIVE_READ_LINE_COUNT_MAX = 200;
const ARCHIVE_FILE_NAME_RE = /^\d{8}\.log$/;
const ARCHIVE_RESULT_TRUNCATED_MARKER = "[超过最大字符数限制,从此处截断内容]";
const ARCHIVABLE_ITEM_STATUS = new Set<AgentContextItemStatus>(["completed", "failed", "denied", "cancelled"]);
const RUN_STATUS_SYSTEM_TEXT_PREFIX = "[run] ";
const COMPACTION_SNIPPET_CACHE_MAX_BYTES = 256 * 1024;

function normalizeRunNoticeText(raw: unknown) {
  if (raw == null) return "";
  const value = String(raw)
    .replace(/\r\n/g, "\n")
    .replace(/\0/g, "")
    .trim();
  if (!value) return "";
  if (value.length <= 1000) return value;
  return `${value.slice(0, 1000)}...`;
}

type ArchiveWriteSnapshot = {
  filePath: string;
  beforeSize: number;
  expectedSize: number;
};

function normalizePositiveInt(raw: unknown, options: { fallback: number; min: number; max: number }) {
  if (raw === undefined || raw === null || raw === "") return options.fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return options.fallback;
  const value = Math.floor(n);
  if (value < options.min) return options.min;
  if (value > options.max) return options.max;
  return value;
}

function sanitizeArchiveText(raw: string) {
  return String(raw || "").replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

function parseArchivedItemIdFromArchiveLine(line: string) {
  const m = /^item=(\d+)\s/.exec(String(line || ""));
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return null;
  return n;
}

function buildCompactionSnippetMessageText(params: {
  excerptLines: string[];
  minPos: number;
}) {
  const body = params.excerptLines.join("\n");
  return [
    "## 压缩前尾部摘录(归档原文; pos 可用于 archive_read 的 beforePos)",
    "",
    body,
    "",
    "## 归档工具提示(需要更多上下文时)",
    "",
    "- 你可以使用 archive_read 继续向前读取更早的归档行:",
    `  - 从更早的位置开始: 使用 beforePos=${params.minPos}`,
    "  - 读取更多行: 增大 lineCount",
    "- 你可以使用 archive_search 在全部归档中按关键词检索:",
    "  - query 建议使用具体名词(文件名/函数名/错误码/工具名/关键短语)",
    "  - 如果命中太多,配合 beforePos 向前翻页"
  ].join("\n");
}

function formatArchiveFileName(seq: number) {
  return `${String(seq).padStart(ARCHIVE_FILE_NAME_WIDTH, "0")}.log`;
}

function parseArchiveFileName(name: string) {
  if (!ARCHIVE_FILE_NAME_RE.test(name)) return null;
  const n = Number(name.slice(0, ARCHIVE_FILE_NAME_WIDTH));
  if (!Number.isFinite(n) || n < 1) return null;
  return n;
}

async function listArchiveFilesAsc(dirPath: string) {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dirPath);
  } catch (err: any) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
  return entries
    .map((name) => ({ name, seq: parseArchiveFileName(name) }))
    .filter((item): item is { name: string; seq: number } => item.seq != null)
    .sort((a, b) => a.seq - b.seq)
    .map((item) => item.name);
}

async function readCompactionSnippetCacheBestEffort(params: {
  dataDir: string;
  workspaceId: string;
  sessionId: string;
  summaryItemId: number;
}) {
  const filePath = compactionSnippetPath(params.dataDir, params.workspaceId, params.sessionId, params.summaryItemId);
  const tmpAbs = path.resolve(tmpRoot(params.dataDir));
  const fileAbs = path.resolve(filePath);
  if (!fileAbs.startsWith(tmpAbs + path.sep) && fileAbs !== tmpAbs) {
    return "";
  }
  const st = await fs.lstat(fileAbs).catch(() => null);
  if (!st || !st.isFile() || st.isSymbolicLink()) {
    return "";
  }
  if (st.size > COMPACTION_SNIPPET_CACHE_MAX_BYTES) {
    return "";
  }
  await ensureRealPathUnderRoot(tmpAbs, fileAbs);
  try {
    return await readFileNoFollow(fileAbs);
  } catch {
    return "";
  }
}

async function writeCompactionSnippetCacheBestEffort(params: {
  dataDir: string;
  workspaceId: string;
  sessionId: string;
  summaryItemId: number;
  text: string;
  logger: FastifyBaseLogger;
}) {
  const filePath = compactionSnippetPath(params.dataDir, params.workspaceId, params.sessionId, params.summaryItemId);
  const tmpAbs = path.resolve(tmpRoot(params.dataDir));
  const fileAbs = path.resolve(filePath);
  if (!fileAbs.startsWith(tmpAbs + path.sep) && fileAbs !== tmpAbs) {
    params.logger.warn({ filePath }, "compaction snippet cache path is outside tmpRoot");
    return;
  }
  const dirAbs = path.dirname(fileAbs);
  try {
    await ensureDirSafeUnderRoot(tmpAbs, dirAbs);
    await ensureRealPathUnderRoot(tmpAbs, dirAbs);
    await writeFileNoFollow(fileAbs, params.text);
  } catch (err) {
    params.logger.warn({ err, filePath }, "failed to write compaction snippet cache");
  }
}

async function buildCompactionSnippetExcerptLines(params: {
  dataDir: string;
  workspaceId: string;
  sessionId: string;
  itemIds: number[];
}) {
  const need = new Set<number>(params.itemIds);
  const resolved = new Map<number, { pos: number; line: string }>();
  if (need.size === 0) {
    return [] as Array<{ pos: number; line: string }>;
  }

  const dirPath = agentArchiveSessionDir(params.dataDir, params.workspaceId, params.sessionId);
  const files = await listArchiveFilesAsc(dirPath);
  if (files.length === 0) {
    return [] as Array<{ pos: number; line: string }>;
  }

  outer: for (let i = files.length - 1; i >= 0; i -= 1) {
    const fileName = files[i] || "";
    if (!fileName) continue;
    const fileSeq = parseArchiveFileName(fileName);
    if (fileSeq == null) continue;
    const filePath = path.join(dirPath, fileName);
    const content = await fs.readFile(filePath, "utf-8").catch((err: any) => {
      if (err && err.code === "ENOENT") return "";
      throw err;
    });
    const lines = splitArchiveFileLines(content);
    for (let lineNo = lines.length; lineNo >= 1; lineNo -= 1) {
      if (resolved.size >= need.size) break outer;
      const line = String(lines[lineNo - 1] || "");
      if (!line) continue;
      const itemId = parseArchivedItemIdFromArchiveLine(line);
      if (itemId == null) continue;
      if (!need.has(itemId)) continue;
      if (resolved.has(itemId)) continue;
      const pos = toArchivePos(fileSeq, lineNo);
      resolved.set(itemId, { pos, line });
    }
  }

  return params.itemIds
    .map((id) => resolved.get(id) || null)
    .filter((row): row is { pos: number; line: string } => row != null)
    .sort((a, b) => a.pos - b.pos);
}

function splitArchiveFileLines(text: string) {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (/\r?\n$/.test(text)) {
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines;
  }
  // 末行没有换行符时视为潜在半行,读取时忽略以避免并发写入噪声。
  lines.pop();
  return lines;
}

async function appendArchiveLines(params: { dataDir: string; workspaceId: string; sessionId: string; lines: string[] }) {
  if (params.lines.length === 0) return [] as ArchiveWriteSnapshot[];
  const dirPath = agentArchiveSessionDir(params.dataDir, params.workspaceId, params.sessionId);
  await fs.mkdir(dirPath, { recursive: true });
  const snapshots = new Map<string, ArchiveWriteSnapshot>();

  const files = await listArchiveFilesAsc(dirPath);
  let currentSeq = files.length > 0 ? parseArchiveFileName(files[files.length - 1] || "") ?? 1 : 1;
  let currentName = formatArchiveFileName(currentSeq);
  let currentPath = path.join(dirPath, currentName);
  let currentCount = 0;

  try {
    const content = await fs.readFile(currentPath, "utf-8");
    currentCount = splitArchiveFileLines(content).length;
  } catch (err: any) {
    if (!(err && err.code === "ENOENT")) throw err;
  }

  let cursor = 0;
  while (cursor < params.lines.length) {
    if (currentCount >= ARCHIVE_FILE_LINE_LIMIT) {
      currentSeq += 1;
      currentName = formatArchiveFileName(currentSeq);
      currentPath = path.join(dirPath, currentName);
      currentCount = 0;
    }
    const writable = Math.min(ARCHIVE_FILE_LINE_LIMIT - currentCount, params.lines.length - cursor);
    const chunk = params.lines.slice(cursor, cursor + writable);
    if (chunk.length > 0) {
      let snapshot = snapshots.get(currentPath);
      if (!snapshot) {
        let beforeSize = 0;
        try {
          const stat = await fs.stat(currentPath);
          beforeSize = stat.size;
        } catch (err: any) {
          if (!(err && err.code === "ENOENT")) throw err;
        }
        snapshot = {
          filePath: currentPath,
          beforeSize,
          expectedSize: beforeSize
        };
        snapshots.set(currentPath, snapshot);
      }
      const payload = `${chunk.join("\n")}\n`;
      await fs.appendFile(currentPath, payload, "utf-8");
      snapshot.expectedSize += Buffer.byteLength(payload, "utf-8");
      currentCount += chunk.length;
      cursor += chunk.length;
    }
  }

  return Array.from(snapshots.values());
}

async function rollbackArchiveLinesBestEffort(snapshots: ArchiveWriteSnapshot[]) {
  let reverted = 0;
  let skipped = 0;
  for (let i = snapshots.length - 1; i >= 0; i -= 1) {
    const snapshot = snapshots[i];
    if (!snapshot) continue;
    try {
      const stat = await fs.stat(snapshot.filePath);
      if (stat.size !== snapshot.expectedSize) {
        skipped += 1;
        continue;
      }
      await fs.truncate(snapshot.filePath, snapshot.beforeSize);
      reverted += 1;
    } catch (err: any) {
      if (err && err.code === "ENOENT") continue;
      skipped += 1;
    }
  }

  return { reverted, skipped };
}

function toArchivePos(fileSeq: number, lineNo: number) {
  return (fileSeq - 1) * ARCHIVE_FILE_LINE_LIMIT + lineNo;
}

function normalizeBeforePos(raw: unknown) {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 2) {
    throw new HttpError(400, "beforePos must be an integer >= 2", "AGENT_ARCHIVE_BEFORE_POS_INVALID");
  }
  return parsed;
}

function fitArchiveLineWithinBudget(line: string, remainChars: number) {
  if (remainChars <= 0) return null;
  const lineBudget = remainChars - 1;
  if (lineBudget <= 0) return null;
  if (line.length <= lineBudget) return line;

  const sepIndex = line.indexOf(" | ");
  if (sepIndex >= 0) {
    const prefix = line.slice(0, sepIndex + 3);
    const minBudget = prefix.length + ARCHIVE_RESULT_TRUNCATED_MARKER.length;
    if (lineBudget < minBudget) return null;
    const body = line.slice(prefix.length);
    const keepBody = lineBudget - minBudget;
    return `${prefix}${body.slice(0, keepBody)}${ARCHIVE_RESULT_TRUNCATED_MARKER}`;
  }

  if (lineBudget < ARCHIVE_RESULT_TRUNCATED_MARKER.length) return null;
  const keepPrefix = lineBudget - ARCHIVE_RESULT_TRUNCATED_MARKER.length;
  return `${line.slice(0, keepPrefix)}${ARCHIVE_RESULT_TRUNCATED_MARKER}`;
}

function formatArchiveToolResultText(newestFirstLines: string[], maxChars: number) {
  if (newestFirstLines.length === 0) return "";
  const keptNewestFirst: string[] = [];
  let chars = 0;

  for (const line of newestFirstLines) {
    const remain = maxChars - chars;
    const fitted = fitArchiveLineWithinBudget(line, remain);
    if (fitted == null) break;
    keptNewestFirst.push(fitted);
    chars += fitted.length + 1;
    if (fitted !== line) break;
  }

  return keptNewestFirst.reverse().join("\n");
}

function shouldIncludeSystemTextInPrompt(text: string) {
  const normalized = String(text || "").trim();
  if (!normalized) return false;
  return !normalized.startsWith(RUN_STATUS_SYSTEM_TEXT_PREFIX);
}

type ArchiveSearchLineMatch = {
  line: number;
  text: string;
};

type ArchiveSearchLineMatchWithOffsets = ArchiveSearchLineMatch & {
  submatches: Array<{ start: number; end: number }>;
};

function trimTrailingLineEnding(text: string) {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}

function textFromRgJsonField(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "";
  const field = raw as Record<string, unknown>;
  if (typeof field.text === "string") return field.text;
  if (typeof field.bytes === "string") {
    try {
      return Buffer.from(field.bytes, "base64").toString("utf-8");
    } catch {
      return "";
    }
  }
  return "";
}

function utf8ByteOffsetToCodeUnitIndex(text: string, byteOffset: number) {
  const target = Math.max(0, Math.min(Buffer.byteLength(text, "utf8"), Math.floor(byteOffset)));
  let usedBytes = 0;
  let usedUnits = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch, "utf8");
    if (usedBytes + size > target) break;
    usedBytes += size;
    usedUnits += ch.length;
  }
  return usedUnits;
}

function mergeSnippetWindows(windows: Array<{ start: number; end: number }>) {
  if (windows.length === 0) return [] as Array<{ start: number; end: number }>;
  const sorted = windows.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const item of sorted) {
    const prev = merged[merged.length - 1];
    if (!prev) {
      merged.push({ start: item.start, end: item.end });
      continue;
    }
    if (item.start <= prev.end + ARCHIVE_SEARCH_SNIPPET_MERGE_GAP_CHARS) {
      prev.end = Math.max(prev.end, item.end);
      continue;
    }
    if (merged.length >= ARCHIVE_SEARCH_SNIPPET_MAX_WINDOWS_PER_LINE) break;
    merged.push({ start: item.start, end: item.end });
  }
  return merged;
}

function buildArchiveSearchSnippetLine(match: ArchiveSearchLineMatchWithOffsets) {
  const sep = match.text.indexOf(" | ");
  const meta = sep >= 0 ? match.text.slice(0, sep) : "";
  const text = sep >= 0 ? match.text.slice(sep + 3) : match.text;
  const textStartByte = sep >= 0 ? Buffer.byteLength(match.text.slice(0, sep + 3), "utf8") : 0;

  if (!text) return meta;
  const textBytes = Buffer.byteLength(text, "utf8");
  const windows: Array<{ start: number; end: number }> = [];
  for (const hit of match.submatches) {
    const localStart = Math.max(0, hit.start - textStartByte);
    const localEnd = Math.min(textBytes, hit.end - textStartByte);
    if (!Number.isFinite(localStart) || !Number.isFinite(localEnd) || localEnd < localStart) continue;
    let start = utf8ByteOffsetToCodeUnitIndex(text, localStart);
    let end = utf8ByteOffsetToCodeUnitIndex(text, localEnd);
    if (end <= start) {
      if (text.length <= 0) continue;
      if (start >= text.length) {
        start = Math.max(0, text.length - 1);
        end = text.length;
      } else {
        end = Math.min(text.length, start + 1);
      }
    }
    if (end <= start) continue;
    windows.push({
      start: Math.max(0, start - ARCHIVE_SEARCH_SNIPPET_CTX_CHARS),
      end: Math.min(text.length, end + ARCHIVE_SEARCH_SNIPPET_CTX_CHARS)
    });
  }

  if (windows.length === 0) {
    const fallback =
      text.length <= ARCHIVE_SEARCH_SNIPPET_FALLBACK_CHARS
        ? text
        : `${text.slice(0, ARCHIVE_SEARCH_SNIPPET_FALLBACK_CHARS)}...`;
    return meta ? `${meta} | ${fallback}` : fallback;
  }

  const merged = mergeSnippetWindows(windows);
  const parts = merged
    .map((window) => {
      const center = text.slice(window.start, window.end).trim();
      if (!center) return "";
      const lead = window.start > 0 ? "..." : "";
      const tail = window.end < text.length ? "..." : "";
      return `${lead}${center}${tail}`;
    })
    .filter((part) => part.length > 0);

  const snippet = parts.join(" ... ");
  if (!snippet) {
    return meta ? `${meta} | ${text.slice(0, ARCHIVE_SEARCH_SNIPPET_FALLBACK_CHARS)}` : text;
  }
  return meta ? `${meta} | ${snippet}` : snippet;
}

async function rgSearchInFile(params: {
  filePath: string;
  query: string;
  regex: boolean;
}) {
  return await new Promise<ArchiveSearchLineMatch[]>((resolve, reject) => {
    const args = [
      "-n",
      "--no-heading",
      "--color",
      "never",
      "--max-columns",
      "20000",
      "--max-columns-preview",
      "-i"
    ];
    if (!params.regex) args.push("-F");
    args.push("--", params.query, params.filePath);

    const child = spawn("rg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk || "");
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk || "");
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code !== 0 && code !== 1) {
        const message = String(stderr || "").trim() || `rg exit code ${String(code)}`;
        reject(new Error(message));
        return;
      }
      if (code === 1 || !stdout.trim()) {
        resolve([]);
        return;
      }
      const out: ArchiveSearchLineMatch[] = [];
      for (const raw of stdout.split(/\r?\n/)) {
        if (!raw) continue;
        const idx = raw.indexOf(":");
        if (idx <= 0) continue;
        const line = Number(raw.slice(0, idx));
        if (!Number.isFinite(line) || !Number.isInteger(line) || line < 1) continue;
        const text = trimTrailingLineEnding(raw.slice(idx + 1));
        if (!text) continue;
        out.push({ line, text });
      }
      resolve(out);
    });
  });
}

async function rgSearchInFileWithOffsets(params: {
  filePath: string;
  query: string;
  regex: boolean;
}) {
  return await new Promise<ArchiveSearchLineMatchWithOffsets[]>((resolve, reject) => {
    const args = [
      "--json",
      "-n",
      "--color",
      "never",
      "--max-columns",
      "20000",
      "--max-columns-preview",
      "-i"
    ];
    if (!params.regex) args.push("-F");
    args.push("--", params.query, params.filePath);

    const child = spawn("rg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk || "");
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk || "");
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code !== 0 && code !== 1) {
        const message = String(stderr || "").trim() || `rg exit code ${String(code)}`;
        reject(new Error(message));
        return;
      }
      if (code === 1 || !stdout.trim()) {
        resolve([]);
        return;
      }
      const out: ArchiveSearchLineMatchWithOffsets[] = [];
      for (const raw of stdout.split(/\r?\n/)) {
        if (!raw) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          continue;
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        const event = parsed as Record<string, unknown>;
        if (event.type !== "match") continue;
        const data = event.data;
        if (!data || typeof data !== "object" || Array.isArray(data)) continue;
        const payload = data as Record<string, unknown>;
        const line = Number(payload.line_number);
        if (!Number.isFinite(line) || !Number.isInteger(line) || line < 1) continue;
        const text = trimTrailingLineEnding(textFromRgJsonField(payload.lines));
        if (!text) continue;
        const rawSubmatches = Array.isArray(payload.submatches) ? payload.submatches : [];
        const submatches = rawSubmatches
          .map((item) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) return null;
            const obj = item as Record<string, unknown>;
            const start = Number(obj.start);
            const end = Number(obj.end);
            if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) return null;
            return { start: Math.floor(start), end: Math.floor(end) };
          })
          .filter((item): item is { start: number; end: number } => item != null);
        out.push({ line, text, submatches });
      }
      resolve(out);
    });
  });
}

function buildArchiveLine(item: AgentContextItemRecord): string | null {
  let text = "";
  if (item.kind === "user" && item.output.type === "user_text") text = item.output.text || "";
  else if (item.kind === "assistant" && item.output.type === "assistant_text") {
    const raw = item.output.text || "";
    // assistant 仅发起 tool-call 时可能没有自然语言文本,归档空行没有价值,直接过滤。
    if (!String(raw).trim()) return null;
    text = raw;
  }
  else if (item.kind === "system" && item.output.type === "system_text") text = item.output.text || "";
  else if (item.kind === "tool" && item.output.type === "tool") {
    if (typeof item.output.text === "string" && item.output.text.trim()) {
      text = item.output.text;
    } else if (typeof item.output.error === "string" && item.output.error.trim()) {
      text = `[error] ${item.output.error}`;
    } else {
      text = resolveToolOutputText(item.output);
    }
  }
  const toolName = item.kind === "tool" && item.output.type === "tool" ? String(item.output.toolName || "-") : "-";
  return `item=${item.id} ts=${item.createdAt} kind=${item.kind} status=${item.status} tool=${toolName} | ${sanitizeArchiveText(text)}`;
}

function isBoundaryMarkerItem(item: AgentContextItemRecord) {
  return item.kind === "system" && typeof item.boundaryReason === "string" && item.boundaryReason.trim().length > 0;
}

type PromptTextPart = { type: "text"; text: string };
type PromptToolCallPart = {
  type: "tool-call";
  toolCallId: string;
  toolName: AgentContextToolName;
  input: Record<string, unknown>;
};
type PromptToolResultPart = {
  type: "tool-result";
  toolCallId: string;
  toolName: AgentContextToolName;
  output:
    | { type: "text"; value: string }
    | { type: "error-text"; value: string };
};
type PromptMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | PromptTextPart[] }
  | { role: "assistant"; content: string | Array<PromptTextPart | PromptToolCallPart> }
  | { role: "tool"; content: PromptToolResultPart[] };

function decodeUtf8Prefix(bytes: Buffer, maxBytes: number) {
  const truncated = bytes.length > maxBytes;
  const prefix = truncated ? bytes.subarray(0, maxBytes) : bytes;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let end = prefix.length;
  while (end > 0) {
    try {
      const text = decoder.decode(prefix.subarray(0, end));
      return { text, truncated };
    } catch {
      end -= 1;
    }
  }
  return { text: "", truncated };
}

async function readWorkspaceAgentsInstructions(workspacePath: string, logger: FastifyBaseLogger) {
  const filePath = path.join(workspacePath, WORKSPACE_AGENTS_FILENAME);
  const relativePath = path.relative(workspacePath, filePath);
  const displayPath = relativePath && !relativePath.startsWith("..") ? relativePath : filePath;
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(filePath);
  } catch (err: any) {
    if (err && err.code === "ENOENT") return null;
    logger.warn({ err, filePath }, "read workspace AGENTS.md failed");
    return null;
  }

  if (!stat.isFile() || stat.isSymbolicLink()) return null;

  let fd: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    fd = await fs.open(filePath, "r");
    const buf = Buffer.alloc(WORKSPACE_AGENTS_MAX_BYTES + 1);
    let totalRead = 0;
    while (totalRead < buf.length) {
      const { bytesRead } = await fd.read(buf, totalRead, buf.length - totalRead, totalRead);
      if (!bytesRead) break;
      totalRead += bytesRead;
    }
    const chunk = buf.subarray(0, totalRead);
    if (chunk.includes(0x00)) {
      logger.warn({ filePath }, "workspace AGENTS.md appears binary, ignored");
      return null;
    }

    const decoded = decodeUtf8Prefix(chunk, WORKSPACE_AGENTS_MAX_BYTES);
    if (!decoded.text.trim()) return null;

    const extra = decoded.truncated ? "\n\n[workspace AGENTS.md truncated: first 32KB]" : "";
    return {
      filePath,
      displayPath,
      content: `${decoded.text}${extra}`
    };
  } catch (err) {
    logger.warn({ err, filePath }, "read workspace AGENTS.md failed");
    return null;
  } finally {
    await fd?.close().catch(() => undefined);
  }
}

const GLOBAL_WORKFLOW_SYSTEM_PROMPT = `# 工作方式与流程(全局)

## 核心原则
- 以用户目标为准: 优先完成用户明确提出的需求,不擅自扩展范围.
- 先理解后行动: 在改动任何内容前,先基于现有代码与文档确认上下文、约定与边界,避免凭空假设.
- 最小且可回滚的改动: 倾向小步、可验证的增量修改,避免一次性大改导致难以定位问题.
- 保持一致性: 严格遵循项目既有的目录结构、命名、风格、架构分层、错误处理与测试习惯.
- 诚实与可追溯: 不要声称已经运行/验证/修改了任何东西,除非确实完成并看到了结果.
- 冲突处理: 若不同段落的指令出现冲突,以本段全局流程为最高优先级,其余指令按"越具体越靠后"的原则仅作补充.

## 推荐流程(按需裁剪)
- 理解:
  - 复述你对需求的理解(1-3 句),明确输出物是什么.
  - 识别约束: 兼容性、安全边界、性能目标、回归风险点.
- 计划(非简单任务才需要):
  - 给出一个短计划(3-6 个步骤),每一步要可验证.
  - 如果存在多种可行路线,列出 2-3 个选项并说明取舍,给出推荐项.
- 实施:
  - 按计划小步完成,优先复用现有抽象与工具函数,避免引入新依赖或新模式.
  - 若发现现有实现与预期冲突,先停下并解释分歧与影响,再继续.
- 验证:
  - 只要改动可能影响行为,就要做验证(测试、类型检查、lint、构建或最小可复现步骤),以项目已有方式为准.
  - 如果无法确定怎么验证,先在仓库内寻找既有命令/惯例;仍不明确时再向用户询问.
- 交付:
  - 输出应便于用户直接采取下一步动作: 说明改动点在哪里、关键行为如何变化、如何验证.
  - 避免冗长总结,信息密度优先.

## 并发工具调用(效率优先)
- 原则: 运行环境提供的工具都支持并发调用,并且允许不同工具混合并发. 当多个操作彼此独立、互不依赖对方输出时,应当合并为一次并发调用,以提升效率并节省上下文.
- 何时不并发: 若后续操作必须依赖某个工具调用的结果(例如需要先通过搜索确定文件路径,再读取文件内容),则应顺序执行.
- 使用场景示例:
  - 工作开始时的"边计划边调研":
    - 在调用 todolist 制定计划的同时,并发调用 read 读取关键项目文档/配置,或并发执行一次 bash/rg 检索以建立初始全局视图.
    - 避免只单独调用 todolist,导致后续还要再发起多轮调研调用.
  - 搜索命中多个相关文件后的"批量读取":
    - 当 bash/rg 搜到多个相关文件后,不要逐个 read;应并发发起多次 read,一次性把关键文件读齐,再综合判断与推进.

## 不确定性与提问规则
- 只有在"会显著影响结果"且无法通过仓库内信息消除歧义时才提问.
- 提问应成组且最小化:
  - 把问题分成两类: "必须确认(阻塞)"与"可选确认(不阻塞)".
  - "必须确认"最多 2 个,且每个问题都要说明: 不同答案将如何影响实现.
  - "可选确认"最多 3 个;若用户不回答,按你明确写出的默认值继续.
- 若用户只回答了部分问题:
  - 先按已回答的继续,对未回答的部分采用默认假设,并在交付时标注这些假设.

## 质量与安全底线
- 不引入或传播敏感信息: 不打印、不写入、不提交任何密钥、token、密码或用户隐私数据.
- 不做破坏性/不可逆操作,除非用户明确要求且已解释影响.
- 变更应保持可维护性: 代码可读、错误可诊断、日志不过量、边界条件清晰.
- 失败优雅: 遇到错误时先定位根因并给出下一步排查路径,不要靠猜测反复试错.
`;

function buildSystemPrompt(input: {
  agentName: string;
  agentPrompt: string;
  agentGlobalPromptIds: string[];
  globalPrompts: Array<{ id: string; title: string; prompt: string }>;
  workspaceInstructions: { filePath: string; displayPath: string; content: string } | null;
}) {
  const agentPrompt = input.agentPrompt || "";
  const selectedGlobalIds = new Set(input.agentGlobalPromptIds);

  const sections: string[] = [];
  sections.push(GLOBAL_WORKFLOW_SYSTEM_PROMPT.trim());

  for (const item of input.globalPrompts) {
    if (!selectedGlobalIds.has(item.id)) continue;
    if (!item.prompt.trim()) continue;
    sections.push(`## Global Prompt: ${item.title}\n${item.prompt}`);
  }

  if (input.workspaceInstructions?.content?.trim()) {
    sections.push(`## Workspace Instructions: ${input.workspaceInstructions.displayPath}\n${input.workspaceInstructions.content}`);
  }

  if (agentPrompt.trim()) {
    sections.push(`## Agent Prompt: ${input.agentName}\n${agentPrompt}`);
  }

  return sections.join("\n\n");
}

export class AgentService {
  private readonly sessionOpLocks = new Map<string, Promise<void>>();

  constructor(private readonly ctx: AppContext, private readonly logger: FastifyBaseLogger) {}

  private async runSessionOperationExclusive<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.sessionOpLocks.get(sessionId) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = () => resolve();
    });
    const queued = previous.then(() => current);
    this.sessionOpLocks.set(sessionId, queued);
    await previous;
    try {
      return await action();
    } finally {
      releaseCurrent();
      if (this.sessionOpLocks.get(sessionId) === queued) {
        this.sessionOpLocks.delete(sessionId);
      }
    }
  }

  getContext() {
    return this.ctx;
  }

  listSessions(workspaceId: string) {
    this.ensureWorkspace(workspaceId);
    return listAgentSessions(this.ctx.db, workspaceId);
  }

  getSession(sessionId: string) {
    return getAgentSession(this.ctx.db, sessionId);
  }

  getWorkspace(workspaceId: string) {
    return getWorkspace(this.ctx.db, workspaceId);
  }

  createSession(params: {
    workspaceId: string;
    title?: string;
    kind?: "primary" | "subtask";
    forkedFromSessionId?: string | null;
    forkedFromItemId?: number | null;
  }) {
    this.ensureWorkspace(params.workspaceId);
    const createdAt = nowMs();
    const sessionId = newSortableId("sess");
    const title = (params.title || "新会话").trim() || "新会话";
    const kind = params.kind === "subtask" ? "subtask" : "primary";

    createAgentSession(this.ctx.db, {
      id: sessionId,
      workspaceId: params.workspaceId,
      title,
      kind,
      createdAt,
      forkedFromSessionId: params.forkedFromSessionId ?? null,
      forkedFromItemId: params.forkedFromItemId ?? null
    });

    const session = getAgentSession(this.ctx.db, sessionId);
    if (!session) throw new HttpError(500, "failed to create session");
    return session;
  }

  async forkSession(params: AgentForkSessionRequest) {
    const fromSession = getAgentSession(this.ctx.db, params.fromSessionId);
    if (!fromSession) throw new HttpError(404, "source session not found");

    const transcript = getSessionTranscriptItems(this.ctx.db, fromSession.workspaceId, fromSession.id);
    const targetIndex = transcript.findIndex((item) => item.id === params.fromItemId);
    if (targetIndex < 0) throw new HttpError(400, "invalid fromItemId");
    const target = transcript[targetIndex];
    if (!target) throw new HttpError(400, "invalid fromItemId");
    if (target.kind !== "user" && target.kind !== "assistant") {
      throw new HttpError(400, "fromItemId must be user or assistant", "AGENT_FORK_ITEM_KIND_INVALID");
    }

    let cloned: AgentContextItemRecord[] = [];
    const archivedSourceItemIds = new Set<number>();

    if (params.mode === "visible_only") {
      if (target.archiveAt != null) {
        throw new HttpError(400, "fromItemId is archived", "AGENT_ARCHIVED_ITEM_IMMUTABLE");
      }
      const visible = getSessionVisibleItems(this.ctx.db, fromSession.workspaceId, fromSession.id);
      const visibleIndex = visible.findIndex((item) => item.id === params.fromItemId);
      if (visibleIndex < 0) throw new HttpError(400, "invalid fromItemId");
      cloned = visible.slice(0, visibleIndex + 1);
    } else {
      cloned = transcript.slice(0, targetIndex + 1);
      if (target.archiveAt == null) {
        for (const item of cloned) {
          if (item.archiveAt != null) {
            archivedSourceItemIds.add(item.id);
          }
        }
      } else {
        let boundaryIndex = -1;
        for (let i = targetIndex; i >= 0; i -= 1) {
          const item = transcript[i];
          if (!item) continue;
          if (!isBoundaryMarkerItem(item)) continue;
          boundaryIndex = i;
          break;
        }
        if (boundaryIndex > 0) {
          for (let i = 0; i < boundaryIndex; i += 1) {
            const item = transcript[i];
            if (!item) continue;
            archivedSourceItemIds.add(item.id);
          }
        }
      }
    }

    const createdAt = nowMs();
    const newSessionId = newSortableId("sess");
    const title = (params.title || `${fromSession.title} (fork)`).trim() || `${fromSession.title} (fork)`;
    const kind = params.kind === "subtask" ? "subtask" : "primary";
    const archiveAt = nowMs();

    const clonedIdMap = new Map<number, number>();
    const tx = this.ctx.db.transaction(() => {
      createAgentSession(this.ctx.db, {
        id: newSessionId,
        workspaceId: fromSession.workspaceId,
        title,
        kind,
        createdAt,
        forkedFromSessionId: fromSession.id,
        forkedFromItemId: params.fromItemId
      });

      let prevId: number | null = null;
      for (const item of cloned) {
        const safeStatus =
          item.status === "streaming" || item.status === "queued" || item.status === "running" || item.status === "awaiting_permission"
            ? "completed"
            : item.status;
        const next = appendContextItem(this.ctx.db, {
          workspaceId: fromSession.workspaceId,
          sessionId: newSessionId,
          runId: null,
          turnId: null,
          step: null,
          prevId,
          kind: item.kind,
          status: safeStatus,
          boundaryReason: item.boundaryReason,
          output: item.output,
          createdAt: Math.max(createdAt, item.createdAt)
        });
        prevId = next.id;
        clonedIdMap.set(item.id, next.id);
      }

      if (params.mode === "with_archive" && archivedSourceItemIds.size > 0) {
        const archiveItemIds: number[] = [];
        for (const item of cloned) {
          if (!archivedSourceItemIds.has(item.id)) continue;
          const newId = clonedIdMap.get(item.id);
          if (!newId) continue;
          archiveItemIds.push(newId);
        }
        if (archiveItemIds.length > 0) {
          setContextItemsArchiveAt(this.ctx.db, {
            workspaceId: fromSession.workspaceId,
            sessionId: newSessionId,
            itemIds: archiveItemIds,
            archiveAt,
            updatedAt: archiveAt
          });
        }
      }
    });
    tx();

    if (params.mode === "with_archive" && archivedSourceItemIds.size > 0) {
      const nextTranscript = getSessionTranscriptItems(this.ctx.db, fromSession.workspaceId, newSessionId);
      const archiveLines = nextTranscript
        .filter((item) => item.archiveAt != null)
        .map((item) => buildArchiveLine(item))
        .filter((line): line is string => line != null);
      if (archiveLines.length > 0) {
        try {
          await appendArchiveLines({
            dataDir: this.ctx.dataDir,
            workspaceId: fromSession.workspaceId,
            sessionId: newSessionId,
            lines: archiveLines
          });
        } catch (err) {
          this.ctx.db.prepare(`delete from agent_session where id = @sessionId and workspace_id = @workspaceId`).run({
            sessionId: newSessionId,
            workspaceId: fromSession.workspaceId
          });
          await fs
            .rm(agentArchiveSessionDir(this.ctx.dataDir, fromSession.workspaceId, newSessionId), {
              recursive: true,
              force: true
            })
            .catch(() => undefined);
          throw new HttpError(500, "failed to write fork archive", "AGENT_FORK_ARCHIVE_FAILED");
        }
      }
    }

    const session = getAgentSession(this.ctx.db, newSessionId);
    if (!session) throw new HttpError(500, "failed to create fork session");
    return session;
  }

  async sendMessage(params: { sessionId: string; body: AgentSendMessageRequest }): Promise<AgentSendMessageResponse> {
    const session = getAgentSession(this.ctx.db, params.sessionId);
    if (!session) throw new HttpError(404, "session not found");
    if (session.kind === "subtask") {
      throw new HttpError(400, "subtask session is read-only", "AGENT_SUBTASK_READONLY");
    }
    if (session.workspaceId !== params.body.workspaceId) {
      throw new HttpError(400, "workspaceId mismatch");
    }

    const text = params.body.text.trim();
    if (!text) throw new HttpError(400, "text is required");

    const dedup = findClientRequestDedup(this.ctx.db, {
      workspaceId: session.workspaceId,
      sessionId: session.id,
      clientRequestId: params.body.clientRequestId
    });
    if (dedup) {
      return {
        sessionId: session.id,
        messageItemId: dedup.messageItemId,
        runId: dedup.runId,
        deduplicated: true
      };
    }

    const runState = getRunState(this.ctx.db, session.workspaceId, session.id);
    if (runState.status !== "idle") {
      throw new HttpError(409, "session is running");
    }

    const profile = resolveExecutionProfile(this.ctx, {
      requestedAgentId: params.body.agentId
    });

    const createdAt = nowMs();
    const runId = newSortableId("run");
    let messageItemId = 0;

    try {
      const tx = this.ctx.db.transaction(() => {
        const head = getSessionHead(this.ctx.db, session.workspaceId, session.id);
        const isFirstUserMessage = head == null;
        const item = appendContextItem(this.ctx.db, {
          workspaceId: session.workspaceId,
          sessionId: session.id,
          runId,
          turnId: null,
          step: null,
          prevId: head,
          kind: "user",
          status: "completed",
          output: {
            type: "user_text",
            text
          },
          createdAt
        });

        messageItemId = item.id;

        if (isFirstUserMessage) {
          updateAgentSessionTitle(this.ctx.db, {
            sessionId: session.id,
            title: toSessionTitleFromFirstMessage(text),
            updatedAt: createdAt
          });
        }

        insertClientRequestDedup(this.ctx.db, {
          workspaceId: session.workspaceId,
          sessionId: session.id,
          clientRequestId: params.body.clientRequestId,
          messageItemId: item.id,
          runId,
          createdAt
        });

        createRunRecord(this.ctx.db, {
          runId,
          workspaceId: session.workspaceId,
          sessionId: session.id,
          triggerItemId: item.id,
          agentId: profile.agent.id,
          providerId: profile.provider.id,
          modelId: profile.model.id,
          status: "running",
          createdAt
        });

        updateRunState(this.ctx.db, {
          workspaceId: session.workspaceId,
          sessionId: session.id,
          status: "running",
          activeRunId: runId,
          activeAssistantItemId: null,
          waitingToolItemId: null,
          runNoticeText: "",
          updatedAt: createdAt,
          appliedItemId: item.id
        });
      });
      tx();
    } catch (err) {
      if (err instanceof AgentConflictError) throw conflictToHttpError(err);
      throw err;
    }

    return {
      sessionId: session.id,
      messageItemId,
      runId,
      deduplicated: false
    };
  }

  getContextItems(
    sessionId: string,
    query?: { afterId?: number; tailLimit?: number; beforeId?: number; limit?: number; expectedHeadItemId?: number }
  ): AgentContextItemsResponse {
    const session = getAgentSession(this.ctx.db, sessionId);
    if (!session) throw new HttpError(404, "session not found");

    const toFiniteNumber = (value: unknown) => {
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n)) return null;
      return n;
    };

    const afterId = toFiniteNumber((query as any)?.afterId);
    const tailLimit = toFiniteNumber((query as any)?.tailLimit);
    const beforeId = toFiniteNumber((query as any)?.beforeId);
    const limit = toFiniteNumber((query as any)?.limit);
    const expectedHeadItemId = toFiniteNumber((query as any)?.expectedHeadItemId);

    const hasAfter = afterId != null && afterId > 0;
    const hasTail = tailLimit != null && tailLimit > 0;
    const hasBefore = beforeId != null && beforeId > 0;

    // 约束: 一次请求只允许一种分页语义.
    const modeCount = Number(hasAfter) + Number(hasTail) + Number(hasBefore);
    if (modeCount > 1) {
      throw new HttpError(400, "invalid context-items query", "AGENT_CONTEXT_ITEMS_QUERY_INVALID");
    }

    let hasMoreBefore: boolean | undefined;
    const items = hasTail
      ? (() => {
          const window = getSessionTranscriptTailWindow(this.ctx.db, session.workspaceId, session.id, tailLimit!);
          hasMoreBefore = window.hasMoreBefore;
          return window.items;
        })()
      : hasBefore
        ? (() => {
            if (expectedHeadItemId != null && expectedHeadItemId > 0) {
              const expected = Math.floor(expectedHeadItemId);
              const head = session.headItemId;
              // 允许 head 向前推进(新消息追加),但不允许 head 回退(分支切换/回退)后继续沿旧链分页。
              if (head == null || head < expected) {
                throw new HttpError(409, "session head conflict", "AGENT_CONTEXT_ITEMS_HEAD_MOVED");
              }
            }
            const window = getSessionTranscriptBeforeWindow(this.ctx.db, {
              workspaceId: session.workspaceId,
              sessionId: session.id,
              beforeId: Math.floor(beforeId!),
              limit: limit != null ? limit : 100
            });
            hasMoreBefore = window.hasMoreBefore;
            return window.items;
          })()
        : hasAfter
          ? getSessionTranscriptItemsAfterIdWindow(this.ctx.db, {
              workspaceId: session.workspaceId,
              sessionId: session.id,
              afterId: Math.floor(afterId!)
            })
          : getSessionTranscriptItems(this.ctx.db, session.workspaceId, session.id);

    const runState = getRunState(this.ctx.db, session.workspaceId, session.id);
    return {
      sessionId: session.id,
      headItemId: session.headItemId,
      appliedItemId: runState.appliedItemId,
      ...(typeof hasMoreBefore === "boolean" ? { hasMoreBefore } : {}),
      items
    };
  }

  async compactSession(params: { sessionId: string; body: AgentCompactSessionRequest }): Promise<AgentCompactSessionResponse> {
    return this.runSessionOperationExclusive(params.sessionId, async () => {
      const session = getAgentSession(this.ctx.db, params.sessionId);
      if (!session) throw new HttpError(404, "session not found");
      if (session.kind === "subtask") {
        throw new HttpError(400, "subtask session is read-only", "AGENT_SUBTASK_READONLY");
      }
      if (session.workspaceId !== params.body.workspaceId) {
        throw new HttpError(400, "workspaceId mismatch");
      }
      if (!this.ctx.agentWorkerEnabled) {
        throw new HttpError(503, "agent worker unavailable", "AGENT_WORKER_UNAVAILABLE");
      }

      const clientRequestId = String(params.body.clientRequestId || "").trim();
      if (!clientRequestId) throw new HttpError(400, "clientRequestId is required");

      const dedup = findClientRequestDedup(this.ctx.db, {
        workspaceId: session.workspaceId,
        sessionId: session.id,
        clientRequestId
      });
      if (dedup) {
        return {
          sessionId: session.id,
          runId: dedup.runId,
          deduplicated: true
        };
      }

      const runState = getRunState(this.ctx.db, session.workspaceId, session.id);
      if (runState.status !== "idle") {
        throw new HttpError(409, "session is running");
      }

      const triggerItemId = session.headItemId;
      if (triggerItemId == null) {
        throw new HttpError(400, "no context to compact", "AGENT_COMPACTION_EMPTY");
      }

      const visible = getSessionVisibleItems(this.ctx.db, session.workspaceId, session.id);
      if (
        visible.length === 1 &&
        visible[0]?.kind === "system" &&
        typeof visible[0]?.boundaryReason === "string" &&
        visible[0].boundaryReason.trim().length > 0
      ) {
        throw new HttpError(400, "compaction not needed", "AGENT_COMPACTION_NOT_NEEDED");
      }

      const profile = resolveExecutionProfile(this.ctx, {
        requestedAgentId: params.body.agentId
      });

      const createdAt = nowMs();
      const runId = newSortableId("run");

      const tx = this.ctx.db.transaction(() => {
        createRunRecord(this.ctx.db, {
          runId,
          workspaceId: session.workspaceId,
          sessionId: session.id,
          triggerItemId: triggerItemId,
          agentId: profile.agent.id,
          providerId: profile.provider.id,
          modelId: profile.model.id,
          status: "running",
          createdAt
        });

        insertClientRequestDedup(this.ctx.db, {
          workspaceId: session.workspaceId,
          sessionId: session.id,
          clientRequestId,
          messageItemId: triggerItemId,
          runId,
          createdAt
        });

        updateRunState(this.ctx.db, {
          workspaceId: session.workspaceId,
          sessionId: session.id,
          status: "running",
          activeRunId: runId,
          activeAssistantItemId: null,
          waitingToolItemId: null,
          // 立即给 UI 一个反馈,避免等待 worker 拉取状态.
          runNoticeText: "正在压缩上下文...",
          updatedAt: createdAt,
          appliedItemId: getLatestSessionItemId(this.ctx.db, session.workspaceId, session.id)
        });
      });
      tx();

      return {
        sessionId: session.id,
        runId,
        deduplicated: false
      };
    });
  }

  // enqueue 失败时做最小回滚,避免会话卡在 running.
  failRunOnEnqueueFailure(params: { workspaceId: string; sessionId: string; runId: string; updatedAt?: number }) {
    const ts = params.updatedAt ?? nowMs();
    const run = getRunRecord(this.ctx.db, params.runId);
    if (!run) return;
    if (run.workspaceId !== params.workspaceId || run.sessionId !== params.sessionId) return;
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") return;

    updateRunRecordStatus(this.ctx.db, {
      runId: params.runId,
      status: "failed",
      updatedAt: ts
    });
    const state = getRunState(this.ctx.db, params.workspaceId, params.sessionId);
    if (state.activeRunId !== params.runId) return;
    setRunStateIdle(this.ctx.db, {
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      updatedAt: ts,
      appliedItemId: getLatestSessionItemId(this.ctx.db, params.workspaceId, params.sessionId)
    });
  }

  getContextItem(sessionId: string, itemId: number) {
    const session = getAgentSession(this.ctx.db, sessionId);
    if (!session) throw new HttpError(404, "session not found");
    const item = getTranscriptItemById(this.ctx.db, session.workspaceId, session.id, itemId);
    if (!item) throw new HttpError(404, "context item not found");
    return item;
  }

  async getApplyPatchUiArtifact(params: { sessionId: string; itemId: number }) {
    const item = this.getContextItem(params.sessionId, params.itemId);
    if (item.kind !== "tool" || item.output.type !== "tool" || item.output.toolName !== "apply_patch") {
      throw new HttpError(404, "apply_patch artifact not found");
    }
    const toolCallId = typeof item.output.toolCallId === "string" ? item.output.toolCallId.trim() : "";
    if (!toolCallId) {
      throw new HttpError(404, "apply_patch artifact not found");
    }
    const filePath = applyPatchUiArtifactPath(this.ctx.dataDir, item.workspaceId, toolCallId);
    const tmpAbs = path.resolve(tmpRoot(this.ctx.dataDir));
    const fileAbs = path.resolve(filePath);
    if (!fileAbs.startsWith(tmpAbs + path.sep) && fileAbs !== tmpAbs) {
      throw new HttpError(404, "apply_patch artifact not found");
    }
    const st = await fs.lstat(fileAbs).catch(() => null);
    if (!st || !st.isFile()) {
      throw new HttpError(404, "apply_patch artifact not found");
    }
    await ensureRealPathUnderRoot(tmpAbs, fileAbs);
    let text = "";
    try {
      text = await readFileNoFollow(fileAbs);
    } catch {
      throw new HttpError(404, "apply_patch artifact not found");
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new HttpError(404, "apply_patch artifact not found");
    }
  }

  async getWriteUiArtifact(params: { sessionId: string; itemId: number }) {
    const item = this.getContextItem(params.sessionId, params.itemId);
    if (item.kind !== "tool" || item.output.type !== "tool" || item.output.toolName !== "write") {
      throw new HttpError(404, "write artifact not found");
    }
    const toolCallId = typeof item.output.toolCallId === "string" ? item.output.toolCallId.trim() : "";
    if (!toolCallId) {
      throw new HttpError(404, "write artifact not found");
    }
    const filePath = writeUiArtifactPath(this.ctx.dataDir, item.workspaceId, toolCallId);
    const tmpAbs = path.resolve(tmpRoot(this.ctx.dataDir));
    const fileAbs = path.resolve(filePath);
    if (!fileAbs.startsWith(tmpAbs + path.sep) && fileAbs !== tmpAbs) {
      throw new HttpError(404, "write artifact not found");
    }
    const st = await fs.lstat(fileAbs).catch(() => null);
    if (!st || !st.isFile()) {
      throw new HttpError(404, "write artifact not found");
    }
    await ensureRealPathUnderRoot(tmpAbs, fileAbs);
    let text = "";
    try {
      text = await readFileNoFollow(fileAbs);
    } catch {
      throw new HttpError(404, "write artifact not found");
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new HttpError(404, "write artifact not found");
    }
  }

  getRunState(sessionId: string): AgentSessionRunState {
    const session = getAgentSession(this.ctx.db, sessionId);
    if (!session) throw new HttpError(404, "session not found");
    const state = getRunState(this.ctx.db, session.workspaceId, session.id);
    const nonTerminalItemIds = listNonTerminalVisibleItemIds(this.ctx.db, session.workspaceId, session.id);
    return {
      sessionId: session.id,
      status: state.status,
      activeRunId: state.activeRunId,
      activeAssistantItemId: state.activeAssistantItemId,
      waitingToolItemId: state.waitingToolItemId,
      lastResponseTotalTokens: state.lastResponseTotalTokens,
      runNoticeText: state.runNoticeText,
      nonTerminalItemIds,
      updatedAt: state.updatedAt,
      appliedItemId: state.appliedItemId
    };
  }

  getContextItemById(itemId: number) {
    return getContextItemById(this.ctx.db, itemId);
  }

  revertSession(sessionId: string, body: AgentRevertSessionRequest): AgentControlResult {
    const session = getAgentSession(this.ctx.db, sessionId);
    if (!session) throw new HttpError(404, "session not found");
    if (session.workspaceId !== body.workspaceId) throw new HttpError(400, "workspaceId mismatch");
    const target = getTranscriptItemById(this.ctx.db, session.workspaceId, session.id, body.toItemId);
    if (!target) throw new HttpError(400, "toItemId is invalid");
    if (target.archiveAt != null) {
      throw new HttpError(400, "toItemId is archived", "AGENT_ARCHIVED_ITEM_IMMUTABLE");
    }

    const state = getRunState(this.ctx.db, session.workspaceId, session.id);
    const createdAt = nowMs();
    try {
      moveSessionHead(this.ctx.db, {
        workspaceId: session.workspaceId,
        sessionId: session.id,
        expectedHeadItemId: session.headItemId,
        nextHeadItemId: body.toItemId,
        updatedAt: createdAt
      });
      setRunStateIdle(this.ctx.db, {
        workspaceId: session.workspaceId,
        sessionId: session.id,
        updatedAt: createdAt,
        appliedItemId: getLatestSessionItemId(this.ctx.db, session.workspaceId, session.id)
      });
      if (state.activeRunId) {
        updateRunRecordStatus(this.ctx.db, {
          runId: state.activeRunId,
          status: "cancelled",
          updatedAt: createdAt
        });
      }
    } catch (err) {
      if (err instanceof AgentConflictError) throw conflictToHttpError(err);
      if (err instanceof Error && err.message === "invalid target head item") {
        throw new HttpError(400, "toItemId is invalid");
      }
      throw err;
    }

    const headItemId = getSessionHead(this.ctx.db, session.workspaceId, session.id);
    return { sessionId: session.id, headItemId };
  }

  cancelSession(sessionId: string, body: AgentCancelSessionRequest): AgentControlResult {
    const session = getAgentSession(this.ctx.db, sessionId);
    if (!session) throw new HttpError(404, "session not found");
    if (session.workspaceId !== body.workspaceId) throw new HttpError(400, "workspaceId mismatch");

    const state = getRunState(this.ctx.db, session.workspaceId, session.id);
    const createdAt = nowMs();

    const tx = this.ctx.db.transaction(() => {
      const visible = getSessionVisibleItems(this.ctx.db, session.workspaceId, session.id);
      for (const item of visible) {
        if (!NON_TERMINAL_ITEM_STATUS.has(item.status)) continue;
        updateContextItem(this.ctx.db, {
          itemId: item.id,
          status: "cancelled",
          output: toTerminalWriteOutput(item.output),
          updatedAt: createdAt
        });
      }

      setRunStateIdle(this.ctx.db, {
        workspaceId: session.workspaceId,
        sessionId: session.id,
        updatedAt: createdAt,
        appliedItemId: getLatestSessionItemId(this.ctx.db, session.workspaceId, session.id)
      });
      if (state.activeRunId) {
        updateRunRecordStatus(this.ctx.db, {
          runId: state.activeRunId,
          status: "cancelled",
          updatedAt: createdAt
        });
      }
    });

    tx();

    const headItemId = getSessionHead(this.ctx.db, session.workspaceId, session.id);
    return { sessionId: session.id, headItemId };
  }

  applyToolPermission(sessionId: string, body: AgentToolPermissionRequest) {
    const session = getAgentSession(this.ctx.db, sessionId);
    if (!session) throw new HttpError(404, "session not found");
    if (session.workspaceId !== body.workspaceId) throw new HttpError(400, "workspaceId mismatch");
    const state = getRunState(this.ctx.db, session.workspaceId, session.id);
    if (!state.activeRunId) throw new HttpError(409, "no active run");
    if (state.waitingToolItemId !== body.toolItemId) throw new HttpError(409, "tool is not waiting for permission");

    const item = getContextItemById(this.ctx.db, body.toolItemId);
    if (!item || item.sessionId !== session.id || item.kind !== "tool") {
      throw new HttpError(404, "tool item not found");
    }
    if (item.status !== "awaiting_permission") {
      throw new HttpError(409, "tool is not waiting for permission");
    }

    if (item.output.type !== "tool") {
      throw new HttpError(400, "invalid tool item output");
    }
    const output = item.output;
    const updatedAt = nowMs();
    if (body.decision === "approve") {
      updateContextItem(this.ctx.db, {
        itemId: item.id,
        status: "queued",
        output: {
          ...output,
          approved: true
        },
        updatedAt
      });
      updateRunRecordStatus(this.ctx.db, {
        runId: state.activeRunId,
        status: "running",
        updatedAt
      });
      updateRunState(this.ctx.db, {
        workspaceId: session.workspaceId,
        sessionId: session.id,
        status: "running",
        activeRunId: state.activeRunId,
        activeAssistantItemId: state.activeAssistantItemId,
        waitingToolItemId: null,
        updatedAt,
        appliedItemId: getLatestSessionItemId(this.ctx.db, session.workspaceId, session.id)
      });
      return { runId: state.activeRunId, decision: body.decision };
    }

    updateContextItem(this.ctx.db, {
      itemId: item.id,
      status: "denied",
      output: toTerminalWriteOutput({
        ...output,
        text: `tool: ${output.toolName}\nstatus: denied\n\npermission denied`,
        error: "permission denied"
      }),
      updatedAt
    });
    updateRunRecordStatus(this.ctx.db, {
      runId: state.activeRunId,
      status: "running",
      updatedAt
    });
    updateRunState(this.ctx.db, {
      workspaceId: session.workspaceId,
      sessionId: session.id,
      status: "running",
      activeRunId: state.activeRunId,
      activeAssistantItemId: state.activeAssistantItemId,
      waitingToolItemId: null,
      updatedAt,
      appliedItemId: getLatestSessionItemId(this.ctx.db, session.workspaceId, session.id)
    });
    return { runId: state.activeRunId, decision: body.decision };
  }

  appendContextItemFromWorker(params: {
    workspaceId: string;
    sessionId: string;
    runId: string | null;
    turnId: string | null;
    step: number | null;
    prevId: number | null;
    kind: AgentContextItemRecord["kind"];
    status: AgentContextItemStatus;
    output: AgentContextItemRecord["output"];
    createdAt?: number;
  }) {
    if (
      params.kind === "tool" &&
      params.status === "completed" &&
      params.output &&
      (params.output as any).type === "tool" &&
      (params.output as any).toolName === "apply_patch" &&
      Object.prototype.hasOwnProperty.call(params.output as any, "result")
    ) {
      // 本项目不保留 apply_patch 的 before/after 在 DB 中,必须走 update 路径写入 service artifact 后再瘦身入库。
      throw new HttpError(400, "apply_patch completed tool item must be updated, not appended");
    }
    try {
      return appendContextItem(this.ctx.db, {
        workspaceId: params.workspaceId,
        sessionId: params.sessionId,
        runId: params.runId,
        turnId: params.turnId,
        step: params.step,
        prevId: params.prevId,
        kind: params.kind,
        status: params.status,
        output: params.output,
        createdAt: params.createdAt ?? nowMs()
      });
    } catch (err) {
      if (err instanceof AgentConflictError) {
        this.logger.warn(
          {
            sessionId: params.sessionId,
            kind: params.kind,
            currentHeadItemId: err.currentHeadItemId
          },
          "agent append context item conflict"
        );
        throw conflictToHttpError(err);
      }
      throw err;
    }
  }

  async updateContextItemFromWorker(params: {
    itemId: number;
    status?: AgentContextItemStatus;
    output?: AgentContextItemRecord["output"];
    updatedAt?: number;
  }) {
    const current = getContextItemById(this.ctx.db, params.itemId);
    const nextStatus = params.status ?? current?.status;
    let nextOutput = params.output;

    // apply_patch: 将 before/after 从 DB 中剥离,改为写入 service UI artifact.
    if (
      nextStatus === "completed" &&
      nextOutput &&
      (nextOutput as any).type === "tool" &&
      (nextOutput as any).toolName === "apply_patch" &&
      Object.prototype.hasOwnProperty.call(nextOutput as any, "result")
    ) {
      const tool = nextOutput as any as { toolCallId?: unknown; result?: unknown };
      const toolCallId = typeof tool.toolCallId === "string" ? tool.toolCallId.trim() : "";
      const workspaceId = current?.workspaceId;
      const { slim, artifact } = splitApplyPatchResult(tool.result);

      if (toolCallId && workspaceId) {
        const filePath = applyPatchUiArtifactPath(this.ctx.dataDir, workspaceId, toolCallId);
        const dirPath = path.dirname(filePath);
        const tmpAbs = path.resolve(tmpRoot(this.ctx.dataDir));
        const dirAbs = path.resolve(dirPath);
        if (!dirAbs.startsWith(tmpAbs + path.sep) && dirAbs !== tmpAbs) {
          this.logger.error(
            { itemId: params.itemId, filePath },
            "apply_patch ui artifact path is outside tmpRoot"
          );
        } else {
          try {
            await ensureDirSafeUnderRoot(tmpAbs, dirAbs);
            await ensureRealPathUnderRoot(tmpAbs, dirAbs);
            const payload: ApplyPatchUiArtifactV1 = {
              ...artifact,
              workspaceId,
              toolCallId,
              createdAt: params.updatedAt ?? nowMs()
            };
            await writeFileNoFollow(filePath, JSON.stringify(payload));
          } catch (err) {
            this.logger.error({ err, itemId: params.itemId }, "failed to write apply_patch ui artifact");
          }
        }
      } else {
        this.logger.warn(
          { itemId: params.itemId, hasToolCallId: !!toolCallId, hasWorkspaceId: !!workspaceId },
          "apply_patch completed but missing toolCallId/workspaceId; ui artifact skipped"
        );
      }

      nextOutput = {
        ...(nextOutput as any),
        result: slim
      } as any;
    }

    const isWriteTool = nextOutput &&
      (nextOutput as any).type === "tool" &&
      (nextOutput as any).toolName === "write";
    const isWriteTerminalStatus = nextStatus === "completed" || nextStatus === "failed" || nextStatus === "denied" || nextStatus === "cancelled";

    if (isWriteTool && isWriteTerminalStatus) {
      const tool = nextOutput as any as { toolCallId?: unknown; result?: unknown; args?: unknown };
      const toolCallId = typeof tool.toolCallId === "string" ? tool.toolCallId.trim() : "";
      const workspaceId = current?.workspaceId;

      if (nextStatus === "completed") {
        const { slim, artifact } = splitWriteResult(tool.result);
        if (toolCallId && workspaceId) {
          const filePath = writeUiArtifactPath(this.ctx.dataDir, workspaceId, toolCallId);
          const dirPath = path.dirname(filePath);
          const tmpAbs = path.resolve(tmpRoot(this.ctx.dataDir));
          const dirAbs = path.resolve(dirPath);
          if (!dirAbs.startsWith(tmpAbs + path.sep) && dirAbs !== tmpAbs) {
            this.logger.error(
              { itemId: params.itemId, filePath },
              "write ui artifact path is outside tmpRoot"
            );
          } else {
            try {
              await ensureDirSafeUnderRoot(tmpAbs, dirAbs);
              await ensureRealPathUnderRoot(tmpAbs, dirAbs);
              const payload: WriteUiArtifactV1 = {
                ...artifact,
                workspaceId,
                toolCallId,
                createdAt: params.updatedAt ?? nowMs()
              };
              await writeFileNoFollow(filePath, JSON.stringify(payload));
            } catch (err) {
              this.logger.error({ err, itemId: params.itemId }, "failed to write write ui artifact");
            }
          }
        } else {
          this.logger.warn(
            { itemId: params.itemId, hasToolCallId: !!toolCallId, hasWorkspaceId: !!workspaceId },
            "write completed but missing toolCallId/workspaceId; ui artifact skipped"
          );
        }

        nextOutput = {
          ...(nextOutput as any),
          result: slim
        } as any;
      }

      nextOutput = {
        ...(nextOutput as any),
        args: toWriteSlimArgs(tool.args)
      } as any;
    }

    const item = updateContextItem(this.ctx.db, {
      itemId: params.itemId,
      status: params.status,
      output: nextOutput,
      updatedAt: params.updatedAt ?? nowMs()
    });
    if (!item) throw new HttpError(404, "context item not found");
    return item;
  }

  updateRunStateFromWorker(params: {
    workspaceId: string;
    sessionId: string;
    status: AgentRunStatus;
    activeRunId: string | null;
    activeAssistantItemId: number | null;
    waitingToolItemId: number | null;
    lastResponseTotalTokens?: number | null;
    runNoticeText?: string | null;
    updatedAt?: number;
  }) {
    const currentState = getRunState(this.ctx.db, params.workspaceId, params.sessionId);
    const activeRunId = typeof params.activeRunId === "string" && params.activeRunId.trim() ? params.activeRunId : null;
    const activeRun = activeRunId ? getRunRecord(this.ctx.db, activeRunId) : null;

    // 避免晚到 worker 状态覆盖已切换到其他 run 的会话状态。
    if (activeRunId && currentState.activeRunId && currentState.activeRunId !== activeRunId) {
      return;
    }
    if (activeRunId) {
      if (activeRun) {
        if (activeRun.workspaceId !== params.workspaceId || activeRun.sessionId !== params.sessionId) return;
        // 终态 run 不再接受 worker 的 running/waiting 状态回写。
        if (TERMINAL_RUN_RECORD_STATUS.has(activeRun.status as "completed" | "failed" | "cancelled")) {
          return;
        }
      }
    }

    const ts = params.updatedAt ?? nowMs();
    const appliedItemId = getLatestSessionItemId(this.ctx.db, params.workspaceId, params.sessionId);
    const hasLastResponseTotalTokens = Object.prototype.hasOwnProperty.call(params, "lastResponseTotalTokens");
    const hasRunNoticeText = Object.prototype.hasOwnProperty.call(params, "runNoticeText");
    const shouldClearNoticeWhenIdle = params.status === "idle" && !hasRunNoticeText;
    updateRunState(this.ctx.db, {
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      status: params.status,
      activeRunId,
      activeAssistantItemId: params.activeAssistantItemId,
      waitingToolItemId: params.waitingToolItemId,
      ...(hasLastResponseTotalTokens ? { lastResponseTotalTokens: params.lastResponseTotalTokens ?? null } : {}),
      ...(hasRunNoticeText
        ? { runNoticeText: normalizeRunNoticeText(params.runNoticeText) }
        : shouldClearNoticeWhenIdle
          ? { runNoticeText: "" }
          : {}),
      updatedAt: ts,
      appliedItemId
    });
    if (activeRunId) {
      updateRunRecordStatus(this.ctx.db, {
        runId: activeRunId,
        status: params.status === "waiting_permission" ? "waiting_permission" : "running",
        updatedAt: ts
      });
    }
  }

  completeRunFromWorker(params: {
    workspaceId: string;
    sessionId: string;
    runId: string;
    status: "completed" | "failed" | "cancelled";
    updatedAt?: number;
  }) {
    const ts = params.updatedAt ?? nowMs();
    const run = getRunRecord(this.ctx.db, params.runId);
    if (!run) return;
    if (run.workspaceId !== params.workspaceId || run.sessionId !== params.sessionId) return;
    if (TERMINAL_RUN_RECORD_STATUS.has(run.status as "completed" | "failed" | "cancelled")) {
      return;
    }

    updateRunRecordStatus(this.ctx.db, {
      runId: params.runId,
      status: params.status,
      updatedAt: ts
    });
    const state = getRunState(this.ctx.db, params.workspaceId, params.sessionId);
    if (state.activeRunId !== params.runId) {
      return;
    }
    setRunStateIdle(this.ctx.db, {
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      updatedAt: ts,
      appliedItemId: getLatestSessionItemId(this.ctx.db, params.workspaceId, params.sessionId)
    });
  }

  async startSubtaskRunFromWorker(params: {
    workspaceId: string;
    parentSessionId: string;
    parentRunId: string;
    parentToolItemId: number;
    description: string;
    prompt: string;
    agentId: string;
    session: {
      mode: "new" | "existing" | "fork";
      sessionId?: string;
    };
  }) {
    const parentSession = getAgentSession(this.ctx.db, params.parentSessionId);
    if (!parentSession) throw new HttpError(404, "parent session not found");
    if (parentSession.workspaceId !== params.workspaceId) throw new HttpError(400, "workspaceId mismatch");

    const parentRun = getRunRecord(this.ctx.db, params.parentRunId);
    if (!parentRun || parentRun.sessionId !== params.parentSessionId || parentRun.workspaceId !== params.workspaceId) {
      throw new HttpError(404, "parent run not found");
    }

    const anchor = getContextItemById(this.ctx.db, params.parentToolItemId);
    if (!anchor || anchor.sessionId !== params.parentSessionId || anchor.workspaceId !== params.workspaceId || anchor.kind !== "tool") {
      throw new HttpError(400, "invalid subtask anchor");
    }
    if (anchor.runId !== params.parentRunId) {
      throw new HttpError(400, "invalid subtask anchor run", "AGENT_SUBTASK_ANCHOR_RUN_MISMATCH");
    }

    const normalizedDescription = params.description.trim();
    if (!normalizedDescription) {
      throw new HttpError(400, "subtask description is required", "AGENT_SUBTASK_DESCRIPTION_REQUIRED");
    }
    if (normalizedDescription.length > 20) {
      throw new HttpError(400, "subtask description must be <= 20 characters", "AGENT_SUBTASK_DESCRIPTION_TOO_LONG");
    }
    const subtaskTitleBase = normalizedDescription;
    const resolvedAgentId = String(params.agentId || "").trim();
    if (!resolvedAgentId) {
      throw new HttpError(400, "subtask agentId is required", "AGENT_SUBTASK_AGENT_REQUIRED");
    }
    const requestedSessionId = String(params.session.sessionId || "").trim();

    let session = null as AgentSessionRecord | null;
    if (params.session.mode === "existing") {
      const sessionId = requestedSessionId;
      if (!sessionId) {
        throw new HttpError(400, "existing sessionId is required", "AGENT_SUBTASK_EXISTING_SESSION_REQUIRED");
      }
      session = getAgentSession(this.ctx.db, sessionId);
      if (!session) throw new HttpError(404, "subtask session not found", "AGENT_SUBTASK_SESSION_NOT_FOUND");
      if (session.workspaceId !== params.workspaceId) {
        throw new HttpError(400, "subtask session workspace mismatch", "AGENT_SUBTASK_WORKSPACE_MISMATCH");
      }
      if (session.kind !== "subtask") {
        throw new HttpError(400, "existing session must be subtask", "AGENT_SUBTASK_KIND_MISMATCH");
      }
    } else if (params.session.mode === "fork") {
      if (requestedSessionId) {
        throw new HttpError(400, "sessionId is not allowed when mode=fork", "AGENT_SUBTASK_SESSION_ID_NOT_ALLOWED");
      }
      if (anchor.prevId == null) {
        session = this.createSession({
          workspaceId: params.workspaceId,
          title: `${subtaskTitleBase} (fork)`,
          kind: "subtask"
        });
      } else {
        session = await this.forkSession({
          fromSessionId: params.parentSessionId,
          fromItemId: anchor.prevId,
          mode: "visible_only",
          title: `${subtaskTitleBase} (fork)`,
          kind: "subtask"
        });
      }
    } else if (params.session.mode === "new") {
      if (requestedSessionId) {
        throw new HttpError(400, "sessionId is not allowed when mode=new", "AGENT_SUBTASK_SESSION_ID_NOT_ALLOWED");
      }
      session = this.createSession({
        workspaceId: params.workspaceId,
        title: `${subtaskTitleBase}`,
        kind: "subtask",
        forkedFromSessionId: params.parentSessionId,
        forkedFromItemId: params.parentToolItemId
      });
    } else {
      throw new HttpError(400, "invalid subtask session mode", "AGENT_SUBTASK_SESSION_MODE_INVALID");
    }

    const state = getRunState(this.ctx.db, session.workspaceId, session.id);
    if (state.status !== "idle") {
      throw new HttpError(409, "subtask session is running", "AGENT_SUBTASK_SESSION_RUNNING");
    }

    const profile = resolveExecutionProfile(this.ctx, {
      requestedAgentId: resolvedAgentId
    });

    const workspace = getWorkspace(this.ctx.db, params.workspaceId);
    if (!workspace) throw new HttpError(404, "workspace not found");

    const createdAt = nowMs();
    const runId = newSortableId("run");
    const text = params.prompt.trim();
    if (!text) {
      throw new HttpError(400, "subtask prompt is required", "AGENT_SUBTASK_PROMPT_REQUIRED");
    }

    const tx = this.ctx.db.transaction(() => {
      const head = getSessionHead(this.ctx.db, session.workspaceId, session.id);
      const item = appendContextItem(this.ctx.db, {
        workspaceId: session.workspaceId,
        sessionId: session.id,
        runId,
        turnId: null,
        step: null,
        prevId: head,
        kind: "user",
        status: "completed",
        output: {
          type: "user_text",
          text
        },
        createdAt
      });

      createRunRecord(this.ctx.db, {
        runId,
        workspaceId: session.workspaceId,
        sessionId: session.id,
        triggerItemId: item.id,
        agentId: profile.agent.id,
        providerId: profile.provider.id,
        modelId: profile.model.id,
        status: "running",
        createdAt
      });

      updateRunState(this.ctx.db, {
        workspaceId: session.workspaceId,
        sessionId: session.id,
        status: "running",
        activeRunId: runId,
        activeAssistantItemId: null,
        waitingToolItemId: null,
        runNoticeText: "",
        updatedAt: createdAt,
        appliedItemId: item.id
      });
    });
    tx();

    return {
      sessionId: session.id,
      runId,
      workspacePath: workspace.path
    };
  }

  getSubtaskRunResultFromWorker(params: { workspaceId: string; sessionId: string; runId: string }) {
    const session = getAgentSession(this.ctx.db, params.sessionId);
    if (!session) throw new HttpError(404, "session not found");
    if (session.workspaceId !== params.workspaceId) throw new HttpError(400, "workspaceId mismatch");
    const run = getRunRecord(this.ctx.db, params.runId);
    if (!run || run.sessionId !== params.sessionId || run.workspaceId !== params.workspaceId) {
      throw new HttpError(404, "run not found");
    }

    const items = getSessionVisibleItems(this.ctx.db, params.workspaceId, params.sessionId)
      .filter((item) => item.runId === params.runId)
      .sort((a, b) => a.id - b.id);

    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i];
      if (!item) continue;
      if (item.kind === "assistant" && item.output.type === "assistant_text") {
        return { resultText: item.output.text || "" };
      }
      if (item.kind === "system" && item.output.type === "system_text") {
        return { resultText: item.output.text || "" };
      }
    }

    return { resultText: "" };
  }

  getSubtaskRunStatusFromWorker(params: { workspaceId: string; sessionId: string; runId: string }) {
    const session = getAgentSession(this.ctx.db, params.sessionId);
    if (!session) throw new HttpError(404, "session not found");
    if (session.workspaceId !== params.workspaceId) throw new HttpError(400, "workspaceId mismatch");
    const run = getRunRecord(this.ctx.db, params.runId);
    if (!run || run.sessionId !== params.sessionId || run.workspaceId !== params.workspaceId) {
      throw new HttpError(404, "run not found");
    }
    return {
      status: run.status
    };
  }

  getExecutionProfileForRun(params: { workspaceId: string; sessionId: string; runId: string }) {
    const session = getAgentSession(this.ctx.db, params.sessionId);
    if (!session) throw new HttpError(404, "session not found");
    if (session.workspaceId !== params.workspaceId) throw new HttpError(400, "workspaceId mismatch");

    const run = getRunRecord(this.ctx.db, params.runId);
    if (!run || run.sessionId !== params.sessionId || run.workspaceId !== params.workspaceId) {
      throw new HttpError(404, "run not found");
    }

    const profile = resolveExecutionProfile(this.ctx, {
      agentIdFromRun: run.agentId,
      providerIdFromRun: run.providerId,
      modelIdFromRun: run.modelId
    });

    const runtime = getAgentRuntimeSettings(this.ctx);

    return {
      resolved: {
        runId: params.runId,
        sessionId: params.sessionId,
        workspaceId: params.workspaceId,
        agentId: profile.agent.id,
        providerId: profile.provider.id,
        modelId: profile.model.id
      },
      agent: profile.agent,
      provider: profile.provider,
      model: profile.model,
      runtime
    };
  }

  getSingleCallModelProfileForRun(params: { workspaceId: string; sessionId: string; runId: string }) {
    const session = getAgentSession(this.ctx.db, params.sessionId);
    if (!session) throw new HttpError(404, "session not found");
    if (session.workspaceId !== params.workspaceId) throw new HttpError(400, "workspaceId mismatch");

    const run = getRunRecord(this.ctx.db, params.runId);
    if (!run || run.sessionId !== params.sessionId || run.workspaceId !== params.workspaceId) {
      throw new HttpError(404, "run not found");
    }

    const profile = resolveGlobalDefaultModelProfile(this.ctx);

    return {
      resolved: {
        runId: params.runId,
        sessionId: params.sessionId,
        workspaceId: params.workspaceId,
        providerId: profile.provider.id,
        modelId: profile.model.id,
        source: "global_default" as const
      },
      provider: profile.provider,
      model: profile.model
    };
  }

  getAgentMcpSettingsFromWorker() {
    return getAgentMcpSettings(this.ctx);
  }

  async compactContextFromWorker(params: {
    workspaceId: string;
    sessionId: string;
    runId: string;
    expectedHeadItemId: number | null;
    summaryText: string;
  }) {
    return this.runSessionOperationExclusive(params.sessionId, async () => {
      const session = getAgentSession(this.ctx.db, params.sessionId);
      if (!session) throw new HttpError(404, "session not found");
      if (session.workspaceId !== params.workspaceId) throw new HttpError(400, "workspaceId mismatch");
      const run = getRunRecord(this.ctx.db, params.runId);
      if (!run || run.workspaceId !== params.workspaceId || run.sessionId !== params.sessionId) {
        throw new HttpError(404, "run not found");
      }
      if (session.headItemId !== params.expectedHeadItemId) {
        throw new HttpError(409, "session head conflict");
      }

      const summaryText = String(params.summaryText || "").trim();
      if (!summaryText) {
        throw new HttpError(400, "summaryText is required", "AGENT_COMPACTION_SUMMARY_REQUIRED");
      }

      const visible = getSessionVisibleItems(this.ctx.db, params.workspaceId, params.sessionId);
      if (visible.length === 0) {
        return {
          compacted: false,
          summaryItemId: null,
          archivedCount: 0
        };
      }
      const nonTerminal = visible.filter((item) => !ARCHIVABLE_ITEM_STATUS.has(item.status));
      if (nonTerminal.length > 0) {
        return {
          compacted: false,
          summaryItemId: null,
          archivedCount: 0
        };
      }

      const createdAt = nowMs();
      const archiveLines = visible.map((item) => buildArchiveLine(item)).filter((line): line is string => line != null);
      const archiveSnapshots = await appendArchiveLines({
        dataDir: this.ctx.dataDir,
        workspaceId: params.workspaceId,
        sessionId: session.id,
        lines: archiveLines
      });

      const archiveAt = nowMs();
      let summaryItemId: number | null = null;
      let archivedCount = 0;
      try {
        const applied = appendSystemSummaryAndArchiveItems(this.ctx.db, {
          workspaceId: params.workspaceId,
          sessionId: params.sessionId,
          runId: params.runId,
          expectedHeadItemId: params.expectedHeadItemId,
          summaryText,
          boundaryReason: "compaction",
          summaryCreatedAt: createdAt,
          archiveItemIds: visible.map((item) => item.id),
          archiveAt
        });
        summaryItemId = applied.summaryItemId;
        archivedCount = applied.archivedCount;
      } catch (err) {
        const rollback = await rollbackArchiveLinesBestEffort(archiveSnapshots);
        if (rollback.skipped > 0) {
          this.logger.warn(
            {
              sessionId: session.id,
              runId: params.runId,
              revertedFiles: rollback.reverted,
              skippedFiles: rollback.skipped
            },
            "archive rollback had skipped files after compaction db failure"
          );
        }
        if (err instanceof AgentConflictError) throw conflictToHttpError(err);
        throw err;
      }

      const state = getRunState(this.ctx.db, params.workspaceId, params.sessionId);
      if (state.activeRunId === params.runId) {
        updateRunState(this.ctx.db, {
          workspaceId: params.workspaceId,
          sessionId: params.sessionId,
          status: state.status,
          activeRunId: state.activeRunId,
          activeAssistantItemId: state.activeAssistantItemId,
          waitingToolItemId: state.waitingToolItemId,
          lastResponseTotalTokens: null,
          updatedAt: archiveAt,
          appliedItemId: getLatestSessionItemId(this.ctx.db, params.workspaceId, params.sessionId)
        });
      }

      return {
        compacted: true,
        summaryItemId,
        archivedCount
      };
    });
  }

  async clearSession(sessionId: string, body: AgentClearSessionRequest): Promise<AgentControlResult> {
    return this.runSessionOperationExclusive(sessionId, async () => {
      const session = getAgentSession(this.ctx.db, sessionId);
      if (!session) throw new HttpError(404, "session not found");
      if (session.kind === "subtask") {
        throw new HttpError(400, "subtask session is read-only", "AGENT_SUBTASK_READONLY");
      }
      if (session.workspaceId !== body.workspaceId) {
        throw new HttpError(400, "workspaceId mismatch");
      }

      const runState = getRunState(this.ctx.db, session.workspaceId, session.id);
      if (runState.status !== "idle") {
        throw new HttpError(409, "session is running", "AGENT_CLEAR_NOT_IDLE");
      }

      const visible = getSessionVisibleItems(this.ctx.db, session.workspaceId, session.id);
      if (visible.length === 0) {
        throw new HttpError(400, "no context to clear", "AGENT_CLEAR_EMPTY");
      }
      if (visible.length === 1 && isBoundaryMarkerItem(visible[0]!)) {
        throw new HttpError(400, "clear not needed", "AGENT_CLEAR_NOT_NEEDED");
      }

      const nonTerminal = visible.filter((item) => !ARCHIVABLE_ITEM_STATUS.has(item.status));
      if (nonTerminal.length > 0) {
        throw new HttpError(409, "session has non-terminal items", "AGENT_CLEAR_NOT_IDLE");
      }

      const createdAt = nowMs();
      const archiveLines = visible.map((item) => buildArchiveLine(item)).filter((line): line is string => line != null);
      const archiveSnapshots = await appendArchiveLines({
        dataDir: this.ctx.dataDir,
        workspaceId: session.workspaceId,
        sessionId: session.id,
        lines: archiveLines
      });

      const archiveAt = nowMs();
      try {
        appendSystemSummaryAndArchiveItems(this.ctx.db, {
          workspaceId: session.workspaceId,
          sessionId: session.id,
          runId: null,
          expectedHeadItemId: session.headItemId,
          summaryText: buildClearSummaryText(body.reason),
          boundaryReason: "clear",
          summaryCreatedAt: createdAt,
          archiveItemIds: visible.map((item) => item.id),
          archiveAt
        });
        setRunStateIdle(this.ctx.db, {
          workspaceId: session.workspaceId,
          sessionId: session.id,
          updatedAt: archiveAt,
          appliedItemId: getLatestSessionItemId(this.ctx.db, session.workspaceId, session.id)
        });
      } catch (err) {
        const rollback = await rollbackArchiveLinesBestEffort(archiveSnapshots);
        if (rollback.skipped > 0) {
          this.logger.warn(
            {
              sessionId: session.id,
              revertedFiles: rollback.reverted,
              skippedFiles: rollback.skipped
            },
            "archive rollback had skipped files after clear db failure"
          );
        }
        if (err instanceof AgentConflictError) throw conflictToHttpError(err);
        throw err;
      }

      const headItemId = getSessionHead(this.ctx.db, session.workspaceId, session.id);
      return { sessionId: session.id, headItemId };
    });
  }

  async archiveSearchFromWorker(params: {
    workspaceId: string;
    sessionId: string;
    query: string;
    beforePos?: number;
    maxHits?: number;
    maxChars?: number;
    snippet?: boolean;
    regex?: boolean;
  }) {
    const session = getAgentSession(this.ctx.db, params.sessionId);
    if (!session) throw new HttpError(404, "session not found");
    if (session.workspaceId !== params.workspaceId) throw new HttpError(400, "workspaceId mismatch");
    const query = String(params.query || "").trim();
    if (!query) {
      throw new HttpError(400, "query is required", "AGENT_ARCHIVE_QUERY_REQUIRED");
    }
    const beforePos = normalizeBeforePos(params.beforePos);

    const maxHits = normalizePositiveInt(params.maxHits, {
      fallback: ARCHIVE_SEARCH_MAX_HITS_DEFAULT,
      min: 1,
      max: ARCHIVE_SEARCH_MAX_HITS_MAX
    });
    const maxChars = normalizePositiveInt(params.maxChars, {
      fallback: ARCHIVE_MAX_CHARS_DEFAULT,
      min: ARCHIVE_MAX_CHARS_MIN,
      max: ARCHIVE_MAX_CHARS_MAX
    });
    const snippet = params.snippet === true;

    const dirPath = agentArchiveSessionDir(this.ctx.dataDir, params.workspaceId, session.id);
    const files = await listArchiveFilesAsc(dirPath);
    if (files.length === 0) {
      return { text: "" };
    }

    const newestFirstLines: string[] = [];

    outer: for (let i = files.length - 1; i >= 0; i -= 1) {
      const fileName = files[i] || "";
      if (!fileName) continue;
      const fileSeq = parseArchiveFileName(fileName);
      if (fileSeq == null) continue;
      const filePath = path.join(dirPath, fileName);
      let matches: ArchiveSearchLineMatch[] = [];
      let offsetMatches: ArchiveSearchLineMatchWithOffsets[] = [];
      try {
        if (snippet) {
          offsetMatches = await rgSearchInFileWithOffsets({
            filePath,
            query,
            regex: params.regex === true
          });
          matches = offsetMatches.map((item) => ({ line: item.line, text: item.text }));
        } else {
          matches = await rgSearchInFile({
            filePath,
            query,
            regex: params.regex === true
          });
        }

        if (matches.length > 0) {
          const content = await fs.readFile(filePath, "utf-8").catch((err: any) => {
            if (err && err.code === "ENOENT") return "";
            throw err;
          });
          const stableLineCount = splitArchiveFileLines(content).length;
          matches = matches.filter((item) => item.line <= stableLineCount);
          if (snippet) {
            const keep = new Set(matches.map((item) => item.line));
            offsetMatches = offsetMatches.filter((item) => keep.has(item.line));
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new HttpError(400, `archive search failed: ${message}`, "AGENT_ARCHIVE_SEARCH_FAILED");
      }

      matches.sort((a, b) => b.line - a.line);
      const offsetsByLine = new Map<number, ArchiveSearchLineMatchWithOffsets>();
      if (snippet) {
        for (const item of offsetMatches) {
          if (!offsetsByLine.has(item.line)) {
            offsetsByLine.set(item.line, item);
          }
        }
      }
      for (const match of matches) {
        if (newestFirstLines.length >= maxHits) break outer;
        const pos = toArchivePos(fileSeq, match.line);
        if (beforePos != null && pos >= beforePos) continue;
        const outputLine = snippet
          ? buildArchiveSearchSnippetLine(offsetsByLine.get(match.line) || { ...match, submatches: [] })
          : match.text;
        newestFirstLines.push(`pos=${pos} | ${String(outputLine || "")}`);
      }
    }

    return { text: formatArchiveToolResultText(newestFirstLines, maxChars) };
  }

  async archiveReadFromWorker(params: {
    workspaceId: string;
    sessionId: string;
    beforePos?: number;
    lineCount?: number;
    maxChars?: number;
  }) {
    const session = getAgentSession(this.ctx.db, params.sessionId);
    if (!session) throw new HttpError(404, "session not found");
    if (session.workspaceId !== params.workspaceId) throw new HttpError(400, "workspaceId mismatch");
    const beforePos = normalizeBeforePos(params.beforePos);

    const lineCount = normalizePositiveInt(params.lineCount, {
      fallback: ARCHIVE_READ_LINE_COUNT_DEFAULT,
      min: 1,
      max: ARCHIVE_READ_LINE_COUNT_MAX
    });
    const maxChars = normalizePositiveInt(params.maxChars, {
      fallback: ARCHIVE_MAX_CHARS_DEFAULT,
      min: ARCHIVE_MAX_CHARS_MIN,
      max: ARCHIVE_MAX_CHARS_MAX
    });

    const dirPath = agentArchiveSessionDir(this.ctx.dataDir, params.workspaceId, session.id);
    const files = await listArchiveFilesAsc(dirPath);
    if (files.length === 0) {
      return { text: "" };
    }

    const newestFirstLines: string[] = [];

    outer: for (let i = files.length - 1; i >= 0; i -= 1) {
      const fileName = files[i] || "";
      if (!fileName) continue;
      const fileSeq = parseArchiveFileName(fileName);
      if (fileSeq == null) continue;
      const filePath = path.join(dirPath, fileName);
      const content = await fs.readFile(filePath, "utf-8").catch((err: any) => {
        if (err && err.code === "ENOENT") return "";
        throw err;
      });
      const lines = splitArchiveFileLines(content);
      let upper = lines.length;
      if (beforePos != null) {
        const maxLineExclusive = beforePos - (fileSeq - 1) * ARCHIVE_FILE_LINE_LIMIT;
        upper = Math.min(upper, Math.max(0, maxLineExclusive - 1));
      }
      for (let lineNo = upper; lineNo >= 1; lineNo -= 1) {
        if (newestFirstLines.length >= lineCount) break outer;
        const pos = toArchivePos(fileSeq, lineNo);
        if (beforePos != null && pos >= beforePos) continue;
        newestFirstLines.push(`pos=${pos} | ${String(lines[lineNo - 1] || "")}`);
      }
    }

    return { text: formatArchiveToolResultText(newestFirstLines, maxChars) };
  }

  async getPromptContextForRun(params: { workspaceId: string; sessionId: string; runId: string }) {
    const session = getAgentSession(this.ctx.db, params.sessionId);
    if (!session) throw new HttpError(404, "session not found");
    if (session.workspaceId !== params.workspaceId) throw new HttpError(400, "workspaceId mismatch");
    const workspace = this.ensureWorkspace(params.workspaceId);

    const run = getRunRecord(this.ctx.db, params.runId);
    if (!run || run.sessionId !== params.sessionId || run.workspaceId !== params.workspaceId) {
      throw new HttpError(404, "run not found");
    }

    const profile = resolveExecutionProfile(this.ctx, {
      agentIdFromRun: run.agentId,
      providerIdFromRun: run.providerId,
      modelIdFromRun: run.modelId
    });
    const globalPrompts = getAgentGlobalPromptSettings(this.ctx);
    const workspaceInstructions = await readWorkspaceAgentsInstructions(workspace.path, this.logger);
    const system = buildSystemPrompt({
      agentName: profile.agent.name,
      agentPrompt: profile.agent.prompt || "",
      agentGlobalPromptIds: Array.isArray(profile.agent.globalPromptIds) ? profile.agent.globalPromptIds : [],
      globalPrompts: globalPrompts.items,
      workspaceInstructions
    });

    const visible = getSessionVisibleItems(this.ctx.db, params.workspaceId, params.sessionId);
    const hasCompactionBoundaryMarker = visible.some((item) => {
      if (!item) return false;
      if (item.kind !== "system" || item.status !== "completed") return false;
      if (item.output.type !== "system_text") return false;
      const boundary = typeof item.boundaryReason === "string" ? item.boundaryReason.trim() : "";
      if (boundary !== "compaction") return false;
      return shouldIncludeSystemTextInPrompt(item.output.text);
    });
    const transcript = hasCompactionBoundaryMarker
      ? getSessionTranscriptItems(this.ctx.db, params.workspaceId, params.sessionId)
      : ([] as AgentContextItemRecord[]);
    const latestArchiveAt = hasCompactionBoundaryMarker
      ? transcript.reduce((max, item) => {
          if (typeof item.archiveAt !== "number" || !Number.isFinite(item.archiveAt)) return max;
          return Math.max(max, item.archiveAt);
        }, 0)
      : 0;
    const messages: PromptMessage[] = [];
    for (let i = 0; i < visible.length; i += 1) {
      const item = visible[i];
      if (!item) continue;

      if (item.kind === "user" && item.output.type === "user_text") {
        if (!item.output.text) continue;
        messages.push({ role: "user", content: item.output.text });
        continue;
      }

      if (item.kind === "system" && item.output.type === "system_text" && item.status === "completed") {
        if (!shouldIncludeSystemTextInPrompt(item.output.text)) continue;
        messages.push({ role: "system", content: item.output.text });

        // compaction: 在摘要后注入“压缩前尾部摘录”(归档原文 + archive 工具提示).
        const boundary = typeof item.boundaryReason === "string" ? item.boundaryReason.trim() : "";
        if (boundary === "compaction") {
          const summaryItemId = item.id;
          let snippetText = "";
          try {
            snippetText = await readCompactionSnippetCacheBestEffort({
              dataDir: this.ctx.dataDir,
              workspaceId: params.workspaceId,
              sessionId: params.sessionId,
              summaryItemId
            });
          } catch {
            snippetText = "";
          }

          if (!snippetText.trim()) {
            try {
              if (latestArchiveAt <= 0) {
                throw new Error("archive batch not found");
              }
              const batch = transcript.filter((t) => t.archiveAt === latestArchiveAt);
              // 归档会过滤“空 assistant(仅 tool-call)”,若直接按 item 取 tail 会导致最终 pos 行数偏少。
              // 这里先按“可归档行”过滤,确保 tail 的 10 条能映射到归档文件中的实际行。
              const batchArchivable = batch.filter((t) => buildArchiveLine(t) != null);
              const last10 = batchArchivable.slice(-10);
              const last4UserAssistant = batchArchivable
                .filter((t) => {
                  if (t.kind === "user" && t.output.type === "user_text") return String(t.output.text || "").trim().length > 0;
                  if (t.kind === "assistant" && t.output.type === "assistant_text") return String(t.output.text || "").trim().length > 0;
                  return false;
                })
                .slice(-4);

              const mergedIds: number[] = [];
              const seen = new Set<number>();
              for (const row of [...last4UserAssistant, ...last10]) {
                if (!row) continue;
                if (seen.has(row.id)) continue;
                seen.add(row.id);
                mergedIds.push(row.id);
              }

              const posLines = await buildCompactionSnippetExcerptLines({
                dataDir: this.ctx.dataDir,
                workspaceId: params.workspaceId,
                sessionId: params.sessionId,
                itemIds: mergedIds
              });

              if (posLines.length > 0) {
                const excerptLines: string[] = [];
                let prevPos = 0;
                for (const row of posLines) {
                  if (prevPos > 0 && row.pos !== prevPos + 1) {
                    excerptLines.push("...");
                  }
                  excerptLines.push(`pos=${row.pos} | ${row.line}`);
                  prevPos = row.pos;
                }
                const minPos = Math.min(...posLines.map((r) => r.pos));
                snippetText = buildCompactionSnippetMessageText({ excerptLines, minPos });
                await writeCompactionSnippetCacheBestEffort({
                  dataDir: this.ctx.dataDir,
                  workspaceId: params.workspaceId,
                  sessionId: params.sessionId,
                  summaryItemId,
                  text: snippetText,
                  logger: this.logger
                });
              }
            } catch (err) {
              this.logger.warn({ err, sessionId: params.sessionId }, "failed to build compaction snippet");
              snippetText = "";
            }
          }

          if (snippetText.trim()) {
            messages.push({ role: "system", content: snippetText });
          }
        }
        continue;
      }

      if (item.kind !== "assistant" || item.output.type !== "assistant_text" || item.status !== "completed") {
        continue;
      }

      const assistantParts: Array<PromptTextPart | PromptToolCallPart> = [];
      if (item.output.text) {
        assistantParts.push({ type: "text", text: item.output.text });
      }

      const toolResultParts: PromptToolResultPart[] = [];
      let cursor = i + 1;
      while (cursor < visible.length) {
        const toolItem = visible[cursor];
        if (!toolItem || toolItem.kind !== "tool") break;
        if (toolItem.runId !== item.runId || toolItem.turnId !== item.turnId || toolItem.step !== item.step) break;
        if (toolItem.output.type !== "tool" || !TERMINAL_TOOL_ITEM_STATUS.has(toolItem.status)) {
          cursor += 1;
          continue;
        }

        const toolCallId = typeof toolItem.output.toolCallId === "string" ? toolItem.output.toolCallId.trim() : "";
        if (!toolCallId) {
          cursor += 1;
          continue;
        }
        const toolInput = toolItem.output.args && typeof toolItem.output.args === "object" && !Array.isArray(toolItem.output.args)
          ? (toolItem.output.args as Record<string, unknown>)
          : {};
        const promptInput = projectToolCallInputForPrompt({
          toolName: toolItem.output.toolName,
          status: toolItem.status,
          args: toolInput
        });
        assistantParts.push({
          type: "tool-call",
          toolCallId,
          toolName: toolItem.output.toolName,
          input: promptInput
        });

        const promptToolText = resolveToolOutputText(toolItem.output).trim() || `status=${toolItem.status}`;
        const toolErrorText =
          typeof toolItem.output.error === "string" && toolItem.output.error.trim()
            ? toolItem.output.error
            : resolveToolOutputText(toolItem.output).trim() || `status=${toolItem.status}`;
        const toolOutput = toolItem.output.error
          ? { type: "error-text" as const, value: toolErrorText }
          : {
              type: "text" as const,
              value: promptToolText
            };
        toolResultParts.push({
          type: "tool-result",
          toolCallId,
          toolName: toolItem.output.toolName,
          output: toolOutput
        });
        cursor += 1;
      }

      if (assistantParts.length === 1 && assistantParts[0].type === "text") {
        messages.push({ role: "assistant", content: assistantParts[0].text });
      } else if (assistantParts.length > 0) {
        messages.push({ role: "assistant", content: assistantParts });
      }

      if (toolResultParts.length > 0) {
        messages.push({ role: "tool", content: toolResultParts });
      }

      i = cursor - 1;
    }

    const subtaskDescription = profile.agent.tools.includes("subtask")
      ? buildSubtaskToolDescription(
          getAgentSettings(this.ctx).agents.map((item) => ({
            id: item.id,
            name: item.name,
            summary: item.summary
          }))
        )
      : undefined;

    const hasArchivedItems = getSessionTranscriptItems(this.ctx.db, params.workspaceId, params.sessionId).some(
      (item) => item.archiveAt != null
    );
    const hasArchiveFiles =
      (await listArchiveFilesAsc(agentArchiveSessionDir(this.ctx.dataDir, params.workspaceId, session.id))).length > 0;
    const hasArchive = hasArchivedItems && hasArchiveFiles;
    const enabledToolNames = hasArchive
      ? profile.agent.tools
      : profile.agent.tools.filter((name) => name !== "archive_search" && name !== "archive_read");

    const tools = enabledToolNames.map((name) => {
      const requiresApproval =
        (name === "read" && !profile.agent.permissions.allowRead) ||
        (name === "write" && !profile.agent.permissions.allowWrite) ||
        (name === "apply_patch" && !profile.agent.permissions.allowWrite) ||
        (name === "bash" && !profile.agent.permissions.allowBash);
      return {
        name,
        description: toolDescription(name, { subtaskDescription }),
        inputSchema: toolArgsSchema(name),
        requiresApproval
      };
    });

    const pendingTools = visible
      .filter((item) => item.runId === params.runId && item.kind === "tool")
      .filter((item) => item.status === "queued" || item.status === "running" || item.status === "awaiting_permission")
      .map((item) => {
        if (item.output.type !== "tool") return null;
        return {
          itemId: item.id,
          status: item.status,
          toolName: item.output.toolName,
          toolCallId: item.output.toolCallId,
          args: item.output.args ?? {},
          approved: item.output.approved === true
        };
      })
      .filter((item): item is {
        itemId: number;
        status: AgentContextItemStatus;
        toolName: AgentContextToolName;
        toolCallId: string | undefined;
        args: Record<string, unknown>;
        approved: boolean;
      } => item !== null);

    const runState = getRunState(this.ctx.db, params.workspaceId, params.sessionId);
    return {
      headItemId: session.headItemId,
      system,
      messages,
      tools,
      pendingTools,
      lastResponseTotalTokens: runState.lastResponseTotalTokens
    };
  }

  private ensureWorkspace(workspaceId: string) {
    const workspace = getWorkspace(this.ctx.db, workspaceId);
    if (!workspace) throw new HttpError(404, "workspace not found");
    return workspace;
  }
}
