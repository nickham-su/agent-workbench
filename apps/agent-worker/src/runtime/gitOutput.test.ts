import assert from "node:assert/strict";
import test from "node:test";
import { GitOutputGuard, GIT_RAW_OUTPUT_MAX_BYTES, GIT_OUTPUT_HEAD_BYTES, GIT_OUTPUT_TAIL_BYTES, GIT_OUTPUT_TRUNCATION_MARKER } from "./gitOutput.js";

for (const stream of ["stdout", "stderr"] as const) {
  test(`Git output ${stream}: known secret, CRLF token, key and lease paths survive every chunk split`, () => {
    const values = ["fixture-secret-中文", "fixture-token", "fixture-token\r\nsecond\n", "-----FIXTURE KEY-----\nline\n-----END FIXTURE KEY-----\n", "/fixture/private/lease/token", "/fixture/private/lease/askpass.sh", "/fixture/private/lease"];
    for (const value of values) {
      const bytes = Buffer.from(`before ${value} after`, "utf8");
      for (let split = 1; split < bytes.length; split++) {
        const guard = new GitOutputGuard(values);
        guard.write(stream, bytes.subarray(0, split));
        guard.write(stream, bytes.subarray(split));
        const result = guard.finish();
        assert(!result[stream].includes(value));
        assert(result[stream].includes("before "));
        assert(result[stream].includes(" after"));
        assert(result.outputRedacted);
      }
    }
  });

  test(`Git output ${stream}: budget cuts and forced tails never expose partial secrets or lease paths`, () => {
    for (const value of ["fixture-secret-中文", "/fixture/private/lease/token"]) {
      const bytes = Buffer.from(`before ${value} after`);
      for (let keep = 1; keep < Buffer.byteLength(value); keep++) {
        const guard = new GitOutputGuard([value], Buffer.byteLength("before ") + keep);
        assert(guard.write(stream, bytes));
        const output = guard.finish()[stream];
        assert.equal(output, "before [REDACTED]");
      }
      const guard = new GitOutputGuard([value]);
      guard.write(stream, Buffer.from(`before ${value.slice(0, -1)}`));
      assert.equal(guard.finish(true)[stream], "before [REDACTED]");
    }
  });
}

test("Git output: complete patterns are matched before an incomplete suffix is discarded", () => {
  const guard = new GitOutputGuard(["abab", "prefix/"], 4);
  guard.write("stdout", Buffer.from("abab-more"));
  assert.equal(guard.finish().stdout, "[REDACTED]");
});

test("Git output: URL userinfo is removed even when scheme, authority and @ cross chunks", () => {
  const input = "failure https://fixture-user:fixture-password@example.test/repo.git and ssh://user:pass@host.test/path\n";
  for (let split = 1; split < input.length; split++) {
    const guard = new GitOutputGuard([]);
    guard.write("stderr", Buffer.from(input.slice(0, split)));
    guard.write("stderr", Buffer.from(input.slice(split)));
    const result = guard.finish();
    assert(!result.stderr.includes("fixture-user"));
    assert(!result.stderr.includes("fixture-password"));
    assert(!result.stderr.includes("user:pass"));
    assert(result.stderr.includes("https://[REDACTED]@example.test/repo.git"));
    assert(result.outputRedacted);
  }
  const guard = new GitOutputGuard([], 30);
  guard.write("stdout", Buffer.from("diagnostic https://fixture-user:fixture-password@host/path"));
  assert(!guard.finish().stdout.includes("fixture-user"));
});

test("Git output: combined raw budget counts secrets before replacement and continues draining", () => {
  const guard = new GitOutputGuard(["fixture-secret"], 128);
  guard.write("stdout", Buffer.from("fixture-secret".repeat(8)));
  assert(guard.write("stderr", Buffer.from("fixture-secret".repeat(8))));
  assert(guard.write("stdout", Buffer.alloc(1024 * 1024, 120)));
  const result = guard.finish();
  assert(!`${result.stdout}${result.stderr}`.includes("fixture-secret"));
  assert(guard.outputLimitExceeded);
});

