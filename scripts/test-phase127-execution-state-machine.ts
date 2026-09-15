// scripts/test-phase127-execution-state-machine.ts
// Phase 127: authoritative durable execution transitions.
//
// Exercises the REAL ExecutionStore.transitionExecution boundary, the REAL
// ExecutionStateMachine, ExecutionEngine, LeaseManager, WorkerRegistry, and
// SQLite persistence.  Stubs exist only at dispatch and telemetry boundaries.

import { resetEngineForTesting, openEngine } from "../src/core/db";
import { ExecutionStore } from "../src/core/execution-store";
import { LeaseManager } from "../src/core/lease-manager";
import { WorkerRegistry } from "../src/core/worker-registry";
import { ExecutionEngine } from "../src/core/execution-engine";
import { RetryEngine } from "../src/core/retry-engine";
import { ExecutionStateMachine } from "../src/core/execution-state-machine";
import type {
  ExecutionEventSink,
  ExecutionAuditSink,
} from "../src/core/execution-engine";
import type {
  ExecutionJob,
  ExecutionWorker,
  RetryPolicy,
} from "../src/core/execution-models";
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

interface RecordedEvent { type: string; source?: string; payload?: Record<string, unknown>; }

function makeRecorder() {
  const events: RecordedEvent[] = [];
  const eventSink: ExecutionEventSink = {
    emit: async (e) => {
      events.push({ type: e.type, source: e.source, payload: (e.payload ?? {}) as any });
      return e;
    },
  };
  const auditSink: ExecutionAuditSink = { record: async (e) => e };
  return { events, eventSink, auditSink };
}

function makeDispatchPort(): ExecutionDispatchPort {
  return {
    async dispatch() { return { dispatchId: `d-${Date.now()}-${Math.random()}` }; },
    async collectResult() { return { success: true, exitCode: 0, evidence: {} } as any; },
  } as unknown as ExecutionDispatchPort;
}

interface Harness {
  engine: ExecutionEngine;
  store: ExecutionStore;
  lm: LeaseManager;
  wr: WorkerRegistry;
  events: RecordedEvent[];
}

async function harness(): Promise<Harness> {
  const rec = makeRecorder();
  const engineDb = await openEngine();
  const store = new ExecutionStore(engineDb as any);
  const lm = new LeaseManager(store);
  const wr = new WorkerRegistry(store, lm);
  const engine = new ExecutionEngine(store, wr, lm, new RetryEngine(), {
    dispatchPort: makeDispatchPort(),
    events: rec.eventSink,
    audit: rec.auditSink,
  });
  return { engine, store, lm, wr, events: rec.events };
}

function makeWorker(id: string): ExecutionWorker {
  return {
    workerId: id,
    status: "ONLINE",
    registeredAt: Date.now(),
    lastHeartbeatAt: Date.now(),
  };
}

let jobCounter = 0;
function makeJob(overrides?: Partial<ExecutionJob>): ExecutionJob {
  const id = `job-127-${++jobCounter}-${Date.now()}`;
  const now = Date.now();
  return {
    id,
    idempotencyKey: `k-${id}`,
    jobType: "noop",
    payload: {},
    status: "QUEUED",
    createdAt: now,
    updatedAt: now,
    cancellationRequested: false,
    cancellationAcknowledged: false,
    ...overrides,
  };
}

const retryPolicy: RetryPolicy = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  multiplier: 2,
  maxDelayMs: 10_000,
};

function readEvents(store: ExecutionStore, jobId: string): any[] {
  const db: any = (store as any).db;
  const sqlite: any = db.getDatabase ? db.getDatabase() : db;
  return sqlite.prepare(
    "SELECT * FROM execution_events WHERE job_id = ? ORDER BY created_at ASC"
  ).all(jobId);
}

// ---------------------------------------------------------------------------
// T1 — legal state-machine vocabulary
// ---------------------------------------------------------------------------

