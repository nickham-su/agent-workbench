# Local Tool Plugin Interfaces v1

Status: draft

本文给出本地工具插件方案的接口草案,用于后续实现时统一 shared contracts、API 插件治理模块、worker runtime 与 plugin-sdk 之间的边界。

## 设计原则

- 面向本地目录型插件包
- v1 只落地 `tools`
- 类型层与 manifest 层预留 `channels/hooks/services`
- 输出契约固定为 `text` 必填, `raw` 可选
- prompt 只消费 `text`
- worker 为工具事实来源
- API 不执行插件代码

## 目录与文件约定

```text
<runtimeRoot>/plugins/<pluginId>/
  package.json
  agent-workbench.plugin.json
  dist/index.js
```

manifest 文件名建议固定为:

```text
agent-workbench.plugin.json
```

## Manifest JSON Schema 草案

说明:

- 以下为草案,可在 `packages/shared` 中以 TypeBox / JSON Schema 实现
- schema 自身不要求 v1 立即消费全部能力字段,但需保留扩展位

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://agent-workbench.dev/schemas/plugin-manifest-v1.json",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schemaVersion",
    "id",
    "name",
    "version",
    "entry",
    "capabilities"
  ],
  "properties": {
    "schemaVersion": {
      "type": "integer",
      "const": 1
    },
    "id": {
      "type": "string",
      "pattern": "^[a-z0-9][a-z0-9-]{0,63}$"
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
    },
    "version": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "description": {
      "type": "string",
      "maxLength": 2000
    },
    "entry": {
      "type": "string",
      "minLength": 1
    },
    "engines": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "agentWorkbench": {
          "type": "string",
          "minLength": 1
        }
      }
    },
    "capabilities": {
      "type": "array",
      "uniqueItems": true,
      "items": {
        "type": "string",
        "enum": ["tools", "channels", "hooks", "services"]
      }
    },
    "tools": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["name", "description"],
        "properties": {
          "name": {
            "type": "string",
            "pattern": "^[a-zA-Z][a-zA-Z0-9_-]{0,63}$"
          },
          "description": {
            "type": "string",
            "minLength": 1,
            "maxLength": 2000
          },
          "riskLevel": {
            "type": "string",
            "enum": ["low", "medium", "high"]
          },
          "outputMode": {
            "type": "string",
            "enum": ["text", "text+raw"]
          }
        }
      }
    },
    "channels": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["name"],
        "properties": {
          "name": { "type": "string", "minLength": 1 }
        }
      }
    },
    "hooks": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["name"],
        "properties": {
          "name": { "type": "string", "minLength": 1 }
        }
      }
    },
    "services": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["name"],
        "properties": {
          "name": { "type": "string", "minLength": 1 }
        }
      }
    },
    "configSchema": {
      "type": "object"
    }
  }
}
```

## Manifest 运行时校验规则草案

除 schema 校验外,还需要额外运行时规则:

1. `entry` 必须位于插件根目录内
2. `entry` 正式支持后缀: `.js` / `.mjs` / `.cjs`
3. `.ts` 仅开发模式友好支持,不作为生产兼容承诺
4. `capabilities` 至少包含一项
5. 若包含 `tools`,则 `tools[]` 不得为空
6. `tools[].name` 在插件内不得重复
7. 插件 `id` 全局不得冲突
8. runtime 导出的工具集合必须是 manifest `tools[]` 的子集

## Shared Contracts 草案

## canonical name

```ts
export type PluginId = string;
export type PluginToolShortName = string;
export type PluginToolCanonicalName = `plugin_${string}_${string}`;

export function toPluginToolCanonicalName(pluginId: string, toolName: string): PluginToolCanonicalName {
  return `plugin_${pluginId}_${toolName}`;
}
```

## diagnostics

```ts
export type PluginDiagnosticSeverity = "info" | "warning" | "error";

export type PluginDiagnosticSource =
  | "discovery"
  | "manifest"
  | "config"
  | "runtime"
  | "compat";

export type PluginDiagnosticCode =
  | "plugin_discovered"
  | "plugin_disabled"
  | "manifest_invalid"
  | "plugin_incompatible"
  | "config_invalid"
  | "entry_not_found"
  | "entry_out_of_root"
  | "entry_extension_unsupported"
  | "plugin_load_failed"
  | "plugin_manifest_mismatch"
  | "tool_name_conflict"
  | "unsupported_capability";

