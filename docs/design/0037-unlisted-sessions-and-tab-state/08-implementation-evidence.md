# 0037 实施与 RELEASE 验证证据

## 1. 状态与证据边界

- 本文记录 DATA、DOMAIN、BACKEND、CLIENT 实施之后的 RELEASE 验证，不替代 [验收矩阵](06-acceptance.md) 或独立源码审查。
- 当前：**第 1 至第 5 阶段及最终全面代码审查均已通过；H1／D1 已 Resolved，无剩余 Open 项**。最终审查者已复验原反例及同类边界，结论见本文末节。最新完整开发门禁为第 7 节的 5474 项及 H1 修复后产品构建；第 2／6 节的 5295／5453 仅为历史，不作为最新验证或生产发布批准。
- 原 RELEASE 阶段只补充测试、更新失效测试夹具及本证据文档；H1 两轮另修复本次专用 v23／v24 结构验证及其词法比较关系，见第 6／7 节。没有降低设计、改变迁移数据策略、产品语义、依赖或测试 runner。
- 验证使用真实 SQLite、隔离 Fastify HTTP、真实前端状态控制代码、现有 Vue 组件测试及真实 Worker gate。没有运行产品 `main`、生产部署、真实用户数据库迁移或真实环境回退。
- 开发、审查和文档子任务未执行 Git；首席已按用户授权逐阶段暂存第 1 至第 5 阶段变更，最终 H1 修复及本次状态收尾待首席核验后暂存。未提交或推送；已有阶段变更未恢复、覆盖或清理。

### 1.1 真实联动的范围

`apps/api/tests/agent-tab-client.integration.test.ts` 对 `new_session`、`fork_message` 各运行一次真实链路：

1. 隔离磁盘库、Fastify loopback HTTP、Cookie 登录及公开定时执行接口创建真实 unlisted Session，确认 request→Run 受理及 `sessionAvailable`。
2. 实际 `createAgentSessionTargetLoader`、`createAgentSessionMetadataReads` 读取元信息；GET 不构成开闭确认。
3. 实际 `AgentSessionTabVisibilityController` 经真实 PUT 打开并取得 confirmed receipt。
4. 丢弃全部客户端缓存及 receipt，使用新客户端实例读取真实 tabs 快照恢复；恢复不额外 PUT。
5. 真实 PUT 关闭确认，再创建全新客户端读取，Session 不再出现。全过程 chooser 不含 hidden，visibility 不提升，Tab 开闭不启动或取消 Run。
6. 随后显式调用原 cancel 接口，真实 hidden Run 正常取消，已关闭 Tab 行保留；任务历史仍关联原 Run。历史 GET 不被误当成同步 reconcile 操作。

这是**真实前后端 HTTP／controller 集成，不是完整浏览器 E2E**。实际 `AgentToolView` 的 DOM、普通 Tab、草稿和生命周期适配由现有组件测试覆盖；不把模拟 XHR 的组件测试单独称为真实后端联动。没有引入浏览器自动化依赖。

另增加真实 CLI→HTTP 测试：已知 unlisted Session 可以 show/status/send/messages/follow/cancel，list 不列出；在 follow 确实取得 active Run 的 HTTP 响应后再取消，跟随命令报告原 Run 的 `run_cancelled`、`complete=true`、退出码 9，且从未请求全局 SSE。

### 1.2 本阶段补测及旧夹具修正

| 文件 | 变更与原因 |
| --- | --- |
| `apps/api/tests/agent-tab-client.integration.test.ts` | 新增两模式真实 HTTP 前后端控制器联动；放入现有 integration collector 自动收集的 `tests/`，避免 API `rootDir` 吞入前端源码 |
| `apps/api/src/infra/db/schema-v23-migration.test.ts` | 增加同时间点 DB＋artifact 离线备份回退；增加仅改版本号、相同列名但 visibility 列序错误、v23 FTS 损坏的无写入拒绝证据 |
| `apps/api/src/modules/analytics/business-collector.test.ts` | 真实 hidden Session／Run 及 canonical model signal 的 2 输入＋3 输出＝5 tokens 保留；删除 Tab 行也不令后台采集 degraded |
| `apps/api/src/modules/scheduled-tasks/scheduled-task-visibility.integration.test.ts` | 在原执行完成且用户已有后续 Run 的真实夹具中删除任务，逐表比较 Session、RunState、Tab、Run、消息和 dedup，证明不回收事实 |
| `apps/api/src/modules/workspaces/workspace.service.test.ts` | 为原实际 Workspace 删除／失败回滚夹具补真实 Tab 行，明确断言 hidden 目标无残留、其他 Workspace 原行不变、删除失败保留原开闭值 |
| `apps/api/src/modules/agent/integration/agent-session-metadata.integration.test.ts` | 完整响应属性数 11→12，补 `visibility=listed`；保留完整性、归属及鉴权断言 |
| `apps/api/src/modules/agent/integration/agent-cli-session-query.integration.test.ts` | 创建已原子插入 Tab 行，旧夹具 INSERT 改 UPDATE；保留“Tab 关闭但 listed”的发现语义，另加真正 unlisted 排除及真实 CLI 定向操作测试 |
| `packages/shared/tests/agent-message.test.ts` | 两个 timeline Session 夹具补必填 visibility，分别覆盖 listed／unlisted；保留工具详情／图片投影拒绝断言 |
| `packages/shared/tests/agent-session-query.test.ts` | 活动查询夹具补已经必填的 `agent:null`，不是给发现 DTO 增加 visibility；保留计数、时间及严格字段边界 |
| `packages/shared/tests/internal-contracts.test.ts` | 精确有限错误码集合增加 `SUBTASK_SESSION_VISIBILITY_MISMATCH`，不放宽为任意字符串 |
| `packages/shared/tests/workspace-agent-tab-state.test.ts` | 精确属性与 required 集合增加 `openedSessionIds`；新增缺失、非法、重复 ID 及严格 mutation 请求断言 |

没有删除原断言绕过失败。新增测试自身调试中修正了 Analytics 有序 slot tuple 夹具、CLI 人类输出字段名以及“历史 GET 立即 reconcile”的错误假设；这些均未修改产品契约。

## 2. 隔离环境、命令与实际结果

以下路径均相对仓库根。临时材料与日志位于 `.tmp-tests/0037/`，**不属于提交文件**。日志仅供本次工作区复核，干净检出后需重新执行。

### 2.1 隔离约束

每个验证命令先加载项目内 `release-env.sh`，将 `TMPDIR`、`HOME`、`XDG_CACHE_HOME`、`XDG_CONFIG_HOME`、npm cache/config/prefix、`TMUX_TMPDIR` 均定位到 `.tmp-tests/0037/`，并设 `TSX_DISABLE_CACHE=1`。不读取根环境文件、真实凭证或用户数据库，不搜索 `.awb`。

在仓库根重建同等隔离环境（无需保留临时脚本）：

```bash
ROOT="$PWD"
BASE="$ROOT/.tmp-tests/0037"
mkdir -p "$BASE"/{tmp,home/.config,cache,tmux,empty-env,npm-prefix}
touch "$BASE/empty-npmrc" "$BASE/empty-global-npmrc"
export TMPDIR="$BASE/tmp" HOME="$BASE/home"
export XDG_CACHE_HOME="$BASE/cache" XDG_CONFIG_HOME="$BASE/home/.config"
export npm_config_cache="$BASE/cache/npm"
export npm_config_userconfig="$BASE/empty-npmrc"
export npm_config_globalconfig="$BASE/empty-global-npmrc"
export npm_config_prefix="$BASE/npm-prefix" TMUX_TMPDIR="$BASE/tmux"
export TSX_DISABLE_CACHE=1
# 不与其他测试/build 并发执行：
npm test
npm run typecheck
```

最终 G 结束后另运行一次完整 `npm run test:unit -w apps/api`，1592＋8＝1600 通过，fail/cancelled/skipped 均为 0，复核 ACC 映射时补强的 Workspace 删除／回滚 Tab 行断言；日志为 `release-api-unit-gate.log`。计数与根门禁不重复相加。

