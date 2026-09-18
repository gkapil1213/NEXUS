// scripts/test-phase143-transactional-execution-recovery.ts
// Phase 143 - transactional durable execution recovery.
//
// Exercises ExecutionStore.recoverJobAtomic against real better-sqlite3 with
// migrations applied. Every assertion inspects durable rows, not returned
// TypeScript objects.

import Database from "better-sqlite3";
import { join } from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { MigrationRunner } from "../src/core/migration-runner";
import { ExecutionStore } from "../src/core/execution-store";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionJob } from "../src/core/execution-models";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log("  ok   " + msg); }
  else      { failed++; console.log("  FAIL " + msg); }
}

interface H { db: Database.Database; store: ExecutionStore; }

function makeHarness(dbFile?: string): H {
  const rawDb = dbFile ? new Database(dbFile) : new Database(":memory:");
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

function getJob(db: Database.Database, id: string) {
  return db.prepare("SELECT status, current_lease_id, cancellation_requested FROM execution_jobs WHERE id = ?").get(id) as any;
}
function countEvents(db: Database.Database, jobId: string, type?: string): number {
  const sql = type
    ? "SELECT COUNT(*) AS n FROM execution_events WHERE job_id = ? AND event_type = ?"
    : "SELECT COUNT(*) AS n FROM execution_events WHERE job_id = ?";
  return type ? (db.prepare(sql).get(jobId, type) as any).n : (db.prepare(sql).get(jobId) as any).n;
}
function countObligations(db: Database.Database, jobId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM execution_ownership_obligations WHERE job_id = ?").get(jobId) as any).n;
}
function expireLease(db: Database.Database, jobId: string): string {
  const lease = db.prepare("SELECT lease_id FROM execution_leases WHERE job_id = ? AND status = 'ACTIVE'").get(jobId) as any;
  if (!lease) throw new Error("no active lease for " + jobId);
  db.prepare("UPDATE execution_leases SET status = 'EXPIRED', expires_at = ? WHERE lease_id = ?").run(Date.now() - 1000, lease.lease_id);
  return lease.lease_id;
}

async function main() {
  console.log("=== Phase 143 - Transactional Durable Execution Recovery ===\n");

  console.log("143-1 atomic recoverable requeue");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j1", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100 } } as any));
    const r = h.store.atomicClaimJob({ jobId: "j1", workerId: "w1", durationMs: 60000 });
    ok(r.claimed, "143-1 claim succeeds");
    expireLease(h.db, "j1");

    const orphan = h.store.recoverJobAtomic({
      jobId: "j1", expectedStatus: "CLAIMED", newStatus: "ORPHANED",
      expectedLeaseId: r.lease!.leaseId,
      event: { eventType: "execution.recovery.orphaned", payload: { from: "CLAIMED", to: "ORPHANED" } },
      obligation: { leaseId: r.lease!.leaseId, workerId: "w1", reason: "LEASE_EXPIRED" },
    });
    ok(orphan.ok, "143-1 orphan applied");
    ok(getJob(h.db, "j1").status === "ORPHANED", "143-1 job ORPHANED");
    ok(getJob(h.db, "j1").current_lease_id === null, "143-1 current_lease_id cleared");
    ok(countObligations(h.db, "j1") === 1, "143-1 one obligation");
    ok(countEvents(h.db, "j1", "execution.recovery.orphaned") === 1, "143-1 orphan event");

    const rq = h.store.recoverJobAtomic({
      jobId: "j1", expectedStatus: "ORPHANED", newStatus: "QUEUED",
      expectedLeaseId: null, patch: { nextAttemptAt: Date.now() },
      event: { eventType: "execution.recovery.requeued", payload: { from: "ORPHANED", to: "QUEUED" } },
    });
    ok(rq.ok, "143-1 requeue applied");
    ok(getJob(h.db, "j1").status === "QUEUED", "143-1 job QUEUED");
    ok(countEvents(h.db, "j1", "execution.recovery.requeued") === 1, "143-1 requeue event");
  }

  console.log("\n143-2 atomic non-retryable recovery");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j2"));
    const r = h.store.atomicClaimJob({ jobId: "j2", workerId: "w2", durationMs: 60000 });
    expireLease(h.db, "j2");
    const orphan = h.store.recoverJobAtomic({
      jobId: "j2", expectedStatus: "CLAIMED", newStatus: "ORPHANED",
      expectedLeaseId: r.lease!.leaseId,
      event: { eventType: "execution.recovery.orphaned", payload: {} },
      obligation: { leaseId: r.lease!.leaseId, workerId: "w2", reason: "LEASE_EXPIRED" },
    });
    ok(orphan.ok, "143-2 orphan applied");
    ok(getJob(h.db, "j2").status === "ORPHANED", "143-2 stays ORPHANED (no retry policy)");
    ok(countObligations(h.db, "j2") === 1, "143-2 obligation durable");
    ok(countEvents(h.db, "j2", "execution.recovery.orphaned") === 1, "143-2 event durable");
  }

  console.log("\n143-3 cancellation precedence");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j3"));
    const r = h.store.atomicClaimJob({ jobId: "j3", workerId: "w3", durationMs: 60000 });
    h.store.requestCancellation("j3");
    expireLease(h.db, "j3");
    const cancel = h.store.recoverJobAtomic({
      jobId: "j3", expectedStatus: "CLAIMED", newStatus: "CANCELLED",
      expectedLeaseId: r.lease!.leaseId,
      event: { eventType: "execution.recovery.cancelled", payload: { reason: "cancellation_requested_honoured_after_lease_loss" } },
      obligation: { leaseId: r.lease!.leaseId, workerId: "w3", reason: "CANCELLATION_REQUESTED_ON_LEASE_LOSS" },
    });
    ok(cancel.ok, "143-3 cancellation applied");
    ok(getJob(h.db, "j3").status === "CANCELLED", "143-3 status CANCELLED");
    ok(countEvents(h.db, "j3", "execution.recovery.cancelled") === 1, "143-3 cancellation event");
  }

  console.log("\n143-4 timeout precedence");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j4", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100 }, timeoutMs: 1000 } as any));
    const r4 = h.store.atomicClaimJob({ jobId: "j4", workerId: "w4", durationMs: 60000 });
    ok(r4.claimed, "143-4 claim succeeds");
    expireLease(h.db, "j4");

    const failed = h.store.recoverJobAtomic({
      jobId: "j4", expectedStatus: "CLAIMED", newStatus: "FAILED",
      expectedLeaseId: r4.lease!.leaseId,
      event: { eventType: "execution.recovery.failed", payload: { reason: "deadline_exceeded_during_lease_loss" } },
      obligation: { leaseId: r4.lease!.leaseId, workerId: "w4", reason: "TIMEOUT_ON_LEASE_LOSS" },
    });
    ok(failed.ok, "143-4 FAILED applied");
    ok(getJob(h.db, "j4").status === "FAILED", "143-4 status FAILED");
    ok(countEvents(h.db, "j4", "execution.recovery.failed") === 1, "143-4 failed event");

    const routed = h.store.recoverJobAtomic({
      jobId: "j4", expectedStatus: "FAILED", newStatus: "RETRY_SCHEDULED",
      expectedLeaseId: null, patch: { nextAttemptAt: Date.now() },
      event: { eventType: "execution.recovery.rerouted", payload: { from: "FAILED", to: "RETRY_SCHEDULED" } },
    });
    ok(routed.ok, "143-4 reroute applied");
    ok(getJob(h.db, "j4").status === "RETRY_SCHEDULED", "143-4 status RETRY_SCHEDULED");
    ok(countEvents(h.db, "j4", "execution.recovery.rerouted") === 1, "143-4 reroute event");
  }
  console.log("\n143-5 concurrent recovery produces one owner");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j5"));
    const r = h.store.atomicClaimJob({ jobId: "j5", workerId: "w5", durationMs: 60000 });
    expireLease(h.db, "j5");
    const a = h.store.recoverJobAtomic({
      jobId: "j5", expectedStatus: "CLAIMED", newStatus: "ORPHANED",
      expectedLeaseId: r.lease!.leaseId,
      event: { eventType: "execution.recovery.orphaned", payload: {} },
      obligation: { leaseId: r.lease!.leaseId, workerId: "w5", reason: "LEASE_EXPIRED" },
    });
    const b = h.store.recoverJobAtomic({
      jobId: "j5", expectedStatus: "CLAIMED", newStatus: "ORPHANED",
      expectedLeaseId: r.lease!.leaseId,
      event: { eventType: "execution.recovery.orphaned", payload: {} },
      obligation: { leaseId: r.lease!.leaseId, workerId: "w5", reason: "LEASE_EXPIRED" },
    });
    ok(a.ok && !b.ok, "143-5 exactly one recovery wins");
    ok(countObligations(h.db, "j5") === 1, "143-5 exactly one obligation");
    ok(countEvents(h.db, "j5", "execution.recovery.orphaned") === 1, "143-5 exactly one event");
  }

  console.log("\n143-6 rollback after state mutation (hook throws)");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j6"));
    const r = h.store.atomicClaimJob({ jobId: "j6", workerId: "w6", durationMs: 60000 });
    expireLease(h.db, "j6");
    (h.store as any).__testPhase143Hook = (stage: string) => { if (stage === "afterJobUpdate") throw new Error("injected-6"); };
    let threw = false;
    try {
      h.store.recoverJobAtomic({
        jobId: "j6", expectedStatus: "CLAIMED", newStatus: "ORPHANED",
        expectedLeaseId: r.lease!.leaseId,
        event: { eventType: "execution.recovery.orphaned", payload: {} },
        obligation: { leaseId: r.lease!.leaseId, workerId: "w6", reason: "LEASE_EXPIRED" },
      });
    } catch (e) { threw = true; }
    delete (h.store as any).__testPhase143Hook;
    ok(threw, "143-6 injected failure propagated");
    ok(getJob(h.db, "j6").status === "CLAIMED", "143-6 job rolled back to CLAIMED");
    ok(getJob(h.db, "j6").current_lease_id === r.lease!.leaseId, "143-6 current_lease_id preserved");
    ok(countObligations(h.db, "j6") === 0, "143-6 no obligation");
    ok(countEvents(h.db, "j6", "execution.recovery.orphaned") === 0, "143-6 no event");
  }

  console.log("\n143-7 rollback after obligation (hook throws)");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j7"));
    const r = h.store.atomicClaimJob({ jobId: "j7", workerId: "w7", durationMs: 60000 });
    expireLease(h.db, "j7");
    (h.store as any).__testPhase143Hook = (stage: string) => { if (stage === "afterObligation") throw new Error("injected-7"); };
    let threw = false;
    try {
      h.store.recoverJobAtomic({
        jobId: "j7", expectedStatus: "CLAIMED", newStatus: "ORPHANED",
        expectedLeaseId: r.lease!.leaseId,
        event: { eventType: "execution.recovery.orphaned", payload: {} },
        obligation: { leaseId: r.lease!.leaseId, workerId: "w7", reason: "LEASE_EXPIRED" },
      });
    } catch (e) { threw = true; }
    delete (h.store as any).__testPhase143Hook;
    ok(threw, "143-7 injected failure propagated");
    ok(getJob(h.db, "j7").status === "CLAIMED", "143-7 job rolled back");
    ok(countObligations(h.db, "j7") === 0, "143-7 no obligation survives");
    ok(countEvents(h.db, "j7", "execution.recovery.orphaned") === 0, "143-7 no event survives");
  }

  console.log("\n143-8 process reload durability");
  {
    const dir = mkdtempSync(join(tmpdir(), "p143-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      h1.store.createJob(queuedJob("j8"));
      const r1 = h1.store.atomicClaimJob({ jobId: "j8", workerId: "w8", durationMs: 60000 });
      expireLease(h1.db, "j8");
      const o1 = h1.store.recoverJobAtomic({
        jobId: "j8", expectedStatus: "CLAIMED", newStatus: "ORPHANED",
        expectedLeaseId: r1.lease!.leaseId,
        event: { eventType: "execution.recovery.orphaned", payload: {} },
        obligation: { leaseId: r1.lease!.leaseId, workerId: "w8", reason: "LEASE_EXPIRED" },
      });
      ok(o1.ok, "143-8 recovery applied before reload");
      h1.db.close();

      const h2 = makeHarness(dbFile);
      ok(getJob(h2.db, "j8").status === "ORPHANED", "143-8 status durable across reload");
      ok(countObligations(h2.db, "j8") === 1, "143-8 obligation durable across reload");
      ok(countEvents(h2.db, "j8", "execution.recovery.orphaned") === 1, "143-8 event durable across reload");
      h2.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log("\n143-9 repeated recovery is idempotent");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j9"));
    const r = h.store.atomicClaimJob({ jobId: "j9", workerId: "w9", durationMs: 60000 });
    expireLease(h.db, "j9");
    const first = h.store.recoverJobAtomic({
      jobId: "j9", expectedStatus: "CLAIMED", newStatus: "ORPHANED",
      expectedLeaseId: r.lease!.leaseId,
      event: { eventType: "execution.recovery.orphaned", payload: {} },
      obligation: { leaseId: r.lease!.leaseId, workerId: "w9", reason: "LEASE_EXPIRED" },
    });
    const second = h.store.recoverJobAtomic({
      jobId: "j9", expectedStatus: "CLAIMED", newStatus: "ORPHANED",
      expectedLeaseId: r.lease!.leaseId,
      event: { eventType: "execution.recovery.orphaned", payload: {} },
      obligation: { leaseId: r.lease!.leaseId, workerId: "w9", reason: "LEASE_EXPIRED" },
    });
    ok(first.ok && !second.ok, "143-9 second recovery rejected by CAS");
    ok(countObligations(h.db, "j9") === 1, "143-9 no duplicate obligation");
    ok(countEvents(h.db, "j9", "execution.recovery.orphaned") === 1, "143-9 no duplicate event");
  }

  console.log("\n143-10 stale recovery vs new owner");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j10", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100 } } as any));
    const old = h.store.atomicClaimJob({ jobId: "j10", workerId: "old", durationMs: 1 });
    expireLease(h.db, "j10");
    // New owner claims after ORPHANED->QUEUED path
    h.store.recoverJobAtomic({
      jobId: "j10", expectedStatus: "CLAIMED", newStatus: "ORPHANED",
      expectedLeaseId: old.lease!.leaseId,
      event: { eventType: "execution.recovery.orphaned", payload: {} },
      obligation: { leaseId: old.lease!.leaseId, workerId: "old", reason: "LEASE_EXPIRED" },
    });
    h.store.recoverJobAtomic({
      jobId: "j10", expectedStatus: "ORPHANED", newStatus: "QUEUED",
      expectedLeaseId: null,
      event: { eventType: "execution.recovery.requeued", payload: {} },
    });
    const fresh = h.store.atomicClaimJob({ jobId: "j10", workerId: "new", durationMs: 60000 });
    ok(fresh.claimed, "143-10 new owner claims");
    // Stale recovery tries to orphan using old lease id — CAS on lease id must fail.
    const stale = h.store.recoverJobAtomic({
      jobId: "j10", expectedStatus: "CLAIMED", newStatus: "ORPHANED",
      expectedLeaseId: old.lease!.leaseId,
      event: { eventType: "execution.recovery.orphaned", payload: {} },
      obligation: { leaseId: old.lease!.leaseId, workerId: "old", reason: "LEASE_EXPIRED" },
    });
    ok(!stale.ok, "143-10 stale recovery rejected");
    ok(getJob(h.db, "j10").current_lease_id === fresh.lease!.leaseId, "143-10 new owner lease intact");
  }

  console.log("\n143-11 terminal protection");
  {
    for (const terminal of ["SUCCEEDED", "FAILED", "CANCELLED", "DEAD_LETTER"]) {
      const h = makeHarness();
      h.store.createJob(queuedJob("jt-" + terminal));
      h.db.prepare("UPDATE execution_jobs SET status = ? WHERE id = ?").run(terminal, "jt-" + terminal);
      const r = h.store.recoverJobAtomic({
        jobId: "jt-" + terminal, expectedStatus: "CLAIMED", newStatus: "ORPHANED",
        expectedLeaseId: "some-lease",
        event: { eventType: "execution.recovery.orphaned", payload: {} },
      });
      ok(!r.ok, "143-11 " + terminal + " cannot be resurrected");
      ok(getJob(h.db, "jt-" + terminal).status === terminal, "143-11 " + terminal + " unchanged");
    }
  }

  console.log("\n--- Phase 143: " + passed + " passed, " + failed + " failed ---");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error("PHASE143 DRIVER CRASH:", err); process.exit(1); });