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