export type PluginDiagnostic = {
  code: PluginDiagnosticCode;
  severity: PluginDiagnosticSeverity;
  source: PluginDiagnosticSource;
  message: string;
  details?: unknown;
};
```

## plugin state

```ts
export type PluginState =
  | "discovered"
  | "disabled"
  | "invalid_manifest"
  | "incompatible"
  | "config_invalid"
  | "load_failed"
  | "manifest_mismatch"
  | "ready";
```

## runtime snapshot

```ts
export type PluginRuntimeSnapshot = {
  id: string;
  path: string;
  manifest: PluginManifest;
  enabled: boolean;
  state: PluginState;
  diagnostics: PluginDiagnostic[];
  config?: unknown;
  loadedAt?: string;
  capabilities: {
    tools?: PluginToolRuntimeSnapshot[];
    channels?: PluginChannelRuntimeSnapshot[];
    hooks?: PluginHookRuntimeSnapshot[];
    services?: PluginServiceRuntimeSnapshot[];
  };
};

export type PluginToolRuntimeSnapshot = {
  canonicalName: PluginToolCanonicalName;
  shortName: string;
  description: string;
  enabledForAgent?: boolean;
  riskLevel?: "low" | "medium" | "high";
};

export type PluginChannelRuntimeSnapshot = {
  name: string;
};

export type PluginHookRuntimeSnapshot = {
  name: string;
};

export type PluginServiceRuntimeSnapshot = {
  name: string;
};
```

## settings 结构草案

## 全局插件设置

```ts
export type GlobalPluginSettings = {
  plugins: Array<{
    id: string;
    path: string;
    enabled: boolean;
    config?: unknown;
  }>;
};
```

说明:

- `path` 通常来自扫描结果
- `config` 是插件级全局配置
- v1 不支持 per-agent plugin config

## Agent 工具设置

建议将 agent 配置扩展为:

```ts
export type AgentToolSelectionSettings = {
  builtinTools: string[];
  mcpServers: string[];
  pluginTools: PluginToolCanonicalName[];
};
```

说明:

- `pluginTools` 保存 canonical name
- agent 按工具启用插件能力

## plugin-sdk TypeScript 类型草案

## 顶层定义

```ts
export type JsonSerializable =
  | null
  | boolean
  | number
  | string
  | JsonSerializable[]
  | { [key: string]: JsonSerializable };

export type JsonSchema = Record<string, unknown>;

export type PluginMeta = {
  id: string;
  name: string;
  version: string;
  description?: string;
};

export type PluginDefinition = {
  meta: PluginMeta;
  capabilities: PluginCapabilities;
  lifecycle?: PluginLifecycle;
};

export type PluginCapabilities = {
  tools?: ToolDefinition[];
  channels?: ChannelDefinition[];
  hooks?: HookDefinition[];
  services?: ServiceDefinition[];
};
```

## 工具定义

```ts
export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputMode?: "text" | "text+raw";
  riskLevel?: "low" | "medium" | "high";
  execute: (args: unknown, ctx: ToolExecutionContext) => Promise<ToolExecutionResult>;
};

export type ToolExecutionResult = {
  text: string;
  raw?: JsonSerializable;
};
```

### 规则

- `text` 必填
- `raw` 可选
- `raw` 必须 JSON-serializable
- 插件允许抛异常,由宿主转换为统一失败结果

## 预留能力定义

```ts
export type ChannelDefinition = {
  name: string;
};

export type HookDefinition = {
  name: string;
};

export type ServiceDefinition = {
  name: string;
};
```

v1 说明:

- 以上类型只作为前向兼容占位,暂不执行

## 生命周期与上下文

```ts
export type PluginLifecycle = {
  onLoad?: (ctx: PluginContext) => Promise<void> | void;
  onUnload?: (ctx: PluginContext) => Promise<void> | void;
};

export type PluginContext = {
  pluginId: string;
  runtimeRoot: string;
  workspaceRoot?: string;
  config?: unknown;
  logger: PluginLogger;
  env: Record<string, string | undefined>;
  signal?: AbortSignal;
};

