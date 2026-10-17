# 接口、实体与模块设计

## 对外接口（拟新增）

```http
POST /api/workspaces/:workspaceId/files/extract
Content-Type: application/json

{"path":"downloads/demo.tar.gz"}
```

- 仅允许 Workspace 相对源文件路径。目标目录由后端计算，不接受 `destination`、`overwrite`、`merge`、`password` 等控制参数。
- 请求 `path` 必须已经规范：非空、仅 `/` 分隔，无空段、`.`、`..`、前尾 `/` 或重复 `//`，并遵守[源路径唯一规则](02-format-path-and-limits.md#源请求-path必须已经规范)。在选择 Workspace/仓库区域前校验，不规范不修正后继续。
- 保留合法前后空格，不沿用旧操作 `.trim()`；源目录、链接、FIFO 等非普通对象拒绝，打开还必须 no-follow/nonblock 并 fstat 复核，避免无写端 FIFO 阻塞槽与锁。
- 本接口沿用现有 HTTP 认证与 Workspace 可写生命周期，不新增匿名/内部旁路；不暴露到 Worker 高权限控制面。
- schema 使用共享 TypeBox 契约直接注册到 Fastify，并登记成功与所有约定错误状态，维持 OpenAPI 可用。
- 请求中的额外属性不产生行为；按项目当前 AJV 额外属性处理设置拒绝或剔除均不改变目的地。测试必须证明不能通过额外字段开启覆盖/改目标，不能假定框架一定报错。

### 成功响应

```json
{
  "path": "downloads/demo.tar.gz",
  "dir": "downloads",
  "format": "tar-gzip",
  "topLevelCount": 2,
  "fileCount": 3,
  "directoryCount": 1,
  "extractedBytes": 1024
}
```

| 字段 | 语义 |
|---|---|
| `path` | 校验通过的原规范 Workspace 相对源路径，不再二次改写，不是绝对路径 |
| `dir` | 从同一规范 path 得到的相对父目录；Workspace 根为 `""` |
| `format` | `"zip"`、`"tar"`、`"tar-gzip"`；`.tgz` 与 `.tar.gz` 统一 |
| `topLevelCount` | 本次清单中不同顶层节点数量 |
| `fileCount` | 实际输出普通文件数 |
| `directoryCount` | 实际输出目录数，包含隐式目录，不含目标父目录/结构性根/暂存目录 |
| `extractedBytes` | 成功发布普通文件的实际内容字节之和 |

- 响应不返回全部文件/条目列表，避免大量路径放大 HTTP 响应；不返回任务 ID、临时路径、绝对路径、内容或摘要。
- 无需持久化任务实体与数据库表，无迁移。请求结束后，仅保留正常日志和文件系统结果。
- 合法空包响应计数全零。发生错误不返回“部分成功”的 200。

### 共享契约

- 在 `packages/shared/src/contracts/workspace-files.ts` 增加 `WorkspaceFileExtractRequestSchema` / `WorkspaceFileExtractRequest`、`WorkspaceFileExtractResponseSchema` / `WorkspaceFileExtractResponse`。
- `path` schema 固定为 `Type.String({ minLength: 1, maxLength: 4096 })`，按 schema 字符计数；schema 先失败沿用框架校验错误，不保证本功能业务 code。
- schema 通过后服务层验证源路径 UTF-8 总长 <=4,096 字节、每段 <=255 字节及规范路径规则；超限统一 `ARCHIVE_PATH_INVALID`（400）。包内输出路径超额另为 413，不混淆；OS 更严格的绝对路径限制按 IO 分类。
- 响应计数字段均为非负安全整数，具体上限以资源规则对应指标为准。
- 增加小型 `packages/shared/src/workspace-archive-formats.ts`，权威维护支持后缀、优先级、格式类型及纯函数 `detectWorkspaceArchiveFormat(name)`；从 `src/index.ts` 导出。
- 前端菜单与后端选择解析器复用该函数；内容解析和安全配额留在后端，不把服务实现带入共享包。

## 错误契约

继续使用现有 `ErrorResponseSchema`：`{ message: string, code?: string }`，不改全局错误结构。以下本功能可控错误必须有稳定 `code`，`message` 为固定、安全、可展示说明，不透传第三方异常的路径/内容。

| HTTP | code | 原因与行为 |
|---:|---|---|
| 400 | `ARCHIVE_PATH_INVALID` | 服务层源规范/UTF-8字节/段长校验失败，或源对象非普通文件（含无写端 FIFO） |
| 400 | `ARCHIVE_FORMAT_UNSUPPORTED` | 后缀不支持 |
| 400 | `ARCHIVE_INVALID` | 库报告的格式/截断/长度错误、内容 CRC/外层 gzip 错误、非法数字、TAR 流 gzip 前缀；不扩大为全部原始结构必检 |
| 400 | `ARCHIVE_FEATURE_UNSUPPORTED` | 本功能从公开条目判断的加密/分卷/不支持方法；库先拒绝时按 ARCHIVE_INVALID |
| 400 | `ARCHIVE_ENTRY_UNSUPPORTED` | 归档链接/特殊类型、非超额 ignoredEntry、meta 中保守 sparse 标记 |
| 400 | `ARCHIVE_ENTRY_INVALID` | 本功能检查公开条目发现路径非法、`.git`、重复文件、文件目录冲突或 FS 别名；库在回调前自行拒绝仍按 ARCHIVE_INVALID |
| 403 | `ARCHIVE_PERMISSION_DENIED` | 源读取/目标写入/权限设置失败 |
| 404 | `ARCHIVE_SOURCE_NOT_FOUND` | 源文件在安全解析时不存在 |
| 409 | `ARCHIVE_TARGET_CONFLICT` | 任一顶层已有对象，或发布排他原语遇到并发创建 |
| 409 | `ARCHIVE_SOURCE_CHANGED` | 源身份/版本变化或源路径被替换 |
| 409 | `ARCHIVE_TARGET_CHANGED` | 父链/目录身份或本次文件版本异常变化；含同 inode 同长度但 mtime/ctime/mode 改变 |
| 409 | `ARCHIVE_FILESYSTEM_UNSUPPORTED` | 跨设备、hardlink/权限/身份原语不足；不降级覆盖或普通复制 |
| 413 | `ARCHIVE_LIMIT_EXCEEDED` | 归档输入/输出/单文件/可观察条目/元数据/输出路径等超额；含明确的超额 TAR 元数据 ignoredEntry，不含源请求 path 超限 |
| 408 | `ARCHIVE_TIMEOUT` | 可协作处理期限到达，停止处理并完成清理后返回 |
| 429 | `ARCHIVE_BUSY` | 进程已有解压操作，立即拒绝；不自动排队/重试 |
| 507 | `ARCHIVE_STORAGE_EXHAUSTED` | 空间或 inode 不足 |
| 500 | `ARCHIVE_IO_FAILED` | 其他已分类 IO 失败 |
| 500 | `ARCHIVE_CLEANUP_INCOMPLETE` | 输出或临时产物无法安全清理；提示可能有残留，需人工确认 |

- Workspace 不存在、删除中、路径失配等已有错误沿用现有状态/code，例如 `WORKSPACE_DELETING`、`WORKSPACE_PATH_INVALID`；不转换成格式错误。
- 语义优先级：框架 schema 先校验；服务层源字符串规则在区域选择/槽位前验证，然后按既定 admission 解析并安全打开源，再读取格式；完整校验后才做最终顶层冲突。schema 失败可能没有业务 code，不转换/修改全局校验 handler。
- 处理中首次业务错误为原始原因；随后无法安全清理则对外 `ARCHIVE_CLEANUP_INCOMPLETE`，保留原 code 到安全日志。发现文件同 inode 同长度改写时停止，保留异常节点，不以尺寸不变继续 commit。
- 编码按库标准解码，不增加无法确定触发的编码专用错误码；库在公开条目回调前报错统一 `ARCHIVE_INVALID`，不从第三方 message 猜危险路径/编码类别；条目回调内由本功能明确判断的路径/类型/特征/额度按表分类，不猜 GBK。
- 发布已经完成但暂存清理失败同样返回清理不完整，消息须明确“文件可能已解压，存在未清理内容，请刷新确认”，不得表示输出已全部撤销。
- 第三方库未预期异常应在归档边界转换为安全错误，并记录固定分类；不把原始 archive entry 名、绝对路径、文件内容或原始第三方异常对象写入普通日志。
- 日志可含 request ID、Workspace ID、阶段、错误 code、计数、耗时、清理是否完成以及系统 `errno`；只输出一条汇总失败/清理记录，不逐条目打日志。

## 内部实体（仅请求内存）

```ts
type ArchiveFormat = "zip" | "tar" | "tar-gzip";

type ArchiveTarget = {
  workspaceId: string;
  domain: { kind: "workspaceRoot" } | { kind: "repo"; dirName: string };
  rootAbs: string;
  sourceRel: string;
  sourceAbs: string;
  parentRel: string;
  parentAbs: string;
};

type PlannedNode = {
  rel: string;             // payload/最终父目录下的规范化相对路径
  kind: "file" | "dir";
  explicit: boolean;       // 目录是否有显式声明
  bytes: number;          // 目录为 0；文件为实际输出
  finalMode: number;      // 仅规范化后的权限
};

type OwnedNode = {
  rel: string;
  kind: "file" | "dir";
  dev: bigint;
  ino: bigint;
  mode: number;          // 当前预期的受限权限，不直接取 archive mode
  size?: bigint;        // 文件必填
  mtimeNs?: bigint;     // 文件必填
  ctimeNs?: bigint;     // 文件必填
  nlink?: bigint;       // 内部别名操作记账，不代替身份/版本核验
  knownChildren?: Set<string>; // 目录必填，不采用不可变 mtime/ctime
};
```

- inode 身份来自 bigint stat，不能经不安全 number 丢精度。内部绝对路径不得序列化到 HTTP 或普通日志。
- 请求上下文还包含清单映射、所有权登记、同 inode 的暂存/最终已知别名、源快照版本、父目录身份、可观察配额计数、deadline、阶段、是否 commit。无需泛型框架、全量内容 hash、数据库或持久化 manifest。
- 文件内容校验在流中完成；清单保存路径、类型、计数和身份，不保存文件内容。
- 文件与目录的核验字段、本次 chmod/link/unlink 的全部存活别名基线更新，以[所有权规则表](04-staging-publication-and-failure.md#所有权版本与本次操作基线)为准；不能仅 dev/ino/size 就 commit。
- 目录所有权不代表拥有其后来出现的所有子项；回滚协议必须逐项处理。

## 模块职责与依赖

| 层 | 拟新增/修改 | 职责 |
|---|---|---|
| 共享包 | 契约及格式纯函数 | 同一后缀规则、请求/结果类型，不包含 FS 逻辑 |
| 路由 | `workspace-files.routes.ts` | schema、错误状态、调用服务；不在 handler 内实现归档算法 |
| 业务服务 | `workspace-files.service.ts` | Workspace/仓库区域解析、路径保护、生命周期与区域锁、调用解压实现 |
| 专用实现 | `workspace-archive-extract.ts`（拟新增） | 输入快照、格式适配、配额、清单、发布/清理；必要时按安全边界拆出路径/发布辅助文件 |
| ZIP 适配 | 上述专用实现的独立函数 | lazy ZIP、名称/CRC/特征校验，不套用 TAR 流协议 |
| TAR 适配 | 上述专用实现的独立函数 | gzip/TAR、有效头与元数据限制、逐流消费 |
| Web API | `shared/api/api.ts` | `extractWorkspaceArchive`，保留 `ApiError.code/status` |
| 文件工具 | 树组件、ToolView、小型纯函数/操作辅助 | 菜单、快照、防重入、scope、提示、刷新及测试接点 |
| i18n | 中英文 `files` 文案 | 菜单、处理中、空包、未知结果、刷新失败及错误码映射 |

- API 运行时直接依赖路线已确定：`yauzl`、`buffer-crc32`、`tar`；源码基线分别为 3.4.0、1.0.0、7.5.22（2026-10-16 主会话只读核验）。实施前仍核对公告、许可证、类型和相容版本；升级不改变不变量。
- 不使用 `tar-stream`；它目前作为其他包的间接依赖不需要为本功能删除或提升。`archiver` 只负责既有下载 ZIP，不能用于解压。
- TAR 专用适配只用 `Parser` 公开事件/abort 和流接口，外层 gzip 一次解压、前缀防二次 gzip、TAR 字节层、entry/ignoredEntry/meta 配额均显式实现，不调用 tar.x/t、不使用私有 Symbol。
- `node:zlib`、FS、stream、crypto 使用 Node 内置模块。生产运行不调用外部命令，不增加 Docker apt 包。
- ZIP、TAR 共享的是最终路径/清单/配额和发布安全规则，不建立“所有格式一样”的泛型解析框架。
