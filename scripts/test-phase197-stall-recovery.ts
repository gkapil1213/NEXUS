import { unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { LeaseManager } from "../src/core/lease-manager";
import { ExecutionEngine } from "../src/core/execution-engine";
import { RetryEngine } from "../src/core/retry-engine";
import { WorkerRegistry } from "../src/core/worker-registry";

let pass = 0, fail = 0;
function ok(n: string, c: boolean, d = "") {
  if (c) { pass++; console.log("[PASSED] " + n + (d ? "  " + d : "")); }
  else   { fail++; console.log("[FAILED] " + n + (d ? "  " + d : "")); }
}
function clean(p: string) { for (const e of ["", "-wal", "-shm"]) { try { unlinkSync(p + e); } catch {} } }

async function open(dbPath: string) {
  const engine = await SQLiteEngine.open(dbPath);
  const db = engine.getDatabase();
  const store = new ExecutionStore(db, undefined);
  const leases = new LeaseManager(store);
  const workerRegistry = new WorkerRegistry(store, leases as any);
  const retryEngine = new RetryEngine();
  const events: Array<{ type: string; payload: any }> = [];
  const deps = { events: { emit: (e: any) => { events.push({ type: e.type, payload: e.payload }); return undefined; } } } as any;
  const execEngine = new ExecutionEngine(store, workerRegistry, leases, retryEngine, deps);
  return { engine, db, store, leases, execEngine, events };
}

function makeJob(id: string, now: number, maxAttempts = 3): any {
  return { id, idempotencyKey: "p197:" + id, jobType: "EXECUTION", payload: {},
    status: "RUNNING", retryPolicy: { maxAttempts, initialDelayMs: 1000, multiplier: 2, maxDelayMs: 60000 },
    timeoutMs: 60000, createdAt: now, updatedAt: now, lastAttemptAt: now,
    nextAttemptAt: null, currentLeaseId: null, cancellationRequested: 0, cancellationAcknowledged: 0 };
}
function makeAttempt(id: string, jobId: string, workerId: string, leaseId: string, now: number): any {
  return { id, jobId, attemptNumber: 1, status: "RUNNING", workerId, leaseId,
    startedAt: now, completedAt: null, error: null, evidence: null, createdAt: now };
}

async function main() {
  console.log("PHASE 197 - STALL RECOVERY\n");
  const DB = path.join(os.tmpdir(), `nexus-p197-${Date.now()}.sqlite`);
  clean(DB);
  const h = await open(DB);
  const { engine, db, store, leases, execEngine, events } = h;
  const HB_TO = 5_000, PR_TO = 3_000, STALE_TO = 5_000;
  const NOW = Date.now();

  console.log("S1 detection");
  const JOB_H = "job_p197_h";
  store.createJob(makeJob(JOB_H, NOW));
  const lH = leases.acquireLease(JOB_H, "worker-A", 60_000);
  store.createAttempt(makeAttempt("att_p197_h", JOB_H, "worker-A", lH.leaseId, NOW));
  await execEngine.recordHeartbeat(JOB_H, "att_p197_h", "worker-A", lH.leaseId, NOW);
  await execEngine.recordProgress(JOB_H, "att_p197_h", "worker-A", lH.leaseId, NOW);
  let r = execEngine.recoverStalledAttemptsTick(NOW + 100, STALE_TO, HB_TO, PR_TO);
  ok("1a healthy: not scanned", r.scanned === 0, "scanned=" + r.scanned);
  ok("1a healthy: not fenced", r.fenced === 0, "fenced=" + r.fenced);

  const JOB_HB = "job_p197_hb";
  store.createJob(makeJob(JOB_HB, NOW));
  const lHB = leases.acquireLease(JOB_HB, "worker-A", 60_000);
  store.createAttempt(makeAttempt("att_p197_hb", JOB_HB, "worker-A", lHB.leaseId, NOW));
  await execEngine.recordHeartbeat(JOB_HB, "att_p197_hb", "worker-A", lHB.leaseId, NOW);
  await execEngine.recordProgress(JOB_HB, "att_p197_hb", "worker-A", lHB.leaseId, NOW);
  const LATER = NOW + HB_TO + 5_000;

  // Keep the S1a healthy control attempt fresh so S1b isolates
  // the heartbeat-timeout fixture under test.
  await execEngine.recordHeartbeat(
    JOB_H,
    "att_p197_h",
    "worker-A",
    lH.leaseId,
    LATER - 100,
  );
  await execEngine.recordProgress(
    JOB_H,
    "att_p197_h",
    "worker-A",
    lH.leaseId,
    LATER - 100,
  );

  r = execEngine.recoverStalledAttemptsTick(LATER, STALE_TO, HB_TO, PR_TO);
  ok("1b hb-timeout: fenced", r.fenced === 1, "fenced=" + r.fenced);
  ok("1b hb-timeout: requeued", r.requeued === 1, "requeued=" + r.requeued);
  ok("1b job -> QUEUED", store.getJob(JOB_HB)?.status === "QUEUED", "status=" + store.getJob(JOB_HB)?.status);
  ok("1b attempt FAILED", store.getAttempt("att_p197_hb")?.status === "FAILED", "status=" + store.getAttempt("att_p197_hb")?.status);
  ok("1b lease expired", leases.getActiveLeaseForJob(JOB_HB) === undefined);

  ok(
    "1b healthy control job remains RUNNING",
    store.getJob(JOB_H)?.status === "RUNNING",
    "status=" + store.getJob(JOB_H)?.status
  );

  ok(
    "1b healthy control attempt remains RUNNING",
    store.getAttempt("att_p197_h")?.status === "RUNNING",
    "status=" + store.getAttempt("att_p197_h")?.status
  );

  const JOB_PR = "job_p197_pr";
  store.createJob(makeJob(JOB_PR, NOW));
  const lPR = leases.acquireLease(JOB_PR, "worker-A", 600_000);
  store.createAttempt(makeAttempt("att_p197_pr", JOB_PR, "worker-A", lPR.leaseId, NOW));
  await execEngine.recordProgress(JOB_PR, "att_p197_pr", "worker-A", lPR.leaseId, NOW);
  const FRESH_HB = NOW + PR_TO + 1_000;
  await execEngine.recordHeartbeat(JOB_PR, "att_p197_pr", "worker-A", lPR.leaseId, FRESH_HB);
  const AT = FRESH_HB + 100;
  r = execEngine.recoverStalledAttemptsTick(AT, STALE_TO, HB_TO, PR_TO);
  ok("1c pr-timeout: fenced", r.fenced === 1, "fenced=" + r.fenced);
  ok("1c pr-timeout: requeued", r.requeued === 1, "requeued=" + r.requeued);

  console.log("\nS2 idempotency");
  r = execEngine.recoverStalledAttemptsTick(LATER + 1_000, STALE_TO, HB_TO, PR_TO);
  ok("2 second tick: nothing fenced", r.fenced === 0, "fenced=" + r.fenced);
  ok("2 second tick: nothing requeued", r.requeued === 0, "requeued=" + r.requeued);
  ok("2 still one attempt", store.listAttemptsForJob(JOB_HB).length === 1);

  console.log("\nS3 retry exhaustion");
  const JOB_EX = "job_p197_ex";
  store.createJob(makeJob(JOB_EX, NOW, 1));
  const lEX = leases.acquireLease(JOB_EX, "worker-A", 60_000);
  store.createAttempt(makeAttempt("att_p197_ex", JOB_EX, "worker-A", lEX.leaseId, NOW));
  await execEngine.recordHeartbeat(JOB_EX, "att_p197_ex", "worker-A", lEX.leaseId, NOW);
  r = execEngine.recoverStalledAttemptsTick(LATER, STALE_TO, HB_TO, PR_TO);
  ok("3 exhausted: fenced", r.fenced === 1, "fenced=" + r.fenced);
  ok("3 exhausted: blocked", r.blocked === 1, "blocked=" + r.blocked);
  ok("3 job stays ORPHANED", store.getJob(JOB_EX)?.status === "ORPHANED", "status=" + store.getJob(JOB_EX)?.status);
  ok("3 recovery.blocked event", events.filter((e) => e.type === "execution.recovery.blocked" && e.payload?.jobId === JOB_EX).length === 1);
  const rowEx = db.prepare("SELECT supervision_state, failure_class FROM execution_jobs WHERE id = ?").get(JOB_EX) as any;
  ok("3 failure_class = RETRY_EXHAUSTED", rowEx?.failure_class === "RETRY_EXHAUSTED", "got=" + rowEx?.failure_class);

  console.log("\nS4 fencing");
  ok("4 stale worker-A lease invalid", !leases.validateLease(lHB.leaseId, "worker-A"));
  const refence = store.fenceStaleAttempt({
    attemptId: "att_p197_hb", jobId: JOB_HB, leaseId: lHB.leaseId,
    reason: "HEARTBEAT_TIMEOUT", now: LATER + 5_000, staleCutoffMs: STALE_TO,
  });
  ok("4 refence FAILED attempt: alreadyFenced", refence.fenced === false && refence.alreadyFenced === true,
     "fenced=" + refence.fenced + " alreadyFenced=" + refence.alreadyFenced);

  console.log("\nS6 atomic-fail path");
  {
    const JOB_AF = "job_p197_af";
    store.createJob(makeJob(JOB_AF, NOW));
    const lAF = leases.acquireLease(JOB_AF, "worker-A", 60_000);
    store.createAttempt(makeAttempt("att_p197_af", JOB_AF, "worker-A", lAF.leaseId, NOW));
    await execEngine.recordHeartbeat(JOB_AF, "att_p197_af", "worker-A", lAF.leaseId, NOW);

    // Intercept recoverJobAtomic for this fixture only, so the rr.ok=false
    // branch is exercised. fenceStaleAttempt runs untouched and promotes
    // the job to ORPHANED, so the tick reaches the retry-policy check
    // (canRetry=true with the default policy) and then the requeue call,
    // which we force to fail.
    const realRecover = (store as any).recoverJobAtomic.bind(store);
    (store as any).recoverJobAtomic = () => ({ ok: false });

    const rAF = execEngine.recoverStalledAttemptsTick(LATER, STALE_TO, HB_TO, PR_TO);

    (store as any).recoverJobAtomic = realRecover;
    ok("6 atomic-fail: fenced", rAF.fenced === 1, "fenced=" + rAF.fenced);
    ok("6 atomic-fail: blocked", rAF.blocked === 1, "blocked=" + rAF.blocked);

    const rowAF = db.prepare(
      "SELECT supervision_state, failure_class FROM execution_jobs WHERE id = ?"
    ).get(JOB_AF) as any;
    ok("6 supervision_state = RECOVERY_BLOCKED",
       rowAF?.supervision_state === "RECOVERY_BLOCKED", "got=" + rowAF?.supervision_state);
    ok("6 failure_class = RECOVER_JOB_ATOMIC_FAILED",
       rowAF?.failure_class === "RECOVER_JOB_ATOMIC_FAILED", "got=" + rowAF?.failure_class);
    ok("6 recovery.blocked event",
       events.filter((e) => e.type === "execution.recovery.blocked"
         && e.payload?.jobId === JOB_AF
         && e.payload?.reason === "RECOVER_JOB_ATOMIC_FAILED").length === 1);
  }

  console.log("\nS7 recoverStaleJobs integration");
  {
    const JOB_INT = "job_p197_int";
    store.createJob(makeJob(JOB_INT, NOW));
    const lInt = leases.acquireLease(JOB_INT, "worker-A", 600_000);
    store.createAttempt(makeAttempt("att_p197_int", JOB_INT, "worker-A", lInt.leaseId, NOW));
    await execEngine.recordHeartbeat(JOB_INT, "att_p197_int", "worker-A", lInt.leaseId, NOW);
    await execEngine.recordProgress(JOB_INT, "att_p197_int", "worker-A", lInt.leaseId, NOW);

    // recoverStaleJobs uses CONFIG.recovery.* defaults
    // (staleAttemptMs=30s, heartbeatTimeoutMs=30s), so LATER_INT must
    // exceed those. Lease is 10 min so it stays active — the tick,
    // not lease-expiry, is what fences this attempt.
    const LATER_INT = NOW + 40_000;

    // Drive the production entry point, not the tick directly.
    await execEngine.recoverStaleJobs(LATER_INT);

    ok("7 recoverStaleJobs wired to tick: attempt FAILED",
       store.getAttempt("att_p197_int")?.status === "FAILED",
       "status=" + store.getAttempt("att_p197_int")?.status);
    ok("7 recoverStaleJobs wired to tick: job QUEUED",
       store.getJob(JOB_INT)?.status === "QUEUED",
       "status=" + store.getJob(JOB_INT)?.status);
  }
  console.log("\nS5 restart durability");
  engine.close();
  const h2 = await open(DB);
  ok("5 job status preserved (QUEUED)", h2.store.getJob(JOB_HB)?.status === "QUEUED", "status=" + h2.store.getJob(JOB_HB)?.status);
  ok("5 attempt FAILED preserved", h2.store.getAttempt("att_p197_hb")?.status === "FAILED", "status=" + h2.store.getAttempt("att_p197_hb")?.status);
  const rowHB2 = h2.db.prepare("SELECT supervision_state FROM execution_jobs WHERE id = ?").get(JOB_HB) as any;
  ok("5 supervision_state = RECOVERED", rowHB2?.supervision_state === "RECOVERED", "got=" + rowHB2?.supervision_state);
  h2.engine.close();
  clean(DB);

  console.log(`\nPASS: ${pass}\nFAIL: ${fail}`);
  process.exitCode = fail > 0 ? 1 : 0;
}
main().catch((e) => { console.error("FATAL:", e); process.exitCode = 2; });
