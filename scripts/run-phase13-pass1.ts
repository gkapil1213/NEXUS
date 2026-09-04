import Database from "better-sqlite3";
import { ExecutionStore } from "../src/core/execution-store";
import { ExecutionStateMachine } from "../src/core/execution-state-machine";
import { WorkerRegistry } from "../src/core/worker-registry";
import { LeaseManager } from "../src/core/lease-manager";
import { RetryEngine } from "../src/core/retry-engine";
import { ExecutionEngine } from "../src/core/execution-engine";
import { ArtifactStore } from "../src/core/artifact-store";
import { ReleaseManager } from "../src/core/release-manager";
import { DeploymentGates } from "../src/core/deployment-gates";
import { FunctionDeploymentVerifier } from "../src/core/deployment-verifier";
import { RollbackManager } from "../src/core/rollback-manager";
import { ApprovalGate } from "../src/core/approval-gate";
import { DeploymentManager } from "../src/core/deployment-manager";
import { RecoveryStore } from "../src/core/recovery-store";
import { RecoveryPolicyEngine } from "../src/core/recovery-policy-engine";
import { RecoveryAgent } from "../src/core/recovery-agent";
import { IncidentAnalysis } from "../src/core/incident-analysis";
import { RecoveryOrchestrator } from "../src/core/recovery-orchestrator";
import { PredicateRecoveryVerifier } from "../src/core/recovery-verifier";

