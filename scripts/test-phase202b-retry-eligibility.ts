// scripts/test-phase202b-retry-eligibility.ts
// Phase 202 slice B: retry-aware dependency reasons + durable orchestration events.

import Database from "better-sqlite3";
import { join } from "path";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { MigrationRunner } from "../src/core/migration-runner";
import { StageExecutionStoreAdapter } from "../src/core/stage-execution-store-adapter";
import { createStageExecution, type StageExecution } from "../src/core/worker-stage-execution";
import { isStageEligible } from "../src/core/stage-eligibility";
import { evaluateStageAdmission } from "../src/core/stage-admission";

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

async function seedStage(h: any, executionId: string, stageName: string): Promise<StageExecution> {
  return h.adapter.insertIfAbsent(createStageExecution({
    executionId, tenantId: "t1", correlationId: "c1", stageName,
    executor: "test", inputFingerprint: "fp", artifactReferences: [],
  }));
}

function setJobStatus(h: any, stageId: string, jobStatus: string) {
  h.rawDb.prepare("UPDATE execution_jobs SET status = ? WHERE id = ?").run(jobStatus, stageId);
}

function mkStage(executionId: string, stageName: string, status: any, derivedJobStatus?: string): StageExecution {
  const s = createStageExecution({
    executionId, tenantId: "t1", correlationId: "c1", stageName,
    executor: "test", inputFingerprint: "fp", artifactReferences: [],
  });
  s.status = status;
  s.derivedJobStatus = derivedJobStatus;
  return s;
}