test("Git output: raw budget is 512 KiB; safe retention is each stream's 64 KiB head plus 8 KiB tail", () => {
  assert.equal(GIT_RAW_OUTPUT_MAX_BYTES, 512 * 1024);
  const guard = new GitOutputGuard([]);
  guard.write("stdout", Buffer.from(`HEAD\n${"x".repeat(250_000)}\nTAIL`));
  guard.write("stderr", Buffer.from("y".repeat(200_000)));
  const result = guard.finish();
  assert(result.stdout.startsWith("HEAD\n"));
  assert(result.stdout.endsWith("\nTAIL"));
  assert(result.stdout.includes("head/tail retained"));
  const windowBytes = GIT_OUTPUT_HEAD_BYTES + GIT_OUTPUT_TAIL_BYTES + Buffer.byteLength(GIT_OUTPUT_TRUNCATION_MARKER);
  assert(Buffer.byteLength(result.stdout) <= windowBytes);
  assert(Buffer.byteLength(result.stderr) <= windowBytes);
  assert(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= GIT_RAW_OUTPUT_MAX_BYTES);
  assert(2 * windowBytes <= GIT_RAW_OUTPUT_MAX_BYTES);
  assert(!guard.outputLimitExceeded);
});

test("Git output: UTF-8 decoding and retained head/tail have no split code points", () => {
  const guard = new GitOutputGuard(["秘密哨兵"]);
  const input = Buffer.from(`${"a".repeat(GIT_OUTPUT_HEAD_BYTES - 1)}中文${"b".repeat(20_000)}秘密哨兵${"结束".repeat(3000)}`);
  for (let position = 0; position < input.length; position += 137) guard.write("stdout", input.subarray(position, position + 137));
  const result = guard.finish();
  assert(!result.stdout.includes("\ufffd"));
  assert(!result.stdout.includes("秘密哨兵"));
  assert(result.stdout.endsWith("结束"));
  assert(result.outputRedacted);
});

test("Git output: matching precedes retention caps; late known secrets and paths are still redacted", () => {
  const secret = "fixture-cap-secret";
  const leasePath = "/fixture/private/lease";
  const guard = new GitOutputGuard([secret, leasePath]);
  const input = Buffer.from(`${"a".repeat(GIT_OUTPUT_HEAD_BYTES - 3)}${secret}${"b".repeat(80_000)}${leasePath}\nTAIL`);
  for (let i = 0; i < input.length; i += 17) guard.write("stdout", input.subarray(i, i + 17));
  const result = guard.finish();
  assert(!result.stdout.includes(secret));
  assert(!result.stdout.includes(leasePath));
  assert(result.stdout.endsWith("\nTAIL"));
  assert(result.outputRedacted);
});

test("Git output: a 1 MiB key and partial suffix remain bounded without quadratic prefix search", () => {
  const key = `-----FIXTURE-----\n${"xyz".repeat(349_510)}\nEND`;
  const guard = new GitOutputGuard([key]);
  guard.write("stdout", Buffer.from(`${key}\nmore`));
  assert(guard.outputLimitExceeded);
  assert.equal(guard.finish().stdout, "[REDACTED]");
});

test("Git output: a long numeric scheme cannot lose userinfo redaction across streaming boundaries", () => {
  const input = `a${"1".repeat(256)}://fixture-user:fixture-password@example.test/path\n`;
  for (let split = 1; split < input.length; split++) {
    const guard = new GitOutputGuard([]);
    guard.write("stdout", Buffer.from(input.slice(0, split)));
    guard.write("stdout", Buffer.from(input.slice(split)));
    const output = guard.finish();
    assert(!output.stdout.includes("fixture-user"));
    assert(!output.stdout.includes("fixture-password"));
    assert(output.stdout.includes("://[REDACTED]@example.test/path"));
  }
});

