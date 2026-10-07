import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { repository } from "./helpers.js";

test("root gates explicitly include the CLI and build its prerequisites before parallel tests", async () => {
  const root = JSON.parse(await fs.readFile(join(repository, "package.json"), "utf8")) as { scripts: Record<string, string> };
  for (const script of ["build", "typecheck", "test"]) {
    const value = root.scripts[script];
    assert.ok(value.includes("packages/shared"));
    assert.ok(value.includes("packages/cli"));
    assert.ok(value.indexOf("packages/shared") < value.indexOf("packages/cli"));
  }
  assert.match(root.scripts["test:parallel"], /npm test -w packages\/cli/);
  assert.ok(root.scripts.test.indexOf("packages/cli") < root.scripts.test.indexOf("test:parallel"));
});

test("Docker definition installs the executable outside HOME and includes its workspace before npm ci", async () => {
  const dockerfile = await fs.readFile(join(repository, "Dockerfile"), "utf8");
  const copyManifest = "COPY packages/cli/package.json packages/cli/package.json";
  assert.ok(dockerfile.includes(copyManifest));
  assert.ok(dockerfile.indexOf(copyManifest) < dockerfile.indexOf("RUN npm ci"));
  assert.match(dockerfile, /COPY --from=builder \/app\/packages\/cli \/app\/packages\/cli/);
  assert.match(dockerfile, /COPY --from=builder \/app\/packages\/cli\/dist\/cli\.cjs \/opt\/awb-cli\/cli\.cjs/);
  assert.match(dockerfile, /chmod 0755 \/opt\/awb-cli\/cli\.cjs/);
  assert.match(dockerfile, /ln -s \/opt\/awb-cli\/cli\.cjs \/usr\/local\/bin\/awb/);
  assert.ok(dockerfile.indexOf("/usr/local/bin/awb") < dockerfile.indexOf("USER dev"));
  assert.match(dockerfile, /ENV HOME=\/home\/dev/);
  assert.match(dockerfile, /VOLUME \["\/data", "\/home\/dev"\]/);
  assert.doesNotMatch(dockerfile, /COPY[^\n]*cli[^\n]*\/home\/dev/);
  // This checks the build definition only, not a Docker image or mounted volume.
});
