// scripts/test-phase202e-admission-stress.ts
// Phase 202 slice E: admission evaluation under load.
// Tests timing + correctness on large DAGs. Runs on SQLite (in-process);
// PostgreSQL stress is opt-in via STRESS_PG=1.

import Database from "better-sqlite3";
import { join } from "path";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { MigrationRunner } from "../src/core/migration-runner";
import { StageExecutionStoreAdapter } from "../src/core/stage-execution-store-adapter";
import { createStageExecution } from "../src/core/worker-stage-execution";
import { evaluateStageAdmission, evaluateStageAdmissionAsync } from "../src/core/stage-admission";
import { PgClient } from "../src/core/pg-client";
import { PgAsyncEngine } from "../src/core/pg-async-engine";
import { bootstrapPgSchema } from "../src/core/pg-bootstrap";

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
  return { store, rawDb, adapter };
}

async function seedStage(h: any, executionId: string, stageName: string) {
  return h.adapter.insertIfAbsent(createStageExecution({
    executionId, tenantId: "t1", correlationId: "c1", stageName,
    executor: "test", inputFingerprint: "fp", artifactReferences: [],
  }));
}

function setJobStatus(h: any, stageId: string, status: string) {
  h.rawDb.prepare("UPDATE execution_jobs SET status = ? WHERE id = ?").run(status, stageId);
}

