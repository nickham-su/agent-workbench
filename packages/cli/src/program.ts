import { Command, CommanderError } from "commander";
import metadata from "../package.json" with { type: "json" };
import { commandName, inspectArguments } from "./arguments.js";
import { FileConfigStore, type ConfigStore } from "./config.js";
import { listAgents, listWorkspaces, sessionStatus, showSession, type ReadCommandDependencies } from "./discovery.js";
import { CliError, withErrorDetails, type CliExitCode } from "./errors.js";
import { HttpClient, type HttpTransport } from "./http.js";
import { login } from "./login.js";
import { writeFailure, writeText } from "./output.js";
import { listSessions } from "./session-list.js";
import { parseSessionListOptions, type SessionListOptions } from "./session-query.js";
import { listMessages, parseMessageSelection } from "./messages.js";
import { prepareSend, sendMessage } from "./send.js";
import { followMessages, followSend } from "./follow.js";
import { parseFollowOptions } from "./follow-lifetime.js";
import { cancelSession, compactSession } from "./control.js";
import { downloadFile, validateDownloadOptions } from "./download.js";
import type { InputOptions } from "./input.js";
import type { CliIO } from "./token-input.js";
import { parseDuration, validateId } from "./validation.js";

export interface CliDependencies { io?: CliIO; createConfigStore?: () => ConfigStore; http?: HttpTransport; signal?: AbortSignal; }
export async function runCli(args: readonly string[], dependencies: CliDependencies = {}): Promise<CliExitCode> {
  const io: CliIO = dependencies.io ?? { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr };
  let json = false;
  let commandExitCode: CliExitCode = 0;
  let help = "awb --help";
  let timeoutMs = 30_000;
  try {
    const parserOutput: string[] = [];
    const program = new Command().name("awb")
      .description("独立 AWB 客户端：发现、调用 Agent，审阅消息并下载工作区产物")
      .version(metadata.version).option("--json", "机器可读 JSON；跟随命令使用 JSONL")
      .option("--timeout <duration>", "单次请求完整响应时限，1s..24h", "30s")
      .allowExcessArguments(false).showSuggestionAfterError(false).showHelpAfterError(false).addHelpCommand(false)
      .configureHelp({ showGlobalOptions: true })
      .configureOutput({ writeOut: (text) => { parserOutput.push(text); }, writeErr: () => {} }).exitOverride()
      .addHelpText("after", "\n最短工作流：awb login --url <origin> → awb workspace list → awb agent list -w <ID>\n使用 awb <组> --help，再查看具体动作 --help。退出码与输出协议见 CLI README。\n");
    program.hook("preAction", () => {
      timeoutMs = parseDuration(program.opts().timeout, 86400, "请求时限") * 1000;
    });
    const commandDependencies = (): ReadCommandDependencies => {
      let config: ConfigStore;
      try { config = (dependencies.createConfigStore ?? (() => new FileConfigStore()))(); }
      catch { throw new CliError(3, "无法初始化本地连接配置，请检查配置目录。", { phase: "config", effect: "not_sent" }); }
      return {
        config,
        http: dependencies.http ?? new HttpClient(), io, json: Boolean(program.opts().json),
        timeoutMs,
        ...(dependencies.signal ? { signal: dependencies.signal } : {})
      };
    };
    program.command("login").description("初始化服务连接并登录，缓存会话 Cookie")
      .requiredOption("--url <origin>", "HTTP(S) 服务 origin，不支持反向代理子路径")
      .option("--token-stdin", "认证开启时从非交互标准输入读取单行 token").allowExcessArguments(false)
      .addHelpText("after", "\n例：awb login --url https://awb.example.test --token-stdin\n不接受命令行 token；不会自动重试登录。\n")
      .action(async (options: { url: string; tokenStdin?: boolean }) => { await login(options, commandDependencies()); });
    const workspace = program.command("workspace").description("发现已有工作区").allowExcessArguments(false);
    workspace.command("list").description("仅列工作区 ID 和名称，按名称码点排序").allowExcessArguments(false)
      .addHelpText("after", "\n例：awb workspace list --json\n不显示仓库地址、凭证或远端绝对路径。\n")
      .action(async () => { await listWorkspaces(commandDependencies()); });
    const agent = program.command("agent").description("发现工作区可用 user Agent").allowExcessArguments(false);
    agent.command("list").description("按配置顺序列 ID、名称和用途").requiredOption("-w, --workspace <ID>", "Workspace ID")
      .allowExcessArguments(false).addHelpText("after", "\n例：awb agent list -w <ID>\n可用只表示范围与启用允许，不保证模型、凭证或 Worker 可运行。\n")
      .action(async (options: { workspace: string }) => { const id = validateId(options.workspace, true); await listAgents(id, commandDependencies()); });
    const session = program.command("session").description("查询、发送、跟随与控制主会话；已知子会话只读").allowExcessArguments(false);
    session.command("list").description("查询最近更新的主会话，保留原生累计计数")
      .requiredOption("-w, --workspace <ID>", "Workspace ID")
      .requiredOption("--updated-within <duration>", "最近更新时间窗口，正整数 s/m/h/d，最大 90d")
      .option("--kind <kind>", "已弃用，仅支持 primary，可省略；subtask/all 请迁移到已知 ID 查询")
      .option("--status <status>", "idle、running 或 all", "all").allowExcessArguments(false)
      .addHelpText("after", "\n例：awb session list -w <ID> --updated-within 24h --status idle\n仅列主会话（包含 Fork 主会话），不提供子会话或全历史枚举。\n")
      .action(async (options: SessionListOptions) => { const query = parseSessionListOptions(options); await listSessions(query, commandDependencies()); });
    for (const [name, description, action] of [
      ["show", "查询已知主/子会话的公开元信息，不受列表窗口限制", showSession],
      ["status", "查询已知主/子会话 idle/running；idle 不代表上次成功", sessionStatus]
    ] as const) {
      session.command(name).description(description).requiredOption("-w, --workspace <ID>", "Workspace ID")
        .requiredOption("-s, --session <ID>", "Session ID").allowExcessArguments(false)
        .addHelpText("after", `\n例：awb session ${name} -w <ID> -s <ID> --json\n支持主/子会话，不查询或推断最近 Run 结果。\n`)
        .action(async (options: { workspace: string; session: string }) => {
          const workspaceId = validateId(options.workspace);
          const sessionId = validateId(options.session, true);
          await action(workspaceId, sessionId, commandDependencies());
        });
    }
    const followFlags = (command: Command) => command.option("-f, --follow", "跟随固定本次 Run，终态排干后退出；中断仅停止本地")
      .option("--follow-timeout <duration>", "整体监听时限，1s..90d；仅与 -f 同用，默认不限制");
    followFlags(session.command("send").description("向主会话发送文本或图片；省略会话时创建一次")
      .requiredOption("-w, --workspace <ID>", "Workspace ID").option("-s, --session <ID>", "主 Session ID，省略则创建")
      .option("-a, --agent <ID>", "可用 user Agent ID，默认配置顺序第一个")
      .option("--prompt <text>", "提示词，与 --prompt-file/--stdin 互斥")
      .option("--prompt-file <local-file>", "有效 UTF-8 普通文件，最大 1 MiB，允许单 BOM")
      .option("--stdin", "显式读取非 TTY 标准输入到 EOF，不隐式读取")
      .option("--image <local-file>", "可重复 PNG/JPEG/WebP；最多 4 张，每张 10 MiB、共 20 MiB", (value: string, previous: string[]) => [...previous, value], [])
      .allowExcessArguments(false))
      .addHelpText("after", "\n例：awb session send -w <ID> --prompt '请检查项目'\n纯图：awb session send -w <ID> --image ./diagram.png\n文本或图片至少一个；创建/发送失败零重试，不切换 Agent、不排队；已受理不等于执行成功。\n")
      .action(async (options: InputOptions & { workspace: string; session?: string; agent?: string; follow?: boolean; followTimeout?: string }) => {
        const target = { workspaceId: validateId(options.workspace, true), ...(options.session !== undefined ? { sessionId: validateId(options.session, true) } : {}), ...(options.agent !== undefined ? { agentId: validateId(options.agent) } : {}) };
        const follow = parseFollowOptions(options);
        // Input validation intentionally precedes config-store construction and all HTTP.
        const prepared = await prepareSend({ ...options, ...target }, io.stdin);
        if (follow.follow) commandExitCode = await followSend(target, prepared, follow, commandDependencies());
        else await sendMessage(target, prepared, commandDependencies());
      });
    followFlags(session.command("messages").description("读取当前可见分支普通 text/image 消息快照")
      .requiredOption("-w, --workspace <ID>", "Workspace ID").requiredOption("-s, --session <ID>", "主/子 Session ID")
      .option("--after <ID>", "排除锚点自身，锚点须属于当前可见分支；与 -n 恰选一")
      .option("-n, --last <N>", "最近 N 条普通消息，正安全整数；与 --after 恰选一")
      .allowExcessArguments(false)).addHelpText("after", "\n例：awb session messages -w <ID> -s <ID> -n 1 --json\n例：awb session messages -w <ID> -s <ID> --after <message-ID>\n按链正序、保留完整 text/image；不输出推理或工具事件。-n 1 不保证任务成功或最终回答。\n")
      .action(async (options: { workspace: string; session: string; last?: string; after?: string; follow?: boolean; followTimeout?: string }) => {
        const workspaceId = validateId(options.workspace); const sessionId = validateId(options.session, true);
        const selection = parseMessageSelection(options);
        const follow = parseFollowOptions(options);
        if (follow.follow) commandExitCode = await followMessages(workspaceId, sessionId, selection, follow, commandDependencies());
        else await listMessages(workspaceId, sessionId, selection, commandDependencies());
      });
    session.command("cancel").description("取消主会话处理时的当前执行及活动后代，不回滚文件")
      .requiredOption("-w, --workspace <ID>", "Workspace ID").requiredOption("-s, --session <ID>", "主 Session ID")
      .allowExcessArguments(false).addHelpText("after", "\n例：awb session cancel -w <ID> -s <ID>\n预查与提交存在竞态：取消服务端处理时的当前 Run 及活动子孙，不保证是此前观察到的 Run；不回滚文件、不删除历史。\n")
      .action(async (options: { workspace: string; session: string }) => {
        await cancelSession(validateId(options.workspace), validateId(options.session, true), commandDependencies());
      });
    followFlags(session.command("compact").description("启动空闲主会话的手动压缩，默认受理即退出")
      .requiredOption("-w, --workspace <ID>", "Workspace ID").requiredOption("-s, --session <ID>", "空闲主 Session ID")
      .allowExcessArguments(false)).addHelpText("after", "\n例：awb session compact -w <ID> -s <ID> -f\n默认首个 user Agent，不公开 -a；忙时冲突不排队。空会话报错，多数无需压缩原因由 Run 终态说明。原历史和文件不删除；中断仅停止 CLI。\n")
      .action(async (options: { workspace: string; session: string; follow?: boolean; followTimeout?: string }) => {
        const workspaceId = validateId(options.workspace); const sessionId = validateId(options.session, true);
        const follow = parseFollowOptions(options);
        commandExitCode = await compactSession(workspaceId, sessionId, follow, commandDependencies());
      });
    const file = program.command("file").description("下载工作区文件或目录 ZIP").allowExcessArguments(false);
    file.command("download").description("流式下载并原子无覆盖发布到显式本地文件")
      .requiredOption("-w, --workspace <ID>", "Workspace ID")
      .requiredOption("--path <remote-relative-path>", "远端 / 分隔相对路径，. 表示整个工作区")
      .requiredOption("--output <local-file>", "本地文件目标，父目录须存在；不覆盖已有文件或链接")
      .allowExcessArguments(false).addHelpText("after", "\n例：awb file download -w <ID> --path reports --output ./reports.zip --json\n目录由服务端生成 ZIP；源文件合计最多 100 MiB，遇 .git/软链整次失败，空目录不保留。\n仅词法过滤，不保证服务端快照或修复软链竞态。中断只清理本次临时文件；发布后错误保留完整目标。\n")
      .action(async (options: { workspace: string; path: string; output: string }) => {
        const target = validateDownloadOptions({ workspaceId: validateId(options.workspace, true), path: options.path, output: options.output });
        await downloadFile(target, commandDependencies());
      });
    for (const group of [program, workspace, agent, session, file]) group.action(() => { group.outputHelp(); });
    const inspection = inspectArguments(args, program);
    json = inspection.json;
    const name = commandName(inspection.command);
    help = `awb${name ? ` ${name}` : ""} --help`;
    if (inspection.invalid) throw new CliError(2, "命令或选项无效，或存在额外位置参数。");
    // Known help bypasses missing/invalid values, duplicate business flags, config and IO.
    if (inspection.help) { inspection.command.outputHelp(); await writeText(io.stdout, parserOutput.join("")); return 0; }
    if (inspection.duplicate) throw new CliError(2, "命令含重复选项，短/长别名也只能提供一次。");
    try { await program.parseAsync([...args], { from: "user" }); }
    catch (error) { if (!(error instanceof CommanderError && error.exitCode === 0)) throw error; }
    if (parserOutput.length) await writeText(io.stdout, parserOutput.join(""));
    return commandExitCode;
  } catch (error) {
    const safeError = withErrorDetails(error instanceof CommanderError ? new CliError(2, "命令参数无效，请查看对应帮助。") : error,
      { phase: "parse", effect: "not_sent", help });
    try { await writeFailure(io, json, safeError); } catch { /* stderr failure must not recurse or expose an exception. */ }
    return safeError.exitCode;
  }
}
