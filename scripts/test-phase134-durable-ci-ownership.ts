#!/usr/bin/env tsx
/* Phase 134 — durable CI reconciliation worker ownership tests.
 *
 * Real in-memory SQLite. Real CiReconciliationOwnershipService. Real
 * CicdReconciliationScheduler. Deterministic clock + timer injection.
 * No network. No fake production claims. */

import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CiReconciliationOwnershipService,
  CI_RECONCILIATION_OWNERSHIP_ID,
} from "../src/core/ci-reconciliation-ownership.service";
import {
  CicdReconciliationScheduler,
  type ReconciliationDrain,
} from "../src/core/cicd-reconciliation-scheduler";

/* --------------------------------- harness -------------------------------- */

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

/* -------------------------- sqlite + migration setup ---------------------- */

function newDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  const sql = readFileSync(
    join(process.cwd(), "src", "db", "migrations", "151_phase134_reconciliation_worker_ownership.sql"),
    "utf8",
  );
  db.exec(sql);
  return db;
}

/* --------------------------------- clocks --------------------------------- */

interface Clock { now: () => number; set: (t: number) => void; advance: (ms: number) => void; }
function makeClock(start = 1_000_000): Clock {
  let t = start;
  return { now: () => t, set: (v) => { t = v; }, advance: (ms) => { t += ms; } };
}

/* --------------------------------- events --------------------------------- */

interface EventRec { type: string; payload?: Record<string, unknown>; }
function recorder(): { events: EventRec[]; audits: EventRec[]; sink: { emit: (i: any) => Promise<void> }; audit: { record: (i: any) => Promise<void> } } {
  const events: EventRec[] = [];
  const audits: EventRec[] = [];
  return {
    events, audits,
    sink: { emit: async (i) => { events.push({ type: i.type, payload: i.payload }); } },
    audit: { record: async (i) => { audits.push({ type: i.action, payload: i.metadata }); } },
  };
}

/* ------------------------------- scheduler fakes -------------------------- */

interface FakeTimerHandle { fn: () => void; ms: number; cancelled: boolean; }
function makeFakeTimers() {
  const state = {
    scheduled: null as FakeTimerHandle | null,
    scheduleCount: 0,
    delays: [] as number[],
    intervalCalls: 0,
  };
  const setTimeoutFake = (fn: () => void, ms: number): FakeTimerHandle => {
    const h = { fn, ms, cancelled: false };
    state.scheduled = h;
    state.scheduleCount += 1;
    state.delays.push(ms);
    return h;
  };
  const clearTimeoutFake = (h: unknown): void => {
    if (h && typeof h === "object") (h as FakeTimerHandle).cancelled = true;
    if (state.scheduled === h) state.scheduled = null;
  };
  const fire = async (): Promise<boolean> => {
    const h = state.scheduled;
    if (!h || h.cancelled) return false;
    state.scheduled = null;
    h.fn();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    return true;
  };
  return { state, setTimeout: setTimeoutFake, clearTimeout: clearTimeoutFake, fire };
}

function countingDrain(calls: { n: number }): ReconciliationDrain {
  return { reconcileOpen: async () => { calls.n += 1; return []; } };
}

/* ---------------------------------- tests --------------------------------- */

function T01(): void {
  const db = newDb();
  const cols = db.prepare("PRAGMA table_info(ci_reconciliation_worker_ownership)").all() as Array<{ name: string }>;
  const names = cols.map((c) => c.name);
  ok("T01",
    names.includes("ownership_id") && names.includes("worker_id") && names.includes("lease_id") &&
    names.includes("state") && names.includes("acquired_at") && names.includes("renewed_at") &&
    names.includes("expires_at") && names.includes("released_at") && names.includes("last_error") &&
    names.includes("created_at") && names.includes("updated_at"),
    "schema contains all required columns");
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='ci_reconciliation_worker_ownership'").all() as Array<{ name: string }>;
  ok("T01", idx.some((i) => i.name === "idx_cirwo_singleton_active"), "partial unique index exists");
}

