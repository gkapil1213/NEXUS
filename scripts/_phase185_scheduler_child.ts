// scripts/_phase185_scheduler_child.ts
// Phase 185 distributed scheduler child.
// Each invocation is an independent process with its own PG connection and
// its own DistributedScheduler instance. Commands read on argv[2].

import Database from "better-sqlite3";
import { PgClient } from "../src/core/pg-client";
import { PgAsyncEngine } from "../src/core/pg-async-engine";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { DistributedScheduler } from "../src/core/distributed-scheduler";

async function main(): Promise<void> {
  const [, , cmd, url, ...args] = process.argv;
  if (!cmd || !url) { console.error("usage: <cmd> <url> [args...]"); process.exit(2); }

  const mem = new Database(":memory:");
  const sync = SQLiteEngine.fromDatabase(mem);
  const pg = new PgClient();
  await pg.connect(url);
  const store = new ExecutionStore(sync, new PgAsyncEngine(pg));

  const maxConc = Number(process.env.NEXUS_SCHEDULER_MAX_CONCURRENCY ?? "4");
  const maxPerTick = Number(process.env.NEXUS_SCHEDULER_MAX_PER_TICK ?? "16");
  const agingMs = Number(process.env.NEXUS_SCHEDULER_AGING_MS ?? "60000");
  const sched = new DistributedScheduler(store, {
    maxConcurrency: maxConc, maxAdmissionsPerTick: maxPerTick, agingMs,
  });

  function emit(o: Record<string, unknown>): void {
    console.log(JSON.stringify({ ok: true, pid: process.pid, ...o }));
  }

  try {
    switch (cmd) {
      case "probe": {
        emit({ hasAsyncBackend: store.hasAsyncBackend(), ownerId: sched.ownerId, config: sched.getConfig() });
        break;
      }
      case "tick": {
        const now = Number(args[0] ?? Date.now());
        const r = await sched.tick(now);
        emit({ report: r });
        break;
      }
      case "admit-one": {
        // Admit exactly one job directly (bypasses the loop, for race tests).
        const now = Number(args[0] ?? Date.now());
        const owner = String(args[1] ?? "admit-" + process.pid);
        const r = await store.admitNextJobAsync({ owner, capacityLimit: maxConc, agingMs, now });
        emit({ result: r });
        break;
      }
      case "claim-admitted": {
        // Claim a job whose status is already ADMITTED.
        const [jobId, workerId, durStr] = args;
        const durationMs = Number(durStr ?? "60000");
        const r = await store.atomicClaimJobAsync({ jobId, workerId, durationMs, fromStatus: "ADMITTED" });
        emit({ result: r });
        break;
      }
      case "claim-queued": {
        // Claim a job whose status is QUEUED (Phase 184 path).
        const [jobId, workerId, durStr] = args;
        const durationMs = Number(durStr ?? "60000");
        const r = await store.atomicClaimJobAsync({ jobId, workerId, durationMs });
        emit({ result: r });
        break;
      }
      case "create-job": {
        // args: id, status, priority, createdAtOffsetMs (negative = older)
        const [id, status, prioStr, offsetStr] = args;
        const priority = Number(prioStr ?? "2");
        const offset = Number(offsetStr ?? "0");
        const now = Date.now();
        const createdAt = now + offset;
        await store.createJobAsync({
          id, idempotencyKey: "p185-" + id, jobType: "engineering",
          payload: {}, status,
          createdAt, updatedAt: createdAt,
          cancellationRequested: false, cancellationAcknowledged: false,
          priority,
        } as any);
        emit({ id, status, priority, createdAt });
        break;
      }
      case "cancel-job": {
        const jobId = args[0];
        const job = await store.getJobAsync(jobId);
        if (!job) { emit({ cancelled: false, reason: "NOT_FOUND" }); break; }
        job.cancellationRequested = true;
        await store.updateJobAsync(job);
        emit({ cancelled: true });
        break;
      }
      case "read-job": {
        const j = await store.getJobAsync(args[0]);
        emit({ found: !!j, job: j ?? null });
        break;
      }
      case "read-status-count": {
        // count by status
        const st = args[0];
        const r = await pg.query<{ cnt: string }>(
          "SELECT COUNT(*)::text AS cnt FROM execution_jobs WHERE status = $1",
          [st],
        );
        emit({ status: st, count: Number(r.rows[0]?.cnt ?? 0) });
        break;
      }
      case "read-admitted-ids": {
        // return all ids in ADMITTED with an optional prefix
        const prefix = args[0] ?? "";
        const r = await pg.query<{ id: string; priority: number; admitted_at: string | null; admission_owner: string | null }>(
          "SELECT id, priority, admitted_at, admission_owner FROM execution_jobs " +
          "WHERE status = 'ADMITTED' AND id LIKE $1 ORDER BY admitted_at ASC",
          [prefix + "%"],
        );
        emit({ rows: r.rows, count: r.rows.length });
        break;
      }
      case "expire-stale-admissions": {
        const now = Number(args[0] ?? Date.now());
        const ttl = Number(args[1] ?? "60000");
        const n = await store.expireStaleAdmissionsAsync(now, ttl);
        emit({ expired: n });
        break;
      }
      case "promote-retries": {
        const now = Number(args[0] ?? Date.now());
        const n = await store.promoteDueRetriesAsync(now);
        emit({ promoted: n });
        break;
      }
      case "set-worker-status": {
        const [wid, status] = args;
        const r = await pg.query("UPDATE execution_workers SET status = $1 WHERE worker_id = $2", [status, wid]);
        emit({ updated: r.rowCount, workerId: wid, status });
        break;
      }
      case "set-all-workers-status": {
        const [status] = args;
        const r = await pg.query("UPDATE execution_workers SET status = $1", [status]);
        emit({ updated: r.rowCount, status });
        break;
      }
      case "create-retry-job": {
        const [id, nextStr, prioStr] = args;
        const nextAt = Number(nextStr);
        const priority = Number(prioStr ?? "2");
        const now = Date.now();
        await store.createJobAsync({
          id, idempotencyKey: "p185-" + id, jobType: "engineering",
          payload: {}, status: "RETRY_SCHEDULED",
          createdAt: now - 10_000_000_000, updatedAt: now,
          cancellationRequested: false, cancellationAcknowledged: false,
          nextAttemptAt: nextAt, priority,
        } as any);
        emit({ id, status: "RETRY_SCHEDULED", nextAt, priority });
        break;
      }
      case "read-retry-jobs": {
        const prefix = args[0] ?? "";
        const r = await pg.query<{ id: string; next_attempt_at: string | null }>(
          "SELECT id, next_attempt_at FROM execution_jobs WHERE status = 'RETRY_SCHEDULED' AND id LIKE $1",
          [prefix + "%"],
        );
        emit({ rows: r.rows, count: r.rows.length });
        break;
      }
      case "dispatch-job": {
        const [jobId, workerId, capStr, durStr] = args;
        const r = await store.dispatchAdmittedJobAsync({
          jobId,
          workerId: workerId || undefined,
          maxConcurrencyPerWorker: capStr ? Number(capStr) : undefined,
          leaseDurationMs: durStr ? Number(durStr) : undefined,
        });
        emit({ result: r });
        break;
      }
      case "dispatch-tick": {
        const now = Number(args[0] ?? Date.now());
        const maxConc = Number(process.env.NEXUS_SCHEDULER_WORKER_CONCURRENCY ?? "1");
        const sched = new DistributedScheduler(store, { maxConcurrencyPerWorker: maxConc });
        const r = await sched.dispatchTick(now);
        emit({ report: r });
        break;
      }
      case "read-attempt": {
        const a = await store.getAttemptAsync(args[0]);
        emit({ found: !!a, attempt: a ?? null });
        break;
      }
      case "count-attempts-for-job": {
        const r = await pg.query("SELECT COUNT(*)::text AS cnt FROM execution_attempts WHERE job_id = $1", [args[0]]);
        emit({ count: Number(r.rows[0]?.cnt ?? 0) });
        break;
      }
      case "count-active-leases-for-worker": {
        const r = await pg.query("SELECT COUNT(*)::text AS cnt FROM execution_leases WHERE worker_id = $1 AND status = 'ACTIVE'", [args[0]]);
        emit({ count: Number(r.rows[0]?.cnt ?? 0) });
        break;
      }
      case "claim-admitted-as": {
        const [jobId, workerId, durStr] = args;
        const r = await store.atomicClaimJobAsync({ jobId, workerId, durationMs: durStr ? Number(durStr) : 60000, fromStatus: "ADMITTED" });
        emit({ result: r });
        break;
      }
      case "complete-attempt-as": {
        const [attemptId, jobId, leaseId, workerId, st] = args;
        const r = await store.completeAttemptAndTransitionJobAsync({
          attemptId, jobId, leaseId, workerId,
          attemptStatus: (st || "SUCCEEDED"),
          expectedJobStatus: "RUNNING",
          newJobStatus: "SUCCEEDED",
        });
        emit({ result: r });
        break;
      }
      case "release-lease": {
        await store.updateLeaseAsync({ leaseId: args[0], jobId: "", workerId: "", acquiredAt: 0, expiresAt: 0, releasedAt: Date.now(), status: "RELEASED" });
        emit({ released: true });
        break;
      }
      case "set-worker-heartbeat": {
        const [wid, hbStr] = args;
        await pg.query("UPDATE execution_workers SET last_heartbeat_at = $1 WHERE worker_id = $2", [Number(hbStr), wid]);
        emit({ updated: true, workerId: wid, lastHeartbeatAt: Number(hbStr) });
        break;
      }
      case "attempt-heartbeat": {
        const [attemptId, jobId, workerId, leaseId, ttlStr] = args;
        const r = await store.attemptHeartbeatAsync({
          attemptId, jobId, workerId, leaseId,
          ttlMs: ttlStr ? Number(ttlStr) : undefined,
        });
        emit({ result: r });
        break;
      }
      case "list-stale-attempts": {
        const [nowStr, maxAgeStr] = args;
        const rows = await store.listStaleAttemptsAsync(Number(nowStr), Number(maxAgeStr));
        emit({ rows });
        break;
      }
      case "fence-stale-attempt": {
        const [attemptId, jobId, leaseId, reason, cutoffStr] = args;
        const r = await store.fenceStaleAttemptAsync({
          attemptId, jobId, leaseId,
          reason: reason || "HEARTBEAT_EXPIRED",
          staleCutoffMs: Number(cutoffStr),
        });
        emit({ result: r });
        break;
      }
      case "recover-stale-attempts-tick": {
        const now = Number(args[0] ?? Date.now());
        const sched = new DistributedScheduler(store, {});
        const r = await sched.recoverStaleAttemptsTick(now);
        emit({ report: r });
        break;
      }
      case "set-attempt-heartbeat": {
        const [attemptId, hbStr] = args;
        const r = await pg.query(
          "UPDATE execution_attempts SET heartbeat_at = $1 WHERE id = $2",
          [Number(hbStr), attemptId],
        );
        emit({ updated: r.rowCount, attemptId, heartbeatAt: Number(hbStr) });
        break;
      }
      case "read-attempt-row": {
        const r = await pg.query(
          "SELECT id, job_id, status, worker_id, lease_id, heartbeat_at, completed_at FROM execution_attempts WHERE id = $1",
          [args[0]],
        );
        emit({ found: r.rows.length > 0, row: r.rows[0] ?? null });
        break;
      }
      case "read-lease-row": {
        const r = await pg.query(
          "SELECT lease_id, job_id, worker_id, status, expires_at, renewed_at, released_at FROM execution_leases WHERE lease_id = $1",
          [args[0]],
        );
        emit({ found: r.rows.length > 0, row: r.rows[0] ?? null });
        break;
      }
      case "sleep": {
        const ms = Number(args[0] ?? "0");
        await new Promise((r) => setTimeout(r, ms));
        emit({ slept: ms });
        break;
      }
      default:
        console.error("unknown cmd: " + cmd);
        process.exit(2);
    }
  } finally {
    try { await pg.close(); } catch {}
    try { mem.close(); } catch {}
  }
}

main().catch((e) => { console.error("CHILD_FAIL:", e?.stack ?? e); process.exit(1); });