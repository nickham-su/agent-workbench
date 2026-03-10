# 本地工具插件开发手册

## 适用范围

本手册面向 **agent-workbench 本地工具插件** 的开发者，描述当前 **v1** 版本已经落地的插件开发方式。

当前版本只支持：

- 本地目录型插件包
- 工具能力（tools）
- JS 入口文件（`.js` / `.mjs` / `.cjs`）

当前版本暂不支持：

- artifact 协议
- hooks
- services
- channels / IM capability
- UI 扩展
- 生产环境直接运行 `.ts` 入口
- 远程插件仓库 / 自动安装依赖
- 热重载

如果你要开发的是：

- 给模型新增一个本地工具
- 让 agent 在运行时动态看到并调用该工具

那么本手册适用。

---

## 核心结论

先记住这几条：

- 插件目录固定放在：`<dataDir>/plugins/<pluginId>/`
- 每个插件必须包含：`agent-workbench.plugin.json`
- 插件入口必须是 JS 文件，且位于插件目录内
- 当前只支持工具插件，插件导出里真正会被宿主消费的是 `capabilities.tools`
- 每个工具都必须实现：`name` / `description` / `inputSchema` / `execute`
- 工具返回值必须满足：`text` 必填，`raw` 可选
- `raw` 必须是 JSON-serializable 数据
- 模型只消费 `text`，不会直接消费 `raw`
- 工具 canonical name 由宿主生成：`plugin_<pluginId>_<toolName>`

---

## 插件目录位置与运行目录约定

agent-workbench 当前将运行期数据统一放在 `dataDir` 下。

本地插件目录约定为：

```text
<dataDir>/plugins/<pluginId>/
```

例如：

```text
.data/plugins/debug-tools/
.data/plugins/acme-jira/
```

说明：

- `dataDir` 由服务启动配置决定（默认通常是 `./.data`）
- 插件扫描根目录是 `<dataDir>/plugins`
- 插件必须是 **目录型插件包**，不支持单独一个散落的脚本文件
- 插件入口文件必须真实位于插件目录内；如果入口通过软链跳出插件根目录，会被拒绝

---

## 最小插件目录结构

推荐的最小目录结构如下：

```text
plugins/<pluginId>/
  package.json
  agent-workbench.plugin.json
  dist/
    index.js
```

一个可工作的最小示例：

```text
plugins/debug-tools/
  package.json
  agent-workbench.plugin.json
  dist/index.js
```

如果你在本仓库中查看参考样例，可以看：

```text
test/fixtures/plugins/debug-tools/
```

---

## `agent-workbench.plugin.json` 最小示例

最小 manifest 示例：

```json
{
  "schemaVersion": 1,
  "id": "debug-tools",
  "name": "Debug Tools",
  "version": "0.1.0",
  "entry": "dist/index.js",
  "capabilities": ["tools"],
  "tools": [
    {
      "name": "echo_inspect",
      "description": "Echo input for debugging and plugin validation",
      "outputMode": "text+raw"
    }
  ]
}
```

### 字段说明

| 字段 | 必填 | 说明 |
|---|---|---|
| `schemaVersion` | 是 | 当前固定为 `1` |
| `id` | 是 | 插件唯一标识。建议全小写、用 `-` 分隔，例如 `debug-tools` |
| `name` | 是 | 展示名称 |
| `version` | 是 | 插件版本。运行时会与导出对象中的 `meta.version` 做一致性校验 |
| `entry` | 是 | 入口文件，相对插件目录，例如 `dist/index.js` |
| `capabilities` | 是 | 当前至少应包含 `"tools"` |
| `tools` | 当声明 `tools` 时必需 | 声明此插件会提供哪些工具 |
| `description` | 否 | 插件描述 |
| `configSchema` | 否 | 插件配置的 JSON Schema，用于设置校验 |
| `engines.agentWorkbench` | 否 | 预留给兼容性声明使用 |

### 当前校验要点

宿主当前会对 manifest 做强治理校验，至少包括：

- `schemaVersion === 1`
- `id / name / version / entry / capabilities` 合法
- 若声明了 `tools`，则 `tools[]` 不为空
- `tools[].name` 不重复
- `entry` 真实路径不能跳出插件根目录
- `entry` 只允许 `.js` / `.mjs` / `.cjs`
- `configSchema` 必须是可编译的 JSON Schema

---

## JS 插件入口最小示例

