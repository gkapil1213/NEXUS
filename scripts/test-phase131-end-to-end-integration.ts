// scripts/test-phase131-end-to-end-integration.ts
// Phase 131 - authoritative end-to-end production execution integration.

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

function makeSvcStub(): any {
  return {
    workspaces: {},
    github: {
      async getFile(_o: string, _r: string, _p: string, _ref?: string) {
        return { content: "name: nexus-ci\non:\n  workflow_dispatch:\n    inputs:\n      execution_id: {}\n      attempt: {}\n", sha: "blob-sha" };
      },
    },
  };
}
const fakeActor: any = { id: "u1", email: "test@example.com", role: "owner", status: "active" };

function makeCicdStub(opts: {
  startStatus: "RUNNING" | "BLOCKED" | "SUCCEEDED";
  externalRunId?: string | null;
  blockedReason?: string | null;
  agentValidation?: "VALID" | "INVALID" | "BLOCKED";
  commitSha?: string;
  createCommitThrows?: boolean;
  readBackShaMismatch?: boolean;
}) {
  let submitCalls = 0; let startCalls = 0; let commitCalls = 0;
  let submitLineage: { workflow_file: string; commit_sha: string } | null = null;
  const chosenSha = opts.commitSha ?? "sha-test-789";
  const genContent = "name: nexus-ci\non:\n  workflow_dispatch:\n    inputs:\n      execution_id: {}\n      attempt: {}\n";
  const stub: any = {
    agent: {
      async run() {
        return {
          detection: {}, plan: {},
          config: { provider: "github", filename: ".github/workflows/nexus-ci.yml", content: genContent, digest: "sha256:fake" },
          validation: { verdict: opts.agentValidation ?? "VALID", findings: [] },
          configArtifactId: "art-cfg", validationArtifactId: "art-val",
        };
      },
    },
    validator: {},
    github: {
      async getRepository() { return { full_name: "owner/repo", default_branch: "main", is_private: false }; },
      async getCommit(_o: string, _r: string, sha: string) {
        return { sha: opts.readBackShaMismatch ? "different-sha" : sha, message: "m", author: "t" };
      },
      async createCommit() {
        commitCalls++;
        if (opts.createCommitThrows) throw new Error("network down");
        return { sha: chosenSha, message: "m", author: "test" };
      },
    },
    gitlab: {},
    engine: {
      async submitRun(_ctx: any, provider: any, repo: string, ref: string, lineage?: any) {
        submitCalls++; submitLineage = lineage ?? null;
        const run: any = { id: "cirun-1", provider, repository: repo, ref, status: "QUEUED", external_run_id: null, blocked_reason: null };
        if (lineage) { run.workflow_file = lineage.workflow_file; run.commit_sha = lineage.commit_sha; }
        return { run, created: true };
      },
      async startRun(run: any) {
        startCalls++;
        return { ...run, status: opts.startStatus, external_run_id: opts.externalRunId ?? null, blocked_reason: opts.blockedReason ?? null };
      },
      async recordGitOp() { return { id: "gitop-1" }; },
    },
  };
  return { stub, getSubmitCalls: () => submitCalls, getStartCalls: () => startCalls, getCommitCalls: () => commitCalls, getSubmitLineage: () => submitLineage };
}

async function T04_ci_absent(): Promise<void> {
  console.log("\nT04 - CI engine absent -> BLOCKED");
  const plan = makePlan({ deploySignal: true, repository: "owner/repo", ref: "nexus/devops/exec-test" });
  const r = await handoffToCI(makeSvcStub(), undefined, fakeCtx, plan, "PASSED", fakeActor);
  ok(r.verdict === "BLOCKED", "T04 verdict BLOCKED");
  ok(r.ci !== null, "T04 ci populated");
  ok(r.ci?.status === "BLOCKED", "T04 ci.status BLOCKED");
  ok(/no CI\/CD engine/i.test(r.ci?.blockedReason ?? ""), "T04 blockedReason honest");
}

async function T05_no_git_target(): Promise<void> {
  console.log("\nT05 - no repository/ref -> BLOCKED");
  const c = makeCicdStub({ startStatus: "RUNNING" });
  const plan = makePlan({ deploySignal: true });
  const r = await handoffToCI(makeSvcStub(), c.stub, fakeCtx, plan, "PASSED", fakeActor);
  ok(r.verdict === "BLOCKED", "T05 verdict BLOCKED");
  ok(/no repository/i.test(r.ci?.blockedReason ?? ""), "T05 blockedReason mentions repository");
  ok(c.getSubmitCalls() === 0, "T05 no CI dispatch attempted");
}

