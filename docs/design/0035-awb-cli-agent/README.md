# AWB CLI 的 AI Agent 调用能力

## 文档定位

- 本目录是开发前的需求、CLI 契约、技术设计、代码审查与验收基线，不代表功能已经实现或测试通过。
- 调研基线：2026-10-29 的当前源码工作树；本轮只读核验接口和实现，没有调用真实 Agent、进行越界验证或修改产品代码。源码链接行号是定位提示，实施时必须重新核对，不能当作永久稳定契约。
- 产品开发范围限定为 `packages/cli` 及其测试、使用说明；复用现有公开 API。没有必须新增或修改的 API、数据库表、共享契约或 Worker 协议。
- 本目录的规范覆盖旧 CLI 设计中本次明确变更的部分；登录、Cookie 安全、单文件发布等未变内容继续保持。[原 CLI 方案](../0031-AWB-CLI与Session查询方案/00-文档导航.md)用于理解现状，不用其早期全类型查询或无 JSON 结论覆盖本方案。
- 状态：独立文档复审通过，可作为开发、代码审查及测试验收基线。H1、M1、L1均已关闭，`--kind`兼容裁决一致；仅代表文档与静态源码核验通过，不代表功能已实现或产品测试通过。见[独立文档审查记录](06-decisions-and-references.md#独立文档审查记录)。

- 实施状态：四阶段代码已接通，实际测试及未验项目见[实施记录](07-implementation-and-validation.md)。阶段四已由原审查者复审通过，阶段四M1/D1关闭；原全面审查者最终复审通过，全面审查H1/M1/M2/M3/L1与L2全部Resolved，无新增问题，可交付。作者最终CLI163/163、API9/9及全仓typecheck通过；本轮独立定向19/19与前轮历史独立193/193分开记录，不累加为最终套件数；构建/help/100验收ID及未验环境、既有风险详见实施记录，不以原文档审查替代产品验收。

## 阅读导航

| 文件 | 唯一权威内容 | 主要读者 |
|---|---|---|
| [需求与业务边界](01-requirements.md) | 目标、需求标识、主/子会话边界、最终用户共识 | 产品、开发、审查 |
| [CLI 契约](02-cli-contract.md) | 命令、参数、消息计数、帮助、JSON/JSONL、退出码 | CLI 开发、调用模型、测试 |
| [技术设计](03-technical-design.md) | API 复用、流程、内存实体、分页跟随、网络与下载发布算法 | 开发、技术审查 |
| [验收标准](04-acceptance.md) | 可执行场景、失败注入、审查门禁、证据要求 | 测试、审查、验收 |
| [实施计划](05-implementation-plan.md) | 按依赖拆分的开发任务、文件触点、实施与验证步骤 | 实施人员 |
| [实施与验收记录](07-implementation-and-validation.md) | 实际实现、逐项测试证据、未验环境及代码审查状态 | 开发、审查、验收 |
| [决策与源码依据](06-decisions-and-references.md) | 决策原因、已定兼容处理、既有风险、真实源码引用 | 产品、开发、审查 |

## 范围速览

```text
awb login
awb workspace list
awb agent list
awb session list
awb session show
awb session send
awb session messages
awb session status
awb session cancel
awb session compact
awb file download
```

- 会话列表只查询最近时间窗口内的主会话；详情、消息、状态可以读取已知子会话。
- 发送时省略会话则创建主会话；创建失败立即失败，不重试，不继续发送，接受可能遗留空会话。
- 发送、取消、手动压缩仅面向主会话；取消级联当前执行树活动后代，不回滚文件。
- `-f` 固定一次执行，执行终结并读完最终消息后退出，不等待下一次执行；中断 CLI 不取消后台。
- 用户没有独立 Run 查询命令；CLI 内部仍用 Run 标识跟随正确对象。Session 状态只展示 `idle/running`，不承诺最近结果。
- 下载复用既有文件流/目录 ZIP，CLI 做输入过滤和本地无覆盖发布，不改原下载 API，也不能声称客户端过滤修复了服务端软链边界风险。

## 规范约定

- “必须/不得”是验收要求；“现有”是静态源码核验结果；“本次新增”是待实现的 CLI 行为；“不做”表示范围排除。
- 稳定语义标识（如 `R-SEND`、`A-FOLLOW-FAST`、`D-NO-RETRY`）用于交叉追踪，不依赖章节序号。文中列表不用有序编号。
- 不同文件不重复定义参数和退出码；技术算法引用 CLI 契约，验收引用需求标识。
- 不能以修改 API、隐式重试、自动切换 Agent、丢弃分页或截断正文的方式掩盖 CLI 实现困难；若实测证明接口组合不足，应停在具体阻碍并回报，不擅自扩大范围。

## 需求追踪入口

| 需求 | 契约入口 | 技术入口 | 验收组 |
|---|---|---|---|
| `R-DISCOVER` | 发现命令 | API 清单、默认 Agent | `A-DISCOVER-*` |
| `R-SESSIONS` | 会话列表/详情 | 主会话查询 | `A-SESSIONS-*` |
| `R-SEND`、`R-CREATE-FAILURE` | 发送命令、失败模型 | 输入预检、创建与发送 | `A-SEND-*`、`A-UNKNOWN-*` |
| `R-MESSAGES` | 消息选择和消息 DTO | 当前分支分页 | `A-MESSAGES-*` |
| `R-FOLLOW` | 跟随契约、JSONL | 固定 Run、revision/reset、终态排干 | `A-FOLLOW-*` |
| `R-STATUS`、`R-CANCEL` | 状态/取消 | 状态投影、取消预查 | `A-CONTROL-*` |
| `R-COMPACT` | 压缩命令 | 手动压缩与跳过结果 | `A-COMPACT-*` |
| `R-DOWNLOAD` | 下载命令 | 文件流、无覆盖发布 | `A-DOWNLOAD-*` |
| `R-HELP`、`R-MACHINE`、`R-SECURITY` | 通用选项、输出、错误 | HTTP、Cookie、信号和输出层 | `A-HELP-*`、`A-OUTPUT-*`、`A-SECURITY-*` |

## 已定兼容规则与本轮修订追踪

- `session list` 新默认 primary，`--kind primary` 保留为弃用兼容写法；`--kind subtask/all` 本地退出 2、不联网、明确提示迁移，不忽略参数、不增加 legacy 命令、不改 API。这是本期有意收缩 CLI 行为，见[CLI 兼容性裁决](06-decisions-and-references.md#cli兼容性裁决)。
- 其余实施规则在契约中给出单一规范，尤其 JSONL upsert、人类输出、消息计数和下载发布，不留给开发者各自选择。

| 审查项 | 修订落点 | 验收/任务追踪 |
|---|---|---|
| H1：初始化捕获 idle 的正常完成竞态 | K0仅取初始head本身的可信原生来源，不越过nullable user找旧Run；有来源补齐同Run追加，无来源稳定历史可成功、无法证明的追加则失败 | `A-FOLLOW-IDLE-*`、`T-FOLLOW`；含R0+新user+R1完成失败及user-only/继承/空历史成功载荷，已关闭（Resolved） |
| M1：路径段 ID 的 URL 点段归一化 | 契约拒绝字面 `.`/`..`；技术统一一次编码及最终 URL 路径结构验证 | `A-PARSE-ID-*`、`T-HTTP` |
| L1：人类输出终端控制字符 | 契约元信息复用 escapeDisplayText；正文保留正常换行并转义控制字符，JSON语义原文不变 | `A-OUTPUT-TERMINAL-SAFE`、`T-BASE` |

## 交付通过标准

- 独立文档复审关闭全部阻断项，已裁决兼容规则及本轮修订在各文件一致。
- 开发实现的每项需求有可定位测试或真实验收证据；构建通过不能替代消息跟随、下载故障、未知执行结果等业务验证。
- 已知独立安全事项、环境未验项目必须保留，不冒称已修复、已利用实测或已通过。
