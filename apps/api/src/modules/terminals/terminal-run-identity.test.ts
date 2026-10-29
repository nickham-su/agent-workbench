import assert from "node:assert/strict";
import { test } from "node:test";
import { isTerminalRunIdentity, readTerminalRunIdentity } from "./terminal-run-identity.js";

const bootId = "11111111-2222-3333-4444-555555555555";
const stat = (comm = "tini", ticks = "12345678901234567890") => `1 (${comm}) S ${Array(18).fill("0").join(" ")} ${ticks} ${Array(30).fill("0").join(" ")}\n`;
const reader = (procStat = stat(), boot = `${bootId}\n`) => async (file: string) => {
  if (file === "/proc/sys/kernel/random/boot_id") return boot;
  assert.equal(file, "/proc/1/stat");
  return procStat;
};

test("runtime identity is stable across API restarts and preserves PID 1 ticks without precision loss", async () => {
  const first = await readTerminalRunIdentity(reader());
  assert.equal(first, `${bootId}:12345678901234567890`);
  assert.equal(await readTerminalRunIdentity(reader()), first);
  assert.notEqual(await readTerminalRunIdentity(reader(stat("tini", "20"))), first);
  assert.notEqual(await readTerminalRunIdentity(reader(stat(), "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")), first);
});

for (const comm of ["tini with spaces", "init (nested) worker)", "init) S 1 (more)", "init\nworker"]) {
  test(`PID 1 stat parsing accepts comm ${JSON.stringify(comm)}`, async () => {
    assert.equal(await readTerminalRunIdentity(reader(stat(comm))), `${bootId}:12345678901234567890`);
  });
}

for (const ticks of ["-1", "01", "1e3", "NaN", "", "+2"]) {
  test(`invalid starttime ${JSON.stringify(ticks)} cannot authorize recovery`, async () => {
    await assert.rejects(readTerminalRunIdentity(reader(stat("tini", ticks))), { code: "TERMINAL_RUN_IDENTITY_UNAVAILABLE" });
  });
}

test("malformed identity input fails with a controlled diagnostic", async () => {
  for (const input of [stat().replace("1 (", "2 ("), "1 (tini S 0", "1 (tini) S 0", stat().replace(" S 0", " S x")]) {
    await assert.rejects(readTerminalRunIdentity(reader(input)), { code: "TERMINAL_RUN_IDENTITY_UNAVAILABLE" });
  }
  await assert.rejects(readTerminalRunIdentity(reader(stat(), "not-a-boot-id")), { code: "TERMINAL_RUN_IDENTITY_UNAVAILABLE" });
  for (const file of ["/proc/sys/kernel/random/boot_id", "/proc/1/stat"]) {
    await assert.rejects(readTerminalRunIdentity(async (name) => {
      if (name === file) throw new Error("private filesystem diagnostic");
      return reader()(name);
    }), (error: unknown) => error instanceof Error && !error.message.includes("private filesystem diagnostic")
      && "code" in error && error.code === "TERMINAL_RUN_IDENTITY_UNAVAILABLE");
  }
  for (const value of [undefined, null, "", `${bootId}:-1`, `${bootId}:1.5`, `${bootId}:01`, `${bootId}:1\n`, {}]) assert.equal(isTerminalRunIdentity(value), false);
});
