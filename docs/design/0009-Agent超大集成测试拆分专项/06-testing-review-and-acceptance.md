# 测试、独立审查与验收标准

## 验证目标

本专项本身改的是测试，因此不能仅以“新测试绿色”证明迁移正确。验证必须回答：

- 原 `165` 个测试是否全部迁移且唯一归属；
- 标题和核心断言是否保持；
- 真实 SQLite、HTTP、process、socket、SSE、filesystem 边界是否保留；
- fixture 和 teardown 是否在多文件下稳定；
- 运行并发与既有 `{ concurrency: false }` 是否保持；
- package script 是否稳定发现全部新文件；
- API 全量回归是否没有覆盖缺口；
- 生产代码是否零改动。

## P0 基线验证

P0 必须记录旧文件基线：

```bash
cd apps/api
npm run test:integration
npm run typecheck
```

需要记录：

- 发现的 test 数；
- pass/fail/skip/cancel 数；
- 总耗时；
- 是否存在预期 warning；
- `.tmp-tests` 是否有遗留；
- Plugin Host / SSE 是否稳定关闭。

P0 还必须建立机器可核对的清单，至少包含：

```text
序号
原行号
原测试标题
目标文件
迁移批次
迁移状态
```

方案中的表是设计基线；实施时应通过脚本或审查比对实际源码，防止手工遗漏。

## 多文件 runner 验证

P0 新增最小迁移探针后，应比较至少两种发现方式，具体命令按实际 shell/Node/tsx 支持决定，例如：

```bash
cd apps/api
npx tsx --test src/modules/agent/integration/*.test.ts
```

或显式由 `find` 排序提供文件列表。最终方案必须基于实际结果冻结，不允许只凭假设修改 `package.json`。

需要验证：

- glob 是否由当前 shell 稳定展开；
- 无文件或路径包含特殊字符时行为是否清晰；
- 多文件是否默认并发；
- 输出中是否能看到全部目标文件；
- 单文件定向运行是否方便；
- CI / 本地 cwd 是否一致；
- 总耗时和资源占用是否可接受；
- Plugin Host 与 SSE 是否需要特殊串行策略。

`apps/api/package.json` 的最终目标是让：

```bash
npm run test:integration
```

稳定运行全部新 integration 文件。具体 script 文本在 P0 独立审查通过后冻结；若审查无修复项，则无需复审。

## 分批测试矩阵

### P0

- 旧 `npm run test:integration`；
- 一个最小新文件定向测试；
- 旧文件减去对应测试后的组合运行；
- 多文件发现与并发实验；
- testkit 自身已有测试或新增窄测试；
- API typecheck；
- test title count/inventory diff。

### P1

定向覆盖：

- Plugin Host process/socket；
- startup fail/recover/cancel race；
- runtime cancel best-effort；
- SSE connect/event/teardown；
- Settings/Profile 基础。

同时运行旧文件中尚未迁移的测试，保证总覆盖连续。

### P2

定向覆盖：

- Subtask lineage/orphan/reuse/partial unique；
- Subtask route validation/auth/schema/depth/mode；
- prefork summary/meta/plan/result/partial result；
- Session create/fork/trigger routes；
- 现有 `subtask/*.test.ts` 回归。

### P3

定向覆盖：

- messages/context/reasoning；
- context writeback helper 等价前置状态；
- run cancel/settlement/cascade；
- `{ concurrency: false }` 保留；
- compact/clear/revert；
- 相关 lifecycle/writeback/session baseline 测试。

### P4

定向覆盖：

- locale/runtime constraints/tool messages；
- peripheral status/tail/allowlist；
- archive/search/read/compaction snippet；
- artifact missing/symlink/slim result/legacy result；
- global prompts/AGENTS.md/skills/workspace；
- Settings/Profile 剩余 provider 场景。

### P5

执行新目录全量 integration：

```bash
cd apps/api
npm run test:integration
npm run typecheck
```

执行 API 全量测试。当前项目既有命令形态为：

```bash
cd apps/api
npx tsx --test $(
  find src \
    -path '*/.data/*' -prune -o \
    -name '*.test.ts' \
    ! -path 'src/modules/plugins/plugin.service.test.ts' \
    -print | sort
)
```

如项目脚本或 cwd 约定在实施时变化，应记录实际命令，不能按旧命令机械标记通过。

根目录最终验证：

```bash
npm run build
npm run typecheck
git diff --check
```

如果涉及暂存，只有经用户授权后才可执行 Git 阶段动作；本专项默认不 push、不改写历史。

## 覆盖连续性规则

每个测试块迁移时：

```text
复制到新位置并调整 import/helper
  → 新位置定向通过
  → 新旧组合运行确认无资源冲突
  → 独立审查核对标题与断言
  → 删除旧位置对应块
  → 再次运行定向与必要回归
```

禁止先大批删除旧测试再补新位置。

迁移期间允许同一测试短暂存在两个副本用于验证，但不能在批次结束时长期重复。重复运行可能掩盖唯一归属，也可能加倍 process/socket/DB 成本。

## 关键主链验收矩阵

