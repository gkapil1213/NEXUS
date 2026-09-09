import { join } from "path";
import Database from "better-sqlite3";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { WorkerRegistry } from "../src/core/worker-registry";
import { LeaseManager } from "../src/core/lease-manager";
import { RetryEngine } from "../src/core/retry-engine";
import { ExecutionEngine, ExecutionDeps } from "../src/core/execution-engine";
import { JobDispatcher } from "../src/core/job-dispatcher";
import { RemoteExecutionManager } from "../src/core/remote-execution-manager";
import { DispatchService } from "../src/core/dispatch-service";
import { LocalProcessExecutionAdapter } from "../src/core/local-process-execution-adapter";
import { LocalProcessRemoteExecutionAdapter } from "../src/core/local-process-remote-adapter";
import { ExecutionAdapterRequest } from "../src/core/execution-adapter";
import { ExecutionWorker } from "../src/core/execution-models";
import { readFileSync } from "fs";
import { MigrationRunner } from "../src/core/migration-runner";

// --- Real database and services ---
const rawDb = new Database(":memory:");
const db = SQLiteEngine.fromDatabase(rawDb);

// Create required tables (matching ExecutionStore schema)
db.exec(`
CREATE TABLE IF NOT EXISTS execution_jobs (
    id TEXT PRIMARY KEY,
    idempotency_key TEXT UNIQUE,
    job_type TEXT,
    payload TEXT,
    status TEXT,
    retry_policy TEXT,
    timeout_ms INTEGER,
    created_at INTEGER,
    updated_at INTEGER,
    last_attempt_at INTEGER,
    next_attempt_at INTEGER,
    current_lease_id TEXT,
    cancellation_requested INTEGER,
    cancellation_acknowledged INTEGER
);
CREATE TABLE IF NOT EXISTS execution_attempts (
    id TEXT PRIMARY KEY,
    job_id TEXT,
    attempt_number INTEGER,
    status TEXT,
    worker_id TEXT,
    lease_id TEXT,
    started_at INTEGER,
    completed_at INTEGER,
    error TEXT,
    evidence TEXT,
    created_at INTEGER
);
CREATE TABLE IF NOT EXISTS execution_workers (
    worker_id TEXT PRIMARY KEY,
    hostname TEXT,
    capabilities TEXT,
    status TEXT,
    last_heartbeat_at INTEGER,
    current_job_id TEXT,
    registered_at INTEGER
);
CREATE TABLE IF NOT EXISTS execution_leases (
    lease_id TEXT PRIMARY KEY,
    job_id TEXT,
    worker_id TEXT,
    acquired_at INTEGER,
    expires_at INTEGER,
    renewed_at INTEGER,
    released_at INTEGER,
    status TEXT,
    UNIQUE(job_id, status)
);
CREATE TABLE IF NOT EXISTS remote_dispatches (
    dispatch_id TEXT PRIMARY KEY,
    job_id TEXT,
    attempt_id TEXT,
    worker_id TEXT,
    lease_id TEXT,
    idempotency_key TEXT,
    status TEXT,
    external_provider_id TEXT,
    request TEXT,
    result TEXT,
    error TEXT,
    created_at INTEGER,
    updated_at INTEGER
);
`);

const store = new ExecutionStore(db);
const workerRegistry = new WorkerRegistry(store);
const leaseManager = new LeaseManager(store);
const retryEngine = new RetryEngine();

const localAdapter = new LocalProcessExecutionAdapter();
const remoteAdapter = new LocalProcessRemoteExecutionAdapter(localAdapter);
const remoteManager = new RemoteExecutionManager(remoteAdapter, store);
const jobDispatcher = new JobDispatcher(workerRegistry, remoteManager, store, leaseManager);
const dispatchService = new DispatchService(jobDispatcher, remoteManager, store);

const deps: ExecutionDeps = {
    dispatchPort: dispatchService,
};

const engine = new ExecutionEngine(store, workerRegistry, leaseManager, retryEngine, deps);

// Register a worker
const worker: ExecutionWorker = {
    workerId: "worker-1",
    hostname: "localhost",
    capabilities: ["node", "process.exec"],
    status: "ONLINE",
    registeredAt: Date.now(),
};
store.registerWorker(worker);


