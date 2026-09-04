import Database from "better-sqlite3";
import { RemoteWorkerStore } from "../src/core/remote-worker-store";
import { RemoteWorkerRegistry } from "../src/core/remote-worker-registry";
import { WorkerAuthentication } from "../src/core/worker-authentication";
import { InMemoryWorkerAuthStore } from "../src/core/worker-auth-store";
import { RemoteWorker, RemoteWorkerStatus } from "../src/core/remote-worker-models";
import { ExecutionStore } from "../src/core/execution-store";
import { WorkerRegistry } from "../src/core/worker-registry";
import { LeaseManager } from "../src/core/lease-manager";
import { RetryEngine } from "../src/core/retry-engine";
import { ExecutionEngine } from "../src/core/execution-engine";
import { CICDProviderRegistry } from "../src/core/cicd-provider-registry";
import { CICDRunManager } from "../src/core/cicd-run-manager";
import { GitHubActionsAdapter } from "../src/core/providers/github-actions-adapter";
import { JenkinsAdapter } from "../src/core/providers/jenkins-adapter";
import { RecoveryStore } from "../src/core/recovery-store";
import { RecoveryPolicyEngine } from "../src/core/recovery-policy-engine";
import { RecoveryAgent } from "../src/core/recovery-agent";
import { IncidentAnalysis } from "../src/core/incident-analysis";
import { RecoveryOrchestrator } from "../src/core/recovery-orchestrator";
import { PredicateRecoveryVerifier } from "../src/core/recovery-verifier";
import { ControlPlaneRecovery } from "../src/core/control-plane-recovery";

let passed = 0;
let total = 0;
function test(name: string, fn: () => boolean | Promise<boolean>) {
  total++;
  Promise.resolve(fn()).then((ok) => {
    if (ok) { passed++; console.log(`PASS: ${name}`); }
    else console.log(`FAIL: ${name}`);
  }).catch((err) => {
    console.log(`FAIL: ${name} (${err.message})`);
  });
}

