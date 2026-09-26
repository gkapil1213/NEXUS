// scripts/test-phase201-stage-dag.ts
// Phase 201 slice A: canonical stage dependency persistence + DAG validation
// + eligibility computation.
//
// Runs against SQLite (in-process) and, when DATABASE_URL is set, against
// PostgreSQL via the async store.

import Database from "better-sqlite3";
import { join } from "path";
import { PgClient } from "../src/core/pg-client";
import { PgAsyncEngine } from "../src/core/pg-async-engine";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { MigrationRunner } from "../src/core/migration-runner";
import { bootstrapPgSchema } from "../src/core/pg-bootstrap";
import { isStageEligible } from "../src/core/stage-eligibility";
import { createStageExecution, type StageExecution, type StageStatus } from "../src/core/worker-stage-execution";

let pass = 0, fail = 0, blocked = 0;
function ok(n: string, c: boolean, d = "") {
  if (c) { pass++; console.log("[PASSED] " + n + (d ? "  " + d : "")); }
  else   { fail++; console.log("[FAILED] " + n + (d ? "  " + d : "")); }
}
function blk(n: string, w: string) { blocked++; console.log("[BLOCKED] " + n + "  " + w); }

const MIG_DIR = join(process.cwd(), "src", "db", "migrations");

function makeSQLiteStore(): { store: ExecutionStore; rawDb: Database.Database } {
  const rawDb = new Database(":memory:");
  new MigrationRunner(rawDb, MIG_DIR).run();
  const syncEngine = SQLiteEngine.fromDatabase(rawDb);
  const store = new ExecutionStore(syncEngine as any);
  return { store, rawDb };
}

function mkStage(executionId: string, stageName: string, status?: StageStatus): StageExecution {
  const s = createStageExecution({
    executionId, tenantId: "t1", correlationId: "c1", stageName,
    executor: "test-executor", inputFingerprint: "fp", artifactReferences: [],
  });
  if (status) s.status = status;
  return s;
}

async function sqliteSuite(): Promise<void> {
  console.log("=== Phase 201a SQLite ===\n");
  const { store } = makeSQLiteStore();
  const deps = store.stageDeps;

  // S1 — add new edge succeeds
  {
    const r = deps.add({ executionId: "ex_s1", stageName: "build", dependsOnStage: "lint" });
    ok("S1 new edge created", r.ok === true && r.created === true);
  }

  // S2 — duplicate edge rejected
  {
    const r = deps.add({ executionId: "ex_s1", stageName: "build", dependsOnStage: "lint" });
    ok("S2 duplicate edge rejected", r.ok === false && r.reason === "DUPLICATE_EDGE", `reason=${(r as any).reason}`);
  }

  // S3 — self-dependency rejected
  {
    const r = deps.add({ executionId: "ex_s1", stageName: "build", dependsOnStage: "build" });
    ok("S3 self-dep rejected", r.ok === false && r.reason === "SELF_DEPENDENCY", `reason=${(r as any).reason}`);
  }

  // S4 — getDependencies returns the edge
  {
    const list = deps.getDependencies("ex_s1", "build");
    ok("S4 getDependencies returns edge", list.length === 1 && list[0] === "lint", `got=${list.join(",")}`);
  }

  // S5 — missing-ref validation
  {
    deps.add({ executionId: "ex_s5", stageName: "build", dependsOnStage: "nonexistent" });
    const v = deps.validateGraph("ex_s5", ["build"]);
    ok("S5 missing-ref rejected", v.ok === false && v.errors.some((e) => e.startsWith("DEPENDENCY_NOT_DECLARED")), `errors=${v.errors.join(";")}`);
  }

  // S6 — 2-cycle rejected
  {
    const ex = "ex_s6";
    deps.add({ executionId: ex, stageName: "a", dependsOnStage: "b" });
    deps.add({ executionId: ex, stageName: "b", dependsOnStage: "a" });
    const v = deps.validateGraph(ex, ["a", "b"]);
    ok("S6 2-cycle rejected", v.ok === false && v.errors.includes("CYCLE_DETECTED"), `errors=${v.errors.join(";")}`);
  }

  // S7 — 3-cycle rejected
  {
    const ex = "ex_s7";
    deps.add({ executionId: ex, stageName: "a", dependsOnStage: "b" });
    deps.add({ executionId: ex, stageName: "b", dependsOnStage: "c" });
    deps.add({ executionId: ex, stageName: "c", dependsOnStage: "a" });
    const v = deps.validateGraph(ex, ["a", "b", "c"]);
    ok("S7 3-cycle rejected", v.ok === false && v.errors.includes("CYCLE_DETECTED"), `errors=${v.errors.join(";")}`);
  }

  // S8 — valid DAG accepted
  {
    const ex = "ex_s8";
    deps.add({ executionId: ex, stageName: "b", dependsOnStage: "a" });
    deps.add({ executionId: ex, stageName: "c", dependsOnStage: "a" });
    deps.add({ executionId: ex, stageName: "d", dependsOnStage: "a" });
    deps.add({ executionId: ex, stageName: "e", dependsOnStage: "b" });
    deps.add({ executionId: ex, stageName: "e", dependsOnStage: "c" });
    deps.add({ executionId: ex, stageName: "e", dependsOnStage: "d" });
    const v = deps.validateGraph(ex, ["a", "b", "c", "d", "e"]);
    ok("S8 valid DAG accepted", v.ok === true, `errors=${v.errors.join(";")}`);
  }

  // S9 — eligibility false when dep PENDING
  {
    const stages = new Map<string, StageExecution>([
      ["a", mkStage("ex_s9", "a", "PENDING")],
      ["b", mkStage("ex_s9", "b", "PENDING")],
    ]);
    const r = isStageEligible({ stage: stages.get("b")!, dependencyNames: ["a"], stagesByName: stages, executionCancelled: false });
    ok("S9 dep PENDING blocks", r.eligible === false && r.reason === "DEPENDENCY_NOT_SUCCEEDED", `reason=${r.reason}`);
  }

  // S10 — eligibility true when all deps SUCCEEDED
  {
    const stages = new Map<string, StageExecution>([
      ["a", mkStage("ex_s10", "a", "SUCCEEDED")],
      ["b", mkStage("ex_s10", "b", "PENDING")],
    ]);
    const r = isStageEligible({ stage: stages.get("b")!, dependencyNames: ["a"], stagesByName: stages, executionCancelled: false });
    ok("S10 dep SUCCEEDED allows", r.eligible === true && r.reason === "ELIGIBLE", `reason=${r.reason}`);
  }

  // S11 — eligibility false when dep FAILED terminal
  {
    const stages = new Map<string, StageExecution>([
      ["a", mkStage("ex_s11", "a", "FAILED")],
      ["b", mkStage("ex_s11", "b", "PENDING")],
    ]);
    const r = isStageEligible({ stage: stages.get("b")!, dependencyNames: ["a"], stagesByName: stages, executionCancelled: false });
    ok("S11 dep FAILED blocks", r.eligible === false && r.reason === "DEPENDENCY_TERMINAL_FAILURE", `reason=${r.reason}`);
  }

  // S12 — 100-stage DAG validates <100ms
  {
    const ex = "ex_s12";
    const stages: string[] = [];
    for (let i = 0; i < 100; i++) stages.push("s" + i);
    for (let i = 1; i < 100; i++) {
      deps.add({ executionId: ex, stageName: "s" + i, dependsOnStage: "s" + (i - 1) });
    }
    const t0 = Date.now();
    const v = deps.validateGraph(ex, stages);
    const dt = Date.now() - t0;
    ok("S12 100-stage DAG valid <100ms", v.ok === true && dt < 100, `ok=${v.ok} dt=${dt}ms`);
  }

  // S13 — deleteGraph removes all edges for execution
  {
    const before = deps.listGraph("ex_s8").length;
    deps.deleteGraph("ex_s8");
    const after = deps.listGraph("ex_s8").length;
    ok("S13 deleteGraph", before === 6 && after === 0, `before=${before} after=${after}`);
  }
}

