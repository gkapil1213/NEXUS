import { sha256Hex, computeResultDigest } from "../src/core/integrity";
import { createServer } from "http";
import { AddressInfo } from "net";
import Database from "better-sqlite3";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { WorkerGateway, WorkerGatewayClient } from "../src/core/worker-gateway";
import { SqliteWorkerAuthStore } from "../src/core/sqlite-worker-auth-store";
import { WorkerAuthentication } from "../src/core/worker-authentication";
import { WorkerSessionStore } from "../src/core/worker-session-store";
import { RemoteWorkerStore } from "../src/core/remote-worker-store";
import { ExecutionStore } from "../src/core/execution-store";
import { LocalProcessExecutionAdapter } from "../src/core/local-process-execution-adapter";
import { WorkerAgent } from "../src/core/worker-agent";
import { WorkerConfig } from "../src/core/worker-config";
import { WorkerSecurity } from "../src/core/worker-security";

let pass = 0, fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { pass++; console.log(`PASS: ${msg}`); }
  else { fail++; console.error(`FAIL: ${msg}`); }
}

async function main() {
  // Setup real in-memory SQLite for auth/session/worker stores
  const rawDb = new Database(":memory:");
  const engine = SQLiteEngine.fromDatabase(rawDb);
  // Create required tables
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS execution_jobs (
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
    CREATE TABLE IF NOT EXISTS execution_leases (
      lease_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      acquired_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      renewed_at INTEGER,
      released_at INTEGER,
      status TEXT NOT NULL,
      FOREIGN KEY (job_id) REFERENCES execution_jobs(id)
    );    CREATE TABLE IF NOT EXISTS worker_sessions (
      session_id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL,
      status TEXT NOT NULL,
      protocol_version TEXT,
      connection_id TEXT,
      created_at INTEGER,
      authenticated_at INTEGER,
      last_seen_at INTEGER,
      last_heartbeat_at INTEGER,
      last_sequence INTEGER,
      expires_at INTEGER,
      revoked INTEGER DEFAULT 0,
      metadata TEXT
    );
    CREATE TABLE IF NOT EXISTS remote_workers (
      worker_id TEXT PRIMARY KEY,
      hostname TEXT,
      platform TEXT,
      architecture TEXT,
      agent_version TEXT,
      capabilities TEXT,
      status TEXT,
      registered_at INTEGER,
      last_heartbeat_at INTEGER,
      current_job_id TEXT,
      metadata TEXT
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
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS remote_execution_results (
      result_id TEXT PRIMARY KEY,
      job_id TEXT,
      attempt_id TEXT,
      worker_id TEXT,
      dispatch_id TEXT,
      lease_id TEXT,
      success INTEGER,
      exit_code INTEGER,
      stdout_ref TEXT,
      stderr_ref TEXT,
      evidence TEXT,
      created_at INTEGER,
      stdout_sha256 TEXT,
      stderr_sha256 TEXT,
      result_sha256 TEXT,
      verification_status TEXT,
      verified_at INTEGER
    );
  `);

  const authStore = new SqliteWorkerAuthStore(engine);
  const auth = new WorkerAuthentication(authStore);
  const sessionStore = new WorkerSessionStore(engine);
  const workerStore = new RemoteWorkerStore(engine);

  // Register worker
  workerStore.registerWorker({
    workerId: "worker-gw-1",
    hostname: "localhost",
    capabilities: { operations: ["node", "process.exec"] },
    status: "ONLINE",
    registeredAt: Date.now(),
  });
  authStore.setCredential("worker-gw-1", "correct-horse-battery-staple");

  // Start gateway on ephemeral port
  const executionStore = new ExecutionStore(engine);
  const gateway = new WorkerGateway(0, sessionStore, workerStore, auth, executionStore);
  gateway.start();
  await new Promise(resolve => setTimeout(resolve, 50));
  const port = (gateway as any).server.address().port;
  console.log(`Gateway listening on port ${port}`);

  const client = new WorkerGatewayClient(`http://127.0.0.1:${port}`, "worker-gw-1", "correct-horse-battery-staple");
  await client.connect();
  const ok = await client.authenticate("worker-gw-1", "correct-horse-battery-staple");
  assert(ok, "Worker authentication succeeds with correct credential");

  // Invalid credential should fail
  const badClient = new WorkerGatewayClient(`http://127.0.0.1:${port}`, "worker-gw-1", "wrong-password");
  await badClient.connect();
  const badAuth = await badClient.authenticate("worker-gw-1", "wrong-password");
  assert(!badAuth, "Invalid credential rejected");

  // Heartbeat
  await client.heartbeat("worker-gw-1");
  const workerAfter = workerStore.getWorker("worker-gw-1");
  assert(workerAfter?.lastHeartbeatAt !== undefined, "Heartbeat updates durable worker lastHeartbeatAt");

  // Offer job via gateway
  const job = {
    jobId: "job-gw-1",
    dispatchId: "dispatch-gw-1",
    leaseId: "lease-gw-1",
    operation: "node",
    args: ["-e", "console.log('gateway-test')"],
  };
  const leaseNow = Date.now();
  rawDb.prepare(`
    INSERT INTO execution_jobs (
      id, idempotency_key, job_type, status, created_at, updated_at, current_lease_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("job-gw-1", "idem-job-gw-1", "node", "RUNNING", leaseNow, leaseNow, "lease-gw-1");
  rawDb.prepare(`
    INSERT INTO execution_leases (
      lease_id, job_id, worker_id, acquired_at, expires_at, status
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run("lease-gw-1", "job-gw-1", "worker-gw-1", leaseNow, leaseNow + 60000, "ACTIVE");
  gateway.offerJob("worker-gw-1", job);

  // Worker receives job
  const received = await client.receiveJob("worker-gw-1");
  assert(received && received.dispatchId === "dispatch-gw-1", "Worker receives offered job via gateway");

  // Execute real local process via adapter (simulating WorkerAgent real path)
  const localAdapter = new LocalProcessExecutionAdapter();
  const result = await localAdapter.execute({ operation: received.operation, args: received.args });
  const workerResultBase = {
    jobId: received.jobId,
    dispatchId: received.dispatchId,
    leaseId: received.leaseId,
    success: result.success,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
  const workerResultWithChecksums = {
    ...workerResultBase,
    stdoutSha256: sha256Hex(workerResultBase.stdout ?? ""),
    stderrSha256: sha256Hex(workerResultBase.stderr ?? ""),
  };
  const workerResult = {
    ...workerResultWithChecksums,
    resultSha256: computeResultDigest(workerResultWithChecksums),
  };

  await client.reportResult("worker-gw-1", workerResult);

  // Verify gateway stored result
  const stored = gateway.getResult("job-gw-1");
  assert(stored && stored.result.dispatchId === "dispatch-gw-1", "Gateway stores real worker result");

  // Duplicate message rejection is enforced by WorkerTransportSecurity, but gateway client doesn't reuse messageId, so skip.

  gateway.stop();
  console.log(`\nWorker gateway integration: ${pass} PASS, ${fail} FAIL`);
  if (fail > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
