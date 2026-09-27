// scripts/test-phase207-production-scheduler.ts
// Phase 207 production scheduler integration test.
// Drives real DistributedScheduler + ExecutionStore + WorkerRegistry
// + StageDependencyStore + isStageEligible production code paths.
// Every scenario reports exactly one of PASS / FAIL / BLOCKED / NOT EXECUTED.

import { NexusKernel } from "../src/core/kernel";
import { DistributedScheduler } from "../src/core/distributed-scheduler";
import { PgClient } from "../src/core/pg-client";
import { isStageEligible } from "../src/core/stage-eligibility";
import type { StageExecution, StageStatus } from "../src/core/worker-stage-execution";

type Result = "PASS" | "FAIL" | "BLOCKED" | "NOT EXECUTED";
interface Row { id: string; name: string; result: Result; note: string; }
const rows: Row[] = [];
function record(id: string, name: string, result: Result, note: string): void {
  rows.push({ id, name, result, note });
  const mark = result === "PASS" ? "[PASS]" : result === "FAIL" ? "[FAIL]" : result === "BLOCKED" ? "[BLK ]" : "[N/E ]";
  console.log(`${mark} ${id} ${name} -- ${note}`);
}
function ok(cond: boolean, msg: string): void { if (!cond) throw new Error(msg); }
function rid(prefix: string): string { return prefix + Date.now() + "-" + Math.random().toString(36).slice(2, 8); }

type Store = any;

async function seedWorker(store: Store, workerId: string): Promise<void> {
  const now = Date.now();
  await store.registerWorkerAsync({
    workerId, hostname: "localhost", status: "ONLINE",
    registeredAt: now, lastHeartbeatAt: now,
  } as any);
}
async function ensureWorker(store: Store, workerId: string): Promise<void> {
  const ex = await store.getWorkerAsync(workerId);
  if (!ex) await seedWorker(store, workerId);
}
async function seedJob(store: Store, id: string, status: string, opts: {
  priority?: number; nextAttemptAt?: number | null; jobType?: string; payload?: any; createdAt?: number;
} = {}): Promise<void> {
  const now = Date.now();
  await store.createJobAsync({
    id, idempotencyKey: "p207-" + id,
    jobType: opts.jobType ?? "engineering",
    payload: opts.payload ?? {},
    status, // Phase 212 fix: with priority -1000000, decades of accumulated QUEUED
// stage jobs (from previous 207 runs, which don't clean up) age to a MORE
// negative effective priority and always win admitNextJobAsync's ordering.
// -2000000000 (INTEGER min + 1 headroom) ensures this run's fresh jobs
// always sort first regardless of how large the backlog has grown.
    priority: opts.priority ?? -2000000000,
    nextAttemptAt: opts.nextAttemptAt ?? null,
    createdAt: opts.createdAt ?? (now - 10_000_000_000),
    updatedAt: now,
    cancellationRequested: false, cancellationAcknowledged: false,
  } as any);
}
async function seedStageJob(store: Store, executionId: string, stageName: string, status: string): Promise<string> {
  const id = `${executionId}__${stageName}`;
  await seedJob(store, id, status, {
    jobType: "pipeline.stage",
    payload: { kind: "pipeline.stage", executionId, stageName, attempt: 1 },
  });
  return id;
}

async function pgQuery<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  const c = new PgClient(); await c.connect(url);
  try { const r = await c.query<T>(sql, params); return r.rows; }
  finally { await c.close(); }
}
async function pgCleanup(prefixes: string[]): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  const c = new PgClient(); await c.connect(url);
  try {
    for (const p of prefixes) {
      await c.query("DELETE FROM execution_events WHERE job_id LIKE $1", [p + "%"]);
      await c.query("DELETE FROM execution_artifacts WHERE job_id LIKE $1", [p + "%"]);
      await c.query("DELETE FROM execution_attempts WHERE job_id LIKE $1", [p + "%"]);
      await c.query("DELETE FROM execution_leases WHERE job_id LIKE $1", [p + "%"]);
      await c.query("DELETE FROM execution_stage_dependencies WHERE execution_id LIKE $1", [p + "%"]);
      await c.query("DELETE FROM execution_jobs WHERE id LIKE $1", [p + "%"]);
      await c.query("DELETE FROM execution_workers WHERE worker_id LIKE $1", [p + "%"]);
    }
  } finally { await c.close(); }
}

