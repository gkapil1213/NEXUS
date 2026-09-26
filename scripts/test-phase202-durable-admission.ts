// scripts/test-phase202-durable-admission.ts
// Phase 202 slice A: durable runtime admission from canonical storage.
//
// Every assertion reads through the durable store. No caller-supplied maps.

import Database from "better-sqlite3";
import { join } from "path";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { MigrationRunner } from "../src/core/migration-runner";
import { StageExecutionStoreAdapter } from "../src/core/stage-execution-store-adapter";
import { createStageExecution, type StageExecution, type StageStatus } from "../src/core/worker-stage-execution";
import { evaluateStageAdmission } from "../src/core/stage-admission";
import { tmpdir } from "node:os";
import { unlinkSync } from "node:fs";

let pass = 0, fail = 0, blocked = 0;
function ok(n: string, c: boolean, d = "") {
  if (c) { pass++; console.log("[PASSED] " + n + (d ? "  " + d : "")); }
  else   { fail++; console.log("[FAILED] " + n + (d ? "  " + d : "")); }
}
function blk(n: string, w: string) { blocked++; console.log("[BLOCKED] " + n + "  " + w); }

const MIG_DIR = join(process.cwd(), "src", "db", "migrations");

function makeHarness(): { store: ExecutionStore; rawDb: Database.Database; adapter: StageExecutionStoreAdapter } {
  const rawDb = new Database(":memory:");
  new MigrationRunner(rawDb, MIG_DIR).run();
  const syncEngine = SQLiteEngine.fromDatabase(rawDb);
  const store = new ExecutionStore(syncEngine as any);
  const adapter = new StageExecutionStoreAdapter(store);
  return { store, rawDb, adapter };
}

async function seedStage(
  harness: { store: ExecutionStore; rawDb: Database.Database; adapter: StageExecutionStoreAdapter },
  executionId: string,
  stageName: string,
): Promise<StageExecution> {
  const s = createStageExecution({
    executionId, tenantId: "t1", correlationId: "c1", stageName,
    executor: "test", inputFingerprint: "fp", artifactReferences: [],
  });
  return harness.adapter.insertIfAbsent(s);
}

// Directly set the underlying job status for fixture purposes. The durable
// status is what the adapter projects, and what admission must consult.
function setStageStatus(
  harness: { store: ExecutionStore; rawDb: Database.Database },
  stageId: string,
  status: StageStatus,
) {
  const jobStatus = ({
    PENDING: 'QUEUED',
    RUNNING: 'RUNNING',
    SUCCEEDED: 'SUCCEEDED',
    FAILED: 'FAILED',
    SKIPPED: 'CANCELLED',
    CANCELLED: 'CANCELLED',
  } as Record<StageStatus, string>)[status];
  harness.rawDb.prepare("UPDATE execution_jobs SET status = ? WHERE id = ?").run(jobStatus, stageId);
}

