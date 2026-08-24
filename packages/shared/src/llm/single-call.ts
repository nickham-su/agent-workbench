import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, streamText, type ToolSet } from "ai";

const MODEL_TIMEOUT_MS_DEFAULT = 60_000;
const MODEL_TIMEOUT_MS_MAX = 2_147_483_647;

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

const SINGLE_CALL_ALLOWED_PARAM_KEYS = new Set([
  "system",
  "messages",
  "temperature",
  "topP",
  "maxOutputTokens",
  "timeoutMs",
  "abortSignal",
  "tools",
  "sessionId",
  "allowTools"
]);

export type SingleCallProviderNpm = "@ai-sdk/openai" | "@ai-sdk/openai-compatible" | "@ai-sdk/anthropic";

export type SingleCallModelProfile = {
  provider: {
    id: string;
    npm: SingleCallProviderNpm;
    options: {
      baseURL: string;
      apiKey: string;
      apiMode?: "responses" | "chatCompletions";
    };
  };
  model: {
    id: string;
    providerModelId?: string;
    options?: Record<string, unknown>;
  };
};

type SingleCallModelParams = {
  system?: string;
  messages: Array<{
    role: string;
    content: unknown;
  }>;
  sessionId?: string;
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  tools?: ToolSet;
  allowTools?: boolean;
};

export type SingleCallGenerateResult = {
  text: string;
  totalTokens: number | null;
};

export type SingleCallStreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "finish"; totalTokens: number | null };

function isSafeObjectKey(raw: string) {
  if (!raw) return false;
  return raw !== "__proto__" && raw !== "prototype" && raw !== "constructor";
}

function toRecordObject(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

function toNonNegativeInt(raw: unknown) {
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

function extractTotalTokens(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === "number") return toNonNegativeInt(raw);
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const usage = raw as Record<string, unknown>;

  const direct = toNonNegativeInt(usage.totalTokens) ?? toNonNegativeInt(usage.total_tokens) ?? toNonNegativeInt(usage.total);
  if (direct != null) return direct;

  const input =
    toNonNegativeInt(usage.inputTokens) ??
    toNonNegativeInt(usage.promptTokens) ??
    toNonNegativeInt(usage.input_tokens) ??
    toNonNegativeInt(usage.prompt_tokens);
  const output =
    toNonNegativeInt(usage.outputTokens) ??
    toNonNegativeInt(usage.completionTokens) ??
    toNonNegativeInt(usage.output_tokens) ??
    toNonNegativeInt(usage.completion_tokens);
  if (input != null && output != null) return input + output;

  return null;
}

async function readStreamTotalTokens(stream: unknown): Promise<number | null> {
  const streamObj = stream as Record<string, unknown>;
  const candidates: unknown[] = [];
  if (streamObj.usage !== undefined) candidates.push(streamObj.usage);
  if (streamObj.totalUsage !== undefined) candidates.push(streamObj.totalUsage);
  if (streamObj.response !== undefined) candidates.push(streamObj.response);

  for (const candidate of candidates) {
    try {
      const resolved = candidate && typeof (candidate as Promise<unknown>).then === "function"
        ? await (candidate as Promise<unknown>)
        : candidate;
      const total = extractTotalTokens(resolved);
      if (total != null) return total;

      if (resolved && typeof resolved === "object" && !Array.isArray(resolved)) {
        const nested = resolved as Record<string, unknown>;
        const nestedUsage = nested.usage ?? nested.totalUsage;
        const nestedTotal = extractTotalTokens(nestedUsage);
        if (nestedTotal != null) return nestedTotal;
      }
    } catch {
      // ignore usage parse errors
    }
  }

  return null;
}

function normalizeTimeoutMs(raw: number | undefined) {
  if (raw === undefined) return MODEL_TIMEOUT_MS_DEFAULT;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error("timeoutMs must be a finite number");
  const int = Math.floor(value);
  if (int !== value) throw new Error("timeoutMs must be an integer");
  if (int < 1) throw new Error("timeoutMs must be >= 1");
  if (int > MODEL_TIMEOUT_MS_MAX) throw new Error(`timeoutMs must be <= ${MODEL_TIMEOUT_MS_MAX}`);
  return int;
}

function normalizeOptionalFinite(raw: number | undefined, field: string) {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  return value;
}

function assertAllowedParamKeys(params: SingleCallModelParams) {
  const raw = params as unknown as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!SINGLE_CALL_ALLOWED_PARAM_KEYS.has(key)) {
      throw new Error(`unsupported single-call model parameter: ${key}`);
    }
  }
}

