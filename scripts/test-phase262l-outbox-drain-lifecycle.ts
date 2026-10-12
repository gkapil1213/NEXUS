// scripts/test-phase262l-outbox-drain-lifecycle.ts
// Phase 262L - outbox drain lifecycle coordination.
//
// Proves that NexusKernel.shutdown waits for in-flight outbox drains
// (startup, periodic) to settle before closing the PostgreSQL pool,
// and that a failed tracked drain does not skip pool cleanup.
//
// Tests:
//   262L-1. shutdown waits for an in-flight startup drain.
//   262L-2. shutdown waits for an in-flight periodic drain.
//   262L-3. a failed tracked drain is logged and does not skip cleanup.

import { PgClient, getPgClient } from "../src/core/pg-client";
import { NexusKernel } from "../src/core/kernel";

type Result = "PASS" | "FAIL" | "BLOCKED" | "NOT EXECUTED";
interface Row { id: string; name: string; result: Result; note: string; }
const rows: Row[] = [];
function record(id: string, name: string, result: Result, note: string): void {
  rows.push({ id, name, result, note });
  const mark = result === "PASS" ? "[PASS]" : result === "FAIL" ? "[FAIL]" : result === "BLOCKED" ? "[BLK ]" : "[N/E ]";
  console.log(`${mark} ${id} ${name} -- ${note}`);
}
function ok(cond: boolean, msg: string): void { if (!cond) throw new Error(msg); }

