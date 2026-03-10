import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { openDb } from "../../infra/db/db.js";
import { ensureDir, rmrf } from "../../infra/fs/fs.js";
import { setSettingJson } from "../settings/settings.store.js";
import { listPluginRuntimeSnapshots, updateAgentPluginSettings } from "./plugin.service.js";

async function createFixture() {
  const repoRoot = path.resolve(process.cwd());
  const testsRoot = path.join(repoRoot, ".tmp-tests");
  await ensureDir(testsRoot);
  const dataDir = await fs.mkdtemp(path.join(testsRoot, "plugin-service-it-"));
  const db = await openDb(dataDir);
  return {
    dataDir,
    db,
    async close() {
      db.close();
      await rmrf(dataDir);
    }
  };
}

test("plugin service discovers debug-tools fixture and exposes runtime snapshot", async () => {
  const fixture = await createFixture();
  try {
    const sourcePluginDir = path.join(process.cwd(), "test", "fixtures", "plugins", "debug-tools");
    const targetPluginDir = path.join(fixture.dataDir, "plugins", "debug-tools");
    await ensureDir(path.join(fixture.dataDir, "plugins"));
    await fs.cp(sourcePluginDir, targetPluginDir, { recursive: true });

    await setSettingJson(fixture.db, "agent_plugins_v1", {
      plugins: [{ id: "debug-tools", enabled: true }]
    }, Date.now());

    const snapshots = await listPluginRuntimeSnapshots({
      db: fixture.db,
      dataDir: fixture.dataDir
    } as any);

    const debugPlugin = snapshots.plugins.find((item) => item.id === "debug-tools");
    assert.ok(debugPlugin, "debug-tools should be discovered");
    assert.equal(debugPlugin?.enabled, true);
    assert.equal(debugPlugin?.state, "ready");
    assert.equal(debugPlugin?.manifest?.id, "debug-tools");
    assert.equal(debugPlugin?.manifest?.version, "0.1.0");
    assert.ok(debugPlugin?.entryPath?.endsWith(path.join("plugins", "debug-tools", "dist", "index.js")));
    assert.ok(
      debugPlugin?.capabilities.tools?.some((tool) => tool.canonicalName === "plugin_debug-tools_echo_inspect"),
      "debug-tools should expose canonical tool name"
    );
  } finally {
    await fixture.close();
  }
});

test("plugin service rejects entry whose real path escapes plugin root", async () => {
  const fixture = await createFixture();
  try {
    const pluginDir = path.join(fixture.dataDir, "plugins", "escape-plugin");
    await ensureDir(path.join(pluginDir, "dist"));
    const outsideDir = path.join(fixture.dataDir, "outside");
    await ensureDir(outsideDir);
    await fs.writeFile(path.join(outsideDir, "outside.js"), "export default {};\n", "utf8");
    await fs.symlink(path.join(outsideDir, "outside.js"), path.join(pluginDir, "dist", "index.js"));
    await fs.writeFile(
      path.join(pluginDir, "agent-workbench.plugin.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "escape-plugin",
        name: "Escape Plugin",
        version: "0.1.0",
        entry: "dist/index.js",
        capabilities: ["tools"],
        tools: [{ name: "echo", description: "echo" }]
      }, null, 2),
      "utf8"
    );

    await setSettingJson(fixture.db, "agent_plugins_v1", {
      plugins: [{ id: "escape-plugin", enabled: true }]
    }, Date.now());

    const snapshots = await listPluginRuntimeSnapshots({ db: fixture.db, dataDir: fixture.dataDir } as any);
    const plugin = snapshots.plugins.find((item) => item.id === "escape-plugin");
    assert.ok(plugin, "escape-plugin should be discovered");
    assert.equal(plugin?.state, "invalid_manifest");
    assert.equal(
      plugin?.diagnostics.some((item) => item.code === "entry_out_of_root"),
      true,
      "should report entry_out_of_root"
    );
  } finally {
    await fixture.close();
  }
});

test("plugin service marks config_invalid when config does not match manifest configSchema", async () => {
  const fixture = await createFixture();
  try {
    const sourcePluginDir = path.join(process.cwd(), "test", "fixtures", "plugins", "debug-tools");
    const targetPluginDir = path.join(fixture.dataDir, "plugins", "debug-tools");
    await ensureDir(path.join(fixture.dataDir, "plugins"));
    await fs.cp(sourcePluginDir, targetPluginDir, { recursive: true });

    await setSettingJson(fixture.db, "agent_plugins_v1", {
      plugins: [{ id: "debug-tools", enabled: true, config: { unexpected: true } }]
    }, Date.now());

    const snapshots = await listPluginRuntimeSnapshots({ db: fixture.db, dataDir: fixture.dataDir } as any);
    const plugin = snapshots.plugins.find((item) => item.id === "debug-tools");
    assert.ok(plugin, "debug-tools should be discovered");
    assert.equal(plugin?.state, "config_invalid");
    assert.equal(
      plugin?.diagnostics.some((item) => item.code === "config_invalid"),
      true,
      "should report config_invalid"
    );
  } finally {
    await fixture.close();
  }
});

test("updateAgentPluginSettings rejects config that violates configSchema", async () => {
  const fixture = await createFixture();
  try {
    const sourcePluginDir = path.join(process.cwd(), "test", "fixtures", "plugins", "debug-tools");
    const targetPluginDir = path.join(fixture.dataDir, "plugins", "debug-tools");
    await ensureDir(path.join(fixture.dataDir, "plugins"));
    await fs.cp(sourcePluginDir, targetPluginDir, { recursive: true });

    await assert.rejects(
      () => updateAgentPluginSettings({ db: fixture.db, dataDir: fixture.dataDir } as any, {
        plugins: [{ id: "debug-tools", enabled: true, config: { unexpected: true } }]
      }),
      /Plugin config is invalid:/
    );
  } finally {
    await fixture.close();
  }
});
