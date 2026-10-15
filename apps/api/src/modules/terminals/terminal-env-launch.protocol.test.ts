import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import {
  assertTerminalEnvironmentPayload, assertTerminalLaunchStatus, buildTerminalEnvironment,
  createTerminalEnvironmentPayload, isTerminalEnvironmentIdentity, terminalEnvironmentIdentity,
  terminalEnvironmentScopes, terminalLaunchSpawnErrorCode, TerminalEnvironmentLaunchError
} from "./terminal-env-launch.protocol.js";

const makePayload = () => createTerminalEnvironmentPayload({ attemptId: "te-test", shell: "/bin/sh",
  baseEnv: { PATH: "/base", TMUX: "stale", AWB_INTERNAL_TOKEN: "fixture-secret", NODE_OPTIONS: "base-late" },
  systemEnv: { HTTP_PROXY: "system", GIT_ASKPASS: "/fixed/system", AWB_SYSTEM: "fixture-secret" },
  workspaceEnv: JSON.parse('{"HTTP_PROXY":"workspace","http_proxy":"independent","EMPTY":"","VALUE":" \\r\\n$PATH $(touch never) 😀é ","__proto__":"own","constructor":"ordinary","NODE_OPTIONS":"workspace-late"}')
});
function invalid(action: () => unknown) {
  assert.throws(action, (error) => error instanceof TerminalEnvironmentLaunchError && error.code === "TERMINAL_ENV_PROTOCOL_FAILED");
}
test("terminal payload is literal, layered, own-key safe and AWB filtered without changing inputs", () => {
  const payload = makePayload();
  assert.equal(Object.hasOwn(payload.baseEnv, "TMUX"), false);
  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes("fixture-secret"), false);
  const env = buildTerminalEnvironment(payload, { TERM: "actual", TMUX: "actual-tmux", TMUX_PANE: "%1", HTTP_PROXY: "stale-server", STALE_SERVER: "not-allowed" });
  assert.equal(env.HTTP_PROXY, "workspace"); assert.equal(env.http_proxy, "independent"); assert.equal(env.EMPTY, "");
  assert.equal(env.VALUE, " \r\n$PATH $(touch never) 😀é "); assert.equal(env.__proto__, "own"); assert.equal(env.constructor, "ordinary");
  assert.equal(env.TMUX, "actual-tmux"); assert.equal(env.TMUX_PANE, "%1"); assert.equal(env.TERM, "actual");
  assert.equal(env.STALE_SERVER, undefined); assert.equal(env.GIT_ASKPASS, "/fixed/system");
  assert.equal(env.NODE_OPTIONS, "workspace-late"); assert.equal(Object.getPrototypeOf(env), null);
  assert.equal(JSON.stringify(payload), serialized);
});
test("Workspace can override exact runtime metadata without hidden extra reserved keys", () => {
  const payload = makePayload(); payload.workspaceEnv.TMUX = "user-literal"; payload.workspaceEnv.TERM = "user-term";
  assert.equal(buildTerminalEnvironment(payload, { TMUX: "server", TERM: "server" }).TMUX, "user-literal");
  assert.equal(buildTerminalEnvironment(payload, { TMUX: "server", TERM: "server" }).TERM, "user-term");
});
test("payload rejects unknown structure, bad identity/version, protected overrides and lossy strings", () => {
  const changes = [
    { version: 2 }, { attemptId: "other" }, { extra: "not-allowed" }, { shell: "" }, { shell: "sh\0" },
    { shell: "\ud800" }, { baseEnv: { BAD: "\udc00" } }, { systemEnv: { BAD: "nul\0" } },
    { baseEnv: { TMUX: "stale" } }, { baseEnv: { AWB_BAD: "secret" } }, { systemEnv: { "BAD=KEY": "bad" } },
    { workspaceEnv: { GIT_ASKPASS: "not-authorized" } }, { workspaceEnv: { AWB_BAD: "secret" } },
    { workspaceEnv: { VALUE: "\ud800" } }, { workspaceEnv: { VALUE: "x".repeat(16385) } },
    { workspaceEnv: Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`V${i}`, ""])) },
    { baseEnv: { BIG: "x".repeat(1024 * 1024) } }
  ];
  for (const change of changes) invalid(() => assertTerminalEnvironmentPayload({ ...makePayload(), ...change }, "te-test"));
  invalid(() => createTerminalEnvironmentPayload({ attemptId: "te-test", shell: "sh", baseEnv: {}, systemEnv: {}, workspaceEnv: { AWB_BAD: "must-not-silently-disappear" } }));
});
test("status strictly binds combinations and attempt identity", () => {
  for (const state of ["pending", "spawned"]) assertTerminalLaunchStatus({ version: 1, attemptId: "te-test", state }, "te-test");
  assertTerminalLaunchStatus({ version: 1, attemptId: "te-test", state: "spawn-error", code: "ENV_TOO_LARGE" }, "te-test");
  for (const value of [null, { version: 1, attemptId: "other", state: "spawned" }, { version: 2, attemptId: "te-test", state: "spawned" },
    { version: 1, attemptId: "te-test", state: "spawned", code: "SHELL_NOT_FOUND" },
    { version: 1, attemptId: "te-test", state: "spawn-error" }, { version: 1, attemptId: "te-test", state: "spawn-error", code: "raw-secret-error" }]) {
    invalid(() => assertTerminalLaunchStatus(value, "te-test"));
  }
});
test("durable identities are canonical and safe; retirement scopes are stable exact SHA256", () => {
  assert.deepEqual(terminalEnvironmentIdentity({ dev: 7, ino: 99 }), { dev: "7", ino: "99" });
  invalid(() => terminalEnvironmentIdentity({ dev: 7, ino: Number.MAX_SAFE_INTEGER + 1 }));
  for (const value of [{ dev: "01", ino: "1" }, { dev: "1", ino: "-1" }, { dev: "1", ino: "9007199254740992" }, { dev: 1, ino: "1" }]) {
    assert.equal(isTerminalEnvironmentIdentity(value), false);
  }
  const token = createHash("sha256").update("te-test", "utf8").digest("hex").slice(0, 32);
  assert.deepEqual(terminalEnvironmentScopes("te-test"), { payload: `ep-${token}`, status: `es-${token}`, directory: `ed-${token}` });
  assert.equal(terminalEnvironmentScopes("te-test").directory.length, 35);
  invalid(() => terminalEnvironmentScopes("../escape"));
});
test("spawn error classification never retains raw error text", () => {
  assert.equal(terminalLaunchSpawnErrorCode({ code: "ENOENT", message: "fixture-secret" }), "SHELL_NOT_FOUND");
  assert.equal(terminalLaunchSpawnErrorCode({ code: "E2BIG", message: "fixture-secret" }), "ENV_TOO_LARGE");
  assert.equal(terminalLaunchSpawnErrorCode(new Error("fixture-secret")), "SHELL_SPAWN_FAILED");
  assert.equal(String(new TerminalEnvironmentLaunchError("TERMINAL_ENV_SPAWN_FAILED")).includes("fixture-secret"), false);
});
