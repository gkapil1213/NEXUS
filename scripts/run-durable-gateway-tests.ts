import Database from "better-sqlite3";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { WorkerGateway, WorkerGatewayClient } from "../src/core/worker-gateway";
import { SqliteWorkerAuthStore } from "../src/core/sqlite-worker-auth-store";
import { WorkerAuthentication } from "../src/core/worker-authentication";
import { WorkerSessionStore } from "../src/core/worker-session-store";
import { RemoteWorkerStore } from "../src/core/remote-worker-store";
import { ExecutionStore } from "../src/core/execution-store";
import { RemoteDispatchRecord } from "../src/core/execution-models";

let pass = 0, fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { pass++; console.log(`PASS: ${msg}`); }
  else { fail++; console.error(`FAIL: ${msg}`); }
}

async function main() {
  const rawDb = new Database(":memory:");
  const engine = SQLiteEngine.fromDatabase(rawDb);
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS worker_sessions (
      session_id TEXT PRIMARY KEY, worker_id TEXT, status TEXT, protocol_version TEXT,
      connection_id TEXT, created_at INTEGER, authenticated_at INTEGER, last_seen_at INTEGER,
      last_heartbeat_at INTEGER, last_sequence INTEGER, expires_at INTEGER, revoked INTEGER DEFAULT 0, metadata TEXT
    );
    CREATE TABLE IF NOT EXISTS remote_workers (
      worker_id TEXT PRIMARY KEY, hostname TEXT, platform TEXT, architecture TEXT,
      agent_version TEXT, capabilities TEXT, status TEXT, registered_at INTEGER,
      last_heartbeat_at INTEGER, current_job_id TEXT, metadata TEXT
    );
    CREATE TABLE IF NOT EXISTS remote_dispatches (
      dispatch_id TEXT PRIMARY KEY, job_id TEXT, attempt_id TEXT, worker_id TEXT,
      lease_id TEXT, idempotency_key TEXT, status TEXT, external_provider_id TEXT,
      request TEXT, result TEXT, error TEXT, created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS remote_execution_results (
      result_id TEXT PRIMARY KEY, job_id TEXT, attempt_id TEXT, worker_id TEXT,
      dispatch_id TEXT, lease_id TEXT, success INTEGER, exit_code INTEGER, stdout_ref TEXT,
      stderr_ref TEXT, evidence TEXT, created_at INTEGER, stdout_sha256 TEXT,
      stderr_sha256 TEXT, result_sha256 TEXT, verification_status TEXT, verified_at INTEGER
    );
  `);

  const authStore = new SqliteWorkerAuthStore(engine);
  const auth = new WorkerAuthentication(authStore);
  const sessionStore = new WorkerSessionStore(engine);
  const workerStore = new RemoteWorkerStore(engine);
  const executionStore = new ExecutionStore(engine);

  workerStore.registerWorker({
    workerId: "worker-durable", hostname: "localhost", capabilities: { operations: ["node"] },
    status: "ONLINE", registeredAt: Date.now(),
  });
  authStore.setCredential("worker-durable", "secret");

  const dispatch: RemoteDispatchRecord = {
    dispatchId: "dispatch-durable-1", jobId: "job-durable-1", attemptId: "attempt-durable-1",
    workerId: "worker-durable", leaseId: "lease-durable-1", idempotencyKey: "idem-durable-1",
    status: "DISPATCHED", request: { operation: "node", args: ["-e", "console.log('durable')"] },
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  executionStore.upsertRemoteDispatch(dispatch);

  const gateway = new WorkerGateway(0, sessionStore, workerStore, auth, executionStore);
  await gateway.start();
  const port = (gateway as any).server.address().port;

  const client = new WorkerGatewayClient(`http://127.0.0.1:${port}`, "worker-durable", "secret");
  await client.connect();
  const ok = await client.authenticate("worker-durable", "secret");
  assert(ok, "Authentication successful");

  await gateway.stop();
  const gateway2 = new WorkerGateway(0, sessionStore, workerStore, auth, executionStore);
  await gateway2.start();
  const port2 = (gateway2 as any).server.address().port;
  const client2 = new WorkerGatewayClient(`http://127.0.0.1:${port2}`, "worker-durable", "secret");
  await client2.connect();
  const ok2 = await client2.authenticate("worker-durable", "secret");
  assert(ok2, "Re-authentication after restart");
  const job = await client2.receiveJob("worker-durable");
  assert(job && job.dispatchId === "dispatch-durable-1", "Durable job delivered after gateway restart");

  const resultPayload = {
    jobId: job.jobId, dispatchId: job.dispatchId, leaseId: job.leaseId,
    success: true, stdout: "durable output", exitCode: 0,
    stdoutSha256: "abc", resultSha256: "result-abc",
  };
  await client2.reportResult("worker-durable", resultPayload);
  const storedResult = executionStore.getRemoteExecutionResultByDispatchId("dispatch-durable-1");
  assert(storedResult !== undefined, "Durable result persisted");
  assert(storedResult.resultSha256 === "result-abc", "Result integrity preserved");

  await client2.reportResult("worker-durable", resultPayload);
  const countAfterDuplicate = rawDb.prepare("SELECT COUNT(*) as cnt FROM remote_execution_results WHERE dispatch_id=?").get("dispatch-durable-1") as any;
  assert(countAfterDuplicate.cnt === 1, "Duplicate result does not create new row");

  const conflicting = { ...resultPayload, stdout: "different", resultSha256: "different-sha" };
  let rejected = false;
  try { await client2.reportResult("worker-durable", conflicting); } catch (e: any) { rejected = true; }
  assert(rejected, "Conflicting duplicate rejected");
  const original = executionStore.getRemoteExecutionResultByDispatchId("dispatch-durable-1");
  assert(original?.stdoutRef === "durable output", "Original result unchanged after conflict");

  const sessionAfter = sessionStore.getActiveSessionForWorker("worker-durable");
  assert(sessionAfter && sessionAfter.lastSequence > 0, "Durable sequence persisted");
  const oldSeq = sessionAfter!.lastSequence;
  await client2.heartbeat("worker-durable");
  const updatedSession = sessionStore.getActiveSessionForWorker("worker-durable");
  assert(updatedSession!.lastSequence > oldSeq, "Sequence advanced durably");

  await gateway2.stop();
  console.log(`\nDurable gateway tests: ${pass} PASS, ${fail} FAIL`);
  if (fail > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
