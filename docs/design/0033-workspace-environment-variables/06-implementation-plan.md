# 开发任务与详细实施步骤

## 执行原则

- 以[需求与决策](01-requirements-and-decisions.md)冻结范围为准，不恢复早期 env 参数、代理同步、cwd 限制或草稿方案。
- 每阶段遵循“开发与自测 → 独立代码审查 → 问题修复 → 复审”，阻断项关闭后进入依赖阶段。
- 改动定位以[代码引用](07-code-references.md)为准；实际文件及阶段状态见[实施与验证记录](08-implementation-and-verification.md)，不将自测等同独立审查。
- 不安装新增依赖，不做全局框架重构。本文命令在仓库根 `agent-workbench/` 执行，已有依赖缺失时报告环境问题，不通过在线命令隐式安装。
- 仅主会话可依用户最新授权，在各阶段独立审查／复审通过后精确 `git add` 对应文件；受托实施者与审查者不执行任何 Git 操作。不得 commit、push、reset、checkout、rebase；未知文件变更保留。
- 用户允许先开发，手动终端验收可后置；不得后置可自动验证的安全、事务和清理检查。

## 阶段依赖

```text
共享契约／实体基础
  → A：API、缓存与删除接点
  → B：bash 接入
  → C：终端启动、定位、握手与恢复
  → D：正式工具 UI
  → E：跨模块回归、审查闭环、用户手动验收
```

UI 可在共享契约和 API 已稳定后独立开发，但最终集成不得用演示存储替代服务。C 的文件／握手基础先于 terminal service 发布 active；不能先放上线注入后补安全清理。

## 阶段 A：契约、数据、API 与缓存

### 共享契约与校验

