// scripts/_phase183b_jobs_child.ts
// Phase 183b child: exercises async job/recovery methods against real Postgres.

import Database from "better-sqlite3";
import { PgClient } from "../src/core/pg-client";
import { PgAsyncEngine } from "../src/core/pg-async-engine";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { AsyncExecutionRecoveryOperationStore } from "../src/core/execution-recovery-operation-store";

async function main(): Promise<void> {
  const [, , cmd, url, ...args] = process.argv;
  if (!cmd || !url) { console.error("usage: <cmd> <url> [args]"); process.exit(2); }

  const mem = new Database(":memory:");
  const syncEngine = SQLiteEngine.fromDatabase(mem);
  const pg = new PgClient();
  await pg.connect(url);
  const asyncDb = new PgAsyncEngine(pg);
  const store = new ExecutionStore(syncEngine, asyncDb);
  const recoveryOps = new AsyncExecutionRecoveryOperationStore(asyncDb);

  const jobBase = (id: string, key: string) => ({
    id, idempotencyKey: key, jobType: "test", payload: { tag: id },
    status: "PENDING" as any, createdAt: Date.now(), updatedAt: Date.now(),
    cancellationRequested: false, cancellationAcknowledged: false,
  });

  try {
    switch (cmd) {
      case "create-job": {
        const [id, key] = args;
        await store.createJobAsync(jobBase(id, key));
        const got = await store.getJobAsync(id);
        console.log(JSON.stringify({ ok: true, id, status: got?.status ?? null, pid: process.pid }));
        break;
      }
      case "create-job-race": {
        const [id, key] = args;
        try {
          await store.createJobAsync(jobBase(id, key));
          console.log(JSON.stringify({ ok: true, created: true, id, pid: process.pid }));
        } catch (e: any) {
          console.log(JSON.stringify({ ok: true, created: false, id, err: String(e?.message ?? e).slice(0, 120), pid: process.pid }));
        }
        break;
      }
      case "get-job": {
        const [id] = args;
        const j = await store.getJobAsync(id);
        console.log(JSON.stringify({ ok: true, found: !!j, id, status: j?.status ?? null, pid: process.pid }));
        break;
      }
      case "get-job-by-idem": {
        const [key] = args;
        const j = await store.getJobByIdempotencyKeyAsync(key);
        console.log(JSON.stringify({ ok: true, found: !!j, id: j?.id ?? null, pid: process.pid }));
        break;
      }
      case "update-job": {
        const [id, newStatus] = args;
        const j = await store.getJobAsync(id);
        if (!j) { console.log(JSON.stringify({ ok: false, err: "not_found", pid: process.pid })); break; }
        j.status = newStatus as any;
        j.updatedAt = Date.now();
        await store.updateJobAsync(j);
        const after = await store.getJobAsync(id);
        console.log(JSON.stringify({ ok: true, id, status: after?.status ?? null, pid: process.pid }));
        break;
      }
      case "transition": {
        const [id, expected, next] = args;
        const r = await store.transitionExecutionAsync({
          jobId: id, expectedStatus: expected as any, newStatus: next as any, actor: "system",
        });
        console.log(JSON.stringify({ ok: true, result: r, pid: process.pid }));
        break;
      }
      case "create-recovery-op": {
        const [jobId, opType] = args;
        const r = await recoveryOps.createOrGetOperation({
          jobId, leaseId: null, workerId: null, operationType: opType as any,
        });
        console.log(JSON.stringify({ ok: true, operationId: r.operation.operationId, created: r.created, pid: process.pid }));
        break;
      }
      case "get-recovery-op": {
        const [opId] = args;
        const op = await recoveryOps.getOperation(opId);
        console.log(JSON.stringify({ ok: true, found: !!op, state: op?.state ?? null, pid: process.pid }));
        break;
      }
      case "claim-recovery-op": {
        const [opId, owner, durStr] = args;
        const r = await recoveryOps.claimOperation({ operationId: opId, owner, durationMs: Number(durStr) || 60000 });
        console.log(JSON.stringify({ ok: true, claimed: r.claimed, reason: r.reason ?? null, pid: process.pid }));
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