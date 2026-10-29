# 关键决策、取舍与源码依据

## 独立文档审查记录

- 首轮独立审查提出H1（idle初始化收尾）、M1（URL点段归一化）、L1（终端控制字符）问题，并要求统一`--kind`兼容裁决。
- 第一次复审（总第二轮）：M1、L1及`--kind`处理通过；H1来源识别仍未关闭，发现不能越过originRunId=null的新user向前认领旧Run。
- 修复nullable user来源识别后，原独立审查者第二次复审（总第三轮）通过；已核查全部7份文档及相关源码，H1、M1、L1全部Resolved，`--kind`裁决一致，无新增H/M/L问题及阻断项。以下结论依据用户转交的原审查者确认登记。

> 独立文档复审通过。已核查全部7份文档及相关源码，H1、M1、L1均已关闭，--kind兼容裁决保持一致，未发现新增阻断项。文档可作为开发、代码审查及测试验收基线。本结论仅代表文档与静态源码核验通过，不代表功能已实现或产品测试通过；下载独立安全风险及未验环境继续保留。

重点待实施验证均引用现有[验收矩阵](04-acceptance.md)，不新增或重写规范、算法及任务范围：

- 真实nullable来源及idle有界收尾；fast-run、reset、终态排干与下一Run隔离。
- 创建/发送结果未知及全部请求零自动重试。
- 图片输入与JSON/multipart大小限额。
- 控制字符显示、URL编码与各层help无副作用。
- 取消与压缩的既有边界、竞态及终态语义。
- 下载无覆盖发布、故障注入与信号处理；独立下载安全风险继续保留。
- Node22单文件产物及授权隔离工作区smoke；未验环境仍按现有矩阵登记，不视作文档通过即已验证。

## 决策记录

| 标识 | 固定结论 | 原因与代价 |
|---|---|---|
| `D-THIN-CLIENT` | 只开发CLI，复用现有公开API | 用户明确不为CLI改变既有后端功能；不新增数据库/事件服务/共享契约 |
| `D-PRIMARY-WINDOW` | 列表只查主会话，接受必填窗口且最大90d | 放弃全历史/子会话列表，消除枚举与权威父关系的新API需求 |
| `D-STATUS-SIMPLE` | 状态仅idle/running | 用户只需知道是否忙；不新增最近Run投影；idle不能证明上次成功 |
| `D-KIND-COMPAT` | 默认primary，兼容--kind primary，拒绝subtask/all | 首席助理已裁决有意收缩CLI；明确迁移，不忽略旧参数、不改API |
| `D-RUN-INTERNAL` | 不提供Run查询命令，内部仍固定runId | 防止-f串到下一次执行；弱化用户界面不等于删掉执行身份 |
| `D-NO-RETRY` | 创建及全部副作用不自动重试，读请求也零自动重试 | 将重试判断交调用模型；网络异常结果可未知；接受创建响应丢失遗留空会话 |
| `D-NO-CREATE-IDEMPOTENCY` | 不新增创建幂等/创建发送事务 | 用户已接受空会话与失败即返回；原“必须改创建API”结论不再适用 |
| `D-DEFAULT-AGENT` | 每次当前user列表首个，包括已有会话 | 简单一致；显式传入固定ID；首个坏配置不自动跳到第二个 |
| `D-SUBTASK-READONLY` | 详情/消息/状态可读已知子会话；发送/取消/压缩CLI限主 | 满足观察与调用边界；不修改原API对子会话取消的既有支持 |
| `D-FOLLOW-FINITE` | 当前执行结束、排干后退出 | 不做tail式永久监听；SIGINT/断线只停本地，不cancel |
| `D-MESSAGE-UPSERT` | JSONL消息按id+revision完整upsert；人类streaming只标识，终结正文一次 | 不承诺逐token；避免部分文本被重复拼接；完整消息规则在契约唯一维护 |
| `D-IDLE-FINALIZE` | 仅从初始head本身确定可信K0，不向前找旧Run；一次有界收尾，未知来源稳定可成功、出现无法证明的追加则失败 | user来源Run实际为null，不能跳过较新user认领旧Run；稳定user-only/继承/空历史可读，真实初始化竞态证据不足退出6；不等未来Run、不扩API |
| `D-ID-PATH` | 拒绝路径段字面点段、一次编码并验证最终URL结构 | encodeURIComponent本身不处理点段，不能只检查同源/API前缀 |
| `D-HUMAN-ESCAPE` | 元信息转义，正文保留换行并转义终端控制；JSON原文不变 | 防止终端执行用户控制序列，不截断业务正文 |
| `D-VISIBLE-MESSAGES` | 普通消息按text/image可见内容计数，不含tool-only/reasoning/compaction | -n1更接近最近可读回答，但仍不是成功结果API |
| `D-CURRENT-BRANCH` | 当前可见分支读取，可恢复reset补页；不可恢复改链显式失败 | 不新增不可变事件日志；不承诺回退后旧token/所有瞬时消息永久无损 |
| `D-CANCEL-CURRENT` | 取消服务端处理时的当前执行树 | 不新增expectedRunId；预查与提交存在竞态，帮助必须诚实说明 |
| `D-COMPACT-EXISTING` | 保留空会话400与Run终态skip语义 | 不把所有无需压缩结果即时化，不改变自动压缩/Worker流程 |
| `D-DOWNLOAD-COMPAT` | 复用文件流/ZIP，不为CLI收紧原API | 客户端做词法过滤与本地无覆盖；现有限额/风险明确说明，不声称修复服务端边界 |
| `D-LOCAL-NO-CLOBBER` | 同目录temp完整接收后原子无覆盖发布 | 预查后目标仍可能并发出现；rename会覆盖，不可作为无覆盖实现 |
| `D-HELP-OFFLINE` | 所有层级help本地无副作用 | 模型可渐进发现能力；帮助不能要求先有登录、文件或有效业务参数 |

