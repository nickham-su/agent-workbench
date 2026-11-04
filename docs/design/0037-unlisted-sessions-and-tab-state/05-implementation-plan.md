# 开发任务与详细实施步骤

## 执行原则与依赖

- 仅实现本目录确认范围；不引入依赖、ACL、清理平台或通用迁移框架。
- 建议依赖链：数据与契约 → 创建／继承／复用 → 发现／事件／定时执行 → 前端／CLI → 全量回归与发布。
- 每阶段都执行“开发 → 独立源码与测试审查 → 修复 → 原审查者复审”，全部问题关闭才进入下一阶段。
- 阶段是开发审查边界，不是可部署版本。新增字段和必要类型适配同步完成；允许尚未实现的后续业务只在隔离开发环境存在，绝不能对真实用户发布半成品。
- 不把类型检查通过、mock 全绿或设计审查通过等同于真实持久化／集成验收。

## TASK-DATA：契约、显式状态与无损迁移

### 实现内容

- 确认工作区用户改动、当前实际源版本与测试门禁；不读取私有环境配置或输出凭证。
- 更新 shared 的 Session visibility、Fork 可选请求、Tab openedSessionIds 和固定错误码，保留定义好的兼容投影；更新内部重导出和必要编译适配。
- 冻结合法 v23 分类／语义校验；新增专用可升级分类和 v24 目标模型，连通 openDb 的 assert→init 顺序。
- 编写真实 v23 SQL／数据夹具，不用当前 v24 建表后手改版本号伪造旧库。
- 使用 ALTER 在原 updated_at 后追加 visibility；新建 v24 DDL、TARGET 有序列数组与升级库列序完全一致，不放宽 hasExactColumns，也不重建表调整列序。
- 在单写事务完成 visibility 增量、Tab 回填、归属规范化、目标验证和版本更新；校验 NOT NULL、默认 listed 与枚举 CHECK 的真实约束，不能只查数据值；保持 cleanup 标记与执行快照原样。
- 将 Tab 存储从 override 改为实际状态读写，GET 完整性诊断、PUT 单行更新及响应 schema 同步。
- 两个底层创建事务初始化 Tab；删除补偿／回收及 Agent 清空路径配套清理。语义探针和测试工厂也必须构造合法状态。

### 验证命令

以下均从仓库根执行，先构建共享包：

```bash
npm run build -w packages/shared
npm run typecheck -w apps/api
node --import tsx --test apps/api/src/infra/db/schema.test.ts
node --import tsx --test apps/api/src/modules/workspaces/workspace-session-tab-state.store.test.ts apps/api/src/modules/workspaces/workspace-session-tab-state.integration.test.ts
```

### 审查与退出门槛

- ACC-MIGRATE 全组、ACC-CREATE 原子性、ACC-TAB 存储／错误场景有真实 SQLite 证据。
- ACC-MIGRATE-STRUCTURE／REOPEN 必须对比新建 v24 与真实 v23 升级库的有序规范结构，证明两者关闭重开均为 current，第二次启动不迁移／回填。
- 人工审查所有 Session 插入和删除生产点，没有遗漏；升级分支不经过 rebuild／文件清理。
- 缺行异常不通过全局 Session JOIN 或启动数据检查阻断已有运行恢复。
- 记录新增测试在仓库测试收集器内可被发现；测试不能只靠手工执行文件通过。

## TASK-DOMAIN：可见性继承与复用边界

### 实现内容

- 将 parent/source policy 输入传递至真实事务；用窄函数统一继承，保留既有历史图和来源校验。
- 更新 Session 所有 SQL 投影／手工对象投影，尤其 subtask run query、列表列集合和 API adapter。
- 覆盖普通、resolved、stable、historical、new、摘要和无边界降级创建；确保隐藏父和不同内容来源组合均正确。
- 在 existing、已有 child Run、竞争 winner 及预分配匹配路径核对 visibility；补齐原子激活前检查。
- 不把 Tab visible 纳入身份匹配或在重试中重新初始化。

### 验证命令

```bash
npm run typecheck -w apps/api
node --import tsx --test apps/api/src/modules/agent/agent-message.store.test.ts apps/api/src/modules/agent/agent-stable-source-fork.test.ts
node --import tsx --test apps/api/src/modules/agent/session/session-interaction-application.test.ts apps/api/src/modules/agent/subtask/subtask-application.test.ts
node --import tsx --test apps/api/src/modules/agent/subtask/subtask-source-compensation.persistence.test.ts apps/api/src/modules/agent/subtask/subtask-activation.persistence.test.ts
```

### 审查与退出门槛

- ACC-DERIVE 全组通过；使用真实事务或持久化夹具证明拒绝无新 message／Run／dedup／enqueue。
- 所有重用捷径有覆盖；来源不存在、跨 Workspace、已运行 Session、并发 loser 不会被隐藏逻辑误处理。
- listed 行为和已有 Fork 选点／稳定性测试保持通过，不用删除原断言“适配”新实现。

## TASK-BACKEND：发现、完成导出及定时执行

### 实现内容

- 逐调用点分类常规发现、tabs、定向读取和内部扫描，更新候选过滤和兼容投影。
- 全局 SSE 导出检查真实 Session，不改内部生命周期完成发布；补充插件通知边界说明。
- 定时执行内部快照添加新声明标记，解析缺省与非法值；两个模式使用快照预期创建 unlisted。
- 传递 expected visibility 到预分配身份与激活检查；覆盖 dedup 早返回、reconcile、startup 和已有受理未知状态。
- 保留 sessionAvailable 请求→Run 证明、固定锚点、原运行结果及删除任务行为。

