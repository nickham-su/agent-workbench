import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { FileConfigStore } from "../src/config.js";
import { msg, page, state } from "./follow-fixture.js";
import { httpServer, repository, temporaryDirectory } from "./helpers.js";

test("全面审查H1: unread full stderr cannot prevent deadline/SIGINT/SIGTERM exit while stdout is consumed", async (t) => {
  for (const reason of ["deadline", "SIGINT", "SIGTERM"] as const) {
    const home = await temporaryDirectory(`failure-stderr-${reason}`); t.after(() => fs.rm(home, { recursive: true, force: true }));
    // Fill the real stderr pipe before the CLI starts; the parent never reads it.
    const preload = join(home, "fill-stderr.cjs"); await fs.writeFile(preload, 'process.stderr.write(Buffer.alloc(2 * 1024 * 1024, 120));\n');
    let pollStarted!: () => void; const activeBody = new Promise<void>((resolve) => { pollStarted = resolve; });
    const requests: string[] = [];
    const server = await httpServer((request, response) => {
      requests.push(`${request.method} ${request.url}`); const url = new URL(request.url!, "http://fixture.test"); response.setHeader("content-type", "application/json");
      if (url.pathname.endsWith("/run-state")) response.end(JSON.stringify(state("target-run")));
      else if (url.searchParams.get("mode") === "delta") { response.write('{"session":'); pollStarted(); }
      else response.end(JSON.stringify(page([msg("a", 0, null)])));
    }); t.after(server.close);
    await new FileConfigStore(home).save({ version: 1, apiOrigin: server.origin, cookie: null });
    const child = spawn(process.execPath, ["--require", preload, join(repository, "packages/cli/dist/cli.cjs"), "session", "messages", "-w", "w", "-s", "s", "-n", "1", "-f", "--follow-timeout", "1s", "--json"], {
      cwd: home, env: { HOME: home, USERPROFILE: home, TMPDIR: home, PATH: dirname(process.execPath), NODE_PATH: "" }, stdio: ["pipe", "pipe", "pipe"]
    });
    t.after(() => { child.kill("SIGKILL"); child.stderr.destroy(); });
    let stdout = ""; child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stdin.end();
    const exited = once(child, "exit"); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const execution = (async () => { await activeBody; if (reason !== "deadline") child.kill(reason); return exited; })();
      const [code, signal] = await Promise.race([execution, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { child.kill("SIGKILL"); reject(Error("CLI stayed alive behind unread stderr")); }, 4000); })]);
      child.stderr.destroy();
      assert.equal(signal, null); assert.equal(code, reason === "deadline" ? 10 : reason === "SIGINT" ? 130 : 143);
      const terminal = JSON.parse(stdout.trim().split("\n").at(-1)!);
      assert.equal(terminal.type, "terminal"); assert.equal(terminal.complete, false); assert.equal(terminal.exitCode, code);
      assert.equal(requests.some((request) => request.startsWith("POST") || request.includes("/cancel")), false);
    } finally { clearTimeout(timer); }
  }
});