test("Git output: draining after the cap does not rescan held matcher state with empty chunks", () => {
  const guard = new GitOutputGuard([], 128);
  const filter = (guard as unknown as { stdout: { write(chunk: Buffer): void } }).stdout;
  const original = filter.write; let calls = 0;
  filter.write = function(chunk) { calls++; original.call(this, chunk); };
  guard.write("stdout", Buffer.from(`https://${"x".repeat(256)}`));
  for (let i = 0; i < 100; i++) assert(guard.write("stdout", Buffer.alloc(4096, 120)));
  assert.equal(calls, 1);
  assert(guard.finish().outputRedacted);
});

for (const stdoutBytes of [0, 128 * 1024, 256 * 1024, 512 * 1024]) {
  for (const overflow of [false, true]) {
    test(`Git raw combined 512 KiB boundary: stdout=${stdoutBytes}, extra-byte=${overflow}`, () => {
      const guard = new GitOutputGuard([]);
      assert.equal(guard.write("stdout", Buffer.alloc(stdoutBytes, 120)), false);
      assert.equal(guard.write("stderr", Buffer.alloc(GIT_RAW_OUTPUT_MAX_BYTES - stdoutBytes, 121)), false);
      assert.equal(guard.outputLimitExceeded, false);
      if (overflow) {
        assert(guard.write("stderr", Buffer.from("z")));
        assert(guard.write("stdout", Buffer.from("ignored after cap")));
      }
      const result = guard.finish();
      assert.equal(guard.outputLimitExceeded, overflow);
      const windowBytes = GIT_OUTPUT_HEAD_BYTES + GIT_OUTPUT_TAIL_BYTES + Buffer.byteLength(GIT_OUTPUT_TRUNCATION_MARKER);
      assert(Buffer.byteLength(result.stdout) <= windowBytes);
      assert(Buffer.byteLength(result.stderr) <= windowBytes);
      assert(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= GIT_RAW_OUTPUT_MAX_BYTES);
    });
  }
}

for (const stream of ["stdout", "stderr"] as const) {
  test(`Git ${stream}: actual 512 KiB cap and chunk boundaries cannot expose known secret/path prefixes`, () => {
    for (const value of ["fixture-secret-中文", "/fixture/私有/lease-token"]) {
      const bytes = Buffer.from(value);
      for (let keep = 1; keep < bytes.length; keep++) {
        const guard = new GitOutputGuard([value]);
        const filler = Buffer.alloc(GIT_RAW_OUTPUT_MAX_BYTES - keep, 120);
        guard.write(stream, filler.subarray(0, filler.length - 5));
        guard.write(stream, Buffer.concat([filler.subarray(-5), bytes.subarray(0, Math.min(bytes.length, keep + 1))]));
        guard.write(stream, Buffer.concat([bytes.subarray(Math.min(bytes.length, keep + 1)), Buffer.from("after cut")]));
        const result = guard.finish();
        assert(guard.outputLimitExceeded); assert(result.outputRedacted);
        assert(!result[stream].includes(value)); assert(!result[stream].includes("\ufffd"));
        assert(result[stream].endsWith("[REDACTED]"));
        assert(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= GIT_RAW_OUTPUT_MAX_BYTES);
      }
    }
  });
}

test("Git replacement expansion cannot increase the raw 512 KiB allowance or final safe byte budget", () => {
  const guard = new GitOutputGuard(["abc"]);
  const raw = Buffer.from("abc".repeat(Math.ceil(GIT_RAW_OUTPUT_MAX_BYTES / 3)));
  for (let offset = 0; offset < GIT_RAW_OUTPUT_MAX_BYTES; offset += 64 * 1024) {
    assert.equal(guard.write("stdout", raw.subarray(offset, Math.min(GIT_RAW_OUTPUT_MAX_BYTES, offset + 64 * 1024))), false);
  }
  assert(guard.write("stderr", Buffer.from("z")));
  const result = guard.finish();
  assert(result.outputRedacted); assert(guard.outputLimitExceeded);
  assert(!result.stdout.includes("abc"));
  assert(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= GIT_RAW_OUTPUT_MAX_BYTES);
  assert(Buffer.byteLength(result.stdout) <= GIT_OUTPUT_HEAD_BYTES + GIT_OUTPUT_TAIL_BYTES + Buffer.byteLength(GIT_OUTPUT_TRUNCATION_MARKER));
});
