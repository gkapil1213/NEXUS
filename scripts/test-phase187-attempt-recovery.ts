import Database from "better-sqlite3";
import { PgClient } from "../src/core/pg-client";
import { PgAsyncEngine } from "../src/core/pg-async-engine";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { DistributedScheduler } from "../src/core/distributed-scheduler";

let passed = 0;
let failed = 0;

function ok(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log("  ok   " + message);
  } else {
    failed++;
    console.log("  FAIL " + message);
  }
}

function section(title: string): void {
  console.log("\n" + title);
}

function mkJob(id: string, retry = true): any {
  const now = Date.now();
  return {
    id,
    idempotencyKey: "p187-" + id,
    jobType: "engineering",
    payload: { kind: "phase187-test" },
    status: "RUNNING",
    createdAt: now,
    updatedAt: now,
    cancellationRequested: false,
    cancellationAcknowledged: false,
    retryPolicy: retry ? { maxAttempts: 3 } : undefined,
  };
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL required");
    process.exit(2);
  }

  const pg = new PgClient();
  await pg.connect(url);

  const asyncDb = new PgAsyncEngine(pg);
  const mem = new Database(":memory:");
  const syncEngine = SQLiteEngine.fromDatabase(mem);
  const store = new ExecutionStore(syncEngine, asyncDb);

  const scheduler = new DistributedScheduler(
    store,
    {
      staleAttemptMs: 1_000,
      maxConcurrency: 4,
      maxAdmissionsPerTick: 16,
      agingMs: 60_000,
      admissionTtlMs: 60_000,
      maxDispatchesPerTick: 16,
      maxConcurrencyPerWorker: 1,
      dispatchLeaseDurationMs: 60_000,
    },
    "phase187-test-scheduler",
  );

  const stamp = Date.now();

  // ============================================================
  // B01-B05 heartbeat
  // ============================================================
  section("B01-B05 - durable attempt heartbeat");

  {
    const jobId = `p187-job-b-${stamp}`;
    const attemptId = `p187-attempt-b-${stamp}`;
    const leaseId = `p187-lease-b-${stamp}`;
    const workerId = `p187-worker-b-${stamp}`;
    const now = Date.now();

    await store.createJobAsync(mkJob(jobId));

    await pg.query(
      "INSERT INTO execution_leases " +
      "(lease_id, job_id, worker_id, acquired_at, expires_at, status) " +
      "VALUES ($1,$2,$3,$4,$5,'ACTIVE')",
      [leaseId, jobId, workerId, now, now + 60_000],
    );

    await store.createAttemptAsync({
      id: attemptId,
      jobId,
      attemptNumber: 1,
      status: "RUNNING",
      createdAt: now,
      startedAt: now,
      workerId,
      leaseId,
    } as any);

    const heartbeatAt = now + 100;

    const hb = await store.attemptHeartbeatAsync({
      attemptId,
      jobId,
      workerId,
      leaseId,
      ttlMs: 60_000,
      now: heartbeatAt,
    });

    ok(hb.ok === true, "B01 valid attempt heartbeat accepted");

    const dbAttempt = await pg.query<{
      heartbeat_at: string | number | null;
      status: string;
    }>(
      "SELECT heartbeat_at, status FROM execution_attempts WHERE id=$1",
      [attemptId],
    );

    ok(
      Number(dbAttempt.rows[0]?.heartbeat_at) === heartbeatAt,
      "B02 heartbeat_at persisted in PostgreSQL",
    );

    ok(
      dbAttempt.rows[0]?.status === "RUNNING",
      "B03 heartbeat leaves attempt RUNNING",
    );

    const dbLease = await pg.query<{
      renewed_at: string | number | null;
      expires_at: string | number | null;
      status: string;
    }>(
      "SELECT renewed_at, expires_at, status FROM execution_leases WHERE lease_id=$1",
      [leaseId],
    );

    ok(
      Number(dbLease.rows[0]?.renewed_at) === heartbeatAt &&
      Number(dbLease.rows[0]?.expires_at) === heartbeatAt + 60_000,
      "B04 heartbeat renews the same lease atomically",
    );

    const wrongWorker = await store.attemptHeartbeatAsync({
      attemptId,
      jobId,
      workerId: workerId + "-wrong",
      leaseId,
      now: heartbeatAt + 100,
    });

    ok(
      wrongWorker.ok === false &&
      wrongWorker.reason === "WORKER_OWNERSHIP_LOST",
      "B05 wrong worker cannot heartbeat attempt",
    );
  }

  // ============================================================
  // B06-B10 stale detection
  // ============================================================
  section("B06-B10 - stale detection");

  {
    const jobId = `p187-job-stale-${stamp}`;
    const attemptId = `p187-attempt-stale-${stamp}`;
    const leaseId = `p187-lease-stale-${stamp}`;
    const workerId = `p187-worker-stale-${stamp}`;
    const now = Date.now();

    await store.createJobAsync(mkJob(jobId));

    await pg.query(
      "INSERT INTO execution_leases " +
      "(lease_id, job_id, worker_id, acquired_at, expires_at, status) " +
      "VALUES ($1,$2,$3,$4,$5,'ACTIVE')",
      [leaseId, jobId, workerId, now - 10_000, now + 60_000],
    );

    await store.createAttemptAsync({
      id: attemptId,
      jobId,
      attemptNumber: 1,
      status: "RUNNING",
      createdAt: now - 10_000,
      startedAt: now - 10_000,
      workerId,
      leaseId,
    } as any);

    await pg.query(
      "UPDATE execution_attempts SET heartbeat_at=$1 WHERE id=$2",
      [now - 10_000, attemptId],
    );

    const stale = await store.listStaleAttemptsAsync(now, 1_000);

    const found = stale.find((x) => x.attemptId === attemptId);

    ok(!!found, "B06 stale RUNNING attempt is detected");

    ok(
      found?.jobId === jobId &&
      found?.workerId === workerId &&
      found?.leaseId === leaseId,
      "B07 stale record preserves ownership binding",
    );

    const freshHeartbeat = await store.attemptHeartbeatAsync({
      attemptId,
      jobId,
      workerId,
      leaseId,
      now,
    });

    ok(
      freshHeartbeat.ok === true,
      "B08 stale attempt can still recover if owner heartbeats before fencing",
    );

    const afterHeartbeat = await store.listStaleAttemptsAsync(now, 1_000);

    ok(
      !afterHeartbeat.some((x) => x.attemptId === attemptId),
      "B09 fresh heartbeat removes attempt from stale set",
    );

    await pg.query(
      "UPDATE execution_attempts SET heartbeat_at=$1 WHERE id=$2",
      [now - 10_000, attemptId],
    );

    const staleAgain = await store.listStaleAttemptsAsync(now, 1_000);

    ok(
      staleAgain.some((x) => x.attemptId === attemptId),
      "B10 attempt becomes stale again after heartbeat ages",
    );
  }

  // ============================================================
  // B11-B18 fencing
  // ============================================================
  section("B11-B18 - stale attempt fencing");

  {
    const jobId = `p187-job-fence-${stamp}`;
    const attemptId = `p187-attempt-fence-${stamp}`;
    const leaseId = `p187-lease-fence-${stamp}`;
    const workerId = `p187-worker-fence-${stamp}`;
    const now = Date.now();

    await store.createJobAsync(mkJob(jobId));

    await pg.query(
      "INSERT INTO execution_leases " +
      "(lease_id, job_id, worker_id, acquired_at, expires_at, status) " +
      "VALUES ($1,$2,$3,$4,$5,'ACTIVE')",
      [leaseId, jobId, workerId, now - 10_000, now + 60_000],
    );

    await store.createAttemptAsync({
      id: attemptId,
      jobId,
      attemptNumber: 1,
      status: "RUNNING",
      createdAt: now - 10_000,
      startedAt: now - 10_000,
      workerId,
      leaseId,
    } as any);

    await pg.query(
      "UPDATE execution_attempts SET heartbeat_at=$1 WHERE id=$2",
      [now - 10_000, attemptId],
    );

    const fenced = await store.fenceStaleAttemptAsync({
      attemptId,
      jobId,
      leaseId,
      reason: "HEARTBEAT_EXPIRED",
      now,
      staleCutoffMs: 1_000,
    });

    ok(fenced.fenced === true, "B11 stale attempt fenced");

    const attempt = await store.getAttemptAsync(attemptId);

    ok(
      attempt?.status === "FAILED",
      "B12 fenced attempt becomes FAILED",
    );

    const lease = await pg.query<{ status: string }>(
      "SELECT status FROM execution_leases WHERE lease_id=$1",
      [leaseId],
    );

    ok(
      lease.rows[0]?.status === "EXPIRED",
      "B13 stale attempt lease becomes EXPIRED",
    );

    const job = await store.getJobAsync(jobId);

    ok(
      job?.status === "ORPHANED",
      "B14 job becomes ORPHANED",
    );

    ok(
      job?.currentLeaseId == null,
      "B15 job current lease is cleared",
    );

    const event = await pg.query<{ event_type: string }>(
      "SELECT event_type FROM execution_events " +
      "WHERE job_id=$1 AND event_type='scheduler.attempt.fenced' " +
      "ORDER BY created_at DESC LIMIT 1",
      [jobId],
    );

    ok(
      event.rows[0]?.event_type === "scheduler.attempt.fenced",
      "B16 stale-attempt fence event is durable",
    );

    const duplicateFence = await store.fenceStaleAttemptAsync({
      attemptId,
      jobId,
      leaseId,
      reason: "HEARTBEAT_EXPIRED",
      now: now + 1,
      staleCutoffMs: 1_000,
    });

    ok(
      duplicateFence.fenced === false,
      "B17 second fence does not re-fence terminal attempt",
    );

    const staleOwnerHeartbeat = await store.attemptHeartbeatAsync({
      attemptId,
      jobId,
      workerId,
      leaseId,
      now: now + 2,
    });

    ok(
      staleOwnerHeartbeat.ok === false,
      "B18 fenced owner cannot heartbeat old attempt",
    );
  }

  // ============================================================
  // B19-B24 scheduler recovery
  // ============================================================
  section("B19-B24 - scheduler stale recovery");

  {
    const jobId = `p187-job-recover-${stamp}`;
    const attemptId = `p187-attempt-recover-${stamp}`;
    const leaseId = `p187-lease-recover-${stamp}`;
    const workerId = `p187-worker-recover-${stamp}`;
    const now = Date.now();

    await store.createJobAsync(mkJob(jobId));

    await pg.query(
      "INSERT INTO execution_leases " +
      "(lease_id, job_id, worker_id, acquired_at, expires_at, status) " +
      "VALUES ($1,$2,$3,$4,$5,'ACTIVE')",
      [leaseId, jobId, workerId, now - 10_000, now + 60_000],
    );

    await store.createAttemptAsync({
      id: attemptId,
      jobId,
      attemptNumber: 1,
      status: "RUNNING",
      createdAt: now - 10_000,
      startedAt: now - 10_000,
      workerId,
      leaseId,
    } as any);

    await pg.query(
      "UPDATE execution_attempts SET heartbeat_at=$1 WHERE id=$2",
      [now - 10_000, attemptId],
    );

    const report = await scheduler.recoverStaleAttemptsTick(now);

    ok(report.scanned >= 1, "B19 scheduler scans stale attempts");

    ok(report.fenced >= 1, "B20 scheduler fences stale attempt");

    ok(report.requeued >= 1, "B21 scheduler requeues retryable job");

    const finalAttempt = await store.getAttemptAsync(attemptId);
    const finalJob = await store.getJobAsync(jobId);

    ok(
      finalAttempt?.status === "FAILED",
      "B22 scheduler leaves durable failed attempt history",
    );

    ok(
      finalJob?.status === "QUEUED",
      "B23 scheduler recovery returns retryable job to QUEUED",
    );

    ok(
      finalJob?.nextAttemptAt != null,
      "B24 scheduler assigns next attempt time",
    );
  }

  // ============================================================
  // B25-B28 concurrent recovery CAS
  // ============================================================
  section("B25-B28 - concurrent recovery fencing");

  {
    const jobId = `p187-job-race-${stamp}`;
    const attemptId = `p187-attempt-race-${stamp}`;
    const leaseId = `p187-lease-race-${stamp}`;
    const workerId = `p187-worker-race-${stamp}`;
    const now = Date.now();

    await store.createJobAsync(mkJob(jobId));

    await pg.query(
      "INSERT INTO execution_leases " +
      "(lease_id, job_id, worker_id, acquired_at, expires_at, status) " +
      "VALUES ($1,$2,$3,$4,$5,'ACTIVE')",
      [leaseId, jobId, workerId, now - 10_000, now + 60_000],
    );

    await store.createAttemptAsync({
      id: attemptId,
      jobId,
      attemptNumber: 1,
      status: "RUNNING",
      createdAt: now - 10_000,
      startedAt: now - 10_000,
      workerId,
      leaseId,
    } as any);

    await pg.query(
      "UPDATE execution_attempts SET heartbeat_at=$1 WHERE id=$2",
      [now - 10_000, attemptId],
    );

    const results = await Promise.all([
      scheduler.recoverStaleAttemptsTick(now),
      scheduler.recoverStaleAttemptsTick(now),
    ]);

    const fencedTotal = results.reduce((n, r) => n + r.fenced, 0);

    ok(
      fencedTotal === 1,
      "B25 concurrent recovery fences stale attempt exactly once",
    );

    const attempts = await pg.query<{ status: string; count: string }>(
      "SELECT status, COUNT(*)::text AS count FROM execution_attempts " +
      "WHERE id=$1 GROUP BY status",
      [attemptId],
    );

    ok(
      attempts.rows[0]?.status === "FAILED" &&
      Number(attempts.rows[0]?.count) === 1,
      "B26 concurrent recovery preserves one terminal attempt row",
    );

    const fenceEvents = await pg.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM execution_events " +
      "WHERE job_id=$1 AND event_type='scheduler.attempt.fenced'",
      [jobId],
    );

    ok(
      Number(fenceEvents.rows[0]?.count) === 1,
      "B27 concurrent recovery writes one fence event",
    );

    const job = await store.getJobAsync(jobId);

    ok(
      job?.status === "QUEUED",
      "B28 concurrent recovery converges job to QUEUED",
    );
  }

  await pg.end();

  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
