// scripts/test-phase262-outbox-claim-concurrency.ts
// Phase 262A / 262B - multi-row outbox claim concurrency and shutdown durability.

import { PgClient, getPgClient } from "../src/core/pg-client";
import { NexusKernel } from "../src/core/kernel";
import { EngineeringRunEventDrainer, OutboxClaimError } from "../src/core/engineering-run-event-drainer";

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

const PREFIX = `engrun-262-${Date.now()}-`;

async function pgCleanup(prefix: string): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  const c = new PgClient(); await c.connect(url);
  try {
    await c.query("DELETE FROM engineering_run_event_outbox WHERE run_id LIKE $1 OR job_id LIKE $1", [prefix + "%"]);
    await c.query("DELETE FROM engineering_run_events WHERE run_id LIKE $1", [prefix + "%"]);
    await c.query("DELETE FROM engineering_run_stages WHERE run_id LIKE $1", [prefix + "%"]);
    await c.query("DELETE FROM engineering_runs WHERE id LIKE $1", [prefix + "%"]);
    await c.query("DELETE FROM execution_jobs WHERE id LIKE $1", [prefix + "%"]);
    await c.query("DELETE FROM execution_events WHERE job_id LIKE $1", [prefix + "%"]);
  } finally { await c.close(); }
}

interface InsertOpts {
  runId: string; eventType: string; payload: string | null;
  attempts?: number; claimedAt?: number | null; claimedBy?: string | null;
  claimExpiresAt?: number | null; nextAttemptAt?: number | null;
}
async function insertOutboxRow(pg: PgClient, o: InsertOpts): Promise<{ outboxId: string; eventId: string; }> {
  const jobId = o.runId + "__PLANNING";
  const outboxId = "outbox-" + jobId + "__" + o.eventType;
  const idemKey = jobId + "__" + o.eventType;
  const eventId = "eevt-" + jobId + "__" + o.eventType;
  const now = Date.now();
  await pg.query(
    "INSERT INTO engineering_run_event_outbox " +
    "(outbox_id, idempotency_key, event_id, job_id, run_id, stage_id, event_type, payload, created_at, attempts, claimed_at, claimed_by, claim_expires_at, next_attempt_at) " +
    "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
    [outboxId, idemKey, eventId, jobId, o.runId, jobId, o.eventType, o.payload, now,
     o.attempts ?? 0, o.claimedAt ?? null, o.claimedBy ?? null,
     o.claimExpiresAt ?? null, o.nextAttemptAt ?? null],
  );
  return { outboxId, eventId };
}

function gatedRunService(real: any) {
  let releaseFn: () => void = () => {};
  const gate = new Promise<void>((r) => { releaseFn = r; });
  const wrapper: any = {
    recordStageExecutionEventWithId: async (...args: any[]) => {
      await gate;
      return real.recordStageExecutionEventWithId(...args);
    },
  };
  return { service: wrapper, release: releaseFn };
}

