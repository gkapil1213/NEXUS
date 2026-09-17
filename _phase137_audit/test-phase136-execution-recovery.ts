#!/usr/bin/env tsx
/* Phase 136 â€” durable execution crash-recovery + stale-worker fencing tests.
 *
 * Real Phase-13 SQLite schema (migrations 020 / 142 / 149). Real ExecutionStore,
 * LeaseManager, WorkerRegistry, RetryEngine, ExecutionEngine, ArtifactStore.
 * A controllable dispatch port whose collectResult promise is held open while
 * the original worker's lease expires and a second worker takes ownership.
 *
 * Direct SQLite assertions verify durable state; service return values alone
 * are not trusted.
 */

import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ExecutionStore } from "../src/core/execution-store";
import type { NexusEngine } from "../src/core/db";
import { LeaseManager } from "../src/core/lease-manager";
import { WorkerRegistry } from "../src/core/worker-registry";
import { RetryEngine } from "../src/core/retry-engine";
import {
  ExecutionEngine,
  ExecutionTransitionRejected,
  type ExecutionDeps,
} from "../src/core/execution-engine";
import type { ExecutionDispatchPort } from "../src/core/execution-dispatch-port";
import { ArtifactStore } from "../src/core/artifact-store";
import { RemoteExecutionManager } from "../src/core/remote-execution-manager";
import type { RemoteDispatchRecord, RemoteExecutionResult } from "../src/core/execution-models";
import type { ExecutionAdapterResult } from "../src/core/execution-adapter";
import type { RemoteExecutionAdapter } from "../src/core/remote-execution-adapter";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(id: string, cond: boolean, msg: string): void {
  if (cond) { passed++; console.log("  ok   " + id + "  " + msg); }
  else { failed++; failures.push(id + " " + msg); console.log("  FAIL " + id + "  " + msg); }
}
function eq<T>(id: string, actual: T, expected: T, msg: string): void {
  ok(id, actual === expected, msg + "  (expected=" + JSON.stringify(expected) + ", got=" + JSON.stringify(actual) + ")");
}

function newDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  const mig = (n: string) => readFileSync(join(process.cwd(), "src", "db", "migrations", n), "utf8");
  db.exec(mig("020_phase13_execution.sql"));
  db.exec(mig("021_phase15_remote_control_plane.sql"));
  db.exec(mig("022_phase16_remote_execution.sql"));
  db.exec(mig("025_phase17_artifact_result_integrity.sql"));
  db.exec(mig("142_phase_production_persistence_lease_integrity.sql"));
  db.exec(mig("143_remote_dispatch_persistence.sql"));
  db.exec(mig("144_durable_dispatch_intent.sql"));
  db.exec(mig("149_phase126_execution_ownership_obligations.sql"));
  return db;
}

function makeStore(db: Database.Database): ExecutionStore {
  return new ExecutionStore(db as unknown as NexusEngine);
}

function registerWorker(reg: WorkerRegistry, workerId: string): void {
  reg.register({ workerId, status: "ONLINE", capabilities: ["build"], registeredAt: Date.now() });
}

interface ControllableDispatch {
  port: ExecutionDispatchPort;
  setAuto: (v: boolean) => void;
  waitForPending: (n: number) => Promise<void>;
  resolve: (r: ExecutionAdapterResult) => void;
}
function makeControllableDispatch(): ControllableDispatch {
  const pending: Array<(r: ExecutionAdapterResult) => void> = [];
  let auto = true;
  const port: ExecutionDispatchPort = {
    async dispatch() { return { dispatchId: "disp_" + Math.random().toString(36).slice(2) }; },
    async collectResult(): Promise<ExecutionAdapterResult> {
      if (auto) return { success: true, exitCode: 0 };
      return await new Promise<ExecutionAdapterResult>((resolve) => { pending.push(resolve); });
    },
    async cancel() { /* no-op */ },
    async getStatus() { return { status: "RUNNING" }; },
  };
  return {
    port,
    setAuto: (v) => { auto = v; },
    waitForPending: async (n) => {
      for (let i = 0; i < 500 && pending.length < n; i++) await new Promise((r) => setImmediate(r));
      if (pending.length < n) throw new Error("expected >= " + n + " pending, got " + pending.length);
    },
    resolve: (r) => {
      const fn = pending.shift();
      if (!fn) throw new Error("no pending collectResult to resolve");
      fn(r);
    },
  };
}