- shared build 会清空 dist，不能与依赖 shared 的测试并发。
- API integration 的实际 cwd 为 `apps/api`；现有 runner 保留其唯一需要仓库根 cwd 的 plugin 单测分组。
- 最终根测试按原 `npm test` 调度运行；不在其外并发补测、typecheck 或 build，避免资源竞争及 dist 竞态。

### 2.2 门禁命令组

| 组 | 实际命令／范围 | 结果 | 日志 |
| --- | --- | --- | --- |
| G | 根 `npm test`：先 shared／CLI build，再全部六个 workspace 测试 | 退出 0，5295/5295；六个 workspace 均退出 0 | `release-npm-test-gate.log`、同名 `.status` |
| U | G 内 API unit，包括仓库根 cwd 的 plugin 分组 | 1592＋8＝1600 通过 | 同 G |
| I | G 内 API integration，包含本阶段真实 HTTP 与真实 CLI | 567/567 | 同 G |
| K | G 内 API `test:integration:worker`，真实 Worker／provider stub／PTY gate | 20/20；此前独立运行也为 20/20 | 同 G；`release-api-worker-initial.log` |
| B | G 内 Agent Worker workspace 完整测试 | 1290/1290 | 同 G |
| W | G 内 Web runner、普通 TypeScript、全部 30 个组件文件 | 22＋493＋735＝1250 通过；组件 completed=30/skipped=0/exitCode=0 | 同 G |
| H | G 内 shared clean-build 与契约测试 | 135/135 | 同 G；`release-shared-tests-final.log` |
| P | G 内 Feishu plugin 完整测试 | 12/12 | 同 G |
| C | G 内 CLI 完整测试及构建产物 help | 421/421 | 同 G |
| TC | 根 `npm run typecheck` | 退出 0，最终顺序重验通过 | `release-typecheck-gate.log` |
| TX | 显式 tsc 检查跨前端 integration 文件 | 退出 0，最终顺序重验通过 | `release-client-integration-typecheck-gate.log` |
| BUILD | 全部产品 workspace build；Web 使用隔离真实配置副本 | 退出 0；Vite 45.92s 完成 | `release-build-gate.log` |
| M | 真正旧 v23 启动 validator＋隔离升级／同点备份恢复演练 | 退出 0，产品构建后再次复跑及 SHA-256 检查均通过 | `release-legacy-rehearsal-final.log`（初次为 `release-legacy-rehearsal.log`）、`release-legacy-artifact.sha256` |

G 中所有分组的 fail/cancelled/skipped 均为 0；统计只累计这一轮各 suite，不叠加定向复跑或另一次 API unit。全局执行耗时以原 concurrently timings 为准，其中 API 453201ms、Web 263855ms、Worker 118433ms，全部 `killed=false`。

定向补测结果（不累计成全量总数）：

- `node --import tsx --test src/infra/db/schema-v23-migration.test.ts`：13/13，`release-migration-final.log`。
- 两个真实 HTTP/controller 场景：2/2，`release-http-final.log`。
- 真实 CLI integration 文件：4/4，`release-cli-direct-final.log`；最终 G 已执行新增的无 SSE 请求断言。
- shared 全量：135/135，`release-shared-tests-final.log`。
- 旧夹具修正＋Analytics＋真实联动早期定向组：23/23，`release-targeted-final.log`。
- schema＋真实联动早期定向组：14/14，`release-new-tests.log`（增加 VERSION 补测前）。

跨前端 integration 的显式类型检查（API tsconfig 仅 include `src`，不能只凭根 typecheck 声称已覆盖此文件）：

```bash
node_modules/.bin/tsc --noEmit --target ES2022 --module ES2022 \
  --moduleResolution Bundler --skipLibCheck --strict --esModuleInterop \
  apps/api/tests/agent-tab-client.integration.test.ts
```

### 2.3 失败记录与处置

| 轮次／日志 | 真实失败 | 处置 |
| --- | --- | --- |
| `release-npm-test.log` | API integration：旧 Tab INSERT 主键冲突、完整元信息属性数仍为 11 | Fix：更新夹具以符合实际行及新增必填 visibility；没有改产品行为 |
| `release-npm-test-final.log` | shared 六个旧契约夹具／有限集合断言失配 | Fix：补 visibility、必填 agent、opened 集合及新有限错误码；shared 135/135 重验 |
| `release-npm-test-complete.log` | Analytics 冷路径测试 2156ms，超过原 2000ms 上界；同期额外补测增加了负载 | 不放宽原断言、不改产品：停止外部并发补测，重新运行完整原门禁；此轮不是通过证据 |
| 失败取消路径 | 环境无 `ps`，`concurrently --kill-others-on-fail` 的树终止报 `spawn ps ENOENT` | 不安装／伪造系统命令、不修改 runner；保留原失败，成功门禁不得依赖该取消路径 |

文件名中的 `final`／`complete` 不代表成功；最终结论以退出状态、各 suite 汇总及 G 的实际日志为准。验证中曾将 shared build 与依赖 dist 的测试错误并发，导致临时 `ERR_MODULE_NOT_FOUND`，已顺序重验；不得归为产品缺陷或成功覆盖。

### 2.4 产品构建隔离

普通 `apps/web/vite.config.ts` 调用 `loadEnv(mode, repoRoot, "")` 且 `envDir=repoRoot`，因此本阶段没有直接运行普通根 `npm run build` 或 Web 普通 build 脚本。经批准，从真实配置生成 `.tmp-tests/0037/release-vite.config.ts`，只改三处：

1. `webRoot` 定位真正 `apps/web`（副本不在原目录）。
2. `loadEnv` 从项目内空目录 `empty-env` 读取。
3. `envDir:false`，禁止 Vite 自动读取根环境文件。

其余 Vue 插件、alias、define、server 及构建选项原样保留；不维护另一套产品配置、不提交临时副本。重现时先断言三个原字符串各出现一次，再替换：

```js
const replacements = [
  ['const webRoot = path.dirname(fileURLToPath(import.meta.url));',
   `const webRoot = ${JSON.stringify(path.resolve('apps/web'))};`],
  ['loadEnv(mode, repoRoot, "")',
   `loadEnv(mode, ${JSON.stringify(path.resolve('.tmp-tests/0037/empty-env'))}, "")`],
  ['envDir: repoRoot', 'envDir: false']
];
// 对真实配置文本逐项检查、替换后写入项目内临时副本。
```

顺序执行与根产品构建相同的 workspace 和 Web 类型／Vite 步骤：

```bash
npm run build -w packages/shared
npm run build -w packages/cli
npm run build -w apps/agent-worker
npm run build -w apps/api
npm run build -w plugins/feishu
(cd apps/web && ../../node_modules/.bin/vue-tsc -p tsconfig.json --noEmit && \
 NODE_OPTIONS=--max-old-space-size=4096 ../../node_modules/.bin/vite build \
 --config ../../.tmp-tests/0037/release-vite.config.ts)
```

构建产物仅为验证，不运行其 `main`；dist、cache 和临时文件不提交。

构建仅有 Browserslist 数据过期和 chunk 大于 500kB 的非阻断提示；未升级依赖或改变打包策略，以免扩大本次发布验证范围。

## 3. 82 个 ACC 的测试定位与结果

### 3.1 引用约定

下表的文件代号均指**具体仓库相对路径**。测试定位使用引号内的唯一测试名片段；模板族列出参数范围，映射该文件内实际生成的全部对应测试，不表示另造测试名。`U/I/K/W/H/C` 对应第 2 节真实执行组。`M` 为可重复隔离演练；`R` 为明确标注的范围／源码核对，不冒充自动测试。

