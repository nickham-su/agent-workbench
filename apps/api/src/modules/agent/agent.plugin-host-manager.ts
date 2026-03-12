import { spawn, type ChildProcess } from "node:child_process";
import { request as httpRequest } from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import type { FastifyBaseLogger } from "fastify";

async function fileExists(filePath: string) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export class AgentPluginHostProcessManager {
  private child: ChildProcess | null = null;
  private stopping = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartAttempt = 0;
  private recentFailureTs: number[] = [];

  constructor(
    private readonly params: {
      repoRoot: string;
      socketPath: string;
      apiDataDir: string;
      apiOrigin: string;
      internalToken: string;
      pidFilePath: string;
      devMode?: boolean;
      logger: FastifyBaseLogger;
    }
  ) {}

  async start() {
    this.stopping = false;
    if (this.child) return;

    const distEntry = path.join(this.params.repoRoot, "apps", "api", "dist", "plugin-host", "main.js");
    const srcEntry = path.join(this.params.repoRoot, "apps", "api", "src", "plugin-host", "main.ts");
    const tsxBin = path.join(this.params.repoRoot, "node_modules", ".bin", "tsx");
    const devMode = this.params.devMode ?? process.env.AWB_AGENT_PLUGIN_HOST_DEV === "1";

    let command = process.execPath;
    let args: string[] = [];

    if (!devMode) {
      if (!(await fileExists(distEntry))) {
        throw new Error("agent-plugin-host dist entry is missing; build apps/api first or enable AWB_AGENT_PLUGIN_HOST_DEV=1");
      }
      args = [distEntry];
    } else {
      command = tsxBin;
      args = [srcEntry];
    }

    const child = spawn(command, args, {
      cwd: this.params.repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        AWB_AGENT_PLUGIN_HOST_SOCKET: this.params.socketPath,
        AWB_AGENT_INTERNAL_TOKEN: this.params.internalToken,
        AWB_DATA_DIR: this.params.apiDataDir,
        AWB_AGENT_API_ORIGIN: this.params.apiOrigin,
        AWB_AGENT_PLUGIN_HOST_PID_FILE: this.params.pidFilePath
      }
    });
    child.unref();
    this.child = child;

    child.stdout?.on("data", (chunk) => {
      this.params.logger.info({ output: chunk.toString("utf8").trim() }, "agent-plugin-host stdout");
    });
    child.stderr?.on("data", (chunk) => {
      this.params.logger.warn({ output: chunk.toString("utf8").trim() }, "agent-plugin-host stderr");
    });
    child.on("exit", (code, signal) => {
      this.params.logger.warn({ code, signal }, "agent-plugin-host exited");
      this.child = null;
      if (this.stopping) return;
      this.handleUnexpectedExit();
    });

    try {
      await this.waitUntilReady();
      this.restartAttempt = 0;
      this.recentFailureTs = [];
    } catch (err) {
      this.params.logger.error({ err }, "agent-plugin-host failed to become ready");
      this.child = null;
      child.kill("SIGKILL");
      throw err;
    }
  }

  async stop() {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    if (!child) return;
    this.child = null;

    child.kill("SIGTERM");
    const done = await Promise.race([
      new Promise<boolean>((resolve) => {
        child.once("exit", () => resolve(true));
      }),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), 3000);
      })
    ]);
    if (!done) {
      child.kill("SIGKILL");
    }
  }

  private handleUnexpectedExit() {
    const now = Date.now();
    this.recentFailureTs.push(now);
    this.recentFailureTs = this.recentFailureTs.filter((ts) => now - ts <= 60_000);
    if (this.recentFailureTs.length >= 8) {
      this.params.logger.error(
        {
          failuresInWindow: this.recentFailureTs.length,
          windowMs: 60_000
        },
        "agent-plugin-host restart paused by circuit breaker"
      );
      if (!this.restartTimer) {
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          this.recentFailureTs = [];
          this.scheduleRestart();
        }, 30_000);
      }
      return;
    }
    this.scheduleRestart();
  }

  private scheduleRestart() {
    if (this.stopping || this.restartTimer) return;
    const base = 500;
    const cap = 10_000;
    const jitter = Math.floor(Math.random() * 200);
    const delay = Math.min(cap, base * 2 ** this.restartAttempt) + jitter;
    this.restartAttempt += 1;

    this.params.logger.warn(
      {
        delayMs: delay,
        attempt: this.restartAttempt
      },
      "agent-plugin-host restart scheduled"
    );

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping) return;
      void this.start().catch((err) => {
        this.params.logger.error({ err }, "agent-plugin-host restart failed");
        this.handleUnexpectedExit();
      });
    }, delay);
  }

  private async waitUntilReady() {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        const ok = await new Promise<boolean>((resolve) => {
          const req = httpRequest(
            {
              socketPath: this.params.socketPath,
              path: "/internal/health",
              method: "GET",
              headers: {
                "x-awb-agent-internal-token": this.params.internalToken
              }
            },
            (res) => {
              res.resume();
              resolve((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300);
            }
          );
          req.setTimeout(1500, () => {
            req.destroy();
            resolve(false);
          });
          req.on("error", () => resolve(false));
          req.end();
        });
        if (ok) return;
      } catch {
        // wait
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    throw new Error("agent-plugin-host did not become ready in time");
  }
}
