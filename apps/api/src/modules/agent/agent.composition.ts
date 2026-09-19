import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import type { AgentCompactSessionRequest, AgentCompactSessionResponse, AgentMessageControlResult, AgentMessageSessionRunState } from "@agent-workbench/shared";
import { TextDecoder } from "node:util";
import type {
  AgentUpdateSessionTitleRequest,
  AgentForkSessionRequest,
  AgentRevertSessionRequest,
  AgentUiLocale,
  AgentSendMessageRequest,
  AgentSendMessageResponse,
  AgentSessionRecord,
  AgentContextToolName,
  AgentRecentSessionsResponse,
  AgentRecentWorkspacesResponse,
} from "@agent-workbench/shared/internal-contracts/agent-api-session";
import type { AgentApiPromptContextResponse, AgentProviderReplayEnvelope } from "@agent-workbench/shared/internal-contracts/agent-api";
import { isValidSkillPathSegment } from "@agent-workbench/shared/internal-contracts/agent-api-session";
import { getPromptText } from "@agent-workbench/shared/prompts";
import { AgentSubtaskErrorCode } from "@agent-workbench/shared/internal-contracts/agent-api";
import type {
  AgentApiCompleteAssistantRequest,
  AgentApiCreateStreamingAssistantRequest,
  AgentApiFlushAssistantPartsRequest,
  AgentApiResumeStreamingAssistantRequest,
  AgentApiReplaceStreamingAssistantRequest,
  AgentApiCommitCompactionRequest,
  AgentApiSubtaskPreforkPlanRequest,
  AgentApiSubtaskStartRequest,
  AgentApiSubtaskResultRequest,
  AgentApiSubtaskStatusRequest,
  AgentApiRunCompleteRequest,
  AgentApiUpdateRunNoticeRequest,
  AgentApiUpdateToolExecutionRequest,
  AgentApiArchiveReadRequest,
  AgentApiArchiveSearchRequest,
} from "@agent-workbench/shared/internal-contracts/agent-api";
import { HttpError } from "../../app/errors.js";

import type { AppContext } from "../../app/context.js";
import { nowMs } from "../../utils/time.js";
import { newSortableId } from "../../utils/ids.js";
import { AgentService } from "./agent.service.js";
import type { LocalAgentRuntimeExecutionPort } from "./agent.runtime-port.js";
import { AgentStartupCoordinator } from "./startup/agent-startup-coordinator.js";
import { getWorkspace as getWorkspaceRecord } from "../workspaces/workspace.store.js";
import {
  listEnabledWorkspaceAgentsInstructions,
  listEnabledWorkspaceExternalSkillRoots,
} from "../workspaces/workspace.service.js";
import {
  createMessageRunRecord,
  findMessageClientRequestDedup,
  insertMessageClientRequestDedup,
  getRunRecord,
  getMessageSessionById,
  getMessageRunState,
  getSessionAgentModelOverride,
  listSessionAgentModelOverrides,
  upsertSessionAgentModelOverride,
  deleteSessionAgentModelOverride,
  updateRunRecordStatus,
  updateAutoMessageSessionTitle,
  setManualMessageSessionTitle,
  AgentStreamingAssistantReplayMismatchError,
} from "./agent-message.store.js";
import {
  getAgentGlobalPromptSettings,
  getAgentMcpSettings,
  AGENT_GLOBAL_SYSTEM_PROMPT_ID,
  getAgentRuntimeSettings,
  registerGlobalSystemPromptTextProvider,
  getAgentSettings,
  getAgentProvidersSettingsInternal,
  listAvailableAgentsForSurface,
  getAgentChannelSenderAllowlistSettings,
  resolveExecutionProfile,
} from "../settings/settings.service.js";
import { listPluginRuntimeSnapshots } from "../plugins/plugin.service.js";
import {
  parseSkillFrontmatter,
  scanReadableTopLevelSkills,
} from "./top-level-skill.js";
import type { AgentRunCompletedEventHub } from "./run-completed-events.js";
import { getAgentWorkspaceRunContext } from "./agent-run-context.js";
import { RunLifecycleApplication } from "./lifecycle/run-lifecycle-application.js";
import { SqliteRunLifecyclePersistence } from "./lifecycle/sqlite-run-lifecycle-persistence.js";
import { SessionRuntimeHandoffCoordinator } from "./lifecycle/session-runtime-handoff-coordinator.js";
import { workspaceDeletingFence } from "./lifecycle/workspace-deleting-fence.js";
import {
  cleanupAgedAgentAttachmentTempFiles,
  commitAgentAttachmentTempFile,
  removeAgentAttachmentTempFile,
  removeAgentAttachmentFinalFile,
  resolveSafeAgentAttachmentContentPath,
} from "./attachments/agent-attachment-storage.js";
import {
  agentAttachmentFilePath,
  agentAttachmentWorkspaceDir,
  agentAttachmentsRoot,
  assertAgentAttachmentId,
} from "./attachments/agent-attachment-paths.js";
import {
  RunPromptStaticCache,
  RunPromptStaticCacheInvalidator,
} from "./prompt/run-prompt-static-cache.js";
import {
  PromptStaticAssembler,
  type RunPromptStatic,
} from "./prompt/prompt-static-assembler.js";
import { ExecutionProfileResolver } from "./read-side/execution-profile-resolver.js";
import { MessagesContextProjector } from "./read-side/messages-context-projector.js";
import { PromptContextProjector } from "./read-side/prompt-context-projector.js";
import { RuntimeTranscriptProjector } from "./read-side/runtime-transcript-projector.js";
import { SqliteMessageQuery } from "./read-side/sqlite-message-query.js";
import { ReadSideApplication } from "./read-side/read-side-application.js";
import { getWorkspaceEnabledAgentIds } from "../workspaces/workspace.service.js";
import { UiArtifactCapability } from "./artifact/ui-artifact-capability.js";
import { SubtaskApplication } from "./subtask/subtask-application.js";
import { SqliteSubtaskLineagePersistence } from "./subtask/sqlite-subtask-lineage-persistence.js";
import { SqliteSubtaskMaintenancePersistence } from "./subtask/sqlite-subtask-maintenance-persistence.js";
import { SqliteSubtaskRunQuery } from "./subtask/sqlite-subtask-run-query.js";
import type {
  CleanupSubtaskOrphansOnStartupCommand,
  SubtaskApplicationDependencies,
} from "./subtask/subtask-ports.js";
import type { AgentRuntimePort } from "./agent.runtime-port.js";
import { SessionInteractionApplication } from "./session/session-interaction-application.js";
import { toAutomaticSessionTitle } from "./session/session-title.js";
import { SqliteSessionInteractionStore } from "./session/sqlite-session-interaction-store.js";
import { SessionAgentModelApplication } from "./session/session-agent-model-application.js";
import {
  appendStreamingAssistant,
  commitCompactionMessage,
  commitCompactionMessageWithRunFence,
  getMessage,
  completeAssistantWithExecutions,
  resumeStreamingAssistant,
  flushStreamingParts,
  AgentMessageConflictError,
  replaceStreamingAssistant,
  discardStreamingAssistant,
  getMessageRunState as getStoredMessageRunState,
  getMessageSession,
  getMessageSessionHead,
  startMessageRun,
  updateMessageRunNotice,
  updateToolExecution,
} from "./agent-message.store.js";
import { archiveRead, archiveSearch } from "./archive/agent-archive-store.js";
import { PeripheralAgentQueryApplication } from "./query/peripheral-agent-query-application.js";
import {
  SqlitePeripheralAgentQueryStore,
} from "./query/sqlite-query-stores.js";
import { ManualCompactionApplication } from "./compaction/manual-compaction-application.js";
import type { ManualCompactionRuntime } from "./compaction/manual-compaction-ports.js";

function conflictToHttpError(err: AgentMessageConflictError): HttpError {
  return new HttpError(409, "session head conflict", err.code);
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
          description:
            "Timeout in seconds (integer). Default is 120. Note: the unit is seconds, not milliseconds.",
        },
      },
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
          description:
            "Maximum lines (file) or entries (directory) to return. Default: 500. Maximum: 2000.",
        },
      },
    };
  }
  if (toolName === "archive_read") {
    return {
      type: "object",
      additionalProperties: false,
      properties: {
        cursor: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
      },
    };
  }
  if (toolName === "archive_search") {
    return {
      type: "object",
      required: ["query"],
      additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 3 },
        cursor: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
      },
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
            "Failure hint: if the patch fails to apply due to context mismatch, regenerate the diff from the current directory or include more context lines (for example, git diff -U5).",
          ].join("\n"),
        },
      },
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
                enum: ["pending", "in_progress", "completed", "cancelled"],
              },
            },
          },
        },
      },
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
          description:
            "A short scratchpad entry to record. Suggested <= 200 characters.",
        },
      },
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
          items: { type: "string", minLength: 1 },
        },
        prompt: {
          type: "string",
        },
      },
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
          description:
            "Stable logical skill identifier shown in the available skills list, such as builtin/skill-authoring.",
        },
        filePath: {
          type: "string",
          description:
            "Optional file path relative to the skill root. Omit filePath, pass an empty string or a string containing only spaces/tabs, or pass exactly SKILL.md to read root instructions and available file paths.",
        },
      },
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
          description:
            "Briefly describe the task goal in 50 characters or fewer. Longer values will be truncated to 50 characters.",
        },
        prompt: {
          type: "string",
          minLength: 1,
          description:
            "Task instructions for the subtask. Clearly define the goal, scope or constraints, and deliverable boundary so the assignee knows exactly what to do and what not to do.",
        },
        agentId: {
          type: "string",
          minLength: 1,
          description:
            "The agent ID of the assignee role template, not a specific assignee instance. The same agentId may be reused across multiple subtasks. It defines the assignee's capabilities, working style, and deliverable requirements.",
        },
        session: {
          description:
            "Controls whether the subtask receives background context or reuses prior session memory for the assignee role.",
          oneOf: [
            {
              type: "object",
              required: ["mode"],
              additionalProperties: false,
              properties: {
                mode: { const: "new" },
              },
              description:
                "new: start a brand-new task with no parent-session or prior subtask background; give instructions only through the prompt.",
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
                  description:
                    "The existing subtask session ID whose content and memory should be resumed.",
                },
              },
              description:
                "existing: continue a specified subtask session to reuse its content and memory. Best for follow-up research, post-fix review, and other work where repeating context gathering would be wasteful.",
            },
            {
              type: "object",
              required: ["mode"],
              additionalProperties: false,
              properties: {
                mode: { const: "fork" },
              },
              description:
                "fork: provide the subtask with the full current parent-session history as background context. Use this when the user's intent must be passed through without loss.",
            },
          ],
        },
      },
    };
  }
  if (toolName === "write") {
    return {
      type: "object",
      required: ["filePath", "content"],
      additionalProperties: false,
      properties: {
        filePath: { type: "string", minLength: 1 },
        content: { type: "string" },
      },
    };
  }
  return {
    type: "object",
    required: ["filePath", "content"],
    additionalProperties: false,
    properties: {
      filePath: { type: "string", minLength: 1 },
      content: { type: "string" },
    },
  };
}

function buildSubtaskToolDescription(
  agentItems: Array<{ id: string; name: string; summary: string }>,
) {
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
    "Result: on success, returns subtaskSessionId and the subtask result text.",
  ];

  const normalizedAgents = agentItems
    .map((item) => ({
      id: String(item.id || "").trim(),
      name: String(item.name || "").trim(),
      summary: String(item.summary || "").trim(),
    }))
    .filter((item) => item.id.length > 0 && item.name.length > 0);

  if (normalizedAgents.length === 0) {
    return `${header.join("\n")}\n\nAvailable agents:\n- No agents are currently available`;
  }

  const lines = normalizedAgents.map((item) =>
    item.summary
      ? `- ${item.id}: ${item.name} - ${item.summary}`
      : `- ${item.id}: ${item.name}`,
  );
  return `${header.join("\n")}\n\nAvailable agents:\n${lines.join("\n")}`;
}

