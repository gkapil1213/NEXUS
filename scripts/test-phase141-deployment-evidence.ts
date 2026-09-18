import Database from "better-sqlite3";
import { join } from "path";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { MigrationRunner } from "../src/core/migration-runner";
import { ExecutionStore } from "../src/core/execution-store";
import { EventService } from "../src/core/events";
import { AuditService } from "../src/core/audit";
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

const RELEASE_ID = "phase141-release";
const EXEC_ID = RELEASE_ID;
const ARTIFACT_ID = "phase141-artifact";
const DIGEST = "sha256:" + "b".repeat(64);
const COMMIT = "phase141-commit";
const ENV = "production";
const PROJECT = "phase141-project";
const REPOSITORY = "phase141/repository";
const TAG = "phase141-v1";
const IMAGE_ID = "phase141-image";
const CONTAINER = "phase141-container";
const PORT = 8080;

let passed = 0;
let failed = 0;

function ok(condition: unknown, message: string): void {
  if (condition) {
    passed++;
    console.log("  PASS:", message);
  } else {
    failed++;
    console.error("  FAIL:", message);
  }
}

class AttemptRecordingProvider implements ReleaseExecutionProvider {
  calls: ReleaseExecutionRequest[] = [];

  async execute(req: ReleaseExecutionRequest): Promise<ReleaseExecutionOutcome> {
    this.calls.push(req);

    return {
      status: "DEPLOYED",
      message: "phase141 evidence test provider",
      deploymentId: "dep-phase141-" + this.calls.length,
    };
  }
}

interface Harness {
  engine: SQLiteEngine;
  store: ExecutionStore;
  intents: ReleaseDeploymentIntentService;
  events: EventService;
  audit: AuditService;
  bridge: ReleaseDeploymentBridge;
  enforcement: ProductionReleaseEnforcementService;
  provider: AttemptRecordingProvider;
}

