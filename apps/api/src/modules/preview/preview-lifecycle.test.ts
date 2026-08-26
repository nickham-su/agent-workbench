import assert from "node:assert/strict";
import { test } from "node:test";
import { startPreviewListenerLifecycle } from "./preview-lifecycle.js";

function listener(name: string, events: string[], failListen = false) {
  return {
    async listen() {
      events.push(`${name}:listen`);
      if (failListen) throw new Error(`${name} listen failed`);
    },
    async close() {
      events.push(`${name}:close`);
    }
  };
}

test("listener lifecycle starts preview before main and closes both listeners and runtime", async () => {
  const events: string[] = [];
  const lifecycle = await startPreviewListenerLifecycle({
    previewApp: listener("preview", events),
    mainApp: listener("main", events),
    runtime: { close() { events.push("runtime:close"); } } as any,
    previewListen: { host: "127.0.0.1", port: 4311 },
    mainListen: { host: "127.0.0.1", port: 4310 }
  });
  assert.deepEqual(events, ["preview:listen", "main:listen"]);
  await lifecycle.close();
  await lifecycle.close();
  assert.deepEqual(events, ["preview:listen", "main:listen", "main:close", "preview:close", "runtime:close"]);
});

test("listener lifecycle preserves preview listen failure and cleans every resource", async () => {
  const events: string[] = [];
  await assert.rejects(
    startPreviewListenerLifecycle({
      previewApp: listener("preview", events, true),
      mainApp: listener("main", events),
      runtime: { close() { events.push("runtime:close"); } } as any,
      previewListen: { host: "127.0.0.1", port: 4311 },
      mainListen: { host: "127.0.0.1", port: 4310 }
    }),
    /preview listen failed/
  );
  assert.deepEqual(events, ["preview:listen", "main:close", "preview:close", "runtime:close"]);
});

test("listener lifecycle cleans preview when the main listener cannot bind", async () => {
  const events: string[] = [];
  await assert.rejects(
    startPreviewListenerLifecycle({
      previewApp: listener("preview", events),
      mainApp: listener("main", events, true),
      runtime: { close() { events.push("runtime:close"); } } as any,
      previewListen: { host: "127.0.0.1", port: 4311 },
      mainListen: { host: "127.0.0.1", port: 4310 }
    }),
    /main listen failed/
  );
  assert.deepEqual(events, ["preview:listen", "main:listen", "main:close", "preview:close", "runtime:close"]);
});
