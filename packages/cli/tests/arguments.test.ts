import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";
import { inspectArguments } from "../src/arguments.js";
import { runCli } from "../src/program.js";
import { captureIO } from "./helpers.js";
import { defaultQuery, queryResponse } from "./session-fixture.js";

test("全面审查M1: invalid root timeout precedes stdin/config/HTTP and known help still wins", async () => {
  for (const timeout of ["0s", "25h", "invalid"]) for (const help of [false, true]) {
    const capture = captureIO(); let reads = 0; let configs = 0; let requests = 0;
    capture.io.stdin.read = () => { reads++; throw Error("stdin must not be touched"); };
    const code = await runCli(["--timeout", timeout, "session", "send", "-w", "w", "--stdin", "--json", ...(help ? ["--help"] : [])], {
      io: capture.io,
      createConfigStore: () => { configs++; throw Error("config must not be constructed"); },
      http: { request: async () => { requests++; throw Error("HTTP must not start"); } }
    });
    assert.equal(code, help ? 0 : 2);
    assert.equal(reads, 0); assert.equal(configs, 0); assert.equal(requests, 0);
    if (help) { assert.match(capture.output(), /Usage: awb session send/); assert.equal(capture.diagnostic(), ""); }
    else { assert.equal(capture.output(), ""); assert.equal(JSON.parse(capture.diagnostic()).error.category, "USAGE"); }
  }
});

const commandPaths = [[], ["login"], ["workspace"], ["workspace", "list"], ["agent"], ["agent", "list"], ["session"], ["session", "list"], ["session", "show"], ["session", "status"], ["session", "send"], ["session", "messages"], ["session", "cancel"], ["session", "compact"], ["file"], ["file", "download"]];
test("A-HELP-LAYERS/PRIORITY/JSON: all connected commands help before invalid values and config", async () => {
  for (const path of commandPaths) for (const flag of ["-h", "--help"]) {
    const capture = captureIO();
    capture.io.stdin.read = () => { throw new Error("Must not read stdin"); };
    let factories = 0;
    let requests = 0;
    const args = [...path, flag, "--json"];
    if (path.join(" ") === "session list") args.push("-w", "invalid\n", "--updated-within", "-1s");
    const code = await runCli(args, { io: capture.io, createConfigStore: () => { factories++; throw new Error("Must not create config"); }, http: { request: async () => { requests++; throw new Error("Must not request"); } } });
    assert.equal(code, 0, args.join(" "));
    assert.equal(factories, 0);
    assert.equal(requests, 0);
    assert.match(capture.output(), /Usage: awb/);
    if (path.length === 0) assert.match(capture.output(), /最短工作流/);
    if (path.length === 2 || path[0] === "login") {
      assert.match(capture.output(), /例：awb/);
      assert.match(capture.output(), /--timeout/);
      assert.match(capture.output(), /--json/);
    }
    assert.equal(capture.diagnostic(), "");
  }
});

test("A-HELP-ERROR: unknown commands remain errors even with help, and use exact known help path", async () => {
  for (const args of [["unknown-secret", "--help"], ["session", "unknown-secret", "--help"], ["session", "show", "--unknown-secret"], ["session", "show", "-w", "w", "-s", "s", "extra-secret"]]) {
    const capture = captureIO();
    assert.equal(await runCli(args, { io: capture.io }), 2);
    assert.equal(capture.output(), "");
    assert.equal(capture.diagnostic().includes("secret"), false);
    assert.ok(capture.diagnostic().includes(args[1] === "show" ? "awb session show --help" : args[0] === "session" ? "awb session --help" : "awb --help"));
  }
});

