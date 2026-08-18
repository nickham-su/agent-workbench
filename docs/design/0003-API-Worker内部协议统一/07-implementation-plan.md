# 开发任务拆分与实施步骤

## 开发前规则

- 每个小任务只改本目录方案所覆盖的协议边界。
- 不顺便修改 1B、Plugin Host、工具 registry、Runner 状态机或公共 RPC 基建。
- 不改变 endpoint、字段、status、鉴权 header、timeout 和业务错误映射。
- 每个任务完成后运行对应最小检查；发现基线与文档不符先更新代码地图和产品合同，再继续。
- 不执行 Git 写操作；代码开发时也应保持小批次、可回滚。

## 任务清单

### P0-0：冻结基线

- 记录三个 endpoint 的当前路径、method、request、response、status 和错误行为。
- 核对 Socket 和 TCP/fetch 两条调用路径。
- 核对 `workspaceRepoDirNames` 现有测试和归一化行为。
- 运行 shared build、全局 typecheck 和相关现有测试。
- 产出迁移前基线摘要。

完成条件：没有未解释的协议差异；若有差异，先暂停后续任务。

### P0-1：新增 internal contracts

新增：

```text
packages/shared/src/internal-contracts/endpoints.ts
packages/shared/src/internal-contracts/errors.ts
packages/shared/src/internal-contracts/agent-worker.ts
```

要求：

- 只定义 1A 实际 endpoint。
- schema 与当前代码真实字段一致。
- enqueue 的 `workspaceRepoDirNames` 保持宽松兼容。
- response 只定义 `{ ok: true }`。
- 不导出到 `packages/shared/src/index.ts`。

完成后运行：

```bash
npm run build -w packages/shared
```

同时确定生产运行时 schema validator 的调用方式，并为 shared/Worker/API Client 复用同一套 schema 语义；仅生成 TypeScript 类型或使用 `as` 断言不算完成。

### P0-2：增加显式 package exports

在 `packages/shared/package.json` 增加：

```text
./internal-contracts/endpoints
./internal-contracts/errors
./internal-contracts/agent-worker
```

验证：

- shared build 生成三个 JS 和 declaration 文件。
- API/Worker 从子路径导入可以通过 TypeScript 编译。
- 根入口导出列表没有 internal contract。
- 不使用源文件路径绕过 exports。

### P0-3：迁移 health path

- Worker Manager 的 health path 改用共享 endpoint。
- Worker Manager ready probe 继续只按 2xx status 判定 ready，不解析 health body，不接入 strict/warn。
- 在 Worker Server/schema 测试中验证成功 body `{ ok: true }`。
- 不修改 Socket/fetch ready timeout、等待、retry/restart 语义。
- Worker Manager ready 自动化测试不是本次必做；可用现有测试（如有）或主力场景手工验收，不为本次引入 Manager 重构或新的测试架构。

完成后运行 shared build、API/Worker typecheck，并手动确认 Worker ready。

### P0-4：迁移 enqueue request

- Worker Server 以共享 schema 校验已成功解析的未知 JSON。
- malformed JSON 继续由现有 `JSON.parse` 外层 catch 返回 500 message-only body，不改为 400。
- JSON 结构合法但字段非法返回 400 message-only body，且不调用 Runner。
- 保留鉴权先行、现有 normalize 函数和 Runner 调用。
- API Worker Client 使用共享 endpoint 和 request type。
- 保留 Socket/fetch header、timeout 和错误映射。
- 删除重复的边界类型，但不删除 Runner 内部继续需要的类型别名，除非确认无调用方。

完成后运行 Worker Server 测试、API Worker Client 测试和 typecheck。

### P0-5：迁移 enqueue response

- API Client 解析成功 JSON body。
- strict 校验 `{ ok: true }`。
- 实现 warn 模式的局部降级和明显 warning。
- 非 2xx、超时、鉴权失败不受 warn 影响。
- 保持 enqueue 失败的 503 映射。

### P0-6：迁移 cancel

- Worker Server 使用共享 cancel request schema。
- API Client 使用共享 path/request/response 定义。
- 保留 `cancelSession` 的 warning/best-effort 语义。
- strict/warn 对 response schema 失败的处理与合同一致。

### P0-7：分层测试

- 增加 shared schema 最小测试。
- 扩展 Worker Server 现有测试。
- 扩展 API Worker Client 现有测试。
- 不重复建设 HTTP 测试基础设施。

### P0-8：清理和审查

- 全仓搜索三个旧路径字符串。
- 搜索重复 request/response 类型和旧错误字段。
- 检查 shared 根入口未暴露 internal contracts。
- 检查 warn 配置只在 API env/Client enqueue/cancel response validation 使用；health Manager ready probe 不使用该开关。
- 检查 malformed JSON 仍为 500、字段结构非法仍为 400，且既有 HTTP error body 仍为 message-only。
- 检查未改动 1B、Plugin Host、Agent 状态机和进程管理。

## 推荐提交/回滚边界

即使实际开发不要求提交，也建议按以下逻辑小批次组织变更：

```text
批次 A：shared contract + exports
批次 B：health
批次 C：enqueue request/response
批次 D：cancel request/response
批次 E：tests + cleanup
```

每个批次都能单独回退。不要把所有协议、RPC 基建和业务重构放在同一批次。

## 每批次最小检查

- `npm run build -w packages/shared`
- `npm run typecheck -w apps/api`
- `npm run typecheck -w apps/agent-worker`
- 对应单元/Server/Client 测试
- 若涉及主流程，完成一次真实场景检查

## 代码审查清单

### 范围

- [ ] 只涉及 health/enqueue/cancel。
- [ ] 没有新增独立 workspace。
- [ ] 没有改动 1B、Plugin Host、工具全量协议或 Agent 状态机。

### 协议

- [ ] path/method 来自 `endpoints.ts`。
- [ ] request/response schema 来自 `agent-worker.ts`。
- [ ] 根入口没有 internal 导出。
- [ ] endpoint、字段、status 和 null 语义保持现状。
- [ ] `workspaceRepoDirNames` 没有被收紧为严格 `string[]`。

### 校验

- [ ] Worker Server 在鉴权后校验 request。
- [ ] API Client 校验关键 response。
- [ ] strict 是默认值。
- [ ] warn 只影响 response schema 失败且有明显 warning。
- [ ] warn 不绕过 request、鉴权、status 或业务逻辑。

### 行为

- [ ] enqueue 仍调用现有 normalize 和 Runner。
- [ ] enqueue 失败仍映射当前 503。
- [ ] cancel 失败仍 best-effort。
- [ ] Socket/fetch、timeout、header、Worker restart 行为无变化。

### 测试

- [ ] shared schema 测试通过。
- [ ] Worker Server 测试通过。
- [ ] API Worker Client 测试通过。
- [ ] 主力 health/run/cancel 手测通过。
- [ ] 未通过删除或放宽既有断言来“修复”测试。
