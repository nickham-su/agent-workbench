# 临时补充输入缓冲：需求与产品规则

> 本页是本轮改造的现行产品规则。0038 其他文档中有关持久可靠队列、`mode` / `pause_code`、暂停与恢复 queued、后台 dispatcher 自动创建 Run 的内容属于历史设计，不再适用。Stop、运行准入、正式输入确认、附件安全和 Worker 写入 fence 等既有边界继续有效。本轮实现仍待独立审查，历史验收结论不覆盖此次变更。

## 定位与范围

缓冲仅用于正常交互 Run 内的临时补充，尽力而为，不保证送达。它不是待执行任务，也不负责恢复执行。

| 场景 | 权威行为 |
| --- | --- |
| 空闲时显式发送 | 在附件发布最终同步事务中创建正式 user 和 Run，提交后 handoff Worker；保留 requestId 幂等和 unknown 诊断 |
| 运行中补充 | 请求携带冻结的 `targetRunId`，仅该 Run 可以消费；不能创建或恢复 Run |
| 正常 `complete_or_continue` | 可以在同一 Run 消费 FIFO 补充；无输入时按既有协议完成 |
| 取消、明确失败、任何终态（含 completed） | 取消该 Run 尚未消费的 queued；不自动执行剩余补充 |
| API 首次启动开放收件 | 丢弃所有遗留 queued，包括旧暂停积压；Worker ready/reconnect 不重复清理 |

不扩大到 scheduled、subtask、IM 或旧强制启动入口；不增加失败列表、重试、恢复、优先级或编辑补充功能。

## 目标 Run 与安全边界

- 收件前及异步发布的最终 SQLite 事务内均校验：同 Workspace / Session、目标为当前交互 user Run、status 为 running、phase 为 `work_pending` / `work_in_progress`，且 Stop 未阻断。
- `targetRunId` 是输入的目标身份，不是新的队列持久状态。跨终态、跨 Stop、跨后续 Run 到达的文字和图片均不得串入下一 Run。
- 当前模型响应的整轮工具闭合后，按已有 prepare / inject 协议消费有限 FIFO 前缀；保留操作幂等、revision、绑定和 preparation fence。
- 明确失败通过既有 terminal intent 立即关闭注入窗口，不等待公开终态写入；旧 Run notice / terminal 重放不得清除新 Run 缓冲。
- 不引入代替 `mode` / `pause_code` 的同义持久状态，不再存在后台 dispatcher 自动创建 Run。

## queued 与正式输入

- queued 尚未进入正式历史；消费时才生成正式 user。首发例外：在接收事务内立即正式化。
- 丢弃统一取消 receipt，不物理删除 receipt；保留去重墓碑、queueVersion 单调性和附件 retain 账本。
- injected / unconfirmed 已是正式输入，不能随缓冲清理而 abandon、删除或丢失其绑定，也不能删除助手输出和工具结果。
- 安全条件满足后的新普通发送创建本次新 user / Run，并承接可见的全部未确认正式输入；不重复插入旧 user，不自动重放旧工具。
- 后端兼容 resume 仅可续接正式 unconfirmed；没有正式输入时返回 `no_unconfirmed`，不恢复 queued。兼容 abandon 仍需原显式不可逆确认、版本和完整输入集合校验，不由补充失败自动调用。Web 不增加相关恢复入口。

## 输入区、草稿与数量

- 运行中可补充文字和图片。发送动作开始即冻结目标 Run，异步建 Session、上传或晚到响应不能改写该目标。
- 补充提交失败或被丢弃静默结束，不保留重试副本、不弹恢复 UI。仅清理对应提交的草稿 / 图片版本，不清掉用户后来编辑的内容。
- 普通首发 HTTP unknown 仍保留 requestId、文字及 File 副本，允许查询或重试原请求；不能换 ID 重发。明确拒绝保留草稿与必要诊断。
- 输入框上方“有 N 条消息等待处理”只统计服务端 queued，0 隐藏；本地草稿、上传、HTTP 未确认和 injected 不计 N。
- messageID、时间、工具摘要独立显示，不受 Fork / 回退权限影响；结构操作本身仍受 Session 类型、Stop 和历史安全限制。

## Esc 与 Stop

| 状态 | Esc |
| --- | --- |
| 运行中且 queued 非空 | 尽力清空按键时快照列出的 receipt IDs，不 Stop，不影响后来补充 |
| 运行中且 queued 为空 | 独立 Stop；服务端同事务关闭准入、清 queued 并冻结原目标屏障 |
| 未运行 | 无操作；显式发送创建新 Run |
| Stop pending / unknown | 保留原 Stop 诊断和原 operationId 重试；不得强制恢复 |

忽略 IME 和 repeat。清空实际 0 条也不能自动 fallback Stop；清空失败不新增恢复流程。Stop 受理或 DB 终态不是 Runner 退出证明，继续要求 admission / drained / 固定实例和目标证明。持久 Stop generation 阻止停止前在途请求晚到；旧 Stop 重放不得停止或清除后续 Run。

## 身份、图片与同步

- 补充固定当前 Run 的 Agent / provider / model；普通发送承接未确认正式输入的身份，不静默切模型。配置错误仅拒绝当前请求，不建立暂停状态。
- 图片维持原数量 / 大小限制、受控读取、路径与软链边界。发布前独立预留，DataDir 留存额度维持 1 GiB；取消、终态、逻辑删除不释放已发布额度，不删除附件文件或账本。
- queueVersion 独立于消息 revision；低版本回包不能覆盖高版本，同版本不同快照需要诊断。
- 活动页面 running / queued / unconfirmed 时 800 ms 轮询，完全 idle 时 3000 ms；恢复可见立即刷新。断网保留最近可信快照，不能伪置 0；切换 Session 隔离旧回包。

## 数据升级与验证边界

v26 → v27 前向迁移删除 control 表中的 `mode` / `pause_code`，保留 control 版本和序号、receipt、正式历史、绑定、去重墓碑、附件账本；receipt 增加 `target_run_id`。保留严格旧 canonical 识别、事务回滚和 FK 校验。迁移本身不清 queued，首次 API 开放收件负责取消遗留缓冲。

本轮验证覆盖迁移、发布晚到、终态 / Stop fence、正式输入承接、Worker 重放及前端元信息。独立审查、真实用户数据库与外部 provider / 多端人工验收不能由作者自测代替。
