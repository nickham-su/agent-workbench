import type { FastifyBaseLogger } from "fastify";
import fs from "node:fs/promises";
import type {
  AgentItem,
  AgentMcpServerConfig,
  AgentMcpSettings,
  AgentProviderNpm,
  AgentProvidersSettings,
  AgentProvidersSettingsView,
  AgentSettings,
  AgentToolName,
  ClearAllGitIdentityResponse,
  GitGlobalIdentity,
  NetworkSettings,
  ResetKnownHostRequest,
  SearchSettings,
  SecurityStatus,
  UpdateAgentProvidersSettingsRequest,
  UpdateAgentMcpSettingsRequest,
  UpdateAgentSettingsRequest,
  UpdateGitGlobalIdentityRequest,
  UpdateNetworkSettingsRequest,
  UpdateSearchSettingsRequest
} from "@agent-workbench/shared";
import type { AppContext } from "../../app/context.js";
import { HttpError } from "../../app/errors.js";
import { ensureDir, pathExists } from "../../infra/fs/fs.js";
import { caBundlePath, caCertPath, certsRoot, sshKnownHostsPath, sshRoot } from "../../infra/fs/paths.js";
import { ensureCaBundleFile } from "../../infra/certs/caBundle.js";
import { nowMs } from "../../utils/time.js";
import { getSettingJson, setSettingJson } from "./settings.store.js";
import { gitConfigGet, gitConfigSet, gitConfigUnsetAll, validateAndNormalizeGitIdentity } from "../../infra/git/gitIdentity.js";
import { listWorkspaceRepos, listWorkspaces } from "../workspaces/workspace.store.js";

type NetworkSettingsV1 = Omit<NetworkSettings, "updatedAt">;

const NETWORK_SETTINGS_KEY = "network";
const SEARCH_SETTINGS_KEY = "search";
const AGENT_PROVIDERS_SETTINGS_KEY = "agent_providers_v1";
const AGENT_SETTINGS_KEY = "agent_agents_v1";
const AGENT_MCP_SETTINGS_KEY = "agent_mcp_v1";

const SEARCH_EXCLUDE_MAX_COUNT = 200;
const SEARCH_EXCLUDE_MAX_LENGTH = 200;

type AgentProvidersSettingsStored = Omit<AgentProvidersSettings, "updatedAt">;
type AgentSettingsStored = Omit<AgentSettings, "updatedAt">;
type AgentMcpSettingsStored = Omit<AgentMcpSettings, "updatedAt">;

type AgentProviderStored = AgentProvidersSettingsStored["providers"][number];

type ExecutionProfileResolved = {
  agent: AgentItem;
  provider: AgentProviderStored;
  model: AgentProviderStored["models"][number];
};

function defaultNetworkSettings(): NetworkSettingsV1 {
  return { httpProxy: null, httpsProxy: null, noProxy: null, caCertPem: null, applyToTerminal: false };
}

function defaultSearchExcludeGlobs() {
  return [
    "node_modules/**",
    "dist/**",
    "build/**",
    "out/**",
    "coverage/**",
    ".next/**",
    ".nuxt/**",
    ".turbo/**",
    ".venv/**",
    "venv/**",
    "__pycache__/**",
    ".pytest_cache/**",
    "target/**"
  ];
}

function normalizeSearchExcludeGlobs(raw: unknown, fallbackToDefault = true) {
  if (!Array.isArray(raw)) return fallbackToDefault ? defaultSearchExcludeGlobs() : [];
  const seen = new Set<string>();
  const next: string[] = [];
  for (const item of raw) {
    if (next.length >= SEARCH_EXCLUDE_MAX_COUNT) break;
    const value = typeof item === "string" ? item.trim() : "";
    if (!value) continue;
    if (value.length > SEARCH_EXCLUDE_MAX_LENGTH) continue;
    if (value.includes("\0") || value.includes("\n") || value.includes("\r")) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    next.push(value);
  }
  if (next.length > 0) return next;
  return fallbackToDefault ? defaultSearchExcludeGlobs() : [];
}

function maskApiKey(raw: string | null) {
  if (!raw) return null;
  const value = raw.trim();
  if (!value) return null;
  if (value.length <= 4) return "*".repeat(value.length);
  return `${"*".repeat(value.length - 4)}${value.slice(-4)}`;
}

function normalizeBaseURL(raw: unknown) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) throw new HttpError(400, "Provider baseURL is required", "AGENT_PROVIDER_BASE_URL_REQUIRED");
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new HttpError(400, "Invalid provider baseURL", "AGENT_PROVIDER_BASE_URL_INVALID");
  }
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function normalizeApiKeyInput(raw: unknown) {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const value = String(raw).trim();
  if (!value) return null;
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new HttpError(400, "Invalid provider apiKey", "AGENT_PROVIDER_API_KEY_INVALID");
  }
  return value;
}

const DEFAULT_PROVIDER_NPM: AgentProviderNpm = "@ai-sdk/openai";

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

