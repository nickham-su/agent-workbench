# Workspace 环境变量：设计与开发基准

## 文档状态

- 本目录是冻结需求、实施设计与验收基准。A、B、C1、C2、D、E 均已实施并通过阶段独立审查；最终全面审查已由 new 会话独立完成并通过，无高／中／低优先级需修复项。真实浏览器、Node20、其他平台及完整人工／部署仍待验收，不代表完整验收通过；实际审查范围见[实施与验证记录](08-implementation-and-verification.md#最终全面独立审查记录)。
- 适用范围：现有单 API 进程、自托管工作台；环境配置统一经 API 修改。直接修改数据库、多 API 进程共同写入不在缓存一致性承诺内。
- 产品规则已确认；按设计先实施，再完成用户手动终端验收。不以环境受限为理由降低文件安全、内部控制变量隔离、错误处理或清理标准。
- 本目录同时作为开发、代码审查和验收基准。实现与设计冲突时应先说明并修订设计，不能在实现中静默改变业务语义。
- 代码引用基于编写时实际源码快照；行号仅作定位辅助，路径及符号是长期依据。实际新增位置在[代码引用](07-code-references.md#实际新增位置)中登记。

## 阅读与职责分配

| 文档 | 权威内容 | 主要读者 |
|---|---|---|
| [需求、产品与决策](01-requirements-and-decisions.md) | 产品行为、作用域、优先级、输入语义、非目标及取舍 | 产品、开发、审查、验收 |
| [实体、API 与缓存](02-data-api-and-cache.md) | 配置表、契约、校验、错误、事务、并发与缓存 | 后端、前端、测试 |
| [bash 执行接入](03-bash-execution.md) | Worker 读取、环境合并、取消与原生 Git 边界 | Worker 开发、审查 |
| [终端启动与清理](04-terminal-launch-and-cleanup.md) | launcher、快照、握手、定位表、补偿与重启恢复 | 后端、运行时开发、审查 |
| [验收与代码审查](05-acceptance-and-review.md) | 自动测试、手动步骤、失败判定、发布门槛 | 测试、审查、用户 |
| [开发任务与实施步骤](06-implementation-plan.md) | 阶段依赖、改动接点、命令、审查和回滚 | 开发执行者 |
| [相关代码引用](07-code-references.md) | 当前事实、原型位置、实际文件及证据索引 | 全体 |
| [实施与验证记录](08-implementation-and-verification.md) | 实际阶段状态、命令、结果、设计差异及待验收项 | 开发、审查、用户 |

建议先阅读需求与决策，再按开发职责阅读 API、bash 或终端章节；编写代码前检查对应验收项，阶段结束后按实施计划完成审查与复审。

同一规则以其权威章节为准，其他章节使用需求 ID 或链接引用，不维护另一份黑名单、校验常量或启动协议。

## 冻结决策摘要

- Workspace 中增加“环境变量”工具，bash 与新建终端共享配置；所有值明文展示。
- 新增、编辑直接保存；启停立即保存；删除确认后保存。没有全局草稿、整页保存或放弃栏。
- 普通环境启动注入优先级为 Workspace 覆盖系统同名变量。模型临时覆盖写在 shell 命令中；不新增 bash `env` 参数，不解析命令。
- 名称区分大小写，代理大小写不自动同步；字符串原样传递，空值合法，停用或删除不等于 unset。
- value／remark只接受可无损UTF-8往返的合法Unicode；异常编码明确失败，不normalize或静默替换。
- `AWB_*` 和系统托管 Git 字段受保护；最终任务子进程排除继承的 `AWB_*`，API、Worker 全局环境不变。
- 不改变 `workdir`，包括既有 Workspace 外执行行为；配置身份仅来自 `run.workspaceId`。
- API 实例内缓存 Workspace 覆盖，写成功后同步失效；读取故障明确阻止本次执行。
- 终端采用固定 Node launcher 读取受保护的一次性配置；值不进入 argv，不写 tmux 全局环境。
- 终端创建、删除和恢复共用同WS admission，入gate重新读取状态；退休槽按稳定scope及durable身份恢复，不把业务名missing当全部完成。
- 终端真实交互和兼容性允许开发后由用户手动验收，但未通过前不能标记完整验收。
- 手动验收使用测试专用harness与PATH wrapper隔离API所有tmux操作及pty attach，不新增产品socket配置。

## 需求与验收导航矩阵

验收 ID 的动作、预期和失败判定以[验收文档](05-acceptance-and-review.md)为准；代码范围以[代码引用](07-code-references.md)为准。

| 需求 ID | 内容 | 权威设计 | 实现范围索引 | 自动验收 | 手动验收 |
|---|---|---|---|---|---|
| R-PRODUCT | 工具布局、明文值、按操作保存 | [产品方案](01-requirements-and-decisions.md#产品方案) | C-WEB | A-UI | M-UI |
| R-SCOPE | Workspace 身份、读快照时点、旧进程不更新 | [作用域与生效边界](01-requirements-and-decisions.md#作用域与生效边界) | C-WORKSPACE、C-BASH、C-TERMINAL | A-SCOPE、A-CACHE、A-BASH、A-TERM | M-ENV |
| R-VALUE | 名称、字面值、空串、停用、删除 | [变量语义](01-requirements-and-decisions.md#变量语义) | C-SHARED、C-API | A-VALIDATION、A-API | M-ENV |
| R-PRIORITY | 普通覆盖、代理独立键、Git 例外、无新工具参数 | [优先级与保护规则](01-requirements-and-decisions.md#优先级与保护规则) | C-BASH、C-TERMINAL | A-BASH、A-TERM、A-VALIDATION | M-ENV |
| R-FAIL | 故障明确失败、写结果不确定、不泄露值 | [错误协议](02-data-api-and-cache.md#错误协议) | C-API、C-BASH、C-TERMINAL、C-WEB | A-API、A-BASH、A-TERM、A-UI | M-FAIL |
| R-STORE | 加密、按条目事务、额度、级联删除 | [实体与约束](02-data-api-and-cache.md#实体与约束) | C-DB、C-CRYPTO | A-STORE、A-API | M-UI |
| R-CACHE | 应用内缓存、零查库命中、同步失效 | [缓存与生命周期](02-data-api-and-cache.md#缓存与生命周期) | C-CACHE、C-WORKSPACE | A-CACHE | M-ENV |
| R-CONTROL | 内部鉴权、AWB 隔离、无全局环境修改 | [优先级与保护规则](01-requirements-and-decisions.md#优先级与保护规则) | C-AUTH、C-BASH、C-TERMINAL | A-AUTH、A-BASH、A-TERM | M-SECURITY |
| R-LAUNCH | 固定入口、安全快照、握手、Node 20/22 | [启动协议](04-terminal-launch-and-cleanup.md#启动协议) | C-LAUNCHER、C-FS、C-BUILD | A-LAUNCH、A-TERM | M-TTY、M-SECURITY |
| R-CLEANUP | 共同admission、稳定scope精确清理、补偿与恢复 | [终端协议](04-terminal-launch-and-cleanup.md#终端副作用的共同串行边界) | C-TERMINAL、C-FS、C-WORKSPACE | A-CLEANUP、A-TERM、A-STORE | M-FAIL、M-SECURITY |
| R-VERIFY | 自动与手动分层、隔离harness、审查复审、可回滚 | [验收完成标准](05-acceptance-and-review.md#验收完成标准) | C-TEST、C-BUILD、C-HARNESS | 各 A-* 项 | 各 M-* 项 |

## 实施与验收状态记录约定

开发期间在变更说明中记录各阶段的实际状态，不用“设计已通过”替代“实现已验证”。至少区分：

- 未实现。
- 已实现，自动测试与类型检查通过，代码审查及问题复审通过。
- 手动运行时待验收：列出尚未执行的 M-* 项及环境原因。
- 完整验收通过：核心自动与手动项均有实际结果，无未关闭的安全、正确性或清理问题。

实际状态以[实施与验证记录](08-implementation-and-verification.md)为准：Node22/Linux 的 source/dist、真实 tmux/PTY、独立 Worker、四类恢复及完整自动回归已有结果；真实浏览器、Node20、其他平台和生产部署仍待验收。