export type ToolExecutionContext = PluginContext & {
  toolName: string;
  canonicalName: PluginToolCanonicalName;
  runId?: string;
  sessionId?: string;
};

export type PluginLogger = {
  debug?: (message: string, meta?: unknown) => void;
  info?: (message: string, meta?: unknown) => void;
  warn?: (message: string, meta?: unknown) => void;
  error?: (message: string, meta?: unknown) => void;
};
```

说明:

- `PluginContext` 面向插件级初始化与未来 hooks/services
- `ToolExecutionContext` 面向单次工具执行
- 二者分层是为了后续自然扩展 channels/hooks/services

## helper API 草案

```ts
export function definePlugin(definition: PluginDefinition): PluginDefinition {
  return definition;
}

export function defineTool(definition: ToolDefinition): ToolDefinition {
  return definition;
}
```

## Worker 侧接口草案

## ResolvedToolDefinition

```ts
export type ResolvedToolDefinition = {
  canonicalName: string;
  displayName: string;
  description: string;
  inputSchema: JsonSchema;
  source: "builtin" | "mcp" | "plugin";
  pluginId?: string;
  mcpServerId?: string;
  outputMode?: "text" | "text+raw";
  riskLevel?: "low" | "medium" | "high";
};
```

## ToolRegistry

```ts
export type ToolListContext = {
  runtimeRoot: string;
  workspaceRoot?: string;
  executionProfile?: unknown;
  promptContext?: unknown;
};

export type ToolExecuteContext = {
  runtimeRoot: string;
  workspaceRoot?: string;
  sessionId?: string;
  runId?: string;
  signal?: AbortSignal;
};

export interface ToolProvider {
  listTools(ctx: ToolListContext): Promise<ResolvedToolDefinition[]>;
  execute(toolName: string, args: unknown, ctx: ToolExecuteContext): Promise<ToolExecutionResult>;
}

export interface ToolRegistry {
  listTools(ctx: ToolListContext): Promise<ResolvedToolDefinition[]>;
  execute(toolName: string, args: unknown, ctx: ToolExecuteContext): Promise<ToolExecutionResult>;
}
```

说明:

- `BuiltinToolProvider`、`McpToolProvider`、`LocalPluginToolProvider` 都实现同一接口
- `runner.ts` 不再维护硬编码工具分发,而是依赖 `ToolRegistry`

## PluginRuntimeManager

```ts
export type PluginLoadRequest = {
  runtimeRoot: string;
  workspaceRoot?: string;
  snapshots: PluginRuntimeSnapshot[];
};

export type LoadedPlugin = {
  id: string;
  manifest: PluginManifest;
  definition: PluginDefinition;
  context: PluginContext;
  diagnostics: PluginDiagnostic[];
};

export interface PluginRuntimeManager {
  sync(request: PluginLoadRequest): Promise<void>;
  listLoadedPlugins(): LoadedPlugin[];
  getPlugin(pluginId: string): LoadedPlugin | null;
  getToolProvider(): ToolProvider;
  dispose(): Promise<void>;
}
```

职责建议:

- 根据 API 下发的 snapshot 加载启用插件
- 运行 manifest/runtime 一致性检查
- 调用 `lifecycle.onLoad`
- 生成 `LocalPluginToolProvider`
- 为未来 `ChannelRegistry` / `HookRegistry` / `ServiceRegistry` 预留扩展点

## API 插件治理接口草案

以下为内部职责草案,非最终 HTTP 形态约束。

```ts
export interface PluginDiscoveryService {
  discover(runtimeRoot: string): Promise<DiscoveredPlugin[]>;
}

export type DiscoveredPlugin = {
  id: string;
  path: string;
  manifest?: PluginManifest;
  diagnostics: PluginDiagnostic[];
};

