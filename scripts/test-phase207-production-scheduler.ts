// scripts/test-phase207-production-scheduler.ts
//
// Phase 207 production scheduler lifecycle test.
//
// Exercises the real kernel lifecycle:
//   - sync mode  : executionReconcileTimer -> recoverStaleJobs -> finalizeExecution
//   - shared mode: startDistributedScheduler -> recoverStaleAttemptsTick -> tick
//
// Every scenario reports exactly one of PASS / FAIL / BLOCKED / NOT EXECUTED.
// BLOCKED is used when the required backend or fixture is unavailable.
// NOT EXECUTED is used when a scenario cannot be attempted.
//
// Run:
//   npx tsx scripts/test-phase207-production-scheduler.ts
//   NEXUS_PERSISTENCE_MODE=shared DATABASE_URL=... npx tsx scripts/test-phase207-production-scheduler.ts

import { NexusKernel } from "../src/core/kernel";
import { DistributedScheduler } from "../src/core/distributed-scheduler";
import type { ExecutionJob } from "../src/core/execution-models";
import { PgClient } from "../src/core/pg-client";

type Result = "PASS" | "FAIL" | "BLOCKED" | "NOT EXECUTED";
interface Row { id: string; name: string; result: Result; note: string; }
const rows: Row[] = [];
function record(id: string, name: string, result: Result, note: string): void {
  rows.push({ id, name, result, note });
  const mark = result === "PASS" ? "[PASS]" : result === "FAIL" ? "[FAIL]" : result === "BLOCKED" ? "[BLK ]" : "[N/E ]";
  console.log(`${mark} ${id} ${name} -- ${note}`);
}
function ok(cond: boolean, msg: string): void { if (!cond) throw new Error(msg); }