function createDb(): Database.Database {
  const db = new Database(":memory:");
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
    CREATE TABLE remote_workers (
      worker_id TEXT PRIMARY KEY,
      hostname TEXT NOT NULL,
      platform TEXT,
      architecture TEXT,
      agent_version TEXT,
      capabilities TEXT,
      status TEXT NOT NULL,
      registered_at INTEGER NOT NULL,
      last_heartbeat_at INTEGER,
      current_job_id TEXT,
      metadata TEXT
    );
    CREATE TABLE remote_dispatches (
      dispatch_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      attempt_id TEXT,
      lease_id TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      dispatched_at INTEGER,
      completed_at INTEGER,
      error TEXT,
      idempotency_key TEXT UNIQUE NOT NULL,
      FOREIGN KEY (job_id) REFERENCES execution_jobs(id)
    );
    CREATE TABLE remote_execution_events (
      event_id TEXT PRIMARY KEY,
      job_id TEXT,
      worker_id TEXT,
      dispatch_id TEXT,
      sequence INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE cicd_providers (
      provider_id TEXT PRIMARY KEY,
      provider_type TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      config TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE cicd_runs (
      run_id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      external_run_id TEXT,
      job_id TEXT,
      repository TEXT,
      ref TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      evidence TEXT
    );
    CREATE TABLE cicd_events (
      event_id TEXT PRIMARY KEY,
      run_id TEXT,
      provider_id TEXT,
      event_type TEXT NOT NULL,
      payload TEXT,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

function makeRemoteWorker(overrides: Partial<RemoteWorker> = {}): RemoteWorker {
  return {
    workerId: "worker1",
    hostname: "host1",
    platform: "linux",
    architecture: "x64",
    agentVersion: "1.0",
    capabilities: { operations: ["node.success"] },
    status: "ONLINE",
    registeredAt: Date.now(),
    ...overrides,
  };
}

async function run() {
  console.log("=== Phase 15 Pass 1: Remote Execution & CI/CD Control Plane ===\n");

  // Worker tests
  test("worker registration", () => {
    const db = createDb();
    const store = new RemoteWorkerStore(db);
    const authStore = new InMemoryWorkerAuthStore();
    authStore.setCredential("worker1", "secret1");
    const auth = new WorkerAuthentication(authStore);
    const registry = new RemoteWorkerRegistry(store, auth);
    registry.registerWorker(makeRemoteWorker());
    return store.getWorker("worker1")?.status === "ONLINE";
  });

  test("duplicate worker registration rejection", () => {
    const db = createDb();
    const store = new RemoteWorkerStore(db);
    const authStore = new InMemoryWorkerAuthStore();
    authStore.setCredential("worker1", "secret1");
    const auth = new WorkerAuthentication(authStore);
    const registry = new RemoteWorkerRegistry(store, auth);
    registry.registerWorker(makeRemoteWorker());
    let rejected = false;
    try { registry.registerWorker(makeRemoteWorker()); } catch { rejected = true; }
    return rejected;
  });

  test("worker authentication success", () => {
    const db = createDb();
    const store = new RemoteWorkerStore(db);
    const authStore = new InMemoryWorkerAuthStore();
    authStore.setCredential("worker1", "secret1");
    const auth = new WorkerAuthentication(authStore);
    const registry = new RemoteWorkerRegistry(store, auth);
    registry.registerWorker(makeRemoteWorker());
    const result = registry.authenticate("worker1", "secret1");
    return result.authenticated && result.sessionToken?.startsWith("session_");
  });

  test("worker authentication rejection", () => {
    const db = createDb();
    const store = new RemoteWorkerStore(db);
    const authStore = new InMemoryWorkerAuthStore();
    authStore.setCredential("worker1", "secret1");
    const auth = new WorkerAuthentication(authStore);
    const registry = new RemoteWorkerRegistry(store, auth);
    registry.registerWorker(makeRemoteWorker());
    const result = registry.authenticate("worker1", "wrong");
    return !result.authenticated;
  });

  test("worker heartbeat", () => {
    const db = createDb();
    const store = new RemoteWorkerStore(db);
    const authStore = new InMemoryWorkerAuthStore();
    authStore.setCredential("worker1", "secret1");
    const auth = new WorkerAuthentication(authStore);
    const registry = new RemoteWorkerRegistry(store, auth);
    registry.registerWorker(makeRemoteWorker());
    registry.heartbeat("worker1", undefined, Date.now());
    const worker = store.getWorker("worker1");
    return worker?.lastHeartbeatAt !== undefined && worker?.status === "ONLINE";
  });

  test("worker capability validation", () => {
    const db = createDb();
    const store = new RemoteWorkerStore(db);
    const authStore = new InMemoryWorkerAuthStore();
    authStore.setCredential("worker1", "secret1");
    const auth = new WorkerAuthentication(authStore);
    const registry = new RemoteWorkerRegistry(store, auth);
    registry.registerWorker(makeRemoteWorker({ capabilities: { operations: ["node.success"] } }));
    const worker = registry.getWorker("worker1");
    return worker?.capabilities?.operations?.includes("node.success") === true;
  });

  test("worker revocation", () => {
    const db = createDb();
    const store = new RemoteWorkerStore(db);
    const authStore = new InMemoryWorkerAuthStore();
    authStore.setCredential("worker1", "secret1");
    const auth = new WorkerAuthentication(authStore);
    const registry = new RemoteWorkerRegistry(store, auth);
    registry.registerWorker(makeRemoteWorker());
    registry.revokeWorker("worker1");
    return store.getWorker("worker1")?.status === "REVOKED";
  });

  test("worker recovery", () => {
    const db = createDb();
    const store = new RemoteWorkerStore(db);
    const authStore = new InMemoryWorkerAuthStore();
    authStore.setCredential("worker1", "secret1");
    const auth = new WorkerAuthentication(authStore);
    const registry = new RemoteWorkerRegistry(store, auth);
    registry.registerWorker(makeRemoteWorker({ status: "OFFLINE" }));
    registry.recoverWorker("worker1");
    return store.getWorker("worker1")?.status === "ONLINE";
  });

  // Dispatch/lease integration
  test("job dispatch lease validation", () => {
    const db = createDb();
    const execStore = new ExecutionStore(db);
    const leaseManager = new LeaseManager(execStore);
    const worker = { workerId: "w1", hostname: "h", status: "ONLINE" as const, registeredAt: Date.now() };
    const workerRegistry = new WorkerRegistry(execStore);
    workerRegistry.register(worker);
    const engine = new ExecutionEngine(execStore, workerRegistry, leaseManager, new RetryEngine());
    const job = engine.createJob("test", {}, "phase15-dispatch", { maxAttempts: 1, initialDelayMs: 10, multiplier: 2, maxDelayMs: 100 });
    const lease = leaseManager.acquireLease(job.id, "w1", 60000);
    return lease.status === "ACTIVE";
  });

  test("duplicate dispatch rejection", () => {
    const db = createDb();
    const execStore = new ExecutionStore(db);
    const leaseManager = new LeaseManager(execStore);
    const job = { id: "job1", idempotencyKey: "idem1", jobType: "test", status: "QUEUED" as any, createdAt: Date.now(), updatedAt: Date.now(), cancellationRequested: false, cancellationAcknowledged: false };
    execStore.createJob(job);
    let rejected = false;
    try {
      leaseManager.acquireLease("job1", "w1", 60000);
      leaseManager.acquireLease("job1", "w2", 60000);
    } catch { rejected = true; }
    return rejected;
  });

  test("control plane recovery", () => {
    const db = createDb();
    const execStore = new ExecutionStore(db);
    const workerStore = new RemoteWorkerStore(db);
    const leaseManager = new LeaseManager(execStore);
    const recovery = new ControlPlaneRecovery(workerStore, execStore, leaseManager);
    const worker = makeRemoteWorker({ lastHeartbeatAt: Date.now() - 200000 });
    workerStore.registerWorker(worker);
    recovery.recover();
    return workerStore.getWorker("worker1")?.status === "OFFLINE" || workerStore.getWorker("worker1")?.status === "UNHEALTHY";
  });

  // CI/CD provider tests
  test("CI provider registration", () => {
    const registry = new CICDProviderRegistry();
    const gh = new GitHubActionsAdapter({ token: "fake" });
    registry.register(gh);
    return registry.get("github-actions")?.id === "github-actions";
  });

  test("duplicate CI provider rejection", () => {
    const registry = new CICDProviderRegistry();
    const gh = new GitHubActionsAdapter({ token: "fake" });
    registry.register(gh);
    let rejected = false;
    try { registry.register(gh); } catch { rejected = true; }
    return rejected;
  });

  test("disabled provider rejection", () => {
    const registry = new CICDProviderRegistry();
    const gh = new GitHubActionsAdapter({ token: "fake" });
    registry.register(gh);
    registry.disable("github-actions");
    return registry.get("github-actions") === undefined;
  });

  test("GitHub adapter missing credentials rejection", async () => {
    const registry = new CICDProviderRegistry();
    const gh = new GitHubActionsAdapter(); // no token
    registry.register(gh);
    const manager = new CICDRunManager(registry);
    let failed = false;
    try {
      await manager.trigger("github-actions", { workflow: "test.yml", ref: "main" });
    } catch { failed = true; }
    return failed;
  });

  test("Jenkins adapter missing credentials rejection", async () => {
    const registry = new CICDProviderRegistry();
    const jenkins = new JenkinsAdapter(); // no config
    registry.register(jenkins);
    const manager = new CICDRunManager(registry);
    let failed = false;
    try {
      await manager.trigger("jenkins", { job: "test" });
    } catch { failed = true; }
    return failed;
  });

  // Security tests
  test("unauthenticated worker rejection", () => {
    const db = createDb();
    const store = new RemoteWorkerStore(db);
    const authStore = new InMemoryWorkerAuthStore();
    authStore.setCredential("worker1", "secret1");
    const auth = new WorkerAuthentication(authStore);
    const registry = new RemoteWorkerRegistry(store, auth);
    registry.registerWorker(makeRemoteWorker());
    const result = registry.authenticate("worker1", "bad");
    return !result.authenticated;
  });

  test("job hijacking rejection", () => {
    const db = createDb();
    const execStore = new ExecutionStore(db);
    const leaseManager = new LeaseManager(execStore);
    const job = { id: "job1", idempotencyKey: "idem1", jobType: "test", status: "QUEUED" as any, createdAt: Date.now(), updatedAt: Date.now(), cancellationRequested: false, cancellationAcknowledged: false };
    execStore.createJob(job);
    const lease = leaseManager.acquireLease("job1", "w1", 60000);
    let rejected = false;
    try {
      // Simulate another worker trying to validate
      if (!leaseManager.validateLease(lease.leaseId, "w2")) rejected = true;
    } catch { rejected = true; }
    return rejected;
  });

  // Regression tests (simplified)
  test("Phase 11 regression", async () => {
    const db = new Database(":memory:");
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
    const recoveryStore = new RecoveryStore(db);
    const policyEngine = new RecoveryPolicyEngine();
    const agent = new RecoveryAgent(policyEngine);
    const diagnosis: IncidentAnalysis = {
      incidentId: "i1",
      service: "svc",
      environment: "staging",
      classification: "APPLICATION",
      confidence: "HIGH",
      summary: "test",
      evidence: [],
      uncertainties: [],
    };
    const attempt = await agent.attemptRecovery(diagnosis, "i1", "staging", [], async () => true);
    return attempt.status === "EXECUTED";
  });

  test("Phase 12 regression", async () => {
    const db = new Database(":memory:");
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
    const recoveryStore = new RecoveryStore(db);
    const policyEngine = new RecoveryPolicyEngine();
    const verifier = new PredicateRecoveryVerifier(async () => true);
    const orchestrator = new RecoveryOrchestrator(recoveryStore, policyEngine, verifier);
    const diagnosis: IncidentAnalysis = {
      incidentId: "i2",
      service: "svc",
      environment: "staging",
      classification: "APPLICATION",
      confidence: "HIGH",
      summary: "test",
      evidence: [],
      uncertainties: [],
    };
    const result = await orchestrator.orchestrate(diagnosis, "staging", "restart", undefined, async () => true);
    return result.finalState === "RECOVERED";
  });

  test("Phase 13 regression", () => {
    const db = createDb();
    const execStore = new ExecutionStore(db);
    const workerRegistry = new WorkerRegistry(execStore);
    const leaseManager = new LeaseManager(execStore);
    const engine = new ExecutionEngine(execStore, workerRegistry, leaseManager, new RetryEngine());
    const job = engine.createJob("test", {}, "phase15-p13reg", { maxAttempts: 1, initialDelayMs: 10, multiplier: 2, maxDelayMs: 100 });
    return job.status === "QUEUED";
  });

  // Wait for async tests to complete
  await new Promise((resolve) => setTimeout(resolve, 1500));
  console.log(`\n${passed}/${total} tests passed.`);
  if (passed === total) {
    console.log("PHASE 15 PASS 1: PASS");
    process.exit(0);
  } else {
    console.log("PHASE 15 PASS 1: FAIL");
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("Phase 15 harness error:", err);
  process.exit(1);
});
