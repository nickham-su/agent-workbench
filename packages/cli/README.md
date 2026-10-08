# AWB CLI

独立的 Node.js 22 HTTP 客户端，不读取 API 数据库，也不依赖 Worker 注入身份。首版提供 `login` 和通用 `session list`；只有固定可读文本输出，没有 JSON、分页或文件导出模式。

## 本地安装

在仓库根目录执行：

```bash
npm run build -w packages/shared
npm run build -w packages/cli
npm link -w packages/cli
awb --help
```

`npm link` 使用当前 npm 全局 prefix。请先确认该目录可写；遇到 `EACCES`／`EPERM` 时选择用户可写的 prefix，并把其 `bin` 加入 PATH，不要求或自动执行 sudo。link 指向当前 checkout 的 `dist/cli.cjs`，源码修改后需要重新构建。

安装程序和登录是两件事：不同主机、容器、系统用户或 HOME 应分别登录，不会自动共享凭证。

## 使用

```bash
awb --help
awb login --help
awb session list --help
awb login --url http://127.0.0.1:4310
awb session list --workspace workspace-id --updated-within 24h
awb session list --workspace workspace-id --updated-within 7d --kind subtask --status idle
```

开启认证时，`login` 默认从终端隐藏读取 token；非交互环境可用安全输入提供方通过管道配合 `--token-stdin`。不要把 token 放进命令参数、任务文本、日志或 shell 历史。关闭认证时，无需终端或 token，初始化不读取 stdin。

- URL 只接受 HTTP(S) origin，不支持代理子路径、用户口令、query 或 fragment。
- Workspace 和最近更新时间窗口必须显式提供；窗口为正整数 `s/m/h/d`，最多90天。
- kind 为 `primary/subtask/all`，status 为 `idle/running/all`，缺省均为 `all`。
- 每条展示本 Session 的创建时间和最近更新时间（UTC ISO）；Fork 展示自身创建时间。窗口仍仅按更新时间筛选，创建时间不参与筛选、排序或计数。
- 计数是本 Session 原生累计 completed user／assistant，不是窗口内增量，不包含 Fork 继承历史，不读取正文。
- 查询只展示数量，不自动排除名称或低计数会话。

连接配置位于 `~/.config/awb/config.json`，仅保存一个服务器地址及 Cookie，不保存登录 token；POSIX目录0700、文件0600。同一系统用户、HOME和文件系统的终端及Worker可以共用配置。有效续签会在业务输出前原子保存；401仅提示重新登录，不自动交互或重试。

API 与 CLI 应同步升级，默认 Docker 镜像会一起构建发布。创建时间是响应必填字段；包含条目的新旧版本响应可能因严格字段校验退出6，未提供兼容模式。本地仅更新源码后需重新构建 API、shared 与CLI产物。

## Docker 安装

镜像构建时生成 CommonJS单文件。运行程序是 `/opt/awb-cli/cli.cjs`，全局入口是 `/usr/local/bin/awb`；两者可由 `dev` 用户执行。程序不放在 `/home/dev`，避免持久化home卷遮蔽程序或遗留旧版本。配置仍在用户HOME，重建镜像无需清除该卷。

在容器内置终端登录后，Worker的 `bash -lc` 应能通过PATH发现 `awb` 并读取同一用户缓存。宿主机登录不等于容器已登录。

## 构建与测试

```bash
npm run build
npm run typecheck
npm test -w packages/cli
# 真实 Worker 门禁需先有 shared、CLI 和 Worker 构建产物。
npm run test:integration:worker -w apps/api
```

CLI测试会把单个产物复制到项目临时隔离目录，在新Node进程中清除 `NODE_OPTIONS/NODE_PATH`，并禁止非Node builtin模块解析，实际运行help/version。这验证依赖闭包，但项目内隔离不冒称独立容器验收。

当前开发环境未提供Docker／Podman。Docker安装定义可静态检查，实际镜像构建、dev用户PATH、挂载home卷及重建后缓存保留，仍需在具备Docker的环境执行。测试中的PTY和真实API-managed Worker验证宿主环境共享缓存，不替代Docker或Web终端人工验收。

## 输出和退出码

业务结果只写stdout，诊断只写stderr。退出码：0成功，2参数／输入错误，3缓存读取／结构错误，4认证失败，5网络或传输失败，6HTTP／响应契约错误，7缓存保存失败。

正常查询以 `查询结束：已输出 N 个 Session。` 结尾。API和CLI全量输出不代表工具链能收集任意大小结果：已有预览、artifact及bash硬上限可能截断，需结合超限标识和结束标记判断，不能把前缀当完整结果。本次不提高上限或增加隐式分页。