- 新建公共条目及写入 schema，内部 env 只读响应 schema；TypeBox 生成类型，不在前后端手写另一份。
- 新建环境policy：名称、保护集合、合法Unicode及UTF-8额度、UTF-16备注、空串与NUL规则；按[权威编码约束](02-data-api-and-cache.md#合法-unicode-与字节计量)复用前端/API/缓存/snapshot，不依赖浏览器Buffer，不用TypeBox替代语义校验。
- 公共契约与 policy 从 shared index 导出；内部契约若使用新 subpath，更新 shared package.json 的显式 exports。现有包不支持自动任意内部 subpath，不能只新增源文件就假定消费者能 import。
- 增加 schema／policy 测试，包括边界值、unknown/type严格拒绝和特殊对象键。
- shared build 通过后再修改消费者，避免用旧 dist 类型掩盖契约错误。

### 非 Agent 实体增量

- 在基础schema新增 `workspace_environment_variables`，按[实体设计](02-data-api-and-cache.md#实体与约束)建立FK、大小写唯一约束和索引。
- 同阶段建立 C 所需 `terminal_env_launch_attempts` 的独立表和专用 store基础，或在 C 开始时补幂等创建；不将其放进Git cleanup enum。
- 验证当前受支持旧DB升级、重复初始化、unsupported分类保持及无Agent/任务/Workspace历史改写。
- store按Workspace＋ID操作；事务内持久deletion状态检查与额度验证。

### 服务与路由

- 创建应用实例作用域的环境服务，持有 db、已有主密钥及私有LRU缓存；由Workspace公共／内部路由和terminal服务共享同一实例。
- 实现加密写、按条目CRUD、部分PATCH和启停接口；框架前严格请求校验，不改变全局AJV。
- 明文响应no-store，固定错误映射；不记录原始payload或校验错误值。
- 内部GET归Workspace模块，必须内部鉴权；空配置和故障分开。
- 同步miss查询／解密／填充；所有成功提交后同步失效再返回，无await窗口。

### 删除接入

- 命中路径使用内存deletion fence；确认启动路由注册前恢复durable fence。
- Workspace最终删除提交后同步失效，再释放fence；pending删除保持拒读。
- 不每次命中先调用查库版Workspace查询，不增加跨进程监听或TTL。

### 阶段完成标准

A-VALIDATION、A-STORE、A-AUTH、A-API、A-CACHE相关测试实际通过；明文/密文日志检查通过；独立审查与复审无阻断项。此阶段不宣称bash或终端已生效。

## 阶段 B：Worker 与 bash

- apiClient增加内部环境读取方法，登记controlRead策略、共享响应校验和AbortSignal；不设置Worker二级缓存。
- builtin bash分支按[执行顺序](03-bash-execution.md#执行顺序)在spawn之前读取run.workspaceId覆盖；保持原workdir及公开schema。当前bash已没有Git lease，不恢复旧项目鉴权，也不向独立原生git工具注入Workspace覆盖。
- 通用bash helper新建最终env对象并过滤AWB，不能修改process.env；探测仍不拿Workspace配置。
- 合并Worker基础环境与Workspace覆盖并最终过滤AWB；共享保留字段校验继续生效，原生git既有prepare/release/finally链保持不变。
- 错误固定且不降级；取消分支不继续读取／spawn。
- 增加provider／helper／apiClient测试，包含外部cwd、空串、普通覆盖、代理独立键、环境隔离与读取失败阻断spawn，另回归bash不调用项目Git lease和原生git不受影响。

阶段完成标准：A-BASH/A-SCOPE相关自动项和既有Worker测试通过；工具输入schema没有env，API自身Git链不受AWB过滤改变。

## 阶段 C：终端安全启动与资源恢复

### 协议与定位基础

- 实施[启动尝试实体](04-terminal-launch-and-cleanup.md#启动尝试实体)，定义每个对象arm状态、可信root/dir/file定位和固定错误码。
- 定义payload/status版本schema和有界读取，status保持同inode，attemptId不复用。
- 用既有安全目录fd和身份删除原语实现专用快照writer/cleanup；所有副作用先有creating和intent。
- 按[稳定scope协议](04-terminal-launch-and-cleanup.md#稳定-scope-与退休槽恢复)导出ep/es/ed；每次重试检查业务名和精确授权槽，rename后crash不依赖随机槽名二次落库。不可用cleanupSecureRetiredFiles的泛扫描代替durable定位授权。
- 在secure-directory增加窄removeRetiredEmptySecureDirectory，严格身份和空目录检查后rmdir，不复用递归树删除；补文件rename→unlink和目录rename→rmdir崩溃测试及replacement/marker/多候选/未知后代用例。
- 如现有helper不足，只增加本协议必要的小能力，不机械建立通用artifact框架，不修改Git业务类型和数量。
- 写入0600、目录0700、拒symlink/hardlink/未知对象；对失去身份的崩溃窗口保守pending。

### launcher

- 新建API src的TypeScript固定入口，确保tsc输出distJS；实现source/dist可信解析和固定Node参数。
- launcher自身不应用Workspace PATH/NODE_OPTIONS，payload晚应用于目标shell；argv无值。
- 合并API基准、tmux运行时元数据、现有系统network/Git、Workspace覆盖；最终过滤AWB。
- 目标spawn事件后写spawned，error固定分类；stdio继承、停止信号与退出有界收敛，不依赖execve。
- 对协议、模式、身份、参数和spawn事件进行单测，不把模拟测试作为TTY兼容证据。

### 服务集成

- 在create现有creating骨架内加入准备、launching、等待状态、presence确认、成功清理和激活事务。
- 落实[共同串行边界](04-terminal-launch-and-cleanup.md#终端副作用的共同串行边界)：create整个有界过程保持withMutation；delete、pending/active reconcile、session-stopped settle与Workspace聚合删除使用同WS withAdmission，deletefence存在仍允许收敛。
- pending/active候选入gate重读terminal/attempt与presence；WS旧not_found路径不得直接授权settle。利用ALS同链重入，处理同WS多个terminal顺序await，不Promise.all绕锁；WS不持锁整个连接。
- 用barrier测试Worker每次ready与create等待交错、扫描creating后变active、deletefence后cleanup、WS旧probe、同WS顺序与不同WS并发；不能只以启动时恢复假设保证安全。
- 保留new-session response-loss／indeterminate边界；只按明确条件默认回退，一次新attempt，旧资源先收敛。
- 扩展runtime operations注入必要的prepare/wait/cleanup能力；旧成功fake需显式握手，不能默认newSession空实现即spawn成功。
- create失败、delete、pending reconcile、active不存在、Workspace删除均接新attempt收敛；保留RESTRICT和deletionfence。
- 保持旧Git SSH1/HTTPS2 locator检查和既有逻辑删除兼容；新增env pending必须有明确诊断，不能假称新文件已清完。
- 核对日志路径，防止将原始error/cause、env、shell参数或快照值打印。

### 阶段完成标准

A-LAUNCH/A-TERM/A-CLEANUP与旧response-loss/orphan/Git auth回归通过，launcher产物存在；独立审查复审通过。M-TTY/M-SECURITY/M-FAIL未执行部分仍标记待验收，不阻止继续UI开发，但不能标完整兼容。

## 阶段 D：正式 Vue 工具

- 新建EnvironmentVariablesToolView与API封装，复用正式UI组件和共享校验，不把HTML原型脚本拷入业务。
- ToolId、工具元信息、view props及每处完整Record缺省值补齐 `environmentVariables`；旧Dock恢复补齐而不重置。
- UI按最终原型保留正文标题按钮／表格／侧栏，明文无显隐，无全局保存栏；删除演示数据和演示限制文案。
- 实现真实请求成功关闭、启停失败回滚、请求中防重入、网络结果未确认后的重读。
- 生命周期处理Workspace切换旧响应、销毁、表单取消和焦点恢复；不本地持久化值。
- 增加zh-CN/en-US文案与组件测试，含空态、搜索筛选、多行和旧Dock布局。

阶段完成标准：A-UI相关自动测试通过，实际API串联正确；M-UI尚未执行时记录待验收，不以原型DOM断言代替正式Vue测试。

## 阶段 E：集成、审查与用户验收

- 按[验收矩阵](05-acceptance-and-review.md)逐项登记自动覆盖，运行完整共享、API、Worker、Web测试和类型检查。
- 独立审查跨模块：缓存提交边界、不同Workspace身份、Git保留规则、内部鉴权、一次性文件授权、全部清理入口和日志。
- 修复后复审同一问题，直到阻断项全部关闭；不得以手动待验收覆盖静态缺陷。
- 提供用户M-*短操作清单与测试准备，注明Node/tmux/OS/source/dist版本，使用虚构标记和隔离新终端。
- 实施 `apps/api/tests/manual/terminal-environment-harness.mjs`；严格按[测试harness权威方案](05-acceptance-and-review.md#测试专用-harness-与-socket-隔离)构造临时ctx、PATH wrapper及唯一socket，先证明runTmux/pty attach同socket再做cold/kill；不新增产品socket配置，不import main或读.env.local。
- 如TTY、信号、退出、参数泄漏或资源恢复实测失败，修运行时并复审；不得改成argv传值或削弱清理检查。
- 最终报告区分已实现、自动通过、手动待验收、完整验收；未执行的项目不填通过。

## 已确认的检查命令

以下为现有 package 脚本。A–E 的实际执行结果见[实施记录](08-implementation-and-verification.md)；先按其中“安全运行准备”建立 `safe`。所有命令用 `safe` 启动，完整根测试还使用项目内 no-profile bash wrapper，避免读取主机 profile。

### 共享变更后

```bash
safe npm run build -w packages/shared
safe npm test -w packages/shared
safe npm run typecheck
```

### 分模块检查

```bash
safe npm run typecheck -w apps/api
safe npm run typecheck -w apps/agent-worker
safe npm run typecheck -w apps/web
safe npm run test:unit -w apps/api
safe npm run test:integration -w apps/api
safe npm run test:integration:worker -w apps/api
safe npm test -w apps/agent-worker
safe npm test -w apps/web
```

API `npm test -w apps/api` 还运行既有test gate和全部分组，完整集成阶段不可只执行新增文件。

### 构建与最终回归

```bash
safe npm run build -w packages/shared
safe npm run build -w packages/cli
safe npm run build -w apps/agent-worker
safe npm run build -w apps/api
safe npm run build -w plugins/feishu
safe npm run build -w apps/web -- --config "$verify_dir/vite.safe.config.mjs"
safe npm run typecheck
safe node "$verify_dir/no-profile.mjs" npm test
```

生产验证需确认构建产物无tsx依赖，并在Node20/22实际部署环境执行；不能把当前Node22构建等同Node20运行兼容。

### 实际聚焦测试位置

| 范围 | 实际测试文件 | runner |
|---|---|---|
| 共享policy/schema | `packages/shared/tests/workspace-environment.test.ts` | shared `tests/*.test.ts` |
| API服务与缓存 | `apps/api/src/modules/workspaces/workspace-environment.service.test.ts` | API unit扫描 |
| API鉴权/CRUD | `apps/api/src/modules/workspaces/workspace-environment.routes.integration.test.ts` | API integration扫描 |
| Worker执行 | `apps/agent-worker/src/runtime/tools/providers/builtin.workspace-environment.test.ts`、`apps/agent-worker/src/runtime/bash.test.ts` | Worker providers／runtime 通配 |
| launcher协议 | `apps/api/src/modules/terminals/terminal-env-launch.protocol.test.ts`、`terminal-env-launch.test.ts`（同目录） | API unit扫描 |
| 文件/恢复 | `apps/api/src/modules/terminals/terminal-env-launch.test.ts`、`terminal.workspace-environment.test.ts`（同目录） | API unit扫描及既有terminal.service.test.ts |
| 正式UI | `apps/web/src/features/workspace/tools/environment-variables/EnvironmentVariablesToolView.component.test.ts` | Web既有runner，确认被发现 |
| 空目录退休槽 | `apps/api/src/modules/terminals/terminal-env-launch.test.ts` | API unit扫描，身份与空目录窄helper |
| 隔离harness | `apps/api/tests/manual/terminal-environment-harness.test.mjs`、`terminal-environment-harness.lifecycle.test.mjs`（同目录） | 显式 `node --test`；不加入默认 unit runner |

若需要单文件调试，用已有tsx离线入口，不能让npx缺依赖时自动下载。例如在相关文件实现后：

```bash
safe npm exec --offline -w apps/api -- tsx --test src/modules/workspaces/workspace-environment.service.test.ts
safe npm exec --offline -w apps/api -- tsx --test src/modules/terminals/terminal-env-launch.test.ts
```

测试只写测试数据目录，不修改真实Workspace、凭据、终端或.env.local。

## 回滚与数据保护

- 新表是安全增量；回滚可移除／停用新UI和执行读取接入，但保留配置表、密文、主密钥与资源定位。
- 不通过删配置、清dataDir、重建DB或Agent域完成回滚。
- 已创建的终端不会因移除新UI自动更新；先让尚在creating/cleanup_pending的新attempt安全收敛，再移除运行时处理代码。
- 若要回到完全不识别新attempt表的旧版本，必须先确认无pending尝试；否则旧版本可能无法收敛新资源，不能宣称直接降级安全。
- 配置失效或手动故障时优先修复具体数据／运行时问题，不禁用AWB过滤、内部认证、RESTRICT或身份清理。