## CLI兼容性裁决

### 现有事实

- 现有 `session list` 默认 `kind=all`，显式接受 `primary/subtask/all`；README也公开了子会话示例。
- 本次最终需求是只列主session，不能继续把原全部/子会话列表当新能力。
- 因此“完全兼容旧参数语义”与“列表只查主会话”不可同时满足；首席助理已裁决采用下述明确收缩，不能由实现者另选。

### 已裁决处理

- 新默认固定primary。
- 保留识别 `--kind primary`，作为已弃用兼容写法，具体命令帮助标注“仅支持primary，可省略”。
- 显式 `--kind subtask/all` 返回退出2和本地迁移说明，不联网、不忽略、不偷偷改成primary结果。
- 不新增legacy命令，不为维持旧子会话列表扩大本次产品范围；API继续支持其原类型过滤，不改变其他调用者。
- 更新CLI README、相关测试并说明这是明确收缩；不把改变原默认输出集合称为零行为变化。

当前状态：**首席助理已裁决并定稿**。本文件、契约、需求、验收与任务均采用同一处理，不保留多个可选实现。该项仅影响CLI兼容，不构成新增API需求。

## 实施细节的统一建议

以下是为消除开发/测试歧义而固定的首轮设计建议，不额外增加后端能力；独立审查如要求调整应同步契约和验收。

- `--json`在根/组/动作位置等价，重复拒绝；help仍是人类文本。
- 单请求默认30s，显式--timeout最大24h；follow可单独给整体时限，默认不限制整体，所有请求零自动重试。
- 提示词显式三选至多一、图片可重复；不隐式吞stdin。
- 普通消息过滤和人类/JSONL跟随策略见契约，不允许开发者任选流式打印方式。
- 下载必须明确本地输出文件，服务器文件名不控制本地路径；无覆盖能力不足的平台直接失败，不危险降级。
- 不暴露--request-id，不新增跨进程恢复存储；意外dedup无法证明原身份时诚实报响应不一致，不假造Agent。

## 独立安全事项

### 服务端下载边界

现有下载已具备词法路径检查、目标lstat、realpath包含检查及递归软链拒绝，但静态核验发现条件风险：

- 检查返回路径字符串后，文件流/ZIP再次按原路径打开；并发替换目标或祖先目录时，校验与打开并非同一固定句柄。
- repo根的词法映射与实际根信任之间存在额外边界：实际repo根应受Workspace实际根约束，而不能仅将首次解析的repo realpath当独立可信根。
- 是否触发受路径变更、缓存时机、进程权限影响；本轮没有运行利用验证，没有读取任何外部文件，不能宣称发生泄露。

