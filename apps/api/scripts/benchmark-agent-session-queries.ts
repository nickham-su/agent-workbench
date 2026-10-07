import { performance } from "node:perf_hooks";
import { cpus } from "node:os";
import { createSessionListFixture } from "../src/modules/agent/read-side/session-list-query.testkit.js";
import { decodeSessionCursor } from "../src/modules/agent/read-side/session-list-query.js";
import { CONTINUABLE_CONDITION, SESSION_METADATA_COLUMNS, TABS_CONDITION } from "../src/modules/agent/read-side/sqlite-session-query.js";

function measure(read: () => unknown) {
  for (let i = 0; i < 5; i++) read();
  const times: number[] = [];
  for (let i = 0; i < 40; i++) { const start = performance.now(); read(); times.push(performance.now() - start); }
  times.sort((a, b) => a - b);
  return { medianMs: +((times[19]! + times[20]!) / 2).toFixed(3), p95Ms: +times[37]!.toFixed(3) };
}

const results = [];
for (const count of [1000, 10000]) {
  for (const distribution of ["hidden90", "allPrimaryVisible", "allPrimarySameTime"] as const) {
    const { db, add, query } = createSessionListFixture();
    try {
      const override = db.prepare("insert into workspace_session_tab_state values ('a',?, ?,1)");
      db.transaction(() => {
        for (let i = 0; i < count; i++) {
          const id = `synthetic-${String(i).padStart(5, "0")}`;
          const kind = distribution !== "hidden90" || i < count / 2 ? "primary" : "subtask";
          add(id, { kind, time: distribution === "allPrimarySameTime" ? 1 : Math.floor(i / 20), head: i % 10 === 0 ? "synthetic-head" : null });
          if (distribution === "hidden90") {
            if (kind === "primary" && i % 10 !== 0) override.run(id, 0);
            if (kind === "subtask" && i % 10 === 0) override.run(id, 1);
          }
        }
      })();
      const baseline = () => db.prepare(`select ${SESSION_METADATA_COLUMNS} from agent_session s where s.workspace_id = ? order by s.updated_at desc`).all("a");
      const target = () => query.getSession({ workspaceId: "a", sessionId: "synthetic-00000" });
      const tabs = () => query.listSessions({ workspaceId: "a", scope: "tabs" });
      const page = () => query.listSessions({ workspaceId: "a", scope: "continuable", limit: 50 });
      const first = page();
      if (first.scope !== "continuable") throw new Error("unexpected scope");
      let deepCursor = first.nextCursor;
      for (let i = 0; i < 4 && deepCursor; i++) {
        const next = query.listSessions({ workspaceId: "a", scope: "continuable", limit: 50, cursor: deepCursor });
        if (next.scope !== "continuable") throw new Error("unexpected scope");
        if (next.nextCursor) deepCursor = next.nextCursor; else break;
      }
      const snapshot = tabs();
      if (snapshot.scope !== "tabs") throw new Error("unexpected scope");
      const explain = (condition: string, limit = false, bindings: (string | number)[] = []) => db.prepare(`explain query plan select ${SESSION_METADATA_COLUMNS} from agent_session s where s.workspace_id = ? and ${condition} order by s.updated_at desc,s.id collate binary desc${limit ? " limit 51" : ""}`).all("a", ...bindings);
      const deep = deepCursor ? decodeSessionCursor(deepCursor, { workspaceId: "a", limit: 50 }) : null;
      results.push({ count, distribution, visible: snapshot.items.length,
        coveredIds: snapshot.tabState.closedSessionIds.length + snapshot.tabState.openedSubtaskSessionIds.length,
        candidatePage: first.items.length,
        jsonBytes: { fullList: Buffer.byteLength(JSON.stringify(baseline())), tabs: Buffer.byteLength(JSON.stringify(snapshot)), page: Buffer.byteLength(JSON.stringify(first)), target: Buffer.byteLength(JSON.stringify(target())) },
        timings: { fullList: measure(baseline), tabs: measure(tabs), page: measure(page), target: measure(target),
          ...(deepCursor ? { deepPage: measure(() => query.listSessions({ workspaceId: "a", scope: "continuable", limit: 50, cursor: deepCursor! })) } : {}) },
        plans: {
          fullList: db.prepare(`explain query plan select ${SESSION_METADATA_COLUMNS} from agent_session s where s.workspace_id=? order by s.updated_at desc`).all("a"),
          target: db.prepare("explain query plan select * from agent_session where workspace_id=? and id=?").all("a", "synthetic-00000"),
          tabs: explain(TABS_CONDITION), page: explain(CONTINUABLE_CONDITION, true),
          ...(deep ? { deepPage: explain(`${CONTINUABLE_CONDITION} and (s.updated_at < ? or (s.updated_at = ? and s.id collate binary < ?))`, true, [deep.updatedAt, deep.updatedAt, deep.id]) } : {})
        }
      });
    } finally { db.close(); }
  }
}
console.log(JSON.stringify({ node: process.version, platform: `${process.platform}/${process.arch}`, cpu: cpus()[0]?.model,
  storage: "in-memory synthetic SQLite", warmup: 5, samples: 40, networkBytes: "not measured", results }, null, 2));
