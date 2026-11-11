# Agent 会话消息队列与运行中注入

## 状态与权威范围

- 设计审查：第四轮独立复审通过，H5及此前H1～H4、M1～M4均Resolved；此结论仅属于设计文档静态审查，历史记录见07。
- 实施状态：**工程实现完成，最终全面独立审查及原会话existing复审已通过，0038整体实现可交付；H1／H2／M1／M2／L1／L2共6/6关闭，Open 0，无新增问题**。本结论来自主助理明确转述的独立审查，不是作者自测替代审查；收尾阶段仅顺序复跑相同源树的完整测试、隔离真实浏览器并归档，不再修改已审通过生产代码／协议／测试语义。最终验证命令、计数及证据见[实现与验收第13节](08-implementation-and-acceptance.md#13-最终独立全面复审通过与同源树收尾归档)。
- 审查层次：设计静态审查、S1～S7逐阶段代码审查、全新全面new审查及原会话existing复审分别记录；设计通过不等于代码通过，阶段通过不替代整体审查。全面new首轮未通过及S8／H2修复历史均保留；最终existing复审才关闭六项问题，详见[最终工程审查记录](07-review-record.md#最终工程实现与独立全面复审归档)。
- 验证边界：独立审查者运行141项定向测试及跨层反例；作者的八组完整测试、真实managed Worker与真实Chromium证据单独归档，不称其为reviewer执行。实际用户DB升级、外部provider联调及人工多端验收不在本次已验证范围。
- 本次只做Web交互收件、持久队列、运行中安全注入、输入框上方数量和受控恢复；飞书／IM暂停。
- 本目录是开发、审查和验收依据。需求／状态／实体／协议冲突须先修文档，不留给开发自行选择。
- 01～04及06保留需求与设计验收权威；05记录分阶段实施历史，08记录本次真实实现和回归证据，不以删减验收项掩盖限制。

## 阅读导航

| 文档 | 权威内容 |
| --- | --- |
| [需求与产品](01-requirements-and-product.md) | R-*、交互、恢复双出口、安全留存成本 |
| [业务规则](02-business-rules-and-state-machine.md) | D-*、FIFO、身份、停止、确认、放弃 |
| [技术与实体](03-architecture-and-data-model.md) | DDL/FK、固定目标停止屏障／运行身份、独立续接、绑定替换、保守预算与发布账本 |
| [API与Worker](04-api-and-worker-protocol.md) | 新旧契约、版本、精确取消等待、停止快照、控制／恢复协议和错误 |
| [开发实施](05-implementation-plan.md) | 真实代码证据、P-*阶段任务和自检 |
| [测试验收](06-testing-and-acceptance.md) | A-*、同Run实际输入、并发／崩溃及审查问题回归 |
| [审查记录](07-review-record.md) | 设计／逐阶段／全面new及existing复审的分层结论、六项最终关闭证据和限制 |
| [实现与验收](08-implementation-and-acceptance.md) | 实施与失败历史、R／D／A覆盖、最终同源树八组测试／真实浏览器证据与限制 |

## 不可降低的约束

- 单Session单有效Run；receipt入队不改正式历史，注入才创建user。
- 当前模型响应的全部工具闭合后才吸收有限FIFO前缀；不抢占模型或长工具。
- 正常完成原子continue/finish，错误／停止／预算不能被queued复活。
- 新Stop不带预期版本、安全优先；resume/abandon才CAS。旧Stop同ID重试只重放，不再次停止后来新执行。
- DB终态不是Runner退出证明；固定Run+可信实例+持久停止屏障，pending/unknown禁止恢复与旧强制／历史修改。精确quiescent才解除，仍paused；工具unknown/lease不变，不承诺撤回副作用。
- 已受理、已注入、已确认分开；不承诺工具副作用exactly-once。
- 输入框上方“有 N 条消息等待处理”，只统计queued；0隐藏，暂停仍计。N=0的未确认正式输入另有恢复提示。
- 未确认输入保留原文／真实图片；只能合法确认或用户显式全量放弃，不能静默摘要。
- 停止屏障解除等安全条件满足后，失败原Session可显式续接旧输入（新Run、无新user），也可不可逆放弃全部未确认输入（保留历史、所有有效上下文排除）。
- Assistant替换／resume必须继承或验证输入绑定，superseded旧结果不能确认。
- Worker使用版本化保守估算，不声称已有精确预算；API不维护动态工具影子。
- 已发布Workspace附件安全保留，不自动unlink；发布前独立持久计额，1GiB留存上限不随取消／逻辑删除释放。
- Worker ready与fallback API onListen分别有恢复屏障；两路径关闭先停推进。

## 术语

| 术语 | 含义 |
| --- | --- |
| receipt | 持久受理记录，具有独立幂等身份 |
| queued | 尚未正式注入，计入N，暂停仍是queued |
| injected | 已有正式user和原注入Run，不能取消或倒退 |
| unconfirmed | 已注入但尚无合法确认，属于保护输入 |
| confirmed | worker_model实际合法完成或local_fallback本地回显完成，记录来源；不是目标验收成功 |
| abandoned | 用户显式不可逆放弃，历史可见、有效上下文排除、不伪造确认 |
| 安全边界 | 工具轮次完整、无模型请求进行中的下一模型调用前窗口 |
| 队列版本 | 独立于消息revision，覆盖收件、控制、确认、放弃与可见停止屏障变化 |
| 停止屏障 | 固定运行目标的持久退出确认；pending/unknown不因DB terminal或新ready解除 |
| quiescent | 指定实例固定Run已无可继续执行／写回的受跟踪Runner，非所有工具／远端副作用回收 |
| 发布留存额度 | DataDir中本功能新增附件的独立记账，不是全磁盘保证或用户配额体系 |

## 需求—决策—验收追踪

| 需求 | 决策 | 验收 |
| --- | --- | --- |
| R-ACCEPT | D-PERSIST、D-IDEMPOTENCY | A-ACCEPT、A-IDEMPOTENCY |
| R-INJECT | D-BOUNDARY、D-FINISH | A-BOUNDARY、A-FINISH |
| R-COUNT | D-SNAPSHOT | A-COUNT、A-MULTICLIENT |
| R-CONTROL | D-STOP、D-FAILURE、D-STOP-BARRIER | A-STOP、A-RECOVERY、A-CONTROL-RACES、A-STOP-BARRIER |
| R-IDENTITY | D-PROFILE | A-PROFILE |
| R-ATTACHMENT | D-INPUT-PROTECTION | A-IMAGE、A-COMPACTION |
| R-RECOVERY | D-RECOVER、D-ABANDON | A-RECOVER-EXIT、A-ABANDON-SCHEMA |
| R-CONFIRM | D-BINDING | A-BINDING-RETRY、A-FALLBACK |
| R-RETAIN | D-RETAIN、D-LIMIT | A-RETENTION |
| R-COMPAT | D-COMPAT | A-COMPAT、A-MIGRATION |
| R-BOUNDARY | D-HISTORY、D-BUDGET | A-HISTORY、A-SECURITY、A-SCOPE-DDL、A-BUDGET |

## 验证声明

设计审查历史保留于07；实施与本次自动化回归结论以08为准。已执行完整构建、类型检查、SQLite真实迁移／事务、真实受管Worker＋本地假provider、Web组件等自动化测试；未进行真实外部模型联调、真实浏览器双标签／断网人工验收或既有用户数据目录升级。追加真实Chromium验收发现的生产Web作用域重置缺陷已按授权最小修复；两轮全新fixture均通过3→刷新3→UI取消2→整轮闭合后同Run输入→0隐藏的完整A-COUNT，详见08第9节；全部S7文件清单见08第10节。S7独立代码审查及最终全面对照方案审查尚未进行；正式依赖未改，仅经授权隔离安装固定浏览器工具，未读取敏感配置或执行Git操作。
