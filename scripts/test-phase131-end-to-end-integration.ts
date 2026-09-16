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
import { bindDurableEngineeringJob, handoffToCI, handoffToRelease } from "../src/core/engineering";

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
function makeReleasePlan(overrides: Partial<EngineeringPlan> = {}): EngineeringPlan {
  return {
    id: "plan-test",
    intent: { raw: "x", subject: "x", scope: "small", words: 1,
      signals: [{ id: "deploy", label: "Deploy", matched: ["deploy"] }] },
    project: { id: "proj-1", name: "test" },
    workspaceId: "ws-1",
    repository: "owner/repo", ref: "main",
    environment: "staging", commitSha: "sha-1",
    containerName: "c1", containerPort: 8080,
    approval: {
      releaseId: "exe-1", artifactId: "art-1",
      artifactDigest: "sha256:" + "a".repeat(64),
      environment: "staging", approver: "alice",
      approvedAt: new Date().toISOString(), status: "APPROVED",
    },
    detection: {} as any, buildPlan: {} as any, buildValidation: {} as any,
    capabilities: {} as any, stages: [], readyCount: 0, blockedCount: 0,
    createdAt: Date.now(), ...overrides,
  } as EngineeringPlan;
}

function makeReleaseSvc(opts: { digest?: string | null; authStatus?: "AUTHORIZED" | "BLOCKED" | "FAIL"; execStatus?: "DEPLOYED" | "BLOCKED" | "FAIL"; } = {}) {
  const digest = opts.digest === undefined ? ("sha256:" + "a".repeat(64)) : opts.digest;
  let requestCalls = 0;
  let execCalls = 0;
  const svc: any = {
    artifacts: { async list(_eid: string) { return digest ? [{ id: "art-1", kind: "IMAGE_DIGEST", digest }] : []; } },
    engine: { async get(_coll: string, _id: string) {
      if (!digest) return undefined;
      return { __content: JSON.stringify({ digest, repository: "reg/app", tag: "v1", image: "reg/app:v1", immutable_reference: "reg/app@" + digest }) };
    } },
    releaseEnforcement: {
      async requestRelease(_req: any) {
        requestCalls++;
        if (opts.authStatus === "AUTHORIZED" || opts.authStatus === undefined)
          return { status: "AUTHORIZED", authorization: { authorizationId: "auth-1" }, blockers: [], reasons: [] };
        return { status: opts.authStatus, blockers: [], reasons: ["denied for test"] };
      },
      async executeRelease(_a: string, _r: string, _art: string, _sha: string, _env: string) {
        execCalls++;
        const status = opts.execStatus ?? "DEPLOYED";
        return { status, message: status === "DEPLOYED" ? "ok" : "test " + status, providerAvailable: true, deploymentId: status === "DEPLOYED" ? "dep-1" : undefined };
      },
    },
  };
  return { svc, getRequestCalls: () => requestCalls, getExecCalls: () => execCalls };
}

async function T08_release_ci_not_succeeded(): Promise<void> {
  console.log("\nT08 - CI not SUCCEEDED -> BLOCKED");
  const h = makeReleaseSvc();
  const r = await handoffToRelease(h.svc, makeReleasePlan(), "exe-1", "RUNNING", "PASSED");
  ok(r.verdict === "BLOCKED", "T08 verdict BLOCKED");
  ok(r.deployment?.blockedReason === "CI_NOT_SUCCESSFUL", "T08 blocked CI_NOT_SUCCESSFUL");
  ok(h.getRequestCalls() === 0, "T08 no requestRelease call");
}

async function T09_release_no_digest(): Promise<void> {
  console.log("\nT09 - no IMAGE_DIGEST -> BLOCKED");
  const h = makeReleaseSvc({ digest: null });
  const r = await handoffToRelease(h.svc, makeReleasePlan(), "exe-1", "SUCCEEDED", "PASSED");
  ok(r.verdict === "BLOCKED", "T09 verdict BLOCKED");
  ok(r.deployment?.blockedReason === "NO_REGISTRY_DIGEST", "T09 blocked NO_REGISTRY_DIGEST");
}

async function T10_release_approval_mismatch(): Promise<void> {
  console.log("\nT10 - approval wrong digest -> BLOCKED");
  const h = makeReleaseSvc();
  const plan = makeReleasePlan({ approval: {
    releaseId: "exe-1", artifactId: "art-1",
    artifactDigest: "sha256:" + "b".repeat(64),
    environment: "staging", approver: "alice",
    approvedAt: new Date().toISOString(), status: "APPROVED",
  }});
  const r = await handoffToRelease(h.svc, plan, "exe-1", "SUCCEEDED", "PASSED");
  ok(r.verdict === "BLOCKED", "T10 verdict BLOCKED");
  ok(r.deployment?.blockedReason === "APPROVAL_MISMATCH", "T10 blocked APPROVAL_MISMATCH");
  ok(h.getRequestCalls() === 0, "T10 no requestRelease call");
}

async function T11_release_happy_path(): Promise<void> {
  console.log("\nT11 - happy path -> DEPLOYED");
  const h = makeReleaseSvc({ authStatus: "AUTHORIZED", execStatus: "DEPLOYED" });
  const r = await handoffToRelease(h.svc, makeReleasePlan(), "exe-1", "SUCCEEDED", "PASSED");
  ok(r.verdict === "PASSED", "T11 verdict PASSED");
  ok(r.deployment?.status === "DEPLOYED", "T11 deployment DEPLOYED");
  ok(r.deployment?.deploymentId === "dep-1", "T11 deploymentId recorded");
  ok(h.getRequestCalls() === 1, "T11 one requestRelease");
  ok(h.getExecCalls() === 1, "T11 one executeRelease");
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
  console.log("\n--- 131c: release + deploy handoff ---");
  await T08_release_ci_not_succeeded();
  await T09_release_no_digest();
  await T10_release_approval_mismatch();
  await T11_release_happy_path();
  console.log(`\n--- Phase 131: ${passed} passed, ${failed} failed ---`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error("PHASE131 DRIVER CRASH:", err); process.exit(1); });