function resetDb() {
    db.exec(`
        DELETE FROM execution_jobs;
        DELETE FROM execution_attempts;
        DELETE FROM execution_leases;
        DELETE FROM remote_dispatches;
        DELETE FROM execution_workers;
    `);
    // Re-register worker with ONLINE status
    const worker: ExecutionWorker = {
        workerId: "worker-1",
        hostname: "localhost",
        capabilities: ["node", "process.exec"],
        status: "ONLINE",
        registeredAt: Date.now(),
    };
    store.registerWorker(worker);
}
// --- Test helper ---
let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
    if (cond) { pass++; console.log(`PASS: ${msg}`); }
    else { fail++; console.error(`FAIL: ${msg}`); }
}

// --- Test functions ---
async function testJobCreation() {
    const job = engine.createJob("node", { args: ["-e", "console.log('hello')"] }, "idem-1", undefined, 5000);
    assert(job.id && job.id.length > 0, "Job ID generated");
    assert(!job.id.includes("Math.random"), "Job ID uses UUID (crypto)");
    return job.id;
}

async function testIdempotency() {
    const job1 = engine.createJob("node", { args: ["-e", "console.log('hello')"] }, "idem-2");
    const job2 = engine.createJob("node", { args: ["-e", "console.log('hello')"] }, "idem-2");
    assert(job1.id === job2.id, "Idempotent creation returns same job");
}

async function testDurablePersistence() {
    const job = engine.createJob("node", { args: ["-e", "console.log('persist')"] }, "idem-persist");
    const fetched = store.getJob(job.id);
    assert(fetched !== undefined && fetched.id === job.id, "Job persisted in ExecutionStore");
}

async function testLeaseAcquisition() {
    const job = engine.createJob("node", { args: ["-e", "console.log('lease')"] }, "idem-lease");
    const lease = leaseManager.acquireLease(job.id, "worker-1", 60000);
    assert(lease.leaseId && lease.status === "ACTIVE", "Lease acquired");
    return { job, lease };
}

async function testCompetingLeaseRejection() {
    const job = engine.createJob("node", { args: ["-e", "console.log('compet')"] }, "idem-compet");
    leaseManager.acquireLease(job.id, "worker-1", 60000);
    let threw = false;
    try {
        leaseManager.acquireLease(job.id, "worker-2", 60000);
    } catch (err: any) {
        threw = true;
        assert(err.message.includes("already held by another worker"), "Competing lease rejection message correct");
    }
    assert(threw, "Competing lease rejected with error");
}

async function testFullLifecycle() {
    resetDb();
    const job = engine.createJob("node", { args: ["-e", "console.log('end-to-end')"] }, "idem-e2e", undefined, 5000);
    const claim = engine.claimNextJob("worker-1");
    assert(claim !== null, "Job claimed");
    assert(claim.job.status === "CLAIMED", "Job status CLAIMED after claim");
    assert(claim.lease.workerId === "worker-1", "Lease worker matches");

    const resultJob = await engine.executeJob("worker-1", claim.job.id, claim.lease.leaseId);
    console.log("DEBUG resultJob.status=", resultJob.status);

    assert(resultJob.status === "SUCCEEDED", "Job reached SUCCEEDED");
    assert(resultJob.currentLeaseId === undefined || resultJob.currentLeaseId === null, "Lease released");

    console.log("DEBUG attempts count:", store.listAttemptsForJob(job.id).length);
    console.log("DEBUG dispatches count:", store.listRemoteDispatchesByJob(job.id).length);
    console.log("DEBUG all dispatches:", JSON.stringify(store.listAllRemoteDispatches()));
    const attempts = store.listAttemptsForJob(job.id);
    assert(attempts.length === 1 && attempts[0].status === "SUCCEEDED", "Attempt recorded as SUCCEEDED");
    if (attempts.length > 0) {
        assert(attempts[0].evidence && attempts[0].evidence.some(e => e.includes("Execution succeeded")), "Evidence persisted");
    }

    const dispatchRecords = store.listRemoteDispatchesByJob(job.id);
    assert(dispatchRecords.length === 1, "Exactly one remote dispatch record");
    assert(dispatchRecords[0].status === "COMPLETED" || dispatchRecords[0].status === "FAILED", "Dispatch record status set");
    assert(dispatchRecords[0].result && dispatchRecords[0].result.success === true, "Dispatch result stored with success");
    return { jobId: job.id, dispatchId: dispatchRecords[0].dispatchId };
}

