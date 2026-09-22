// scripts/_phase183c_attempts_child.ts
// Phase 183c child: one attempts/workers operation against real Postgres.

import Database from "better-sqlite3";
import { PgClient } from "../src/core/pg-client";
import { PgAsyncEngine } from "../src/core/pg-async-engine";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";

function mkJob(id: string): any {
  const now = Date.now();
  return {
    id,
    idempotencyKey: "ck-" + id,
    jobType: "engineering",
    payload: { kind: "engineering" },
    status: "RUNNING",
    createdAt: now,
    updatedAt: now,
    cancellationRequested: false,
    cancellationAcknowledged: false,
  };
}

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
      case "create-job": {
        const id = args[0];
        await store.createJobAsync(mkJob(id));
        console.log(JSON.stringify({ ok: true, id, pid: process.pid }));
        break;
      }
      case "create-attempt": {
        const [id, jobId, n] = args;
        const now = Date.now();
        await store.createAttemptAsync({
          id, jobId, attemptNumber: Number(n),
          status: "RUNNING", createdAt: now, startedAt: now,
        } as any);
        console.log(JSON.stringify({ ok: true, id, pid: process.pid }));
        break;
      }
      case "get-attempt": {
        const id = args[0];
        const a = await store.getAttemptAsync(id);
        console.log(JSON.stringify({
          ok: true, found: !!a, status: a?.status ?? null,
          attemptNumber: a?.attemptNumber ?? null, pid: process.pid,
        }));
        break;
      }
      case "register-worker": {
        const id = args[0];
        const now = Date.now();
        await store.registerWorkerAsync({
          workerId: id, hostname: "test-host", status: "IDLE",
          registeredAt: now, lastHeartbeatAt: now,
        } as any);
        console.log(JSON.stringify({ ok: true, id, pid: process.pid }));
        break;
      }
      case "get-worker": {
        const id = args[0];
        const w = await store.getWorkerAsync(id);
        console.log(JSON.stringify({
          ok: true, found: !!w, status: w?.status ?? null, pid: process.pid,
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

main().catch((e) => { console.error("CHILD_FAIL:", e?.message ?? e); process.exit(1); });