function normalizeProviderNpmStored(raw: unknown): AgentProviderNpm {
  if (raw === "@ai-sdk/anthropic") return raw;
  return DEFAULT_PROVIDER_NPM;
}

function normalizeProviderNpmInput(raw: unknown): AgentProviderNpm {
  if (raw === "@ai-sdk/openai" || raw === "@ai-sdk/anthropic") return raw;
  throw new HttpError(400, `Unsupported provider npm: ${String(raw)}`, "AGENT_PROVIDER_NPM_UNSUPPORTED");
}

function providerOptionsKeyByNpm(npm: AgentProviderNpm) {
  return npm === "@ai-sdk/anthropic" ? "anthropic" : "openai";
}

function normalizeAiSdkOptions(raw: unknown) {
  const source = toRecordObject(raw);
  if (!source) return {};
  const out: Record<string, unknown> = {};
  for (const [rawKey, value] of Object.entries(source)) {
    const key = rawKey.trim();
    if (!isSafeObjectKey(key)) continue;
    if (RESERVED_MODEL_OPTION_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

function normalizeProviderOptionsByKey(raw: unknown) {
  const source = toRecordObject(raw);
  if (!source) return {};
  const out: Record<string, Record<string, unknown>> = {};
  for (const [rawKey, rawValue] of Object.entries(source)) {
    const key = rawKey.trim();
    if (!isSafeObjectKey(key)) continue;
    const payload = toRecordObject(rawValue);
    if (!payload) continue;
    const value: Record<string, unknown> = {};
    for (const [payloadRawKey, payloadRawValue] of Object.entries(payload)) {
      const payloadKey = payloadRawKey.trim();
      if (!isSafeObjectKey(payloadKey)) continue;
      value[payloadKey] = payloadRawValue;
    }
    out[key] = value;
  }
  return out;
}

function normalizeProviderModelOptions(raw: unknown, providerNpm: AgentProviderNpm) {
  const source = toRecordObject(raw);
  if (!source) return {};

  const aiSdk = normalizeAiSdkOptions(source.aiSdk);
  const providerOptionsByKey = normalizeProviderOptionsByKey(source.providerOptionsByKey);
  const providerKey = providerOptionsKeyByNpm(providerNpm);

  const legacyProviderOptions: Record<string, unknown> = {};
  for (const [rawKey, value] of Object.entries(source)) {
    const key = rawKey.trim();
    if (!isSafeObjectKey(key)) continue;
    if (key === "aiSdk" || key === "providerOptionsByKey") continue;
    if (key === "maxOutputTokens") {
      if (aiSdk.maxOutputTokens === undefined) {
        aiSdk.maxOutputTokens = value;
      }
      continue;
    }
    legacyProviderOptions[key] = value;
  }

  if (Object.keys(legacyProviderOptions).length > 0) {
    providerOptionsByKey[providerKey] = {
      ...legacyProviderOptions,
      ...(providerOptionsByKey[providerKey] ?? {})
    };
  }

  const out: Record<string, unknown> = {};
  if (Object.keys(aiSdk).length > 0) out.aiSdk = aiSdk;
  if (Object.keys(providerOptionsByKey).length > 0) out.providerOptionsByKey = providerOptionsByKey;
  return out;
}

function defaultAgentPermissions() {
  return {
    allowRead: true,
    allowWrite: true,
    allowBash: true
  };
}

function getAgentProvidersSettingsStored(ctx: AppContext) {
  const row = getSettingJson(ctx.db, AGENT_PROVIDERS_SETTINGS_KEY);
  const value = row?.value as Partial<AgentProvidersSettingsStored> | undefined;
  const providersRaw = Array.isArray(value?.providers) ? value.providers : [];
  const ids = new Set<string>();
  const providers = providersRaw
    .map((providerRaw) => {
      const provider = providerRaw as Record<string, unknown>;
      const id = typeof provider.id === "string" ? provider.id.trim() : "";
      if (!id || ids.has(id)) return null;
      ids.add(id);
      const npm = normalizeProviderNpmStored(provider.npm);
      const modelsRaw = Array.isArray(provider.models) ? provider.models : [];
      const modelIds = new Set<string>();
      const models = modelsRaw
        .map((modelRaw) => {
          const model = modelRaw as Record<string, unknown>;
          const modelId = typeof model.id === "string" ? model.id.trim() : "";
          const providerModelIdRaw = typeof model.providerModelId === "string" ? model.providerModelId.trim() : "";
          const providerModelId = providerModelIdRaw || modelId;
          const name = typeof model.name === "string" ? model.name.trim() : modelId;
          if (!modelId || !providerModelId || !name || modelIds.has(modelId)) return null;
          modelIds.add(modelId);
          return {
            id: modelId,
            providerModelId,
            name,
            options: normalizeProviderModelOptions(model.options, npm)
          };
        })
        .filter((x): x is NonNullable<typeof x> => Boolean(x));
      const optionsRaw = (provider.options ?? {}) as Record<string, unknown>;
      try {
        return {
          id,
          name: typeof provider.name === "string" && provider.name.trim() ? provider.name.trim() : id,
          npm,
          options: {
            baseURL: normalizeBaseURL(optionsRaw.baseURL),
            apiKey: normalizeApiKeyInput(optionsRaw.apiKey) ?? null
          },
          models
        };
      } catch {
        return null;
      }
    })
    .filter((x): x is NonNullable<typeof x> => Boolean(x));

  const defaultValue = value?.default as { providerId?: unknown; modelId?: unknown } | null | undefined;
  const providerId = typeof defaultValue?.providerId === "string" ? defaultValue.providerId.trim() : "";
  const modelId = typeof defaultValue?.modelId === "string" ? defaultValue.modelId.trim() : "";
  const defaultRef = providerId && modelId ? { providerId, modelId } : null;

  return {
    settings: {
      default: defaultRef,
      providers
    },
    updatedAt: row?.updatedAt ?? 0
  };
}

function toAgentProvidersSettingsView(settings: AgentProvidersSettingsStored, updatedAt: number): AgentProvidersSettingsView {
  return {
    default: settings.default,
    providers: settings.providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      npm: provider.npm,
      options: {
        baseURL: provider.options.baseURL,
        hasApiKey: Boolean(provider.options.apiKey),
        apiKeyMasked: maskApiKey(provider.options.apiKey ?? null)
      },
      models: provider.models
    })),
    updatedAt
  };
}

