// scripts/test-phase202c-concurrency.ts
// Phase 202 slice C: concurrency + idempotency at the runtime admission
// boundary. Exercises the real store, the real lease CAS, and the real
// admission decision against SQLite and, when DATABASE_URL is set,
// PostgreSQL.

import Database from "better-sqlite3";
import { join } from "path";
import { tmpdir } from "node:os";
import { unlinkSync } from "node:fs";
import { PgClient } from "../src/core/pg-client";
import { PgAsyncEngine } from "../src/core/pg-async-engine";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { MigrationRunner } from "../src/core/migration-runner";
import { bootstrapPgSchema } from "../src/core/pg-bootstrap";
import { StageExecutionStoreAdapter } from "../src/core/stage-execution-store-adapter";
import { createStageExecution, type StageExecution } from "../src/core/worker-stage-execution";
import { evaluateStageAdmission } from "../src/core/stage-admission";
import { LeaseManager } from "../src/core/lease-manager";

let pass = 0, fail = 0, blocked = 0;
function ok(n: string, c: boolean, d = "") {
  if (c) { pass++; console.log("[PASSED] " + n + (d ? "  " + d : "")); }
  else   { fail++; console.log("[FAILED] " + n + (d ? "  " + d : "")); }
}
function blk(n: string, w: string) { blocked++; console.log("[BLOCKED] " + n + "  " + w); }

const MIG_DIR = join(process.cwd(), "src", "db", "migrations");

function makeHarness() {
  const rawDb = new Database(":memory:");
  new MigrationRunner(rawDb, MIG_DIR).run();
  const syncEngine = SQLiteEngine.fromDatabase(rawDb);
  const store = new ExecutionStore(syncEngine as any);
  const adapter = new StageExecutionStoreAdapter(store);
  const leases = new LeaseManager(store);
  return { store, rawDb, adapter, leases };
}

async function seedStage(h: any, executionId: string, stageName: string): Promise<StageExecution> {
  return h.adapter.insertIfAbsent(createStageExecution({
    executionId, tenantId: "t1", correlationId: "c1", stageName,
    executor: "test", inputFingerprint: "fp", artifactReferences: [],
  }));
}

