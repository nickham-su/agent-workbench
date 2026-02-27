import { randomBytes } from "node:crypto";
import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { runBashCommand } from "./bash.js";
import { AgentApiClient, ApiConflictError, type ExecutionProfile } from "./apiClient.js";
import { buildTextPayload } from "./text.js";
import { runReadTool, runWriteTool } from "./fileTools.js";

function nowMs() {
  return Date.now();
}

function newSortableId(prefix: string) {
  const ts = Date.now().toString(36).padStart(10, "0");
  const random = randomBytes(6).toString("hex");
  return `${prefix}_${ts}${random}`;
}

type QueuedRun = {
  workspaceId: string;
  sessionId: string;
  runId: string;
  inputText: string;
  workspacePath: string;
};

type ParsedToolCommand =
  | { toolName: "bash"; summary: string; args: { command: string; workdir: string } }
  | { toolName: "read"; summary: string; args: { filePath: string; offset?: number; limit?: number } }
  | { toolName: "write"; summary: string; args: { filePath: string; content: string } };

function parseToolCommand(inputText: string, workspacePath: string): ParsedToolCommand | null {
  const bashMatch = inputText.match(/^\/bash\s+([\s\S]+)$/);
  if (bashMatch?.[1]) {
    const command = bashMatch[1].trim();
    if (!command) return null;
    return {
      toolName: "bash",
      summary: `执行 bash: ${command}`,
      args: {
        command,
        workdir: workspacePath
      }
    };
  }

  const readMatch = inputText.match(/^\/read\s+(.+)$/);
  if (readMatch?.[1]) {
    const filePath = readMatch[1].trim();
    if (!filePath) return null;
    return {
      toolName: "read",
      summary: `读取文件: ${filePath}`,
      args: {
        filePath
      }
    };
  }

  const writeMatch = inputText.match(/^\/write\s+(\S+)\s+([\s\S]+)$/);
  if (writeMatch?.[1] && writeMatch?.[2]) {
    const filePath = writeMatch[1].trim();
    const content = writeMatch[2];
    if (!filePath) return null;
    return {
      toolName: "write",
      summary: `写入文件: ${filePath}`,
      args: {
        filePath,
        content
      }
    };
  }

  return null;
}

