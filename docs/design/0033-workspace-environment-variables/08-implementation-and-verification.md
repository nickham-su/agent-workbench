# 实施状态与实际验证记录

## 状态与交付边界

| 阶段 | 实施与验证状态 | 审查状态 |
|---|---|---|
| A：共享契约、数据、API、缓存 | 已完成 | 阶段独立审查通过 |
| B：Worker bash | 已完成；保持 bash 与 Git lease 解耦 | 阶段独立审查通过 |
| C1：文件协议、launcher、精确恢复 | 已完成 | 阶段独立审查通过 |
| C2：终端服务、共同 admission、恢复与受限 fallback | 已完成 | 阶段独立审查通过 |
| D：正式 Vue UI | 已完成；不是原型 DOM 替代实现 | 阶段独立审查通过 |
| E：隔离 harness、真实运行矩阵、完整回归和本记录 | 已实现并完成下列自测 | 阶段独立审查通过 |
| 最终全面审查 | 已由 new 会话独立完成 | 通过，无高／中／低优先级需修复项 |
| 用户手动与部署验收 | 真实浏览器、Node20、其他平台及完整人工／部署仍待验收 | 不宣称完整验收通过 |

本阶段没有修改产品业务代码，没有安装依赖，没有执行 Git 操作；只新增四个测试专用脚本并同步设计文档。主会话在各阶段审查通过后按授权精确暂存；受托实施者不代替独立审查者。

## 最终全面独立审查记录

各阶段独立审查均已通过，最终全面审查另由 new 会话独立完成并通过。以下是独立审查者的实际执行与只读核验记录，不是本次文档更新者重跑的结果：

- 独立执行 78 项：shared／service／protocol 25 项、harness pure 5 项、Worker env 21 项、UI 27 项，零失败／skip。
- shared／API／Worker／Web 共 4 项 noEmit 类型检查通过；内存 Fastify 接口探针通过。
- 只读核对既有根回归 3744 项及 11 份成功 harness 证据，没有重跑这些完整回归／harness 场景。
- 确认已批准差异合理：bash 无 Git lease、native Git 不注入 Workspace 环境、envDir:false 等价构建、固定 Worker fixture 非 LLM 端到端、cold 由最后一个授权 session 退出；Node20／真实浏览器等未验收边界保持不变，无需扩展实现。
- 无高／中／低优先级需修复项；审查通过不等于完整人工／部署验收通过。本次仅同步文档状态，未新增业务测试或部署结果。

## 实际运行环境

- Node `v22.23.3`，tmux `3.3a`，Linux/x64，kernel `5.15.0-191-generic`。
- source 和 dist 均动态调用真实 `createApp`，不 import main、不加载 dotenv、不读取真实 `.env.local`。
- 每次创建独立 `.tmp-tests/te-<随机>/`：HOME、TMP、SQLite、测试 Workspace、tmux 配置／socket、Worker socket／端口。主密钥和 internal token 随机生成、只留内存、不打印。
- dist 入口没有 tsx／loader；source 在脚本内注册已有 tsx。两种模式的 managed Worker 都使用已构建的 dist。
- 没有真实浏览器操作；Web 组件结果和真实 WebSocket／PTY 结果分别记账，不冒充浏览器验收。

## 构建、类型检查与完整回归

以下命令实际在仓库根执行，均通过。实际使用项目内受控启动器：

```bash
node .tmp-tests/workspace-environment-a/run-safe.mjs <命令及参数>
```

该启动器固定项目内 HOME、短 TMP、npm cache／空 npmrc／日志、offline，并不继承 AWB／NODE_OPTIONS／NODE_PATH。根测试再使用 B 阶段项目内 bash wrapper，保留产品 `-lc` 参数但追加 `--noprofile --norc`，不读取主机 profile。上述 `.tmp-tests` 文件不随代码交付；新 checkout 的等价准备见下节。

| 检查 | 实际命令（省略上面的启动器前缀） | 结果 |
|---|---|---|
| shared／CLI／Worker／API／Feishu 构建 | 分别 `npm run build -w packages/shared`、`packages/cli`、`apps/agent-worker`、`apps/api`、`plugins/feishu` | 全通过 |
| Web 构建 | `npm run build -w apps/web -- --config ../../.tmp-tests/workspace-environment-d/vite.safe.config.mjs` | 通过；仅既有 chunk／Browserslist 提示 |
| 全仓类型检查 | `npm run typecheck` | 通过 |
| 完整根回归 | `node .tmp-tests/workspace-environment-b/run.mjs npm test` | 3744 项通过，零失败／skip |
| E 显式测试 | `node --test apps/api/tests/manual/terminal-environment-harness.test.mjs apps/api/tests/manual/terminal-environment-harness.lifecycle.test.mjs` | 8 项通过，零失败／skip |
| 脚本语法 | `node --check` 检查 harness 与 Worker fixture | 通过 |