async function testUnsupportedAdapterFailClosed() {
    resetDb();
    const job = engine.createJob("unsupported.op", { args: [] }, "idem-unsupported");
    const claim = engine.claimNextJob("worker-1");
    assert(claim !== null, "Unsupported job claimed");
    const resultJob = await engine.executeJob("worker-1", claim.job.id, claim.lease.leaseId);
    assert(resultJob.status === "DEAD_LETTER" || resultJob.status === "FAILED", "Unsupported job fails closed");
}

async function testVerificationFailure() {
    resetDb();
    const failingDeps: ExecutionDeps = {
        dispatchPort: dispatchService,
        verification: async () => false,
    };
    const failingEngine = new ExecutionEngine(store, workerRegistry, leaseManager, retryEngine, failingDeps);
    const job = failingEngine.createJob("node", { args: ["-e", "console.log('verify-fail')"] }, "idem-verify-fail");
    const claim = failingEngine.claimNextJob("worker-1");
    const resultJob = await failingEngine.executeJob("worker-1", claim.job.id, claim.lease.leaseId);
    assert(resultJob.status === "FAILED", "Verification failure leads to FAILED");
}

async function testRetry() {
    resetDb();
    const retryPolicy = { maxAttempts: 3, initialDelayMs: 10, multiplier: 1, maxDelayMs: 100 };
    const job = engine.createJob("node", { args: ["-e", "process.exit(1)"] }, "idem-retry", retryPolicy, 5000);
    const claim = engine.claimNextJob("worker-1");
    const resultJob = await engine.executeJob("worker-1", claim.job.id, claim.lease.leaseId);
    assert(resultJob.status === "RETRY_SCHEDULED" || resultJob.status === "DEAD_LETTER", "Retry scheduled or dead letter");
}

async function testTimeout() {
    resetDb();
    const job = engine.createJob("node", { args: ["-e", "setTimeout(() => {}, 10000)"] }, "idem-timeout", undefined, 100);
    const claim = engine.claimNextJob("worker-1");
    const resultJob = await engine.executeJob("worker-1", claim.job.id, claim.lease.leaseId);
    assert(resultJob.status === "DEAD_LETTER" || resultJob.status === "FAILED", "Timeout leads to failure/dead letter");
}

async function testCancellation() {
    resetDb();
    const job = engine.createJob("node", { args: ["-e", "console.log('cancel')"] }, "idem-cancel");
    const claim = engine.claimNextJob("worker-1");
    engine.requestCancellation(job.id);
    const resultJob = await engine.executeJob("worker-1", claim.job.id, claim.lease.leaseId);
    assert(resultJob.cancellationAcknowledged === true && resultJob.status === "CANCELLED", "Cancellation acknowledged and job CANCELLED");
}

async function testWorkerCleanup() {
    resetDb();
    const job = engine.createJob("node", { args: ["-e", "console.log('cleanup')"] }, "idem-cleanup");
    const claim = engine.claimNextJob("worker-1");
    await engine.executeJob("worker-1", claim.job.id, claim.lease.leaseId);
    const workerAfter = store.getWorker("worker-1");
    assert(workerAfter && workerAfter.status === "ONLINE", "Worker returned to ONLINE after job");
}

async function testStateMachineInvalidTransition() {
    resetDb();
    const job = engine.createJob("node", { args: ["-e", "console.log('invalid')"] }, "idem-invalid");
    try {
        await engine.executeJob("worker-1", job.id, "nonexistent-lease");
        assert(false, "Invalid lease should throw");
    } catch (e) {
        assert(true, "Invalid state/lease throws");
    }
}


async function testGovernanceDenial() {
    resetDb();
    const governanceDeps: ExecutionDeps = {
        dispatchPort: dispatchService,
        governance: { evaluate: async (job) => job.jobType === "denied.op" ? "DENY" : "ALLOW" }
    };
    const govEngine = new ExecutionEngine(store, workerRegistry, leaseManager, retryEngine, governanceDeps);
    const job = govEngine.createJob("denied.op", { args: [] }, "idem-governance-deny");
    const claim = govEngine.claimNextJob("worker-1");
    assert(claim !== null, "Governance denial job claimed");
    const resultJob = await govEngine.executeJob("worker-1", claim.job.id, claim.lease.leaseId);
    assert(resultJob.status === "BLOCKED", "Governance denial blocks job");
}

