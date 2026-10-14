import assert from "node:assert/strict";
import test from "node:test";
import { GitToolError, gitSafeErrorText } from "./gitErrors.js";
import { projectGitDiagnostic } from "./gitDiagnostic.js";
import { executeGitTool } from "./git.js";
import { createGitFixture } from "./git.testkit.js";

function availableRepos(text: string) {
  const line = text.split("\n").find((value) => value.startsWith("availableRepos: "));
  assert(line, "the model-visible error must include an explicit JSON repository list");
  return JSON.parse(line.slice("availableRepos: ".length));
}

test("Git repository errors retain all validated names as escaped JSON and snapshot the list", () => {
  const names = [...Array.from({ length: 100 }, (_, index) => `current-${index}`), '中文 "repo'];
  const error = new GitToolError("REPO_NOT_AVAILABLE", names);
  names.splice(0, names.length, "later-change");
  const text = gitSafeErrorText(error);
  assert.equal(text, error.message);
  const repos = availableRepos(text);
  assert.equal(repos.length, 101);
  assert.equal(repos[100], '中文 "repo');
  assert(text.includes(JSON.stringify('中文 "repo')));
  assert(!text.includes("later-change"));
  assert(!Object.keys(error).includes("availableRepos"), "details must not become generic exception snapshot fields");
});

test("Git repository errors distinguish an explicit empty list from absent metadata", () => {
  assert.deepEqual(availableRepos(gitSafeErrorText(new GitToolError("REPO_NOT_AVAILABLE", []))), []);
  assert(!gitSafeErrorText(new GitToolError("REPO_NOT_AVAILABLE")).includes("availableRepos"));
});

for (const invalid of [["../fixture-private"], ["bad\nfixture"], [" padded "], [""], [7], "fixture-foreign-name"] as const) {
  test(`Git repository error rejects invalid list metadata: ${JSON.stringify(invalid)}`, () => {
    const error = new GitToolError("REPO_NOT_AVAILABLE", invalid as unknown as string[]);
    const text = gitSafeErrorText(error);
    assert.equal(text, "REPO_NOT_AVAILABLE: The selected repository is not currently registered.");
    assert(!text.includes("availableRepos"));
  });
}

test("Git error text never trusts arbitrary exception lists, accessors or raw bodies", () => {
  let getterCalls = 0;
  const hostile = Object.defineProperties(new Error("fixture-private-response-body"), {
    code: { value: "REPO_NOT_AVAILABLE" },
    availableRepos: { get() { getterCalls++; return ["fixture-foreign-name"]; } },
  });
  for (const error of [hostile, { code: "REPO_NOT_AVAILABLE", availableRepos: ["fixture-foreign-name"], body: "fixture-private-response-body" },
    Object.assign(new GitToolError("REPO_NOT_AVAILABLE"), { availableRepos: ["fixture-foreign-name"], cause: hostile })]) {
    const text = gitSafeErrorText(error);
    assert(!text.includes("fixture-foreign-name"));
    assert(!text.includes("fixture-private-response-body"));
    assert(!text.includes("availableRepos"));
  }
  assert.equal(getterCalls, 0);
});

test("Git errors outside repository availability cannot expose repository lists", () => {
  for (const code of ["RUN_CONTEXT_INVALID", "GIT_ENV_PREPARE_FAILED", "GIT_TOOL_FAILED"] as const) {
    assert(!gitSafeErrorText(new GitToolError(code, ["fixture-foreign-name"])).includes("availableRepos"));
  }
});

test("Git model-visible repository details do not expand the extra diagnostic projection", () => {
  const error = new GitToolError("REPO_NOT_AVAILABLE", ["latest-safe-name"]);
  assert.deepEqual(projectGitDiagnostic({ repo: "removed-repo", args: ["fixture-private-argv"], timeout: 1 }, { stage: "preflight", error }), {
    toolName: "git", repo: "removed-repo", argsCount: 1, timeout: 1, stage: "preflight", code: "REPO_NOT_AVAILABLE",
  });
  assert(gitSafeErrorText(error).includes("latest-safe-name"));
});

for (const [name, response, expectedCode] of [
  ["unvalidated path name", { ok: false, errorCode: "REPO_NOT_AVAILABLE", error: "fixture-private-response-body", availableRepos: ["../fixture-private"] }, "GIT_ENV_RPC_FAILED"],
  ["unvalidated control name", { ok: false, errorCode: "REPO_NOT_AVAILABLE", error: "fixture-private-response-body", availableRepos: ["bad\nfixture"] }, "GIT_ENV_RPC_FAILED"],
  ["non-array metadata", { ok: false, errorCode: "REPO_NOT_AVAILABLE", error: "fixture-private-response-body", availableRepos: "fixture-foreign-name" }, "GIT_ENV_RPC_FAILED"],
  ["unknown response fields", { ok: false, errorCode: "REPO_NOT_AVAILABLE", error: "fixture-private-response-body", availableRepos: ["fixture-foreign-name"], body: "fixture-private-response-body" }, "GIT_ENV_RPC_FAILED"],
  ["unknown error code", { ok: false, errorCode: "FIXTURE_UNKNOWN_FAILURE", error: "fixture-private-response-body", availableRepos: ["fixture-foreign-name"] }, "GIT_ENV_PREPARE_FAILED"],
  ["foreign owner error", { ok: false, errorCode: "RUN_CONTEXT_INVALID", error: "fixture-private-response-body", availableRepos: ["fixture-foreign-name"] }, "RUN_CONTEXT_INVALID"],
] as const) {
  test(`Git availability details require the strict prepare response and matching code: ${name}`, async (t) => {
    const fixture = await createGitFixture();
    t.after(fixture.cleanup);
    let prepares = 0, spawns = 0;
    fixture.ctx.apiClient.prepareRepoGitEnvLease = async () => { prepares++; return response as any; };
    await assert.rejects(executeGitTool({ repo: fixture.repo, args: ["status"] }, fixture.ctx, {
      dataDir: fixture.dataDir,
      runProcess: async () => { spawns++; throw new Error("fixture-must-not-start"); },
    }), (error: unknown) => {
      assert.equal((error as GitToolError).code, expectedCode);
      const text = gitSafeErrorText(error);
      assert(!text.includes("fixture-private"));
      assert(!text.includes("fixture-foreign-name"));
      assert(!text.includes("availableRepos"));
      return true;
    });
    assert.equal(prepares, 1, "failed prepare must not be retried");
    assert.equal(spawns, 0);
    assert.equal(fixture.released.length, 0);
  });
}
