#!/usr/bin/env tsx
/* Phase 133 — durable CI reconciliation scheduler tests.
 *
 * Deterministic: injects a fake clock, fake setInterval/clearInterval, and a
 * fixed random(). No real timers, no network, no SQLite.
 *
 * Verifies only the scheduler's own contract — single-flight, bounded backoff
 * with jitter, graceful stop, idempotent start/stop, and stats. The underlying
 * reconciler behavior is already covered by Phase 132. */

import { CicdReconciliationScheduler, type ReconciliationDrain } from "../src/core/cicd-reconciliation-scheduler";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(id: string, cond: boolean, msg: string): void {
  if (cond) { passed++; console.log("  ok   " + id + "  " + msg); }
  else { failed++; failures.push(id + "  " + msg); console.log("  FAIL " + id + "  " + msg); }
}
function eq<T>(id: string, actual: T, expected: T, msg: string): void {
  ok(id, actual === expected, msg + "  (expected=" + JSON.stringify(expected) + ", got=" + JSON.stringify(actual) + ")");
}

/* ------------------------------ fake timers ------------------------------ */

interface ScheduledHandle { fn: () => void; ms: number; cancelled: boolean; }

function makeFakeTimers() {
  const state = {
    now: 0,
    scheduled: null as ScheduledHandle | null,
    scheduleCount: 0,
    delays: [] as number[],
    clearedCount: 0,
    // Regression counters for the Phase 133b timer-lifecycle bug:
    // the scheduler must NEVER call setInterval.
    timeoutCalls: 0,
    intervalCalls: 0,
  };
  const setTimeoutFake = (fn: () => void, ms: number): ScheduledHandle => {
    state.timeoutCalls += 1;
    const h: ScheduledHandle = { fn, ms, cancelled: false };
    state.scheduled = h;
    state.scheduleCount += 1;
    state.delays.push(ms);
    return h;
  };
  // Trap: if the scheduler ever calls setInterval, the regression test fails.
  // Return a cancelled handle so the scheduler does not actually crash.
  const setIntervalTrap = (fn: () => void, ms: number): ScheduledHandle => {
    state.intervalCalls += 1;
    return { fn, ms, cancelled: true };
  };
  const clearTimeoutFake = (h: unknown): void => {
    state.clearedCount += 1;
    if (h && typeof h === "object") (h as ScheduledHandle).cancelled = true;
    if (state.scheduled === h) state.scheduled = null;
  };
  /** Fire the currently scheduled callback and let the async tick settle. */
  const fire = async (): Promise<boolean> => {
    const h = state.scheduled;
    if (!h || h.cancelled) return false;
    state.scheduled = null;
    h.fn();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    return true;
  };
  return { state, setTimeout: setTimeoutFake, clearTimeout: clearTimeoutFake, setIntervalTrap, fire };
}

/* ------------------------------- drain fakes ------------------------------ */

function drainThatResolves(calls: { n: number }): ReconciliationDrain {
  return { reconcileOpen: async () => { calls.n += 1; return []; } };
}
function drainThatRejects(calls: { n: number }, reason = "TEST_FAILURE"): ReconciliationDrain {
  return { reconcileOpen: async () => { calls.n += 1; throw new Error(reason); } };
}
function drainThatHangs(): { drain: ReconciliationDrain; resolve: () => void } {
  let resolve!: () => void;
  const p = new Promise<void>((r) => { resolve = r; });
  return { drain: { reconcileOpen: async () => { await p; return []; } }, resolve };
}

/* ---------------------------------- tests --------------------------------- */

async function T01(): Promise<void> {
  const t = makeFakeTimers();
  const calls = { n: 0 };
  const s = new CicdReconciliationScheduler(drainThatResolves(calls), {
    intervalMs: 1_000, jitterMs: 0, now: () => t.state.now,
    setTimeout: t.setTimeout as never, clearTimeout: t.clearTimeout as never,
  });
  s.start();
  eq("T01", s.isRunning(), true, "start() sets running=true");
  eq("T01", t.state.scheduleCount, 1, "start() schedules exactly one timer");
  eq("T01", t.state.delays[0], 0, "first schedule fires immediately (delay=0)");
}