// helper: create a fresh in-memory DB with both Phase 11/12 and Phase 13 tables
function createTestDb() {
  const db = new Database(":memory:");
  // Phase 11/12 tables (simplified)
  db.exec(`
    CREATE TABLE recovery_policies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      target_type TEXT NOT NULL,
      conditions TEXT NOT NULL,
      actions TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE recovery_jobs (
      id TEXT PRIMARY KEY,
      policy_id TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      error TEXT,
      result TEXT
    );
    CREATE TABLE recovery_attempts (
      id TEXT PRIMARY KEY,
      incident_id TEXT NOT NULL,
      attempt_number INTEGER NOT NULL,
      action_json TEXT NOT NULL,
      decision TEXT NOT NULL,
      status TEXT NOT NULL,
      verification_result INTEGER,
      evidence_json TEXT NOT NULL,
      error TEXT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      idempotency_key TEXT UNIQUE NOT NULL
    );
  `);
  // Phase 13 tables
  db.exec(`
    CREATE TABLE execution_jobs (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT UNIQUE NOT NULL,
      job_type TEXT NOT NULL,
      payload TEXT,
      status TEXT NOT NULL,
      retry_policy TEXT,
      timeout_ms INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_attempt_at INTEGER,
      next_attempt_at INTEGER,
      current_lease_id TEXT,
      cancellation_requested INTEGER DEFAULT 0,
      cancellation_acknowledged INTEGER DEFAULT 0
    );
    CREATE TABLE execution_attempts (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      attempt_number INTEGER NOT NULL,
      status TEXT NOT NULL,
      worker_id TEXT,
      lease_id TEXT,
      started_at INTEGER,
      completed_at INTEGER,
      error TEXT,
      evidence TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (job_id) REFERENCES execution_jobs(id)
    );
    CREATE TABLE execution_workers (
      worker_id TEXT PRIMARY KEY,
      hostname TEXT,
      capabilities TEXT,
      status TEXT NOT NULL,
      last_heartbeat_at INTEGER,
      current_job_id TEXT,
      registered_at INTEGER NOT NULL
    );
    CREATE TABLE execution_leases (
      lease_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      acquired_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      renewed_at INTEGER,
      released_at INTEGER,
      status TEXT NOT NULL,
      FOREIGN KEY (job_id) REFERENCES execution_jobs(id)
    );
    CREATE TABLE execution_artifacts (
      artifact_id TEXT PRIMARY KEY,
      job_id TEXT,
      release_id TEXT,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      size_bytes INTEGER,
      checksum TEXT NOT NULL,
      storage_ref TEXT,
      metadata TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE execution_releases (
      release_id TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      build_info TEXT,
      artifact_id TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE execution_deployments (
      deployment_id TEXT PRIMARY KEY,
      release_id TEXT NOT NULL,
      environment TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      rollback_deployment_id TEXT,
      evidence TEXT
    );
    CREATE TABLE execution_approvals (
      approval_id TEXT PRIMARY KEY,
      deployment_id TEXT NOT NULL,
      release_id TEXT NOT NULL,
      environment TEXT NOT NULL,
      requested_action TEXT NOT NULL,
      decision TEXT NOT NULL,
      decided_at INTEGER,
      decided_by TEXT,
      reason TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (deployment_id) REFERENCES execution_deployments(deployment_id)
    );
    CREATE TABLE execution_events (
      event_id TEXT PRIMARY KEY,
      job_id TEXT,
      deployment_id TEXT,
      event_type TEXT NOT NULL,
      payload TEXT,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

// Helper to create standard components
function setup(db: Database.Database) {
  const store = new ExecutionStore(db);
  const workerRegistry = new WorkerRegistry(store);
  const leaseManager = new LeaseManager(store);
  const retryEngine = new RetryEngine();
  const engine = new ExecutionEngine(store, workerRegistry, leaseManager, retryEngine);
  return { store, workerRegistry, leaseManager, retryEngine, engine };
}

let passed = 0;
const total = 30;
const results: string[] = [];

function check(testName: string, condition: boolean) {
  if (condition) {
    passed++;
    results.push(`PASS: ${testName}`);
  } else {
    results.push(`FAIL: ${testName}`);
  }
}

async function run() {
  console.log("=== Phase 13 Pass 1: Durable Execution and Deployment Safety ===\n");

  // TEST 1: create execution job
  {
    const db = createTestDb();
    const { engine } = setup(db);
    const job = engine.createJob("test", { foo: "bar" }, "idem1", { maxAttempts: 3, initialDelayMs: 10, multiplier: 2, maxDelayMs: 100 });
    check("create execution job", job.status === "QUEUED" && job.idempotencyKey === "idem1");
  }

  // TEST 2: persist job
  {
    const db = createTestDb();
    const { store, engine } = setup(db);
    engine.createJob("test", { foo: "bar" }, "idem2", { maxAttempts: 3, initialDelayMs: 10, multiplier: 2, maxDelayMs: 100 });
    const fetched = store.getJobByIdempotencyKey("idem2");
    check("persist job", !!fetched && fetched.status === "QUEUED");
  }

  // TEST 3: worker registration
  {
    const db = createTestDb();
    const { store, workerRegistry } = setup(db);
    const worker = { workerId: "w1", hostname: "host1", capabilities: ["test"], status: "ONLINE" as const, registeredAt: Date.now() };
    workerRegistry.register(worker);
    const fetched = store.getWorker("w1");
    check("worker registration", !!fetched && fetched.status === "ONLINE");
  }

  // TEST 4: worker heartbeat
  {
    const db = createTestDb();
    const { workerRegistry } = setup(db);
    const worker = { workerId: "w1", hostname: "host1", status: "ONLINE" as const, registeredAt: Date.now() };
    workerRegistry.register(worker);
    workerRegistry.heartbeat("w1", undefined, Date.now());
    const fetched = workerRegistry.listWorkers("ONLINE")[0];
    check("worker heartbeat", !!fetched && fetched.lastHeartbeatAt !== undefined);
  }

  // TEST 5: lease acquisition
  {
    const db = createTestDb();
    const { engine, leaseManager } = setup(db);
    const job = engine.createJob("test", {}, "idem5", { maxAttempts: 3, initialDelayMs: 10, multiplier: 2, maxDelayMs: 100 });
    const lease = leaseManager.acquireLease(job.id, "w1", 60000);
    check("lease acquisition", lease.status === "ACTIVE" && lease.jobId === job.id);
  }

  // TEST 6: duplicate lease prevention
  {
    const db = createTestDb();
    const { engine, leaseManager } = setup(db);
    const job = engine.createJob("test", {}, "idem6", { maxAttempts: 3, initialDelayMs: 10, multiplier: 2, maxDelayMs: 100 });
    leaseManager.acquireLease(job.id, "w1", 60000);
    let duplicate = false;
    try {
      leaseManager.acquireLease(job.id, "w2", 60000);
    } catch {
      duplicate = true;
    }
    check("duplicate lease prevention", duplicate);
  }

  // TEST 7: lease renewal
  {
    const db = createTestDb();
    const { engine, leaseManager } = setup(db);
    const job = engine.createJob("test", {}, "idem7", { maxAttempts: 3, initialDelayMs: 10, multiplier: 2, maxDelayMs: 100 });
    const lease = leaseManager.acquireLease(job.id, "w1", 1000);
    await new Promise((r) => setTimeout(r, 10));
    const renewed = leaseManager.renewLease(lease.leaseId, 5000);
    check("lease renewal", renewed.expiresAt > lease.expiresAt);
  }

  // TEST 8: lease expiration
  {
    const db = createTestDb();
    const { engine, leaseManager } = setup(db);
    const job = engine.createJob("test", {}, "idem8", { maxAttempts: 3, initialDelayMs: 10, multiplier: 2, maxDelayMs: 100 });
    const lease = leaseManager.acquireLease(job.id, "w1", 10);
    await new Promise((r) => setTimeout(r, 20));
    leaseManager.expireLease(lease.leaseId);
    const updated = leaseManager.store.getLease(lease.leaseId);
    check("lease expiration", updated?.status === "EXPIRED");
  }

  // TEST 9: orphan recovery
  {
    const db = createTestDb();
    const { engine, leaseManager } = setup(db);
    const job = engine.createJob("test", {}, "idem9", { maxAttempts: 3, initialDelayMs: 10, multiplier: 2, maxDelayMs: 100 });
    const worker = { workerId: "w1", hostname: "host", status: "ONLINE" as const, registeredAt: Date.now() };
    engine.workerRegistry.register(worker);
    const claim = engine.claimNextJob("w1");
    if (!claim) { check("orphan recovery", false); }
    else {
      // Simulate crash: expire lease without releasing
      db.prepare("UPDATE execution_leases SET expires_at = ? WHERE lease_id = ?").run(Date.now() - 1000, claim.lease.leaseId);
      engine.recoverStaleJobs();
      const updatedJob = engine.store.getJob(job.id);
      check("orphan recovery", updatedJob?.status === "RETRY_SCHEDULED" || updatedJob?.status === "ORPHANED");
    }
  }

  // TEST 10: successful execution
  {
    const db = createTestDb();
    const { engine } = setup(db);
    engine.deps.executionFn = async () => true;
    engine.deps.verificationFn = async () => true;
    const job = engine.createJob("test", {}, "idem10", { maxAttempts: 3, initialDelayMs: 10, multiplier: 2, maxDelayMs: 100 });
    const worker = { workerId: "w1", hostname: "host", status: "ONLINE" as const, registeredAt: Date.now() };
    engine.workerRegistry.register(worker);
    const claim = engine.claimNextJob("w1");
    if (!claim) { check("successful execution", false); }
    else {
      const result = await engine.executeJob("w1", job.id, claim.lease.leaseId);
      check("successful execution", result.status === "SUCCEEDED");
    }
  }

  // TEST 11: failed execution
  {
    const db = createTestDb();
    const { engine } = setup(db);
    engine.deps.executionFn = async () => false;
    const job = engine.createJob("test", {}, "idem11", { maxAttempts: 1, initialDelayMs: 10, multiplier: 2, maxDelayMs: 100 });
    const worker = { workerId: "w1", hostname: "host", status: "ONLINE" as const, registeredAt: Date.now() };
    engine.workerRegistry.register(worker);
    const claim = engine.claimNextJob("w1");
    if (!claim) { check("failed execution", false); }
    else {
      const result = await engine.executeJob("w1", job.id, claim.lease.leaseId);
      check("failed execution", result.status === "DEAD_LETTER");
    }
  }

  // TEST 12: retry scheduling
  {
    const db = createTestDb();
    const { engine } = setup(db);
    engine.deps.executionFn = async () => false;
    const job = engine.createJob("test", {}, "idem12", { maxAttempts: 3, initialDelayMs: 10, multiplier: 2, maxDelayMs: 100 });
    const worker = { workerId: "w1", hostname: "host", status: "ONLINE" as const, registeredAt: Date.now() };
    engine.workerRegistry.register(worker);
    const claim = engine.claimNextJob("w1");
    if (!claim) { check("retry scheduling", false); }
    else {
      const result = await engine.executeJob("w1", job.id, claim.lease.leaseId);
      check("retry scheduling", result.status === "RETRY_SCHEDULED" && result.nextAttemptAt !== undefined);
    }
  }

  // TEST 13: retry backoff
  {
    const db = createTestDb();
    const { retryEngine } = setup(db);
    const policy = { maxAttempts: 3, initialDelayMs: 10, multiplier: 2, maxDelayMs: 100 };
    const next1 = retryEngine.calculateNextAttempt(1, policy, 1000);
    const next2 = retryEngine.calculateNextAttempt(2, policy, 1000);
    check("retry backoff", next1 !== null && next2 !== null && next2! > next1!);
  }

  // TEST 14: retry limit
  {
    const db = createTestDb();
    const { engine } = setup(db);
    engine.deps.executionFn = async () => false;
    const job = engine.createJob("test", {}, "idem14", { maxAttempts: 2, initialDelayMs: 10, multiplier: 2, maxDelayMs: 100 });
    const worker = { workerId: "w1", hostname: "host", status: "ONLINE" as const, registeredAt: Date.now() };
    engine.workerRegistry.register(worker);
    // first attempt
    let claim = engine.claimNextJob("w1");
    if (claim) await engine.executeJob("w1", job.id, claim.lease.leaseId);
    // simulate retry due: set job to QUEUED
    const updatedJob = engine.store.getJob(job.id);
    if (updatedJob && updatedJob.status === "RETRY_SCHEDULED") {
      updatedJob.status = "QUEUED";
      engine.store.updateJob(updatedJob);
    }
    // second claim and execute
    claim = engine.claimNextJob("w1");
    if (claim) await engine.executeJob("w1", job.id, claim.lease.leaseId);
    const finalJob = engine.store.getJob(job.id);
    check("retry limit", finalJob?.status === "DEAD_LETTER");
  }

  // TEST 15: dead-letter transition
  {
    const db = createTestDb();
    const { engine } = setup(db);
    engine.deps.executionFn = async () => false;
    const job = engine.createJob("test", {}, "idem15", { maxAttempts: 1, initialDelayMs: 10, multiplier: 2, maxDelayMs: 100 });
    const worker = { workerId: "w1", hostname: "host", status: "ONLINE" as const, registeredAt: Date.now() };
    engine.workerRegistry.register(worker);
    const claim = engine.claimNextJob("w1");
    if (claim) {
      await engine.executeJob("w1", job.id, claim.lease.leaseId);
      const finalJob = engine.store.getJob(job.id);
      check("dead-letter transition", finalJob?.status === "DEAD_LETTER");
    } else check("dead-letter transition", false);
  }

  // TEST 16: idempotency
  {
    const db = createTestDb();
    const { engine } = setup(db);
    const job1 = engine.createJob("test", {}, "idem16", { maxAttempts: 3, initialDelayMs: 10, multiplier: 2, maxDelayMs: 100 });
    const job2 = engine.createJob("test", {}, "idem16", { maxAttempts: 3, initialDelayMs: 10, multiplier: 2, maxDelayMs: 100 });
    check("idempotency", job1.id === job2.id);
  }

  // TEST 17: cancellation
  {
    const db = createTestDb();
    const { engine } = setup(db);
    const job = engine.createJob("test", {}, "idem17", { maxAttempts: 3, initialDelayMs: 10, multiplier: 2, maxDelayMs: 100 });
    engine.requestCancellation(job.id);
    const updated = engine.store.getJob(job.id);
    check("cancellation", updated?.cancellationRequested === true);
  }

  // TEST 18: timeout
  {
    const db = createTestDb();
    const { engine } = setup(db);
    engine.deps.executionFn = async () => { await new Promise((r) => setTimeout(r, 50)); return true; };
    const job = engine.createJob("test", {}, "idem18", { maxAttempts: 1, initialDelayMs: 10, multiplier: 2, maxDelayMs: 100 }, 20);
    const worker = { workerId: "w1", hostname: "host", status: "ONLINE" as const, registeredAt: Date.now() };
    engine.workerRegistry.register(worker);
    const claim = engine.claimNextJob("w1");
    if (claim) {
      const result = await engine.executeJob("w1", job.id, claim.lease.leaseId);
      check("timeout", result.status === "DEAD_LETTER" || result.status === "RETRY_SCHEDULED");
    } else check("timeout", false);
  }

  // TEST 19: artifact registration
  {
    const db = createTestDb();
    const { store } = setup(db);
    const artifactStore = new ArtifactStore(store);
    const artifact = artifactStore.registerArtifact(
      { artifactId: "art1", name: "test-art", type: "tar", createdAt: Date.now() },
      Buffer.from("hello")
    );
    check("artifact registration", artifact.checksum.length === 64);
  }

  // TEST 20: artifact checksum validation
  {
    const db = createTestDb();
    const { store } = setup(db);
    const artifactStore = new ArtifactStore(store);
    const artifact = artifactStore.registerArtifact(
      { artifactId: "art2", name: "test-art", type: "tar", createdAt: Date.now() },
      Buffer.from("hello")
    );
    const valid = artifactStore.verifyArtifact("art2", Buffer.from("hello"));
    const invalid = artifactStore.verifyArtifact("art2", Buffer.from("world"));
    check("artifact checksum validation", valid && !invalid);
  }

  // TEST 21: release creation
  {
    const db = createTestDb();
    const { store } = setup(db);
    const releaseManager = new ReleaseManager(store);
    const release = releaseManager.createRelease("rel1", "1.0.0", "art1");
    check("release creation", release.status === "CREATED" && release.version === "1.0.0");
  }

  // TEST 22: deployment safety gate
  {
    const db = createTestDb();
    const { store } = setup(db);
    const gates = new DeploymentGates();
    const release = { releaseId: "rel1", version: "1.0.0", status: "CREATED" as const, createdAt: Date.now(), updatedAt: Date.now() };
    const artifact = { artifactId: "art1", name: "art", type: "tar", checksum: "abc", createdAt: Date.now() };
    const result = gates.evaluate(release, artifact, ["build_passed", "tests_passed", "security_passed"]);
    check("deployment safety gate", result.every((g) => g.passed));
  }

  // TEST 23: human approval gate
  {
    const db = createTestDb();
    const { store } = setup(db);
    const approvalGate = new ApprovalGate(store);
    const decision = approvalGate.evaluate("dep1", "rel1", "production", "deploy");
    check("human approval gate", decision === "HUMAN_APPROVAL_REQUIRED");
  }

  // TEST 24: deployment verification
  {
    const db = createTestDb();
    const { store } = setup(db);
    const verifier = new FunctionDeploymentVerifier((id) => Promise.resolve(true));
    const result = await verifier.verify("dep1");
    check("deployment verification", result === true);
  }

  // TEST 25: rollback execution
  {
    const db = createTestDb();
    const { store } = setup(db);
    const rollbackManager = new RollbackManager(
      store,
      async () => true,
      async () => true
    );
    const deployment: any = {
      deploymentId: "dep1",
      releaseId: "rel1",
      environment: "staging",
      status: "VERIFYING",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    store.addDeployment(deployment);
    const result = await rollbackManager.rollback(deployment);
    check("rollback execution", result.status === "ROLLED_BACK");
  }

  // TEST 26: rollback verification
  {
    const db = createTestDb();
    const { store } = setup(db);
    const rollbackManager = new RollbackManager(
      store,
      async () => true,
      async () => true
    );
    const deployment: any = {
      deploymentId: "dep2",
      releaseId: "rel1",
      environment: "staging",
      status: "VERIFYING",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    store.addDeployment(deployment);
    const result = await rollbackManager.rollback(deployment);
    const rollbackDeployment = store.getDeployment(result.rollbackDeploymentId!);
    check("rollback verification", rollbackDeployment?.status === "SUCCEEDED");
  }

  // TEST 27: deployment failure escalation
  {
    const db = createTestDb();
    const { store } = setup(db);
    const rollbackManager = new RollbackManager(
      store,
      async () => true,
      async () => false // rollback verification fails
    );
    const deployment: any = {
      deploymentId: "dep3",
      releaseId: "rel1",
      environment: "staging",
      status: "VERIFYING",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    store.addDeployment(deployment);
    const result = await rollbackManager.rollback(deployment);
    check("deployment failure escalation", result.status === "INTERVENTION_REQUIRED");
  }

  // TEST 28: Phase 11 regression
  {
    const db = createTestDb();
    const recoveryStore = new RecoveryStore(db);
    const policyEngine = new RecoveryPolicyEngine();
    const agent = new RecoveryAgent(policyEngine);
    const diagnosis: IncidentAnalysis = {
      incidentId: "incident1",
      service: "svc",
      environment: "staging",
      classification: "APPLICATION",
      confidence: "HIGH",
      summary: "test",
      evidence: [],
      uncertainties: [],
    };
    const attempt = await agent.attemptRecovery(diagnosis, "incident1", "staging", [], async () => true);
    check("Phase 11 regression", attempt.status === "EXECUTED");
  }

  // TEST 29: Phase 12 regression
  {
    const db = createTestDb();
    const recoveryStore = new RecoveryStore(db);
    const policyEngine = new RecoveryPolicyEngine();
    const verifier = new PredicateRecoveryVerifier(async () => true);
    const orchestrator = new RecoveryOrchestrator(recoveryStore, policyEngine, verifier);
    const diagnosis: IncidentAnalysis = {
      incidentId: "incident2",
      service: "svc",
      environment: "staging",
      classification: "APPLICATION",
      confidence: "HIGH",
      summary: "test",
      evidence: [],
      uncertainties: [],
    };
    const result = await orchestrator.orchestrate(diagnosis, "staging", "restart", undefined, async () => true);
    check("Phase 12 regression", result.finalState === "RECOVERED");
  }

  // TEST 30: restart/crash recovery scenario
  {
    const db = createTestDb();
    const { engine } = setup(db);
    engine.deps.executionFn = async () => true;
    engine.deps.verificationFn = async () => true;
    const job = engine.createJob("test", {}, "idem30", { maxAttempts: 3, initialDelayMs: 10, multiplier: 2, maxDelayMs: 100 });
    const worker = { workerId: "w1", hostname: "host", status: "ONLINE" as const, registeredAt: Date.now() };
    engine.workerRegistry.register(worker);
    const claim = engine.claimNextJob("w1");
    if (!claim) { check("restart/crash recovery scenario", false); }
    else {
      // Simulate crash: expire lease without releasing
      db.prepare("UPDATE execution_leases SET expires_at = ? WHERE lease_id = ?").run(Date.now() - 1000, claim.lease.leaseId);
      engine.recoverStaleJobs();
      // Ensure job is requeued if retry scheduled
      const recoveredJob = engine.store.getJob(job.id);
      if (recoveredJob && recoveredJob.status === "RETRY_SCHEDULED") {
        recoveredJob.status = "QUEUED";
        engine.store.updateJob(recoveredJob);
      }
      // Re-claim and execute
      const claim2 = engine.claimNextJob("w1");
      if (!claim2) { check("restart/crash recovery scenario", false); }
      else {
        const result = await engine.executeJob("w1", job.id, claim2.lease.leaseId);
        check("restart/crash recovery scenario", result.status === "SUCCEEDED");
      }
    }
  }

  // Summarize
  console.log("\n=== Phase 13 Test Results ===");
  for (const r of results) console.log(r);
  console.log(`\n${passed}/${total} tests passed.`);
  if (passed === total) {
    console.log("PHASE 13 PASS 1: PASS");
    process.exit(0);
  } else {
    console.log("PHASE 13 PASS 1: FAIL");
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("Phase 13 harness error:", err);
  process.exit(1);
});
