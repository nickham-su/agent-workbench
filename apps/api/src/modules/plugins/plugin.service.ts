import fs from "node:fs/promises";
import path from "node:path";
import Ajv from "ajv";
import { getSettingJson, setSettingJson } from "../settings/settings.store.js";
import type { AppContext } from "../../app/context.js";
import type {
  AgentPluginSettings,
  PluginDiagnostic,
  PluginDiagnosticCode,
  PluginManifest,
  PluginRuntimeSnapshot,
  PluginState,
  PluginToolManifestItem,
  PluginToolRuntimeSnapshot,
  UpdateAgentPluginSettingsRequest,
  PluginRuntimeSnapshotsResponse
} from "@agent-workbench/shared";
import { nowMs } from "../../utils/time.js";
import { pluginsRoot } from "../../infra/fs/paths.js";
import { ensureDir } from "../../infra/fs/fs.js";
import { HttpError } from "../../app/errors.js";

const AGENT_PLUGIN_SETTINGS_KEY = "agent_plugins_v1";
const MANIFEST_FILE_NAME = "agent-workbench.plugin.json";
const ENTRY_ALLOWED_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);

const ajv = new Ajv({ allErrors: true, strict: false });

type StoredPluginSettings = Omit<AgentPluginSettings, "updatedAt">;

type PluginSettingsLoaded = {
  settings: StoredPluginSettings;
  updatedAt: number;
};

type PluginDiscoveryRecord = {
  id: string;
  path: string;
  manifest: PluginManifest | null;
  entryPath?: string;
  state: PluginState;
  diagnostics: PluginDiagnostic[];
};

type JsonObject = Record<string, unknown>;

function pushDiagnostic(
  list: PluginDiagnostic[],
  input: {
    code: PluginDiagnosticCode;
    severity: "info" | "warning" | "error";
    source: "discovery" | "manifest" | "config" | "runtime" | "compat";
    message: string;
    details?: unknown;
  }
) {
  list.push({
    code: input.code,
    severity: input.severity,
    source: input.source,
    message: input.message,
    ...(input.details === undefined ? {} : { details: input.details })
  });
}

function toRecordObject(raw: unknown): JsonObject | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as JsonObject;
}

function isJsonSerializable(value: unknown): boolean {
  if (value === null) return true;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return true;
  if (Array.isArray(value)) return value.every((item) => isJsonSerializable(item));
  if (t === "object") {
    const record = value as Record<string, unknown>;
    return Object.values(record).every((item) => isJsonSerializable(item));
  }
  return false;
}

function normalizePluginId(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(value) ? value : "";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validatePluginConfigWithSchema(configSchema: unknown, config: unknown): { ok: boolean; errors?: string[] } {
  if (configSchema === undefined) return { ok: true };
  if (!isPlainObject(configSchema)) {
    return { ok: false, errors: ["configSchema must be a JSON object schema"] };
  }
  try {
    const validate = ajv.compile(configSchema);
    const ok = validate(config);
    if (ok) return { ok: true };
    const errors = (validate.errors ?? []).map((item) => {
      const path = item.instancePath || "/";
      return `${path} ${item.message || "is invalid"}`.trim();
    });
    return { ok: false, errors };
  } catch (err) {
    return { ok: false, errors: [err instanceof Error ? err.message : String(err)] };
  }
}

function normalizePluginToolShortName(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value) ? value : "";
}