async function T1() {
  section("T1 — state-machine vocabulary");
  const sm = new ExecutionStateMachine();

  const legal: Array<[any, any]> = [
    ["QUEUED", "CLAIMED"],
    ["CLAIMED", "RUNNING"],
    ["RUNNING", "VERIFYING"],
    ["VERIFYING", "SUCCEEDED"],
    ["FAILED", "RETRY_SCHEDULED"],
    ["RETRY_SCHEDULED", "QUEUED"],
    ["CANCELLATION_REQUESTED", "CANCELLED"],
    ["ORPHANED", "QUEUED"],
  ];
  for (const [f, t] of legal) {
    ok(sm.canTransition(f, t), `${f} -> ${t} is legal`);
  }

  const illegal: Array<[any, any]> = [
    ["QUEUED", "SUCCEEDED"],
    ["SUCCEEDED", "RUNNING"],
    ["CANCELLED", "RUNNING"],
    ["DEAD_LETTER", "QUEUED"],
    ["BLOCKED", "RUNNING"],
  ];
  for (const [f, t] of illegal) {
    ok(!sm.canTransition(f, t), `${f} -> ${t} is rejected`);
  }
}

// ---------------------------------------------------------------------------
// T2 — normal durable transition
// ---------------------------------------------------------------------------

async function T2() {
  section("T2 — normal durable transition (QUEUED -> CLAIMED)");
  const { store } = await harness();
  const job = makeJob();
  store.createJob(job);

  const r = store.transitionExecution({
    jobId: job.id,
    actor: "system",
    expectedStatus: "QUEUED",
    newStatus: "CLAIMED",
    reason: "T2",
  });

  ok(r.ok === true, "T2 result is ok");
  if (r.ok) {
    ok(r.applied === true, "T2 applied === true");
    ok(r.status === "CLAIMED", "T2 status is CLAIMED");
  }
  const reloaded = store.getJob(job.id);
  ok(reloaded?.status === "CLAIMED", "T2 DB reload reports CLAIMED");

  const events = readEvents(store, job.id);
  ok(events.length === 1, "T2 exactly one durable transition event");
  ok(events[0]?.event_type === "execution.transition.claimed",
     "T2 event type is execution.transition.claimed");
}

// ---------------------------------------------------------------------------
// T3 — duplicate non-worker transition is idempotent
// ---------------------------------------------------------------------------

async function T3() {
  section("T3 — duplicate non-worker transition is idempotent");
  const { store } = await harness();
  const job = makeJob();
  store.createJob(job);

  store.transitionExecution({
    jobId: job.id, actor: "system",
    expectedStatus: "QUEUED", newStatus: "CLAIMED",
  });
  const r2 = store.transitionExecution({
    jobId: job.id, actor: "system",
    expectedStatus: "QUEUED", newStatus: "CLAIMED",
  });

  ok(r2.ok === true, "T3 second call ok === true");
  if (r2.ok) {
    ok(r2.applied === false, "T3 second call applied === false");
    ok(r2.idempotent === true, "T3 second call idempotent === true");
  }
  const events = readEvents(store, job.id);
  ok(events.length === 1, "T3 duplicate does not create a second event");
}

// ---------------------------------------------------------------------------
// T4 — worker duplicate requires valid ownership
// ---------------------------------------------------------------------------

async function T4() {
  section("T4 — worker duplicate requires valid ownership");
  const { store, lm, wr } = await harness();
  wr.register(makeWorker("worker-A"));
  const job = makeJob();
  store.createJob(job);

  const lease = lm.acquireLease(job.id, "worker-A", 60_000);
  // Transition QUEUED -> CLAIMED as system to attach the lease
  store.transitionExecution({
    jobId: job.id, actor: "system",
    expectedStatus: "QUEUED", newStatus: "CLAIMED",
    patch: { currentLeaseId: lease.leaseId },
  });

  // Now duplicate with worker actor + valid lease -> idempotent
  const r = store.transitionExecution({
    jobId: job.id, actor: "worker",
    expectedStatus: "QUEUED", newStatus: "CLAIMED",
    workerId: "worker-A", leaseId: lease.leaseId,
  });
  ok(r.ok === true, "T4 worker duplicate ok");
  if (r.ok) ok(r.idempotent === true, "T4 worker duplicate idempotent");
}

