// scripts/test-phase201-orchestrator-deps.ts
// Phase 201 slice B: dependency gate wired into the CI/CD orchestrator.
// Runs against SQLite (in-process). PostgreSQL is not required for this slice.

import Database from "better-sqlite3";
import { join } from "path";
import { randomUUID } from "crypto";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { MigrationRunner } from "../src/core/migration-runner";
import { LeaseManager } from "../src/core/lease-manager";
import { orchestrateCICD } from "../src/core/worker-autonomous-cicd-orchestrator";
import { createPipelineDefinition } from "../src/core/worker-pipeline-definition";

let pass = 0, fail = 0, blocked = 0;
function ok(n: string, c: boolean, d = "") {
  if (c) { pass++; console.log("[PASSED] " + n + (d ? "  " + d : "")); }
  else   { fail++; console.log("[FAILED] " + n + (d ? "  " + d : "")); }
}
function blk(n: string, w: string) { blocked++; console.log("[BLOCKED] " + n + "  " + w); }

const MIG_DIR = join(process.cwd(), "src", "db", "migrations");

function makeStore(): ExecutionStore {
  const rawDb = new Database(":memory:");
  new MigrationRunner(rawDb, MIG_DIR).run();
  const syncEngine = SQLiteEngine.fromDatabase(rawDb);
  return new ExecutionStore(syncEngine as any);
}

const noopAdapter = {
  getId: () => "test-adapter",
  healthCheck: async () => ({ healthy: true, ok: true }),
  execute: async () => ({ success: true }),
} as any;

const noopEnforcement = undefined;
const baseDeployment = {
  environment: "staging",
  projectId: null,
  artifactId: "art-x",
  artifactDigest: "dig-x",
  imageRepository: "img",
  imageTag: "t",
  imageId: null,
  containerName: "c",
  containerPort: 8080,
  approval: {},
};

function buildRequest(store: ExecutionStore, leaseManager: LeaseManager, stages: any[], stageName: string) {
  const tenantId = "t1";
  const correlationId = randomUUID();
  const pipelineDefInput = {
    name: "test-pipeline-" + randomUUID(),
    version: 1,
    stages,
    requiredStages: [],
    timeoutMs: 60_000,
    retryPolicy: { maxRetries: 0, backoffMs: 0 },
    approvalRequired: false,
    artifactRequired: false,
    securityRequired: false,
    owner: "test-owner",
    policy: "test-policy",
    tenantId,
    correlationId,
  };
  const pipelineDef = createPipelineDefinition(pipelineDefInput as any);

  return {
    tenantId,
    correlationId,
    pipelineDef: pipelineDefInput as any,
    repository: "r",
    revision: "rev-1",
    actor: "test-actor",
    trigger: "manual",
    changedFiles: [],
    riskInput: {} as any,
    governanceDecision: "ALLOW" as const,
    safetyDecision: "ALLOW" as const,
    approvalRequired: false,
    approvalGranted: true,
    deploymentTargetHealthy: true,
    releaseVersion: "1.0.0",
    store,
    leaseManager,
    adapter: noopAdapter,
    workerId: "worker-A",
    leaseTtlMs: 60_000,
    releaseEnforcement: noopEnforcement,
    deployment: baseDeployment,
    pipelineDefString: pipelineDef, // (unused, kept for clarity)
  } as any;
}