async function pgSuite(url: string): Promise<void> {
  console.log("\n=== Phase 201a PostgreSQL ===\n");

  const pg = new PgClient();
  await pg.connect(url);
  await bootstrapPgSchema(pg);
  ok("PG connectivity", true);

  const asyncDb = new PgAsyncEngine(pg);
  const mem = new Database(":memory:");
  new MigrationRunner(mem, MIG_DIR).run();
  const syncEngine = SQLiteEngine.fromDatabase(mem);
  const store = new ExecutionStore(syncEngine as any, asyncDb);

  const deps = store.stageDepsAsync!;
  ok("PG async store available", !!deps);

  const uniq = Date.now().toString(36);
  const ex = "pg_ex_" + uniq;

  const r1 = await deps.add({ executionId: ex, stageName: "build", dependsOnStage: "lint" });
  ok("PG add edge", r1.ok === true, `ok=${r1.ok}`);

  const r2 = await deps.add({ executionId: ex, stageName: "build", dependsOnStage: "lint" });
  ok("PG duplicate rejected", r2.ok === false && (r2 as any).reason === "DUPLICATE_EDGE");

  const r3 = await deps.add({ executionId: ex, stageName: "build", dependsOnStage: "build" });
  ok("PG self-dep rejected", r3.ok === false && (r3 as any).reason === "SELF_DEPENDENCY");

  const list = await deps.getDependencies(ex, "build");
  ok("PG getDependencies", list.length === 1 && list[0] === "lint");

  const ex2 = "pg_ex2_" + uniq;
  await deps.add({ executionId: ex2, stageName: "a", dependsOnStage: "b" });
  await deps.add({ executionId: ex2, stageName: "b", dependsOnStage: "a" });
  const v = await deps.validateGraph(ex2, ["a", "b"]);
  ok("PG cycle rejected", v.ok === false && v.errors.includes("CYCLE_DETECTED"));

  const deleted = await deps.deleteGraph(ex2);
  ok("PG deleteGraph", deleted === 2, `deleted=${deleted}`);

  try { await pg.close(); } catch {}
  try { mem.close(); } catch {}
}

async function main() {
  console.log("=== NEXUS PHASE 201A ===\n");

  await sqliteSuite();

  const url = process.env.DATABASE_URL;
  if (!url) {
    blk("PostgreSQL suite", "DATABASE_URL not set");
  } else {
    try {
      await pgSuite(url);
    } catch (e: any) {
      blk("PostgreSQL suite", String(e?.message ?? e));
    }
  }

  console.log(`\nPASS: ${pass}\nFAIL: ${fail}\nBLOCKED: ${blocked}`);
  process.exitCode = (fail > 0 || blocked > 0) ? 1 : 0;
}
main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exitCode = 2; });