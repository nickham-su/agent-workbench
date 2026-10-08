import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { componentCommand, componentTests, parseConcurrency, runComponentTests } from "./run-component-tests.mjs";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kills = [];
  kill(signal) { this.kills.push(signal); return true; }
  close(code = 0, signal = null) {
    this.emit("exit", code, signal);
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, signal);
  }
}

function fixture({ tests = ["a", "b", "c", "d"], concurrency = 2, spawnChild, commandFor } = {}) {
  const children = [];
  const output = [];
  const signals = new EventEmitter();
  const timers = new Map();
  let timerId = 0;
  const done = runComponentTests({
    tests,
    concurrency,
    spawnChild: spawnChild ?? (() => { const child = new FakeChild(); children.push(child); return child; }),
    commandFor: commandFor ?? ((file) => ({ executable: "node", args: [file], options: {} })),
    write: (stream, text) => output.push({ stream, text }),
    signals,
    setTimer: (callback, ms) => { const id = ++timerId; timers.set(id, { callback, ms }); return id; },
    clearTimer: (id) => timers.delete(id),
  });
  const assertClean = () => {
    assert.equal(signals.listenerCount("SIGINT"), 0);
    assert.equal(signals.listenerCount("SIGTERM"), 0);
    assert.equal(timers.size, 0);
    for (const child of children) {
      assert.equal(child.listenerCount("close"), 0);
      assert.equal(child.listenerCount("exit"), 0);
      assert.equal(child.listenerCount("error"), 0);
      assert.equal(child.stdout.listenerCount("data"), 0);
      assert.equal(child.stderr.listenerCount("data"), 0);
    }
  };
  return { done, children, output, signals, timers, assertClean };
}

test("concurrency defaults to two and accepts explicit serial/two", () => {
  assert.equal(parseConcurrency([]), 2);
  assert.equal(parseConcurrency(["--concurrency=1"]), 1);
  assert.equal(parseConcurrency(["--concurrency=2"]), 2);
});

test("unknown, duplicate and invalid arguments are rejected", () => {
  for (const args of [["--watch"], ["--concurrency=0"], ["--concurrency=3"], ["--concurrency=-1"], ["--concurrency=1.5"], ["--concurrency=01"], ["--concurrency", "2"], ["--concurrency=2", "--concurrency=2"]]) {
    assert.throws(() => parseConcurrency(args), /Usage:/);
  }
  for (const concurrency of [0, -1, 3, "2", null]) {
    assert.throws(() => runComponentTests({ concurrency }), /must be 1 or 2/);
  }
});

test("component command uses local JS CLI, same cwd, no shell and isolated pipes", () => {
  const require = createRequire(import.meta.url);
  const root = fileURLToPath(new URL("..", import.meta.url));
  const command = componentCommand("file.component.test.ts", { root, env: {} });
  assert.equal(command.executable, process.execPath);
  assert.deepEqual(command.args, [require.resolve("vite-node/vite-node.mjs"), "--config", "vite.component-test.config.ts", "file.component.test.ts"]);
  assert.equal(command.options.cwd, root);
  assert.equal(command.options.shell, false);
  assert.deepEqual(command.options.stdio, ["ignore", "pipe", "pipe"]);
});

test("bootstrap file URL safely handles spaces and preserves inherited Node options", () => {
  const root = resolve("component tests \"quoted\" 中文");
  const env = { NODE_OPTIONS: "--trace-warnings", TEST_SENTINEL: "kept" };
  const command = componentCommand("a", { root, env, executable: "node", cli: "local-cli" });
  const url = pathToFileURL(resolve(root, "scripts/component-test-dom.mjs")).href;
  assert.equal(command.options.env.NODE_OPTIONS, `--trace-warnings --import=${url}`);
  assert.ok(url.includes("%20"));
  assert.ok(url.includes("%22"));
  assert.equal(command.options.env.TEST_SENTINEL, "kept");
  assert.equal(env.NODE_OPTIONS, "--trace-warnings");
});

test("default component list contains thirteen unique files", () => {
  assert.equal(componentTests.length, 13);
  assert.equal(new Set(componentTests).size, 13);
  assert.ok(componentTests.every((file) => file.endsWith(".component.test.ts")));
});

for (const concurrency of [1, 2]) {
  test(`queue runs every file once with at most ${concurrency} children`, async () => {
    const started = [];
    const f = fixture({ concurrency, commandFor: (file) => { started.push(file); return { executable: "node", args: [file], options: {} }; } });
    assert.equal(f.children.length, concurrency);
    let closed = 0;
    while (closed < 4) {
      assert.ok(f.children.length - closed <= concurrency);
      f.children[closed++].close();
    }
    const result = await f.done;
    assert.equal(result.exitCode, 0);
    assert.deepEqual(started, ["a", "b", "c", "d"]);
    assert.deepEqual(result.results.map((item) => item.file), started);
    assert.deepEqual(result.skipped, []);
    f.assertClean();
  });
}

test("a completed second child refills its slot without waiting for the first", async () => {
  const f = fixture();
  f.children[1].close();
  assert.equal(f.children.length, 3);
  f.children[2].close();
  assert.equal(f.children.length, 4);
  f.children[0].close();
  f.children[3].close();
  const result = await f.done;
  assert.deepEqual(result.results.map((item) => item.file), ["b", "c", "a", "d"]);
  f.assertClean();
});