async function T06_happy_path_running(): Promise<void> {
  console.log("\nT06 - CI dispatched, RUNNING preserved");
  const c = makeCicdStub({ startStatus: "RUNNING", externalRunId: "gh-123" });
  const plan = makePlan({ deploySignal: true, repository: "owner/repo", ref: "nexus/devops/exec-test" });
  const r = await handoffToCI(makeSvcStub(), c.stub, fakeCtx, plan, "PASSED", fakeActor);
  ok(r.verdict === "PASSED", "T06 verdict PASSED");
  ok(r.ci?.status === "RUNNING", "T06 ci.status RUNNING");
  ok(r.ci?.externalRunId === "gh-123", "T06 externalRunId captured");
  ok(c.getSubmitCalls() === 1, "T06 one submitRun");
  ok(c.getStartCalls() === 1, "T06 one startRun");
}

async function T06b_lineage_propagation(): Promise<void> {
  console.log("\nT06b - lineage propagated + plan.commitSha filled");
  const c = makeCicdStub({ startStatus: "RUNNING", externalRunId: "gh-456", commitSha: "sha-test-789" });
  const plan = makePlan({ deploySignal: true, repository: "owner/repo", ref: "nexus/devops/exec-test" });
  const r = await handoffToCI(makeSvcStub(), c.stub, fakeCtx, plan, "PASSED", fakeActor);
  ok(r.verdict === "PASSED", "T06b verdict PASSED");
  ok(plan.commitSha === "sha-test-789", "T06b plan.commitSha filled");
  ok(c.getSubmitLineage()?.commit_sha === "sha-test-789", "T06b lineage propagated");
  ok(c.getCommitCalls() === 1, "T06b one createCommit");
}

async function T07_no_deploy_signal(): Promise<void> {
  console.log("\nT07 - no deploy signal -> ci null");
  const c = makeCicdStub({ startStatus: "RUNNING" });
  const plan = makePlan({ deploySignal: false, repository: "owner/repo", ref: "nexus/devops/exec-test" });
  const r = await handoffToCI(makeSvcStub(), c.stub, fakeCtx, plan, "PASSED", fakeActor);
  ok(r.ci === null, "T07 no CI dispatch");
  ok(r.verdict === "PASSED", "T07 verdict unchanged");
  ok(c.getSubmitCalls() === 0, "T07 no submit call");
}

async function T15_invalid_validation(): Promise<void> {
  console.log("\nT15 - INVALID validation -> BLOCKED");
  const c = makeCicdStub({ startStatus: "RUNNING", agentValidation: "INVALID" });
  const plan = makePlan({ deploySignal: true, repository: "owner/repo", ref: "nexus/devops/exec-test" });
  const r = await handoffToCI(makeSvcStub(), c.stub, fakeCtx, plan, "PASSED", fakeActor);
  ok(r.verdict === "BLOCKED", "T15 BLOCKED");
  ok(/failed validation/i.test(r.ci?.blockedReason ?? ""), "T15 reason");
  ok(c.getCommitCalls() === 0, "T15 no commit");
}

async function T16_commit_failure(): Promise<void> {
  console.log("\nT16 - commit failure -> BLOCKED");
  const c = makeCicdStub({ startStatus: "RUNNING", createCommitThrows: true });
  const plan = makePlan({ deploySignal: true, repository: "owner/repo", ref: "nexus/devops/exec-test" });
  const r = await handoffToCI(makeSvcStub(), c.stub, fakeCtx, plan, "PASSED", fakeActor);
  ok(r.verdict === "BLOCKED", "T16 BLOCKED");
  ok(/commit failed/i.test(r.ci?.blockedReason ?? ""), "T16 reason");
}

async function T17_default_branch_rejected(): Promise<void> {
  console.log("\nT17 - ref === default branch -> BLOCKED");
  const c = makeCicdStub({ startStatus: "RUNNING" });
  const plan = makePlan({ deploySignal: true, repository: "owner/repo", ref: "main" });
  const r = await handoffToCI(makeSvcStub(), c.stub, fakeCtx, plan, "PASSED", fakeActor);
  ok(r.verdict === "BLOCKED", "T17 BLOCKED");
  ok(/protected branch|default branch/i.test(r.ci?.blockedReason ?? ""), "T17 reason");
  ok(c.getCommitCalls() === 0, "T17 no commit");
}

