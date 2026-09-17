// scripts/test-phase138-attempt-authority.ts
// Phase 138 - attempt-authority verification harness.
//
// Proves the production-safety invariant: the durable authorization CAS can
// only consume with a real, verified ExecutionAttempt.id that belongs to the
// requested execution. Uses the real ProductionReleaseEnforcementService,
// real ExecutionStore, real migrations, and a provider test double.

import Database from "better-sqlite3";
import { join } from "path";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { MigrationRunner } from "../src/core/migration-runner";
import { ExecutionStore } from "../src/core/execution-store";
import { SecurityReleaseGate } from "../src/core/security-release-gate";
import {
  ProductionReleaseEnforcementService,
  ReleaseExecutionProvider,
  ReleaseExecutionRequest,
  ReleaseExecutionOutcome,
} from "../src/core/production-release-enforcement";
import { ExecutionJob, ExecutionAttempt } from "../src/core/execution-models";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log("  ok   " + msg); }
  else      { failed++; console.log("  FAIL " + msg); }
}

class TestProvider implements ReleaseExecutionProvider {
  public calls: Array<{
    authorizationId: string;
    releaseId: string;
    artifactId: string;
    commitSha: string;
    environment: string;
  }> = [];
  async execute(req: ReleaseExecutionRequest): Promise<ReleaseExecutionOutcome> {
    this.calls.push({
      authorizationId: req.authorizationId,
      releaseId: req.releaseId,
      artifactId: req.artifactId,
      commitSha: req.commitSha,
      environment: req.environment,
    });
    return { status: "DEPLOYED", message: "test deployed", deploymentId: "dep-test-1" };
  }
}

interface Harness {
  store: ExecutionStore;
  enforcement: ProductionReleaseEnforcementService;
  provider: TestProvider;
}

const RELEASE_ID = "rel-1";
const EXEC_ID = "exec-1";
const ARTIFACT_ID = "art-1";
const DIGEST = "sha256:abc";
const COMMIT = "deadbeef";
const ENV = "production";

function makeHarness(): Harness {
  const rawDb = new Database(":memory:");
  const migrationsDir = join(process.cwd(), "src", "db", "migrations");
  new MigrationRunner(rawDb, migrationsDir).run();
  const db = SQLiteEngine.fromDatabase(rawDb);
  const store = new ExecutionStore(db as any);

  const provider = new TestProvider();
  const securityGate = new SecurityReleaseGate({ authorize: async () => ({ allowed: true }) } as any);
  const decisionService = {
    async decide(_params: any) {
      return { status: "ALLOW", reasons: [], blockers: [], releaseId: RELEASE_ID };
    },
  } as any;

  const enforcement = new ProductionReleaseEnforcementService(
    {} as any,
    securityGate,
    decisionService,
    provider,
    store,
  );
  return { store, enforcement, provider };
}

async function authorizeOne(h: Harness): Promise<string> {
  const r = await h.enforcement.requestRelease({
    releaseId: RELEASE_ID,
    executionId: EXEC_ID,
    artifactId: ARTIFACT_ID,
    artifactDigest: DIGEST,
    commitSha: COMMIT,
    environment: ENV,
    approval: {
      releaseId: RELEASE_ID,
      artifactId: ARTIFACT_ID,
      artifactDigest: DIGEST,
      environment: ENV,
      approvedAt: new Date().toISOString(),
    } as any,
  });
  if (r.status !== "AUTHORIZED" || !r.authorization) {
    throw new Error("test setup: requestRelease failed: " + JSON.stringify(r));
  }
  return r.authorization.authorizationId;
}