function toolDescription(
  toolName: AgentContextToolName,
  options?: { subtaskDescription?: string },
) {
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
      '- {"command":"pwd"}',
      '- {"command":"pwd && ls -la"}',
      '- {"command":"rg -n \\"TODO\\" .","workdir":"apps/api"}',
    ].join("\n");
  }
  if (toolName === "read") {
    return [
      "Read a directory or UTF-8 text file inside the current directory. Supports offset/limit pagination, truncates very long lines, and caps output at 50KB. Non-text and special file types are not supported.",
      "When reading a file, offset is the starting line number. When reading a directory, offset is the starting entry number. Both are 1-based.",
      "When continuing to read the same file or directory, use the offset explicitly returned by the previous read result instead of guessing the next offset yourself.",
      "If the result says End of file, the file has no more content to read. Do not continue paging the same file unless it changes.",
      "If the requested offset exceeds the file length, the tool returns an end-of-file notice instead of failing.",
    ].join(" ");
  }
  if (toolName === "archive_read") {
    return [
      "Read completed high-value text outside the current compacted context.",
      "Only this Session's archived ancestor range is returned, ordered oldest to newest.",
      "Use cursor only as returned by the previous call; never construct one.",
    ].join(" ");
  }
  if (toolName === "archive_search") {
    return [
      "Search completed high-value text outside the current compacted context.",
      "query requires at least three characters; results are newest to oldest.",
      "Use cursor only as returned by the previous call; never construct one.",
    ].join(" ");
  }
  if (toolName === "skill") {
    return [
      "Load a top-level skill and its text files by stable logical identifier (no filesystem paths).",
      "Input: skillId (string) is one of the identifiers in the available skills list, using builtin/... or workspace/... or repo/... prefixes.",
      "filePath is optional and is relative to the selected skill root.",
      "Omit filePath, pass an empty string or a string containing only spaces/tabs, or pass exactly SKILL.md to read root instructions and a flat list of available file paths.",
      "Any other valid filePath reads that text file with the Worker text reader's normalized content.",
    ].join(" ");
  }
  if (toolName === "visual_analyze") {
    return [
      "Analyze visual files inside the current workspace and return natural-language findings.",
      "Supported file types: PNG, JPG/JPEG, WEBP, GIF, PDF.",
      "Accepts multiple files and interprets them in input order.",
      "Input paths must be relative paths inside the workspace.",
      "If model/provider/SDK/service does not support the given files, the tool returns an error result.",
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
      "rename to src/new-name.txt",
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
      '{"goal":"Complete the todolist goal enhancement","todos":[{"content":"Review requirements and constraints","status":"completed"},{"content":"Implement core logic","status":"in_progress"},{"content":"Add tests and verification","status":"pending"}]}',
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
      '{"content":"Plan: read agent.service.ts to find tool registry"}',
    ].join("\n");
  }
  if (toolName === "subtask")
    return (
      options?.subtaskDescription || "Execute a task in a subtask session."
    );
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
      "For localized changes to an existing file, prefer apply_patch.",
    ].join("\n");
  }
  if (toolName.startsWith("mcp_")) return `Call MCP tool ${toolName}`;
  return "Write and fully overwrite a file inside the current directory. Use this as a deterministic fallback when you need to rewrite the whole file or when patch matching is unstable.";
}

function normalizeAgentUiLocale(value: unknown): AgentUiLocale | null {
  const raw = String(value || "").trim();
  if (raw === "zh-CN" || raw === "en-US") return raw;
  return null;
}

function buildOutputFormatInstruction(input: {
  uiLocale: AgentUiLocale | null;
}) {
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

  const languageInstruction = buildLanguageInstruction({
    uiLocale: input.uiLocale,
  });
  if (languageInstruction) pushGroup(languageInstruction.split("\n"));
  return lines.join("\n");
}

function normalizeTodolistGoal(value: unknown) {
  if (typeof value !== "string") return "";
  return toAutomaticSessionTitle(value, "");
}

const TERMINAL_RUN_RECORD_STATUS = new Set([
  "completed",
  "failed",
  "cancelled",
] as const);

const BUILTIN_SKILLS_ROOT = "skills";
const WORKSPACE_AGENTS_MAX_BYTES = 32 * 1024;
const COMPACTION_SNIPPET_CACHE_MAX_BYTES = 256 * 1024;
const SUBTASK_PREFORK_SUMMARY_MAX_CHARS = 20_000;
const STRUCTURED_RESULT_TOOL_NAMES = new Set([
  "apply_patch",
  "todolist",
  "subtask",
  "write",
  "scratchpad",
]);
function buildSubtaskForkGuardSystemText(input: {
  uiLocale: AgentUiLocale | null;
}) {
  if (normalizeAgentUiLocale(input.uiLocale) === "zh-CN") {
    return getPromptText("agent/subtask-fork-guard-system-text.zh-CN.txt");
  }
  return getPromptText("agent/subtask-fork-guard-system-text.en-US.txt");
}

function normalizeRunNoticeText(raw: unknown) {
  if (raw == null) return "";
  const value = String(raw).replace(/\r\n/g, "\n").replace(/\0/g, "").trim();
  if (!value) return "";
  if (value.length <= 1000) return value;
  return `${value.slice(0, 1000)}...`;
}

function buildHistoricalImagePlaceholder(attachmentCount: number) {
  return `[This user message included ${attachmentCount} image attachment(s). Their image contents are not included in this run.]`;
}

function buildImageOnlyTriggerPromptText(attachmentCount: number) {
  return `[The user sent ${attachmentCount} image attachment(s) without accompanying text.]`;
}

function buildSafeUserMessageText(text: string, attachmentCount: number) {
  const placeholder = buildHistoricalImagePlaceholder(attachmentCount);
  return text ? `${text}\n\n${placeholder}` : placeholder;
}

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
    logMessage: "failed to read top-level skill summary",
  });

  const items: SkillSummaryItem[] = [];
  for (const item of readableItems) {
    const parsed = parseSkillFrontmatter(item.text);
    const base = params.idBasePath ? `${params.idBasePath}/` : "";
    const identifierSegments = [
      params.idPrefix,
      ...base.split("/").filter(Boolean),
      item.entryName,
    ];
    if (!identifierSegments.every(isValidSkillPathSegment)) {
      params.logger.warn(
        { skillNamespace: params.idPrefix },
        "skip top-level skill with non-callable identifier",
      );
      continue;
    }
    const description = parsed.description.trim();
    items.push({
      skill: `${params.idPrefix}/${base}${item.entryName}`,
      name: parsed.name.trim() || item.entryName,
      ...(description ? { description } : {}),
    });
  }
  return items;
}

function buildSkillsInstructionSection(input: {
  builtin: SkillSummaryItem[];
  external: SkillSummaryItem[];
}) {
  const lines: string[] = [];
  lines.push(
    "Use the builtin skill tool to load details on demand by stable logical skill identifier.",
  );
  lines.push(
    'If the user mentions anything related to skills, use the "skill" tool with the corresponding skill entry, then proceed with the action. First read the root: omit filePath, pass an empty string or spaces/tabs only, or pass exactly SKILL.md. Root content includes a flat (not tree-shaped) Skill files list; copy one complete path line verbatim into filePath to read that auxiliary text file.',
  );
  lines.push("");
  lines.push("builtin skills:");
  if (input.builtin.length === 0) {
    lines.push("- (none)");
  } else {
    for (const item of input.builtin)
      lines.push(
        `- skillId: ${item.skill}; name: ${item.name}${item.description ? `; description: ${item.description}` : ""}`,
      );
  }
  lines.push("");
  lines.push("external skills:");
  if (input.external.length === 0) {
    lines.push("- (none)");
  } else {
    for (const item of input.external) {
      lines.push(
        `- skillId: ${item.skill}; name: ${item.name}${item.description ? `; description: ${item.description}` : ""}`,
      );
    }
  }
  return lines.join("\n");
}

async function readAgentsInstructionFile(params: {
  filePath: string;
  displayPath: string;
  logger: FastifyBaseLogger;
}) {
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
      const { bytesRead } = await fd.read(
        buf,
        totalRead,
        buf.length - totalRead,
        totalRead,
      );
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

    const extra = decoded.truncated
      ? "\n\n[AGENTS.md truncated: first 32KB]"
      : "";
    return {
      filePath,
      displayPath,
      content: `${decoded.text}${extra}`,
    };
  } catch (err) {
    params.logger.warn({ err, filePath }, "read AGENTS.md failed");
    return null;
  } finally {
    await fd?.close().catch(() => undefined);
  }
}

const GLOBAL_WORKFLOW_SYSTEM_PROMPT = getPromptText(
  "agent/global-workflow-system-prompt.zh-CN.txt",
);

registerGlobalSystemPromptTextProvider(() => GLOBAL_WORKFLOW_SYSTEM_PROMPT);

function buildSystemPrompt(input: {
  agentName: string;
  agentPrompt: string;
  agentGlobalPromptIds: string[];
  outputFormatInstruction?: string;
  globalPrompts: Array<{ id: string; title: string; prompt: string }>;
  runtimeInstruction?: string;
  agentsInstructions: Array<{
    filePath: string;
    displayPath: string;
    content: string;
  }>;
  skillsInstruction?: string;
}) {
  const agentPrompt = input.agentPrompt || "";
  const selectedGlobalIds = new Set(input.agentGlobalPromptIds);
  const outputFormatInstruction = String(
    input.outputFormatInstruction || "",
  ).trim();
  const runtimeInstruction = String(input.runtimeInstruction || "").trim();

  const formatSection = (kind: string, body: string, label?: string) => {
    const normalizedBody = String(body || "").trim();
    if (!normalizedBody) return "";
    const normalizedLabel = typeof label === "string" ? label.trim() : "";
    const prefix = normalizedLabel
      ? `[${kind}] ${normalizedLabel}`
      : `[${kind}]`;
    return `${prefix}\n\n${normalizedBody}`;
  };

  const sections: string[] = [];
  const systemBase =
    input.globalPrompts
      .find((item) => item.id === AGENT_GLOBAL_SYSTEM_PROMPT_ID)
      ?.prompt?.trim() || GLOBAL_WORKFLOW_SYSTEM_PROMPT.trim();
  sections.push(formatSection("system_base", systemBase));

  for (const item of input.globalPrompts) {
    if (!selectedGlobalIds.has(item.id)) continue;
    if (!item.prompt.trim()) continue;
    if (item.id === AGENT_GLOBAL_SYSTEM_PROMPT_ID) continue;
    sections.push(formatSection("global_prompt", item.prompt, item.title));
  }

  for (const item of input.agentsInstructions || []) {
    if (!item?.content?.trim()) continue;
    sections.push(
      formatSection("agents_instructions", item.content, item.displayPath),
    );
  }

  if (agentPrompt.trim()) {
    sections.push(formatSection("agent_prompt", agentPrompt, input.agentName));
  }

  if (String(input.skillsInstruction || "").trim()) {
    sections.push(
      formatSection("skills", String(input.skillsInstruction || "")),
    );
  }

  if (outputFormatInstruction) {
    sections.push(
      formatSection("output_format_instructions", outputFormatInstruction),
    );
  }

  if (runtimeInstruction) {
    sections.push(formatSection("runtime_constraints", runtimeInstruction));
  }

  return sections.filter(Boolean).join("\n\n---\n");
}