| 代号 | 测试文件 |
| --- | --- |
| D | `apps/api/src/infra/db/schema-v23-migration.test.ts` |
| SC | `apps/api/src/infra/db/schema.test.ts` |
| T | `apps/api/src/modules/workspaces/workspace-session-tab-state.store.test.ts` |
| TH | `apps/api/src/modules/workspaces/workspace-session-tab-state.integration.test.ts` |
| WM | `apps/api/src/modules/workspaces/workspace.service.test.ts` |
| V | `apps/api/src/modules/agent/session/session-visibility.persistence.test.ts` |
| VI | `apps/api/src/modules/agent/integration/agent-session-visibility.integration.test.ts` |
| SA | `apps/api/src/modules/agent/subtask/subtask-application.test.ts` |
| COMP | `apps/api/src/modules/agent/subtask/subtask-source-compensation.persistence.test.ts` |
| MS | `apps/api/src/modules/agent/agent-message.store.test.ts` |
| SQ | `apps/api/src/modules/agent/read-side/sqlite-session-query.test.ts` |
| META | `apps/api/src/modules/agent/integration/agent-session-metadata.integration.test.ts` |
| SD | `apps/api/src/modules/agent/read-side/session-discovery-visibility.test.ts` |
| DH | `apps/api/src/modules/agent/integration/agent-session-discovery-visibility.integration.test.ts` |
| EV | `apps/api/src/modules/agent/integration/agent-hidden-events-sse.integration.test.ts` |
| RL | `apps/api/src/modules/agent/lifecycle/run-lifecycle-application.test.ts` |
| RI | `apps/api/src/modules/agent/lifecycle/scheduled-user-run-identity.persistence.test.ts` |
| S | `apps/api/src/modules/scheduled-tasks/scheduled-task-visibility.integration.test.ts` |
| SS | `apps/api/src/modules/scheduled-tasks/scheduled-task-snapshot.test.ts` |
| SR | `apps/api/src/modules/scheduled-tasks/scheduled-task.routes.integration.test.ts` |
| SV | `apps/api/src/modules/scheduled-tasks/scheduled-task.service.test.ts` |
| F | `apps/api/tests/agent-tab-client.integration.test.ts` |
| CLIH | `apps/api/src/modules/agent/integration/agent-cli-session-query.integration.test.ts` |
| CF | `packages/cli/tests/fork.test.ts` |
| CP | `packages/cli/tests/program.test.ts` |
| CA | `packages/cli/tests/arguments.test.ts` |
| AF | `apps/web/src/features/workspace/tools/agent/AgentToolView.component.test.ts` |
| VC | `apps/web/src/features/workspace/tools/agent/agentSessionTabVisibilityState.test.ts` |
| TL | `apps/web/src/features/workspace/tools/agent/agentSessionTargetLoader.test.ts` |
| STV | `apps/web/src/features/workspace/tools/scheduled-tasks/ScheduledTasksToolView.component.test.ts` |
| AN | `apps/api/src/modules/analytics/business-collector.test.ts` |
| WK | `apps/api/src/modules/agent/agent.worker.integration.test.ts` |
| AP | `apps/web/src/features/workspace/tools/agent/AgentClientPane.component.test.ts` |
| TD | `apps/web/src/features/workspace/tools/agent/agentToolDetailCache.test.ts` |

### 3.2 创建／派生（14 项）

| ACC | 具体测试定位与主要证据 | 实际结果 |
| --- | --- | --- |
| ACC-CREATE-DEFAULT | T：`all kind/visibility combinations initialize actual state`；四组合逐行检查 Session／RunState／Tab 默认值 | 通过 G:U |
| ACC-CREATE-HIDDEN | VI：`HTTP Fork accepts visibility intent`；MS：`Fork creates actual hidden Tab state atomically` | 通过 G:I/U |
| ACC-CREATE-ATOMIC | T：`Tab or RunState insertion failure rolls back`、`a deferred commit failure`；MS 同上，源图未变 | 通过 G:U |
| ACC-CREATE-REPLAY | V：`preallocated primary identity includes visibility, but never current Tab visible`；S：`old ${mode} snapshot`（两模式×existing/no Session） | 通过 G:U/I |
| ACC-CREATE-CONFLICT | V：`historical expected identity rejects opposite visibility`；S：`${mode} refuses an occupied listed preallocated ID`，计数与 enqueue 不变 | 通过 G:U/I |
| ACC-CREATE-PROJECTION | SQ：`single-session metadata reads complete primary/subtask records`；META：`public metadata route: complete record`；CF：`fork unlisted intent`；WK 内部 read/writeback 契约 | 通过 G:U/I/C/K |
| ACC-DERIVE-MATRIX | V：`creation policy matrix`（parent×source 两值，intent 为 undefined/listed/unlisted） | 通过 G:U |
| ACC-DERIVE-PUBLIC | V：`public and historical Fork use authoritative` 六组合、`stale/forged caller projection`；VI 公开 HTTP Fork | 通过 G:U/I |
| ACC-DERIVE-PATHS | V：`subtask materialization ${path} inherits`（new/resolved/stable/summary/no-boundary×父两值）、`unlisted stable content source` | 通过 G:U |
| ACC-DERIVE-SOURCE | V：`invalid execution binding or missing/cross-workspace content source creates no partial state`；SA：`direct application preserves raw source validation before side effects` | 通过 G:U |
| ACC-DERIVE-EXISTING | VI：`HTTP existing reuse ... exact zero-write rejection`；V：`reuse and activation`，hidden 父→listed 子拒绝且 snapshot 不变 | 通过 G:I/U |
| ACC-DERIVE-SHORTCUT | SA：`existing child Run fast-return`、`activation race rechecks a listed winner`；VI：`HTTP already accepted listed child cannot bypass` | 通过 G:U/I |
| ACC-DERIVE-REVERSE | V：listed 父→unlisted 子的 `reuse and activation`；SA：`listed parent may return an already accepted unlisted child without resetting it` | 通过 G:U |
| ACC-DERIVE-RACE | VI：`two real SQLite connections produce one unlisted child Run`、`real SQLite activation loser rejects a listed winner`；COMP 保留共享历史 | 通过 G:I/U |

### 3.3 发现／通知（11 项）

| ACC | 具体测试定位与主要证据 | 实际结果 |
| --- | --- | --- |
| ACC-DISCOVER-CHOOSER | SD：`continuable excludes hidden before limit+1/cursor`；DH：`HTTP discovery filters before pagination/total/recent`，遍历 limit=2 的全部页 | 通过 G:U/I |
| ACC-DISCOVER-ACTIVITY | SD：`activity candidate/aggregate/total excludes hidden across every kind/status`，全部 kind×status | 通过 G:U |
| ACC-DISCOVER-RECENT | SD：`legacy discovery and recent filter before limit across Workspaces`；DH 真实 recent HTTP | 通过 G:U/I |
| ACC-DISCOVER-OPENED | DH：opened hidden 不进入 continuable/activity/recent，但 tabs 包含；F 两模式确认后重复 chooser | 通过 G:I |
| ACC-DISCOVER-DIRECT | DH：hidden 缺 Tab 仍 GET/timeline/run-state/send/run status；CLIH：`production CLI directly shows, sends, reads, follows and cancels` | 通过 G:I |
| ACC-DISCOVER-WORKSPACE | SQ：`separates workspace 404 from missing/cross-workspace target`；DH wrong Workspace GET；TH ownership errors | 通过 G:U/I |
| ACC-DISCOVER-CORRUPT | SD：`activity candidate/aggregate/total` 保留 listed 缺 RunState 的 stateInvalid；`legacy discovery... recovery still include hidden` | 通过 G:U |
| ACC-EVENT-LISTED | EV：`hidden completions remain internal and directed` 中 listed barrier 对两订阅者恰一次原事件；RL：`only publishes transition` | 通过 G:I/U |
| ACC-EVENT-HIDDEN | EV 同一真实 SSE 测试：hidden opened/closed 均到内部 hub、均未导出到任一全局订阅者 | 通过 G:I |
| ACC-EVENT-FAILURE | EV 注入不存在／错 Workspace／查询抛错后仍能导出 listed barrier；比较输出无私有错误，Run 已 completed | 通过 G:I |
| ACC-EVENT-DIRECT | CLIH：真实 CLI follow 捕获并终结 hidden Run，零 SSE 请求；S accepted replay/reconcile；WK：`scheduled slot starts a real Agent Worker` | 通过 G:I/K |

