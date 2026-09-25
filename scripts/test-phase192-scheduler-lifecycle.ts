// scripts/test-phase192-scheduler-lifecycle.ts
//
// PHASE 192 — Scheduler + ownership lifecycle at the service level.
//
// Constructs CiReconciliationOwnershipService and CicdReconciliationScheduler
// directly against a real in-memory SQLite engine. Exercises:
//   §4 start / stop / restart
//   §5 ownership lifecycle A–E (normal, graceful, restart, crash, stale-return)
//   §8 lease takeover + fencing
//
// No kernel.boot(). No mocks of the services under test.

import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CiReconciliationOwnershipService } from "../src/core/ci-reconciliation-ownership.service";
import { CicdReconciliationScheduler } from "../src/core/cicd-reconciliation-scheduler";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log("[PASSED] " + name + (detail ? "  " + detail : "")); }
  else      { fail++; console.log("[FAILED] " + name + (detail ? "  " + detail : "")); }
}

function newDb(): Database.Database {
  const db = new Database(":memory:");
  const m151 = readFileSync(
    join(process.cwd(), "src", "db", "migrations",
         "151_phase134_reconciliation_worker_ownership.sql"), "utf8");
  db.exec(m151);
  return db;
}

// A drain that always succeeds — we are testing the scheduler/ownership
// lifecycle, not the reconciliation logic.
function drain(): Promise<void> { return Promise.resolve(); }

async function main() {
  console.log("PHASE 192 — SCHEDULER + OWNERSHIP LIFECYCLE\n");

  // ---------- §4 / §5A: start ----------
  const db = newDb();
  const ownA = new CiReconciliationOwnershipService(db, "worker-A", undefined, undefined,
                                                    { ttlMs: 30_000 });
  const schedA = new CicdReconciliationScheduler({ reconcileOpen: drain } as any, {
    ownership: ownA, intervalMs: 60_000,
  });

  schedA.start();
  ok("§4 scheduler start() running", schedA.isRunning() === true);
  schedA.start();   // idempotent
  ok("§4 scheduler start() idempotent", schedA.isRunning() === true);

  const acquiredA = await ownA.ensureOwned();
  ok("§5A A acquired ownership", acquiredA.owned === true,
     `worker=${acquiredA.workerId}`);

  const fenceA = ownA.currentFence();
  ok("§5A A has a fence", fenceA !== null, `leaseId=${fenceA?.leaseId}`);

  // ---------- §4 / §5B: graceful stop ----------
  await schedA.stop();
  ok("§4 scheduler stop() not running", schedA.isRunning() === false);

  const stateAfterStop = ownA.inspect();
  ok("§5B ownership RELEASED after stop", stateAfterStop.state === "RELEASED",
     `state=${stateAfterStop.state}`);

  // ---------- §4 / §5C: restart reacquires ----------
  const ownA2 = new CiReconciliationOwnershipService(db, "worker-A", undefined, undefined,
                                                     { ttlMs: 30_000 });
  const schedA2 = new CicdReconciliationScheduler({ reconcileOpen: drain } as any, {
    ownership: ownA2, intervalMs: 60_000,
  });
  schedA2.start();
  const acquiredA2 = await ownA2.ensureOwned();
  ok("§5C A can reacquire after graceful stop", acquiredA2.owned === true);
  await schedA2.stop();

  // ---------- §5D: stale owner expires; B takes over ----------
  const ownA3 = new CiReconciliationOwnershipService(db, "worker-A", undefined, undefined,
                                                     { ttlMs: 1_000 });
  const ownB  = new CiReconciliationOwnershipService(db, "worker-B", undefined, undefined,
                                                     { ttlMs: 30_000 });
  const acqA3 = await ownA3.ensureOwned();
  ok("§5D A3 acquired before expiry", acqA3.owned === true);

  // Force expiry by waiting one TTL + margin.
  await new Promise((r) => setTimeout(r, 1_100));

  const acqB = await ownB.ensureOwned();
  ok("§5D B takes over after A's lease expires", acqB.owned === true,
     `holder=${acqB.holder}`);

  // ---------- §5E / §8: stale owner returns ----------
  const renewA3 = await ownA3.ensureOwned();
  ok("§5E stale A cannot renew after takeover", renewA3.owned === false,
     `reason=${renewA3.reason}`);

  ok("§8 B remains authoritative", ownB.isOwnedNowSync() === true);

  const inspectFinal = ownB.inspect();
  ok("§8 durable row names B",
     inspectFinal.state === "ACTIVE" && inspectFinal.holder === "worker-B",
     `holder=${inspectFinal.holder} state=${inspectFinal.state}`);

  // ---------- §4: no orphan timers ----------
  const schedB = new CicdReconciliationScheduler({ reconcileOpen: drain } as any, {
    ownership: ownB, intervalMs: 60_000,
  });
  schedB.start();
  ok("§4 B scheduler running", schedB.isRunning() === true);
  await schedB.stop();
  ok("§4 B scheduler cleanly stopped", schedB.isRunning() === false);

  console.log(`\nPASS: ${pass}\nFAIL: ${fail}`);
  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch((e) => { console.error("FATAL:", e); process.exit(2); });