test("A-PARSE-ALIASES: equivalent aliases/global option positions and duplicate rejection before IO", async () => {
  const args = ["session", "list", "-w", defaultQuery.workspaceId, "--updated-within", "24h"];
  let first = "";
  for (const position of [0, 1, args.length]) {
    const capture = captureIO();
    const invocation = [...args.slice(0, position), "--json", "--timeout", "1s", ...args.slice(position)];
    const code = await runCli(invocation, { io: capture.io, createConfigStore: () => ({ load: async () => ({ version: 1, apiOrigin: "http://example.test", cookie: null }), save: async () => {} }), http: {
      request: async (_origin, path, request) => {
        assert.equal(request?.timeoutMs, 1000);
        assert.match(path, /kind=primary/);
        return { status: 200, body: JSON.stringify(queryResponse()), setCookies: [] };
      }
    } });
    assert.equal(code, 0);
    assert.equal(capture.diagnostic(), "");
    const parsed = JSON.parse(capture.output());
    assert.equal(parsed.command, "session list");
    assert.equal(parsed.data.count, 1);
    if (first) assert.equal(capture.output(), first); else first = capture.output();
  }
  for (const invocation of [
    [...args, "--workspace", "secret"], [...args, "--json", "--json"],
    ["--json", ...args, "--json"], [...args, "--timeout", "1s", "--timeout=2s"],
    ["session", "show", "-w", "w", "-s", "s", "--session", "secret"]
  ]) {
    const capture = captureIO();
    let factories = 0;
    assert.equal(await runCli(invocation, { io: capture.io, createConfigStore: () => { factories++; throw new Error("Must not create"); } }), 2);
    assert.equal(factories, 0);
    assert.equal(capture.output(), "");
    assert.equal(capture.diagnostic().includes("secret"), false);
  }
});

test("grammar scanner consumes text option values rather than finding phantom flags; images may repeat", () => {
  const root = new Command().name("awb").option("--json");
  const send = root.command("session").command("send").option("-w, --workspace <ID>").option("--prompt <text>").option("--image <file>");
  for (const prompt of ["some --workspace in text", "--workspace"]) {
    const inspection = inspectArguments(["session", "send", "--workspace", "w", `--prompt=${prompt}`, "--image", "one", "--image", "two"], root);
    assert.equal(inspection.command, send);
    assert.equal(inspection.invalid, false);
    assert.equal(inspection.duplicate, false);
  }
  assert.equal(inspectArguments(["session", "send", "--prompt", "text containing --workspace", "-w", "w"], root).duplicate, false);
  assert.equal(inspectArguments(["session", "send", "-ww", "--workspace", "w"], root).duplicate, true);
});

test("A-PARSE-ID/DOT and A-COMPAT-KIND: invalid identifiers/kinds never load config or network", async () => {
  const cases = [
    ...["", " ", " w", "w ", "x\u001b", "\ud800"].map((id) => ["session", "show", "-w", id, "-s", "s"]),
    ...[".", ".."].flatMap((id) => [["agent", "list", "-w", id], ["session", "show", "-w", "w", "-s", id]]),
    ...["subtask", "all", ""].map((kind) => ["session", "list", "-w", "w", "--updated-within", "1s", "--kind", kind])
  ];
  for (const args of cases) {
    const capture = captureIO();
    let factories = 0;
    assert.equal(await runCli([...args, "--json"], { io: capture.io, createConfigStore: () => { factories++; throw new Error("Must not create"); } }), 2);
    assert.equal(factories, 0);
    assert.equal(capture.output(), "");
    const error = JSON.parse(capture.diagnostic()).error;
    assert.equal(error.code, "INPUT_INVALID");
    assert.equal(error.effect, "not_sent");
  }
});

test("global request timeouts validate before config creation; legal maximum reaches transport", async () => {
  for (const value of ["0s", "01s", "1.5s", "1h30m", "25h", "86401s", "999999999999999999999999d", "1s\n"]) {
    const capture = captureIO();
    let factories = 0;
    assert.equal(await runCli(["workspace", "list", "--timeout", value], { io: capture.io, createConfigStore: () => { factories++; throw new Error("Must not create"); } }), 2);
    assert.equal(factories, 0);
  }
  const capture = captureIO();
  assert.equal(await runCli(["workspace", "list", "--timeout", "24h"], { io: capture.io, createConfigStore: () => ({ load: async () => ({ version: 1, apiOrigin: "http://example.test", cookie: null }), save: async () => {} }), http: {
    request: async (_origin, _path, request) => { assert.equal(request?.timeoutMs, 86_400_000); return { status: 200, body: "[]", setCookies: [] }; }
  } }), 0);
});
