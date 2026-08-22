import type { FastifyBaseLogger } from "fastify";
import fs from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import type {
  AgentCancelSessionRequest,
  AgentContextItemRecord,
  AgentContextItemStatus,
  AgentContextItemOutput,
  AgentContextItemsResponse,
  AgentControlResult,
  AgentForkSessionRequest,
  AgentClearSessionRequest,
  AgentCompactSessionRequest,
  AgentCompactSessionResponse,
  AgentRevertSessionRequest,
  AgentUiLocale,
  AgentSendMessageRequest,
  AgentSendMessageResponse,
  AgentSessionRecord,
  AgentSessionRunState,
  AgentContextToolName,
  AgentRecentSessionsResponse,
  AgentRecentWorkspacesResponse,
} from "@agent-workbench/shared";
import { isValidSkillPathSegment } from "@agent-workbench/shared";
import { getPromptText, renderPromptTemplateFile } from "@agent-workbench/shared/prompts";
import { AgentSubtaskErrorCode } from "@agent-workbench/shared/internal-contracts/agent-api";
import type {
  AgentApiCreateContextItemRequest,
  AgentApiUpdateContextItemRequest,
  AgentApiCompactContextRequest,
  AgentApiSubtaskPreforkPlanRequest,
  AgentApiSubtaskStartRequest,
  AgentApiSubtaskResultRequest,
  AgentApiSubtaskStatusRequest,
  AgentApiRunCompleteRequest,
  AgentApiRunStateRequest
} from "@agent-workbench/shared/internal-contracts/agent-api";
import { HttpError } from "../../app/errors.js";

import type { AppContext } from "../../app/context.js";
import { nowMs } from "../../utils/time.js";
import { newSortableId } from "../../utils/ids.js";
import { getWorkspace, listRecentWorkspaces } from "../workspaces/workspace.store.js";
import { listEnabledWorkspaceAgentsInstructions, listEnabledWorkspaceExternalSkillRoots } from "../workspaces/workspace.service.js";
import {
  agentArchiveSessionDir,
} from "../../infra/fs/paths.js";
import {
  AgentConflictError,
  appendContextItem,
  appendContextItemWithRunFence,
  getContextItemForWorkerUpdate,
  updateContextItemWithRunFence,
  createAgentSession,
  createRunRecord,
  findClientRequestDedup,
  findSubtaskRunByParentTool,
  getAgentSession,
  getContextItemById,
  getLatestCompletedAssistantTextByRunId,
  getLatestRunUiLocaleBySession,
  getLatestRunUiLocaleGlobal,
  getLatestTerminalAssistantTextByRunId,
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
  listRecentSessionsAcrossWorkspaces,
  listNonTerminalVisibleItemIds,
  listNonTerminalSessionItemIds,
  listNonTerminalSessionItemIdsByRunId,
  hasNonTerminalSessionItems,
  listNonTerminalRunIdsByItemIds,
  listNonTerminalRunIdsBySession,
  moveSessionHead,
  setContextItemsArchiveAt,
  setRunStateIdle,
  updateContextItem,
  updateRunRecordStatus,
  updateAgentSessionTitle,
  updateRunState
} from "./agent.store.js";
import {
  getAgentGlobalPromptSettings,
  getAgentMcpSettings,
  AGENT_GLOBAL_SYSTEM_PROMPT_ID,
  getAgentRuntimeSettings,
  registerGlobalSystemPromptTextProvider,
  getAgentSettings,
  listAvailableAgentsForSurface,
  getAgentChannelSenderAllowlistSettings,
  resolveExecutionProfile
} from "../settings/settings.service.js";
import { projectToolCallInputForPrompt } from "./prompt/tool-projectors/index.js";
import { listPluginRuntimeSnapshots } from "../plugins/plugin.service.js";
import { parseSkillFrontmatter, scanReadableTopLevelSkills } from "./top-level-skill.js";
import type { AgentRunCompletedEventHub } from "./run-completed-events.js";
import { getAgentWorkspaceRunContext } from "./agent-run-context.js";
import { RunLifecycleApplication } from "./lifecycle/run-lifecycle-application.js";
import { SqliteRunLifecyclePersistence } from "./lifecycle/sqlite-run-lifecycle-persistence.js";
import { RunPromptStaticCache, RunPromptStaticCacheInvalidator } from "./prompt/run-prompt-static-cache.js";
import { PromptStaticAssembler } from "./prompt/prompt-static-assembler.js";
import { ExecutionProfileResolver } from "./read-side/execution-profile-resolver.js";
import { MessagesContextProjector } from "./read-side/messages-context-projector.js";
import { PromptContextProjector } from "./read-side/prompt-context-projector.js";
import { ReadSideApplication } from "./read-side/read-side-application.js";
import { getWorkspaceEnabledAgentIds } from "../workspaces/workspace.service.js";
import { ContextWritebackApplication } from "./writeback/context-writeback-application.js";
import { UiArtifactCapability } from "./artifact/ui-artifact-capability.js";
import { SubtaskApplication } from "./subtask/subtask-application.js";
import {
  isSubtaskParentToolUniqueConstraintError,
  SqliteSubtaskLineagePersistence
} from "./subtask/sqlite-subtask-lineage-persistence.js";
import { SqliteSubtaskMaintenancePersistence } from "./subtask/sqlite-subtask-maintenance-persistence.js";
import { SqliteSubtaskRunQuery } from "./subtask/sqlite-subtask-run-query.js";
import type {
  CleanupSubtaskOrphansOnStartupCommand,
  SubtaskApplicationDependencies,
} from "./subtask/subtask-ports.js";
import type { AgentRuntimePort } from "./agent.runtime-port.js";
import { ArchiveStorage } from "./archive/archive-storage.js";
import { SqliteCompactionArchivePersistence } from "./archive/sqlite-compaction-archive-persistence.js";
import { CompactionArchiveApplication } from "./compaction/compaction-archive-application.js";
import { ManualCompactionApplication } from "./compaction/manual-compaction-application.js";
import type { ManualCompactionRuntime } from "./compaction/manual-compaction-ports.js";
import { ArchiveReadApplication } from "./archive/archive-read-application.js";
import { ArchiveReadStorage } from "./archive/archive-read-storage.js";
import { CompactionSnippetCache } from "./archive/compaction-snippet-cache.js";

type AgentCancelCascadeResult = {
  result: AgentControlResult;
  runtimeCancelSessionIds: string[];
};

function conflictToHttpError(err: AgentConflictError): HttpError {
  return new HttpError(409, "session head conflict", `conflict_head:${String(err.currentHeadItemId ?? "null")}`);
}

