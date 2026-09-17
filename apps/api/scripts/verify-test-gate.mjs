import { existsSync } from "node:fs";

const required = [
  "src/infra/db/schema.test.ts",
  "src/modules/agent/agent-message.store.test.ts",
  "src/modules/agent/read-side.api.test.ts",
  "src/modules/agent/run-lifecycle-baseline.api.test.ts",
  "src/modules/agent/integration/agent-message-attachments.integration.test.ts",
  "src/modules/agent/integration/agent-peripheral-status.integration.test.ts",
  "src/modules/agent/agent.worker.integration.test.ts",
];
const missing = required.filter((file) => !existsSync(file));
if (missing.length > 0) {
  throw new Error(`API test gate is missing required stage-nine coverage: ${missing.join(", ")}`);
}
