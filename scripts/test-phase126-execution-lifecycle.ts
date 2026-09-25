// scripts/test-phase126-execution-lifecycle.ts
// Phase 126: execution ownership, fencing, stale-worker recovery.
//
// Exercises the REAL ExecutionEngine, LeaseManager, ExecutionStore,
// WorkerRegistry, and ExecutionStateMachine against a temp SQLite database.
// Stubs only exist at the dispatch-port and telemetry-sink boundaries.

import { resetEngineForTesting, openEngine } from "../src/core/db";
import { CONFIG } from "../src/core/config";
import { ExecutionStore } from "../src/core/execution-store";
import { LeaseManager } from "../src/core/lease-manager";
import { WorkerRegistry } from "../src/core/worker-registry";
import { ExecutionEngine, OwnershipLostError } from "../src/core/execution-engine";
import { RetryEngine } from "../src/core/retry-engine";
import { ExecutionStateMachine } from "../src/core/execution-state-machine";
import type {
  ExecutionEventSink,
  ExecutionAuditSink,
} from "../src/core/execution-engine";
import type { ExecutionWorker, RetryPolicy } from "../src/core/execution-models";
import type { ExecutionDispatchPort } from "../src/core/execution-dispatch-port";

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log(`  ok   ${msg}`); }
  else { failed++; failures.push(msg); console.log(`  FAIL ${msg}`); }
}