export { isSubtaskParentToolUniqueConstraintError };

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
  if (toolName === "scratchpad") {
    return {
      type: "object",
      required: ["content"],
      additionalProperties: false,
      properties: {
        content: {
          type: "string",
          maxLength: 200,
          description: "A short scratchpad entry to record. Suggested <= 200 characters."
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
  if (toolName === "visual_analyze") {
    return {
      type: "object",
      required: ["paths"],
      additionalProperties: false,
      properties: {
        paths: {
          type: "array",
          minItems: 1,
          items: { type: "string", minLength: 1 }
        },
        prompt: {
          type: "string"
        }
      }
    };
  }
  if (toolName === "skill") {
    return {
      type: "object",
      required: ["skillId"],
      additionalProperties: false,
      properties: {
        skillId: {
          type: "string",
          description: "Stable logical skill identifier shown in the available skills list, such as builtin/skill-authoring."
        },
        filePath: {
          type: "string",
          description: "Optional file path relative to the skill root. Omit filePath, pass an empty string or a string containing only spaces/tabs, or pass exactly SKILL.md to read root instructions and available file paths."
        }
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
          description: "Briefly describe the task goal in 50 characters or fewer. Longer values will be truncated to 50 characters."
        },
        prompt: {
          type: "string",
          minLength: 1,
          description: "Task instructions for the subtask. Clearly define the goal, scope or constraints, and deliverable boundary so the assignee knows exactly what to do and what not to do."
        },
        agentId: {
          type: "string",
          minLength: 1,
          description: "The agent ID of the assignee role template, not a specific assignee instance. The same agentId may be reused across multiple subtasks. It defines the assignee's capabilities, working style, and deliverable requirements."
        },
        session: {
          description: "Controls whether the subtask receives background context or reuses prior session memory for the assignee role.",
          oneOf: [
            {
              type: "object",
              required: ["mode"],
              additionalProperties: false,
              properties: {
                mode: { const: "new" }
              },
              description: "new: start a brand-new task with no parent-session or prior subtask background; give instructions only through the prompt."
            },
            {
              type: "object",
              required: ["mode", "sessionId"],
              additionalProperties: false,
              properties: {
                mode: { const: "existing" },
                sessionId: {
                  type: "string",
                  minLength: 1,
                  description: "The existing subtask session ID whose content and memory should be resumed."
                }
              },
              description: "existing: continue a specified subtask session to reuse its content and memory. Best for follow-up research, post-fix review, and other work where repeating context gathering would be wasteful."
            },
            {
              type: "object",
              required: ["mode"],
              additionalProperties: false,
              properties: {
                mode: { const: "fork" }
              },
              description: "fork: provide the subtask with the full current parent-session history as background context. Use this when the user's intent must be passed through without loss."
            }
          ]
        }
      }
    };
  }
  if (toolName === "write") {
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
    "Usage guidance:",
    "In a single response, invoking multiple subtask tools indicates that the subtasks are executed in parallel. If the execution order of the subtasks needs to be guaranteed, you can only invoke one subtask tool at a time, making multiple separate calls.",
    "Using parallel subtasks for multiple independent tasks is often a good way to improve efficiency. However, tasks that have dependencies must be delegated one by one in sequence. For example, implementation and code review cannot be delegated in parallel.",
    "For coding or documentation work driven by the user's request, prefer fork so the user's intent can be passed to the subtask without loss.",
    "When using fork, the subtask receives the full parent-session context, which may include overall planning information such as todolists. Therefore the prompt must explicitly state the subtask's concrete goal, deliverable boundary, and responsibilities it should not take on.",
    "Concurrent subtasks may reuse the same agentId, but do not assign the same existing sessionId to multiple concurrent tasks.",
    "If a subtask call fails after a session ID has already been created, prefer reusing that session with existing instead of starting over, because useful partial progress may already exist.",
    "If a subtask call succeeds but returns no summary, you must reuse that session to check progress and continue the work if it is not actually finished.",
    "",
    "Guidance for choosing session.mode:",
    "- new: start a fresh task with no inherited context; use only the prompt as instructions.",
    "- fork: send the full parent-session context to the subtask when the prompt alone cannot capture the user's intent or constraints.",
    "- existing: resume an earlier subtask session to reuse memory, continue unfinished work, or avoid repeating research and review setup.",
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
  if (toolName === "skill") {
    return [
      "Load a top-level skill and its text files by stable logical identifier (no filesystem paths).",
      "Input: skillId (string) is one of the identifiers in the available skills list, using builtin/... or workspace/... or repo/... prefixes.",
      "filePath is optional and is relative to the selected skill root.",
      "Omit filePath, pass an empty string or a string containing only spaces/tabs, or pass exactly SKILL.md to read root instructions and a flat list of available file paths.",
      "Any other valid filePath reads that text file with the Worker text reader's normalized content."
    ].join(" ");
  }
  if (toolName === "visual_analyze") {
    return [
      "Analyze visual files inside the current workspace and return natural-language findings.",
      "Supported file types: PNG, JPG/JPEG, WEBP, GIF, PDF.",
      "Accepts multiple files and interprets them in input order.",
      "Input paths must be relative paths inside the workspace.",
      "If model/provider/SDK/service does not support the given files, the tool returns an error result."
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
    if (toolName === "scratchpad") {
      return [
        "Record a short scratchpad entry into the runtime session state as persistent working memory.",
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
  if (toolName === "write") {
    return [
      "Write and fully overwrite a workspace-relative file.",
      "",
      "Arguments:",
      "- filePath: Required workspace-relative file path.",
      "- content: Required complete file content as a string.",
      "",
      "The content field must contain the complete intended file text.",
      "contentBytes, contentPreview, and contentTruncated are not valid write arguments.",
      "For localized changes to an existing file, prefer apply_patch."
    ].join("\n");
  }
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
  // - subtask: 明确 cancelled，并保留 subtask_session_id + 复用提示
  return toTerminalSubtaskCancelledOutput(output);
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

function buildOutputFormatInstruction(input: { uiLocale: AgentUiLocale | null }) {
  if (input.uiLocale === "zh-CN") {
    return getPromptText("agent/output-format-instruction.zh-CN.txt");
  }
  return getPromptText("agent/output-format-instruction.en-US.txt");
}

function buildLanguageInstruction(input: { uiLocale: AgentUiLocale | null }) {
  if (input.uiLocale === "zh-CN") {
    return getPromptText("agent/language-instruction.zh-CN.txt");
  }
  if (input.uiLocale === "en-US") {
    return getPromptText("agent/language-instruction.en-US.txt");
  }
  return "";
}

function buildOneShotSystemPrompt(input: { uiLocale: AgentUiLocale | null }) {
  return buildLanguageInstruction(input);
}

function buildRuntimeInstruction(input: { uiLocale: AgentUiLocale | null }) {
  const lines: string[] = [];
  const pushGroup = (group: string[]) => {
    if (!group.length) return;
    if (lines.length) lines.push("");
    lines.push(...group);
  };

  const languageInstruction = buildLanguageInstruction({ uiLocale: input.uiLocale });
  if (languageInstruction) pushGroup(languageInstruction.split("\n"));
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
      return getPromptText("agent/clear-summary.en-US.txt");
    }
    return renderPromptTemplateFile("agent/clear-summary-with-reason.en-US.tmpl.txt", { reason: normalizedReason });
  }

  if (!normalizedReason) {
    return getPromptText("agent/clear-summary.zh-CN.txt");
  }
  return renderPromptTemplateFile("agent/clear-summary-with-reason.zh-CN.tmpl.txt", { reason: normalizedReason });
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

const WORKSPACE_AGENTS_MAX_BYTES = 32 * 1024;
const ARCHIVE_FILE_NAME_WIDTH = 8;
const ARCHIVE_FILE_LINE_LIMIT = 100;
const ARCHIVE_SEARCH_MAX_HITS_DEFAULT = 10;
const BUILTIN_SKILLS_ROOT = "skills";
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
const SUBTASK_PREFORK_SUMMARY_MAX_CHARS = 20_000;
function buildSubtaskForkGuardSystemText(input: { uiLocale: AgentUiLocale | null }) {
  if (normalizeAgentUiLocale(input.uiLocale) === "zh-CN") {
    return getPromptText("agent/subtask-fork-guard-system-text.zh-CN.txt");
  }
  return getPromptText("agent/subtask-fork-guard-system-text.en-US.txt");
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

function sanitizeArchiveText(raw: string) {
  return String(raw || "").replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

function shouldIncludeSystemTextInPrompt(text: string) {
  const normalized = String(text || "").trim();
  return Boolean(normalized) && !normalized.startsWith(RUN_STATUS_SYSTEM_TEXT_PREFIX);
}

function buildCompactionSnippetMessageText(params: {
  excerptLines: string[];
  minPos: number;
  uiLocale: AgentUiLocale | null;
}) {
  const body = params.excerptLines.join("\n");
  if (normalizeAgentUiLocale(params.uiLocale) !== "zh-CN") {
    return renderPromptTemplateFile("agent/compaction-snippet-message.en-US.tmpl.txt", { body, minPos: params.minPos });
  }
  return renderPromptTemplateFile("agent/compaction-snippet-message.zh-CN.tmpl.txt", { body, minPos: params.minPos });
}

function parseArchivedItemIdFromArchiveLine(line: string) {
  const m = /^item=(\d+)\s/.exec(String(line || ""));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && Number.isInteger(n) && n >= 1 ? n : null;
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

type SkillSummaryItem = {
  skill: string;
  name: string;
  description?: string;
};

async function scanTopLevelSkillSummaries(params: {
  rootPath: string;
  idPrefix: "builtin" | "workspace" | "repo";
  logger: FastifyBaseLogger;
  idBasePath?: string;
}) {
  const readableItems = await scanReadableTopLevelSkills({
    rootPath: params.rootPath,
    logger: params.logger,
    logMessage: "failed to read top-level skill summary"
  });

  const items: SkillSummaryItem[] = [];
  for (const item of readableItems) {
    const parsed = parseSkillFrontmatter(item.text);
    const base = params.idBasePath ? `${params.idBasePath}/` : "";
    const identifierSegments = [params.idPrefix, ...base.split("/").filter(Boolean), item.entryName];
    if (!identifierSegments.every(isValidSkillPathSegment)) {
      params.logger.warn({ skillNamespace: params.idPrefix }, "skip top-level skill with non-callable identifier");
      continue;
    }
    const description = parsed.description.trim();
    items.push({
      skill: `${params.idPrefix}/${base}${item.entryName}`,
      name: parsed.name.trim() || item.entryName,
      ...(description ? { description } : {})
    });
  }
  return items;
}

function buildSkillsInstructionSection(input: {
  builtin: SkillSummaryItem[];
  external: SkillSummaryItem[];
}) {
  const lines: string[] = [];
  lines.push("Use the builtin skill tool to load details on demand by stable logical skill identifier.");
  lines.push('If the user mentions anything related to skills, use the "skill" tool with the corresponding skill entry, then proceed with the action. First read the root: omit filePath, pass an empty string or spaces/tabs only, or pass exactly SKILL.md. Root content includes a flat (not tree-shaped) Skill files list; copy one complete path line verbatim into filePath to read that auxiliary text file.');
  lines.push("");
  lines.push("builtin skills:");
  if (input.builtin.length === 0) {
    lines.push("- (none)");
  } else {
    for (const item of input.builtin) lines.push(`- skillId: ${item.skill}; name: ${item.name}${item.description ? `; description: ${item.description}` : ""}`);
  }
  lines.push("");
  lines.push("external skills:");
  if (input.external.length === 0) {
    lines.push("- (none)");
  } else {
    for (const item of input.external) {
      lines.push(`- skillId: ${item.skill}; name: ${item.name}${item.description ? `; description: ${item.description}` : ""}`);
    }
  }
  return lines.join("\n");
}

async function readAgentsInstructionFile(params: { filePath: string; displayPath: string; logger: FastifyBaseLogger }) {
  const filePath = params.filePath;
  const displayPath = params.displayPath;
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(filePath);
  } catch (err: any) {
    if (err && err.code === "ENOENT") return null;
    params.logger.warn({ err, filePath }, "read AGENTS.md failed");
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
      params.logger.warn({ filePath }, "AGENTS.md appears binary, ignored");
      return null;
    }

    const decoded = decodeUtf8Prefix(chunk, WORKSPACE_AGENTS_MAX_BYTES);
    if (!decoded.text.trim()) return null;

    const extra = decoded.truncated ? "\n\n[AGENTS.md truncated: first 32KB]" : "";
    return {
      filePath,
      displayPath,
      content: `${decoded.text}${extra}`
    };
  } catch (err) {
    params.logger.warn({ err, filePath }, "read AGENTS.md failed");
    return null;
  } finally {
    await fd?.close().catch(() => undefined);
  }
}

const GLOBAL_WORKFLOW_SYSTEM_PROMPT = getPromptText("agent/global-workflow-system-prompt.zh-CN.txt");

registerGlobalSystemPromptTextProvider(() => GLOBAL_WORKFLOW_SYSTEM_PROMPT);

function buildSystemPrompt(input: {
  agentName: string;
  agentPrompt: string;
  agentGlobalPromptIds: string[];
  outputFormatInstruction?: string;
  globalPrompts: Array<{ id: string; title: string; prompt: string }>;
  runtimeInstruction?: string;
  agentsInstructions: Array<{ filePath: string; displayPath: string; content: string }>;
  skillsInstruction?: string;
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

  for (const item of input.agentsInstructions || []) {
    if (!item?.content?.trim()) continue;
    sections.push(formatSection("agents_instructions", item.content, item.displayPath));
  }

  if (agentPrompt.trim()) {
    sections.push(formatSection("agent_prompt", agentPrompt, input.agentName));
  }

  if (String(input.skillsInstruction || "").trim()) {
    sections.push(formatSection("skills", String(input.skillsInstruction || "")));
  }

  if (outputFormatInstruction) {
    sections.push(formatSection("output_format_instructions", outputFormatInstruction));
  }

  if (runtimeInstruction) {
    sections.push(formatSection("runtime_constraints", runtimeInstruction));
  }

  return sections.filter(Boolean).join("\n\n---\n");
}

function appendRuntimeConstraintsSection(systemStatic: string, runtimeInstruction: string) {
  const runtime = String(runtimeInstruction || "").trim();
  if (!runtime) return systemStatic;
  const runtimeSection = `[runtime_constraints]\n\n${runtime}`;
  const base = String(systemStatic || "").trim();
  if (!base) return runtimeSection;
  return `${base}\n\n---\n${runtimeSection}`;
}

export class AgentService {
  private readonly sessionOpLocks = new Map<string, Promise<void>>();
  private readonly runPromptStaticCache = new RunPromptStaticCache<Awaited<ReturnType<PromptStaticAssembler["assemble"]>>>();
  private readonly readSideApplication: ReadSideApplication<
    ReturnType<AgentService["resolveExecutionProfileForReadSide"]> extends infer Profile extends { agent: { id: string }; provider: { id: string }; model: { id: string }; vision: unknown; compaction: unknown }
      ? ReturnType<ExecutionProfileResolver<Profile, ReturnType<AgentService["getAgentRuntimeSettingsForReadSide"]>>["getExecutionProfileForRun"]>
      : never,
    Awaited<ReturnType<MessagesContextProjector<Awaited<ReturnType<AgentService["buildPromptMessagesForSession"]>>["messages"][number]>["getMessagesContext"]>>,
    Awaited<ReturnType<PromptContextProjector<Awaited<ReturnType<AgentService["buildPromptMessagesForSession"]>>["messages"][number]>["getPromptContextForRun"]>>
  >;
  private readonly writebackApplication: ContextWritebackApplication;
  private readonly uiArtifactCapability: UiArtifactCapability;
  private readonly executionProfileResolver: ExecutionProfileResolver<
    ReturnType<AgentService["resolveExecutionProfileForReadSide"]>,
    ReturnType<AgentService["getAgentRuntimeSettingsForReadSide"]>
  >;
  private readonly messagesContextProjector: MessagesContextProjector<Awaited<ReturnType<AgentService["buildPromptMessagesForSession"]>>["messages"][number]>;
  private readonly promptStaticAssembler: PromptStaticAssembler;
  private readonly promptContextProjector: PromptContextProjector<Awaited<ReturnType<AgentService["buildPromptMessagesForSession"]>>["messages"][number]>;
  private readonly runPromptStaticCacheInvalidator: RunPromptStaticCacheInvalidator;
  private readonly runLifecycleApplication: RunLifecycleApplication;
  private readonly subtaskApplication: SubtaskApplication;
  private readonly archiveStorage: ArchiveStorage;
  private readonly compactionArchivePersistence: SqliteCompactionArchivePersistence;
  private readonly compactionArchiveApplication: CompactionArchiveApplication;
  private readonly manualCompactionApplication: ManualCompactionApplication;
  private readonly archiveReadApplication: ArchiveReadApplication;
  private readonly compactionSnippetCache: CompactionSnippetCache;

  constructor(
    private readonly ctx: AppContext,
    private readonly logger: FastifyBaseLogger,
    private readonly runCompletedEventHub?: AgentRunCompletedEventHub | null,
    dependencies?: {
      archiveStorage?: ArchiveStorage;
      compactionArchivePersistence?: SqliteCompactionArchivePersistence;
    }
  ) {
    this.archiveStorage = dependencies?.archiveStorage ?? new ArchiveStorage({ dataDir: this.ctx.dataDir, logger: this.logger });
    this.compactionArchivePersistence = dependencies?.compactionArchivePersistence ?? new SqliteCompactionArchivePersistence(this.ctx.db);
    this.archiveReadApplication = new ArchiveReadApplication(
      { get: (sessionId) => getAgentSession(this.ctx.db, sessionId) },
      new ArchiveReadStorage(this.ctx.dataDir)
    );
    this.compactionSnippetCache = new CompactionSnippetCache({ dataDir: this.ctx.dataDir, logger: this.logger });
    this.compactionArchiveApplication = new CompactionArchiveApplication({
      sessionQuery: {
        get: (sessionId) => getAgentSession(this.ctx.db, sessionId),
        getRun: (runId) => getRunRecord(this.ctx.db, runId),
        getVisibleItems: (workspaceId, sessionId) => getSessionVisibleItems(this.ctx.db, workspaceId, sessionId),
        getLatestItemId: (workspaceId, sessionId) => getLatestSessionItemId(this.ctx.db, workspaceId, sessionId)
      },
      persistence: this.compactionArchivePersistence,
      archiveStorage: this.archiveStorage,
      runState: {
        get: (workspaceId, sessionId) => getRunState(this.ctx.db, workspaceId, sessionId),
        clearLastResponseTokensIfActiveRun: (params) => {
          const state = getRunState(this.ctx.db, params.workspaceId, params.sessionId);
          if (state.activeRunId !== params.runId) return;
          updateRunState(this.ctx.db, {
            workspaceId: params.workspaceId,
            sessionId: params.sessionId,
            status: state.status,
            activeRunId: state.activeRunId,
            activeAssistantItemId: state.activeAssistantItemId,
            lastResponseTotalTokens: null,
            updatedAt: params.updatedAt,
            appliedItemId: params.appliedItemId
          });
        },
        setIdle: (params) => setRunStateIdle(this.ctx.db, params),
        getControlResult: (sessionId) => this.getRunState(sessionId)
      },
      clock: { nowMs },
      logger: this.logger,
      isConflict: (error) => error instanceof AgentConflictError,
      toConflictHttpError: (error) => conflictToHttpError(error as AgentConflictError),
      isArchivableItem: (item) => ARCHIVABLE_ITEM_STATUS.has(item.status),
      isBoundaryMarkerItem,
      buildArchiveLine,
      buildClearSummaryText
    });
    this.manualCompactionApplication = new ManualCompactionApplication({
      reconcilePendingForSessionBestEffort: (params) => this.compactionArchiveApplication.reconcilePendingForSessionBestEffort(params),
      sessions: {
        get: (sessionId) => getAgentSession(this.ctx.db, sessionId),
        getVisibleItems: (workspaceId, sessionId) => getSessionVisibleItems(this.ctx.db, workspaceId, sessionId)
      },
      isWorkerEnabled: () => this.ctx.agentWorkerEnabled,
      findDedup: (params) => findClientRequestDedup(this.ctx.db, params),
      getRunState: (workspaceId, sessionId) => getRunState(this.ctx.db, workspaceId, sessionId),
      getControlRunState: (sessionId) => this.getRunState(sessionId),
      resolveProfile: ({ workspaceId, requestedAgentId }) => {
        const profile = resolveExecutionProfile(this.ctx, { surface: "user", requestedAgentId, workspaceEnablement: getWorkspaceEnabledAgentIds(this.ctx, workspaceId) });
        return { agentId: profile.agent.id, providerId: profile.provider.id, modelId: profile.model.id };
      },
      getWorkspaceRunContext: (workspaceId) => getAgentWorkspaceRunContext(this.ctx, workspaceId),
      activate: (params) => {
        this.ctx.db.transaction(() => {
          createRunRecord(this.ctx.db, { runId: params.runId, workspaceId: params.workspaceId, sessionId: params.sessionId, triggerItemId: params.triggerItemId, agentId: params.profile.agentId, providerId: params.profile.providerId, modelId: params.profile.modelId, uiLocale: params.uiLocale, subtaskDepth: 0, parentRunId: null, parentToolItemId: null, status: "running", createdAt: params.createdAt });
          insertClientRequestDedup(this.ctx.db, { workspaceId: params.workspaceId, sessionId: params.sessionId, clientRequestId: params.clientRequestId, messageItemId: params.triggerItemId, runId: params.runId, createdAt: params.createdAt });
          updateRunState(this.ctx.db, { workspaceId: params.workspaceId, sessionId: params.sessionId, status: "running", activeRunId: params.runId, activeAssistantItemId: null, runNoticeText: "正在压缩上下文...", updatedAt: params.createdAt, appliedItemId: getLatestSessionItemId(this.ctx.db, params.workspaceId, params.sessionId) });
        })();
      },
      failAfterEnqueueFailure: (params) => this.runLifecycleApplication.failRunAfterEnqueueFailure(params),
      clock: { nowMs },
      ids: { newRunId: () => newSortableId("run") }
    });
    this.runPromptStaticCacheInvalidator = new RunPromptStaticCacheInvalidator({
      clearRunStaticPrompt: (runId) => this.runPromptStaticCache.clear(runId)
    });
    const sqliteLifecyclePersistence = new SqliteRunLifecyclePersistence(this.ctx.db);
    const sqliteSubtaskLineagePersistence = new SqliteSubtaskLineagePersistence(this.ctx.db);
    const sqliteSubtaskRunQuery = new SqliteSubtaskRunQuery(this.ctx.db);
    const sqliteSubtaskMaintenancePersistence = new SqliteSubtaskMaintenancePersistence(this.ctx.db);
    this.runLifecycleApplication = new RunLifecycleApplication({
      workspaceRunContextReader: {
        get: (workspaceId) => getAgentWorkspaceRunContext(this.ctx, workspaceId)
      },
      runStateReader: { get: (sessionId) => this.getRunState(sessionId) },
      activeSubtaskChildQuery: sqliteSubtaskLineagePersistence,
      promptStaticCacheInvalidator: this.runPromptStaticCacheInvalidator,
      runCompletedEventPublisher: {
        publishRunCompleted: (event) => {
          this.runCompletedEventHub?.publish({
            ...event,
            eventType: "agent.run.completed.v1"
          });
        }
      },
      persistence: sqliteLifecyclePersistence,
      triggerInputReader: {
        getUserText: (itemId) => {
          const item = getContextItemById(this.ctx.db, itemId);
          return item?.output.type === "user_text" ? item.output.text : null;
        }
      },
      isContextAppendConflict: (error) => error instanceof AgentConflictError,
      clock: { nowMs },
      ids: { newId: newSortableId },
      logger: {
        warn: (bindings, message) => this.logger.warn(bindings, message),
        error: (bindings, message) => this.logger.error(bindings, message)
      }
    });
    const subtaskDependencies: SubtaskApplicationDependencies = {
      parentAnchorReader: {
        resolve: (params) => this.resolveSubtaskParentContext(params)
      },
      lineagePersistence: sqliteSubtaskLineagePersistence,
      sessionMaterializer: {
        resolveForStart: (params) => this.resolveSubtaskSessionForStart(params),
        resolveForkBoundary: (params) => this.resolveSubtaskForkBoundaryItemId(params)
      },
      executionProfileReader: {
        resolve: (input) => {
          const profile = resolveExecutionProfile(this.ctx, {
            surface: "subtask",
            requestedAgentId: input.requestedAgentId,
            workspaceEnablement: getWorkspaceEnabledAgentIds(this.ctx, input.workspaceId)
          });
          return {
            agentId: profile.agent.id,
            agentName: profile.agent.name,
            providerId: profile.provider.id,
            modelId: profile.model.id,
            contextWindowTokens: profile.model.contextWindowTokens
          };
        },
        findAgentName: (agentId) => getAgentSettings(this.ctx).agents.find((item) => item.id === agentId)?.name || null,
        getMaxDepth: () => getAgentRuntimeSettings(this.ctx).maxSubtaskDepth
      },
      workspaceReader: {
        get: (workspaceId) => {
          const workspace = getWorkspace(this.ctx.db, workspaceId);
          return workspace ? { path: workspace.path } : null;
        }
      },
      parentRunStateReader: {
        get: (workspaceId, sessionId) => getRunState(this.ctx.db, workspaceId, sessionId)
      },
      childRunActivator: sqliteLifecyclePersistence,
      runQuery: sqliteSubtaskRunQuery,
      localCompensationPersistence: sqliteSubtaskMaintenancePersistence,
      orphanPersistence: sqliteSubtaskMaintenancePersistence,
      clock: { nowMs },
      ids: { newId: newSortableId },
      logger: {
        warn: (bindings, message) => this.logger.warn(bindings, message),
        error: (bindings, message) => this.logger.error(bindings, message)
      },
      forkGuardTextReader: { get: (uiLocale) => buildSubtaskForkGuardSystemText({ uiLocale }) }
    };
    this.subtaskApplication = new SubtaskApplication(subtaskDependencies);
    this.executionProfileResolver = new ExecutionProfileResolver({
      resolveProfile: (input) => this.resolveExecutionProfileForReadSide(input),
      getRuntime: () => this.getAgentRuntimeSettingsForReadSide()
    });
    this.messagesContextProjector = new MessagesContextProjector({
      buildMessages: ({ workspaceId, sessionId }) => this.buildPromptMessagesForSession({
        workspaceId,
        sessionId,
        compactionSnippetUiLocale: null
      }),
      getActiveRunId: ({ workspaceId, sessionId }) => getRunState(this.ctx.db, workspaceId, sessionId).activeRunId,
      resolveUiLocale: (input) => this.resolveUiLocaleForSessionContext(input),
      buildOneShotSystem: (input) => buildOneShotSystemPrompt(input)
    });
    this.promptStaticAssembler = new PromptStaticAssembler({
      getGlobalPrompts: () => getAgentGlobalPromptSettings(this.ctx),
      listAgentsInstructionSources: (workspaceId) => listEnabledWorkspaceAgentsInstructions({ ctx: this.ctx, logger: this.logger, workspaceId }),
      readAgentsInstruction: (source) => readAgentsInstructionFile({ ...source, logger: this.logger }),
      scanBuiltinSkills: () => scanTopLevelSkillSummaries({
        rootPath: path.join(this.ctx.repoRoot, BUILTIN_SKILLS_ROOT),
        idPrefix: "builtin",
        logger: this.logger
      }),
      listExternalSkillRoots: (workspaceId) => listEnabledWorkspaceExternalSkillRoots(this.ctx, this.logger, workspaceId),
      scanExternalSkills: (root) => scanTopLevelSkillSummaries({
        rootPath: root.rootPath,
        idPrefix: root.sourceType === "workspace" ? "workspace" : "repo",
        idBasePath: root.sourceType === "workspace" ? root.rootDir : `${root.repoId}/${root.rootDir}`,
        logger: this.logger
      }),
      warnExternalSkillScanFailure: ({ err, workspaceId, root }) => {
        this.logger.warn(
          { err, workspaceId, sourceType: root.sourceType, repoId: root.sourceType === "repo" ? root.repoId : undefined },
          "scan external skill roots failed"
        );
      },
      getMaxSubtaskDepth: () => getAgentRuntimeSettings(this.ctx).maxSubtaskDepth,
      listSubtaskAgents: () => listAvailableAgentsForSurface(this.ctx, "subtask").map((item) => ({
        id: item.id,
        name: item.name,
        summary: item.summary
      })),
      buildSystem: (input) => buildSystemPrompt(input),
      buildOutputFormatInstruction: (input) => buildOutputFormatInstruction(input),
      buildSkillsInstruction: (input) => buildSkillsInstructionSection(input),
      buildSubtaskDescription: (agents) => buildSubtaskToolDescription(agents),
      describeTool: (name, options) => toolDescription(name as AgentContextToolName, options),
      getToolInputSchema: (name) => toolArgsSchema(name as AgentContextToolName)
    });
    this.promptContextProjector = new PromptContextProjector(this.runPromptStaticCache, {
      getRunState: ({ workspaceId, sessionId }) => getRunState(this.ctx.db, workspaceId, sessionId),
      resolveUiLocale: (input) => this.resolveUiLocaleForSessionContext(input),
      resolveProfile: (input) => this.resolveExecutionProfileForReadSide(input),
      assembleStatic: (input) => this.promptStaticAssembler.assemble(input),
      buildRuntimeInstruction: (input) => buildRuntimeInstruction(input),
      appendRuntimeConstraints: (systemStatic, runtimeInstruction) => appendRuntimeConstraintsSection(systemStatic, runtimeInstruction),
      listVisibleItems: ({ workspaceId, sessionId }) => getSessionVisibleItems(this.ctx.db, workspaceId, sessionId),
      buildMessages: (input) => this.buildPromptMessagesForSession(input)
    });
    this.readSideApplication = new ReadSideApplication({
      findSession: (sessionId) => getAgentSession(this.ctx.db, sessionId),
      findRun: (runId) => getRunRecord(this.ctx.db, runId),
      ensureWorkspace: (workspaceId) => {
        this.ensureWorkspace(workspaceId);
      },
      resolveExecutionProfile: (input) => this.executionProfileResolver.getExecutionProfileForRun({
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        session: input.session,
        run: input.run
      }),
      projectMessagesContext: (input) => this.messagesContextProjector.getMessagesContext({
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        headItemId: input.session.headItemId,
        ...(input.appendMessage ? { appendMessage: input.appendMessage } : {})
      }),
      projectPromptContext: (input) => this.promptContextProjector.getPromptContextForRun(input)
    });
    this.uiArtifactCapability = new UiArtifactCapability(this.ctx.dataDir);
    this.writebackApplication = new ContextWritebackApplication({
      appendWithRunFence: (params) => appendContextItemWithRunFence(this.ctx.db, params),
      nowMs,
      formatTodolistTitle: normalizeTodolistGoal,
      updateSessionTitle: (params) => {
        updateAgentSessionTitle(this.ctx.db, params);
      },
      isAppendConflict: (error): error is AgentConflictError => error instanceof AgentConflictError,
      warnAppendConflict: (params) => {
        this.logger.warn(
          {
            sessionId: params.sessionId,
            kind: params.kind,
            currentHeadItemId: params.currentHeadItemId
          },
          "agent append context item conflict"
        );
      },
      inspectForWorkerUpdate: (itemId) => getContextItemForWorkerUpdate(this.ctx.db, itemId),
      uiArtifacts: this.uiArtifactCapability,
      logArtifactError: ({ itemId, message, filePath, err }) => {
        this.logger.error({ ...(err ? { err } : {}), itemId, ...(filePath ? { filePath } : {}) }, message);
      },
      logArtifactWarning: ({ itemId, message, hasToolCallId, hasWorkspaceId }) => {
        this.logger.warn({ itemId, hasToolCallId, hasWorkspaceId }, message);
      },
      updateWithRunFence: (params) => updateContextItemWithRunFence(this.ctx.db, params)
    });
  }

  private clearRunPromptStaticCache(runId: string) {
    this.runPromptStaticCacheInvalidator.clear(runId);
  }

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

  async reconcileArchivePendingForSessionBestEffort(params: { workspaceId: string; sessionId: string }) {
    return this.compactionArchiveApplication.reconcilePendingForSessionBestEffort(params);
  }

  cleanupSubtaskOrphansOnStartup(
    command?: CleanupSubtaskOrphansOnStartupCommand,
  ) {
    return this.subtaskApplication.cleanupOrphansOnStartup(command);
  }

  listSessions(workspaceId: string) {
    this.ensureWorkspace(workspaceId);
    return listAgentSessions(this.ctx.db, workspaceId);
  }

  listRecentSessions(params: { limit: number; kind?: "primary" | "subtask" | "all" }): AgentRecentSessionsResponse {
    const kind = params.kind === "primary" || params.kind === "subtask" ? params.kind : "all";
    return { items: listRecentSessionsAcrossWorkspaces(this.ctx.db, Math.max(1, Math.min(50, params.limit || 10)), kind) };
  }

  getSession(sessionId: string) {
    return getAgentSession(this.ctx.db, sessionId);
  }

  listRecentWorkspaces(params: { limit: number }): AgentRecentWorkspacesResponse {
    const limit = Math.max(1, Math.min(50, params.limit || 10));
    return { items: listRecentWorkspaces(this.ctx.db, limit) };
  }

  getWorkspace(workspaceId: string) {
    return getWorkspace(this.ctx.db, workspaceId);
  }

  createPrimarySession(params: { workspaceId: string; title?: string }) {
    return this.createSessionRecord({
      workspaceId: params.workspaceId,
      title: params.title,
      kind: "primary"
    });
  }

  private createSubtaskSessionInternal(params: {
    workspaceId: string;
    title?: string;
    forkedFromSessionId?: string | null;
    forkedFromItemId?: number | null;
  }) {
    return this.createSessionRecord({ ...params, kind: "subtask" });
  }

  private createSessionRecord(params: {
    workspaceId: string;
    title?: string;
    kind: "primary" | "subtask";
    forkedFromSessionId?: string | null;
    forkedFromItemId?: number | null;
  }) {
    this.ensureWorkspace(params.workspaceId);
    const createdAt = nowMs();
    const sessionId = newSortableId("sess");
    const title = (params.title || "新会话").trim() || "新会话";

    createAgentSession(this.ctx.db, {
      id: sessionId,
      workspaceId: params.workspaceId,
      title,
      kind: params.kind,
      createdAt,
      forkedFromSessionId: params.forkedFromSessionId ?? null,
      forkedFromItemId: params.forkedFromItemId ?? null
    });

    const session = getAgentSession(this.ctx.db, sessionId);
    if (!session) throw new HttpError(500, "failed to create session");
    return session;
  }

  async forkPrimarySession(params: AgentForkSessionRequest) {
    const fromSession = getAgentSession(this.ctx.db, params.fromSessionId);
    if (!fromSession) throw new HttpError(404, "source session not found");
    if (fromSession.kind !== "primary") {
      throw new HttpError(400, "source session must be primary", "AGENT_FORK_SOURCE_KIND_INVALID");
    }
    return await this.cloneContextIntoNewSession({
      fromSession,
      fromItemId: params.fromItemId,
      mode: params.mode,
      title: params.title,
      targetKind: "primary",
      boundaryPolicy: "public-user-assistant"
    });
  }

  private async cloneForkedSubtaskSessionInternal(params: {
    fromSessionId: string;
    fromItemId: number;
    title?: string;
  }) {
    const fromSession = getAgentSession(this.ctx.db, params.fromSessionId);
    if (!fromSession) throw new HttpError(404, "source session not found");
    return await this.cloneContextIntoNewSession({
      fromSession,
      fromItemId: params.fromItemId,
      mode: "visible_only",
      title: params.title,
      targetKind: "subtask",
      boundaryPolicy: "internal-resolved"
    });
  }

  /**
   * Resolves only the session used by the internal subtask start domain.
   * It intentionally owns subtask-session origin metadata and context-clone
   * selection, while child Run depth/parent fields remain owned by
   * startSubtaskRunFromWorker's Run creation transaction.
   */
  private async resolveSubtaskSessionForStart(params: {
    workspaceId: string;
    parentSessionId: string;
    parentToolItemId: number;
    session: AgentApiSubtaskStartRequest["session"];
    subtaskTitleBase: string;
    forkBoundaryItemId: number | null;
    shouldUsePreforkSummary: boolean;
  }) {
    const requestedSessionId = String(params.session.sessionId || "").trim();
    if (params.session.mode === "existing") {
      if (!requestedSessionId) {
        throw new HttpError(400, "existing sessionId is required", AgentSubtaskErrorCode.ExistingSessionRequired);
      }
      const session = getAgentSession(this.ctx.db, requestedSessionId);
      if (!session) throw new HttpError(404, "subtask session not found", AgentSubtaskErrorCode.SessionNotFound);
      if (session.workspaceId !== params.workspaceId) {
        throw new HttpError(400, "subtask session workspace mismatch", AgentSubtaskErrorCode.WorkspaceMismatch);
      }
      if (session.kind !== "subtask") {
        throw new HttpError(400, "existing session must be subtask", AgentSubtaskErrorCode.KindMismatch);
      }
      return { session, createdSessionId: null };
    }

    if (requestedSessionId) {
      throw new HttpError(
        400,
        `sessionId is not allowed when mode=${params.session.mode}`,
        AgentSubtaskErrorCode.SessionIdNotAllowed
      );
    }

    if (params.session.mode === "new") {
      const session = this.createSubtaskSessionInternal({
        workspaceId: params.workspaceId,
        title: params.subtaskTitleBase,
        forkedFromSessionId: params.parentSessionId,
        forkedFromItemId: params.parentToolItemId
      });
      return { session, createdSessionId: session.id };
    }

    if (params.shouldUsePreforkSummary) {
      const session = this.createSubtaskSessionInternal({
        workspaceId: params.workspaceId,
        title: `${params.subtaskTitleBase} (fork)`,
        forkedFromSessionId: params.parentSessionId,
        forkedFromItemId: params.parentToolItemId
      });
      return { session, createdSessionId: session.id };
    }

    if (params.forkBoundaryItemId == null) {
      const session = this.createSubtaskSessionInternal({
        workspaceId: params.workspaceId,
        title: `${params.subtaskTitleBase} (fork)`
      });
      return { session, createdSessionId: session.id };
    }

    const session = await this.cloneForkedSubtaskSessionInternal({
      fromSessionId: params.parentSessionId,
      fromItemId: params.forkBoundaryItemId,
      title: `${params.subtaskTitleBase} (fork)`
    });
    return { session, createdSessionId: session.id };
  }

  private async cloneContextIntoNewSession(params: {
    fromSession: AgentSessionRecord;
    fromItemId: number;
    mode: "with_archive" | "visible_only";
    title?: string;
    targetKind: "primary" | "subtask";
    boundaryPolicy: "public-user-assistant" | "internal-resolved";
  }) {
    const fromSession = params.fromSession;

    const transcript = getSessionTranscriptItems(this.ctx.db, fromSession.workspaceId, fromSession.id);
    const targetIndex = transcript.findIndex((item) => item.id === params.fromItemId);
    if (targetIndex < 0) throw new HttpError(400, "invalid fromItemId");
    const target = transcript[targetIndex];
    if (!target) throw new HttpError(400, "invalid fromItemId");
    if (params.boundaryPolicy === "public-user-assistant" && target.kind !== "user" && target.kind !== "assistant") {
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
    const kind = params.targetKind;
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
          await this.archiveStorage.appendLines({
            operation: "fork",
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

  async sendMessage(params: { sessionId: string; body: AgentSendMessageRequest; runtime: AgentRuntimePort }): Promise<AgentSendMessageResponse> {
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
    // Non-authoritative fast paths preserve existing user-facing validation
    // order; Lifecycle repeats both checks inside its activation transaction.
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
    if (getRunState(this.ctx.db, session.workspaceId, session.id).status !== "idle") {
      throw new HttpError(409, "session is running");
    }
    const profile = resolveExecutionProfile(this.ctx, {
      surface: "user",
      requestedAgentId: params.body.agentId,
      workspaceEnablement: getWorkspaceEnabledAgentIds(this.ctx, session.workspaceId)
    });
    try {
      return await this.runLifecycleApplication.startUserRun({
        workspaceId: session.workspaceId,
        sessionId: session.id,
        clientRequestId: params.body.clientRequestId,
        text,
        inputText: params.body.text,
        agentId: profile.agent.id,
        providerId: profile.provider.id,
        modelId: profile.model.id,
        uiLocale: normalizeAgentUiLocale(params.body.uiLocale),
        runtime: params.runtime
      });
    } catch (err) {
      if (err instanceof AgentConflictError) throw conflictToHttpError(err);
      throw err;
    }
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

  async compactSession(params: { sessionId: string; body: AgentCompactSessionRequest; runtime: ManualCompactionRuntime }): Promise<AgentCompactSessionResponse> {
    return this.runSessionOperationExclusive(params.sessionId, () => this.manualCompactionApplication.schedule({
      sessionId: params.sessionId,
      body: params.body,
      runtime: params.runtime
    }));
  }

  // 兼容 compact 等尚未迁移的入口；条件收敛权威位于 Lifecycle。
  failRunOnEnqueueFailure(params: { workspaceId: string; sessionId: string; runId: string; updatedAt?: number }) {
    return this.runLifecycleApplication.failRunAfterEnqueueFailure(params);
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
    if (!toolCallId) throw new HttpError(404, "apply_patch artifact not found");
    return this.uiArtifactCapability.readApplyPatch({ workspaceId: item.workspaceId, toolCallId });
  }

  async getWriteUiArtifact(params: { sessionId: string; itemId: number }) {
    const item = this.getContextItem(params.sessionId, params.itemId);
    if (item.kind !== "tool" || item.output.type !== "tool" || item.output.toolName !== "write") {
      throw new HttpError(404, "write artifact not found");
    }
    const toolCallId = typeof item.output.toolCallId === "string" ? item.output.toolCallId.trim() : "";
    if (!toolCallId) throw new HttpError(404, "write artifact not found");
    return this.uiArtifactCapability.readWrite({ workspaceId: item.workspaceId, toolCallId });
  }

  getRunState(sessionId: string): AgentSessionRunState {
    const session = getAgentSession(this.ctx.db, sessionId);
    if (!session) throw new HttpError(404, "session not found");
    const state = getRunState(this.ctx.db, session.workspaceId, session.id);
    const latestTerminalRun = getLatestTerminalRunRecord(this.ctx.db, { workspaceId: session.workspaceId, sessionId: session.id });
    const lastTerminalStatus =
      latestTerminalRun && state.status === "idle" && latestTerminalRun.updatedAt === state.updatedAt ? latestTerminalRun.status : null;

    const activeRun = (() => {
      const activeRunId = state.activeRunId;
      if (!activeRunId) return null;
      const run = getRunRecord(this.ctx.db, activeRunId);
      if (!run) {
        this.logger.warn(
          { sessionId: session.id, workspaceId: session.workspaceId, activeRunId },
          "run-state has activeRunId but run record not found"
        );
        return null;
      }
      if (run.workspaceId !== session.workspaceId || run.sessionId !== session.id) {
        this.logger.warn(
          {
            sessionId: session.id,
            workspaceId: session.workspaceId,
            activeRunId,
            runWorkspaceId: run.workspaceId,
            runSessionId: run.sessionId
          },
          "run-state activeRunId does not belong to the session"
        );
        return null;
      }
      return {
        runId: run.runId,
        startedAt: run.createdAt
      };
    })();

    const contextRun = (() => {
      const activeRunId = state.activeRunId;
      if (activeRunId) {
        const active = getRunRecord(this.ctx.db, activeRunId);
        if (active && active.workspaceId === session.workspaceId && active.sessionId === session.id) {
          return active;
        }
      }
      return latestTerminalRun ?? null;
    })();

    let contextWindowTokens: number | null = null;
    if (contextRun) {
      try {
        const profile = resolveExecutionProfile(this.ctx, {
          surface: session.kind === "subtask" ? "subtask" : "user",
          agentIdFromRun: contextRun.agentId,
          workspaceEnablement: getWorkspaceEnabledAgentIds(this.ctx, session.workspaceId),
          providerIdFromRun: contextRun.providerId,
          modelIdFromRun: contextRun.modelId
        });
        const rawTokens = Number(profile.model.contextWindowTokens);
        if (Number.isFinite(rawTokens) && rawTokens >= 1) {
          contextWindowTokens = Math.floor(rawTokens);
        }
      } catch (err) {
        this.logger.warn(
          { err, sessionId: session.id, workspaceId: session.workspaceId, runId: contextRun.runId },
          "resolve context-window tokens failed for run-state"
        );
      }
    }
    const contextTokenRatio =
      typeof state.lastResponseTotalTokens === "number" && typeof contextWindowTokens === "number" && contextWindowTokens > 0
        ? state.lastResponseTotalTokens / contextWindowTokens
        : null;

    const lastRun = (() => {
      if (!latestTerminalRun) return null;
      const startedAt = latestTerminalRun.createdAt;
      const endedAt = latestTerminalRun.updatedAt;
      return {
        runId: latestTerminalRun.runId,
        status: latestTerminalRun.status,
        startedAt,
        endedAt,
        durationMs: Math.max(0, endedAt - startedAt)
      };
    })();

    const nonTerminalItemIds = listNonTerminalVisibleItemIds(this.ctx.db, session.workspaceId, session.id);
    return {
      sessionId: session.id,
      status: state.status,
      activeRunId: state.activeRunId,
      activeAssistantItemId: state.activeAssistantItemId,
      activeRun,
      lastResponseTotalTokens: state.lastResponseTotalTokens,
      runNoticeText: state.runNoticeText,
      nonTerminalItemIds,
      updatedAt: state.updatedAt,
      lastTerminalStatus,
      appliedItemId: state.appliedItemId,
      lastRun,
      contextWindowTokens,
      contextTokenRatio
    };
  }

  getSessionStatusSummary(params: { sessionId: string; agentId?: string | null; selectedAgentId?: string | null }) {
    const sessionId = String(params.sessionId || "").trim();
    if (!sessionId) {
      throw new HttpError(400, "sessionId is required", "SESSION_ID_REQUIRED");
    }
    const session = getAgentSession(this.ctx.db, sessionId);
    if (!session) throw new HttpError(404, "session not found", "SESSION_NOT_FOUND");

    const runState = this.getRunState(session.id);

    const generatedAt = nowMs();
    let startedAt: number | null = null;
    let elapsedMs: number | null = null;
    if (runState.activeRunId) {
      const run = getRunRecord(this.ctx.db, runState.activeRunId);
      if (run && run.workspaceId === session.workspaceId && run.sessionId === session.id) {
        startedAt = run.createdAt;
        elapsedMs = Math.max(0, generatedAt - run.createdAt);
      }
    }

    // Compatibility precedence: selectedAgentId wins.
    const selectedAgentIdRaw =
      typeof params.selectedAgentId === "string" && params.selectedAgentId.trim()
        ? params.selectedAgentId
        : typeof params.agentId === "string"
          ? params.agentId
          : "";
    const selectedAgentId = String(selectedAgentIdRaw || "").trim();
    const agent = selectedAgentId
      ? (() => {
          const item = listAvailableAgentsForSurface(this.ctx, "user", {
            workspaceEnablement: getWorkspaceEnabledAgentIds(this.ctx, session.workspaceId)
          }).find((a) => a.id === selectedAgentId);
          if (!item) throw new HttpError(400, "Agent not found", "AGENT_NOT_FOUND");
          // keep minimal fields for IM display
          return { id: item.id, name: item.name, contextWindowTokens: item.resolvedModel?.contextWindowTokens ?? null };
         })()
      : null;

    // updatedAt should reflect the underlying data change time, not "now".
    const updatedAt = Math.max(session.updatedAt, runState.updatedAt, startedAt ?? 0);
    const workspace = getWorkspace(this.ctx.db, session.workspaceId);
    const sessionSummary = {
      ...session,
      workspaceTitle: workspace?.title,
      workspaceDirName: workspace?.dirName
    };

    return {
      updatedAt,
      generatedAt,
      session: sessionSummary,
      agent: agent ? { id: agent.id, name: agent.name } : null,
      runState: {
        ...runState,
        // Compatibility: IM design doc uses terminalStatus.
        terminalStatus: runState.lastTerminalStatus
      },
      startedAt,
      elapsedMs,
      contextWindowTokens: runState.contextWindowTokens ?? null,
      contextTokenRatio: runState.contextTokenRatio ?? null
    };
  }

  getContextItemById(itemId: number) {
    return getContextItemById(this.ctx.db, itemId);
  }

  getLatestTerminalAssistantTextByRunId(params: { runId: string }) {
    return getLatestTerminalAssistantTextByRunId(this.ctx.db, params);
  }

  getLatestCompletedAssistantTextByRunId(params: { runId: string }) {
    return getLatestCompletedAssistantTextByRunId(this.ctx.db, params);
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
    return this.cancelSessionCascade(sessionId, body).result;
  }

  cancelSessionCascade(sessionId: string, body: AgentCancelSessionRequest): AgentCancelCascadeResult {
    return this.runLifecycleApplication.cancelSessionCascade(sessionId, body);
  }

  async cancelSessionWithRuntime(params: { sessionId: string; workspaceId: string; runtime: AgentRuntimePort }) {
    return this.runLifecycleApplication.cancelSession({
      sessionId: params.sessionId,
      workspaceId: params.workspaceId,
      runtime: params.runtime
    });
  }

  recoverRunsOnStartup(params: {
    runtime: AgentRuntimePort;
    beforeFinalCheck?: (candidate: { workspaceId: string; sessionId: string; runId: string; triggerItemId: number | null }) => void | Promise<void>;
  }) {
    return this.runLifecycleApplication.recoverRunsOnStartup(params);
  }

  failRunsOnStartup() {
    return this.runLifecycleApplication.failRunsOnStartup();
  }

  appendContextItemFromWorker(params: AgentApiCreateContextItemRequest) {
    return this.writebackApplication.appendContextItemFromWorker(params);
  }

  async updateContextItemFromWorker(params: AgentApiUpdateContextItemRequest & { itemId: number }) {
    return this.writebackApplication.updateContextItemFromWorker(params);
  }


  updateRunStateFromWorker(params: AgentApiRunStateRequest) {
    return this.runLifecycleApplication.updateRunStateFromWorker(params);
  }

  completeRunFromWorker(params: AgentApiRunCompleteRequest) {
    return this.runLifecycleApplication.completeRunFromWorker(params);
  }

  private resolveSubtaskParentContext(params: {
    workspaceId: string;
    parentSessionId: string;
    parentRunId: string;
    parentToolItemId: number;
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
      throw new HttpError(400, "invalid subtask anchor run", AgentSubtaskErrorCode.AnchorRunMismatch);
    }
    if (anchor.output.type !== "tool" || anchor.output.toolName !== "subtask") {
      throw new HttpError(400, "invalid subtask anchor", AgentSubtaskErrorCode.AnchorInvalid);
    }

    return {
      parentSession,
      parentRun,
      parentUiLocale,
      anchor
    };
  }

  getSubtaskPreforkPlanFromWorker(params: AgentApiSubtaskPreforkPlanRequest) {
    return this.subtaskApplication.getPreforkPlan(params);
  }

  async startSubtaskRunFromWorker(params: AgentApiSubtaskStartRequest) {
    return await this.subtaskApplication.startSubtask(params);
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
        throw new HttpError(400, "invalid subtask fork boundary", AgentSubtaskErrorCode.ForkBoundaryInvalid);
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

  getSubtaskRunResultFromWorker(params: AgentApiSubtaskResultRequest) {
    return this.subtaskApplication.getResult(params);
  }

  getSubtaskRunStatusFromWorker(params: AgentApiSubtaskStatusRequest) {
    return this.subtaskApplication.getStatus(params);
  }

  getRunFinalText(params: { runId: string }) {
    const runId = String(params.runId || "").trim();
    if (!runId) {
      return { found: false, text: "" };
    }
    const run = getRunRecord(this.ctx.db, runId);
    if (!run) {
      return { found: false, text: "" };
    }
    const latest = getLatestTerminalAssistantTextByRunId(this.ctx.db, { runId });
    return { found: latest.itemId != null, text: latest.text };
  }

  getExecutionProfileForRun(params: { workspaceId: string; sessionId: string; runId: string }) {
    return this.readSideApplication.getExecutionProfileForRun(params);
  }

  private resolveExecutionProfileForReadSide(input: {
    surface: "user" | "subtask";
    workspaceId: string;
    agentId: string;
    providerId: string;
    modelId: string;
  }) {
    return resolveExecutionProfile(this.ctx, {
      surface: input.surface,
      agentIdFromRun: input.agentId,
      workspaceEnablement: getWorkspaceEnabledAgentIds(this.ctx, input.workspaceId),
      providerIdFromRun: input.providerId,
      modelIdFromRun: input.modelId
    });
  }

  private getAgentRuntimeSettingsForReadSide() {
    return getAgentRuntimeSettings(this.ctx);
  }

  getSingleCallModelProfileForRun(params: { workspaceId: string; sessionId: string; runId: string }) {
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
      workspaceEnablement: getWorkspaceEnabledAgentIds(this.ctx, session.workspaceId),
      providerIdFromRun: run.providerId,
      modelIdFromRun: run.modelId
    });

    return {
      resolved: {
        runId: params.runId,
        sessionId: params.sessionId,
        workspaceId: params.workspaceId,
        agentId: profile.agent.id,
        providerId: profile.provider.id,
        modelId: profile.model.id,
        source: "agent_default" as const
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

  async compactContextFromWorker(params: AgentApiCompactContextRequest) {
    return this.runSessionOperationExclusive(params.sessionId, () => this.compactionArchiveApplication.applyWorkerCompaction(params));
  }

  async clearSession(sessionId: string, body: AgentClearSessionRequest & { uiLocale?: AgentUiLocale | null }): Promise<AgentControlResult> {
    return this.runSessionOperationExclusive(sessionId, () => this.compactionArchiveApplication.clearSession({
      sessionId,
      workspaceId: body.workspaceId,
      reason: body.reason,
      uiLocale: normalizeAgentUiLocale(body.uiLocale)
    }));
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
    return this.archiveReadApplication.search(params);
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
            snippetText = await this.compactionSnippetCache.readBestEffort({
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

              const posLines = await this.archiveStorage.findExcerptByItemIds({
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
                await this.compactionSnippetCache.writeBestEffort({
                  workspaceId: params.workspaceId,
                  sessionId: params.sessionId,
                  summaryItemId,
                  text: snippetText
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
        const isWriteTool = toolItem.output.toolName === "write";
        const hasCompleteWriteInput =
          typeof toolInput.filePath === "string" &&
          toolInput.filePath.trim().length > 0 &&
          typeof toolInput.content === "string";
        if (isWriteTool && !hasCompleteWriteInput) {
          const filePath = typeof toolInput.filePath === "string" ? toolInput.filePath.trim() : "";
          const resultText = (typeof toolItem.output.error === "string" && toolItem.output.error.trim()
            ? toolItem.output.error
            : resolveToolOutputText(toolItem.output).trim()) || `status=${toolItem.status}`;
          assistantParts.push({
            type: "text",
            text: filePath
              ? `[Historical write input unavailable: ${filePath}; status=${toolItem.status}; result=${resultText}]`
              : `[Historical write input unavailable; status=${toolItem.status}; result=${resultText}]`
          });
          cursor += 1;
          continue;
        }
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

  private resolveUiLocaleForSessionContext(params: {
    workspaceId: string;
    sessionId: string;
    activeRunId: string | null;
  }): AgentUiLocale | null {
    const activeRunUiLocale = params.activeRunId
      ? normalizeAgentUiLocale(getRunRecord(this.ctx.db, params.activeRunId)?.uiLocale ?? null)
      : null;
    if (activeRunUiLocale) return activeRunUiLocale;

    const sessionLatestRunUiLocale = getLatestRunUiLocaleBySession(this.ctx.db, {
      workspaceId: params.workspaceId,
      sessionId: params.sessionId
    });
    if (sessionLatestRunUiLocale) return sessionLatestRunUiLocale;
    return getLatestRunUiLocaleGlobal(this.ctx.db);
  }

  async getMessagesContext(params: {
    workspaceId: string;
    sessionId: string;
    appendMessage?: { role: "system" | "user"; content: string };
  }) {
    return this.readSideApplication.getMessagesContext(params);
  }

  async archiveReadFromWorker(params: {
    workspaceId: string;
    sessionId: string;
    beforePos?: number;
    lineCount?: number;
    maxChars?: number;
  }) {
    return this.archiveReadApplication.read(params);
  }

  async getPromptContextForRun(params: { workspaceId: string; sessionId: string; runId: string }) {
    return this.readSideApplication.getPromptContextForRun(params);
  }

  checkChannelSenderAllowlist(input: { pluginId: string; senderId: string }) {
    const pluginId = String(input.pluginId || "").trim();
    const senderId = String(input.senderId || "").trim();

    const stored = getAgentChannelSenderAllowlistSettings(this.ctx);
    const bySettings = new Map<string, "admin" | "user">();
    for (const it of stored.items || []) {
      const channel = String(it.channel || "").trim();
      const itemSenderId = String(it.senderId || "").trim();
      if (!channel || !itemSenderId) continue;
      const role = String((it as any).role || "").trim() === "admin" ? "admin" : "user";
      bySettings.set(`${channel}\u0000${itemSenderId}`, role);
    }
    if (bySettings.size === 0) return { allowed: false, reason: "channel sender allowlist is empty" as const };
    const role = bySettings.get(`${pluginId}\u0000${senderId}`);
    if (!role) return { allowed: false, reason: "sender is not allowed" as const };
    return { allowed: true, role };
  }

  private ensureWorkspace(workspaceId: string) {
    const workspace = getWorkspace(this.ctx.db, workspaceId);
    if (!workspace) throw new HttpError(404, "workspace not found");
    return workspace;
  }
}