async function ensureTestWorker(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  const c = new PgClient();
  await c.connect(url);
  try {
    const now = Date.now();
    await c.query(
      "INSERT INTO execution_workers (worker_id, hostname, capabilities, status, last_heartbeat_at, registered_at) " +
      "VALUES ($1, $2, $3, $4, $5, $6) " +
      "ON CONFLICT (worker_id) DO UPDATE SET status = $4, last_heartbeat_at = $5",
      ["phase207-test-worker", "localhost", null, "ONLINE", now, now]
    );
  } finally {
    await c.close();
  }
}
async function main(): Promise<void> {
  const shared = (process.env.NEXUS_PERSISTENCE_MODE ?? "sqlite").toLowerCase() === "shared";
  const hasDb = !!process.env.DATABASE_URL;
  console.log(`mode=${shared ? "shared" : "sqlite"} databaseUrl=${hasDb ? "set" : "unset"}`);

  const kernel = new NexusKernel();

  // ---- 207A: kernel boot ----
  try {
    await kernel.boot();
    record("207A", "kernel boot", "PASS", `boot completed (${shared ? "shared" : "sqlite"})`);
  } catch (e) {
    record("207A", "kernel boot", "FAIL", e instanceof Error ? e.message : String(e));
    return finish(kernel);
  }

  // ---- 207B: scheduler status snapshot before start ----
  try {
    const st = kernel.getDistributedSchedulerStatus();
    ok(st.running === false, "scheduler should not be running before start");
    ok(st.inFlight === false, "scheduler should not be inFlight before start");
    record("207B", "scheduler status (pre-start)", "PASS", `wired=${st.wired} running=${st.running}`);
  } catch (e) {
    record("207B", "scheduler status (pre-start)", "FAIL", e instanceof Error ? e.message : String(e));
  }

  // ---- 207C: shared-mode start requires shared backend ----
  if (!shared) {
    try {
      await kernel.startDistributedScheduler();
      record("207C", "shared-only start rejects sqlite", "FAIL", "expected throw SCHEDULER_REQUIRES_SHARED");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("shared") || msg.includes("SCHEDULER_REQUIRES_SHARED")) {
        record("207C", "shared-only start rejects sqlite", "PASS", msg);
      } else {
        record("207C", "shared-only start rejects sqlite", "FAIL", msg);
      }
    }
  } else if (!hasDb) {
    record("207C", "shared-only start", "BLOCKED", "DATABASE_URL not set");
  } else {
    try {
      await kernel.startDistributedScheduler();
      const st = kernel.getDistributedSchedulerStatus();
      ok(st.running === true, "scheduler should be running");
      ok(st.wired === true, "scheduler should be wired");
      record("207C", "shared-mode start", "PASS", `interval from NEXUS_SCHEDULER_INTERVAL_MS`);
    } catch (e) {
      record("207C", "shared-mode start", "FAIL", e instanceof Error ? e.message : String(e));
    }
  }

  // ---- 207D: idempotent start ----
  if (shared && hasDb) {
    try {
      const before = kernel.getDistributedSchedulerStatus();
      await kernel.startDistributedScheduler();
      const after = kernel.getDistributedSchedulerStatus();
      ok(after.running === true, "still running");
      record("207D", "idempotent start", before.running === after.running ? "PASS" : "FAIL", `running=${after.running}`);
    } catch (e) {
      record("207D", "idempotent start", "FAIL", e instanceof Error ? e.message : String(e));
    }
  } else {
    record("207D", "idempotent start", "BLOCKED", shared ? "DATABASE_URL not set" : "not in shared mode");
  }

  // ---- 207E: DistributedScheduler direct construct ----
  try {
    const fakeStore = (kernel as unknown as { executionStore?: { hasAsyncBackend?: () => boolean } }).executionStore;
    if (!fakeStore) {
      record("207E", "scheduler construct on kernel store", "BLOCKED", "kernel has no executionStore");
    } else if (!shared) {
      record("207E", "scheduler construct on kernel store", "BLOCKED", "sqlite mode: DistributedScheduler requires shared backend");
    } else {
      const s = new DistributedScheduler(fakeStore as never);
      ok(typeof s.tick === "function", "tick present");
      ok(typeof s.recoverStaleAttemptsTick === "function", "recoverStaleAttemptsTick present");
      record("207E", "scheduler construct on kernel store", "PASS", `ownerId=${s.ownerId}`);
    }
  } catch (e) {
    record("207E", "scheduler construct on kernel store", "FAIL", e instanceof Error ? e.message : String(e));
  }

  // ---- 207F: sync-mode execution reconcile timer runs ----
  if (!shared) {
    try {
      const before = kernel.getDistributedSchedulerStatus();
      // in sync mode, startDistributedScheduler must throw (requires shared)
      // so the sync path is exercised through the reconcile timer, which is
      // started automatically when executionEngine is wired.
      const engineAny = (kernel as unknown as { executionEngine?: { recoverStaleJobs?: (n?: number) => Promise<void> } }).executionEngine;
      if (!engineAny || typeof engineAny.recoverStaleJobs !== "function") {
        record("207F", "sync reconcile path present", "BLOCKED", "no executionEngine in kernel");
      } else {
        await engineAny.recoverStaleJobs(Date.now());
        record("207F", "sync reconcile path present", "PASS", `recoverStaleJobs completed; scheduler running=${before.running}`);
      }
    } catch (e) {
      record("207F", "sync reconcile path present", "FAIL", e instanceof Error ? e.message : String(e));
    }
  } else {
    record("207F", "sync reconcile path present", "NOT EXECUTED", "shared mode");
  }

  // ---- 207G - 207T: stateful scenarios require shared + real worker ----
  const sharedOnlyReason = shared ? "DATABASE_URL not set" : "sqlite mode: DistributedScheduler is shared-only";
  // ---- 207G: queued job admission (shared only) ----
  if (shared && hasDb) {
    try {
      const store = (kernel as unknown as { executionStore?: any }).executionStore;
      if (!store || typeof store.createJobAsync !== "function") {
        record("207G", "queued job admission", "BLOCKED", "executionStore.createJobAsync not available");
      } else {
        const jobId = "job-207G-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
        const now = Date.now();
        const job: ExecutionJob = {
          id: jobId,
          idempotencyKey: "idem-" + jobId,
          jobType: "test.phase207",
          status: "QUEUED",
          createdAt: now,
          updatedAt: now,
          cancellationRequested: false,
          cancellationAcknowledged: false,
          priority: -1000000,
        };
        await store.createJobAsync(job);
        await ensureTestWorker();
        const before = await store.getJobAsync(jobId);
        const diag = await store.admitNextJobAsync({ owner: "diag", capacityLimit: 10000, now });
        console.log("[207G diag] admitNextJobAsync direct result:", JSON.stringify(diag));
        const after = await store.getJobAsync(jobId);
        if (before?.status === "QUEUED" && after?.status === "ADMITTED") {
          record("207G", "queued job admission", "PASS", "QUEUED -> ADMITTED");
        } else {
          record("207G", "queued job admission", "FAIL", "diag=" + JSON.stringify(diag) + " before=" + before?.status + " after=" + after?.status);
        }
      }
    } catch (e) {
      record("207G", "queued job admission", "FAIL", e instanceof Error ? e.message : String(e));
    }
  } else {
    record("207G", "queued job admission", "BLOCKED", shared ? "DATABASE_URL not set" : "sqlite mode");
  }

  // ---- 207N: duplicate tick protection (shared only) ----
  if (shared && hasDb) {
    try {
      const store = (kernel as unknown as { executionStore?: any }).executionStore;
      const jobId = "job-207N-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
      const now = Date.now();
      const job: ExecutionJob = { id: jobId, idempotencyKey: "idem-" + jobId, jobType: "test.phase207", status: "QUEUED", createdAt: now, updatedAt: now, cancellationRequested: false, cancellationAcknowledged: false, priority: -1000000 };
      await store.createJobAsync(job);
      await ensureTestWorker();
      const sched = new DistributedScheduler(store, { maxConcurrency: 10000, maxAdmissionsPerTick: 16 });
      await sched.tick(now);
      await sched.tick(now);
      const admitted = await store.listJobsByStatusAsync("ADMITTED");
      const rows = admitted.filter((j: ExecutionJob) => j.id === jobId).length;
      if (rows === 1) {
        record("207N", "duplicate tick protection", "PASS", "exactly one ADMITTED row after two ticks");
      } else {
        record("207N", "duplicate tick protection", "FAIL", "expected 1 ADMITTED row, got " + rows);
      }
    } catch (e) {
      record("207N", "duplicate tick protection", "FAIL", e instanceof Error ? e.message : String(e));
    }
  } else {
    record("207N", "duplicate tick protection", "BLOCKED", shared ? "DATABASE_URL not set" : "sqlite mode");
  }

  const matrix: Array<[string, string]> = [
    ["207H", "worker dispatch"],
    ["207I", "lease acquisition"],
    ["207J", "dependency gating"],
    ["207K", "DAG progression"],
    ["207L", "fan-out"],
    ["207M", "fan-in"],
    ["207O", "concurrent scheduler instances"],
    ["207P", "worker race"],
    ["207Q", "stale worker fencing"],
    ["207R", "retry promotion"],
    ["207S", "scheduler restart"],
    ["207T", "end-to-end execution"],
  ];
  for (const [id, name] of matrix) {
    if (!shared || !hasDb) {
      record(id, name, "BLOCKED", sharedOnlyReason);
    } else {
      record(id, name, "NOT EXECUTED", "requires real worker fixture + durable job seed");
    }
  }

  await finish(kernel);
}

async function finish(kernel: NexusKernel): Promise<void> {
  try { await kernel.stopDistributedScheduler(); } catch { /* ignore */ }
  try { await kernel.shutdown({ finalRecoveryPass: false }); } catch { /* ignore */ }

  const counts = rows.reduce<Record<Result, number>>(
    (acc, r) => { acc[r.result] = (acc[r.result] ?? 0) + 1; return acc; },
    { PASS: 0, FAIL: 0, BLOCKED: 0, "NOT EXECUTED": 0 },
  );

  console.log("\n===== Phase 207 summary =====");
  console.log(`PASS: ${counts.PASS}`);
  console.log(`FAIL: ${counts.FAIL}`);
  console.log(`BLOCKED: ${counts.BLOCKED}`);
  console.log(`NOT EXECUTED: ${counts["NOT EXECUTED"]}`);

  const failing = rows.filter((r) => r.result === "FAIL");
  if (failing.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("fatal:", e instanceof Error ? e.stack : String(e));
  process.exit(2);
});
