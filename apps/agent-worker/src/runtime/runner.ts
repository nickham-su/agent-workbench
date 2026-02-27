import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { jsonSchema, streamText, tool } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { runBashCommand } from "./bash.js";
import { AgentApiClient, ApiConflictError, type ExecutionProfile, type PromptContext } from "./apiClient.js";
import { runReadTool, runWriteTool } from "./fileTools.js";

function nowMs() {
  return Date.now();
}

function parseIntOrDefault(raw: string | undefined, fallback: number) {
  const parsed = Number.parseInt(String(raw || "").trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

const DEBUG_DUMP_ENABLED = process.env.AWB_AGENT_DEBUG_DUMP === "1";
const DEBUG_DUMP_RELATIVE_DIR = path.join(".debug", "agent_context_item_logs");
const LOOP_MAX_STEPS = parseIntOrDefault(process.env.AWB_AGENT_LOOP_MAX_STEPS, 128);
const LOOP_REPEAT_TOOL_CALL_THRESHOLD = parseIntOrDefault(process.env.AWB_AGENT_LOOP_REPEAT_TOOL_CALL_THRESHOLD, 20);

function newSortableId(prefix: string) {
  const ts = Date.now().toString(36).padStart(10, "0");
  const random = randomBytes(6).toString("hex");
  return `${prefix}_${ts}${random}`;
}

type QueuedRun = {
  workspaceId: string;
  sessionId: string;
  runId: string;
  inputText?: string;
  workspacePath: string;
};

type PendingTool = {
  itemId: number;
  status: "queued" | "running" | "awaiting_permission" | "streaming" | "completed" | "failed" | "denied" | "cancelled";
  toolName: "bash" | "read" | "write";
  toolCallId: string;
  args: Record<string, unknown>;
  approved?: boolean;
};

type ToolCall = {
  toolName: "bash" | "read" | "write";
  toolCallId: string;
  args: Record<string, unknown>;
};

const RESERVED_MODEL_OPTION_KEYS = new Set([
  "model",
  "system",
  "prompt",
  "messages",
  "input",
  "abortSignal",
  "providerOptions",
  "tools",
  "toolChoice"
]);

function isSafeObjectKey(raw: string) {
  if (!raw) return false;
  return raw !== "__proto__" && raw !== "prototype" && raw !== "constructor";
}

function toRecordObject(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

function providerOptionsKeyByNpm(npm: ExecutionProfile["provider"]["npm"]) {
  return npm === "@ai-sdk/anthropic" ? "anthropic" : "openai";
}

function buildModelRuntimeOptions(profile: ExecutionProfile) {
  const source = toRecordObject(profile.model.options) ?? {};
  const aiSdkSource = toRecordObject(source.aiSdk) ?? {};
  const aiSdk: Record<string, unknown> = {};
  for (const [rawKey, value] of Object.entries(aiSdkSource)) {
    const key = rawKey.trim();
    if (!isSafeObjectKey(key)) continue;
    if (RESERVED_MODEL_OPTION_KEYS.has(key)) continue;
    aiSdk[key] = value;
  }

  if (aiSdk.maxOutputTokens === undefined && source.maxOutputTokens !== undefined) {
    aiSdk.maxOutputTokens = source.maxOutputTokens;
  }

  const providerOptionsByKey = toRecordObject(source.providerOptionsByKey) ?? {};
  const providerKey = providerOptionsKeyByNpm(profile.provider.npm);
  const providerFromMap = toRecordObject(providerOptionsByKey[providerKey]);
  const providerOptions: Record<string, unknown> = {};
  if (providerFromMap) {
    for (const [rawKey, value] of Object.entries(providerFromMap)) {
      const key = rawKey.trim();
      if (!isSafeObjectKey(key)) continue;
      providerOptions[key] = value;
    }
  }

  if (Object.keys(providerOptions).length === 0) {
    for (const [rawKey, value] of Object.entries(source)) {
      const key = rawKey.trim();
      if (!isSafeObjectKey(key)) continue;
      if (key === "aiSdk" || key === "providerOptionsByKey" || key === "maxOutputTokens") continue;
      providerOptions[key] = value;
    }
  }

  return {
    aiSdk,
    providerOptions,
    providerKey
  };
}

function createLanguageModel(profile: ExecutionProfile) {
  const providerModelId =
    typeof profile.model.providerModelId === "string" && profile.model.providerModelId.trim()
      ? profile.model.providerModelId.trim()
      : profile.model.id;

  if (profile.provider.npm === "@ai-sdk/openai") {
    const sdk = createOpenAI({
      apiKey: profile.provider.options.apiKey,
      baseURL: profile.provider.options.baseURL
    });
    return sdk.responses(providerModelId);
  }

  if (profile.provider.npm === "@ai-sdk/anthropic") {
    const sdk = createAnthropic({
      apiKey: profile.provider.options.apiKey,
      baseURL: profile.provider.options.baseURL
    });
    return sdk(providerModelId);
  }

  throw new Error(`unsupported provider npm: ${profile.provider.npm}`);
}

function isSensitiveKey(rawKey: string) {
  const key = rawKey.toLowerCase();
  return (
    key === "authorization" ||
    key === "api_key" ||
    key === "apikey" ||
    key.includes("token") ||
    key.includes("secret") ||
    key.includes("password")
  );
}

function sanitizeForDebugDump(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForDebugDump(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    if (isSensitiveKey(key)) {
      result[key] = "***";
      continue;
    }
    result[key] = sanitizeForDebugDump(item);
  }
  return result;
}

async function writeItemLog(params: {
  logger: Pick<Console, "warn">;
  workspacePath: string;
  kind: "assistant" | "tool";
  itemId: number;
  payload: unknown;
}) {
  if (!DEBUG_DUMP_ENABLED) return;
  const dirPath = path.join(params.workspacePath, DEBUG_DUMP_RELATIVE_DIR, params.kind);
  const filePath = path.join(dirPath, `${params.itemId}.log`);
  try {
    await fs.mkdir(dirPath, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(sanitizeForDebugDump(params.payload), null, 2), "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    params.logger.warn(`[agent-worker] write item log failed: ${message}`);
  }
}

function normalizeToolName(raw: unknown): "bash" | "read" | "write" | null {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "bash" || value === "read" || value === "write") return value;
  return null;
}

function normalizeToolArgs(raw: unknown) {
  const value = toRecordObject(raw);
  return value ?? {};
}

function toolSignature(toolName: string, args: Record<string, unknown>) {
  return `${toolName}:${JSON.stringify(args)}`;
}

export class AgentRunner {
  private readonly queue: QueuedRun[] = [];
  private readonly queuedRunIds = new Set<string>();
  private readonly runningSessions = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private activeCount = 0;

  constructor(
    private readonly apiClient: AgentApiClient,
    private readonly logger: Pick<Console, "info" | "warn" | "error">,
    private readonly concurrency: number
  ) {}

  enqueueRun(run: QueuedRun) {
    if (this.queuedRunIds.has(run.runId)) return;
    this.queue.push(run);
    this.queuedRunIds.add(run.runId);
    this.pump();
  }

  cancelSession(sessionId: string) {
    const controller = this.controllers.get(sessionId);
    if (controller) controller.abort();
    for (let i = this.queue.length - 1; i >= 0; i -= 1) {
      const item = this.queue[i];
      if (!item || item.sessionId !== sessionId) continue;
      this.queuedRunIds.delete(item.runId);
      this.queue.splice(i, 1);
    }
  }

  private pump() {
    while (this.activeCount < this.concurrency) {
      const index = this.queue.findIndex((item) => !this.runningSessions.has(item.sessionId));
      if (index < 0) return;
      const [next] = this.queue.splice(index, 1);
      if (!next) return;
      this.queuedRunIds.delete(next.runId);
      this.startRun(next);
    }
  }

  private startRun(run: QueuedRun) {
    this.activeCount += 1;
    this.runningSessions.add(run.sessionId);
    const controller = new AbortController();
    this.controllers.set(run.sessionId, controller);

    void this.processRun(run, controller.signal)
      .catch((err) => {
        this.logger.error("worker run failed", err);
      })
      .finally(() => {
        this.controllers.delete(run.sessionId);
        this.runningSessions.delete(run.sessionId);
        this.activeCount -= 1;
        this.pump();
      });
  }

  private async executeTool(params: {
    profile: ExecutionProfile;
    run: QueuedRun;
    tool: PendingTool;
    signal: AbortSignal;
  }) {
    const { profile, run, tool, signal } = params;
    if (signal.aborted) return { paused: false as const };

    const outputBase = {
      type: "tool" as const,
      toolName: tool.toolName,
      toolCallId: tool.toolCallId,
      args: tool.args
    };

    if (tool.status === "awaiting_permission") {
      await this.apiClient.updateRunState({
        workspaceId: run.workspaceId,
        sessionId: run.sessionId,
        status: "waiting_permission",
        activeRunId: run.runId,
        activeAssistantItemId: null,
        waitingToolItemId: tool.itemId,
        updatedAt: nowMs()
      });
      return { paused: true as const };
    }

    const allowedByPermissions =
      (tool.toolName === "read" && profile.agent.permissions.allowRead) ||
      (tool.toolName === "write" && profile.agent.permissions.allowWrite) ||
      (tool.toolName === "bash" && profile.agent.permissions.allowBash);

    if (!allowedByPermissions && tool.approved !== true) {
      await this.apiClient.updateContextItem({
        itemId: tool.itemId,
        status: "awaiting_permission",
        output: outputBase,
        updatedAt: nowMs()
      });
      await writeItemLog({
        logger: this.logger,
        workspacePath: run.workspacePath,
        kind: "tool",
        itemId: tool.itemId,
        payload: {
          meta: {
            workspaceId: run.workspaceId,
            sessionId: run.sessionId,
            runId: run.runId,
            toolItemId: tool.itemId
          },
          request: {
            toolName: tool.toolName,
            toolCallId: tool.toolCallId,
            args: tool.args
          },
          status: "awaiting_permission"
        }
      });
      await this.apiClient.updateRunState({
        workspaceId: run.workspaceId,
        sessionId: run.sessionId,
        status: "waiting_permission",
        activeRunId: run.runId,
        activeAssistantItemId: null,
        waitingToolItemId: tool.itemId,
        updatedAt: nowMs()
      });
      return { paused: true as const };
    }

    await this.apiClient.updateContextItem({
      itemId: tool.itemId,
      status: "running",
      output: outputBase,
      updatedAt: nowMs()
    });

    try {
      let result: unknown;
      if (tool.toolName === "bash") {
        const command = String(tool.args.command || "").trim();
        const bash = await runBashCommand({
          command,
          cwd: run.workspacePath,
          timeoutMs: 120_000,
          maxOutputBytes: 512 * 1024,
          signal
        });
        result = {
          command,
          exitCode: bash.code,
          timedOut: bash.timedOut,
          outputLimitExceeded: bash.outputLimitExceeded,
          stdout: bash.stdout,
          stderr: bash.stderr
        };
      } else if (tool.toolName === "read") {
        const filePath = String(tool.args.filePath || "");
        const offsetRaw = tool.args.offset;
        const limitRaw = tool.args.limit;
        const offset = Number.isFinite(Number(offsetRaw)) ? Number(offsetRaw) : undefined;
        const limit = Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : undefined;
        result = await runReadTool({
          workspacePath: run.workspacePath,
          filePath,
          offset,
          limit,
          signal
        });
      } else {
        const filePath = String(tool.args.filePath || "");
        const content = String(tool.args.content ?? "");
        result = await runWriteTool({
          workspacePath: run.workspacePath,
          filePath,
          content,
          signal
        });
      }

      if (signal.aborted) return { paused: false as const };

      const output = {
        ...outputBase,
        result
      };
      await this.apiClient.updateContextItem({
        itemId: tool.itemId,
        status: "completed",
        output,
        updatedAt: nowMs()
      });
      await writeItemLog({
        logger: this.logger,
        workspacePath: run.workspacePath,
        kind: "tool",
        itemId: tool.itemId,
        payload: {
          meta: {
            workspaceId: run.workspaceId,
            sessionId: run.sessionId,
            runId: run.runId,
            toolItemId: tool.itemId
          },
          request: {
            toolName: tool.toolName,
            toolCallId: tool.toolCallId,
            args: tool.args
          },
          status: "completed",
          response: result
        }
      });
      return { paused: false as const };
    } catch (err) {
      if (signal.aborted) return { paused: false as const };
      const error = err instanceof Error ? err.message : String(err);
      await this.apiClient.updateContextItem({
        itemId: tool.itemId,
        status: "failed",
        output: {
          ...outputBase,
          error
        },
        updatedAt: nowMs()
      });
      await writeItemLog({
        logger: this.logger,
        workspacePath: run.workspacePath,
        kind: "tool",
        itemId: tool.itemId,
        payload: {
          meta: {
            workspaceId: run.workspaceId,
            sessionId: run.sessionId,
            runId: run.runId,
            toolItemId: tool.itemId
          },
          request: {
            toolName: tool.toolName,
            toolCallId: tool.toolCallId,
            args: tool.args
          },
          status: "failed",
          error
        }
      });
      return { paused: false as const };
    }
  }

  private async executePendingTools(params: {
    profile: ExecutionProfile;
    run: QueuedRun;
    context: PromptContext;
    signal: AbortSignal;
  }) {
    const pending: PendingTool[] = [];
    for (const item of params.context.pendingTools) {
      if (!(item.toolName === "bash" || item.toolName === "read" || item.toolName === "write")) continue;
      if (item.status === "running") {
        const outputBase = {
          type: "tool" as const,
          toolName: item.toolName,
          toolCallId: item.toolCallId,
          args: item.args
        };
        const error = "tool execution interrupted, mark failed and wait next step";
        await this.apiClient.updateContextItem({
          itemId: item.itemId,
          status: "failed",
          output: {
            ...outputBase,
            error
          },
          updatedAt: nowMs()
        });
        await writeItemLog({
          logger: this.logger,
          workspacePath: params.run.workspacePath,
          kind: "tool",
          itemId: item.itemId,
          payload: {
            meta: {
              workspaceId: params.run.workspaceId,
              sessionId: params.run.sessionId,
              runId: params.run.runId,
              toolItemId: item.itemId
            },
            request: {
              toolName: item.toolName,
              toolCallId: item.toolCallId,
              args: item.args
            },
            status: "failed",
            error
          }
        });
        continue;
      }
      if (item.status !== "queued" && item.status !== "awaiting_permission") continue;
      const toolCallId = String(item.toolCallId || "").trim();
      if (!toolCallId) continue;
      pending.push({
        itemId: item.itemId,
        status: item.status,
        toolName: item.toolName,
        toolCallId,
        args: item.args,
        approved: item.approved === true
      });
    }

    for (const tool of pending) {
      const result = await this.executeTool({
        profile: params.profile,
        run: params.run,
        tool,
        signal: params.signal
      });
      if (result.paused) {
        return { paused: true as const };
      }
      if (params.signal.aborted) {
        return { paused: false as const };
      }
    }

    await this.apiClient.updateRunState({
      workspaceId: params.run.workspaceId,
      sessionId: params.run.sessionId,
      status: "running",
      activeRunId: params.run.runId,
      activeAssistantItemId: null,
      waitingToolItemId: null,
      updatedAt: nowMs()
    });
    return { paused: false as const };
  }

  private async runModelStep(params: {
    profile: ExecutionProfile;
    run: QueuedRun;
    context: PromptContext;
    step: number;
    signal: AbortSignal;
    repeatedToolCallCounter: Map<string, number>;
  }) {
    const { profile, run, context, step, signal, repeatedToolCallCounter } = params;
    const model = createLanguageModel(profile);
    const runtimeOptions = buildModelRuntimeOptions(profile);
    const turnId = newSortableId("turn");

    const assistant = await this.apiClient.createContextItem({
      workspaceId: run.workspaceId,
      sessionId: run.sessionId,
      runId: run.runId,
      turnId,
      step,
      prevId: context.headItemId,
      kind: "assistant",
      status: "streaming",
      output: {
        type: "assistant_text",
        text: ""
      },
      createdAt: nowMs()
    });

    await this.apiClient.updateRunState({
      workspaceId: run.workspaceId,
      sessionId: run.sessionId,
      status: "running",
      activeRunId: run.runId,
      activeAssistantItemId: assistant.id,
      waitingToolItemId: null,
      updatedAt: nowMs()
    });

    const toolSet: Record<string, any> = {};
    for (const item of context.tools) {
      toolSet[item.name] = tool({
        description: item.description,
        inputSchema: jsonSchema(item.inputSchema)
      });
    }

    const request: Record<string, unknown> = {
      model,
      system: context.system || undefined,
      messages: context.messages,
      tools: toolSet,
      abortSignal: signal
    };

    if (Object.keys(runtimeOptions.aiSdk).length > 0) {
      Object.assign(request, runtimeOptions.aiSdk);
    }
    if (Object.keys(runtimeOptions.providerOptions).length > 0) {
      request.providerOptions = {
        [runtimeOptions.providerKey]: runtimeOptions.providerOptions
      };
    }

    let text = "";
    const toolCalls: ToolCall[] = [];
    const startedAt = nowMs();

    await writeItemLog({
      logger: this.logger,
      workspacePath: run.workspacePath,
      kind: "assistant",
      itemId: assistant.id,
      payload: {
        status: "running",
        startedAt,
        meta: {
          workspaceId: run.workspaceId,
          sessionId: run.sessionId,
          runId: run.runId,
          turnId,
          step,
          itemId: assistant.id
        },
        request
      }
    });

    try {
      const stream = streamText(request as any);
      for await (const chunk of stream.fullStream as AsyncIterable<any>) {
        if (signal.aborted) break;
        if (!chunk || typeof chunk !== "object") continue;
        if (chunk.type === "text-delta") {
          const delta = String(chunk.text || "");
          if (!delta) continue;
          text += delta;
          await this.apiClient.updateContextItem({
            itemId: assistant.id,
            status: "streaming",
            output: {
              type: "assistant_text",
              text
            },
            updatedAt: nowMs()
          });
          continue;
        }
        if (chunk.type === "tool-call") {
          const toolName = normalizeToolName(chunk.toolName);
          if (!toolName) continue;
          const rawToolCallId = String(chunk.toolCallId || "").trim();
          const toolCallId = rawToolCallId || `${turnId}_call_${toolCalls.length + 1}`;
          const args = normalizeToolArgs(chunk.input);
          toolCalls.push({ toolName, toolCallId, args });
          continue;
        }
        if (chunk.type === "error") {
          const message = chunk.error instanceof Error ? chunk.error.message : String(chunk.error || "stream error");
          throw new Error(message);
        }
      }

      if (signal.aborted) {
        return { aborted: true as const, assistantItemId: assistant.id };
      }

      const recognizedCalls = toolCalls.filter((item) => item.toolName === "bash" || item.toolName === "read" || item.toolName === "write");
      let prevId = assistant.id;
      for (const call of recognizedCalls) {
        const signature = toolSignature(call.toolName, call.args);
        const count = (repeatedToolCallCounter.get(signature) ?? 0) + 1;
        repeatedToolCallCounter.set(signature, count);
        if (LOOP_REPEAT_TOOL_CALL_THRESHOLD > 0 && count > LOOP_REPEAT_TOOL_CALL_THRESHOLD) {
          throw new Error(`repeated tool call threshold exceeded: ${call.toolName}`);
        }

        const toolItem = await this.apiClient.createContextItem({
          workspaceId: run.workspaceId,
          sessionId: run.sessionId,
          runId: run.runId,
          turnId,
          step,
          prevId,
          kind: "tool",
          status: "queued",
          output: {
            type: "tool",
            toolName: call.toolName,
            toolCallId: call.toolCallId,
            args: call.args
          },
          createdAt: nowMs()
        });
        prevId = toolItem.id;
        await writeItemLog({
          logger: this.logger,
          workspacePath: run.workspacePath,
          kind: "tool",
          itemId: toolItem.id,
          payload: {
            status: "queued",
            meta: {
              workspaceId: run.workspaceId,
              sessionId: run.sessionId,
              runId: run.runId,
              turnId,
              step,
              itemId: toolItem.id
            },
            request: {
              toolName: call.toolName,
              toolCallId: call.toolCallId,
              args: call.args
            }
          }
        });
      }

      await this.apiClient.updateContextItem({
        itemId: assistant.id,
        status: "completed",
        output: {
          type: "assistant_text",
          text
        },
        updatedAt: nowMs()
      });

      await writeItemLog({
        logger: this.logger,
        workspacePath: run.workspacePath,
        kind: "assistant",
        itemId: assistant.id,
        payload: {
          status: "completed",
          startedAt,
          finishedAt: nowMs(),
          meta: {
            workspaceId: run.workspaceId,
            sessionId: run.sessionId,
            runId: run.runId,
            turnId,
            step,
            itemId: assistant.id
          },
          request,
          response: {
            text,
            toolCalls: recognizedCalls
          }
        }
      });

      await this.apiClient.updateRunState({
        workspaceId: run.workspaceId,
        sessionId: run.sessionId,
        status: "running",
        activeRunId: run.runId,
        activeAssistantItemId: null,
        waitingToolItemId: null,
        updatedAt: nowMs()
      });

      return { aborted: false as const, toolCallCount: recognizedCalls.length, assistantItemId: assistant.id };
    } catch (err) {
      if (signal.aborted) {
        return { aborted: true as const, assistantItemId: assistant.id };
      }
      const message = err instanceof Error ? err.message : String(err);
      const failedText = text.trim().length > 0 ? `${text}\n\n[run] ${message}` : `[run] ${message}`;
      try {
        await this.apiClient.updateContextItem({
          itemId: assistant.id,
          status: "failed",
          output: {
            type: "assistant_text",
            text: failedText
          },
          updatedAt: nowMs()
        });
      } catch {
        // 忽略更新失败，保持原始异常抛出
      }
      await writeItemLog({
        logger: this.logger,
        workspacePath: run.workspacePath,
        kind: "assistant",
        itemId: assistant.id,
        payload: {
          status: "failed",
          startedAt,
          finishedAt: nowMs(),
          meta: {
            workspaceId: run.workspaceId,
            sessionId: run.sessionId,
            runId: run.runId,
            turnId,
            step,
            itemId: assistant.id
          },
          request,
          response: {
            text,
            toolCalls,
            error: message
          }
        }
      });
      throw err;
    }
  }

  private async processRun(run: QueuedRun, signal: AbortSignal) {
    try {
      const profile = await this.apiClient.getExecutionProfile({
        workspaceId: run.workspaceId,
        sessionId: run.sessionId,
        runId: run.runId
      });

      await this.apiClient.updateRunState({
        workspaceId: run.workspaceId,
        sessionId: run.sessionId,
        status: "running",
        activeRunId: run.runId,
        activeAssistantItemId: null,
        waitingToolItemId: null,
        updatedAt: nowMs()
      });

      let step = 0;
      const repeatedToolCallCounter = new Map<string, number>();

      while (!signal.aborted) {
        const context = await this.apiClient.getPromptContext({
          workspaceId: run.workspaceId,
          sessionId: run.sessionId,
          runId: run.runId
        });

        if (context.pendingTools.length > 0) {
          const pendingResult = await this.executePendingTools({
            profile,
            run,
            context,
            signal
          });
          if (pendingResult.paused || signal.aborted) {
            return;
          }
          continue;
        }

        if (LOOP_MAX_STEPS > 0 && step >= LOOP_MAX_STEPS) {
          const head = context.headItemId;
          if (head != null) {
            await this.apiClient.createContextItem({
              workspaceId: run.workspaceId,
              sessionId: run.sessionId,
              runId: run.runId,
              turnId: null,
              step: null,
              prevId: head,
              kind: "system",
              status: "completed",
              output: {
                type: "system_text",
                text: "[run] max steps exceeded"
              },
              createdAt: nowMs()
            });
          }
          await this.apiClient.completeRun({
            workspaceId: run.workspaceId,
            sessionId: run.sessionId,
            runId: run.runId,
            status: "failed",
            updatedAt: nowMs()
          });
          return;
        }

        step += 1;
        const result = await this.runModelStep({
          profile,
          run,
          context,
          step,
          signal,
          repeatedToolCallCounter
        });
        if (result.aborted || signal.aborted) {
          return;
        }
        if (result.toolCallCount === 0) {
          await this.apiClient.completeRun({
            workspaceId: run.workspaceId,
            sessionId: run.sessionId,
            runId: run.runId,
            status: "completed",
            updatedAt: nowMs()
          });
          return;
        }
      }
    } catch (err) {
      if (signal.aborted) {
        this.logger.info(`run aborted: ${run.sessionId} ${run.runId}`);
        return;
      }
      if (err instanceof ApiConflictError) {
        this.logger.warn(`run append conflict, stop run: ${run.sessionId} ${run.runId}`);
        return;
      }

      const message = err instanceof Error ? err.message : String(err);
      try {
        await this.apiClient.completeRun({
          workspaceId: run.workspaceId,
          sessionId: run.sessionId,
          runId: run.runId,
          status: "failed",
          updatedAt: nowMs()
        });
      } catch {
        this.logger.error(`run failed and fallback append failed: ${run.sessionId} ${run.runId} ${message}`);
      }
    }
  }
}

export type EnqueuePayload = {
  workspaceId: string;
  sessionId: string;
  runId: string;
  inputText?: string;
  workspacePath: string;
};
