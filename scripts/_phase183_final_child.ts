// scripts/_phase183_final_child.ts
// Phase 183 final child: independent-process reads of Postgres-persisted
// worker and lease state. Own connection, own in-memory SQLite.

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
      case "read-worker": {
        const w = await store.getWorkerAsync(args[0]);
        console.log(JSON.stringify({ ok: true, found: !!w, worker: w ?? null, pid: process.pid }));
        break;
      }
      case "read-lease": {
        const l = await store.getLeaseAsync(args[0]);
        console.log(JSON.stringify({ ok: true, found: !!l, lease: l ?? null, pid: process.pid }));
        break;
      }
      case "read-active-lease-for-job": {
        const l = await store.getActiveLeaseForJobAsync(args[0]);
        console.log(JSON.stringify({ ok: true, found: !!l, lease: l ?? null, pid: process.pid }));
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

main().catch((e) => { console.error("CHILD_FAIL:", e?.stack ?? e); process.exit(1); });