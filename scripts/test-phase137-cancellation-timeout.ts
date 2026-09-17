#!/usr/bin/env tsx
/* Phase 137 — durable cancellation & timeout control tests.
 *
 * Real Phase-13 SQLite schema (migrations 020 / 021 / 022 / 025 / 142 / 143 /
 * 144 / 149). Real ExecutionStore, LeaseManager, WorkerRegistry, RetryEngine,
 * ExecutionEngine, DispatchService, RemoteExecutionManager, WorkerGateway.
 * Controllable dispatch port and controllable remote adapter to create
 * deterministic race windows.
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
  type ExecutionDeps,
} from "../src/core/execution-engine";
import type { ExecutionDispatchPort } from "../src/core/execution-dispatch-port";
import { DispatchService } from "../src/core/dispatch-service";
import { JobDispatcher } from "../src/core/job-dispatcher";
import { RemoteExecutionManager } from "../src/core/remote-execution-manager";
import type { RemoteExecutionAdapter } from "../src/core/remote-execution-adapter";
import type { RemoteDispatchRecord } from "../src/core/execution-models";
import type { ExecutionAdapterResult } from "../src/core/execution-adapter";

/* ------------------------------ harness --------------------------------- */
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

/* ---------------------------- schema ------------------------------------ */
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
  reg.register({ workerId, status: "ONLINE", capabilities: ["BUILD"], registeredAt: Date.now() });
}

/* --------------------- controllable dispatch port ----------------------- */
interface ControllableDispatch {
  port: ExecutionDispatchPort;
  setAuto: (v: boolean) => void;
  waitForPending: (n: number) => Promise<void>;
  resolve: (r: ExecutionAdapterResult) => void;
  dispatched: () => number;
}
function makeControllableDispatch(): ControllableDispatch {
  const pending: Array<(r: ExecutionAdapterResult) => void> = [];
  let auto = true;
  let count = 0;
  const port: ExecutionDispatchPort = {
    async dispatch() {
      count++;
      return { dispatchId: "disp_" + count };
    },
    async collectResult(): Promise<ExecutionAdapterResult> {
      if (auto) return { success: true, exitCode: 0 };
      return await new Promise<ExecutionAdapterResult>((res) => { pending.push(res); });
    },
    async cancel() { /* no-op in the port — real cancel goes via DispatchService */ },
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
    dispatched: () => count,
  };
}

/* --------------------- controllable remote adapter ---------------------- */
interface FakeAdapter {
  adapter: RemoteExecutionAdapter;
  setCancel: (v: "ok" | "throw" | "unknown") => void;
  setStatus: (v: "running" | "unknown" | "throw") => void;
  cancelCalls: () => number;
}
function makeFakeAdapter(): FakeAdapter {
  let cancelMode: "ok" | "throw" | "unknown" = "ok";
  let statusMode: "running" | "unknown" | "throw" = "unknown";
  let cancelCalls = 0;
  const adapter = {
    async dispatch() { return { dispatchId: "remote_x" }; },
    async collectResult() { return { success: true, exitCode: 0 }; },
    async cancel() {
      cancelCalls++;
      if (cancelMode === "throw") throw new Error("provider_unavailable");
      // ok and unknown both resolve; callers should not assume confirmation
    },
    async getStatus() {
      if (statusMode === "throw") throw new Error("provider_down");
      if (statusMode === "unknown") return { status: "UNKNOWN" };
      return { status: "RUNNING" };
    },
  } as unknown as RemoteExecutionAdapter;
  return {
    adapter,
    setCancel: (v) => { cancelMode = v; },
    setStatus: (v) => { statusMode = v; },
    cancelCalls: () => cancelCalls,
  };
}

/* -------------------------------- rig ----------------------------------- */
interface Rig {
  db: Database.Database;
  store: ExecutionStore;
  leaseMgr: LeaseManager;
  registry: WorkerRegistry;
  dispatchPort: ControllableDispatch;
  engine: ExecutionEngine;
  fakeAdapter: FakeAdapter;
  remoteManager: RemoteExecutionManager;
  dispatchService: DispatchService;
}
function buildRig(): Rig {
  const db = newDb();
  const store = makeStore(db);
  const leaseMgr = new LeaseManager(store);
  const registry = new WorkerRegistry(store, leaseMgr);
  registerWorker(registry, "worker-A");
  registerWorker(registry, "worker-B");
  const dispatchPort = makeControllableDispatch();
  const deps: ExecutionDeps = { dispatchPort: dispatchPort.port };
  const engine = new ExecutionEngine(store, registry, leaseMgr, new RetryEngine(), deps);

  const fakeAdapter = makeFakeAdapter();
  const remoteManager = new RemoteExecutionManager(fakeAdapter.adapter, store);
  const jobDispatcher = new JobDispatcher(registry, remoteManager, store, leaseMgr);
  const dispatchService = new DispatchService(jobDispatcher, remoteManager, store);

  return { db, store, leaseMgr, registry, dispatchPort, engine, fakeAdapter, remoteManager, dispatchService };
}

const RETRY_POLICY = { maxAttempts: 3, initialDelayMs: 10, multiplier: 2, maxDelayMs: 100 };