async function T02(): Promise<void> {
  const t = makeFakeTimers();
  const calls = { n: 0 };
  const s = new CicdReconciliationScheduler(drainThatResolves(calls), {
    intervalMs: 1_000, jitterMs: 0, now: () => t.state.now,
    setTimeout: t.setTimeout as never, clearTimeout: t.clearTimeout as never,
  });
  s.start();
  await t.fire();
  eq("T02", calls.n, 1, "firing the first timer invokes reconcileOpen exactly once");
}

async function T03(): Promise<void> {
  const t = makeFakeTimers();
  const calls = { n: 0 };
  const s = new CicdReconciliationScheduler(drainThatResolves(calls), {
    intervalMs: 1_000, jitterMs: 0, now: () => t.state.now,
    setTimeout: t.setTimeout as never, clearTimeout: t.clearTimeout as never,
  });
  s.start();
  await t.fire();
  eq("T03", t.state.delays[t.state.delays.length - 1], 1_000,
     "after a successful tick, next delay == intervalMs (no backoff)");
}

async function T04(): Promise<void> {
  const t = makeFakeTimers();
  const hung = drainThatHangs();
  const s = new CicdReconciliationScheduler(hung.drain, {
    intervalMs: 1_000, jitterMs: 0, now: () => t.state.now,
    setTimeout: t.setTimeout as never, clearTimeout: t.clearTimeout as never,
  });
  // Kick off a tick without a timer, then try a second concurrently.
  const first = s.tickNow();
  await Promise.resolve();
  const second = await s.tickNow();
  eq("T04", second.ran, false, "concurrent tickNow() does not run");
  eq("T04", second.reason, "coalesced", "concurrent tickNow() reports coalesced");
  hung.resolve();
  await first;
}

async function T05(): Promise<void> {
  const t = makeFakeTimers();
  const calls = { n: 0 };
  const s = new CicdReconciliationScheduler(drainThatRejects(calls), {
    intervalMs: 1_000, jitterMs: 0, maxBackoffMs: 100_000, now: () => t.state.now,
    setTimeout: t.setTimeout as never, clearTimeout: t.clearTimeout as never,
  });
  s.start();
  await t.fire();
  // One failure → next delay = intervalMs * 2^1 = 2000
  eq("T05", t.state.delays[t.state.delays.length - 1], 2_000,
     "after one failure, next delay doubles (exponential backoff)");
  await t.fire();
  eq("T05", t.state.delays[t.state.delays.length - 1], 4_000,
     "after two failures, next delay quadruples");
}

async function T06(): Promise<void> {
  const t = makeFakeTimers();
  const calls = { n: 0 };
  const s = new CicdReconciliationScheduler(drainThatRejects(calls), {
    intervalMs: 1_000, jitterMs: 0, maxBackoffMs: 5_000, now: () => t.state.now,
    setTimeout: t.setTimeout as never, clearTimeout: t.clearTimeout as never,
  });
  s.start();
  for (let i = 0; i < 6; i++) await t.fire();
  eq("T06", t.state.delays[t.state.delays.length - 1], 5_000,
     "backoff is capped at maxBackoffMs");
}

async function T07(): Promise<void> {
  const t = makeFakeTimers();
  const calls = { n: 0 };
  const s = new CicdReconciliationScheduler(drainThatResolves(calls), {
    intervalMs: 1_000, jitterMs: 400, now: () => t.state.now,
    setTimeout: t.setTimeout as never, clearTimeout: t.clearTimeout as never,
    random: () => 0.5,
  });
  s.start();
  await t.fire();
  eq("T07", t.state.delays[t.state.delays.length - 1], 1_200,
     "jitter adds floor(random * jitterMs) to base delay");
}

