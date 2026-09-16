// scripts/test-phase131-end-to-end-integration.ts
// Phase 131 - authoritative end-to-end production execution integration.
//
// 131a: bind a durable ExecutionJob identity to a single engineering execution.
// 131b: CI/CD handoff (added later).
// 131c: release+deploy handoff (added later).

import Database from "better-sqlite3";
import { join } from "path";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { MigrationRunner } from "../src/core/migration-runner";
import { ExecutionStore } from "../src/core/execution-store";
import { bindDurableEngineeringJob } from "../src/core/engineering";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log(`  ok   ${msg}`); }
  else      { failed++; console.log(`  FAIL ${msg}`); }
}

function makeStore(): ExecutionStore {
  const rawDb = new Database(":memory:");
  const migrationsDir = join(process.cwd(), "src", "db", "migrations");
  new MigrationRunner(rawDb, migrationsDir).run();
  const db = SQLiteEngine.fromDatabase(rawDb);
  return new ExecutionStore(db as any);
}

async function T01_durable_binding(): Promise<void> {
  console.log("\nT01 - durable identity binding");
  const store = makeStore();
  const jobId = bindDurableEngineeringJob(store, "exec-abc", {
    projectId: "proj-1",
    workspaceId: "ws-1",
    intentRaw: "build a thing",
  });
  ok(typeof jobId === "string" && jobId.length > 0, "T01 returns a job id");
  const job = store.getJob(jobId!);
  ok(!!job, "T01 durable job exists");
  ok(job?.jobType === "engineering", "T01 jobType=engineering");
  ok(job?.status === "QUEUED", "T01 initial status QUEUED");
  ok((job?.payload as any)?.executionId === "exec-abc", "T01 executionId in payload");
  ok((job?.payload as any)?.projectId === "proj-1", "T01 projectId in payload");
}

async function T02_idempotency(): Promise<void> {
  console.log("\nT02 - idempotent binding");
  const store = makeStore();
  const a = bindDurableEngineeringJob(store, "exec-xyz", { projectId: "p", workspaceId: "w", intentRaw: "r" });
  const b = bindDurableEngineeringJob(store, "exec-xyz", { projectId: "p", workspaceId: "w", intentRaw: "r" });
  ok(a === b, "T02 same executionId -> same job id");
  const all = store.getJobByIdempotencyKey("engineering:exec-xyz");
  ok(!!all && all.id === a, "T02 idempotency key stable");
}

async function T03_distinct_executions(): Promise<void> {
  console.log("\nT03 - distinct executions -> distinct jobs");
  const store = makeStore();
  const a = bindDurableEngineeringJob(store, "exec-1", { projectId: "p", workspaceId: "w", intentRaw: "r" });
  const b = bindDurableEngineeringJob(store, "exec-2", { projectId: "p", workspaceId: "w", intentRaw: "r" });
  ok(a !== b, "T03 different executionId -> different job id");
}

async function main(): Promise<void> {
  console.log("=== Phase 131 - End-to-End Production Execution Integration ===\n");
  console.log("--- 131a: durable engineering identity binding ---");
  await T01_durable_binding();
  await T02_idempotency();
  await T03_distinct_executions();
  console.log(`\n--- Phase 131: ${passed} passed, ${failed} failed ---`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error("PHASE131 DRIVER CRASH:", err); process.exit(1); });