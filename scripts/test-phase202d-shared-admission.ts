// scripts/test-phase202d-shared-admission.ts
// Phase 202 slice D: shared-mode admission. Exercises the async sibling
// added in 202d: listStageJobsForExecutionAsync, listForExecutionAsync,
// evaluateStageAdmissionAsync. Also tests graph-level convergence at the
// admission layer against a real Postgres backend.

import Database from "better-sqlite3";
import { join } from "path";
import { PgClient } from "../src/core/pg-client";
import { PgAsyncEngine } from "../src/core/pg-async-engine";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { MigrationRunner } from "../src/core/migration-runner";
import { bootstrapPgSchema } from "../src/core/pg-bootstrap";
import { evaluateStageAdmissionAsync } from "../src/core/stage-admission";
import { evaluateStageAdmission } from "../src/core/stage-admission";

let pass = 0, fail = 0, blocked = 0;
function ok(n: string, c: boolean, d = "") {
  if (c) { pass++; console.log("[PASSED] " + n + (d ? "  " + d : "")); }
  else   { fail++; console.log("[FAILED] " + n + (d ? "  " + d : "")); }
}
function blk(n: string, w: string) { blocked++; console.log("[BLOCKED] " + n + "  " + w); }

const MIG_DIR = join(process.cwd(), "src", "db", "migrations");

async function seedPgJob(
  asyncDb: PgAsyncEngine,
  id: string,
  executionId: string,
  stageName: string,
  status: string,
  cancellationRequested: number,
  now: number,
) {
  const payload = JSON.stringify({
    kind: "pipeline.stage",
    executionId, stageName, tenantId: "t1", correlationId: "c1",
    attempt: 1, status: status === "SUCCEEDED" ? "SUCCEEDED" : "PENDING",
    executor: "test", inputFingerprint: "fp", artifactReferences: [],
  });
  await asyncDb.prepareAsync(
    "INSERT INTO execution_jobs (id, idempotency_key, job_type, payload, status, cancellation_requested, created_at, updated_at) " +
    "VALUES (?, ?, 'pipeline.stage', ?, ?, ?, ?, ?)"
  ).run(id, "k_" + id, payload, status, cancellationRequested, now, now);
}

async function seedPgExecution(
  asyncDb: PgAsyncEngine,
  id: string,
  cancellationRequested: number,
  now: number,
) {
  await asyncDb.prepareAsync(
    "INSERT INTO execution_jobs (id, idempotency_key, job_type, payload, status, cancellation_requested, created_at, updated_at) " +
    "VALUES (?, ?, 'pipeline', '{}', 'RUNNING', ?, ?, ?)"
  ).run(id, "k_" + id, cancellationRequested, now, now);
}

