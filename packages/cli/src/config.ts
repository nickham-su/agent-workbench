import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { isSessionCookie, type SessionCookie } from "./cookie.js";
import { CliError, isRecord } from "./errors.js";
import { normalizeOrigin } from "./origin.js";

export interface CliConfigV1 {
  version: 1;
  apiOrigin: string;
  cookie: SessionCookie | null;
}

export interface ConfigStore {
  load(): Promise<CliConfigV1>;
  save(config: CliConfigV1): Promise<void>;
}

type ConfigIO = Pick<typeof fs, "mkdir" | "chmod" | "open" | "readFile" | "rename" | "unlink">;

function isConfig(value: unknown): value is CliConfigV1 {
  if (!isRecord(value) || Object.keys(value).length !== 3
    || value.version !== 1 || typeof value.apiOrigin !== "string"
    || (value.cookie !== null && !isSessionCookie(value.cookie))) return false;
  try {
    return normalizeOrigin(value.apiOrigin) === value.apiOrigin;
  } catch {
    return false;
  }
}

export class FileConfigStore implements ConfigStore {
  readonly directory: string;
  readonly filePath: string;

  constructor(home = homedir(), private readonly io: ConfigIO = fs) {
    this.directory = join(home, ".config", "awb");
    this.filePath = join(this.directory, "config.json");
  }

  async load(): Promise<CliConfigV1> {
    try {
      const value: unknown = JSON.parse(await this.io.readFile(this.filePath, "utf8"));
      if (!isConfig(value)) throw new Error("Invalid config");
      return value;
    } catch {
      throw new CliError(3, "无法读取有效的本地连接配置，请重新执行 awb login。");
    }
  }

  async save(config: CliConfigV1): Promise<void> {
    const temporary = join(this.directory, `.config-${process.pid}-${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<ConfigIO["open"]>> | undefined;
    try {
      if (!isConfig(config)) throw new Error("Invalid config");
      await this.io.mkdir(join(this.directory, ".."), { recursive: true });
      await this.io.mkdir(this.directory, { recursive: true, mode: 0o700 });
      if (process.platform !== "win32") await this.io.chmod(this.directory, 0o700);
      handle = await this.io.open(temporary, "wx", 0o600);
      if (process.platform !== "win32") await this.io.chmod(temporary, 0o600);
      await handle.writeFile(`${JSON.stringify(config)}\n`, "utf8");
      await handle.close();
      handle = undefined;
      await this.io.rename(temporary, this.filePath);
    } catch {
      await handle?.close().catch(() => {});
      await this.io.unlink(temporary).catch(() => {});
      throw new CliError(7, "无法保存登录凭证，旧配置保持不变；请检查用户目录权限后重试。");
    }
  }
}