本次处理：记录为独立安全事项，不改变下载API合法业务规则、不绕过已有检查、不让CLI过滤承担其做不到的服务端安全保证。以后若修复，应保持合法访问兼容，针对真实边界增加验证，而不是给CLI扩大配置/权限体系。

### 已知功能限制

- 目录下载源文件累计100MiB；`.git`或扫描遇软链整次失败；空目录未作为条目保留。
- 同一下载中源文件可能变化，不提供一致性快照；HTTP完整不等于源目录从未变化。
- 当前Timeline只读当前分支，无法恢复所有已移出链的历史消息；客户端不得静默掩盖改链失败。
- 主会话发送user、子任务初始user的originRunId均为null；Run内部用triggerMessageId关联输入，公开接口无从该输入反查Run的能力。K0只信任首snapshot的head本身原生来源；不能向前跳过未归属head取旧Run，也不按消息ID模式、内容或时间推断。未知来源但稳定终结历史可成功，新增记录与H0关系不能证明则-f观察失败，调用模型可重新读取。
- 终态Run接口不含actual agentId；messages跟随不得根据当前配置猜Agent。
- 创建响应丢失/发送响应丢失的结果不确定性是已接受取舍，不是通过固定错误文案就消除。

## 源码调研基线

- 下列为2026-10-29静态核验路径，均为项目内相对链接；行号用于定位，后续源码变化应重新核实。
- “现有事实”不等于已运行验证，特别图片/并发跟随/下载故障仍需按验收矩阵执行。
- 没有读取.env、真实配置、运行数据库或凭证，没有执行真实Agent。

### CLI 现状与约束

