// scripts/test-phase142-atomic-claim.ts
// Phase 142 - atomic lease claim + job ownership binding.
//
// Uses real SQLite via SQLiteEngine.open() with migrations applied. Verifies
// the durable invariant directly in SQLite rows:
//   COUNT(ACTIVE leases for job) in {0, 1}
//   if 1, execution_jobs.current_lease_id == that lease_id
//   if 1, execution_jobs.status == 'CLAIMED'

import Database from "better-sqlite3";
import { join } from "path";
import { MigrationRunner } from "../src/core/migration-runner";
import { ExecutionStore } from "../src/core/execution-store";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionJob, ExecutionAttempt } from "../src/core/execution-models";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log("  ok   " + msg); }
  else      { failed++; console.log("  FAIL " + msg); }
}

interface H {
  db: Database.Database;
  store: ExecutionStore;
}

function makeHarness(): H {
  const rawDb = new Database(":memory:");
  const migrationsDir = join(process.cwd(), "src", "db", "migrations");
  new MigrationRunner(rawDb, migrationsDir).run();
  const db = SQLiteEngine.fromDatabase(rawDb);
  const store = new ExecutionStore(db as any);
  return { db: rawDb, store };
}

function queuedJob(id: string, extra: Partial<ExecutionJob> = {}): ExecutionJob {
  const now = Date.now();
  return {
    id,
    idempotencyKey: "k-" + id,
    jobType: "engineering" as any,
    payload: { kind: "engineering", executionId: "exec-" + id },
    status: "QUEUED",
    createdAt: now,
    updatedAt: now,
    cancellationRequested: false,
    cancellationAcknowledged: false,
    ...extra,
  } as ExecutionJob;
}

function countActiveLeases(db: Database.Database, jobId: string): number {
  const row = db.prepare(
    "SELECT COUNT(*) AS n FROM execution_leases WHERE job_id = ? AND status = 'ACTIVE'"
  ).get(jobId) as { n: number };
  return row.n;
}

function getJobRow(db: Database.Database, jobId: string): { status: string; current_lease_id: string | null } {
  return db.prepare("SELECT status, current_lease_id FROM execution_jobs WHERE id = ?").get(jobId) as any;
}

function getActiveLease(db: Database.Database, jobId: string): { lease_id: string; worker_id: string } | undefined {
  return db.prepare(
    "SELECT lease_id, worker_id FROM execution_leases WHERE job_id = ? AND status = 'ACTIVE'"
  ).get(jobId) as any;
}