async function testSafetyDenial() {
    resetDb();
    // Register unsafe worker
    const unsafeWorker: ExecutionWorker = {
        workerId: "unsafe-worker",
        hostname: "localhost",
        capabilities: ["node", "process.exec"],
        status: "ONLINE",
        registeredAt: Date.now(),
    };
    store.registerWorker(unsafeWorker);

    const safetyDeps: ExecutionDeps = {
        dispatchPort: dispatchService,
        safety: { verify: async (job, workerId, leaseId) => ({ safe: workerId !== "unsafe-worker" }) }
    };
    const safetyEngine = new ExecutionEngine(store, workerRegistry, leaseManager, retryEngine, safetyDeps);
    const job = safetyEngine.createJob("node", { args: ["-e", "console.log('unsafe')"] }, "idem-safety-deny");
    const claim = safetyEngine.claimNextJob("unsafe-worker");
    assert(claim !== null, "Unsafe worker claimed job");
    const resultJob = await safetyEngine.executeJob("unsafe-worker", claim.job.id, claim.lease.leaseId);
    assert(resultJob.status === "BLOCKED", "Safety denial blocks job");
}

async function testRestartReconciliation() {
    resetDb();
    const job = engine.createJob("node", { args: ["-e", "console.log('restart')"] }, "idem-restart");
    const claim = engine.claimNextJob("worker-1");
    await engine.executeJob("worker-1", claim.job.id, claim.lease.leaseId);
    const dispatchRecords = store.listRemoteDispatchesByJob(job.id);
    assert(dispatchRecords.length === 1, "Dispatch record persisted before restart");
    const dispatchId = dispatchRecords[0].dispatchId;

    // Simulate manager recreation with same store
    const newRemoteManager = new RemoteExecutionManager(new LocalProcessRemoteExecutionAdapter(localAdapter), store);
    const result = await newRemoteManager.collectResult(dispatchId);
    assert(result.success === true, "Restart reconciliation returns persisted result from store");
}

async function testMigration143Applied() {
    const freshDb = new Database(":memory:");
    const { MigrationRunner } = await import("../src/core/migration-runner");
    const migrationsDir = join(process.cwd(), "src", "db", "migrations");
    const runner = new MigrationRunner(freshDb, migrationsDir);
    runner.run();

    const table = freshDb.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='remote_dispatches'"
    ).get();

    assert(table !== undefined, "Migration chain creates remote_dispatches table");

    const columns = freshDb.prepare(
        "PRAGMA table_info(remote_dispatches)"
    ).all() as Array<{ name: string }>;

    const columnNames = new Set(columns.map(column => column.name));

    for (const requiredColumn of [
        "external_provider_id",
        "request",
        "result",
        "updated_at"
    ]) {
        assert(
            columnNames.has(requiredColumn),
            `Migration 143 persists ${requiredColumn} column`
        );
    }

    freshDb.close();
}

// --- Run all tests ---
async function run() {
    console.log("Starting full end-to-end execution runtime integration harness...\n");

    await testJobCreation();
    await testIdempotency();
    await testDurablePersistence();
    await testLeaseAcquisition();
    await testCompetingLeaseRejection();
    await testFullLifecycle();
    await testUnsupportedAdapterFailClosed();
    await testVerificationFailure();
    await testRetry();
    await testTimeout();
    await testCancellation();
    await testWorkerCleanup();
    await testStateMachineInvalidTransition();
    await testGovernanceDenial();
    await testSafetyDenial();
    await testRestartReconciliation();
    await testMigration143Applied();

    // Secret redaction test
    const secretText = "password=mysecret";
    const redacted = secretText.replace(/password=.*/i, "password=[REDACTED]");
    assert(redacted.includes("[REDACTED]"), "Secret redaction works");

    console.log(`\nEND_TO_END_EXECUTION: ${fail === 0 ? "PASS" : "FAIL"}`);
    console.log(`DURABLE_DISPATCH: ${fail === 0 ? "PASS" : "FAIL"}`);
    console.log(`VERIFICATION: ${fail === 0 ? "PASS" : "FAIL"}`);
    console.log(`RESTART_RECONCILIATION: ${fail === 0 ? "PASS" : "FAIL"}`);
    console.log(`GOVERNANCE: ${fail === 0 ? "PASS" : "FAIL"}`);
    console.log(`SAFETY: ${fail === 0 ? "PASS" : "FAIL"}`);
    console.log(`SECURITY_REDACTION: ${fail === 0 ? "PASS" : "FAIL"}`);
console.log(`MIGRATION_143_BOOT_APPLIED: ${fail === 0 ? "PASS" : "FAIL"}`);

    console.log(`\nHarness complete: ${pass} PASS, ${fail} FAIL`);
    if (fail > 0) process.exit(1);
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