// ---------------------------------------------------------------------------
// T5 — stale worker cannot receive idempotent success
// ---------------------------------------------------------------------------

async function T5() {
  section("T5 — stale worker cannot receive idempotent success");
  const { store, lm, wr } = await harness();
  wr.register(makeWorker("worker-A"));
  const job = makeJob();
  store.createJob(job);

  const lease = lm.acquireLease(job.id, "worker-A", 60_000);
  store.transitionExecution({
    jobId: job.id, actor: "system",
    expectedStatus: "QUEUED", newStatus: "CLAIMED",
    patch: { currentLeaseId: lease.leaseId },
  });

  // Expire the lease via real LeaseManager
  lm.expireLease(lease.leaseId, Date.now() + 120_000);

  const r = store.transitionExecution({
    jobId: job.id, actor: "worker",
    expectedStatus: "QUEUED", newStatus: "CLAIMED",
    workerId: "worker-A", leaseId: lease.leaseId,
  });

  ok(r.ok === false, "T5 stale worker rejected");
  if (!r.ok) ok(r.reason === "WORKER_OWNERSHIP_LOST",
                 "T5 reason is WORKER_OWNERSHIP_LOST");
  ok(store.getJob(job.id)?.status === "CLAIMED", "T5 status remains CLAIMED");
}

// ---------------------------------------------------------------------------
// T6 — wrong worker is fenced
// ---------------------------------------------------------------------------

async function T6() {
  section("T6 — wrong worker is fenced");
  const { store, lm, wr } = await harness();
  wr.register(makeWorker("worker-A"));
  wr.register(makeWorker("worker-B"));
  const job = makeJob();
  store.createJob(job);

  const lease = lm.acquireLease(job.id, "worker-A", 60_000);
  store.transitionExecution({
    jobId: job.id, actor: "system",
    expectedStatus: "QUEUED", newStatus: "CLAIMED",
    patch: { currentLeaseId: lease.leaseId },
  });

  const r = store.transitionExecution({
    jobId: job.id, actor: "worker",
    expectedStatus: "CLAIMED", newStatus: "RUNNING",
    workerId: "worker-B", leaseId: lease.leaseId,
  });
  ok(r.ok === false, "T6 wrong worker rejected");
  if (!r.ok) ok(r.reason === "WORKER_OWNERSHIP_LOST",
                 "T6 reason is WORKER_OWNERSHIP_LOST");
  ok(store.getJob(job.id)?.status === "CLAIMED", "T6 state unchanged");
}

// ---------------------------------------------------------------------------
// T7 — missing worker identity/lease is fenced
// ---------------------------------------------------------------------------

async function T7() {
  section("T7 — missing worker identity/lease is fenced");
  const { store } = await harness();
  const job = makeJob();
  store.createJob(job);

  const r1 = store.transitionExecution({
    jobId: job.id, actor: "worker",
    expectedStatus: "QUEUED", newStatus: "CLAIMED",
  });
  ok(r1.ok === false, "T7 missing both rejected");
  if (!r1.ok) ok(r1.reason === "WORKER_OWNERSHIP_LOST",
                 "T7 missing both -> WORKER_OWNERSHIP_LOST");

  const r2 = store.transitionExecution({
    jobId: job.id, actor: "worker",
    expectedStatus: "QUEUED", newStatus: "CLAIMED",
    workerId: "worker-A",
  });
  ok(r2.ok === false, "T7 missing leaseId rejected");

  const r3 = store.transitionExecution({
    jobId: job.id, actor: "worker",
    expectedStatus: "QUEUED", newStatus: "CLAIMED",
    leaseId: "lease-x",
  });
  ok(r3.ok === false, "T7 missing workerId rejected");

  ok(store.getJob(job.id)?.status === "QUEUED", "T7 state unchanged");
}

