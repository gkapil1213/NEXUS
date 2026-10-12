// scripts/test-phase261-outbox-drainer.ts
// Phase 261 - transactional outbox drainer acceptance.
//
// Phase 261A additions (D-J):
//   D. Transient failure -> retry succeeds.
//   E. Retry exhaustion -> permanently_failed.
//   F. Concurrent drainers claim at most one row total.
//   G. Expired claim is recoverable.
//   H. Malformed payload is not delivered; row is permanently failed.
//   I. Claim error surfaces (does not become an empty success report).
//   J. Fence miss on ack update is counted as lostClaims, not delivered.

import { PgClient } from "../src/core/pg-client";
import { NexusKernel } from "../src/core/kernel";
import { EngineeringRunEventDrainer } from "../src/core/engineering-run-event-drainer";

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

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) { console.log("mode=shared db=unset"); process.exit(1); }
  if (process.env.NEXUS_PERSISTENCE_MODE !== "shared") { console.log("mode=local"); process.exit(1); }

  const kernel = new NexusKernel();
  let drainer: EngineeringRunEventDrainer;
  let runService: any;
  let store: any;

  await test("261.boot", "kernel boots in shared mode and wires drainer", async () => {
    await kernel.boot();
    drainer = (kernel as any).engineeringOutboxDrainer;
    store = (kernel as any).executionStore;
    ok(!!drainer, "engineeringOutboxDrainer should be wired after boot");
    ok(!!store, "executionStore should be wired after boot");
    const { EngineeringRunService } = await import("../src/core/engineering-run-service");
    const { EngineeringCapabilityRegistry } = await import("../src/core/engineering-capability-registry");
    const { EngineeringStageExecutor } = await import("../src/core/engineering-stage-executor");
    const registry = new EngineeringCapabilityRegistry(undefined, undefined, EngineeringStageExecutor.wiring());
    runService = new EngineeringRunService(url, store, registry);
    return "kernel.boot ok; drainer and store present";
  });

  const pg = new PgClient(); await pg.connect(url);
  try {
    // ---- 261A/B/C baseline ----
    {
      const runId = PREFIX + "A";
      const { outboxId, eventId } = await insertOutboxRow(pg, {
        runId, eventType: "engineering_run.stage_blocked",
        payload: JSON.stringify({ reason: "PHASE261_TEST" }),
      });

      await test("261A", "drain delivers undelivered outbox row", async () => {
        const r = await drainer.drain(Date.now());
        ok(r.claimed >= 1, `expected claimed >= 1, got ${r.claimed}`);
        ok(r.delivered >= 1, `expected delivered >= 1, got ${r.delivered}`);
        const res = await pg.query("SELECT delivered_at FROM engineering_run_event_outbox WHERE outbox_id = $1", [outboxId]);
        ok(res.rows[0].delivered_at !== null, "delivered_at must be set");
        return `delivered_at=${res.rows[0].delivered_at}`;
      });

      await test("261B", "redelivery is idempotent on event_id", async () => {
        const r = await drainer.drain(Date.now());
        ok(r.claimed === 0, `expected claimed=0, got ${r.claimed}`);
        const res = await pg.query("SELECT count(*)::int AS n FROM engineering_run_events WHERE event_id = $1", [eventId]);
        ok(res.rows[0].n === 1, `expected 1 event row, got ${res.rows[0].n}`);
        return "no duplicate; claimed=0";
      });

      await test("261C", "deleteEngineeringRunCascade removes the outbox row", async () => {
        await store.deleteEngineeringRunCascade(runId);
        const res = await pg.query("SELECT count(*)::int AS n FROM engineering_run_event_outbox WHERE run_id = $1 OR job_id LIKE $2", [runId, runId + "%"]);
        ok(res.rows[0].n === 0, `expected 0 rows, got ${res.rows[0].n}`);
        return "cascade removed 1 row";
      });
    }

    // ---- 261D transient failure -> retry succeeds ----
    {
      const runId = PREFIX + "D";
      const { outboxId } = await insertOutboxRow(pg, { runId, eventType: "engineering_run.stage_blocked", payload: JSON.stringify({ case: "D" }) });
      const t0 = Date.now();
      let calls = 0;
      const orig = runService.recordStageExecutionEventWithId.bind(runService);
      const stub = { recordStageExecutionEventWithId: async (...args: any[]) => {
        calls++; if (calls === 1) throw new Error("TRANSIENT_FAKE"); return orig(...args);
      } };
      const d = new EngineeringRunEventDrainer(store, stub as any);

      await test("261D", "transient failure -> retry succeeds", async () => {
        const r1 = await d.drain(t0);
        ok(r1.retried === 1, `r1.retried expected 1, got ${r1.retried}`);
        const row1 = (await pg.query("SELECT attempts, delivered_at, next_attempt_at FROM engineering_run_event_outbox WHERE outbox_id = $1", [outboxId])).rows[0];
        ok(row1.attempts === 1, `attempts expected 1, got ${row1.attempts}`);
        ok(row1.delivered_at === null, "delivered_at should be null after failure");
        const r2 = await d.drain(row1.next_attempt_at + 1);
        ok(r2.delivered === 1, `r2.delivered expected 1, got ${r2.delivered}`);
        return `retry succeeded after ${calls} calls`;
      });
    }

    // ---- 261E retry exhaustion ----
    {
      const runId = PREFIX + "E";
      const { outboxId } = await insertOutboxRow(pg, { runId, eventType: "engineering_run.stage_blocked", payload: JSON.stringify({ case: "E" }) });
      const always = new EngineeringRunEventDrainer(store, { recordStageExecutionEventWithId: async () => { throw new Error("ALWAYS_FAIL"); } } as any);

      await test("261E", "retry exhaustion -> permanently_failed", async () => {
        let t = Date.now();
        for (let i = 0; i < 5; i++) {
          await always.drain(t);
          const row = (await pg.query("SELECT next_attempt_at FROM engineering_run_event_outbox WHERE outbox_id = $1", [outboxId])).rows[0];
          t = (row.next_attempt_at ?? t + 300_000) + 1;
        }
        const row = (await pg.query("SELECT attempts, permanently_failed_at FROM engineering_run_event_outbox WHERE outbox_id = $1", [outboxId])).rows[0];
        ok(row.permanently_failed_at !== null, "permanently_failed_at should be set");
        ok(row.attempts === 5, `attempts expected 5, got ${row.attempts}`);
        const r6 = await always.drain(t + 1_000_000);
        ok(r6.claimed === 0, `expected claimed=0 after terminal, got ${r6.claimed}`);
        return `terminal after ${row.attempts} attempts`;
      });
    }

    // ---- 261F concurrent drainers ----
    {
      const runId = PREFIX + "F";
      await insertOutboxRow(pg, { runId, eventType: "engineering_run.stage_blocked", payload: JSON.stringify({ case: "F" }) });
      const d1 = new EngineeringRunEventDrainer(store, runService, { workerId: "worker-1" });
      const d2 = new EngineeringRunEventDrainer(store, runService, { workerId: "worker-2" });

      await test("261F", "concurrent drainers claim at most one row total", async () => {
        const t = Date.now();
        const [r1, r2] = await Promise.all([d1.drain(t), d2.drain(t)]);
        const total = r1.claimed + r2.claimed;
        ok(total <= 1, `expected <=1 total claimed, got ${total} (r1=${r1.claimed} r2=${r2.claimed})`);
        return `r1=${r1.claimed} r2=${r2.claimed}`;
      });
    }

    // ---- 261G expired claim recoverable ----
    {
      const runId = PREFIX + "G";
      const t0 = Date.now();
      const { outboxId } = await insertOutboxRow(pg, {
        runId, eventType: "engineering_run.stage_blocked", payload: JSON.stringify({ case: "G" }),
        claimedAt: t0 - 120_000, claimedBy: "ghost", claimExpiresAt: t0 - 60_000,
      });
      const d = new EngineeringRunEventDrainer(store, runService, { workerId: "reclaimer" });

      await test("261G", "expired claim is recoverable", async () => {
        const r = await d.drain(t0);
        ok(r.claimed === 1, `expected claimed=1, got ${r.claimed}`);
        ok(r.delivered === 1, `expected delivered=1, got ${r.delivered}`);
        const row = (await pg.query("SELECT delivered_at FROM engineering_run_event_outbox WHERE outbox_id = $1", [outboxId])).rows[0];
        ok(row.delivered_at !== null, "delivered_at should be set");
        return "expired claim reclaimed";
      });
    }

    // ---- 261H malformed payload ----
    {
      const runId = PREFIX + "H";
      const { outboxId, eventId } = await insertOutboxRow(pg, { runId, eventType: "engineering_run.stage_blocked", payload: "{invalid json" });
      const d = new EngineeringRunEventDrainer(store, runService, { workerId: "malformed" });

      await test("261H", "malformed payload is not delivered", async () => {
        const r = await d.drain(Date.now());
        ok(r.delivered === 0, `delivered expected 0, got ${r.delivered}`);
        const row = (await pg.query("SELECT payload, permanently_failed_at, last_error, delivered_at FROM engineering_run_event_outbox WHERE outbox_id = $1", [outboxId])).rows[0];
        ok(row.payload === "{invalid json", `payload must be preserved, got ${JSON.stringify(row.payload)}`);
        ok(row.permanently_failed_at !== null, "permanently_failed_at should be set");
        ok(typeof row.last_error === "string" && row.last_error.indexOf("MALFORMED_PAYLOAD") === 0, `last_error should start with MALFORMED_PAYLOAD, got ${row.last_error}`);
        ok(row.delivered_at === null, "delivered_at must remain null");
        const evt = (await pg.query("SELECT count(*)::int AS n FROM engineering_run_events WHERE event_id = $1", [eventId])).rows[0];
        ok(evt.n === 0, `no engineering_run_events row should exist, got ${evt.n}`);
        return "payload preserved; permanently_failed";
      });
    }

    // ---- 261I claim error surfaces ----
    {
      const runId = PREFIX + "I";
      await insertOutboxRow(pg, { runId, eventType: "engineering_run.stage_blocked", payload: JSON.stringify({ case: "I" }) });

      await test("261I", "claim error surfaces (does not become empty success)", async () => {
        const real = store.asyncDb;
        const fakeStore: any = {
          asyncDb: {
            transactionAsync: async (fn: (tx: any) => Promise<any>) =>
              fn({
                prepareAsync: (sql: string) => {
                  if (/SELECT\s+outbox_id[\s\S]+FROM engineering_run_event_outbox/i.test(sql)) {
                    return {
                      all: async () => { throw new Error("pg_boom_claim"); },
                      run: async () => { throw new Error("pg_boom_claim"); },
                      get: async () => { throw new Error("pg_boom_claim"); },
                    };
                  }
                  return real.prepareAsync(sql);
                },
              }),
          },
        };
        const d = new EngineeringRunEventDrainer(fakeStore, runService, { workerId: "err-claim" });
        let threw = false, msg = "";
        try { await d.drain(Date.now()); } catch (e) { threw = true; msg = e instanceof Error ? e.message : String(e); }
        ok(threw, "drain() must throw when the claim query fails");
        ok(msg.indexOf("pg_boom_claim") >= 0, `thrown message must include cause, got ${JSON.stringify(msg)}`);
        return `threw: ${msg.slice(0, 80)}`;
      });

      // Test I simulates a failed claim query. Remove its pending row so
      // test J measures only the row it intentionally inserted.
      await pg.query("DELETE FROM engineering_run_event_outbox WHERE run_id = $1", [runId]);
    }

    // ---- 261J fence miss on ack ----
    {
      const runId = PREFIX + "J";
      const { outboxId } = await insertOutboxRow(pg, { runId, eventType: "engineering_run.stage_blocked", payload: JSON.stringify({ case: "J" }) });
      const d = new EngineeringRunEventDrainer(store, runService, { workerId: "loser" });

      await test("261J", "fence miss on ack is lostClaims, not delivered", async () => {
        const real = store.asyncDb;
        const orig = real.prepareAsync.bind(real);
        (real as any).prepareAsync = (sql: string) => {
          if (/SET delivered_at = \?/.test(sql) && /AND claimed_by = \?/.test(sql)) {
            const stmt = orig(sql);
            return {
              run: async (...params: unknown[]) => {
                const p = params.slice();
                p[p.length - 1] = "some-other-worker";
                return stmt.run(...p);
              },
              all: stmt.all.bind(stmt), get: stmt.get.bind(stmt),
            };
          }
          return orig(sql);
        };
        try {
          const r = await d.drain(Date.now());
          ok(r.delivered === 0, `delivered should be 0, got ${r.delivered}`);
          const lost = (r as any).lostClaims ?? 0;
          ok(lost === 1, `lostClaims should be 1, got ${lost}`);
          const row = (await pg.query("SELECT delivered_at FROM engineering_run_event_outbox WHERE outbox_id = $1", [outboxId])).rows[0];
          ok(row.delivered_at === null, "delivered_at must remain null");
          return `lostClaims=${lost}`;
        } finally {
          (real as any).prepareAsync = orig;
        }
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