function providerOptionsKeyByNpm(npm: SingleCallProviderNpm) {
  if (npm === "@ai-sdk/openai-compatible") return "openaiCompatible";
  return npm === "@ai-sdk/anthropic" ? "anthropic" : "openai";
}

function buildModelRuntimeOptions(profile: SingleCallModelProfile) {
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

function resolveOpenAiModelFactory(sdk: Record<string, unknown>, apiMode: "responses" | "chatCompletions") {
  const responses = typeof sdk.responses === "function" ? (sdk.responses as (modelId: string) => unknown) : null;
  const chat = typeof sdk.chat === "function" ? (sdk.chat as (modelId: string) => unknown) : null;
  const chatCompletions =
    typeof sdk.chatCompletions === "function" ? (sdk.chatCompletions as (modelId: string) => unknown) : null;

  if (apiMode === "chatCompletions") {
    if (chat) return chat;
    if (chatCompletions) return chatCompletions;
    throw new Error(`openai sdk does not expose chat/chatCompletions model factories for apiMode=${apiMode}`);
  }

  if (responses) return responses;
  throw new Error(`openai sdk does not expose responses model factory for apiMode=${apiMode}`);
}

function normalizeOpenAiApiMode(raw: unknown): "responses" | "chatCompletions" {
  if (raw === "responses" || raw === "chatCompletions") return raw;
  return "responses";
}

function hasValidPromptCacheKey(providerOptions: Record<string, unknown>) {
  const value = providerOptions.promptCacheKey;
  return typeof value === "string" && value.trim().length > 0;
}

function buildProviderOptionsWithPromptCacheKey(params: {
  providerNpm: SingleCallProviderNpm;
  sessionId?: string;
  providerOptions: Record<string, unknown>;
}) {
  if (params.providerNpm !== "@ai-sdk/openai") return params.providerOptions;
  if (!params.sessionId || !params.sessionId.trim()) return params.providerOptions;
  if (hasValidPromptCacheKey(params.providerOptions)) return params.providerOptions;
  return { ...params.providerOptions, promptCacheKey: `awb:${params.sessionId}` };
}

function createLanguageModel(profile: SingleCallModelProfile) {
  const providerModelId =
    typeof profile.model.providerModelId === "string" && profile.model.providerModelId.trim()
      ? profile.model.providerModelId.trim()
      : profile.model.id;

  if (profile.provider.npm === "@ai-sdk/openai") {
    const sdk = createOpenAI({
      apiKey: profile.provider.options.apiKey,
      baseURL: profile.provider.options.baseURL
    });
    const apiMode = normalizeOpenAiApiMode(profile.provider.options.apiMode);
    const createModel = resolveOpenAiModelFactory(sdk as unknown as Record<string, unknown>, apiMode);
    return createModel(providerModelId);
  }

  if (profile.provider.npm === "@ai-sdk/openai-compatible") {
    const sdk = createOpenAICompatible({
      name: profile.provider.id,
      apiKey: profile.provider.options.apiKey,
      baseURL: profile.provider.options.baseURL
    });
    return sdk.chatModel(providerModelId);
  }

  const sdk = createAnthropic({
    apiKey: profile.provider.options.apiKey,
    baseURL: profile.provider.options.baseURL
  });
  return sdk(providerModelId);
}

function createTimedAbortSignal(params: { timeoutMs: number; abortSignal?: AbortSignal }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`single-call model timeout after ${params.timeoutMs}ms`));
  }, params.timeoutMs);

  const parent = params.abortSignal;
  const onParentAbort = () => {
    controller.abort(parent?.reason);
  };
  if (parent?.aborted) {
    controller.abort(parent.reason);
  } else if (parent) {
    parent.addEventListener("abort", onParentAbort, { once: true });
  }

  const cleanup = () => {
    clearTimeout(timeout);
    if (parent) {
      try {
        parent.removeEventListener("abort", onParentAbort);
      } catch {
        // ignore listener cleanup errors
      }
    }
  };

  return {
    signal: controller.signal,
    abort: () => controller.abort(),
    cleanup
  };
}