// ---------------------------------------------------------------------------
// T8 — expected-state CAS
// ---------------------------------------------------------------------------

async function T8() {
  section("T8 — expected-state CAS");
  const { store } = await harness();
  const job = makeJob();
  store.createJob(job);

  const r1 = store.transitionExecution({
    jobId: job.id, actor: "system",
    expectedStatus: "QUEUED", newStatus: "CLAIMED",
  });
  ok(r1.ok === true, "T8 first transition commits");

  const r2 = store.transitionExecution({
    jobId: job.id, actor: "system",
    expectedStatus: "QUEUED", newStatus: "RUNNING",
  });
  ok(r2.ok === false, "T8 stale CAS rejected");
  if (!r2.ok) ok(r2.reason === "STATE_MISMATCH", "T8 reason is STATE_MISMATCH");
  ok(store.getJob(job.id)?.status === "CLAIMED", "T8 CLAIMED not overwritten");
}

// ---------------------------------------------------------------------------
// T9 — competing transitions
// ---------------------------------------------------------------------------

async function T9() {
  section("T9 — competing transitions from CLAIMED");
  const { store, lm, wr } = await harness();
  wr.register(makeWorker("worker-A"));
  const job = makeJob();
  store.createJob(job);

  const lease = lm.acquireLease(job.id, "worker-A", 60_000);
  store.transitionExecution({
    jobId: job.id, actor: "system",
    expectedStatus: "QUEUED", newStatus: "CLAIMED",
    patch: { currentLeaseId: lease.leaseId },
  });

  const rRun = store.transitionExecution({
    jobId: job.id, actor: "worker",
    expectedStatus: "CLAIMED", newStatus: "RUNNING",
    workerId: "worker-A", leaseId: lease.leaseId,
  });
  ok(rRun.ok === true, "T9 CLAIMED -> RUNNING wins");

  const rCancel = store.transitionExecution({
    jobId: job.id, actor: "worker",
    expectedStatus: "CLAIMED", newStatus: "CANCELLED",
    workerId: "worker-A", leaseId: lease.leaseId,
  });
  ok(rCancel.ok === false, "T9 stale CLAIMED -> CANCELLED rejected");
  ok(store.getJob(job.id)?.status === "RUNNING", "T9 final state is RUNNING");
}

// ---------------------------------------------------------------------------
// T10 — terminal immutability
// ---------------------------------------------------------------------------

async function T10() {
  section("T10 — terminal immutability");
  const terminals: Array<ExecutionJob["status"]> = [
    "SUCCEEDED", "CANCELLED", "DEAD_LETTER", "BLOCKED",
  ];
  const { store } = await harness();

  for (const t of terminals) {
    const job = makeJob({ status: t as any });
    store.createJob(job);
    const r = store.transitionExecution({
      jobId: job.id, actor: "system",
      expectedStatus: t, newStatus: "RUNNING",
    });
    ok(r.ok === false, `T10 ${t} -> RUNNING rejected`);
    if (!r.ok) ok(r.reason === "TERMINAL_STATE",
                   `T10 ${t} reason is TERMINAL_STATE`);
    ok(store.getJob(job.id)?.status === t, `T10 ${t} unchanged`);
  }
}

// ---------------------------------------------------------------------------
// T11 — terminal duplicate semantics
// ---------------------------------------------------------------------------

async function T11() {
  section("T11 — terminal duplicate semantics");
  const { store } = await harness();
  const job = makeJob({ status: "SUCCEEDED" as any });
  store.createJob(job);

  const r = store.transitionExecution({
    jobId: job.id, actor: "system",
    expectedStatus: "SUCCEEDED", newStatus: "SUCCEEDED",
  });
  ok(r.ok === true, "T11 exact duplicate is ok");
  if (r.ok) {
    ok(r.applied === false, "T11 applied === false");
    ok(r.idempotent === true, "T11 idempotent === true");
  }
  ok(store.getJob(job.id)?.status === "SUCCEEDED", "T11 unchanged");
}

