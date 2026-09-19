// scripts/test-phase153-recovery-lease-fencing.ts
// Phase 153 - durable recovery lease renewal & long-running ownership fencing.
//
// Exercises the real ExecutionRecoveryOperationStore against real better-sqlite3.
// Every assertion reads durable SQLite rows.

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

function queuedJob(id: string): ExecutionJob {
  const now = Date.now();
  return {
    id, idempotencyKey: "k-" + id, jobType: "engineering" as any,
    payload: { kind: "engineering", executionId: "exec-" + id },
    status: "QUEUED", createdAt: now, updatedAt: now,
    cancellationRequested: false, cancellationAcknowledged: false,
  } as ExecutionJob;
}

function createOp(h: H, jobId: string, type = "CANCELLATION"): string {
  h.store.createJob(queuedJob(jobId));
  const { operation } = h.store.recoveryOps.createOrGetOperation({
    jobId, leaseId: "L-" + jobId, workerId: "w-" + jobId, operationType: type as any,
  });
  return operation.operationId;
}
function getOp(h: H, opId: string) {
  return h.db.prepare("SELECT * FROM execution_recovery_operations WHERE operation_id = ?").get(opId) as any;
}
function countEvents(h: H, jobId: string): number {
  return (h.db.prepare("SELECT COUNT(*) AS n FROM execution_events WHERE job_id = ?").get(jobId) as any).n;
}
function countOps(h: H, jobId: string): number {
  return (h.db.prepare("SELECT COUNT(*) AS n FROM execution_recovery_operations WHERE job_id = ?").get(jobId) as any).n;
}

