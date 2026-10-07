import * as fs from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import type { CliIO, TokenInput } from "../src/token-input.js";

export const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const cookieValue = "v1.dGVzdC1wYXlsb2Fk.dGVzdC1zaWduYXR1cmU";
export const cookieHeader = `awb_session=${cookieValue}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`;

export async function temporaryDirectory(prefix: string): Promise<string> {
  const root = join(repository, ".tmp-tests", "0031-stage4-fixtures");
  await fs.mkdir(root, { recursive: true });
  return fs.mkdtemp(join(root, `${prefix}-`));
}

export function captureIO(input = ""): { io: CliIO; output: () => string; diagnostic: () => string } {
  const stdin: PassThrough & TokenInput = new PassThrough();
  stdin.end(input);
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let output = "";
  let diagnostic = "";
  stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  stderr.on("data", (chunk: Buffer) => { diagnostic += chunk.toString("utf8"); });
  return { io: { stdin, stdout, stderr }, output: () => output, diagnostic: () => diagnostic };
}

export function healthBody(authEnabled: boolean): string {
  return JSON.stringify({ ok: true, name: "agent-workbench", version: "test", authEnabled, authed: !authEnabled, previewEnabled: false });
}

export async function httpServer(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>): Promise<{
  origin: string;
  close: () => Promise<void>;
}> {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch(() => { response.destroy(); });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test address");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve(); }));
    }
  };
}

export async function readRequestBody(request: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  return JSON.parse(body);
}

export async function runBuiltCli(args: string[], home: string, input = ""): Promise<{
  code: number | null; stdout: string; stderr: string;
}> {
  const child = spawn(process.execPath, [join(repository, "packages/cli/dist/cli.cjs"), ...args], {
    cwd: home,
    env: { ...process.env, HOME: home, NODE_PATH: "" },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  child.stdin.end(input);
  const [code] = await once(child, "close");
  return { code, stdout, stderr };
}