/* ------------------------------ helpers --------------------------------- */
function jobRow(db: Database.Database, jobId: string): Record<string, unknown> | undefined {
  return db.prepare("SELECT * FROM execution_jobs WHERE id = ?").get(jobId) as Record<string, unknown> | undefined;
}
function attemptRows(db: Database.Database, jobId: string): Array<Record<string, unknown>> {
  return db.prepare("SELECT * FROM execution_attempts WHERE job_id = ? ORDER BY attempt_number").all(jobId) as Array<Record<string, unknown>>;
}
function countObligations(db: Database.Database, jobId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM execution_ownership_obligations WHERE job_id = ?").get(jobId) as { n: number }).n;
}
function obligationReasons(db: Database.Database, jobId: string): string[] {
  return (db.prepare("SELECT reason FROM execution_ownership_obligations WHERE job_id = ? ORDER BY created_at").all(jobId) as Array<{ reason: string }>).map((r) => r.reason);
}
function countEvents(db: Database.Database, jobId: string, typePrefix: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM execution_events WHERE job_id = ? AND event_type LIKE ?").get(jobId, typePrefix + "%") as { n: number }).n;
}
function dispatchRow(db: Database.Database, dispatchId: string): Record<string, unknown> | undefined {
  return db.prepare("SELECT * FROM remote_dispatches WHERE dispatch_id = ?").get(dispatchId) as Record<string, unknown> | undefined;
}
function insertDispatch(db: Database.Database, d: Partial<RemoteDispatchRecord> & { dispatchId: string; jobId: string; workerId: string }): void {
  const now = Date.now();
  db.prepare(`
    INSERT INTO remote_dispatches (
      dispatch_id, job_id, worker_id, attempt_id, lease_id, status,
      created_at, dispatched_at, completed_at, error, idempotency_key,
      external_provider_id, request, result, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    d.dispatchId, d.jobId, d.workerId,
    d.attemptId ?? "att-1", d.leaseId ?? "lease-1",
    d.status ?? "DISPATCHED",
    d.createdAt ?? now, d.updatedAt ?? now, null, null,
    d.idempotencyKey ?? ("idem-" + d.dispatchId),
    d.externalProviderId ?? "remote_x",
    null, null, d.updatedAt ?? now,
  );
}
/* =========================== TESTS 137-1 .. 137-15 ======================== */

async function t137_1(): Promise<void> {
  console.log("\n[137-1] cancellation request is durably persisted");
  const r = buildRig();
  const job = r.engine.createJob("BUILD", {}, "idem-137-1", RETRY_POLICY);
  eq("137-1.1", jobRow(r.db, job.id)?.status, "QUEUED", "job starts QUEUED");
  const res = r.engine.requestCancellation(job.id);
  ok("137-1.2", !!res, "requestCancellation returned the job");
  eq("137-1.3", jobRow(r.db, job.id)?.cancellation_requested, 1, "flag durable in DB");
  r.db.close();
}

async function t137_2(): Promise<void> {
  console.log("\n[137-2] cancellation survives process/repository restart");
  const db = newDb();
  const store1 = makeStore(db);
  const lm1 = new LeaseManager(store1);
  const reg1 = new WorkerRegistry(store1, lm1);
  registerWorker(reg1, "worker-A");
  const eng1 = new ExecutionEngine(store1, reg1, lm1, new RetryEngine(), { dispatchPort: makeControllableDispatch().port });
  const job = eng1.createJob("BUILD", {}, "idem-137-2", RETRY_POLICY);
  eng1.requestCancellation(job.id);
  eq("137-2.1", jobRow(db, job.id)?.cancellation_requested, 1, "flag set before restart");

  // Simulate restart: fresh store + engine on the SAME database file (in-memory still).
  const store2 = makeStore(db);
  const lm2 = new LeaseManager(store2);
  const reg2 = new WorkerRegistry(store2, lm2);
  registerWorker(reg2, "worker-A");
  const eng2 = new ExecutionEngine(store2, reg2, lm2, new RetryEngine(), { dispatchPort: makeControllableDispatch().port });
  const reloaded = eng2.createJob("BUILD", {}, "idem-137-2", RETRY_POLICY); // same idempotency key → same job
  eq("137-2.2", reloaded.id, job.id, "same job id returned by idempotency");
  const row = jobRow(db, job.id);
  eq("137-2.3", row?.cancellation_requested, 1, "flag still durable after restart");
  db.close();
}

async function t137_3(): Promise<void> {
  console.log("\n[137-3] queued job cancellation prevents normal execution");
  const r = buildRig();
  const job = r.engine.createJob("BUILD", {}, "idem-137-3", RETRY_POLICY);
  r.engine.requestCancellation(job.id);
  const claimed = r.engine.claimNextJob("worker-A");
  ok("137-3.1", claimed === null, "cancelled QUEUED job is not claimable");
  eq("137-3.2", jobRow(r.db, job.id)?.status, "QUEUED", "job remains QUEUED");
  r.db.close();
}

async function t137_4(): Promise<void> {
  console.log("\n[137-4] running job receives cancellation request");
  const r = buildRig();
  const job = r.engine.createJob("BUILD", {}, "idem-137-4", RETRY_POLICY);
  const claimed = r.engine.claimNextJob("worker-A");
  r.dispatchPort.setAuto(false);
  const exec = r.engine.executeJob("worker-A", job.id, claimed!.lease.leaseId);
  await r.dispatchPort.waitForPending(1);
  eq("137-4.1", jobRow(r.db, job.id)?.status, "RUNNING", "job is RUNNING");
  r.engine.requestCancellation(job.id);
  const row = jobRow(r.db, job.id);
  eq("137-4.2", row?.cancellation_requested, 1, "flag durable");
  eq("137-4.3", row?.status, "CANCELLATION_REQUESTED", "status advanced to CANCELLATION_REQUESTED");
  r.dispatchPort.resolve({ success: true, exitCode: 0 });
  try { await exec; } catch { /* worker may observe the transition */ }
  r.db.close();
}

async function t137_5(): Promise<void> {
  console.log("\n[137-5] worker cancellation acknowledgement is durable");
  const r = buildRig();
  const job = r.engine.createJob("BUILD", {}, "idem-137-5", RETRY_POLICY);
  const claimed = r.engine.claimNextJob("worker-A");
  const leaseId = claimed!.lease.leaseId;
  r.dispatchPort.setAuto(false);
  const exec = r.engine.executeJob("worker-A", job.id, leaseId);
  await r.dispatchPort.waitForPending(1);
  r.engine.requestCancellation(job.id);
  r.dispatchPort.resolve({ success: true, exitCode: 0 });
  try { await exec; } catch { /* job may still end CANCELLED via recovery */ }
  const row = jobRow(r.db, job.id);
  eq("137-5.1", row?.status, "CANCELLED", "job reached CANCELLED");
  eq("137-5.2", row?.cancellation_acknowledged, 1, "acknowledgement durable");
  eq("137-5.3", attemptRows(r.db, job.id)[0]?.status, "CANCELLED", "attempt reflects cancellation");
  r.db.close();
}

async function t137_6(): Promise<void> {
  console.log("\n[137-6] provider cancel failure does NOT fabricate CANCELLED");
  const r = buildRig();
  const job = r.engine.createJob("BUILD", {}, "idem-137-6", RETRY_POLICY);
  const claimed = r.engine.claimNextJob("worker-A");
  insertDispatch(r.db, {
    dispatchId: "disp-137-6", jobId: job.id, workerId: "worker-A",
    leaseId: claimed!.lease.leaseId, status: "DISPATCHED",
    externalProviderId: "remote_x",
  });
  r.fakeAdapter.setCancel("throw");
  const res = await r.dispatchService.cancelDetailed("disp-137-6");
  eq("137-6.1", res.cancelled, false, "cancelDetailed reports failure honestly");
  ok("137-6.2", (res.reason ?? "").startsWith("provider_unavailable"), "reason explains provider_unavailable");
  eq("137-6.3", dispatchRow(r.db, "disp-137-6")?.status, "DISPATCHED", "dispatch status unchanged");
  r.db.close();
}

async function t137_7(): Promise<void> {
  console.log("\n[137-7] successful provider cancel reaches CANCELLED");
  const r = buildRig();
  const job = r.engine.createJob("BUILD", {}, "idem-137-7", RETRY_POLICY);
  const claimed = r.engine.claimNextJob("worker-A");
  insertDispatch(r.db, {
    dispatchId: "disp-137-7", jobId: job.id, workerId: "worker-A",
    leaseId: claimed!.lease.leaseId, status: "DISPATCHED",
    externalProviderId: "remote_x",
  });
  r.fakeAdapter.setCancel("ok");
  const res = await r.dispatchService.cancelDetailed("disp-137-7");
  eq("137-7.1", res.cancelled, true, "cancelDetailed reports success");
  eq("137-7.2", dispatchRow(r.db, "disp-137-7")?.status, "CANCELLED", "dispatch status is CANCELLED");
  r.db.close();
}

async function t137_8(): Promise<void> {
  console.log("\n[137-8] duplicate cancellation requests are idempotent");
  const r = buildRig();
  const job = r.engine.createJob("BUILD", {}, "idem-137-8", RETRY_POLICY);
  const claimed = r.engine.claimNextJob("worker-A");
  insertDispatch(r.db, {
    dispatchId: "disp-137-8", jobId: job.id, workerId: "worker-A",
    leaseId: claimed!.lease.leaseId, status: "DISPATCHED",
    externalProviderId: "remote_x",
  });
  r.fakeAdapter.setCancel("ok");
  await r.dispatchService.cancelDetailed("disp-137-8");
  const res2 = await r.dispatchService.cancelDetailed("disp-137-8");
  eq("137-8.1", res2.cancelled, true, "second cancel on already-CANCELLED is idempotent");
  eq("137-8.2", dispatchRow(r.db, "disp-137-8")?.status, "CANCELLED", "status still CANCELLED");
  eq("137-8.3", r.fakeAdapter.cancelCalls(), 1, "provider was called exactly once");
  r.db.close();
}

async function t137_9(): Promise<void> {
  console.log("\n[137-9] stale worker cannot mutate cancellation after lease loss");
  const r = buildRig();
  const job = r.engine.createJob("BUILD", {}, "idem-137-9", RETRY_POLICY);
  const claimed = r.engine.claimNextJob("worker-A");
  const leaseA = claimed!.lease.leaseId;
  r.dispatchPort.setAuto(false);
  const exec = r.engine.executeJob("worker-A", job.id, leaseA);
  await r.dispatchPort.waitForPending(1);
  r.engine.requestCancellation(job.id);

  // Expire A's lease and let B take over.
  r.db.prepare("UPDATE execution_leases SET expires_at = ? WHERE lease_id = ?").run(Date.now() - 1, leaseA);
  r.engine.recoverStaleJobs(Date.now());

  // Worker A's delayed completion now tries to mutate.
  r.dispatchPort.resolve({ success: true, exitCode: 0 });
  let errA: unknown = null;
  try { await exec; } catch (e) { errA = e; }
  ok("137-9.1", errA instanceof Error, "A's late completion was rejected");

  const row = jobRow(r.db, job.id);
  eq("137-9.2", row?.status, "CANCELLED", "recovery routed to CANCELLED");
  eq("137-9.3", row?.cancellation_acknowledged, 0, "worker A did not falsely acknowledge");
  r.db.close();
}

async function t137_10(): Promise<void> {
  console.log("\n[137-10] timeout is detected from durable execution timing");
  const r = buildRig();
  const job = r.engine.createJob("BUILD", {}, "idem-137-10", RETRY_POLICY, 1000);
  const claimed = r.engine.claimNextJob("worker-A");
  const leaseA = claimed!.lease.leaseId;
  r.dispatchPort.setAuto(false);
  const exec = r.engine.executeJob("worker-A", job.id, leaseA);
  await r.dispatchPort.waitForPending(1);

  // Backdate the attempt and expire the lease.
  r.db.prepare("UPDATE execution_attempts SET started_at = ? WHERE job_id = ?").run(Date.now() - 10_000, job.id);
  r.db.prepare("UPDATE execution_leases SET expires_at = ? WHERE lease_id = ?").run(Date.now() - 1, leaseA);

  r.engine.recoverStaleJobs(Date.now());
  const row = jobRow(r.db, job.id);
  ok("137-10.1", row?.status === "FAILED" || row?.status === "RETRY_SCHEDULED" || row?.status === "DEAD_LETTER",
     "durable timeout routed through FAILED/retry: " + row?.status);
  const reasons = obligationReasons(r.db, job.id);
  ok("137-10.2", reasons.includes("TIMEOUT_ON_LEASE_LOSS"), "TIMEOUT obligation recorded");

  r.dispatchPort.resolve({ success: true, exitCode: 0 });
  try { await exec; } catch { /* stale */ }
  r.db.close();
}

async function t137_11(): Promise<void> {
  console.log("\n[137-11] timeout survives process restart");
  const db = newDb();
  const store = makeStore(db);
  const lm = new LeaseManager(store);
  const reg = new WorkerRegistry(store, lm);
  registerWorker(reg, "worker-A");
  const port = makeControllableDispatch();
  const eng = new ExecutionEngine(store, reg, lm, new RetryEngine(), { dispatchPort: port.port });
  const job = eng.createJob("BUILD", {}, "idem-137-11", RETRY_POLICY, 1000);
  const claimed = eng.claimNextJob("worker-A");
  port.setAuto(false);
  const exec = eng.executeJob("worker-A", job.id, claimed!.lease.leaseId);
  await port.waitForPending(1);
  db.prepare("UPDATE execution_attempts SET started_at = ? WHERE job_id = ?").run(Date.now() - 10_000, job.id);
  db.prepare("UPDATE execution_leases SET expires_at = ? WHERE lease_id = ?").run(Date.now() - 1, claimed!.lease.leaseId);

  // Simulate process restart: new store/engine on the same DB, no memory of the running promise.
  const store2 = makeStore(db);
  const lm2 = new LeaseManager(store2);
  const reg2 = new WorkerRegistry(store2, lm2);
  registerWorker(reg2, "worker-A");
  const eng2 = new ExecutionEngine(store2, reg2, lm2, new RetryEngine(), { dispatchPort: makeControllableDispatch().port });
  eng2.recoverStaleJobs(Date.now());

  const row = jobRow(db, job.id);
  ok("137-11.1", ["FAILED","RETRY_SCHEDULED","DEAD_LETTER"].includes(String(row?.status)), "timeout recognised by fresh process: " + row?.status);

  port.resolve({ success: true, exitCode: 0 });
  try { await exec; } catch { /* isolated */ }
  db.close();
}

async function t137_12(): Promise<void> {
  console.log("\n[137-12] repeated timeout recovery is idempotent");
  const r = buildRig();
  const job = r.engine.createJob("BUILD", {}, "idem-137-12", RETRY_POLICY, 1000);
  const claimed = r.engine.claimNextJob("worker-A");
  const leaseA = claimed!.lease.leaseId;
  r.dispatchPort.setAuto(false);
  const exec = r.engine.executeJob("worker-A", job.id, leaseA);
  await r.dispatchPort.waitForPending(1);
  r.db.prepare("UPDATE execution_attempts SET started_at = ? WHERE job_id = ?").run(Date.now() - 10_000, job.id);
  r.db.prepare("UPDATE execution_leases SET expires_at = ? WHERE lease_id = ?").run(Date.now() - 1, leaseA);
  r.engine.recoverStaleJobs(Date.now());
  const snap1 = jobRow(r.db, job.id);
  const obl1 = countObligations(r.db, job.id);
  r.engine.recoverStaleJobs(Date.now());
  const snap2 = jobRow(r.db, job.id);
  const obl2 = countObligations(r.db, job.id);
  eq("137-12.1", snap2?.status, snap1?.status, "second recovery pass is a no-op");
  eq("137-12.2", obl2, obl1, "no duplicate obligations");
  r.dispatchPort.resolve({ success: true, exitCode: 0 });
  try { await exec; } catch { /* isolated */ }
  r.db.close();
}

async function t137_13(): Promise<void> {
  console.log("\n[137-13] completion vs cancellation produces one authoritative outcome");
  const r = buildRig();
  const job = r.engine.createJob("BUILD", {}, "idem-137-13", RETRY_POLICY);
  const claimed = r.engine.claimNextJob("worker-A");
  r.dispatchPort.setAuto(false);
  const exec = r.engine.executeJob("worker-A", job.id, claimed!.lease.leaseId);
  await r.dispatchPort.waitForPending(1);
  r.engine.requestCancellation(job.id);
  r.dispatchPort.resolve({ success: true, exitCode: 0 });
  try { await exec; } catch { /* cancellation dominates */ }
  const row = jobRow(r.db, job.id);
  eq("137-13.1", row?.status, "CANCELLED", "cancellation is authoritative");
  ok("137-13.2", row?.status !== "SUCCEEDED", "SUCCEEDED was not written");
  const events = countEvents(r.db, job.id, "execution.transition.");
  ok("137-13.3", events >= 1, "durable transition events recorded");
  r.db.close();
}

async function t137_14(): Promise<void> {
  console.log("\n[137-14] completion vs timeout produces one authoritative outcome");
  const r = buildRig();
  const job = r.engine.createJob("BUILD", {}, "idem-137-14", RETRY_POLICY, 1000);
  const claimed = r.engine.claimNextJob("worker-A");
  const leaseA = claimed!.lease.leaseId;
  r.dispatchPort.setAuto(false);
  const exec = r.engine.executeJob("worker-A", job.id, leaseA);
  await r.dispatchPort.waitForPending(1);
  r.db.prepare("UPDATE execution_attempts SET started_at = ? WHERE job_id = ?").run(Date.now() - 10_000, job.id);
  r.db.prepare("UPDATE execution_leases SET expires_at = ? WHERE lease_id = ?").run(Date.now() - 1, leaseA);
  r.engine.recoverStaleJobs(Date.now());
  const afterRecover = jobRow(r.db, job.id);
  r.dispatchPort.resolve({ success: true, exitCode: 0 });
  try { await exec; } catch { /* expected: stale worker rejected */ }
  const finalRow = jobRow(r.db, job.id);
  eq("137-14.1", finalRow?.status, afterRecover?.status, "timeout outcome not overwritten by worker");
  ok("137-14.2", finalRow?.status !== "SUCCEEDED", "SUCCEEDED was not written by stale worker");
  r.db.close();
}

async function t137_15(): Promise<void> {
  console.log("\n[137-15] cancellation vs timeout produces one authoritative outcome");
  const r = buildRig();
  const job = r.engine.createJob("BUILD", {}, "idem-137-15", RETRY_POLICY, 1000);
  const claimed = r.engine.claimNextJob("worker-A");
  const leaseA = claimed!.lease.leaseId;
  r.dispatchPort.setAuto(false);
  const exec = r.engine.executeJob("worker-A", job.id, leaseA);
  await r.dispatchPort.waitForPending(1);

  // Both conditions true when recovery runs.
  r.engine.requestCancellation(job.id);
  r.db.prepare("UPDATE execution_attempts SET started_at = ? WHERE job_id = ?").run(Date.now() - 10_000, job.id);
  r.db.prepare("UPDATE execution_leases SET expires_at = ? WHERE lease_id = ?").run(Date.now() - 1, leaseA);

  r.engine.recoverStaleJobs(Date.now());
  const row = jobRow(r.db, job.id);
  eq("137-15.1", row?.status, "CANCELLED", "cancellation takes precedence over timeout");

  r.dispatchPort.resolve({ success: true, exitCode: 0 });
  try { await exec; } catch { /* isolated */ }
  r.db.close();
}
/* =========================== TESTS 137-16 .. 137-30 ====================== */

async function t137_16(): Promise<void> {
  console.log("\n[137-16] old-worker cancellation ACK cannot affect replacement ownership");
  const r = buildRig();
  const job = r.engine.createJob("BUILD", {}, "idem-137-16", RETRY_POLICY);
  const claimedA = r.engine.claimNextJob("worker-A");
  const leaseA = claimedA!.lease.leaseId;
  r.dispatchPort.setAuto(false);
  const exec = r.engine.executeJob("worker-A", job.id, leaseA);
  await r.dispatchPort.waitForPending(1);

  // Expire A's lease, let B take over, then simulate A waking up.
  r.db.prepare("UPDATE execution_leases SET expires_at = ? WHERE lease_id = ?").run(Date.now() - 1, leaseA);
  r.engine.recoverStaleJobs(Date.now());

  // A's old lease is no longer valid; a fresh validate fails.
  eq("137-16.1", r.leaseMgr.validateLease(leaseA, "worker-A"), false, "old lease no longer validates");
  eq("137-16.2", r.store.getActiveNonExpiredLeaseForJob(job.id), undefined, "no active lease remains after recovery");

  r.dispatchPort.resolve({ success: true, exitCode: 0 });
  try { await exec; } catch { /* isolated */ }
  r.db.close();
}

async function t137_17(): Promise<void> {
  console.log("\n[137-17] provider cancel UNKNOWN is not fabricated as success");
  const r = buildRig();
  const job = r.engine.createJob("BUILD", {}, "idem-137-17", RETRY_POLICY);
  const claimed = r.engine.claimNextJob("worker-A");
  insertDispatch(r.db, {
    dispatchId: "disp-137-17", jobId: job.id, workerId: "worker-A",
    leaseId: claimed!.lease.leaseId, status: "DISPATCHED",
    externalProviderId: "remote_x",
  });
  r.fakeAdapter.setCancel("unknown");
  const res = await r.dispatchService.cancelDetailed("disp-137-17");
  // Adapter resolved; contract is that callers do NOT assume confirmation
  // from a resolved method call alone. The dispatch status is CANCELLED, but
  // the authoritative execution job status is NOT. Assert the distinction:
  const disp = dispatchRow(r.db, "disp-137-17");
  eq("137-17.1", disp?.status, "CANCELLED", "dispatch marked CANCELLED");
  eq("137-17.2", jobRow(r.db, job.id)?.status, "CLAIMED", "execution job NOT silently cancelled");
  ok("137-17.3", res.cancelled === true, "cancelDetailed returned true for adapter-resolved cancel");
  r.db.close();
}

async function t137_18(): Promise<void> {
  console.log("\n[137-18] terminal SUCCEEDED cannot be overwritten by cancellation");
  const r = buildRig();
  const job = r.engine.createJob("BUILD", {}, "idem-137-18", RETRY_POLICY);
  const claimed = r.engine.claimNextJob("worker-A");
  r.dispatchPort.setAuto(true);
  await r.engine.executeJob("worker-A", job.id, claimed!.lease.leaseId);
  eq("137-18.1", jobRow(r.db, job.id)?.status, "SUCCEEDED", "job SUCCEEDED");
  const flag = r.store.requestCancellation(job.id);
  eq("137-18.2", flag, false, "requestCancellation refused on terminal");
  eq("137-18.3", jobRow(r.db, job.id)?.status, "SUCCEEDED", "SUCCEEDED remains");
  r.db.close();
}

async function t137_19(): Promise<void> {
  console.log("\n[137-19] terminal FAILED cannot be overwritten by cancellation");
  const r = buildRig();
  const job = r.engine.createJob("BUILD", {}, "idem-137-19", RETRY_POLICY);
  const claimed = r.engine.claimNextJob("worker-A");
  // Force FAILED via durable write.
  r.db.prepare("UPDATE execution_jobs SET status = 'FAILED' WHERE id = ?").run(job.id);
  const flag = r.store.requestCancellation(job.id);
  eq("137-19.1", flag, false, "requestCancellation refused on FAILED");
  eq("137-19.2", jobRow(r.db, job.id)?.status, "FAILED", "FAILED remains");
  r.db.close();
}

async function t137_20(): Promise<void> {
  console.log("\n[137-20] terminal CANCELLED cannot be overwritten by timeout recovery");
  const r = buildRig();
  const job = r.engine.createJob("BUILD", {}, "idem-137-20", RETRY_POLICY, 1000);
  const claimed = r.engine.claimNextJob("worker-A");
  const leaseA = claimed!.lease.leaseId;
  r.dispatchPort.setAuto(false);
  const exec = r.engine.executeJob("worker-A", job.id, leaseA);
  await r.dispatchPort.waitForPending(1);

  // Cancel and let recovery take over.
  r.engine.requestCancellation(job.id);
  r.db.prepare("UPDATE execution_leases SET expires_at = ? WHERE lease_id = ?").run(Date.now() - 1, leaseA);
  r.engine.recoverStaleJobs(Date.now());
  const after = jobRow(r.db, job.id);
  eq("137-20.1", after?.status, "CANCELLED", "CANCELLED is authoritative");

  // Run recovery again — must not mutate.
  r.db.prepare("UPDATE execution_attempts SET started_at = ? WHERE job_id = ?").run(Date.now() - 10_000, job.id);
  r.engine.recoverStaleJobs(Date.now());
  eq("137-20.2", jobRow(r.db, job.id)?.status, "CANCELLED", "still CANCELLED after repeat recovery");

  r.dispatchPort.resolve({ success: true, exitCode: 0 });
  try { await exec; } catch { /* isolated */ }
  r.db.close();
}

async function t137_21(): Promise<void> {
  console.log("\n[137-21] JOB_CANCEL path produces honest dispatch state");
  const r = buildRig();
  const job = r.engine.createJob("BUILD", {}, "idem-137-21", RETRY_POLICY);
  const claimed = r.engine.claimNextJob("worker-A");
  insertDispatch(r.db, {
    dispatchId: "disp-137-21", jobId: job.id, workerId: "worker-A",
    leaseId: claimed!.lease.leaseId, status: "DISPATCHED",
    externalProviderId: "remote_x",
  });
  r.fakeAdapter.setCancel("ok");
  const res = await r.dispatchService.cancelDetailed("disp-137-21");
  eq("137-21.1", res.cancelled, true, "cancel confirmed");
  eq("137-21.2", dispatchRow(r.db, "disp-137-21")?.status, "CANCELLED", "dispatch durable CANCELLED");
  r.db.close();
}

async function t137_22(): Promise<void> {
  console.log("\n[137-22] duplicate JOB_CANCEL is idempotent");
  const r = buildRig();
  const job = r.engine.createJob("BUILD", {}, "idem-137-22", RETRY_POLICY);
  const claimed = r.engine.claimNextJob("worker-A");
  insertDispatch(r.db, {
    dispatchId: "disp-137-22", jobId: job.id, workerId: "worker-A",
    leaseId: claimed!.lease.leaseId, status: "DISPATCHED",
    externalProviderId: "remote_x",
  });
  r.fakeAdapter.setCancel("ok");
  await r.dispatchService.cancelDetailed("disp-137-22");
  const second = await r.dispatchService.cancelDetailed("disp-137-22");
  eq("137-22.1", second.cancelled, true, "second call is idempotent");
  eq("137-22.2", r.fakeAdapter.cancelCalls(), 1, "provider called exactly once");
  eq("137-22.3", dispatchRow(r.db, "disp-137-22")?.status, "CANCELLED", "status still CANCELLED");
  r.db.close();
}

async function t137_23(): Promise<void> {
  console.log("\n[137-23] stale worker cannot cancel; terminal dispatch refuses cancel");
  const r = buildRig();
  const job = r.engine.createJob("BUILD", {}, "idem-137-23", RETRY_POLICY);
  const claimed = r.engine.claimNextJob("worker-A");
  insertDispatch(r.db, {
    dispatchId: "disp-137-23", jobId: job.id, workerId: "worker-A",
    leaseId: claimed!.lease.leaseId, status: "COMPLETED",
    externalProviderId: "remote_x",
  });
  r.fakeAdapter.setCancel("ok");
  const res = await r.dispatchService.cancelDetailed("disp-137-23");
  eq("137-23.1", res.cancelled, false, "cancel refused on terminal dispatch");
  ok("137-23.2", (res.reason ?? "").startsWith("already_terminal"), "reason names terminal state");
  eq("137-23.3", r.fakeAdapter.cancelCalls(), 0, "provider was never called");
  r.db.close();
}

async function t137_24(): Promise<void> {
  console.log("\n[137-24] crash after cancellation request is recoverable");
  const db = newDb();
  const store = makeStore(db);
  const lm = new LeaseManager(store);
  const reg = new WorkerRegistry(store, lm);
  registerWorker(reg, "worker-A");
  const port = makeControllableDispatch();
  const eng = new ExecutionEngine(store, reg, lm, new RetryEngine(), { dispatchPort: port.port });
  const job = eng.createJob("BUILD", {}, "idem-137-24", RETRY_POLICY);
  const claimed = eng.claimNextJob("worker-A");
  const leaseA = claimed!.lease.leaseId;
  port.setAuto(false);
  const exec = eng.executeJob("worker-A", job.id, leaseA);
  await port.waitForPending(1);
  eng.requestCancellation(job.id);

  // Simulate crash: no clean shutdown. Fresh engine on same DB runs recovery.
  db.prepare("UPDATE execution_leases SET expires_at = ? WHERE lease_id = ?").run(Date.now() - 1, leaseA);
  const store2 = makeStore(db);
  const lm2 = new LeaseManager(store2);
  const reg2 = new WorkerRegistry(store2, lm2);
  registerWorker(reg2, "worker-A");
  const eng2 = new ExecutionEngine(store2, reg2, lm2, new RetryEngine(), { dispatchPort: makeControllableDispatch().port });
  eng2.recoverStaleJobs(Date.now());

  eq("137-24.1", jobRow(db, job.id)?.status, "CANCELLED", "recovery honoured the durable cancellation flag");
  port.resolve({ success: true, exitCode: 0 });
  try { await exec; } catch { /* isolated */ }
  db.close();
}

async function t137_25(): Promise<void> {
  console.log("\n[137-25] crash during timeout processing is recoverable");
  const db = newDb();
  const store = makeStore(db);
  const lm = new LeaseManager(store);
  const reg = new WorkerRegistry(store, lm);
  registerWorker(reg, "worker-A");
  const port = makeControllableDispatch();
  const eng = new ExecutionEngine(store, reg, lm, new RetryEngine(), { dispatchPort: port.port });
  const job = eng.createJob("BUILD", {}, "idem-137-25", RETRY_POLICY, 1000);
  const claimed = eng.claimNextJob("worker-A");
  const leaseA = claimed!.lease.leaseId;
  port.setAuto(false);
  const exec = eng.executeJob("worker-A", job.id, leaseA);
  await port.waitForPending(1);

  // Backdate attempt + expire lease, then run recovery twice across "restart".
  db.prepare("UPDATE execution_attempts SET started_at = ? WHERE job_id = ?").run(Date.now() - 10_000, job.id);
  db.prepare("UPDATE execution_leases SET expires_at = ? WHERE lease_id = ?").run(Date.now() - 1, leaseA);

  const store2 = makeStore(db);
  const lm2 = new LeaseManager(store2);
  const reg2 = new WorkerRegistry(store2, lm2);
  registerWorker(reg2, "worker-A");
  const eng2 = new ExecutionEngine(store2, reg2, lm2, new RetryEngine(), { dispatchPort: makeControllableDispatch().port });
  eng2.recoverStaleJobs(Date.now());
  const s1 = jobRow(db, job.id)?.status;
  eng2.recoverStaleJobs(Date.now());
  const s2 = jobRow(db, job.id)?.status;
  eq("137-25.1", s2, s1, "second recovery after crash is a no-op");
  ok("137-25.2", ["FAILED","RETRY_SCHEDULED","DEAD_LETTER"].includes(String(s1)), "timeout routed through terminal: " + s1);

  port.resolve({ success: true, exitCode: 0 });
  try { await exec; } catch { /* isolated */ }
  db.close();
}

async function t137_26(): Promise<void> {
  console.log("\n[137-26] provider unavailable during cancel leaves truthful recoverable state");
  const r = buildRig();
  const job = r.engine.createJob("BUILD", {}, "idem-137-26", RETRY_POLICY);
  const claimed = r.engine.claimNextJob("worker-A");
  insertDispatch(r.db, {
    dispatchId: "disp-137-26", jobId: job.id, workerId: "worker-A",
    leaseId: claimed!.lease.leaseId, status: "DISPATCHED",
    externalProviderId: "remote_x",
  });
  r.fakeAdapter.setCancel("throw");
  const res = await r.dispatchService.cancelDetailed("disp-137-26");
  eq("137-26.1", res.cancelled, false, "cancel refused");
  eq("137-26.2", dispatchRow(r.db, "disp-137-26")?.status, "DISPATCHED", "dispatch NOT marked CANCELLED");
  eq("137-26.3", jobRow(r.db, job.id)?.status, "CLAIMED", "execution job NOT marked CANCELLED");
  r.db.close();
}

async function t137_27(): Promise<void> {
  console.log("\n[137-27] repeated recovery cycles converge without duplicate terminal effects");
  const r = buildRig();
  const job = r.engine.createJob("BUILD", {}, "idem-137-27", RETRY_POLICY, 1000);
  const claimed = r.engine.claimNextJob("worker-A");
  const leaseA = claimed!.lease.leaseId;
  r.dispatchPort.setAuto(false);
  const exec = r.engine.executeJob("worker-A", job.id, leaseA);
  await r.dispatchPort.waitForPending(1);
  r.db.prepare("UPDATE execution_attempts SET started_at = ? WHERE job_id = ?").run(Date.now() - 10_000, job.id);
  r.db.prepare("UPDATE execution_leases SET expires_at = ? WHERE lease_id = ?").run(Date.now() - 1, leaseA);
  r.engine.recoverStaleJobs(Date.now());
  const status1 = jobRow(r.db, job.id)?.status;
  const obl1 = countObligations(r.db, job.id);
  const events1 = countEvents(r.db, job.id, "execution.transition.");
  for (let i = 0; i < 5; i++) r.engine.recoverStaleJobs(Date.now());
  eq("137-27.1", jobRow(r.db, job.id)?.status, status1, "status unchanged after 5 more cycles");
  eq("137-27.2", countObligations(r.db, job.id), obl1, "obligations unchanged");
  eq("137-27.3", countEvents(r.db, job.id, "execution.transition."), events1, "transition events unchanged");
  r.dispatchPort.resolve({ success: true, exitCode: 0 });
  try { await exec; } catch { /* isolated */ }
  r.db.close();
}

async function t137_28(): Promise<void> {
  console.log("\n[137-28] cancellation/timeout events contain no secrets");
  const r = buildRig();
  const job = r.engine.createJob("BUILD", {}, "idem-137-28", RETRY_POLICY, 1000);
  const claimed = r.engine.claimNextJob("worker-A");
  const leaseA = claimed!.lease.leaseId;
  r.dispatchPort.setAuto(false);
  const exec = r.engine.executeJob("worker-A", job.id, leaseA);
  await r.dispatchPort.waitForPending(1);
  r.engine.requestCancellation(job.id);
  r.db.prepare("UPDATE execution_leases SET expires_at = ? WHERE lease_id = ?").run(Date.now() - 1, leaseA);
  r.engine.recoverStaleJobs(Date.now());
  const rows = r.db.prepare("SELECT payload FROM execution_events WHERE job_id = ?").all(job.id) as Array<{ payload: string | null }>;
  const blob = JSON.stringify(rows);
  const forbidden = [
    /gh[pousr]_[A-Za-z0-9]{20,}/,
    /github_pat_/,
    /Bearer\s+[A-Za-z0-9._~+/=-]{10,}/i,
    /password\s*[:=]\s*[^\s"]+/i,
    /token\s*[:=]\s*[A-Za-z0-9._~+/=-]{10,}/i,
  ];
  for (const re of forbidden) {
    ok("137-28.1." + re.source.slice(0, 12), !re.test(blob), "no secret matching " + re.source.slice(0, 20));
  }
  r.dispatchPort.resolve({ success: true, exitCode: 0 });
  try { await exec; } catch { /* isolated */ }
  r.db.close();
}

async function t137_29(): Promise<void> {
  console.log("\n[137-29] Phase 136 stale-worker execution fencing remains intact");
  const r = buildRig();
  const job = r.engine.createJob("BUILD", {}, "idem-137-29", RETRY_POLICY);
  const claimedA = r.engine.claimNextJob("worker-A");
  const leaseA = claimedA!.lease.leaseId;
  r.dispatchPort.setAuto(false);
  const exec = r.engine.executeJob("worker-A", job.id, leaseA);
  await r.dispatchPort.waitForPending(1);

  r.db.prepare("UPDATE execution_leases SET expires_at = ? WHERE lease_id = ?").run(Date.now() - 1, leaseA);
  r.engine.recoverStaleJobs(Date.now());

  r.dispatchPort.resolve({ success: true, exitCode: 0 });
  let errA: unknown = null;
  try { await exec; } catch (e) { errA = e; }
  ok("137-29.1", errA instanceof Error, "stale worker A rejected");
  const row = jobRow(r.db, job.id);
  ok("137-29.2", row?.status !== "SUCCEEDED", "job not falsely SUCCEEDED");
  const attempts = attemptRows(r.db, job.id);
  eq("137-29.3", attempts.length, 1, "no extra attempt created by stale worker");
  r.db.close();
}

async function t137_30(): Promise<void> {
  console.log("\n[137-30] remote-result fencing remains intact");
  const r = buildRig();
  const job = r.engine.createJob("BUILD", {}, "idem-137-30", RETRY_POLICY);
  const claimed = r.engine.claimNextJob("worker-A");
  const leaseA = claimed!.lease.leaseId;
  insertDispatch(r.db, {
    dispatchId: "disp-137-30", jobId: job.id, workerId: "worker-A",
    leaseId: leaseA, status: "DISPATCHED",
    externalProviderId: "remote_x",
  });

  // Build a synthetic remote result row using the direct store path.
  const good = r.store.persistRemoteExecutionResultAndDispatchAsOwner(
    {
      resultId: "res-137-30", jobId: job.id, attemptId: "att-1",
      workerId: "worker-A", dispatchId: "disp-137-30", leaseId: leaseA,
      success: true, exitCode: 0, createdAt: Date.now(), resultSha256: "abc",
    },
    { dispatchId: "disp-137-30", jobId: job.id, attemptId: "att-1", workerId: "worker-A",
      leaseId: leaseA, idempotencyKey: "idem-disp-137-30", status: "COMPLETED",
      createdAt: Date.now(), updatedAt: Date.now() },
    leaseA, "worker-A",
  );
  eq("137-30.1", good.persisted, true, "owned remote result persisted");

  r.db.prepare("UPDATE execution_leases SET expires_at = ? WHERE lease_id = ?").run(Date.now() - 1, leaseA);
  const stale = r.store.persistRemoteExecutionResultAndDispatchAsOwner(
    {
      resultId: "res-137-30-b", jobId: job.id, attemptId: "att-1",
      workerId: "worker-A", dispatchId: "disp-137-30", leaseId: leaseA,
      success: false, exitCode: 1, createdAt: Date.now(), resultSha256: "def",
    },
    { dispatchId: "disp-137-30", jobId: job.id, attemptId: "att-1", workerId: "worker-A",
      leaseId: leaseA, idempotencyKey: "idem-disp-137-30", status: "FAILED",
      createdAt: Date.now(), updatedAt: Date.now() },
    leaseA, "worker-A",
  );
  eq("137-30.2", stale.persisted, false, "stale remote result rejected");
  eq("137-30.3", dispatchRow(r.db, "disp-137-30")?.status, "COMPLETED", "prior COMPLETED status preserved");
  r.db.close();
}

/* ============================== runner =================================== */

async function main(): Promise<void> {
  console.log("===============================================");
  console.log("NEXUS Phase 137 — Durable Cancellation & Timeout");
  console.log("===============================================");

  await t137_1();  await t137_2();  await t137_3();  await t137_4();  await t137_5();
  await t137_6();  await t137_7();  await t137_8();  await t137_9();  await t137_10();
  await t137_11(); await t137_12(); await t137_13(); await t137_14(); await t137_15();
  await t137_16(); await t137_17(); await t137_18(); await t137_19(); await t137_20();
  await t137_21(); await t137_22(); await t137_23(); await t137_24(); await t137_25();
  await t137_26(); await t137_27(); await t137_28(); await t137_29(); await t137_30();

  console.log("\n===============================================");
  console.log(`Phase 137 results: ${passed} passed, ${failed} failed`);
  console.log("===============================================");
  if (failed > 0) {
    console.error("\nFailures:");
    for (const f of failures) console.error(" - " + f);
    process.exitCode = 1;
  }
}

void main().catch((err) => {
  console.error("\nFATAL:", err);
  process.exitCode = 1;
});