async function main() {
  console.log("=== Phase 153 - Recovery Lease Renewal & Long-Running Ownership Fencing ===\n");

  // ==================================================================
  // Group A - Renewal basics
  // ==================================================================

  console.log("153-A1 owner can renew live claim");
  {
    const h = makeHarness();
    const opId = createOp(h, "a1");
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "A", durationMs: 60000 });
    const r = h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000 });
    ok(r.renewed === true, "A1 renewed");
    ok(getOp(h, opId).claim_owner === "A", "A1 owner preserved");
  }

  console.log("\n153-A2 renewal extends expiration");
  {
    const h = makeHarness();
    const opId = createOp(h, "a2");
    const t0 = 1_000_000_000_000;
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "A", durationMs: 60000, now: t0 });
    const before = getOp(h, opId).claim_expires_at;
    const t1 = t0 + 30_000;
    h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: t1 });
    const after = getOp(h, opId).claim_expires_at;
    ok(after > before, "A2 expiry extended");
    ok(after === t1 + 60000, "A2 new expiry is now + duration");
  }

  console.log("\n153-A3 renewal does not increment attempt_count");
  {
    const h = makeHarness();
    const opId = createOp(h, "a3");
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "A", durationMs: 60000 });
    const before = getOp(h, opId).attempt_count;
    h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000 });
    h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000 });
    h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000 });
    ok(getOp(h, opId).attempt_count === before, "A3 attempt_count unchanged");
  }

  console.log("\n153-A4 non-owner cannot renew");
  {
    const h = makeHarness();
    const opId = createOp(h, "a4");
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "A", durationMs: 60000 });
    const r = h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "B", durationMs: 60000 });
    ok(r.renewed === false && r.reason === "OWNERSHIP_LOST", "A4 B rejected");
  }

  console.log("\n153-A5 missing operation cannot renew");
  {
    const h = makeHarness();
    const r = h.store.recoveryOps.renewOperationClaim({ operationId: "nonexistent", owner: "A", durationMs: 60000 });
    ok(r.renewed === false && r.reason === "NOT_FOUND", "A5 NOT_FOUND");
  }

  // ==================================================================
  // Group B - Expiration boundaries
  // ==================================================================

  console.log("\n153-B1 expired owner cannot renew");
  {
    const h = makeHarness();
    const opId = createOp(h, "b1");
    const t0 = 1_000_000_000_000;
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "A", durationMs: 60000, now: t0 });
    const tAfter = t0 + 120_000;
    const r = h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: tAfter });
    ok(r.renewed === false && r.reason === "EXPIRED", "B1 EXPIRED");
  }

  console.log("\n153-B2 exact-boundary expiry rejects renewal");
  {
    const h = makeHarness();
    const opId = createOp(h, "b2");
    const t0 = 1_000_000_000_000;
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "A", durationMs: 60000, now: t0 });
    // claim_expires_at === t0 + 60000. At now === t0 + 60000, CAS predicate
    // claim_expires_at > now fails. Renewal must reject.
    const r = h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: t0 + 60000 });
    ok(r.renewed === false && r.reason === "EXPIRED", "B2 boundary rejects");
  }

  console.log("\n153-B3 just-past-boundary rejects");
  {
    const h = makeHarness();
    const opId = createOp(h, "b3");
    const t0 = 1_000_000_000_000;
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "A", durationMs: 60000, now: t0 });
    const r = h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: t0 + 60001 });
    ok(r.renewed === false && r.reason === "EXPIRED", "B3 past-boundary rejects");
  }

  console.log("\n153-B4 just-before-boundary succeeds");
  {
    const h = makeHarness();
    const opId = createOp(h, "b4");
    const t0 = 1_000_000_000_000;
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "A", durationMs: 60000, now: t0 });
    const r = h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: t0 + 59999 });
    ok(r.renewed === true, "B4 before-boundary succeeds");
  }

  console.log("\n153-B5 owner can renew multiple times");
  {
    const h = makeHarness();
    const opId = createOp(h, "b5");
    const t0 = 1_000_000_000_000;
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "A", durationMs: 60000, now: t0 });
    let t = t0;
    for (let i = 0; i < 5; i++) {
      t += 30000;
      const r = h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: t });
      ok(r.renewed === true, "B5 renewal " + (i + 1) + " ok");
    }
    ok(getOp(h, opId).claim_owner === "A", "B5 still owner");
  }

  // ==================================================================
  // Group C - Takeover / fencing
  // ==================================================================

  console.log("\n153-C1 takeover after expiration succeeds");
  {
    const h = makeHarness();
    const opId = createOp(h, "c1");
    const t0 = 1_000_000_000_000;
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "A", durationMs: 60000, now: t0 });
    const tAfter = t0 + 120_000;
    const r = h.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000, now: tAfter });
    ok(r.claimed === true, "C1 B takes over");
    ok(getOp(h, opId).claim_owner === "B", "C1 owner is B");
  }

  console.log("\n153-C2 stale owner cannot renew after takeover");
  {
    const h = makeHarness();
    const opId = createOp(h, "c2");
    const t0 = 1_000_000_000_000;
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "A", durationMs: 60000, now: t0 });
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000, now: t0 + 120_000 });
    const r = h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: t0 + 130_000 });
    ok(r.renewed === false && r.reason === "OWNERSHIP_LOST", "C2 A rejected");
  }

  console.log("\n153-C3 stale owner cannot complete after takeover");
  {
    const h = makeHarness();
    const opId = createOp(h, "c3");
    const t0 = 1_000_000_000_000;
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "A", durationMs: 60000, now: t0 });
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000, now: t0 + 120_000 });
    ok(h.store.recoveryOps.markCompleted(opId, "A", t0 + 130_000) === false, "C3 A completion rejected");
  }

  console.log("\n153-C4 stale owner cannot fail after takeover");
  {
    const h = makeHarness();
    const opId = createOp(h, "c4");
    const t0 = 1_000_000_000_000;
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "A", durationMs: 60000, now: t0 });
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000, now: t0 + 120_000 });
    ok(h.store.recoveryOps.markFailed(opId, "A", "err", t0 + 130_000) === false, "C4 A failed rejected");
  }

  console.log("\n153-C5 stale owner cannot mark recovery required after takeover");
  {
    const h = makeHarness();
    const opId = createOp(h, "c5");
    const t0 = 1_000_000_000_000;
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "A", durationMs: 60000, now: t0 });
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000, now: t0 + 120_000 });
    ok(h.store.recoveryOps.markRecoveryRequired(opId, "A", "err", t0 + 130_000) === false, "C5 A recovery-required rejected");
  }

  // ==================================================================
  // Group D - Long-running / crash recovery
  // ==================================================================

  console.log("\n153-D1 crash after claim eventually permits takeover");
  {
    const h = makeHarness();
    const opId = createOp(h, "d1");
    const t0 = 1_000_000_000_000;
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "A", durationMs: 60000, now: t0 });
    // A crashes; B attempts takeover after expiry.
    const r = h.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000, now: t0 + 120_000 });
    ok(r.claimed === true, "D1 B takes over");
  }

  console.log("\n153-D2 crash after IN_PROGRESS eventually permits takeover");
  {
    const h = makeHarness();
    const opId = createOp(h, "d2");
    const t0 = 1_000_000_000_000;
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "A", durationMs: 60000, now: t0 });
    h.store.recoveryOps.markInProgress(opId, "A", t0);
    ok(getOp(h, opId).state === "IN_PROGRESS", "D2 IN_PROGRESS");
    const r = h.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000, now: t0 + 120_000 });
    ok(r.claimed === true, "D2 B takes over IN_PROGRESS");
  }

  console.log("\n153-D3 DB reopen preserves claim state");
  {
    const dir = mkdtempSync(join(tmpdir(), "p153-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      const opId = createOp(h1, "d3");
      const t0 = 1_000_000_000_000;
      h1.store.recoveryOps.claimOperation({ operationId: opId, owner: "A", durationMs: 60000, now: t0 });
      h1.store.recoveryOps.markInProgress(opId, "A", t0);
      h1.db.close();

      const h2 = makeHarness(dbFile);
      const op = getOp(h2, opId);
      ok(op.claim_owner === "A", "D3 owner durable");
      ok(op.state === "IN_PROGRESS", "D3 state durable");
      ok(op.claim_expires_at === t0 + 60000, "D3 expiry durable");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n153-D4 new owner can complete after takeover");
  {
    const h = makeHarness();
    const opId = createOp(h, "d4");
    const t0 = 1_000_000_000_000;
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "A", durationMs: 60000, now: t0 });
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000, now: t0 + 120_000 });
    ok(h.store.recoveryOps.markCompleted(opId, "B", t0 + 130_000) === true, "D4 B completes");
    ok(getOp(h, opId).state === "COMPLETED", "D4 COMPLETED");
  }

  console.log("\n153-D5 new owner can renew after takeover");
  {
    const h = makeHarness();
    const opId = createOp(h, "d5");
    const t0 = 1_000_000_000_000;
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "A", durationMs: 60000, now: t0 });
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000, now: t0 + 120_000 });
    const r = h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "B", durationMs: 60000, now: t0 + 130_000 });
    ok(r.renewed === true, "D5 B renews");
  }

  // ==================================================================
  // Group E - Terminal / idempotency safety
  // ==================================================================

  console.log("\n153-E1 completed operation cannot renew");
  {
    const h = makeHarness();
    const opId = createOp(h, "e1");
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "A", durationMs: 60000 });
    h.store.recoveryOps.markCompleted(opId, "A");
    const r = h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000 });
    ok(r.renewed === false && r.reason === "TERMINAL", "E1 COMPLETED rejected");
  }

  console.log("\n153-E2 failed operation cannot renew");
  {
    const h = makeHarness();
    const opId = createOp(h, "e2");
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "A", durationMs: 60000 });
    h.store.recoveryOps.markFailed(opId, "A", "err");
    const r = h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000 });
    ok(r.renewed === false && r.reason === "TERMINAL", "E2 FAILED rejected");
  }

  console.log("\n153-E3 recovery-required operation cannot renew");
  {
    const h = makeHarness();
    const opId = createOp(h, "e3");
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "A", durationMs: 60000 });
    h.store.recoveryOps.markRecoveryRequired(opId, "A", "err");
    const r = h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000 });
    ok(r.renewed === false && r.reason === "TERMINAL", "E3 RECOVERY_REQUIRED rejected");
  }

  console.log("\n153-E4 renewal preserves operation identity and owner");
  {
    const h = makeHarness();
    const opId = createOp(h, "e4");
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "A", durationMs: 60000 });
    const before = getOp(h, opId);
    h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000 });
    const after = getOp(h, opId);
    ok(before.operation_id === after.operation_id, "E4 op id preserved");
    ok(before.job_id === after.job_id, "E4 job id preserved");
    ok(before.operation_type === after.operation_type, "E4 type preserved");
    ok(before.claim_owner === after.claim_owner, "E4 owner preserved");
    ok(before.state === after.state, "E4 state preserved");
  }

  console.log("\n153-E5 repeated renewal remains safe");
  {
    const h = makeHarness();
    const opId = createOp(h, "e5");
    const t0 = 1_000_000_000_000;
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "A", durationMs: 60000, now: t0 });
    for (let i = 0; i < 20; i++) {
      const r = h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: t0 + 1000 * (i + 1) });
      ok(r.renewed === true, "E5 renewal " + (i + 1) + " ok");
    }
    ok(getOp(h, opId).attempt_count === 1, "E5 attempt_count still 1");
  }

  // ==================================================================
  // Group F - Concurrent renewal / takeover
  // ==================================================================

  console.log("\n153-F1 renewal vs takeover — one owner, no double ownership");
  {
    const h = makeHarness();
    const opId = createOp(h, "f1");
    const t0 = 1_000_000_000_000;
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "A", durationMs: 60000, now: t0 });
    // A renews at t0+30000 (still live).
    const rA = h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: t0 + 30000 });
    // B tries to take over at t0+30000 — A's claim is now extended, so B must fail.
    const rB = h.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000, now: t0 + 30000 });
    ok(rA.renewed === true, "F1 A renewed");
    ok(rB.claimed === false, "F1 B blocked while A live");
    ok(getOp(h, opId).claim_owner === "A", "F1 owner is A");
  }

  console.log("\n153-F2 renewal does not create recovery events");
  {
    const h = makeHarness();
    const opId = createOp(h, "f2");
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "A", durationMs: 60000 });
    const before = countEvents(h, "f2");
    for (let i = 0; i < 10; i++) {
      h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000 });
    }
    ok(countEvents(h, "f2") === before, "F2 no new events");
  }

  console.log("\n153-F3 renewal does not create another operation");
  {
    const h = makeHarness();
    const opId = createOp(h, "f3");
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "A", durationMs: 60000 });
    const before = countOps(h, "f3");
    h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000 });
    ok(countOps(h, "f3") === before, "F3 op count unchanged");
  }

  console.log("\n153-F4 renewal does not consume retry budget");
  {
    const h = makeHarness();
    const opId = createOp(h, "f4");
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "A", durationMs: 60000 });
    const before = getOp(h, opId).attempt_count;
    for (let i = 0; i < 5; i++) {
      h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000 });
    }
    ok(getOp(h, opId).attempt_count === before, "F4 budget unchanged");
  }

  console.log("\n153-F5 complete end-to-end long-running recovery");
  {
    const h = makeHarness();
    const opId = createOp(h, "f5");
    const t0 = 1_000_000_000_000;
    // A claims, enters IN_PROGRESS, does long-running work simulated by renewals.
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "A", durationMs: 60000, now: t0 });
    h.store.recoveryOps.markInProgress(opId, "A", t0);
    for (let i = 1; i <= 10; i++) {
      const r = h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: t0 + 30000 * i });
      ok(r.renewed === true, "F5 renewal " + i);
    }
    // A completes normally.
    ok(h.store.recoveryOps.markCompleted(opId, "A", t0 + 330000) === true, "F5 A completes");
    ok(getOp(h, opId).state === "COMPLETED", "F5 COMPLETED");
    ok(getOp(h, opId).attempt_count === 1, "F5 attempt_count=1");
    ok(getOp(h, opId).claim_owner === null, "F5 claim cleared");
  }

  console.log("\n--- Phase 153: " + passed + " passed, " + failed + " failed ---");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error("PHASE153 DRIVER CRASH:", err); process.exit(1); });
