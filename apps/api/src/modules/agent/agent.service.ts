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
  AgentClearSessionRequest,
  AgentCompactSessionRequest,
  AgentCompactSessionResponse,
  AgentRevertSessionRequest,
  AgentRunStatus,
  AgentUiLocale,
  AgentSendMessageRequest,
  AgentSendMessageResponse,
  AgentSessionRecord,
  AgentSessionRunState,
  AgentContextToolName,
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
  getLatestTerminalRunRecord,
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
  listNonTerminalSessionItemIds,
  hasNonTerminalSessionItems,
  listNonTerminalRunIdsByItemIds,
  listNonTerminalRunIdsBySession,
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
  AGENT_GLOBAL_SYSTEM_PROMPT_ID,
  getAgentRuntimeSettings,
  registerGlobalSystemPromptTextProvider,
  getAgentSettings,
  listAvailableAgentsForSurface,
  resolveGlobalDefaultModelProfile,
  resolveExecutionProfile
} from "../settings/settings.service.js";
import { projectToolCallInputForPrompt } from "./prompt/tool-projectors/index.js";
import { listPluginRuntimeSnapshots } from "../plugins/plugin.service.js";

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
          description: "Timeout in seconds (integer). Default is 120. Note: the unit is seconds, not milliseconds."
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
        limit: {
          type: "number",
          minimum: 1,
          maximum: 2000,
          default: 500,
          description: "Maximum lines (file) or entries (directory) to return. Default: 500. Maximum: 2000."
        }
      }
    };
  }
  if (toolName === "apply_patch") {
    return {
      type: "object",
      required: ["patchText"],
      additionalProperties: false,
      properties: {
        patchText: {
          type: "string",
          minLength: 1,
          description: [
            "patchText must be a git unified diff text containing lines such as diff --git/---/+++/@@.",
            "Supported: modify/add/delete text files, multi-file diffs, multiple @@ hunks in one file, and rename/move operations (including rename-only).",
            "Not supported: binary patches (GIT binary patch), submodules, copy from/to, or other advanced metadata.",
            "Constraints: text only; paths must stay inside the current directory and symlink/out-of-workspace paths are rejected; new files must not overwrite existing paths.",
            "Failure hint: if the patch fails to apply due to context mismatch, regenerate the diff from the current directory or include more context lines (for example, git diff -U5)."
          ].join("\n")
        }
      }
    };
  }
  if (toolName === "todolist") {
    return {
      type: "object",
      required: ["goal", "todos"],
      additionalProperties: false,
      properties: {
        goal: { type: "string", minLength: 1 },
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
  if (toolName === "note") {
    return {
      type: "object",
      required: ["content"],
      additionalProperties: false,
      properties: {
        content: {
          type: "string",
          maxLength: 200,
          description: "A short note to record. Suggested <= 200 characters."
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
          description: "Briefly describe the task goal in 20 characters or fewer."
        },
        prompt: {
          type: "string",
          minLength: 1,
          description: "Detailed instructions for the subtask. Clearly describe the input scope, constraints, and expected output format."
        },
        agentId: {
          type: "string",
          minLength: 1,
          description: "The agent ID that should execute the subtask."
        },
        session: {
          description: "The session strategy for the subtask.",
          oneOf: [
            {
              type: "object",
              required: ["mode"],
              additionalProperties: false,
              properties: {
                mode: { const: "new" }
              },
              description: "new: start from scratch, or use when the subtask needs independent thinking."
            },
            {
              type: "object",
              required: ["mode", "sessionId"],
              additionalProperties: false,
              properties: {
                mode: { const: "existing" },
                sessionId: { type: "string", minLength: 1 }
              },
              description: "existing: continue based on an existing subtask session to reuse prior work."
            },
            {
              type: "object",
              required: ["mode"],
              additionalProperties: false,
              properties: {
                mode: { const: "fork" }
              },
              description: "fork: use when the subtask needs the full parent-session context and the prompt alone is not sufficient."
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
    "Run the task in a subtask session and bring the result back to the parent session.",
    "Recommended use cases:",
    "- Preserve parent-session context quality: handle noisy or long-running work in a subtask first, then return only the distilled useful information.",
    "- Focus on results instead of process: keep only the conclusion and key evidence in the parent session.",
    "- Divide complex work: use only for tasks that are genuinely complex or can be parallelized; avoid splitting simple tasks because it adds coordination cost.",
    "",
    "Guidance for choosing session.mode:",
    "- new: start from scratch, or use when independent thinking is needed.",
    "  Example: use new for web research when starting fresh is useful, or for code review when independent thinking is preferred.",
    "- fork: use when the full parent-session context is needed and the prompt alone cannot express it adequately.",
    "- existing: continue from an existing subtask session to avoid repeating work.",
    "",
    "Result: on success, returns subtaskSessionId and the subtask result text."
  ];

  const normalizedAgents = agentItems
    .map((item) => ({
      id: String(item.id || "").trim(),
      name: String(item.name || "").trim(),
      summary: String(item.summary || "").trim()
    }))
    .filter((item) => item.id.length > 0 && item.name.length > 0);

  if (normalizedAgents.length === 0) {
    return `${header.join("\n")}\n\nAvailable agents:\n- No agents are currently available`;
  }

  const lines = normalizedAgents.map((item) =>
    item.summary ? `- ${item.id}: ${item.name} - ${item.summary}` : `- ${item.id}: ${item.name}`
  );
  return `${header.join("\n")}\n\nAvailable agents:\n${lines.join("\n")}`;
}

function toolDescription(toolName: AgentContextToolName, options?: { subtaskDescription?: string }) {
  if (toolName === "bash") {
    return [
      "Run a bash command and return stdout/stderr.",
      "Internally equivalent to: bash -lc <command>",
      "",
      "Arguments:",
      "- command: Required string. Provide the exact command to run. Do not pass an array, and do not wrap it in bash -lc again.",
      "- workdir: Optional working directory. Prefer leaving it unset (the current directory is the default). If needed, prefer a relative path inside the current directory rather than an absolute path such as /workspace.",
      "- timeout: Optional timeout in seconds (integer). Default: 120.",
      "  Note: timeout is measured in seconds, not milliseconds. Do not pass values such as 120000.",
      "",
      "Guidance:",
      "- Prefer operating inside the current directory, and prefer relative paths when possible.",
      "",
      "Examples:",
      "- {\"command\":\"pwd\"}",
      "- {\"command\":\"pwd && ls -la\"}",
      "- {\"command\":\"rg -n \\\"TODO\\\" .\",\"workdir\":\"apps/api\"}"
    ].join("\n");
  }
  if (toolName === "read") {
    return [
      "Read a directory or UTF-8 text file inside the current directory. Supports offset/limit pagination, truncates very long lines, and caps output at 50KB. Non-text and special file types are not supported.",
      "When reading a file, offset is the starting line number. When reading a directory, offset is the starting entry number. Both are 1-based.",
      "When continuing to read the same file or directory, use the offset explicitly returned by the previous read result instead of guessing the next offset yourself.",
      "If the result says End of file, the file has no more content to read. Do not continue paging the same file unless it changes.",
      "If the requested offset exceeds the file length, the tool returns an end-of-file notice instead of failing."
    ].join(" ");
  }
  if (toolName === "apply_patch") {
    return [
      "Apply a git unified diff (text) to update files inside the current directory. Best for minimal edits and coordinated multi-file changes.",
      "",
      "Format:",
      "- patchText must be a standard git diff / unified diff text containing lines such as diff --git, ---, +++, and @@.",
      "",
      "Supported:",
      "- Multi-file diffs",
      "- Multiple @@ hunks in a single file",
      "- Add file: --- /dev/null +++ b/<path>",
      "- Delete file: --- a/<path> +++ /dev/null",
      "- rename/move: rename from / rename to (supports rename-only and rename+modify)",
      "",
      "Constraints:",
       "- Text only; binary patches (GIT binary patch) and submodules are not supported.",
       "- Paths must stay inside the current directory; symlink and out-of-workspace paths are rejected.",
       "- New files must not overwrite existing paths.",
       "- To reduce the risk of a batch failure caused by syntax errors or context mismatches, prefer splitting unrelated edits into multiple smaller apply_patch calls. If those calls are independent, they may be executed in parallel. If changes are tightly coupled or need atomicity, keep them in a single patch.",
       "",
       "Example (minimal update):",
       "diff --git a/src/foo.txt b/src/foo.txt",
       "index 1111111..2222222 100644",
       "--- a/src/foo.txt",
       "+++ b/src/foo.txt",
       "@@ -1,1 +1,1 @@",
       "-old",
       "+new",
       "",
       "Example (multiple hunks in one file):",
       "diff --git a/src/foo.txt b/src/foo.txt",
       "index 1111111..3333333 100644",
       "--- a/src/foo.txt",
       "+++ b/src/foo.txt",
       "@@ -1,2 +1,2 @@",
       "-alpha",
       "+alpha-1",
       " beta",
       "@@ -5,2 +5,2 @@",
       "-gamma",
       "+gamma-1",
       " delta",
       "",
       "Example (add file):",
       "diff --git a/src/new-file.txt b/src/new-file.txt",
       "new file mode 100644",
       "--- /dev/null",
       "+++ b/src/new-file.txt",
       "@@ -0,0 +1,2 @@",
       "+hello",
       "+world",
       "",
       "Example (multi-file diff):",
       "diff --git a/src/a.txt b/src/a.txt",
       "index 1111111..2222222 100644",
       "--- a/src/a.txt",
       "+++ b/src/a.txt",
       "@@ -1,1 +1,1 @@",
       "-old-a",
       "+new-a",
       "diff --git a/src/b.txt b/src/b.txt",
       "index 3333333..4444444 100644",
       "--- a/src/b.txt",
       "+++ b/src/b.txt",
       "@@ -1,1 +1,1 @@",
       "-old-b",
       "+new-b",
       "",
       "Example (rename/move):",
       "diff --git a/src/old-name.txt b/src/new-name.txt",
       "similarity index 100%",
       "rename from src/old-name.txt",
       "rename to src/new-name.txt"
     ].join("\n");
    }
    if (toolName === "todolist") {
     return [
       "Use this management tool to maintain a task list and execution progress. It is shown to the user and also helps enforce planned execution.",
       "",
        "Quick self-check (skip todolist if any condition is met):",
        "- If your planned work has 3 steps or fewer; or",
        "- If you expect to need 10 tool calls or fewer to complete the request;",
        "you may skip todolist and proceed directly.",
       "Otherwise, for longer, more complex, or uncertain work, you must use todolist: first present the task list, then begin execution.",
        "",
        "Usage rules:",
       "- Express the overall objective with goal; goal is required and states what the current task list is serving.",
       "- Keep goal short; 50 characters or fewer is recommended. Longer values may be truncated at runtime.",
       "- Submit the full todos array on every call; the semantics are full replacement, not an incremental patch.",
       "- If goal or the task list changes, submit the full goal + todos as the latest state.",
       "- Todos are ordered by priority from top to bottom: plan first, then execute, and prioritize earlier items.",
       "- Allowed task statuses are: pending | in_progress | completed | cancelled.",
       "- Multiple in_progress items are allowed, but keep the number of active tasks realistic and manageable.",
      "- Each todo must include:",
      "  - content: a non-empty string (it must remain non-empty after trim)",
      "  - status: one of the allowed enum values above",
      "- Update the list immediately whenever task status changes, including but not limited to:",
      "  - Starting a task (pending -> in_progress)",
      "  - Completing a task (-> completed)",
      "  - Cancelling / no longer needing a task (-> cancelled)",
      "  - Discovering omissions, splitting, merging, rolling back, or adding tasks (structural changes also require an update)",
       "- Goal: keep the user seeing a clear, trustworthy, real-time progress view, and enforce traceable, priority-driven execution instead of unplanned expansion.",
        "",
        "Example input:",
        "{\"goal\":\"Complete the todolist goal enhancement\",\"todos\":[{\"content\":\"Review requirements and constraints\",\"status\":\"completed\"},{\"content\":\"Implement core logic\",\"status\":\"in_progress\"},{\"content\":\"Add tests and verification\",\"status\":\"pending\"}]}"
      ].join("\n");
    }
    if (toolName === "note") {
      return [
        "Record a short note into the runtime session state as persistent working memory.",
        "",
        "Arguments:",
        "- content: Required string. Suggested <= 200 characters.",
        "",
        "Example input:",
        "{\"content\":\"Plan: read agent.service.ts to find tool registry\"}"
      ].join("\n");
    }
  if (toolName === "archive_search") {
    return (
      "Search the current session archive log for keywords and return plain-text lines sorted from oldest to newest, each prefixed with pos." +
      " By default, full lines are returned; if snippet=true, matched windows are returned instead." +
      " Use beforePos to continue reading older hits." +
      " Hint: you can also search archive metadata fields directly, such as kind/status/tool/item/ts." +
      " Example (full lines, find the latest 5 user or assistant messages): {\"query\":\"kind=(user|assistant)\",\"regex\":true,\"maxHits\":5}" +
      " Example (too many hits, limit first and then page): {\"query\":\"timeout\",\"snippet\":true,\"maxHits\":10,\"maxChars\":3000} Then page with beforePos=<pos>."
    );
  }
  if (toolName === "archive_read") {
    return "Read the most recent lines from the archive log and return plain-text lines sorted from oldest to newest, each prefixed with pos. Use beforePos to restrict the read to older content only.";
  }
  if (toolName === "subtask") return options?.subtaskDescription || "Execute a task in a subtask session.";
  if (toolName.startsWith("mcp_")) return `Call MCP tool ${toolName}`;
  return "Write and fully overwrite a file inside the current directory. Use this as a deterministic fallback when you need to rewrite the whole file or when patch matching is unstable.";
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
      ? `Wrote file ${filePath}`
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

function buildToolText(params: {
  toolName: string;
  status: "running" | "completed" | "failed" | "cancelled";
  headers?: Array<[string, string | undefined]>;
  body?: string;
}) {
  const lines: string[] = [`tool: ${params.toolName}`, `status: ${params.status}`];
  for (const [key, value] of params.headers ?? []) {
    if (value == null || !String(value).trim()) continue;
    lines.push(`${key}: ${String(value).trim()}`);
  }
  lines.push("");
  const body = typeof params.body === "string" ? params.body : "";
  if (body) lines.push(body);
  return lines.join("\n");
}

function parseSubtaskSessionIdFromToolText(text: unknown) {
  if (typeof text !== "string") return "";
  const match = text.match(/(?:^|\n)subtask_session_id:\s*([^\s]+)/);
  return match ? String(match[1] || "").trim() : "";
}

function toTerminalSubtaskCancelledOutput(output: AgentContextItemRecord["output"]) {
  if (!output || output.type !== "tool" || output.toolName !== "subtask") return output;

  const resultObj = output.result && typeof output.result === "object" ? (output.result as Record<string, unknown>) : null;
  const fromResult = typeof resultObj?.subtaskSessionId === "string" ? resultObj.subtaskSessionId.trim() : "";
  const fromText = parseSubtaskSessionIdFromToolText((output as { text?: unknown }).text);
  const subtaskSessionId = fromResult || fromText;

  const body = subtaskSessionId
    ? `Subtask was cancelled. To continue it later, call subtask with session: { mode: "existing", sessionId: "${subtaskSessionId}" }.`
    : "Subtask was cancelled.";

  const nextResult = resultObj
    ? {
        ...resultObj,
        ...(subtaskSessionId && !fromResult ? { subtaskSessionId } : {})
      }
    : output.result;

  return {
    ...output,
    text: buildToolText({
      toolName: "subtask",
      status: "cancelled",
      headers: [["subtask_session_id", subtaskSessionId || undefined]],
      body
    }),
    ...(nextResult !== output.result ? { result: nextResult } : {})
  } as AgentContextItemRecord["output"];
}

function toTerminalCancelledOutput(output: AgentContextItemRecord["output"]) {
  // cancelSession: 只在终态收尾时做最小必要的输出规整。
  // - write: 瘦身 args.content
  // - subtask: 明确 cancelled，并保留 subtask_session_id + 复用提示
  const writeNormalized = toTerminalWriteOutput(output);
  return toTerminalSubtaskCancelledOutput(writeNormalized);
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

function normalizeAgentUiLocale(value: unknown): AgentUiLocale | null {
  const raw = String(value || "").trim();
  if (raw === "zh-CN" || raw === "en-US") return raw;
  return null;
}

function formatRuntimeDateTime(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function buildOutputFormatInstruction(input: { uiLocale: AgentUiLocale | null }) {
  if (input.uiLocale !== "zh-CN") {
    return [
      "Output format requirements:",
      "- Prefer Markdown in responses when it improves readability.",
      "- When appropriate, prefer headings, lists, tables, blockquotes, inline code, code blocks, and links.",
      "- For comparisons, parameter descriptions, or option differences, prefer tables.",
      "- For commands, code, configuration, or log snippets, prefer fenced code blocks.",
      "- When useful for flows or relationships, Mermaid fenced code blocks may be used.",
      "- Do not rely on images, embedded HTML, task list checkboxes, or mathematical formulas.",
      "- If Markdown would reduce clarity, use plain text instead."
    ].join("\n");
  }

  return [
    "输出格式要求：",
    "- 回复时优先使用 Markdown，以提升可读性。",
    "- 在合适时优先使用标题、列表、表格、引用、行内代码、代码块和链接。",
    "- 对比信息、参数说明、选项差异等内容，优先使用表格展示。",
    "- 命令、代码、配置、日志片段应优先使用 fenced code block。",
    "- 需要表达流程或关系图时，可使用 Mermaid fenced code block。",
    "- 不要依赖图片、内嵌 HTML、任务列表复选框或数学公式等格式。",
    "- 如果 Markdown 会降低表达清晰度，则直接使用纯文本。"
  ].join("\n");
}

function buildRuntimeInstruction(input: { uiLocale: AgentUiLocale | null; now: Date }) {
  const timeText = formatRuntimeDateTime(input.now);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const lines: string[] = [];
  const pushGroup = (group: string[]) => {
    if (!group.length) return;
    if (lines.length) lines.push("");
    lines.push(...group);
  };

  if (input.uiLocale === "zh-CN") {
    pushGroup([
      "语言要求：本轮对话请统一使用简体中文。",
      "对用户的回答使用简体中文。",
      "内部思考/推理文本使用简体中文。",
      "若调用 todolist，其中的 goal 与 todos[].content 必须使用简体中文。",
      "代码、命令、路径、接口名、配置键名、报错原文等需要保真的内容可保持原样，不必翻译。"
    ]);
    pushGroup([
      `当前系统时间：${timeText}`,
      `当前时区：${timeZone}`
    ]);
  } else {
    if (input.uiLocale === "en-US") {
      pushGroup([
        "Language requirement: use English consistently for this run.",
        "Respond to the user in English.",
        "Use English for internal reasoning/thought text.",
        "If you call todolist, the goal and todos[].content must also be in English.",
        "Code, commands, paths, API names, config keys, and original error messages may remain verbatim when needed."
      ]);
    }
    pushGroup([
      `Current system time: ${timeText}`,
      `Time zone: ${timeZone}`
    ]);
  }
  return lines.join("\n");
}

function normalizeTodolistGoal(value: unknown) {
  if (typeof value !== "string") return "";
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return toSessionTitleFromFirstMessage(compact);
}

function buildClearSummaryText(input: { uiLocale: AgentUiLocale | null; reason?: string }) {
  const uiLocale = normalizeAgentUiLocale(input.uiLocale);
  const rawReason = typeof input.reason === "string" ? input.reason.trim() : "";
  const normalizedReason = rawReason.length > 200 ? `${rawReason.slice(0, 200)}...` : rawReason;
  if (uiLocale !== "zh-CN") {
    if (!normalizedReason) {
      return "A new task has started. Previous context has been archived; use archive_search or archive_read if you need to recall earlier decisions.";
    }
    return `A new task has started (${normalizedReason}). Previous context has been archived; use archive_search or archive_read if you need to recall earlier decisions.`;
  }

  if (!normalizedReason) {
    return "已开始新任务。之前的上下文已归档,如需回忆历史决策请使用 archive_search 或 archive_read。";
  }
  return `已开始新任务(${normalizedReason})。之前的上下文已归档,如需回忆历史决策请使用 archive_search 或 archive_read。`;
}

const NON_TERMINAL_ITEM_STATUS = new Set<AgentContextItemStatus>([
  "streaming",
  "queued",
  "running",
]);

const TERMINAL_TOOL_ITEM_STATUS = new Set<AgentContextItemStatus>([
  "completed",
  "failed",
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
const ARCHIVABLE_ITEM_STATUS = new Set<AgentContextItemStatus>(["completed", "failed", "cancelled"]);
const RUN_STATUS_SYSTEM_TEXT_PREFIX = "[run] ";
const COMPACTION_SNIPPET_CACHE_MAX_BYTES = 256 * 1024;
function buildSubtaskForkGuardSystemText(input: { uiLocale: AgentUiLocale | null }) {
  if (normalizeAgentUiLocale(input.uiLocale) !== "zh-CN") {
    return [
      "You are working in a subtask session derived from a parent session.",
      "All history before this system message was copied from the parent session and is provided only as background context; it does not constitute direct execution instructions for this subtask session.",
      "Only user messages that appear after this system message should be treated as the instructions you must follow in this subtask session.",
      "You may reference earlier history for background, constraints, clues, and evidence, but do not treat prior action requests as commands to execute now; in particular, do not continue prior meta-instructions such as calling subtask again, delegating to another agent, or continuing work that was directed at a previous assistant.",
      "If earlier history conflicts with user messages that appear after this system message, follow the later user messages."
    ].join("\n");
  }

  return [
    "你正在一个由主会话派生出的子任务会话中工作。",
    "在本条系统消息之前的全部历史内容，均来自父会话复制，仅作为背景信息，不构成对你的直接执行指令。",
    "只有本条系统消息之后出现的用户消息，才构成你在此子任务会话中应当遵循的任务指令。",
    "你可以参考此前历史中的背景、约束、线索和证据，但不要把其中的行动要求当作当前待执行命令；尤其不要继续执行其中关于“调用 subtask”“转交给其他 agent”“继续让助手做某事”等元指令。",
    "若此前历史与本条系统消息之后的用户消息不一致，以本条系统消息之后的用户消息为准。"
  ].join("\n");
}

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
  uiLocale: AgentUiLocale | null;
}) {
  const body = params.excerptLines.join("\n");
  if (normalizeAgentUiLocale(params.uiLocale) !== "zh-CN") {
    return [
      "## Pre-compaction tail excerpt (archived original text; pos can be used as archive_read beforePos)",
      "",
      body,
      "",
      "## Archive tool hints (when you need more context)",
      "",
      "- You can use archive_read to continue reading earlier archived lines:",
      `  - Start from an earlier position: use beforePos=${params.minPos}`,
      "  - Read more lines: increase lineCount",
      "- You can use archive_search to search across all archived content by keyword:",
      "  - Prefer specific nouns for query (file names / function names / error codes / tool names / key phrases)",
      "  - If there are too many hits, combine it with beforePos to page backward"
    ].join("\n");
  }

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

async function appendArchiveLines(params: {
  dataDir: string;
  workspaceId: string;
  sessionId: string;
  lines: string[];
  failAfterChunks?: number;
}) {
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
  let writtenChunks = 0;
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
      writtenChunks += 1;
      if (typeof params.failAfterChunks === "number" && Number.isFinite(params.failAfterChunks) && writtenChunks >= params.failAfterChunks) {
        const err = new Error("injected archive write failure");
        (err as Error & { code?: string }).code = "TEST_ARCHIVE_WRITE_FAIL";
        throw err;
      }
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

## 并发工具调用(强制默认)

**总规则(必须遵守)**
- 默认策略: 能并发就并发。若你计划调用 ≥2 次工具,且这些调用互不依赖对方输出,必须合并为一次并发调用(一次提交多个 tool calls)。
- 违规判定: 若出现连续两次工具调用,且第二次不依赖第一次的输出,视为一次可避免的串行(除非满足例外条件)。

**每次调用工具前的 10 秒自检**
1) 列出接下来最可能要做的 2-5 个工具调用(例如: todolist、rg、read 多个文件)。
2) 标注依赖关系: 哪些调用必须等前一个结果才能确定参数/文件路径。
3) 将所有“无依赖”的调用合并并发执行;只保留真正有依赖的步骤串行。

**并发常用模板(优先使用)**
- 启动阶段(边计划边调研): todolist 应尽量与一次初始检索/目录概览并发(例如 rg/ls/read README)。
- 命中多文件后: 一次 rg 命中多个相关文件后,下一步不要逐个 read;应并发 read 3-8 个最关键文件(超过则分批并发),再汇总判断。
- 多个互不依赖的搜索: 多关键词/多目录的 rg 可以并发跑;不要一个个试。

**例外(允许串行)**
- 参数依赖: 必须先 rg 才知道要读哪些文件/行号。
- 输出风险: 并发会导致输出过大触发截断,影响定位(此时减少并发数量或分批并发)。
- 资源/副作用: 写文件/跑测试等可能相互干扰的操作,需要串行保证确定性。

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

registerGlobalSystemPromptTextProvider(() => GLOBAL_WORKFLOW_SYSTEM_PROMPT);

function buildSystemPrompt(input: {
  agentName: string;
  agentPrompt: string;
  agentGlobalPromptIds: string[];
  outputFormatInstruction?: string;
  globalPrompts: Array<{ id: string; title: string; prompt: string }>;
  runtimeInstruction?: string;
  workspaceInstructions: { filePath: string; displayPath: string; content: string } | null;
}) {
  const agentPrompt = input.agentPrompt || "";
  const selectedGlobalIds = new Set(input.agentGlobalPromptIds);
  const outputFormatInstruction = String(input.outputFormatInstruction || "").trim();
  const runtimeInstruction = String(input.runtimeInstruction || "").trim();

  const formatSection = (kind: string, body: string, label?: string) => {
    const normalizedBody = String(body || "").trim();
    if (!normalizedBody) return "";
    const normalizedLabel = typeof label === "string" ? label.trim() : "";
    const prefix = normalizedLabel ? `[${kind}] ${normalizedLabel}` : `[${kind}]`;
    return `${prefix}\n\n${normalizedBody}`;
  };

  const sections: string[] = [];
  const systemBase = input.globalPrompts.find((item) => item.id === AGENT_GLOBAL_SYSTEM_PROMPT_ID)?.prompt?.trim() || GLOBAL_WORKFLOW_SYSTEM_PROMPT.trim();
  sections.push(formatSection("system_base", systemBase));

  for (const item of input.globalPrompts) {
    if (!selectedGlobalIds.has(item.id)) continue;
    if (!item.prompt.trim()) continue;
    if (item.id === AGENT_GLOBAL_SYSTEM_PROMPT_ID) continue;
    sections.push(formatSection("global_prompt", item.prompt, item.title));
  }

  if (input.workspaceInstructions?.content.trim()) {
    sections.push(formatSection("workspace_instructions", input.workspaceInstructions.content, input.workspaceInstructions.displayPath));
  }

  if (agentPrompt.trim()) {
    sections.push(formatSection("agent_prompt", agentPrompt, input.agentName));
  }

  if (outputFormatInstruction) {
    sections.push(formatSection("output_format_instructions", outputFormatInstruction));
  }

  if (runtimeInstruction) {
    sections.push(formatSection("runtime_constraints", runtimeInstruction));
  }

  return sections.filter(Boolean).join("\n\n---\n");
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

  async forkSession(params: AgentForkSessionRequest & { allowAnyKindBoundary?: boolean }) {
    const fromSession = getAgentSession(this.ctx.db, params.fromSessionId);
    if (!fromSession) throw new HttpError(404, "source session not found");

    const transcript = getSessionTranscriptItems(this.ctx.db, fromSession.workspaceId, fromSession.id);
    const targetIndex = transcript.findIndex((item) => item.id === params.fromItemId);
    if (targetIndex < 0) throw new HttpError(400, "invalid fromItemId");
    const target = transcript[targetIndex];
    if (!target) throw new HttpError(400, "invalid fromItemId");
    if (params.allowAnyKindBoundary !== true && target.kind !== "user" && target.kind !== "assistant") {
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
          item.status === "streaming" || item.status === "queued" || item.status === "running" ? "completed"
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
            lines: archiveLines,
            failAfterChunks: this.ctx.agentTestFaults?.archiveWrite?.failAfterChunks
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
      surface: "user",
      requestedAgentId: params.body.agentId
    });

    const createdAt = nowMs();
    const uiLocale = normalizeAgentUiLocale(params.body.uiLocale);
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
          uiLocale,
          status: "running",
          createdAt
        });

        updateRunState(this.ctx.db, {
          workspaceId: session.workspaceId,
          sessionId: session.id,
          status: "running",
          activeRunId: runId,
          activeAssistantItemId: null,
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
          ok: true,
          session,
          runState: this.getRunState(session.id),
          runId: dedup.runId,
          scheduled: false,
          skippedReason: "deduplicated"
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
        surface: "user",
        requestedAgentId: params.body.agentId
      });

      const createdAt = nowMs();
      const runId = newSortableId("run");
      const uiLocale = normalizeAgentUiLocale(params.body.uiLocale);

      const tx = this.ctx.db.transaction(() => {
        createRunRecord(this.ctx.db, {
          runId,
          workspaceId: session.workspaceId,
          sessionId: session.id,
          triggerItemId: triggerItemId,
          agentId: profile.agent.id,
          providerId: profile.provider.id,
          modelId: profile.model.id,
          uiLocale,
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
          // 立即给 UI 一个反馈,避免等待 worker 拉取状态.
          runNoticeText: "正在压缩上下文...",
          updatedAt: createdAt,
          appliedItemId: getLatestSessionItemId(this.ctx.db, session.workspaceId, session.id)
        });
      });
      tx();

      return {
        ok: true,
        session,
        runState: this.getRunState(session.id),
        runId,
        scheduled: true
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
    const latestTerminalRun = getLatestTerminalRunRecord(this.ctx.db, { workspaceId: session.workspaceId, sessionId: session.id });
    const lastTerminalStatus =
      latestTerminalRun && state.status === "idle" && latestTerminalRun.updatedAt === state.updatedAt ? latestTerminalRun.status : null;
    const nonTerminalItemIds = listNonTerminalVisibleItemIds(this.ctx.db, session.workspaceId, session.id);
    return {
      sessionId: session.id,
      status: state.status,
      activeRunId: state.activeRunId,
      activeAssistantItemId: state.activeAssistantItemId,
      lastResponseTotalTokens: state.lastResponseTotalTokens,
      runNoticeText: state.runNoticeText,
      nonTerminalItemIds,
      updatedAt: state.updatedAt,
      lastTerminalStatus,
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
    const target = getTranscriptItemById(this.ctx.db, session.workspaceId, session.id, body.itemId);
    if (!target) throw new HttpError(400, "itemId is invalid");
    if (target.archiveAt != null) {
      throw new HttpError(400, "itemId is archived", "AGENT_ARCHIVED_ITEM_IMMUTABLE");
    }

    const state = getRunState(this.ctx.db, session.workspaceId, session.id);
    if (state.status !== "idle") {
      throw new HttpError(409, "session is running", "AGENT_REVERT_NOT_IDLE");
    }
    if (hasNonTerminalSessionItems(this.ctx.db, session.workspaceId, session.id)) {
      throw new HttpError(409, "session has non-terminal items", "AGENT_REVERT_HAS_NON_TERMINAL_ITEMS");
    }

    const createdAt = nowMs();
    const tx = this.ctx.db.transaction(() => {
      moveSessionHead(this.ctx.db, {
        workspaceId: session.workspaceId,
        sessionId: session.id,
        expectedHeadItemId: session.headItemId,
        nextHeadItemId: body.itemId,
        updatedAt: createdAt
      });
    });
    try {
      tx();
    } catch (err) {
      if (err instanceof AgentConflictError) throw conflictToHttpError(err);
      if (err instanceof Error && err.message === "invalid target head item") {
        throw new HttpError(400, "itemId is invalid");
      }
      throw err;
    }

    const updated = getAgentSession(this.ctx.db, session.id);
    if (!updated) throw new HttpError(500, "session not found after revert");
    return { ok: true, session: updated, runState: this.getRunState(updated.id) };
  }

  cancelSession(sessionId: string, body: AgentCancelSessionRequest): AgentControlResult {
    const session = getAgentSession(this.ctx.db, sessionId);
    if (!session) throw new HttpError(404, "session not found");
    if (session.workspaceId !== body.workspaceId) throw new HttpError(400, "workspaceId mismatch");

    const state = getRunState(this.ctx.db, session.workspaceId, session.id);
    const createdAt = nowMs();

    const tx = this.ctx.db.transaction(() => {
      const allItemIds = new Set<number>();
      for (const itemId of listNonTerminalSessionItemIds(this.ctx.db, session.workspaceId, session.id)) {
        allItemIds.add(itemId);
      }

      const relatedRunIds = new Set<string>(listNonTerminalRunIdsBySession(this.ctx.db, {
        workspaceId: session.workspaceId,
        sessionId: session.id
      }));
      for (const runId of listNonTerminalRunIdsByItemIds(this.ctx.db, {
        workspaceId: session.workspaceId,
        sessionId: session.id,
        itemIds: Array.from(allItemIds)
      })) {
        relatedRunIds.add(runId);
      }

      for (const itemId of allItemIds) {
        const item = getContextItemById(this.ctx.db, itemId);
        if (!item || !NON_TERMINAL_ITEM_STATUS.has(item.status)) continue;
        updateContextItem(this.ctx.db, {
          itemId,
          status: "cancelled",
          output: toTerminalCancelledOutput(item.output),
          updatedAt: createdAt
        });
      }

      setRunStateIdle(this.ctx.db, {
        workspaceId: session.workspaceId,
        sessionId: session.id,
        updatedAt: createdAt,
        appliedItemId: getLatestSessionItemId(this.ctx.db, session.workspaceId, session.id)
      });
      for (const runId of relatedRunIds) {
        updateRunRecordStatus(this.ctx.db, {
          runId,
          status: "cancelled",
          updatedAt: createdAt
        });
      }
      if (state.activeRunId && !relatedRunIds.has(state.activeRunId)) {
        updateRunRecordStatus(this.ctx.db, { runId: state.activeRunId, status: "cancelled", updatedAt: createdAt });
      }
    });

    tx();
    const updated = getAgentSession(this.ctx.db, session.id);
    if (!updated) throw new HttpError(500, "session not found after cancel");
    return { ok: true, session: updated, runState: this.getRunState(updated.id) };
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
    const createdAt = params.createdAt ?? nowMs();
    try {
      const item = appendContextItem(this.ctx.db, {
        workspaceId: params.workspaceId,
        sessionId: params.sessionId,
        runId: params.runId,
        turnId: params.turnId,
        step: params.step,
        prevId: params.prevId,
        kind: params.kind,
        status: params.status,
        output: params.output,
        createdAt
      });
      if (item.kind === "tool" && item.status === "completed" && item.output.type === "tool" && item.output.toolName === "todolist") {
        const resultObj = item.output.result && typeof item.output.result === "object"
          ? item.output.result as Record<string, unknown>
          : null;
        const goal = normalizeTodolistGoal(resultObj?.goal);
        if (goal) {
          updateAgentSessionTitle(this.ctx.db, { sessionId: item.sessionId, title: goal, updatedAt: createdAt });
        }
      }
      return item;
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
    const isWriteTerminalStatus = nextStatus === "completed" || nextStatus === "failed" || nextStatus === "cancelled";

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

    const updatedAt = params.updatedAt ?? nowMs();
    const item = updateContextItem(this.ctx.db, {
      itemId: params.itemId,
      status: params.status,
      output: nextOutput,
      updatedAt
    });
    if (!item) throw new HttpError(404, "context item not found");
    if (
      item.kind === "tool" &&
      item.status === "completed" &&
      item.output.type === "tool" &&
      item.output.toolName === "todolist"
    ) {
      const resultObj = item.output.result && typeof item.output.result === "object"
        ? item.output.result as Record<string, unknown>
        : null;
      const goal = normalizeTodolistGoal(resultObj?.goal);
      if (goal) {
        updateAgentSessionTitle(this.ctx.db, {
          sessionId: item.sessionId,
          title: goal,
          updatedAt
        });
      }
    }
    return item;
  }

  updateRunStateFromWorker(params: {
    workspaceId: string;
    sessionId: string;
    status: AgentRunStatus;
    activeRunId: string | null;
    activeAssistantItemId: number | null;
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
        status: "running",
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
    const parentUiLocale = normalizeAgentUiLocale(parentRun.uiLocale);

    const anchor = getContextItemById(this.ctx.db, params.parentToolItemId);
    if (!anchor || anchor.sessionId !== params.parentSessionId || anchor.workspaceId !== params.workspaceId || anchor.kind !== "tool") {
      throw new HttpError(400, "invalid subtask anchor");
    }
    if (anchor.runId !== params.parentRunId) {
      throw new HttpError(400, "invalid subtask anchor run", "AGENT_SUBTASK_ANCHOR_RUN_MISMATCH");
    }
    if (anchor.output.type !== "tool" || anchor.output.toolName !== "subtask") {
      throw new HttpError(400, "invalid subtask anchor", "AGENT_SUBTASK_ANCHOR_INVALID");
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
    const forkBoundaryItemId = params.session.mode === "fork"
      ? this.resolveSubtaskForkBoundaryItemId({
          workspaceId: params.workspaceId,
          sessionId: params.parentSessionId,
          anchor
        })
      : null;

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
      if (forkBoundaryItemId == null) {
        session = this.createSession({
          workspaceId: params.workspaceId,
          title: `${subtaskTitleBase} (fork)`,
          kind: "subtask"
        });
      } else {
        session = await this.forkSession({
          fromSessionId: params.parentSessionId,
          fromItemId: forkBoundaryItemId,
          mode: "visible_only",
          title: `${subtaskTitleBase} (fork)`,
          kind: "subtask",
          allowAnyKindBoundary: true
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
      surface: "subtask",
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
      let head = getSessionHead(this.ctx.db, session.workspaceId, session.id);
      if (params.session.mode === "fork") {
        const systemItem = appendContextItem(this.ctx.db, {
          workspaceId: session.workspaceId,
          sessionId: session.id,
          runId: null,
          turnId: null,
          step: null,
          prevId: head,
          kind: "system",
          status: "completed",
          output: {
            type: "system_text",
            text: buildSubtaskForkGuardSystemText({ uiLocale: parentUiLocale })
          },
          createdAt
        });
        head = systemItem.id;
      }
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
        uiLocale: parentUiLocale,
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

  private resolveSubtaskForkBoundaryItemId(params: {
    workspaceId: string;
    sessionId: string;
    anchor: AgentContextItemRecord;
  }) {
    let cursorId = params.anchor.prevId;
    while (cursorId != null) {
      const item = getContextItemById(this.ctx.db, cursorId);
      if (!item || item.workspaceId !== params.workspaceId || item.sessionId !== params.sessionId) {
        throw new HttpError(400, "invalid subtask fork boundary", "AGENT_SUBTASK_FORK_BOUNDARY_INVALID");
      }
      if (
        item.kind === "assistant"
        && item.runId === params.anchor.runId
        && item.turnId === params.anchor.turnId
        && item.step === params.anchor.step
      ) {
        return item.prevId;
      }
      cursorId = item.prevId;
    }
    return null;
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
      if (item.kind === "assistant" && item.output.type === "assistant_text" && String(item.output.text || "").trim()) {
        // 失败 assistant 在超过重试次数后也返回其 partial text,错误由 run status 承载。
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
      surface: session.kind === "subtask" ? "subtask" : "user",
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
      // profile.agent 现已包含 pluginTools，共享契约扩展不改变当前执行逻辑。
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

  async getPluginRuntimeSnapshotsFromWorker() {
    return listPluginRuntimeSnapshots(this.ctx);
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

  async clearSession(sessionId: string, body: AgentClearSessionRequest & { uiLocale?: AgentUiLocale | null }): Promise<AgentControlResult> {
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
          summaryText: buildClearSummaryText({ uiLocale: normalizeAgentUiLocale(body.uiLocale), reason: body.reason }),
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

      const updated = getAgentSession(this.ctx.db, session.id);
      if (!updated) throw new HttpError(500, "session not found after clear");
      return { ok: true, session: updated, runState: this.getRunState(updated.id) };
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

  private async buildPromptMessagesForSession(params: {
    workspaceId: string;
    sessionId: string;
    // 仅 prompt-context 需要 locale 用于 compaction snippet 文案。
    compactionSnippetUiLocale: AgentUiLocale | null;
  }) {
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
    let mostRecentFailedAssistantId: number | null = null;
    const assistantHasToolItems = new Set<number>();
    for (let i = visible.length - 1; i >= 0; i -= 1) {
      const item = visible[i];
      if (!item) continue;
      if (mostRecentFailedAssistantId == null && item.kind === "assistant" && item.output.type === "assistant_text" && item.status === "failed") {
        mostRecentFailedAssistantId = item.id;
      }
      if (item.kind !== "tool") continue;
      for (let j = i - 1; j >= 0; j -= 1) {
        const prev = visible[j];
        if (!prev) continue;
        if (prev.kind !== "assistant") continue;
        if (prev.runId === item.runId && prev.turnId === item.turnId && prev.step === item.step) {
          assistantHasToolItems.add(prev.id);
          break;
        }
      }
    }
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
              // 这里先按“可归档行”过滤,确保 tail 的 20 条能映射到归档文件中的实际行。
              const batchArchivable = batch.filter((t) => buildArchiveLine(t) != null);
              const last20 = batchArchivable.slice(-20);
              const last10UserAssistantSystem = batchArchivable
                .filter((t) => {
                  if (t.kind === "user" && t.output.type === "user_text") return String(t.output.text || "").trim().length > 0;
                  if (t.kind === "assistant" && t.output.type === "assistant_text") return String(t.output.text || "").trim().length > 0;
                  if (t.kind === "system" && t.output.type === "system_text") {
                    const text = String(t.output.text || "").trim();
                    if (!text) return false;
                    // 与 prompt 构造保持一致: 排除 [run] 开头的运行状态系统消息。
                    return shouldIncludeSystemTextInPrompt(text);
                  }
                  return false;
                })
                .slice(-10);

              const mergedIds: number[] = [];
              const seen = new Set<number>();
              for (const row of [...last10UserAssistantSystem, ...last20]) {
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
                snippetText = buildCompactionSnippetMessageText({
                  excerptLines,
                  minPos,
                  uiLocale: params.compactionSnippetUiLocale
                });
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

      const includeFailedAssistant =
        item.kind === "assistant" &&
        item.output.type === "assistant_text" &&
        item.status === "failed" &&
        item.id === mostRecentFailedAssistantId &&
        !assistantHasToolItems.has(item.id) &&
        String(item.output.text || "").trim().length > 0;

      if (item.kind !== "assistant" || item.output.type !== "assistant_text" || (item.status !== "completed" && !includeFailedAssistant)) {
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
        const toolInput =
          toolItem.output.args && typeof toolItem.output.args === "object" && !Array.isArray(toolItem.output.args)
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
          : { type: "text" as const, value: promptToolText };
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

      if (!includeFailedAssistant && toolResultParts.length > 0) {
        messages.push({ role: "tool", content: toolResultParts });
      }

      i = cursor - 1;
    }

    return { messages, visible };
  }

  async getMessagesContext(params: {
    workspaceId: string;
    sessionId: string;
    appendMessage?: { role: "system" | "user"; content: string };
  }) {
    const session = getAgentSession(this.ctx.db, params.sessionId);
    if (!session) throw new HttpError(404, "session not found");
    if (session.workspaceId !== params.workspaceId) throw new HttpError(400, "workspaceId mismatch");

    const { messages } = await this.buildPromptMessagesForSession({
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      // messages-context 是通用 messages 视图，不应隐式依赖 active run 的 uiLocale；此处固定为 null。
      compactionSnippetUiLocale: null
    });
    if (params.appendMessage && params.appendMessage.content.trim()) {
      messages.push({ role: params.appendMessage.role, content: params.appendMessage.content });
    }
    return { headItemId: session.headItemId, messages };
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
      surface: session.kind === "subtask" ? "subtask" : "user",
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
      outputFormatInstruction: buildOutputFormatInstruction({ uiLocale: run.uiLocale }),
      workspaceInstructions,
      runtimeInstruction: buildRuntimeInstruction({ uiLocale: run.uiLocale, now: new Date() })
    });

    const visible = getSessionVisibleItems(this.ctx.db, params.workspaceId, params.sessionId);
    const { messages } = await this.buildPromptMessagesForSession({
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      compactionSnippetUiLocale: normalizeAgentUiLocale(run.uiLocale)
    });

    const hasArchivedItems = getSessionTranscriptItems(this.ctx.db, params.workspaceId, params.sessionId).some(
      (item) => item.archiveAt != null
      );
    const hasArchiveFiles =
      (await listArchiveFilesAsc(agentArchiveSessionDir(this.ctx.dataDir, params.workspaceId, session.id))).length > 0;
    const hasArchive = hasArchivedItems && hasArchiveFiles;
    let enabledToolNames = hasArchive
      ? [...profile.agent.tools]
      : profile.agent.tools.filter((name) => name !== "archive_search" && name !== "archive_read");
    if (session.kind === "subtask") {
      enabledToolNames = enabledToolNames.filter((name) => name !== "subtask");
    }

    const subtaskDescription = enabledToolNames.includes("subtask")
      ? buildSubtaskToolDescription(
          listAvailableAgentsForSurface(this.ctx, "subtask").map((item) => ({
            id: item.id,
            name: item.name,
            summary: item.summary
          }))
        )
      : undefined;

    const tools = enabledToolNames.map((name) => {
      return {
        name,
        description: toolDescription(name, { subtaskDescription }),
        inputSchema: toolArgsSchema(name)
      };
    });

    const pendingTools = visible
      .filter((item) => item.runId === params.runId && item.kind === "tool")
      .filter((item) => item.status === "queued" || item.status === "running")
      .map((item) => {
        if (item.output.type !== "tool") return null;
        return {
          itemId: item.id,
          status: item.status,
          toolName: item.output.toolName,
          toolCallId: item.output.toolCallId,
          args: item.output.args ?? {}
        };
      })
      .filter((item): item is {
        itemId: number;
        status: AgentContextItemStatus;
        toolName: AgentContextToolName;
        toolCallId: string | undefined;
        args: Record<string, unknown>;
      } => item !== null);

    const runState = getRunState(this.ctx.db, params.workspaceId, params.sessionId);
    return {
      headItemId: session.headItemId,
      system,
      messages,
      tools,
      pendingTools,
      lastResponseTotalTokens: runState.lastResponseTotalTokens,
      uiLocale: normalizeAgentUiLocale(run.uiLocale)
    };
  }

  private ensureWorkspace(workspaceId: string) {
    const workspace = getWorkspace(this.ctx.db, workspaceId);
    if (!workspace) throw new HttpError(404, "workspace not found");
    return workspace;
  }
}