下面是一个与当前系统契约一致的最小入口示例：

```js
function definePlugin(definition) {
  return definition;
}

const echoInspectTool = {
  name: "echo_inspect",
  description: "Echo input for debugging and plugin validation",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      message: { type: "string" },
      tags: {
        type: "array",
        items: { type: "string" }
      },
      includeRaw: { type: "boolean" },
      mode: {
        type: "string",
        enum: ["ok", "throw", "long_text"]
      }
    }
  },
  async execute(args) {
    const input = args && typeof args === "object" ? args : {};
    const message = typeof input.message === "string" ? input.message : "";
    const tags = Array.isArray(input.tags) ? input.tags.filter((item) => typeof item === "string") : [];
    const includeRaw = input.includeRaw === true;
    const mode = typeof input.mode === "string" ? input.mode : "ok";

    if (mode === "throw") {
      throw new Error("debug-tools: throw branch triggered");
    }

    if (mode === "long_text") {
      return {
        text: `long text output\n\n${"debug-line\n".repeat(2000)}`
      };
    }

    const text = [
      "Echo inspect result:",
      `- message: ${message || "<empty>"}`,
      `- tags: ${tags.length}`,
      `- includeRaw: ${includeRaw ? "true" : "false"}`,
      `- mode: ${mode}`
    ].join("\n");

    return {
      text,
      raw: includeRaw
        ? {
            receivedArgs: {
              message,
              tags,
              includeRaw,
              mode
            },
            meta: {
              tagCount: tags.length,
              generatedBy: "debug-tools"
            }
          }
        : undefined
    };
  }
};

export default definePlugin({
  meta: {
    id: "debug-tools",
    name: "Debug Tools",
    version: "0.1.0",
    description: "Debug plugin examples for agent-workbench"
  },
  capabilities: {
    tools: [echoInspectTool]
  }
});
```

---

## 工具定义约定

每个工具至少需要以下字段：

| 字段 | 必需 | 说明 |
|---|---|---|
| `name` | 是 | 工具短名，例如 `echo_inspect` |
| `description` | 是 | 给模型看的工具说明 |
| `inputSchema` | 是 | JSON Schema，用于参数约束 |
| `execute` | 是 | 工具执行函数 |
| `outputMode` | 否 | 可选声明输出模式，如 `text` / `text+raw` |
| `riskLevel` | 否 | 可选风险等级 |

### `name`

- 这是插件内部工具名，不需要自己写 canonical name
- 推荐使用小写字母 + 下划线风格，例如：

```text
echo_inspect
search_issues
get_issue
```

### `description`

- 要写给模型看，尽量清晰、直接
- 说明输入是什么、返回什么、适合什么场景

### `inputSchema`

- 当前使用 JSON Schema
- 建议尽量写明确：
  - `type`
  - `properties`
  - `required`
  - `additionalProperties`

例如：

```js
inputSchema: {
  type: "object",
  additionalProperties: false,
  properties: {
    keyword: { type: "string" },
    limit: { type: "integer", minimum: 1, maximum: 20 }
  },
  required: ["keyword"]
}
```

### `execute(args, ctx)`

- `args` 是模型传入的参数对象
- `ctx` 是宿主提供的执行上下文
- 当前版本建议把 `ctx` 当作只读执行上下文使用
- 插件不要假定可以访问宿主的所有内部能力

建议写法：

- 先校验/清洗输入
- 再执行业务逻辑
- 最后返回 `{ text, raw? }`

---

## 输出契约

这是当前插件系统最重要的约束之一。

### 规则

- `text`：**必填**
- `raw`：**可选**
- `raw` 若存在，必须是 **JSON-serializable**
- prompt **只消费 `text`**
- `raw` 默认不进入 prompt，也默认不作为主展示内容

### 正确示例

```js
return {
  text: "Found 3 issues: ABC-1, ABC-2, ABC-3",
  raw: {
    count: 3,
    issues: ["ABC-1", "ABC-2", "ABC-3"]
  }
};
```

### 仅文本也完全合法

```js
return {
  text: "Current server time: 2026-03-10T12:00:00Z"
};
```

### 错误示例：缺少 `text`

```js
return {
  raw: { ok: true }
};
```

这会在 worker 侧被视为不符合契约。

### 错误示例：`raw` 不可序列化

```js
return {
  text: "bad raw",
  raw: {
    now: new Date(),
    fn: () => {}
  }
};
```