interface Rig {
  db: Database.Database;
  store: ExecutionStore;
  leaseMgr: LeaseManager;
  registry: WorkerRegistry;
  engine: ExecutionEngine;
  dispatch: ControllableDispatch;
}
function buildRig(): Rig {
  const db = newDb();
  const store = makeStore(db);
  const leaseMgr = new LeaseManager(store);
  const registry = new WorkerRegistry(store, leaseMgr);
  registerWorker(registry, "worker-A");
  registerWorker(registry, "worker-B");
  const dispatch = makeControllableDispatch();
  const deps: ExecutionDeps = { dispatchPort: dispatch.port };
  const engine = new ExecutionEngine(store, registry, leaseMgr, new RetryEngine(), deps);
  return { db, store, leaseMgr, registry, engine, dispatch };
}

const RETRY_POLICY = { maxAttempts: 3, initialDelayMs: 10, multiplier: 2, maxDelayMs: 100 };

function jobRow(db: Database.Database, jobId: string): Record<string, unknown> | undefined {
  return db.prepare("SELECT * FROM execution_jobs WHERE id = ?").get(jobId) as Record<string, unknown> | undefined;
}
function attemptRows(db: Database.Database, jobId: string): Array<Record<string, unknown>> {
  return db.prepare("SELECT * FROM execution_attempts WHERE job_id = ? ORDER BY attempt_number").all(jobId) as Array<Record<string, unknown>>;
}
function countObligations(db: Database.Database, jobId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM execution_ownership_obligations WHERE job_id = ?").get(jobId) as { n: number }).n;
}
async function testStaleWorkerCannotFinalize(): Promise<void> {
  console.log("\n[136-1] stale worker cannot finalize after lease loss");
  const r = buildRig();

  const job = r.engine.createJob(
    "BUILD",
    { project: "nexus-test" },
    "idem-stale-finalize",
    RETRY_POLICY,
  );

  const claimed = r.engine.claimNextJob("worker-A");
  ok("136-1.1", !!claimed, "worker A claimed job");

  const leaseA = claimed?.lease;
  ok("136-1.2", !!leaseA, "worker A acquired lease");

  r.dispatch.setAuto(false);

  const execution = r.engine.executeJob(
    "worker-A",
    job.id,
    leaseA!.leaseId,
  );

  await r.dispatch.waitForPending(1);

  const beforeExpiry = r.store.getJob(job.id);
  eq(
    "136-1.2",
    beforeExpiry?.status,
    "RUNNING",
    "job is RUNNING while worker A is executing",
  );

  r.db.prepare(`
    UPDATE execution_leases
    SET expires_at = ?
    WHERE lease_id = ?
  `).run(Date.now() - 1, leaseA!.leaseId);

  r.engine.recoverStaleJobs(Date.now());

  const leaseAStatus = r.db.prepare(
    "SELECT status FROM execution_leases WHERE lease_id = ?"
  ).get(leaseA!.leaseId) as { status: string } | undefined;
  ok(
    "136-1.3",
    leaseAStatus?.status === "EXPIRED",
    "stale lease A is durably marked EXPIRED by recovery",
  );

  const afterRecovery = r.store.getJob(job.id);
  eq(
    "136-1.4",
    afterRecovery?.status,
    "QUEUED",
    "stale job is re-queued for retry",
  );

  const leaseB = r.leaseMgr.acquireLease(job.id, "worker-B", 5000);
  ok("136-1.5", !!leaseB, "worker B acquired replacement lease");

  const attemptsBefore = attemptRows(r.db, job.id);
  eq(
    "136-1.6",
    attemptsBefore.length,
    1,
    "only worker A attempt exists before stale completion",
  );

  r.dispatch.resolve({ success: true, exitCode: 0 });

  let staleError: unknown;
  try {
    await execution;
  } catch (err) {
    staleError = err;
  }

  ok(
    "136-1.7",
    staleError !== undefined,
    "worker A completion is rejected after lease loss",
  );

  const finalJob = jobRow(r.db, job.id);
  eq(
    "136-1.8",
    finalJob?.status,
    "QUEUED",
    "stale worker cannot advance authoritative job state",
  );

  const attemptsAfter = attemptRows(r.db, job.id);
  eq(
    "136-1.9",
    attemptsAfter.length,
    1,
    "stale worker cannot create a second attempt",
  );

  const staleAttempt = attemptsAfter[0];
  eq(
    "136-1.10",
    staleAttempt?.worker_id,
    "worker-A",
    "stale completion did not replace attempt ownership",
  );

  ok(
    "136-1.11",
    countObligations(r.db, job.id) >= 1,
    "ownership-loss obligation is durable",
  );

  r.db.close();
}