async function main() {
  console.log("=== NEXUS PHASE 202E ===\n");

  // S1 - linear chain 100 stages: evaluate admission of the last stage.
  {
    const h = makeHarness();
    const execId = "stress_linear_100";
    const N = 100;
    const stages: any[] = [];
    for (let i = 0; i < N; i++) {
      stages.push(await seedStage(h, execId, "s" + i));
    }
    // All except last are SUCCEEDED; last is QUEUED
    for (let i = 0; i < N - 1; i++) setJobStatus(h, stages[i].stageExecutionId, "SUCCEEDED");
    for (let i = 1; i < N; i++) h.store.stageDeps.add({ executionId: execId, stageName: "s" + i, dependsOnStage: "s" + (i - 1) });

    const t0 = Date.now();
    const r = evaluateStageAdmission({ store: h.store, executionId: execId, stageName: "s" + (N - 1) });
    const dt = Date.now() - t0;

    ok("S1 linear-100 eligible when all deps succeeded", r.eligible === true, `reason=${r.reason} dt=${dt}ms`);
    ok("S1 linear-100 evaluation < 500ms", dt < 500, `dt=${dt}ms`);
  }

  // S2 - wide DAG: 1 root, 50 independent children, 1 leaf
  {
    const h = makeHarness();
    const execId = "stress_wide_50";
    const root = await seedStage(h, execId, "root");
    const children: any[] = [];
    for (let i = 0; i < 50; i++) children.push(await seedStage(h, execId, "c" + i));
    const leaf = await seedStage(h, execId, "leaf");
    for (let i = 0; i < 50; i++) {
      h.store.stageDeps.add({ executionId: execId, stageName: "c" + i, dependsOnStage: "root" });
      h.store.stageDeps.add({ executionId: execId, stageName: "leaf", dependsOnStage: "c" + i });
    }
    setJobStatus(h, root.stageExecutionId, "SUCCEEDED");

    // Every child eligible; leaf blocked
    const c0 = evaluateStageAdmission({ store: h.store, executionId: execId, stageName: "c0" });
    const c49 = evaluateStageAdmission({ store: h.store, executionId: execId, stageName: "c49" });
    const lf = evaluateStageAdmission({ store: h.store, executionId: execId, stageName: "leaf" });

    ok("S2 wide-50: c0 eligible", c0.eligible === true);
    ok("S2 wide-50: c49 eligible", c49.eligible === true);
    ok("S2 wide-50: leaf blocked on 50 pending children", lf.eligible === false && lf.reason === "DEPENDENCY_NOT_SUCCEEDED");

    // Promote all children; leaf becomes eligible
    for (const c of children) setJobStatus(h, c.stageExecutionId, "SUCCEEDED");
    const lf2 = evaluateStageAdmission({ store: h.store, executionId: execId, stageName: "leaf" });
    ok("S2 wide-50: leaf eligible after all children succeeded", lf2.eligible === true, `reason=${lf2.reason}`);
  }

  // S3 - repeated evaluation timing: 1000 evaluations on a 100-stage chain
  {
    const h = makeHarness();
    const execId = "stress_repeat";
    const N = 100;
    const stages: any[] = [];
    for (let i = 0; i < N; i++) stages.push(await seedStage(h, execId, "r" + i));
    for (let i = 0; i < N - 1; i++) setJobStatus(h, stages[i].stageExecutionId, "SUCCEEDED");
    for (let i = 1; i < N; i++) h.store.stageDeps.add({ executionId: execId, stageName: "r" + i, dependsOnStage: "r" + (i - 1) });

    const t0 = Date.now();
    let lastReason = "";
    for (let k = 0; k < 1000; k++) {
      const r = evaluateStageAdmission({ store: h.store, executionId: execId, stageName: "r" + (N - 1) });
      lastReason = String(r.reason);
    }
    const dt = Date.now() - t0;
    ok("S3 1000 evaluations on 100-stage chain all eligible", lastReason === "ELIGIBLE", `last=${lastReason}`);
    ok("S3 1000 evaluations < 5000ms", dt < 5000, `dt=${dt}ms avg=${(dt/1000).toFixed(2)}ms`);
  }

  // S4 - PostgreSQL 50-stage chain admission via shared-mode async path.
  const url = process.env.DATABASE_URL;
  if (!url) {
    blk("PostgreSQL admission stress", "DATABASE_URL not set");
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
      const execId = "pg_stress_" + uniq;
      const N = 50;
      const now = Date.now();

      // Seed execution + N stages in PG
      await asyncDb.prepareAsync(
        "INSERT INTO execution_jobs (id, idempotency_key, job_type, payload, status, created_at, updated_at) " +
        "VALUES (?, ?, 'pipeline', '{}', 'RUNNING', ?, ?)"
      ).run(execId, "k_" + execId, now, now);

      for (let i = 0; i < N; i++) {
        const sid = execId + "_s" + i;
        const status = i < N - 1 ? "SUCCEEDED" : "QUEUED";
        const payload = JSON.stringify({
          kind: "pipeline.stage", executionId: execId, stageName: "s" + i,
          tenantId: "t1", correlationId: "c1", attempt: 1,
          status: status === "SUCCEEDED" ? "SUCCEEDED" : "PENDING",
          executor: "test", inputFingerprint: "fp", artifactReferences: [],
        });
        await asyncDb.prepareAsync(
          "INSERT INTO execution_jobs (id, idempotency_key, job_type, payload, status, created_at, updated_at) " +
          "VALUES (?, ?, 'pipeline.stage', ?, ?, ?, ?)"
        ).run(sid, "k_" + sid, payload, status, now, now);
      }
      for (let i = 1; i < N; i++) {
        await store.stageDepsAsync!.add({ executionId: execId, stageName: "s" + i, dependsOnStage: "s" + (i - 1) });
      }

      const t0 = Date.now();
      const r = await evaluateStageAdmissionAsync({ store, executionId: execId, stageName: "s" + (N - 1) });
      const dt = Date.now() - t0;

      ok("S4 PG 50-chain admission: eligible", r.eligible === true, `reason=${r.reason} dt=${dt}ms`);
      ok("S4 PG 50-chain admission < 1000ms", dt < 1000, `dt=${dt}ms`);

      try { await pg.close(); } catch {}
      try { mem.close(); } catch {}
    } catch (e: any) {
      blk("PostgreSQL admission stress", String(e?.message ?? e));
    }
  }

  console.log(`\nPASS: ${pass}\nFAIL: ${fail}\nBLOCKED: ${blocked}`);
  process.exitCode = (fail > 0 || blocked > 0) ? 1 : 0;
}
main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exitCode = 2; });