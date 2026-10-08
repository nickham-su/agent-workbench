import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
export const componentTests = [
  "src/features/dashboard/Dashboard.component.test.ts",
  "src/features/settings/components/AgentProvidersSettingsPanel.component.test.ts",
  "src/features/workspace/tools/agent/agentArtifactCards.component.test.ts",
  "src/features/workspace/tools/agent/agentRichToolCards.component.test.ts",
  "src/features/workspace/tools/agent/agentSystemMessage.component.test.ts",
  "src/features/workspace/tools/agent/AgentAttachmentPreviewModal.component.test.ts",
  "src/features/workspace/tools/agent/AgentClientPane.component.test.ts",
  "src/features/workspace/tools/agent/AgentClientPane.attachmentPreview.component.test.ts",
  "src/features/workspace/tools/agent/AgentMessageActions.component.test.ts",
  "src/features/workspace/tools/agent/AgentToolView.component.test.ts",
  "src/features/workspace/tools/agent/useAgentSessionStatusStore.component.test.ts",
  "src/features/workspace/tools/scheduled-tasks/ScheduledTaskDrawer.component.test.ts",
  "src/features/workspace/tools/scheduled-tasks/ScheduledTasksToolView.component.test.ts",
];

export function parseConcurrency(args) {
  // Two isolated children trade memory for speed (~1.5 GiB observed Node RSS).
  // Use --concurrency=1 on memory-constrained machines.
  if (args.length === 0) return 2;
  if (args.length === 1 && /^--concurrency=[12]$/.test(args[0])) return Number(args[0].at(-1));
  throw new Error("Usage: run-component-tests.mjs [--concurrency=1|2]");
}

export function componentCommand(test, {
  root = webRoot,
  env = process.env,
  executable = process.execPath,
  cli = require.resolve("vite-node/vite-node.mjs"),
} = {}) {
  const bootstrap = pathToFileURL(resolve(root, "scripts/component-test-dom.mjs")).href;
  return {
    executable,
    args: [cli, "--config", "vite.component-test.config.ts", test],
    options: {
      cwd: root,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...env, NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --import=${bootstrap}`.trim() },
    },
  };
}

/** Keep each file isolated; retain complete output until that child's streams close. */
export function runComponentTests({
  tests = componentTests,
  concurrency = 2,
  spawnChild = spawn,
  commandFor = componentCommand,
  write = (stream, text) => process[stream].write(text),
  signals = process,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  cancellationGraceMs = 5_000,
} = {}) {
  if (concurrency !== 1 && concurrency !== 2) throw new Error("Component concurrency must be 1 or 2");
  return new Promise((resolveDone) => {
    const active = new Map();
    const results = [];
    let next = 0;
    let failed = false;
    let cancelledBy = null;
    let cancellationTimer = null;
    let finished = false;

    const report = (result) => {
      const status = `code=${result.code ?? "none"} signal=${result.signal ?? "none"}`;
      write("stdout", `[component:start] ${result.file}\n${result.stdout}${result.stdout.endsWith("\n") || !result.stdout ? "" : "\n"}[component:end] ${result.file} ${status}\n`);
      if (result.stderr || result.error) {
        write("stderr", `[component:stderr] ${result.file}\n${result.stderr}${result.stderr.endsWith("\n") || !result.stderr ? "" : "\n"}${result.error ? `${result.error.message}\n` : ""}`);
      }
    };
    const finishIfReady = () => {
      if (active.size !== 0 || (!failed && !cancelledBy && next < tests.length) || finished) return;
      finished = true;
      signals.off("SIGINT", onInterrupt);
      signals.off("SIGTERM", onTerminate);
      if (cancellationTimer !== null) clearTimer(cancellationTimer);
      const skipped = tests.slice(next);
      if (skipped.length) write("stderr", `[component:skipped] ${skipped.join(", ")}\n`);
      const exitCode = cancelledBy === "SIGINT" ? 130 : cancelledBy === "SIGTERM" ? 143 : failed ? 1 : 0;
      write("stdout", `[component:summary] ${JSON.stringify({ completed: results.length, skipped: skipped.length, exitCode, signal: cancelledBy })}\n`);
      resolveDone({ exitCode, signal: cancelledBy, results, skipped });
    };
    const cancel = (signal) => {
      if (finished || cancelledBy) return;
      cancelledBy = signal;
      for (const child of active.keys()) {
        try { child.kill(signal); } catch (error) { write("stderr", `[component:cancel] ${error.message}\n`); }
      }
      if (active.size > 0) {
        cancellationTimer = setTimer(() => {
          // Escalate only an explicit cancellation, never an ordinary test failure.
          for (const child of active.keys()) {
            try { child.kill("SIGKILL"); } catch (error) { write("stderr", `[component:cancel] ${error.message}\n`); }
          }
        }, cancellationGraceMs);
      }
      finishIfReady();
    };
    const onInterrupt = () => cancel("SIGINT");
    const onTerminate = () => cancel("SIGTERM");

    const pump = () => {
      while (!failed && !cancelledBy && active.size < concurrency && next < tests.length) {
        const file = tests[next++];
        const result = { file, code: null, signal: null, stdout: "", stderr: "", error: null };
        let child;
        try {
          const command = commandFor(file);
          child = spawnChild(command.executable, command.args, command.options);
        } catch (error) {
          result.error = error;
          failed = true;
          results.push(result);
          report(result);
          break;
        }
        active.set(child, result);
        const onStdout = (chunk) => { result.stdout += chunk.toString(); };
        const onStderr = (chunk) => { result.stderr += chunk.toString(); };
        const onError = (error) => {
          result.error = error;
          failed = true;
          // Node emits close after a spawn error; do not lose pending pipe output.
        };
        const onExit = (code, signal) => {
          // Stop scheduling immediately, but wait for close before reporting.
          if (code !== 0 || signal) failed = true;
        };
        const onClose = (code, signal) => {
          active.delete(child);
          child.off("error", onError);
          child.off("exit", onExit);
          child.off("close", onClose);
          child.stdout?.off("data", onStdout);
          child.stderr?.off("data", onStderr);
          result.code = code;
          result.signal = signal;
          if (result.error || code !== 0 || signal) failed = true;
          results.push(result);
          report(result);
          pump();
        };
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", onStdout);
        child.stderr?.on("data", onStderr);
        child.on("error", onError);
        child.on("exit", onExit);
        child.on("close", onClose);
      }
      finishIfReady();
    };
    signals.on("SIGINT", onInterrupt);
    signals.on("SIGTERM", onTerminate);
    pump();
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runComponentTests({ concurrency: parseConcurrency(process.argv.slice(2)) });
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