async function main() {
  console.log("=== NEXUS PHASE 202A ===\n");

  // S1 — no deps, target PENDING ? eligible
  {
    const h = makeHarness();
    await seedStage(h, "ex_s1", "A");
    const r = evaluateStageAdmission({ store: h.store, executionId: "ex_s1", stageName: "A" });
    ok("S1 no deps ? eligible", r.eligible === true && r.reason === "ELIGIBLE", `reason=${r.reason}`);
  }

  // S2 — dep SUCCEEDED ? eligible
  {
    const h = makeHarness();
    const A = await seedStage(h, "ex_s2", "A");
    await seedStage(h, "ex_s2", "B");
    setStageStatus(h, A.stageExecutionId, "SUCCEEDED");
    h.store.stageDeps.add({ executionId: "ex_s2", stageName: "B", dependsOnStage: "A" });
    const r = evaluateStageAdmission({ store: h.store, executionId: "ex_s2", stageName: "B" });
    ok("S2 dep SUCCEEDED ? eligible", r.eligible === true, `reason=${r.reason}`);
  }

  // S3 — dep PENDING ? not eligible
  {
    const h = makeHarness();
    await seedStage(h, "ex_s3", "A");
    await seedStage(h, "ex_s3", "B");
    h.store.stageDeps.add({ executionId: "ex_s3", stageName: "B", dependsOnStage: "A" });
    const r = evaluateStageAdmission({ store: h.store, executionId: "ex_s3", stageName: "B" });
    ok("S3 dep PENDING ? not eligible", r.eligible === false && r.reason === "DEPENDENCY_NOT_SUCCEEDED", `reason=${r.reason}`);
  }

  // S4 — dep RUNNING ? not eligible
  {
    const h = makeHarness();
    const A = await seedStage(h, "ex_s4", "A");
    await seedStage(h, "ex_s4", "B");
    setStageStatus(h, A.stageExecutionId, "RUNNING");
    h.store.stageDeps.add({ executionId: "ex_s4", stageName: "B", dependsOnStage: "A" });
    const r = evaluateStageAdmission({ store: h.store, executionId: "ex_s4", stageName: "B" });
    ok("S4 dep RUNNING -> not eligible", r.eligible === false, `reason=${r.reason}`);
  }

  // S5 — dep FAILED ? DEPENDENCY_TERMINAL_FAILURE
  {
    const h = makeHarness();
    const A = await seedStage(h, "ex_s5", "A");
    await seedStage(h, "ex_s5", "B");
    setStageStatus(h, A.stageExecutionId, "FAILED");
    h.store.stageDeps.add({ executionId: "ex_s5", stageName: "B", dependsOnStage: "A" });
    const r = evaluateStageAdmission({ store: h.store, executionId: "ex_s5", stageName: "B" });
    ok("S5 dep FAILED ? terminal failure", r.eligible === false && r.reason === "DEPENDENCY_TERMINAL_FAILURE", `reason=${r.reason}`);
  }

  // S6 — target stage terminal ? STAGE_TERMINAL
  {
    const h = makeHarness();
    const A = await seedStage(h, "ex_s6", "A");
    setStageStatus(h, A.stageExecutionId, "SUCCEEDED");
    const r = evaluateStageAdmission({ store: h.store, executionId: "ex_s6", stageName: "A" });
    ok("S6 target terminal ? STAGE_TERMINAL", r.eligible === false && r.reason === "STAGE_TERMINAL", `reason=${r.reason}`);
  }

  // S7 — execution cancelled ? EXECUTION_CANCELLED
  {
    const h = makeHarness();
    await seedStage(h, "ex_s7", "A");
    h.rawDb.prepare(
      "INSERT INTO execution_jobs (id, idempotency_key, job_type, payload, status, cancellation_requested, created_at, updated_at) " +
      "VALUES ('ex_s7', 'k_ex_s7', 'pipeline', '{}', 'RUNNING', 1, ?, ?)"
    ).run(Date.now(), Date.now());
    const r = evaluateStageAdmission({ store: h.store, executionId: "ex_s7", stageName: "A" });
    ok("S7 cancelled execution ? EXECUTION_CANCELLED", r.eligible === false && r.reason === "EXECUTION_CANCELLED", `reason=${r.reason}`);
  }

  // S8 — stage missing ? STAGE_NOT_FOUND
  {
    const h = makeHarness();
    h.rawDb.prepare(
      "INSERT INTO execution_jobs (id, idempotency_key, job_type, payload, status, created_at, updated_at) " +
      "VALUES ('ex_s8', 'k_ex_s8', 'pipeline', '{}', 'RUNNING', ?, ?)"
    ).run(Date.now(), Date.now());
    const r = evaluateStageAdmission({ store: h.store, executionId: "ex_s8", stageName: "MISSING" });
    ok("S8 stage missing ? STAGE_NOT_FOUND", r.eligible === false && r.reason === "STAGE_NOT_FOUND", `reason=${r.reason}`);
  }

  // S9 — multi-dep, all SUCCEEDED ? eligible
  {
    const h = makeHarness();
    const A = await seedStage(h, "ex_s9", "A");
    const B = await seedStage(h, "ex_s9", "B");
    await seedStage(h, "ex_s9", "C");
    setStageStatus(h, A.stageExecutionId, "SUCCEEDED");
    setStageStatus(h, B.stageExecutionId, "SUCCEEDED");
    h.store.stageDeps.add({ executionId: "ex_s9", stageName: "C", dependsOnStage: "A" });
    h.store.stageDeps.add({ executionId: "ex_s9", stageName: "C", dependsOnStage: "B" });
    const r = evaluateStageAdmission({ store: h.store, executionId: "ex_s9", stageName: "C" });
    ok("S9 multi-dep all succeeded ? eligible", r.eligible === true, `reason=${r.reason}`);
  }

  // S10 — multi-dep, one PENDING ? not eligible
  {
    const h = makeHarness();
    const A = await seedStage(h, "ex_s10", "A");
    await seedStage(h, "ex_s10", "B");
    await seedStage(h, "ex_s10", "C");
    setStageStatus(h, A.stageExecutionId, "SUCCEEDED");
    h.store.stageDeps.add({ executionId: "ex_s10", stageName: "C", dependsOnStage: "A" });
    h.store.stageDeps.add({ executionId: "ex_s10", stageName: "C", dependsOnStage: "B" });
    const r = evaluateStageAdmission({ store: h.store, executionId: "ex_s10", stageName: "C" });
    ok("S10 multi-dep one pending ? not eligible",
       r.eligible === false && r.reason === "DEPENDENCY_NOT_SUCCEEDED",
       `reason=${r.reason}`);
  }

  // S11 — restart durability: same durable state ? same admission result
  {
    const dir = tmpdir() + "/nexus-p202a-" + Date.now() + ".sqlite";
    for (const s of ["", "-wal", "-shm"]) { try { unlinkSync(dir + s); } catch {} }

    const rawDb = new Database(dir);
    new MigrationRunner(rawDb, MIG_DIR).run();
    const syncEngine = SQLiteEngine.fromDatabase(rawDb);
    const store = new ExecutionStore(syncEngine as any);
    const adapter = new StageExecutionStoreAdapter(store);
    const A = await adapter.insertIfAbsent(createStageExecution({
      executionId: "ex_s11", tenantId: "t1", correlationId: "c1", stageName: "A",
      executor: "test", inputFingerprint: "fp", artifactReferences: [],
    }));
    await adapter.insertIfAbsent(createStageExecution({
      executionId: "ex_s11", tenantId: "t1", correlationId: "c1", stageName: "B",
      executor: "test", inputFingerprint: "fp", artifactReferences: [],
    }));
    rawDb.prepare("UPDATE execution_jobs SET status = 'SUCCEEDED' WHERE id = ?").run(A.stageExecutionId);
    store.stageDeps.add({ executionId: "ex_s11", stageName: "B", dependsOnStage: "A" });
    const before = evaluateStageAdmission({ store, executionId: "ex_s11", stageName: "B" });
    rawDb.close();

    const rawDb2 = new Database(dir);
    const syncEngine2 = SQLiteEngine.fromDatabase(rawDb2);
    const store2 = new ExecutionStore(syncEngine2 as any);
    const after = evaluateStageAdmission({ store: store2, executionId: "ex_s11", stageName: "B" });
    ok("S11 restart durability ? same admission",
       before.eligible === after.eligible && before.reason === after.reason,
       `before=${before.reason} after=${after.reason}`);
    rawDb2.close();
    for (const s of ["", "-wal", "-shm"]) { try { unlinkSync(dir + s); } catch {} }
  }

  console.log(`\nPASS: ${pass}\nFAIL: ${fail}\nBLOCKED: ${blocked}`);
  process.exitCode = (fail > 0 || blocked > 0) ? 1 : 0;
}
main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exitCode = 2; });