async function main() {
  console.log("=== Phase 142 - Atomic Lease Claim ===\n");

  console.log("T01 - successful atomic claim");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("job-t01"));
    const r = h.store.atomicClaimJob({ jobId: "job-t01", workerId: "worker-A", durationMs: 60000 });
    ok(r.claimed === true, "T01 claimed");
    ok(!!r.lease, "T01 lease returned");
    const job = getJobRow(h.db, "job-t01");
    ok(job.status === "CLAIMED", "T01 job status CLAIMED");
    ok(job.current_lease_id === r.lease!.leaseId, "T01 current_lease_id = returned lease");
    ok(countActiveLeases(h.db, "job-t01") === 1, "T01 exactly 1 ACTIVE lease");
    const l = getActiveLease(h.db, "job-t01");
    ok(l?.lease_id === r.lease!.leaseId, "T01 lease_id matches");
    ok(l?.worker_id === "worker-A", "T01 lease.worker_id = worker-A");
  }

  console.log("\nT02 - competing workers");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("job-t02"));
    const a = h.store.atomicClaimJob({ jobId: "job-t02", workerId: "worker-A", durationMs: 60000 });
    const b = h.store.atomicClaimJob({ jobId: "job-t02", workerId: "worker-B", durationMs: 60000 });
    const wins = [a, b].filter((r) => r.claimed);
    ok(wins.length === 1, "T02 exactly one claim succeeded");
    ok(countActiveLeases(h.db, "job-t02") === 1, "T02 exactly one ACTIVE lease");
    const job = getJobRow(h.db, "job-t02");
    ok(job.status === "CLAIMED", "T02 job CLAIMED");
    ok(job.current_lease_id === wins[0].lease!.leaseId, "T02 current_lease_id = winner");
    const l = getActiveLease(h.db, "job-t02");
    ok(l?.worker_id === wins[0].lease!.workerId, "T02 active lease worker = winner");
  }

  console.log("\nT03 - transaction rollback on injected failure (hook-based)");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("job-t03"));

    (h.store as any).__testPhase142Hook = (stage: string) => {
      if (stage === "afterJobUpdate") throw new Error("injected-failure");
    };

    let threw = false;
    try {
      h.store.atomicClaimJob({ jobId: "job-t03", workerId: "worker-X", durationMs: 60000 });
    } catch (e) {
      threw = e instanceof Error && /injected-failure/.test(e.message);
    }
    ok(threw === true, "T03 atomicClaimJob threw on injected failure");

    ok(countActiveLeases(h.db, "job-t03") === 0, "T03 no ACTIVE lease remains");
    const job = getJobRow(h.db, "job-t03");
    ok(job.status === "QUEUED", "T03 job still QUEUED");
    ok(job.current_lease_id === null, "T03 current_lease_id remains NULL");
    const evt = h.db.prepare(
      "SELECT COUNT(*) AS n FROM execution_events WHERE job_id = ? AND event_type = 'execution.transition.claimed'"
    ).get("job-t03") as { n: number };
    ok(evt.n === 0, "T03 no CLAIMED event");

    delete (h.store as any).__testPhase142Hook;

    const r2 = h.store.atomicClaimJob({ jobId: "job-t03", workerId: "worker-X", durationMs: 60000 });
    ok(r2.claimed === true, "T03 retry succeeds");
    ok(!!r2.lease, "T03 retry returns lease");
    ok(countActiveLeases(h.db, "job-t03") === 1, "T03 retry: exactly 1 ACTIVE lease");
    const job2 = getJobRow(h.db, "job-t03");
    ok(job2.status === "CLAIMED", "T03 retry: job CLAIMED");
    ok(job2.current_lease_id === r2.lease!.leaseId, "T03 retry: current_lease_id = returned lease.leaseId");
    const evt2 = h.db.prepare(
      "SELECT COUNT(*) AS n FROM execution_events WHERE job_id = ? AND event_type = 'execution.transition.claimed'"
    ).get("job-t03") as { n: number };
    ok(evt2.n === 1, "T03 retry: exactly 1 CLAIMED event");
  }
  console.log("\nT04 - cancellation race");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("job-t04", { cancellationRequested: true } as any));
    const r = h.store.atomicClaimJob({ jobId: "job-t04", workerId: "worker-A", durationMs: 60000 });
    ok(r.claimed === false, "T04 claim refused");
    ok(r.reason === "CANCELLED", "T04 reason CANCELLED");
    ok(countActiveLeases(h.db, "job-t04") === 0, "T04 no lease");
    const job = getJobRow(h.db, "job-t04");
    ok(job.status === "QUEUED", "T04 job still QUEUED");
  }

  console.log("\nT05 - expired prior lease does not block new claim");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("job-t05"));
    const now = Date.now();
    h.db.prepare(
      "INSERT INTO execution_leases (lease_id, job_id, worker_id, acquired_at, expires_at, renewed_at, released_at, status) " +
      "VALUES ('stale-1', 'job-t05', 'worker-old', ?, ?, NULL, NULL, 'ACTIVE')"
    ).run(now - 120000, now - 60000);
    ok(countActiveLeases(h.db, "job-t05") === 1, "T05 pre-claim: 1 stale ACTIVE lease");
    const r = h.store.atomicClaimJob({ jobId: "job-t05", workerId: "worker-B", durationMs: 60000 });
    ok(r.claimed === true, "T05 new claim succeeds");
    ok(countActiveLeases(h.db, "job-t05") === 1, "T05 exactly 1 ACTIVE lease after cleanup");
    const l = getActiveLease(h.db, "job-t05");
    ok(l?.lease_id === r.lease!.leaseId, "T05 the ACTIVE lease is the new one");
    ok(l?.worker_id === "worker-B", "T05 new worker owns it");
  }

  console.log("\nT06 - fencing regression: fresh lease blocks second claim until expiry");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("job-t06"));
    const a = h.store.atomicClaimJob({ jobId: "job-t06", workerId: "worker-A", durationMs: 60000 });
    ok(a.claimed === true, "T06 worker A claims");
    const b = h.store.atomicClaimJob({ jobId: "job-t06", workerId: "worker-B", durationMs: 60000 });
    ok(b.claimed === false, "T06 worker B blocked");
    ok(b.reason === "NOT_QUEUED" || b.reason === "ALREADY_LEASED", "T06 rejection reason is NOT_QUEUED or ALREADY_LEASED");
    const l = getActiveLease(h.db, "job-t06");
    ok(l?.worker_id === "worker-A", "T06 ownership unchanged");
  }

  console.log("\nT07 - exactly one durable claim event");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("job-t07"));
    h.store.atomicClaimJob({ jobId: "job-t07", workerId: "worker-A", durationMs: 60000 });
    const evt = h.db.prepare(
      "SELECT COUNT(*) AS n FROM execution_events WHERE job_id = ? AND event_type = 'execution.transition.claimed'"
    ).get("job-t07") as { n: number };
    ok(evt.n === 1, "T07 exactly one execution.transition.claimed event");
  }

  console.log("\nT08 - migration 142 index still present and functional");
  {
    const h = makeHarness();
    const idx = h.db.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_execution_leases_active_job'"
    ).get() as { name: string; sql: string } | undefined;
    ok(!!idx, "T08 index exists");
    ok(/WHERE status = 'ACTIVE'/i.test(idx?.sql ?? ""), "T08 index is partial on status='ACTIVE'");

    // Prove the index actually blocks a second ACTIVE lease at the DB layer.
    h.store.createJob(queuedJob("job-t08"));
    const now = Date.now();
    h.db.prepare(
      "INSERT INTO execution_leases (lease_id, job_id, worker_id, acquired_at, expires_at, renewed_at, released_at, status) " +
      "VALUES ('dup-1', 'job-t08', 'w1', ?, ?, NULL, NULL, 'ACTIVE')"
    ).run(now, now + 60000);
    let blocked = false;
    try {
      h.db.prepare(
        "INSERT INTO execution_leases (lease_id, job_id, worker_id, acquired_at, expires_at, renewed_at, released_at, status) " +
        "VALUES ('dup-2', 'job-t08', 'w2', ?, ?, NULL, NULL, 'ACTIVE')"
      ).run(now, now + 60000);
    } catch (err: any) {
      blocked = err?.code === "SQLITE_CONSTRAINT_UNIQUE" || /UNIQUE constraint failed/i.test(String(err?.message));
    }
    ok(blocked === true, "T08 index blocks second ACTIVE lease");
  }

  console.log("\n--- Phase 142: " + passed + " passed, " + failed + " failed ---");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error("PHASE142 DRIVER CRASH:", err); process.exit(1); });