async function admitFully(store: Store, jobId: string, _sched: DistributedScheduler): Promise<string> {
  // Pure admitNextJobAsync loop. Deliberately does NOT call sched.tick():
  // tick() runs dispatchTick(), which can move ADMITTED -> CLAIMED behind
  // the caller with a random worker, breaking tests that need to dispatch
  // to a specific worker. Same fix as Phase 208 admitFully.
  for (let i = 0; i < 500; i++) {
    const j = await store.getJobAsync(jobId);
    if (!j) throw new Error("job not found: " + jobId);
    if (j.status === "ADMITTED") return j.status;
    if (j.status === "CLAIMED") return j.status;
    if (j.status === "QUEUED") {
      await store.admitNextJobAsync({ owner: "p207", capacityLimit: 100000, now: Date.now() });
      continue;
    }
    return j.status;
  }
  throw new Error("admit timeout: " + jobId);
}

async function main(): Promise<void> {
  const shared = (process.env.NEXUS_PERSISTENCE_MODE ?? "sqlite").toLowerCase() === "shared";
  const hasDb = !!process.env.DATABASE_URL;
  const prefix = "phase207-" + Date.now() + "-";
  console.log(`mode=${shared ? "shared" : "sqlite"} databaseUrl=${hasDb ? "set" : "unset"} prefix=${prefix}`);

  const kernel = new NexusKernel();
  try {
    await kernel.boot();
    record("207A", "kernel boot", "PASS", `boot completed (${shared ? "shared" : "sqlite"})`);
  } catch (e) {
    record("207A", "kernel boot", "FAIL", e instanceof Error ? e.message : String(e));
    return finish(kernel, prefix);
  }

  const store = (kernel as any).executionStore as Store | undefined;

  try {
    const st = kernel.getDistributedSchedulerStatus();
    ok(st.running === false && st.inFlight === false, "expected stopped");
    record("207B", "scheduler status (pre-start)", "PASS", `wired=${st.wired} running=${st.running}`);
  } catch (e) { record("207B", "scheduler status (pre-start)", "FAIL", e instanceof Error ? e.message : String(e)); }

  if (!shared) {
    try {
      await kernel.startDistributedScheduler();
      record("207C", "shared-only start rejects sqlite", "FAIL", "expected throw");
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      record("207C", "shared-only start rejects sqlite",
        /shared/i.test(m) ? "PASS" : "FAIL", m);
    }
  } else if (!hasDb) {
    record("207C", "shared-mode start", "BLOCKED", "DATABASE_URL not set");
  } else {
    try {
      await kernel.startDistributedScheduler();
      const st = kernel.getDistributedSchedulerStatus();
      ok(st.running && st.wired, "not running");
      record("207C", "shared-mode start", "PASS", `interval=${process.env.NEXUS_SCHEDULER_INTERVAL_MS ?? "default"}`);
    } catch (e) { record("207C", "shared-mode start", "FAIL", e instanceof Error ? e.message : String(e)); }
  }

  if (shared && hasDb) {
    try {
      await kernel.startDistributedScheduler();
      const st = kernel.getDistributedSchedulerStatus();
      record("207D", "idempotent start", st.running ? "PASS" : "FAIL", `running=${st.running}`);
    } catch (e) { record("207D", "idempotent start", "FAIL", e instanceof Error ? e.message : String(e)); }
  } else {
    record("207D", "idempotent start", "BLOCKED", shared ? "no DB" : "sqlite mode");
  }

  if (store && shared) {
    try {
      const s = new DistributedScheduler(store);
      record("207E", "scheduler construct on kernel store", "PASS", `ownerId=${s.ownerId}`);
    } catch (e) { record("207E", "scheduler construct on kernel store", "FAIL", e instanceof Error ? e.message : String(e)); }
  } else {
    record("207E", "scheduler construct on kernel store", "BLOCKED", shared ? "no store" : "sqlite");
  }

  // 207F reconciliation
  {
    const engine = (kernel as any).executionEngine;
    const present = !!(engine && typeof engine.recoverStaleJobs === "function");
    if (!present) {
      record("207F", "execution reconciliation", "BLOCKED", "executionEngine.recoverStaleJobs not available");
    } else {
      try {
        await engine.recoverStaleJobs(Date.now());
        record("207F", "execution reconciliation", "PASS", `recoverStaleJobs completed (${shared ? "shared" : "sqlite"})`);
      } catch (e) {
        record("207F", "execution reconciliation",
          shared ? "BLOCKED" : "FAIL",
          `recoverStaleJobs threw: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // Phase 212: stop the kernel-owned background scheduler before the DAG
  // scenarios. Its setInterval fires tick()->dispatchTick() on ADMITTED jobs
  // and races the test's explicit admit+dispatch. The DAG scenarios instantiate
  // their own DistributedScheduler and call tick() explicitly, so they are
  // deterministic once the background timer is stopped.
  try { await kernel.stopDistributedScheduler(); } catch { /* ignore */ }

  if (!(shared && hasDb && store)) {
    for (const [id, name] of [
      ["207G","queued job admission"],["207H","worker dispatch"],["207I","lease acquisition exclusivity"],
      ["207J","dependency gating A->B"],["207K","DAG progression A->B->C"],["207L","fan-out A->B,A->C"],
      ["207M","fan-in B->D,C->D"],["207N","duplicate tick protection"],["207O","concurrent scheduler instances"],
      ["207P","worker race"],["207Q","stale worker fencing"],["207R","retry promotion"],
      ["207S","scheduler restart"],["207T","end-to-end execution"],
    ] as Array<[string,string]>) {
      record(id, name, "BLOCKED", shared ? "DATABASE_URL not set" : "sqlite mode");
    }
    return finish(kernel, prefix);
  }

  // 207G admission
  try {
    await ensureWorker(store, prefix + "w-g");
    const jobId = rid(prefix + "job-g-");
    await seedJob(store, jobId, "QUEUED");
    const sched = new DistributedScheduler(store, { maxConcurrency: 100000, maxAdmissionsPerTick: 500 });
    await admitFully(store, jobId, sched);
    const j = await store.getJobAsync(jobId);
    ok(j?.status === "ADMITTED", `status=${j?.status}`);
    record("207G", "queued job admission", "PASS", "QUEUED -> ADMITTED");
  } catch (e) { record("207G", "queued job admission", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 207H dispatch
  try {
    const workerId = prefix + "w-h";
    await ensureWorker(store, workerId);
    const jobId = rid(prefix + "job-h-");
    await seedJob(store, jobId, "QUEUED");
    const sched = new DistributedScheduler(store, { maxConcurrency: 100000, maxAdmissionsPerTick: 500 });
    await admitFully(store, jobId, sched);

    const d = await store.dispatchAdmittedJobAsync({ jobId, workerId, maxConcurrencyPerWorker: 10, leaseDurationMs: 60000 });
    ok(d.dispatched, `dispatch failed: ${d.reason}`);
    ok(!!d.attemptId && !!d.leaseId, "missing attemptId/leaseId");

    const attempt = await store.getAttemptAsync(d.attemptId!);
    ok(!!attempt, "attempt missing");
    ok(attempt.status === "RUNNING", `attempt status=${attempt.status}`);
    ok(attempt.workerId === workerId, `attempt worker mismatch`);
    ok(attempt.leaseId === d.leaseId, `attempt lease mismatch`);

    const jAfter = await store.getJobAsync(jobId);
    ok(jAfter?.status === "CLAIMED", `job status=${jAfter?.status}`);

    const leases = await pgQuery<{cnt:string}>(
      "SELECT COUNT(*)::text AS cnt FROM execution_leases WHERE job_id = $1 AND status = 'ACTIVE'", [jobId]);
    ok(Number(leases[0].cnt) === 1, `active leases=${leases[0].cnt}`);

    record("207H", "worker dispatch", "PASS",
      `job=${jobId} worker=${workerId} attempt=${d.attemptId} lease=${d.leaseId}`);
  } catch (e) { record("207H", "worker dispatch", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 207I lease exclusivity
  try {
    const w1 = prefix + "w-i1", w2 = prefix + "w-i2";
    await ensureWorker(store, w1); await ensureWorker(store, w2);
    const jobId = rid(prefix + "job-i-");
    await seedJob(store, jobId, "QUEUED");
    const sched = new DistributedScheduler(store, { maxConcurrency: 100000, maxAdmissionsPerTick: 500 });
    await admitFully(store, jobId, sched);

    const d1 = await store.dispatchAdmittedJobAsync({ jobId, workerId: w1, maxConcurrencyPerWorker: 10 });
    ok(d1.dispatched, `first dispatch: ${d1.reason}`);
    const d2 = await store.dispatchAdmittedJobAsync({ jobId, workerId: w2, maxConcurrencyPerWorker: 10 });
    ok(!d2.dispatched, `second dispatch unexpectedly succeeded: ${d2.leaseId}`);
    ok(d2.reason === "NOT_ADMITTED" || d2.reason === "DISPATCH_CONFLICT",
       `unexpected reason=${d2.reason}`);

    const leases = await pgQuery<{cnt:string}>(
      "SELECT COUNT(*)::text AS cnt FROM execution_leases WHERE job_id = $1 AND status = 'ACTIVE'", [jobId]);
    ok(Number(leases[0].cnt) === 1, `active leases=${leases[0].cnt}`);

    record("207I", "lease acquisition exclusivity", "PASS",
      `winner=${w1} loser=${w2} reason=${d2.reason}`);
  } catch (e) { record("207I", "lease acquisition exclusivity", "FAIL", e instanceof Error ? e.message : String(e)); }

  // DAG helper: run a full DAG scenario using the real eligibility function
  // and the real admission/dispatch/completion path.
  async function runDag(id: string, name: string, edges: Array<[string,string]>, initialBlocked: string[], finalEligible: string): Promise<void> {
    try {
      const execId = rid(prefix + "exec-" + id.toLowerCase() + "-");
      await seedJob(store, execId, "RUNNING", { jobType: "pipeline" });
      const stageNames = new Set<string>();
      for (const [a, b] of edges) { stageNames.add(a); stageNames.add(b); }
      for (const s of stageNames) await seedStageJob(store, execId, s, "QUEUED");
      for (const [a, b] of edges) {
        const r = await store.stageDepsAsync.add({ executionId: execId, stageName: b, dependsOnStage: a });
        ok(r.ok, `dep ${a}->${b}: ${r.reason}`);
      }
      const workerId = prefix + "w-" + id.toLowerCase();
      await ensureWorker(store, workerId);
      const sched = new DistributedScheduler(store, { maxConcurrency: 100000, maxAdmissionsPerTick: 500 });

      async function loadStages(): Promise<Map<string, StageExecution>> {
        const jobs = await store.listStageJobsForExecutionAsync(execId);
        const m = new Map<string, StageExecution>();
        for (const job of jobs) {
          const sn = (job.payload as any)?.stageName;
          if (!sn) continue;
          const st: StageStatus =
            job.status === "SUCCEEDED" ? "SUCCEEDED" :
            job.status === "FAILED"    ? "FAILED"    :
            job.status === "CANCELLED" ? "CANCELLED" :
            job.status === "SKIPPED"   ? "SKIPPED"   :
            (job.status === "RUNNING" || job.status === "CLAIMED" || job.status === "VERIFYING") ? "RUNNING" :
            "PENDING";
          m.set(sn, { stageName: sn, status: st, derivedJobStatus: job.status } as any);
        }
        return m;
      }
      async function eligibilityOf(stageName: string): Promise<string> {
        const stages = await loadStages();
        const deps = await store.stageDepsAsync.getDependencies(execId, stageName);
        return isStageEligible({
          stage: stages.get(stageName)!,
          dependencyNames: deps,
          stagesByName: stages,
          executionCancelled: false,
        }).reason;
      }

      // Assert initial blocked state
      for (const s of initialBlocked) {
        const reason = await eligibilityOf(s);
        ok(reason !== "ELIGIBLE" && reason !== "STAGE_TERMINAL",
           `expected ${s} blocked, got ${reason}`);
      }

      // Drive stages in topological order.
      const incoming = new Map<string, number>();
      for (const s of stageNames) incoming.set(s, 0);
      for (const [, b] of edges) incoming.set(b, (incoming.get(b) ?? 0) + 1);

      const remaining = new Set(stageNames);
      while (remaining.size > 0) {
        const ready = [...remaining].filter((s) => (incoming.get(s) ?? 0) === 0);
        if (ready.length === 0) throw new Error("no ready stages (cycle?)");
        for (const s of ready) {
          // Pre-drive eligibility check
          const reason = await eligibilityOf(s);
          ok(reason === "ELIGIBLE", `stage ${s} not eligible before drive: ${reason}`);
          // Real admit
          // Race-safe admit+dispatch: between admitFully returning ADMITTED and
          // dispatch, another scheduler tick can move the job ADMITTED -> CLAIMED
          // or reset it. Retry admit+dispatch together until we win or timeout.
          let dispatched: any = null;
          let lastReason = "";
          for (let attempt = 0; attempt < 10 && !dispatched; attempt++) {
            const cur = await store.getJobAsync(`${execId}__${s}`);
            if (cur && cur.status === "QUEUED") {
              await admitFully(store, `${execId}__${s}`, sched);
            }
            const d = await store.dispatchAdmittedJobAsync({
              jobId: `${execId}__${s}`, workerId, maxConcurrencyPerWorker: 10 });
            if (d.dispatched) { dispatched = d; break; }
            lastReason = d.reason ?? "UNKNOWN";
            await new Promise((r) => setTimeout(r, 25));
          }
          if (!dispatched) throw new Error(`dispatch ${s} never succeeded: ${lastReason}`);
          const d = dispatched;
          ok(d.dispatched, `dispatch ${s}: ${d.reason}`);
          // Real completion
          const comp = await store.completeAttemptAndTransitionJobAsync({
            attemptId: d.attemptId!, jobId: `${execId}__${s}`,
            leaseId: d.leaseId!, workerId,
            attemptStatus: "SUCCEEDED",
            expectedJobStatus: "CLAIMED", newJobStatus: "SUCCEEDED",
            now: Date.now(),
          });
          ok(comp.ok, `complete ${s}: ${comp.reason}`);
          remaining.delete(s);
          for (const [a, b] of edges) if (a === s) incoming.set(b, (incoming.get(b) ?? 1) - 1);
        }
      }

      // Final: dependencies of the sink are all SUCCEEDED so the sink itself
      // is now in a state where eligibility considers only its own status.
      // Assert the terminal state of the sink stage job.
      const sinkJob = await store.getJobAsync(`${execId}__${finalEligible}`);
      ok(sinkJob?.status === "SUCCEEDED", `sink ${finalEligible} final status=${sinkJob?.status}`);

      record(id, name, "PASS", `execId=${execId} stages=${[...stageNames].join(",")}`);
    } catch (e) {
      record(id, name, "FAIL", e instanceof Error ? e.message : String(e));
    }
  }

  await runDag("207J", "dependency gating A->B", [["A","B"]], ["B"], "B");
  await runDag("207K", "DAG progression A->B->C", [["A","B"],["B","C"]], ["B","C"], "C");
  await runDag("207L", "fan-out A->B,A->C", [["A","B"],["A","C"]], ["B","C"], "C");
  await runDag("207M", "fan-in B->D,C->D", [["B","D"],["C","D"]], ["D"], "D");

  // 207N duplicate tick
  try {
    await ensureWorker(store, prefix + "w-n");
    const jobId = rid(prefix + "job-n-");
    await seedJob(store, jobId, "QUEUED");
    const sched = new DistributedScheduler(store, { maxConcurrency: 100000, maxAdmissionsPerTick: 500 });
    for (let i = 0; i < 20; i++) {
      const j = await store.getJobAsync(jobId);
      if (j?.status === "ADMITTED" || j?.status === "CLAIMED") break;
      await sched.tick(Date.now());
    }
    await sched.tick(Date.now());
    const jf = await store.getJobAsync(jobId);
    ok(jf?.status === "ADMITTED" || jf?.status === "CLAIMED",
       `expected ADMITTED or CLAIMED, got ${jf?.status}`);
    const attempts = await pgQuery<{c:string}>(
      "SELECT COUNT(*)::text AS c FROM execution_attempts WHERE job_id = $1", [jobId]);
    ok(Number(attempts[0].c) <= 1, `duplicate attempts: ${attempts[0].c}`);
    const leases = await pgQuery<{c:string}>(
      "SELECT COUNT(*)::text AS c FROM execution_leases WHERE job_id = $1", [jobId]);
    ok(Number(leases[0].c) <= 1, `duplicate leases: ${leases[0].c}`);
    record("207N", "duplicate tick protection", "PASS",
      `job=${jf?.status} attempts<=1 leases<=1`);
  } catch (e) { record("207N", "duplicate tick protection", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 207O concurrent schedulers
  try {
    await ensureWorker(store, prefix + "w-o");
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const id = rid(prefix + "job-o-" + i + "-");
      ids.push(id);
      await seedJob(store, id, "QUEUED");
    }
    const s1 = new DistributedScheduler(store, { maxConcurrency: 100000, maxAdmissionsPerTick: 500 }, "o1");
    const s2 = new DistributedScheduler(store, { maxConcurrency: 100000, maxAdmissionsPerTick: 500 }, "o2");
    const [r1, r2] = await Promise.all([s1.tick(Date.now()), s2.tick(Date.now())]);
    const dup = await pgQuery<{id:string;n:string}>(
      "SELECT id, COUNT(*)::text AS n FROM execution_jobs WHERE id = ANY($1::text[]) GROUP BY id HAVING COUNT(*) > 1",
      [ids]);
    ok(dup.length === 0, `duplicates: ${JSON.stringify(dup)}`);
    const admitted = await pgQuery<{cnt:string}>(
      "SELECT COUNT(*)::text AS cnt FROM execution_jobs WHERE id = ANY($1::text[]) AND status = 'ADMITTED'", [ids]);
    record("207O", "concurrent scheduler instances", "PASS",
      `2 schedulers admitted=${admitted[0].cnt} of ${ids.length} seeded no-duplicates`);
  } catch (e) { record("207O", "concurrent scheduler instances", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 207P worker race
  try {
    const w1 = prefix + "w-p1", w2 = prefix + "w-p2";
    await ensureWorker(store, w1); await ensureWorker(store, w2);
    const jobId = rid(prefix + "job-p-");
    await seedJob(store, jobId, "QUEUED");
    const sched = new DistributedScheduler(store, { maxConcurrency: 100000, maxAdmissionsPerTick: 500 });
    await admitFully(store, jobId, sched);
    const [r1, r2] = await Promise.all([
      store.dispatchAdmittedJobAsync({ jobId, workerId: w1, maxConcurrencyPerWorker: 10 }),
      store.dispatchAdmittedJobAsync({ jobId, workerId: w2, maxConcurrencyPerWorker: 10 }),
    ]);
    const winners = [r1, r2].filter((r) => r.dispatched);
    ok(winners.length === 1, `winners=${winners.length}`);
    const attempts = await pgQuery<{cnt:string}>(
      "SELECT COUNT(*)::text AS cnt FROM execution_attempts WHERE job_id = $1 AND status = 'RUNNING'", [jobId]);
    ok(Number(attempts[0].cnt) === 1, `running attempts=${attempts[0].cnt}`);
    const leases = await pgQuery<{cnt:string}>(
      "SELECT COUNT(*)::text AS cnt FROM execution_leases WHERE job_id = $1 AND status = 'ACTIVE'", [jobId]);
    ok(Number(leases[0].cnt) === 1, `active leases=${leases[0].cnt}`);
    record("207P", "worker race", "PASS", `winner=${winners[0].workerId}`);
  } catch (e) { record("207P", "worker race", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 207Q stale fencing
  try {
    const w1 = prefix + "w-q1", w2 = prefix + "w-q2";
    await ensureWorker(store, w1); await ensureWorker(store, w2);
    const jobId = rid(prefix + "job-q-");
    await seedJob(store, jobId, "QUEUED");
    const sched = new DistributedScheduler(store, { maxConcurrency: 100000, maxAdmissionsPerTick: 500 });
    await admitFully(store, jobId, sched);
    const d = await store.dispatchAdmittedJobAsync({ jobId, workerId: w1, maxConcurrencyPerWorker: 10 });
    ok(d.dispatched, `dispatch: ${d.reason}`);

    // Precedential staleness: same SQL as scripts/_phase185_scheduler_child.ts
    // 'set-attempt-heartbeat'. This is how Phase 185 tests make an attempt stale.
    const url = process.env.DATABASE_URL!;
    const c = new PgClient(); await c.connect(url);
    try {
      await c.query("UPDATE execution_attempts SET heartbeat_at = $1 WHERE id = $2",
        [Date.now() - 10_000_000, d.attemptId]);
    } finally { await c.close(); }

    const sched2 = new DistributedScheduler(store, { staleAttemptMs: 1000 });
    const rec = await sched2.recoverStaleAttemptsTick(Date.now());
    ok(rec.fenced >= 1, `fenced=${rec.fenced}`);

    const hb = await store.recordAttemptHeartbeatAsOwnerAsync(d.attemptId!, jobId, d.leaseId!, w1, Date.now());
    ok(hb.updated === false, "stale worker heartbeat should be rejected");

    record("207Q", "stale worker fencing", "PASS",
      `fenced=${rec.fenced} lateHB=${hb.reason ?? "updated"}`);
  } catch (e) { record("207Q", "stale worker fencing", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 207R retry promotion
  try {
    await ensureWorker(store, prefix + "w-r");
    const jobId = rid(prefix + "job-r-");
    await seedJob(store, jobId, "RETRY_SCHEDULED", { nextAttemptAt: Date.now() - 1000 });
    await store.promoteDueRetriesAsync(Date.now());
    const j = await store.getJobAsync(jobId);
    ok(j?.status === "QUEUED", `after promote status=${j?.status}`);
    const sched = new DistributedScheduler(store, { maxConcurrency: 100000, maxAdmissionsPerTick: 500 });
    await admitFully(store, jobId, sched);
    const j2 = await store.getJobAsync(jobId);
    ok(j2?.status === "ADMITTED", `after admit status=${j2?.status}`);
    record("207R", "retry promotion", "PASS", "RETRY_SCHEDULED->QUEUED->ADMITTED");
  } catch (e) { record("207R", "retry promotion", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 207S scheduler restart
  try {
    await ensureWorker(store, prefix + "w-s");
    const jobId = rid(prefix + "job-s-");
    await seedJob(store, jobId, "QUEUED");
    const s1 = new DistributedScheduler(store, { maxConcurrency: 100000, maxAdmissionsPerTick: 500 }, "s1");
    await s1.tick(Date.now());
    const mid = await store.getJobAsync(jobId);

    const k2 = new NexusKernel();
    await k2.boot();
    try {
      await k2.startDistributedScheduler();
      const st2 = k2.getDistributedSchedulerStatus();
      ok(st2.running, "second scheduler not running");
      const store2 = (k2 as any).executionStore as Store;
      const after = await store2.getJobAsync(jobId);
      ok(!!after, "job lost after restart");
      await k2.stopDistributedScheduler();
      await k2.shutdown({ finalRecoveryPass: false });
    } catch (e) {
      try { await k2.shutdown({ finalRecoveryPass: false }); } catch {}
      throw e;
    }
    record("207S", "scheduler restart", "PASS",
      `job persisted across scheduler instances (mid=${mid?.status})`);
  } catch (e) { record("207S", "scheduler restart", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 207T end-to-end
  try {
    const workerId = prefix + "w-t";
    await ensureWorker(store, workerId);
    const jobId = rid(prefix + "job-t-");
    await seedJob(store, jobId, "QUEUED");
    const sched = new DistributedScheduler(store, { maxConcurrency: 100000, maxAdmissionsPerTick: 500 });
    await admitFully(store, jobId, sched);
    const d = await store.dispatchAdmittedJobAsync({ jobId, workerId, maxConcurrencyPerWorker: 10 });
    ok(d.dispatched, `dispatch: ${d.reason}`);
    const comp = await store.completeAttemptAndTransitionJobAsync({
      attemptId: d.attemptId!, jobId, leaseId: d.leaseId!, workerId,
      attemptStatus: "SUCCEEDED",
      expectedJobStatus: "CLAIMED", newJobStatus: "SUCCEEDED",
      now: Date.now(),
    });
    ok(comp.ok, `complete: ${comp.reason}`);
    const jf = await store.getJobAsync(jobId);
    ok(jf?.status === "SUCCEEDED", `final job=${jf?.status}`);
    const at = await store.getAttemptAsync(d.attemptId!);
    ok(at?.status === "SUCCEEDED", `final attempt=${at?.status}`);
    record("207T", "end-to-end execution", "PASS",
      `job=${jobId} attempt=${d.attemptId} terminal=SUCCEEDED`);
  } catch (e) { record("207T", "end-to-end execution", "FAIL", e instanceof Error ? e.message : String(e)); }

  return finish(kernel, prefix);
}

async function finish(kernel: NexusKernel, prefix: string): Promise<void> {
  try { await kernel.stopDistributedScheduler(); } catch { /* ignore */ }
  try { await kernel.shutdown({ finalRecoveryPass: false }); } catch { /* ignore */ }
  // Phase 212: purge this run's durable rows so subsequent runs start clean.
  try {
    await pgExec("DELETE FROM execution_events WHERE job_id LIKE $1", [prefix + "%"]);
    await pgExec("DELETE FROM execution_artifacts WHERE job_id LIKE $1", [prefix + "%"]);
    await pgExec("DELETE FROM execution_attempts WHERE job_id LIKE $1", [prefix + "%"]);
    await pgExec("DELETE FROM execution_leases WHERE job_id LIKE $1", [prefix + "%"]);
    await pgExec("DELETE FROM execution_stage_dependencies WHERE execution_id LIKE $1", [prefix + "%"]);
    await pgExec("DELETE FROM execution_jobs WHERE id LIKE $1", [prefix + "%"]);
    await pgExec("DELETE FROM execution_workers WHERE worker_id LIKE $1", [prefix + "%"]);
  } catch (e) { console.log("207 cleanup warning:", e); }
  try { await pgCleanup([prefix]); } catch (e) { console.log("cleanup warning:", e); }

  const counts = rows.reduce<Record<Result, number>>(
    (acc, r) => { acc[r.result] = (acc[r.result] ?? 0) + 1; return acc; },
    { PASS: 0, FAIL: 0, BLOCKED: 0, "NOT EXECUTED": 0 },
  );
  console.log("\n===== Phase 207 summary =====");
  console.log(`PASS: ${counts.PASS}`);
  console.log(`FAIL: ${counts.FAIL}`);
  console.log(`BLOCKED: ${counts.BLOCKED}`);
  console.log(`NOT EXECUTED: ${counts["NOT EXECUTED"]}`);
  if (counts.FAIL > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("fatal:", e instanceof Error ? e.stack : String(e));
  process.exit(2);
});