async function T18_content_mismatch(): Promise<void> {
  console.log("\nT18 - feature content mismatch -> BLOCKED");
  const svc = makeSvcStub();
  svc.github.getFile = async (_o: string, _r: string, _p: string, ref?: string) => ref ? { content: "different", sha: "b" } : { content: "name: nexus-ci\n", sha: "b" };
  const c = makeCicdStub({ startStatus: "RUNNING" });
  const plan = makePlan({ deploySignal: true, repository: "owner/repo", ref: "nexus/devops/exec-test" });
  const r = await handoffToCI(svc, c.stub, fakeCtx, plan, "PASSED", fakeActor);
  ok(r.verdict === "BLOCKED", "T18 BLOCKED");
  ok(/content mismatch/i.test(r.ci?.blockedReason ?? ""), "T18 reason");
}

async function T19_default_missing(): Promise<void> {
  console.log("\nT19 - default workflow missing -> BLOCKED");
  const svc = makeSvcStub();
  svc.github.getFile = async (_o: string, _r: string, _p: string, ref?: string) => ref ? { content: "name: nexus-ci\non:\n  workflow_dispatch:\n    inputs:\n      execution_id: {}\n      attempt: {}\n", sha: "b" } : null;
  const c = makeCicdStub({ startStatus: "RUNNING" });
  const plan = makePlan({ deploySignal: true, repository: "owner/repo", ref: "nexus/devops/exec-test" });
  const r = await handoffToCI(svc, c.stub, fakeCtx, plan, "PASSED", fakeActor);
  ok(r.verdict === "BLOCKED", "T19 BLOCKED");
  ok(/not present on default branch/i.test(r.ci?.blockedReason ?? ""), "T19 reason");
}

async function T20_default_no_dispatch(): Promise<void> {
  console.log("\nT20 - default workflow without dispatch -> BLOCKED");
  const svc = makeSvcStub();
  const genContent = "name: nexus-ci\non:\n  workflow_dispatch:\n    inputs:\n      execution_id: {}\n      attempt: {}\n";
  svc.github.getFile = async (_o: string, _r: string, _p: string, ref?: string) =>
    ref ? { content: genContent, sha: "b" } : { content: "name: nexus-ci\non:\n  push:\n    branches: [ main ]\n", sha: "b" };
  const c = makeCicdStub({ startStatus: "RUNNING" });
  const plan = makePlan({ deploySignal: true, repository: "owner/repo", ref: "nexus/devops/exec-test" });
  const r = await handoffToCI(svc, c.stub, fakeCtx, plan, "PASSED", fakeActor);
  ok(r.verdict === "BLOCKED", "T20 BLOCKED");
  ok(/workflow_dispatch/i.test(r.ci?.blockedReason ?? ""), "T20 reason");
}

async function T21_readback_mismatch(): Promise<void> {
  console.log("\nT21 - read-back SHA mismatch -> BLOCKED");
  const c = makeCicdStub({ startStatus: "RUNNING", readBackShaMismatch: true });
  const plan = makePlan({ deploySignal: true, repository: "owner/repo", ref: "nexus/devops/exec-test" });
  const r = await handoffToCI(makeSvcStub(), c.stub, fakeCtx, plan, "PASSED", fakeActor);
  ok(r.verdict === "BLOCKED", "T21 BLOCKED");
  ok(/read-back mismatch/i.test(r.ci?.blockedReason ?? ""), "T21 reason");
}

// ---- 131c release tests ----

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
}

async function T11_release_happy_path(): Promise<void> {
  console.log("\nT11 - happy path -> DEPLOYED");
  const h = makeReleaseSvc();
  const r = await handoffToRelease(h.svc, makeReleasePlan(), "exe-1", "SUCCEEDED", "PASSED");
  ok(r.verdict === "PASSED", "T11 verdict PASSED");
  ok(r.deployment?.status === "DEPLOYED", "T11 deployment DEPLOYED");
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
  await T06b_lineage_propagation();
  await T07_no_deploy_signal();
  await T15_invalid_validation();
  await T16_commit_failure();
  await T17_default_branch_rejected();
  await T18_content_mismatch();
  await T19_default_missing();
  await T20_default_no_dispatch();
  await T21_readback_mismatch();
  console.log("\n--- 131c: release + deploy handoff ---");
  await T08_release_ci_not_succeeded();
  await T09_release_no_digest();
  await T10_release_approval_mismatch();
  await T11_release_happy_path();
  console.log(`\n--- Phase 131: ${passed} passed, ${failed} failed ---`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error("PHASE131 DRIVER CRASH:", err); process.exit(1); });
