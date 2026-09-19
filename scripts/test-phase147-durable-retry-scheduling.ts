// scripts/test-phase147-durable-retry-scheduling.ts
// Phase 147 - durable retry scheduling & attempt-consistency integrity.
//
// Every assertion reads durable SQLite rows. No mocks.

import Database from "better-sqlite3";
import { join } from "path";
import { MigrationRunner } from "../src/core/migration-runner";
import { ExecutionStore } from "../src/core/execution-store";
import { ExecutionEngine } from "../src/core/execution-engine";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionJob } from "../src/core/execution-models";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log("  ok   " + msg); }
  else      { failed++; console.log("  FAIL " + msg); }
}

interface EngineH {
  db: Database.Database;
  store: ExecutionStore;
  engine: ExecutionEngine;
}

function makeEngineHarness(dbFile?: string): EngineH {
  const rawDb = dbFile ? new Database(dbFile) : new Database(":memory:");
  const migrationsDir = join(process.cwd(), "src", "db", "migrations");
  new MigrationRunner(rawDb, migrationsDir).run();
  const db = SQLiteEngine.fromDatabase(rawDb);
  const store = new ExecutionStore(db as any);
  const leaseManager: any = { recoverExpiredLeases: () => [] };
  const workerRegistry: any = { detectLostWorkers: () => [] };
  const engine = new ExecutionEngine(store, workerRegistry, leaseManager, {} as any, {});
  return { db: rawDb, store, engine };
}

function queuedJob(id: string, extra: Partial<ExecutionJob> = {}): ExecutionJob {
  const now = Date.now();
  return {
    id, idempotencyKey: "k-" + id, jobType: "engineering" as any,
    payload: { kind: "engineering", executionId: "exec-" + id },
    status: "QUEUED", createdAt: now, updatedAt: now,
    cancellationRequested: false, cancellationAcknowledged: false,
    ...extra,
  } as ExecutionJob;
}

function getJob(db: Database.Database, id: string) {
  return db.prepare("SELECT status, next_attempt_at, current_lease_id, cancellation_requested FROM execution_jobs WHERE id = ?").get(id) as any;
}
function countEvents(db: Database.Database, jobId: string, type: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM execution_events WHERE job_id = ? AND event_type = ?").get(jobId, type) as any).n;
}
function setScheduled(db: Database.Database, id: string, nextAt: number | null): void {
  db.prepare("UPDATE execution_jobs SET status='RETRY_SCHEDULED', next_attempt_at = ?, current_lease_id = NULL WHERE id = ?").run(nextAt, id);
}