function normalizeAgentTools(raw: unknown): AgentToolName[] {
  if (!Array.isArray(raw)) return ["bash", "read", "write", "apply_patch", "subtask"];
  const out: AgentToolName[] = [];
  const seen = new Set<AgentToolName>();
  for (const item of raw) {
    if (item !== "bash" && item !== "read" && item !== "write" && item !== "apply_patch" && item !== "subtask") continue;
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out.length > 0 ? out : ["bash", "read", "write", "apply_patch", "subtask"];
}

function normalizeServerId(raw: unknown) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return "";
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) return "";
  return value;
}

function toStringRecord(raw: unknown) {
  const source = toRecordObject(raw);
  if (!source) return {};
  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(source)) {
    const key = rawKey.trim();
    if (!isSafeObjectKey(key) || !key) continue;
    const value = typeof rawValue === "string" ? rawValue : String(rawValue ?? "");
    if (value.includes("\0") || value.includes("\n") || value.includes("\r")) continue;
    out[key] = value;
  }
  return out;
}

function normalizeMcpConfig(raw: unknown): AgentMcpServerConfig {
  const input = toRecordObject(raw);
  if (!input) {
    throw new HttpError(400, "MCP config must be an object", "AGENT_MCP_CONFIG_INVALID");
  }
  const type = typeof input.type === "string" ? input.type.trim() : "";
  const timeout = Number.isFinite(Number(input.timeout)) ? Math.max(1, Math.floor(Number(input.timeout))) : undefined;

  if (type === "local") {
    const commandRaw = Array.isArray(input.command) ? input.command : [];
    const command = commandRaw
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter((item) => item.length > 0);
    if (command.length === 0) {
      throw new HttpError(400, "Local MCP command is required", "AGENT_MCP_LOCAL_COMMAND_REQUIRED");
    }
    const config: AgentMcpServerConfig = {
      type: "local",
      command,
      environment: toStringRecord(input.environment)
    };
    if (timeout) config.timeout = timeout;
    return config;
  }

  if (type === "remote") {
    const url = typeof input.url === "string" ? input.url.trim() : "";
    if (!url) {
      throw new HttpError(400, "Remote MCP url is required", "AGENT_MCP_REMOTE_URL_REQUIRED");
    }
    const oauthRaw = input.oauth;
    let oauth: false | { clientId?: string; clientSecret?: string; scope?: string } | undefined;
    if (oauthRaw === false) {
      oauth = false;
    } else if (oauthRaw && typeof oauthRaw === "object" && !Array.isArray(oauthRaw)) {
      const oauthObj = oauthRaw as Record<string, unknown>;
      const clientId = typeof oauthObj.clientId === "string" ? oauthObj.clientId.trim() : "";
      const clientSecret = typeof oauthObj.clientSecret === "string" ? oauthObj.clientSecret.trim() : "";
      const scope = typeof oauthObj.scope === "string" ? oauthObj.scope.trim() : "";
      oauth = {
        ...(clientId ? { clientId } : {}),
        ...(clientSecret ? { clientSecret } : {}),
        ...(scope ? { scope } : {})
      };
    }
    const config: AgentMcpServerConfig = {
      type: "remote",
      url,
      headers: toStringRecord(input.headers)
    };
    if (oauth !== undefined) config.oauth = oauth;
    if (timeout) config.timeout = timeout;
    return config;
  }

  throw new HttpError(400, "MCP config type must be local or remote", "AGENT_MCP_TYPE_INVALID");
}

