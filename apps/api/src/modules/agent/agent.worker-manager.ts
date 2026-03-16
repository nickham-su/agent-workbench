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

export class AgentWorkerProcessManager {
  private child: ChildProcess | null = null;
  private stopping = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartAttempt = 0;
  private recentFailureTs: number[] = [];

  constructor(
    private readonly params: {
      repoRoot: string;
      workerHost: string;
      workerPort: number;
      socketPath: string;
      workerConcurrency: number;
      apiOrigin: string;
      internalToken: string;
      pidFilePath: string;
      logger: FastifyBaseLogger;
    }
  ) {}

  async start() {
    this.stopping = false;
    if (this.child) return;

    const distEntry = path.join(this.params.repoRoot, "apps", "agent-worker", "dist", "main.js");
    const srcEntry = path.join(this.params.repoRoot, "apps", "agent-worker", "src", "main.ts");
    const tsxBin = path.join(this.params.repoRoot, "node_modules", ".bin", "tsx");
    const preferSource =
      String(process.env.npm_lifecycle_event || "").includes("dev") ||
      String(process.argv[1] || "").endsWith(".ts");

    let command = process.execPath;
    let args: string[] = [];

    if (!preferSource && (await fileExists(distEntry))) {
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
        AWB_AGENT_WORKER_HOST: this.params.workerHost,
        AWB_AGENT_WORKER_PORT: String(this.params.workerPort),
        AWB_AGENT_WORKER_SOCKET: this.params.socketPath,
        AWB_AGENT_WORKER_CONCURRENCY: String(this.params.workerConcurrency),
        AWB_AGENT_API_ORIGIN: this.params.apiOrigin,
        AWB_AGENT_INTERNAL_TOKEN: this.params.internalToken,
        AWB_AGENT_WORKER_PID_FILE: this.params.pidFilePath,
        AWB_AGENT_REPO_ROOT: this.params.repoRoot
      }
    });
    child.unref();
    this.child = child;

    child.stdout?.on("data", (chunk) => {
      this.params.logger.info({ output: chunk.toString("utf8").trim() }, "agent-worker stdout");
    });
    child.stderr?.on("data", (chunk) => {
      this.params.logger.warn({ output: chunk.toString("utf8").trim() }, "agent-worker stderr");
    });
    child.on("exit", (code, signal) => {
      this.params.logger.warn({ code, signal }, "agent-worker exited");
      this.child = null;
      if (this.stopping) return;
      this.handleUnexpectedExit();
    });

    try {
      await this.waitUntilReady();
      this.restartAttempt = 0;
      this.recentFailureTs = [];
    } catch (err) {
      this.params.logger.error({ err }, "agent-worker failed to become ready");
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
        "agent-worker restart paused by circuit breaker"
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
      "agent-worker restart scheduled"
    );

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping) return;
      void this.start().catch((err) => {
        this.params.logger.error({ err }, "agent-worker restart failed");
        this.handleUnexpectedExit();
      });
    }, delay);
  }

  private async waitUntilReady() {
    const origin = `http://${this.params.workerHost}:${this.params.workerPort}`;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        if (this.params.socketPath) {
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
        } else {
          const response = await fetch(`${origin}/internal/health`, {
            headers: {
              "x-awb-agent-internal-token": this.params.internalToken
            }
          });
          if (response.ok) return;
        }
      } catch {
        // wait
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    throw new Error("agent-worker did not become ready in time");
  }
}
