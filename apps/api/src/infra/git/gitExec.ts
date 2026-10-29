import { spawn } from "node:child_process";

export type ExecResult = {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  failure?: "timeout" | "output-limit" | "spawn";
};

export type ExecBufferResult = Omit<ExecResult, "stdout"> & { stdout: Buffer };

type GitExecOptions = {
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
};

const repositoryEnvironmentKeys = new Set([
  "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_PREFIX", "GIT_IMPLICIT_WORK_TREE",
  "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT", "GIT_GRAFT_FILE", "GIT_SHALLOW_FILE", "GIT_REPLACE_REF_BASE"
]);

/** A parent Git process must not redirect this service's explicitly selected repository. */
export function buildGitProcessEnv(overrides: NodeJS.ProcessEnv = {}, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...inherited };
  for (const key of Object.keys(env)) {
    if (repositoryEnvironmentKeys.has(key) || key.startsWith("GIT_CONFIG_KEY_") || key.startsWith("GIT_CONFIG_VALUE_")) delete env[key];
  }
  return { ...env, ...overrides };
}

export async function runGit(args: string[], opts: GitExecOptions = { cwd: process.cwd() }): Promise<ExecResult> {
  const result = await runGitBuffer(args, opts);
  return { ...result, stdout: result.stdout.toString("utf8") };
}

// SIGKILL is sent to the owned POSIX group before pipes are closed. Do not wait forever
// for `close`: a helper can retain the inherited pipes after the Git parent has exited.
const TERMINATION_GRACE_MS = 100;

export async function runGitBuffer(args: string[], opts: GitExecOptions = { cwd: process.cwd() }): Promise<ExecBufferResult> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const maxBytes = opts.maxOutputBytes ?? Infinity;
  const ownProcessGroup = process.platform !== "win32";
  return new Promise<ExecBufferResult>((resolve) => {
    const child = spawn("git", args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: ownProcessGroup,
      env: buildGitProcessEnv(opts.env)
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let bytes = 0;
    let failure: ExecBufferResult["failure"];
    let settled = false;
    let exitCode: number | null = null;
    let pendingError: Error | undefined;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    let taskKiller: ReturnType<typeof spawn> | undefined;
    const deadline = setTimeout(() => terminate("timeout"), timeoutMs);
    const closePipes = () => {
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (cleanupTimer) clearTimeout(cleanupTimer);
      resolve({
        ok: code === 0 && !failure,
        code,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks).toString("utf8") + (pendingError ? String(pendingError.message) : ""),
        ...(failure ? { failure } : {})
      });
    };
    const terminate = (reason: NonNullable<ExecBufferResult["failure"]>, error?: Error) => {
      if (settled || failure) return;
      failure = reason;
      pendingError = error;
      clearTimeout(deadline);
      const killDirect = () => { try { child.kill("SIGKILL"); } catch { /* already exited */ } };
      if (ownProcessGroup && child.pid && child.pid > 0) {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch { killDirect(); }
      } else if (process.platform === "win32" && child.pid && child.pid > 0) {
        // Native tree-kill fallback; no shell interpolation and only our child's PID is accepted.
        try {
          taskKiller = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
          taskKiller.on("error", killDirect);
          taskKiller.on("close", killDirect);
        } catch { killDirect(); }
      } else {
        killDirect();
      }
      cleanupTimer = setTimeout(() => {
        // Bound the native termination helper as well; it must not retain this request.
        if (taskKiller) { try { taskKiller.kill("SIGKILL"); } catch { /* already exited */ } }
        closePipes();
        settle(exitCode);
      }, process.platform === "win32" ? 1000 : TERMINATION_GRACE_MS);
    };
    const append = (chunks: Buffer[], chunk: Buffer) => {
      if (settled || failure) return;
      bytes += chunk.byteLength;
      if (bytes > maxBytes) { terminate("output-limit"); return; }
      chunks.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => append(stdoutChunks, chunk));
    child.stderr.on("data", (chunk: Buffer) => append(stderrChunks, chunk));
    child.stdout.on("error", (error) => terminate("spawn", error));
    child.stderr.on("error", (error) => terminate("spawn", error));
    child.on("exit", (code) => { exitCode = code; });
    child.on("error", (error) => {
      if (!child.pid) {
        failure = "spawn";
        pendingError = error;
        closePipes();
        settle(null);
      } else terminate("spawn", error);
    });
    child.on("close", (code) => {
      exitCode = code;
      if (!failure) settle(code);
    });
  });
}