function getAgentMcpSettingsStored(ctx: AppContext) {
  const row = getSettingJson(ctx.db, AGENT_MCP_SETTINGS_KEY);
  const value = row?.value as Partial<AgentMcpSettingsStored> | undefined;
  const serversRaw = Array.isArray(value?.servers) ? value.servers : [];
  const ids = new Set<string>();
  const servers = serversRaw
    .map((itemRaw) => {
      const item = itemRaw as Record<string, unknown>;
      const id = normalizeServerId(item.id);
      if (!id || ids.has(id)) return null;
      ids.add(id);
      const enabled = typeof item.enabled === "boolean" ? item.enabled : true;
      try {
        const config = normalizeMcpConfig(item.config);
        return { id, enabled, config };
      } catch {
        return null;
      }
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  return {
    settings: {
      servers
    },
    updatedAt: row?.updatedAt ?? 0
  };
}

function normalizeAgentMcpServers(raw: unknown, availableIds: Set<string>) {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const id = normalizeServerId(item);
    if (!id || seen.has(id)) continue;
    if (!availableIds.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function normalizeAgentSummaryFromStored(raw: unknown) {
  const value = typeof raw === "string" ? raw : "";
  if (value.includes("\0")) return "";
  return value
    .replace(/\r\n/g, " ")
    .replace(/[\r\n]/g, " ")
    .trim()
    .slice(0, 160);
}

function normalizeAgentSummaryForUpdate(raw: unknown) {
  const value = typeof raw === "string" ? raw : "";
  if (value.includes("\0")) {
    throw new HttpError(400, "Agent summary contains invalid character", "AGENT_SUMMARY_INVALID");
  }
  const normalized = value
    .replace(/\r\n/g, " ")
    .replace(/[\r\n]/g, " ")
    .trim();
  if (normalized.length > 160) {
    throw new HttpError(400, "Agent summary is too long", "AGENT_SUMMARY_TOO_LONG");
  }
  return normalized;
}

function getAgentSettingsStored(ctx: AppContext) {
  const mcpLoaded = getAgentMcpSettingsStored(ctx);
  const mcpServerIds = new Set(mcpLoaded.settings.servers.map((item) => item.id));
  const row = getSettingJson(ctx.db, AGENT_SETTINGS_KEY);
  const value = row?.value as Partial<AgentSettingsStored> | undefined;
  const agentsRaw = Array.isArray(value?.agents) ? value.agents : [];
  const ids = new Set<string>();
  const agents = agentsRaw
    .map((agentRaw) => {
      const agent = agentRaw as Record<string, unknown>;
      const id = typeof agent.id === "string" ? agent.id.trim() : "";
      if (!id || ids.has(id)) return null;
      ids.add(id);
      const name = typeof agent.name === "string" && agent.name.trim() ? agent.name.trim() : id;
      const prompt = typeof agent.prompt === "string" ? agent.prompt : "";
      const permissionsRaw = (agent.permissions ?? {}) as Record<string, unknown>;
      const permissions = {
        allowRead: typeof permissionsRaw.allowRead === "boolean" ? permissionsRaw.allowRead : true,
        allowWrite: typeof permissionsRaw.allowWrite === "boolean" ? permissionsRaw.allowWrite : true,
        allowBash: typeof permissionsRaw.allowBash === "boolean" ? permissionsRaw.allowBash : true
      };
      const modelRefRaw = (agent.defaultModel ?? null) as { providerId?: unknown; modelId?: unknown } | null;
      const modelProviderId = typeof modelRefRaw?.providerId === "string" ? modelRefRaw.providerId.trim() : "";
      const modelId = typeof modelRefRaw?.modelId === "string" ? modelRefRaw.modelId.trim() : "";
      return {
        id,
        name,
        summary: normalizeAgentSummaryFromStored(agent.summary),
        prompt,
        tools: normalizeAgentTools(agent.tools),
        mcpServers: normalizeAgentMcpServers(agent.mcpServers, mcpServerIds),
        permissions,
        defaultModel: modelProviderId && modelId ? { providerId: modelProviderId, modelId } : null
      };
    })
    .filter((x): x is NonNullable<typeof x> => Boolean(x));

  const defaultValue = value?.default as { agentId?: unknown } | null | undefined;
  const defaultAgentId = typeof defaultValue?.agentId === "string" ? defaultValue.agentId.trim() : "";
  return {
    settings: {
      default: defaultAgentId ? { agentId: defaultAgentId } : null,
      agents
    },
    updatedAt: row?.updatedAt ?? 0
  };
}

function assertUniqueIdsOrThrow(items: string[], errorCode: string, message: string) {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item)) throw new HttpError(400, message, errorCode);
    seen.add(item);
  }
}

export function getNetworkSettings(ctx: AppContext): NetworkSettings {
  const row = getSettingJson(ctx.db, NETWORK_SETTINGS_KEY);
  const base = defaultNetworkSettings();
  const value = row?.value as Partial<NetworkSettingsV1> | undefined;
  return {
    httpProxy: typeof value?.httpProxy === "string" ? value.httpProxy : null,
    httpsProxy: typeof value?.httpsProxy === "string" ? value.httpsProxy : null,
    noProxy: typeof value?.noProxy === "string" ? value.noProxy : null,
    caCertPem: typeof value?.caCertPem === "string" ? value.caCertPem : null,
    applyToTerminal: typeof value?.applyToTerminal === "boolean" ? value.applyToTerminal : base.applyToTerminal,
    updatedAt: row?.updatedAt ?? 0
  };
}

export function getSearchSettings(ctx: AppContext): SearchSettings {
  const row = getSettingJson(ctx.db, SEARCH_SETTINGS_KEY);
  const value = row?.value as Partial<SearchSettings> | undefined;
  const hasStored = Array.isArray(value?.excludeGlobs);
  const excludeGlobs = normalizeSearchExcludeGlobs(value?.excludeGlobs, !hasStored);
  return {
    excludeGlobs,
    updatedAt: row?.updatedAt ?? 0
  };
}

export function getAgentProvidersSettings(ctx: AppContext): AgentProvidersSettingsView {
  const loaded = getAgentProvidersSettingsStored(ctx);
  return toAgentProvidersSettingsView(loaded.settings, loaded.updatedAt);
}

export function getAgentProvidersSettingsInternal(ctx: AppContext): AgentProvidersSettings {
  const loaded = getAgentProvidersSettingsStored(ctx);
  return {
    default: loaded.settings.default,
    providers: loaded.settings.providers,
    updatedAt: loaded.updatedAt
  };
}

export function getAgentMcpSettings(ctx: AppContext): AgentMcpSettings {
  const loaded = getAgentMcpSettingsStored(ctx);
  return {
    servers: loaded.settings.servers,
    updatedAt: loaded.updatedAt
  };
}

export function updateAgentMcpSettings(ctx: AppContext, logger: FastifyBaseLogger, bodyRaw: unknown): AgentMcpSettings {
  const body = (bodyRaw ?? {}) as UpdateAgentMcpSettingsRequest;
  const incoming = Array.isArray(body.servers) ? body.servers : [];
  const servers = incoming.map((itemRaw) => {
    const item = itemRaw as Record<string, unknown>;
    const id = normalizeServerId(item.id);
    if (!id) {
      throw new HttpError(400, "MCP server id is required", "AGENT_MCP_SERVER_ID_REQUIRED");
    }
    const enabled = typeof item.enabled === "boolean" ? item.enabled : true;
    const config = normalizeMcpConfig(item.config);
    return { id, enabled, config };
  });

  assertUniqueIdsOrThrow(
    servers.map((item) => item.id),
    "AGENT_MCP_SERVER_DUPLICATE",
    "Duplicate MCP server id"
  );

  const updatedAt = nowMs();
  setSettingJson(
    ctx.db,
    AGENT_MCP_SETTINGS_KEY,
    {
      servers
    },
    updatedAt
  );

  logger.info({ servers: servers.length, updatedAt }, "agent mcp settings updated");
  return {
    servers,
    updatedAt
  };
}

export function updateAgentProvidersSettings(
  ctx: AppContext,
  logger: FastifyBaseLogger,
  bodyRaw: unknown
): AgentProvidersSettingsView {
  const body = (bodyRaw ?? {}) as UpdateAgentProvidersSettingsRequest;
  const incomingProviders = Array.isArray(body.providers) ? body.providers : [];
  const current = getAgentProvidersSettingsInternal(ctx);
  const currentById = new Map(current.providers.map((provider) => [provider.id, provider]));

  const providers = incomingProviders.map((providerRaw) => {
    const provider = providerRaw as Record<string, unknown>;
    const id = typeof provider.id === "string" ? provider.id.trim() : "";
    const name = typeof provider.name === "string" ? provider.name.trim() : "";
    if (!id || !name) {
      throw new HttpError(400, "Provider id/name is required", "AGENT_PROVIDER_ID_NAME_REQUIRED");
    }
    const npm = normalizeProviderNpmInput(provider.npm);
    const optionsRaw = (provider.options ?? {}) as Record<string, unknown>;
    const apiKeyInput = normalizeApiKeyInput(optionsRaw.apiKey);
    const previous = currentById.get(id);
    const apiKey = apiKeyInput === undefined ? previous?.options.apiKey ?? null : apiKeyInput;

    const modelsRaw = Array.isArray(provider.models) ? provider.models : [];
    const models = modelsRaw.map((modelRaw) => {
      const model = modelRaw as Record<string, unknown>;
      const modelId = typeof model.id === "string" ? model.id.trim() : "";
      const providerModelIdRaw = typeof model.providerModelId === "string" ? model.providerModelId.trim() : "";
      const providerModelId = providerModelIdRaw || modelId;
      const modelName = typeof model.name === "string" ? model.name.trim() : "";
      if (!modelId || !providerModelId || !modelName) {
        throw new HttpError(400, "Provider model id/providerModelId/name is required", "AGENT_PROVIDER_MODEL_ID_NAME_REQUIRED");
      }
      return {
        id: modelId,
        providerModelId,
        name: modelName,
        options: normalizeProviderModelOptions(model.options, npm)
      };
    });

    assertUniqueIdsOrThrow(
      models.map((model) => model.id),
      "AGENT_PROVIDER_MODEL_DUPLICATE",
      `Duplicate model id in provider '${id}'`
    );

    return {
      id,
      name,
      npm,
      options: {
        baseURL: normalizeBaseURL(optionsRaw.baseURL),
        apiKey
      },
      models
    };
  });

  assertUniqueIdsOrThrow(
    providers.map((provider) => provider.id),
    "AGENT_PROVIDER_DUPLICATE",
    "Duplicate provider id"
  );

  const defaultValue = (body.default ?? null) as { providerId?: unknown; modelId?: unknown } | null;
  const providerId = typeof defaultValue?.providerId === "string" ? defaultValue.providerId.trim() : "";
  const modelId = typeof defaultValue?.modelId === "string" ? defaultValue.modelId.trim() : "";
  const defaultRef = providerId && modelId ? { providerId, modelId } : null;

  if (defaultRef) {
    const provider = providers.find((item) => item.id === defaultRef.providerId);
    if (!provider) {
      throw new HttpError(400, "Default providerId not found", "AGENT_PROVIDER_DEFAULT_PROVIDER_NOT_FOUND");
    }
    if (!provider.models.some((item) => item.id === defaultRef.modelId)) {
      throw new HttpError(400, "Default modelId not found", "AGENT_PROVIDER_DEFAULT_MODEL_NOT_FOUND");
    }
  }

  const updatedAt = nowMs();
  setSettingJson(
    ctx.db,
    AGENT_PROVIDERS_SETTINGS_KEY,
    {
      default: defaultRef,
      providers
    },
    updatedAt
  );

  logger.info({ providers: providers.length, updatedAt }, "agent providers settings updated");
  return toAgentProvidersSettingsView({ default: defaultRef, providers }, updatedAt);
}

export function getAgentSettings(ctx: AppContext): AgentSettings {
  const loaded = getAgentSettingsStored(ctx);
  return {
    default: loaded.settings.default,
    agents: loaded.settings.agents,
    updatedAt: loaded.updatedAt
  };
}

export function updateAgentSettings(ctx: AppContext, logger: FastifyBaseLogger, bodyRaw: unknown): AgentSettings {
  const body = (bodyRaw ?? {}) as UpdateAgentSettingsRequest;
  const incomingAgents = Array.isArray(body.agents) ? body.agents : [];
  const mcpLoaded = getAgentMcpSettingsStored(ctx);
  const availableMcpIds = new Set(mcpLoaded.settings.servers.map((item) => item.id));
  const agents = incomingAgents.map((agentRaw) => {
    const agent = agentRaw as Record<string, unknown>;
    const id = typeof agent.id === "string" ? agent.id.trim() : "";
    const name = typeof agent.name === "string" ? agent.name.trim() : "";
    if (!id || !name) {
      throw new HttpError(400, "Agent id/name is required", "AGENT_ID_NAME_REQUIRED");
    }
    const prompt = typeof agent.prompt === "string" ? agent.prompt : "";
    const summary = normalizeAgentSummaryForUpdate(agent.summary);
    const tools = normalizeAgentTools(agent.tools);
    const mcpServers = normalizeAgentMcpServers(agent.mcpServers, availableMcpIds);
    const permissionsRaw = (agent.permissions ?? {}) as Record<string, unknown>;
    const fallbackPermissions = defaultAgentPermissions();
    const permissions = {
      allowRead: typeof permissionsRaw.allowRead === "boolean" ? permissionsRaw.allowRead : fallbackPermissions.allowRead,
      allowWrite: typeof permissionsRaw.allowWrite === "boolean" ? permissionsRaw.allowWrite : fallbackPermissions.allowWrite,
      allowBash: typeof permissionsRaw.allowBash === "boolean" ? permissionsRaw.allowBash : fallbackPermissions.allowBash
    };
    const modelRaw = (agent.defaultModel ?? null) as { providerId?: unknown; modelId?: unknown } | null;
    const providerId = typeof modelRaw?.providerId === "string" ? modelRaw.providerId.trim() : "";
    const modelId = typeof modelRaw?.modelId === "string" ? modelRaw.modelId.trim() : "";
    const defaultModel = providerId && modelId ? { providerId, modelId } : null;
    return {
      id,
      name,
      summary,
      prompt,
      tools,
      mcpServers,
      permissions,
      defaultModel
    };
  });

  assertUniqueIdsOrThrow(agents.map((agent) => agent.id), "AGENT_DUPLICATE", "Duplicate agent id");

  const defaultValue = (body.default ?? null) as { agentId?: unknown } | null;
  const defaultAgentId = typeof defaultValue?.agentId === "string" ? defaultValue.agentId.trim() : "";
  const defaultRef = defaultAgentId ? { agentId: defaultAgentId } : null;

  if (defaultRef && !agents.some((agent) => agent.id === defaultRef.agentId)) {
    throw new HttpError(400, "Default agentId not found", "AGENT_DEFAULT_NOT_FOUND");
  }

  const updatedAt = nowMs();
  setSettingJson(
    ctx.db,
    AGENT_SETTINGS_KEY,
    {
      default: defaultRef,
      agents
    },
    updatedAt
  );
  logger.info({ agents: agents.length, updatedAt }, "agent settings updated");

  return {
    default: defaultRef,
    agents,
    updatedAt
  };
}

export function resolveExecutionProfile(ctx: AppContext, input: {
  requestedAgentId?: string | null;
  agentIdFromRun?: string | null;
  providerIdFromRun?: string | null;
  modelIdFromRun?: string | null;
}) {
  const providersSettings = getAgentProvidersSettingsInternal(ctx);
  const agentSettings = getAgentSettings(ctx);

  const resolvedAgentId = [input.agentIdFromRun, input.requestedAgentId, agentSettings.default?.agentId]
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .find((item) => item.length > 0);
  if (!resolvedAgentId) {
    throw new HttpError(400, "Agent is not configured", "AGENT_NOT_CONFIGURED");
  }

  const agent = agentSettings.agents.find((item) => item.id === resolvedAgentId);
  if (!agent) {
    throw new HttpError(400, "Agent not found", "AGENT_NOT_FOUND");
  }

  const fallbackModel = agent.defaultModel ?? providersSettings.default;
  const resolvedProviderId = [input.providerIdFromRun, fallbackModel?.providerId]
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .find((item) => item.length > 0);
  const resolvedModelId = [input.modelIdFromRun, fallbackModel?.modelId]
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .find((item) => item.length > 0);

  if (!resolvedProviderId || !resolvedModelId) {
    throw new HttpError(400, "Default provider/model is not configured", "AGENT_PROVIDER_MODEL_NOT_CONFIGURED");
  }

  const provider = providersSettings.providers.find((item) => item.id === resolvedProviderId);
  if (!provider) {
    throw new HttpError(400, "Provider not found", "AGENT_PROVIDER_NOT_FOUND");
  }
  const model = provider.models.find((item) => item.id === resolvedModelId);
  if (!model) {
    throw new HttpError(400, "Model not found", "AGENT_MODEL_NOT_FOUND");
  }
  if (!provider.options.apiKey) {
    throw new HttpError(400, `Provider '${provider.id}' apiKey is missing`, "AGENT_PROVIDER_API_KEY_MISSING");
  }

  return {
    agent,
    provider,
    model
  } satisfies ExecutionProfileResolved;
}

export async function updateNetworkSettings(
  ctx: AppContext,
  logger: FastifyBaseLogger,
  bodyRaw: unknown
): Promise<NetworkSettings> {
  const body = (bodyRaw ?? {}) as UpdateNetworkSettingsRequest;
  const current = getNetworkSettings(ctx);
  const next: NetworkSettingsV1 = {
    httpProxy: body.httpProxy !== undefined ? (body.httpProxy ? String(body.httpProxy).trim() : null) : current.httpProxy,
    httpsProxy: body.httpsProxy !== undefined ? (body.httpsProxy ? String(body.httpsProxy).trim() : null) : current.httpsProxy,
    noProxy: body.noProxy !== undefined ? (body.noProxy ? String(body.noProxy).trim() : null) : current.noProxy,
    caCertPem: body.caCertPem !== undefined ? (body.caCertPem ? String(body.caCertPem) : null) : current.caCertPem,
    applyToTerminal: body.applyToTerminal !== undefined ? Boolean(body.applyToTerminal) : current.applyToTerminal
  };

  const updatedAt = nowMs();
  setSettingJson(ctx.db, NETWORK_SETTINGS_KEY, next, updatedAt);

  await ensureDir(certsRoot(ctx.dataDir));
  const caPath = caCertPath(ctx.dataDir);
  if (next.caCertPem) {
    await fs.writeFile(caPath, next.caCertPem, { encoding: "utf-8" });
    await ensureCaBundleFile({
      dataDir: ctx.dataDir,
      customCaPem: next.caCertPem,
      fallbackCaPath: caPath,
      writeCustomCa: false
    });
  } else if (await pathExists(caPath)) {
    await fs.rm(caPath, { force: true });
  }
  if (!next.caCertPem) {
    const bundlePath = caBundlePath(ctx.dataDir);
    if (await pathExists(bundlePath)) {
      await fs.rm(bundlePath, { force: true });
    }
  }

  logger.info({ updatedAt }, "network settings updated");
  return { ...next, updatedAt };
}

export async function updateSearchSettings(ctx: AppContext, logger: FastifyBaseLogger, bodyRaw: unknown): Promise<SearchSettings> {
  const body = (bodyRaw ?? {}) as UpdateSearchSettingsRequest;
  const current = getSearchSettings(ctx);
  const excludeGlobs =
    body.excludeGlobs !== undefined ? normalizeSearchExcludeGlobs(body.excludeGlobs, false) : current.excludeGlobs;
  const updatedAt = nowMs();
  setSettingJson(ctx.db, SEARCH_SETTINGS_KEY, { excludeGlobs }, updatedAt);
  logger.info({ updatedAt, excludeGlobs: excludeGlobs.length }, "search settings updated");
  return { excludeGlobs, updatedAt };
}

export function getSecurityStatus(ctx: AppContext): SecurityStatus {
  return {
    credentialMasterKey: {
      source: ctx.credentialMasterKeySource,
      keyId: ctx.credentialMasterKeyId,
      createdAt: ctx.credentialMasterKeyCreatedAt
    },
    sshKnownHostsPath: sshKnownHostsPath(ctx.dataDir)
  };
}

function hostToKnownHostsNeedle(hostRaw: string) {
  const host = String(hostRaw || "").trim();
  if (!host) return "";
  if (host.includes("\n") || host.includes("\r") || host.includes("\0")) return "";
  return host;
}

export async function resetKnownHost(ctx: AppContext, logger: FastifyBaseLogger, bodyRaw: unknown) {
  const body = (bodyRaw ?? {}) as ResetKnownHostRequest;
  const host = hostToKnownHostsNeedle((body as any).host);
  if (!host) throw new HttpError(400, "Invalid host");

  await ensureDir(sshRoot(ctx.dataDir));
  const p = sshKnownHostsPath(ctx.dataDir);
  if (!(await pathExists(p))) return;

  const raw = await fs.readFile(p, "utf-8");
  const lines = raw.split("\n");
  const nextLines = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return true;
    // known_hosts 第一列可能包含多个 host，以逗号分隔
    const first = trimmed.split(" ")[0] || "";
    const hosts = first.split(",").map((x) => x.trim());
    return !hosts.includes(host);
  });
  await fs.writeFile(p, nextLines.join("\n"), { encoding: "utf-8" });
  logger.info({ host }, "known_hosts entry removed");
}

