// scripts/_phase184_distributed_child.ts
// Phase 184 distributed child: independent process connecting to shared
// Postgres. All commands print a single-line JSON on stdout.
//
// Usage: tsx _phase184_distributed_child.ts <cmd> <url> [args...]

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

  function emit(obj: Record<string, unknown>): void {
    console.log(JSON.stringify({ ok: true, pid: process.pid, ...obj }));
  }

  try {
    switch (cmd) {
      case "register-worker": {
        const wid = args[0];
        await registry.registerAsync({
          workerId: wid,
          hostname: "child-" + process.pid,
          capabilities: ["distributed-test"],
          status: "ONLINE",
          lastHeartbeatAt: Date.now(),
          registeredAt: Date.now(),
        } as any);
        const w = await store.getWorkerAsync(wid);
        emit({ workerId: wid, status: w?.status ?? null });
        break;
      }
      case "read-worker": {
        const w = await store.getWorkerAsync(args[0]);
        emit({ found: !!w, worker: w ?? null });
        break;
      }
      case "heartbeat": {
        const wid = args[0];
        const r = await registry.heartbeatAsync(wid);
        emit({ healthy: r.healthy, reason: r.reason ?? null });
        break;
      }
      case "claim-job": {
        const [jobId, wid] = args;
        const r = await store.atomicClaimJobAsync({ jobId, workerId: wid, durationMs: 60000 });
        emit({
          claimed: r.claimed,
          reason: r.reason ?? null,
          leaseId: r.lease?.leaseId ?? null,
          workerId: wid,
        });
        break;
      }
      case "claim-next": {
        const wid = args[0];
        // claimNextJobAsync is on ExecutionEngine; construct minimal engine.
        const { ExecutionEngine } = await import("../src/core/execution-engine");
        const { RetryEngine } = await import("../src/core/retry-engine");
        const engine = new ExecutionEngine(store, registry, leaseManager, new RetryEngine(), {} as any);
        const r = await (engine as any).claimNextJobAsync(wid);
        emit({
          claimed: !!r,
          jobId: r?.job?.id ?? null,
          leaseId: r?.lease?.leaseId ?? null,
        });
        break;
      }
      case "read-lease": {
        const l = await store.getLeaseAsync(args[0]);
        emit({ found: !!l, lease: l ?? null });
        break;
      }
      case "read-active-lease-for-job": {
        const l = await store.getActiveLeaseForJobAsync(args[0]);
        emit({ found: !!l, lease: l ?? null });
        break;
      }
      case "renew-lease": {
        const [leaseId, wid] = args;
        try {
          const l = await leaseManager.renewLeaseAsync(leaseId, wid, 60000);
          emit({ renewed: true, expiresAt: l.expiresAt });
        } catch (e: any) {
          emit({ renewed: false, error: String(e?.message ?? e) });
        }
        break;
      }
      case "release-lease": {
        await leaseManager.releaseLeaseAsync(args[0]);
        emit({ released: true });
        break;
      }
      case "complete-attempt": {
        const [attemptId, jobId, leaseId, wid, status] = args;
        const r = await store.completeAttemptAndTransitionJobAsync({
          attemptId, jobId, leaseId, workerId: wid,
          attemptStatus: (status || "SUCCEEDED") as any,
          expectedJobStatus: "RUNNING",
          newJobStatus: "SUCCEEDED",
        });
        emit({ completeOk: r.ok, reason: r.reason ?? null, jobStatus: r.jobStatus ?? null });
        break;
      }
      case "cancel-job": {
        const jobId = args[0];
        const job = await store.getJobAsync(jobId);
        if (!job) { emit({ cancelled: false, reason: "JOB_NOT_FOUND" }); break; }
        job.cancellationRequested = true;
        await store.updateJobAsync(job);
        emit({ cancelled: true });
        break;
      }
      case "read-recovery-op": {
        const key = args[0];
        const r = await pg.query<{ operation_id: string; state: string; idempotency_key: string }>(
          "SELECT operation_id, state, idempotency_key FROM execution_recovery_operations WHERE idempotency_key = $1",
          [key],
        );
        emit({ found: r.rows.length > 0, op: r.rows[0] ?? null, count: r.rows.length });
        break;
      }
      case "claim-after-delay": {
        const [jobId, wid, delayStr] = args;
        const delay = Number(delayStr);
        await new Promise((r) => setTimeout(r, delay));
        const r = await store.atomicClaimJobAsync({ jobId, workerId: wid, durationMs: 60000 });
        emit({
          claimed: r.claimed,
          reason: r.reason ?? null,
          leaseId: r.lease?.leaseId ?? null,
          workerId: wid,
          delay,
        });
        break;
      }
      case "run-recovery": {
        const { ExecutionEngine } = await import("../src/core/execution-engine");
        const { RetryEngine } = await import("../src/core/retry-engine");
        const engine = new ExecutionEngine(store, registry, leaseManager, new RetryEngine(), {} as any);
        await (engine as any).recoverStaleJobs(Date.now());
        emit({ recovered: true });
        break;
      }
      case "sleep": {
        const ms = Number(args[0] || "0");
        await new Promise((r) => setTimeout(r, ms));
        emit({ slept: ms });
        break;
      }
      case "probe-mode": {
        emit({
          hasAsyncBackend: store.hasAsyncBackend(),
          mode: process.env.NEXUS_PERSISTENCE_MODE ?? null,
        });
        break;
      }
      case "read-job": {
        const j = await store.getJobAsync(args[0]);
        emit({ found: !!j, job: j ?? null });
        break;
      }
      case "read-attempt": {
        const a = await store.getAttemptAsync(args[0]);
        emit({ found: !!a, attempt: a ?? null });
        break;
      }
      case "count-active-leases": {
        const r = await pg.query<{ cnt: string }>(
          "SELECT COUNT(*)::text AS cnt FROM execution_leases WHERE job_id = $1 AND status = 'ACTIVE'",
          [args[0]],
        );
        emit({ count: Number(r.rows[0]?.cnt ?? 0) });
        break;
      }
      case "count-provenance": {
        const r = await pg.query<{ cnt: string }>(
          "SELECT COUNT(*)::text AS cnt FROM execution_outcome_provenance WHERE attempt_id = $1",
          [args[0]],
        );
        emit({ count: Number(r.rows[0]?.cnt ?? 0) });
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