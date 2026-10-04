// scripts/_phase244_lifecycle_child.ts
// Phase 244 verifier child. Independent process, real PostgreSQL. One JSON
// line on stdout per invocation.
import Database from "better-sqlite3";
import { PgClient } from "../src/core/pg-client";
import { PgAsyncEngine } from "../src/core/pg-async-engine";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { WorkerRegistry } from "../src/core/worker-registry";
import { LeaseManager } from "../src/core/lease-manager";

async function main(): Promise<void> {
  const [, , cmd, url, ...args] = process.argv;
  if (!cmd || !url) { console.error("usage: <cmd> <url> [args]"); process.exit(2); }

  const mem = new Database(":memory:");
  const syncEngine = SQLiteEngine.fromDatabase(mem);
  const pg = new PgClient();
  await pg.connect(url);
  const asyncDb = new PgAsyncEngine(pg);
  const store = new ExecutionStore(syncEngine, asyncDb);
  const registry = new WorkerRegistry(store);
  const leaseManager = new LeaseManager(store);

  function emit(o: Record<string, unknown>): void {
    console.log(JSON.stringify({ ok: true, pid: process.pid, ...o }));
  }

  try {
    switch (cmd) {
      case "probe": {
        const p = await pg.probe();
        emit({ reachable: p.ok === true, hasAsyncBackend: store.hasAsyncBackend() });
        break;
      }

      case "create-job": {
        const [jobId] = args;
        const now = Date.now();
        const job = {
          id: jobId,
          idempotencyKey: "p244-" + jobId,
          jobType: "engineering",
          payload: { kind: "engineering" },
          status: "QUEUED",
          createdAt: now,
          updatedAt: now,
          cancellationRequested: false,
          cancellationAcknowledged: false,
          retryPolicy: { maxAttempts: 3, initialDelayMs: 1000, multiplier: 2, maxDelayMs: 30000 },
        } as any;
        await store.createJobAsync(job);
        emit({ created: true });
        break;
      }

      case "read-job": {
        const j = await store.getJobAsync(args[0]);
        emit({ found: !!j, status: j?.status ?? null, currentLeaseId: j?.currentLeaseId ?? null });
        break;
      }

      case "admit-job": {
        const [jobId] = args;
        const r = await store.admitNextJobAsync({
          owner: "p244-child-" + process.pid,
          capacityLimit: 100,
          agingMs: 0,
          now: Date.now(),
        } as any);
        emit({ admitted: r.admitted, reason: r.reason ?? null });
        break;
      }

      case "claim-job": {
        const [jobId, wid] = args;
        const r = await store.atomicClaimJobAsync({ jobId, workerId: wid, durationMs: 60000 });
        emit({ claimed: r.claimed, reason: r.reason ?? null,
               leaseId: r.lease?.leaseId ?? null, workerId: wid });
        break;
      }

      case "register-worker": {
        const wid = args[0];
        await registry.registerAsync({
          workerId: wid, hostname: "p244-" + process.pid,
          capabilities: ["p244"], status: "ONLINE",
          lastHeartbeatAt: Date.now(), registeredAt: Date.now(),
        } as any);
        emit({ workerId: wid });
        break;
      }

      case "force-expire-lease": {
        const [leaseId] = args;
        await pg.query(
          "UPDATE execution_leases SET expires_at = $1 WHERE lease_id = $2 AND status = 'ACTIVE'",
          [Date.now() - 60_000, leaseId],
        );
        emit({ expired: true });
        break;
      }

      case "run-recover-jobs": {
        const { ExecutionEngine } = await import("../src/core/execution-engine");
        const { RetryEngine } = await import("../src/core/retry-engine");
        const engine = new ExecutionEngine(store, registry, leaseManager, new RetryEngine(), {} as any);
        await (engine as any).recoverStaleJobs(Date.now());
        emit({ ranRecovery: true });
        break;
      }

      case "finalize-job": {
        const { finalizeExecutionAsync } = await import("../src/core/execution-finalizer");
        const r = await finalizeExecutionAsync(store, args[0], Date.now());
        emit({ ok: r.ok, applied: r.applied, status: r.status ?? null, reason: r.reason ?? null });
        break;
      }

      case "count-active-leases-for-job": {
        const rows = await pg.query<{ cnt: string }>(
          "SELECT COUNT(*)::text AS cnt FROM execution_leases WHERE job_id = $1 AND status = 'ACTIVE'",
          [args[0]],
        );
        emit({ count: Number(rows.rows[0]?.cnt ?? 0) });
        break;
      }

      case "count-recovery-ops-for-job": {
        const rows = await pg.query<{ cnt: string }>(
          "SELECT COUNT(*)::text AS cnt FROM execution_recovery_operations WHERE job_id = $1",
          [args[0]],
        );
        emit({ count: Number(rows.rows[0]?.cnt ?? 0) });
        break;
      }

      case "read-recovery-op": {
        const rows = await pg.query<any>(
          "SELECT * FROM execution_recovery_operations WHERE job_id = $1 ORDER BY created_at DESC LIMIT 1",
          [args[0]],
        );
        emit({ found: rows.rows.length > 0, op: rows.rows[0] ?? null });
        break;
      }

      case "read-job-pg": {
        const rows = await pg.query<any>(
          "SELECT id, status, current_lease_id, next_attempt_at FROM execution_jobs WHERE id = $1",
          [args[0]],
        );
        emit({ found: rows.rows.length > 0, job: rows.rows[0] ?? null });
        break;
      }

      case "cancel-job": {
        const job = await store.getJobAsync(args[0]);
        if (!job) { emit({ cancelled: false, reason: "JOB_NOT_FOUND" }); break; }
        job.cancellationRequested = true;
        await store.updateJobAsync(job);
        emit({ cancelled: true });
        break;
      }

      default:
        emit({ error: "unknown cmd: " + cmd });
        process.exit(2);
    }
  } finally {
    try { await pg.close(); } catch {}
    try { mem.close(); } catch {}
  }
}

main().catch((e) => { console.log(JSON.stringify({ ok: false, error: String((e as Error)?.message ?? e) })); process.exit(1); });