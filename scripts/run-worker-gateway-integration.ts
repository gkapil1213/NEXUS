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
    CREATE TABLE IF NOT EXISTS worker_sessions (
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
  gateway.offerJob("worker-gw-1", job);

  // Worker receives job
  const received = await client.receiveJob("worker-gw-1");
  assert(received && received.dispatchId === "dispatch-gw-1", "Worker receives offered job via gateway");

  // Execute real local process via adapter (simulating WorkerAgent real path)
  const localAdapter = new LocalProcessExecutionAdapter();
  const result = await localAdapter.execute({ operation: received.operation, args: received.args });
  const workerResult = {
    jobId: received.jobId,
    dispatchId: received.dispatchId,
    leaseId: received.leaseId,
    success: result.success,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
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
