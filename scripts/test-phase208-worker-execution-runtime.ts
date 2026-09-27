// scripts/test-phase208-worker-execution-runtime.ts
// Phase 208 — Production Worker Execution Runtime & Durable Result Contract.
// Drives real ExecutionStore / WorkerRegistry / ExecutionEngine / LeaseManager
// production APIs against shared PostgreSQL. No fake success. No direct
// status mutation. Every scenario reports PASS / FAIL / BLOCKED / NOT EXECUTED.

import { NexusKernel } from "../src/core/kernel";
import { DistributedScheduler } from "../src/core/distributed-scheduler";
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
function rid(p: string): string { return p + Date.now() + "-" + Math.random().toString(36).slice(2, 8); }

type Store = any;

async function ensureWorker(store: Store, workerId: string): Promise<void> {
  const now = Date.now();
  const ex = await store.getWorkerAsync(workerId);
  if (ex) return;
  await store.registerWorkerAsync({
    workerId, hostname: "localhost", status: "ONLINE",
    registeredAt: now, lastHeartbeatAt: now,
  } as any);
}

async function seedJob(store: Store, id: string, status: string, opts: {
  priority?: number; nextAttemptAt?: number | null; jobType?: string;
  payload?: any; createdAt?: number; retryPolicy?: any; timeoutMs?: number;
} = {}): Promise<void> {
  const now = Date.now();
  await store.createJobAsync({
    id, idempotencyKey: "p208-" + id,
    jobType: opts.jobType ?? "engineering",
    payload: opts.payload ?? {},
    status,
    priority: opts.priority ?? -1000000,
    nextAttemptAt: opts.nextAttemptAt ?? null,
    createdAt: opts.createdAt ?? (now - 10_000_000_000),
    updatedAt: now,
    cancellationRequested: false, cancellationAcknowledged: false,
    retryPolicy: opts.retryPolicy,
    timeoutMs: opts.timeoutMs,
  } as any);
}

async function admitFully(store: Store, jobId: string, _sched: DistributedScheduler): Promise<void> {
  // Pure admitNextJobAsync loop. We intentionally do NOT call sched.tick():
  // tick() runs dispatchTick(), which can move the job ADMITTED -> CLAIMED
  // behind the caller's back and cause an intermittent NOT_ADMITTED at dispatch.
  for (let i = 0; i < 500; i++) {
    const j = await store.getJobAsync(jobId);
    if (!j) throw new Error("job not found: " + jobId);
    if (j.status === "ADMITTED" || j.status === "CLAIMED") return;
    if (j.status === "QUEUED") {
      await store.admitNextJobAsync({ owner: "p208", capacityLimit: 100000, now: Date.now() });
      continue;
    }
    throw new Error(`admitFully: unexpected status ${j.status}`);
  }
  throw new Error("admitFully timeout: " + jobId);
}

async function pgExec(sql: string, params: unknown[] = []): Promise<any> {
  const url = process.env.DATABASE_URL!;
  const c = new PgClient(); await c.connect(url);
  try { return await c.query(sql, params); }
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
      await c.query("DELETE FROM execution_jobs WHERE id LIKE $1", [p + "%"]);
      await c.query("DELETE FROM execution_workers WHERE worker_id LIKE $1", [p + "%"]);
    }
  } finally { await c.close(); }
}

async function dispatchToWorker(store: Store, jobId: string, workerId: string): Promise<{
  attemptId: string; leaseId: string;
}> {
  const d = await store.dispatchAdmittedJobAsync({
    jobId, workerId, maxConcurrencyPerWorker: 10, leaseDurationMs: 60000,
  });
  if (!d.dispatched || !d.attemptId || !d.leaseId) {
    throw new Error(`dispatch failed: ${d.reason}`);
  }
  return { attemptId: d.attemptId, leaseId: d.leaseId };
}