### 3.4 实际 Tab 状态（8 项）

| ACC | 具体测试定位与主要证据 | 实际结果 |
| --- | --- | --- |
| ACC-TAB-UPDATE | TH：`stores actual visibility for every kind`；T：`exact UPDATE retain each real state row`、四组合默认／投影 | 通过 G:I/U |
| ACC-TAB-SNAPSHOT | TH：`hidden sessions open in the same persistent Tab projection`；DH 比较 items ID 与 opened；F 重新加载真实快照 | 通过 G:I |
| ACC-TAB-COMPAT | T：`project only permitted IDs`；TH：`closed hidden IDs are not enumerated`；shared 精确 opened/兼容属性断言 | 通过 G:U/I/H |
| ACC-TAB-MISSING | TH：`missing Tab state returns a fixed 500 without repair`；T：`missing/orphan/cross-workspace state`；DH 缺 Tab 的实际 send | 通过 G:I/U |
| ACC-TAB-OWNERSHIP | TH：`stable Workspace and Session ownership errors`；T：`missing/orphan/cross-workspace state`，不跨 Workspace UPDATE | 通过 G:I/U |
| ACC-TAB-DELETE | COMP：`removes only a request-owned empty shell`、身份／ownership 全部拒绝族、`compensation Tab delete failure rolls Session and RunState deletion back` | 通过 G:U |
| ACC-TAB-WORKSPACE | WM：`仅清理目标 Workspace 的 Agent 图与 FTS 数据`、`Agent 清理失败时整个删除事务回滚`；SC：`controlled Agent-domain rebuild clears base-domain Tab state`；D 无损升级 | 通过 G:U |
| ACC-TAB-RUN | F 两模式：已受理 Run 保持同一 RunState，经真实开／关而未取消；TH/T 同值 UPDATE 幂等 | 通过 G:I/U |

### 3.5 界面与时序（15 项）

| ACC | 具体测试定位与主要证据 | 实际结果 |
| --- | --- | --- |
| ACC-WEB-FLOW | F：`real HTTP frontend loader/controller opens, restores and closes a hidden ${triggerMode} execution` 两模式；AF：`0037 unlisted 沿普通 Tab 打开` | 通过 G:I/W（HTTP＋组件，非浏览器 E2E） |
| ACC-WEB-SNAPSHOT | VC：`snapshot protects PUT issued before snapshot`、`snapshot before queued open/close completion protects settled confirmation`；AF 草稿迟到快照族 | 通过 G:W |
| ACC-WEB-PENDING | VC：`初始化快照不会覆盖 pending 状态`、`同一 Session 单飞`；AF：`单目标刷新不覆盖 pending 可见性` | 通过 G:W |
| ACC-WEB-NEWCACHE | VC：`快照采集后新学到的缓存保持未知`；AF：`0037 旧快照遗漏后学到的元信息缓存` | 通过 G:W |
| ACC-WEB-FAST | VC：`同一 Session 单飞`、`旧失败后仍按新 intent 补偿`、不同 Session 并行及独立 404 | 通过 G:W |
| ACC-WEB-TIMEOUT | VC：`timeout keeps uncertain commit`、`snapshot captured during a failed PUT`；AF：`0037 picker 取消未知开闭目标不臆造 false 补偿` | 通过 G:W |
| ACC-WEB-CONTEXT | VC：`旧 Workspace 或卸载后的回调`、`ending a context releases identities`；AF：`连续外部打开 A/B`、`picker旧workspace在途PUT可能提交` | 通过 G:W |
| ACC-WEB-DRAFT | VC：`草稿真实化总是显式提交当前意图`；AF：`0037 草稿真实化显式 PUT ${visible}`（true/false） | 通过 G:W |
| ACC-WEB-DRAFT-CLOSE | AF 同上 false 分支及 `关闭创建中的草稿会将关闭意图转交给真实 Session`，确认后迟到快照及刷新 | 通过 G:W |
| ACC-WEB-DRAFT-FAILURE | AF：`0037 草稿关闭 rejected 只提示一次未确认`，原创建一次、初始实际开、无后台补偿 | 通过 G:W |
| ACC-WEB-DRAFT-UNKNOWN | AF：`0037 草稿关闭 timeout-before-commit` / `timeout-after-commit`；VC：`草稿关闭超时不伪造确认`（saved 两值） | 通过 G:W |
| ACC-WEB-DRAFT-INVALIDATED | AF：`0037 草稿在 ${responseAt} 响应前 ${invalidation}`（create/put×workspace/unmount）；VC：`草稿创建响应上下文已失效时不迁移` | 通过 G:W |
| ACC-WEB-INVALID | AF：`0037 tabs 非法 ${invalid}` 九种 malformed 集合／成员／visibility／Workspace；VC：`2xx 回显的 Workspace、Session 或可见值不一致`；TL 缺／非法 visibility | 通过 G:W |
| ACC-WEB-SHARED | AF：`0037 unlisted 沿普通 Tab 打开、另一个客户端刷新恢复`；F 丢弃所有客户端状态后新实例仍读取同一真实后端 | 通过 G:I/W |
| ACC-WEB-INTERACTION | AF 普通 hidden Tab／运行中关闭不请求 cancel；DH hidden 实际 send；F 真实关闭不取消、显式 cancel 可用；AP：`发送和状态轮询间隙保持 Run loading`、`仅工具执行变化时重建列表行`；TD：`completion delta 先到时，旧 detail 晚到不可覆盖` | 通过 G:I/W |
### 3.6 定时执行（11 项）

| ACC | 具体测试定位与主要证据 | 实际结果 |
| --- | --- | --- |
| ACC-SCHEDULE-MODES | SS：`new ${mode} manual, scheduled and skipped declarations share the fixed internal hidden marker`；S：`${mode}/${trigger} uses hidden execution Sessions`（两模式×manual/scheduled） | 通过 G:U/I |
| ACC-SCHEDULE-ANCHOR | S 同上：known hidden source 固定锚点；SR：`historical task validates a scoped source`、`invalidated source anchor fails execution` | 通过 G:I |
| ACC-SCHEDULE-OLD | S：`old ${mode} snapshot with ... Session uses listed identity without resetting Tab`（两模式×已有／无 Session）；SS 旧快照不重写 | 通过 G:I/U |
| ACC-SCHEDULE-DEDUP | RI：`accepted ${visibility} activation replay validates stable identity` 两值；S：`accepted replay checks only stable identity`，非 pristine、不重发 | 通过 G:U/I |
| ACC-SCHEDULE-ID | S：`${mode} refuses an occupied listed preallocated ID before Message/Run/dedup/enqueue`；SR：`unrelated Session occupying the reserved ID is never navigable` | 通过 G:I |
| ACC-SCHEDULE-UNKNOWN | S：`accepted wrong-visibility identity is unresolved`、`genuinely persisted hidden Run survives unknown enqueue`；SV：`unknown enqueue keeps manual execution active`；SR：`conflicting Run links retain task mutex` | 通过 G:I/U |
| ACC-SCHEDULE-STARTUP | SV：`unknown enqueue keeps manual execution active` 明确断言无 Run 的旧重启沿用 startup_interrupted_before_run 且不重发；另有 missing Run references／lookup error 保守处理；S 真实 unknown enqueue；WK startup | 通过 G:U/I/K |
| ACC-SCHEDULE-BADSNAPSHOT | SS：`invalid JSON, visibility markers and necessary snapshot structure`；S：`invalid active snapshots are isolated per execution`、`healthy due task despite ... malformed` | 通过 G:U/I |
| ACC-SCHEDULE-NAV | STV：`scheduled session links retain availability gate and send host intent`；SR unrelated reserved ID；S 两模式／skipped；F 真实 sessionAvailable | 通过 G:W/I |
| ACC-SCHEDULE-LATER | S：`accepted replay checks only stable identity, and execution history stays bound to its Run after ordinary continuation`，后续 Run 不改变原执行结果 | 通过 G:I |
| ACC-SCHEDULE-DELETE | S 同一测试删除已完成任务，Session／Run／Tab／消息／dedup 逐表不变，task/history 删除；原后续 Run 保留 | 通过 G:I |

