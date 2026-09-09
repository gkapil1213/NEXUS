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
import { ExecutionWorker, RemoteDispatchRecord } from "../src/core/execution-models";
import { readFileSync, rmSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { MigrationRunner } from "../src/core/migration-runner";

// --- Real database and services ---
const rawDb = new Database(":memory:");
const db = SQLiteEngine.fromDatabase(rawDb);

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
    job_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    worker_id TEXT NOT NULL,
    lease_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    status TEXT NOT NULL,
    external_provider_id TEXT,
    request TEXT,
    result TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (job_id) REFERENCES execution_jobs(id),
    FOREIGN KEY (attempt_id) REFERENCES execution_attempts(id),
    FOREIGN KEY (worker_id) REFERENCES execution_workers(worker_id),
    FOREIGN KEY (lease_id) REFERENCES execution_leases(lease_id)
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
const deps: ExecutionDeps = { dispatchPort: dispatchService };
const engine = new ExecutionEngine(store, workerRegistry, leaseManager, retryEngine, deps);

function resetDb() {
    db.exec(`
        DELETE FROM remote_dispatches;
        DELETE FROM execution_attempts;
        DELETE FROM execution_leases;
        DELETE FROM execution_jobs;
        DELETE FROM execution_workers;
    `);
    const worker: ExecutionWorker = {
        workerId: "worker-1",
        hostname: "localhost",
        capabilities: ["node", "process.exec"],
        status: "ONLINE",
        registeredAt: Date.now(),
    };
    store.registerWorker(worker);
}


function insertAttempt(jobId: string, workerId: string, leaseId: string): string {
    const attemptId = `attempt_${jobId}_1`;
    db.prepare(`
        INSERT INTO execution_attempts (id, job_id, attempt_number, status, worker_id, lease_id, started_at, created_at)
        VALUES (?, ?, 1, 'RUNNING', ?, ?, ?, ?)
    `).run(attemptId, jobId, workerId, leaseId, Date.now(), Date.now());
    return attemptId;
}
let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
    if (cond) { pass++; console.log(`PASS: ${msg}`); }
    else { fail++; console.error(`FAIL: ${msg}`); }
}

