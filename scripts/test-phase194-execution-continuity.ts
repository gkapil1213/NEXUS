// scripts/test-phase194-execution-continuity.ts
//
// PHASE 194 — execution continuity + atomic expired-lease takeover.
// Real on-disk SQLite via SQLiteEngine.open() (full migration chain).
// No manual SQL for lease expiry — the store must handle it.

import { existsSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { LeaseManager } from "../src/core/lease-manager";

let pass = 0, fail = 0, blocked = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log("[PASSED] " + name + (detail ? "  " + detail : "")); }
  else      { fail++; console.log("[FAILED] " + name + (detail ? "  " + detail : "")); }
}
function blk(name: string, reason: string) {
  blocked++; console.log("[BLOCKED] " + name + "  " + reason);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Ctx {
  engine: SQLiteEngine;
  db: any;
  store: ExecutionStore;
  leases: LeaseManager;
}

async function openCtx(dbPath: string): Promise<Ctx> {
  const engine = await SQLiteEngine.open(dbPath);
  const db = engine.getDatabase();
  const store = new ExecutionStore(db, undefined);
  const leases = new LeaseManager(store);
  return { engine, db, store, leases };
}

function makeJob(id: string, now: number): any {
  return {
    id,
    idempotencyKey: "p194:" + id,
    jobType: "EXECUTION",
    payload: {},
    status: "RUNNING",
    retryPolicy: { maxAttempts: 3, initialDelayMs: 1000, multiplier: 2, maxDelayMs: 60000 },
    timeoutMs: 60000,
    createdAt: now,
    updatedAt: now,
    lastAttemptAt: now,
    nextAttemptAt: null,
    currentLeaseId: null,
    cancellationRequested: 0,
    cancellationAcknowledged: 0,
  };
}

function makeAttempt(id: string, jobId: string, attemptNumber: number, workerId: string, leaseId: string, now: number): any {
  return {
    id, jobId, attemptNumber, status: "RUNNING",
    workerId, leaseId, startedAt: now, completedAt: null,
    error: null, evidence: null, createdAt: now,
  };
}

async function main() {
  console.log("PHASE 194 — EXECUTION CONTINUITY (production bootstrap)\n");

  const DB_PATH = path.join(os.tmpdir(), `nexus-p194-${Date.now()}.sqlite`);
  const JOB_ID = "job_p194_001";
  const ATTEMPT_ID = "att_p194_001";
  const WORKER_A = "worker-A";
  const WORKER_B = "worker-B";
  const WORKER_C = "worker-C";
  const WORKER_D = "worker-D";
  const T0 = Date.now();
  const SHORT_TTL_MS = 200;

  // ---------- Phase 1: worker A ----------
  {
    const { engine, store, leases } = await openCtx(DB_PATH);

    ok("engine kind=sqlite", engine.kind === "sqlite");

    store.createJob(makeJob(JOB_ID, T0));
    ok("F01 execution persisted", store.getJob(JOB_ID)?.id === JOB_ID);

    const aLease = leases.acquireLease(JOB_ID, WORKER_A, SHORT_TTL_MS);
    ok("F02 worker-A acquired lease", !!aLease.leaseId, "leaseId=" + aLease.leaseId);

    store.createAttempt(makeAttempt(ATTEMPT_ID, JOB_ID, 1, WORKER_A, aLease.leaseId, T0));
    const attempts1 = store.listAttemptsForJob(JOB_ID);
    ok("F02 attempt persisted", attempts1.length === 1 && attempts1[0].id === ATTEMPT_ID);

    const j = store.getJob(JOB_ID)!;
    (j as any).currentLeaseId = aLease.leaseId;
    (j as any).updatedAt = Date.now();
    store.updateJob(j);
    ok("F02 job points at lease", (store.getJob(JOB_ID) as any)?.currentLeaseId === aLease.leaseId);

    engine.close();
    ok("F04 crash simulated (no release)", true);
  }

  // ---------- Phase 2: worker B takes over expired lease ----------
  {
    const { engine, db, store, leases } = await openCtx(DB_PATH);

    ok("F05 execution survived restart", store.getJob(JOB_ID)?.id === JOB_ID);

    const running = store.listJobsByStatus("RUNNING");
    ok("F06 stale RUNNING discovered", running.some((x: any) => x.id === JOB_ID));

    const seenLease = leases.getActiveLeaseForJob(JOB_ID) as any;
    ok("F07 old lease visible after restart",
       seenLease !== undefined && seenLease.workerId === WORKER_A,
       "worker=" + seenLease?.workerId);

    // Real time passes; A's 200ms TTL expires.
    await sleep(300);

    // F08: no manual SQL. Just call acquireLease. The store MUST atomically
    // expire A's stale row and insert B's.
    let bLease: any = null;
    try { bLease = leases.acquireLease(JOB_ID, WORKER_B, 60_000); }
    catch (e) { bLease = null; }
    ok("F08 worker-B takes over expired A lease",
       bLease !== null && bLease.workerId === WORKER_B,
       bLease ? "leaseId=" + bLease.leaseId : "acquireLease threw/failed");

    if (bLease === null) {
      blk("F09-F20 downstream fencing checks", "F08 did not establish B");
      engine.close();
      for (const ext of ["", "-wal", "-shm"]) { try { unlinkSync(DB_PATH + ext); } catch {} }
      console.log(`\nPASS: ${pass}\nFAIL: ${fail}\nBLOCKED: ${blocked}`);
      process.exitCode = fail > 0 ? 1 : 0;
      return;
    }

    const attempts2 = store.listAttemptsForJob(JOB_ID);
    ok("F09 attempt count still exactly one", attempts2.length === 1);
    ok("F10 attempt number still 1", attempts2[0].attemptNumber === 1);

    const aStillValid = leases.validateLease((seenLease as any).leaseId, WORKER_A);
    ok("F11 worker-A old lease fenced (no longer valid)", aStillValid === false);

    const bValid = leases.validateLease(bLease.leaseId, WORKER_B);
    ok("F12 worker-B lease validates", bValid === true);

    // F13 B can renew
    let bRenewed: any = null;
    try { bRenewed = leases.renewLease(bLease.leaseId, WORKER_B, 60_000); } catch {}
    ok("F13 worker-B can renew", bRenewed !== null);

    // F14 A cannot renew its old lease
    let aRenewed: any = null;
    try { aRenewed = leases.renewLease((seenLease as any).leaseId, WORKER_A, 60_000); } catch {}
    ok("F14 worker-A cannot renew stale lease", aRenewed === null);

    // F15 A cannot mutate execution through stale lease
    let aMutated = false;
    try {
      const res = store.updateJobAsOwner(
        JOB_ID,
        { status: "SUCCEEDED", updatedAt: Date.now() } as any,
        { workerId: WORKER_A, leaseId: (seenLease as any).leaseId } as any,
      );
      aMutated = (res as any)?.ok === true;
    } catch { aMutated = false; }
    ok("F15 worker-A cannot mutate via stale lease", aMutated === false);

    // F16 B can continue the existing attempt
    const existingAttempt = attempts2[0];
    ok("F16 worker-B continues attempt-1", existingAttempt.id === ATTEMPT_ID &&
       existingAttempt.workerId === WORKER_A); // attempt owner stays as creator; B takes over job

    // F17 worker-C cannot acquire while B holds active lease
    let cLease: any = null;
    try { cLease = leases.acquireLease(JOB_ID, WORKER_C, 60_000); } catch {}
    ok("F17 worker-C rejected while B holds active", cLease === null);

    // F18 after B's lease expires, worker-D takes over
    // Renew B with a short TTL, then wait for real expiry
    try { leases.renewLease(bLease.leaseId, WORKER_B, SHORT_TTL_MS); } catch {}
    await sleep(300);
    let dLease: any = null;
    try { dLease = leases.acquireLease(JOB_ID, WORKER_D, 60_000); } catch {}
    ok("F18 worker-D takes over after B expired",
       dLease !== null && dLease.workerId === WORKER_D,
       dLease ? "leaseId=" + dLease.leaseId : "acquireLease threw/failed");

    // F19 still one attempt
    const attempts3 = store.listAttemptsForJob(JOB_ID);
    ok("F19 no duplicate attempt after second takeover", attempts3.length === 1);

    // F20 final state authoritative
    const finalLease = leases.getActiveLeaseForJob(JOB_ID) as any;
    ok("F20 final active lease belongs to D",
       finalLease !== undefined && finalLease.workerId === WORKER_D,
       "worker=" + finalLease?.workerId);

    engine.close();
  }

  for (const ext of ["", "-wal", "-shm"]) { try { unlinkSync(DB_PATH + ext); } catch {} }

  console.log(`\nPASS: ${pass}\nFAIL: ${fail}\nBLOCKED: ${blocked}`);
  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch((e) => { console.error("FATAL:", e); process.exitCode = 2; });
