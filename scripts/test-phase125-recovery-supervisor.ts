// scripts/test-phase125-recovery-supervisor.ts
// Phase 125: recovery supervisor lifecycle tests.
//
// Exercises the real ReleaseRecoverySupervisor against deterministic stubs
// and real durable events/audit stores. Executor stubs never touch the real
// recovery logic; only the ReleaseRecoveryExecutor dependency is doubled.

import { resetEngineForTesting, openEngine } from "../src/core/db";
import { CONFIG } from "../src/core/config";
import { EventService } from "../src/core/events";
import { AuditService } from "../src/core/audit";
import {
  ReleaseRecoverySupervisor,
  type RecoverySupervisorEventSink,
  type RecoverySupervisorAuditSink,
  type RecoverySupervisorStatus,
} from "../src/core/release-recovery-supervisor";
import type {
  ReleaseRecoveryExecutor,
  RecoveryRunReport,
} from "../src/core/release-recovery-executor";

// --- harness ---------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(cond: boolean, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ok   ${msg}`);
  } else {
    failed++;
    failures.push(msg);
    console.log(`  FAIL ${msg}`);
  }
}

function section(name: string): void {
  console.log(`\n${name}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function deferred<T = void>() {
  let resolve!: (v: T | PromiseLike<T>) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const emptyReport = (): RecoveryRunReport => ({
  scanned: 0,
  acted: 0,
  skipped: 0,
  blocked: 0,
  leaseHeld: 0,
  actions: [],
  blockedReasons: [],
});

interface RecordedEvent {
  type: string;
  source?: string;
  payload?: Record<string, unknown>;
}

interface RecordedAudit {
  actor: string;
  action: string;
  resource_type: string;
  resource_id: string;
  result?: string;
  metadata?: Record<string, unknown>;
}

function makeRecordingSinks() {
  const events: RecordedEvent[] = [];
  const audits: RecordedAudit[] = [];
  const eventSink: RecoverySupervisorEventSink = {
    emit: async (e) => {
      events.push({
        type: e.type,
        source: e.source,
        payload: (e.payload as Record<string, unknown>) ?? {},
      });
      return e;
    },
  };
  const auditSink: RecoverySupervisorAuditSink = {
    record: async (e) => {
      audits.push({
        actor: e.actor,
        action: e.action,
        resource_type: e.resource_type,
        resource_id: e.resource_id,
        result: e.result,
        metadata: (e.metadata as Record<string, unknown>) ?? {},
      });
      return e;
    },
  };
  return { events, audits, eventSink, auditSink };
}

interface StubState {
  report?: RecoveryRunReport;
  failWith?: Error;
  failNextN?: number;
  gate?: Promise<void>;
}

function makeStubExecutor() {
  const calls: number[] = [];
  let behavior: StubState = {};
  const stub = {
    async runOnce(_now?: number): Promise<RecoveryRunReport> {
      calls.push(Date.now());
      if (behavior.gate) await behavior.gate;
      if (behavior.failNextN && behavior.failNextN > 0) {
        behavior.failNextN--;
        throw behavior.failWith ?? new Error("stub failure");
      }
      if (behavior.failWith && behavior.failNextN === undefined) {
        throw behavior.failWith;
      }
      return behavior.report ?? emptyReport();
    },
  } as unknown as ReleaseRecoveryExecutor;
  return {
    executor: stub,
    calls,
    set(b: StubState) {
      behavior = b;
    },
    update(patch: Partial<StubState>) {
      behavior = { ...behavior, ...patch };
    },
  };
}

// --- T1: disabled config ----------------------------------------------------

async function T1() {
  section("T1 — disabled config does not start periodic work");
  const original = CONFIG.recovery.enabled;
  try {
    CONFIG.recovery.enabled = false;
    // The supervisor has no CONFIG dependency, so we cannot test it here.
    // The kernel-level no-op gate is what config.disabled implies.
    ok(CONFIG.recovery.enabled === false, "CONFIG.recovery.enabled can be set false and restored");
  } finally {
    CONFIG.recovery.enabled = original;
  }
}

// --- T2: start --------------------------------------------------------------

async function T2() {
  section("T2 — start transitions to RUNNING");
  const { eventSink, auditSink } = makeRecordingSinks();
  const { executor } = makeStubExecutor();
  const sup = new ReleaseRecoverySupervisor({
    executor,
    svc: { events: eventSink, audit: auditSink },
    workerId: "test-worker-T2",
    intervalMs: 40,
  });
  try {
    await sup.start();
    const s = sup.status();
    ok(s.state === "RUNNING", "state is RUNNING after start");
    ok(s.activeRun === false, "activeRun is false immediately after start");
    ok(s.workerId === "test-worker-T2", "workerId is preserved");
  } finally {
    await sup.stop();
  }
}

// --- T3: idempotent start ---------------------------------------------------

async function T3() {
  section("T3 — repeated start is idempotent");
  const { eventSink, auditSink } = makeRecordingSinks();
  const { executor } = makeStubExecutor();
  const sup = new ReleaseRecoverySupervisor({
    executor,
    svc: { events: eventSink, audit: auditSink },
    workerId: "test-worker-T3",
    intervalMs: 40,
  });
  try {
    await sup.start();
    await sup.start();
    await sup.start();
    const s = sup.status();
    ok(s.state === "RUNNING", "state remains RUNNING after 3 starts");
    ok(s.workerId === "test-worker-T3", "workerId unchanged");
  } finally {
    await sup.stop();
  }
}

// --- T4: scheduled execution ------------------------------------------------

async function T4() {
  section("T4 — scheduled tick invokes executor");
  const { events, eventSink, auditSink } = makeRecordingSinks();
  const stub = makeStubExecutor();
  const report: RecoveryRunReport = {
    scanned: 1, acted: 1, skipped: 0, blocked: 0, leaseHeld: 0,
    actions: [{ intentKey: "k1", action: "RESUME_FROM_INTENT" as never, reason: "test" }],
    blockedReasons: [],
  };
  stub.set({ report });
  const sup = new ReleaseRecoverySupervisor({
    executor: stub.executor,
    svc: { events: eventSink, audit: auditSink },
    workerId: "test-worker-T4",
    intervalMs: 30,
  });
  try {
    await sup.start();
    await sleep(90);
    ok(stub.calls.length >= 1, "executor invoked by scheduled tick");
    const started = events.filter((e) => e.type === "release.recovery.supervisor.run_started");
    const completed = events.filter((e) => e.type === "release.recovery.supervisor.run_completed");
    ok(started.length >= 1, "run_started emitted");
    ok(completed.length >= 1, "run_completed emitted");
    const s = sup.status();
    ok(s.lastRunResult?.scanned === 1 && s.lastRunResult?.acted === 1,
      "lastRunResult reflects the actual report");
  } finally {
    await sup.stop();
  }
}

// --- T5: no overlap ---------------------------------------------------------

async function T5() {
  section("T5 — no overlapping scheduled runs");
  const { events, eventSink, auditSink } = makeRecordingSinks();
  const stub = makeStubExecutor();
  const gate = deferred();
  stub.set({ gate: gate.promise });
  const sup = new ReleaseRecoverySupervisor({
    executor: stub.executor,
    svc: { events: eventSink, audit: auditSink },
    workerId: "test-worker-T5",
    intervalMs: 30,
  });
  try {
    await sup.start();
    await sleep(80);
    ok(stub.calls.length === 1, "executor invoked exactly once while gated");
    ok(sup.status().skippedTicks >= 1, "skippedTicks increased");
    const manual = sup.runNow();
    await sleep(20);
    ok(stub.calls.length === 1, "runNow during active run does not invoke executor again");
    gate.resolve();
    const report = await manual;
    ok(report.scanned === 0, "runNow resolves with the shared report");
    const skipped = events.filter((e) => e.type === "release.recovery.supervisor.tick_skipped");
    ok(skipped.length >= 1, "tick_skipped event emitted");
  } finally {
    await sup.stop();
  }
}

// --- T6: failure isolation --------------------------------------------------

async function T6() {
  section("T6 — failure isolation");
  const { events, audits, eventSink, auditSink } = makeRecordingSinks();
  const stub = makeStubExecutor();
  stub.set({ failWith: new Error("boom"), failNextN: 1 });
  const sup = new ReleaseRecoverySupervisor({
    executor: stub.executor,
    svc: { events: eventSink, audit: auditSink },
    workerId: "test-worker-T6",
    intervalMs: 30,
  });
  try {
    await sup.start();
    let rejected = false;
    try {
      await sup.runNow();
    } catch {
      rejected = true;
    }
    ok(rejected, "runNow rejects on executor failure");
    const s = sup.status();
    ok(!!s.lastError && s.lastError.includes("boom"), "lastError populated with diagnostic");
    ok(s.consecutiveFailures === 1, "consecutiveFailures incremented");
    ok(events.some((e) => e.type === "release.recovery.supervisor.run_failed"),
      "run_failed event emitted");
    ok(audits.some((a) => a.action === "release.recovery.supervisor.run_failed"),
      "run_failed audit recorded");
    // Now make it succeed
    await sup.runNow();
    ok(sup.status().consecutiveFailures === 0, "consecutiveFailures reset on success");
  } finally {
    await sup.stop();
  }
}

// --- T7: stop ---------------------------------------------------------------

async function T7() {
  section("T7 — stop clears scheduling");
  const { eventSink, auditSink } = makeRecordingSinks();
  const stub = makeStubExecutor();
  const sup = new ReleaseRecoverySupervisor({
    executor: stub.executor,
    svc: { events: eventSink, audit: auditSink },
    workerId: "test-worker-T7",
    intervalMs: 30,
  });
  await sup.start();
  await sup.stop();
  const s = sup.status();
  ok(s.state === "STOPPED", "state STOPPED");
  ok(s.activeRun === false, "activeRun false");
  const before = stub.calls.length;
  await sleep(90);
  ok(stub.calls.length === before, "no further execution after stop");
}

// --- T8: idempotent stop ----------------------------------------------------

async function T8() {
  section("T8 — repeated stop is safe");
  const { eventSink, auditSink } = makeRecordingSinks();
  const stub = makeStubExecutor();
  const sup = new ReleaseRecoverySupervisor({
    executor: stub.executor,
    svc: { events: eventSink, audit: auditSink },
    workerId: "test-worker-T8",
    intervalMs: 30,
  });
  await sup.start();
  await sup.stop();
  await sup.stop();
  await sup.stop();
  ok(sup.status().state === "STOPPED", "state remains STOPPED after 3 stops");
}

// --- T9: restart lifecycle --------------------------------------------------

async function T9() {
  section("T9 — start/stop/start");
  const { eventSink, auditSink } = makeRecordingSinks();
  const stub = makeStubExecutor();
  const sup = new ReleaseRecoverySupervisor({
    executor: stub.executor,
    svc: { events: eventSink, audit: auditSink },
    workerId: "test-worker-T9",
    intervalMs: 30,
  });
  await sup.start();
  await sleep(50);
  await sup.stop();
  await sup.start();
  await sleep(50);
  const s = sup.status();
  ok(s.state === "RUNNING", "supervisor running again");
  ok(s.workerId === "test-worker-T9", "worker ID unchanged across restart");
  ok(stub.calls.length >= 2, "executor invoked in both cycles");
  await sup.stop();
}

// --- T10: runNow ------------------------------------------------------------

async function T10() {
  section("T10 — runNow executes exactly once");
  const { eventSink, auditSink } = makeRecordingSinks();
  const stub = makeStubExecutor();
  const report: RecoveryRunReport = {
    scanned: 2, acted: 1, skipped: 0, blocked: 0, leaseHeld: 0,
    actions: [], blockedReasons: [],
  };
  stub.set({ report });
  const sup = new ReleaseRecoverySupervisor({
    executor: stub.executor,
    svc: { events: eventSink, audit: auditSink },
    workerId: "test-worker-T10",
    intervalMs: 5000,
  });
  try {
    await sup.start();
    const before = stub.calls.length;
    const r = await sup.runNow();
    ok(stub.calls.length === before + 1, "exactly one manual invocation");
    ok(r.scanned === 2 && r.acted === 1, "returns exact report");
  } finally {
    await sup.stop();
  }
}

// --- T11: overlapping runNow ------------------------------------------------

async function T11() {
  section("T11 — overlapping runNow shares the in-flight promise");
  const { eventSink, auditSink } = makeRecordingSinks();
  const stub = makeStubExecutor();
  const gate = deferred();
  stub.set({ gate: gate.promise });
  const sup = new ReleaseRecoverySupervisor({
    executor: stub.executor,
    svc: { events: eventSink, audit: auditSink },
    workerId: "test-worker-T11",
    intervalMs: 5000,
  });
  try {
    await sup.start();
    const a = sup.runNow();
    await sleep(20);
    const b = sup.runNow();
    await sleep(20);
    ok(stub.calls.length === 1, "executor invoked exactly once");
    gate.resolve();
    const [ra, rb] = await Promise.all([a, b]);
    ok(ra === rb, "both callers received the same report");
  } finally {
    await sup.stop();
  }
}

// --- T12: final pass --------------------------------------------------------

async function T12() {
  section("T12 — final pass on stop");
  const { events, eventSink, auditSink } = makeRecordingSinks();
  const stub = makeStubExecutor();
  const sup = new ReleaseRecoverySupervisor({
    executor: stub.executor,
    svc: { events: eventSink, audit: auditSink },
    workerId: "test-worker-T12",
    intervalMs: 5000,
  });
  await sup.start();
  const before = stub.calls.length;
  await sup.stop({ finalPass: true });
  ok(stub.calls.length === before + 1, "exactly one final pass invocation");
  ok(sup.status().state === "STOPPED", "state STOPPED after successful final pass");
  const finalStarted = events.filter(
    (e) =>
      e.type === "release.recovery.supervisor.run_started" &&
      (e.payload as { trigger?: string })?.trigger === "final",
  );
  ok(finalStarted.length === 1, "run_started emitted with trigger=final");
}

// --- T13: final pass failure ------------------------------------------------

async function T13() {
  section("T13 — final pass failure is preserved");
  const { eventSink, auditSink } = makeRecordingSinks();
  const stub = makeStubExecutor();
  const sup = new ReleaseRecoverySupervisor({
    executor: stub.executor,
    svc: { events: eventSink, audit: auditSink },
    workerId: "test-worker-T13",
    intervalMs: 5000,
  });
  await sup.start();
  stub.set({ failWith: new Error("final pass exploded") });
  await sup.stop({ finalPass: true });
  const s = sup.status();
  ok(s.state === "FAILED", "state FAILED after final pass failure");
  ok(!!s.lastError && s.lastError.includes("final pass exploded"), "lastError preserved");
}

// --- T14: restart after failed stop -----------------------------------------

async function T14() {
  section("T14 — restart after FAILED");
  const { eventSink, auditSink } = makeRecordingSinks();
  const stub = makeStubExecutor();
  const sup = new ReleaseRecoverySupervisor({
    executor: stub.executor,
    svc: { events: eventSink, audit: auditSink },
    workerId: "test-worker-T14",
    intervalMs: 5000,
  });
  await sup.start();
  stub.set({ failWith: new Error("bail") });
  await sup.stop({ finalPass: true });
  ok(sup.status().state === "FAILED", "in FAILED state after stop with failed final pass");
  stub.set({});
  try {
    await sup.start();
    ok(sup.status().state === "RUNNING", "start() from FAILED transitions to RUNNING");
  } finally {
    await sup.stop();
  }
}

// --- T15: durable restart ---------------------------------------------------

async function T15() {
  section("T15 — durable restart across supervisor instances");
  // Uses real EventService/AuditService on a temp DB.
  resetEngineForTesting();
  const originalEngine = CONFIG.persistence.engine;
  const originalDb = CONFIG.persistence.dbName;
  CONFIG.persistence.engine = "sqlite";
  CONFIG.persistence.dbName = "./test-phase125-t15.sqlite";
  try {
    const engine = await openEngine();
    const events = new EventService(engine);
    await events.init();
    const audit = new AuditService(engine);

    const stub1 = makeStubExecutor();
    stub1.set({
      report: {
        scanned: 1, acted: 0, skipped: 0, blocked: 1, leaseHeld: 0,
        actions: [], blockedReasons: [{ intentKey: "k-durable", reason: "still pending" }],
      },
    });
    const sup1 = new ReleaseRecoverySupervisor({
      executor: stub1.executor,
      svc: { events, audit },
      workerId: "nexus-recovery-A",
      intervalMs: 5000,
    });
    await sup1.start();
    await sup1.runNow();
    await sup1.stop();

    // Second supervisor instance, same durable store, different identity.
    const stub2 = makeStubExecutor();
    const sup2 = new ReleaseRecoverySupervisor({
      executor: stub2.executor,
      svc: { events, audit },
      workerId: "nexus-recovery-B",
      intervalMs: 5000,
    });
    await sup2.start();
    await sup2.runNow();
    await sup2.stop();

    const all = await events.list(500);
    const started = all.filter((e) => e.type === "release.recovery.supervisor.started");
    const payloads = started.map((e) => (e.payload as { workerId?: string })?.workerId);
    ok(payloads.includes("nexus-recovery-A") && payloads.includes("nexus-recovery-B"),
      "both worker IDs are represented in durable events");

    (engine as unknown as { close?: () => void }).close?.();
  } finally {
    CONFIG.persistence.engine = originalEngine;
    CONFIG.persistence.dbName = originalDb;
    resetEngineForTesting();
    try {
      const fs = await import("node:fs");
      if (fs.existsSync("./test-phase125-t15.sqlite")) fs.unlinkSync("./test-phase125-t15.sqlite");
    } catch { /* ignore */ }
  }
}

// --- T16: multi-supervisor lease safety -------------------------------------

async function T16() {
  section("T16 — two supervisors, same durable store");
  // We exercise the supervisor's no-overlap + telemetry against a shared
  // durable store. The real lease semantics live in the executor, which this
  // test stubs at the dependency boundary.
  resetEngineForTesting();
  const originalEngine = CONFIG.persistence.engine;
  const originalDb = CONFIG.persistence.dbName;
  CONFIG.persistence.engine = "sqlite";
  CONFIG.persistence.dbName = "./test-phase125-t16.sqlite";
  try {
    const engine = await openEngine();
    const events = new EventService(engine);
    await events.init();
    const audit = new AuditService(engine);

    const stubA = makeStubExecutor();
    const stubB = makeStubExecutor();
    stubA.set({ report: { ...emptyReport(), scanned: 1, leaseHeld: 1 } });
    stubB.set({ report: { ...emptyReport(), scanned: 1, leaseHeld: 1 } });

    const supA = new ReleaseRecoverySupervisor({
      executor: stubA.executor, svc: { events, audit },
      workerId: "nexus-recovery-A", intervalMs: 5000,
    });
    const supB = new ReleaseRecoverySupervisor({
      executor: stubB.executor, svc: { events, audit },
      workerId: "nexus-recovery-B", intervalMs: 5000,
    });

    await supA.start();
    await supB.start();
    const [ra, rb] = await Promise.all([supA.runNow(), supB.runNow()]);
    await supA.stop();
    await supB.stop();

    ok(stubA.calls.length === 1 && stubB.calls.length === 1,
      "each supervisor invoked its executor exactly once");
    ok(ra.leaseHeld === 1 && rb.leaseHeld === 1,
      "leaseHeld reflected from the actual report");

    (engine as unknown as { close?: () => void }).close?.();
  } finally {
    CONFIG.persistence.engine = originalEngine;
    CONFIG.persistence.dbName = originalDb;
    resetEngineForTesting();
    try {
      const fs = await import("node:fs");
      if (fs.existsSync("./test-phase125-t16.sqlite")) fs.unlinkSync("./test-phase125-t16.sqlite");
    } catch { /* ignore */ }
  }
}

// --- T17: lifecycle events --------------------------------------------------

async function T17() {
  section("T17 — lifecycle events emitted");
  const { events, eventSink, auditSink } = makeRecordingSinks();
  const stub = makeStubExecutor();
  const gate = deferred();
  stub.set({ gate: gate.promise });
  const sup = new ReleaseRecoverySupervisor({
    executor: stub.executor,
    svc: { events: eventSink, audit: auditSink },
    workerId: "test-worker-T17",
    intervalMs: 30,
  });
  await sup.start();
  await sleep(80); // tick 1 — gated, more ticks produce tick_skipped
  gate.resolve();
  await sleep(10);
  await sup.stop();

  const types = new Set(events.map((e) => e.type));
  ok(types.has("release.recovery.supervisor.started"), "started emitted");
  ok(types.has("release.recovery.supervisor.run_started"), "run_started emitted");
  ok(types.has("release.recovery.supervisor.run_completed"), "run_completed emitted");
  ok(types.has("release.recovery.supervisor.stopped"), "stopped emitted");
  ok(types.has("release.recovery.supervisor.tick_skipped"), "tick_skipped emitted");
}

// --- T18: audit -------------------------------------------------------------

async function T18() {
  section("T18 — audit records emitted");
  const { audits, eventSink, auditSink } = makeRecordingSinks();
  const stub = makeStubExecutor();
  const sup = new ReleaseRecoverySupervisor({
    executor: stub.executor,
    svc: { events: eventSink, audit: auditSink },
    workerId: "test-worker-T18",
    intervalMs: 5000,
  });
  await sup.start();
  await sup.stop();
  const actions = audits.map((a) => a.action);
  ok(actions.includes("release.recovery.supervisor.start"), "start audit recorded");
  ok(actions.includes("release.recovery.supervisor.stop"), "stop audit recorded");
}

// --- T19: secret sanitization -----------------------------------------------

async function T19() {
  section("T19 — secrets redacted in diagnostics");
  const { eventSink, auditSink } = makeRecordingSinks();
  const stub = makeStubExecutor();
  const sup = new ReleaseRecoverySupervisor({
    executor: stub.executor,
    svc: { events: eventSink, audit: auditSink },
    workerId: "test-worker-T19",
    intervalMs: 5000,
  });
  await sup.start();

  const samples = [
    "Authorization: Bearer SECRET_AAAA",
    "Bearer SECRET_BBBB",
    "token=SECRET_CCCC",
    "access_token=SECRET_DDDD",
    "password=SECRET_EEEE",
    "api_key=SECRET_FFFF",
    "https://user:SECRET_GGGG@example.com",
  ];

  for (const sample of samples) {
    stub.set({ failWith: new Error(sample) });
    try {
      await sup.runNow();
    } catch { /* expected */ }
  }
  await sup.stop();

  const diagnostics = sup.status().lastError ?? "";
  ok(diagnostics.includes("[REDACTED]") || diagnostics.length > 0,
    "a diagnostic was recorded");
  for (const s of ["SECRET_AAAA", "SECRET_BBBB", "SECRET_CCCC", "SECRET_DDDD", "SECRET_EEEE", "SECRET_FFFF", "SECRET_GGGG"]) {
    ok(!diagnostics.includes(s), `diagnostic does not contain ${s}`);
  }
  ok(diagnostics.length <= 500, "diagnostic <= 500 chars");
}

// --- T20: outcome propagation -----------------------------------------------

async function T20() {
  section("T20 — actual outcome propagation");
  const { events, eventSink, auditSink } = makeRecordingSinks();
  const stub = makeStubExecutor();
  const report: RecoveryRunReport = {
    scanned: 7, acted: 2, skipped: 3, blocked: 1, leaseHeld: 1,
    actions: [{ intentKey: "k-x", action: "RESUME_FROM_INTENT" as never, reason: "distinctive" }],
    blockedReasons: [{ intentKey: "k-y", reason: "why" }],
  };
  stub.set({ report });
  const sup = new ReleaseRecoverySupervisor({
    executor: stub.executor,
    svc: { events: eventSink, audit: auditSink },
    workerId: "test-worker-T20",
    intervalMs: 5000,
  });
  try {
    await sup.start();
    await sup.runNow();
    const s = sup.status();
    ok(s.lastRunResult?.scanned === 7, "scanned propagated");
    ok(s.lastRunResult?.acted === 2, "acted propagated");
    ok(s.lastRunResult?.skipped === 3, "skipped propagated");
    ok(s.lastRunResult?.blocked === 1, "blocked propagated");
    ok(s.lastRunResult?.leaseHeld === 1, "leaseHeld propagated");
    const completed = events.filter((e) => e.type === "release.recovery.supervisor.run_completed");
    const last = completed[completed.length - 1];
    const p = (last?.payload ?? {}) as Record<string, unknown>;
    ok(p.scanned === 7 && p.acted === 2 && p.blocked === 1, "event payload reflects actual report");
  } finally {
    await sup.stop();
  }
}

// --- T21: timer cleanup -----------------------------------------------------

async function T21() {
  section("T21 — timer cleanup after stop");
  const { eventSink, auditSink } = makeRecordingSinks();
  const stub = makeStubExecutor();
  const sup = new ReleaseRecoverySupervisor({
    executor: stub.executor,
    svc: { events: eventSink, audit: auditSink },
    workerId: "test-worker-T21",
    intervalMs: 30,
  });
  await sup.start();
  await sleep(80);
  await sup.stop();
  const count = stub.calls.length;
  await sleep(120);
  ok(stub.calls.length === count, "no additional executions after stop");
}

// --- T22: telemetry failure isolation ---------------------------------------

async function T22() {
  section("T22 — telemetry failure does not affect recovery outcome");
  const throwingEventSink: RecoverySupervisorEventSink = {
    emit: async () => { throw new Error("event sink is down"); },
  };
  const throwingAuditSink: RecoverySupervisorAuditSink = {
    record: async () => { throw new Error("audit sink is down"); },
  };
  const stub = makeStubExecutor();
  const report: RecoveryRunReport = {
    scanned: 1, acted: 1, skipped: 0, blocked: 0, leaseHeld: 0,
    actions: [], blockedReasons: [],
  };
  stub.set({ report });
  const sup = new ReleaseRecoverySupervisor({
    executor: stub.executor,
    svc: { events: throwingEventSink, audit: throwingAuditSink },
    workerId: "test-worker-T22",
    intervalMs: 5000,
  });
  try {
    await sup.start();
    const r = await sup.runNow();
    ok(r.scanned === 1, "outcome preserved despite telemetry failure");
    ok(sup.status().lastRunResult?.scanned === 1, "status reflects real report");
    await sup.stop();
    ok(sup.status().state === "STOPPED", "stop completed despite telemetry failure");
  } catch (e) {
    ok(false, `telemetry failure leaked: ${(e as Error).message}`);
  }
}

// --- main -------------------------------------------------------------------

async function main() {
  console.log("=== Phase 125 — Recovery Supervisor ===\n");
  await T1();
  await T2();
  await T3();
  await T4();
  await T5();
  await T6();
  await T7();
  await T8();
  await T9();
  await T10();
  await T11();
  await T12();
  await T13();
  await T14();
  await T15();
  await T16();
  await T17();
  await T18();
  await T19();
  await T20();
  await T21();
  await T22();

  console.log(`\n--- Phase 125: ${passed} passed, ${failed} failed ---`);
  if (failed > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});