# Assistant Markdown Render v1(基础+表格+Mermaid,无图片)

## 背景

- 目前 Web UI 的对话区对 `assistant_text` 采用纯文本渲染(保留换行,不做格式解析),典型入口在 `agent-workbench/apps/web/src/features/workspace/tools/agent/AgentClientPane.vue:124` 附近.
- 随着模型输出越来越偏“文档化”(标题,列表,代码块,表格),纯文本可读性不足,尤其是长回答和结构化结果.
- 需求希望把 assistant 的消息改为 Markdown 可视化组件展示,并支持:
  - 基础 Markdown
  - 表格(GFM tables)
  - Mermaid 图
  - 链接可点击
  - 不需要图片(明确禁用)
- 另外,assistant 输出是流式写入(通过轮询刷新 UI),希望实时渲染,但可以接受降低频率(例如调慢轮询或做渲染节流).

## 目标

- 仅对 assistant 的文本消息做 Markdown 渲染,其他消息类型保持现状:
  - `assistant` + `assistant_text`: Markdown 渲染
  - `user` + `user_text`: 继续按纯文本渲染(后续如需支持可再扩展)
  - `tool/system`: 继续按现有展示(工具卡片/等宽纯文本)
- 支持基础 Markdown 与表格,保证常见模型输出格式可读:
  - 标题,列表,引用,粗斜体,行内代码,代码块
  - 表格 `| a | b |`
  - 普通链接 `[text](https://...)` 可点击,并做安全属性约束
- Mermaid 仅用于展示:
  - 支持 fenced code block: <code>```mermaid</code>
  - 禁用 Mermaid 内部链接/点击能力(不产生可点击元素)
- 安全优先:
  - 禁止图片渲染(`![]()` 和 `<img>` 均不展示)
  - 防 XSS(assistant 内容视为不可信输入)
- 体验与性能:
  - 流式阶段实时更新,但解析与 Mermaid 渲染做节流/降频
  - 与虚拟列表(`@tanstack/vue-virtual`)兼容,滚动时不产生明显卡顿

## 非目标

- 不支持 Markdown 原生 HTML(例如 `<div>...</div>`),也不支持内联脚本/样式.
- 不支持图片,视频,iframe,表单等任何富媒体交互.
- 不实现 Mermaid 的交互特性(链接,click handler,回调).
- 不对后端存储与 API 做结构性改造(仍然存纯文本,前端决定如何渲染).

## 现状与约束

- 对话区使用虚拟列表渲染,消息 item 会 mount/unmount,渲染逻辑必须可缓存且幂等.
- Tailwind preflight 关闭(`agent-workbench/apps/web/tailwind.config.cjs:7`),HTML 标签默认样式较弱,需要为 Markdown 容器补充样式.
- 当前刷新节奏由轮询驱动,相关逻辑在 `agent-workbench/apps/web/src/features/workspace/tools/agent/AgentClientPane.vue:937` 到 `agent-workbench/apps/web/src/features/workspace/tools/agent/AgentClientPane.vue:1152`.

## 方案总览

### 核心思路

- 引入一个专用的 Markdown 展示组件,仅用于 assistant 文本消息,在 `AgentClientPane` 的 assistant 分支替换纯文本输出.
- Markdown 渲染采取两阶段:
  - Markdown -> HTML(解析)
  - HTML -> safe HTML(DOMPurify 净化)
- Mermaid 渲染采取后处理:
  - 在 safe HTML 渲染到 DOM 后,扫描 `mermaid` 代码块并替换为 SVG
  - 对生成的 SVG 再做一次净化,并显式移除 `<a>` 与 `href` 属性,达到“仅展示,不可点击”

### 技术选型(建议)

- Markdown parser: `markdown-it`
  - 理由: 可设置 `html: false` 从源头禁用原生 HTML,表格支持成熟,生态插件可选.
- HTML sanitizer: `dompurify`
  - 理由: 浏览器端成熟方案,可细粒度控制允许标签/属性/协议.
- Mermaid: `mermaid`
  - 采用动态 import,避免首屏把 Mermaid 体积带进来.

## 详细需求与业务逻辑

### 哪些消息走 Markdown

- 仅 `DisplayItem.role === 'assistant'` 且文本输出类型为 `assistant_text` 的消息.
- 其他内容保持原样,避免把工具日志/系统提示/错误堆栈误解析成 Markdown.

### 链接行为

- 普通 Markdown 链接可点击.
- 所有外链默认:
  - `target="_blank"`
  - `rel="noopener noreferrer"`
- 禁止 `javascript:` 等危险协议.

### 图片行为

- 图片一律不展示:
  - Markdown image 语法 `![]()` 不渲染
  - HTML `<img>` 被 sanitizer 禁止

### Mermaid 行为

- 仅当出现 fenced code block ` ```mermaid ` 时,才尝试渲染.
- 流式过程中 fence 可能未闭合,此时保持代码块原样,不报错.
- Mermaid 内部链接禁用:
  - 初始化配置上使用安全等级 `strict`
  - 渲染结果后处理: 移除 `<a>` 节点,移除任何 `href/xlink:href` 属性

## 流式实时渲染策略

### 目标

- 用户看到 assistant 输出在持续增长时,Markdown 视图能实时更新.
- 避免每个 token/chunk 都触发一次完整 parse + Mermaid render.

### 策略

