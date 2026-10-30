import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { repository } from "./helpers.js";

test("A-SECURITY-INTERNAL/REGRESSION-API: runtime CLI never imports database/API services or requests internal/settings/event endpoints", async () => {
  const directory = join(repository, "packages/cli/src");
  for (const name of await fs.readdir(directory)) {
    if (!name.endsWith(".ts")) continue;
    const source = await fs.readFile(join(directory, name), "utf8");
    for (const forbidden of ["better-sqlite3", "node:sqlite", "/api/internal/", "/api/settings/", "AWB_AGENT_INTERNAL_TOKEN", "AWB_INTERNAL_TOKEN", "apps/api/", "/events"]) assert.equal(source.includes(forbidden), false, `${name}: ${forbidden}`);
  }
});
