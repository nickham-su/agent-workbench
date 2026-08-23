import type { FastifyBaseLogger } from "fastify";
import fs from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import type {
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
import { AgentService } from "./agent.service.js";
import type { LocalAgentRuntimeExecutionPort } from "./agent.runtime-port.js";
import { ArchiveStartupReconcileApplication } from "./archive/archive-startup-reconcile-application.js";
import { SqliteArchiveStartupSessionQuery } from "./archive/sqlite-archive-startup-session-query.js";
import { AgentStartupCoordinator } from "./startup/agent-startup-coordinator.js";
import { getWorkspace as getWorkspaceRecord } from "../workspaces/workspace.store.js";
import { listEnabledWorkspaceAgentsInstructions, listEnabledWorkspaceExternalSkillRoots } from "../workspaces/workspace.service.js";
import {
  AgentConflictError,
  appendContextItem,
  appendContextItemWithRunFence,
  getContextItemForWorkerUpdate,
  updateContextItemWithRunFence,
  createRunRecord,
  findClientRequestDedup,
  findSubtaskRunByParentTool,
  getAgentSession,
  getContextItemById as getContextItemRecordById,
  getLatestRunUiLocaleBySession,
  getLatestRunUiLocaleGlobal,
  getLatestSessionItemId,
  getRunRecord,
  getRunState as getStoredRunState,
  getSessionHead,
  getSessionTranscriptItems,
  getSessionVisibleItems,
  insertClientRequestDedup,
  listNonTerminalSessionItemIds,
  listNonTerminalSessionItemIdsByRunId,
  hasNonTerminalSessionItems,
  listNonTerminalRunIdsByItemIds,
  listNonTerminalRunIdsBySession,
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
import { PromptStaticAssembler, type RunPromptStatic } from "./prompt/prompt-static-assembler.js";
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
import { SessionInteractionApplication } from "./session/session-interaction-application.js";
import { SqliteSessionInteractionStore } from "./session/sqlite-session-interaction-store.js";
import { ContextQueryApplication } from "./query/context-query-application.js";
import { PeripheralAgentQueryApplication } from "./query/peripheral-agent-query-application.js";
import { SqliteContextQueryStore, SqlitePeripheralAgentQueryStore } from "./query/sqlite-query-stores.js";
import { ArchiveStorage } from "./archive/archive-storage.js";
import { SqliteCompactionArchivePersistence } from "./archive/sqlite-compaction-archive-persistence.js";
import { CompactionArchiveApplication } from "./compaction/compaction-archive-application.js";
import { ManualCompactionApplication } from "./compaction/manual-compaction-application.js";
import { archiveFaultHookFromLegacyTestFaults } from "./archive/archive-fault-hook.js";
import type { ManualCompactionRuntime } from "./compaction/manual-compaction-ports.js";
import { ArchiveReadApplication } from "./archive/archive-read-application.js";
import { ArchiveReadStorage } from "./archive/archive-read-storage.js";
import { CompactionSnippetCache } from "./archive/compaction-snippet-cache.js";

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

/** Named facade capability groups keep the compatibility surface partitioned by owner. */
function createSessionFacadeCapabilities<T extends {
  cleanupSubtaskOrphansOnStartup: (...args: any[]) => any;
  listSessions: (...args: any[]) => any;
  getSession: (...args: any[]) => any;
  getWorkspace: (...args: any[]) => any;
  createPrimarySession: (...args: any[]) => any;
  forkPrimarySession: (...args: any[]) => any;
  sendMessage: (...args: any[]) => any;
  compactSession: (...args: any[]) => any;
  revertSession: (...args: any[]) => any;
}>(dependencies: T): Pick<T, "cleanupSubtaskOrphansOnStartup" | "listSessions" | "getSession" | "getWorkspace" | "createPrimarySession" | "forkPrimarySession" | "sendMessage" | "compactSession" | "revertSession"> {
  const {
    cleanupSubtaskOrphansOnStartup,
    listSessions,
    getSession,
    getWorkspace,
    createPrimarySession,
    forkPrimarySession,
    sendMessage,
    compactSession,
    revertSession
  } = dependencies;
  return {
    cleanupSubtaskOrphansOnStartup,
    listSessions,
    getSession,
    getWorkspace,
    createPrimarySession,
    forkPrimarySession,
    sendMessage,
    compactSession,
    revertSession
  };
}

function createQueryFacadeCapabilities<T extends Record<
  "listRecentSessions" | "listAvailableAgents" | "listRecentWorkspaces" | "getContextItems" | "getContextItem" |
  "getApplyPatchUiArtifact" | "getWriteUiArtifact" | "getRunState" | "getSessionStatusSummary" | "getRunFinalText",
  (...args: any[]) => any
>>(dependencies: T): Pick<T, "listRecentSessions" | "listAvailableAgents" | "listRecentWorkspaces" | "getContextItems" | "getContextItem" | "getApplyPatchUiArtifact" | "getWriteUiArtifact" | "getRunState" | "getSessionStatusSummary" | "getRunFinalText"> {
  const {
    listRecentSessions, listAvailableAgents, listRecentWorkspaces, getContextItems, getContextItem,
    getApplyPatchUiArtifact, getWriteUiArtifact, getRunState, getSessionStatusSummary, getRunFinalText
  } = dependencies;
  return {
    listRecentSessions, listAvailableAgents, listRecentWorkspaces, getContextItems, getContextItem,
    getApplyPatchUiArtifact, getWriteUiArtifact, getRunState, getSessionStatusSummary, getRunFinalText
  };
}

function createLifecycleFacadeCapabilities<T extends Record<
  "cancelSessionWithRuntime" |
  "recoverRunsOnStartup" | "failRunsOnStartup" | "appendContextItemFromWorker" | "updateContextItemFromWorker" |
  "updateRunStateFromWorker" | "completeRunFromWorker",
  (...args: any[]) => any
>>(dependencies: T): Pick<T, "cancelSessionWithRuntime" | "recoverRunsOnStartup" | "failRunsOnStartup" | "appendContextItemFromWorker" | "updateContextItemFromWorker" | "updateRunStateFromWorker" | "completeRunFromWorker"> {
  const {
    cancelSessionWithRuntime,
    recoverRunsOnStartup, failRunsOnStartup, appendContextItemFromWorker, updateContextItemFromWorker,
    updateRunStateFromWorker, completeRunFromWorker
  } = dependencies;
  return {
    cancelSessionWithRuntime,
    recoverRunsOnStartup, failRunsOnStartup, appendContextItemFromWorker, updateContextItemFromWorker,
    updateRunStateFromWorker, completeRunFromWorker
  };
}

function createWorkerFacadeCapabilities<T extends Record<
  "getSubtaskPreforkPlanFromWorker" | "startSubtaskRunFromWorker" | "getSubtaskRunResultFromWorker" |
  "getSubtaskRunStatusFromWorker" | "getExecutionProfileForRun" | "getSingleCallModelProfileForRun" |
  "getAgentMcpSettingsFromWorker" | "getPluginRuntimeSnapshotsFromWorker" | "compactContextFromWorker" |
  "clearSession" | "archiveSearchFromWorker" | "getMessagesContext" | "archiveReadFromWorker" |
  "getPromptContextForRun" | "checkChannelSenderAllowlist",
  (...args: any[]) => any
>>(dependencies: T): Pick<T, "getSubtaskPreforkPlanFromWorker" | "startSubtaskRunFromWorker" | "getSubtaskRunResultFromWorker" | "getSubtaskRunStatusFromWorker" | "getExecutionProfileForRun" | "getSingleCallModelProfileForRun" | "getAgentMcpSettingsFromWorker" | "getPluginRuntimeSnapshotsFromWorker" | "compactContextFromWorker" | "clearSession" | "archiveSearchFromWorker" | "getMessagesContext" | "archiveReadFromWorker" | "getPromptContextForRun" | "checkChannelSenderAllowlist"> {
  const {
    getSubtaskPreforkPlanFromWorker, startSubtaskRunFromWorker, getSubtaskRunResultFromWorker,
    getSubtaskRunStatusFromWorker, getExecutionProfileForRun, getSingleCallModelProfileForRun,
    getAgentMcpSettingsFromWorker, getPluginRuntimeSnapshotsFromWorker, compactContextFromWorker,
    clearSession, archiveSearchFromWorker, getMessagesContext, archiveReadFromWorker,
    getPromptContextForRun, checkChannelSenderAllowlist
  } = dependencies;
  return {
    getSubtaskPreforkPlanFromWorker, startSubtaskRunFromWorker, getSubtaskRunResultFromWorker,
    getSubtaskRunStatusFromWorker, getExecutionProfileForRun, getSingleCallModelProfileForRun,
    getAgentMcpSettingsFromWorker, getPluginRuntimeSnapshotsFromWorker, compactContextFromWorker,
    clearSession, archiveSearchFromWorker, getMessagesContext, archiveReadFromWorker,
    getPromptContextForRun, checkChannelSenderAllowlist
  };
}

type AgentCompositionEnvironment = {
  db: AppContext["db"];
  dataDir: string;
  repoRoot: string;
  isAgentWorkerEnabled(): boolean;
  resolveExecutionProfile: (input: Parameters<typeof resolveExecutionProfile>[1]) => ReturnType<typeof resolveExecutionProfile>;
  getWorkspaceEnabledAgentIds: (workspaceId: string) => ReturnType<typeof getWorkspaceEnabledAgentIds>;
  getWorkspaceRunContext: (workspaceId: string) => ReturnType<typeof getAgentWorkspaceRunContext>;
  getAgentSettings: () => ReturnType<typeof getAgentSettings>;
  getAgentRuntimeSettings: () => ReturnType<typeof getAgentRuntimeSettings>;
  getAgentGlobalPromptSettings: () => ReturnType<typeof getAgentGlobalPromptSettings>;
  getAgentMcpSettings: () => ReturnType<typeof getAgentMcpSettings>;
  getChannelSenderAllowlistSettings: () => ReturnType<typeof getAgentChannelSenderAllowlistSettings>;
  listAgentsInstructionSources: (workspaceId: string) => ReturnType<typeof listEnabledWorkspaceAgentsInstructions>;
  listExternalSkillRoots: (workspaceId: string) => ReturnType<typeof listEnabledWorkspaceExternalSkillRoots>;
  listAvailableAgentsForSurface: (surface: Parameters<typeof listAvailableAgentsForSurface>[1], options?: Parameters<typeof listAvailableAgentsForSurface>[2]) => ReturnType<typeof listAvailableAgentsForSurface>;
  listPluginRuntimeSnapshots: () => ReturnType<typeof listPluginRuntimeSnapshots>;
};

function createAgentCompositionEnvironment(ctx: AppContext, logger: FastifyBaseLogger): AgentCompositionEnvironment {
  return {
    db: ctx.db,
    dataDir: ctx.dataDir,
    repoRoot: ctx.repoRoot,
    isAgentWorkerEnabled: () => ctx.agentWorkerEnabled,
    resolveExecutionProfile: (input) => resolveExecutionProfile(ctx, input),
    getWorkspaceEnabledAgentIds: (workspaceId) => getWorkspaceEnabledAgentIds(ctx, workspaceId),
    getWorkspaceRunContext: (workspaceId) => getAgentWorkspaceRunContext(ctx, workspaceId),
    getAgentSettings: () => getAgentSettings(ctx),
    getAgentRuntimeSettings: () => getAgentRuntimeSettings(ctx),
    getAgentGlobalPromptSettings: () => getAgentGlobalPromptSettings(ctx),
    getAgentMcpSettings: () => getAgentMcpSettings(ctx),
    getChannelSenderAllowlistSettings: () => getAgentChannelSenderAllowlistSettings(ctx),
    listAgentsInstructionSources: (workspaceId) => listEnabledWorkspaceAgentsInstructions({ ctx, logger, workspaceId }),
    listExternalSkillRoots: (workspaceId) => listEnabledWorkspaceExternalSkillRoots(ctx, logger, workspaceId),
    listAvailableAgentsForSurface: (surface, options) => listAvailableAgentsForSurface(ctx, surface, options),
    listPluginRuntimeSnapshots: () => listPluginRuntimeSnapshots(ctx)
  };
}

/** Constructs archive, compaction, and cache collaborators from their explicit inputs. */
function createArchiveCompactionAssembly(assembly: {
  environment: AgentCompositionEnvironment;
  logger: FastifyBaseLogger;
  dependencies?: AgentCompositionDependencies;
  runPromptStaticCache: RunPromptStaticCache<RunPromptStatic>;
  failAfterEnqueueFailure: (input: any) => unknown;
  getControlRunState: (sessionId: string) => AgentSessionRunState;
}) {
    const archiveStorage = assembly.dependencies?.archiveStorage ?? new ArchiveStorage({ dataDir: assembly.environment.dataDir, logger: assembly.logger });
    const compactionArchivePersistence = assembly.dependencies?.compactionArchivePersistence ?? new SqliteCompactionArchivePersistence(assembly.environment.db);
    const archiveReadApplication = new ArchiveReadApplication(
      { get: (sessionId) => getAgentSession(assembly.environment.db, sessionId) },
      new ArchiveReadStorage(assembly.environment.dataDir)
    );
    const compactionSnippetCache = new CompactionSnippetCache({ dataDir: assembly.environment.dataDir, logger: assembly.logger });
    const compactionArchiveApplication = new CompactionArchiveApplication({
      sessionQuery: {
        get: (sessionId) => getAgentSession(assembly.environment.db, sessionId),
        getRun: (runId) => getRunRecord(assembly.environment.db, runId),
        getVisibleItems: (workspaceId, sessionId) => getSessionVisibleItems(assembly.environment.db, workspaceId, sessionId),
        getLatestItemId: (workspaceId, sessionId) => getLatestSessionItemId(assembly.environment.db, workspaceId, sessionId)
      },
      persistence: compactionArchivePersistence,
      archiveStorage: archiveStorage,
      runState: {
        get: (workspaceId, sessionId) => getStoredRunState(assembly.environment.db, workspaceId, sessionId),
        clearLastResponseTokensIfActiveRun: (params) => {
          const state = getStoredRunState(assembly.environment.db, params.workspaceId, params.sessionId);
          if (state.activeRunId !== params.runId) return;
          updateRunState(assembly.environment.db, {
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
        setIdle: (params) => setRunStateIdle(assembly.environment.db, params),
        getControlResult: (sessionId) => assembly.getControlRunState(sessionId)
      },
      clock: { nowMs },
      logger: assembly.logger,
      isConflict: (error) => error instanceof AgentConflictError,
      toConflictHttpError: (error) => conflictToHttpError(error as AgentConflictError),
      isArchivableItem: (item) => ARCHIVABLE_ITEM_STATUS.has(item.status),
      isBoundaryMarkerItem,
      buildArchiveLine,
      buildClearSummaryText
    });
    const manualCompactionApplication = new ManualCompactionApplication({
      reconcilePendingForSessionBestEffort: (params) => compactionArchiveApplication.reconcilePendingForSessionBestEffort(params),
      sessions: {
        get: (sessionId) => getAgentSession(assembly.environment.db, sessionId),
        getVisibleItems: (workspaceId, sessionId) => getSessionVisibleItems(assembly.environment.db, workspaceId, sessionId)
      },
      isWorkerEnabled: () => assembly.environment.isAgentWorkerEnabled(),
      findDedup: (params) => findClientRequestDedup(assembly.environment.db, params),
      getRunState: (workspaceId, sessionId) => getStoredRunState(assembly.environment.db, workspaceId, sessionId),
      getControlRunState: (sessionId) => assembly.getControlRunState(sessionId),
      resolveProfile: ({ workspaceId, requestedAgentId }) => {
        const profile = assembly.environment.resolveExecutionProfile( { surface: "user", requestedAgentId, workspaceEnablement: assembly.environment.getWorkspaceEnabledAgentIds( workspaceId) });
        return { agentId: profile.agent.id, providerId: profile.provider.id, modelId: profile.model.id };
      },
      getWorkspaceRunContext: (workspaceId) => assembly.environment.getWorkspaceRunContext( workspaceId),
      activate: (params) => {
        assembly.environment.db.transaction(() => {
          createRunRecord(assembly.environment.db, { runId: params.runId, workspaceId: params.workspaceId, sessionId: params.sessionId, triggerItemId: params.triggerItemId, agentId: params.profile.agentId, providerId: params.profile.providerId, modelId: params.profile.modelId, uiLocale: params.uiLocale, subtaskDepth: 0, parentRunId: null, parentToolItemId: null, status: "running", createdAt: params.createdAt });
          insertClientRequestDedup(assembly.environment.db, { workspaceId: params.workspaceId, sessionId: params.sessionId, clientRequestId: params.clientRequestId, messageItemId: params.triggerItemId, runId: params.runId, createdAt: params.createdAt });
          updateRunState(assembly.environment.db, { workspaceId: params.workspaceId, sessionId: params.sessionId, status: "running", activeRunId: params.runId, activeAssistantItemId: null, runNoticeText: "正在压缩上下文...", updatedAt: params.createdAt, appliedItemId: getLatestSessionItemId(assembly.environment.db, params.workspaceId, params.sessionId) });
        })();
      },
      failAfterEnqueueFailure: (params) => assembly.failAfterEnqueueFailure(params),
      clock: { nowMs },
      ids: { newRunId: () => newSortableId("run") }
    });
    const runPromptStaticCacheInvalidator = new RunPromptStaticCacheInvalidator({
      clearRunStaticPrompt: (runId) => assembly.runPromptStaticCache.clear(runId)
    });

  return {
    archiveStorage,
    compactionArchivePersistence,
    archiveReadApplication,
    compactionSnippetCache,
    compactionArchiveApplication,
    manualCompactionApplication,
    runPromptStaticCacheInvalidator,
  };
}

/** Constructs lifecycle, session, and subtask applications without a shared registry. */
function createLifecycleSessionSubtaskAssembly(assembly: {
  environment: AgentCompositionEnvironment;
  logger: FastifyBaseLogger;
  archiveStorage: ArchiveStorage;
  runPromptStaticCacheInvalidator: RunPromptStaticCacheInvalidator;
  runCompletedEventHub?: AgentRunCompletedEventHub | null;
  getControlRunState: (sessionId: string) => AgentSessionRunState;
  resolveSubtaskParentContext: (input: any) => any;
  resolveSubtaskForkBoundaryItemId: (input: any) => any;
}) {
    const sqliteLifecyclePersistence = new SqliteRunLifecyclePersistence(assembly.environment.db);
    const sqliteSubtaskLineagePersistence = new SqliteSubtaskLineagePersistence(assembly.environment.db);
    const sqliteSubtaskRunQuery = new SqliteSubtaskRunQuery(assembly.environment.db);
    const sqliteSubtaskMaintenancePersistence = new SqliteSubtaskMaintenancePersistence(assembly.environment.db);
    const runLifecycleApplication = new RunLifecycleApplication({
      workspaceRunContextReader: {
        get: (workspaceId) => assembly.environment.getWorkspaceRunContext( workspaceId)
      },
      runStateReader: { get: (sessionId) => assembly.getControlRunState(sessionId) },
      activeSubtaskChildQuery: sqliteSubtaskLineagePersistence,
      promptStaticCacheInvalidator: assembly.runPromptStaticCacheInvalidator,
      runCompletedEventPublisher: {
        publishRunCompleted: (event) => {
          assembly.runCompletedEventHub?.publish({
            ...event,
            eventType: "agent.run.completed.v1"
          });
        }
      },
      persistence: sqliteLifecyclePersistence,
      triggerInputReader: {
        getUserText: (itemId) => {
          const item = getContextItemRecordById(assembly.environment.db, itemId);
          return item?.output.type === "user_text" ? item.output.text : null;
        }
      },
      isContextAppendConflict: (error) => error instanceof AgentConflictError,
      clock: { nowMs },
      ids: { newId: newSortableId },
      logger: {
        warn: (bindings, message) => assembly.logger.warn(bindings, message),
        error: (bindings, message) => assembly.logger.error(bindings, message)
      }
    });
    const sessionStore = new SqliteSessionInteractionStore({
      db: assembly.environment.db,
      dataDir: assembly.environment.dataDir,
      archiveStorage: assembly.archiveStorage,
      isBoundaryMarkerItem,
      buildArchiveLine,
      getControlRunState: (sessionId) => assembly.getControlRunState(sessionId),
      workspaceExists: (workspaceId) => Boolean(getWorkspaceRecord(assembly.environment.db, workspaceId))
    });
    const sessionInteractionApplication = new SessionInteractionApplication({
      store: sessionStore,
      profileReader: {
        resolveUser: ({ workspaceId, requestedAgentId }) => {
          const profile = assembly.environment.resolveExecutionProfile( {
            surface: "user",
            requestedAgentId,
            workspaceEnablement: assembly.environment.getWorkspaceEnabledAgentIds( workspaceId)
          });
          return { agentId: profile.agent.id, providerId: profile.provider.id, modelId: profile.model.id };
        }
      },
      lifecycleStarter: runLifecycleApplication,
      clock: { nowMs },
      ids: { newSessionId: () => newSortableId("sess") },
      logger: { warn: (bindings, message) => assembly.logger.warn(bindings, message) },
      normalizeUiLocale: normalizeAgentUiLocale,
      isConflict: (error) => error instanceof AgentConflictError,
      toConflictHttpError: (error) => conflictToHttpError(error as AgentConflictError)
    });
    const subtaskDependencies: SubtaskApplicationDependencies = {
      parentAnchorReader: {
        resolve: (params) => assembly.resolveSubtaskParentContext(params)
      },
      lineagePersistence: sqliteSubtaskLineagePersistence,
      sessionMaterializer: {
        resolveForStart: (params) => sessionInteractionApplication.resolveSubtaskSessionForStart(params),
        resolveForkBoundary: (params) => assembly.resolveSubtaskForkBoundaryItemId(params)
      },
      executionProfileReader: {
        resolve: (input) => {
          const profile = assembly.environment.resolveExecutionProfile( {
            surface: "subtask",
            requestedAgentId: input.requestedAgentId,
            workspaceEnablement: assembly.environment.getWorkspaceEnabledAgentIds( input.workspaceId)
          });
          return {
            agentId: profile.agent.id,
            agentName: profile.agent.name,
            providerId: profile.provider.id,
            modelId: profile.model.id,
            contextWindowTokens: profile.model.contextWindowTokens
          };
        },
        findAgentName: (agentId) => assembly.environment.getAgentSettings().agents.find((item) => item.id === agentId)?.name || null,
        getMaxDepth: () => assembly.environment.getAgentRuntimeSettings().maxSubtaskDepth
      },
      workspaceReader: {
        get: (workspaceId) => {
          const workspace = getWorkspaceRecord(assembly.environment.db, workspaceId);
          return workspace ? { path: workspace.path } : null;
        }
      },
      parentRunStateReader: {
        get: (workspaceId, sessionId) => getStoredRunState(assembly.environment.db, workspaceId, sessionId)
      },
      childRunActivator: sqliteLifecyclePersistence,
      runQuery: sqliteSubtaskRunQuery,
      localCompensationPersistence: sqliteSubtaskMaintenancePersistence,
      orphanPersistence: sqliteSubtaskMaintenancePersistence,
      clock: { nowMs },
      ids: { newId: newSortableId },
      logger: {
        warn: (bindings, message) => assembly.logger.warn(bindings, message),
        error: (bindings, message) => assembly.logger.error(bindings, message)
      },
      forkGuardTextReader: { get: (uiLocale) => buildSubtaskForkGuardSystemText({ uiLocale }) }
    };
    const subtaskApplication = new SubtaskApplication(subtaskDependencies);

  return {
    sqliteLifecyclePersistence,
    sqliteSubtaskLineagePersistence,
    runLifecycleApplication,
    sessionInteractionApplication,
    subtaskApplication,
  };
}

/** Constructs read/query/writeback applications from explicit read-side collaborators. */
function createReadQueryWritebackAssembly(assembly: {
  environment: AgentCompositionEnvironment;
  logger: FastifyBaseLogger;
  runPromptStaticCache: RunPromptStaticCache<RunPromptStatic>;
  resolveExecutionProfileForReadSide: (input: any) => any;
  getAgentRuntimeSettingsForReadSide: () => any;
  buildPromptMessagesForSession: (input: any) => Promise<{
    messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: any }>;
  }>;
  resolveUiLocaleForSessionContext: (input: any) => any;
  buildOneShotSystemPrompt: (input: any) => any;
  ensureWorkspace: (workspaceId: string) => unknown;
}) {
    const executionProfileResolver = new ExecutionProfileResolver({
      resolveProfile: (input) => assembly.resolveExecutionProfileForReadSide(input),
      getRuntime: () => assembly.getAgentRuntimeSettingsForReadSide()
    });
    const messagesContextProjector = new MessagesContextProjector({
      buildMessages: ({ workspaceId, sessionId }) => assembly.buildPromptMessagesForSession({
        workspaceId,
        sessionId,
        compactionSnippetUiLocale: null
      }),
      getActiveRunId: ({ workspaceId, sessionId }) => getStoredRunState(assembly.environment.db, workspaceId, sessionId).activeRunId,
      resolveUiLocale: (input) => assembly.resolveUiLocaleForSessionContext(input),
      buildOneShotSystem: (input) => assembly.buildOneShotSystemPrompt(input)
    });
    const promptStaticAssembler = new PromptStaticAssembler({
      getGlobalPrompts: () => assembly.environment.getAgentGlobalPromptSettings(),
      listAgentsInstructionSources: (workspaceId) => assembly.environment.listAgentsInstructionSources(workspaceId),
      readAgentsInstruction: (source) => readAgentsInstructionFile({ ...source, logger: assembly.logger }),
      scanBuiltinSkills: () => scanTopLevelSkillSummaries({
        rootPath: path.join(assembly.environment.repoRoot, BUILTIN_SKILLS_ROOT),
        idPrefix: "builtin",
        logger: assembly.logger
      }),
      listExternalSkillRoots: (workspaceId) => assembly.environment.listExternalSkillRoots(workspaceId),
      scanExternalSkills: (root) => scanTopLevelSkillSummaries({
        rootPath: root.rootPath,
        idPrefix: root.sourceType === "workspace" ? "workspace" : "repo",
        idBasePath: root.sourceType === "workspace" ? root.rootDir : `${root.repoId}/${root.rootDir}`,
        logger: assembly.logger
      }),
      warnExternalSkillScanFailure: ({ err, workspaceId, root }) => {
        assembly.logger.warn(
          { err, workspaceId, sourceType: root.sourceType, repoId: root.sourceType === "repo" ? root.repoId : undefined },
          "scan external skill roots failed"
        );
      },
      getMaxSubtaskDepth: () => assembly.environment.getAgentRuntimeSettings().maxSubtaskDepth,
      listSubtaskAgents: () => assembly.environment.listAvailableAgentsForSurface("subtask").map((item) => ({
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
    const promptContextProjector = new PromptContextProjector(assembly.runPromptStaticCache, {
      getRunState: ({ workspaceId, sessionId }) => getStoredRunState(assembly.environment.db, workspaceId, sessionId),
      resolveUiLocale: (input) => assembly.resolveUiLocaleForSessionContext(input),
      resolveProfile: (input) => assembly.resolveExecutionProfileForReadSide(input),
      assembleStatic: (input) => promptStaticAssembler.assemble(input),
      buildRuntimeInstruction: (input) => buildRuntimeInstruction(input),
      appendRuntimeConstraints: (systemStatic, runtimeInstruction) => appendRuntimeConstraintsSection(systemStatic, runtimeInstruction),
      listVisibleItems: ({ workspaceId, sessionId }) => getSessionVisibleItems(assembly.environment.db, workspaceId, sessionId),
      buildMessages: (input) => assembly.buildPromptMessagesForSession(input)
    });
    const readSideApplication = new ReadSideApplication({
      findSession: (sessionId) => getAgentSession(assembly.environment.db, sessionId),
      findRun: (runId) => getRunRecord(assembly.environment.db, runId),
      ensureWorkspace: (workspaceId) => {
        assembly.ensureWorkspace(workspaceId);
      },
      resolveExecutionProfile: (input) => executionProfileResolver.getExecutionProfileForRun({
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        session: input.session,
        run: input.run
      }),
      projectMessagesContext: (input) => messagesContextProjector.getMessagesContext({
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        headItemId: input.session.headItemId,
        ...(input.appendMessage ? { appendMessage: input.appendMessage } : {})
      }),
      projectPromptContext: (input) => promptContextProjector.getPromptContextForRun(input)
    });
    const uiArtifactCapability = new UiArtifactCapability(assembly.environment.dataDir);
    const contextQueryStore = new SqliteContextQueryStore(assembly.environment.db);
    const peripheralQueryStore = new SqlitePeripheralAgentQueryStore(assembly.environment.db);
    const availableAgentsQuery = {
      listUserAgents: (workspaceId: string) => assembly.environment.listAvailableAgentsForSurface("user", {
        workspaceEnablement: assembly.environment.getWorkspaceEnabledAgentIds( workspaceId)
      }),
      findUserDisplayAgent: ({ workspaceId, agentId }: { workspaceId: string; agentId: string }) => {
        const agent = assembly.environment.listAvailableAgentsForSurface("user", {
          workspaceEnablement: assembly.environment.getWorkspaceEnabledAgentIds( workspaceId)
        }).find((item) => item.id === agentId);
        return agent ? { id: agent.id, name: agent.name } : null;
      }
    };
    const contextQueryApplication = new ContextQueryApplication({
      store: contextQueryStore,
      uiArtifacts: uiArtifactCapability,
      availableAgentQuery: availableAgentsQuery,
      resolveContextWindowTokens: ({ workspaceId, sessionKind, run }) => {
        const profile = assembly.environment.resolveExecutionProfile( {
          surface: sessionKind === "subtask" ? "subtask" : "user",
          agentIdFromRun: run.agentId,
          workspaceEnablement: assembly.environment.getWorkspaceEnabledAgentIds( workspaceId),
          providerIdFromRun: run.providerId,
          modelIdFromRun: run.modelId
        });
        return profile.model.contextWindowTokens;
      },
      clock: { nowMs },
      logger: { warn: (bindings, message) => assembly.logger.warn(bindings, message) }
    });
    const peripheralAgentQueryApplication = new PeripheralAgentQueryApplication({
      store: peripheralQueryStore,
      availableAgentsQuery
    });
    const writebackApplication = new ContextWritebackApplication({
      appendWithRunFence: (params) => appendContextItemWithRunFence(assembly.environment.db, params),
      nowMs,
      formatTodolistTitle: normalizeTodolistGoal,
      updateSessionTitle: (params) => {
        updateAgentSessionTitle(assembly.environment.db, params);
      },
      isAppendConflict: (error): error is AgentConflictError => error instanceof AgentConflictError,
      warnAppendConflict: (params) => {
        assembly.logger.warn(
          {
            sessionId: params.sessionId,
            kind: params.kind,
            currentHeadItemId: params.currentHeadItemId
          },
          "agent append context item conflict"
        );
      },
      inspectForWorkerUpdate: (itemId) => getContextItemForWorkerUpdate(assembly.environment.db, itemId),
      uiArtifacts: uiArtifactCapability,
      logArtifactError: ({ itemId, message, filePath, err }) => {
        assembly.logger.error({ ...(err ? { err } : {}), itemId, ...(filePath ? { filePath } : {}) }, message);
      },
      logArtifactWarning: ({ itemId, message, hasToolCallId, hasWorkspaceId }) => {
        assembly.logger.warn({ itemId, hasToolCallId, hasWorkspaceId }, message);
      },
      updateWithRunFence: (params) => updateContextItemWithRunFence(assembly.environment.db, params)
    });

  return {
    readSideApplication,
    writebackApplication,
    uiArtifactCapability,
    contextQueryApplication,
    peripheralAgentQueryApplication,
    executionProfileResolver,
    messagesContextProjector,
    promptStaticAssembler,
    promptContextProjector,
  };
}

/**
 * Constructs existing applications from a narrow composition environment. The
 * function does not receive AppContext or return an application registry: it
 * returns only named facade capability groups and explicit test collaborators.
 */
function createAgentApplications(
  environment: AgentCompositionEnvironment,
  logger: FastifyBaseLogger,
  runCompletedEventHub?: AgentRunCompletedEventHub | null,
  dependencies?: AgentCompositionDependencies
) {
  const sessionOpLocks = new Map<string, Promise<void>>();
  const runPromptStaticCache = new RunPromptStaticCache<Awaited<ReturnType<PromptStaticAssembler["assemble"]>>>();

  const archiveAssembly = createArchiveCompactionAssembly({
    environment,
    logger,
    dependencies,
    runPromptStaticCache,
    getControlRunState: (sessionId) => getRunState(sessionId),
    failAfterEnqueueFailure: (input) => runLifecycleApplication.failRunAfterEnqueueFailure(input)
  });
  const {
    archiveStorage,
    compactionArchivePersistence,
    archiveReadApplication,
    compactionSnippetCache,
    compactionArchiveApplication,
    manualCompactionApplication,
    runPromptStaticCacheInvalidator
  } = archiveAssembly;
  const lifecycleSessionSubtaskAssembly = createLifecycleSessionSubtaskAssembly({
    environment,
    logger,
    archiveStorage,
    runPromptStaticCacheInvalidator,
    runCompletedEventHub,
    getControlRunState: (sessionId) => getRunState(sessionId),
    resolveSubtaskParentContext,
    resolveSubtaskForkBoundaryItemId
  });
  const {
    sqliteLifecyclePersistence,
    sqliteSubtaskLineagePersistence,
    runLifecycleApplication,
    sessionInteractionApplication,
    subtaskApplication
  } = lifecycleSessionSubtaskAssembly;
  const readQueryWritebackAssembly = createReadQueryWritebackAssembly({
    environment,
    logger,
    runPromptStaticCache,
    resolveExecutionProfileForReadSide,
    getAgentRuntimeSettingsForReadSide,
    buildPromptMessagesForSession,
    resolveUiLocaleForSessionContext,
    buildOneShotSystemPrompt,
    ensureWorkspace
  });
  const {
    readSideApplication,
    writebackApplication,
    uiArtifactCapability,
    contextQueryApplication,
    peripheralAgentQueryApplication,
    executionProfileResolver,
    messagesContextProjector,
    promptStaticAssembler,
    promptContextProjector
  } = readQueryWritebackAssembly;

  function clearRunPromptStaticCache(runId: string) {
    runPromptStaticCacheInvalidator.clear(runId);
  }

  async function runSessionOperationExclusive<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    const previous = sessionOpLocks.get(sessionId) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = () => resolve();
    });
    const queued = previous.then(() => current);
    sessionOpLocks.set(sessionId, queued);
    await previous;
    try {
      return await action();
    } finally {
      releaseCurrent();
      if (sessionOpLocks.get(sessionId) === queued) {
        sessionOpLocks.delete(sessionId);
      }
    }
  }

  function cleanupSubtaskOrphansOnStartup(
    command?: CleanupSubtaskOrphansOnStartupCommand,
  ) {
    return subtaskApplication.cleanupOrphansOnStartup(command);
  }

  function listSessions(workspaceId: string) {
    return sessionInteractionApplication.listSessions(workspaceId);
  }

  function listRecentSessions(params: { limit?: number; kind?: "primary" | "subtask" | "all" }): AgentRecentSessionsResponse {
    return peripheralAgentQueryApplication.listRecentSessions(params);
  }

  function getSession(sessionId: string) {
    return getAgentSession(environment.db, sessionId);
  }

  function listAvailableAgents(params: { workspaceId: string; surface?: string }) {
    return peripheralAgentQueryApplication.listAvailableAgents(params);
  }

  function listRecentWorkspaces(params: { limit?: number }): AgentRecentWorkspacesResponse {
    return peripheralAgentQueryApplication.listRecentWorkspaces(params);
  }

  function getWorkspace(workspaceId: string) {
    return getWorkspaceRecord(environment.db, workspaceId);
  }

  function createPrimarySession(params: { workspaceId: string; title?: string }) {
    return sessionInteractionApplication.createPrimarySession(params);
  }

  async function forkPrimarySession(params: AgentForkSessionRequest) {
    return await sessionInteractionApplication.forkPrimarySession(params);
  }

  async function sendMessage(params: { sessionId: string; body: AgentSendMessageRequest; runtime: AgentRuntimePort }): Promise<AgentSendMessageResponse> {
    return await sessionInteractionApplication.sendMessage(params);
  }

  function getContextItems(
    sessionId: string,
    query?: { afterId?: number; tailLimit?: number; beforeId?: number; limit?: number; expectedHeadItemId?: number }
  ): AgentContextItemsResponse {
    return contextQueryApplication.getContextItems(sessionId, query);
  }

  async function compactSession(params: { sessionId: string; body: AgentCompactSessionRequest; runtime: ManualCompactionRuntime }): Promise<AgentCompactSessionResponse> {
    return runSessionOperationExclusive(params.sessionId, () => manualCompactionApplication.schedule({
      sessionId: params.sessionId,
      body: params.body,
      runtime: params.runtime
    }));
  }

  function getContextItem(sessionId: string, itemId: number) {
    return contextQueryApplication.getContextItem(sessionId, itemId);
  }

  async function getApplyPatchUiArtifact(params: { sessionId: string; itemId: number }) {
    return await contextQueryApplication.getApplyPatchUiArtifact(params);
  }

  async function getWriteUiArtifact(params: { sessionId: string; itemId: number }) {
    return await contextQueryApplication.getWriteUiArtifact(params);
  }

  function getRunState(sessionId: string): AgentSessionRunState {
    return contextQueryApplication.getRunState(sessionId);
  }

  function getSessionStatusSummary(params: { sessionId: string; agentId?: string | null; selectedAgentId?: string | null }) {
    return contextQueryApplication.getSessionStatusSummary(params);
  }

  async function revertSession(params: { sessionId: string; body: AgentRevertSessionRequest; runtime: Pick<AgentRuntimePort, "cancelSession"> }): Promise<AgentControlResult> {
    return await sessionInteractionApplication.revertSession(params);
  }

  async function cancelSessionWithRuntime(params: { sessionId: string; workspaceId: string; runtime: AgentRuntimePort }) {
    return runLifecycleApplication.cancelSession({
      sessionId: params.sessionId,
      workspaceId: params.workspaceId,
      runtime: params.runtime
    });
  }

  function recoverRunsOnStartup(params: {
    runtime: AgentRuntimePort;
    beforeFinalCheck?: (candidate: { workspaceId: string; sessionId: string; runId: string; triggerItemId: number | null }) => void | Promise<void>;
  }) {
    return runLifecycleApplication.recoverRunsOnStartup(params);
  }

  function failRunsOnStartup() {
    return runLifecycleApplication.failRunsOnStartup();
  }

  function appendContextItemFromWorker(params: AgentApiCreateContextItemRequest) {
    return writebackApplication.appendContextItemFromWorker(params);
  }

  async function updateContextItemFromWorker(params: AgentApiUpdateContextItemRequest & { itemId: number }) {
    return writebackApplication.updateContextItemFromWorker(params);
  }


  function updateRunStateFromWorker(params: AgentApiRunStateRequest) {
    return runLifecycleApplication.updateRunStateFromWorker(params);
  }

  function completeRunFromWorker(params: AgentApiRunCompleteRequest) {
    return runLifecycleApplication.completeRunFromWorker(params);
  }

  function resolveSubtaskParentContext(params: {
    workspaceId: string;
    parentSessionId: string;
    parentRunId: string;
    parentToolItemId: number;
  }) {
    const parentSession = getAgentSession(environment.db, params.parentSessionId);
    if (!parentSession) throw new HttpError(404, "parent session not found");
    if (parentSession.workspaceId !== params.workspaceId) throw new HttpError(400, "workspaceId mismatch");

    const parentRun = getRunRecord(environment.db, params.parentRunId);
    if (!parentRun || parentRun.sessionId !== params.parentSessionId || parentRun.workspaceId !== params.workspaceId) {
      throw new HttpError(404, "parent run not found");
    }
    const parentUiLocale = normalizeAgentUiLocale(parentRun.uiLocale);

    const anchor = getContextItemRecordById(environment.db, params.parentToolItemId);
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

  function getSubtaskPreforkPlanFromWorker(params: AgentApiSubtaskPreforkPlanRequest) {
    return subtaskApplication.getPreforkPlan(params);
  }

  async function startSubtaskRunFromWorker(params: AgentApiSubtaskStartRequest) {
    return await subtaskApplication.startSubtask(params);
  }

  function resolveSubtaskForkBoundaryItemId(params: {
    workspaceId: string;
    sessionId: string;
    anchor: AgentContextItemRecord;
  }) {
    let cursorId = params.anchor.prevId;
    while (cursorId != null) {
      const item = getContextItemRecordById(environment.db, cursorId);
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

  function getSubtaskRunResultFromWorker(params: AgentApiSubtaskResultRequest) {
    return subtaskApplication.getResult(params);
  }

  function getSubtaskRunStatusFromWorker(params: AgentApiSubtaskStatusRequest) {
    return subtaskApplication.getStatus(params);
  }

  function getRunFinalText(params: { runId: string }) {
    return peripheralAgentQueryApplication.getRunFinalText(params);
  }

  function getExecutionProfileForRun(params: { workspaceId: string; sessionId: string; runId: string }) {
    return readSideApplication.getExecutionProfileForRun(params);
  }

  function resolveExecutionProfileForReadSide(input: {
    surface: "user" | "subtask";
    workspaceId: string;
    agentId: string;
    providerId: string;
    modelId: string;
  }) {
    return environment.resolveExecutionProfile( {
      surface: input.surface,
      agentIdFromRun: input.agentId,
      workspaceEnablement: environment.getWorkspaceEnabledAgentIds( input.workspaceId),
      providerIdFromRun: input.providerId,
      modelIdFromRun: input.modelId
    });
  }

  function getAgentRuntimeSettingsForReadSide() {
    return environment.getAgentRuntimeSettings();
  }

  function getSingleCallModelProfileForRun(params: { workspaceId: string; sessionId: string; runId: string }) {
    const session = getAgentSession(environment.db, params.sessionId);
    if (!session) throw new HttpError(404, "session not found");
    if (session.workspaceId !== params.workspaceId) throw new HttpError(400, "workspaceId mismatch");

    const run = getRunRecord(environment.db, params.runId);
    if (!run || run.sessionId !== params.sessionId || run.workspaceId !== params.workspaceId) {
      throw new HttpError(404, "run not found");
    }

    const profile = environment.resolveExecutionProfile( {
      surface: session.kind === "subtask" ? "subtask" : "user",
      agentIdFromRun: run.agentId,
      workspaceEnablement: environment.getWorkspaceEnabledAgentIds( session.workspaceId),
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

  function getAgentMcpSettingsFromWorker() {
    return environment.getAgentMcpSettings();
  }

  async function getPluginRuntimeSnapshotsFromWorker() {
    return environment.listPluginRuntimeSnapshots();
  }

  async function compactContextFromWorker(params: AgentApiCompactContextRequest) {
    return runSessionOperationExclusive(params.sessionId, () => compactionArchiveApplication.applyWorkerCompaction(params));
  }

  async function clearSession(sessionId: string, body: AgentClearSessionRequest & { uiLocale?: AgentUiLocale | null }): Promise<AgentControlResult> {
    return runSessionOperationExclusive(sessionId, () => compactionArchiveApplication.clearSession({
      sessionId,
      workspaceId: body.workspaceId,
      reason: body.reason,
      uiLocale: normalizeAgentUiLocale(body.uiLocale)
    }));
  }

  async function archiveSearchFromWorker(params: {
    workspaceId: string;
    sessionId: string;
    query: string;
    beforePos?: number;
    maxHits?: number;
    maxChars?: number;
    snippet?: boolean;
    regex?: boolean;
  }) {
    return archiveReadApplication.search(params);
  }

  async function buildPromptMessagesForSession(params: {
    workspaceId: string;
    sessionId: string;
    // 仅 prompt-context 需要 locale 用于 compaction snippet 文案。
    compactionSnippetUiLocale: AgentUiLocale | null;
  }) {
    const visible = getSessionVisibleItems(environment.db, params.workspaceId, params.sessionId);
    const hasCompactionBoundaryMarker = visible.some((item) => {
      if (!item) return false;
      if (item.kind !== "system" || item.status !== "completed") return false;
      if (item.output.type !== "system_text") return false;
      const boundary = typeof item.boundaryReason === "string" ? item.boundaryReason.trim() : "";
      if (boundary !== "compaction") return false;
      return shouldIncludeSystemTextInPrompt(item.output.text);
    });
    const transcript = hasCompactionBoundaryMarker
      ? getSessionTranscriptItems(environment.db, params.workspaceId, params.sessionId)
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
            snippetText = await compactionSnippetCache.readBestEffort({
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

              const posLines = await archiveStorage.findExcerptByItemIds({
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
                const minPos = Math.min(...posLines.map((r: { pos: number }) => r.pos));
                snippetText = buildCompactionSnippetMessageText({
                  excerptLines,
                  minPos,
                  uiLocale: params.compactionSnippetUiLocale
                });
                await compactionSnippetCache.writeBestEffort({
                  workspaceId: params.workspaceId,
                  sessionId: params.sessionId,
                  summaryItemId,
                  text: snippetText
                });
              }
            } catch (err) {
              logger.warn({ err, sessionId: params.sessionId }, "failed to build compaction snippet");
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

  function resolveUiLocaleForSessionContext(params: {
    workspaceId: string;
    sessionId: string;
    activeRunId: string | null;
  }): AgentUiLocale | null {
    const activeRunUiLocale = params.activeRunId
      ? normalizeAgentUiLocale(getRunRecord(environment.db, params.activeRunId)?.uiLocale ?? null)
      : null;
    if (activeRunUiLocale) return activeRunUiLocale;

    const sessionLatestRunUiLocale = getLatestRunUiLocaleBySession(environment.db, {
      workspaceId: params.workspaceId,
      sessionId: params.sessionId
    });
    if (sessionLatestRunUiLocale) return sessionLatestRunUiLocale;
    return getLatestRunUiLocaleGlobal(environment.db);
  }

  async function getMessagesContext(params: {
    workspaceId: string;
    sessionId: string;
    appendMessage?: { role: "system" | "user"; content: string };
  }) {
    return readSideApplication.getMessagesContext(params);
  }

  async function archiveReadFromWorker(params: {
    workspaceId: string;
    sessionId: string;
    beforePos?: number;
    lineCount?: number;
    maxChars?: number;
  }) {
    return archiveReadApplication.read(params);
  }

  async function getPromptContextForRun(params: { workspaceId: string; sessionId: string; runId: string }) {
    return readSideApplication.getPromptContextForRun(params);
  }

  function checkChannelSenderAllowlist(input: { pluginId: string; senderId: string }) {
    const pluginId = String(input.pluginId || "").trim();
    const senderId = String(input.senderId || "").trim();

    const stored = environment.getChannelSenderAllowlistSettings();
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

  function ensureWorkspace(workspaceId: string) {
    const workspace = getWorkspaceRecord(environment.db, workspaceId);
    if (!workspace) throw new HttpError(404, "workspace not found");
    return workspace;
  }

  const session = createSessionFacadeCapabilities({
    cleanupSubtaskOrphansOnStartup,
    listSessions,
    getSession,
    getWorkspace,
    createPrimarySession,
    forkPrimarySession,
    sendMessage,
    compactSession,
    revertSession
  });
  const query = createQueryFacadeCapabilities({
    listRecentSessions,
    listAvailableAgents,
    listRecentWorkspaces,
    getContextItems,
    getContextItem,
    getApplyPatchUiArtifact,
    getWriteUiArtifact,
    getRunState,
    getSessionStatusSummary,
    getRunFinalText
  });
  const lifecycle = createLifecycleFacadeCapabilities({
    cancelSessionWithRuntime,
    recoverRunsOnStartup,
    failRunsOnStartup,
    appendContextItemFromWorker,
    updateContextItemFromWorker,
    updateRunStateFromWorker,
    completeRunFromWorker
  });
  const worker = createWorkerFacadeCapabilities({
    getSubtaskPreforkPlanFromWorker,
    startSubtaskRunFromWorker,
    getSubtaskRunResultFromWorker,
    getSubtaskRunStatusFromWorker,
    getExecutionProfileForRun,
    getSingleCallModelProfileForRun,
    getAgentMcpSettingsFromWorker,
    getPluginRuntimeSnapshotsFromWorker,
    compactContextFromWorker,
    clearSession,
    archiveSearchFromWorker,
    getMessagesContext,
    archiveReadFromWorker,
    getPromptContextForRun,
    checkChannelSenderAllowlist
  });

  const serviceCapabilities = { session, query, lifecycle, worker };

  const testOnly = createCompositionTestReferences({
    lifecyclePersistence: sqliteLifecyclePersistence,
    lifecycleActiveSubtaskChildQuery: sqliteSubtaskLineagePersistence,
    subtaskLineagePersistence: sqliteSubtaskLineagePersistence,
    subtaskChildRunActivator: sqliteLifecyclePersistence,
    runPromptStaticCache
  });

  return {
    serviceCapabilities,
    testOnly
  };
}

export type AgentServiceCapabilities = ReturnType<typeof createAgentApplications>["serviceCapabilities"];

function createCompositionTestReferences<T extends {
  lifecyclePersistence: SqliteRunLifecyclePersistence;
  lifecycleActiveSubtaskChildQuery: SqliteSubtaskLineagePersistence;
  subtaskLineagePersistence: SqliteSubtaskLineagePersistence;
  subtaskChildRunActivator: SqliteRunLifecyclePersistence;
  runPromptStaticCache: RunPromptStaticCache<unknown>;
}>(references: T) {
  return references;
}

function createLocalRuntimeExecutionPort(capabilities: Pick<AgentServiceCapabilities, "session" | "lifecycle" | "worker">): LocalAgentRuntimeExecutionPort {
  return {
    getPromptContextForRun: (params) => capabilities.worker.getPromptContextForRun(params),
    appendContextItemFromWorker: (params) => capabilities.lifecycle.appendContextItemFromWorker(params),
    updateContextItemFromWorker: (params) => capabilities.lifecycle.updateContextItemFromWorker(params),
    updateRunStateFromWorker: (params) => capabilities.lifecycle.updateRunStateFromWorker(params),
    completeRunFromWorker: (params) => capabilities.lifecycle.completeRunFromWorker(params),
    getSession: (sessionId) => capabilities.session.getSession(sessionId)
  };
}

function createArchiveStartupCoordinator(params: {
  db: AppContext["db"];
  archiveStorage: ArchiveStorage;
  logger: FastifyBaseLogger;
  recoveryMode: AppContext["agentStartupRecoveryMode"];
  capabilities: Pick<AgentServiceCapabilities, "session" | "lifecycle">;
}) {
  const archiveStartupSessionQuery = new SqliteArchiveStartupSessionQuery(params.db);
  const archiveStartupReconcile = new ArchiveStartupReconcileApplication({
    listSessions: () => archiveStartupSessionQuery.listForReconcile(),
    reconcilePendingBestEffort: (input) => params.archiveStorage.reconcilePendingBestEffort(input),
    logger: params.logger
  });
  return new AgentStartupCoordinator({
    cleanupOrphans: () => { params.capabilities.session.cleanupSubtaskOrphansOnStartup(); },
    reconcileArchive: () => archiveStartupReconcile.reconcileAllPendingBestEffort(),
    failRuns: () => params.capabilities.lifecycle.failRunsOnStartup(),
    recoverRuns: (input) => params.capabilities.lifecycle.recoverRunsOnStartup(input),
    logger: params.logger,
    recoveryMode: params.recoveryMode
  });
}

export type AgentCompositionDependencies = {
  archiveStorage?: ArchiveStorage;
  compactionArchivePersistence?: SqliteCompactionArchivePersistence;
};

export function createAgentComposition(
  ctx: AppContext,
  logger: FastifyBaseLogger,
  runCompletedEventHub?: AgentRunCompletedEventHub | null,
  dependencies?: AgentCompositionDependencies
) {
  const archiveStorage = dependencies?.archiveStorage ?? new ArchiveStorage({
    dataDir: ctx.dataDir,
    logger,
    faultHook: archiveFaultHookFromLegacyTestFaults(ctx.agentTestFaults)
  });
  const compactionArchivePersistence = dependencies?.compactionArchivePersistence ?? new SqliteCompactionArchivePersistence(ctx.db);
  const environment = createAgentCompositionEnvironment(ctx, logger);
  const { serviceCapabilities, testOnly } = createAgentApplications(environment, logger, runCompletedEventHub, {
    archiveStorage,
    compactionArchivePersistence
  });
  const localRuntimeExecution = createLocalRuntimeExecutionPort(serviceCapabilities);
  const startupCoordinator = createArchiveStartupCoordinator({
    db: ctx.db,
    archiveStorage,
    logger,
    recoveryMode: ctx.agentStartupRecoveryMode,
    capabilities: serviceCapabilities
  });
  return {
    service: new AgentService(serviceCapabilities),
    localRuntimeExecution,
    startupCoordinator,
    testOnly
  };
}

export function createAgentService(
  ctx: AppContext,
  logger: FastifyBaseLogger,
  runCompletedEventHub?: AgentRunCompletedEventHub | null,
  dependencies?: AgentCompositionDependencies
) {
  return createAgentComposition(ctx, logger, runCompletedEventHub, dependencies).service;
}