export async function getGitGlobalIdentity(ctx: AppContext): Promise<GitGlobalIdentity> {
  const [name, email] = await Promise.all([
    gitConfigGet({ cwd: ctx.dataDir, global: true, key: "user.name" }),
    gitConfigGet({ cwd: ctx.dataDir, global: true, key: "user.email" })
  ]);
  return { name, email };
}

export async function updateGitGlobalIdentity(ctx: AppContext, logger: FastifyBaseLogger, bodyRaw: unknown): Promise<GitGlobalIdentity> {
  const v = validateAndNormalizeGitIdentity(bodyRaw as UpdateGitGlobalIdentityRequest);
  if (!v) throw new HttpError(400, "Invalid identity. Expected {name,email}.", "GIT_IDENTITY_INVALID");

  const okName = await gitConfigSet({ cwd: ctx.dataDir, global: true, key: "user.name", value: v.name });
  const okEmail = await gitConfigSet({ cwd: ctx.dataDir, global: true, key: "user.email", value: v.email });
  if (!okName || !okEmail) throw new HttpError(409, "Failed to set global git identity.", "GIT_IDENTITY_SET_FAILED");

  logger.info({ scope: "global" }, "git identity updated");
  return getGitGlobalIdentity(ctx);
}

export async function clearAllGitIdentity(ctx: AppContext, logger: FastifyBaseLogger): Promise<ClearAllGitIdentityResponse> {
  const before = await getGitGlobalIdentity(ctx);
  const hadGlobal = Boolean(before.name || before.email);

  // 全局清理
  const okGlobalName = await gitConfigUnsetAll({ cwd: ctx.dataDir, global: true, key: "user.name" });
  const okGlobalEmail = await gitConfigUnsetAll({ cwd: ctx.dataDir, global: true, key: "user.email" });
  const clearedGlobal = hadGlobal && okGlobalName && okGlobalEmail;

  // 遍历所有 workspace repo 目录清理（best-effort）
  const workspaces = listWorkspaces(ctx.db);
  const errors: ClearAllGitIdentityResponse["errors"] = [];

  const results = await Promise.all(
    workspaces.map(async (ws) => {
      try {
        const repos = listWorkspaceRepos(ctx.db, ws.id);
        const okList = await Promise.all(
          repos.map(async (repo) => {
            if (!repo.path) return 0;
            if (!(await pathExists(repo.path))) return 0;
            const okName = await gitConfigUnsetAll({ cwd: ctx.dataDir, repoPath: repo.path, key: "user.name" });
            const okEmail = await gitConfigUnsetAll({ cwd: ctx.dataDir, repoPath: repo.path, key: "user.email" });
            return okName && okEmail ? 1 : 0;
          })
        );
        return okList.reduce<number>((sum, v) => sum + v, 0);
      } catch (err) {
        errors.push({ workspaceId: ws.id, path: ws.path, error: err instanceof Error ? err.message : String(err) });
        return 0;
      }
    })
  );
  const clearedRepos = results.reduce<number>((sum, v) => sum + (v ?? 0), 0);

  logger.info({ clearedGlobal, clearedRepos, errors: errors.length }, "git identity cleared");
  return { ok: errors.length === 0, clearedGlobal, clearedRepos, errors };
}
