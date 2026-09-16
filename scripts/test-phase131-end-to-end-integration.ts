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
import { bindDurableEngineeringJob, handoffToCI } from "../src/core/engineering";

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


function makePlan(opts: { deploySignal: boolean; repository?: string; ref?: string }): EngineeringPlan {
  return {
    id: "plan-test",
    intent: {
      raw: "x", subject: "x", scope: "small", words: 1,
      signals: opts.deploySignal ? [{ id: "deploy", label: "Deploy", matched: ["deploy"] }] : [],
    },
    project: { id: "proj-1", name: "test" },
    workspaceId: "ws-1",
    repository: opts.repository,
    ref: opts.ref,
    detection: {} as any,
    buildPlan: {} as any,
    buildValidation: {} as any,
    capabilities: {} as any,
    stages: [],
    readyCount: 0,
    blockedCount: 0,
    createdAt: Date.now(),
  } as EngineeringPlan;
}

const fakeCtx: any = {
  actor: {}, project_id: "p1", execution_id: "e1", attempt: 1,
  correlation_id: "c1", workspace_id: "w1", reader: {}, executor: null,
};

function makeCicdStub(opts: { startStatus: "RUNNING" | "BLOCKED" | "SUCCEEDED"; externalRunId?: string | null; blockedReason?: string | null }) {
  let submitCalls = 0;
  let startCalls = 0;
  const stub: any = {
    agent: {}, validator: {}, github: {}, gitlab: {},
    engine: {
      async submitRun(_ctx: any, provider: any, repo: string, ref: string) {
        submitCalls++;
        return { run: { id: "cirun-1", provider, repository: repo, ref, status: "QUEUED", external_run_id: null, blocked_reason: null }, created: true };
      },
      async startRun(run: any) {
        startCalls++;
        return { ...run, status: opts.startStatus, external_run_id: opts.externalRunId ?? null, blocked_reason: opts.blockedReason ?? null };
      },
    },
  };
  return { stub, getSubmitCalls: () => submitCalls, getStartCalls: () => startCalls };
}

async function T04_ci_absent(): Promise<void> {
  console.log("\nT04 - CI engine absent -> BLOCKED, not PASSED");
  const plan = makePlan({ deploySignal: true, repository: "owner/repo", ref: "main" });
  const r = await handoffToCI(undefined, fakeCtx, plan, "PASSED");
  ok(r.verdict === "BLOCKED", "T04 verdict downgraded to BLOCKED");
  ok(r.ci !== null, "T04 ci populated");
  ok(r.ci?.status === "BLOCKED", "T04 ci.status BLOCKED");
  ok(/no CI\/CD engine/i.test(r.ci?.blockedReason ?? ""), "T04 blockedReason honest");
}

async function T05_no_git_target(): Promise<void> {
  console.log("\nT05 - no repository/ref -> BLOCKED");
  const c = makeCicdStub({ startStatus: "RUNNING" });
  const plan = makePlan({ deploySignal: true });
  const r = await handoffToCI(c.stub, fakeCtx, plan, "PASSED");
  ok(r.verdict === "BLOCKED", "T05 verdict BLOCKED");
  ok(/no repository/i.test(r.ci?.blockedReason ?? ""), "T05 blockedReason mentions repository");
  ok(c.getSubmitCalls() === 0, "T05 no CI dispatch attempted");
}

async function T06_happy_path_running(): Promise<void> {
  console.log("\nT06 - CI dispatched, RUNNING preserved");
  const c = makeCicdStub({ startStatus: "RUNNING", externalRunId: "gh-123" });
  const plan = makePlan({ deploySignal: true, repository: "owner/repo", ref: "main" });
  const r = await handoffToCI(c.stub, fakeCtx, plan, "PASSED");
  ok(r.verdict === "PASSED", "T06 verdict stays PASSED");
  ok(r.ci?.status === "RUNNING", "T06 ci.status RUNNING");
  ok(r.ci?.externalRunId === "gh-123", "T06 externalRunId captured");
  ok(c.getSubmitCalls() === 1, "T06 exactly one submitRun");
  ok(c.getStartCalls() === 1, "T06 exactly one startRun");
}

async function T07_no_deploy_signal(): Promise<void> {
  console.log("\nT07 - no deploy signal -> ci null");
  const c = makeCicdStub({ startStatus: "RUNNING" });
  const plan = makePlan({ deploySignal: false, repository: "owner/repo", ref: "main" });
  const r = await handoffToCI(c.stub, fakeCtx, plan, "PASSED");
  ok(r.ci === null, "T07 no CI dispatch without deploy signal");
  ok(r.verdict === "PASSED", "T07 verdict unchanged");
  ok(c.getSubmitCalls() === 0, "T07 no submit call");
}
async function main(): Promise<void> {
  console.log("=== Phase 131 - End-to-End Production Execution Integration ===\n");
  console.log("--- 131a: durable engineering identity binding ---");
  await T01_durable_binding();
  await T02_idempotency();
  await T03_distinct_executions();
  console.log("\n--- 131b: CI/CD handoff ---");
  await T04_ci_absent();
  await T05_no_git_target();
  await T06_happy_path_running();
  await T07_no_deploy_signal();
  console.log(`\n--- Phase 131: ${passed} passed, ${failed} failed ---`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error("PHASE131 DRIVER CRASH:", err); process.exit(1); });