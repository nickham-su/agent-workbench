import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createApp } from "../../../app/createApp.js";
import { openDb } from "../../../infra/db/db.js";
import { ensureDir, rmrf } from "../../../infra/fs/fs.js";
import { workspaceRoot } from "../../../infra/fs/paths.js";
import { insertWorkspace } from "../../workspaces/workspace.store.js";
import { setSettingJson } from "../../settings/settings.store.js";
import { newSortableId } from "../../../utils/ids.js";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createPluginHostFixture() {
  const repoRoot = path.resolve(process.cwd(), "../..");
  const dataDir = await fs.mkdtemp(path.join(repoRoot, ".tmp-tests", "agent-plugin-host-integration-"));
  const db = await openDb(dataDir);
  const internalToken = "test-internal-token";
  try {
    const workspaceId = newSortableId("ws");
    const workspaceDirName = newSortableId("workspace");
    const workspacePath = workspaceRoot(dataDir, workspaceDirName);
    await ensureDir(workspacePath);
    const createdAt = Date.now();
    insertWorkspace(db, { id: workspaceId, dirName: workspaceDirName, title: "it-workspace", path: workspacePath, terminalCredentialId: null, createdAt, updatedAt: createdAt });
    const app = await createApp({
      db, repoRoot, dataDir, fileMaxBytes: 1024 * 1024, version: "test", logLevel: "error", serveWeb: false, webDistDir: null,
      credentialMasterKey: Buffer.alloc(32, 7), credentialMasterKeySource: "generated", credentialMasterKeyId: "testkey", credentialMasterKeyCreatedAt: createdAt,
      authToken: null, authCookieSecure: false, agentWorkerEnabled: false, agentWorkerHost: "127.0.0.1", agentWorkerPort: 0,
      agentWorkerSocketPath: path.join(dataDir, "agent-worker.sock"), agentWorkerConcurrency: 0, agentInternalToken: internalToken,
      agentWorkerResponseValidation: "strict", agentApiOrigin: "http://127.0.0.1:0", agentStartupRecoveryMode: "recover",
      agentPluginHostEnabled: true, agentPluginHostSocketPath: path.join(dataDir, "agent-plugin-host.sock"), agentPluginServicesEnabled: true
    });
    await app.ready();
    const providersRes = await app.inject({ method: "PUT", url: "/api/settings/agent/providers", payload: { default: { providerId: "ppchat", modelId: "gpt-5.2" }, providers: [{ id: "ppchat", name: "ppchat", npm: "@ai-sdk/openai", options: { baseURL: "https://code.ppchat.vip/v1", apiKey: "sk-test" }, models: [{ id: "gpt-5.2", name: "gpt-5.2", contextWindowTokens: 128000 }] }] } });
    assert.equal(providersRes.statusCode, 200, `configure providers failed: ${providersRes.body}`);
    setSettingJson(db, "agent_channel_sender_allowlist_v1", { items: [{ channel: "feishu", senderId: "u_allowed", remark: "default test allowlist" }] }, Date.now());
    let disposed = false;
    return { app, dataDir, internalToken, async dispose() { if (disposed) return; disposed=true; const failures: unknown[]=[]; try { await app.close(); } catch (error) { failures.push(error); } try { db.close(); } catch (error) { failures.push(error); } try { await rmrf(dataDir); } catch (error) { failures.push(error); } if (failures.length===1) throw failures[0]; if (failures.length>1) throw new AggregateError(failures, `Failed to dispose plugin-host fixture at ${dataDir}`); } };
  } catch (error) {
    try { db.close(); } catch { /* cleanup */ }
    await rmrf(dataDir);
    throw error;
  }
}

test("plugin-host services reconcile can start/stop feishu gateway", async () => {
  const fixture = await createPluginHostFixture();
  try {;

  // Prepare a mock feishu plugin under dataDir/plugins so plugin discovery can find it.
  // We intentionally avoid network calls in tests.
  const pluginRoot = path.join(fixture.dataDir, "plugins", "feishu");
  await ensureDir(path.join(pluginRoot, "dist"));
  await fs.writeFile(
    path.join(pluginRoot, "agent-workbench.plugin.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        id: "feishu",
        name: "Feishu IM",
        version: "0.0.0-test",
        description: "mock feishu plugin for integration tests",
        entry: "dist/index.mjs",
        capabilities: ["services"],
        services: [{ name: "gateway" }],
        uiHints: { sensitiveKeys: ["appSecret"] },
        configSchema: {
          type: "object",
          additionalProperties: false,
          required: ["appId", "appSecret"],
          properties: {
            appId: { type: "string", minLength: 1 },
            appSecret: { type: "string", minLength: 1 }
          }
        }
      },
      null,
      2
    ),
    "utf8"
  );
  await fs.writeFile(
    path.join(pluginRoot, "dist", "index.mjs"),
    [
      "export default {",
      "  meta: { id: 'feishu', name: 'Feishu IM', version: '0.0.0-test' },",
      "  services: {",
      "    gateway: {",
      "      async start() {",
      "        // no-op gateway (no network)",
      "        return { stop: async () => {} };",
      "      }",
      "    }",
      "  }",
      "};",
      ""
    ].join("\n"),
    "utf8"
  );

  // Enable plugin with minimal config.
  const enableRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/plugins",
    payload: {
      plugins: [
        {
          id: "feishu",
          enabled: true,
          config: { appId: "test", appSecret: "test" }
        }
      ]
    }
  });
  assert.equal(enableRes.statusCode, 200, `enable plugin failed: ${enableRes.body}`);

  // Wait for services runtime reconcile hook to fire.
  await sleep(800);

  const host = new (await import("../agent.plugin-host-client.js" as any)).AgentPluginHostClient({
    pluginHostSocketPath: path.join(fixture.dataDir, "agent-plugin-host.sock"),
    internalToken: fixture.internalToken,
    logger: fixture.app.log
  });

  const status1 = await host.getServicesStatus();
  assert.equal(status1.running, true, `expected running=true, got running=${String(status1.running)}`);

  // Disable plugin.
  const disableRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/plugins",
    payload: {
      plugins: [
        {
          id: "feishu",
          enabled: false
        }
      ]
    }
  });
  assert.equal(disableRes.statusCode, 200, `disable plugin failed: ${disableRes.body}`);
  await sleep(500);
  const status2 = await host.getServicesStatus();
  assert.equal(status2.running, false, `expected running=false, got running=${String(status2.running)}`);  } finally {
    await fixture.dispose();
  }
});
