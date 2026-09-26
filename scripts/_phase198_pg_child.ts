// scripts/_phase198_pg_child.ts
// Phase 198 Postgres child: races two concurrent acquireLeaseAsync calls
// for the same job and reports the outcome as single-line JSON.
//
// Usage: tsx _phase198_pg_child.ts <cmd> <url> [jobId]

import Database from "better-sqlite3";
import { PgClient } from "../src/core/pg-client";
import { PgAsyncEngine } from "../src/core/pg-async-engine";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";

async function main(): Promise<void> {
  const [, , cmd, url, jobId] = process.argv;
  if (!cmd || !url) { console.error("usage: <cmd> <url> [jobId]"); process.exit(2); }

  const mem = new Database(":memory:");
  const syncEngine = SQLiteEngine.fromDatabase(mem);
  const pg = new PgClient();
  await pg.connect(url);
  const asyncDb = new PgAsyncEngine(pg);
  const store = new ExecutionStore(syncEngine, asyncDb);

  try {
    switch (cmd) {
      case "race-lease": {
        const now = Date.now();
        const mkLease = (wid: string) => ({
          leaseId: "lease_p198_" + wid + "_" + Math.random().toString(36).slice(2, 10),
          jobId, workerId: wid,
          acquiredAt: now, expiresAt: now + 60_000,
          renewedAt: now, releasedAt: null, status: "ACTIVE",
        });
        const lA = mkLease("worker-A");
        const lB = mkLease("worker-B");

        const [rA, rB] = await Promise.all([
          store.acquireLeaseAsync(lA as any),
          store.acquireLeaseAsync(lB as any),
        ]);
        const winners = (rA.acquired ? 1 : 0) + (rB.acquired ? 1 : 0);
        const loser = rA.acquired ? rB : rA;

        const activeRows: any = await (pg as any).query(
          "SELECT COUNT(*)::text AS cnt FROM execution_leases WHERE job_id = $1 AND status = 'ACTIVE'",
          [jobId],
        );
        const rows = Array.isArray(activeRows) ? activeRows : (activeRows?.rows ?? []);
        const activeLeaseCount = Number(rows?.[0]?.cnt ?? -1);

        console.log(JSON.stringify({
          ok: true,
          winners,
          loserAcquired: loser.acquired,
          activeLeaseCount,
        }));
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