### 验证命令

```bash
npm run typecheck -w apps/api
node --import tsx --test apps/api/src/modules/agent/read-side/sqlite-session-query.test.ts apps/api/src/modules/agent/read-side/sqlite-session-activity-query.test.ts
node --import tsx --test apps/api/src/modules/agent/integration/agent-session-routes.integration.test.ts apps/api/src/modules/agent/integration/agent-session-activity-query.integration.test.ts apps/api/src/modules/agent/integration/agent-events-sse.integration.test.ts
node --import tsx --test apps/api/src/modules/scheduled-tasks/scheduled-task.store.test.ts apps/api/src/modules/scheduled-tasks/scheduled-task.service.test.ts apps/api/src/modules/scheduled-tasks/scheduled-task.routes.integration.test.ts apps/api/src/modules/scheduled-tasks/scheduled-task.scheduler.test.ts
```

### 审查与退出门槛

- ACC-DISCOVER、ACC-EVENT、ACC-SCHEDULE 全组通过，包含 SQLite＋Fastify，而非仅 mock SQL。
- 时间／kind／status／total／limit 与 hidden-first 排序夹具交叉验证，避免“返回空一页但后面有 listed”。
- 生命周期扫描及 Analytics 未因 visibility／Tab JOIN 漏掉隐藏活跃任务。
- 新旧执行恢复均不二次发送；原启动 interrupted-before-run 不被顺手改为自动重发。

## TASK-CLIENT：普通 Tab 与 CLI

### 实现内容

- 前端以 openedSessionIds 建立实际状态，不按 kind 默认／兼容数组构造记录。
- 更新完整快照成员合并、未知缓存、草稿转换；保留 metadata reads、epoch、single-flight 和迟到响应保护。
- 草稿转换仅在创建响应上下文仍有效时提交开闭；分别处理创建成功尚未确认、关闭确认、关闭失败／unknown、创建响应上下文失效。保留失效直接返回，不加跨组件补偿，不把未确认关闭写成已持久化。
- 任务已有 openSession 链不分 hidden 特例拒绝，不新增查看器或转换 visibility。
- CLI 注册 --unlisted，更新请求、sessionRecord 校验和输出；保留所有 fork effect／身份／不重试语义。
- 更新 CLI README／help 与必要前端提示，说明共享 Tab、非权限隔离及任务默认隐藏。

### 验证命令

```bash
npm run typecheck -w apps/web
npm run typecheck -w packages/cli
npm test -w apps/web
npm test -w packages/cli
```

- Web 脚本按项目既有方式收集组件及 TypeScript 测试，不将 Vue 组件测试替换为简单 node 模拟。
- 重点现有用例为 `agentSessionTabVisibilityState.test.ts`、`agentSessionTargetLoader.test.ts`、`AgentToolView.component.test.ts`、`useAgentSessionStatusStore.component.test.ts`、CLI fork／help／program 测试。

### 审查与退出门槛

- ACC-WEB、ACC-CLI 全组通过；至少一次真实前后端联动证明打开／刷新／关闭隐藏执行会话。
- Tab PUT 网络超时、快速切换、Workspace 切换及创建中关闭草稿均有可控时序测试；ACC-WEB-DRAFT 系列分别证明关闭确认后刷新不出现、失败／unknown 读取协调、失效上下文无新意图／补偿且不污染新界面。
- 审查不得用“不复活”掩盖未提交关闭：普通 listed primary 初始打开，创建响应前上下文失效时允许后续加载显示；已发请求可能提交，不得断言被销毁组件撤销。
- 新客户端不默默兼容缺失必填字段；旧合法请求和兼容响应字段仍满足本基线。

## TASK-RELEASE：整体回归与验收证据

### 全量门禁

```bash
npm run build -w packages/shared
npm run typecheck
npm test
npm run build
```

- 保持仓库 API unit／integration／worker 测试门禁，不跳过 Worker 集成来宣称全部通过。
- 命令缺少环境前提时记录具体阻塞，补齐后重跑；不能将未执行计为通过，也不能运行会操作真实凭证或生产数据的测试。
- 手工验收使用隔离 Workspace、测试 Provider／工具产物；不得打印真实提示词、私有代码或连接凭证。

### 发布前审查

- 将每个 ACC 场景映射到具体测试名／证据与命令，列出所有新增或修改的旧测试及原因。
- 复查生产代码不存在第二套 kind 默认、delete-to-default、隐藏全局 404、隐藏来源禁令或专用 viewer。
- 复查 schema 分类、事务、幂等快捷返回、迁移失败和旧执行恢复；由独立审查者确认全部关闭。
- 更新实际实施记录，不覆盖本目录的需求来源；设计与实现差异必须先裁决再更新。

### 部署与回退步骤

- 确认源库为可支持 v23、停止旧相关进程、制作同一时点数据库及数据目录备份。
- 整体部署 shared／API／Worker／Web／CLI 兼容产物，启动新 API 完成一次迁移，确认版本、计数、历史引用及 Tab 抽样。
- 启动其余新进程，刷新旧页面，按隐藏任务创建、任务入口打开、刷新恢复及关闭流程冒烟。
- 异常时停止全部新写入，按升级前同一时点备份回退；不得直接降低版本号或新旧混跑。
- 本文只规定实施方法，不授权现在对真实库执行升级、备份替换、提交或推送。