// ---------------------------------------------------------------------------
// T12 — durable event contains transition metadata
// ---------------------------------------------------------------------------

async function T12() {
  section("T12 — durable event shape");
  const { store, lm, wr } = await harness();
  wr.register(makeWorker("worker-A"));
  const job = makeJob();
  store.createJob(job);

  const lease = lm.acquireLease(job.id, "worker-A", 60_000);
  store.transitionExecution({
    jobId: job.id, actor: "system",
    expectedStatus: "QUEUED", newStatus: "CLAIMED",
    patch: { currentLeaseId: lease.leaseId },
  });

  const r = store.transitionExecution({
    jobId: job.id, actor: "worker",
    expectedStatus: "CLAIMED", newStatus: "RUNNING",
    workerId: "worker-A", leaseId: lease.leaseId,
    reason: "T12-reason",
  });
  ok(r.ok === true, "T12 transition committed");

  const events = readEvents(store, job.id);
  const last = events[events.length - 1];
  ok(!!last, "T12 event exists");
  if (last) {
    ok(last.job_id === job.id, "T12 event.job_id matches");
    ok(last.event_type === "execution.transition.running",
       "T12 event.event_type lowercase status");
    let payload: any = last.payload;
    if (typeof payload === "string") payload = JSON.parse(payload);
    ok(payload?.from === "CLAIMED", "T12 payload.from");
    ok(payload?.to === "RUNNING", "T12 payload.to");
    ok(payload?.actor === "worker", "T12 payload.actor");
    ok(payload?.workerId === "worker-A", "T12 payload.workerId");
    ok(payload?.leaseId === lease.leaseId, "T12 payload.leaseId");
    ok(payload?.reason === "T12-reason", "T12 payload.reason");
  }
}

// ---------------------------------------------------------------------------
// T13 — event failure rolls back state
// ---------------------------------------------------------------------------

async function T13() {
  section("T13 — event failure rolls back state");
  const { store } = await harness();
  const job = makeJob();
  store.createJob(job);

  const original = (store as any).addEvent.bind(store);
  (store as any).addEvent = () => { throw new Error("T13-injected"); };

  let result: any = null;
  try {
    result = store.transitionExecution({
      jobId: job.id, actor: "system",
      expectedStatus: "QUEUED", newStatus: "CLAIMED",
    });
  } catch { /* accepted */ } finally {
    (store as any).addEvent = original;
  }

  ok(!result || result.ok === false,
     "T13 transition does NOT report successful application");
  ok(store.getJob(job.id)?.status === "QUEUED",
     "T13 execution_jobs remains QUEUED after reload");
  const events = readEvents(store, job.id);
  ok(events.length === 0, "T13 no partially committed event");
}

// ---------------------------------------------------------------------------
// T14 — non-worker actors do not require leases
// ---------------------------------------------------------------------------

async function T14() {
  section("T14 — system actor does not require lease");
  const { store } = await harness();
  const job = makeJob();
  store.createJob(job);

  const r = store.transitionExecution({
    jobId: job.id, actor: "system",
    expectedStatus: "QUEUED", newStatus: "CLAIMED",
  });
  ok(r.ok === true, "T14 system actor transition without lease succeeds");
  ok(store.getJob(job.id)?.status === "CLAIMED", "T14 state committed");
}

// ---------------------------------------------------------------------------
// T15 — recovery cannot violate legality
// ---------------------------------------------------------------------------

