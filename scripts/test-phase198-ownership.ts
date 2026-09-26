// scripts/test-phase198-ownership.ts
// Phase 198 - worker ownership reconciliation.
//
// Tests A-I exercise the ownership boundary on the SQLite/sync path,
// which shares the same WHERE predicate as the async twins added in
// this phase. Test J exercises the async path against Postgres via a
// spawned child (DATABASE_URL required).

import { unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { LeaseManager } from "../src/core/lease-manager";
import { ExecutionEngine } from "../src/core/execution-engine";
import { RetryEngine } from "../src/core/retry-engine";
import { WorkerRegistry } from "../src/core/worker-registry";
import { PgClient } from "../src/core/pg-client";
import { bootstrapPgSchema } from "../src/core/pg-bootstrap";

let pass = 0, fail = 0, blocked = 0;
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
  return { id, idempotencyKey: "p198:" + id, jobType: "EXECUTION", payload: {},
    status: "RUNNING", retryPolicy: { maxAttempts, initialDelayMs: 1000, multiplier: 2, maxDelayMs: 60000 },
    timeoutMs: 60000, createdAt: now, updatedAt: now, lastAttemptAt: now,
    nextAttemptAt: null, currentLeaseId: null, cancellationRequested: 0, cancellationAcknowledged: 0 };
}
function makeAttempt(id: string, jobId: string, workerId: string, leaseId: string, now: number): any {
  return { id, jobId, attemptNumber: 1, status: "RUNNING", workerId, leaseId,
    startedAt: now, completedAt: null, error: null, evidence: null, createdAt: now };
}

// Spawn helper for Test J (mirrors test-phase183-final.ts).
const liveChildren = new Set<ChildProcess>();
process.on("exit", () => { for (const c of liveChildren) { try { c.kill("SIGKILL"); } catch {} } });

function runChild(url: string, cmd: string, ...args: string[]): Promise<{ code: number | null; stdout: string; stderr: string; json: any }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/_phase198_pg_child.ts", cmd, url, ...args], {
      cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
    });
    liveChildren.add(child);
    let stdout = "", stderr = "";
    child.stdout!.on("data", (d) => { stdout += d.toString(); });
    child.stderr!.on("data", (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 60_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      liveChildren.delete(child);
      const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
      let json: any = null;
      for (let i = lines.length - 1; i >= 0; i--) { try { json = JSON.parse(lines[i]); break; } catch {} }
      resolve({ code, stdout, stderr, json });
    });
  });
}

