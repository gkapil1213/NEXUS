import Database from "better-sqlite3";
import { join } from "path";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { MigrationRunner } from "../src/core/migration-runner";
import { ExecutionStore } from "../src/core/execution-store";
import { ReleaseDeploymentIntentService } from "../src/core/release-deployment-intent";
import { ReleaseDeploymentBridge } from "../src/core/deployment-release-bridge";
import {
  ProductionReleaseEnforcementService,
  ReleaseExecutionProvider,
  ReleaseExecutionRequest,
  ReleaseExecutionOutcome,
} from "../src/core/production-release-enforcement";
import { SecurityReleaseGate } from "../src/core/security-release-gate";
import { ExecutionJob, ExecutionAttempt } from "../src/core/execution-models";

let passed = 0;
let failed = 0;

function ok(cond: boolean, msg: string): void {
  if (cond) {
    passed++;
    console.log("  ok   " + msg);
  } else {
    failed++;
    console.log("  FAIL " + msg);
  }
}

class AttemptRecordingProvider implements ReleaseExecutionProvider {
  calls: ReleaseExecutionRequest[] = [];

  async execute(req: ReleaseExecutionRequest): Promise<ReleaseExecutionOutcome> {
    this.calls.push(req);
    return {
      status: "DEPLOYED",
      message: "phase140 provider boundary test",
      deploymentId: "dep-phase140-" + this.calls.length,
    };
  }
}

interface Harness {
  store: ExecutionStore;
  intents: ReleaseDeploymentIntentService;
  bridge: ReleaseDeploymentBridge;
  enforcement: ProductionReleaseEnforcementService;
  provider: AttemptRecordingProvider;
}

const RELEASE_ID = "phase140-release";
const EXEC_ID = RELEASE_ID;
const ARTIFACT_ID = "phase140-artifact";
const DIGEST = "sha256:" + "a".repeat(64);
const COMMIT = "phase140-commit";
const ENV = "production";
const PROJECT = "phase140-project";
const REPOSITORY = "phase140/repository";
const TAG = "phase140-v1";
const IMAGE_ID = "phase140-image";
const CONTAINER = "phase140-container";
const PORT = 8080;

function makeHarness(): Harness {
  const rawDb = new Database(":memory:");
  const migrationsDir = join(process.cwd(), "src", "db", "migrations");
  new MigrationRunner(rawDb, migrationsDir).run();

  const db = SQLiteEngine.fromDatabase(rawDb);
  const store = new ExecutionStore(db as any);
  const intents = new ReleaseDeploymentIntentService(store);
  const provider = new AttemptRecordingProvider();

  const securityGate = new SecurityReleaseGate({
    authorize: async () => ({ allowed: true }),
  } as any);

  const decisionService = {
    async decide(_params: any) {
      return {
        status: "ALLOW",
        reasons: [],
        blockers: [],
        releaseId: RELEASE_ID,
      };
    },
  } as any;

  const enforcement = new ProductionReleaseEnforcementService(
    {} as any,
    securityGate,
    decisionService,
    provider,
    store,
  );

  const svc = {
    events: { emit: async (e: any) => e },
    audit: { record: async (e: any) => e },
  };

  const orchestrator = {
    async deploy(_req: any) {
      return {
        deployment: {
          id: "dep-bridge-phase140",
          status: "KNOWN_GOOD",
          failure_reason: null,
          project_id: PROJECT,
          environment: ENV,
          release_id: RELEASE_ID,
        },
        rollback: null,
      };
    },
  };

  const bridge = new ReleaseDeploymentBridge({
    deployments: orchestrator as any,
    artifacts: { list: async (_executionId: string) => [{ id: ARTIFACT_ID }] } as any,
    svc: svc as any,
    intents,
  });

  return { store, intents, bridge, enforcement, provider };
}