function appendRuntimeConstraintsSection(
  systemStatic: string,
  runtimeInstruction: string,
) {
  const runtime = String(runtimeInstruction || "").trim();
  if (!runtime) return systemStatic;
  const runtimeSection = `[runtime_constraints]\n\n${runtime}`;
  const base = String(systemStatic || "").trim();
  if (!base) return runtimeSection;
  return `${base}\n\n---\n${runtimeSection}`;
}

/** Named facade capability groups keep the compatibility surface partitioned by owner. */
function createSessionFacadeCapabilities<
  T extends {
    cleanupSubtaskOrphansOnStartup: (...args: any[]) => any;
    listSessions: (...args: any[]) => any;
    getSession: (...args: any[]) => any;
    getWorkspace: (...args: any[]) => any;
    createPrimarySession: (...args: any[]) => any;
    forkPrimarySession: (...args: any[]) => any;
    updateSessionTitle: (...args: any[]) => any;
    sendMessage: (...args: any[]) => any;
    compactSession: (...args: any[]) => any;
    revertSession: (...args: any[]) => any;
    listSessionModelOverrides: (...args: any[]) => any;
    setSessionModelOverride: (...args: any[]) => any;
    resetSessionModelOverride: (...args: any[]) => any;
  },
>(
  dependencies: T,
): Pick<
  T,
  | "cleanupSubtaskOrphansOnStartup"
  | "listSessions"
  | "getSession"
  | "getWorkspace"
  | "createPrimarySession"
  | "forkPrimarySession"
  | "updateSessionTitle"
  | "sendMessage"
  | "compactSession"
  | "revertSession"
  | "listSessionModelOverrides"
  | "setSessionModelOverride"
  | "resetSessionModelOverride"
> {
  const {
    cleanupSubtaskOrphansOnStartup,
    listSessions,
    getSession,
    getWorkspace,
    createPrimarySession,
    forkPrimarySession,
    updateSessionTitle,
    sendMessage,
    compactSession,
    revertSession,
    listSessionModelOverrides,
    setSessionModelOverride,
    resetSessionModelOverride,
  } = dependencies;
  return {
    cleanupSubtaskOrphansOnStartup,
    listSessions,
    getSession,
    getWorkspace,
    createPrimarySession,
    forkPrimarySession,
    updateSessionTitle,
    sendMessage,
    compactSession,
    revertSession,
    listSessionModelOverrides,
    setSessionModelOverride,
    resetSessionModelOverride,
  };
}

function createQueryFacadeCapabilities<
  T extends Record<
    | "listRecentSessions"
    | "listAvailableAgents"
    | "listRecentWorkspaces"
    | "getMessageTimeline"
    | "getMessageDetail"
    | "getToolExecutionDetail"
    | "getLastAssistantText"
    | "getLatestTodolistToolExecution"
    | "getMessageTimelineSnapshot"
    | "getMessageRunState"
    | "getApplyPatchUiArtifact"
    | "getWriteUiArtifact"
    | "getRunFinalText"
    | "getAttachmentContent",
    (...args: any[]) => any
  >,
>(
  dependencies: T,
): Pick<
  T,
  | "listRecentSessions"
  | "listAvailableAgents"
  | "listRecentWorkspaces"
  | "getMessageTimeline"
  | "getMessageDetail"
  | "getToolExecutionDetail"
  | "getLastAssistantText"
  | "getLatestTodolistToolExecution"
  | "getMessageTimelineSnapshot"
  | "getMessageRunState"
  | "getApplyPatchUiArtifact"
  | "getWriteUiArtifact"
  | "getRunFinalText"
  | "getAttachmentContent"
> {
  const {
    listRecentSessions,
    listAvailableAgents,
    listRecentWorkspaces,
    getMessageTimeline,
    getMessageDetail,
    getToolExecutionDetail,
    getLastAssistantText,
    getLatestTodolistToolExecution,
    getMessageTimelineSnapshot,
    getMessageRunState,
    getApplyPatchUiArtifact,
    getWriteUiArtifact,
    getRunFinalText,
    getAttachmentContent,
  } = dependencies;
  return {
    listRecentSessions,
    listAvailableAgents,
    listRecentWorkspaces,
    getMessageTimeline,
    getMessageDetail,
    getToolExecutionDetail,
    getLastAssistantText,
    getLatestTodolistToolExecution,
    getMessageTimelineSnapshot,
    getMessageRunState,
    getApplyPatchUiArtifact,
    getWriteUiArtifact,
    getRunFinalText,
    getAttachmentContent,
  };
}

function createLifecycleFacadeCapabilities<
  T extends Record<
    | "cancelSessionWithRuntime"
    | "recoverRunsOnStartup"
    | "createStreamingAssistantFromWorker"
    | "flushAssistantPartsFromWorker"
    | "resumeStreamingAssistantFromWorker"
    | "replaceStreamingAssistantFromWorker"
    | "discardStreamingAssistantFromWorker"
    | "completeAssistantFromWorker"
    | "updateToolExecutionFromWorker"
    | "updateRunNoticeFromWorker"
    | "completeRunFromWorker",
    (...args: any[]) => any
  >,
>(
  dependencies: T,
): Pick<
  T,
  | "cancelSessionWithRuntime"
  | "recoverRunsOnStartup"
  | "createStreamingAssistantFromWorker"
  | "flushAssistantPartsFromWorker"
  | "resumeStreamingAssistantFromWorker"
  | "replaceStreamingAssistantFromWorker"
  | "discardStreamingAssistantFromWorker"
  | "completeAssistantFromWorker"
  | "updateToolExecutionFromWorker"
  | "updateRunNoticeFromWorker"
  | "completeRunFromWorker"
> {
  const {
    cancelSessionWithRuntime,
    recoverRunsOnStartup,
    createStreamingAssistantFromWorker,
    flushAssistantPartsFromWorker,
    resumeStreamingAssistantFromWorker,
    replaceStreamingAssistantFromWorker,
    discardStreamingAssistantFromWorker,
    completeAssistantFromWorker,
    updateToolExecutionFromWorker,
    updateRunNoticeFromWorker,
    completeRunFromWorker,
  } = dependencies;
  return {
    cancelSessionWithRuntime,
    recoverRunsOnStartup,
    createStreamingAssistantFromWorker,
    flushAssistantPartsFromWorker,
    resumeStreamingAssistantFromWorker,
    replaceStreamingAssistantFromWorker,
    discardStreamingAssistantFromWorker,
    completeAssistantFromWorker,
    updateToolExecutionFromWorker,
    updateRunNoticeFromWorker,
    completeRunFromWorker,
  };
}

function createWorkerFacadeCapabilities<
  T extends Record<
    | "getSubtaskPreforkPlanFromWorker"
    | "startSubtaskRunFromWorker"
    | "getSubtaskRunResultFromWorker"
    | "getSubtaskRunStatusFromWorker"
    | "getExecutionProfileForRun"
    | "getSingleCallModelProfileForRun"
    | "getAgentMcpSettingsFromWorker"
    | "getPluginRuntimeSnapshotsFromWorker"
    | "commitCompactionFromWorker"
    | "getMessagesContext"
    | "getPromptContextForRun"
    | "archiveReadFromWorker"
    | "archiveSearchFromWorker"
    | "checkChannelSenderAllowlist",
    (...args: any[]) => any
  >,
>(
  dependencies: T,
): Pick<
  T,
  | "getSubtaskPreforkPlanFromWorker"
  | "startSubtaskRunFromWorker"
  | "getSubtaskRunResultFromWorker"
  | "getSubtaskRunStatusFromWorker"
  | "getExecutionProfileForRun"
  | "getSingleCallModelProfileForRun"
  | "getAgentMcpSettingsFromWorker"
  | "getPluginRuntimeSnapshotsFromWorker"
  | "commitCompactionFromWorker"
  | "getMessagesContext"
  | "getPromptContextForRun"
  | "archiveReadFromWorker"
  | "archiveSearchFromWorker"
  | "checkChannelSenderAllowlist"
> {
  const {
    getSubtaskPreforkPlanFromWorker,
    startSubtaskRunFromWorker,
    getSubtaskRunResultFromWorker,
    getSubtaskRunStatusFromWorker,
    getExecutionProfileForRun,
    getSingleCallModelProfileForRun,
    getAgentMcpSettingsFromWorker,
    getPluginRuntimeSnapshotsFromWorker,
    commitCompactionFromWorker,
    getMessagesContext,
    getPromptContextForRun,
    archiveReadFromWorker,
    archiveSearchFromWorker,
    checkChannelSenderAllowlist,
  } = dependencies;
  return {
    getSubtaskPreforkPlanFromWorker,
    startSubtaskRunFromWorker,
    getSubtaskRunResultFromWorker,
    getSubtaskRunStatusFromWorker,
    getExecutionProfileForRun,
    getSingleCallModelProfileForRun,
    getAgentMcpSettingsFromWorker,
    getPluginRuntimeSnapshotsFromWorker,
    commitCompactionFromWorker,
    getMessagesContext,
    getPromptContextForRun,
    archiveReadFromWorker,
    archiveSearchFromWorker,
    checkChannelSenderAllowlist,
  };
}

type AgentCompositionEnvironment = {
  db: AppContext["db"];
  dataDir: string;
  repoRoot: string;
  isAgentWorkerEnabled(): boolean;
  resolveExecutionProfile: (
    input: Parameters<typeof resolveExecutionProfile>[1],
  ) => ReturnType<typeof resolveExecutionProfile>;
  getWorkspaceEnabledAgentIds: (
    workspaceId: string,
  ) => ReturnType<typeof getWorkspaceEnabledAgentIds>;
  getWorkspaceRunContext: (
    workspaceId: string,
  ) => ReturnType<typeof getAgentWorkspaceRunContext>;
  getAgentSettings: () => ReturnType<typeof getAgentSettings>;
  getAgentProvidersSettings: () => ReturnType<
    typeof getAgentProvidersSettingsInternal
  >;
  getAgentRuntimeSettings: () => ReturnType<typeof getAgentRuntimeSettings>;
  getAgentGlobalPromptSettings: () => ReturnType<
    typeof getAgentGlobalPromptSettings
  >;
  getAgentMcpSettings: () => ReturnType<typeof getAgentMcpSettings>;
  getChannelSenderAllowlistSettings: () => ReturnType<
    typeof getAgentChannelSenderAllowlistSettings
  >;
  listAgentsInstructionSources: (
    workspaceId: string,
  ) => ReturnType<typeof listEnabledWorkspaceAgentsInstructions>;
  listExternalSkillRoots: (
    workspaceId: string,
  ) => ReturnType<typeof listEnabledWorkspaceExternalSkillRoots>;
  listAvailableAgentsForSurface: (
    surface: Parameters<typeof listAvailableAgentsForSurface>[1],
    options?: Parameters<typeof listAvailableAgentsForSurface>[2],
  ) => ReturnType<typeof listAvailableAgentsForSurface>;
  listPluginRuntimeSnapshots: () => ReturnType<
    typeof listPluginRuntimeSnapshots
  >;
};

