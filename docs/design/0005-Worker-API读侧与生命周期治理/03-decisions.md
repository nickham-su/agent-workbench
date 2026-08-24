# 关键决策、取舍与暂停条件

## 决策总表

| 编号 | 决策 | 本轮规范 |
|---|---|---|
| D-1 | read-side 范围 | 仅 `execution-profile`、`prompt-context`、`messages-context` |
| D-2 | contract 入口 | 继续使用 `@agent-workbench/shared/internal-contracts/agent-api` 唯一公开入口 |
| D-3 | cache | `prompt-context` 的 `runPromptStaticCache` 原样冻结 |
| D-4 | schema | 稳定外壳精确，动态内部宽松 |
| D-5 | 体积 | 不新增分页、截断、maxChars、压缩或通用体积保护 |
| D-6 | 错误 | 保持 token → schema → handler 顺序及当前 400/401/404 |
| D-7 | 敏感字段 | `execution-profile` 保留运行所需字段，validation 日志不打印 payload/secret/标识符 |
| D-8 | 一致性 | DB 收敛优先 + 轻量 DB fence |
| D-9 | race | cancel wins；recover enqueue 前最终检查 DB |
| D-10 | late append | 1D 受控扩展 Context create：正常 `{ok:true,item:record}`；late no-op 固定 `{ok:true,item:null,ignored:true}` |
| D-11 | lineage | `parentRunId + parentToolItemId` 权威；`subtaskSessionId` 仅呈现/定位 |
| D-12 | orphan | 只扫描 1h 空壳 suspect；24h 且双 fork lineage 完整才可自动删；suspect 内其余对象保留诊断 |
| D-13 | archive | 仅 rollback skipped 写 sidecar；仅单文件 sidecar 在尺寸精确匹配时自动 truncate |
| D-14 | 兼容 | 同仓库原子迁移，不做长期双协议 |

## 取舍说明

### Read-side 只做三接口

三接口直接位于 Worker 主运行链路，已有 API service 和大量行为测试，迁移收益高、范围可控。`archive/*` 是工具读取而非主 prompt read-side；`plugins/*`、`git-env/*`、`mcp-settings` 的动态 payload、外部进程或文件 lease 语义不同，全部后置。一次纳入会把协议收口与外围能力治理混在一起。

### 不修改 prompt cache

`runPromptStaticCache` 负责静态 prompt 组装，当前测试已覆盖同 run 复用和 compaction snippet 等行为。改变 key、TTL、失效或动态拆分会同时改变模型输入和设置生效时机，不属于 contract 迁移。缓存问题记录为后续治理。

### 稳定外壳精确、动态内部宽松

完整深 schema 会把消息 provider options、工具 input schema 和任意 args/result 变成新业务合同；宽松到只校验顶层又失去 response validation 价值。当前方案只冻结能证明稳定的外壳，保留动态 payload 兼容性。

### DB 收敛优先

完整 execution linearization 需要 epoch/lease、写回代际字段、recovery reconciliation 等跨层改造，风险高于本轮目标。DB fence 能阻止迟到写回污染终态，runtime stop 的短暂滞后是本项目可接受取舍。

### late append 不伪造正常 create item

0004 记录了 1B 正常 create response 返回完整 record 的已验收事实，Worker 可能使用 `item.id`。terminal/cancelled late append 又不得创建 item，因此 1D 必须引入明确、最小、可校验的 no-op response 分支；这不是对 1B 事实的否定或回写。

1D 冻结合同：

```json
{"ok":true,"item":null,"ignored":true}
```

P3 必须把 response schema 扩展为 normal/late no-op 的可判别联合：正常分支仍是 `{ok:true,item:AgentContextItemRecord}`；`item:null` 时必须同时为 `ignored:true`。shared schema、Route、Worker Client typed response 和测试必须一起迁移。不得返回裸 `{ok:true}`、虚构 item 或未声明的替代 response。

### 保守 orphan 清理

existing reuse 使“空壳 session”也可能具有用户未来语义。scanner 只枚举超过 1 小时、无 run、无 context item 且 head 为空的 suspect；自动删除只针对其中有完整 fork lineage、超过 24 小时且删除前二次确认的极小集合。suspect 中其余对象只标记，非-suspect 不进入该 scanner 的诊断范围，牺牲清理彻底性换取不误删。

### Sidecar 而非全局事务

当前 archive 已有 `beforeSize/expectedSize` 快照和安全 truncate 条件。sidecar 只补可发现、可重试入口，不改文件格式和 DB 事务边界；尺寸不匹配时不猜测处理。由于跨多个文件的 truncate 不具备原子性，自动 reconcile 只处理单文件 sidecar；多文件记录保留并 warning。

## 已接受风险

- cancel 后 runtime 可能短暂继续执行；
- recover 不能保证已发出 enqueue 被强制取消；
- Worker 重启不恢复内存 nested mapping；
- orphan 可能长期只标记不删除；
- archive 与 DB 仍不是全局原子，sidecar 只能处理可确定回滚的单文件尺寸匹配情况；多文件 pending 记录可能长期保留。

## 实施前必须暂停的冲突

遇到以下任一情况，停止当前批次并更新设计/测试：

- 三个 read-side 的真实 response 与 02/04 中稳定字段不一致；
- `runPromptStaticCache` 的 key/TTL/失效行为在当前代码已变化；
- 正常 Context create 已不再返回完整 record；
- Store 无法在 append/update 的同一 DB 边界获得 run/session 状态；
- 当前数据模型无法可靠查询 parentRunId/parentToolItemId；
- archive snapshot 不再包含 before/expected size；
- sidecar 路径无法安全置于 dataDir 内；
- 发现 existing reuse 会使用本文自动删除候选条件。

## 不采用的方案

- 全部 read-side endpoint 一次迁移；
- 通过 `Type.Any()` 绕过全部 response validation；
- 以 retry/timeout 掩盖 conflict 或 race；
- 引入通用 RPC、lease、epoch、outbox；
- 终态后继续写入再由后台清理；
- 不检查文件尺寸直接 truncate；
- 以删除测试断言或扩大 `any` 解决兼容问题。