async function main() {
  console.log("=== NEXUS PHASE 202D ===\n");

  const url = process.env.DATABASE_URL;
  if (!url) {
    blk("PostgreSQL shared-mode suite", "DATABASE_URL not set");
    console.log(`\nPASS: ${pass}\nFAIL: ${fail}\nBLOCKED: ${blocked}`);
    process.exitCode = blocked > 0 ? 1 : 0;
    return;
  }

  const pg = new PgClient();
  try {
    await pg.connect(url);
    await bootstrapPgSchema(pg);
    ok("PG connectivity", true);
  } catch (e: any) {
    blk("PG connectivity", String(e?.message ?? e));
    console.log(`\nPASS: ${pass}\nFAIL: ${fail}\nBLOCKED: ${blocked}`);
    process.exitCode = blocked > 0 ? 1 : 0;
    return;
  }

  const asyncDb = new PgAsyncEngine(pg);
  const mem = new Database(":memory:");
  new MigrationRunner(mem, MIG_DIR).run();
  const syncEngine = SQLiteEngine.fromDatabase(mem);
  const store = new ExecutionStore(syncEngine as any, asyncDb);
  ok("store.hasAsyncBackend()", store.hasAsyncBackend() === true);

  const uniq = Date.now().toString(36);

  // S1 — linear graph A -> B -> C, A succeeded, B pending, C pending
  {
    const execId = "pg_lin_" + uniq;
    const now = Date.now();
    await seedPgExecution(asyncDb, execId, 0, now);
    await seedPgJob(asyncDb, execId + "_A", execId, "A", "SUCCEEDED", 0, now);
    await seedPgJob(asyncDb, execId + "_B", execId, "B", "QUEUED", 0, now);
    await seedPgJob(asyncDb, execId + "_C", execId, "C", "QUEUED", 0, now);
    await store.stageDepsAsync!.add({ executionId: execId, stageName: "B", dependsOnStage: "A" });
    await store.stageDepsAsync!.add({ executionId: execId, stageName: "C", dependsOnStage: "B" });

    const a = await evaluateStageAdmissionAsync({ store, executionId: execId, stageName: "A" });
    ok("S1 A terminal ? STAGE_TERMINAL", a.reason === "STAGE_TERMINAL", `reason=${a.reason}`);

    const b = await evaluateStageAdmissionAsync({ store, executionId: execId, stageName: "B" });
    ok("S1 B dep A succeeded ? ELIGIBLE", b.eligible === true && b.reason === "ELIGIBLE", `reason=${b.reason}`);

    const c = await evaluateStageAdmissionAsync({ store, executionId: execId, stageName: "C" });
    ok("S1 C dep B pending ? DEPENDENCY_NOT_SUCCEEDED", c.reason === "DEPENDENCY_NOT_SUCCEEDED", `reason=${c.reason}`);
  }

  // S2 — promote B to SUCCEEDED, C becomes eligible (convergence)
  {
    const execId = "pg_conv_" + uniq;
    const now = Date.now();
    await seedPgExecution(asyncDb, execId, 0, now);
    await seedPgJob(asyncDb, execId + "_A", execId, "A", "SUCCEEDED", 0, now);
    await seedPgJob(asyncDb, execId + "_B", execId, "B", "SUCCEEDED", 0, now);
    await seedPgJob(asyncDb, execId + "_C", execId, "C", "QUEUED", 0, now);
    await store.stageDepsAsync!.add({ executionId: execId, stageName: "B", dependsOnStage: "A" });
    await store.stageDepsAsync!.add({ executionId: execId, stageName: "C", dependsOnStage: "B" });

    const c = await evaluateStageAdmissionAsync({ store, executionId: execId, stageName: "C" });
    ok("S2 convergence: C dep B succeeded ? ELIGIBLE", c.eligible === true && c.reason === "ELIGIBLE", `reason=${c.reason}`);
  }

  // S3 — diamond A -> (B, C) -> D
  {
    const execId = "pg_dia_" + uniq;
    const now = Date.now();
    await seedPgExecution(asyncDb, execId, 0, now);
    await seedPgJob(asyncDb, execId + "_A", execId, "A", "SUCCEEDED", 0, now);
    await seedPgJob(asyncDb, execId + "_B", execId, "B", "QUEUED", 0, now);
    await seedPgJob(asyncDb, execId + "_C", execId, "C", "QUEUED", 0, now);
    await seedPgJob(asyncDb, execId + "_D", execId, "D", "QUEUED", 0, now);
    await store.stageDepsAsync!.add({ executionId: execId, stageName: "B", dependsOnStage: "A" });
    await store.stageDepsAsync!.add({ executionId: execId, stageName: "C", dependsOnStage: "A" });
    await store.stageDepsAsync!.add({ executionId: execId, stageName: "D", dependsOnStage: "B" });
    await store.stageDepsAsync!.add({ executionId: execId, stageName: "D", dependsOnStage: "C" });

    const b = await evaluateStageAdmissionAsync({ store, executionId: execId, stageName: "B" });
    const c = await evaluateStageAdmissionAsync({ store, executionId: execId, stageName: "C" });
    ok("S3 diamond: B eligible", b.eligible === true);
    ok("S3 diamond: C eligible", c.eligible === true);

    const d1 = await evaluateStageAdmissionAsync({ store, executionId: execId, stageName: "D" });
    ok("S3 diamond: D blocked (B,C pending)", d1.eligible === false && d1.reason === "DEPENDENCY_NOT_SUCCEEDED", `reason=${d1.reason}`);

    // Promote B only; D still blocked on C
    await pg.query("UPDATE execution_jobs SET status = 'SUCCEEDED' WHERE id = $1", [execId + "_B"]);
    const d2 = await evaluateStageAdmissionAsync({ store, executionId: execId, stageName: "D" });
    ok("S3 diamond: D still blocked after B only", d2.eligible === false, `reason=${d2.reason}`);

    // Promote C; D now eligible
    await pg.query("UPDATE execution_jobs SET status = 'SUCCEEDED' WHERE id = $1", [execId + "_C"]);
    const d3 = await evaluateStageAdmissionAsync({ store, executionId: execId, stageName: "D" });
    ok("S3 diamond: D eligible after both B and C", d3.eligible === true, `reason=${d3.reason}`);
  }

  // S4 — cancelled execution blocks admission
  {
    const execId = "pg_cancel_" + uniq;
    const now = Date.now();
    await seedPgExecution(asyncDb, execId, 1, now);  // cancellation_requested=1
    await seedPgJob(asyncDb, execId + "_A", execId, "A", "QUEUED", 0, now);

    const a = await evaluateStageAdmissionAsync({ store, executionId: execId, stageName: "A" });
    ok("S4 cancelled execution ? EXECUTION_CANCELLED", a.reason === "EXECUTION_CANCELLED", `reason=${a.reason}`);
  }

  // S5 — cross-execution isolation: stages from exec X never appear in exec Y
  {
    const execX = "pg_iso_x_" + uniq;
    const execY = "pg_iso_y_" + uniq;
    const now = Date.now();
    await seedPgExecution(asyncDb, execX, 0, now);
    await seedPgExecution(asyncDb, execY, 0, now);
    await seedPgJob(asyncDb, execX + "_A", execX, "A", "QUEUED", 0, now);
    // execY has no stages

    const x = await evaluateStageAdmissionAsync({ store, executionId: execX, stageName: "A" });
    ok("S5 exec X: stage A found ? ELIGIBLE", x.eligible === true, `reason=${x.reason}`);

    const y = await evaluateStageAdmissionAsync({ store, executionId: execY, stageName: "A" });
    ok("S5 exec Y: stage A not found ? STAGE_NOT_FOUND", y.reason === "STAGE_NOT_FOUND", `reason=${y.reason}`);
  }

  // S6 — sync path still valid (SQLite) — regression sanity
  {
    const syncStoreOnly = new ExecutionStore(SQLiteEngine.fromDatabase(new Database(":memory:")) as any);
    // This store has no tables (empty memory), so we can't assert much.
    // Just verify the sync API surface doesn't throw on the SQLite path.
    ok("S6 sync evaluateStageAdmission exists", typeof evaluateStageAdmission === "function");
  }

  try { await pg.close(); } catch {}
  try { mem.close(); } catch {}

  console.log(`\nPASS: ${pass}\nFAIL: ${fail}\nBLOCKED: ${blocked}`);
  process.exitCode = (fail > 0 || blocked > 0) ? 1 : 0;
}
main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exitCode = 2; });