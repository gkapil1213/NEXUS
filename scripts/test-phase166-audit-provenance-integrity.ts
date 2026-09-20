// scripts/test-phase166-audit-provenance-integrity.ts
// Phase 166 — durable execution audit trail & provenance query integrity.
//
// Every assertion reads durable state via the ExecutionStore. Provenance
// is created only through the real write path
// (completeAttemptAndTransitionJob). Tamper fixtures are created by real
// terminalize followed by direct UPDATE on an isolated test DB — this is
// intentional per Phase 166 section 9 and never happens in production code.

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
function section(t: string): void { console.log("\n" + t); }

interface H { db: Database.Database; store: ExecutionStore; file?: string; dir?: string; }

function makeHarness(file?: string): H {
  const raw = file ? new Database(file) : new Database(":memory:");
  new MigrationRunner(raw, join(process.cwd(), "src", "db", "migrations")).run();
  const store = new ExecutionStore(SQLiteEngine.fromDatabase(raw) as any);
  return { db: raw, store, file };
}
function makeFileHarness(): H {
  const dir = mkdtempSync(join(tmpdir(), "p166-"));
  const h = makeHarness(join(dir, "audit.db"));
  h.dir = dir;
  return h;
}
function reopen(h: H): H {
  h.db.close();
  const raw = new Database(h.file!);
  return { db: raw, store: new ExecutionStore(SQLiteEngine.fromDatabase(raw) as any), file: h.file, dir: h.dir };
}
function cleanup(h: H): void {
  try { h.db.close(); } catch {}
  if (h.dir) try { rmSync(h.dir, { recursive: true, force: true }); } catch {}
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
function seedLease(db: Database.Database, jobId: string, workerId: string, leaseId: string,
                   status = "ACTIVE", expiresAt = Date.now() + 60000): void {
  db.prepare(
    "INSERT INTO execution_leases (lease_id, job_id, worker_id, acquired_at, expires_at, status) VALUES (?,?,?,?,?,?)"
  ).run(leaseId, jobId, workerId, Date.now() - 120000, expiresAt, status);
}
function setJobRunning(db: Database.Database, jobId: string, leaseId: string | null): void {
  db.prepare("UPDATE execution_jobs SET status='RUNNING', current_lease_id=? WHERE id=?").run(leaseId, jobId);
}
function setupRunning(h: H, jobId: string, workerId = "wA", leaseId = "L-" + jobId) {
  h.store.createJob(queuedJob(jobId));
  setJobRunning(h.db, jobId, leaseId);
  seedLease(h.db, jobId, workerId, leaseId);
  const c = h.store.createAttemptAsOwnerAtomic(jobId, leaseId, workerId, "RUNNING");
  if (!c.created) throw new Error("alloc " + jobId);
  return { attemptId: c.attempt.id, leaseId, workerId };
}
function terminalize(
  h: H, s: { attemptId: string; leaseId: string; workerId: string },
  jobId: string, status: string, newJobStatus: string, extra: any = {}
) {
  return h.store.completeAttemptAndTransitionJob({
    attemptId: s.attemptId, jobId, leaseId: s.leaseId, workerId: s.workerId,
    attemptStatus: status, expectedJobStatus: "RUNNING", newJobStatus,
    ...extra,
  });
}
function rawProv(h: H, attemptId: string): any {
  return h.db.prepare("SELECT * FROM execution_outcome_provenance WHERE attempt_id = ?").get(attemptId);
}
function countProv(h: H, jobId: string): number {
  return (h.db.prepare("SELECT COUNT(*) AS n FROM execution_outcome_provenance WHERE job_id = ?").get(jobId) as any).n;
}
function countEvents(h: H, jobId: string, type?: string): number {
  const sql = type
    ? "SELECT COUNT(*) AS n FROM execution_events WHERE job_id = ? AND event_type = ?"
    : "SELECT COUNT(*) AS n FROM execution_events WHERE job_id = ?";
  return type
    ? (h.db.prepare(sql).get(jobId, type) as any).n
    : (h.db.prepare(sql).get(jobId) as any).n;
}
function setupRetry(h: H, jobId: string, workerId = "wA") {
  const s1 = setupRunning(h, jobId, workerId, "L1-" + jobId);
  terminalize(h, s1, jobId, "FAILED", "RETRY_SCHEDULED", { attemptError: "first" });
  h.db.prepare("UPDATE execution_leases SET status='RELEASED' WHERE lease_id = ?").run(s1.leaseId);
  const lease2 = "L2-" + jobId;
  setJobRunning(h.db, jobId, lease2);
  seedLease(h.db, jobId, workerId, lease2);
  const c2 = h.store.createAttemptAsOwnerAtomic(jobId, lease2, workerId, "RUNNING");
  if (!c2.created) throw new Error("retry alloc " + jobId);
  const s2 = { attemptId: c2.attempt.id, leaseId: lease2, workerId };
  terminalize(h, s2, jobId, "SUCCEEDED", "SUCCEEDED");
  return { attempt1Id: s1.attemptId, attempt2Id: s2.attemptId };
}

async function main() {
  console.log("=== Phase 166 — Durable Execution Audit Trail & Provenance Query Integrity ===\n");

  section("Group A — Query correctness");

  console.log("166-A1 queryProvenanceByJob returns job history");
  {
    const h = makeHarness();
    const s = setupRunning(h, "a1");
    terminalize(h, s, "a1", "SUCCEEDED", "SUCCEEDED");
    const res = h.store.queryProvenanceByJob("a1");
    ok(res.kind === "ok", "A1 kind=ok");
    if (res.kind === "ok") {
      ok(res.records.length === 1, "A1 one record");
      ok(res.records[0].jobId === "a1", "A1 jobId");
      ok(res.records[0].outcome === "SUCCEEDED", "A1 outcome");
    }
  }

  console.log("\n166-A2 queryProvenanceByAttempt returns exact record");
  {
    const h = makeHarness();
    const s = setupRunning(h, "a2");
    terminalize(h, s, "a2", "FAILED", "FAILED", { attemptError: "boom" });
    const res = h.store.queryProvenanceByAttempt(s.attemptId);
    ok(res.kind === "ok", "A2 kind=ok");
    if (res.kind === "ok") {
      ok(res.record.attemptId === s.attemptId, "A2 attemptId");
      ok(res.record.outcome === "FAILED", "A2 outcome");
      ok(res.record.reason === "boom", "A2 reason");
    }
  }

  console.log("\n166-A3 queryProvenanceById returns exactly one");
  {
    const h = makeHarness();
    const s = setupRunning(h, "a3");
    terminalize(h, s, "a3", "SUCCEEDED", "SUCCEEDED");
    const row = rawProv(h, s.attemptId);
    const res = h.store.queryProvenanceById(row.provenance_id);
    ok(res.kind === "ok", "A3 kind=ok");
    if (res.kind === "ok") {
      ok(res.record.provenanceId === row.provenance_id, "A3 provenanceId");
      ok(res.record.attemptId === s.attemptId, "A3 attemptId");
    }
  }

  console.log("\n166-A4 queryProvenanceByRecoveryOperation");
  {
    const h = makeHarness();
    const s = setupRunning(h, "a4");
    terminalize(h, s, "a4", "FAILED", "FAILED", { attemptError: "t/o", recoveryOperationId: "rop-a4" });
    const res = h.store.queryProvenanceByRecoveryOperation("rop-a4");
    ok(res.kind === "ok", "A4 kind=ok");
    if (res.kind === "ok") {
      ok(res.record.recoveryOperationId === "rop-a4", "A4 recoveryId");
      ok(res.record.jobId === "a4", "A4 jobId");
    }
  }

  console.log("\n166-A5 deterministic ordering for multiple records");
  {
    const h = makeHarness();
    const ids = setupRetry(h, "a5");
    const res = h.store.queryProvenanceByJob("a5");
    ok(res.kind === "ok", "A5 kind=ok");
    if (res.kind === "ok") {
      ok(res.records.length === 2, "A5 two records");
      ok(res.records[0].attemptId === ids.attempt1Id, "A5 first=attempt1");
      ok(res.records[1].attemptId === ids.attempt2Id, "A5 second=attempt2");
    }
  }

  section("Group B — Identity integrity");

  console.log("166-B1 job identity");
  {
    const h = makeHarness();
    const s = setupRunning(h, "b1");
    terminalize(h, s, "b1", "SUCCEEDED", "SUCCEEDED");
    const res = h.store.queryProvenanceByAttempt(s.attemptId);
    if (res.kind === "ok") ok(res.record.jobId === "b1", "B1 jobId matches");
    else ok(false, "B1 kind=ok expected");
  }

  console.log("\n166-B2 attempt identity");
  {
    const h = makeHarness();
    const s = setupRunning(h, "b2");
    terminalize(h, s, "b2", "SUCCEEDED", "SUCCEEDED");
    const res = h.store.queryProvenanceByAttempt(s.attemptId);
    if (res.kind === "ok") ok(res.record.attemptId === s.attemptId, "B2 attemptId matches");
    else ok(false, "B2 kind=ok expected");
  }

  console.log("\n166-B3 attempt number");
  {
    const h = makeHarness();
    const s = setupRunning(h, "b3");
    terminalize(h, s, "b3", "SUCCEEDED", "SUCCEEDED");
    const res = h.store.queryProvenanceByAttempt(s.attemptId);
    if (res.kind === "ok") ok(res.record.attemptNumber === 1, "B3 first attempt is #1");
    else ok(false, "B3 kind=ok expected");
  }

  console.log("\n166-B4 provenance identity stable");
  {
    const h = makeHarness();
    const s = setupRunning(h, "b4");
    terminalize(h, s, "b4", "SUCCEEDED", "SUCCEEDED");
    const row = rawProv(h, s.attemptId);
    const r1 = h.store.queryProvenanceByAttempt(s.attemptId);
    const r2 = h.store.queryProvenanceByAttempt(s.attemptId);
    ok(r1.kind === "ok" && r2.kind === "ok", "B4 two queries succeed");
    if (r1.kind === "ok" && r2.kind === "ok") {
      ok(r1.record.provenanceId === r2.record.provenanceId, "B4 same provenanceId");
      ok(r1.record.provenanceId === row.provenance_id, "B4 matches raw row");
    }
  }

  console.log("\n166-B5 recovery identity stored exactly when supplied");
  {
    const h = makeHarness();
    const s = setupRunning(h, "b5");
    terminalize(h, s, "b5", "FAILED", "FAILED", { recoveryOperationId: "rop-b5" });
    const row = rawProv(h, s.attemptId);
    ok(row.recovery_operation_id === "rop-b5", "B5 recovery op stored");
    const res = h.store.queryProvenanceByAttempt(s.attemptId);
    if (res.kind === "ok") ok(res.record.recoveryOperationId === "rop-b5", "B5 mapped correctly");
  }

  section("Group C — Retry lineage");

  console.log("166-C1 predecessor relationship preserved");
  {
    const h = makeHarness();
    const ids = setupRetry(h, "c1");
    const p2 = rawProv(h, ids.attempt2Id);
    ok(p2.predecessor_attempt_id === ids.attempt1Id, "C1 predecessor=attempt1");
  }

  console.log("\n166-C2 multiple retries");
  {
    const h = makeHarness();
    const s1 = setupRunning(h, "c2", "wA", "L1-c2");
    terminalize(h, s1, "c2", "FAILED", "RETRY_SCHEDULED", { attemptError: "e1" });
    h.db.prepare("UPDATE execution_leases SET status='RELEASED' WHERE lease_id = ?").run(s1.leaseId);
    const l2 = "L2-c2";
    setJobRunning(h.db, "c2", l2); seedLease(h.db, "c2", "wA", l2);
    const c2 = h.store.createAttemptAsOwnerAtomic("c2", l2, "wA", "RUNNING");
    if (c2.created !== true) throw new Error("c2 alloc");
    terminalize(h, { attemptId: c2.attempt.id, leaseId: l2, workerId: "wA" }, "c2", "FAILED", "RETRY_SCHEDULED", { attemptError: "e2" });
    h.db.prepare("UPDATE execution_leases SET status='RELEASED' WHERE lease_id = ?").run(l2);
    const l3 = "L3-c2";
    setJobRunning(h.db, "c2", l3); seedLease(h.db, "c2", "wA", l3);
    const c3 = h.store.createAttemptAsOwnerAtomic("c2", l3, "wA", "RUNNING");
    if (c3.created !== true) throw new Error("c3 alloc");
    terminalize(h, { attemptId: c3.attempt.id, leaseId: l3, workerId: "wA" }, "c2", "SUCCEEDED", "SUCCEEDED");
    const res = h.store.queryRetryLineage("c2");
    ok(res.kind === "ok", "C2 kind=ok");
    if (res.kind === "ok") {
      ok(res.steps.length === 3, "C2 three steps");
      ok(res.steps[0].predecessorAttemptId === null, "C2 step1 pred=null");
      ok(res.steps[1].predecessorAttemptId === s1.attemptId, "C2 step2 pred=attempt1");
      ok(res.steps[2].predecessorAttemptId === c2.attempt.id, "C2 step3 pred=attempt2");
    }
  }

  console.log("\n166-C3 lineage ordering by attempt_number ascending");
  {
    const h = makeHarness();
    setupRetry(h, "c3");
    const res = h.store.queryRetryLineage("c3");
    if (res.kind === "ok") {
      const nums = res.steps.map((s) => s.provenance.attemptNumber);
      ok(nums[0] < nums[1], "C3 ascending attemptNumber");
    } else ok(false, "C3 kind=ok expected");
  }

  console.log("\n166-C4 duplicate retry query is idempotent");
  {
    const h = makeHarness();
    setupRetry(h, "c4");
    const r1 = h.store.queryRetryLineage("c4");
    const r2 = h.store.queryRetryLineage("c4");
    if (r1.kind === "ok" && r2.kind === "ok") {
      ok(r1.steps.length === r2.steps.length, "C4 same length");
      ok(r1.steps[0].provenance.provenanceId === r2.steps[0].provenance.provenanceId, "C4 same first id");
    } else ok(false, "C4 both should be ok");
  }

  console.log("\n166-C5 lineage survives reopen");
  {
    const h = makeFileHarness();
    const ids = setupRetry(h, "c5");
    const h2 = reopen(h);
    const res = h2.store.queryRetryLineage("c5");
    ok(res.kind === "ok", "C5 kind=ok after reopen");
    if (res.kind === "ok") {
      ok(res.steps.length === 2, "C5 two steps");
      ok(res.steps[1].predecessorAttemptId === ids.attempt1Id, "C5 predecessor preserved");
    }
    cleanup(h2);
  }

  section("Group D — Recovery lineage");

  console.log("166-D1 provenance retrievable by recovery operation id");
  {
    const h = makeHarness();
    const s = setupRunning(h, "d1");
    terminalize(h, s, "d1", "FAILED", "FAILED", { recoveryOperationId: "rop-d1" });
    const res = h.store.queryProvenanceByRecoveryOperation("rop-d1");
    ok(res.kind === "ok", "D1 kind=ok");
    if (res.kind === "ok") ok(res.record.jobId === "d1", "D1 jobId matches");
  }

  console.log("\n166-D2 duplicate recovery query deterministic");
  {
    const h = makeHarness();
    const s = setupRunning(h, "d2");
    terminalize(h, s, "d2", "FAILED", "FAILED", { recoveryOperationId: "rop-d2" });
    const a = h.store.queryProvenanceByRecoveryOperation("rop-d2");
    const b = h.store.queryProvenanceByRecoveryOperation("rop-d2");
    if (a.kind === "ok" && b.kind === "ok") ok(a.record.provenanceId === b.record.provenanceId, "D2 same provenanceId");
    else ok(false, "D2 both ok expected");
  }

  console.log("\n166-D3 recovery lineage survives reopen");
  {
    const h = makeFileHarness();
    const s = setupRunning(h, "d3");
    terminalize(h, s, "d3", "FAILED", "FAILED", { recoveryOperationId: "rop-d3" });
    const h2 = reopen(h);
    const res = h2.store.queryProvenanceByRecoveryOperation("rop-d3");
    ok(res.kind === "ok", "D3 kind=ok after reopen");
    if (res.kind === "ok") ok(res.record.jobId === "d3", "D3 jobId after reopen");
    cleanup(h2);
  }

  console.log("\n166-D4 terminal-before-recovery returns not_found");
  {
    const h = makeHarness();
    const s = setupRunning(h, "d4");
    terminalize(h, s, "d4", "SUCCEEDED", "SUCCEEDED");
    const res = h.store.queryProvenanceByRecoveryOperation("rop-never-existed");
    ok(res.kind === "not_found", "D4 not_found for unknown recovery op");
  }

  section("Group E — Evidence verification");

  console.log("166-E1 valid hash verified");
  {
    const h = makeHarness();
    const s = setupRunning(h, "e1");
    terminalize(h, s, "e1", "SUCCEEDED", "SUCCEEDED");
    const res = h.store.verifyProvenanceByAttempt(s.attemptId);
    ok(res.kind === "verified", "E1 hash verified");
  }

  console.log("\n166-E2 tampered evidence rejected");
  {
    const h = makeHarness();
    const s = setupRunning(h, "e2");
    terminalize(h, s, "e2", "SUCCEEDED", "SUCCEEDED");
    h.db.prepare("UPDATE execution_outcome_provenance SET evidence_json = ? WHERE attempt_id = ?")
      .run(JSON.stringify(["tampered"]), s.attemptId);
    const res = h.store.verifyProvenanceByAttempt(s.attemptId);
    ok(res.kind === "hash_mismatch", "E2 evidence tamper caught by hash");
  }

  console.log("\n166-E3 tampered hash rejected");
  {
    const h = makeHarness();
    const s = setupRunning(h, "e3");
    terminalize(h, s, "e3", "SUCCEEDED", "SUCCEEDED");
    h.db.prepare("UPDATE execution_outcome_provenance SET evidence_hash = ? WHERE attempt_id = ?")
      .run("0".repeat(64), s.attemptId);
    const res = h.store.verifyProvenanceByAttempt(s.attemptId);
    ok(res.kind === "hash_mismatch", "E3 hash tamper caught");
  }

  console.log("\n166-E4 tampered metadata (outcome) rejected");
  {
    const h = makeHarness();
    const s = setupRunning(h, "e4");
    terminalize(h, s, "e4", "SUCCEEDED", "SUCCEEDED");
    h.db.prepare("UPDATE execution_outcome_provenance SET outcome = ? WHERE attempt_id = ?")
      .run("FAILED", s.attemptId);
    const res = h.store.verifyProvenanceByAttempt(s.attemptId);
    ok(res.kind === "hash_mismatch", "E4 outcome tamper caught");
  }

  console.log("\n166-E5 verification survives reopen");
  {
    const h = makeFileHarness();
    const s = setupRunning(h, "e5");
    terminalize(h, s, "e5", "SUCCEEDED", "SUCCEEDED");
    const h2 = reopen(h);
    const res = h2.store.verifyProvenanceByAttempt(s.attemptId);
    ok(res.kind === "verified", "E5 verified after reopen");
    cleanup(h2);
  }

  section("Group F — Event correlation");

  console.log("166-F1 rejected mutation has no event for job");
  {
    const h = makeHarness();
    const s = setupRunning(h, "f1");
    h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "f1", leaseId: "WRONG", workerId: s.workerId,
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    });
    ok(countEvents(h, "f1") === 0, "F1 no events for rejected");
    ok(countProv(h, "f1") === 0, "F1 no provenance for rejected");
  }

  console.log("\n166-F2 replay has no duplicate event");
  {
    const h = makeHarness();
    const s = setupRunning(h, "f2");
    terminalize(h, s, "f2", "SUCCEEDED", "SUCCEEDED");
    const before = countEvents(h, "f2");
    terminalize(h, s, "f2", "SUCCEEDED", "SUCCEEDED");
    ok(countEvents(h, "f2") === before, "F2 event count unchanged on replay");
  }

  console.log("\n166-F3 event isolation — no cross-job events");
  {
    const h = makeHarness();
    const sA = setupRunning(h, "f3a");
    setupRunning(h, "f3b");
    terminalize(h, sA, "f3a", "SUCCEEDED", "SUCCEEDED");
    const aEvents = h.db.prepare("SELECT job_id FROM execution_events WHERE job_id = ?").all("f3a") as any[];
    for (const e of aEvents) ok(e.job_id === "f3a", "F3 event belongs to f3a");
    const bEvents = h.db.prepare("SELECT job_id FROM execution_events WHERE job_id = ?").all("f3b") as any[];
    ok(bEvents.length === 0, "F3 no events for untriggered f3b");
  }

  console.log("\n166-F4 provenance job_id equals queried job");
  {
    const h = makeHarness();
    const s = setupRunning(h, "f4");
    terminalize(h, s, "f4", "SUCCEEDED", "SUCCEEDED");
    const row = rawProv(h, s.attemptId);
    ok(row.job_id === "f4", "F4 provenance job_id");
    const evs = h.db.prepare("SELECT job_id FROM execution_events WHERE job_id = ?").all(row.job_id) as any[];
    for (const e of evs) ok(e.job_id === row.job_id, "F4 event job matches provenance job");
  }

  section("Group G — Cross-boundary isolation");

  console.log("166-G1 cross-job queryProvenanceByAttempt isolation");
  {
    const h = makeHarness();
    const sA = setupRunning(h, "g1a");
    const sB = setupRunning(h, "g1b");
    terminalize(h, sA, "g1a", "SUCCEEDED", "SUCCEEDED");
    terminalize(h, sB, "g1b", "FAILED", "FAILED");
    const rA = h.store.queryProvenanceByAttempt(sA.attemptId);
    const rB = h.store.queryProvenanceByAttempt(sB.attemptId);
    if (rA.kind === "ok") ok(rA.record.jobId === "g1a", "G1a returns g1a");
    else ok(false, "G1a kind=ok expected");
    if (rB.kind === "ok") ok(rB.record.jobId === "g1b", "G1b returns g1b");
    else ok(false, "G1b kind=ok expected");
  }

  console.log("\n166-G2 cross-attempt isolation");
  {
    const h = makeHarness();
    const ids = setupRetry(h, "g2");
    const r1 = h.store.queryProvenanceByAttempt(ids.attempt1Id);
    const r2 = h.store.queryProvenanceByAttempt(ids.attempt2Id);
    if (r1.kind === "ok" && r2.kind === "ok") {
      ok(r1.record.attemptId !== r2.record.attemptId, "G2 different attempts");
      ok(r1.record.provenanceId !== r2.record.provenanceId, "G2 different provenanceIds");
    } else ok(false, "G2 both ok expected");
  }

  console.log("\n166-G3 cross-recovery isolation");
  {
    const h = makeHarness();
    const s1 = setupRunning(h, "g3a");
    const s2 = setupRunning(h, "g3b");
    terminalize(h, s1, "g3a", "FAILED", "FAILED", { recoveryOperationId: "rop-g3a" });
    terminalize(h, s2, "g3b", "FAILED", "FAILED", { recoveryOperationId: "rop-g3b" });
    const r = h.store.queryProvenanceByRecoveryOperation("rop-g3a");
    if (r.kind === "ok") ok(r.record.jobId === "g3a", "G3a returns g3a");
    const miss = h.store.queryProvenanceByRecoveryOperation("rop-none");
    ok(miss.kind === "not_found", "G3 missing op not_found");
  }

  console.log("\n166-G4 cross-execution queryProvenanceByJob isolation");
  {
    const h = makeHarness();
    const sA = setupRunning(h, "g4a");
    const sB = setupRunning(h, "g4b");
    terminalize(h, sA, "g4a", "SUCCEEDED", "SUCCEEDED");
    terminalize(h, sB, "g4b", "SUCCEEDED", "SUCCEEDED");
    const rA = h.store.queryProvenanceByJob("g4a");
    if (rA.kind === "ok") {
      ok(rA.records.length === 1, "G4a one record");
      ok(rA.records[0].jobId === "g4a", "G4a job");
    }
    const rB = h.store.queryProvenanceByJob("g4b");
    if (rB.kind === "ok") ok(rB.records[0].jobId === "g4b", "G4b job");
  }

  section("Group H — Concurrency & replay");

  console.log("166-H1 stale lease cannot terminalize");
  {
    const h = makeHarness();
    const s = setupRunning(h, "h1");
    terminalize(h, { ...s, leaseId: "WRONG-LEASE" }, "h1", "SUCCEEDED", "SUCCEEDED");
    ok(countProv(h, "h1") === 0, "H1 stale lease no provenance");
  }

  console.log("\n166-H2 wrong worker cannot terminalize");
  {
    const h = makeHarness();
    const s = setupRunning(h, "h2");
    terminalize(h, { ...s, workerId: "w-other" }, "h2", "SUCCEEDED", "SUCCEEDED");
    ok(countProv(h, "h2") === 0, "H2 wrong worker no provenance");
  }

  console.log("\n166-H3 wrong expectedJobStatus rejected");
  {
    const h = makeHarness();
    const s = setupRunning(h, "h3");
    h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "h3", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "SUCCEEDED", expectedJobStatus: "QUEUED", newJobStatus: "SUCCEEDED",
    });
    ok(countProv(h, "h3") === 0, "H3 wrong expected status no provenance");
  }

  console.log("\n166-H4 duplicate terminalize replay has no duplicate provenance");
  {
    const h = makeHarness();
    const s = setupRunning(h, "h4");
    terminalize(h, s, "h4", "SUCCEEDED", "SUCCEEDED");
    ok(countProv(h, "h4") === 1, "H4 after first");
    terminalize(h, s, "h4", "SUCCEEDED", "SUCCEEDED");
    ok(countProv(h, "h4") === 1, "H4 after replay");
  }

  console.log("\n166-H5 duplicate query identical + no mutation");
  {
    const h = makeHarness();
    const s = setupRunning(h, "h5");
    terminalize(h, s, "h5", "SUCCEEDED", "SUCCEEDED");
    const before = countProv(h, "h5");
    const a = h.store.queryProvenanceByAttempt(s.attemptId);
    const b = h.store.queryProvenanceByAttempt(s.attemptId);
    const after = countProv(h, "h5");
    ok(before === after, "H5 no mutation from query");
    if (a.kind === "ok" && b.kind === "ok") ok(a.record.evidenceHash === b.record.evidenceHash, "H5 hash identical");
  }

  section("Group I — Durability");

  console.log("166-I1 query survives DB reopen");
  {
    const h = makeFileHarness();
    const s = setupRunning(h, "i1");
    terminalize(h, s, "i1", "SUCCEEDED", "SUCCEEDED");
    const h2 = reopen(h);
    const res = h2.store.queryProvenanceByAttempt(s.attemptId);
    ok(res.kind === "ok", "I1 kind=ok after reopen");
    if (res.kind === "ok") ok(res.record.jobId === "i1", "I1 jobId");
    cleanup(h2);
  }

  console.log("\n166-I2 process restart simulation — job query survives");
  {
    const h = makeFileHarness();
    const s = setupRunning(h, "i2");
    terminalize(h, s, "i2", "FAILED", "FAILED");
    const h2 = reopen(h);
    const res = h2.store.queryProvenanceByJob("i2");
    ok(res.kind === "ok", "I2 kind=ok");
    if (res.kind === "ok") ok(res.records.length === 1, "I2 one record");
    cleanup(h2);
  }

  console.log("\n166-I3 historical evidence preserved after reopen");
  {
    const h = makeFileHarness();
    const s = setupRunning(h, "i3");
    terminalize(h, s, "i3", "SUCCEEDED", "SUCCEEDED");
    const h2 = reopen(h);
    const res = h2.store.verifyProvenanceByAttempt(s.attemptId);
    ok(res.kind === "verified", "I3 still verified");
    cleanup(h2);
  }

  console.log("\n166-I4 historical lineage preserved after reopen");
  {
    const h = makeFileHarness();
    const ids = setupRetry(h, "i4");
    const h2 = reopen(h);
    const res = h2.store.queryRetryLineage("i4");
    ok(res.kind === "ok", "I4 kind=ok");
    if (res.kind === "ok") {
      ok(res.steps.length === 2, "I4 two steps");
      ok(res.steps[1].provenance.attemptId === ids.attempt2Id, "I4 second attempt preserved");
    }
    cleanup(h2);
  }

  console.log("\n166-I5 historical query is stable across multiple reopens");
  {
    const h = makeFileHarness();
    const s = setupRunning(h, "i5");
    terminalize(h, s, "i5", "SUCCEEDED", "SUCCEEDED");
    // Open, close, reopen, close, reopen. Query only the LAST live handle
    // (reopen closes the previous connection - do not query a closed one).
    const h2 = reopen(h);
    const h3 = reopen(h2);
    const r1 = h3.store.queryProvenanceByAttempt(s.attemptId);
    const r2 = h3.store.queryProvenanceByAttempt(s.attemptId);
    ok(r1.kind === "ok" && r2.kind === "ok", "I5 both ok");
    if (r1.kind === "ok" && r2.kind === "ok") ok(r1.record.evidenceHash === r2.record.evidenceHash, "I5 hash stable");
    cleanup(h3);
  }

  section("Group J — Corruption detection");

  console.log("166-J1 evidence tamper detected");
  {
    const h = makeHarness();
    const s = setupRunning(h, "j1");
    terminalize(h, s, "j1", "SUCCEEDED", "SUCCEEDED");
    h.db.prepare("UPDATE execution_outcome_provenance SET evidence_json = ? WHERE attempt_id = ?")
      .run(JSON.stringify(["evil"]), s.attemptId);
    const res = h.store.verifyProvenanceByAttempt(s.attemptId);
    ok(res.kind === "hash_mismatch", "J1 evidence tamper detected");
  }

  console.log("\n166-J2 hash tamper detected");
  {
    const h = makeHarness();
    const s = setupRunning(h, "j2");
    terminalize(h, s, "j2", "SUCCEEDED", "SUCCEEDED");
    h.db.prepare("UPDATE execution_outcome_provenance SET evidence_hash = ? WHERE attempt_id = ?")
      .run("a".repeat(64), s.attemptId);
    const res = h.store.verifyProvenanceByAttempt(s.attemptId);
    ok(res.kind === "hash_mismatch", "J2 hash tamper detected");
  }

  console.log("\n166-J3 outcome tamper detected");
  {
    const h = makeHarness();
    const s = setupRunning(h, "j3");
    terminalize(h, s, "j3", "SUCCEEDED", "SUCCEEDED");
    h.db.prepare("UPDATE execution_outcome_provenance SET outcome = ? WHERE attempt_id = ?")
      .run("FAILED", s.attemptId);
    const res = h.store.verifyProvenanceByAttempt(s.attemptId);
    ok(res.kind === "hash_mismatch", "J3 outcome tamper detected");
  }

  console.log("\n166-J4 attempt identity tamper detected via cross-record check");
  {
    const h = makeHarness();
    const s = setupRunning(h, "j4");
    terminalize(h, s, "j4", "SUCCEEDED", "SUCCEEDED");
    const row = rawProv(h, s.attemptId);
    h.db.prepare("UPDATE execution_outcome_provenance SET attempt_id = ? WHERE provenance_id = ?")
      .run("other-attempt", row.provenance_id);
    const res = h.store.queryProvenanceById(row.provenance_id);
    ok(res.kind === "integrity_failure", "J4 identity tamper via integrity_failure");
    if (res.kind === "integrity_failure") ok(res.failure.kind === "source_attempt_missing", "J4 kind source_attempt_missing");
  }

  console.log("\n166-J5 job identity tamper detected");
  {
    const h = makeHarness();
    const s = setupRunning(h, "j5");
    terminalize(h, s, "j5", "SUCCEEDED", "SUCCEEDED");
    const row = rawProv(h, s.attemptId);
    h.db.prepare("UPDATE execution_outcome_provenance SET job_id = ? WHERE provenance_id = ?")
      .run("other-job", row.provenance_id);
    const res = h.store.queryProvenanceById(row.provenance_id);
    ok(res.kind === "integrity_failure", "J5 job tamper detected");
    if (res.kind === "integrity_failure") ok(res.failure.kind === "source_attempt_job_mismatch", "J5 kind job_mismatch");
  }

  console.log("\n166-J6 recovery identity tamper discoverable but not repudiated");
  {
    const h = makeHarness();
    const s = setupRunning(h, "j6");
    terminalize(h, s, "j6", "FAILED", "FAILED", { recoveryOperationId: "rop-j6" });
    const row = rawProv(h, s.attemptId);
    h.db.prepare("UPDATE execution_outcome_provenance SET recovery_operation_id = ? WHERE provenance_id = ?")
      .run("rop-other", row.provenance_id);
    const miss = h.store.queryProvenanceByRecoveryOperation("rop-j6");
    ok(miss.kind === "not_found", "J6 original op no longer matches");
    const hit = h.store.queryProvenanceByRecoveryOperation("rop-other");
    ok(hit.kind === "ok", "J6 tampered op is discoverable");
    if (hit.kind === "ok") ok(hit.record.jobId === "j6", "J6 job_id still j6");
  }

  section("Group K — Transaction integrity");

  console.log("166-K1 rollback leaves no partial provenance");
  {
    const h = makeHarness();
    const s = setupRunning(h, "k1");
    h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "k1", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "SUCCEEDED", expectedJobStatus: "QUEUED", newJobStatus: "SUCCEEDED",
    });
    ok(countProv(h, "k1") === 0, "K1 no provenance");
    const attempt = h.db.prepare("SELECT status FROM execution_attempts WHERE id = ?").get(s.attemptId) as any;
    ok(attempt.status === "RUNNING", "K1 attempt still RUNNING");
    const job = h.db.prepare("SELECT status FROM execution_jobs WHERE id = ?").get("k1") as any;
    ok(job.status === "RUNNING", "K1 job still RUNNING");
  }

  console.log("\n166-K2 commit durability — all required records present");
  {
    const h = makeHarness();
    const s = setupRunning(h, "k2");
    terminalize(h, s, "k2", "SUCCEEDED", "SUCCEEDED");
    const prov = rawProv(h, s.attemptId);
    const attempt = h.db.prepare("SELECT status FROM execution_attempts WHERE id = ?").get(s.attemptId) as any;
    const job = h.db.prepare("SELECT status FROM execution_jobs WHERE id = ?").get("k2") as any;
    ok(!!prov, "K2 provenance committed");
    ok(attempt.status === "SUCCEEDED", "K2 attempt terminal");
    ok(job.status === "SUCCEEDED", "K2 job terminal");
  }

  console.log("\n166-K3 no partial audit state after reopen");
  {
    const h = makeFileHarness();
    const s = setupRunning(h, "k3");
    terminalize(h, s, "k3", "SUCCEEDED", "SUCCEEDED");
    const h2 = reopen(h);
    const res = h2.store.queryProvenanceByAttempt(s.attemptId);
    ok(res.kind === "ok", "K3 kind=ok");
    cleanup(h2);
  }

  section("Group L — Security");

  console.log("166-L1 SQL metacharacters in id are safe");
  {
    const h = makeHarness();
    const res = h.store.queryProvenanceByAttempt("x'; DROP TABLE execution_outcome_provenance; --");
    ok(res.kind === "not_found", "L1 not_found");
    const tableCheck = h.db.prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='execution_outcome_provenance'"
    ).get() as any;
    ok(tableCheck.n === 1, "L1 table not dropped");
  }

  console.log("\n166-L2 cross-job isolation via API");
  {
    const h = makeHarness();
    const sA = setupRunning(h, "l2a");
    terminalize(h, sA, "l2a", "SUCCEEDED", "SUCCEEDED");
    const res = h.store.queryProvenanceByJob("l2b-never-existed");
    ok(res.kind === "ok" && res.records.length === 0, "L2 no cross-job records");
  }

  console.log("\n166-L3 no arbitrary SQL via query API");
  {
    const h = makeHarness();
    const s = setupRunning(h, "l3");
    terminalize(h, s, "l3", "SUCCEEDED", "SUCCEEDED");
    const res = h.store.queryProvenanceById("SELECT 1");
    ok(res.kind === "not_found", "L3 literal id lookup");
  }

  console.log("\n166-L4 query does not mutate history");
  {
    const h = makeHarness();
    const s = setupRunning(h, "l4");
    terminalize(h, s, "l4", "SUCCEEDED", "SUCCEEDED");
    const before = rawProv(h, s.attemptId);
    h.store.queryProvenanceByAttempt(s.attemptId);
    h.store.queryProvenanceByJob("l4");
    h.store.queryRetryLineage("l4");
    h.store.queryProvenanceById(before.provenance_id);
    const after = rawProv(h, s.attemptId);
    ok(before.evidence_hash === after.evidence_hash, "L4 hash unchanged");
    ok(before.terminalized_at === after.terminalized_at, "L4 timestamp unchanged");
    ok(before.outcome === after.outcome, "L4 outcome unchanged");
  }

  console.log("\n166-L5 query result does not expose job payload secrets");
  {
    const h = makeHarness();
    const s = setupRunning(h, "l5");
    terminalize(h, s, "l5", "SUCCEEDED", "SUCCEEDED");
    const res = h.store.queryProvenanceByAttempt(s.attemptId);
    if (res.kind === "ok") {
      const json = JSON.stringify(res.record);
      ok(!json.includes("password"), "L5 no password field");
      ok(!json.includes("token"), "L5 no token field");
    } else ok(false, "L5 kind=ok expected");
  }

  section("Group M — No synthetic results");

  console.log("166-M1 missing provenance remains missing");
  {
    const h = makeHarness();
    const res = h.store.queryProvenanceByAttempt("no-such-attempt");
    ok(res.kind === "not_found", "M1 not_found");
    ok(countProv(h, "m1") === 0, "M1 no rows created");
  }

  console.log("\n166-M2 missing executor does not create SUCCESS");
  {
    const h = makeHarness();
    const s = setupRunning(h, "m2");
    h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "m2", leaseId: "no-lease", workerId: "no-worker",
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    });
    ok(countProv(h, "m2") === 0, "M2 no provenance from missing executor");
  }

  console.log("\n166-M3 missing evidence does not fabricate evidence");
  {
    const h = makeHarness();
    const s = setupRunning(h, "m3");
    terminalize(h, s, "m3", "SUCCEEDED", "SUCCEEDED");
    const row = rawProv(h, s.attemptId);
    ok(row.evidence_json === null, "M3 evidence_json null");
    ok(row.evidence_hash !== null, "M3 hash still computed");
  }

  console.log("\n166-M4 failed verification does not become SUCCESS");
  {
    const h = makeHarness();
    const s = setupRunning(h, "m4");
    terminalize(h, s, "m4", "SUCCEEDED", "SUCCEEDED");
    h.db.prepare("UPDATE execution_outcome_provenance SET evidence_hash = ? WHERE attempt_id = ?")
      .run("f".repeat(64), s.attemptId);
    const res = h.store.verifyProvenanceByAttempt(s.attemptId);
    ok(res.kind === "hash_mismatch", "M4 mismatch");
    ok(res.kind !== "verified", "M4 not silently verified");
  }

  console.log("\n166-M5 query does not mutate state");
  {
    const h = makeHarness();
    const s = setupRunning(h, "m5");
    terminalize(h, s, "m5", "SUCCEEDED", "SUCCEEDED");
    const beforeProv = countProv(h, "m5");
    const beforeAtt = (h.db.prepare("SELECT COUNT(*) AS n FROM execution_attempts WHERE job_id = ?").get("m5") as any).n;
    const beforeEv = countEvents(h, "m5");
    for (let i = 0; i < 5; i++) {
      h.store.queryProvenanceByAttempt(s.attemptId);
      h.store.queryProvenanceByJob("m5");
      h.store.queryRetryLineage("m5");
      h.store.verifyProvenanceByAttempt(s.attemptId);
    }
    ok(countProv(h, "m5") === beforeProv, "M5 provenance count unchanged");
    ok((h.db.prepare("SELECT COUNT(*) AS n FROM execution_attempts WHERE job_id = ?").get("m5") as any).n === beforeAtt, "M5 attempts unchanged");
    ok(countEvents(h, "m5") === beforeEv, "M5 events unchanged");
  }

  console.log("\n=== Phase 166 Summary ===");
  console.log("Passed: " + passed);
  console.log("Failed: " + failed);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL: " + (e && e.stack ? e.stack : e)); process.exit(1); });