`raw` 应当只包含 JSON 可序列化内容，例如：

- `null`
- `boolean`
- `number`
- `string`
- 数组
- 纯对象

---

## canonical tool name 如何生成

插件作者只需要声明：

- `pluginId`
- `toolName`

宿主会把插件工具的 canonical name 组织为：

```text
plugin_<pluginId>_<toolName>
```

例如：

- 插件 `debug-tools`
- 工具 `echo_inspect`

最终 canonical name 为：

```text
plugin_debug-tools_echo_inspect
```

这个名字会用于：

- agent 的 `pluginTools` 选择
- 运行时工具识别
- 日志、诊断与治理展示

---

## `configSchema` 的作用与示例

如果你的插件需要配置，例如：

- API base URL
- Token
- 默认项目
- 模式开关

可以在 manifest 中声明 `configSchema`。

例如：

```json
{
  "schemaVersion": 1,
  "id": "acme-jira",
  "name": "Acme Jira Tools",
  "version": "0.1.0",
  "entry": "dist/index.js",
  "capabilities": ["tools"],
  "tools": [
    {
      "name": "search_issues",
      "description": "Search Jira issues",
      "outputMode": "text+raw"
    }
  ],
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "baseUrl": { "type": "string", "minLength": 1 },
      "token": { "type": "string", "minLength": 1 },
      "defaultProject": { "type": "string" }
    },
    "required": ["baseUrl", "token"]
  }
}
```

### 它的作用

宿主会用它做插件配置治理：

- 更新插件 settings 时校验 `config`
- 生成 runtime snapshot 时再次校验 `config`
- 如果配置不符合 schema，插件可能进入：

```text
config_invalid
```

### 开发建议

- 尽量使用 `additionalProperties: false`
- 对必要字段使用 `required`
- 对字符串、数字、数组加上最小必要约束

---

## 如何在系统中启用插件

当前完整链路大致如下。

### 1. 放置插件目录
把插件包放到：

```text
<dataDir>/plugins/<pluginId>/
```

例如：

```text
.data/plugins/debug-tools/
```

### 2. 确保 manifest 与入口文件合法
至少保证：

- 有 `agent-workbench.plugin.json`
- `entry` 文件存在
- 入口文件是 `.js/.mjs/.cjs`

### 3. 在设置页启用插件
当前最小管理面已经支持：

- 查看插件列表
- 查看插件状态与诊断信息
- 全局 enable / disable 插件

### 4. 为 agent 选择 `pluginTools`
在 agent 配置中，给目标 agent 选择需要使用的插件工具。

例如选择：

```text
plugin_debug-tools_echo_inspect
```

### 5. 运行 agent
满足以下条件后，worker 才会真正加载并暴露插件工具：

1. 插件被扫描发现
2. manifest 校验通过
3. 插件全局启用
4. 插件配置校验通过（如果声明了 `configSchema`）
5. 当前 agent 的 `pluginTools` 中包含该工具

---

## 常见状态与 diagnostics

当前系统会给插件产出状态和诊断信息。常见状态包括：

| 状态 | 含义 |
|---|---|
| `discovered` | 已发现插件目录 |
| `disabled` | 插件已发现，但全局未启用 |
| `invalid_manifest` | manifest 非法，或入口/路径校验失败 |
| `incompatible` | 与当前宿主兼容性不满足 |
| `config_invalid` | 配置不符合 `configSchema` |
| `ready` | 通过治理校验，可供 worker 进一步加载 |
| `load_failed` | 预留给运行时加载失败场景 |
| `manifest_mismatch` | 预留给运行时导出与 manifest 不一致场景 |

### 常见 diagnostics 示例

| 诊断码 | 含义 |
|---|---|
| `plugin_discovered` | 已发现插件 |
| `plugin_disabled` | 插件当前未启用 |
| `manifest_invalid` | manifest 内容非法 |
| `entry_not_found` | 入口文件不存在 |
| `entry_out_of_root` | 入口真实路径跳出了插件根目录 |
| `entry_extension_unsupported` | 入口文件后缀不支持 |
| `plugin_incompatible` | 宿主兼容性不满足 |
| `config_invalid` | 插件配置不符合 schema |
| `unsupported_capability` | 声明了当前版本不支持的 capability |

---

## 排障建议

### 问题 1：插件没有出现在列表里
先检查：

