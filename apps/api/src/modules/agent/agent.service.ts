import type { FastifyBaseLogger } from "fastify";
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
  getSessionVisibleItems,
  getSessionVisibleItemsAfter,
  getVisibleItemById,
  insertClientRequestDedup,
  listAgentSessions,
  listNonTerminalVisibleItemIds,
  moveSessionHead,
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
  resolveExecutionProfile
} from "../settings/settings.service.js";
import { projectToolCallInputForPrompt, projectToolResultForPrompt } from "./prompt/tool-projectors/index.js";

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
        timeout: { type: "number", minimum: 1 }
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
        cursor: { type: "string", minLength: 1 },
        maxHits: { type: "number", minimum: 1 },
        maxChars: { type: "number", minimum: 1 },
        regex: { type: "boolean" }
      }
    };
  }
  if (toolName === "archive_read") {
    return {
      type: "object",
      required: ["file", "startLine"],
      additionalProperties: false,
      properties: {
        file: { type: "string", minLength: 1 },
        startLine: { type: "number", minimum: 1 },
        lineCount: { type: "number", minimum: 1 },
        maxChars: { type: "number", minimum: 1 }
      }
    };
  }
  if (toolName === "archive_tail") {
    return {
      type: "object",
      required: ["n"],
      additionalProperties: false,
      properties: {
        n: { type: "number", minimum: 1 },
        maxChars: { type: "number", minimum: 1 },
        cursor: { type: "string", minLength: 1 }
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
    return "执行一个 bash 命令并返回 stdout/stderr,支持 workdir/timeout 参数,默认 workdir 为工作区根目录,timeout 为 120000ms。";
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
    return "在当前会话归档日志中检索关键词。支持 cursor 继续向更早内容检索。";
  }
  if (toolName === "archive_read") {
    return "读取指定归档日志文件的行窗口,用于查看命中附近上下文。";
  }
  if (toolName === "archive_tail") {
    return "读取归档日志最新 n 行,支持 cursor 继续向更早内容读取。返回顺序为旧到新。";
  }
  if (toolName === "subtask") return options?.subtaskDescription || "在子会话中执行任务。";
  if (toolName.startsWith("mcp_")) return `调用 MCP 工具 ${toolName}`;
  return "写入工作区内文件并全量覆盖,作为确定性兜底工具,当需要直接重写完整内容或 patch 匹配不稳定时使用。";
}

function stringifyToolResult(raw: unknown) {
  if (typeof raw === "string") return raw;
  try {
    return JSON.stringify(raw, null, 2);
  } catch {
    return String(raw);
  }
}

function toSessionTitleFromFirstMessage(text: string) {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "新会话";
  if (compact.length <= 50) return compact;
  return `${compact.slice(0, 49)}…`;
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
const ARCHIVE_ROOT_RELATIVE_PATH = path.join(".awb", "agent", "archive");
const ARCHIVE_FILE_NAME_WIDTH = 8;
const ARCHIVE_FILE_LINE_LIMIT = 100;
const ARCHIVE_SEARCH_MAX_HITS_DEFAULT = 30;
const ARCHIVE_SEARCH_MAX_HITS_MAX = 100;
const ARCHIVE_SEARCH_MAX_CHARS_DEFAULT = 12_000;
const ARCHIVE_SEARCH_MAX_CHARS_MAX = 200_000;
const ARCHIVE_READ_LINE_COUNT_DEFAULT = 80;
const ARCHIVE_READ_LINE_COUNT_MAX = 300;
const ARCHIVE_READ_MAX_CHARS_DEFAULT = 20_000;
const ARCHIVE_READ_MAX_CHARS_MAX = 200_000;
const ARCHIVE_TAIL_N_DEFAULT = 80;
const ARCHIVE_TAIL_N_MAX = 500;
const ARCHIVE_TAIL_MAX_CHARS_DEFAULT = 20_000;
const ARCHIVE_TAIL_MAX_CHARS_MAX = 200_000;
const ARCHIVE_FILE_NAME_RE = /^\d{8}\.log$/;
const ARCHIVABLE_ITEM_STATUS = new Set<AgentContextItemStatus>(["completed", "failed", "denied", "cancelled"]);
const RUN_STATUS_SYSTEM_TEXT_PREFIX = "[run] ";

type ArchiveCursorPayload = {
  v: 1;
  mode: "search" | "tail";
  fileIndex: number;
  line: number;
};

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

function archiveSessionDir(workspacePath: string, sessionId: string) {
  return path.join(workspacePath, ARCHIVE_ROOT_RELATIVE_PATH, sessionId);
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

function encodeArchiveCursor(payload: ArchiveCursorPayload) {
  return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
}

function decodeArchiveCursor(raw: unknown, mode: ArchiveCursorPayload["mode"]): ArchiveCursorPayload | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf-8")) as Partial<ArchiveCursorPayload>;
    if (parsed.v !== 1) return null;
    if (parsed.mode !== mode) return null;
    const fileIndex = Number(parsed.fileIndex);
    const line = Number(parsed.line);
    if (!Number.isFinite(fileIndex) || !Number.isInteger(fileIndex) || fileIndex < 0) return null;
    if (!Number.isFinite(line) || !Number.isInteger(line) || line < 0) return null;
    return {
      v: 1,
      mode,
      fileIndex,
      line
    };
  } catch {
    return null;
  }
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

function splitArchiveFileLines(text: string) {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

async function appendArchiveLines(params: { workspacePath: string; sessionId: string; lines: string[] }) {
  if (params.lines.length === 0) return [] as ArchiveWriteSnapshot[];
  const dirPath = archiveSessionDir(params.workspacePath, params.sessionId);
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

async function hasMoreArchiveSearchHits(params: {
  dirPath: string;
  files: string[];
  query: string;
  regex: boolean;
  cursor: ArchiveCursorPayload;
}) {
  let fileIndex = params.cursor.fileIndex;
  let lineCursor = params.cursor.line;
  if (fileIndex >= params.files.length) {
    fileIndex = params.files.length - 1;
    lineCursor = Number.MAX_SAFE_INTEGER;
  }

  for (let i = fileIndex; i >= 0; i -= 1) {
    const fileName = params.files[i] || "";
    if (!fileName) continue;
    const filePath = path.join(params.dirPath, fileName);
    const matches = await rgSearchInFile({
      filePath,
      query: params.query,
      regex: params.regex
    });
    const upperExclusive = i === fileIndex ? Math.max(0, lineCursor) : Number.MAX_SAFE_INTEGER;
    for (const match of matches) {
      if (match.line >= upperExclusive) continue;
      return true;
    }
  }

  return false;
}

function shouldIncludeSystemTextInPrompt(text: string) {
  const normalized = String(text || "").trim();
  if (!normalized) return false;
  return !normalized.startsWith(RUN_STATUS_SYSTEM_TEXT_PREFIX);
}

async function rgSearchInFile(params: {
  filePath: string;
  query: string;
  regex: boolean;
}) {
  return await new Promise<Array<{ line: number; preview: string }>>((resolve, reject) => {
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
      const out: Array<{ line: number; preview: string }> = [];
      for (const raw of stdout.split(/\r?\n/)) {
        if (!raw) continue;
        const idx = raw.indexOf(":");
        if (idx <= 0) continue;
        const line = Number(raw.slice(0, idx));
        if (!Number.isFinite(line) || line < 1) continue;
        out.push({ line, preview: raw.slice(idx + 1) });
      }
      resolve(out);
    });
  });
}

function buildArchiveLine(item: AgentContextItemRecord) {
  let text = "";
  if (item.kind === "user" && item.output.type === "user_text") text = item.output.text || "";
  else if (item.kind === "assistant" && item.output.type === "assistant_text") text = item.output.text || "";
  else if (item.kind === "system" && item.output.type === "system_text") text = item.output.text || "";
  else if (item.kind === "tool" && item.output.type === "tool") {
    if (typeof item.output.error === "string" && item.output.error.trim()) {
      text = `[error] ${item.output.error}`;
    } else {
      text = stringifyToolResult(item.output.result);
    }
  }
  const toolName = item.kind === "tool" && item.output.type === "tool" ? String(item.output.toolName || "-") : "-";
  return `item=${item.id} ts=${item.createdAt} kind=${item.kind} status=${item.status} tool=${toolName} | ${sanitizeArchiveText(text)}`;
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
    | { type: "json"; value: unknown }
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

function buildSystemPrompt(input: {
  agentName: string;
  agentPrompt: string;
  agentGlobalPromptIds: string[];
  globalPrompts: Array<{ id: string; title: string; prompt: string }>;
  workspaceInstructions: { filePath: string; displayPath: string; content: string } | null;
}) {
  const agentPrompt = input.agentPrompt || "";
  const hasWorkspace = Boolean(input.workspaceInstructions?.content?.trim());
  const selectedGlobalIds = new Set(input.agentGlobalPromptIds);
  const hasGlobal = input.globalPrompts.some((item) => selectedGlobalIds.has(item.id) && item.prompt.trim());
  if (!hasWorkspace && !hasGlobal) {
    return agentPrompt;
  }

  const sections: string[] = [];

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
  constructor(private readonly ctx: AppContext, private readonly logger: FastifyBaseLogger) {}

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

  forkSession(params: AgentForkSessionRequest) {
    const fromSession = getAgentSession(this.ctx.db, params.fromSessionId);
    if (!fromSession) throw new HttpError(404, "source session not found");

    const visible = getSessionVisibleItems(this.ctx.db, fromSession.workspaceId, fromSession.id);
    const index = visible.findIndex((item) => item.id === params.fromItemId);
    if (index < 0) throw new HttpError(400, "invalid fromItemId");

    const createdAt = nowMs();
    const newSessionId = newSortableId("sess");
    const title = (params.title || `${fromSession.title} (fork)`).trim() || `${fromSession.title} (fork)`;
    const kind = params.kind === "subtask" ? "subtask" : "primary";

    const cloned = visible.slice(0, index + 1);
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
        const safeStatus = item.status === "streaming" || item.status === "queued" || item.status === "running" || item.status === "awaiting_permission" ? "completed" : item.status;
        const next = appendContextItem(this.ctx.db, {
          workspaceId: fromSession.workspaceId,
          sessionId: newSessionId,
          runId: null,
          turnId: null,
          step: null,
          prevId,
          kind: item.kind,
          status: safeStatus,
          output: item.output,
          createdAt: Math.max(createdAt, item.createdAt)
        });
        prevId = next.id;
      }
    });
    tx();

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

  getContextItems(sessionId: string, afterId?: number): AgentContextItemsResponse {
    const session = getAgentSession(this.ctx.db, sessionId);
    if (!session) throw new HttpError(404, "session not found");
    const items = afterId && afterId > 0 ? getSessionVisibleItemsAfter(this.ctx.db, session.workspaceId, session.id, afterId) : getSessionVisibleItems(this.ctx.db, session.workspaceId, session.id);
    const runState = getRunState(this.ctx.db, session.workspaceId, session.id);
    return {
      sessionId: session.id,
      headItemId: session.headItemId,
      appliedItemId: runState.appliedItemId,
      items
    };
  }

  getContextItem(sessionId: string, itemId: number) {
    const session = getAgentSession(this.ctx.db, sessionId);
    if (!session) throw new HttpError(404, "session not found");
    const item = getVisibleItemById(this.ctx.db, session.workspaceId, session.id, itemId);
    if (!item) throw new HttpError(404, "context item not found");
    return item;
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
    const target = getVisibleItemById(this.ctx.db, session.workspaceId, session.id, body.toItemId);
    if (!target) throw new HttpError(400, "toItemId is invalid");

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
          output: item.output,
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
      output: {
        ...output,
        error: "permission denied"
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

  updateContextItemFromWorker(params: {
    itemId: number;
    status?: AgentContextItemStatus;
    output?: AgentContextItemRecord["output"];
    updatedAt?: number;
  }) {
    const item = updateContextItem(this.ctx.db, {
      itemId: params.itemId,
      status: params.status,
      output: params.output,
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
    updateRunState(this.ctx.db, {
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      status: params.status,
      activeRunId: params.activeRunId,
      activeAssistantItemId: params.activeAssistantItemId,
      waitingToolItemId: params.waitingToolItemId,
      ...(hasLastResponseTotalTokens ? { lastResponseTotalTokens: params.lastResponseTotalTokens ?? null } : {}),
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

  startSubtaskRunFromWorker(params: {
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
        session = this.forkSession({
          fromSessionId: params.parentSessionId,
          fromItemId: anchor.prevId,
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

    const workspace = this.ensureWorkspace(params.workspaceId);
    const createdAt = nowMs();
    const archiveLines = visible.map((item) => buildArchiveLine(item));
    const archiveSnapshots = await appendArchiveLines({
      workspacePath: workspace.path,
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
  }

  async archiveSearchFromWorker(params: {
    workspaceId: string;
    sessionId: string;
    query: string;
    cursor?: string;
    maxHits?: number;
    maxChars?: number;
    regex?: boolean;
  }) {
    const session = getAgentSession(this.ctx.db, params.sessionId);
    if (!session) throw new HttpError(404, "session not found");
    if (session.workspaceId !== params.workspaceId) throw new HttpError(400, "workspaceId mismatch");
    const workspace = this.ensureWorkspace(params.workspaceId);
    const query = String(params.query || "").trim();
    if (!query) {
      throw new HttpError(400, "query is required", "AGENT_ARCHIVE_QUERY_REQUIRED");
    }

    const maxHits = normalizePositiveInt(params.maxHits, {
      fallback: ARCHIVE_SEARCH_MAX_HITS_DEFAULT,
      min: 1,
      max: ARCHIVE_SEARCH_MAX_HITS_MAX
    });
    const maxChars = normalizePositiveInt(params.maxChars, {
      fallback: ARCHIVE_SEARCH_MAX_CHARS_DEFAULT,
      min: 1,
      max: ARCHIVE_SEARCH_MAX_CHARS_MAX
    });

    const dirPath = archiveSessionDir(workspace.path, session.id);
    const files = await listArchiveFilesAsc(dirPath);
    if (files.length === 0) {
      return {
        hits: [] as Array<{ file: string; line: number; preview: string }>,
        nextCursor: null as string | null,
        hasMore: false,
        truncated: false
      };
    }

    const cursor = decodeArchiveCursor(params.cursor, "search");
    let fileIndex = files.length - 1;
    let lineCursor = Number.MAX_SAFE_INTEGER;
    if (cursor && cursor.fileIndex < files.length) {
      fileIndex = cursor.fileIndex;
      lineCursor = Math.max(0, cursor.line);
    }

    const hits: Array<{ file: string; line: number; preview: string }> = [];
    let chars = 0;
    let nextCursorPayload: ArchiveCursorPayload | null = null;

    outer: for (let i = fileIndex; i >= 0; i -= 1) {
      const fileName = files[i] || "";
      if (!fileName) continue;
      const filePath = path.join(dirPath, fileName);
      let matches: Array<{ line: number; preview: string }> = [];
      try {
        matches = await rgSearchInFile({
          filePath,
          query,
          regex: params.regex === true
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new HttpError(400, `archive search failed: ${message}`, "AGENT_ARCHIVE_SEARCH_FAILED");
      }

      matches.sort((a, b) => b.line - a.line);

      let upperExclusive = i === fileIndex ? lineCursor : Number.MAX_SAFE_INTEGER;
      let lastReturnedLine = upperExclusive;
      for (const match of matches) {
        if (match.line >= upperExclusive) continue;
        if (hits.length >= maxHits) {
          nextCursorPayload = { v: 1, mode: "search", fileIndex: i, line: lastReturnedLine };
          break outer;
        }

        let preview = String(match.preview || "");
        const remain = maxChars - chars;
        if (remain <= 0) {
          nextCursorPayload = { v: 1, mode: "search", fileIndex: i, line: lastReturnedLine };
          break outer;
        }
        if (preview.length > remain) {
          preview = preview.slice(0, remain);
        }

        hits.push({ file: fileName, line: match.line, preview });
        chars += preview.length;
        lastReturnedLine = match.line;
        upperExclusive = match.line;

        if (hits.length >= maxHits || chars >= maxChars) {
          nextCursorPayload = { v: 1, mode: "search", fileIndex: i, line: lastReturnedLine };
          break outer;
        }
      }
    }

    if (nextCursorPayload) {
      let hasMore = false;
      try {
        hasMore = await hasMoreArchiveSearchHits({
          dirPath,
          files,
          query,
          regex: params.regex === true,
          cursor: nextCursorPayload
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new HttpError(400, `archive search failed: ${message}`, "AGENT_ARCHIVE_SEARCH_FAILED");
      }
      if (!hasMore) {
        nextCursorPayload = null;
      }
    }

    const nextCursor = nextCursorPayload ? encodeArchiveCursor(nextCursorPayload) : null;

    return {
      hits,
      nextCursor,
      hasMore: nextCursor != null,
      truncated: nextCursor != null
    };
  }

  async archiveReadFromWorker(params: {
    workspaceId: string;
    sessionId: string;
    file: string;
    startLine: number;
    lineCount?: number;
    maxChars?: number;
  }) {
    const session = getAgentSession(this.ctx.db, params.sessionId);
    if (!session) throw new HttpError(404, "session not found");
    if (session.workspaceId !== params.workspaceId) throw new HttpError(400, "workspaceId mismatch");
    const workspace = this.ensureWorkspace(params.workspaceId);

    const fileName = String(params.file || "").trim();
    if (!ARCHIVE_FILE_NAME_RE.test(fileName)) {
      throw new HttpError(400, "invalid archive file", "AGENT_ARCHIVE_FILE_INVALID");
    }

    const startLine = normalizePositiveInt(params.startLine, { fallback: 1, min: 1, max: Number.MAX_SAFE_INTEGER });
    const lineCount = normalizePositiveInt(params.lineCount, {
      fallback: ARCHIVE_READ_LINE_COUNT_DEFAULT,
      min: 1,
      max: ARCHIVE_READ_LINE_COUNT_MAX
    });
    const maxChars = normalizePositiveInt(params.maxChars, {
      fallback: ARCHIVE_READ_MAX_CHARS_DEFAULT,
      min: 1,
      max: ARCHIVE_READ_MAX_CHARS_MAX
    });

    const filePath = path.join(archiveSessionDir(workspace.path, session.id), fileName);
    let content = "";
    try {
      content = await fs.readFile(filePath, "utf-8");
    } catch (err: any) {
      if (err && err.code === "ENOENT") {
        throw new HttpError(404, "archive file not found", "AGENT_ARCHIVE_FILE_NOT_FOUND");
      }
      throw err;
    }

    const allLines = splitArchiveFileLines(content);
    const lines: Array<{ line: number; text: string; truncated: boolean }> = [];
    let chars = 0;
    let truncated = false;
    for (let line = startLine; line <= allLines.length && lines.length < lineCount; line += 1) {
      const raw = String(allLines[line - 1] || "");
      const remain = maxChars - chars;
      if (remain <= 0) {
        truncated = true;
        break;
      }
      let text = raw;
      let lineTruncated = false;
      if (text.length > remain) {
        text = text.slice(0, remain);
        lineTruncated = true;
      }
      lines.push({ line, text, truncated: lineTruncated });
      chars += text.length;
      if (lineTruncated) {
        truncated = true;
        break;
      }
    }

    const consumedTo = lines.length > 0 ? (lines[lines.length - 1]?.line ?? startLine - 1) : startLine - 1;
    const hasMore = truncated || consumedTo < allLines.length;
    return {
      lines,
      nextStartLine: hasMore ? consumedTo + 1 : null,
      hasMore,
      truncated
    };
  }

  async archiveTailFromWorker(params: {
    workspaceId: string;
    sessionId: string;
    n: number;
    cursor?: string;
    maxChars?: number;
  }) {
    const session = getAgentSession(this.ctx.db, params.sessionId);
    if (!session) throw new HttpError(404, "session not found");
    if (session.workspaceId !== params.workspaceId) throw new HttpError(400, "workspaceId mismatch");
    const workspace = this.ensureWorkspace(params.workspaceId);

    const n = normalizePositiveInt(params.n, {
      fallback: ARCHIVE_TAIL_N_DEFAULT,
      min: 1,
      max: ARCHIVE_TAIL_N_MAX
    });
    const maxChars = normalizePositiveInt(params.maxChars, {
      fallback: ARCHIVE_TAIL_MAX_CHARS_DEFAULT,
      min: 1,
      max: ARCHIVE_TAIL_MAX_CHARS_MAX
    });

    const dirPath = archiveSessionDir(workspace.path, session.id);
    const files = await listArchiveFilesAsc(dirPath);
    if (files.length === 0) {
      return {
        lines: [] as Array<{ file: string; line: number; text: string }>,
        nextCursor: null as string | null,
        hasMore: false,
        truncated: false
      };
    }

    const cursor = decodeArchiveCursor(params.cursor, "tail");
    let fileIndex = files.length - 1;
    let lineLimitExclusive = Number.MAX_SAFE_INTEGER;
    if (cursor && cursor.fileIndex < files.length) {
      fileIndex = cursor.fileIndex;
      lineLimitExclusive = cursor.line;
    }

    const newestFirst: Array<{ file: string; line: number; text: string }> = [];
    let chars = 0;
    let nextCursor: string | null = null;

    outer: for (let i = fileIndex; i >= 0; i -= 1) {
      const fileName = files[i] || "";
      if (!fileName) continue;
      const filePath = path.join(dirPath, fileName);
      const content = await fs.readFile(filePath, "utf-8").catch((err: any) => {
        if (err && err.code === "ENOENT") return "";
        throw err;
      });
      const lines = splitArchiveFileLines(content);
      const upper = i === fileIndex ? Math.min(lines.length, Math.max(0, lineLimitExclusive - 1)) : lines.length;
      for (let lineNo = upper; lineNo >= 1; lineNo -= 1) {
        if (newestFirst.length >= n) {
          nextCursor = encodeArchiveCursor({ v: 1, mode: "tail", fileIndex: i, line: lineNo + 1 });
          break outer;
        }
        const raw = String(lines[lineNo - 1] || "");
        const remain = maxChars - chars;
        if (remain <= 0) {
          nextCursor = encodeArchiveCursor({ v: 1, mode: "tail", fileIndex: i, line: lineNo + 1 });
          break outer;
        }
        let text = raw;
        if (text.length > remain) {
          text = text.slice(0, remain);
          newestFirst.push({ file: fileName, line: lineNo, text });
          chars += text.length;
          nextCursor = encodeArchiveCursor({ v: 1, mode: "tail", fileIndex: i, line: lineNo });
          break outer;
        }
        newestFirst.push({ file: fileName, line: lineNo, text });
        chars += text.length;
      }
    }

    return {
      lines: newestFirst.reverse(),
      nextCursor,
      hasMore: nextCursor != null,
      truncated: nextCursor != null
    };
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

        const rawToolResult = toolItem.output.result !== undefined ? toolItem.output.result : { status: toolItem.status };
        const promptToolResult = projectToolResultForPrompt({
          toolName: toolItem.output.toolName,
          status: toolItem.status,
          result: rawToolResult
        });
        const toolOutput = toolItem.output.error
          ? { type: "error-text" as const, value: toolItem.output.error }
          : {
              type: "json" as const,
              value: promptToolResult
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

    const tools = profile.agent.tools.map((name) => {
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