### 3.7 CLI（6 项）

| ACC | 具体测试定位与主要证据 | 实际结果 |
| --- | --- | --- |
| ACC-CLI-FLAG | CF：`fork unlisted intent and immutable source visibility determine exact result`（来源两值×flag 两值）；VI 真实 Fork 继承 | 通过 G:C/I |
| ACC-CLI-HELP | CF：`fork invalid arguments fail before config or network`；CA：`all connected commands help before invalid values and config`；CP：`built CommonJS entry ... usable help/version` | 通过 G:C |
| ACC-CLI-HEAD | CF：`fork remains anchored to the read head`、`rejects invalid source ... empty head`、`never reselects or retries when the server rejects streaming, tools, compaction or a changed branch`；SR historical anchor | 通过 G:C/I |
| ACC-CLI-UNKNOWN | CF：`fork POST network failure preserves unknown effect`、`fork refuses an unexpected visibility as unknown`、`fork validates new primary session identity and exact source boundary` | 通过 G:C |
| ACC-CLI-ACCEPTED | CF：`fork retains accepted new identity if cookie persistence or stdout fails`；不把源 ID 当作新 ID | 通过 G:C |
| ACC-CLI-DIRECT | CLIH：`production CLI directly shows, sends, reads, follows and cancels a known unlisted Session without global SSE`；`includes Tab-closed listed ... excludes unlisted`；CF 隐藏继承 | 通过 G:I/C |

### 3.8 升级与回退（13 项）

| ACC | 具体测试定位与主要证据 | 实际结果 |
| --- | --- | --- |
| ACC-MIGRATE-REAL | D：`real openDb v23 upgrade with pending=0`、`v23 incremental migration preserves history, run/task identity` 两种 pending；独立 v23 DDL 共享消息／附件／Run／工具／dedup／旧 JSON | 通过 G:U |
| ACC-MIGRATE-STRUCTURE | D：`fresh and upgraded v24 have identical physical columns/constraints`，PRAGMA 全列属性同序、updated_at 后 visibility、default/null/enum 实际写探针 | 通过 G:U |
| ACC-MIGRATE-REOPEN | D 同上 close/reopen，两次 init 禁止 alter/drop/backfill；META：`reopening an existing database preserves Sessions and Tab overrides` | 通过 G:U/I |
| ACC-MIGRATE-TABS | D：`v23 incremental migration preserves history` 中 expectedStates 覆盖有效／无记录／无效／orphan／跨归属，恰每 Session 一行 | 通过 G:U |
| ACC-MIGRATE-ROLLBACK | D：`migration failure at ${phase} rolls back DDL/data/version`（alter/clear/backfill/validate/version），原 v23 可再次启动 | 通过 G:U |
| ACC-MIGRATE-VERSION | D：`malformed v23 source and v24 visibility constraints fail closed`、`version-only upgrades, misplaced visibility columns and damaged v23 FTS fail closed without writes`；SC current semantic damage/unknown version | 通过 G:U |
| ACC-MIGRATE-REPEAT | D current reopen 多次 init；META production reopen 保存用户 Tab override，不重填 | 通过 G:U/I |
| ACC-MIGRATE-CONCURRENT | D：`two concurrent SQLite starters upgrade a real v23 once`；两个真实连接分别观察 current，未进入重建 | 通过 G:U |
| ACC-MIGRATE-PENDING | D pending=0/1 保留标记、real openDb pending=0 留 artifact；SC：`destructive file cleanup ... safely retries pending cleanup` 等原续作测试 | 通过 G:U |
| ACC-MIGRATE-NEW | SC：`new Agent schema exposes Message/Part/Execution`、base-domain Tab；D fresh v24 结构探针；T 四组合创建行 | 通过 G:U |
| ACC-MIGRATE-OLDPROCESS | M：真正预构建 v23 validator 对 v24 拒绝且数据不变，对同点恢复的 v23 接受；第 4 节明确停机要求 | 通过 M；整体部署未执行 |
| ACC-MIGRATE-UIBOUNDARY | TH：`missing Tab state returns a fixed 500 without repair`；DH 缺 Tab 的元信息／run-state／send；SD hidden recoverable Run | 通过 G:I/U |
| ACC-MIGRATE-BACKUP | D：`offline backup and rollback restore the same v23 database and artifact snapshot without relabeling v24`；M 旧 validator 接受恢复副本 | 通过 G:U；M 通过 |

### 3.9 原行为／范围（4 项）及计数

| ACC | 具体测试定位与主要证据 | 实际结果 |
| --- | --- | --- |
| ACC-REGRESSION-LISTED | 完整 U/I/K/W/C 门禁；META listed 元信息、VI listed Fork、MS 原消息／终态、WK 真实发送与取消、CF 原 head/Fork 语义 | 通过 G:U/I/K/W/C |
| ACC-REGRESSION-INTERNAL | SD hidden recoverable candidate；EV hidden 内部完成；VI hidden 父子激活；CLIH/F hidden 真实取消；WK Worker 内部 token、replacement/discard、startup recovery；原路径／Workspace 安全门禁 | 通过 G:U/I/K |
| ACC-REGRESSION-ANALYTICS | AN：`unlisted background Sessions, Runs and model token facts remain measurable without a Tab join`；真实 collector、canonical signal，Tab 缺失也不过滤后台事实 | 通过 G:U |
| ACC-REGRESSION-NONGOALS | R：本阶段只修改第 1.2 节测试和本文／索引，无依赖、ACL、TTL、viewer、配置列、visibility 提升入口或文件复制隔离；原阶段独立审查结论不替代后续整体审查 | 范围核对完成，整体独立审查待办 |

稳定 ID 数量：CREATE 6＋DERIVE 8＋DISCOVER 7＋EVENT 4＋TAB 8＋WEB 15＋SCHEDULE 11＋CLI 6＋MIGRATE 13＋REGRESSION 4＝**82**。文档检查对照 `06-acceptance.md` 的表格首列，要求 ID 集合相等、无重复、无缺失；同一测试可以覆盖多个 ACC，但不会把参数族或重复运行累计成更多场景。

## 4. 隔离升级、旧启动拒绝与回退

### 4.1 自动持久证据

D 使用冻结的 `apps/api/src/infra/db/fixtures/agent-schema-v23.sql`，而非从现版库修改版本号冒充旧库。备份回退测试执行：

1. 生成真实 v23 DB＋固定非敏感 artifact，关闭连接。
2. 在同一静止时点复制 DB＋artifact 为 backup。
3. `openDb` 升级 active 为 v24，核验历史保留，并制造升级后 Session／artifact 变化。
4. 关闭升级连接，将 backup 恢复到另一隔离 restored 目录。
5. 直接打开 restored，核验 version=23、没有 visibility 列、业务行／旧 TabState 完全一致、artifact 回到原内容。

没有降低 v24 版本号；没有在活跃连接下随意拷贝 WAL 库；没有覆盖真实用户库。

### 4.2 实际旧构建 validator 演练（M）

在首次 API 产品 build 之前，工作区已有 `apps/api/dist/infra/db/schema.js`，其实际 `AGENT_SCHEMA_VERSION=23`。将这一**本工作区原有构建产物**原样保存为项目内 `legacy-v23-schema.mjs`，同时保存 SHA-256；未从 Git 获取、未冒充已验证的发布包。

本次保存 artifact 的 SHA-256：`a90ade8569f4f2c15700766ba72ce154537d0dacf7b1d252b2f906d1aa0eb578`。这是内容复核标识，不替代可信发布包来源核验。

运行 `.tmp-tests/0037/release-legacy-rehearsal.mts`：同一旧 `assertAgentSchemaSupported` 接受独立真实 v23 DDL；当前迁移升级后拒绝 v24且不写数据；关闭连接、恢复同点 DB＋artifact 后，该旧 validator 再次接受 v23。日志输出：

```text
PASS: actual pre-build v23 startup validator refuses v24 without writes; same-point DB+artifact backup restores v23 accepted by the same old validator.
```