async function main() {
  console.log("=== NEXUS PHASE 202B ===\n");

  // Unit tests on isStageEligible with derivedJobStatus.

  // S1 — dep PENDING (no derivedJobStatus) ? DEPENDENCY_NOT_SUCCEEDED
  {
    const stages = new Map<string, StageExecution>([
      ["A", mkStage("ex", "A", "PENDING", "QUEUED")],
      ["B", mkStage("ex", "B", "PENDING")],
    ]);
    const r = isStageEligible({ stage: stages.get("B")!, dependencyNames: ["A"], stagesByName: stages, executionCancelled: false });
    ok("S1 dep PENDING ? DEPENDENCY_NOT_SUCCEEDED", r.reason === "DEPENDENCY_NOT_SUCCEEDED", `reason=${r.reason}`);
  }

  // S2 — dep RUNNING ? DEPENDENCY_IN_FLIGHT
  {
    const stages = new Map<string, StageExecution>([
      ["A", mkStage("ex", "A", "RUNNING", "RUNNING")],
      ["B", mkStage("ex", "B", "PENDING")],
    ]);
    const r = isStageEligible({ stage: stages.get("B")!, dependencyNames: ["A"], stagesByName: stages, executionCancelled: false });
    ok("S2 dep RUNNING ? DEPENDENCY_IN_FLIGHT", r.reason === "DEPENDENCY_IN_FLIGHT", `reason=${r.reason}`);
    ok("S2 inFlightDependencies populated", (r.inFlightDependencies ?? []).includes("A"));
  }

  // S3 — dep RETRY_SCHEDULED ? DEPENDENCY_RETRY_PENDING
  {
    const stages = new Map<string, StageExecution>([
      ["A", mkStage("ex", "A", "FAILED", "RETRY_SCHEDULED")],
      ["B", mkStage("ex", "B", "PENDING")],
    ]);
    const r = isStageEligible({ stage: stages.get("B")!, dependencyNames: ["A"], stagesByName: stages, executionCancelled: false });
    ok("S3 dep RETRY_SCHEDULED ? DEPENDENCY_RETRY_PENDING", r.reason === "DEPENDENCY_RETRY_PENDING", `reason=${r.reason}`);
    ok("S3 retryPendingDependencies populated", (r.retryPendingDependencies ?? []).includes("A"));
  }

  // S4 — dep SUCCEEDED ? ELIGIBLE
  {
    const stages = new Map<string, StageExecution>([
      ["A", mkStage("ex", "A", "SUCCEEDED", "SUCCEEDED")],
      ["B", mkStage("ex", "B", "PENDING")],
    ]);
    const r = isStageEligible({ stage: stages.get("B")!, dependencyNames: ["A"], stagesByName: stages, executionCancelled: false });
    ok("S4 dep SUCCEEDED ? ELIGIBLE", r.eligible === true && r.reason === "ELIGIBLE", `reason=${r.reason}`);
  }

  // S5 — dep DEAD_LETTER ? DEPENDENCY_TERMINAL_FAILURE
  {
    const stages = new Map<string, StageExecution>([
      ["A", mkStage("ex", "A", "FAILED", "DEAD_LETTER")],
      ["B", mkStage("ex", "B", "PENDING")],
    ]);
    const r = isStageEligible({ stage: stages.get("B")!, dependencyNames: ["A"], stagesByName: stages, executionCancelled: false });
    ok("S5 dep DEAD_LETTER ? DEPENDENCY_TERMINAL_FAILURE", r.reason === "DEPENDENCY_TERMINAL_FAILURE", `reason=${r.reason}`);
  }

  // S6 — dep CANCELLED (stage status) ? DEPENDENCY_TERMINAL_FAILURE
  {
    const stages = new Map<string, StageExecution>([
      ["A", mkStage("ex", "A", "CANCELLED", "CANCELLED")],
      ["B", mkStage("ex", "B", "PENDING")],
    ]);
    const r = isStageEligible({ stage: stages.get("B")!, dependencyNames: ["A"], stagesByName: stages, executionCancelled: false });
    ok("S6 dep CANCELLED ? DEPENDENCY_TERMINAL_FAILURE", r.reason === "DEPENDENCY_TERMINAL_FAILURE", `reason=${r.reason}`);
  }

  // S7 — multi-dep: one in-flight, one retry-pending ? retry-pending wins
  {
    const stages = new Map<string, StageExecution>([
      ["A", mkStage("ex", "A", "RUNNING", "RUNNING")],
      ["B", mkStage("ex", "B", "FAILED", "RETRY_SCHEDULED")],
      ["C", mkStage("ex", "C", "PENDING")],
    ]);
    const r = isStageEligible({ stage: stages.get("C")!, dependencyNames: ["A", "B"], stagesByName: stages, executionCancelled: false });
    ok("S7 retry-pending wins over in-flight", r.reason === "DEPENDENCY_RETRY_PENDING", `reason=${r.reason}`);
  }

  // Integration tests through evaluateStageAdmission + durable store.

  // S8 — dep RETRY_SCHEDULED via durable store
  {
    const h = makeHarness();
    const A = await seedStage(h, "ex_s8", "A");
    await seedStage(h, "ex_s8", "B");
    setJobStatus(h, A.stageExecutionId, "RETRY_SCHEDULED");
    h.store.stageDeps.add({ executionId: "ex_s8", stageName: "B", dependsOnStage: "A" });
    const r = evaluateStageAdmission({ store: h.store, executionId: "ex_s8", stageName: "B" });
    ok("S8 durable RETRY_SCHEDULED ? DEPENDENCY_RETRY_PENDING",
       r.reason === "DEPENDENCY_RETRY_PENDING",
       `reason=${r.reason}`);
  }

  // S9 — dep RUNNING via durable store
  {
    const h = makeHarness();
    const A = await seedStage(h, "ex_s9", "A");
    await seedStage(h, "ex_s9", "B");
    setJobStatus(h, A.stageExecutionId, "RUNNING");
    h.store.stageDeps.add({ executionId: "ex_s9", stageName: "B", dependsOnStage: "A" });
    const r = evaluateStageAdmission({ store: h.store, executionId: "ex_s9", stageName: "B" });
    ok("S9 durable RUNNING ? DEPENDENCY_IN_FLIGHT",
       r.reason === "DEPENDENCY_IN_FLIGHT",
       `reason=${r.reason}`);
  }

  // S10 — dep DEAD_LETTER via durable store
  {
    const h = makeHarness();
    const A = await seedStage(h, "ex_s10", "A");
    await seedStage(h, "ex_s10", "B");
    setJobStatus(h, A.stageExecutionId, "DEAD_LETTER");
    h.store.stageDeps.add({ executionId: "ex_s10", stageName: "B", dependsOnStage: "A" });
    const r = evaluateStageAdmission({ store: h.store, executionId: "ex_s10", stageName: "B" });
    ok("S10 durable DEAD_LETTER ? DEPENDENCY_TERMINAL_FAILURE",
       r.reason === "DEPENDENCY_TERMINAL_FAILURE",
       `reason=${r.reason}`);
  }

  // S11 — dep SUCCEEDED via durable store ? eligible
  {
    const h = makeHarness();
    const A = await seedStage(h, "ex_s11", "A");
    await seedStage(h, "ex_s11", "B");
    setJobStatus(h, A.stageExecutionId, "SUCCEEDED");
    h.store.stageDeps.add({ executionId: "ex_s11", stageName: "B", dependsOnStage: "A" });
    const r = evaluateStageAdmission({ store: h.store, executionId: "ex_s11", stageName: "B" });
    ok("S11 durable SUCCEEDED ? ELIGIBLE", r.eligible === true, `reason=${r.reason}`);
  }

  console.log(`\nPASS: ${pass}\nFAIL: ${fail}\nBLOCKED: ${blocked}`);
  process.exitCode = (fail > 0 || blocked > 0) ? 1 : 0;
}
main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exitCode = 2; });