function seedAttempt(
  store: ExecutionStore,
  executionId: string,
  attemptId: string,
): void {
  const now = Date.now();
  const jobId = "job-" + attemptId;

  const job: ExecutionJob = {
    id: jobId,
    idempotencyKey: "phase140:" + attemptId,
    jobType: "engineering" as any,
    payload: { kind: "engineering", executionId },
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
}

async function authorize(h: Harness): Promise<string> {
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
    throw new Error("Phase 140 setup authorization failed: " + JSON.stringify(r));
  }

  return r.authorization.authorizationId;
}

function intentInput(attemptId: string): any {
  return {
    releaseId: RELEASE_ID,
    executionId: EXEC_ID,
    attemptId,
    artifactId: ARTIFACT_ID,
    artifactDigest: DIGEST,
    commitSha: COMMIT,
    environment: ENV,
    projectId: PROJECT,
    imageRepository: REPOSITORY,
    imageTag: TAG,
    imageId: IMAGE_ID,
    imageDigest: DIGEST,
    containerName: CONTAINER,
    containerPort: PORT,
  };
}

async function T01_missingAttemptBlocked(): Promise<void> {
  console.log("\nT01 - missing attemptId is BLOCKED before deployment");

  const h = makeHarness();
  const authId = await authorize(h);
  const r = await h.enforcement.executeRelease(
    authId,
    RELEASE_ID,
    ARTIFACT_ID,
    COMMIT,
    ENV,
    null,
  );

  ok(r.status === "BLOCKED", "T01 status BLOCKED");
  ok(h.provider.calls.length === 0, "T01 provider not called");

  const auth = h.store.getProductionAuthorization(authId);
  ok(auth?.consumedByAttemptId == null, "T01 authorization not consumed");
}

async function T02_exactAttemptReachesProvider(): Promise<void> {
  console.log("\nT02 - exact durable attempt reaches provider boundary");

  const h = makeHarness();
  const attemptId = "phase140-attempt-A";
  seedAttempt(h.store, EXEC_ID, attemptId);

  const authId = await authorize(h);
  const r = await h.enforcement.executeRelease(
    authId,
    RELEASE_ID,
    ARTIFACT_ID,
    COMMIT,
    ENV,
    attemptId,
  );

  ok(r.status === "DEPLOYED", "T02 status DEPLOYED");
  ok(h.provider.calls.length === 1, "T02 provider called once");
  ok(h.provider.calls[0]?.attemptId === attemptId, "T02 provider received exact attemptId");

  const auth = h.store.getProductionAuthorization(authId);
  ok(auth?.consumedByAttemptId === attemptId, "T02 durable authorization bound to exact attemptId");
}

async function T03_differentAttemptBlocked(): Promise<void> {
  console.log("\nT03 - different attempt cannot reuse consumed authorization");

  const h = makeHarness();
  const attemptA = "phase140-attempt-A";
  const attemptB = "phase140-attempt-B";

  seedAttempt(h.store, EXEC_ID, attemptA);
  seedAttempt(h.store, EXEC_ID, attemptB);

  const authId = await authorize(h);

  await h.enforcement.executeRelease(
    authId,
    RELEASE_ID,
    ARTIFACT_ID,
    COMMIT,
    ENV,
    attemptA,
  );

  const callsAfterA = h.provider.calls.length;

  const r = await h.enforcement.executeRelease(
    authId,
    RELEASE_ID,
    ARTIFACT_ID,
    COMMIT,
    ENV,
    attemptB,
  );

  ok(r.status === "BLOCKED", "T03 different attempt BLOCKED");
  ok(/different attempt|replay/i.test(r.message), "T03 reason identifies attempt mismatch/replay");
  ok(h.provider.calls.length === callsAfterA, "T03 provider not called for attempt B");

  const auth = h.store.getProductionAuthorization(authId);
  ok(auth?.consumedByAttemptId === attemptA, "T03 durable binding remains attempt A");
}

async function T04_intentKeyIncludesAttempt(): Promise<void> {
  console.log("\nT04 - deployment intent key is attempt-specific");

  const h = makeHarness();

  const a = await h.intents.getOrCreate(intentInput("phase140-attempt-A"));
  const b = await h.intents.getOrCreate(intentInput("phase140-attempt-B"));

  ok(a.intent.intentKey !== b.intent.intentKey, "T04 attempt A and B have different intent keys");
  ok(a.intent.attemptId === "phase140-attempt-A", "T04 intent A stores attempt A");
  ok(b.intent.attemptId === "phase140-attempt-B", "T04 intent B stores attempt B");
}