- 插件是否放在 `<dataDir>/plugins/<pluginId>/`
- 是否存在 `agent-workbench.plugin.json`
- manifest 是否是合法 JSON

### 问题 2：插件状态是 `invalid_manifest`
优先检查：

- `schemaVersion` 是否为 `1`
- `entry` 是否存在
- `entry` 是否是 `.js/.mjs/.cjs`
- `entry` 真实路径是否跳出插件目录
- `tools[].name` 是否重复

### 问题 3：插件状态是 `config_invalid`
优先检查：

- settings 中保存的 `config` 是否满足 manifest 里的 `configSchema`
- 是否遗漏了 `required` 字段
- 是否多传了 `additionalProperties: false` 不允许的字段

### 问题 4：插件启用了，但 agent 看不到工具
优先检查：

- 插件是否处于 `ready`
- 插件是否全局 enabled
- 当前 agent 是否勾选了对应 `pluginTools`
- canonical name 是否正确，例如：

```text
plugin_debug-tools_echo_inspect
```

### 问题 5：工具执行时报错
优先检查：

- `execute()` 是否总能返回 `{ text, raw? }`
- `text` 是否始终为字符串
- `raw` 是否可 JSON 序列化
- 是否在 `mode === "throw"` 这类测试分支里主动抛错

---

## 当前不支持的能力

为了避免误用，请特别注意当前版本 **不支持**：

### 1. artifact
插件当前不要依赖 artifact 协议。

如果你需要输出很大的内容：
- 可以先通过 `text` 返回摘要
- 宿主当前不会为插件工具提供专门的 artifact 协议

### 2. hooks
虽然设计上为未来预留了 hooks，但当前版本不会执行插件 hooks。

### 3. services
当前版本不会启动插件后台服务，也不会为插件管理常驻进程/连接。

### 4. channels / IM capability
当前版本的插件系统只支持工具插件。IM 对接未来应走 channel capability，而不是把 IM 逻辑塞进工具插件。

### 5. 生产环境直接运行 TypeScript 入口
当前正式支持：

- `.js`
- `.mjs`
- `.cjs`

不要假设生产环境会直接运行：

- `.ts`

正确做法是先构建为 JS 再放入插件目录。

---

## 参考样例：`debug-tools / echo_inspect`

当前仓库里已经有一个最小样例插件，可作为开发参考：

```text
test/fixtures/plugins/debug-tools/
```

它展示了当前 v1 插件系统最典型的一条路径：

- 合法 manifest
- JS 入口文件
- 一个最小工具 `echo_inspect`
- `text` 必填
- `raw` 可选
- 正常分支 / 抛错分支 / 长文本分支

如果你要开发自己的第一个插件，最推荐的方式是：

1. 先复制 `debug-tools` 结构
2. 改 `pluginId`
3. 改 manifest
4. 改工具实现
5. 放到 `<dataDir>/plugins/<pluginId>/`
6. 在设置页启用插件并为 agent 选择对应 `pluginTools`

---

## 快速上手：从 `debug-tools` 复制出你的第一个插件

如果你已经看懂上面的规范，最省事的方式不是从空目录开始写，而是直接从仓库里的样例复制一份。

### 第 1 步：复制样例目录

从仓库中的样例：

```text
test/fixtures/plugins/debug-tools/
```

复制到你的运行目录插件根，例如：

```text
<dataDir>/plugins/my-first-plugin/
```

复制完成后，目录大致会变成：

```text
<dataDir>/plugins/my-first-plugin/
  package.json
  agent-workbench.plugin.json
  dist/index.js
```

### 第 2 步：修改 manifest

打开：

```text
<dataDir>/plugins/my-first-plugin/agent-workbench.plugin.json
```

至少修改这些字段：

```json
{
  "schemaVersion": 1,
  "id": "my-first-plugin",
  "name": "My First Plugin",
  "version": "0.1.0",
  "entry": "dist/index.js",
  "capabilities": ["tools"],
  "tools": [
    {
      "name": "say_hello",
      "description": "Return a greeting for the given name",
      "outputMode": "text"
    }
  ]
}
```

重点注意：

- `id` 要改成新的插件 ID
- `tools[].name` 要和你真正导出的工具一致
- `entry` 先保持 `dist/index.js` 不动最稳

### 第 3 步：修改 JS 入口

打开：

```text
<dataDir>/plugins/my-first-plugin/dist/index.js
```

把样例里的 `echo_inspect` 改成你自己的工具，例如：