function createAgentCompositionEnvironment(
  ctx: AppContext,
  logger: FastifyBaseLogger,
): AgentCompositionEnvironment {
  return {
    db: ctx.db,
    dataDir: ctx.dataDir,
    repoRoot: ctx.repoRoot,
    isAgentWorkerEnabled: () => ctx.agentWorkerEnabled,
    resolveExecutionProfile: (input) => resolveExecutionProfile(ctx, input),
    getWorkspaceEnabledAgentIds: (workspaceId) =>
      getWorkspaceEnabledAgentIds(ctx, workspaceId),
    getWorkspaceRunContext: (workspaceId) =>
      getAgentWorkspaceRunContext(ctx, workspaceId),
    getAgentSettings: () => getAgentSettings(ctx),
    getAgentProvidersSettings: () => getAgentProvidersSettingsInternal(ctx),
    getAgentRuntimeSettings: () => getAgentRuntimeSettings(ctx),
    getAgentGlobalPromptSettings: () => getAgentGlobalPromptSettings(ctx),
    getAgentMcpSettings: () => getAgentMcpSettings(ctx),
    getChannelSenderAllowlistSettings: () =>
      getAgentChannelSenderAllowlistSettings(ctx),
    listAgentsInstructionSources: (workspaceId) =>
      listEnabledWorkspaceAgentsInstructions({ ctx, logger, workspaceId }),
    listExternalSkillRoots: (workspaceId) =>
      listEnabledWorkspaceExternalSkillRoots(ctx, logger, workspaceId),
    listAvailableAgentsForSurface: (surface, options) =>
      listAvailableAgentsForSurface(ctx, surface, options),
    listPluginRuntimeSnapshots: () => listPluginRuntimeSnapshots(ctx),
  };
}

/** Constructs the Worker-owned compaction scheduler from Message-model inputs. */
function createManualCompactionAssembly(assembly: {
  environment: AgentCompositionEnvironment;
  enqueueActivatedRunOrReconcile: RunLifecycleApplication["enqueueActivatedRunOrReconcile"];
  getControlRunState: (sessionId: string) => AgentMessageSessionRunState;
  resolvePrimarySessionModel: (input: {
    workspaceId: string;
    sessionId: string;
    requestedAgentId?: string | null;
  }) => { agentId: string; providerId: string; modelId: string };
}) {
  const manualCompactionApplication = new ManualCompactionApplication({
    sessions: {
      get: (sessionId) => getMessageSessionById(assembly.environment.db, sessionId),
    },
    isWorkerEnabled: () => assembly.environment.isAgentWorkerEnabled(),
    findDedup: (params) =>
      findMessageClientRequestDedup(assembly.environment.db, params),
    getRunState: (workspaceId, sessionId) =>
      getMessageRunState(assembly.environment.db, workspaceId, sessionId) ?? { status: "idle" },
    getControlRunState: (sessionId) => assembly.getControlRunState(sessionId),
    resolveProfile: ({ workspaceId, sessionId, requestedAgentId }) => {
      return assembly.resolvePrimarySessionModel({
        workspaceId,
        sessionId,
        requestedAgentId,
      });
    },
    getWorkspaceRunContext: (workspaceId) =>
      assembly.environment.getWorkspaceRunContext(workspaceId),
    activate: (params) => {
      assembly.environment.db.transaction(() => {
        createMessageRunRecord(assembly.environment.db, {
          runId: params.runId,
          workspaceId: params.workspaceId,
          sessionId: params.sessionId,
          triggerMessageId: params.triggerMessageId,
          agentId: params.profile.agentId,
          providerId: params.profile.providerId,
          uiLocale: params.uiLocale,
          modelId: params.profile.modelId,
          runKind: "manual_compaction",
          subtaskDepth: 0,
          parentRunId: null,
          parentToolExecutionId: null,
          status: "running",
          createdAt: params.createdAt,
        });
        insertMessageClientRequestDedup(assembly.environment.db, {
          workspaceId: params.workspaceId,
          sessionId: params.sessionId,
          clientRequestId: params.clientRequestId,
          messageId: params.triggerMessageId,
          runId: params.runId,
          createdAt: params.createdAt,
        });
        startMessageRun(assembly.environment.db, {
          workspaceId: params.workspaceId,
          sessionId: params.sessionId,
          runId: params.runId,
          updatedAt: params.createdAt,
          noticeText: "正在压缩上下文...",
        });
      })();
    },
    enqueueActivatedRunOrReconcile: (params) => assembly.enqueueActivatedRunOrReconcile(params),
    clock: { nowMs },
    ids: { newRunId: () => newSortableId("run") },
  });
  return { manualCompactionApplication };
}