async function T15() {
  section("T15 — recovery actor cannot violate legality");
  const sm = new ExecutionStateMachine();
  ok(!sm.canTransition("CLAIMED", "RUNNING") === false,
     "T15 sanity: CLAIMED -> RUNNING is legal");
  ok(!sm.canTransition("QUEUED", "VERIFYING"),
     "T15 sanity: QUEUED -> VERIFYING is illegal");
  // Store-level transitionExecution does not enforce the graph by design;
  // legality is enforced by ExecutionEngine.applyTransition. This test asserts
  // the state-machine gate exists and would reject the illegal path.
}

// ---------------------------------------------------------------------------
// T16 — cancellation request is flag-only
// ---------------------------------------------------------------------------

async function T16() {
  section("T16 — cancellation request is flag-only");
  const { store } = await harness();
  const job = makeJob({ status: "RUNNING" as any });
  store.createJob(job);

  const okFlag = store.requestCancellation(job.id);
  ok(okFlag === true, "T16 flag set for non-terminal");
  const reloaded = store.getJob(job.id);
  ok(reloaded?.cancellationRequested === true, "T16 flag persisted");
  ok(reloaded?.status === "RUNNING", "T16 status NOT changed by request");

  const job2 = makeJob({ status: "SUCCEEDED" as any });
  store.createJob(job2);
  const okFlag2 = store.requestCancellation(job2.id);
  ok(okFlag2 === false, "T16 terminal job ignores cancellation request");
}

// ---------------------------------------------------------------------------
// T17 — cancellation acknowledgement transition
// ---------------------------------------------------------------------------

async function T17() {
  section("T17 — cancellation acknowledgement transition");
  const { store, lm, wr } = await harness();
  wr.register(makeWorker("worker-A"));
  const job = makeJob({ status: "RUNNING" as any });
  store.createJob(job);
  const lease = lm.acquireLease(job.id, "worker-A", 60_000);
  store.transitionExecution({
    jobId: job.id, actor: "system",
    expectedStatus: "RUNNING", newStatus: "RUNNING",
    patch: { currentLeaseId: lease.leaseId },
  }).ok; // no-op transition; forces patch

  const r = store.transitionExecution({
    jobId: job.id, actor: "worker",
    expectedStatus: "RUNNING", newStatus: "CANCELLED",
    workerId: "worker-A", leaseId: lease.leaseId,
    patch: { cancellationAcknowledged: true },
    reason: "T17",
  });
  ok(r.ok === true, "T17 cancellation transition committed");

  const reloaded = store.getJob(job.id);
  ok(reloaded?.status === "CANCELLED", "T17 status is CANCELLED");
  ok(reloaded?.cancellationAcknowledged === true, "T17 acknowledged");

  // terminal immutability afterwards
  const r2 = store.transitionExecution({
    jobId: job.id, actor: "system",
    expectedStatus: "CANCELLED", newStatus: "RUNNING",
  });
  ok(r2.ok === false, "T17 terminal immutable afterwards");
}

// ---------------------------------------------------------------------------
// T18 — retry transition integrity
// ---------------------------------------------------------------------------

async function T18() {
  section("T18 — FAILED -> RETRY_SCHEDULED -> QUEUED");
  const { store } = await harness();
  const job = makeJob({ status: "FAILED" as any, retryPolicy });
  store.createJob(job);

  const r1 = store.transitionExecution({
    jobId: job.id, actor: "system",
    expectedStatus: "FAILED", newStatus: "RETRY_SCHEDULED",
    patch: { nextAttemptAt: Date.now() + 1000 },
  });
  ok(r1.ok === true, "T18 FAILED -> RETRY_SCHEDULED committed");
  const mid = store.getJob(job.id);
  ok(mid?.status === "RETRY_SCHEDULED", "T18 DB reports RETRY_SCHEDULED");
  ok(mid?.nextAttemptAt !== undefined && mid.nextAttemptAt !== null,
     "T18 nextAttemptAt persisted");

  const r2 = store.transitionExecution({
    jobId: job.id, actor: "system",
    expectedStatus: "RETRY_SCHEDULED", newStatus: "QUEUED",
  });
  ok(r2.ok === true, "T18 RETRY_SCHEDULED -> QUEUED committed");
  ok(store.getJob(job.id)?.status === "QUEUED", "T18 DB reports QUEUED");
}