function seedJobAndAttempt(store: ExecutionStore, jobExecId: string, attemptId: string): string {
  const now = Date.now();
  const jobId = "job-" + attemptId;
  const job: ExecutionJob = {
    id: jobId,
    idempotencyKey: "test:" + attemptId,
    jobType: "engineering" as any,
    payload: { kind: "engineering", executionId: jobExecId },
    status: "QUEUED" as any,
    createdAt: now,
    updatedAt: now,
    cancellationRequested: false,
    cancellationAcknowledged: false,
  } as any;
  store.createJob(job);
  const attempt: ExecutionAttempt = {
    id: attemptId,
    jobId,
    attemptNumber: 1,
    status: "RUNNING" as any,
    createdAt: now,
  };
  store.createAttempt(attempt);
  return jobId;
}

async function main() {
  console.log("=== Phase 138 attempt authority ===\n");

  console.log("T-A1 - null attemptId -> BLOCKED, no consume, no provider");
  {
    const h = makeHarness();
    const authId = await authorizeOne(h);
    const r = await h.enforcement.executeRelease(authId, RELEASE_ID, ARTIFACT_ID, COMMIT, ENV, null);
    ok(r.status === "BLOCKED", "T-A1 status BLOCKED");
    ok(h.provider.calls.length === 0, "T-A1 provider not called");
    const auth = h.store.getProductionAuthorization(authId);
    ok(auth?.consumedAt == null, "T-A1 authorization not consumed");
    ok(auth?.consumedByAttemptId == null, "T-A1 consumed_by_attempt_id NULL");
  }

  console.log("\nT-A2 - real durable attempt -> CAS binds to exact attempt ID");
  {
    const h = makeHarness();
    const authId = await authorizeOne(h);
    seedJobAndAttempt(h.store, RELEASE_ID, "attempt-real-001");
    const r = await h.enforcement.executeRelease(authId, RELEASE_ID, ARTIFACT_ID, COMMIT, ENV, "attempt-real-001");
    ok(r.status === "DEPLOYED", "T-A2 status DEPLOYED");
    ok(h.provider.calls.length === 1, "T-A2 provider called once");
    ok(h.provider.calls[0]?.releaseId === RELEASE_ID, "T-A2 provider received releaseId");
    ok(h.provider.calls[0]?.authorizationId === authId, "T-A2 provider received authorizationId");
    const auth = h.store.getProductionAuthorization(authId);
    ok(auth?.consumedByAttemptId === "attempt-real-001", "T-A2 consumed_by_attempt_id = attempt-real-001");
    ok(auth?.consumedAt != null, "T-A2 consumedAt set");
  }

  console.log("\nT-A3 - same attempt retry does not corrupt durable binding");
  {
    const h = makeHarness();
    const authId = await authorizeOne(h);
    seedJobAndAttempt(h.store, RELEASE_ID, "attempt-real-001");
    await h.enforcement.executeRelease(authId, RELEASE_ID, ARTIFACT_ID, COMMIT, ENV, "attempt-real-001");
    const r = await h.enforcement.executeRelease(authId, RELEASE_ID, ARTIFACT_ID, COMMIT, ENV, "attempt-real-001");
    ok(r.status === "DEPLOYED", "T-A3 retry succeeds (not replay-blocked)");
    const auth = h.store.getProductionAuthorization(authId);
    ok(auth?.consumedByAttemptId === "attempt-real-001", "T-A3 attempt ID unchanged");
    ok(auth?.consumedAt != null, "T-A3 still consumed");
  }

  console.log("\nT-A4 - different attempt ID -> BLOCKED replay");
  {
    const h = makeHarness();
    const authId = await authorizeOne(h);
    seedJobAndAttempt(h.store, RELEASE_ID, "attempt-real-001");
    seedJobAndAttempt(h.store, RELEASE_ID, "attempt-real-002");
    await h.enforcement.executeRelease(authId, RELEASE_ID, ARTIFACT_ID, COMMIT, ENV, "attempt-real-001");
    const callsAfterFirst = h.provider.calls.length;
    const r = await h.enforcement.executeRelease(authId, RELEASE_ID, ARTIFACT_ID, COMMIT, ENV, "attempt-real-002");
    ok(r.status === "BLOCKED", "T-A4 status BLOCKED");
    ok(/replay|different attempt/i.test(r.message), "T-A4 reason mentions replay/different attempt");
    ok(h.provider.calls.length === callsAfterFirst, "T-A4 provider not called for second attempt");
    const auth = h.store.getProductionAuthorization(authId);
    ok(auth?.consumedByAttemptId === "attempt-real-001", "T-A4 attempt ID not overwritten");
  }

  console.log("\nT-A5 - synthetic string is not a durable ExecutionAttempt");
  {
    const h = makeHarness();
    const authId = await authorizeOne(h);
    const synthetic = "attempt_release_artifact_sha_environment";
    const r = await h.enforcement.executeRelease(authId, RELEASE_ID, ARTIFACT_ID, COMMIT, ENV, synthetic);
    ok(r.status === "BLOCKED", "T-A5 status BLOCKED");
    ok(/not a durable ExecutionAttempt/i.test(r.message), "T-A5 reason names durable ExecutionAttempt");
    ok(h.provider.calls.length === 0, "T-A5 provider not called");
    const auth = h.store.getProductionAuthorization(authId);
    ok(auth?.consumedByAttemptId == null, "T-A5 not consumed by synthetic ID");
  }

  console.log("\nT-A6 - attempt from a different execution -> BLOCKED ownership mismatch");
  {
    const h = makeHarness();
    const authId = await authorizeOne(h);
    seedJobAndAttempt(h.store, "different-execution", "attempt-other");
    const r = await h.enforcement.executeRelease(authId, RELEASE_ID, ARTIFACT_ID, COMMIT, ENV, "attempt-other");
    ok(r.status === "BLOCKED", "T-A6 status BLOCKED");
    ok(/does not belong to execution/i.test(r.message), "T-A6 reason mentions ownership");
    ok(h.provider.calls.length === 0, "T-A6 provider not called");
    const auth = h.store.getProductionAuthorization(authId);
    ok(auth?.consumedByAttemptId == null, "T-A6 not consumed");
  }

  console.log("\nT-A7 - engineering caller passes null -> BLOCKED, no fabrication");
  {
    // Mirrors engineering.ts:1360 where the release handoff passes null today.
    const h = makeHarness();
    const authId = await authorizeOne(h);
    const r = await h.enforcement.executeRelease(authId, RELEASE_ID, ARTIFACT_ID, COMMIT, ENV, null);
    ok(r.status === "BLOCKED", "T-A7 status BLOCKED");
    ok(h.provider.calls.length === 0, "T-A7 provider not called");
    const auth = h.store.getProductionAuthorization(authId);
    ok(auth?.consumedByAttemptId == null, "T-A7 no synthetic identity stored");
    ok(auth?.consumedAt == null, "T-A7 authorization not consumed");
  }

  console.log("\nT-A8 - worker caller passes null -> BLOCKED, no fabrication");
  {
    // Mirrors worker-autonomous-cicd-orchestrator.ts:513 where executeRelease
    // is invoked with null today (no durable ExecutionAttempt available).
    const h = makeHarness();
    const authId = await authorizeOne(h);
    const r = await h.enforcement.executeRelease(authId, RELEASE_ID, ARTIFACT_ID, COMMIT, ENV, null);
    ok(r.status === "BLOCKED", "T-A8 status BLOCKED");
    ok(h.provider.calls.length === 0, "T-A8 provider not called");
    const auth = h.store.getProductionAuthorization(authId);
    ok(auth?.consumedByAttemptId == null, "T-A8 no synthetic identity stored");
    ok(auth?.consumedAt == null, "T-A8 authorization not consumed");
  }

  console.log("\n--- Phase 138 attempt authority: " + passed + " passed, " + failed + " failed ---");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error("PHASE138-ATTEMPT DRIVER CRASH:", err); process.exit(1); });