复核本工作区可直接使用已保存 artifact、hash 和脚本；在干净检出／部署演练中应先取得可信 v23 发布包的同名启动 validator，再按相同步骤运行，不能把当前源码改常量或只改版本号替代旧程序证据。这次没有运行完整旧服务 `main`，证据边界是**真实旧启动 schema validator**，不是旧发布包上线演练。

### 4.3 实际部署／回退操作边界

- 旧进程已经打开 DB 时不会被新增版本检查自动停止，必须先停止所有旧后端／Worker，再进行同一兼容单元升级；不能新旧进程混跑。
- 停机后备份同一时点完整 SQLite 状态与对应 Workspace／artifact 数据；有 WAL 时按受支持的离线／SQLite backup 流程处理，不能遗漏 WAL 或取不同时点的数据。
- 后端、前端、CLI 和 shared/schema 必须整体部署，不能发布本次中途阶段。
- 升级启动如被结构校验拒绝，保留现场，不能自动重建清空历史。
- 回退必须同时恢复匹配的旧 DB＋数据及旧程序。**不得将 v24 版本号手改为 23**，也不得只回退二进制继续使用 v24。
- 真正停机、实际用户备份／恢复、发布包来源核验、生产部署及浏览器设备兼容验收不在本子任务授权范围内，未执行，不能据此宣称生产已升级或已回退。

## 5. 交付与后续门槛

- 原 RELEASE 提交候选为第 1.2 节源码测试文件、本文及本目录 README 索引；H1 增量文件见第 6.4／7.4 节，仍仅三个文件。由首席处理暂存，不得暂存 `.tmp-tests/`、dist 或 cache。
- 第 1 至第 5 阶段均已独立开发、审查通过并由首席暂存；随后全新会话的全面审查及同一审查者的修复复审已经完成，最终通过。最终 H1 修复和文档收尾仍由首席核验后暂存，不据代码审查结论执行生产发布。
- 设计的 82 项场景映射不等于审查已完成；实际门禁、隔离验证和审查状态分别记录，不能互相替代。


## 6. P1 H1 首次修复历史（后续复审未通过）

本节保留首次开发修复与 5453 项门禁的真实历史。随后原审查者发现词法语义碰撞，H1 仍 Open；本节不是最新完整验证，也不能代替第 7 节的修复／再复审。

### 6.1 处置决定与最小实现策略

- **H1 → Fix**：首席复核接受。原 `hasV23SchemaSemantics` 只检查选定片段／外键，未证明完整既有约束。独立 v23 DDL 删除 Session kind CHECK、Workspace FK 或 title NOT NULL 后，即使列名及业务数据均合法，仍可能被接受并升级；`foreign_key_check` 只能发现数据违规，不能证明 FK 定义存在。
- 用 **现有创建 DDL 作为唯一结构权威**，在仅内存的参考连接中物化 pre-visibility v23、fresh v24 和实际 `ALTER ADD COLUMN` 产生的 v24 定义，缓存规范描述后关闭参考连接。不读取真实库生成规范，不引入通用迁移平台或 SQL 解析框架，也不手工再维护一套大型 CHECK／FK 规则表。
- 对 Agent 域、RunState 及 Tab 表的完整 `sqlite_master` 对象集合与定义进行规范匹配：有序列名仍单独严格检查；完整表定义覆盖列类型、NOT NULL、default、PK、全部 FK／动作、UNIQUE、CHECK；同时覆盖隐式 autoindex、关键／部分／唯一索引、FTS 及其 shadow 定义、完整触发器体。缺失、削弱、额外未知定义均不能靠旧片段蒙混通过。
- 首次规范化保留单引号字面量却删除其余空白：虽然上表原约束变体转绿，但后续复审证明它会将不同 token 合并为同一签名，**该比较关系不安全**。本轮已按第 7 节替换，不再以此首次实现声称完整覆盖。
- fresh v24 将 visibility 列声明写在表级 FK 前；真实 ALTER 将其追加在 FK 后。两种参考定义均由同一创建／ALTER 实现物化并接受，实际列序依旧是 `updated_at` 后追加，未放宽逐位置校验。visibility 列定义与 ALTER 共用同一常量。
- 外部 `assertAgentSchemaSupported`、`initSchema` 的 immediate 事务内重新分类、升级后版本更新前／后的目标验证均使用该结构边界。结构不符先拒绝，不启动会写入真实表的语义探针；原 Run／visibility savepoint 行为探针保留且回滚。
- 四个原有 additive Analytics 索引仍可缺省，不因可选性能索引缺失阻断恢复；存在时定义必须规范。Tab **数据**缺行仍只是展示损坏，不提升为启动／执行全局阻断，不在 current 启动补写。未改变 pending、业务历史、旧版本重建策略或合法 v23 的 Tab 规范化迁移策略。

### 6.2 先红后绿与完整负向覆盖

所有负向源均从独立冻结 `fixtures/agent-schema-v23.sql` 变形，不用新 initializer 改版本号伪造 v23。共 **26 类变体 × 3 种结构形态 × 2 个入口＝156 项测试**，每项转绿后分别验证 pending=0／1。结构形态是 v23、fresh 形式 v24、真实 ALTER 形式 v24；入口是外部 preflight 与事务内 init。

覆盖范围：

- H1 三个原始复现：缺 kind CHECK、缺 Session→Workspace FK、缺 title NOT NULL，其他业务行合法；另测缺 kind CHECK 后写入 `invalid-kind`。
- Session 列类型、revision 默认值、boolean CHECK；meta 主键、pending 非空／默认值；override 复合 PK 顺序；Attachment UNIQUE／FK 删除动作。
- kind／message CHECK 的 `or 1=1`＋原片段注释绕过；Run 部分仲裁索引去 UNIQUE／禁用谓词；Session 索引缺失／方向变化；retained 部分索引谓词削弱。
- 触发器保留旧片段但 body 不再 abort、注释掩盖 Workspace 条件、字面量大小写改变；Tab 非空／类型；FTS unindexed 语义。
- 每次拒绝前后比较完整 `sqlite_master`、`schema_version` 及全部真实／FTS shadow 表内容，涵盖版本、pending、Session／Run／消息／附件／任务／Tab；不得留下探针行、半迁移或自动修复。

真实 red→green：

| 步骤 | 实际结果 | 工作区日志／退出状态 |
| --- | --- | --- |
| 仅新增 156 项负向测试，尚未改生产实现 | **0 pass／156 fail**；均为缺少预期拒绝，不是测试夹具建库失败 | `h1-red.log`、`h1-red.status=1` |
| 实现完整规范校验后，同命令重跑 | **156 pass／0 fail**，覆盖每项 pending=0／1 | `h1-green.log`、`h1-green.status=0` |
| 另补兼容与锁内重验 | 2 项通过：可选 Analytics 索引缺失＋current Tab 缺行不修复；成功外部预检后另一连接删关键索引，init 仍拒绝且全量状态不变 | 包含于 `h1-key-gate.log` 与最终根门禁 |

前两步真实命令，从隔离仓库根环境进入 API：

```bash
cd apps/api
node --import tsx --test --test-name-pattern '^H1 ' \
  src/infra/db/schema-v23-migration.test.ts
```

该命令的 red／green 日志产生时尚未添加后述 2 项兼容／重验测试；不得将后补测试计入原始 red 统计。现有合法迁移／fresh／升级／close-reopen、并发升级、immediate／回滚、完整历史、离线备份／回退测试全部保留。

### 6.3 修复后真实门禁

沿用第 2.1 节项目内 TMPDIR／HOME／cache 隔离；没有运行 `.env`、真实库、产品 `main` 或目录外数据。关键组完成后，**先根 `npm run typecheck`，再实际根 `npm test`**，两者及其他外部补测不并发，避免 shared dist 重建与测试竞态。