| 主链 | 必须保留的关键证据 |
|---|---|
| Plugin Host | mock plugin、service reconcile、process/socket、start/stop、清理 |
| Startup fail | in-flight run fail 与 run-state 收敛 |
| Startup recover | enqueue 前/后 cancel race、candidate 隔离 |
| Runtime cancel | runtime failure 仅 warning，DB cancelled 终态保持 |
| SSE | connection、event chunk/type/id/data、abort/reader/body teardown |
| Subtask lineage | depth/parent、orphan 条件、reuse/new-shell compensation、unique constraint |
| Session control | compact auth/unavailable、clear archive/boundary/concurrency、revert 状态与隐藏分支 |
| Run cancel | context settlement、hidden chain、terminal dirty data、child cascade |
| Archive/Compaction | archive write/search/read、snippet 缓存/重建、v2 边界 |
| Artifact | apply_patch/write、missing、symlink 越界、完整 args/slim result |
| Prompt | locale、runtime constraints、tool visibility、structured messages、global/workspace/skills order |
| Settings/Profile | scope/surface、provider/model、compaction model、OpenAI-compatible |
| Peripheral | status summary、tail、allowlist、agent list、final text、internal auth |

## 独立审查要求

每批审查员必须未参与该批迁移，并给出明确结论：

- 本批原测试标题是否全部有新位置；
- 是否有丢失、重复或改名未记录；
- 核心断言是否保持，是否为了通过而弱化断言；
- fixture 前置状态是否等价；
- teardown 是否覆盖成功和失败路径；
- 是否保留特殊资源与并发语义；
- helper 是否显式、窄、无跨测试状态；
- 是否形成新的 testkit 杂物层；
- 是否修改生产代码、产品预期或无关文件；
- 定向测试和必要回归是否真实执行并看到结果。

若发现问题，必须修复并由独立审查员复审。P5 后由未参与 P0-P5 的新审查员全面终审。

## 代码审查清单

### 迁移完整性

- `165` 项清单无空目标；
- 每项只有一个最终活动副本；
- test 标题保持，必要改名有理由和旧标题映射；
- 核心 `assert` 数量或语义没有下降；
- 没有以已有单元测试为理由删除跨域主链；
- 没有遗漏 file/process/socket/SSE teardown。

### 结构可维护性

- 新文件名表达调用链；
- 不存在 `part1/part2/misc`；
- imports 与文件职责一致；
- 每个文件的场景 helper 就近可见；
- integration testkit 只含稳定通用能力；
- 领域 helper 不互相形成新的依赖网；
- 新增测试归属规则已写入文档。

### Fixture 与并发

- 每测试独立 DB、app、dataDir、workspace；
- 无跨文件全局 fixture；
- `dispose()` 幂等；
- 特殊资源有局部 finally；
- `{ concurrency: false }` 等原配置保持；
- package script 与 runner 并发模型有 P0 实测证据；
- `.tmp-tests` 无持续遗留。

### 范围控制

- `apps/api/src/modules/agent` 生产 `.ts` 文件无修改；
- Worker、Store、composition、module、route 无修改；
- Shared contract、DB schema、Artifact/Archive 格式无修改；
- package script 只改 `test:integration`；
- 无依赖升级、无测试框架重写、无无关格式化。

## 完成定义

### 结构验收

- 旧综合文件已删除，或仅保留极少 cross-domain smoke，并逐项说明不能归域的理由；
- 原 `165` 个测试唯一归属；
- 约 `16` 个语义文件结构稳定；
- 无新的超大杂项测试文件；
- 无新的万能巨型 testkit；
- fixture ownership 和 helper 层级清晰。

### 行为与覆盖验收

- 原测试标题与核心断言没有丢失；
- 所有特殊主链保留；
- 并发、auth、schema、状态、文件安全等既有语义保持；
- 没有修改测试预期来接受新行为；
- API 全量测试没有新增失败。

### 质量验收

- `npm run test:integration` 稳定发现全部新文件；
- API integration、API 全量、API typecheck 通过；
- root build/typecheck 通过；
- `git diff --check` 通过；
- 生产代码零 diff；
- 总耗时无无法解释的明显恶化；
- 每批审查/复审与最终新审查员终审通过；
- [09-implementation-record.md](./09-implementation-record.md) 记录实际命令、结果、耗时、偏差和结论。

## 最终验收结论

未参与 P0-P5 实施及批次审查的新审查员已完成全面独立终审，结论为**通过**：专项达到完成定义，无 H/M 问题，无必须补代码差距。终审引用 P5 已实际执行并记录的 new integration、API 全量、API/root typecheck、root build、worker/plugin/web 回归、资源与 diff 证据；不将终审员未单独执行的命令记为其执行。

### 非阻断维护观察与决策

| 级别 | 观察 | 决策与理由 |
|---|---|---|
| L1 | `createSession` / `sendMessage` 在 `agent-integration-testkit.ts`、`context-writeback.helpers.ts` 与 `subtask.helpers.ts` 存在小幅重复 | 本专项不补代码。复制面有限，且 helper 职责与 fixture 类型不同；立即统一会扩大共享 testkit 耦合，并可能削弱显式前置状态。未来相关调用约定变化时再需求驱动收敛。 |
| L2 | 默认 providers/agents 初始化在 `agent-integration-testkit.ts` 与 P4 特殊 fixture 有近似重复 | 本专项不补代码。P4 特殊 fixture 需要 pre-app 初始化，和通用 ready fixture 的生命周期不同；立即统一会扩大共享 testkit 耦合并模糊显式前置状态。未来 bootstrap 或相关调用约定变更时再需求驱动收敛。 |

### 已接受的结构差异

- Plugin Host、SSE、Archive/Artifact 等特殊主链继续使用局部 fixture、pre-app 或 direct seam，而不硬塞进通用 testkit；
- `internal final-text` 归入 Peripheral Status，符合其主调用面；
- 最大 integration 测试文件为 `agent-subtask-prefork-result.integration.test.ts`，`1433` 行，低于本专项关注阈值；
- 上述差异不降低覆盖或改变产品行为，已由终审接受。