async function main(): Promise<void> {
  const shared = (process.env.NEXUS_PERSISTENCE_MODE ?? "sqlite").toLowerCase() === "shared";
  const hasDb = !!process.env.DATABASE_URL;
  const prefix = "phase208-" + Date.now() + "-";
  console.log(`mode=${shared ? "shared" : "sqlite"} databaseUrl=${hasDb ? "set" : "unset"} prefix=${prefix}`);

  const kernel = new NexusKernel();
  try {
    await kernel.boot();
    record("208A", "execution runtime initialization", "PASS", `kernel.boot() ok (${shared ? "shared" : "sqlite"})`);
  } catch (e) {
    record("208A", "execution runtime initialization", "FAIL", e instanceof Error ? e.message : String(e));
    return finish(kernel, prefix);
  }

  const store = (kernel as any).executionStore as Store | undefined;
  if (!shared || !hasDb || !store) {
    const reason = !shared ? "sqlite mode" : !hasDb ? "DATABASE_URL not set" : "no executionStore";
    for (const [id, name] of [
      ["208B","worker-owned execution"],["208C","heartbeat durability"],["208D","progress durability"],
      ["208E","successful completion"],["208F","failed completion"],["208G","cancellation"],
      ["208H","result persistence"],["208I","artifact persistence"],["208J","completion idempotency"],
      ["208K","concurrent completion race"],["208L","stale worker completion rejection"],
      ["208M","timeout detection"],["208N","late completion after timeout rejection"],
      ["208O","retry after execution failure"],["208P","retry creates new attempt"],
      ["208Q","restart durability"],["208R","reconciliation after worker/process failure"],
      ["208S","concurrent recovery/completion race"],["208T","end-to-end execution lifecycle"],
    ] as Array<[string,string]>) {
      record(id, name, "BLOCKED", reason);
    }
    return finish(kernel, prefix);
  }

  const sched = new DistributedScheduler(store, { maxConcurrency: 100000, maxAdmissionsPerTick: 500 });

  // ---- 208B worker-owned execution ----
  let bAttemptId = "", bLeaseId = "", bJobId = "";
  try {
    const w = prefix + "w-b";
    await ensureWorker(store, w);
    bJobId = rid(prefix + "job-b-");
    await seedJob(store, bJobId, "QUEUED");
    await admitFully(store, bJobId, sched);
    const r = await dispatchToWorker(store, bJobId, w);
    bAttemptId = r.attemptId; bLeaseId = r.leaseId;

    const j = await store.getJobAsync(bJobId);
    const a = await store.getAttemptAsync(bAttemptId);
    const leases = await pgExec(
      "SELECT worker_id, status FROM execution_leases WHERE lease_id = $1", [bLeaseId]);
    ok(j?.status === "CLAIMED", `job status=${j?.status}`);
    ok(a?.status === "RUNNING", `attempt status=${a?.status}`);
    ok(a?.workerId === w, `attempt worker mismatch`);
    ok(a?.leaseId === bLeaseId, `attempt lease mismatch`);
    ok(leases.rows[0]?.status === "ACTIVE", `lease status=${leases.rows[0]?.status}`);
    ok(leases.rows[0]?.worker_id === w, `lease worker mismatch`);
    record("208B", "worker-owned execution", "PASS", `job=CLAIMED attempt=RUNNING lease=ACTIVE`);
  } catch (e) { record("208B", "worker-owned execution", "FAIL", e instanceof Error ? e.message : String(e)); }

  // ---- 208C heartbeat durability ----
  try {
    ok(!!bAttemptId, "208B prerequisite missing");
    const before = await store.getAttemptAsync(bAttemptId);
    const t0 = Date.now() + 500;
    const r = await store.recordAttemptHeartbeatAsOwnerAsync(bAttemptId, bJobId, bLeaseId, prefix + "w-b", t0);
    ok(r.updated === true, `heartbeat rejected: ${r.reason}`);
    const after = await store.getAttemptAsync(bAttemptId);
    ok(after.heartbeatAt >= t0, `heartbeatAt did not advance: ${before?.heartbeatAt} -> ${after?.heartbeatAt}`);
    const j = await store.getJobAsync(bJobId);
    ok(j?.status === "CLAIMED", `job changed unexpectedly to ${j?.status}`);
    record("208C", "heartbeat durability", "PASS", `attempt.heartbeatAt advanced`);
  } catch (e) { record("208C", "heartbeat durability", "FAIL", e instanceof Error ? e.message : String(e)); }

  // ---- 208D progress durability ----
  try {
    ok(!!bAttemptId, "208B prerequisite missing");
    const t0 = Date.now() + 500;
    const r = await store.recordAttemptProgressAsOwnerAsync(bAttemptId, bJobId, bLeaseId, prefix + "w-b", t0);
    ok(r.updated === true, `progress rejected: ${r.reason}`);
    const row = await pgExec("SELECT last_progress_at FROM execution_attempts WHERE id = $1", [bAttemptId]);
    const persisted = Number(row.rows[0]?.last_progress_at);
    ok(Number.isFinite(persisted) && persisted >= t0,
       `last_progress_at not persisted: ${row.rows[0]?.last_progress_at}`);
    record("208D", "progress durability", "PASS", `last_progress_at=${persisted}`);
  } catch (e) { record("208D", "progress durability", "FAIL", e instanceof Error ? e.message : String(e)); }

  // ---- 208E successful completion (uses the attempt opened by 208B) ----
  try {
    ok(!!bAttemptId, "208B prerequisite missing");
    const r = await store.completeAttemptAndTransitionJobAsync({
      attemptId: bAttemptId, jobId: bJobId, leaseId: bLeaseId, workerId: prefix + "w-b",
      attemptStatus: "SUCCEEDED",
      expectedJobStatus: "CLAIMED", newJobStatus: "SUCCEEDED",
      now: Date.now(),
    });
    ok(r.ok, `complete rejected: ${r.reason}`);
    const j = await store.getJobAsync(bJobId);
    const a = await store.getAttemptAsync(bAttemptId);
    ok(j?.status === "SUCCEEDED", `job=${j?.status}`);
    ok(a?.status === "SUCCEEDED", `attempt=${a?.status}`);
    const leases = await pgExec(
      "SELECT COUNT(*)::text AS c FROM execution_leases WHERE job_id = $1 AND status = 'ACTIVE'", [bJobId]);
    ok(Number(leases.rows[0].c) === 0, `active leases remain: ${leases.rows[0].c}`);
    record("208E", "successful completion", "PASS", `job=SUCCEEDED attempt=SUCCEEDED no-active-lease`);
  } catch (e) { record("208E", "successful completion", "FAIL", e instanceof Error ? e.message : String(e)); }

  // ---- 208F failed completion ----
  try {
    const w = prefix + "w-f";
    await ensureWorker(store, w);
    const jobId = rid(prefix + "job-f-");
    await seedJob(store, jobId, "QUEUED");
    await admitFully(store, jobId, sched);
    const { attemptId, leaseId } = await dispatchToWorker(store, jobId, w);
    const r = await store.completeAttemptAndTransitionJobAsync({
      attemptId, jobId, leaseId, workerId: w,
      attemptStatus: "FAILED", attemptError: "phase208 synthetic failure",
      expectedJobStatus: "CLAIMED", newJobStatus: "FAILED",
      now: Date.now(),
    });
    ok(r.ok, `complete failed: ${r.reason}`);
    const j = await store.getJobAsync(jobId);
    const a = await store.getAttemptAsync(attemptId);
    ok(j?.status === "FAILED", `job=${j?.status}`);
    ok(a?.status === "FAILED", `attempt=${a?.status}`);
    ok(a?.error === "phase208 synthetic failure", `error=${a?.error}`);
    record("208F", "failed completion", "PASS", `job=FAILED attempt=FAILED error persisted`);
  } catch (e) { record("208F", "failed completion", "FAIL", e instanceof Error ? e.message : String(e)); }

  // ---- 208G cancellation ----
  try {
    const w = prefix + "w-g";
    await ensureWorker(store, w);
    const jobId = rid(prefix + "job-g-");
    await seedJob(store, jobId, "QUEUED");
    await admitFully(store, jobId, sched);
    const { attemptId, leaseId } = await dispatchToWorker(store, jobId, w);
    const r = await store.completeAttemptAndTransitionJobAsync({
      attemptId, jobId, leaseId, workerId: w,
      attemptStatus: "CANCELLED",
      expectedJobStatus: "CLAIMED", newJobStatus: "CANCELLED",
      now: Date.now(),
    });
    ok(r.ok, `cancel rejected: ${r.reason}`);
    const j = await store.getJobAsync(jobId);
    const a = await store.getAttemptAsync(attemptId);
    ok(j?.status === "CANCELLED", `job=${j?.status}`);
    ok(a?.status === "CANCELLED", `attempt=${a?.status}`);
    record("208G", "cancellation", "PASS", `job=CANCELLED attempt=CANCELLED`);
  } catch (e) { record("208G", "cancellation", "FAIL", e instanceof Error ? e.message : String(e)); }

  // ---- 208H result persistence ----
  try {
    const w = prefix + "w-h";
    await ensureWorker(store, w);
    const jobId = rid(prefix + "job-h-");
    await seedJob(store, jobId, "QUEUED");
    await admitFully(store, jobId, sched);
    const { attemptId, leaseId } = await dispatchToWorker(store, jobId, w);

    // Durable result contract in shared mode: getAttemptResultAsync returns
    // attempt + job + provenance + artifacts from the async backend.
    const r = await store.completeAttemptAndTransitionJobAsync({
      attemptId, jobId, leaseId, workerId: w,
      attemptStatus: "SUCCEEDED",
      attemptEvidence: ["phase208 evidence"],
      expectedJobStatus: "CLAIMED", newJobStatus: "SUCCEEDED",
      now: Date.now(),
    });
    ok(r.ok, `completion rejected: ${r.reason}`);

    const durable = await store.getAttemptResultAsync(attemptId);
    ok(!!durable, "getAttemptResultAsync returned null");
    ok(durable.attempt.status === "SUCCEEDED", `durable attempt=${durable.attempt.status}`);
    ok(durable.job.status === "SUCCEEDED", `durable job=${durable.job.status}`);
    ok(durable.provenance !== null, "durable provenance missing");

    const execResult = await store.getExecutionResultAsync(jobId);
    ok(!!execResult, "getExecutionResultAsync returned null");
    ok(execResult.job.status === "SUCCEEDED", `exec result job=${execResult.job.status}`);

    record("208H", "result persistence", "PASS",
      `attempt=${attemptId} provenance=${durable.provenance!.provenanceId} outcome=${durable.provenance!.outcome}`);
  } catch (e) { record("208H", "result persistence", "FAIL", e instanceof Error ? e.message : String(e)); }

  // ---- 208I artifact persistence ----
  try {
    const w = prefix + "w-i";
    await ensureWorker(store, w);
    const jobId = rid(prefix + "job-i-");
    await seedJob(store, jobId, "QUEUED");
    await admitFully(store, jobId, sched);
    const { attemptId, leaseId } = await dispatchToWorker(store, jobId, w);
    const r = await store.completeAttemptAndTransitionJobAsync({
      attemptId, jobId, leaseId, workerId: w,
      attemptStatus: "SUCCEEDED",
      expectedJobStatus: "CLAIMED", newJobStatus: "SUCCEEDED",
      now: Date.now(),
      artifacts: [{
        artifactId: "art-" + jobId, jobId, attemptId,
        name: "phase208.log", type: "LOG",
        checksum: "sha256:deadbeef", sizeBytes: 42,
        createdAt: Date.now(),
      }],
    });
    ok(r.ok, `completion with artifact rejected: ${r.reason}`);
    const arts = await store.listAttemptArtifactsAsync(attemptId);
    ok(arts.length === 1 && arts[0].attemptId === attemptId,
       `expected 1 artifact bound to attempt, got ${arts.length}`);
    record("208I", "artifact persistence", "PASS", `artifactId=${arts[0].artifactId} bound to attempt`);
  } catch (e) { record("208I", "artifact persistence", "FAIL", e instanceof Error ? e.message : String(e)); }

  // ---- 208J completion idempotency ----
  try {
    const w = prefix + "w-j";
    await ensureWorker(store, w);
    const jobId = rid(prefix + "job-j-");
    await seedJob(store, jobId, "QUEUED");
    await admitFully(store, jobId, sched);
    const { attemptId, leaseId } = await dispatchToWorker(store, jobId, w);
    const r1 = await store.completeAttemptAndTransitionJobAsync({
      attemptId, jobId, leaseId, workerId: w,
      attemptStatus: "SUCCEEDED",
      expectedJobStatus: "CLAIMED", newJobStatus: "SUCCEEDED",
      now: Date.now(),
    });
    const r2 = await store.completeAttemptAndTransitionJobAsync({
      attemptId, jobId, leaseId, workerId: w,
      attemptStatus: "SUCCEEDED",
      expectedJobStatus: "CLAIMED", newJobStatus: "SUCCEEDED",
      now: Date.now(),
    });
    ok(r1.ok, `first completion failed: ${r1.reason}`);
    ok(r2.ok, `second completion threw: ${r2.reason}`);
    ok(r2.idempotent === true || r2.applied === false,
       `second completion not idempotent: ${JSON.stringify(r2)}`);
    const evts = await pgExec(
      "SELECT COUNT(*)::text AS c FROM execution_events WHERE job_id = $1 AND event_type IN ('execution.completed','execution.failed','execution.cancelled')",
      [jobId]);
    ok(Number(evts.rows[0].c) <= 1, `duplicate terminal event: ${evts.rows[0].c}`);
    record("208J", "completion idempotency", "PASS", `second=${r2.idempotent ? "idempotent" : "no-op"}`);
  } catch (e) { record("208J", "completion idempotency", "FAIL", e instanceof Error ? e.message : String(e)); }

  // ---- 208K concurrent completion race ----
  try {
    const w = prefix + "w-k";
    await ensureWorker(store, w);
    const jobId = rid(prefix + "job-k-");
    await seedJob(store, jobId, "QUEUED");
    await admitFully(store, jobId, sched);
    const { attemptId, leaseId } = await dispatchToWorker(store, jobId, w);
    const [a, b] = await Promise.all([
      store.completeAttemptAndTransitionJobAsync({
        attemptId, jobId, leaseId, workerId: w,
        attemptStatus: "SUCCEEDED",
        expectedJobStatus: "CLAIMED", newJobStatus: "SUCCEEDED", now: Date.now(),
      }),
      store.completeAttemptAndTransitionJobAsync({
        attemptId, jobId, leaseId, workerId: w,
        attemptStatus: "SUCCEEDED",
        expectedJobStatus: "CLAIMED", newJobStatus: "SUCCEEDED", now: Date.now(),
      }),
    ]);
    const appliedCount = [a, b].filter((r) => r.applied === true).length;
    ok(appliedCount === 1, `applied=${appliedCount} (expected exactly 1)`);
    ok(a.ok && b.ok, `one threw: ${a.reason ?? ""} ${b.reason ?? ""}`);
    const evts = await pgExec(
      "SELECT COUNT(*)::text AS c FROM execution_events WHERE job_id = $1 AND event_type IN ('execution.transition.succeeded','execution.transition.failed')",
      [jobId]);
    ok(Number(evts.rows[0].c) === 1, `terminal events=${evts.rows[0].c}`);
    record("208K", "concurrent completion race", "PASS", `applied=1 terminal-events=1`);
  } catch (e) { record("208K", "concurrent completion race", "FAIL", e instanceof Error ? e.message : String(e)); }

  // ---- 208L stale worker completion rejection ----
  try {
    const w = prefix + "w-l";
    await ensureWorker(store, w);
    const jobId = rid(prefix + "job-l-");
    await seedJob(store, jobId, "QUEUED");
    await admitFully(store, jobId, sched);
    const { attemptId, leaseId } = await dispatchToWorker(store, jobId, w);
    await pgExec("UPDATE execution_attempts SET heartbeat_at = $1 WHERE id = $2",
      [Date.now() - 10_000_000, attemptId]);
    const s2 = new DistributedScheduler(store, { staleAttemptMs: 1000 });
    const rec = await s2.recoverStaleAttemptsTick(Date.now());
    ok(rec.fenced >= 1, `fenced=${rec.fenced}`);
    const r = await store.completeAttemptAndTransitionJobAsync({
      attemptId, jobId, leaseId, workerId: w,
      attemptStatus: "SUCCEEDED",
      expectedJobStatus: "CLAIMED", newJobStatus: "SUCCEEDED", now: Date.now(),
    });
    ok(r.ok === false, `stale completion unexpectedly succeeded`);
    ok(r.reason === "WORKER_OWNERSHIP_LOST" || r.reason === "ATTEMPT_STATE_MISMATCH" ||
       r.reason === "STATE_MISMATCH" || r.reason === "TERMINAL_STATE",
       `unexpected reason=${r.reason}`);
    record("208L", "stale worker completion rejection", "PASS", `fenced=${rec.fenced} rejection=${r.reason}`);
  } catch (e) { record("208L", "stale worker completion rejection", "FAIL", e instanceof Error ? e.message : String(e)); }

  // ---- 208M timeout detection ----
  try {
    const w = prefix + "w-m";
    await ensureWorker(store, w);
    const jobId = rid(prefix + "job-m-");
    await seedJob(store, jobId, "QUEUED", { timeoutMs: 50 });
    await admitFully(store, jobId, sched);
    const { attemptId } = await dispatchToWorker(store, jobId, w);
    await pgExec("UPDATE execution_attempts SET heartbeat_at = $1 WHERE id = $2",
      [Date.now() - 10_000_000, attemptId]);
    const s2 = new DistributedScheduler(store, { staleAttemptMs: 1000 });
    const rec = await s2.recoverStaleAttemptsTick(Date.now());
    ok(rec.fenced >= 1, `timeout not detected: fenced=${rec.fenced}`);
    const a = await store.getAttemptAsync(attemptId);
    ok(a?.status !== "RUNNING", `attempt still RUNNING after timeout`);
    record("208M", "timeout detection", "PASS", `fenced=${rec.fenced} attempt=${a?.status}`);
  } catch (e) { record("208M", "timeout detection", "FAIL", e instanceof Error ? e.message : String(e)); }

  // ---- 208N late completion after timeout rejection ----
  try {
    const w = prefix + "w-n";
    await ensureWorker(store, w);
    const jobId = rid(prefix + "job-n-");
    await seedJob(store, jobId, "QUEUED");
    await admitFully(store, jobId, sched);
    const { attemptId, leaseId } = await dispatchToWorker(store, jobId, w);
    await pgExec("UPDATE execution_attempts SET heartbeat_at = $1 WHERE id = $2",
      [Date.now() - 10_000_000, attemptId]);
    const s2 = new DistributedScheduler(store, { staleAttemptMs: 1000 });
    await s2.recoverStaleAttemptsTick(Date.now());
    const r = await store.completeAttemptAndTransitionJobAsync({
      attemptId, jobId, leaseId, workerId: w,
      attemptStatus: "SUCCEEDED",
      expectedJobStatus: "CLAIMED", newJobStatus: "SUCCEEDED", now: Date.now(),
    });
    ok(r.ok === false, `late completion after timeout unexpectedly succeeded`);
    record("208N", "late completion after timeout rejection", "PASS", `rejection=${r.reason}`);
  } catch (e) { record("208N", "late completion after timeout rejection", "FAIL", e instanceof Error ? e.message : String(e)); }

  // ---- 208O retry after execution failure ----
  try {
    const w = prefix + "w-o";
    await ensureWorker(store, w);
    const jobId = rid(prefix + "job-o-");
    await seedJob(store, jobId, "QUEUED", {
      retryPolicy: { maxAttempts: 3, initialDelayMs: 10, multiplier: 1, maxDelayMs: 100 },
    });
    await admitFully(store, jobId, sched);
    const { attemptId, leaseId } = await dispatchToWorker(store, jobId, w);
    const r = await store.completeAttemptAndTransitionJobAsync({
      attemptId, jobId, leaseId, workerId: w,
      attemptStatus: "FAILED", attemptError: "phase208 retryable failure",
      expectedJobStatus: "CLAIMED", newJobStatus: "RETRY_SCHEDULED",
      patch: { nextAttemptAt: Date.now() - 1000 },
      now: Date.now(),
    });
    ok(r.ok, `retry completion rejected: ${r.reason}`);
    const j = await store.getJobAsync(jobId);
    ok(j?.status === "RETRY_SCHEDULED", `job after failure=${j?.status}`);
    await store.promoteDueRetriesAsync(Date.now());
    const j2 = await store.getJobAsync(jobId);
    ok(j2?.status === "QUEUED", `after promote=${j2?.status}`);
    record("208O", "retry after execution failure", "PASS", `CLAIMED->FAILED->RETRY_SCHEDULED->QUEUED`);
  } catch (e) { record("208O", "retry after execution failure", "FAIL", e instanceof Error ? e.message : String(e)); }

  // ---- 208P retry creates new attempt ----
  try {
    const w = prefix + "w-p";
    await ensureWorker(store, w);
    const jobId = rid(prefix + "job-p-");
    await seedJob(store, jobId, "QUEUED", {
      retryPolicy: { maxAttempts: 3, initialDelayMs: 10, multiplier: 1, maxDelayMs: 100 },
    });
    await admitFully(store, jobId, sched);
    const r1 = await dispatchToWorker(store, jobId, w);
    await store.completeAttemptAndTransitionJobAsync({
      attemptId: r1.attemptId, jobId, leaseId: r1.leaseId, workerId: w,
      attemptStatus: "FAILED", attemptError: "attempt 1 failed",
      expectedJobStatus: "CLAIMED", newJobStatus: "RETRY_SCHEDULED",
      patch: { nextAttemptAt: Date.now() - 1000 },
      now: Date.now(),
    });
    await store.promoteDueRetriesAsync(Date.now());
    await admitFully(store, jobId, sched);
    const r2 = await dispatchToWorker(store, jobId, w);
    ok(r2.attemptId !== r1.attemptId, `attempt reuse: ${r2.attemptId}`);
    const a1 = await store.getAttemptAsync(r1.attemptId);
    const a2 = await store.getAttemptAsync(r2.attemptId);
    ok(a1?.attemptNumber === 1, `a1 number=${a1?.attemptNumber}`);
    ok(a2?.attemptNumber === 2, `a2 number=${a2?.attemptNumber}`);
    record("208P", "retry creates new attempt", "PASS", `attempt#1=${a1?.attemptNumber} attempt#2=${a2?.attemptNumber}`);
  } catch (e) { record("208P", "retry creates new attempt", "FAIL", e instanceof Error ? e.message : String(e)); }

  // ---- 208Q restart durability ----
  try {
    const w = prefix + "w-q";
    await ensureWorker(store, w);
    const jobId = rid(prefix + "job-q-");
    await seedJob(store, jobId, "QUEUED");
    await admitFully(store, jobId, sched);
    const { attemptId } = await dispatchToWorker(store, jobId, w);

    const k2 = new NexusKernel();
    await k2.boot();
    try {
      const store2 = (k2 as any).executionStore as Store;
      const j2 = await store2.getJobAsync(jobId);
      const a2 = await store2.getAttemptAsync(attemptId);
      ok(j2?.status === "CLAIMED", `after restart job=${j2?.status}`);
      ok(a2?.status === "RUNNING", `after restart attempt=${a2?.status}`);
    } finally {
      await k2.shutdown({ finalRecoveryPass: false });
    }
    record("208Q", "restart durability", "PASS", `job=CLAIMED attempt=RUNNING after new kernel`);
  } catch (e) { record("208Q", "restart durability", "FAIL", e instanceof Error ? e.message : String(e)); }

  // ---- 208R reconciliation after worker/process failure ----
  try {
    const w = prefix + "w-r";
    await ensureWorker(store, w);
    const jobId = rid(prefix + "job-r-");
    await seedJob(store, jobId, "QUEUED");
    await admitFully(store, jobId, sched);
    const { attemptId } = await dispatchToWorker(store, jobId, w);
    await pgExec("UPDATE execution_attempts SET heartbeat_at = $1 WHERE id = $2",
      [Date.now() - 10_000_000, attemptId]);
    const s2 = new DistributedScheduler(store, { staleAttemptMs: 1000 });
    const rec = await s2.recoverStaleAttemptsTick(Date.now());
    ok(rec.fenced >= 1, `fenced=${rec.fenced}`);
    const a = await store.getAttemptAsync(attemptId);
    ok(a?.status !== "RUNNING", `attempt still RUNNING after recovery`);
    record("208R", "reconciliation after worker/process failure", "PASS", `attempt=${a?.status}`);
  } catch (e) { record("208R", "reconciliation after worker/process failure", "FAIL", e instanceof Error ? e.message : String(e)); }

  // ---- 208S concurrent recovery/completion race ----
  try {
    const w = prefix + "w-s";
    await ensureWorker(store, w);
    const jobId = rid(prefix + "job-s-");
    await seedJob(store, jobId, "QUEUED");
    await admitFully(store, jobId, sched);
    // Robust admit+dispatch: re-admit if the state drifted, retry dispatch.
    let dispatched: { attemptId: string; leaseId: string } | null = null;
    let lastReason = "";
    for (let i = 0; i < 5 && !dispatched; i++) {
      const cur = await store.getJobAsync(jobId);
      if (cur?.status === "QUEUED") await admitFully(store, jobId, sched);
      const d = await store.dispatchAdmittedJobAsync({
        jobId, workerId: w, maxConcurrencyPerWorker: 10, leaseDurationMs: 60000,
      });
      if (d.dispatched && d.attemptId && d.leaseId) {
        dispatched = { attemptId: d.attemptId, leaseId: d.leaseId };
      } else {
        lastReason = d.reason ?? "UNKNOWN";
        await new Promise((res) => setTimeout(res, 50));
      }
    }
    if (!dispatched) throw new Error("208S dispatch never succeeded: " + lastReason);
    const attemptId = dispatched.attemptId;
    const leaseId = dispatched.leaseId;
    const engine = (kernel as any).executionEngine;
    const [, comp] = await Promise.all([
      engine.recoverStaleJobs(Date.now()),
      store.completeAttemptAndTransitionJobAsync({
        attemptId, jobId, leaseId, workerId: w,
        attemptStatus: "SUCCEEDED",
        expectedJobStatus: "CLAIMED", newJobStatus: "SUCCEEDED", now: Date.now(),
      }),
    ]);
    const j = await store.getJobAsync(jobId);
    const a = await store.getAttemptAsync(attemptId);
    const compatible =
      (j?.status === "SUCCEEDED" && a?.status === "SUCCEEDED") ||
      (j?.status === "CLAIMED" && a?.status === "RUNNING") ||
      (a?.status === "FAILED") || (a?.status === "ORPHANED");
    ok(compatible, `inconsistent: job=${j?.status} attempt=${a?.status} comp=${comp.reason ?? "ok"}`);
    record("208S", "concurrent recovery/completion race", "PASS",
      `job=${j?.status} attempt=${a?.status} consistent`);
  } catch (e) { record("208S", "concurrent recovery/completion race", "FAIL", e instanceof Error ? e.message : String(e)); }

  // ---- 208T end-to-end execution lifecycle ----
  try {
    const w = prefix + "w-t";
    await ensureWorker(store, w);
    const jobId = rid(prefix + "job-t-");
    await seedJob(store, jobId, "QUEUED");
    await admitFully(store, jobId, sched);
    const { attemptId, leaseId } = await dispatchToWorker(store, jobId, w);

    await store.recordAttemptHeartbeatAsOwnerAsync(attemptId, jobId, leaseId, w, Date.now());
    await store.recordAttemptProgressAsOwnerAsync(attemptId, jobId, leaseId, w, Date.now());

    const r = await store.completeAttemptAndTransitionJobAsync({
      attemptId, jobId, leaseId, workerId: w,
      attemptStatus: "SUCCEEDED",
      attemptEvidence: ["phase208 e2e evidence"],
      expectedJobStatus: "CLAIMED", newJobStatus: "SUCCEEDED",
      now: Date.now(),
      artifacts: [{
        artifactId: "art-" + jobId, jobId, attemptId,
        name: "phase208-e2e.txt", type: "LOG",
        checksum: "sha256:cafebabe", sizeBytes: 11, createdAt: Date.now(),
      }],
    });
    ok(r.ok, `completion rejected: ${r.reason}`);

    const j = await store.getJobAsync(jobId);
    const a = await store.getAttemptAsync(attemptId);
    const durable = await store.getAttemptResultAsync(attemptId);
    const execResult = await store.getExecutionResultAsync(jobId);
    const arts = await store.listAttemptArtifactsAsync(attemptId);
    const leases = await pgExec(
      "SELECT COUNT(*)::text AS c FROM execution_leases WHERE job_id = $1 AND status = 'ACTIVE'", [jobId]);

    ok(j?.status === "SUCCEEDED", `job=${j?.status}`);
    ok(a?.status === "SUCCEEDED", `attempt=${a?.status}`);
    ok(!!durable && durable.provenance !== null, `durable provenance missing`);
    ok(!!execResult && execResult.job.status === "SUCCEEDED", `exec result missing`);
    ok(arts.length === 1, `artifacts=${arts.length}`);
    ok(Number(leases.rows[0].c) === 0, `active leases=${leases.rows[0].c}`);

    record("208T", "end-to-end execution lifecycle", "PASS",
      `job=SUCCEEDED attempt=SUCCEEDED provenance=${durable!.provenance!.provenanceId} artifacts=1 no-active-lease`);
  } catch (e) { record("208T", "end-to-end execution lifecycle", "FAIL", e instanceof Error ? e.message : String(e)); }

  return finish(kernel, prefix);
}

async function finish(kernel: NexusKernel, prefix: string): Promise<void> {
  try { await kernel.stopDistributedScheduler(); } catch { /* ignore */ }
  try { await kernel.shutdown({ finalRecoveryPass: false }); } catch { /* ignore */ }
  try { await pgCleanup([prefix]); } catch (e) { console.log("cleanup warning:", e); }

  const counts = rows.reduce<Record<Result, number>>(
    (acc, r) => { acc[r.result] = (acc[r.result] ?? 0) + 1; return acc; },
    { PASS: 0, FAIL: 0, BLOCKED: 0, "NOT EXECUTED": 0 },
  );
  console.log("\n===== Phase 208 summary =====");
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
