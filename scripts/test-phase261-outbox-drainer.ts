// scripts/test-phase261-outbox-drainer.ts
// Phase 261 - transactional outbox drainer acceptance.
//
// Boots the real kernel (shared mode) so ExecutionStore, EngineeringRunService,
// and the drainer are constructed exactly as production does. Then:
//   1. Inserts an undelivered outbox row directly.
//   2. Asserts a drain() call delivers it to engineering_run_events.
//   3. Asserts a second drain() is a no-op (idempotent on event_id).
//   4. Asserts deleteEngineeringRunCascade removes the outbox row.

import { PgClient } from "../src/core/pg-client";
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

const PREFIX = `engrun-261-${Date.now()}-`;

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

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("mode=shared db=unset -- DATABASE_URL required for phase261 acceptance");
    process.exit(1);
  }
  if (process.env.NEXUS_PERSISTENCE_MODE !== "shared") {
    console.log("mode=local -- NEXUS_PERSISTENCE_MODE=shared required");
    process.exit(1);
  }

  const kernel = new NexusKernel();
  let drainer: any;
  let store: any;

  await test("261.boot", "kernel boots in shared mode and wires drainer", async () => {
    await kernel.boot();
    drainer = (kernel as any).engineeringOutboxDrainer;
    store = (kernel as any).executionStore;
    ok(!!drainer, "engineeringOutboxDrainer should be wired after boot");
    ok(!!store, "executionStore should be wired after boot");
    return "kernel.boot ok; drainer and store present";
  });

  const pg = new PgClient(); await pg.connect(url);
  try {
    const runId = PREFIX + "A";
    const jobId = runId + "__PLANNING";
    const eventType = "engineering_run.stage_blocked";
    const outboxId = "outbox-" + jobId + "__" + eventType;
    const idemKey = jobId + "__" + eventType;
    const eventId = "eevt-" + jobId + "__" + eventType;
    const now = Date.now();

    await pg.query(
      "INSERT INTO engineering_run_event_outbox " +
      "(outbox_id, idempotency_key, event_id, job_id, run_id, stage_id, event_type, payload, created_at, attempts) " +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0)",
      [outboxId, idemKey, eventId, jobId, runId, jobId, eventType,
       JSON.stringify({ reason: "PHASE261_TEST" }), now],
    );

    await test("261A", "drain delivers undelivered outbox row", async () => {
      const r = await drainer.drain(Date.now());
      ok(r.claimed >= 1, `expected claimed >= 1, got ${r.claimed}`);
      ok(r.delivered >= 1, `expected delivered >= 1, got ${r.delivered}`);
      const res = await pg.query(
        "SELECT delivered_at, attempts FROM engineering_run_event_outbox WHERE outbox_id = $1",
        [outboxId],
      );
      const row = res.rows[0];
      ok(row.delivered_at !== null, "delivered_at must be set after drain");
      return `delivered_at=${row.delivered_at} attempts=${row.attempts}`;
    });

    await test("261B", "redelivery is idempotent on event_id", async () => {
      const r = await drainer.drain(Date.now());
      ok(r.claimed === 0, `expected claimed=0 on second drain, got ${r.claimed}`);
      const res = await pg.query(
        "SELECT count(*)::int AS n FROM engineering_run_events WHERE event_id = $1",
        [eventId],
      );
      ok(res.rows[0].n === 1, `expected exactly 1 engineering_run_events row, got ${res.rows[0].n}`);
      return "no duplicate; claimed=0";
    });

    await test("261C", "deleteEngineeringRunCascade removes the outbox row", async () => {
      await store.deleteEngineeringRunCascade(runId);
      const res = await pg.query(
        "SELECT count(*)::int AS n FROM engineering_run_event_outbox WHERE run_id = $1 OR job_id LIKE $2",
        [runId, runId + "%"],
      );
      ok(res.rows[0].n === 0, `expected 0 rows after cascade, got ${res.rows[0].n}`);
      return "cascade removed 1 row";
    });
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