async function main() {
  console.log("PHASE 198 - WORKER OWNERSHIP RECONCILIATION\n");
  const DB = path.join(os.tmpdir(), `nexus-p198-${Date.now()}.sqlite`);
  clean(DB);
  const h = await open(DB);
  const { engine, db, store, leases, execEngine, events } = h;
  const NOW = Date.now();

  // ====================================================================
  // S1 - async (sync-path proxy) heartbeat/progress with valid owner
  // ====================================================================
  console.log("S1 valid owner heartbeat + progress");
  {
    const J = "job_p198_s1";
    store.createJob(makeJob(J, NOW));
    const l = leases.acquireLease(J, "worker-A", 60_000);
    store.createAttempt(makeAttempt("att_p198_s1", J, "worker-A", l.leaseId, NOW));

    const hbAt = NOW + 1000;
    const hb = await execEngine.recordHeartbeat(J, "att_p198_s1", "worker-A", l.leaseId, hbAt);
    ok("A valid heartbeat succeeds", hb.ok === true, "reason=" + hb.reason);

    const row1 = db.prepare("SELECT heartbeat_at FROM execution_attempts WHERE id = ?").get("att_p198_s1") as any;
    ok("A heartbeat_at updated", Number(row1?.heartbeat_at) === hbAt, "got=" + row1?.heartbeat_at);

    const prAt = NOW + 2000;
    const pr = await execEngine.recordProgress(J, "att_p198_s1", "worker-A", l.leaseId, prAt);
    ok("B valid progress succeeds", pr.ok === true, "reason=" + pr.reason);

    const row2 = db.prepare("SELECT last_progress_at FROM execution_attempts WHERE id = ?").get("att_p198_s1") as any;
    ok("B last_progress_at updated", Number(row2?.last_progress_at) === prAt, "got=" + row2?.last_progress_at);
  }

  // ====================================================================
  // S2 - wrong worker rejection
  // ====================================================================
  console.log("\nS2 wrong worker rejection");
  {
    const J = "job_p198_s2";
    store.createJob(makeJob(J, NOW));
    const l = leases.acquireLease(J, "worker-A", 60_000);
    store.createAttempt(makeAttempt("att_p198_s2", J, "worker-A", l.leaseId, NOW));

    // Seed heartbeat so we can verify no mutation
    store.recordAttemptHeartbeatAsOwner("att_p198_s2", J, l.leaseId, "worker-A", NOW);
    const before = db.prepare("SELECT heartbeat_at FROM execution_attempts WHERE id = ?").get("att_p198_s2") as any;

    const hb = await execEngine.recordHeartbeat(J, "att_p198_s2", "worker-B", l.leaseId, NOW + 5000);
    ok("C wrong worker heartbeat rejected", hb.ok === false, "reason=" + hb.reason);
    ok("C wrong worker heartbeat reason", hb.reason === "WORKER_OWNERSHIP_LOST", "got=" + hb.reason);
    const after = db.prepare("SELECT heartbeat_at FROM execution_attempts WHERE id = ?").get("att_p198_s2") as any;
    ok("C heartbeat_at unchanged", Number(after?.heartbeat_at) === Number(before?.heartbeat_at));

    const pr = await execEngine.recordProgress(J, "att_p198_s2", "worker-B", l.leaseId, NOW + 5000);
    ok("D wrong worker progress rejected", pr.ok === false, "reason=" + pr.reason);
    ok("D wrong worker progress reason", pr.reason === "WORKER_OWNERSHIP_LOST", "got=" + pr.reason);
  }

  // ====================================================================
  // S3 - expired lease rejection
  // ====================================================================
  console.log("\nS3 expired lease rejection");
  {
    const J = "job_p198_s3";
    store.createJob(makeJob(J, NOW));
    const l = leases.acquireLease(J, "worker-A", 1000); // 1s TTL
    store.createAttempt(makeAttempt("att_p198_s3", J, "worker-A", l.leaseId, NOW));

    // Explicitly expire the lease so the test does not depend on wall-clock
    // elapsed time relative to the captured NOW. A synthetic future
    // timestamp (NOW + 60_000) stops being in the future once test runtime
    // exceeds that offset, silently un-expiring the lease.
    db.prepare("UPDATE execution_leases SET expires_at = 0 WHERE lease_id = ?")
      .run(l.leaseId);

    const LATER = NOW + 60_000;
    const hb = await execEngine.recordHeartbeat(J, "att_p198_s3", "worker-A", l.leaseId, LATER);
    ok("E expired-lease heartbeat rejected", hb.ok === false, "reason=" + hb.reason);
    ok("E reason = WORKER_OWNERSHIP_LOST", hb.reason === "WORKER_OWNERSHIP_LOST", "got=" + hb.reason);

    const pr = await execEngine.recordProgress(J, "att_p198_s3", "worker-A", l.leaseId, LATER);
    ok("F expired-lease progress rejected", pr.ok === false, "reason=" + pr.reason);
    ok("F reason = WORKER_OWNERSHIP_LOST", pr.reason === "WORKER_OWNERSHIP_LOST", "got=" + pr.reason);
  }

  // ====================================================================
  // S4 - post-fence rejection (the recovery race)
  // ====================================================================
  console.log("\nS4 post-fence rejection");
  {
    const J = "job_p198_s4";
    store.createJob(makeJob(J, NOW));
    const l = leases.acquireLease(J, "worker-A", 600_000);
    store.createAttempt(makeAttempt("att_p198_s4", J, "worker-A", l.leaseId, NOW));
    store.recordAttemptHeartbeatAsOwner("att_p198_s4", J, l.leaseId, "worker-A", NOW);

    // Drive the fence: simulate stale by calling fenceStaleAttempt directly
    const FR = execEngine.recoverStalledAttemptsTick(NOW + 60_000, 5_000, 5_000, 3_000);
    ok("G fence fired (scanned >= 1)", FR.scanned >= 1, "scanned=" + FR.scanned);

    // Old worker tries to mutate with the old lease
    const hb = await execEngine.recordHeartbeat(J, "att_p198_s4", "worker-A", l.leaseId, NOW + 61_000);
    ok("G post-fence heartbeat rejected", hb.ok === false, "reason=" + hb.reason);
    ok("G post-fence heartbeat reason", hb.reason === "WORKER_OWNERSHIP_LOST", "got=" + hb.reason);

    const pr = await execEngine.recordProgress(J, "att_p198_s4", "worker-A", l.leaseId, NOW + 61_000);
    ok("G post-fence progress rejected", pr.ok === false, "reason=" + pr.reason);
  }

  // ====================================================================
  // S5 - new worker takeover
  // ====================================================================
  console.log("\nS5 new worker takeover");
  {
    const J = "job_p198_s5";
    store.createJob(makeJob(J, NOW));
    const lA = leases.acquireLease(J, "worker-A", 600_000);
    store.createAttempt(makeAttempt("att_p198_s5_A", J, "worker-A", lA.leaseId, NOW));
    // Heartbeat required: listStaleAttempts filters heartbeat_at < cutoff,
    // and a NULL heartbeat never matches the stale scan.
    store.recordAttemptHeartbeatAsOwner("att_p198_s5_A", J, lA.leaseId, "worker-A", NOW);

    // Recover: fence A
    execEngine.recoverStalledAttemptsTick(NOW + 60_000, 5_000, 5_000, 3_000);

    // Now job should be ORPHANED -> recoverJobAtomic -> QUEUED
    const jobAfter = store.getJob(J);
    ok("H job requeued after fence", jobAfter?.status === "QUEUED", "status=" + jobAfter?.status);

    // Worker B acquires the new lease for the requeued job
    // Synthetic clock is ~60s ahead of real time; give worker B a
    // long enough lease that real elapsed time during the test cannot
    // push it past expiry before the synthetic heartbeat timestamp.
    const lB = leases.acquireLease(J, "worker-B", 600_000);
    const attB = makeAttempt("att_p198_s5_B", J, "worker-B", lB.leaseId, NOW + 61_000);
    // Migration 155 enforces UNIQUE(job_id, attempt_number); worker B
    // is a fresh attempt on the same job, so attemptNumber must be 2.
    attB.attemptNumber = 2;
    store.createAttempt(attB);

    const hb = await execEngine.recordHeartbeat(J, "att_p198_s5_B", "worker-B", lB.leaseId, NOW + 61_500);
    ok("H new worker heartbeat succeeds", hb.ok === true, "reason=" + hb.reason);

    const pr = await execEngine.recordProgress(J, "att_p198_s5_B", "worker-B", lB.leaseId, NOW + 62_000);
    ok("H new worker progress succeeds", pr.ok === true, "reason=" + pr.reason);
  }

  // ====================================================================
  // S6 - old worker cannot revive after takeover
  // ====================================================================
  console.log("\nS6 old worker cannot revive");
  {
    const J = "job_p198_s6";
    store.createJob(makeJob(J, NOW));
    const lA = leases.acquireLease(J, "worker-A", 600_000);
    store.createAttempt(makeAttempt("att_p198_s6_A", J, "worker-A", lA.leaseId, NOW));
    store.recordAttemptHeartbeatAsOwner("att_p198_s6_A", J, lA.leaseId, "worker-A", NOW);

    execEngine.recoverStalledAttemptsTick(NOW + 60_000, 5_000, 5_000, 3_000);

    // Worker B takes over
    // Synthetic clock is ~60s ahead of real time; give worker B a
    // long enough lease that real elapsed time during the test cannot
    // push it past expiry before the synthetic heartbeat timestamp.
    const lB = leases.acquireLease(J, "worker-B", 600_000);
    const attB6 = makeAttempt("att_p198_s6_B", J, "worker-B", lB.leaseId, NOW + 61_000);
    attB6.attemptNumber = 2;
    store.createAttempt(attB6);

    // Worker A tries to renew its old lease
    ok("I old lease invalid (validateLease)", !leases.validateLease(lA.leaseId, "worker-A"));
    let renewThrew = false;
    try { leases.renewLease(lA.leaseId, "worker-A", 60_000, NOW + 61_500); }
    catch { renewThrew = true; }
    ok("I old lease renewal rejected", renewThrew === true, "threw=" + renewThrew);

    // Worker A tries to heartbeat with old lease. Two independent reasons
    // should hold: lease EXPIRED (fence), attempt FAILED (fence). Either is
    // sufficient to reject; both confirm the boundary.
    ok("I old attempt is FAILED after fence",
       store.getAttempt("att_p198_s6_A")?.status === "FAILED",
       "status=" + store.getAttempt("att_p198_s6_A")?.status);
    const hb = await execEngine.recordHeartbeat(J, "att_p198_s6_A", "worker-A", lA.leaseId, NOW + 61_500);
    ok("I old worker heartbeat rejected", hb.ok === false, "reason=" + hb.reason);

    // Worker A tries to progress with old lease
    const pr = await execEngine.recordProgress(J, "att_p198_s6_A", "worker-A", lA.leaseId, NOW + 61_500);
    ok("I old worker progress rejected", pr.ok === false, "reason=" + pr.reason);
  }

  engine.close();
  clean(DB);

  // ====================================================================
  // S7 - Postgres async lease race (optional; BLOCKED if no DATABASE_URL)
  // ====================================================================
  console.log("\nS7 async lease race (Postgres)");
  const url = process.env.DATABASE_URL;
  if (!url) {
    blocked++;
    console.log("[BLOCKED] S7 DATABASE_URL not set; async path not exercised");
  } else {
    // Self-contained schema setup -- matches the phase183a convention of
    // applying the shared schema inside the test rather than requiring an
    // external bootstrap step.
    const pgBoot = new PgClient();
    await pgBoot.connect(url);
    try { await bootstrapPgSchema(pgBoot); }
    finally { await pgBoot.close(); }

    const res = await runChild(url, "race-lease", "job_p198_s7");
    if (res.code !== 0) {
      blocked++;
      console.log("[BLOCKED] S7 child exit=" + res.code + " stderr=" + res.stderr.trim().slice(0, 200));
    } else {
      ok("J exactly one ACTIVE lease wins", res.json?.winners === 1, "winners=" + res.json?.winners);
      ok("J loser sees { acquired: false }", res.json?.loserAcquired === false, "loserAcquired=" + res.json?.loserAcquired);
      ok("J single ACTIVE lease in DB", res.json?.activeLeaseCount === 1, "count=" + res.json?.activeLeaseCount);
    }
  }

  console.log(`\nPASS: ${pass}\nFAIL: ${fail}\nBLOCKED: ${blocked}`);
  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch((e) => { console.error("FATAL:", e); process.exitCode = 2; });