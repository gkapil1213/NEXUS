// scripts/_phase183d_child.ts
// Phase 183d child: cross-process read of Postgres-persisted attempt state.

import Database from "better-sqlite3";
import { PgClient } from "../src/core/pg-client";
import { PgAsyncEngine } from "../src/core/pg-async-engine";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";

async function main(): Promise<void> {
  const [, , cmd, url, ...args] = process.argv;
  if (!cmd || !url) { console.error("usage: <cmd> <url> [args]"); process.exit(2); }

  const mem = new Database(":memory:");
  const syncEngine = SQLiteEngine.fromDatabase(mem);
  const pg = new PgClient();
  await pg.connect(url);
  const asyncDb = new PgAsyncEngine(pg);
  const store = new ExecutionStore(syncEngine, asyncDb);

  try {
    switch (cmd) {
      case "get-attempt": {
        const id = args[0];
        const a = await store.getAttemptAsync(id);
        console.log(JSON.stringify({ ok: true, found: !!a, status: a?.status ?? null, pid: process.pid }));
        break;
      }
      case "get-provenance": {
        const attemptId = args[0];
        const r = await pg.query<{ provenance_id: string; outcome: string }>(
          "SELECT provenance_id, outcome FROM execution_outcome_provenance WHERE attempt_id = $1",
          [attemptId],
        );
        console.log(JSON.stringify({ ok: true, found: r.rows.length > 0, outcome: r.rows[0]?.outcome ?? null, pid: process.pid }));
        break;
      }
      default:
        console.error("unknown cmd: " + cmd);
        process.exit(2);
    }
  } finally {
    try { await pg.close(); } catch { /* ignore */ }
    try { mem.close(); } catch { /* ignore */ }
  }
}

main().catch((e) => { console.error("CHILD_FAIL:", e?.message ?? e); process.exit(1); });