test("stdout/stderr retain whole per-file blocks, including split UTF-8", async () => {
  const f = fixture({ tests: ["a", "b"] });
  const encoded = Buffer.from("中文\n");
  f.children[0].stdout.write(encoded.subarray(0, 1));
  f.children[1].stdout.write("B1\n");
  f.children[0].stdout.write(encoded.subarray(1));
  f.children[0].stderr.write("original error detail\n");
  assert.deepEqual(f.output, []);
  f.children[1].close();
  f.children[0].close(2);
  const result = await f.done;
  assert.equal(result.exitCode, 1);
  assert.equal(result.results[1].stdout, "中文\n");
  assert.match(f.output[0].text, /^\[component:start\] b\nB1\n\[component:end\] b code=0/);
  assert.match(f.output[1].text, /^\[component:start\] a\n中文\n\[component:end\] a code=2/);
  assert.match(f.output[2].text, /original error detail/);
  f.assertClean();
});

test("exit is not completion; trailing output is retained until close", async () => {
  const f = fixture({ concurrency: 1, tests: ["a", "b"] });
  f.children[0].emit("exit", 0, null);
  assert.equal(f.children.length, 1);
  f.children[0].stdout.write("trailing diagnostic\n");
  f.children[0].emit("close", 0, null);
  assert.equal(f.children.length, 2);
  f.children[1].close();
  const result = await f.done;
  assert.match(result.results[0].stdout, /trailing diagnostic/);
  f.assertClean();
});

test("nonzero exit stops the queue immediately but drains running siblings", async () => {
  const f = fixture();
  f.children[0].emit("exit", 1, null);
  f.children[1].close();
  assert.equal(f.children.length, 2);
  assert.equal(f.signals.listenerCount("SIGTERM"), 1);
  f.children[0].stderr.write("failure must be preserved\n");
  f.children[0].emit("close", 1, null);
  const result = await f.done;
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.skipped, ["c", "d"]);
  assert.ok(f.output.some(({ text }) => text.includes("failure must be preserved")));
  assert.ok(f.children.every((child) => child.kills.length === 0));
  f.assertClean();
});

test("signal exit is a failure and does not schedule more files", async () => {
  const f = fixture({ concurrency: 1 });
  f.children[0].close(null, "SIGSEGV");
  const result = await f.done;
  assert.equal(result.exitCode, 1);
  assert.equal(result.results[0].signal, "SIGSEGV");
  assert.deepEqual(result.skipped, ["b", "c", "d"]);
  f.assertClean();
});

test("synchronous spawn failure preserves its error and cleans listeners", async () => {
  const error = new Error("spawn threw");
  const f = fixture({ spawnChild: () => { throw error; } });
  const result = await f.done;
  assert.equal(result.exitCode, 1);
  assert.equal(result.results[0].error, error);
  assert.deepEqual(result.skipped, ["b", "c", "d"]);
  assert.ok(f.output.some(({ text }) => text.includes("spawn threw")));
  f.assertClean();
});

test("asynchronous spawn error waits for close and is recorded only once", async () => {
  const f = fixture();
  const error = new Error("ENOENT");
  f.children[0].emit("error", error);
  f.children[1].close();
  assert.equal(f.children.length, 2);
  f.children[0].emit("close", -2, null);
  const result = await f.done;
  assert.equal(result.results.length, 2);
  assert.equal(result.results[1].error, error);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.skipped, ["c", "d"]);
  f.assertClean();
});

test("command setup error follows the same failure path", async () => {
  const f = fixture({ commandFor: () => { throw new Error("missing local dependency"); } });
  const result = await f.done;
  assert.equal(result.exitCode, 1);
  assert.equal(f.children.length, 0);
  assert.match(result.results[0].error.message, /missing local dependency/);
  f.assertClean();
});

for (const [signal, exitCode] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  test(`${signal} forwards to owned children, stops scheduling and cleans grace timer`, async () => {
    const f = fixture();
    f.signals.emit(signal);
    assert.ok(f.children.every((child) => child.kills.join() === signal));
    assert.equal(f.timers.size, 1);
    assert.equal([...f.timers.values()][0].ms, 5_000);
    f.signals.emit(signal);
    assert.ok(f.children.every((child) => child.kills.length === 1));
    f.children[0].close(null, signal);
    f.children[1].close(null, signal);
    const result = await f.done;
    assert.equal(result.exitCode, exitCode);
    assert.deepEqual(result.skipped, ["c", "d"]);
    f.assertClean();
  });
}

test("cancellation alone escalates still-active owned children after grace", async () => {
  const f = fixture();
  f.signals.emit("SIGTERM");
  f.children[0].close(null, "SIGTERM");
  [...f.timers.values()][0].callback();
  assert.deepEqual(f.children[0].kills, ["SIGTERM"]);
  assert.deepEqual(f.children[1].kills, ["SIGTERM", "SIGKILL"]);
  f.children[1].close(null, "SIGKILL");
  assert.equal((await f.done).exitCode, 143);
  f.assertClean();
});

test("an ordinary failure never starts an escalation timer or kills siblings", async () => {
  const f = fixture();
  f.children[0].close(1);
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.children[1].kills, []);
  f.children[1].close();
  assert.equal((await f.done).exitCode, 1);
  f.assertClean();
});

test("an empty queue resolves successfully and leaves no listeners", async () => {
  const f = fixture({ tests: [] });
  assert.equal((await f.done).exitCode, 0);
  assert.equal(f.children.length, 0);
  f.assertClean();
});
