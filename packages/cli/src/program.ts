import { Command, CommanderError } from "commander";
import metadata from "../package.json" with { type: "json" };
import { FileConfigStore, type ConfigStore } from "./config.js";
import { CliError, errorDiagnostic, type CliExitCode } from "./errors.js";
import { HttpClient, type HttpTransport } from "./http.js";
import { login } from "./login.js";
import { listSessions } from "./session-list.js";
import { parseSessionListOptions, type SessionListOptions } from "./session-query.js";
import type { CliIO } from "./token-input.js";

export interface CliDependencies {
  io?: CliIO;
  createConfigStore?: () => ConfigStore;
  http?: HttpTransport;
}

const singleOptions = new Set([
  "--url", "--token-stdin", "--workspace", "--updated-within", "--kind", "--status"
]);

function rejectDuplicateOptions(args: readonly string[]): void {
  const found = new Set<string>();
  for (const argument of args) {
    const option = argument.split("=", 1)[0];
    if (!singleOptions.has(option)) continue;
    if (found.has(option)) throw new CliError(2, "命令含重复选项，请为每个参数仅提供一个值。");
    found.add(option);
  }
}

export async function runCli(args: readonly string[], dependencies: CliDependencies = {}): Promise<CliExitCode> {
  const io: CliIO = dependencies.io ?? {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr
  };
  try {
    rejectDuplicateOptions(args);
    const program = new Command()
      .name("awb")
      .description("独立 AWB 客户端：登录和通用 Session 查询")
      .version(metadata.version)
      .allowExcessArguments(false)
      .showSuggestionAfterError(false)
      .showHelpAfterError(false)
      .configureOutput({
        writeOut: (text) => { io.stdout.write(text); },
        // Commander includes offending argv values in errors. Suppress all raw
        // parser diagnostics to avoid leaking a mistakenly supplied token.
        writeErr: () => {}
      })
      .exitOverride();

    program.command("login")
      .description("初始化服务连接并登录，缓存会话 Cookie")
      .requiredOption("--url <origin>", "HTTP(S) 服务 origin，不支持反向代理子路径")
      .option("--token-stdin", "认证开启时从非交互标准输入读取单行 token")
      .allowExcessArguments(false)
      .action(async (options: { url: string; tokenStdin?: boolean }) => {
        await login(options, {
          config: (dependencies.createConfigStore ?? (() => new FileConfigStore()))(),
          http: dependencies.http ?? new HttpClient(),
          io
        });
      });

    const session = program.command("session")
      .description("查询 Workspace 中的 Session")
      .allowExcessArguments(false);
    session.command("list")
      .description("按最近更新时间查询 Session，固定文本输出")
      .requiredOption("--workspace <ID>", "Workspace ID")
      .requiredOption("--updated-within <duration>", "最近更新时间窗口，例如 24h，最大 90d")
      .option("--kind <kind>", "primary、subtask 或 all", "all")
      .option("--status <status>", "idle、running 或 all", "all")
      .allowExcessArguments(false)
      .action(async (options: SessionListOptions) => {
        const query = parseSessionListOptions(options);
        await listSessions(query, {
          config: (dependencies.createConfigStore ?? (() => new FileConfigStore()))(),
          http: dependencies.http ?? new HttpClient(),
          io
        });
      });
    session.action(() => { session.outputHelp(); });
    program.action(() => { program.outputHelp(); });

    await program.parseAsync([...args], { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return 0;
    const safeError = error instanceof CliError ? error
      : error instanceof CommanderError ? new CliError(2, "命令参数无效，请使用相应命令的 --help 查看用法。")
      : new CliError(6, "CLI 执行失败；未输出业务结果，请检查命令后重试。");
    io.stderr.write(errorDiagnostic(safeError));
    return safeError.exitCode;
  }
}