| 组 | 本轮实际执行与结果 | 日志／状态 |
| --- | --- | --- |
| KEY | schema、完整迁移、cleanup、Tab store／integration、Session 查询／列表、创建／Fork store 共 8 个文件，**324/324** | `h1-key-gate.log`、`.status=0` |
| TC-H1 | 根 `npm run typecheck`，包括 shared build 与全部 workspace 类型检查，退出 0 | `h1-typecheck.log`、`.status=0` |
| G-H1 | **重新执行根 `npm test`，5453/5453**；六个 workspace 均退出 0、killed=false | `h1-npm-test-gate.log`、`.status=0` |
| U-H1 | G-H1 内 API unit：1750＋8＝**1758** | 同 G-H1 |
| I-H1 | G-H1 内 API integration，含真实 HTTP／CLI／Tab 联动：**567** | 同 G-H1 |
| K-H1 | G-H1 内 API integration:worker，真实 Worker gate：**20** | 同 G-H1 |
| B-H1 | G-H1 内 Agent Worker workspace：**1290** | 同 G-H1 |
| W-H1 | G-H1 内 Web：22＋493＋735＝**1250**；30 个组件文件 completed=30、skipped=0、exitCode=0 | 同 G-H1 |
| H-H1 | G-H1 内 shared：**135** | 同 G-H1 |
| P-H1 | G-H1 内 Feishu：**12** | 同 G-H1 |
| C-H1 | G-H1 内 CLI：**421** | 同 G-H1 |

G-H1 各 suite 的 fail／cancelled／skipped 全为 0；本轮总数只累计这一轮根门禁，不叠加 KEY／red／green 或历史 RELEASE 的 5295 项。原 13 项迁移门禁增加本轮 158 项后为 171 项，全部进入根 API unit。

KEY 的实际命令（cwd=`apps/api`）：

```bash
node --import tsx --test \
  src/infra/db/schema.test.ts \
  src/infra/db/schema-v23-migration.test.ts \
  src/infra/db/workspace-agent-data-cleanup.test.ts \
  src/modules/workspaces/workspace-session-tab-state.store.test.ts \
  src/modules/workspaces/workspace-session-tab-state.integration.test.ts \
  src/modules/agent/read-side/sqlite-session-query.test.ts \
  src/modules/agent/read-side/sqlite-session-list-query.test.ts \
  src/modules/agent/agent-message.store.test.ts
```

### 6.4 本轮文件与审查状态

本轮仅修改：

1. `apps/api/src/infra/db/schema.ts`：专用旧／目标完整规范校验，替换片段白名单；共用 visibility 定义。
2. `apps/api/src/infra/db/schema-v23-migration.test.ts`：156 项负向 red→green，加 2 项兼容／锁内重验。
3. `docs/design/0037-unlisted-sessions-and-tab-state/08-implementation-evidence.md`：本节及当前状态边界。

首席告知的 v23 SQL fixture 第 164 行 4 空格删除为 RELEASE 已知格式修正；本轮未修改该 fixture，并用修复前后 SHA-256 一致性确认。未覆盖 DOMAIN／BACKEND／CLIENT／RELEASE 已有实现和测试，未执行任何 Git 命令、add 或 commit。

首次交付后原审查者 `existing` 复审仍未通过，H1 保持 Open；本轮词法修复、重验及等待再复审状态见第 7 节。生产停机备份／发布／回退、真实浏览器兼容等未执行事项仍维持第 4 节边界。


## 7. H1 复审词法边界修复与最新完整验证

### 7.1 Fix 决定与比较关系

- **H1 仍按 Fix 处理**。首席接受复审结论：将触发器条件 `new.previous_message_id is not null` 改成 `new.previous_message_idisnotnull`，SQLite 可建表／触发器，但普通消息 INSERT 才因缺列失败。首次删除空白的比较把两者混为相等，故旧负向组和 5453 门禁不能证明它安全。
- 保留已确认可维护的专用参考定义方案，仅将 `canonicalAgentSql` 改为**小型、受限词法 token 序列比较**，不是通用 SQL 解析／迁移框架，不新增依赖。返回 JSON token 数组而非去空白串：`["is","not","null"]` 与 `["isnotnull"]` 永不相等。
- 只跳过 token **之间**的 SQLite ASCII 空白，只折叠未引用 token 的 ASCII 大小写。识别完整标识符、数值和最长复合运算符，合并／拆分标识符、`>=`／`||`／`->>`／`<<`／`>>` 等不会碰撞；不把未知数字尾缀拆成合法原子。
- 单引号 literal、双引号／backtick／bracket 名称作为不透明 token，内部空白、大小写、反斜杠和 SQLite 支持的成对引号转义原样保留。注释 token 的内容与行边界原样保留（SQLite `--` 仅在 LF／输入结束处终止，CR 仍属于注释内容）；未知 token、未闭合引号／块注释等直接拒绝。发布定义不含 blob literal，`x'00'` 等未支持形式明确拒绝，不能误拆成 `x` 与独立字符串。不会借兼容任意手改 DDL 放松冻结结构。
- 未特判某个字段、未增加业务表运行时探针，也未推翻参考结构／缓存／连接关闭机制。原 kind／FK／列属性等 156 项负例、合法 v23／fresh24／ALTER24、并发／回滚／历史、Tab 缺行不阻断、可选 Analytics 索引边界全部保留。

### 7.2 新增负例、正例及真实 red→green

本轮增加两种有效 SQLite 触发器损坏：

1. `new.previous_message_id is not null` → `new.previous_message_idisnotnull`（原复审复现）。
2. `new.previous_message_id and workspace_id` → `new.previous_message_idandworkspace_id`（同类 AND 边界合并）。

两种损坏 × v23／fresh24／ALTER24 × preflight／init＝**12 项负例**，转绿后每项分别验证 pending=0／1。先播种合法历史数据，再安装损坏触发器，确保确实到达待测入口，而非在夹具 INSERT 阶段失败。拒绝前后沿用完整 schema、`schema_version` 及全部表内容比较，涵盖业务、Tab、版本与 pending，无写入或探针残留。

另加 **8 项纯词法回归＋1 项三形态真实结构正向测试**：标识符／关键字／复合运算符边界；四类引用及转义／内部空白；注释行边界；未知／未闭合形式拒绝；合法发布结构在正常 keyword 大小写与安全空白（包括点、括号、运算符两侧）变化后仍被两个入口接受，成功预检亦无探针残留。

| 步骤 | 实际结果 | 日志／退出状态（均在 `.tmp-tests/0037/`） |
| --- | --- | --- |
| 修正夹具播种顺序后，仅恢复保存的旧比较函数，重放旧行为；finally 恢复本轮实现 | **0 pass／12 fail**，12 项均为 `Missing expected exception`，无建库／INSERT 提前错误 | `h1b-red.log`、`h1b-red.status=1` |
| 新 token 比较函数，原 12 项＋9 项词法／正向回归 | **21 pass／0 fail** | `h1b-green.log`、`h1b-green.status=0` |

真实 red 命令（cwd=`apps/api`）：

```bash
node --import tsx --test --test-name-pattern 'H1 .*trigger token collision' \
  src/infra/db/schema-v23-migration.test.ts
```

真实 green 命令：

```bash
node --import tsx --test --test-name-pattern 'H1 .*trigger token collision|^H1b ' \
  src/infra/db/schema-v23-migration.test.ts
```

最终迁移测试文件为 **192 项**：原 13 项＋首次 H1 的 158 项＋本轮 21 项；负向结构矩阵现在为 28×3×2＝168 项。不得把后补正向／词法测试计入 12 项 red，也不把历史失败当作成功证据。

交付前另审视同类边界，在已有 8 项词法测试中补入仅 CR 不结束 `--` 注释及未知 blob-prefix 拒绝断言，先得到 `h1b-boundary-red.log` 的 **0 pass／2 fail**（`.status=1`），再修正转绿；未新增顶层测试计数。随后**再次从 KEY、根 typecheck、根 npm test 到全产品 build／新编译 validator 全部顺序重跑**。当前不带 `before-boundary` 的 gate 日志均来自这一最终代码；带该后缀的旧成功日志不作为最新证据。

### 7.3 最新真实门禁、产品构建与失败记录

