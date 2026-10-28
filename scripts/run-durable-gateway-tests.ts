import { sha256Hex, computeResultDigest } from "../src/core/integrity";
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
  const auth = new WorkerAuthentication(authStore, undefined, engine);
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
  const leaseNow = Date.now();
  rawDb.prepare(`
    INSERT INTO execution_jobs (
      id, idempotency_key, job_type, status, created_at, updated_at, current_lease_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("job-durable-1", "idem-job-durable-1", "node", "RUNNING", leaseNow, leaseNow, "lease-durable-1");
  rawDb.prepare(`
    INSERT INTO execution_leases (
      lease_id, job_id, worker_id, acquired_at, expires_at, status
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run("lease-durable-1", "job-durable-1", "worker-durable", leaseNow, leaseNow + 60000, "ACTIVE");
  executionStore.upsertRemoteDispatch(dispatch);

  const gateway = new WorkerGateway(0, sessionStore, workerStore, auth, executionStore, engine);
  await gateway.start();
  const port = (gateway as any).server.address().port;

  const client = new WorkerGatewayClient(`http://127.0.0.1:${port}`, "worker-durable", "secret");
  await client.connect();
  const ok = await client.authenticate("worker-durable", "secret");
  assert(ok, "Authentication successful");

  await gateway.stop();
  const gateway2 = new WorkerGateway(0, sessionStore, workerStore, auth, executionStore, engine);
  await gateway2.start();
  const port2 = (gateway2 as any).server.address().port;
  const client2 = new WorkerGatewayClient(`http://127.0.0.1:${port2}`, "worker-durable", "secret");
  await client2.connect();
  const ok2 = await client2.authenticate("worker-durable", "secret");
  assert(ok2, "Re-authentication after restart");
  const job = await client2.receiveJob("worker-durable");
  assert(job && job.dispatchId === "dispatch-durable-1", "Durable job delivered after gateway restart");

  const resultPayloadBase = {
    jobId: job.jobId, dispatchId: job.dispatchId, leaseId: job.leaseId,
    success: true, stdout: "durable output", stderr: "", exitCode: 0,
  };
  const resultPayloadWithChecksums = {
    ...resultPayloadBase,
    stdoutSha256: sha256Hex(resultPayloadBase.stdout ?? ""),
    stderrSha256: sha256Hex(resultPayloadBase.stderr ?? ""),
  };
  const resultPayload = {
    ...resultPayloadWithChecksums,
    resultSha256: computeResultDigest(resultPayloadWithChecksums),
  };
  // Real HTTP integrity rejection: correct digest, but stale stdout checksum.
  const { resultSha256: _originalDigest, ...resultWithoutDigest } = resultPayload;
  const tamperedBase = { ...resultWithoutDigest, stdout: "tampered output" };
  const tamperedResult = {
    ...tamperedBase,
    resultSha256: computeResultDigest(tamperedBase),
  };

  let tamperedRejected = false;
  try {
    await client2.reportResult("worker-durable", tamperedResult);
  } catch {
    tamperedRejected = true;
  }
  assert(tamperedRejected, "Tampered output rejected over HTTP");
  assert(
    executionStore.getRemoteExecutionResultByDispatchId("dispatch-durable-1") === undefined,
    "Tampered first submission not persisted",
  );

  // Real HTTP integrity rejection: valid output checksums, invalid result digest.
  const badDigestResult = { ...resultPayload, resultSha256: "0".repeat(64) };
  let badDigestRejected = false;
  try {
    await client2.reportResult("worker-durable", badDigestResult);
  } catch {
    badDigestRejected = true;
  }
  assert(badDigestRejected, "Invalid result digest rejected over HTTP");
  assert(
    executionStore.getRemoteExecutionResultByDispatchId("dispatch-durable-1") === undefined,
    "Invalid-digest submission not persisted",
  );

  await client2.reportResult("worker-durable", resultPayload);
  const storedResult = executionStore.getRemoteExecutionResultByDispatchId("dispatch-durable-1");
  assert(storedResult !== undefined, "Durable result persisted");
  assert(storedResult.resultSha256 === resultPayload.resultSha256, "Result integrity preserved");

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