async function testAttemptMutationFence(): Promise<void> {
  console.log("\n[136-2] direct attempt mutation fence");

  const r = buildRig();

  const job = (() => {
    const id = "job-attempt-fence";
    r.store.createJob({
      id,
      idempotencyKey: "idem-attempt-fence",
      jobType: "BUILD",
      payload: {},
      status: "QUEUED",
      retryPolicy: RETRY_POLICY,
      cancellationRequested: false,
      cancellationAcknowledged: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return r.store.getJob(id)!;
  })();

  const lease = r.leaseMgr.acquireLease(job.id, "worker-A", 5000);

  const attempt = {
    id: "attempt-fence-1",
    jobId: job.id,
    attemptNumber: 1,
    status: "RUNNING" as const,
    workerId: "worker-A",
    leaseId: lease!.leaseId,
    createdAt: Date.now(),
  };

  const created = r.store.createAttemptAsOwner(
    attempt,
    lease!.leaseId,
    "worker-A",
  );

  ok("136-2.1", created.created, "owned attempt creation succeeds");

  r.db.prepare(`
    UPDATE execution_leases
    SET expires_at = ?
    WHERE lease_id = ?
  `).run(Date.now() - 1, lease!.leaseId);

  const staleUpdate = r.store.updateAttemptAsOwner(
    {
      ...attempt,
      status: "SUCCEEDED",
      completedAt: Date.now(),
    },
    lease!.leaseId,
    "worker-A",
  );

  eq(
    "136-2.2",
    staleUpdate.updated,
    false,
    "stale attempt update is rejected",
  );

  eq(
    "136-2.3",
    staleUpdate.reason,
    "WORKER_OWNERSHIP_LOST",
    "stale attempt update reports ownership loss",
  );

  const row = r.db.prepare(`
    SELECT status, completed_at
    FROM execution_attempts
    WHERE id = ?
  `).get(attempt.id) as { status: string; completed_at: number | null };

  eq(
    "136-2.4",
    row.status,
    "RUNNING",
    "stale worker cannot mutate attempt status",
  );

  eq(
    "136-2.5",
    row.completed_at,
    null,
    "stale worker cannot write completion timestamp",
  );

  r.db.close();
}

async function testRecoveryObligationIsDurable(): Promise<void> {
  console.log("\n[136-3] recovery obligation durability");

  const r = buildRig();

  const job = (() => {
    const id = "job-obligation";
    r.store.createJob({
      id,
      idempotencyKey: "idem-obligation",
      jobType: "BUILD",
      payload: {},
      status: "RUNNING",
      retryPolicy: RETRY_POLICY,
      cancellationRequested: false,
      cancellationAcknowledged: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return r.store.getJob(id)!;
  })();

  const lease = r.leaseMgr.acquireLease(job.id, "worker-A", 5000);

  r.store.writeOwnershipObligation({
    jobId: job.id,
    leaseId: lease!.leaseId,
    workerId: "worker-A",
    reason: "PROCESS_CRASH",
  });

  const obligations = r.store.listOpenOwnershipObligations();

  ok(
    "136-3.1",
    obligations.some(
      (x: any) =>
        x.jobId === job.id &&
        x.leaseId === lease!.leaseId &&
        x.workerId === "worker-A",
    ),
    "ownership obligation survives as durable DB state",
  );

  r.db.close();
}

async function testStaleArtifactFence(): Promise<void> {
  console.log("\n[136-4] artifact ownership fence");
  const r = buildRig();
  const job = r.engine.createJob("BUILD", {}, "idem-artifact", RETRY_POLICY);
  const claimed = r.engine.claimNextJob("worker-A");
  ok("136-4.1", !!claimed, "A claimed job");
  const leaseA = claimed!.lease.leaseId;

  const artifacts = new ArtifactStore(r.store);
  artifacts.registerArtifact(
    { artifactId: "art-ok", jobId: job.id, name: "out.bin", type: "BUILD_OUTPUT", createdAt: Date.now() },
    "hello",
    { leaseId: leaseA, workerId: "worker-A" },
  );
  const after1 = r.db.prepare("SELECT COUNT(*) AS n FROM execution_artifacts WHERE job_id = ?").get(job.id) as { n: number };
  eq("136-4.2", after1.n, 1, "owned artifact write succeeded");

  r.db.prepare("UPDATE execution_leases SET expires_at = ? WHERE lease_id = ?").run(Date.now() - 1, leaseA);

  let threw: unknown = null;
  try {
    artifacts.registerArtifact(
      { artifactId: "art-stale", jobId: job.id, name: "stale.bin", type: "BUILD_OUTPUT", createdAt: Date.now() },
      "stale",
      { leaseId: leaseA, workerId: "worker-A" },
    );
  } catch (e) { threw = e; }
  ok("136-4.3", threw instanceof Error && /artifact_ownership_lost/.test((threw as Error).message),
    "stale artifact write is rejected with artifact_ownership_lost");

  const after2 = r.db.prepare("SELECT COUNT(*) AS n FROM execution_artifacts WHERE job_id = ?").get(job.id) as { n: number };
  eq("136-4.4", after2.n, 1, "exactly one authoritative artifact row remains");
  r.db.close();
}

async function testStaleRemoteResultFence(): Promise<void> {
  console.log("\n[136-5] remote result ownership fence");
  const r = buildRig();
  const job = r.engine.createJob("BUILD", {}, "idem-remote", RETRY_POLICY);
  const claimed = r.engine.claimNextJob("worker-A");
  ok("136-5.1", !!claimed, "A claimed job");
  const leaseA = claimed!.lease.leaseId;

  const dispatch: RemoteDispatchRecord = {
    dispatchId: "disp-1", jobId: job.id, attemptId: "att-1",
    workerId: "worker-A", leaseId: leaseA, idempotencyKey: "idem-remote",
    status: "DISPATCHED", createdAt: Date.now(), updatedAt: Date.now(),
  };
  r.store.addRemoteDispatch(dispatch);

  const result: RemoteExecutionResult = {
    resultId: "res-1", jobId: job.id, attemptId: "att-1",
    workerId: "worker-A", dispatchId: "disp-1", leaseId: leaseA,
    success: true, exitCode: 0, createdAt: Date.now(), resultSha256: "abc123",
  };

  const good = r.store.persistRemoteExecutionResultAndDispatchAsOwner(
    result, { ...dispatch, status: "COMPLETED", updatedAt: Date.now() }, leaseA, "worker-A",
  );
  ok("136-5.2", good.persisted, "owned remote result persist succeeds");

  r.db.prepare("UPDATE execution_leases SET expires_at = ? WHERE lease_id = ?").run(Date.now() - 1, leaseA);

  const stale = r.store.persistRemoteExecutionResultAndDispatchAsOwner(
    { ...result, resultId: "res-2" },
    { ...dispatch, status: "FAILED", updatedAt: Date.now() },
    leaseA, "worker-A",
  );
  eq("136-5.3", stale.persisted, false, "stale remote result is rejected");
  eq("136-5.4", stale.reason, "WORKER_OWNERSHIP_LOST", "rejection reason is WORKER_OWNERSHIP_LOST");

  const disp = r.db.prepare("SELECT status FROM remote_dispatches WHERE dispatch_id = ?").get("disp-1") as { status: string } | undefined;
  ok("136-5.5", disp?.status !== "FAILED", "stale result cannot flip dispatch to FAILED");
  r.db.close();
}

async function testRecoveryIdempotency(): Promise<void> {
  console.log("\n[136-6] recovery idempotency");
  const r = buildRig();
  const job = r.engine.createJob("BUILD", {}, "idem-rec-idem", RETRY_POLICY);
  const claimed = r.engine.claimNextJob("worker-A");
  ok("136-6.1", !!claimed, "A claimed job");

  r.db.prepare("UPDATE execution_leases SET expires_at = ? WHERE lease_id = ?").run(Date.now() - 1, claimed!.lease.leaseId);

  r.engine.recoverStaleJobs(Date.now());
  const after1 = jobRow(r.db, job.id);
  const obl1 = countObligations(r.db, job.id);

  r.engine.recoverStaleJobs(Date.now());
  const after2 = jobRow(r.db, job.id);
  const obl2 = countObligations(r.db, job.id);

  eq("136-6.2", after2?.status, after1?.status, "second recovery pass is a no-op");
  eq("136-6.3", obl2, obl1, "no duplicate ownership obligation");
  ok("136-6.4", obl1 >= 1, "at least one obligation was written");
  r.db.close();
}

async function testBlockedTerminal(): Promise<void> {
  console.log("\n[136-7] BLOCKED terminal protection");
  const r = buildRig();
  const job = r.engine.createJob("BUILD", {}, "idem-blocked", RETRY_POLICY);

  r.db.prepare("UPDATE execution_jobs SET status = 'BLOCKED', updated_at = ? WHERE id = ?").run(Date.now(), job.id);

  const staleLeaseId = "stale-lease-blocked";
  r.db.prepare(
    "INSERT INTO execution_leases (lease_id, job_id, worker_id, acquired_at, expires_at, status) " +
    "VALUES (?, ?, ?, ?, ?, 'ACTIVE')"
  ).run(staleLeaseId, job.id, "worker-A", 0, 0);
  r.db.prepare("UPDATE execution_jobs SET current_lease_id = ? WHERE id = ?").run(staleLeaseId, job.id);

  r.engine.recoverStaleJobs(Date.now());
  eq("136-7.1", jobRow(r.db, job.id)?.status, "BLOCKED", "BLOCKED is not resurrected by recovery");
  r.db.close();
}

async function testUnknownPreservation(): Promise<void> {
  console.log("\n[136-8] UNKNOWN dispatch status preservation");
  const db = newDb();
  const store = makeStore(db);
  const dispatchId = "disp-unknown";

  // FK parent: remote_dispatches.job_id REFERENCES execution_jobs(id)
  store.createJob({
    id: "job-x", idempotencyKey: "idem-x-parent", jobType: "BUILD",
    payload: {}, status: "QUEUED",
    cancellationRequested: false, cancellationAcknowledged: false,
    createdAt: Date.now(), updatedAt: Date.now(),
  });

  const dispatch: RemoteDispatchRecord = {
    dispatchId, jobId: "job-x", attemptId: "att-x",
    workerId: "worker-A", leaseId: "lease-x", idempotencyKey: "idem-x",
    status: "DISPATCHED", createdAt: Date.now(), updatedAt: Date.now(),
  };
  store.addRemoteDispatch(dispatch);

  const throwingAdapter = {
    async getStatus(): Promise<{ status: string }> { throw new Error("provider down"); },
    async dispatch(): Promise<{ dispatchId: string }> { throw new Error("no"); },
    async cancel(): Promise<void> { throw new Error("no"); },
  } as unknown as RemoteExecutionAdapter;

  const mgr = new RemoteExecutionManager(throwingAdapter, store);
  await mgr.reconcilePersistedDispatches([dispatch]);

  const row = db.prepare("SELECT status FROM remote_dispatches WHERE dispatch_id = ?").get(dispatchId) as { status: string };
  eq("136-8.1", row.status, "UNKNOWN", "provider-down reconciliation yields UNKNOWN");
  ok("136-8.2", row.status !== "FAILED" && row.status !== "COMPLETED", "UNKNOWN is not collapsed to terminal");
  db.close();
}

async function testTerminalNotOverwritten(): Promise<void> {
  console.log("\n[136-9] terminal dispatch status not overwritten by reconciliation");
  const db = newDb();
  const store = makeStore(db);
  const dispatchId = "disp-terminal";

  // FK parent: remote_dispatches.job_id REFERENCES execution_jobs(id)
  store.createJob({
    id: "job-y", idempotencyKey: "idem-y-parent", jobType: "BUILD",
    payload: {}, status: "QUEUED",
    cancellationRequested: false, cancellationAcknowledged: false,
    createdAt: Date.now(), updatedAt: Date.now(),
  });

  const dispatch: RemoteDispatchRecord = {
    dispatchId, jobId: "job-y", attemptId: "att-y",
    workerId: "worker-A", leaseId: "lease-y", idempotencyKey: "idem-y",
    status: "DISPATCHED", createdAt: Date.now(), updatedAt: Date.now(),
  };
  store.addRemoteDispatch(dispatch);
  store.upsertRemoteDispatch({ ...dispatch, status: "COMPLETED", updatedAt: Date.now() });

  const throwingAdapter = {
    async getStatus(): Promise<{ status: string }> { throw new Error("provider down"); },
    async dispatch(): Promise<{ dispatchId: string }> { throw new Error("no"); },
    async cancel(): Promise<void> { throw new Error("no"); },
  } as unknown as RemoteExecutionAdapter;

  const mgr = new RemoteExecutionManager(throwingAdapter, store);
  await mgr.reconcilePersistedDispatches([dispatch]);

  const row = db.prepare("SELECT status FROM remote_dispatches WHERE dispatch_id = ?").get(dispatchId) as { status: string };
  eq("136-9.1", row.status, "COMPLETED", "terminal dispatch status is preserved");
  db.close();
}
async function main(): Promise<void> {
  console.log("===============================================");
  console.log("NEXUS Phase 136 â€” Durable Execution Recovery");
  console.log("===============================================");

  await testStaleWorkerCannotFinalize();
  await testAttemptMutationFence();
  await testRecoveryObligationIsDurable();  await testStaleArtifactFence();  await testStaleRemoteResultFence();  await testRecoveryIdempotency();  await testBlockedTerminal();  await testUnknownPreservation();  await testTerminalNotOverwritten();

  console.log("\n===============================================");
  console.log(`Phase 136 results: ${passed} passed, ${failed} failed`);
  console.log("===============================================");

  if (failed > 0) {
    console.error("\nFailures:");
    for (const failure of failures) console.error(" - " + failure);
    process.exitCode = 1;
  }
}

void main().catch((err) => {
  console.error("\nFATAL:", err);
  process.exitCode = 1;
});