/** Constructs lifecycle, session, and subtask applications without a shared registry. */
function createLifecycleSessionSubtaskAssembly(assembly: {
  environment: AgentCompositionEnvironment;
  logger: FastifyBaseLogger;
  runPromptStaticCacheInvalidator: RunPromptStaticCacheInvalidator;
  runtimeHandoffCoordinator: SessionRuntimeHandoffCoordinator;
  runCompletedEventHub?: AgentRunCompletedEventHub | null;
  getControlRunState: (sessionId: string) => AgentMessageSessionRunState;
  resolveSubtaskParentContext: (input: any) => any;
  resolveSubtaskForkBoundaryMessageId: (input: any) => any;
  resolvePrimarySessionModel: (input: {
    workspaceId: string;
    sessionId: string;
    requestedAgentId?: string | null;
  }) => { agentId: string; providerId: string; modelId: string };
}) {
  const sqliteLifecyclePersistence = new SqliteRunLifecyclePersistence(
    assembly.environment.db,
  );
  const sqliteSubtaskLineagePersistence = new SqliteSubtaskLineagePersistence(
    assembly.environment.db,
  );
  const sqliteSubtaskRunQuery = new SqliteSubtaskRunQuery(
    assembly.environment.db,
  );
  const sqliteSubtaskMaintenancePersistence =
    new SqliteSubtaskMaintenancePersistence(assembly.environment.db);
  const runLifecycleApplication = new RunLifecycleApplication({
    workspaceRunContextReader: {
      get: (workspaceId) =>
        assembly.environment.getWorkspaceRunContext(workspaceId),
    },
    runStateReader: {
      get: (sessionId) => assembly.getControlRunState(sessionId),
    },
    activeSubtaskChildQuery: sqliteSubtaskLineagePersistence,
    promptStaticCacheInvalidator: assembly.runPromptStaticCacheInvalidator,
    runCompletedEventPublisher: {
      publishRunCompleted: (event) => {
        assembly.runCompletedEventHub?.publish({
          ...event,
          eventType: "agent.run.completed.v1",
        });
      },
    },
    persistence: sqliteLifecyclePersistence,
    attachmentCommitter: {
      commit: async ({ workspaceId, image }) => {
        await commitAgentAttachmentTempFile({
          dataDir: assembly.environment.dataDir,
          workspaceId,
          attachmentId: image.attachmentId,
          tempId: image.tempId,
        });
      },
      removeTemp: async ({ tempId }) => {
        await removeAgentAttachmentTempFile({
          dataDir: assembly.environment.dataDir,
          tempId,
        });
      },
      removeFinal: async ({ workspaceId, image }) => {
        await removeAgentAttachmentFinalFile({
          dataDir: assembly.environment.dataDir,
          workspaceId,
          attachmentId: image.attachmentId,
        });
      },
    },
    triggerInputReader: {
      getUserText: (messageId) => {
        const row = assembly.environment.db
          .prepare(
            `
            select part.text as text
            from agent_message message
            join agent_message_part part on part.message_id = message.id
            where message.id = ? and message.type = 'user' and part.type = 'text'
            order by part.position asc limit 1
          `,
          )
          .get(messageId) as { text: string | null } | undefined;
        return row?.text ?? null;
      },
    },
    isContextAppendConflict: (error) => error instanceof AgentMessageConflictError,
    runtimeHandoffCoordinator: assembly.runtimeHandoffCoordinator,
    clock: { nowMs },
    ids: { newId: newSortableId },
    logger: {
      warn: (bindings, message) => assembly.logger.warn(bindings, message),
      error: (bindings, message) => assembly.logger.error(bindings, message),
    },
  });
  const sessionStore = new SqliteSessionInteractionStore({
    db: assembly.environment.db,
    getControlRunState: (sessionId) => assembly.getControlRunState(sessionId),
    workspaceExists: (workspaceId) =>
      Boolean(getWorkspaceRecord(assembly.environment.db, workspaceId)),
  });
  const sessionInteractionApplication = new SessionInteractionApplication({
    store: sessionStore,
    profileReader: {
      resolveUser: ({ workspaceId, sessionId, requestedAgentId }) => {
        return assembly.resolvePrimarySessionModel({
          workspaceId,
          sessionId,
          requestedAgentId,
        });
      },
    },
    lifecycleStarter: runLifecycleApplication,
    clock: { nowMs },
    ids: { newSessionId: () => newSortableId("sess") },
    logger: {
      warn: (bindings, message) => assembly.logger.warn(bindings, message),
    },
    normalizeUiLocale: normalizeAgentUiLocale,
    isConflict: (error) => error instanceof AgentMessageConflictError,
    toConflictHttpError: (error) =>
      conflictToHttpError(error as AgentMessageConflictError),
  });
  const subtaskDependencies: SubtaskApplicationDependencies = {
    parentAnchorReader: {
      resolve: (params) => assembly.resolveSubtaskParentContext(params),
    },
    lineagePersistence: sqliteSubtaskLineagePersistence,
    sessionMaterializer: {
      resolveForStart: (params) =>
        sessionInteractionApplication.resolveSubtaskSessionForStart(params),
      resolveForkBoundary: (params) =>
        assembly.resolveSubtaskForkBoundaryMessageId(params),
    },
    executionProfileReader: {
      resolve: (input) => {
        const profile = assembly.environment.resolveExecutionProfile({
          surface: "subtask",
          requestedAgentId: input.requestedAgentId,
          workspaceEnablement: assembly.environment.getWorkspaceEnabledAgentIds(
            input.workspaceId,
          ),
        });
        return {
          agentId: profile.agent.id,
          agentName: profile.agent.name,
          providerId: profile.provider.id,
          modelId: profile.model.id,
          contextWindowTokens: profile.model.contextWindowTokens,
        };
      },
      findAgentName: (agentId) =>
        assembly.environment
          .getAgentSettings()
          .agents.find((item) => item.id === agentId)?.name || null,
      getMaxDepth: () =>
        assembly.environment.getAgentRuntimeSettings().maxSubtaskDepth,
    },
    workspaceReader: {
      get: (workspaceId) => {
        const workspace = getWorkspaceRecord(
          assembly.environment.db,
          workspaceId,
        );
        return workspace ? { path: workspace.path } : null;
      },
    },
    parentRunStateReader: {
      get: (workspaceId, sessionId) =>
        (() => {
          const state = getMessageRunState(assembly.environment.db, workspaceId, sessionId);
          return { status: state?.status ?? "idle", lastResponseTotalTokens: state?.lastResponseTotalTokens ?? null };
        })(),
    },
    childRunActivator: sqliteLifecyclePersistence,
    runQuery: sqliteSubtaskRunQuery,
    localCompensationPersistence: sqliteSubtaskMaintenancePersistence,
    orphanPersistence: sqliteSubtaskMaintenancePersistence,
    clock: { nowMs },
    ids: { newId: newSortableId },
    logger: {
      warn: (bindings, message) => assembly.logger.warn(bindings, message),
      error: (bindings, message) => assembly.logger.error(bindings, message),
    },
    forkGuardTextReader: {
      get: (uiLocale) => buildSubtaskForkGuardSystemText({ uiLocale }),
    },
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
    messages: Array<{
      role: "system" | "user" | "assistant" | "tool";
      content: any;
    }>;
  }>;
  buildPromptContextMessagesForSession: (input: any) => Promise<{
    messages: any[];
    providerReplay: NonNullable<AgentApiPromptContextResponse["providerReplay"]>;
  }>;
  resolveUiLocaleForSessionContext: (input: any) => any;
  buildOneShotSystemPrompt: (input: any) => any;
  ensureWorkspace: (workspaceId: string) => unknown;
}) {
  const executionProfileResolver = new ExecutionProfileResolver({
    resolveProfile: (input) =>
      assembly.resolveExecutionProfileForReadSide(input),
    getRuntime: () => assembly.getAgentRuntimeSettingsForReadSide(),
  });
  const messagesContextProjector = new MessagesContextProjector({
    buildMessages: ({ workspaceId, sessionId }) =>
      assembly.buildPromptMessagesForSession({
        workspaceId,
        sessionId,
        triggerMessageId: null,
        compactionSnippetUiLocale: null,
      }),
    getActiveRunId: ({ workspaceId, sessionId }) =>
      getMessageRunState(assembly.environment.db, workspaceId, sessionId)
        ?.activeRunId ?? null,
    resolveUiLocale: (input) =>
      assembly.resolveUiLocaleForSessionContext(input),
    buildOneShotSystem: (input) => assembly.buildOneShotSystemPrompt(input),
  });
  const promptStaticAssembler = new PromptStaticAssembler({
    getGlobalPrompts: () => assembly.environment.getAgentGlobalPromptSettings(),
    listAgentsInstructionSources: (workspaceId) =>
      assembly.environment.listAgentsInstructionSources(workspaceId),
    readAgentsInstruction: (source) =>
      readAgentsInstructionFile({ ...source, logger: assembly.logger }),
    scanBuiltinSkills: () =>
      scanTopLevelSkillSummaries({
        rootPath: path.join(assembly.environment.repoRoot, BUILTIN_SKILLS_ROOT),
        idPrefix: "builtin",
        logger: assembly.logger,
      }),
    listExternalSkillRoots: (workspaceId) =>
      assembly.environment.listExternalSkillRoots(workspaceId),
    scanExternalSkills: (root) =>
      scanTopLevelSkillSummaries({
        rootPath: root.rootPath,
        idPrefix: root.sourceType === "workspace" ? "workspace" : "repo",
        idBasePath:
          root.sourceType === "workspace"
            ? root.rootDir
            : `${root.repoId}/${root.rootDir}`,
        logger: assembly.logger,
      }),
    warnExternalSkillScanFailure: ({ err, workspaceId, root }) => {
      assembly.logger.warn(
        {
          err,
          workspaceId,
          sourceType: root.sourceType,
          repoId: root.sourceType === "repo" ? root.repoId : undefined,
        },
        "scan external skill roots failed",
      );
    },
    getMaxSubtaskDepth: () =>
      assembly.environment.getAgentRuntimeSettings().maxSubtaskDepth,
    listSubtaskAgents: () =>
      assembly.environment
        .listAvailableAgentsForSurface("subtask")
        .map((item) => ({
          id: item.id,
          name: item.name,
          summary: item.summary,
        })),
    buildSystem: (input) => buildSystemPrompt(input),
    buildOutputFormatInstruction: (input) =>
      buildOutputFormatInstruction(input),
    buildSkillsInstruction: (input) => buildSkillsInstructionSection(input),
    buildSubtaskDescription: (agents) => buildSubtaskToolDescription(agents),
    describeTool: (name, options) =>
      toolDescription(name as AgentContextToolName, options),
    getToolInputSchema: (name) => toolArgsSchema(name as AgentContextToolName),
  });
  const promptContextProjector = new PromptContextProjector(
    assembly.runPromptStaticCache,
    {
      getRunState: ({ workspaceId, sessionId }) =>
        (() => { const state = getMessageRunState(assembly.environment.db, workspaceId, sessionId); return { activeRunId: state?.activeRunId ?? null, lastResponseTotalTokens: state?.lastResponseTotalTokens ?? null }; })(),
      resolveUiLocale: (input) =>
        assembly.resolveUiLocaleForSessionContext(input),
      resolveProfile: (input) =>
        assembly.resolveExecutionProfileForReadSide(input),
      assembleStatic: (input) => promptStaticAssembler.assemble(input),
      buildRuntimeInstruction: (input) => buildRuntimeInstruction(input),
      appendRuntimeConstraints: (systemStatic, runtimeInstruction) =>
        appendRuntimeConstraintsSection(systemStatic, runtimeInstruction),
      listPendingTools: ({ workspaceId, sessionId, runId }) => {
        const rows = assembly.environment.db
          .prepare(
            `
          select execution.id as toolExecutionId, execution.call_part_id as callPartId,
                 part.message_id as assistantMessageId, execution.status,
                 part.tool_name as toolName, part.provider_tool_call_id as toolCallId,
                 part.tool_input_json as toolInputJson
          from agent_tool_execution execution
          join agent_message_part part on part.id = execution.call_part_id
          where execution.origin_session_id = @sessionId
            and execution.origin_run_id = @runId
            and execution.status in ('queued', 'running')
          order by execution.created_at asc, execution.id asc
        `,
          )
          .all({ sessionId, runId }) as Array<{
          toolExecutionId: string;
          callPartId: string;
          assistantMessageId: string;
          status: "queued" | "running";
          toolName: string;
          toolCallId: string | null;
          toolInputJson: string;
        }>;
        return rows.map((row) => ({
          toolExecutionId: row.toolExecutionId,
          callPartId: row.callPartId,
          assistantMessageId: row.assistantMessageId,
          status: row.status,
          toolName: row.toolName,
          ...(row.toolCallId ? { toolCallId: row.toolCallId } : {}),
          args: JSON.parse(row.toolInputJson) as Record<string, unknown>,
        }));
      },
      buildMessages: (input) => assembly.buildPromptContextMessagesForSession(input),
    },
  );
  const readSideApplication = new ReadSideApplication({
    findSession: (sessionId) => {
      const session = assembly.environment.db
        .prepare(
          `
          select workspace_id as workspaceId, kind, head_message_id as headMessageId, revision
          from agent_session where id = ?
        `,
        )
        .get(sessionId) as
        | {
            workspaceId: string;
            kind: "primary" | "subtask";
            headMessageId: string | null;
            revision: number;
          }
        | undefined;
      if (!session) return null;
      return {
        workspaceId: session.workspaceId,
        kind: session.kind,
        headMessageId: session.headMessageId,
        revision: Number(session.revision),
      };
    },
    findRun: (runId) =>
      (assembly.environment.db
        .prepare(
          `
        select run_id as runId, workspace_id as workspaceId, session_id as sessionId,
               agent_id as agentId, provider_id as providerId, model_id as modelId,
               subtask_depth as subtaskDepth, trigger_message_id as triggerMessageId
        from agent_run where run_id = ?
      `,
        )
        .get(runId) as
        | {
            runId: string;
            workspaceId: string;
            sessionId: string;
            agentId: string;
            providerId: string;
            modelId: string;
            subtaskDepth: number | null;
            triggerMessageId: string | null;
          }
        | undefined) ?? null,
    ensureWorkspace: (workspaceId) => {
      assembly.ensureWorkspace(workspaceId);
    },
    resolveExecutionProfile: (input) =>
      executionProfileResolver.getExecutionProfileForRun({
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        session: input.session,
        run: input.run,
      }),
    projectMessagesContext: (input) =>
      messagesContextProjector.getMessagesContext({
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        headMessageId: input.session.headMessageId,
        ...(input.appendMessage ? { appendMessage: input.appendMessage } : {}),
      }),
    projectPromptContext: (input) =>
      promptContextProjector.getPromptContextForRun(input),
  });
  const uiArtifactCapability = new UiArtifactCapability(
    assembly.environment.dataDir,
  );
  const peripheralQueryStore = new SqlitePeripheralAgentQueryStore(
    assembly.environment.db,
  );
  const availableAgentsQuery = {
    listUserAgents: (workspaceId: string) =>
      assembly.environment.listAvailableAgentsForSurface("user", {
        workspaceEnablement:
          assembly.environment.getWorkspaceEnabledAgentIds(workspaceId),
      }),
    findUserDisplayAgent: ({
      workspaceId,
      agentId,
    }: {
      workspaceId: string;
      agentId: string;
    }) => {
      const agent = assembly.environment
        .listAvailableAgentsForSurface("user", {
          workspaceEnablement:
            assembly.environment.getWorkspaceEnabledAgentIds(workspaceId),
        })
        .find((item) => item.id === agentId);
      return agent ? { id: agent.id, name: agent.name } : null;
    },
  };
  const peripheralAgentQueryApplication = new PeripheralAgentQueryApplication({
    store: peripheralQueryStore,
    availableAgentsQuery,
  });
  const messageQuery = new SqliteMessageQuery(assembly.environment.db);
  const runtimeTranscriptProjector = new RuntimeTranscriptProjector();
  return {
    readSideApplication,
    uiArtifactCapability,
    peripheralAgentQueryApplication,
    messageQuery,
    runtimeTranscriptProjector,
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
  dependencies?: AgentCompositionDependencies,
) {
  const sessionOpLocks = new Map<string, Promise<void>>();
  const runPromptStaticCache = new RunPromptStaticCache<
    Awaited<ReturnType<PromptStaticAssembler["assemble"]>>
  >();

  const sessionAgentModelApplication = new SessionAgentModelApplication({
    sessions: {
      get: (sessionId) => getMessageSessionById(environment.db, sessionId),
    },
    overrides: {
      get: (params) => getSessionAgentModelOverride(environment.db, params),
      list: (params) => listSessionAgentModelOverrides(environment.db, params),
      upsert: (record) =>
        upsertSessionAgentModelOverride(environment.db, record),
      delete: (params) =>
        deleteSessionAgentModelOverride(environment.db, params),
    },
    settings: {
      getAgents: () => environment.getAgentSettings().agents,
      getProviders: () => environment.getAgentProvidersSettings(),
      getWorkspaceEnablement: (workspaceId) =>
        environment.getWorkspaceEnabledAgentIds(workspaceId),
    },
    clock: { nowMs },
  });
  const resolvePrimarySessionModel = (input: {
    workspaceId: string;
    sessionId: string;
    requestedAgentId?: string | null;
  }) => {
    const agentId =
      input.requestedAgentId?.trim() ||
      environment.resolveExecutionProfile({
        surface: "user",
        requestedAgentId: input.requestedAgentId,
        workspaceEnablement: environment.getWorkspaceEnabledAgentIds(
          input.workspaceId,
        ),
      }).agent.id;
    const resolved = sessionAgentModelApplication.resolveForNewRun({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      agentId,
    });
    const profile = environment.resolveExecutionProfile({
      surface: "user",
      requestedAgentId: agentId,
      workspaceEnablement: environment.getWorkspaceEnabledAgentIds(
        input.workspaceId,
      ),
      modelOverride: {
        providerId: resolved.providerId,
        modelId: resolved.modelId,
      },
    });
    return {
      agentId: profile.agent.id,
      providerId: profile.provider.id,
      modelId: profile.model.id,
    };
  };

  const getMessageControlRunState = (sessionId: string): AgentMessageSessionRunState => {
    const session = getMessageSessionById(environment.db, sessionId);
    if (!session) throw new HttpError(404, "session not found");
    const state = getStoredMessageRunState(environment.db, session.workspaceId, sessionId);
    if (!state) throw new HttpError(404, "session run state not found");
    return state;
  };



  const runtimeHandoffCoordinator = new SessionRuntimeHandoffCoordinator();
  const runPromptStaticCacheInvalidator = new RunPromptStaticCacheInvalidator({
    clearRunStaticPrompt: (runId) => runPromptStaticCache.clear(runId),
  });
  const lifecycleSessionSubtaskAssembly = createLifecycleSessionSubtaskAssembly(
    {
      environment,
      logger,
      runPromptStaticCacheInvalidator,
      runtimeHandoffCoordinator,
      runCompletedEventHub,
      getControlRunState: getMessageControlRunState,
      resolveSubtaskParentContext,
      resolveSubtaskForkBoundaryMessageId,
      resolvePrimarySessionModel,
    },
  );
  const {
    sqliteLifecyclePersistence,
    sqliteSubtaskLineagePersistence,
    runLifecycleApplication,
    sessionInteractionApplication,
    subtaskApplication,
  } = lifecycleSessionSubtaskAssembly;
  const { manualCompactionApplication } = createManualCompactionAssembly({
    environment,
    getControlRunState: getMessageControlRunState,
    enqueueActivatedRunOrReconcile: (params) =>
      runLifecycleApplication.enqueueActivatedRunOrReconcile(params),
    resolvePrimarySessionModel,
  });
  const readQueryWritebackAssembly = createReadQueryWritebackAssembly({
    environment,
    logger,
    runPromptStaticCache,
    resolveExecutionProfileForReadSide,
    getAgentRuntimeSettingsForReadSide,
    buildPromptMessagesForSession,
    buildPromptContextMessagesForSession,
    resolveUiLocaleForSessionContext,
    buildOneShotSystemPrompt,
    ensureWorkspace,
  });
  const {
    readSideApplication,
    uiArtifactCapability,
    peripheralAgentQueryApplication,
    messageQuery,
    runtimeTranscriptProjector,
    executionProfileResolver,
    messagesContextProjector,
    promptStaticAssembler,
    promptContextProjector,
  } = readQueryWritebackAssembly;

  function clearRunPromptStaticCache(runId: string) {
    runPromptStaticCacheInvalidator.clear(runId);
  }

  async function runSessionOperationExclusive<T>(
    sessionId: string,
    action: () => Promise<T>,
  ): Promise<T> {
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

  function listRecentSessions(params: {
    limit?: number;
    kind?: "primary" | "subtask" | "all";
  }): AgentRecentSessionsResponse {
    return peripheralAgentQueryApplication.listRecentSessions(params);
  }

  function getSession(sessionId: string) {
    return getMessageSessionById(environment.db, sessionId);
  }

  function listAvailableAgents(params: {
    workspaceId: string;
    surface?: string;
  }) {
    return peripheralAgentQueryApplication.listAvailableAgents(params);
  }

  function listRecentWorkspaces(params: {
    limit?: number;
  }): AgentRecentWorkspacesResponse {
    return peripheralAgentQueryApplication.listRecentWorkspaces(params);
  }

  function getWorkspace(workspaceId: string) {
    return getWorkspaceRecord(environment.db, workspaceId);
  }

  function createPrimarySession(params: {
    workspaceId: string;
    title?: string;
  }) {
    return sessionInteractionApplication.createPrimarySession(params);
  }

  async function forkPrimarySession(params: AgentForkSessionRequest) {
    return await sessionInteractionApplication.forkPrimarySession(params);
  }

  function updateSessionTitle(params: {
    sessionId: string;
    body: AgentUpdateSessionTitleRequest;
  }) {
    return sessionInteractionApplication.updateSessionTitle(params);
  }

  async function sendMessage(params: {
    sessionId: string;
    body:
      | AgentSendMessageRequest
      | import("./session/session-interaction-ports.js").NormalizedAgentUserMessageInput;
    runtime: AgentRuntimePort;
  }): Promise<AgentSendMessageResponse> {
    return await sessionInteractionApplication.sendMessage(params);
  }

  function getMessageTimeline(params: Parameters<typeof messageQuery.getTimeline>[0]) {
    return messageQuery.getTimeline(params);
  }

  function getMessageDetail(params: { workspaceId: string; sessionId: string; messageId: string }) {
    return messageQuery.getMessage(params);
  }

  function getToolExecutionDetail(params: { workspaceId: string; sessionId: string; toolExecutionId: string }) {
    return messageQuery.getToolExecutionDetail(params);
  }

  function getLastAssistantText(params: { workspaceId: string; sessionId: string }) {
    return messageQuery.getLastAssistantText(params);
  }

  function getLatestTodolistToolExecution(params: { workspaceId: string; sessionId: string }) {
    return messageQuery.getLatestTodolistToolExecution(params);
  }

  async function compactSession(params: {
    sessionId: string;
    body: AgentCompactSessionRequest;
    runtime: ManualCompactionRuntime;
  }): Promise<AgentCompactSessionResponse> {
    workspaceDeletingFence.assertWritable(params.body.workspaceId);
    return runSessionOperationExclusive(params.sessionId, () => {
      // 前一个同 Session 操作释放后，删除可能已经开始；在调度前复检。
      workspaceDeletingFence.assertWritable(params.body.workspaceId);
      return manualCompactionApplication.schedule({
        sessionId: params.sessionId,
        body: params.body,
        runtime: params.runtime,
      });
    });
  }

  function projectMessageRunState(params: { workspaceId: string; sessionId: string }): AgentMessageSessionRunState {
    const state = messageQuery.getRunState(params);
    let contextTokenRatio: number | null = null;
    if (typeof state.lastResponseTotalTokens === "number") {
      const session = getMessageSessionById(environment.db, params.sessionId);
      const run = environment.db.prepare(`
        select run_id as runId, agent_id as agentId, provider_id as providerId, model_id as modelId
        from agent_run
        where workspace_id = @workspaceId and session_id = @sessionId
          and (
            run_id = @activeRunId
            or (@activeRunId is null and status in ('completed','failed','cancelled'))
          )
        order by case when run_id = @activeRunId then 0 else 1 end, updated_at desc, run_id desc
        limit 1
      `).get({ ...params, activeRunId: state.activeRunId }) as {
        runId: string; agentId: string; providerId: string; modelId: string;
      } | undefined;
      if (session && session.workspaceId === params.workspaceId && run) {
        try {
          const profile = environment.resolveExecutionProfile({
            surface: session.kind === "subtask" ? "subtask" : "user",
            agentIdFromRun: run.agentId,
            workspaceEnablement: environment.getWorkspaceEnabledAgentIds(params.workspaceId),
            providerIdFromRun: run.providerId,
            modelIdFromRun: run.modelId,
          });
          const contextWindowTokens = Number(profile.model.contextWindowTokens);
          if (Number.isFinite(contextWindowTokens) && contextWindowTokens >= 1) {
            contextTokenRatio = state.lastResponseTotalTokens / Math.floor(contextWindowTokens);
          }
        } catch (error) {
          logger.warn({ err: error, workspaceId: params.workspaceId, sessionId: params.sessionId, runId: run.runId }, "resolve context-window tokens failed for message run-state");
        }
      }
    }
    return { ...state, contextTokenRatio };
  }

  function getMessageTimelineSnapshot(params: { workspaceId: string; sessionId: string; sinceRevision?: number }) {
    const snapshot = messageQuery.getSnapshot(params);
    return { ...snapshot, runState: projectMessageRunState(params) };
  }

  async function getApplyPatchUiArtifact(params: {
    sessionId: string;
    workspaceId: string;
    toolExecutionId: string;
  }) {
    const tool = messageQuery.getArtifactToolExecution({ ...params, toolName: "apply_patch" });
    return await uiArtifactCapability.readApplyPatch(tool);
  }

  async function getWriteUiArtifact(params: {
    sessionId: string;
    workspaceId: string;
    toolExecutionId: string;
  }) {
    const tool = messageQuery.getArtifactToolExecution({ ...params, toolName: "write" });
    return await uiArtifactCapability.readWrite(tool);
  }

  function getMessageRunState(params: { workspaceId: string; sessionId: string }) {
    return projectMessageRunState(params);
  }

  async function revertSession(params: {
    sessionId: string;
    body: AgentRevertSessionRequest;
    runtime: Pick<AgentRuntimePort, "cancelSession">;
  }): Promise<AgentMessageControlResult> {
    return await sessionInteractionApplication.revertSession(params);
  }

  async function cancelSessionWithRuntime(params: {
    sessionId: string;
    workspaceId: string;
    runtime: AgentRuntimePort;
  }) {
    return runLifecycleApplication.cancelSession({
      sessionId: params.sessionId,
      workspaceId: params.workspaceId,
      runtime: params.runtime,
    });
  }

  function recoverRunsOnStartup(params: {
    runtime: AgentRuntimePort;
    beforeFinalCheck?: (candidate: {
      workspaceId: string;
      sessionId: string;
      runId: string;
      triggerMessageId: string | null;
    }) => void | Promise<void>;
  }) {
    return runLifecycleApplication.recoverRunsOnStartup(params);
  }

  function createStreamingAssistantFromWorker(
    params: AgentApiCreateStreamingAssistantRequest,
  ) {
    workspaceDeletingFence.assertWritable(params.workspaceId);
    // A response-loss replay already has a durable Message and must not read
    // the moved Session head or perform a new CAS calculation first.
    const existing = getMessage(environment.db, params.messageId);
    try {
      if (existing) {
        return {
          message: appendStreamingAssistant(environment.db, {
            ...params,
            expectedHeadMessageId: existing.previousMessageId,
            expectedRevision: 0,
            id: params.messageId, originRunId: params.runId, replacesMessageId: null,
          }),
        };
      }
      const head = getMessageSessionHead(environment.db, params);
      if (!head) throw new HttpError(404, "session not found");
      return {
        message: appendStreamingAssistant(environment.db, {
          ...params,
          expectedHeadMessageId: head.headMessageId,
          expectedRevision: head.revision,
          id: params.messageId, originRunId: params.runId, replacesMessageId: null,
        }),
      };
    } catch (err) {
      if (err instanceof AgentStreamingAssistantReplayMismatchError) {
        throw new HttpError(409, err.message, err.code);
      }
      throw err;
    }
  }

  function flushAssistantPartsFromWorker(
    params: AgentApiFlushAssistantPartsRequest,
  ) {
    workspaceDeletingFence.assertWritable(params.workspaceId);
    return { result: flushStreamingParts(environment.db, params) };
  }

  function archiveReadFromWorker(params: AgentApiArchiveReadRequest) {
    return archiveRead(environment.db, params);
  }

  function archiveSearchFromWorker(params: AgentApiArchiveSearchRequest) {
    return archiveSearch(environment.db, params);
  }

  function resumeStreamingAssistantFromWorker(
    params: AgentApiResumeStreamingAssistantRequest,
  ) {
    workspaceDeletingFence.assertWritable(params.workspaceId);
    return { result: resumeStreamingAssistant(environment.db, params) };
  }

  function replaceStreamingAssistantFromWorker(
    params: AgentApiReplaceStreamingAssistantRequest,
  ) {
    workspaceDeletingFence.assertWritable(params.workspaceId);
    const head = getMessageSessionHead(environment.db, params);
    if (!head) throw new HttpError(404, "session not found");
    return replaceStreamingAssistant(environment.db, {
      ...params,
      expectedHeadMessageId: head.headMessageId,
      expectedRevision: head.revision,
    });
  }

  function discardStreamingAssistantFromWorker(params: import("@agent-workbench/shared/internal-contracts/agent-api").AgentApiDiscardStreamingAssistantRequest) {
    workspaceDeletingFence.assertWritable(params.workspaceId);
    return { result: discardStreamingAssistant(environment.db, params) };
  }

  function completeAssistantFromWorker(
    params: AgentApiCompleteAssistantRequest,
  ) {
    workspaceDeletingFence.assertWritable(params.workspaceId);
    return { result: completeAssistantWithExecutions(environment.db, params) };
  }

  function updateToolExecutionFromWorker(
    params: AgentApiUpdateToolExecutionRequest,
  ) {
    workspaceDeletingFence.assertWritable(params.workspaceId);
    const tool = environment.db
      .prepare(`select part.tool_name as toolName from agent_tool_execution execution join agent_message_part part on part.id = execution.call_part_id where execution.id = ?`)
      .get(params.toolExecutionId) as { toolName: string | null } | undefined;
    const structuredResult = tool && STRUCTURED_RESULT_TOOL_NAMES.has(tool.toolName ?? "")
      ? params.structuredResult
      : undefined;
    const result = updateToolExecution(environment.db, {
      ...params,
      structuredResult,
      executionId: params.toolExecutionId,
    });
    if (result === "updated" && params.status === "completed") {
      const goal =
        structuredResult && typeof structuredResult === "object"
          ? (structuredResult as { goal?: unknown }).goal
          : undefined;
      const title =
        tool?.toolName === "todolist" ? normalizeTodolistGoal(goal) : "";
      if (title)
        updateAutoMessageSessionTitle(environment.db, {
          sessionId: params.sessionId,
          title,
          updatedAt: params.updatedAt,
        });
    }
    return { result };
  }

  function updateRunNoticeFromWorker(params: AgentApiUpdateRunNoticeRequest) {
    workspaceDeletingFence.assertWritable(params.workspaceId);
    return { result: updateMessageRunNotice(environment.db, params) };
  }

  function completeRunFromWorker(params: AgentApiRunCompleteRequest) {
    workspaceDeletingFence.assertWritable(params.workspaceId);
    return runLifecycleApplication.completeRunFromWorker(params);
  }

  function resolveSubtaskParentContext(params: {
    workspaceId: string;
    parentSessionId: string;
    parentRunId: string;
    parentToolExecutionId: string;
  }) {
    const parentSession = environment.db
      .prepare(
        `
      select id, workspace_id as workspaceId, title, kind,
             head_message_id as headMessageId, revision
      from agent_session where id = ?
    `,
      )
      .get(params.parentSessionId) as
      | {
          id: string;
          workspaceId: string;
          title: string;
          kind: "primary" | "subtask";
          headMessageId: string | null;
          revision: number;
        }
      | undefined;
    if (!parentSession) throw new HttpError(404, "parent session not found");
    if (parentSession.workspaceId !== params.workspaceId)
      throw new HttpError(400, "workspaceId mismatch");

    const parentRun = environment.db
      .prepare(
        `
      select run_id as runId, workspace_id as workspaceId, session_id as sessionId,
             trigger_message_id as triggerMessageId, agent_id as agentId, provider_id as providerId, ui_locale as uiLocale,
             model_id as modelId, subtask_depth as subtaskDepth, parent_run_id as parentRunId,
             parent_tool_execution_id as parentToolExecutionId, status,
             created_at as createdAt, updated_at as updatedAt
      from agent_run where run_id = ?
    `,
      )
      .get(params.parentRunId) as
      import("./subtask/subtask-ports.js").SubtaskRunRecord | undefined;
    if (
      !parentRun ||
      parentRun.sessionId !== params.parentSessionId ||
      parentRun.workspaceId !== params.workspaceId
    ) {
      throw new HttpError(404, "parent run not found");
    }
    const anchor = environment.db
      .prepare(
        `
      select execution.id as toolExecutionId, execution.origin_session_id as originSessionId,
             execution.origin_run_id as originRunId, part.message_id as assistantMessageId,
             part.tool_name as toolName
      from agent_tool_execution execution
      join agent_message_part part on part.id = execution.call_part_id
      where execution.id = ?
    `,
      )
      .get(params.parentToolExecutionId) as
      | {
          toolExecutionId: string;
          originSessionId: string | null;
          originRunId: string | null;
          assistantMessageId: string;
          toolName: string | null;
        }
      | undefined;
    if (
      !anchor ||
      anchor.originSessionId !== params.parentSessionId ||
      anchor.originRunId !== params.parentRunId
    ) {
      throw new HttpError(
        400,
        "invalid subtask anchor run",
        AgentSubtaskErrorCode.AnchorRunMismatch,
      );
    }
    if (anchor.toolName !== "subtask") {
      throw new HttpError(
        400,
        "invalid subtask anchor",
        AgentSubtaskErrorCode.AnchorInvalid,
      );
    }

    return {
      parentSession,
      parentRun,
      parentUiLocale: parentRun.uiLocale,
      anchor: {
        toolExecutionId: anchor.toolExecutionId,
        assistantMessageId: anchor.assistantMessageId,
      },
    };
  }

  function getSubtaskPreforkPlanFromWorker(
    params: AgentApiSubtaskPreforkPlanRequest,
  ) {
    return subtaskApplication.getPreforkPlan(params);
  }

  async function startSubtaskRunFromWorker(
    params: AgentApiSubtaskStartRequest,
  ) {
    workspaceDeletingFence.assertWritable(params.workspaceId);
    return await subtaskApplication.startSubtask(params);
  }

  function resolveSubtaskForkBoundaryMessageId(params: {
    workspaceId: string;
    sessionId: string;
    assistantMessageId: string;
  }) {
    const row = environment.db
      .prepare(
        `
      select previous_message_id as previousMessageId
      from agent_message
      where id = @assistantMessageId
        and workspace_id = @workspaceId
        and origin_session_id = @sessionId
        and type = 'assistant'
    `,
      )
      .get(params) as { previousMessageId: string | null } | undefined;
    if (!row)
      throw new HttpError(
        400,
        "invalid subtask fork boundary",
        AgentSubtaskErrorCode.ForkBoundaryInvalid,
      );
    return row.previousMessageId;
  }

  function getSubtaskRunResultFromWorker(params: AgentApiSubtaskResultRequest) {
    return subtaskApplication.getResult(params);
  }

  function getSubtaskRunStatusFromWorker(params: AgentApiSubtaskStatusRequest) {
    return subtaskApplication.getStatus(params);
  }

  function getRunFinalText(params: { runId: string }) {
    return messageQuery.getRunFinalText(params.runId);
  }

  function getExecutionProfileForRun(params: {
    workspaceId: string;
    sessionId: string;
    runId: string;
  }) {
    return readSideApplication.getExecutionProfileForRun(params);
  }

  function resolveExecutionProfileForReadSide(input: {
    surface: "user" | "subtask";
    workspaceId: string;
    agentId: string;
    providerId: string;
    modelId: string;
  }) {
    return environment.resolveExecutionProfile({
      surface: input.surface,
      agentIdFromRun: input.agentId,
      workspaceEnablement: environment.getWorkspaceEnabledAgentIds(
        input.workspaceId,
      ),
      providerIdFromRun: input.providerId,
      modelIdFromRun: input.modelId,
    });
  }

  function getAgentRuntimeSettingsForReadSide() {
    return environment.getAgentRuntimeSettings();
  }

  function getSingleCallModelProfileForRun(params: {
    workspaceId: string;
    sessionId: string;
    runId: string;
  }) {
    const session = getMessageSessionById(environment.db, params.sessionId);
    if (!session) throw new HttpError(404, "session not found");
    if (session.workspaceId !== params.workspaceId)
      throw new HttpError(400, "workspaceId mismatch");

    const run = getRunRecord(environment.db, params.runId);
    if (
      !run ||
      run.sessionId !== params.sessionId ||
      run.workspaceId !== params.workspaceId
    ) {
      throw new HttpError(404, "run not found");
    }

    const profile = environment.resolveExecutionProfile({
      surface: session.kind === "subtask" ? "subtask" : "user",
      agentIdFromRun: run.agentId,
      workspaceEnablement: environment.getWorkspaceEnabledAgentIds(
        session.workspaceId,
      ),
      providerIdFromRun: run.providerId,
      modelIdFromRun: run.modelId,
    });

    return {
      resolved: {
        runId: params.runId,
        sessionId: params.sessionId,
        workspaceId: params.workspaceId,
        agentId: profile.agent.id,
        providerId: profile.provider.id,
        modelId: profile.model.id,
        source: "run_snapshot" as const,
      },
      provider: profile.provider,
      model: profile.model,
    };
  }

  function getAgentMcpSettingsFromWorker() {
    return environment.getAgentMcpSettings();
  }

  async function getPluginRuntimeSnapshotsFromWorker() {
    return environment.listPluginRuntimeSnapshots();
  }

  async function commitCompactionFromWorker(params: AgentApiCommitCompactionRequest) {
    try {
      const message = commitCompactionMessageWithRunFence(environment.db, {
        id: params.messageId,
        workspaceId: params.workspaceId,
        sessionId: params.sessionId,
        runId: params.runId,
        expectedHeadMessageId: params.expectedHeadMessageId,
        expectedRevision: params.expectedRevision,
        textPartId: params.textPartId,
        text: params.summaryText.trim(),
        createdAt: params.createdAt,
      });
      if (!message) {
        return { result: "ignored" as const, summaryMessageId: null };
      }
      return { result: "updated" as const, summaryMessageId: message.id };
    } catch (error) {
      if (error instanceof AgentMessageConflictError)
        throw conflictToHttpError(error);
      throw error;
    }
  }

  async function buildPromptContextMessagesForSession(params: {
    workspaceId: string;
    sessionId: string;
    triggerMessageId: string | null;
    compactionSnippetUiLocale: AgentUiLocale | null;
    pendingAssistantMessageIds?: ReadonlySet<string>;
  }) {
    void params.compactionSnippetUiLocale;
    const source = messageQuery.getRuntimeTranscriptSource({
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
    });
    const replayByPartId = messageQuery.getRuntimeProviderReplaySource({
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
    });
    const replayOnlyAssistantMessageIds = new Set(source.messages.flatMap((message) => {
      if (message.type !== "assistant" || message.status !== "completed") return [];
      const hasVisiblePart = message.parts.some((part) =>
        part.type === "tool_call" || (part.type === "text" && part.text.length > 0));
      const hasReasoningReplay = message.parts.some((part) =>
        part.type === "reasoning"
        && replayByPartId.get(part.id)?.item.type === "reasoning");
      return !hasVisiblePart && hasReasoningReplay ? [message.id] : [];
    }));
    const projected = runtimeTranscriptProjector.projectDetailed({
      workspaceId: params.workspaceId,
      triggerMessageId: params.triggerMessageId,
      stopBeforeAssistantMessageIds: params.pendingAssistantMessageIds,
      includeEmptyAssistantMessageIds: replayOnlyAssistantMessageIds,
      ...source,
    });
    const providerReplay = source.messages.flatMap((message) => {
      const assistantOrdinal = projected.assistantMessageIndexes.get(message.id);
      if (assistantOrdinal == null || message.type !== "assistant" || message.status !== "completed") return [];
      let visibleIndex = 0;
      const parts: Array<
        | { visibleIndex: number; type: "reasoning"; text: string; providerReplay: AgentProviderReplayEnvelope }
        | { visibleIndex: number; type: "text"; providerReplay: AgentProviderReplayEnvelope }
        | { visibleIndex: number; type: "tool_call"; providerReplay: AgentProviderReplayEnvelope }
      > = [];
      for (const part of [...message.parts].sort((left, right) => left.position - right.position)) {
        if (part.type !== "text" && part.type !== "tool_call" && part.type !== "reasoning") continue;
        const replay = replayByPartId.get(part.id);
        const currentVisibleIndex = visibleIndex;
        if (part.type !== "reasoning") visibleIndex += 1;
        if (!replay) continue;
        if (part.type === "reasoning" && replay.item.type === "reasoning") {
          parts.push({ visibleIndex: currentVisibleIndex, type: "reasoning", text: part.text, providerReplay: replay });
        }
        if (part.type === "text" && replay.item.type === "text") {
          parts.push({ visibleIndex: currentVisibleIndex, type: "text", providerReplay: replay });
        }
        if (part.type === "tool_call" && replay.item.type === "function_call") {
          parts.push({ visibleIndex: currentVisibleIndex, type: "tool_call", providerReplay: replay });
        }
      }
      return parts.length > 0 ? [{ assistantOrdinal, parts }] : [];
    });
    return { messages: projected.messages, providerReplay };
  }

  async function buildPromptMessagesForSession(params: {
    workspaceId: string;
    sessionId: string;
    triggerMessageId: string | null;
    compactionSnippetUiLocale: AgentUiLocale | null;
    pendingAssistantMessageIds?: ReadonlySet<string>;
  }) {
    void params.compactionSnippetUiLocale;
    const source = messageQuery.getRuntimeTranscriptSource({
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
    });
    return {
      messages: runtimeTranscriptProjector.project({
        workspaceId: params.workspaceId,
        triggerMessageId: params.triggerMessageId,
        stopBeforeAssistantMessageIds: params.pendingAssistantMessageIds,
        ...source,
      }),
    };
  }

  function resolveUiLocaleForSessionContext(params: {
    workspaceId: string;
    sessionId: string;
    activeRunId: string | null;
  }): AgentUiLocale | null {
    if (!params.activeRunId) return null;
    const row = environment.db.prepare(`
      select ui_locale as uiLocale
      from agent_run
      where run_id = @activeRunId
        and workspace_id = @workspaceId
        and session_id = @sessionId
      limit 1
    `).get(params) as { uiLocale: unknown } | undefined;
    return normalizeAgentUiLocale(row?.uiLocale);
  }

  async function getMessagesContext(params: {
    workspaceId: string;
    sessionId: string;
    appendMessage?: { role: "system" | "user"; content: string };
  }) {
    return readSideApplication.getMessagesContext(params);
  }

  async function getPromptContextForRun(params: {
    workspaceId: string;
    sessionId: string;
    runId: string;
  }) {
    return readSideApplication.getPromptContextForRun(params);
  }

  async function getAttachmentContent(params: {
    workspaceId: string;
    sessionId: string;
    attachmentId: string;
  }) {
    try {
      assertAgentAttachmentId(params.attachmentId);
      const attachment = environment.db.prepare(
        `
          with recursive visible(message_id) as (
            select head_message_id
            from agent_session
            where id = @sessionId
              and workspace_id = @workspaceId
              and head_message_id is not null
            union all
            select message.previous_message_id
            from agent_message message
            join visible on visible.message_id = message.id
            join agent_session session
              on session.id = @sessionId and session.workspace_id = @workspaceId
            where visible.message_id <> session.context_root_message_id
              and message.previous_message_id is not null
          )
          select attachment.id as attachmentId,
            attachment.workspace_id as workspaceId,
            attachment.storage_key as storageKey,
            attachment.media_type as mediaType,
            attachment.byte_size as byteSize
          from agent_attachment attachment
          join agent_message_part part
            on part.attachment_id = attachment.id and part.type = 'image'
          join agent_message message
            on message.id = part.message_id
          join visible on visible.message_id = message.id
          where attachment.id = @attachmentId
            and attachment.workspace_id = @workspaceId
            and message.workspace_id = attachment.workspace_id
          limit 1
        `,
      ).get(params) as {
        attachmentId: string;
        workspaceId: string;
        storageKey: string;
        mediaType: "image/png" | "image/jpeg" | "image/webp";
        byteSize: number;
      } | undefined;
      if (!attachment || attachment.storageKey !== attachment.attachmentId)
        return null;
      const resolved = await resolveSafeAgentAttachmentContentPath({
        dataDir: environment.dataDir,
        workspaceId: attachment.workspaceId,
        storageKey: attachment.storageKey,
        expectedByteSize: attachment.byteSize,
      });
      if (!resolved) return null;
      return {
        handle: resolved.handle,
        filePath: resolved.filePath,
        mediaType: attachment.mediaType,
        byteSize: attachment.byteSize,
      };
    } catch {
      // Deliberately hide authorization, path and filesystem distinctions.
      return null;
    }
  }

  function checkChannelSenderAllowlist(input: {
    pluginId: string;
    senderId: string;
  }) {
    const pluginId = String(input.pluginId || "").trim();
    const senderId = String(input.senderId || "").trim();

    const stored = environment.getChannelSenderAllowlistSettings();
    const bySettings = new Map<string, "admin" | "user">();
    for (const it of stored.items || []) {
      const channel = String(it.channel || "").trim();
      const itemSenderId = String(it.senderId || "").trim();
      if (!channel || !itemSenderId) continue;
      const role =
        String((it as any).role || "").trim() === "admin" ? "admin" : "user";
      bySettings.set(`${channel}\u0000${itemSenderId}`, role);
    }
    if (bySettings.size === 0)
      return {
        allowed: false,
        reason: "channel sender allowlist is empty" as const,
      };
    const role = bySettings.get(`${pluginId}\u0000${senderId}`);
    if (!role)
      return { allowed: false, reason: "sender is not allowed" as const };
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
    updateSessionTitle,
    sendMessage,
    compactSession,
    revertSession,
    listSessionModelOverrides: (params) =>
      sessionAgentModelApplication.list(params),
    setSessionModelOverride: (params) =>
      sessionAgentModelApplication.put(params),
    resetSessionModelOverride: (params) =>
      sessionAgentModelApplication.delete(params),
  });
  const query = createQueryFacadeCapabilities({
    listRecentSessions,
    listAvailableAgents,
    listRecentWorkspaces,
      getMessageTimeline,
      getMessageDetail,
      getToolExecutionDetail,
      getLastAssistantText,
      getLatestTodolistToolExecution,
      getMessageTimelineSnapshot,
    getMessageRunState,
    getApplyPatchUiArtifact,
    getWriteUiArtifact,
    getRunFinalText,
    getAttachmentContent,
  });
  const lifecycle = createLifecycleFacadeCapabilities({
    cancelSessionWithRuntime,
    recoverRunsOnStartup,
    createStreamingAssistantFromWorker,
    flushAssistantPartsFromWorker,
    resumeStreamingAssistantFromWorker,
    replaceStreamingAssistantFromWorker,
    discardStreamingAssistantFromWorker,
    completeAssistantFromWorker,
    updateToolExecutionFromWorker,
    updateRunNoticeFromWorker,
    completeRunFromWorker,
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
    commitCompactionFromWorker,
    getMessagesContext,
    getPromptContextForRun,
    archiveReadFromWorker,
    archiveSearchFromWorker,
    checkChannelSenderAllowlist,
  });

  const serviceCapabilities = { session, query, lifecycle, worker };

  const testOnly = createCompositionTestReferences({
    lifecyclePersistence: sqliteLifecyclePersistence,
    lifecycleActiveSubtaskChildQuery: sqliteSubtaskLineagePersistence,
    subtaskLineagePersistence: sqliteSubtaskLineagePersistence,
    subtaskChildRunActivator: sqliteLifecyclePersistence,
    runPromptStaticCache,
  });

  return {
    serviceCapabilities,
    testOnly,
    runtimeHandoffCoordinator,
    dispose: () => runLifecycleApplication.dispose(),
  };
}

export type AgentServiceCapabilities = ReturnType<
  typeof createAgentApplications
>["serviceCapabilities"];

function createCompositionTestReferences<
  T extends {
    lifecyclePersistence: SqliteRunLifecyclePersistence;
    lifecycleActiveSubtaskChildQuery: SqliteSubtaskLineagePersistence;
    subtaskLineagePersistence: SqliteSubtaskLineagePersistence;
    subtaskChildRunActivator: SqliteRunLifecyclePersistence;
    runPromptStaticCache: RunPromptStaticCache<unknown>;
  },
>(references: T) {
  return references;
}

function createLocalRuntimeExecutionPort(
  capabilities: Pick<
    AgentServiceCapabilities,
    "session" | "lifecycle" | "worker"
  >,
): LocalAgentRuntimeExecutionPort {
  return {
    getPromptContextForRun: (params) =>
      capabilities.worker.getPromptContextForRun(params),
    archiveReadFromWorker: (params) =>
      capabilities.worker.archiveReadFromWorker(params),
    archiveSearchFromWorker: (params) =>
      capabilities.worker.archiveSearchFromWorker(params),
    createStreamingAssistantFromWorker: (params) =>
      capabilities.lifecycle.createStreamingAssistantFromWorker(params),
    flushAssistantPartsFromWorker: (params) =>
      capabilities.lifecycle.flushAssistantPartsFromWorker(params),
    resumeStreamingAssistantFromWorker: (params) =>
      capabilities.lifecycle.resumeStreamingAssistantFromWorker(params),
    replaceStreamingAssistantFromWorker: (params) =>
      capabilities.lifecycle.replaceStreamingAssistantFromWorker(params),
    discardStreamingAssistantFromWorker: (params) =>
      capabilities.lifecycle.discardStreamingAssistantFromWorker(params),
    completeAssistantFromWorker: (params) =>
      capabilities.lifecycle.completeAssistantFromWorker(params),
    updateToolExecutionFromWorker: (params) =>
      capabilities.lifecycle.updateToolExecutionFromWorker(params),
    updateRunNoticeFromWorker: (params) =>
      capabilities.lifecycle.updateRunNoticeFromWorker(params),
    completeRunFromWorker: (params) =>
      capabilities.lifecycle.completeRunFromWorker(params),
    getSession: (sessionId) => {
      const session = capabilities.session.getSession(sessionId);
      return session ? { headMessageId: session.headMessageId } : null;
    },
  };
}

function createStartupCoordinator(params: {
  logger: FastifyBaseLogger;
  dataDir: string;
  capabilities: Pick<AgentServiceCapabilities, "session" | "lifecycle">;
}) {
  return new AgentStartupCoordinator({
    cleanupOrphans: () => {
      params.capabilities.session.cleanupSubtaskOrphansOnStartup();
    },
    cleanupAttachmentTemps: () =>
      cleanupAgedAgentAttachmentTempFiles({
        dataDir: params.dataDir,
        nowMs: Date.now(),
        maxAgeMs: 24 * 60 * 60 * 1000,
      }),
    recoverRuns: (input) =>
      params.capabilities.lifecycle.recoverRunsOnStartup(input),
    logger: params.logger,
  });
}

export type AgentCompositionDependencies = {};

export function createAgentComposition(
  ctx: AppContext,
  logger: FastifyBaseLogger,
  runCompletedEventHub?: AgentRunCompletedEventHub | null,
  dependencies?: AgentCompositionDependencies,
) {
  const environment = createAgentCompositionEnvironment(ctx, logger);
  const { serviceCapabilities, testOnly, runtimeHandoffCoordinator, dispose } = createAgentApplications(
    environment,
    logger,
    runCompletedEventHub,
    dependencies,
  );
  const localRuntimeExecution =
    createLocalRuntimeExecutionPort(serviceCapabilities);
  const startupCoordinator = createStartupCoordinator({
    logger,
    dataDir: ctx.dataDir,
    capabilities: serviceCapabilities,
  });
  return {
    service: new AgentService(serviceCapabilities),
    localRuntimeExecution,
    startupCoordinator,
    testOnly,
    runtimeHandoffCoordinator,
    dispose,
  };
}

export function createAgentService(
  ctx: AppContext,
  logger: FastifyBaseLogger,
  runCompletedEventHub?: AgentRunCompletedEventHub | null,
  dependencies?: AgentCompositionDependencies,
) {
  return createAgentComposition(ctx, logger, runCompletedEventHub, dependencies)
    .service;
}