function T02(): void {
  const db = newDb();
  // Re-run the migration idempotently.
  const sql = readFileSync(
    join(process.cwd(), "src", "db", "migrations", "151_phase134_reconciliation_worker_ownership.sql"),
    "utf8",
  );
  let threw = false;
  try { db.exec(sql); } catch { threw = true; }
  ok("T02", !threw, "migration is idempotent (re-running is a no-op)");
}

async function T03(): Promise<void> {
  const db = newDb();
  const clock = makeClock();
  const rec = recorder();
  const a = new CiReconciliationOwnershipService(db as never, "worker-A", rec.sink, rec.audit, { now: clock.now, ttlMs: 30_000 });
  const s = await a.ensureOwned();
  ok("T03", s.owned === true && s.leaseId !== null, "first owner acquires successfully");
  const inspect = a.inspect();
  ok("T03", inspect.state === "ACTIVE" && inspect.holder === "worker-A", "inspect reflects ACTIVE ownership by worker-A");
}

async function T04(): Promise<void> {
  const db = newDb();
  const clock = makeClock();
  const rec = recorder();
  const a = new CiReconciliationOwnershipService(db as never, "worker-A", rec.sink, rec.audit, { now: clock.now, ttlMs: 30_000 });
  const b = new CiReconciliationOwnershipService(db as never, "worker-B", rec.sink, rec.audit, { now: clock.now, ttlMs: 30_000 });
  await a.ensureOwned();
  const s = await b.ensureOwned();
  ok("T04", s.owned === false && (s.reason === "held-by-other" || s.reason === "race-lost"),
    "second owner rejected (reason=" + s.reason + ")");
}

async function T05(): Promise<void> {
  const db = newDb();
  const clock = makeClock();
  const rec = recorder();
  const a = new CiReconciliationOwnershipService(db as never, "worker-A", rec.sink, rec.audit, { now: clock.now, ttlMs: 30_000 });
  await a.ensureOwned();
  const s = await a.ensureOwned();
  ok("T05", s.owned === true, "owner validates by re-running ensureOwned (renew path)");
  const inspect = new CiReconciliationOwnershipService(db as never, "observer", rec.sink, rec.audit, { now: clock.now }).inspect();
  ok("T05", inspect.holder === "worker-A" && inspect.state === "ACTIVE", "durable inspect shows the current owner");
}

async function T06(): Promise<void> {
  const db = newDb();
  const clock = makeClock();
  const rec = recorder();
  const a = new CiReconciliationOwnershipService(db as never, "worker-A", rec.sink, rec.audit, { now: clock.now, ttlMs: 30_000 });
  const first = await a.ensureOwned();
  clock.advance(10_000);
  const second = await a.ensureOwned();
  ok("T06", second.owned === true && first.expiresAt !== null && second.expiresAt !== null && second.expiresAt > first.expiresAt,
    "renewal extends expiresAt (" + first.expiresAt + " → " + second.expiresAt + ")");
}

async function T07(): Promise<void> {
  const db = newDb();
  const clock = makeClock();
  const rec = recorder();
  const a = new CiReconciliationOwnershipService(db as never, "worker-A", rec.sink, rec.audit, { now: clock.now, ttlMs: 30_000 });
  const b = new CiReconciliationOwnershipService(db as never, "worker-B", rec.sink, rec.audit, { now: clock.now, ttlMs: 30_000 });
  await a.ensureOwned();
  const bOwned = await b.ensureOwned();
  ok("T07", bOwned.owned === false, "wrong worker cannot become owner while A holds");
}