根回归包含 API test gate 及全部分组，不是仅挑选新增测试：

| 模块 | 通过数量 |
|---|---:|
| API unit（1202 + 8） | 1210 |
| API integration | 422 |
| API Worker integration | 20 |
| Worker | 1117 |
| Web（20 runner + 359 普通 + 403 组件） | 782 |
| shared | 130 |
| Feishu | 12 |
| CLI | 51 |
| 合计 | **3744** |

E 的 8 项位于 manual 目录，不计入上述 3744：5 项参数／引用／路径边界测试，3 项真实生命周期测试（dist 拒绝 loader、占用端口不连接其持有者／不启动 Worker、默认手动 UI 真实预检后 SIGINT 清理）。手动模式退出码 130，且 `verificationPassed=false`，避免把未操作的 UI 记为完整验收；最终该项证据为 `.tmp-tests/te-mNM1T4/result.json`（clean=true、pendingAttempts=0）。

本地日志：`.tmp-tests/workspace-environment-a/logs/e-root-test.log`、`e-typecheck.log`、`e-web-build.log`。日志和证据目录不提交。完整根回归针对未变化的 A–D 产品代码执行；随后 E 测试脚本的细化由显式测试及真实矩阵复跑覆盖。

## 安全运行准备

前提：已有项目依赖、真实 tmux、可工作的 node-pty；不在线安装。以下是新 checkout 可自行生成的等价本地配置，不依赖当前忽略目录中的旧脚本。仅在仓库根执行；不要使用默认 Web／根 build，原 Vite 配置会加载仓库 env。

```bash
umask 077
mkdir -p .tmp-tests
verify_dir="$(mktemp -d "$PWD/.tmp-tests/ev-XXXXXX")"
verify_tmp="$(mktemp -d "$PWD/.tmp-tests/t-XXXXXX")"
mkdir "$verify_dir/home" "$verify_dir/cache" "$verify_dir/logs"
: > "$verify_dir/empty.npmrc"
: > "$verify_dir/global.npmrc"
safe() {
  env -i PATH="$PATH" LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC TERM=dumb \
    HOME="$verify_dir/home" TMPDIR="$verify_tmp" TMP="$verify_tmp" TEMP="$verify_tmp" \
    npm_config_cache="$verify_dir/cache" npm_config_userconfig="$verify_dir/empty.npmrc" \
    npm_config_globalconfig="$verify_dir/global.npmrc" npm_config_logs_dir="$verify_dir/logs" \
    npm_config_offline=true npm_config_yes=false npm_config_update_notifier=false \
    GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL="$verify_dir/home/.gitconfig" "$@"
}
cat > "$verify_dir/vite.safe.config.mjs" <<'JS'
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../apps/web');
export default defineConfig({
  root, envDir: false, plugins: [vue()],
  resolve: { alias: { '@': path.join(root, 'src') } },
  define: { __DEV_API_TARGET__: JSON.stringify('http://127.0.0.1:4310') }
});
JS
cat > "$verify_dir/no-profile.mjs" <<'JS'
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bin');
mkdirSync(bin, { mode: 0o700 });
writeFileSync(path.join(bin, 'bash'), '#!/bin/sh\nexec /bin/bash --noprofile --norc "$@"\n',
  { mode: 0o700, flag: 'wx' });
const [command, ...args] = process.argv.slice(2);
const result = spawnSync(command, args,
  { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: 'inherit' });
process.exit(result.status ?? 1);
JS
```

目录随机新建，文件只写该目录。`no-profile.mjs` 一次性使用，重复完整回归需重新准备目录，不覆盖未知文件。此配置禁用 envDir，保留正式 Vue plugin、alias 和 DEV_API_TARGET；不 import 原 Vite 配置。Node20 的正式验收仍需切换真实 Node20 后重建／实跑，不以这些准备步骤宣称通过。

上述准备代码块已实际抽取执行：独立空 user/global npmrc、等价 Web 构建和 dist／Worker harness 通过，附加证据为 `.tmp-tests/te-ZWLf8F/result.json`；no-profile wrapper 的真实 `bash -lc` 探针亦通过。该附加运行不替代下表带 5 秒 hold 的基础矩阵。