```js
function definePlugin(definition) {
  return definition;
}

const sayHelloTool = {
  name: "say_hello",
  description: "Return a greeting for the given name",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string" }
    },
    required: ["name"]
  },
  async execute(args) {
    const name =
      args && typeof args === "object" && typeof args.name === "string"
        ? args.name.trim()
        : "";

    return {
      text: name ? `Hello, ${name}!` : "Hello!"
    };
  }
};

export default definePlugin({
  meta: {
    id: "my-first-plugin",
    name: "My First Plugin",
    version: "0.1.0"
  },
  capabilities: {
    tools: [sayHelloTool]
  }
});
```

这里要保证：

- `meta.id` 和 manifest 的 `id` 一致
- `meta.version` 和 manifest 的 `version` 一致
- 导出的工具名 `say_hello` 和 manifest `tools[].name` 一致
- 返回值里一定有 `text`

### 第 4 步：启动系统并检查插件状态

启动 agent-workbench 后，到设置页查看插件列表。

你应该能看到：

- 插件 `my-first-plugin` 被发现
- 状态为 `disabled` 或 `ready`
- 工具列表中包含 `say_hello`

如果看不到，优先检查：

- 目录是否真的在 `<dataDir>/plugins/` 下
- manifest 文件名是否正确
- JS 入口文件是否存在

### 第 5 步：全局启用插件

在插件设置页：

- 找到 `my-first-plugin`
- 打开 enable 开关
- 确认状态为 `ready`

### 第 6 步：给 agent 勾选插件工具

到 agent profile 设置中，选择：

```text
plugin_my-first-plugin_say_hello
```

这个 canonical name 是宿主自动生成的，不需要你自己手写到代码里，但你需要知道它的格式，方便检查是否选对。

### 第 7 步：做一次最小调用验证

让 agent 触发你的工具时，至少确认：

- 工具能被模型看到
- 工具执行不会报错
- 返回文本能出现在 tool output 中

如果你想更快验证，也可以先把工具写得非常简单，例如固定返回：

```js
return {
  text: "plugin is working"
};
```

等链路跑通后，再逐步加真实逻辑。

### 第 8 步：再逐步增加复杂度

建议顺序是：

1. 先只返回 `text`
2. 再增加参数校验
3. 再按需要增加 `raw`
4. 最后再接外部 API 或更复杂逻辑

这样最容易定位问题，也最不容易把“插件系统问题”和“业务逻辑问题”混在一起。

---

## 开发建议

### 建议 1：先做一个极小插件
不要一上来就做复杂网络调用或多工具插件。优先先写一个：

- 单工具
- 无外部依赖
- 纯文本输出为主

### 建议 2：先保证 `text` 质量
模型真正消费的是 `text`，所以比起复杂 `raw`，更应该先把 `text` 写得：

- 稳定
- 简洁
- 可读
- 对模型有帮助

### 建议 3：只在必要时提供 `raw`
如果你暂时没有：

- UI 富展示需求
- 结构化排障需求
- 后续程序消费需求

那么只返回 `text` 就足够。

### 建议 4：尽量保持 manifest 与 runtime 完全一致
例如：

- manifest 里声明了 `echo_inspect`
- runtime 也只导出 `echo_inspect`

这样最不容易踩到一致性校验问题。

---

## 最小自检清单

在把插件交给其他人使用前，建议至少检查：

- 插件目录位置正确
- manifest 合法
- 入口文件存在且为 JS
- 宿主能发现插件
- 全局启用插件后状态为 `ready`
- agent 能选到对应 `pluginTools`
- 工具执行时能返回 `text`
- 若返回 `raw`，其内容可 JSON 序列化
- `throw` 分支能正确变成失败结果
- 长文本分支不会破坏主链路

---

## 总结

当前 agent-workbench 的本地工具插件系统已经支持一个清晰、可治理的 v1 开发模型：

- 目录型本地插件包
- manifest 强校验
- worker 运行时加载 JS 入口
- 统一工具注册与执行
- `text` 必填、`raw` 可选 的输出契约
- 设置页启用插件并给 agent 选择 `pluginTools`

如果你想开发第一个插件，最简单的起点就是参考：

```text
test/fixtures/plugins/debug-tools/
```

然后实现你自己的：

- `agent-workbench.plugin.json`
- `dist/index.js`
- `capabilities.tools`
- `execute() => { text, raw? }`