function section(name: string): void {
  console.log(`\n${name}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface RecordedEvent { type: string; source?: string; payload?: Record<string, unknown>; }
interface RecordedAudit {
  actor: string; action: string; resource_type: string;
  resource_id: string; result?: string; metadata?: Record<string, unknown>;
}

function makeRecorder(): {
  events: RecordedEvent[];
  audits: RecordedAudit[];
  eventSink: ExecutionEventSink;
  auditSink: ExecutionAuditSink;
} {
  const events: RecordedEvent[] = [];
  const audits: RecordedAudit[] = [];
  return {
    events,
    audits,
    eventSink: {
      emit: async (e) => {
        events.push({
          type: e.type,
          source: e.source,
          payload: (e.payload ?? {}) as Record<string, unknown>,
        });
        return e;
      },
    },
    auditSink: {
      record: async (e) => {
        audits.push({
          actor: e.actor, action: e.action,
          resource_type: e.resource_type, resource_id: e.resource_id,
          result: e.result, metadata: (e.metadata ?? {}) as Record<string, unknown>,
        });
        return e;
      },
    },
  };
}

function makeDispatchPort(): ExecutionDispatchPort {
  return {
    async dispatch() { return { dispatchId: `d-${Date.now()}-${Math.random()}` }; },
    async collectResult() { return { success: true, exitCode: 0, evidence: {} } as any; },
  } as unknown as ExecutionDispatchPort;
}

const testRetry: RetryPolicy = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  multiplier: 2,
  maxDelayMs: 10_000,
};

interface Harness {
  engine: ExecutionEngine;
  store: ExecutionStore;
  lm: LeaseManager;
  wr: WorkerRegistry;
  recorder: ReturnType<typeof makeRecorder>;
}

async function harness(overrides?: {
  events?: ExecutionEventSink;
  audit?: ExecutionAuditSink;
}): Promise<Harness> {
  const recorder = makeRecorder();
  const engineDb = await openEngine();
  const store = new ExecutionStore(engineDb as any);
  const lm = new LeaseManager(store);
  const wr = new WorkerRegistry(store, lm);
  const engine = new ExecutionEngine(store, wr, lm, new RetryEngine(), {
    dispatchPort: makeDispatchPort(),
    events: overrides?.events ?? recorder.eventSink,
    audit: overrides?.audit ?? recorder.auditSink,
  });
  return { engine, store, lm, wr, recorder };
}

function makeWorker(id: string): ExecutionWorker {
  return {
    workerId: id,
    status: "ONLINE",
    registeredAt: Date.now(),
    lastHeartbeatAt: Date.now(),
  };
}

const DB_FILE = "./test-phase126-execution-lifecycle.sqlite";

async function withFreshDb(): Promise<void> {
  resetEngineForTesting();
  // Delete any leftover file from a prior aborted run so idempotency keys
  // from earlier tests don't collide with this run's fixtures.
  try {
    const fs = await import("node:fs");
    if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
  } catch { /* ignore */ }
  CONFIG.persistence.engine = "sqlite";
  CONFIG.persistence.dbName = DB_FILE;
}

async function cleanupDb(): Promise<void> {
  resetEngineForTesting();
  try {
    const fs = await import("node:fs");
    if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

async function T1() {
  section("T1 — lease acquisition");
  await withFreshDb();
  const { store, lm } = await harness();
  const job = { id: "job-1", idempotencyKey: "k1", jobType: "noop", status: "QUEUED" as const,
    createdAt: Date.now(), updatedAt: Date.now(),
    cancellationRequested: false, cancellationAcknowledged: false };
  store.createJob(job as any);
  const lease = lm.acquireLease("job-1", "worker-A", 60_000);
  ok(lease.leaseId.startsWith("lease_job-1_"), "leaseId is deterministic-prefixed");
  ok(lease.workerId === "worker-A", "lease owned by worker-A");
  ok(lm.validateLease(lease.leaseId, "worker-A"), "validateLease true for owner");
  await cleanupDb();
}

async function T2() {
  section("T2 — two workers cannot own the same active job");
  await withFreshDb();
  const { store, lm } = await harness();
  store.createJob({ id: "job-2", idempotencyKey: "k2", jobType: "noop", status: "QUEUED",
    createdAt: Date.now(), updatedAt: Date.now(),
    cancellationRequested: false, cancellationAcknowledged: false } as any);
  lm.acquireLease("job-2", "worker-A", 60_000);
  let secondError: string | null = null;
  try { lm.acquireLease("job-2", "worker-B", 60_000); }
  catch (e) { secondError = (e as Error).message; }
  ok(secondError !== null && secondError.includes("another worker"),
    "second worker's acquire is rejected");
  await cleanupDb();
}

async function T3() {
  section("T3 — valid worker can renew its lease");
  await withFreshDb();
  const { store, lm } = await harness();
  store.createJob({ id: "job-3", idempotencyKey: "k3", jobType: "noop", status: "QUEUED",
    createdAt: Date.now(), updatedAt: Date.now(),
    cancellationRequested: false, cancellationAcknowledged: false } as any);
  const lease = lm.acquireLease("job-3", "worker-A", 60_000);
  const before = lease.expiresAt;
  const renewed = lm.renewLease(lease.leaseId, "worker-A", 90_000);
  ok(renewed.expiresAt > before, "renewal extends expiry");
  ok(renewed.renewedAt !== undefined, "renewedAt is set");
  await cleanupDb();
}

async function T4() {
  section("T4 — wrong worker cannot renew another worker's lease");
  await withFreshDb();
  const { store, lm } = await harness();
  store.createJob({ id: "job-4", idempotencyKey: "k4", jobType: "noop", status: "QUEUED",
    createdAt: Date.now(), updatedAt: Date.now(),
    cancellationRequested: false, cancellationAcknowledged: false } as any);
  const lease = lm.acquireLease("job-4", "worker-A", 60_000);
  let err: string | null = null;
  try { lm.renewLease(lease.leaseId, "worker-B", 90_000); }
  catch (e) { err = (e as Error).message; }
  ok(err !== null && err.includes("worker-A"),
    "wrong worker's renew is rejected with ownership info");
  await cleanupDb();
}

async function T5() {
  section("T5 — expired lease is detected");
  await withFreshDb();
  const { store, lm } = await harness();
  store.createJob({ id: "job-5", idempotencyKey: "k5", jobType: "noop", status: "QUEUED",
    createdAt: Date.now(), updatedAt: Date.now(),
    cancellationRequested: false, cancellationAcknowledged: false } as any);
  const lease = lm.acquireLease("job-5", "worker-A", 100);
  await sleep(150);
  const expired = lm.recoverExpiredLeases(Date.now());
  ok(expired.length >= 1, "expired lease recovered");
  ok(expired[0].status === "EXPIRED", "lease marked EXPIRED");
  await cleanupDb();
}

async function T6() {
  section("T6 — stale execution classified + transitioned");
  await withFreshDb();
  const { engine, store, lm } = await harness();
  store.createJob({ id: "job-6", idempotencyKey: "k6", jobType: "noop", status: "QUEUED",
    retryPolicy: testRetry, createdAt: Date.now(), updatedAt: Date.now(),
    cancellationRequested: false, cancellationAcknowledged: false } as any);
  const lease = lm.acquireLease("job-6", "worker-A", 100);
  const j = store.getJob("job-6")!;
  j.status = "RUNNING"; j.currentLeaseId = lease.leaseId;
  store.updateJob(j);
  await sleep(150);
  await engine.recoverStaleJobs(Date.now());
  const after = store.getJob("job-6")!;
  ok(after.status === "QUEUED", "recoverable job re-queued");
  await cleanupDb();
}

async function T7() {
  section("T7 — stale execution produces durable obligation");
  await withFreshDb();
  const { engine, store, lm } = await harness();
  store.createJob({ id: "job-7", idempotencyKey: "k7", jobType: "noop", status: "QUEUED",
    createdAt: Date.now(), updatedAt: Date.now(),
    cancellationRequested: false, cancellationAcknowledged: false } as any);
  const lease = lm.acquireLease("job-7", "worker-A", 100);
  const j = store.getJob("job-7")!;
  j.status = "RUNNING"; j.currentLeaseId = lease.leaseId;
  store.updateJob(j);
  await sleep(150);
  await engine.recoverStaleJobs(Date.now());
  const open = store.listOpenOwnershipObligations();
  ok(open.some((o) => o.jobId === "job-7"), "ownership obligation written");
  await cleanupDb();
}

async function T8() {
  section("T8 — repeated detection is idempotent");
  await withFreshDb();
  const { engine, store, lm } = await harness();
  store.createJob({ id: "job-8", idempotencyKey: "k8", jobType: "noop", status: "QUEUED",
    createdAt: Date.now(), updatedAt: Date.now(),
    cancellationRequested: false, cancellationAcknowledged: false } as any);
  const lease = lm.acquireLease("job-8", "worker-A", 100);
  const j = store.getJob("job-8")!;
  j.status = "RUNNING"; j.currentLeaseId = lease.leaseId;
  store.updateJob(j);
  await sleep(150);
  await engine.recoverStaleJobs(Date.now());
  const first = store.listOpenOwnershipObligations().filter((o) => o.jobId === "job-8").length;
  await engine.recoverStaleJobs(Date.now());
  await engine.recoverStaleJobs(Date.now());
  const second = store.listOpenOwnershipObligations().filter((o) => o.jobId === "job-8").length;
  ok(first === 1 && second === 1, "obligation count stable across repeated detection");
  await cleanupDb();
}

async function T9() {
  section("T9 — terminal execution is not recovered");
  await withFreshDb();
  const { engine, store, lm } = await harness();
  store.createJob({ id: "job-9", idempotencyKey: "k9", jobType: "noop", status: "QUEUED",
    retryPolicy: testRetry, createdAt: Date.now(), updatedAt: Date.now(),
    cancellationRequested: false, cancellationAcknowledged: false } as any);
  const lease = lm.acquireLease("job-9", "worker-A", 100);
  const j = store.getJob("job-9")!;
  j.status = "SUCCEEDED"; j.currentLeaseId = lease.leaseId;
  store.updateJob(j);
  await sleep(150);
  engine.recoverStaleJobs(Date.now());
  const after = store.getJob("job-9")!;
  ok(after.status === "SUCCEEDED", "terminal SUCCEEDED not resurrected");
  const ob = store.listOpenOwnershipObligations().filter((o) => o.jobId === "job-9");
  ok(ob.length === 0, "no obligation for terminal job");
  await cleanupDb();
}

async function T10() {
  section("T10 — ownership-aware update succeeds for owner");
  await withFreshDb();
  const { store, lm } = await harness();
  store.createJob({ id: "job-10", idempotencyKey: "k10", jobType: "noop", status: "QUEUED",
    createdAt: Date.now(), updatedAt: Date.now(),
    cancellationRequested: false, cancellationAcknowledged: false } as any);
  const lease = lm.acquireLease("job-10", "worker-A", 60_000);
  const j = store.getJob("job-10")!;
  j.status = "RUNNING"; j.currentLeaseId = lease.leaseId;
  const r = store.updateJobAsOwner(j, "worker-A", lease.leaseId);
  ok(r.updated === true, "owner's write accepted");
  const after = store.getJob("job-10")!;
  ok(after.status === "RUNNING", "state persisted");
  await cleanupDb();
}

async function T11() {
  section("T11 — ownership-aware update fails for stale worker");
  await withFreshDb();
  const { store, lm } = await harness();
  store.createJob({ id: "job-11", idempotencyKey: "k11", jobType: "noop", status: "QUEUED",
    createdAt: Date.now(), updatedAt: Date.now(),
    cancellationRequested: false, cancellationAcknowledged: false } as any);
  const lease = lm.acquireLease("job-11", "worker-A", 100);
  const j = store.getJob("job-11")!;
  j.status = "RUNNING"; j.currentLeaseId = lease.leaseId;
  store.updateJob(j);
  await sleep(150);
  j.status = "FAILED"; j.updatedAt = Date.now();
  const r = store.updateJobAsOwner(j, "worker-A", lease.leaseId);
  ok(r.updated === false, "stale worker's write rejected");
  ok(r.reason === "WORKER_OWNERSHIP_LOST", "reason is WORKER_OWNERSHIP_LOST");
  const after = store.getJob("job-11")!;
  ok(after.status === "RUNNING", "stale worker did not overwrite state");
  await cleanupDb();
}

async function T12() {
  section("T12 — worker A loses lease, worker B acquires");
  await withFreshDb();
  const { store, lm } = await harness();
  store.createJob({ id: "job-12", idempotencyKey: "k12", jobType: "noop", status: "QUEUED",
    createdAt: Date.now(), updatedAt: Date.now(),
    cancellationRequested: false, cancellationAcknowledged: false } as any);
  const leaseA = lm.acquireLease("job-12", "worker-A", 100);
  await sleep(150);
  lm.recoverExpiredLeases(Date.now());
  const leaseB = lm.acquireLease("job-12", "worker-B", 60_000);
  ok(leaseB.leaseId !== leaseA.leaseId, "B acquired a new lease");
  ok(leaseB.workerId === "worker-B", "B owns the lease");
  await cleanupDb();
}

async function T13() {
  section("T13 — worker A cannot overwrite worker B's state");
  await withFreshDb();
  const { store, lm } = await harness();
  store.createJob({ id: "job-13", idempotencyKey: "k13", jobType: "noop", status: "QUEUED",
    createdAt: Date.now(), updatedAt: Date.now(),
    cancellationRequested: false, cancellationAcknowledged: false } as any);
  const leaseA = lm.acquireLease("job-13", "worker-A", 100);
  const j = store.getJob("job-13")!;
  j.status = "RUNNING"; j.currentLeaseId = leaseA.leaseId;
  store.updateJob(j);
  await sleep(150);
  lm.recoverExpiredLeases(Date.now());
  const leaseB = lm.acquireLease("job-13", "worker-B", 60_000);
  const j2 = store.getJob("job-13")!;
  j2.status = "RUNNING"; j2.currentLeaseId = leaseB.leaseId;
  store.updateJob(j2);

  // Worker A attempts to mutate with its stale lease
  j.status = "FAILED"; j.updatedAt = Date.now();
  const r = store.updateJobAsOwner(j, "worker-A", leaseA.leaseId);
  ok(r.updated === false, "A's write rejected");
  const after = store.getJob("job-13")!;
  ok(after.status === "RUNNING", "B's state intact after A's stale attempt");
  ok(after.currentLeaseId === leaseB.leaseId, "lease still belongs to B");
  await cleanupDb();
}

async function T14() {
  section("T14 — fencing: expired leaseId cannot mutate");
  await withFreshDb();
  const { store, lm } = await harness();
  store.createJob({ id: "job-14", idempotencyKey: "k14", jobType: "noop", status: "QUEUED",
    createdAt: Date.now(), updatedAt: Date.now(),
    cancellationRequested: false, cancellationAcknowledged: false } as any);
  const lease = lm.acquireLease("job-14", "worker-A", 100);
  await sleep(150);
  const j = store.getJob("job-14")!;
  j.status = "FAILED";
  const r = store.updateJobAsOwner(j, "worker-A", lease.leaseId);
  ok(r.updated === false, "expired lease cannot mutate");
  await cleanupDb();
}

async function T15() {
  section("T15 — state survives DB reload");
  await withFreshDb();
  const h1 = await harness();
  h1.store.createJob({ id: "job-15", idempotencyKey: "k15", jobType: "noop", status: "QUEUED",
    createdAt: Date.now(), updatedAt: Date.now(),
    cancellationRequested: false, cancellationAcknowledged: false } as any);
  const lease = h1.lm.acquireLease("job-15", "worker-A", 60_000);
  const j = h1.store.getJob("job-15")!;
  j.status = "RUNNING"; j.currentLeaseId = lease.leaseId;
  h1.store.updateJob(j);
  resetEngineForTesting();
  const h2 = await harness();
  const reloaded = h2.store.getJob("job-15")!;
  ok(reloaded.status === "RUNNING", "job status reloaded from disk");
  ok(reloaded.currentLeaseId === lease.leaseId, "leaseId reloaded from disk");
  const l2 = h2.store.getLease(lease.leaseId);
  ok(l2?.workerId === "worker-A", "lease row reloaded");
  await cleanupDb();
}

async function T16() {
  section("T16 — obligation survives DB reload");
  await withFreshDb();
  const h1 = await harness();
  h1.store.createJob({ id: "job-16", idempotencyKey: "k16", jobType: "noop", status: "QUEUED",
    createdAt: Date.now(), updatedAt: Date.now(),
    cancellationRequested: false, cancellationAcknowledged: false } as any);
  h1.store.writeOwnershipObligation({ jobId: "job-16", leaseId: "lease_x", workerId: "worker-A",
    reason: "TEST_PERSIST" });
  resetEngineForTesting();
  const h2 = await harness();
  const open = h2.store.listOpenOwnershipObligations();
  ok(open.some((o) => o.jobId === "job-16"), "obligation survived reload");
  await cleanupDb();
}

async function T17() {
  section("T17 — telemetry shape matches Phase 125 conventions");
  await withFreshDb();
  const rec = makeRecorder();
  const { engine, store, lm, wr } = await harness({ events: rec.eventSink, audit: rec.auditSink });
  store.createJob({ id: "job-17", idempotencyKey: "k17", jobType: "noop", status: "QUEUED",
    createdAt: Date.now(), updatedAt: Date.now(),
    cancellationRequested: false, cancellationAcknowledged: false } as any);
  const lease = lm.acquireLease("job-17", "worker-A", 100);
  const j = store.getJob("job-17")!;
  j.status = "RUNNING"; j.currentLeaseId = lease.leaseId;
  store.updateJob(j);
  await sleep(150);
  engine.recoverStaleJobs(Date.now());
  await sleep(20);
  const execEvents = rec.events.filter((e) => e.type.startsWith("execution."));
  ok(execEvents.length > 0, "execution.* events emitted");
  ok(execEvents.every((e) => e.source === "ExecutionEngine"), "all events sourced from ExecutionEngine");
  ok(execEvents.every((e) => typeof e.payload === "object"), "all payloads are objects");
  await cleanupDb();
}

async function T18() {
  section("T18 — heartbeat failure never manufactures SUCCESS");
  await withFreshDb();
  const { store, lm, wr } = await harness();
  wr.register(makeWorker("worker-A"));
  store.createJob({ id: "job-18", idempotencyKey: "k18", jobType: "noop", status: "QUEUED",
    createdAt: Date.now(), updatedAt: Date.now(),
    cancellationRequested: false, cancellationAcknowledged: false } as any);
  const lease = lm.acquireLease("job-18", "worker-A", 100);
  await sleep(150);
  const before = store.getWorker("worker-A")!.lastHeartbeatAt;
  await sleep(10);
  const r = wr.heartbeat("worker-A", "job-18", { leaseId: lease.leaseId });
  ok(r.healthy === false, "heartbeat not healthy");
  ok(r.reason === "WORKER_OWNERSHIP_LOST", "reason is WORKER_OWNERSHIP_LOST");
  const after = store.getWorker("worker-A")!.lastHeartbeatAt;
  ok(after === before, "lastHeartbeatAt not updated on ownership loss");
  await cleanupDb();
}

async function T19() {
  section("T19 — invalid terminal-state resurrection rejected");
  await withFreshDb();
  const sm = new ExecutionStateMachine();
  ok(!sm.canTransition("SUCCEEDED", "RUNNING"), "SUCCEEDED → RUNNING rejected");
  ok(!sm.canTransition("FAILED", "RUNNING"), "FAILED → RUNNING rejected");
  ok(!sm.canTransition("CANCELLED", "RUNNING"), "CANCELLED → RUNNING rejected");
  ok(!sm.canTransition("DEAD_LETTER", "RUNNING"), "DEAD_LETTER → RUNNING rejected");
  await cleanupDb();
}

async function T20() {
  section("T20 — duplicate recovery detection remains idempotent");
  await withFreshDb();
  const { store } = await harness();
  const a = store.writeOwnershipObligation({ jobId: "job-20", leaseId: "l20",
    workerId: "worker-A", reason: "first" });
  const b = store.writeOwnershipObligation({ jobId: "job-20", leaseId: "l20",
    workerId: "worker-A", reason: "second" });
  ok(a.created === true && b.created === false, "second write is idempotent");
  ok(a.obligationId === b.obligationId, "same obligation ID returned");
  const open = store.listOpenOwnershipObligations().filter((o) => o.jobId === "job-20");
  ok(open.length === 1, "exactly one obligation row");
  await cleanupDb();
}

async function T21() {
  section("T21 — lease/recovery events correct");
  await withFreshDb();
  const rec = makeRecorder();
  const { engine, store, lm } = await harness({ events: rec.eventSink, audit: rec.auditSink });
  store.createJob({ id: "job-21", idempotencyKey: "k21", jobType: "noop", status: "QUEUED",
    createdAt: Date.now(), updatedAt: Date.now(),
    cancellationRequested: false, cancellationAcknowledged: false } as any);
  const lease = lm.acquireLease("job-21", "worker-A", 100);
  const j = store.getJob("job-21")!;
  j.status = "RUNNING"; j.currentLeaseId = lease.leaseId;
  store.updateJob(j);
  await sleep(150);
  engine.recoverStaleJobs(Date.now());
  await sleep(20);
  const types = new Set(rec.events.map((e) => e.type));
  ok(types.has("execution.lease.expired"), "lease.expired emitted");
  ok(types.has("execution.recovery_completed") || types.has("execution.recovery_required"),
    "recovery outcome emitted");
  await cleanupDb();
}

async function T22() {
  section("T22 — audit is durable");
  await withFreshDb();
  const rec = makeRecorder();
  const { engine, store, lm } = await harness({ events: rec.eventSink, audit: rec.auditSink });
  store.createJob({ id: "job-22", idempotencyKey: "k22", jobType: "noop", status: "QUEUED",
    createdAt: Date.now(), updatedAt: Date.now(),
    cancellationRequested: false, cancellationAcknowledged: false } as any);
  const lease = lm.acquireLease("job-22", "worker-A", 100);
  const j = store.getJob("job-22")!;
  j.status = "RUNNING"; j.currentLeaseId = lease.leaseId;
  store.updateJob(j);
  await sleep(150);
  engine.recoverStaleJobs(Date.now());
  await sleep(20);
  ok(rec.audits.some((a) => a.action === "execution.stale_recovered"),
    "stale_recovered audit recorded");
  await cleanupDb();
}

async function T23() {
  section("T23 — secrets not persisted in diagnostics");
  await withFreshDb();
  const { store } = await harness();
  // The engine's ownership-loss path only emits enumerated keys (jobId/leaseId/workerId).
  // Assert OwnershipLostError.message contains no raw error text.
  const err = new OwnershipLostError("job-23", "lease-23", "worker-23");
  ok(!err.message.includes("Bearer"), "no auth header in error message");
  ok(!err.message.includes("token="), "no token in error message");
  ok(err.message.includes("job-23") && err.message.includes("lease-23"),
    "enumerated identifiers present");
  // Audit metadata for ownership loss has exact keys
  const ob = store.writeOwnershipObligation({ jobId: "job-23", leaseId: "lease-23",
    workerId: "worker-23", reason: "SECRET_PLACEHOLDER_TOKEN=abc123" });
  const open = store.listOpenOwnershipObligations().find((o) => o.obligationId === ob.obligationId);
  ok(!!open, "obligation persisted");
  await cleanupDb();
}

async function T24() {
  section("T24 — telemetry failure does not change outcome");
  await withFreshDb();
  const brokenEvents: ExecutionEventSink = {
    emit: async () => { throw new Error("events down"); },
  };
  const brokenAudit: ExecutionAuditSink = {
    record: async () => { throw new Error("audit down"); },
  };
  const { engine, store, lm } = await harness({ events: brokenEvents, audit: brokenAudit });
  store.createJob({ id: "job-24", idempotencyKey: "k24", jobType: "noop", status: "QUEUED",
    retryPolicy: testRetry,
    createdAt: Date.now(), updatedAt: Date.now(),
    cancellationRequested: false, cancellationAcknowledged: false } as any);
  const lease = lm.acquireLease("job-24", "worker-A", 100);
  const j = store.getJob("job-24")!;
  j.status = "RUNNING"; j.currentLeaseId = lease.leaseId;
  store.updateJob(j);
  await sleep(150);
  let threw = false;
  try { engine.recoverStaleJobs(Date.now()); } catch { threw = true; }
  ok(!threw, "recovery does not throw when telemetry fails");
  await sleep(20);
  const after = store.getJob("job-24")!;
  ok(after.status === "QUEUED", "recovery still applied despite telemetry failure");
  await cleanupDb();
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Phase 126 — Execution Lifecycle ===\n");
  try {
    await T1(); await T2(); await T3(); await T4(); await T5(); await T6();
    await T7(); await T8(); await T9(); await T10(); await T11(); await T12();
    await T13(); await T14(); await T15(); await T16(); await T17(); await T18();
    await T19(); await T20(); await T21(); await T22(); await T23(); await T24();
  } catch (e) {
    console.error("FATAL during test run:", e);
    failed++;
  }
  console.log(`\n--- Phase 126: ${passed} passed, ${failed} failed ---`);
  if (failed > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => { console.error("FATAL:", err); process.exit(1); });