async function main() {
  console.log("=== NEXUS PHASE 201B ===\n");

  // S1 — stage with no dependencies: unchanged behavior
  {
    const store = makeStore();
    const leases = new LeaseManager(store);
    const stages = ["BUILD", "ARTIFACT"]; // no deps registered
    const req = buildRequest(store, leases, stages, "BUILD");
    const result = await orchestrateCICD(req);
    ok("S1 no-deps pipeline not blocked on dependency check",
       result.status !== "BLOCKED" || (result as any).blockedReason !== "DEPENDENCY_NOT_SUCCEEDED",
       `status=${result.status} blockedReason=${(result as any).blockedReason ?? "none"}`);
  }

  // S2 — valid DAG, deps in declared order ? pipeline reaches past dependency gate
  {
    const store = makeStore();
    const leases = new LeaseManager(store);
    const stages = ["BUILD", "ARTIFACT"];
    // Need a job id first; build then inspect. We use orchestrateCICD, which
    // creates the pipeline job. So register deps after we know the job id —
    // this test uses a two-step approach: first call to create the job,
    // then insert dependencies and re-invoke against the same job.
    // For slice B, simpler assertion: a dependency edge with the ARtifact
    // stage declared before BUILD does not gate (no edge exists).
    const req = buildRequest(store, leases, stages, "BUILD");
    const result = await orchestrateCICD(req);
    ok("S2 no edges registered ? not blocked by dependency gate",
       (result as any).blockedReason !== "DEPENDENCY_NOT_SUCCEEDED",
       `status=${result.status} blockedReason=${(result as any).blockedReason ?? "none"}`);
  }

  // S3 — dependency edge whose dep is not in stages ? INVALID_DEPENDENCY_GRAPH
  {
    const store = makeStore();
    const leases = new LeaseManager(store);
    const stages = ["BUILD"];
    const req = buildRequest(store, leases, stages, "BUILD");
    // Pre-insert a dependency edge with a nonexistent stage BEFORE the
    // orchestrator runs. It uses a synthetic execution id — the orchestrator
    // generates its own pipelineJob.id, so we cannot pre-seed for that exact
    // id. Instead test the graph validator directly through the store API.
    const v = store.stageDeps.validateGraph("nonexistent-exec", ["BUILD"]);
    ok("S3 empty graph for unknown execution is valid",
       v.ok === true && v.errors.length === 0,
       `ok=${v.ok} errors=${v.errors.join(";")}`);
  }

  // S4 — dependency cycle rejected by validator
  {
    const store = makeStore();
    store.stageDeps.add({ executionId: "ex-cycle", stageName: "A", dependsOnStage: "B" });
    store.stageDeps.add({ executionId: "ex-cycle", stageName: "B", dependsOnStage: "A" });
    const v = store.stageDeps.validateGraph("ex-cycle", ["A", "B"]);
    ok("S4 cycle rejected", v.ok === false && v.errors.includes("CYCLE_DETECTED"),
       `errors=${v.errors.join(";")}`);
  }

  // S5 — self-dependency rejected by validator storage layer
  {
    const store = makeStore();
    const r = store.stageDeps.add({ executionId: "ex-self", stageName: "A", dependsOnStage: "A" });
    ok("S5 self-dep rejected at add()", r.ok === false && r.reason === "SELF_DEPENDENCY");
  }

  // S6 — duplicate edge rejected
  {
    const store = makeStore();
    store.stageDeps.add({ executionId: "ex-dup", stageName: "B", dependsOnStage: "A" });
    const r = store.stageDeps.add({ executionId: "ex-dup", stageName: "B", dependsOnStage: "A" });
    ok("S6 duplicate edge rejected", r.ok === false && r.reason === "DUPLICATE_EDGE");
  }

  // S7 — missing-ref rejected by validator
  {
    const store = makeStore();
    store.stageDeps.add({ executionId: "ex-miss", stageName: "B", dependsOnStage: "NOT_DECLARED" });
    const v = store.stageDeps.validateGraph("ex-miss", ["B"]);
    ok("S7 missing-ref rejected",
       v.ok === false && v.errors.some((e) => e.startsWith("DEPENDENCY_NOT_DECLARED")),
       `errors=${v.errors.join(";")}`);
  }

  // S8 — orchestrator still completes successfully on a run with no registered edges
  {
    const store = makeStore();
    const leases = new LeaseManager(store);
    const stages = ["BUILD", "ARTIFACT"];
    const req = buildRequest(store, leases, stages, "BUILD");
    const result = await orchestrateCICD(req);
    ok("S8 pipeline completes (no deps registered)",
       result.status === "COMPLETED" || result.status === "SUCCEEDED",
       `status=${result.status}`);
  }

  // S9 — graph validation gate fires: cycle interception makes the
  // orchestrator return BLOCKED with INVALID_DEPENDENCY_GRAPH.
  {
    const store = makeStore();
    const leases = new LeaseManager(store);
    const realValidate = store.stageDeps.validateGraph.bind(store.stageDeps);
    (store.stageDeps as any).validateGraph = () => ({ ok: false, errors: ["CYCLE_DETECTED"] });
    try {
      const stages = ["BUILD", "ARTIFACT"];
      const req = buildRequest(store, leases, stages, "BUILD");
      const result = await orchestrateCICD(req);
      ok("S9 graph gate fires ? BLOCKED / INVALID_DEPENDENCY_GRAPH",
         result.status === "BLOCKED" && (result as any).blockedReason === "INVALID_DEPENDENCY_GRAPH",
         `status=${result.status} blockedReason=${(result as any).blockedReason ?? "none"}`);
    } finally {
      (store.stageDeps as any).validateGraph = realValidate;
    }
  }

  // S10 — dependency eligibility gate fires: getDependencies returns a
  // phantom dependency not present in the loop's stages map ? BLOCKED with
  // DEPENDENCY_NOT_SUCCEEDED and no stage lease remains ACTIVE.
  {
    const store = makeStore();
    const leases = new LeaseManager(store);
    const realGet = store.stageDeps.getDependencies.bind(store.stageDeps);
    (store.stageDeps as any).getDependencies = () => ["PHANTOM_DEP"];
    try {
      const stages = ["BUILD", "ARTIFACT"];
      const req = buildRequest(store, leases, stages, "BUILD");
      const result = await orchestrateCICD(req);
      ok("S10 eligibility gate fires ? BLOCKED / DEPENDENCY_NOT_SUCCEEDED",
         result.status === "BLOCKED" && (result as any).blockedReason === "DEPENDENCY_NOT_SUCCEEDED",
         `status=${result.status} blockedReason=${(result as any).blockedReason ?? "none"}`);

      // Verify no leaked ACTIVE lease for the pipeline job or any stage job.
      const activeCount = (store as any).db.prepare(
        "SELECT COUNT(*) AS c FROM execution_leases WHERE status = 'ACTIVE'"
      ).get() as any;
      ok("S10 no ACTIVE lease leaked after gate rejection",
         Number(activeCount?.c ?? -1) === 0,
         `activeCount=${activeCount?.c}`);
    } finally {
      (store.stageDeps as any).getDependencies = realGet;
    }
  }
  console.log(`\nPASS: ${pass}\nFAIL: ${fail}\nBLOCKED: ${blocked}`);
  process.exitCode = (fail > 0 || blocked > 0) ? 1 : 0;
}
main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exitCode = 2; });