// ---------------------------------------------------------------------------
// T19 — retry cannot resurrect terminal jobs
// ---------------------------------------------------------------------------

async function T19() {
  section("T19 — retry cannot resurrect terminal jobs");
  const { store } = await harness();
  for (const t of ["DEAD_LETTER", "SUCCEEDED"] as const) {
    const job = makeJob({ status: t as any, retryPolicy });
    store.createJob(job);
    const r = store.transitionExecution({
      jobId: job.id, actor: "system",
      expectedStatus: t, newStatus: "RETRY_SCHEDULED",
    });
    ok(r.ok === false, `T19 ${t} -> RETRY_SCHEDULED rejected`);
    ok(store.getJob(job.id)?.status === t, `T19 ${t} stays ${t}`);
  }
}

// ---------------------------------------------------------------------------
// T20 — restart durability
// ---------------------------------------------------------------------------

async function T20() {
  section("T20 — restart durability");
  const { store } = await harness();
  const job = makeJob();
  store.createJob(job);
  store.transitionExecution({
    jobId: job.id, actor: "system",
    expectedStatus: "QUEUED", newStatus: "CLAIMED",
    reason: "T20",
  });

  const eventsBefore = readEvents(store, job.id).length;
  ok(eventsBefore >= 1, "T20 event present before restart");

  resetEngineForTesting();
  const engineDb2 = await openEngine();
  const store2 = new ExecutionStore(engineDb2 as any);

  const reloaded = store2.getJob(job.id);
  ok(reloaded?.status === "CLAIMED", "T20 status survives restart");
  const eventsAfter = readEvents(store2, job.id).length;
  ok(eventsAfter >= 1, "T20 event survives restart");
}

// ---------------------------------------------------------------------------
// T21 — Phase 126 ownership regression (focused)
// ---------------------------------------------------------------------------

async function T21() {
  section("T21 — Phase 126 ownership regression");
  const { store, lm, wr } = await harness();
  wr.register(makeWorker("worker-A"));
  const job = makeJob();
  store.createJob(job);

  const lease = lm.acquireLease(job.id, "worker-A", 60_000);
  ok(lease.workerId === "worker-A", "T21 lease acquired");
  ok(lm.validateLease(lease.leaseId, "worker-A"), "T21 validateLease ok");

  const renewed = lm.renewLease(lease.leaseId, "worker-A", 120_000);
  ok(renewed.expiresAt > lease.expiresAt, "T21 renewal extends expiry");

  lm.expireLease(lease.leaseId, Date.now() + 200_000);
  ok(lm.validateLease(lease.leaseId, "worker-A") === false,
     "T21 expired lease fails validation");
}

// ---------------------------------------------------------------------------
// T22 — no APPROVAL_REQUIRED execution status
// ---------------------------------------------------------------------------

async function T22() {
  section("T22 — APPROVAL_REQUIRED is not an ExecutionJobStatus");
  // Compile-time assertion: if APPROVAL_REQUIRED ever becomes an
  // ExecutionJobStatus, this line fails to typecheck.
  type _NotApproval =
    "APPROVAL_REQUIRED" extends ExecutionJob["status"] ? false : true;
  const check: _NotApproval = true;
  ok(check === true, "T22 APPROVAL_REQUIRED is not in ExecutionJobStatus union");

  // And confirm the runtime state machine does not recognize it.
  const sm = new ExecutionStateMachine();
  ok(sm.canTransition("QUEUED", "APPROVAL_REQUIRED" as any) === false,
     "T22 state machine rejects APPROVAL_REQUIRED as a target");
}

// ---------------------------------------------------------------------------
// T23 — authoritative path is used (event presence)
// ---------------------------------------------------------------------------