// Phase 262A fix: wait for the kernel's eager startup drain (kernel.ts:610)
// to settle before the test inserts its own row. Without this, the startup
// drain can claim and deliver the test's row first, leaving the shutdown
// drain with no pending work and no outbox_drain_on_shutdown emit.
async function waitForStartupDrainToSettle(k: any, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (k.outboxDrainsInFlight && k.outboxDrainsInFlight.size > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function waitForAllClaimed(pg: PgClient, ids: string[], timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let lastCount = 0;
  while (Date.now() < deadline) {
    const res = await pg.query(
      "SELECT count(*)::int AS n FROM engineering_run_event_outbox WHERE outbox_id = ANY($1) AND claimed_by IS NOT NULL",
      [ids],
    );
    lastCount = res.rows[0].n;
    if (lastCount === ids.length) return lastCount;
    await new Promise((r) => setTimeout(r, 25));
  }
  return lastCount;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) { console.log("mode=shared db=unset -- DATABASE_URL required"); process.exit(1); }
  if (process.env.NEXUS_PERSISTENCE_MODE !== "shared") { console.log("mode=local -- NEXUS_PERSISTENCE_MODE=shared required"); process.exit(1); }

  const kernel = new NexusKernel();
  let store: any;
  let runService: any;

  await test("262.boot", "kernel boots in shared mode and wires drainer", async () => {
    await kernel.boot();
    store = (kernel as any).executionStore;
    const { EngineeringRunService } = await import("../src/core/engineering-run-service");
    const { EngineeringCapabilityRegistry } = await import("../src/core/engineering-capability-registry");
    const { EngineeringStageExecutor } = await import("../src/core/engineering-stage-executor");
    const registry = new EngineeringCapabilityRegistry(undefined, undefined, EngineeringStageExecutor.wiring());
    runService = new EngineeringRunService(url, store, registry);
    ok(!!store, "executionStore should be wired");
    ok(!!store.hasAsyncBackend(), "store must have an async (Postgres) backend");
    return "kernel.boot ok; store has async backend";
  });

  const pg = new PgClient(); await pg.connect(url);
  try {
    // 262A: barrier-gated
    {
      const runBase = PREFIX + "A";
      const rowCount = 5;
      const ids: string[] = [];
      for (let i = 0; i < rowCount; i++) {
        const { outboxId } = await insertOutboxRow(pg, {
          runId: `${runBase}-row-${i}`,
          eventType: "engineering_run.stage_blocked",
          payload: JSON.stringify({ case: "262A", i }),
        });
        ids.push(outboxId);
      }
      await test("262A", "two drainers partition 5 rows with batchSize=3 (barrier)", async () => {
        const gated = gatedRunService(runService);
        const t = Date.now();
        const d1 = new EngineeringRunEventDrainer(store, gated.service, { workerId: "262A-w1", batchSize: 3 });
        const d2 = new EngineeringRunEventDrainer(store, gated.service, { workerId: "262A-w2", batchSize: 3 });
        const drainPromise = Promise.all([d1.drain(t), d2.drain(t)]);
        const claimed = await waitForAllClaimed(pg, ids, 3000);
        ok(claimed === rowCount, `all rows must be claimed before release; got ${claimed}/${rowCount}`);
        const ownership = await pg.query(
          "SELECT outbox_id, claimed_by FROM engineering_run_event_outbox WHERE outbox_id = ANY($1)",
          [ids],
        );
        const byWorker: Record<string, string[]> = {};
        for (const r of ownership.rows) {
          const w = (r as any).claimed_by ?? "(none)";
          (byWorker[w] ??= []).push((r as any).outbox_id);
        }
        const workerIds = Object.keys(byWorker).filter((w) => w !== "(none)");
        ok(!byWorker["(none)"], "no row may be unclaimed during barrier window");
        ok(workerIds.length >= 2, `expected >= 2 distinct claiming workers, got ${workerIds.length}`);
        const union = new Set<string>();
        for (const w of workerIds) for (const id of byWorker[w]) union.add(id);
        ok(union.size === rowCount, `union of owners must cover all rows: got ${union.size}/${rowCount}`);
        gated.release();
        const [r1, r2] = await drainPromise;
        ok(r1.claimed + r2.claimed === rowCount, `total claimed should be ${rowCount}`);
        ok(r1.delivered + r2.delivered === rowCount, `total delivered should be ${rowCount}`);
        return `r1=${r1.claimed} r2=${r2.claimed}; workers=${workerIds.length}; disjoint=ok`;
      });
    }

    // 262B: barrier-gated
    {
      const runBase = PREFIX + "B";
      const rowCount = 10;
      const ids: string[] = [];
      for (let i = 0; i < rowCount; i++) {
        const { outboxId } = await insertOutboxRow(pg, {
          runId: `${runBase}-row-${i}`,
          eventType: "engineering_run.stage_blocked",
          payload: JSON.stringify({ case: "262B", i }),
        });
        ids.push(outboxId);
      }
      await test("262B", "three drainers partition 10 rows with batchSize=4 (barrier)", async () => {
        const gated = gatedRunService(runService);
        const t = Date.now();
        const ds = [
          new EngineeringRunEventDrainer(store, gated.service, { workerId: "262B-w1", batchSize: 4 }),
          new EngineeringRunEventDrainer(store, gated.service, { workerId: "262B-w2", batchSize: 4 }),
          new EngineeringRunEventDrainer(store, gated.service, { workerId: "262B-w3", batchSize: 4 }),
        ];
        const drainPromise = Promise.all(ds.map((d) => d.drain(t)));
        const claimed = await waitForAllClaimed(pg, ids, 3000);
        ok(claimed === rowCount, `all rows must be claimed before release; got ${claimed}/${rowCount}`);
        const ownership = await pg.query(
          "SELECT outbox_id, claimed_by FROM engineering_run_event_outbox WHERE outbox_id = ANY($1)",
          [ids],
        );
        const byWorker: Record<string, string[]> = {};
        for (const r of ownership.rows) {
          const w = (r as any).claimed_by ?? "(none)";
          (byWorker[w] ??= []).push((r as any).outbox_id);
        }
        const workerIds = Object.keys(byWorker).filter((w) => w !== "(none)");
        ok(!byWorker["(none)"], "no row may be unclaimed during barrier window");
        ok(workerIds.length === 3, `expected exactly 3 distinct claiming workers, got ${workerIds.length}`);
        const union = new Set<string>();
        for (const w of workerIds) for (const id of byWorker[w]) union.add(id);
        ok(union.size === rowCount, `union of owners must cover all rows: got ${union.size}/${rowCount}`);
        gated.release();
        const rs = await drainPromise;
        const totalDelivered = rs.reduce((n, r) => n + r.delivered, 0);
        ok(totalDelivered === rowCount, `total delivered should be ${rowCount}`);
        return `total=${rowCount} distribution=${rs.map((r) => r.claimed).join("/")}; workers=${workerIds.length}; disjoint=ok`;
      });
    }

    // 262C: active unexpired claim not stolen
    {
      const runId = PREFIX + "C";
      const t0 = Date.now();
      const { outboxId } = await insertOutboxRow(pg, {
        runId, eventType: "engineering_run.stage_blocked", payload: JSON.stringify({ case: "262C" }),
        claimedAt: t0 - 5_000, claimedBy: "ghost-worker", claimExpiresAt: t0 + 60_000,
      });
      const d = new EngineeringRunEventDrainer(store, runService, { workerId: "262C-fresh" });
      await test("262C", "active unexpired claim is not stolen", async () => {
        const r = await d.drain(t0);
        ok(r.claimed === 0, `expected claimed=0, got ${r.claimed}`);
        const row = (await pg.query(
          "SELECT claimed_by, delivered_at FROM engineering_run_event_outbox WHERE outbox_id = $1", [outboxId],
        )).rows[0];
        ok(row.claimed_by === "ghost-worker", `claimed_by should be ghost-worker, got ${row.claimed_by}`);
        ok(row.delivered_at === null, "delivered_at should remain null");
        return "ghost owner preserved";
      });
    }

    // 262D: expired claim is recovered
    {
      const runId = PREFIX + "D";
      const t0 = Date.now();
      const { outboxId } = await insertOutboxRow(pg, {
        runId, eventType: "engineering_run.stage_blocked", payload: JSON.stringify({ case: "262D" }),
        claimedAt: t0 - 120_000, claimedBy: "ghost-worker", claimExpiresAt: t0 - 60_000,
      });
      const d = new EngineeringRunEventDrainer(store, runService, { workerId: "262D-reclaimer" });
      await test("262D", "expired claim is recovered", async () => {
        const r = await d.drain(t0);
        ok(r.claimed === 1, `expected claimed=1, got ${r.claimed}`);
        ok(r.delivered === 1, `expected delivered=1, got ${r.delivered}`);
        const row = (await pg.query(
          "SELECT delivered_at FROM engineering_run_event_outbox WHERE outbox_id = $1", [outboxId],
        )).rows[0];
        ok(row.delivered_at !== null, "delivered_at should be set");
        return "expired claim reclaimed and delivered";
      });
    }

    // 262E: failed claim transaction surfaces cause
    {
      const runId = PREFIX + "E";
      await insertOutboxRow(pg, {
        runId, eventType: "engineering_run.stage_blocked", payload: JSON.stringify({ case: "262E" }),
      });
      await test("262E", "failed claim transaction surfaces cause", async () => {
        const injected = new Error("262E_injected_claim_failure");
        const fakeStore: any = {
          asyncDb: {
            prepareAsync: () => { throw injected; },
            execAsync: async () => {},
            transactionAsync: async (_fn: any) => { throw injected; },
          },
        };
        const d = new EngineeringRunEventDrainer(fakeStore, runService, { workerId: "262E-err" });
        let threw = false;
        let err: any = null;
        try { await d.drain(Date.now()); } catch (e) { threw = true; err = e; }
        ok(threw, "drain() must throw on claim transaction failure");
        ok(err instanceof OutboxClaimError, `expected OutboxClaimError, got ${err?.constructor?.name ?? typeof err}`);
        ok(err.cause === injected, "OutboxClaimError.cause must be the injected error");
        return "OutboxClaimError with cause preserved";
      });
    }

    // 262F: destination idempotency
    {
      const runBase = PREFIX + "A";
      const expectedEventIds: string[] = [];
      for (let i = 0; i < 5; i++) {
        const jobId = `${runBase}-row-${i}__PLANNING`;
        expectedEventIds.push("eevt-" + jobId + "__engineering_run.stage_blocked");
      }
      await test("262F", "every delivered event appears exactly once", async () => {
        const res = await pg.query(
          "SELECT event_id, count(*)::int AS n FROM engineering_run_events WHERE event_id = ANY($1) GROUP BY event_id",
          [expectedEventIds],
        );
        for (const row of res.rows) {
          ok((row as any).n === 1, `event_id ${(row as any).event_id} expected exactly once, got ${(row as any).n}`);
        }
        ok(res.rowCount === expectedEventIds.length, `expected ${expectedEventIds.length} distinct event_ids, got ${res.rowCount}`);
        return `${res.rowCount} events, no duplicates`;
      });
    }

    // 262G: repeat contention 5 times
    {
      let failures = 0;
      const trialNotes: string[] = [];
      for (let trial = 0; trial < 5; trial++) {
        const trialPrefix = PREFIX + "G" + trial + "-";
        const ids: string[] = [];
        for (let i = 0; i < 4; i++) {
          const { outboxId } = await insertOutboxRow(pg, {
            runId: `${trialPrefix}row-${i}`,
            eventType: "engineering_run.stage_blocked",
            payload: JSON.stringify({ trial, i }),
          });
          ids.push(outboxId);
        }
        const t = Date.now();
        const ds = [
          new EngineeringRunEventDrainer(store, runService, { workerId: `262G-${trial}-w1`, batchSize: 2 }),
          new EngineeringRunEventDrainer(store, runService, { workerId: `262G-${trial}-w2`, batchSize: 2 }),
        ];
        const rs = await Promise.all(ds.map((d) => d.drain(t)));
        const totalClaimed = rs.reduce((n, r) => n + r.claimed, 0);
        if (totalClaimed !== 4) failures++;
        trialNotes.push(`t${trial}=${totalClaimed}`);
        await pg.query("DELETE FROM engineering_run_event_outbox WHERE outbox_id = ANY($1)", [ids]);
      }
      await test("262G", "5 contention trials all partition correctly", async () => {
        ok(failures === 0, `expected 0 failing trials, got ${failures} (${trialNotes.join(" ")})`);
        return trialNotes.join(" ");
      });
    }

    // 262H: shutdown persists outbox_drain_on_shutdown; pool closed
    {
      await test("262H", "shutdown persists outbox_drain_on_shutdown; pool closed", async () => {
        const k = new NexusKernel();
        await k.boot();
        // Insert the row AFTER the eager startup drain has settled.
        // Otherwise the startup drain claims and delivers it first,
        // and the shutdown drain has no work to emit for.
        const runId = PREFIX + "H";
        await waitForStartupDrainToSettle(k);
        await insertOutboxRow(pg, {
          runId, eventType: "engineering_run.stage_blocked", payload: JSON.stringify({ case: "262H" }),
        });
        const kServices: any = (k as any).services;
        await k.shutdown({ finalRecoveryPass: false });
        ok(getPgClient() === null, "pgClient must be cleared after shutdown");
        const events = await kServices.events.list(500);
        const hit = events.find((e: any) => e.type === "outbox_drain_on_shutdown");
        ok(!!hit, "outbox_drain_on_shutdown must be persisted before shutdown returns");
        return "shutdown persisted outbox_drain_on_shutdown; pool closed";
      });
    }

    // 262I: drain failure logged; pool still closes; shutdown does not throw
    {
      const runId = PREFIX + "I";
      await insertOutboxRow(pg, {
        runId, eventType: "engineering_run.stage_blocked", payload: JSON.stringify({ case: "262I" }),
      });
      await test("262I", "shutdown drain failure logged; pool closed; no throw", async () => {
        const captured: string[] = [];
        const origError = console.error;
        console.error = (...args: any[]) => { captured.push(args.map(String).join(" ")); origError(...args); };
        try {
          const k = new NexusKernel();
          await k.boot();
          (k as any).engineeringOutboxDrainer = {
            drain: async () => { throw new Error("262I_injected_drain_failure"); },
          };
          let threw = false;
          try { await k.shutdown({ finalRecoveryPass: false }); } catch { threw = true; }
          ok(!threw, "shutdown must not throw when drain fails");
          ok(getPgClient() === null, "pgClient must be cleared after shutdown");
          const logged = captured.some((line) => line.indexOf("Shutdown drain failed") >= 0 && line.indexOf("262I_injected_drain_failure") >= 0);
          ok(logged, `console.error must record drain failure; captured: ${JSON.stringify(captured)}`);
          return "drain failure logged; pool closed; no throw";
        } finally {
          console.error = origError;
        }
      });
    }

    // 262J: emit failure logged; pool still closes
    {
      const runId = PREFIX + "J";
      const { outboxId } = await insertOutboxRow(pg, {
        runId, eventType: "engineering_run.stage_blocked", payload: JSON.stringify({ case: "262J" }),
        nextAttemptAt: Date.now() + 60_000,
      });
      await test("262J", "emit failure logged; pool closed", async () => {
        const captured: string[] = [];
        const origError = console.error;
        console.error = (...args: any[]) => { captured.push(args.map(String).join(" ")); origError(...args); };
        try {
          const k = new NexusKernel();
          await k.boot();
          await pg.query(
            "UPDATE engineering_run_event_outbox SET next_attempt_at = $1 WHERE outbox_id = $2",
            [Date.now() - 1, outboxId],
          );
          const kServices: any = (k as any).services;
          const origEmit = kServices.events.emit.bind(kServices.events);
          kServices.events.emit = async (input: any) => {
            if (input && input.type === "outbox_drain_on_shutdown") {
              throw new Error("262J_injected_emit_failure");
            }
            return origEmit(input);
          };
          let threw = false;
          try { await k.shutdown({ finalRecoveryPass: false }); } catch { threw = true; }
          ok(!threw, "shutdown must not throw when emit fails");
          ok(getPgClient() === null, "pgClient must be cleared");
          const logged = captured.some((line) => line.indexOf("Shutdown drain event persist failed") >= 0 && line.indexOf("262J_injected_emit_failure") >= 0);
          ok(logged, `console.error must record emit failure; captured: ${JSON.stringify(captured)}`);
          return "emit failure logged; pool closed";
        } finally {
          console.error = origError;
        }
      });
    }

    // 262K: resource cleanup completes even when emit fails
    {
      const runId = PREFIX + "K";
      await insertOutboxRow(pg, {
        runId, eventType: "engineering_run.stage_blocked", payload: JSON.stringify({ case: "262K" }),
      });
      await test("262K", "cleanup complete even when emit fails", async () => {
        const k = new NexusKernel();
        await k.boot();
        const kServices: any = (k as any).services;
        const origEmit = kServices.events.emit.bind(kServices.events);
        kServices.events.emit = async (input: any) => {
          if (input && input.type === "outbox_drain_on_shutdown") {
            throw new Error("262K_injected_emit_failure");
          }
          return origEmit(input);
        };
        await k.shutdown({ finalRecoveryPass: false });
        ok(getPgClient() === null, "pgClient must be cleared");
        ok((k as any).status !== "failed", `kernel status not 'failed', got ${(k as any).status}`);
        return "cleanup complete; pool closed; kernel not failed";
      });
    }

  } finally {
    await pgCleanup(PREFIX);
    await pg.close();
    try { await kernel.shutdown({ finalRecoveryPass: false }); } catch { /* best-effort */ }
  }

  const failed = rows.filter((r) => r.result === "FAIL" || r.result === "BLOCKED");
  console.log(`\n${rows.length} checks, ${failed.length} failed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