function toTokenUsage(raw: unknown) {
  const usage = (raw ?? {}) as Record<string, unknown>;
  const input = Number(usage.inputTokens ?? usage.promptTokens ?? 0) || 0;
  const output = Number(usage.outputTokens ?? usage.completionTokens ?? 0) || 0;
  const total = Number(usage.totalTokens ?? input + output) || input + output;
  return { input, output, total };
}

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

  // 兼容旧格式: model.options 根层字段作为当前 provider 的 providerOptions。
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

  private async append(params: {
    workspaceId: string;
    sessionId: string;
    type: string;
    payload: unknown;
    createdAt?: number;
  }) {
    await this.apiClient.appendTimelineEvent(params);
  }

  private async executeToolCommand(params: {
    profile: ExecutionProfile;
    run: QueuedRun;
    turnId: string;
    command: ParsedToolCommand;
    signal: AbortSignal;
  }) {
    const { profile, run, turnId, command, signal } = params;
    if (signal.aborted) return;
    const toolCallId = newSortableId("call");
    const allowedTools = new Set(profile.agent.tools);
    const allowedByPermissions =
      (command.toolName === "read" && profile.agent.permissions.allowRead) ||
      (command.toolName === "write" && profile.agent.permissions.allowWrite) ||
      (command.toolName === "bash" && profile.agent.permissions.allowBash);

    await this.append({
      workspaceId: run.workspaceId,
      sessionId: run.sessionId,
      type: "model.turn.committed",
      createdAt: nowMs(),
      payload: {
        runId: run.runId,
        turnId,
        assistantText: `收到,开始执行 ${command.toolName}。`,
        toolRequests: [
          {
            toolCallId,
            toolName: command.toolName,
            args: command.args,
            raw: run.inputText
          }
        ]
      }
    });

    if (signal.aborted) return;

    await this.append({
      workspaceId: run.workspaceId,
      sessionId: run.sessionId,
      type: "tool.requested",
      createdAt: nowMs(),
      payload: {
        runId: run.runId,
        turnId,
        toolCallId,
        toolName: command.toolName,
        args: command.args,
        summary: command.summary
      }
    });

    if (!allowedTools.has(command.toolName) || !allowedByPermissions) {
      await this.append({
        workspaceId: run.workspaceId,
        sessionId: run.sessionId,
        type: "tool.failed",
        createdAt: nowMs(),
        payload: {
          runId: run.runId,
          toolCallId,
          finishedAt: nowMs(),
          error: `tool '${command.toolName}' is not allowed by agent policy`,
          summary: "工具权限拒绝"
        }
      });
      await this.append({
        workspaceId: run.workspaceId,
        sessionId: run.sessionId,
        type: "run.failed",
        createdAt: nowMs(),
        payload: {
          runId: run.runId,
          error: `tool '${command.toolName}' is not allowed by agent policy`,
          retryable: false
        }
      });
      return;
    }

    await this.append({
      workspaceId: run.workspaceId,
      sessionId: run.sessionId,
      type: "tool.running",
      createdAt: nowMs(),
      payload: {
        runId: run.runId,
        toolCallId,
        startedAt: nowMs()
      }
    });

    try {
      let resultText = "";
      if (command.toolName === "bash") {
        const result = await runBashCommand({
          command: command.args.command,
          cwd: run.workspacePath,
          timeoutMs: 120_000,
          maxOutputBytes: 512 * 1024,
          signal
        });
        resultText = [
          `command: ${command.args.command}`,
          `exitCode: ${String(result.code)}`,
          `timedOut: ${result.timedOut ? "true" : "false"}`,
          `outputLimitExceeded: ${result.outputLimitExceeded ? "true" : "false"}`,
          "",
          "stdout:",
          result.stdout,
          "",
          "stderr:",
          result.stderr
        ].join("\n");

        const output = await buildTextPayload({ workspacePath: run.workspacePath, text: resultText });
        if (result.ok) {
          await this.append({
            workspaceId: run.workspaceId,
            sessionId: run.sessionId,
            type: "tool.completed",
            createdAt: nowMs(),
            payload: {
              runId: run.runId,
              toolCallId,
              finishedAt: nowMs(),
              output,
              summary: "bash 执行完成"
            }
          });
          await this.append({
            workspaceId: run.workspaceId,
            sessionId: run.sessionId,
            type: "model.turn.committed",
            createdAt: nowMs(),
            payload: {
              runId: run.runId,
              turnId: newSortableId("turn"),
              assistantText: "bash 已完成,可查看工具输出。",
              toolRequests: []
            }
          });
          await this.append({
            workspaceId: run.workspaceId,
            sessionId: run.sessionId,
            type: "run.completed",
            createdAt: nowMs(),
            payload: {
              runId: run.runId,
              finishedAt: nowMs(),
              tokens: { input: 0, output: 0, total: 0 }
            }
          });
          return;
        }

        await this.append({
          workspaceId: run.workspaceId,
          sessionId: run.sessionId,
          type: "tool.failed",
          createdAt: nowMs(),
          payload: {
            runId: run.runId,
            toolCallId,
            finishedAt: nowMs(),
            error: result.timedOut ? "bash timeout" : result.outputLimitExceeded ? "bash output limit exceeded" : "bash failed",
            output,
            summary: "bash 执行失败"
          }
        });
        await this.append({
          workspaceId: run.workspaceId,
          sessionId: run.sessionId,
          type: "run.failed",
          createdAt: nowMs(),
          payload: {
            runId: run.runId,
            error: result.timedOut ? "bash timeout" : result.outputLimitExceeded ? "bash output limit exceeded" : "bash failed",
            retryable: false
          }
        });
        return;
      }

      if (command.toolName === "read") {
        if (signal.aborted) return;
        const result = await runReadTool({
          workspacePath: run.workspacePath,
          filePath: command.args.filePath,
          offset: command.args.offset,
          limit: command.args.limit,
          signal
        });
        resultText = result.content;
      } else {
        if (signal.aborted) return;
        const result = await runWriteTool({
          workspacePath: run.workspacePath,
          filePath: command.args.filePath,
          content: command.args.content,
          signal
        });
        resultText = result.content;
      }

      if (signal.aborted) return;

      const output = await buildTextPayload({ workspacePath: run.workspacePath, text: resultText });
      await this.append({
        workspaceId: run.workspaceId,
        sessionId: run.sessionId,
        type: "tool.completed",
        createdAt: nowMs(),
        payload: {
          runId: run.runId,
          toolCallId,
          finishedAt: nowMs(),
          output,
          summary: command.summary
        }
      });
      await this.append({
        workspaceId: run.workspaceId,
        sessionId: run.sessionId,
        type: "model.turn.committed",
        createdAt: nowMs(),
        payload: {
          runId: run.runId,
          turnId: newSortableId("turn"),
          assistantText: `${command.toolName} 已执行完成。`,
          toolRequests: []
        }
      });
      await this.append({
        workspaceId: run.workspaceId,
        sessionId: run.sessionId,
        type: "run.completed",
        createdAt: nowMs(),
        payload: {
          runId: run.runId,
          finishedAt: nowMs(),
          tokens: { input: 0, output: 0, total: 0 }
        }
      });
    } catch (err) {
      if (signal.aborted) return;
      const error = err instanceof Error ? err.message : String(err);
      const output = await buildTextPayload({ workspacePath: run.workspacePath, text: `error: ${error}` });
      await this.append({
        workspaceId: run.workspaceId,
        sessionId: run.sessionId,
        type: "tool.failed",
        createdAt: nowMs(),
        payload: {
          runId: run.runId,
          toolCallId,
          finishedAt: nowMs(),
          error,
          output,
          summary: `${command.toolName} 执行失败`
        }
      });
      await this.append({
        workspaceId: run.workspaceId,
        sessionId: run.sessionId,
        type: "run.failed",
        createdAt: nowMs(),
        payload: {
          runId: run.runId,
          error,
          retryable: false
        }
      });
    }
  }

  private async executeModelTurn(params: {
    profile: ExecutionProfile;
    run: QueuedRun;
    turnId: string;
    signal: AbortSignal;
  }) {
    const { profile, run, turnId, signal } = params;
    const model = createLanguageModel(profile);
    const runtimeOptions = buildModelRuntimeOptions(profile);

    const request: Record<string, unknown> = {
      model,
      system: profile.agent.prompt || undefined,
      prompt: run.inputText,
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

    const result = await generateText(request as any);

    await this.append({
      workspaceId: run.workspaceId,
      sessionId: run.sessionId,
      type: "model.turn.committed",
      createdAt: nowMs(),
      payload: {
        runId: run.runId,
        turnId,
        assistantText: result.text,
        toolRequests: []
      }
    });

    await this.append({
      workspaceId: run.workspaceId,
      sessionId: run.sessionId,
      type: "run.completed",
      createdAt: nowMs(),
      payload: {
        runId: run.runId,
        finishedAt: nowMs(),
        tokens: toTokenUsage(result.usage)
      }
    });
  }

  private async processRun(run: QueuedRun, signal: AbortSignal) {
    try {
      const profile = await this.apiClient.getExecutionProfile({
        workspaceId: run.workspaceId,
        sessionId: run.sessionId,
        runId: run.runId
      });

      await this.append({
        workspaceId: run.workspaceId,
        sessionId: run.sessionId,
        type: "run.started",
        createdAt: nowMs(),
        payload: {
          runId: run.runId,
          startedAt: nowMs(),
          agentId: profile.resolved.agentId,
          providerId: profile.resolved.providerId,
          modelId: profile.resolved.modelId
        }
      });

      if (signal.aborted) return;

      const turnId = newSortableId("turn");
      await this.append({
        workspaceId: run.workspaceId,
        sessionId: run.sessionId,
        type: "model.turn.started",
        createdAt: nowMs(),
        payload: {
          runId: run.runId,
          turnId,
          model: profile.model.providerModelId || profile.model.id,
          agentId: profile.resolved.agentId,
          providerId: profile.resolved.providerId,
          modelId: profile.resolved.modelId
        }
      });

      const command = parseToolCommand(run.inputText, run.workspacePath);
      if (command) {
        await this.executeToolCommand({ profile, run, turnId, command, signal });
        return;
      }

      await this.executeModelTurn({ profile, run, turnId, signal });
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
        await this.append({
          workspaceId: run.workspaceId,
          sessionId: run.sessionId,
          type: "run.failed",
          createdAt: nowMs(),
          payload: {
            runId: run.runId,
            error: message,
            retryable: false
          }
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
  inputText: string;
  workspacePath: string;
};