async function makeHarness(): Promise<Harness> {
  const rawDb = new Database(":memory:");
  const migrationsDir = join(process.cwd(), "src", "db", "migrations");
  new MigrationRunner(rawDb, migrationsDir).run();

  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS nexus_records (
      store TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (store, key)
    );
  `);

  const engine = SQLiteEngine.fromDatabase(rawDb);

  await engine.put("artifacts", ARTIFACT_ID, {
    __content: JSON.stringify({
      digest: "sha256:" + "c".repeat(64),
    }),
  });

  const store = new ExecutionStore(engine as any);

  const events = new EventService(engine as any);
  await events.init();

  const audit = new AuditService(engine as any);

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

  const orchestrator = {
    async deploy(_req: any) {
      return {
        deployment: {
          id: "dep-bridge-phase141",
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
    engine,
    deployments: orchestrator as any,
    artifacts: {
      list: async (_executionId: string) => [
        {
          id: ARTIFACT_ID,
          kind: "IMAGE_DIGEST",
        },
      ],
    } as any,
    svc: {
      events,
      audit,
    } as any,
    intents,
  });

  return {
    engine,
    store,
    intents,
    events,
    audit,
    bridge,
    enforcement,
    provider,
  };
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
    idempotencyKey: "phase141:" + attemptId,
    jobType: "engineering" as any,
    payload: {
      kind: "engineering",
      executionId,
    },
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

function request(attemptId?: string): any {
  return {
    releaseId: RELEASE_ID,
    executionId: EXEC_ID,
    ...(attemptId === undefined ? {} : { attemptId }),
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
  };
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
    throw new Error(
      "Phase 141 setup authorization failed: " + JSON.stringify(r),
    );
  }

  return r.authorization.authorizationId;
}

async function T01_canonicalEventsCarryExactAttempt(): Promise<void> {
  console.log("\nT01 - canonical deployment events carry exact attemptId");

  const h = await makeHarness();
  const attemptId = "phase141-attempt-A";

  seedAttempt(h.store, EXEC_ID, attemptId);

  const result = await h.bridge.execute(request(attemptId));

  ok(result.status !== "BLOCKED", "T01 deployment reaches canonical path");

  const events = await h.events.byAttempt(attemptId);

  ok(events.length >= 1, "T01 attempt query returns canonical events");

  const deploymentStarted = events.find(
    (e) => e.type === "release.deployment_started",
  );

  ok(
    deploymentStarted?.attempt_id === attemptId,
    "T01 deployment_started contains exact attemptId",
  );

  const imageResolved = events.find(
    (e) => e.type === "release.image_digest.resolved",
  );

  ok(
    imageResolved?.attempt_id === attemptId,
    "T01 image_digest.resolved contains exact attemptId",
  );
}

async function T02_byAttemptIsolatesAttempts(): Promise<void> {
  console.log("\nT02 - byAttempt isolates execution attempts");

  const h = await makeHarness();

  const attemptA = "phase141-attempt-A";
  const attemptB = "phase141-attempt-B";

  seedAttempt(h.store, EXEC_ID, attemptA);
  seedAttempt(h.store, EXEC_ID, attemptB);

  await h.bridge.execute(request(attemptA));

  const eventsA = await h.events.byAttempt(attemptA);
  const eventsB = await h.events.byAttempt(attemptB);

  ok(eventsA.length >= 1, "T02 attempt A has events");
  ok(eventsB.length === 0, "T02 attempt B has no attempt-A events");

  ok(
    eventsA.every((e) => e.attempt_id === attemptA),
    "T02 every attempt-A event has exact attempt-A binding",
  );
}

async function T03_auditEvidenceCarriesAttempt(): Promise<void> {
  console.log("\nT03 - canonical deployment audit carries exact attemptId");

  const h = await makeHarness();
  const attemptId = "phase141-audit-attempt";

  seedAttempt(h.store, EXEC_ID, attemptId);

  const result = await h.bridge.execute(request(attemptId));

  ok(result.status !== "BLOCKED", "T03 deployment succeeds");

  const audits = await h.audit.list();

  const deploymentAudit = audits.find(
    (a) =>
      a.action === "release.deployed" &&
      a.resource_type === "deployment" &&
      a.metadata &&
      a.metadata.attempt_id === attemptId,
  );

  ok(
    !!deploymentAudit,
    "T03 deployment audit contains exact attemptId",
  );
}

async function T04_sameExecutionAttemptsRemainSeparated(): Promise<void> {
  console.log("\nT04 - same execution with A/B remains evidence-separated");

  const h = await makeHarness();

  const attemptA = "phase141-same-execution-A";
  const attemptB = "phase141-same-execution-B";

  seedAttempt(h.store, EXEC_ID, attemptA);
  seedAttempt(h.store, EXEC_ID, attemptB);

  await h.bridge.execute(request(attemptA));

  const aEvents = await h.events.byAttempt(attemptA);
  const bEvents = await h.events.byAttempt(attemptB);

  ok(
    aEvents.some((e) => e.execution_id === EXEC_ID),
    "T04 attempt A events retain executionId",
  );

  ok(
    aEvents.every((e) => e.attempt_id === attemptA),
    "T04 attempt A events never bind to attempt B",
  );

  ok(
    bEvents.length === 0,
    "T04 attempt B query remains empty after attempt A deployment",
  );
}

async function T05_legacyAndGlobalEventsRemainValid(): Promise<void> {
  console.log("\nT05 - historical/global events without attemptId remain valid");

  const h = await makeHarness();

  const legacy = await h.events.emit({
    type: "release.ready" as never,
    source: "Phase141LegacyFixture",
    execution_id: EXEC_ID,
    payload: {
      legacy: true,
    },
  } as any);

  ok(
    legacy.attempt_id == null,
    "T05 legacy event has no attemptId",
  );

  const global = await h.events.emit({
    type: "release.ready" as never,
    source: "Phase141GlobalFixture",
    execution_id: null,
    payload: {
      global: true,
    },
  } as any);

  ok(
    global.attempt_id == null,
    "T05 global event remains without attemptId",
  );

  const byExecution = await h.events.byExecution(EXEC_ID);

  ok(
    byExecution.some((e) => e.id === legacy.id),
    "T05 legacy event remains queryable by execution",
  );
}

async function T06_missingAttemptBlockedWithoutEvidence(): Promise<void> {
  console.log("\nT06 - missing attemptId blocks without fake evidence");

  const h = await makeHarness();

  const result = await h.bridge.execute(request());

  ok(
    result.status === "BLOCKED",
    "T06 missing attemptId is BLOCKED",
  );

  ok(
    h.provider.calls.length === 0,
    "T06 provider is not called",
  );

  const events = await h.events.byExecution(EXEC_ID);

  ok(
    events.every((e) => e.attempt_id !== "fake-attempt"),
    "T06 no fabricated attempt evidence exists",
  );
}

async function T07_attemptSpecificIntentRetainsEvidenceBinding(): Promise<void> {
  console.log("\nT07 - durable deployment intent retains attempt binding");

  const h = await makeHarness();

  const attemptId = "phase141-intent-attempt";

  const created = await h.intents.getOrCreate(intentInput(attemptId));
  const loaded = h.intents.get(created.intent.intentKey);

  ok(
    created.intent.attemptId === attemptId,
    "T07 created intent stores exact attemptId",
  );

  ok(
    loaded?.attemptId === attemptId,
    "T07 reloaded intent stores exact attemptId",
  );
}

async function T08_replayMismatchStillBlocked(): Promise<void> {
  console.log("\nT08 - replay/mismatch remains blocked");

  const h = await makeHarness();

  const attemptA = "phase141-replay-A";
  const attemptB = "phase141-replay-B";

  seedAttempt(h.store, EXEC_ID, attemptA);
  seedAttempt(h.store, EXEC_ID, attemptB);

  const authId = await authorize(h);

  const first = await h.enforcement.executeRelease(
    authId,
    RELEASE_ID,
    ARTIFACT_ID,
    COMMIT,
    ENV,
    attemptA,
  );

  ok(first.status === "DEPLOYED", "T08 first exact attempt deploys");

  const second = await h.enforcement.executeRelease(
    authId,
    RELEASE_ID,
    ARTIFACT_ID,
    COMMIT,
    ENV,
    attemptB,
  );

  ok(
    second.status === "BLOCKED",
    "T08 mismatched replay is BLOCKED",
  );

  ok(
    h.provider.calls.length === 1,
    "T08 provider is not called by mismatched replay",
  );
}

async function main(): Promise<void> {
  console.log("=== Phase 141 deployment evidence integrity verification ===");

  await T01_canonicalEventsCarryExactAttempt();
  await T02_byAttemptIsolatesAttempts();
  await T03_auditEvidenceCarriesAttempt();
  await T04_sameExecutionAttemptsRemainSeparated();
  await T05_legacyAndGlobalEventsRemainValid();
  await T06_missingAttemptBlockedWithoutEvidence();
  await T07_attemptSpecificIntentRetainsEvidenceBinding();
  await T08_replayMismatchStillBlocked();

  console.log(
    "\n--- Phase 141 deployment evidence integrity: " +
      passed +
      " passed, " +
      failed +
      " failed ---",
  );

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("PHASE141 DRIVER CRASH:", err);
  process.exit(1);
});