function setJobStatus(h: any, stageId: string, jobStatus: string) {
  h.rawDb.prepare("UPDATE execution_jobs SET status = ? WHERE id = ?").run(jobStatus, stageId);
}
async function main() {
  console.log("=== NEXUS PHASE 202C ===\n");

  // ---------- Sequential lease CAS tests (SQLite) ----------

  // S1 - two sequential acquireLease on the same stage job -> second throws
  {
    const h = makeHarness();
    const A = await seedStage(h, "ex_s1", "A");
    h.leases.acquireLease(A.stageExecutionId, "worker-1", 60_000);
    let secondFailed = false;
    try {
      h.leases.acquireLease(A.stageExecutionId, "worker-2", 60_000);
    } catch {
      secondFailed = true;
    }
    const active = h.store.getActiveLeaseForJob(A.stageExecutionId);
    ok("S1 lease CAS: second worker rejected", secondFailed === true);
    ok("S1 lease CAS: single ACTIVE lease", active?.workerId === "worker-1", `holder=${active?.workerId}`);
  }

  // S2 - admission on a stage whose dep is PENDING -> not eligible
  {
    const h = makeHarness();
    await seedStage(h, "ex_s2", "A");
    await seedStage(h, "ex_s2", "B");
    h.store.stageDeps.add({ executionId: "ex_s2", stageName: "B", dependsOnStage: "A" });
    const r = evaluateStageAdmission({ store: h.store, executionId: "ex_s2", stageName: "B" });
    ok("S2 unmet dep -> not eligible", r.eligible === false, `reason=${r.reason}`);
  }

  // S3 - dep succeeds -> admission eligible
  {
    const h = makeHarness();
    const A = await seedStage(h, "ex_s3", "A");
    await seedStage(h, "ex_s3", "B");
    setJobStatus(h, A.stageExecutionId, "SUCCEEDED");
    h.store.stageDeps.add({ executionId: "ex_s3", stageName: "B", dependsOnStage: "A" });
    const r = evaluateStageAdmission({ store: h.store, executionId: "ex_s3", stageName: "B" });
    ok("S3 satisfied dep -> eligible", r.eligible === true, `reason=${r.reason}`);
  }

  // S4 - two workers attempt combined admission+lease with unmet dep.
  {
    const h = makeHarness();
    await seedStage(h, "ex_s4", "A");
    const B = await seedStage(h, "ex_s4", "B");
    h.store.stageDeps.add({ executionId: "ex_s4", stageName: "B", dependsOnStage: "A" });

    const tryWorker = (wid: string) => {
      const a = evaluateStageAdmission({ store: h.store, executionId: "ex_s4", stageName: "B" });
      if (!a.eligible) return { admitted: false, leased: false };
      try {
        h.leases.acquireLease(B.stageExecutionId, wid, 60_000);
        return { admitted: true, leased: true };
      } catch {
        return { admitted: true, leased: false };
      }
    };

    const w1 = tryWorker("worker-1");
    const w2 = tryWorker("worker-2");
    ok("S4 unmet dep: worker-1 not admitted", w1.admitted === false);
    ok("S4 unmet dep: worker-2 not admitted", w2.admitted === false);
    const lease = h.store.getActiveLeaseForJob(B.stageExecutionId);
    ok("S4 unmet dep: zero leases acquired", lease === undefined);
  }

  // S5 - one worker, satisfied dep -> admission + lease succeed
  {
    const h = makeHarness();
    const A = await seedStage(h, "ex_s5", "A");
    const B = await seedStage(h, "ex_s5", "B");
    setJobStatus(h, A.stageExecutionId, "SUCCEEDED");
    h.store.stageDeps.add({ executionId: "ex_s5", stageName: "B", dependsOnStage: "A" });

    const a = evaluateStageAdmission({ store: h.store, executionId: "ex_s5", stageName: "B" });
    ok("S5 satisfied dep: admitted", a.eligible === true);
    h.leases.acquireLease(B.stageExecutionId, "worker-1", 60_000);
    const lease = h.store.getActiveLeaseForJob(B.stageExecutionId);
    ok("S5 satisfied dep: leased", lease?.workerId === "worker-1");
  }

  // S6 - two workers, satisfied dep, race for the same stage lease.
  {
    const h = makeHarness();
    const A = await seedStage(h, "ex_s6", "A");
    const B = await seedStage(h, "ex_s6", "B");
    setJobStatus(h, A.stageExecutionId, "SUCCEEDED");
    h.store.stageDeps.add({ executionId: "ex_s6", stageName: "B", dependsOnStage: "A" });

    const tryWorker = (wid: string) => {
      const a = evaluateStageAdmission({ store: h.store, executionId: "ex_s6", stageName: "B" });
      if (!a.eligible) return false;
      try { h.leases.acquireLease(B.stageExecutionId, wid, 60_000); return true; }
      catch { return false; }
    };
    const w1 = tryWorker("worker-1");
    const w2 = tryWorker("worker-2");
    ok("S6 race: exactly one worker leased", (w1 ? 1 : 0) + (w2 ? 1 : 0) === 1, `w1=${w1} w2=${w2}`);
    const lease = h.store.getActiveLeaseForJob(B.stageExecutionId);
    ok("S6 race: single ACTIVE lease", lease?.workerId === "worker-1", `holder=${lease?.workerId}`);
  }

  // S7 - 10 consecutive admissions, identical result, no side effects
  {
    const h = makeHarness();
    await seedStage(h, "ex_s7", "A");
    await seedStage(h, "ex_s7", "B");
    h.store.stageDeps.add({ executionId: "ex_s7", stageName: "B", dependsOnStage: "A" });

    const beforeCount = (h.rawDb.prepare("SELECT COUNT(*) AS c FROM execution_jobs").get() as any).c;
    const results: string[] = [];
    for (let i = 0; i < 10; i++) {
      const r = evaluateStageAdmission({ store: h.store, executionId: "ex_s7", stageName: "B" });
      results.push(String(r.reason));
    }
    const afterCount = (h.rawDb.prepare("SELECT COUNT(*) AS c FROM execution_jobs").get() as any).c;
    const allSame = results.every((x) => x === results[0]);
    ok("S7 idempotent: 10 evaluations identical", allSame, `first=${results[0]}`);
    ok("S7 idempotent: no job rows created", beforeCount === afterCount, `before=${beforeCount} after=${afterCount}`);
  }

  // S8 - dependency transitions between two reads
  {
    const h = makeHarness();
    const A = await seedStage(h, "ex_s8", "A");
    await seedStage(h, "ex_s8", "B");
    h.store.stageDeps.add({ executionId: "ex_s8", stageName: "B", dependsOnStage: "A" });

    const r1 = evaluateStageAdmission({ store: h.store, executionId: "ex_s8", stageName: "B" });
    setJobStatus(h, A.stageExecutionId, "SUCCEEDED");
    const r2 = evaluateStageAdmission({ store: h.store, executionId: "ex_s8", stageName: "B" });
    ok("S8 transition: pre-success blocked", r1.eligible === false);
    ok("S8 transition: post-success admitted", r2.eligible === true);
  }

  // S9 - close + reopen DB, admission outcome unchanged
  {
    const dir = tmpdir() + "/nexus-p202c-" + Date.now() + ".sqlite";
    for (const s of ["", "-wal", "-shm"]) { try { unlinkSync(dir + s); } catch {} }

    const rawDb = new Database(dir);
    new MigrationRunner(rawDb, MIG_DIR).run();
    const syncEngine = SQLiteEngine.fromDatabase(rawDb);
    const store = new ExecutionStore(syncEngine as any);
    const adapter = new StageExecutionStoreAdapter(store);
    const A = await adapter.insertIfAbsent(createStageExecution({
      executionId: "ex_s9", tenantId: "t1", correlationId: "c1", stageName: "A",
      executor: "test", inputFingerprint: "fp", artifactReferences: [],
    }));
    await adapter.insertIfAbsent(createStageExecution({
      executionId: "ex_s9", tenantId: "t1", correlationId: "c1", stageName: "B",
      executor: "test", inputFingerprint: "fp", artifactReferences: [],
    }));
    rawDb.prepare("UPDATE execution_jobs SET status = 'SUCCEEDED' WHERE id = ?").run(A.stageExecutionId);
    store.stageDeps.add({ executionId: "ex_s9", stageName: "B", dependsOnStage: "A" });
    const before = evaluateStageAdmission({ store, executionId: "ex_s9", stageName: "B" });
    rawDb.close();

    const rawDb2 = new Database(dir);
    const syncEngine2 = SQLiteEngine.fromDatabase(rawDb2);
    const store2 = new ExecutionStore(syncEngine2 as any);
    const after = evaluateStageAdmission({ store: store2, executionId: "ex_s9", stageName: "B" });
    ok("S9 restart: same admission",
       before.eligible === after.eligible && before.reason === after.reason,
       `before=${before.reason} after=${after.reason}`);
    rawDb2.close();
    for (const s of ["", "-wal", "-shm"]) { try { unlinkSync(dir + s); } catch {} }
  }

  // PostgreSQL concurrency (when DATABASE_URL is set).
  //
  // The sync adapter writes to in-memory SQLite only; PG-side rows must be
  // seeded explicitly via the async engine. Use payload::jsonb ->> 'key'
  // for JSON reads (json_extract is SQLite-only syntax).
  const url = process.env.DATABASE_URL;
  if (!url) {
    blk("PostgreSQL concurrent lease CAS", "DATABASE_URL not set");
  } else {
    try {
      const pg = new PgClient();
      await pg.connect(url);
      await bootstrapPgSchema(pg);
      const asyncDb = new PgAsyncEngine(pg);

      const mem = new Database(":memory:");
      new MigrationRunner(mem, MIG_DIR).run();
      const syncEngine = SQLiteEngine.fromDatabase(mem);
      const store = new ExecutionStore(syncEngine as any, asyncDb);

      const uniq = Date.now().toString(36);
      const execId = "pg_cas_ex_" + uniq;
      const aId = "pg_cas_a_" + uniq;
      const bId = "pg_cas_b_" + uniq;
      const now = Date.now();

      // Seed two stage jobs directly into Postgres via the async engine.
      await asyncDb.prepareAsync(
        "INSERT INTO execution_jobs (id, idempotency_key, job_type, payload, status, created_at, updated_at) " +
        "VALUES (?, ?, 'pipeline.stage', ?, 'QUEUED', ?, ?)"
      ).run(aId, "k_" + aId, JSON.stringify({
        kind: "pipeline.stage", executionId: execId, stageName: "A",
        tenantId: "t1", correlationId: "c1", attempt: 1, status: "PENDING",
        executor: "test", inputFingerprint: "fp", artifactReferences: [],
      }), now, now);
      await asyncDb.prepareAsync(
        "INSERT INTO execution_jobs (id, idempotency_key, job_type, payload, status, created_at, updated_at) " +
        "VALUES (?, ?, 'pipeline.stage', ?, 'QUEUED', ?, ?)"
      ).run(bId, "k_" + bId, JSON.stringify({
        kind: "pipeline.stage", executionId: execId, stageName: "B",
        tenantId: "t1", correlationId: "c1", attempt: 1, status: "PENDING",
        executor: "test", inputFingerprint: "fp", artifactReferences: [],
      }), now, now);

      // Confirm the row is queryable via PG JSON operators (this is what the
      // earlier json_extract call was trying to do).
      const readBack: any = await pg.query(
        "SELECT id FROM execution_jobs WHERE job_type = 'pipeline.stage' AND (payload::jsonb ->> 'executionId') = $1 AND (payload::jsonb ->> 'stageName') = 'A'",
        [execId],
      );
      const readBackRows = Array.isArray(readBack) ? readBack : (readBack?.rows ?? []);
      ok("PG JSON read: seeded stage A queryable", readBackRows[0]?.id === aId, `got=${readBackRows[0]?.id}`);

      // Concurrent lease CAS on the same job id (aId).
      const lA = {
        leaseId: "lease_pg_c1_" + uniq, jobId: aId, workerId: "pg-worker-1",
        acquiredAt: now, expiresAt: now + 60_000,
        renewedAt: now, releasedAt: null, status: "ACTIVE",
      };
      const lB = {
        leaseId: "lease_pg_c2_" + uniq, jobId: aId, workerId: "pg-worker-2",
        acquiredAt: now, expiresAt: now + 60_000,
        renewedAt: now, releasedAt: null, status: "ACTIVE",
      };
      const [rA, rB] = await Promise.all([
        store.acquireLeaseAsync(lA as any),
        store.acquireLeaseAsync(lB as any),
      ]);
      const winners = (rA.acquired ? 1 : 0) + (rB.acquired ? 1 : 0);
      ok("PG concurrent lease CAS: exactly one winner", winners === 1,
         `winners=${winners} rA=${rA.acquired} rB=${rB.acquired}`);

      // Verify durable state: exactly one ACTIVE lease for the job in PG.
      const activeRows: any = await pg.query(
        "SELECT COUNT(*)::int AS c FROM execution_leases WHERE job_id = $1 AND status = 'ACTIVE'",
        [aId],
      );
      const activeArr = Array.isArray(activeRows) ? activeRows : (activeRows?.rows ?? []);
      const activeCount = Number(activeArr[0]?.c ?? -1);
      ok("PG CAS: exactly one ACTIVE lease in DB", activeCount === 1, `count=${activeCount}`);

      try { await pg.close(); } catch {}
      try { mem.close(); } catch {}
    } catch (e: any) {
      blk("PostgreSQL concurrent lease CAS", String(e?.message ?? e));
    }
  }
  console.log(`\nPASS: ${pass}\nFAIL: ${fail}\nBLOCKED: ${blocked}`);
  process.exitCode = (fail > 0 || blocked > 0) ? 1 : 0;
}
main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exitCode = 2; });