async function main() {
  console.log("=== Phase 147 - Durable Retry Scheduling & Attempt-Consistency ===\n");

  console.log("147-1 due RETRY_SCHEDULED job is promoted to QUEUED");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j1", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100, multiplier: 2, maxDelayMs: 1000 } as any } as any));
    setScheduled(h.db, "j1", Date.now() - 1000);
    h.engine.recoverStaleJobs();
    ok(getJob(h.db, "j1").status === "QUEUED", "147-1 promoted to QUEUED");
    ok(getJob(h.db, "j1").next_attempt_at === null, "147-1 next_attempt_at cleared");
    ok(countEvents(h.db, "j1", "execution.retry.due") === 1, "147-1 one due event");
  }

  console.log("147-2 future next_attempt_at is not yet due");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j2", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100, multiplier: 2, maxDelayMs: 1000 } as any } as any));
    setScheduled(h.db, "j2", Date.now() + 60000);
    h.engine.recoverStaleJobs();
    ok(getJob(h.db, "j2").status === "RETRY_SCHEDULED", "147-2 stays RETRY_SCHEDULED");
    ok(countEvents(h.db, "j2", "execution.retry.due") === 0, "147-2 no due event");
  }

  console.log("147-3 cancellation requested before retry due routes CANCELLED");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j3", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100, multiplier: 2, maxDelayMs: 1000 } as any } as any));
    setScheduled(h.db, "j3", Date.now() - 1000);
    h.db.prepare("UPDATE execution_jobs SET cancellation_requested = 1 WHERE id = 'j3'").run();
    h.engine.recoverStaleJobs();
    ok(getJob(h.db, "j3").status === "CANCELLED", "147-3 CANCELLED");
    ok(countEvents(h.db, "j3", "execution.retry.cancelled") === 1, "147-3 one cancelled event");
    ok(countEvents(h.db, "j3", "execution.retry.due") === 0, "147-3 no due event");
  }

  console.log("147-4 two engines promoting the same due retry converge");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j4", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100, multiplier: 2, maxDelayMs: 1000 } as any } as any));
    setScheduled(h.db, "j4", Date.now() - 1000);
    const engine2 = new ExecutionEngine(h.store, { detectLostWorkers: () => [] } as any, { recoverExpiredLeases: () => [] } as any, {} as any, {});
    h.engine.recoverStaleJobs();
    engine2.recoverStaleJobs();
    h.engine.recoverStaleJobs();
    ok(getJob(h.db, "j4").status === "QUEUED", "147-4 QUEUED");
    ok(countEvents(h.db, "j4", "execution.retry.due") === 1, "147-4 exactly one due event");
  }

  console.log("147-5 repeated recovery after promotion is idempotent");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j5", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100, multiplier: 2, maxDelayMs: 1000 } as any } as any));
    setScheduled(h.db, "j5", Date.now() - 1000);
    h.engine.recoverStaleJobs();
    h.engine.recoverStaleJobs();
    h.engine.recoverStaleJobs();
    ok(getJob(h.db, "j5").status === "QUEUED", "147-5 stable QUEUED");
    ok(countEvents(h.db, "j5", "execution.retry.due") === 1, "147-5 still one due event");
  }

  console.log("147-6 promotion is durable across process reload");
  {
    const dir = (await import("fs")).mkdtempSync(join((await import("os")).tmpdir(), "p147-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeEngineHarness(dbFile);
      h1.store.createJob(queuedJob("j6", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100, multiplier: 2, maxDelayMs: 1000 } as any } as any));
      setScheduled(h1.db, "j6", Date.now() - 1000);
      h1.engine.recoverStaleJobs();
      h1.db.close();

      const h2 = makeEngineHarness(dbFile);
      ok(getJob(h2.db, "j6").status === "QUEUED", "147-6 QUEUED durable");
      ok(getJob(h2.db, "j6").next_attempt_at === null, "147-6 next_attempt_at cleared durable");
      ok(countEvents(h2.db, "j6", "execution.retry.due") === 1, "147-6 one due event durable");
      h2.db.close();
    } finally {
      (await import("fs")).rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log("147-7 missing next_attempt_at escalates invariant violation");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j7", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100, multiplier: 2, maxDelayMs: 1000 } as any } as any));
    setScheduled(h.db, "j7", null);
    h.engine.recoverStaleJobs();
    ok(getJob(h.db, "j7").status === "ORPHANED", "147-7 escalated to ORPHANED");
    ok(countEvents(h.db, "j7", "execution.retry.invariant_violation") === 1, "147-7 one invariant event");
  }

  console.log("147-8 zero next_attempt_at escalates invariant violation");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j8", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100, multiplier: 2, maxDelayMs: 1000 } as any } as any));
    setScheduled(h.db, "j8", 0);
    h.engine.recoverStaleJobs();
    ok(getJob(h.db, "j8").status === "ORPHANED", "147-8 escalated to ORPHANED");
  }

  console.log("147-9 terminal jobs are never promoted");
  {
    for (const terminal of ["SUCCEEDED", "FAILED", "CANCELLED", "DEAD_LETTER", "ORPHANED"]) {
      const h = makeEngineHarness();
      h.store.createJob(queuedJob("j9-" + terminal));
      h.db.prepare("UPDATE execution_jobs SET status = ? WHERE id = ?").run(terminal, "j9-" + terminal);
      h.engine.recoverStaleJobs();
      ok(getJob(h.db, "j9-" + terminal).status === terminal, "147-9 " + terminal + " unchanged");
    }
  }

  console.log("147-10 stale-worker fencing: no ownership possible at RETRY_SCHEDULED");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j10", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100, multiplier: 2, maxDelayMs: 1000 } as any } as any));
    setScheduled(h.db, "j10", Date.now() - 1000);
    // Pre-existing current_lease_id is already NULL; verify CAS rejects an attempt
    // that asserts a stale lease
    const stale = h.store.recoverJobAtomic({
      jobId: "j10",
      expectedStatus: "RETRY_SCHEDULED",
      newStatus: "QUEUED",
      expectedLeaseId: "stale-lease-from-dead-worker",
      event: { eventType: "execution.retry.due", payload: {} },
    });
    ok(!stale.ok, "147-10 stale lease asserted: rejected");
    ok(getJob(h.db, "j10").status === "RETRY_SCHEDULED", "147-10 job unchanged");
  }

  console.log("147-11 non-due promotion has no side effects");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j11", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100, multiplier: 2, maxDelayMs: 1000 } as any } as any));
    const future = Date.now() + 3600000;
    setScheduled(h.db, "j11", future);
    h.engine.recoverStaleJobs();
    ok(getJob(h.db, "j11").status === "RETRY_SCHEDULED", "147-11 unchanged status");
    ok(getJob(h.db, "j11").next_attempt_at === future, "147-11 next_attempt_at preserved");
    ok(countEvents(h.db, "j11", "execution.retry.due") === 0, "147-11 no event");
  }

  console.log("147-12 promotion emits exactly one event per call site");
  {
    const h = makeEngineHarness();
    for (let i = 1; i <= 5; i++) {
      h.store.createJob(queuedJob("j12-" + i, { retryPolicy: { maxAttempts: 3, initialDelayMs: 100, multiplier: 2, maxDelayMs: 1000 } as any } as any));
      setScheduled(h.db, "j12-" + i, Date.now() - 1000);
    }
    h.engine.recoverStaleJobs();
    let totalDue = 0;
    for (let i = 1; i <= 5; i++) totalDue += countEvents(h.db, "j12-" + i, "execution.retry.due");
    ok(totalDue === 5, "147-12 exactly five due events across five jobs");
    let queued = 0;
    for (let i = 1; i <= 5; i++) if (getJob(h.db, "j12-" + i).status === "QUEUED") queued++;
    ok(queued === 5, "147-12 all five QUEUED");
  }

  console.log("\n--- Phase 147: " + passed + " passed, " + failed + " failed ---");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error("PHASE147 DRIVER CRASH:", err); process.exit(1); });