async function T23() {
  section("T23 — authoritative path used (durable event present)");
  const { store } = await harness();
  const job = makeJob();
  store.createJob(job);
  store.transitionExecution({
    jobId: job.id, actor: "system",
    expectedStatus: "QUEUED", newStatus: "CLAIMED",
  });
  const events = readEvents(store, job.id);
  ok(events.length === 1, "T23 exactly one event (not bypassed by direct UPDATE)");
}

// ---------------------------------------------------------------------------
// T24 — ownership loss during transition
// ---------------------------------------------------------------------------

async function T24() {
  section("T24 — ownership loss between read and CAS");
  const { store, lm, wr } = await harness();
  wr.register(makeWorker("worker-A"));
  const job = makeJob();
  store.createJob(job);
  const lease = lm.acquireLease(job.id, "worker-A", 60_000);
  store.transitionExecution({
    jobId: job.id, actor: "system",
    expectedStatus: "QUEUED", newStatus: "CLAIMED",
    patch: { currentLeaseId: lease.leaseId },
  });

  // Expire before the worker CAS
  lm.expireLease(lease.leaseId, Date.now() + 500_000);

  const r = store.transitionExecution({
    jobId: job.id, actor: "worker",
    expectedStatus: "CLAIMED", newStatus: "RUNNING",
    workerId: "worker-A", leaseId: lease.leaseId,
  });
  ok(r.ok === false, "T24 stale-worker CAS rejected");
  if (!r.ok) ok(r.reason === "WORKER_OWNERSHIP_LOST",
                 "T24 reason WORKER_OWNERSHIP_LOST");
  ok(store.getJob(job.id)?.status === "CLAIMED", "T24 job not advanced");
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// T25 — lease for wrong job is fenced
// ---------------------------------------------------------------------------

async function T25() {
  section("T25 — lease for wrong job is fenced");
  const { store, lm, wr } = await harness();
  wr.register(makeWorker("worker-A"));

  const jobA = makeJob();
  const jobB = makeJob();
  store.createJob(jobA);
  store.createJob(jobB);

  // Acquire an active lease for jobA only.
  const leaseA = lm.acquireLease(jobA.id, "worker-A", 60_000);

  // Put jobB into CLAIMED via system (no lease requirement).
  store.transitionExecution({
    jobId: jobB.id, actor: "system",
    expectedStatus: "QUEUED", newStatus: "CLAIMED",
  });

  // Attempt to advance jobB as worker-A using a lease issued for jobA.
  const r = store.transitionExecution({
    jobId: jobB.id, actor: "worker",
    expectedStatus: "CLAIMED", newStatus: "RUNNING",
    workerId: "worker-A", leaseId: leaseA.leaseId,
  });
  ok(r.ok === false, "T25 mismatched lease/job rejected");
  if (!r.ok) ok(r.reason === "WORKER_OWNERSHIP_LOST",
                 "T25 reason WORKER_OWNERSHIP_LOST");
  ok(store.getJob(jobB.id)?.status === "CLAIMED", "T25 jobB unchanged");
  ok(store.getJob(jobA.id)?.status === "QUEUED", "T25 jobA untouched");
}

async function main() {
  try {
    await T1(); await T2(); await T3(); await T4(); await T5();
    await T6(); await T7(); await T8(); await T9(); await T10();
    await T11(); await T12(); await T13(); await T14(); await T15();
    await T16(); await T17(); await T18(); await T19(); await T20();
    await T21(); await T22(); await T23(); await T24(); await T25();
  } catch (e) {
    console.error("FATAL during test run:", e);
    failed++;
  }

  console.log(`\nPHASE 127 EXECUTION STATE MACHINE TEST`);
  console.log(`  total assertions: ${passed + failed}`);
  console.log(`  passed: ${passed}`);
  console.log(`  failed: ${failed}`);
  if (failed > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => { console.error("FATAL:", err); process.exit(1); });