async function T08(): Promise<void> {
  const t = makeFakeTimers();
  const hung = drainThatHangs();
  const s = new CicdReconciliationScheduler(hung.drain, {
    intervalMs: 1_000, jitterMs: 0, now: () => t.state.now,
    setTimeout: t.setTimeout as never, clearTimeout: t.clearTimeout as never,
  });
  s.start();
  const firing = t.fire();
  await Promise.resolve();
  const stopping = s.stop();
  hung.resolve();
  await firing;
  await stopping;
  eq("T08", s.isRunning(), false, "stop() sets running=false");
  eq("T08", s.isTickInFlight(), false, "stop() awaits in-flight tick before returning");
}

async function T09(): Promise<void> {
  const t = makeFakeTimers();
  const calls = { n: 0 };
  const s = new CicdReconciliationScheduler(drainThatResolves(calls), {
    intervalMs: 1_000, jitterMs: 0, now: () => t.state.now,
    setTimeout: t.setTimeout as never, clearTimeout: t.clearTimeout as never,
  });
  s.start();
  await s.stop();
  let threw = false;
  try { await s.stop(); } catch { threw = true; }
  ok("T09", !threw, "stop() is idempotent (does not throw on second call)");
}

async function T10(): Promise<void> {
  const t = makeFakeTimers();
  const calls = { n: 0 };
  const s = new CicdReconciliationScheduler(drainThatResolves(calls), {
    intervalMs: 1_000, jitterMs: 0, now: () => t.state.now,
    setTimeout: t.setTimeout as never, clearTimeout: t.clearTimeout as never,
  });
  s.start();
  s.start();
  s.start();
  eq("T10", t.state.scheduleCount, 1, "start() is idempotent (only one schedule)");
}

async function T11(): Promise<void> {
  const t = makeFakeTimers();
  const calls = { n: 0 };
  const errors: unknown[] = [];
  const s = new CicdReconciliationScheduler(drainThatRejects(calls, "BOOM"), {
    intervalMs: 1_000, jitterMs: 0, now: () => t.state.now,
    setTimeout: t.setTimeout as never, clearTimeout: t.clearTimeout as never,
    onError: (e) => { errors.push(e); },
  });
  s.start();
  await t.fire();
  eq("T11", errors.length, 1, "onError is invoked on drain failure");
  ok("T11", (errors[0] as Error).message === "BOOM", "onError receives the original error");
}

async function T12(): Promise<void> {
  const t = makeFakeTimers();
  let reject = true;
  const drain: ReconciliationDrain = {
    reconcileOpen: async () => {
      if (reject) throw new Error("transient");
      return [];
    },
  };
  const s = new CicdReconciliationScheduler(drain, {
    intervalMs: 1_000, jitterMs: 0, maxBackoffMs: 100_000, now: () => t.state.now,
    setTimeout: t.setTimeout as never, clearTimeout: t.clearTimeout as never,
  });
  s.start();
  await t.fire();
  eq("T12", s.stats().consecutiveFailures, 1, "one failure → consecutiveFailures=1");
  reject = false;
  await t.fire();
  eq("T12", s.stats().consecutiveFailures, 0, "success resets consecutiveFailures");
}

async function T13(): Promise<void> {
  const t = makeFakeTimers();
  t.state.now = 1_000;
  const calls = { n: 0 };
  const s = new CicdReconciliationScheduler(
    { reconcileOpen: async () => { calls.n += 1; t.state.now += 42; return []; } },
    {
      intervalMs: 1_000, jitterMs: 0, now: () => t.state.now,
      setTimeout: t.setTimeout as never, clearTimeout: t.clearTimeout as never,
    },
  );
  s.start();
  eq("T13", s.stats().startedAt, 1_000, "stats().startedAt reflects start() time");
  await t.fire();
  eq("T13", s.stats().lastTickDurationMs, 42, "stats().lastTickDurationMs reflects real duration");
  eq("T13", s.stats().lastTickStartedAt, 1_000, "stats().lastTickStartedAt recorded");
}