function buildSingleCallRequest(profile: SingleCallModelProfile, params: SingleCallModelParams, abortSignal: AbortSignal) {
  assertAllowedParamKeys(params);
  const runtimeOptions = buildModelRuntimeOptions(profile);
  const request: Record<string, unknown> = {
    model: createLanguageModel(profile),
    messages: params.messages,
    abortSignal
  };

  if (typeof params.system === "string" && params.system.trim()) {
    request.system = params.system;
  }

  if (Object.keys(runtimeOptions.aiSdk).length > 0) {
    Object.assign(request, runtimeOptions.aiSdk);
  }
  const providerOptions = buildProviderOptionsWithPromptCacheKey({
    providerNpm: profile.provider.npm,
    sessionId: params.sessionId,
    providerOptions: runtimeOptions.providerOptions
  });
  if (Object.keys(providerOptions).length > 0) {
    request.providerOptions = {
      [runtimeOptions.providerKey]: providerOptions
    };
  }

  const temperature = normalizeOptionalFinite(params.temperature, "temperature");
  const topP = normalizeOptionalFinite(params.topP, "topP");
  const maxOutputTokens = normalizeOptionalFinite(params.maxOutputTokens, "maxOutputTokens");

  if (temperature !== undefined) request.temperature = temperature;
  if (topP !== undefined) request.topP = topP;
  if (maxOutputTokens !== undefined) request.maxOutputTokens = Math.floor(maxOutputTokens);

  if (params.tools !== undefined) {
    if (params.allowTools !== true) {
      throw new Error("tools are disabled by default; set allowTools=true to enable");
    }
    request.tools = params.tools;
  }

  return request;
}

export async function generateSingleCallText(profile: SingleCallModelProfile, params: SingleCallModelParams): Promise<SingleCallGenerateResult> {
  let text = "";
  let totalTokens: number | null = null;

  for await (const event of streamSingleCallText(profile, params)) {
    if (event.type === "text-delta") {
      text += event.text;
      continue;
    }
    if (event.type === "finish") {
      totalTokens = event.totalTokens;
    }
  }

  return {
    text,
    totalTokens
  };
}

export function streamSingleCallText(profile: SingleCallModelProfile, params: SingleCallModelParams): AsyncIterable<SingleCallStreamEvent> {
  const timeoutMs = normalizeTimeoutMs(params.timeoutMs);
  return {
    [Symbol.asyncIterator]: async function* () {
      const timed = createTimedAbortSignal({
        timeoutMs,
        abortSignal: params.abortSignal
      });
      let stream: unknown = null;
      let finishEmitted = false;
      try {
        const request = buildSingleCallRequest(profile, params, timed.signal);
        stream = streamText(request as any);
        for await (const chunk of (stream as any).fullStream as AsyncIterable<any>) {
          if (!chunk || typeof chunk !== "object") continue;
          if (chunk.type === "text-delta") {
            const text = String(chunk.text || "");
            if (!text) continue;
            yield { type: "text-delta", text };
            continue;
          }
          if (chunk.type === "finish") {
            let totalTokens =
              extractTotalTokens((chunk as Record<string, unknown>).usage) ??
              extractTotalTokens((chunk as Record<string, unknown>).totalUsage) ??
              null;
            if (totalTokens == null) {
              totalTokens = await readStreamTotalTokens(stream);
            }
            finishEmitted = true;
            yield { type: "finish", totalTokens };
            continue;
          }
          if (chunk.type === "error") {
            if ((chunk as Record<string, unknown>).error !== undefined) {
              throw (chunk as Record<string, unknown>).error;
            }
            throw new Error("stream error");
          }
        }

        if (!finishEmitted) {
          const totalTokens = await readStreamTotalTokens(stream);
          yield { type: "finish", totalTokens };
        }
      } finally {
        timed.abort();
        timed.cleanup();
      }
    }
  };
}