按 [实施计划的构建与最终回归](06-implementation-plan.md#构建与最终回归)执行构建，然后：

```bash
safe node --test apps/api/tests/manual/terminal-environment-harness.test.mjs \
  apps/api/tests/manual/terminal-environment-harness.lifecycle.test.mjs
safe node apps/api/tests/manual/terminal-environment-harness.mjs \
  --mode dist --verify --with-worker --hold-launch-ms 5000
safe node apps/api/tests/manual/terminal-environment-harness.mjs \
  --mode source --verify --with-worker --hold-launch-ms 5000
for mode in source dist; do
  for fault in file-retire-crash directory-retire-crash status-timeout kill-failed; do
    safe node apps/api/tests/manual/terminal-environment-harness.mjs \
      --mode "$mode" --verify --with-worker --fault "$fault" || break 2
  done
done
```

## 真实运行矩阵及证据

以下十次均带 `--with-worker --verify`，基础场景另带 `--hold-launch-ms 5000`。每个 `result.json` 均已核对：`isolated=true`、`clean=true`、`verificationPassed=true`、`pendingAttempts=0`。

| 模式 | 场景 | 项目内证据 |
|---|---|---|
| dist | 正常／延长窗口 | `.tmp-tests/te-jW4d7f/result.json` |
| source | 正常／延长窗口 | `.tmp-tests/te-dALpYs/result.json` |
| dist | file-retire-crash | `.tmp-tests/te-Aurvxk/result.json` |
| dist | directory-retire-crash | `.tmp-tests/te-3rQsh4/result.json` |
| dist | status-timeout | `.tmp-tests/te-3rVGso/result.json` |
| dist | kill-failed | `.tmp-tests/te-sdG9by/result.json` |
| source | file-retire-crash | `.tmp-tests/te-zLCwp7/result.json` |
| source | directory-retire-crash | `.tmp-tests/te-BJRpXn/result.json` |
| source | status-timeout | `.tmp-tests/te-YAkCeh/result.json` |
| source | kill-failed | `.tmp-tests/te-RmPIJ9/result.json` |

实际动作与边界：

- API 创建、has-session／list-clients，PATH wrapper 与真实 tmux 显式 `-S` 列表一致；生产 WebSocket 路由经 node-pty attach 到同一独立 socket。核对 socket inode／uid、server PID／pane PID 后才授权 kill。
- 验证普通覆盖、空串、CR/LF、中文／emoji、字面 `$PATH`／`$(...)`、大小写代理独立、最终 AWB 过滤；刻意配置非法 NODE_OPTIONS／虚构 NODE_PATH，证明 launcher 晚应用环境。观察程序仅在自身命令中清除这两项以读取 shell 环境，不改变产品值。
- 改配置后新 shell 读新值，旧 shell／断开重连仍旧值；hot 复用 server，cold 经最后一个 session 退出自然停止并核对新 PID。没有操作默认 socket。
- 真实 PTY 中文输入、27×96 resize、Ctrl+C、Ctrl+Z／jobs／fg、后台任务完成、shell `exit` 与 terminal 记录收敛。WebSocket 屏幕 diff 不能当行流，必要时只读取已归属 pane 的 capture-pane 文本，不打印内容。
- 延长窗口内校验私有目录 0700、payload/status 0600、uid／nlink／非 symlink、launcher/shell argv 不含虚构值；dist argv 不含 tsx。成功后 attempt 和启动文件清空。
- file／directory retire crash 在真实 rename 后注入错误，先证明退休槽和 durable attempt 保留，再用同一 DB／dataDir／socket 重建 app，真实启动恢复清完。
- status-timeout 用测试专用延迟程序保持 pending，真实握手超时后 session／attempt／文件收敛，不 fallback。kill-failed 在 shell 真正 spawned 后注入等待和 kill 失败，证明 session／attempt 留存；移除注入重建 app 后真实恢复。
- managed Worker 真正独立启动并通过鉴权健康检查。固定 bash 调用在另一个短命 fixture 进程运行已构建 Worker 的 AgentApiClient／BuiltinToolProvider，真实通过内部鉴权 API 读取配置并执行 bash；不是 managed Worker 的 LLM 端到端调用。
- 结束先 close app／Worker，仅清理由该测试 Workspace durable terminal ID 授权的精确 session；核对 session 消失、Worker socket／pid 消失、attempt=0、启动根为空。未知 session／替换对象保守保留，不递归删除整棵目录；DB／虚构 fixture／result.json 继续作证据。

## 实施差异与处置

| 设计期表述／环境差异 | 实际实现与理由 |
|---|---|
| wrapper 仅 `-S` | 增加 `-f <项目内独立空配置>`，避免读取主机 tmux 配置；仍只有单个 exec，不改产品 socket 机制 |
| source 命令行 `--import tsx` | harness 内部 register；dist 明确拒绝 loader，避免 dev 依赖掩盖生产入口 |
| cold 停止测试 server | 精确删除已归属的最后一个 session，自然退出后核对新 server PID，无需 kill-server |
| ps／短命 argv 观察 | 当前容器没有 ps；Linux 仅观察已归属 pane 及已验证 PPid 的直接子进程 `/proc` 元数据，不读取 environ 或遍历系统进程 |
| 退出时删除测试目录 | 只收敛授权运行资源和启动文件，保留 DB／fixture／result.json；不为整洁递归删未知对象 |
| 默认 Web／根 build | 使用等价 `envDir:false` 配置，避免读取真实 `.env.local`；未声称默认根 build 已执行 |
| 预计 launcher／空目录 helper 独立测试文件 | 实际放入 protocol／launch 测试；共同 admission 集成位于 terminal.workspace-environment.test.ts，见[实际测试位置](06-implementation-plan.md#实际聚焦测试位置) |
| tmux resize／last-session 退出存在异步窗口 | 等待真实 pane geometry 及信号传递；仅对 TERMINAL_SESSION_STOP_UNCONFIRMED 等真实 presence 明确 not_found 后再 DELETE 收敛，不放宽产品 fail-closed |

早期开发中的 PTY 行流、resize、Worker header、缺少 ps、空 stdin EPIPE 和 stop-unconfirmed 已在测试脚本修正／重跑；不能把旧失败目录当成功证据。异常中断留下的已知测试进程／session 已在核对确切入口、uid／PID lifetime／测试 socket、真实 PTY 归属后精确停止；从未泛扫环境或操作默认 tmux。最终结果以本节成功矩阵为准。

## 待验收项与用户短操作

| 项目 | 当前状态／边界 |
|---|---|
| M-UI：真实浏览器、旧 Dock、焦点、布局、多行可读性 | 尚未执行；组件测试不是视觉／人工交互验收 |
| M-ENV：多 Workspace 并发、外部 workdir、长任务改配置 | 自动测试已覆盖；本 harness 实测单 Workspace 新旧 shell／重连和固定 Worker bash，不冒充全部手动动作 |
| M-TTY：Node20、其他平台、异常 shell 退出／连续输出／完整生产部署 | 尚未实跑；Node22/Linux 基础 TTY、信号、job control、后台、exit、重连、冷／热已实跑 |
| M-SECURITY：其他平台的 argv／文件观察 | 当前证据限 Linux/Node22；其他平台仍需相应归属限定观察 |
| M-FAIL：浏览器响应丢失、手动 fallback／删除 pending 交互 | 自动测试已覆盖对应分支；人工交互仍待验收，四种真实 harness 故障恢复已通过 |
| 阶段 E 独立审查与最终全面审查 | 均已通过；最终全面审查由 new 会话独立完成，不等于完整人工／部署验收通过 |

用户步骤（只用虚构值，不把真实 token／代理密码填入测试环境）：

1. 完成上述安全准备与构建；执行 `safe node apps/api/tests/manual/terminal-environment-harness.mjs --mode dist --with-worker`，不加 `--verify`。等待 `READY manual-ui`，打开打印的 `/workspaces/<id>` URL。
2. 在正式“环境变量”工具逐项新增／编辑／启停／删除，刷新确认持久化；检查搜索／筛选、空串／多行、取消和保存中防重入，无显隐或全局保存栏。旧布局与切 Workspace 以 [M-UI 清单](05-acceptance-and-review.md#m-ui正式工具)补验。
3. 新建终端比较测试值，改值后新终端变化、旧终端和重连不变；测试中文、resize、Ctrl+C、Ctrl+Z／jobs／fg、后台和 exit。按 [M-ENV／M-TTY](05-acceptance-and-review.md#m-env实际环境与生效)记录实际版本与结果。
4. Ctrl+C 停止 harness；正常手动退出码 130。核对打印的 `result.json`：`clean=true`、`pendingAttempts=0`；手动模式 `verificationPassed=false` 是刻意不冒认完整验收，不是清理失败。出现 pending／固定错误码时保留证据，不强删测试目录。
5. 切换 Node20 后分别重建并运行 source/dist，同样记录；必要的其他平台／生产部署单独执行。各阶段独立审查与最终 new 会话全面独立审查均已通过，但未覆盖的核心人工／部署项完成前，不标记“完整验收通过”。