function normalizeManifest(raw: unknown): PluginManifest {
  const value = toRecordObject(raw);
  if (!value) {
    throw new Error("manifest must be an object");
  }

  const schemaVersion = value.schemaVersion;
  if (schemaVersion !== 1) {
    throw new Error("schemaVersion must be 1");
  }

  const id = normalizePluginId(value.id);
  if (!id) throw new Error("manifest id is invalid");

  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name) throw new Error("manifest name is required");

  const version = typeof value.version === "string" ? value.version.trim() : "";
  if (!version) throw new Error("manifest version is required");

  const entry = typeof value.entry === "string" ? value.entry.trim() : "";
  if (!entry) throw new Error("manifest entry is required");

  const capabilitiesRaw = Array.isArray(value.capabilities) ? value.capabilities : [];
  const capabilities = capabilitiesRaw.filter(
    (item): item is "tools" | "channels" | "hooks" | "services" =>
      item === "tools" || item === "channels" || item === "hooks" || item === "services"
  );
  if (capabilities.length === 0) {
    throw new Error("manifest capabilities must contain at least one supported value");
  }
  if (new Set(capabilities).size !== capabilities.length) {
    throw new Error("manifest capabilities contains duplicates");
  }

  const toolsRaw = Array.isArray(value.tools) ? value.tools : undefined;
  const tools: PluginToolManifestItem[] | undefined = toolsRaw?.map((itemRaw) => {
    const item = toRecordObject(itemRaw);
    if (!item) {
      throw new Error("tool manifest item must be an object");
    }
    const toolName = normalizePluginToolShortName(item.name);
    if (!toolName) throw new Error("tool manifest name is invalid");
    const description = typeof item.description === "string" ? item.description.trim() : "";
    if (!description) throw new Error(`tool '${toolName}' description is required`);

    const riskLevelRaw = typeof item.riskLevel === "string" ? item.riskLevel.trim() : "";
    const riskLevel: PluginToolManifestItem["riskLevel"] | undefined =
      riskLevelRaw === "low" || riskLevelRaw === "medium" || riskLevelRaw === "high"
        ? (riskLevelRaw as PluginToolManifestItem["riskLevel"])
        : undefined;
    const outputModeRaw = typeof item.outputMode === "string" ? item.outputMode.trim() : "";
    const outputMode: PluginToolManifestItem["outputMode"] | undefined =
      outputModeRaw === "text" || outputModeRaw === "text+raw"
        ? (outputModeRaw as PluginToolManifestItem["outputMode"])
        : undefined;
    return {
      name: toolName,
      description,
      ...(riskLevel ? { riskLevel } : {}),
      ...(outputMode ? { outputMode } : {})
    };
  });

  if (capabilities.includes("tools") && (!tools || tools.length === 0)) {
    throw new Error("manifest tools capability requires non-empty tools[]");
  }
  if (tools) {
    const seen = new Set<string>();
    for (const item of tools) {
      if (seen.has(item.name)) throw new Error(`duplicate tool manifest name '${item.name}'`);
      seen.add(item.name);
    }
  }

  const normalizeNamedItems = (itemsRaw: unknown) => {
    const list = Array.isArray(itemsRaw) ? itemsRaw : undefined;
    return list?.map((itemRaw) => {
      const item = toRecordObject(itemRaw);
      const nameValue = typeof item?.name === "string" ? item.name.trim() : "";
      if (!nameValue) throw new Error("named capability item requires name");
      return { name: nameValue };
    });
  };

  const enginesRaw = toRecordObject(value.engines);
  const engines = enginesRaw
    ? {
        ...(typeof enginesRaw.agentWorkbench === "string" && enginesRaw.agentWorkbench.trim()
          ? { agentWorkbench: enginesRaw.agentWorkbench.trim() }
          : {})
      }
    : undefined;

  const description = typeof value.description === "string" && value.description.trim() ? value.description.trim() : undefined;
  const configSchema = value.configSchema !== undefined ? value.configSchema : undefined;

  const uiHintsRaw = toRecordObject(value.uiHints);
  const sensitiveKeysRaw = Array.isArray(uiHintsRaw?.sensitiveKeys) ? uiHintsRaw?.sensitiveKeys : null;
  const sensitiveKeys = sensitiveKeysRaw
    ? sensitiveKeysRaw
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean)
        .slice(0, 64)
    : [];
  const uiHints = sensitiveKeys.length
    ? {
        sensitiveKeys
      }
    : undefined;

  if (configSchema !== undefined) {
    if (!isPlainObject(configSchema)) {
      throw new Error("configSchema must be a JSON object schema");
    }
    if (!isJsonSerializable(configSchema)) {
      throw new Error("configSchema must be JSON-serializable");
    }
    // Validate schema syntax only.
    // Do NOT validate a sample instance (like {}) here, because many plugins legitimately
    // require secrets/credentials in configSchema.required. Instance validation happens
    // when user saves plugin settings.
    try {
      ajv.compile(configSchema as any);
    } catch (err) {
      throw new Error(`configSchema is invalid: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    schemaVersion: 1,
    id,
    name,
    version,
    entry,
    ...(uiHints ? { uiHints } : {}),
    capabilities,
    ...(description ? { description } : {}),
    ...(engines && Object.keys(engines).length > 0 ? { engines } : {}),
    ...(tools ? { tools } : {}),
    ...(normalizeNamedItems(value.channels) ? { channels: normalizeNamedItems(value.channels)! } : {}),
    ...(normalizeNamedItems(value.hooks) ? { hooks: normalizeNamedItems(value.hooks)! } : {}),
    ...(normalizeNamedItems(value.services) ? { services: normalizeNamedItems(value.services)! } : {}),
    ...(configSchema !== undefined ? { configSchema } : {})
  } satisfies PluginManifest;
}

function getAgentPluginSettingsStored(ctx: AppContext): PluginSettingsLoaded {
  const row = getSettingJson(ctx.db, AGENT_PLUGIN_SETTINGS_KEY);
  const value = row?.value as { plugins?: unknown } | undefined;
  const pluginsRaw = Array.isArray(value?.plugins) ? value.plugins : [];
  const seen = new Set<string>();
  const plugins = pluginsRaw
    .map((itemRaw) => {
      const item = toRecordObject(itemRaw);
      if (!item) return null;
      const id = normalizePluginId(item.id);
      if (!id || seen.has(id)) return null;
      seen.add(id);
      const enabled = typeof item.enabled === "boolean" ? item.enabled : false;
      const config = item.config;
      if (config !== undefined && !isJsonSerializable(config)) return null;
      return {
        id,
        enabled,
        ...(config === undefined ? {} : { config })
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  return {
    settings: { plugins },
    updatedAt: row?.updatedAt ?? 0
  };
}

function resolvePluginState(input: {
  enabled: boolean;
  staticState: PluginState;
  diagnostics: PluginDiagnostic[];
  configValid: boolean;
}): PluginState {
  if (input.staticState !== "ready") return input.staticState;
  if (!input.enabled) return "disabled";
  if (!input.configValid) return "config_invalid";
  return "ready";
}

function toToolSnapshots(manifest: PluginManifest | null): PluginToolRuntimeSnapshot[] | undefined {
  if (!manifest?.tools || manifest.tools.length === 0) return undefined;
  return manifest.tools.map((tool) => ({
    canonicalName: `plugin_${manifest.id}_${tool.name}`,
    shortName: tool.name,
    description: tool.description,
    ...(tool.riskLevel ? { riskLevel: tool.riskLevel } : {})
  }));
}

async function discoverPluginDirectories(pluginRootPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(pluginRootPath, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(pluginRootPath, entry.name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }
}

async function discoverPluginRecord(pluginDirPath: string): Promise<PluginDiscoveryRecord> {
  const diagnostics: PluginDiagnostic[] = [];
  const dirName = path.basename(pluginDirPath);
  const manifestPath = path.join(pluginDirPath, MANIFEST_FILE_NAME);
  let manifest: PluginManifest | null = null;
  let state: PluginState = "ready";
  let pluginId = normalizePluginId(dirName) || dirName;
  let entryPath: string | undefined;

  try {
    const manifestRaw = await fs.readFile(manifestPath, "utf-8");
    manifest = normalizeManifest(JSON.parse(manifestRaw));
    pluginId = manifest.id;
  } catch (err) {
    state = "invalid_manifest";
    pushDiagnostic(diagnostics, {
      code: "manifest_invalid",
      severity: "error",
      source: "manifest",
      message: err instanceof Error ? err.message : String(err)
    });
    return {
      id: pluginId,
      path: pluginDirPath,
      manifest: null,
      state,
      diagnostics
    };
  }

  pushDiagnostic(diagnostics, {
    code: "plugin_discovered",
    severity: "info",
    source: "discovery",
    message: `Plugin '${manifest.id}' discovered`
  });

  if (
    manifest.engines?.agentWorkbench &&
    manifest.engines.agentWorkbench.trim() &&
    manifest.engines.agentWorkbench.trim() !== "*" &&
    manifest.engines.agentWorkbench.trim() !== "^0.1.0"
  ) {
    state = "incompatible";
    pushDiagnostic(diagnostics, {
      code: "plugin_incompatible",
      severity: "error",
      source: "compat",
      message: `Unsupported agentWorkbench engine range: ${manifest.engines.agentWorkbench}`
    });
  }

  const candidateEntryPath = path.resolve(pluginDirPath, manifest.entry);
  const relativeEntry = path.relative(pluginDirPath, candidateEntryPath);
  if (relativeEntry.startsWith("..") || path.isAbsolute(relativeEntry)) {
    state = "invalid_manifest";
    pushDiagnostic(diagnostics, {
      code: "entry_out_of_root",
      severity: "error",
      source: "manifest",
      message: "Plugin entry must stay within plugin root",
      details: { entry: manifest.entry }
    });
  } else if (!ENTRY_ALLOWED_EXTENSIONS.has(path.extname(candidateEntryPath))) {
    state = "invalid_manifest";
    pushDiagnostic(diagnostics, {
      code: "entry_extension_unsupported",
      severity: "error",
      source: "manifest",
      message: "Plugin entry extension must be .js, .mjs, or .cjs",
      details: { entry: manifest.entry }
    });
  } else {
    try {
      const pluginDirRealPath = await fs.realpath(pluginDirPath);
      const entryRealPath = await fs.realpath(candidateEntryPath);
      const relativeRealEntry = path.relative(pluginDirRealPath, entryRealPath);
      if (relativeRealEntry.startsWith("..") || path.isAbsolute(relativeRealEntry)) {
        state = "invalid_manifest";
        pushDiagnostic(diagnostics, {
          code: "entry_out_of_root",
          severity: "error",
          source: "manifest",
          message: "Plugin entry real path must stay within plugin root",
          details: { entry: manifest.entry }
        });
      } else {
        const stat = await fs.stat(entryRealPath);
        if (!stat.isFile()) {
          throw new Error("entry is not a file");
        }
        entryPath = entryRealPath;
      }
    } catch (err) {
      if (state !== "invalid_manifest") {
        state = "invalid_manifest";
        pushDiagnostic(diagnostics, {
          code: "entry_not_found",
          severity: "error",
          source: "manifest",
          message: "Plugin entry file not found",
          details: { entry: manifest.entry, error: err instanceof Error ? err.message : String(err) }
        });
      }
    }
  }

  const seenCapabilities = new Set(manifest.capabilities);
  for (const capability of ["hooks"] as const) {
    if (seenCapabilities.has(capability)) {
      pushDiagnostic(diagnostics, {
        code: "unsupported_capability",
        severity: "warning",
        source: "compat",
        message: `Capability '${capability}' is declared but not implemented in current host version`
      });
    }
  }

  return {
    id: manifest.id,
    path: pluginDirPath,
    manifest,
    ...(entryPath ? { entryPath } : {}),
    state,
    diagnostics
  };
}

export async function getAgentPluginSettings(ctx: AppContext): Promise<AgentPluginSettings> {
  const loaded = getAgentPluginSettingsStored(ctx);
  return {
    plugins: loaded.settings.plugins,
    updatedAt: loaded.updatedAt
  };
}

export async function updateAgentPluginSettings(
  ctx: AppContext,
  bodyRaw: unknown
): Promise<AgentPluginSettings> {
  const body = (bodyRaw ?? {}) as UpdateAgentPluginSettingsRequest;
  const incoming = Array.isArray(body.plugins) ? body.plugins : [];
  const seen = new Set<string>();
  const discovered = await listPluginRuntimeSnapshots(ctx);
  const snapshotById = new Map(discovered.plugins.map((item) => [item.id, item]));
  const existing = getAgentPluginSettingsStored(ctx);
  const existingById = new Map(existing.settings.plugins.map((item) => [item.id, item]));

  function mergeSecrets(params: { pluginId: string; incomingConfig: unknown }): unknown {
    const snapshot = snapshotById.get(params.pluginId);
    const sensitiveKeys = snapshot?.manifest?.uiHints?.sensitiveKeys ?? [];
    if (!params.incomingConfig || typeof params.incomingConfig !== "object" || Array.isArray(params.incomingConfig)) {
      return params.incomingConfig;
    }
    if (sensitiveKeys.length === 0) return params.incomingConfig;

    const prev = existingById.get(params.pluginId)?.config;
    const prevObj = prev && typeof prev === "object" && !Array.isArray(prev) ? (prev as Record<string, unknown>) : null;
    const next = { ...(params.incomingConfig as Record<string, unknown>) };

    for (const key of sensitiveKeys) {
      const hasKey = Object.prototype.hasOwnProperty.call(next, key);
      const v = (next as any)[key];
      const keep =
        !hasKey ||
        v === undefined ||
        (typeof v === "string" && (v.trim() === "" || v.trim() === "***"));
      if (keep && prevObj && Object.prototype.hasOwnProperty.call(prevObj, key)) {
        (next as any)[key] = (prevObj as any)[key];
      }
      if (keep && (!prevObj || !Object.prototype.hasOwnProperty.call(prevObj, key))) {
        delete (next as any)[key];
      }
    }

    return next;
  }

  const plugins = incoming.map((itemRaw) => {
    const item = toRecordObject(itemRaw);
    const id = normalizePluginId(item?.id);
    if (!id) {
      throw new HttpError(400, "Plugin id is required", "AGENT_PLUGIN_ID_REQUIRED");
    }
    if (seen.has(id)) {
      throw new HttpError(400, "Duplicate plugin id", "AGENT_PLUGIN_DUPLICATE");
    }
    seen.add(id);

    const enabled = typeof item?.enabled === "boolean" ? item.enabled : false;

    // Note: treat config as optional. When caller does not provide config,
    // we keep the existing config (if any). This allows disabling a plugin
    // even when its config would fail configSchema validation.
    const hasConfigProp = !!item && Object.prototype.hasOwnProperty.call(item, "config");
    const incomingConfig = hasConfigProp ? item?.config : undefined;
    if (incomingConfig !== undefined && !isJsonSerializable(incomingConfig)) {
      throw new HttpError(400, "Plugin config must be JSON-serializable", "AGENT_PLUGIN_CONFIG_INVALID");
    }

    const snapshot = snapshotById.get(id);

    const prevConfig = existingById.get(id)?.config;
    const mergedConfig = hasConfigProp
      ? incomingConfig === undefined
        ? undefined
        : mergeSecrets({ pluginId: id, incomingConfig: incomingConfig })
      : prevConfig;

    // Validate config only when plugin is enabled.
    // - Enabled + missing config should be treated as invalid if configSchema requires it.
    // - Disabled plugin can be saved without passing configSchema.
    if (enabled) {
      const schemaValidation = validatePluginConfigWithSchema(snapshot?.manifest?.configSchema, mergedConfig ?? {});
      if (!schemaValidation.ok) {
        throw new HttpError(
          400,
          `Plugin config is invalid: ${(schemaValidation.errors || []).join("; ")}`,
          "AGENT_PLUGIN_CONFIG_INVALID"
        );
      }
    }
    return {
      id,
      enabled,
      ...(mergedConfig === undefined ? {} : { config: mergedConfig })
    };
  });

  const updatedAt = nowMs();
  setSettingJson(ctx.db, AGENT_PLUGIN_SETTINGS_KEY, { plugins }, updatedAt);
  return {
    plugins,
    updatedAt
  };
}

type PluginRootSpec = {
  source: "user" | "official";
  rootPath: string;
  priority: number;
};

type PluginDiscoveryResolvedRecord = PluginDiscoveryRecord & {
  rootSource: PluginRootSpec["source"];
  rootPriority: number;
};

function resolvePluginRoots(ctx: AppContext): PluginRootSpec[] {
  const resolvedRepoRoot = path.resolve(ctx.repoRoot || process.cwd());
  return [
    { source: "user", rootPath: pluginsRoot(ctx.dataDir), priority: 100 },
    { source: "official", rootPath: path.join(resolvedRepoRoot, "plugins"), priority: 10 }
  ];
}

export async function listPluginRuntimeSnapshots(ctx: AppContext): Promise<PluginRuntimeSnapshotsResponse> {
  const roots = resolvePluginRoots(ctx);
  const userRoot = roots.find((item) => item.source === "user")?.rootPath;
  if (userRoot) {
    await ensureDir(userRoot);
  }
  const settings = await getAgentPluginSettings(ctx);
  const settingsById = new Map(settings.plugins.map((item) => [item.id, item]));
  const discoveredByRoot = await Promise.all(
    roots.map(async (root): Promise<PluginDiscoveryResolvedRecord[]> => {
      const pluginDirs = await discoverPluginDirectories(root.rootPath);
      const discovered = await Promise.all(pluginDirs.map((dirPath) => discoverPluginRecord(dirPath)));
      return discovered.map((record) => ({
        ...record,
        rootSource: root.source,
        rootPriority: root.priority
      }));
    })
  );
  const discovered = discoveredByRoot.flat();
  const idToRecords = new Map<string, PluginDiscoveryResolvedRecord[]>();
  for (const record of discovered) {
    const list = idToRecords.get(record.id) ?? [];
    list.push(record);
    idToRecords.set(record.id, list);
  }

  const snapshots: PluginRuntimeSnapshot[] = [];
  for (const [pluginId, records] of idToRecords.entries()) {
    const ranked = [...records].sort((a, b) => {
      if (b.rootPriority !== a.rootPriority) return b.rootPriority - a.rootPriority;
      return a.path.localeCompare(b.path);
    });
    const selected = ranked[0]!;
    const samePriorityRecords = ranked.filter((item) => item.rootPriority === selected.rootPriority);

    if (samePriorityRecords.length > 1) {
      for (const record of samePriorityRecords) {
        const diagnostics = [...record.diagnostics];
        pushDiagnostic(diagnostics, {
          code: "tool_name_conflict",
          severity: "error",
          source: "discovery",
          message: `Duplicate plugin id '${pluginId}' discovered under ${record.rootSource} root`
        });
        snapshots.push({
          id: pluginId,
          path: record.path,
          manifest: record.manifest,
          ...(record.entryPath ? { entryPath: record.entryPath } : {}),
          enabled: false,
          state: "invalid_manifest",
          diagnostics,
          capabilities: {
            ...(record.manifest?.tools ? { tools: toToolSnapshots(record.manifest) } : {}),
            ...(record.manifest?.channels ? { channels: record.manifest.channels } : {}),
            ...(record.manifest?.hooks ? { hooks: record.manifest.hooks } : {}),
            ...(record.manifest?.services ? { services: record.manifest.services } : {})
          }
        });
      }
      continue;
    }

    const record = selected;
    const configured = settingsById.get(pluginId);
    const diagnostics = [...record.diagnostics];
    const enabled = configured?.enabled === true;

    const userRecords = ranked.filter((item) => item.rootSource === "user");
    const officialRecords = ranked.filter((item) => item.rootSource === "official");
    if (userRecords.length > 0 && officialRecords.length > 0) {
      pushDiagnostic(diagnostics, {
        code: "PLUGIN_ID_CONFLICT_OVERRIDDEN",
        severity: "warning",
        source: "discovery",
        message: `Plugin '${pluginId}' exists in both user and official roots; user root overrides official root`,
        details: {
          userCount: userRecords.length,
          officialCount: officialRecords.length,
          hasConflict: true,
          resolvedSource: record.rootSource
        }
      });
    }

    let configValid = true;
    if (enabled) {
      if (configured?.config !== undefined && !isJsonSerializable(configured.config)) {
        configValid = false;
        pushDiagnostic(diagnostics, {
          code: "config_invalid",
          severity: "error",
          source: "config",
          message: "Plugin config must be JSON-serializable"
        });
      } else if (record.manifest?.configSchema !== undefined) {
        const validation = validatePluginConfigWithSchema(record.manifest.configSchema, configured?.config ?? {});
        if (!validation.ok) {
          configValid = false;
          pushDiagnostic(diagnostics, {
            code: "config_invalid",
            severity: "error",
            source: "config",
            message: `Plugin config does not match configSchema: ${(validation.errors || []).join("; ")}`
          });
        }
      }
    }
    if (!enabled) {
      pushDiagnostic(diagnostics, {
        code: "plugin_disabled",
        severity: "info",
        source: "config",
        message: `Plugin '${pluginId}' is disabled`
      });
    }
    const state = resolvePluginState({
      enabled,
      staticState: record.state,
      diagnostics,
      configValid
    });

    snapshots.push({
      id: pluginId,
      path: record.path,
      manifest: record.manifest,
      ...(record.entryPath ? { entryPath: record.entryPath } : {}),
      enabled,
      state,
      diagnostics,
      ...(configured?.config === undefined ? {} : { config: configured.config }),
      capabilities: {
        ...(record.manifest?.tools ? { tools: toToolSnapshots(record.manifest) } : {}),
        ...(record.manifest?.channels ? { channels: record.manifest.channels } : {}),
        ...(record.manifest?.hooks ? { hooks: record.manifest.hooks } : {}),
        ...(record.manifest?.services ? { services: record.manifest.services } : {})
      }
    });
  }

  snapshots.sort((a, b) => a.id.localeCompare(b.id));
  return {
    plugins: snapshots,
    updatedAt: Math.max(settings.updatedAt, 0)
  };
}