async function T08(): Promise<void> {
  const db = newDb();
  const clock = makeClock();
  const rec = recorder();
  const a = new CiReconciliationOwnershipService(db as never, "worker-A", rec.sink, rec.audit, { now: clock.now, ttlMs: 30_000 });
  await a.ensureOwned();
  // Advance past expiry, then B acquires first.
  clock.advance(31_000);
  const b = new CiReconciliationOwnershipService(db as never, "worker-B", rec.sink, rec.audit, { now: clock.now, ttlMs: 30_000 });
  const bOwned = await b.ensureOwned();
  ok("T08", bOwned.owned === true, "expired owner's lease auto-expired during B's ensureOwned");
  // A tries to renew — must fail because B holds.
  const aRetry = await a.ensureOwned();
  ok("T08", aRetry.owned === false, "expired owner cannot renew after takeover");
}

async function T09(): Promise<void> {
  const db = newDb();
  const clock = makeClock();
  const rec = recorder();
  const a = new CiReconciliationOwnershipService(db as never, "worker-A", rec.sink, rec.audit, { now: clock.now, ttlMs: 30_000 });
  await a.ensureOwned();
  clock.advance(31_000);
  const b = new CiReconciliationOwnershipService(db as never, "worker-B", rec.sink, rec.audit, { now: clock.now, ttlMs: 30_000 });
  const bOwned = await b.ensureOwned();
  ok("T09", bOwned.owned === true, "expired lease can be safely taken over");
}

async function T10(): Promise<void> {
  const db = newDb();
  const clock = makeClock();
  const rec = recorder();
  const a = new CiReconciliationOwnershipService(db as never, "worker-A", rec.sink, rec.audit, { now: clock.now, ttlMs: 30_000 });
  await a.ensureOwned();
  clock.advance(31_000);
  const b = new CiReconciliationOwnershipService(db as never, "worker-B", rec.sink, rec.audit, { now: clock.now, ttlMs: 30_000 });
  await b.ensureOwned();
  const aAfter = await a.ensureOwned();
  ok("T10", aAfter.owned === false, "old owner is blocked after takeover (no mutation possible)");
}

async function T11(): Promise<void> {
  const db = newDb();
  const clock = makeClock();
  const rec = recorder();
  const a = new CiReconciliationOwnershipService(db as never, "worker-A", rec.sink, rec.audit, { now: clock.now, ttlMs: 30_000 });
  await a.ensureOwned();
  await a.release();
  const inspect = a.inspect();
  ok("T11", inspect.state === "RELEASED", "release moves row to RELEASED");
  const b = new CiReconciliationOwnershipService(db as never, "worker-B", rec.sink, rec.audit, { now: clock.now, ttlMs: 30_000 });
  const bOwned = await b.ensureOwned();
  ok("T11", bOwned.owned === true, "B can acquire after A's release");
}

async function T12(): Promise<void> {
  const db = newDb();
  const clock = makeClock();
  const rec = recorder();
  const a1 = new CiReconciliationOwnershipService(db as never, "worker-A", rec.sink, rec.audit, { now: clock.now, ttlMs: 30_000 });
  await a1.ensureOwned();
  clock.advance(31_000);
  // Simulate A crashing and restarting with the SAME worker identity.
  const a2 = new CiReconciliationOwnershipService(db as never, "worker-A", rec.sink, rec.audit, { now: clock.now, ttlMs: 30_000 });
  const s = await a2.ensureOwned();
  ok("T12", s.owned === true, "restart can reclaim its own expired ownership");
}

/* ---------------------------------- runner -------------------------------- */

async function main(): Promise<void> {
  console.log("Phase 134 — durable CI reconciliation worker ownership tests");
  T01(); T02(); await T03(); await T04(); await T05(); await T06();
  await T07(); await T08(); await T09(); await T10(); await T11(); await T12();
  // T13–T26 added in Block D2.
  console.log("");
  console.log("passed: " + passed + "  failed: " + failed);
  if (failed > 0) {
    console.log("");
    for (const f of failures) console.log("  FAILED: " + f);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(2); });