| 依据 | 核验内容 |
|---|---|
| [program.ts:17-29](../../../packages/cli/src/program.ts#L17) | 当前原始argv重复扫描，仅长参数；新别名/提示词需改为有语法边界的校验 |
| [program.ts:39-96](../../../packages/cli/src/program.ts#L39) | Commander帮助/安全错误，现有login/session list注册，kind默认all |
| [session-query.ts:33-50](../../../packages/cli/src/session-query.ts#L33) | 时长语法、90天、kind/status解析 |
| [session-query.ts:68-103](../../../packages/cli/src/session-query.ts#L68) | DTO与请求关系严格校验，避免部分输出 |
| [session-list.ts:24-51](../../../packages/cli/src/session-list.ts#L24) | 原HTTP错误优先、续签保存顺序、完整响应后输出 |
| [http.ts:20-49](../../../packages/cli/src/http.ts#L20) | 当前JSON-only、30s、manual redirect、完整response.text；需增加multipart/stream |
| [http.ts:62-81](../../../packages/cli/src/http.ts#L62) | 安全错误code白名单、401与其他HTTP映射 |
| [session-list-output.ts:3-8](../../../packages/cli/src/session-list-output.ts#L3) | escapeDisplayText元信息显示转义；正文仅在人类渲染层按行复用，不改变JSON原文 |
| [errors.ts:1-25](../../../packages/cli/src/errors.ts#L1) | 现有0/2..7退出分类，本次沿用并补Run/监听码 |
| [login.ts:28-53](../../../packages/cli/src/login.ts#L28) | 健康探测、token输入、Cookie保存，不读取旧连接发起登录 |
| [cookie.ts:20-60](../../../packages/cli/src/cookie.ts#L20) | host-only固定Cookie、Secure/属性校验 |
| [config.ts:33-69](../../../packages/cli/src/config.ts#L33) | 单连接配置、0700/0600、随机temp原子保存 |
| [program.test.ts:12-49](../../../packages/cli/tests/program.test.ts#L12) | 离线帮助、用法错误不回显机密，旧JSON拒绝用例需按新契约更新 |
| [scripts/build.mjs:5-19](../../../packages/cli/scripts/build.mjs#L5) | Node22目标CommonJS单文件打包 |
| [package.json:12-26](../../../packages/cli/package.json#L12) | 当前build/typecheck/pretest/test入口与依赖边界 |

### 发现与会话查询

| 依据 | 核验内容 |
|---|---|
| [workspaces.routes.ts:67-73](../../../apps/api/src/modules/workspaces/workspaces.routes.ts#L67) | 工作区列表公开入口 |
| [workspaces.ts:26-36](../../../packages/shared/src/contracts/workspaces.ts#L26) | 工作区列表实际字段title、repos等，CLI裁剪而非原样输出 |
| [workspaces.routes.ts:291-313](../../../apps/api/src/modules/workspaces/workspaces.routes.ts#L291) | surface=user与工作区启用过滤 |
| [settings.service.ts:1019-1026](../../../apps/api/src/modules/settings/settings.service.ts#L1019) | Agent order稳定规范化 |
| [settings.service.ts:1955-1973](../../../apps/api/src/modules/settings/settings.service.ts#L1955) | 可用表面过滤不是运行健康检查 |
| [settings.ts:324-336](../../../packages/shared/src/contracts/settings.ts#L324) | Agent公开view含prompt/tools/model，CLI必须窄投影 |
| [agent-public.routes.ts:365-407](../../../apps/api/src/modules/agent/routes/agent-public.routes.ts#L365) | 摘要与已知session详情，详情支持显式workspace归属 |
| [agent-session-query.ts:3-27](../../../packages/shared/src/contracts/agent-session-query.ts#L3) | 90天窗口及primary/status现成契约 |
| [sqlite-session-activity-query.ts:42-91](../../../apps/api/src/modules/agent/read-side/sqlite-session-activity-query.ts#L42) | updatedAt排序/筛选、原生累计completed计数 |

### 发送、消息、状态、跟随

| 依据 | 核验内容 |
|---|---|
| [agent-public.routes.ts:496-514](../../../apps/api/src/modules/agent/routes/agent-public.routes.ts#L496) | 公开创建只有workspace/title，没有创建幂等键 |
| [agent.ts:347-371](../../../packages/shared/src/contracts/agent.ts#L347) | 发送请求/图片payload及响应字段，无agentId回显 |
| [session-interaction-application.ts:170-219](../../../apps/api/src/modules/agent/session/session-interaction-application.ts#L170) | 主会话写、text/image至少一个、dedup、busy、profile解析 |
| [sqlite-run-lifecycle-persistence.ts:155-177](../../../apps/api/src/modules/agent/lifecycle/sqlite-run-lifecycle-persistence.ts#L155) | 主会话user持久化originRunId=null，Run内部triggerMessageId关联该输入；不能用completed user确定Run |
| [sqlite-run-lifecycle-persistence.ts:286-309](../../../apps/api/src/modules/agent/lifecycle/sqlite-run-lifecycle-persistence.ts#L286) | 子任务初始user同样originRunId=null，内部关联不构成CLI反查能力 |
| [agent-public.routes.ts:143-233](../../../apps/api/src/modules/agent/routes/agent-public.routes.ts#L143) | multipart payload/images、纯图支持、64KiB payload检查 |
| [agent-attachment-limits.ts:3-10](../../../apps/api/src/modules/agent/attachments/agent-attachment-limits.ts#L3) | 4张、10MiB单张、20MiB合计、PNG/JPEG/WebP |
| [agent-attachment-signature.ts:7-17](../../../apps/api/src/modules/agent/attachments/agent-attachment-signature.ts#L7) | 字节签名，不信文件扩展名 |
| [createApp.ts:27-47](../../../apps/api/src/app/createApp.ts#L27) | 未覆盖Fastify默认JSON bodyLimit；multipart插件另设上限，不能误当Agent图片上限 |
| [agent-message.store.ts:1819-1830](../../../apps/api/src/modules/agent/agent-message.store.ts#L1819) | workspace/session/request去重键，操作共用表 |
| [agent-message.ts:9-32](../../../packages/shared/src/contracts/agent-message.ts#L9) | 消息type/status/part类型 |
| [agent-message.ts:105-150](../../../packages/shared/src/contracts/agent-message.ts#L105) | originRunId、revision、parts和compaction严格分支 |
| [agent-message.ts:224-276](../../../packages/shared/src/contracts/agent-message.ts#L224) | run-state与snapshot/before/delta参数、root-null前提 |
| [agent-public.routes.ts:583-639](../../../apps/api/src/modules/agent/routes/agent-public.routes.ts#L583) | Timeline/详情公开路由，root前提互斥 |
| [sqlite-message-query.ts:183-229](../../../apps/api/src/modules/agent/read-side/sqlite-message-query.ts#L183) | reset条件、当前分支可见性、before cursor失败 |
| [sqlite-message-query.ts:455-519](../../../apps/api/src/modules/agent/read-side/sqlite-message-query.ts#L455) | depth排序、原始消息分页、delta按updatedRevision |
| [sqlite-message-query.ts:561-593](../../../apps/api/src/modules/agent/read-side/sqlite-message-query.ts#L561) | 普通parts完整读取，不按工具预览3000字符截断 |
| [agent-public.routes.ts:718-759](../../../apps/api/src/modules/agent/routes/agent-public.routes.ts#L718) | session忙闲与指定Run状态公开入口 |
| [agent.composition.ts:2257-2291](../../../apps/api/src/modules/agent/agent.composition.ts#L2257) | Run完全收敛前仍running，终态不变量与结果码 |
| [agent.ts:94-116](../../../packages/shared/src/contracts/agent.ts#L94) | 公开Run响应无Agent/Provider配置、triggerMessageId及输入反查投影，不必新增命令 |
| [agent-message.store.ts:863-879](../../../apps/api/src/modules/agent/agent-message.store.ts#L863) | 压缩previous保留旧head，contextRoot改变，不删除原历史 |

### 取消、压缩、下载与身份

| 依据 | 核验内容 |
|---|---|
| [run-lifecycle-application.ts:360-409](../../../apps/api/src/modules/agent/lifecycle/run-lifecycle-application.ts#L360) | 多session取消、持久化收敛及best-effort runtime停止；无kind guard |
| [sqlite-run-lifecycle-persistence.ts:376-435](../../../apps/api/src/modules/agent/lifecycle/sqlite-run-lifecycle-persistence.ts#L376) | 从根当前Run递归活动后代、根idle不扫历史、不覆盖已完成intent |
| [manual-compaction-application.ts:9-39](../../../apps/api/src/modules/agent/compaction/manual-compaction-application.ts#L9) | 子只读、busy409、空400、dedup/scheduled实际语义 |
| [runner.ts:3769-3807](../../../apps/agent-worker/src/runtime/runner.ts#L3769) | 手动压缩只一次、无需压缩等终态code |
| [workspace-files.routes.ts:305-344](../../../apps/api/src/modules/workspaces/workspace-files.routes.ts#L305) | 现成文件流/目录ZIP，以及重新按路径打开 |
| [workspace-files.service.ts:55-56](../../../apps/api/src/modules/workspaces/workspace-files.service.ts#L55) | 100MiB源大小与.git规则 |
| [workspace-files.service.ts:108-131](../../../apps/api/src/modules/workspaces/workspace-files.service.ts#L108) | 既有相对路径/..检查和根路径规范化 |
| [workspace-files.service.ts:276-297](../../../apps/api/src/modules/workspaces/workspace-files.service.ts#L276) | 工作区根与repo首段映射 |
| [workspace-files.service.ts:315-337](../../../apps/api/src/modules/workspaces/workspace-files.service.ts#L315) | realpath缓存/根包含检查 |
| [workspace-files.service.ts:382-389](../../../apps/api/src/modules/workspaces/workspace-files.service.ts#L382) | repo根词法映射，独立风险定位 |
| [workspace-files.service.ts:1235-1340](../../../apps/api/src/modules/workspaces/workspace-files.service.ts#L1235) | 递归下载限制、软链拒绝、仅普通文件条目、目标解析 |
| [auth.ts:25-72](../../../apps/api/src/app/auth.ts#L25) | 公开Cookie与内部token两套边界，不把internal SSE提供给CLI |

## 实施中不得沿用的早期结论

- 不再要求完整主会话历史、直接子会话查询、父子树API。
- 不再要求session状态带最近Run或失败原因。
- 不要求创建幂等、新建并发送事务入口或发送API强制补agentId。
- 不把独立下载安全修复作为CLI新增API任务，也不宣称CLI过滤等于服务端安全保证。
- 不以“全部功能可复用API”推断CLI无需实现复杂边界；分页、最后排干、未知结果与本地无覆盖仍是本次重点。
