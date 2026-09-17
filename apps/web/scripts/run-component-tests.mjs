import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const domBootstrap = resolve(webRoot, "scripts/component-test-dom.mjs");
const tests = [
  "src/features/workspace/tools/agent/agentArtifactCards.component.test.ts",
  "src/features/workspace/tools/agent/AgentMessageActions.component.test.ts",
];

for (const test of tests) {
  execFileSync("npx", ["vite-node", "--config", "vite.component-test.config.ts", "--script", test], {
    cwd: webRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${domBootstrap}`.trim(),
    },
  });
}