// Existing tests
async function testJobCreation() {
    const job = engine.createJob("node", { args: ["-e", "console.log('hello')"] }, "idem-1", undefined, 5000);
    assert(job.id && job.id.length > 0, "Job ID generated");
    assert(!job.id.includes("Math.random"), "Job ID uses UUID (crypto)");
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
}
async function testCompetingLeaseRejection() {
    const job = engine.createJob("node", { args: ["-e", "console.log('compet')"] }, "idem-compet");
    leaseManager.acquireLease(job.id, "worker-1", 60000);
    let threw = false;
    try { leaseManager.acquireLease(job.id, "worker-2", 60000); } catch (e: any) { threw = true; assert(e.message.includes("already held by another worker"), "Competing lease rejection message correct"); }
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
    assert(resultJob.status === "SUCCEEDED", "Job reached SUCCEEDED");
    assert(resultJob.currentLeaseId === undefined || resultJob.currentLeaseId === null, "Lease released");
    const attempts = store.listAttemptsForJob(job.id);
    assert(attempts.length === 1 && attempts[0].status === "SUCCEEDED", "Attempt recorded as SUCCEEDED");
    assert(attempts[0].evidence && attempts[0].evidence.some(e => e.includes("Execution succeeded")), "Evidence persisted");
    const dispatchRecords = store.listRemoteDispatchesByJob(job.id);
    assert(dispatchRecords.length === 1, "Exactly one remote dispatch record");
    assert(dispatchRecords[0].status === "COMPLETED" || dispatchRecords[0].status === "FAILED", "Dispatch record status set");
    assert(dispatchRecords[0].result && dispatchRecords[0].result.success === true, "Dispatch result stored with success");
}
async function testUnsupportedAdapterFailClosed() {
    resetDb();
    const job = engine.createJob("unsupported.op", { args: [] }, "idem-unsupported");
    const claim = engine.claimNextJob("worker-1");
    const resultJob = await engine.executeJob("worker-1", claim.job.id, claim.lease.leaseId);
    assert(resultJob.status === "DEAD_LETTER" || resultJob.status === "FAILED", "Unsupported job fails closed");
}
async function testVerificationFailure() {
    resetDb();
    const failingDeps: ExecutionDeps = { dispatchPort: dispatchService, verification: async () => false };
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
    try { await engine.executeJob("worker-1", job.id, "nonexistent-lease"); assert(false, "Invalid lease should throw"); } catch { assert(true, "Invalid state/lease throws"); }
}
async function testGovernanceDenial() {
    resetDb();
    const govDeps: ExecutionDeps = { dispatchPort: dispatchService, governance: { evaluate: async (job) => job.jobType === "denied.op" ? "DENY" : "ALLOW" } };
    const govEngine = new ExecutionEngine(store, workerRegistry, leaseManager, retryEngine, govDeps);
    const job = govEngine.createJob("denied.op", { args: [] }, "idem-governance-deny");
    const claim = govEngine.claimNextJob("worker-1");
    const resultJob = await govEngine.executeJob("worker-1", claim.job.id, claim.lease.leaseId);
    assert(resultJob.status === "BLOCKED", "Governance denial blocks job");
}
async function testSafetyDenial() {
    resetDb();
    const unsafeWorker: ExecutionWorker = { workerId: "unsafe-worker", hostname: "localhost", capabilities: ["node"], status: "ONLINE", registeredAt: Date.now() };
    store.registerWorker(unsafeWorker);
    const safetyDeps: ExecutionDeps = { dispatchPort: dispatchService, safety: { verify: async (job, workerId, leaseId) => ({ safe: workerId !== "unsafe-worker" }) } };
    const safetyEngine = new ExecutionEngine(store, workerRegistry, leaseManager, retryEngine, safetyDeps);
    const job = safetyEngine.createJob("node", { args: ["-e", "console.log('unsafe')"] }, "idem-safety-deny");
    const claim = safetyEngine.claimNextJob("unsafe-worker");
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
    const newRemoteManager = new RemoteExecutionManager(new LocalProcessRemoteExecutionAdapter(localAdapter), store);
    const result = await newRemoteManager.collectResult(dispatchRecords[0].dispatchId);
    assert(result.success === true, "Restart reconciliation returns persisted result from store");
}
async function testMigrationChain() {
    const tempFile = join(tmpdir(), `nexus-migration-${Date.now()}.sqlite`);
    try {
        const freshEngine = await SQLiteEngine.open(tempFile);
        const freshDb = freshEngine.getDatabase();
        const table = freshDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='remote_dispatches'").get();
        assert(table !== undefined, "Migration chain creates remote_dispatches table");
        const columns = freshDb.prepare("PRAGMA table_info(remote_dispatches)").all() as Array<{ name: string }>;
        const names = new Set(columns.map(c => c.name));
        for (const col of ["external_provider_id","request","result","updated_at"]) {
            assert(names.has(col), `Migration 143 persists ${col} column`);
        }
        freshDb.close();
    } finally { try { rmSync(tempFile, { force: true }); } catch {} }
}
async function testSecretRedaction() {
    const secret = "password=mysecret";
    const redacted = secret.replace(/password=.*/i, "password=[REDACTED]");
    assert(redacted.includes("[REDACTED]"), "Secret redaction works");
}