async function T14(): Promise<void> {
  const t = makeFakeTimers();
  const calls = { n: 0 };
  const s = new CicdReconciliationScheduler(drainThatResolves(calls), {
    intervalMs: 1_000, jitterMs: 0, now: () => t.state.now,
    setTimeout: t.setTimeout as never, clearTimeout: t.clearTimeout as never,
  });
  s.start();
  await s.stop();
  const scheduledBefore = t.state.scheduleCount;
  await t.fire();
  eq("T14", t.state.scheduleCount, scheduledBefore, "no further schedule after stop()");
  eq("T14", calls.n, 0, "drain never invoked after stop() (timer cleared)");
}

async function T15(): Promise<void> {
  const t = makeFakeTimers();
  const calls = { n: 0 };
  const s = new CicdReconciliationScheduler(drainThatResolves(calls), {
    intervalMs: 1_000, jitterMs: 0, now: () => t.state.now,
    setTimeout: t.setTimeout as never, clearTimeout: t.clearTimeout as never,
  });
  // Manual tick outside the scheduler — should run even if not started.
  const r = await s.tickNow();
  eq("T15", r.ran, true, "manual tickNow() runs even before start()");
  eq("T15", calls.n, 1, "manual tickNow() invoked drain exactly once");
}

async function T16(): Promise<void> {
  const t = makeFakeTimers();
  const calls = { n: 0 };
  let reject = true;
  const drain: ReconciliationDrain = {
    reconcileOpen: async () => { calls.n += 1; if (reject) throw new Error("x"); return []; },
  };
  const s = new CicdReconciliationScheduler(drain, {
    intervalMs: 1_000, jitterMs: 0, maxBackoffMs: 100_000, now: () => t.state.now,
    setTimeout: t.setTimeout as never, clearTimeout: t.clearTimeout as never,
  });
  s.start();
  await t.fire();
  // After a failure, next delay should be backoff (2x interval), not reset.
  eq("T16", t.state.delays[t.state.delays.length - 1], 2_000,
     "backoff persists across scheduled (not manual) ticks");
  reject = false;
  await t.fire();
  // After success, back to base.
  eq("T16", t.state.delays[t.state.delays.length - 1], 1_000,
     "backoff returns to intervalMs after a successful tick");
}

async function T17(): Promise<void> {
  // Regression test for the Phase 133 timer-lifecycle bug:
  // the scheduler must use one-shot setTimeout semantics, never setInterval.
  // If this regresses, state.intervalCalls will be > 0 and the test fails.
  const t = makeFakeTimers();
  const calls = { n: 0 };
  const s = new CicdReconciliationScheduler(drainThatResolves(calls), {
    intervalMs: 1_000, jitterMs: 0, now: () => t.state.now,
    setTimeout: t.setTimeout as never, clearTimeout: t.clearTimeout as never,
  });
  // Also inject the trap by monkey-patching the fake to record intervalCalls
  // if the scheduler bypasses opts and reaches for global setInterval.
  const origGlobal = (globalThis as { setInterval?: unknown }).setInterval;
  let globalIntervalCalls = 0;
  try {
    (globalThis as { setInterval?: unknown }).setInterval = () => { globalIntervalCalls++; return 0; };
    s.start();
    await t.fire();
    await t.fire();
    await t.fire();
  } finally {
    (globalThis as { setInterval?: unknown }).setInterval = origGlobal;
  }
  eq("T17", globalIntervalCalls, 0,
     "scheduler never falls through to global setInterval");
  eq("T17", t.state.scheduleCount > 0, true,
     "scheduler scheduled at least one one-shot timer");
  await s.stop();
}

/* ---------------------------------- runner -------------------------------- */

async function main(): Promise<void> {
  console.log("Phase 133 — scheduler tests");
  await T01(); await T02(); await T03(); await T04(); await T05();
  await T06(); await T07(); await T08(); await T09(); await T10();
  await T11(); await T12(); await T13(); await T14(); await T15(); await T16(); await T17();

  console.log("");
  console.log("passed: " + passed + "  failed: " + failed);
  if (failed > 0) {
    console.log("");
    for (const f of failures) console.log("  FAILED: " + f);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(2); });