export interface PluginService {
  listPlugins(): Promise<PluginRuntimeSnapshot[]>;
  getPlugin(id: string): Promise<PluginRuntimeSnapshot | null>;
  setPluginEnabled(id: string, enabled: boolean): Promise<void>;
  updatePluginConfig(id: string, config: unknown): Promise<void>;
  getRuntimeSnapshot(): Promise<{ plugins: PluginRuntimeSnapshot[] }>;
}
```

## 运行时输出与 prompt 约束草案

```ts
export type NormalizedToolOutput = {
  text: string;
  raw?: JsonSerializable;
  error?: string;
};
```

执行规则:

- worker 在执行插件工具后必须得到 `text`
- prompt 回灌只用 `text`
- `raw` 只作为内部可选结构化信息保留在内存或有限元数据中
- v1 默认不将插件 `raw` 持久化到 `tool_result_json`

## manifest/runtime 一致性检查伪代码

```ts
function validateManifestRuntime(manifest: PluginManifest, definition: PluginDefinition): PluginDiagnostic[] {
  const diagnostics: PluginDiagnostic[] = [];

  if (manifest.id !== definition.meta.id) {
    diagnostics.push({
      code: "plugin_manifest_mismatch",
      severity: "error",
      source: "runtime",
      message: "Plugin id does not match manifest id"
    });
  }

  if (manifest.version !== definition.meta.version) {
    diagnostics.push({
      code: "plugin_manifest_mismatch",
      severity: "error",
      source: "runtime",
      message: "Plugin version does not match manifest version"
    });
  }

  const declaredToolNames = new Set((manifest.tools ?? []).map((item) => item.name));
  for (const tool of definition.capabilities.tools ?? []) {
    if (!declaredToolNames.has(tool.name)) {
      diagnostics.push({
        code: "plugin_manifest_mismatch",
        severity: "error",
        source: "runtime",
        message: `Tool ${tool.name} is not declared in manifest`
      });
    }
  }

  return diagnostics;
}
```

## `debug-tools / echo_inspect` 样板插件草案

### Manifest 示例

```json
{
  "schemaVersion": 1,
  "id": "debug-tools",
  "name": "Debug Tools",
  "version": "0.1.0",
  "entry": "dist/index.js",
  "description": "用于验证本地工具插件链路的调试插件",
  "capabilities": ["tools"],
  "tools": [
    {
      "name": "echo_inspect",
      "description": "回显输入参数并输出调试摘要",
      "outputMode": "text+raw",
      "riskLevel": "low"
    }
  ],
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "prefix": { "type": "string" }
    }
  }
}
```

### SDK 示例

```ts
import { definePlugin, defineTool } from "@agent-workbench/plugin-sdk";

export default definePlugin({
  meta: {
    id: "debug-tools",
    name: "Debug Tools",
    version: "0.1.0",
    description: "用于验证工具插件链路"
  },
  capabilities: {
    tools: [
      defineTool({
        name: "echo_inspect",
        description: "回显输入参数并输出调试摘要",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            message: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            includeRaw: { type: "boolean" }
          }
        },
        outputMode: "text+raw",
        riskLevel: "low",
        async execute(args, ctx) {
          const input = (args ?? {}) as {
            message?: string;
            tags?: string[];
            includeRaw?: boolean;
          };

          return {
            text: [
              `plugin: ${ctx.pluginId}`,
              `tool: ${ctx.canonicalName}`,
              `message: ${input.message ?? ""}`,
              `tags: ${(input.tags ?? []).length}`
            ].join("\n"),
            raw: input.includeRaw
              ? {
                  receivedArgs: input,
                  pluginId: ctx.pluginId,
                  toolName: ctx.toolName
                }
              : undefined
          };
        }
      })
    ]
  }
});
```

## 推荐落地顺序

1. 在 shared 中补齐 manifest / diagnostics / settings / snapshot 契约
2. 在 worker 中先实现 `ToolRegistry` 与 `PluginRuntimeManager` 骨架
3. 在 API 中实现插件目录扫描、manifest 校验与 runtime snapshot
4. 增加 `pluginTools` agent 设置
5. 用 `debug-tools / echo_inspect` 样板插件完成端到端验证

## 总结

本草案的重点不在于一次性把所有插件能力做完,而在于先把以下几个接口边界固定下来:

- manifest 是声明来源
- worker runtime 是执行来源
- 插件是能力容器,而不是纯工具列表
- v1 只实现 tools,但上下文、生命周期、snapshot 与 registry 均按未来可扩展结构设计
- 插件工具统一采用 `text` 必填、`raw` 可选 的输出契约