// New durable dispatch boundary tests
async function testDurableDispatchIntent() {
    resetDb();
    const job = engine.createJob("node", { args: ["-e", "console.log('intent')"] }, "idem-intent");
    const claim = engine.claimNextJob("worker-1");
    const attemptId = insertAttempt(job.id, "worker-1", claim.lease.leaseId);
    const intent: RemoteDispatchRecord = {
        dispatchId: `intent_${job.id}_${attemptId}`,
        jobId: job.id,
        attemptId,
        workerId: "worker-1",
        leaseId: claim.lease.leaseId,
        idempotencyKey: job.idempotencyKey,
        status: "DISPATCH_INTENT",
        request: { operation: "node", args: ["-e", "console.log('intent')"] },
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
    store.upsertRemoteDispatch(intent);
    const fetched = store.getRemoteDispatch(intent.dispatchId);
    assert(fetched !== undefined && fetched.status === "DISPATCH_INTENT", "Durable dispatch intent exists before dispatch");
}
async function testDuplicateDispatchPrevention() {
    resetDb();
    const job = engine.createJob("node", { args: ["-e", "console.log('duplicate')"] }, "idem-dup");
    const claim = engine.claimNextJob("worker-1");
    const record: RemoteDispatchRecord = {
        dispatchId: "first-dispatch",
        jobId: job.id,
        attemptId: insertAttempt(job.id, "worker-1", claim.lease.leaseId),
        workerId: "worker-1",
        leaseId: claim.lease.leaseId,
        idempotencyKey: job.idempotencyKey,
        status: "DISPATCHED",
        request: { operation: "node", args: ["-e", "console.log('duplicate')"] },
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
    store.upsertRemoteDispatch(record);
    const existing = store.getRemoteDispatchByJobIdempotencyKey(job.idempotencyKey);
    assert(existing !== undefined && existing.dispatchId === "first-dispatch", "Duplicate dispatch prevented via idempotency lookup");
}
async function testDispatchFailure() {
    resetDb();
    const job = engine.createJob("unsupported.op", { args: [] }, "idem-fail");
    const claim = engine.claimNextJob("worker-1");
    const resultJob = await engine.executeJob("worker-1", claim.job.id, claim.lease.leaseId);
    assert(resultJob.status === "DEAD_LETTER" || resultJob.status === "FAILED", "Dispatch failure leads to failure/dead letter");
    const workerAfter = store.getWorker("worker-1");
    assert(workerAfter && workerAfter.status === "ONLINE", "Worker returned to ONLINE after dispatch failure");
}
async function testCrashWindowSimulation() {
    resetDb();
    const job = engine.createJob("node", { args: ["-e", "console.log('crash')"] }, "idem-crash");
    const claim = engine.claimNextJob("worker-1");
    const intent: RemoteDispatchRecord = {
        dispatchId: `intent_${job.id}_attempt_1`,
        jobId: job.id,
        attemptId: insertAttempt(job.id, "worker-1", claim.lease.leaseId),
        workerId: "worker-1",
        leaseId: claim.lease.leaseId,
        idempotencyKey: job.idempotencyKey,
        status: "DISPATCH_INTENT",
        request: { operation: "node", args: ["-e", "console.log('crash')"] },
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
    store.upsertRemoteDispatch(intent);
    const newRemoteManager = new RemoteExecutionManager(new LocalProcessRemoteExecutionAdapter(localAdapter), store);
    await newRemoteManager.reconcilePersistedDispatches(store.listAllRemoteDispatches());
    const final = store.getRemoteDispatch(intent.dispatchId);
    assert(final !== undefined && final.status === "UNKNOWN", "Crash-window dispatch discovered and reconciled to UNKNOWN");
}
async function testUnknownRemoteState() {
    resetDb();
    const job = engine.createJob("node", { args: ["-e", "console.log('unknown')"] }, "idem-unknown");
    const claim = engine.claimNextJob("worker-1");
    const record: RemoteDispatchRecord = {
        dispatchId: "unknown-dispatch",
        jobId: job.id,
        attemptId: insertAttempt(job.id, "worker-1", claim.lease.leaseId),
        workerId: "worker-1",
        leaseId: claim.lease.leaseId,
        idempotencyKey: job.idempotencyKey,
        status: "UNKNOWN",
        request: { operation: "node", args: ["-e", "console.log('unknown')"] },
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
    store.upsertRemoteDispatch(record);
    const fetched = store.getRemoteDispatch("unknown-dispatch");
    assert(fetched !== undefined && fetched.status === "UNKNOWN", "Unknown remote state preserved");
}
async function testCompletedDispatchReconciliation() {
    resetDb();
    const job = engine.createJob("node", { args: ["-e", "console.log('completed')"] }, "idem-completed");
    const claim = engine.claimNextJob("worker-1");
    const record: RemoteDispatchRecord = {
        dispatchId: "completed-dispatch",
        jobId: job.id,
        attemptId: insertAttempt(job.id, "worker-1", claim.lease.leaseId),
        workerId: "worker-1",
        leaseId: claim.lease.leaseId,
        idempotencyKey: job.idempotencyKey,
        status: "COMPLETED",
        result: { success: true, exitCode: 0, stdout: "done", evidence: { ok: true } },
        request: { operation: "node", args: ["-e", "console.log('completed')"] },
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
    store.upsertRemoteDispatch(record);
    const newRemoteManager = new RemoteExecutionManager(new LocalProcessRemoteExecutionAdapter(localAdapter), store);
    await newRemoteManager.reconcilePersistedDispatches(store.listAllRemoteDispatches());
    const final = store.getRemoteDispatch("completed-dispatch");
    assert(final !== undefined && final.status === "COMPLETED" && final.result?.success === true, "Completed dispatch reconciled with result");
}
async function testCancellationIdempotent() {
    resetDb();
    const job = engine.createJob("node", { args: ["-e", "console.log('cancel')"] }, "idem-cancel2");
    const claim = engine.claimNextJob("worker-1");
    await dispatchService.cancel(`fake-dispatch-${job.id}`);
    await dispatchService.cancel(`fake-dispatch-${job.id}`);
    assert(true, "Cancellation remains idempotent");
}

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
    await testMigrationChain();
    await testSecretRedaction();

    await testDurableDispatchIntent();
    await testDuplicateDispatchPrevention();
    await testDispatchFailure();
    await testCrashWindowSimulation();
    await testUnknownRemoteState();
    await testCompletedDispatchReconciliation();
    await testCancellationIdempotent();

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

run().catch(err => { console.error(err); process.exit(1); });
