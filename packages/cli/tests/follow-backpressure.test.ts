import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { once } from "node:events";
import { FileConfigStore } from "../src/config.js";
import { agentSession, messagePart } from "./agent-fixture.js";
import { msg, page, state } from "./follow-fixture.js";
import { httpServer, repository, temporaryDirectory } from "./helpers.js";

test("A-FOLLOW-SIGNALS: stalled stdout backpressure cannot prevent SIGTERM exit or cause remote cancellation", async (t) => {
  const home = await temporaryDirectory("follow-stalled-output"); t.after(() => fs.rm(home, { recursive: true, force: true }));
  let requested!: () => void; const responseStarted = new Promise<void>((resolve) => { requested = resolve; }); let cancels = 0;
  const server = await httpServer((request, response) => {
    const url = new URL(request.url!, "http://fixture.test"); response.setHeader("content-type", "application/json");
    if (url.pathname.endsWith("/cancel")) cancels++;
    if (url.pathname.endsWith("/run-state")) response.end(JSON.stringify(state("r")));
    else if (url.searchParams.get("mode") === "snapshot") response.end(JSON.stringify(page([msg("u", 0, null, { type: "user", originRunId: null })])));
    else {
      response.end(JSON.stringify(page([msg("large", 1, "u", { updatedRevision: 11, parts: [messagePart("large", "text", { text: "x".repeat(3_000_000) })] })], 11, { session: agentSession({ headMessageId: "large", revision: 11 }) })));
      requested();
    }
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await new FileConfigStore(home).save({ version: 1, apiOrigin: server.origin, cookie: null });
    const child = spawn(process.execPath, [join(repository, "packages/cli/dist/cli.cjs"), "session", "messages", "-w", "w", "-s", "s", "-n", "1", "-f", "--json"], {
      cwd: home, env: { HOME: home, USERPROFILE: home, TMPDIR: home, PATH: dirname(process.execPath), NODE_PATH: "" }, stdio: ["pipe", "pipe", "pipe"]
    });
    t.after(() => { child.kill("SIGKILL"); });
    // Intentionally never consume stdout: fill the pipe before delivering SIGTERM.
    let stderr = ""; child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); }); child.stdin.end();
    const close = once(child, "exit");
    const execution = (async () => { await responseStarted; await new Promise<void>((resolve) => setTimeout(resolve, 100)); child.kill("SIGTERM"); return close; })();
    const [code, signal] = await Promise.race([execution, new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => { child.kill("SIGKILL"); reject(Error("CLI failed to exit under backpressure")); }, 8_000); })]);
    child.stdout.destroy();
    assert.equal(code, 143, stderr); assert.equal(signal, null); assert.equal(cancels, 0); assert.equal(JSON.parse(stderr).error.category, "INTERRUPTED");
  } finally { clearTimeout(timeout); await server.close(); }
});