- 在 Markdown 组件内部做节流:
  - Markdown parse: 以 250ms 到 400ms 为一个窗口做 debounce
  - Mermaid render: 以 600ms 到 1200ms 为一个窗口做 debounce,且仅在检测到 ` ```mermaid ` 且 fence 已闭合时触发
- 在轮询层面做适度降频(可选):
  - `AgentClientPane` 在 runState 非 idle 时目前约 600ms 拉取一次,可调整到 800ms 到 1000ms
  - 主要收益是降低网络与 UI 状态更新频率,但核心性能收益来自组件内部节流

### 缓存

- 解析缓存(建议):
  - key: `messageId + updatedAt` 或 `hash(text)`
  - value: `safeHtml`
  - 目的: 虚拟列表滚动导致组件重建时,避免重复 parse
- Mermaid 缓存(建议):
  - key: `hash(mermaidCode)`
  - value: `safeSvg`
  - 目的: 同一段 mermaid 在流式增量中被反复渲染时减少开销

## 安全设计

### 威胁模型

- assistant 输出内容不可视为可信.
- 攻击面主要来自:
  - Markdown 转 HTML 后的 `v-html` 注入
  - 链接协议与属性
  - Mermaid 输出 SVG 内可能包含危险节点/属性

### Markdown 层安全

- parser 配置:
  - 禁用原生 HTML(`html: false`)
  - 不开启危险扩展(如允许 raw HTML 的插件)

### HTML 净化策略

- DOMPurify 基本策略:
  - 显式 `FORBID_TAGS` 包含: `img`, `script`, `style`, `iframe`, `object`, `embed`, `form`, `input`, `button`
  - 允许表格相关标签: `table`, `thead`, `tbody`, `tr`, `td`, `th`
  - 允许代码块相关标签: `pre`, `code`
  - 允许链接标签 `a`,但限制协议,并在 hook 中统一补齐 `target/rel`
- 协议限制:
  - 只允许 `http:`, `https:`, `mailto:`(如有需要可扩展)
  - 拒绝 `javascript:`, `data:` 等

### Mermaid 安全

- Mermaid 初始化:
  - `securityLevel: 'strict'`
  - 禁止自动 startOnLoad
  - 关闭或限制 HTML label(如 `htmlLabels: false`),降低 SVG 注入概率
- SVG 后处理:
  - 生成 SVG 后再走一次 DOMPurify(按 SVG 允许列表)
  - 移除 `<a>` 元素
  - 移除 `href`, `xlink:href` 属性
  - 移除所有事件属性(形如 `onload`)

## UI 与样式

### 组件边界

- 新增组件(建议位置):
  - `agent-workbench/apps/web/src/shared/components/AssistantMarkdownMessage.vue`
  - 或 `agent-workbench/apps/web/src/features/workspace/tools/agent/components/AssistantMarkdownMessage.vue`
- `AgentClientPane` 中:
  - assistant 文本分支由 `{{ row.msg.text }}` 替换为 `<AssistantMarkdownMessage :text="row.msg.text" :message-id="row.msg.id" :updated-at="..." />`

### 样式策略

- 为 Markdown 容器加独立 class,避免影响全局与 ant-design-vue:
  - 列表与段落间距
  - 代码块背景,圆角,横向滚动
  - 表格 `overflow-x: auto`,边框,行高
- 由于 preflight 关闭,需要明确写 `h1/h2/ul/ol/blockquote/table` 等样式,否则视觉效果过于“素”.

## 关键决策与取舍

### 选择 `markdown-it` 而不是继续纯文本

- 得到:
  - 更强的结构表达能力,尤其是表格与代码块
  - 更接近用户对“AI 输出可读性”的预期
- 付出:
  - 引入 `v-html` 与 sanitize 复杂度
  - 需要为 HTML 标签补齐样式

### Mermaid 采用“后处理渲染”

- 得到:
  - 不影响普通 Markdown 渲染
  - 可控制渲染触发时机(流式节流)
- 付出:
  - 需要 DOM 扫描与替换,实现稍复杂

### 禁用图片

- 得到:
  - 降低 XSS 与隐私追踪面(外链请求)
  - 减少样式与布局复杂度
- 付出:
  - 某些模型输出的图片链接无法直接展示

### 流式实时渲染采用“渲染节流 + 可选调慢轮询”

- 得到:
  - 保持实时感
  - 控制 CPU 峰值,避免每次 poll 都触发 Mermaid 重渲染
- 付出:
  - UI 更新会有可感知的 0.25s 到 1s 延迟(在可接受范围内)

## 验证与测试清单

### 功能用例

- 标题/列表/引用/代码块渲染正确
- 表格渲染正确且不撑破消息宽度(横向滚动)
- Mermaid 渲染:
  - 正常图可以显示
  - fence 未闭合时不报错,后续闭合后能渲染

### 安全用例

- Markdown 注入:
  - `<script>alert(1)</script>` 不执行,不展示或被剥离
  - `<img src=x onerror=alert(1)>` 不展示
- 链接协议:
  - `[x](javascript:alert(1))` 被剥离或转为不可点击
  - `https://example.com` 可点击,并带 `rel` 与 `target`
- Mermaid 链接:
  - Mermaid 语法包含 link/click 时,最终 SVG 中不应出现 `<a>` 或可点击区域

### 性能与体验用例

- 长会话滚动时不卡顿(虚拟列表反复 mount)
- 流式输出时 UI 更新平滑,无明显卡顿与闪烁
- Mermaid 较大图在流式更新时不会频繁重渲染(节流生效)

## 迁移与兼容

- 无需数据迁移.
- 旧消息会以 Markdown 方式重新展示(仅 assistant),可能出现轻微“格式化”变化:
  - 例如 `_` 触发斜体,`#` 触发标题
  - 这是预期行为,如需更强兼容可后续增加“只在检测到 fenced code/table 等特征时启用 Markdown”的开关.

## 后续可扩展点

- 增加“渲染模式”设置:
  - 纯文本
  - Markdown(默认)
- 对 user 消息启用 Markdown(可选)
- 增加代码块复制按钮,或为代码块做更好的样式/语言标识