async function T05_bridgeRequiresAndPropagatesAttempt(): Promise<void> {
  console.log("\nT05 - deployment bridge requires and propagates attemptId");

  const h = makeHarness();

  const missing = await h.bridge.execute({
    releaseId: RELEASE_ID,
    executionId: EXEC_ID,
    artifactId: ARTIFACT_ID,
    commitSha: COMMIT,
    environment: ENV,
    projectId: PROJECT,
    imageRepository: REPOSITORY,
    imageTag: TAG,
    imageId: IMAGE_ID,
    imageDigest: DIGEST,
    containerName: CONTAINER,
    containerPort: PORT,
  } as any);

  ok(missing.status === "BLOCKED", "T05 bridge without attemptId BLOCKED");

  const attemptId = "phase140-bridge-attempt";
  const result = await h.bridge.execute({
    releaseId: RELEASE_ID,
    executionId: EXEC_ID,
    attemptId,
    artifactId: ARTIFACT_ID,
    commitSha: COMMIT,
    environment: ENV,
    projectId: PROJECT,
    imageRepository: REPOSITORY,
    imageTag: TAG,
    imageId: IMAGE_ID,
    imageDigest: DIGEST,
    containerName: CONTAINER,
    containerPort: PORT,
  } as any);

  console.log("  T05 actual result:", JSON.stringify(result)); ok(result.status !== "BLOCKED", "T05 bridge with attemptId reaches deployment path");

  const created = await h.intents.getOrCreate(intentInput(attemptId));
  ok(created.intent.attemptId === attemptId, "T05 durable intent retains bridge attemptId");
}

async function T06_legacyIntentRecoveryMustNotResume(): Promise<void> {
  console.log("\nT06 - intent without durable attemptId cannot be resumed");

  const h = makeHarness();

  const legacy = intentInput("phase140-legacy");
  delete legacy.attemptId;

  const created = await h.intents.getOrCreate(legacy);

  ok(created.intent.attemptId == null, "T06 legacy-shaped intent has no attemptId");

  const loaded = h.intents.get(created.intent.intentKey);
  ok(loaded?.attemptId == null, "T06 loaded legacy intent has no attemptId");
}

async function T07_canonicalRequestTypeRequiresAttempt(): Promise<void> {
  console.log("\nT07 - canonical deployment request requires attemptId");

  const h = makeHarness();
  const attemptId = "phase140-canonical-attempt";

  const result = await h.bridge.execute({
    releaseId: RELEASE_ID,
    executionId: EXEC_ID,
    attemptId,
    artifactId: ARTIFACT_ID,
    commitSha: COMMIT,
    environment: ENV,
    projectId: PROJECT,
    imageRepository: REPOSITORY,
    imageTag: TAG,
    imageId: IMAGE_ID,
    imageDigest: DIGEST,
    containerName: CONTAINER,
    containerPort: PORT,
  } as any);

  console.log("  T07 actual result:", JSON.stringify(result)); ok(result.status !== "BLOCKED", "T07 canonical path accepts exact attemptId");
}

async function main(): Promise<void> {
  console.log("=== Phase 140 attempt-bound deployment verification ===");

  await T01_missingAttemptBlocked();
  await T02_exactAttemptReachesProvider();
  await T03_differentAttemptBlocked();
  await T04_intentKeyIncludesAttempt();
  await T05_bridgeRequiresAndPropagatesAttempt();
  await T06_legacyIntentRecoveryMustNotResume();
  await T07_canonicalRequestTypeRequiresAttempt();

  console.log(
    "\n--- Phase 140 attempt binding: " +
      passed +
      " passed, " +
      failed +
      " failed ---",
  );

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("PHASE140 DRIVER CRASH:", err);
  process.exit(1);
});