沿用第 2.1 节项目内 TMPDIR／HOME／cache 隔离。关键组、根类型检查、根完整测试、产品构建顺序执行；无额外并发测试／build，不读取 `.env`、真实库或目录外数据，不运行任何产品 `main`。

| 组 | 最新实际结果 | 日志／状态 |
| --- | --- | --- |
| KEY-H1b | 第 6.3 节相同 8 文件关键组，**345/345** | `h1b-key-gate.log`、`.status=0` |
| TC-H1b | 根 `npm run typecheck`，shared build＋全部 workspace 类型检查，退出 0 | `h1b-typecheck.log`、`.status=0` |
| G-H1b | **重新实际执行根 `npm test`，5474/5474**；六个 workspace 均退出 0、killed=false | `h1b-npm-test-gate.log`、`.status=0` |
| U-H1b | G-H1b 内 API unit：1771＋8＝**1779** | 同 G-H1b |
| I-H1b | G-H1b 内 API integration：**567** | 同 G-H1b |
| K-H1b | G-H1b 内 API integration:worker：**20** | 同 G-H1b |
| B-H1b | G-H1b 内 Agent Worker workspace：**1290** | 同 G-H1b |
| W-H1b | G-H1b 内 Web：22＋493＋735＝**1250**；30 组件 completed=30、skipped=0、exitCode=0 | 同 G-H1b |
| H／P／C-H1b | G-H1b 内 shared／Feishu／CLI：**135／12／421** | 同 G-H1b |
| BUILD-H1b | 修复后的 shared、CLI、Agent Worker、**API**、Feishu 依次 build；Web vue-tsc＋隔离真实配置 Vite production build，退出 0 | `h1b-build-gate.log`、`.status=0` |
| BUILT-H1b | 导入本轮新构建 `apps/api/dist/infra/db/schema.js`，实际接受三个合法形态，两个入口拒绝三个损坏形态且全表／schema 不变；另证明损坏触发器普通消息 INSERT 报预期缺列错误而无写入 | `h1b-built-validator.log`、`.status=0`；可复跑 `h1b-built-validator.mjs` |

G-H1b 所有 suite 的 fail／cancelled／skipped 全为 0；5474 只累计这次最终根门禁，不叠加定向、red／green、编译产物 smoke 或历史 5453。最终 sequential gate 可在相同工作区以 `sh .tmp-tests/0037/h1b-run-final-gates.sh` 复跑；该临时脚本依赖按第 2.1／2.4 节生成的隔离环境与配置，不属于提交文件。

本轮产品构建按第 2.4 节的真实配置隔离方案重新生成 `h1b-vite.config.ts`，逐项断言三处替换各出现一次；仅改变副本的 webRoot、空 envDir 的 loadEnv 路径及 `envDir:false`。没有直接运行会读取根环境的原 Web Vite build，也没有沿用旧后端 build 冒称本轮覆盖。全产品构建与第 2.4 节同命令，最后 Vite 的 `--config` 改为 `../../.tmp-tests/0037/h1b-vite.config.ts`。新编译 validator 用真实独立 v23 SQL和隔离内存库，不启动服务或运行真实迁移。

如需复跑编译产物验证（仓库根隔离环境）：

```bash
node .tmp-tests/0037/h1b-built-validator.mjs
```

本轮真实失败记录及处置：

| 记录 | 实际失败与处置 |
| --- | --- |
| `h1b-red-fixture-initial.log`／`h1b-green-fixture-initial.log` | 最初夹具在播种历史前安装坏触发器，INSERT 提前报缺列；改为先播种再安装。它们不作为有效 red 证据；随后仅恢复旧比较逻辑取得上表 12 项缺少预期拒绝。 |
| `h1b-green-initial.log` | 小词法实现初次将单独点号误当数值起始，正例失败；修正数值边界判断，补充／保留正向回归后重验。 |
| `h1b-npm-test-initial.log`、`.status=1` | 根完整测试首次遇既有 Analytics 冷路径耗时 2295ms，超过原 2000ms；随后取消路径因环境无 `ps` 报 ENOENT。不放宽断言、不改产品／runner、不安装或伪造命令；保留失败记录，等待该轮结束后原样重跑整个根 `npm test`，最终 5474 项完整通过。 |
| `h1b-built-validator-initial.log` | 补充 smoke 自身遗漏必填 updated_revision；修正隔离测试脚本后重新导入本轮构建产物通过，未修改产品代码。 |

构建只有既有 Browserslist 数据过期及大 chunk 提示，未升级依赖或改变构建策略。

### 7.4 第二轮增量及交付时状态（历史）

精确修改文件仍为：

1. `apps/api/src/infra/db/schema.ts`：只修专用定义比较函数的词法边界，提供同模块纯函数回归入口；未改变参考定义／缓存／迁移数据策略。
2. `apps/api/src/infra/db/schema-v23-migration.test.ts`：12 项结构损坏负例、8 项词法测试、1 项三形态真实正向测试，以及仅为坏触发器延后安装的夹具适配。
3. `docs/design/0037-unlisted-sessions-and-tab-state/08-implementation-evidence.md`：纠正历史边界并记录本节最新真实证据。

v23 SQL fixture 已知格式修正仍原样保留，本轮前后 SHA-256 一致。该开发子任务未执行 Git、暂存或提交；未覆盖其他阶段现有实现／测试／设计。`.tmp-tests/`、dist、cache 不属于提交候选。

第二轮开发交付时，修复及验证已完成，**H1 当时仍为 Open，等待同一全面审查者 `existing` 再复审**，开发者未自行宣布通过。后续复审已完成，最终结论见下节；第 4 节生产停机备份／发布／回退、真实浏览器兼容等未执行边界不变。

## 最终全面审查结论

### 审查与修复闭环

| 环节 | 独立结论及处置 |
| --- | --- |
| 全新 `mode=new` 全面审查 | 发现 P1 H1：旧 v23 完整结构验证不足；D1 为对应设计差距。首席决定补齐代码，不降低设计要求。 |
| 原 DATA 作者 `existing` 首次修复及原审查者复审 | 补齐完整规范结构验证；复审发现删除空白造成 SQL token 语义碰撞，H1 保持 Open。 |
| 原作者第二次修复及原审查者 `existing` 再复审 | 改为受限词法 token 数组比较，保留完整规范结构门禁；原反例和同类边界复验通过，**H1／D1 Resolved，全面代码审查通过，无其他 Open 项**。 |

### 最终独立复验与完成度

- 最终全面审查者实际独立执行 **498 项关键测试（345＋153），全部通过**，fail／cancelled／skipped 均为 0；API `tsc --noEmit` 与跨端 HTTP/controller integration 显式类型检查均通过。
- 审查者分别对源码及新构建 dist validator 复验原反例和同类损坏：各 **72 次拒绝及状态不变断言**通过；旧 initializer 与冻结 v23 fixture 的交叉验证、实际升级也通过。这些额外复验不与 498 项或开发门禁累计。
- 审查者核查了第 7.3 节根 `npm test` **5474/5474**、全局类型检查、H1 修复后全产品隔离构建及新 dist validator 证据，**未独立重跑根全量门禁**。5474 是开发者实际运行结果，不是审查者测试计数。
- 对照原设计 01—06，CREATE／DERIVE／DISCOVER／EVENT／TAB／WEB／SCHEDULE／CLI／MIGRATE／REGRESSION 均通过最终审查；82 项 ACC 映射已有实质证据支持，未发现剩余代码验收缺口。第 3 节映射保持不变。
- 可维护性审查通过：完整规范结构与有限词法比较保持专用边界，未引入通用 SQL 解析器、迁移框架、额外依赖或永久兼容 fallback。

### 交付与未执行边界

- 第 1 至第 5 阶段已由首席暂存；最终 H1 修复及本次文档状态收尾待首席核验后暂存。子任务未执行 Git，整个任务未提交或推送。
- 真实联动证据为 **HTTP/controller 集成＋Vue 组件测试，不是完整浏览器 E2E**。未生产部署、迁移真实用户库或执行真实停机备份替换／回退；代码与验收审查通过不代表这些操作已执行或获准。