class Blocked extends Error {}
async function test(id: string, name: string, fn: () => Promise<string> | string): Promise<void> {
  try { record(id, name, "PASS", await fn()); }
  catch (e) {
    if (e instanceof Blocked) record(id, name, "BLOCKED", e.message);
    else record(id, name, "FAIL", e instanceof Error ? e.message : String(e));
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) { console.log("mode=shared db=unset -- DATABASE_URL required"); process.exit(1); }
  if (process.env.NEXUS_PERSISTENCE_MODE !== "shared") { console.log("mode=local -- NEXUS_PERSISTENCE_MODE=shared required"); process.exit(1); }

  // ---------------------------------------------------------------
  // 262L-1: shutdown waits for an in-flight startup drain.
  // ---------------------------------------------------------------
  {
    await test("262L-1", "shutdown waits for in-flight startup drain before pool close", async () => {
      const k: any = new NexusKernel();
      await k.boot();

      // Simulate a startup drain that is still in flight: track a slow
      // promise on the kernel's private in-flight set using the same
      // helper the kernel itself uses.
      let settled = false;
      const slow = new Promise<void>((resolve) => setTimeout(() => { settled = true; resolve(); }, 400));
      k.trackOutboxDrain("Test startup drain", slow);

      // Spy on pgClient.close to observe ordering.
      const pgClient: any = k.pgClient;
      ok(pgClient, "kernel must have a pgClient in shared mode");
      const origClose = pgClient.close.bind(pgClient);
      let closeCalledBeforeSettle = false;
      pgClient.close = async () => {
        if (!settled) closeCalledBeforeSettle = true;
        return origClose();
      };

      await k.shutdown({ finalRecoveryPass: false });

      ok(!closeCalledBeforeSettle, "pgClient.close must not run before the tracked drain settles");
      ok(settled, "the tracked drain must have settled before shutdown returned");
      ok(getPgClient() === null, "pgClient must be cleared after shutdown");
      return "startup drain awaited; pool closed after settle";
    });
  }

  // ---------------------------------------------------------------
  // 262L-2: shutdown waits for an in-flight periodic drain.
  // ---------------------------------------------------------------
  {
    await test("262L-2", "shutdown waits for in-flight periodic drain before pool close", async () => {
      // Enable a fast periodic tick just for this kernel.
      const prevInterval = process.env.NEXUS_EXEC_RECONCILE_MS;
      process.env.NEXUS_EXEC_RECONCILE_MS = "100";

      const k: any = new NexusKernel();
      await k.boot();

      // Install a slow drain on the kernel's drainer, before the first tick.
      let started = false;
      let settled = false;
      const slow = new Promise<void>((resolve) => {
        started = true;
        setTimeout(() => { settled = true; resolve(); }, 400);
      });
      k.engineeringOutboxDrainer.drain = (_now: number) => slow;

      // Wait until the periodic tick fires and calls our stub.
      const deadline = Date.now() + 2000;
      while (!started && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      ok(started, "the periodic tick must have invoked the slow drain stub");

      // Spy on pgClient.close.
      const pgClient: any = k.pgClient;
      const origClose = pgClient.close.bind(pgClient);
      let closeCalledBeforeSettle = false;
      pgClient.close = async () => {
        if (!settled) closeCalledBeforeSettle = true;
        return origClose();
      };

      try {
        await k.shutdown({ finalRecoveryPass: false });
      } finally {
        if (prevInterval === undefined) delete process.env.NEXUS_EXEC_RECONCILE_MS;
        else process.env.NEXUS_EXEC_RECONCILE_MS = prevInterval;
      }

      ok(!closeCalledBeforeSettle, "pgClient.close must not run before the periodic drain settles");
      ok(settled, "the periodic drain must have settled before shutdown returned");
      ok(getPgClient() === null, "pgClient must be cleared after shutdown");
      return "periodic drain awaited; pool closed after settle";
    });
  }

  // ---------------------------------------------------------------
  // 262L-3: a failed tracked drain is logged and does not skip cleanup.
  // ---------------------------------------------------------------
  {
    await test("262L-3", "failed tracked drain is logged; pool still closed", async () => {
      const captured: string[] = [];
      const origError = console.error;
      console.error = (...args: any[]) => { captured.push(args.map(String).join(" ")); origError(...args); };
      try {
        const k: any = new NexusKernel();
        await k.boot();

        // Track a promise that rejects. trackOutboxDrain attaches a
        // .catch, so this must not become an unhandled rejection, and
        // the failure must be logged.
        k.trackOutboxDrain("Failing test drain", Promise.reject(new Error("262L_injected_drain_failure")));

        let threw = false;
        try { await k.shutdown({ finalRecoveryPass: false }); } catch { threw = true; }
        ok(!threw, "shutdown must not throw when a tracked drain failed");
        ok(getPgClient() === null, "pgClient must be cleared after shutdown");

        const logged = captured.some((line) =>
          line.indexOf("Failing test drain failed") >= 0 &&
          line.indexOf("262L_injected_drain_failure") >= 0
        );
        ok(logged, `console.error must record the failed drain; captured: ${JSON.stringify(captured)}`);
        return "failed drain logged; pool closed";
      } finally {
        console.error = origError;
      }
    });
  }


  // ---------------------------------------------------------------
  // 262L-4: a throwing stop-step does not skip pool cleanup.
  // ---------------------------------------------------------------
  {
    await test("262L-4", "a throwing stop-step does not skip pool cleanup", async () => {
      const k: any = new NexusKernel();
      await k.boot();
      // Force a stop-step to throw. driftObserver is optional and its
      // stop() has no internal try/catch before this hardening pass,
      // so it is the natural candidate to exercise the failure path.
      k.driftObserver = {
        stop: async () => { throw new Error("262L_injected_drift_stop_failure"); },
      };
      let threw = false;
      try { await k.shutdown({ finalRecoveryPass: false }); } catch { threw = true; }
      ok(!threw, "shutdown must not throw when a stop-step fails");
      ok(getPgClient() === null, "pgClient must be cleared despite the stop-step failure");
      // A repeat call returns the memoized promise; no duplicate cleanup.
      await k.shutdown({ finalRecoveryPass: false });
      ok(getPgClient() === null, "pgClient stays cleared after a repeat shutdown");
      return "stop-step failure tolerated; pool closed";
    });
  }

  const failed = rows.filter((r) => r.result === "FAIL" || r.result === "BLOCKED");
  console.log(`\n${rows.length} checks, ${failed.length} failed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
