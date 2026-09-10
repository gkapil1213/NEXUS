import Database from "better-sqlite3";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { WorkerGateway, WorkerGatewayClient } from "../src/core/worker-gateway";
import { SqliteWorkerAuthStore } from "../src/core/sqlite-worker-auth-store";
import { WorkerAuthentication } from "../src/core/worker-authentication";
import { WorkerSessionStore } from "../src/core/worker-session-store";
import { RemoteWorkerStore } from "../src/core/remote-worker-store";
import { ExecutionStore } from "../src/core/execution-store";
import { WorkerAgent } from "../src/core/worker-agent";
import { WorkerSandbox } from "../src/core/worker-sandbox";
import { WorkerSecurity } from "../src/core/worker-security";
import { WorkerConfig } from "../src/core/worker-config";
import { WorkerGatewayRemoteExecutionAdapter } from "../src/core/worker-gateway-remote-adapter";
import { ExecutionAdapterRequest } from "../src/core/execution-adapter";

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { pass++; console.log(`PASS: ${msg}`); }
  else { fail++; console.error(`FAIL: ${msg}`); }
}
async function expectThrow(fn: () => Promise<any>, needle: string, msg: string) {
  try {
    await fn();
    fail++; console.error(`FAIL: ${msg} (did not throw)`);
  } catch (e: any) {
    const s = String(e?.message ?? e);
    if (s.includes(needle)) { pass++; console.log(`PASS: ${msg}`); }
    else { fail++; console.error(`FAIL: ${msg} (threw: ${s})`); }
  }
}

async function main() {
  const rawDb = new Database(":memory:");
  const engine = SQLiteEngine.fromDatabase(rawDb);

  rawDb.exec(`
    CREATE TABLE worker_sessions (
      session_id TEXT PRIMARY KEY, worker_id TEXT NOT NULL, status TEXT NOT NULL,
      protocol_version TEXT, connection_id TEXT, created_at INTEGER NOT NULL,
      authenticated_at INTEGER, last_seen_at INTEGER, last_heartbeat_at INTEGER,
      last_sequence INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,
      metadata TEXT
    );
    CREATE TABLE remote_workers (
      worker_id TEXT PRIMARY KEY, hostname TEXT NOT NULL, platform TEXT, architecture TEXT,
      agent_version TEXT, capabilities TEXT, status TEXT NOT NULL, registered_at INTEGER NOT NULL,
      last_heartbeat_at INTEGER, current_job_id TEXT, metadata TEXT
    );
    CREATE TABLE remote_dispatches (
      dispatch_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
      worker_id TEXT NOT NULL, lease_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL, external_provider_id TEXT, request TEXT, result TEXT,
      error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE remote_execution_results (
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

  const workerId = "worker-adapter-e2e";
  const credential = "credential-adapter-e2e";
  workerStore.registerWorker({
    workerId,
    hostname: "localhost",
    capabilities: { operations: ["node", "process.exec"] },
    status: "ONLINE",
    registeredAt: Date.now(),
  });
  authStore.setCredential(workerId, credential);

  const gateway = new WorkerGateway(0, sessionStore, workerStore, auth, executionStore);
  await gateway.start();
  const port = (gateway as any).server.address().port;

  const client = new WorkerGatewayClient(`http://127.0.0.1:${port}`, workerId, credential);
  const agent = new WorkerAgent(
    { workerId, credentialRef: credential, capabilities: ["node"], allowedOperations: ["node"], allowedExecutables: ["node"] } as WorkerConfig,
    new WorkerSecurity({ allowedOperations: ["node"], allowedExecutables: ["node"] }),
    client,
    new WorkerSandbox()
  );
  await agent.start();

  // ===== T1: connect =====
  const adapter = new WorkerGatewayRemoteExecutionAdapter(gateway);
  await adapter.connect();
  assert(true, "T1 Adapter.connect() succeeds against real gateway");

  // ===== T2: dispatch =====
  const request: ExecutionAdapterRequest = {
    operation: "node",
    args: ["-e", "console.log('adapter-e2e-ok')"],
    timeoutMs: 5000,
    metadata: {
      jobId: "job-adapter-1",
      attemptId: "attempt-adapter-1",
      idempotencyKey: "idem-adapter-1",
    },
  };
  const { dispatchId } = await adapter.dispatch(request, workerId, "lease-adapter-1");
  assert(typeof dispatchId === "string" && dispatchId.length > 0, "T2 dispatchId returned");
  const persisted = executionStore.getRemoteDispatch(dispatchId);
  assert(!!persisted, "T2 durable dispatch record exists");
  assert(persisted!.workerId === workerId, "T2 workerId preserved");
  assert(persisted!.jobId === "job-adapter-1", "T2 jobId preserved");
  assert(persisted!.attemptId === "attempt-adapter-1", "T2 attemptId preserved");
  assert(persisted!.leaseId === "lease-adapter-1", "T2 leaseId preserved");
  assert(persisted!.idempotencyKey === "idem-adapter-1", "T2 idempotencyKey preserved");
  assert(persisted!.status === "DISPATCHED", "T2 status starts as DISPATCHED");

  // ===== T3: atomic claim + no double claim =====
  const firstClaim = executionStore.claimNextDispatchForWorker(workerId);
  assert(!!firstClaim && firstClaim!.dispatchId === dispatchId, "T3 worker claims dispatch");
  assert(firstClaim!.status === "DELIVERED", "T3 status DISPATCHED -> DELIVERED");
  const secondClaim = executionStore.claimNextDispatchForWorker(workerId);
  assert(secondClaim === undefined, "T3 same dispatch cannot be claimed twice");

  // ===== T4-T7: live worker execution, result, adapter status/result =====
  const liveRequest: ExecutionAdapterRequest = {
    operation: "node",
    args: ["-e", "console.log('adapter-e2e-ok')"],
    timeoutMs: 5000,
    metadata: {
      jobId: "job-adapter-live",
      attemptId: "attempt-adapter-live",
      idempotencyKey: "idem-adapter-live",
    },
  };
  const { dispatchId: liveId } = await adapter.dispatch(liveRequest, workerId, "lease-adapter-live");
  const jobResult: any = await agent.processOnce();
  assert(!!jobResult, "T4 WorkerAgent.processOnce returned a result");
  assert(jobResult.success === true, "T4 real execution succeeded");
  assert(String(jobResult.stdout ?? "").includes("adapter-e2e-ok"), "T4 real stdout contains expected output");

  const afterResult = executionStore.getRemoteDispatch(liveId);
  assert(afterResult!.status === "COMPLETED", "T5 dispatch transitioned to COMPLETED");

  const status = await adapter.getStatus(liveId);
  assert(status.status === "COMPLETED", "T6 Adapter.getStatus reports COMPLETED");

  const collected: any = await adapter.collectResult(liveId);
  assert(collected.success === true, "T7 collectResult.success=true");
  assert(collected.exitCode === 0, "T7 collectResult.exitCode=0");
  assert(String(collected.stdout ?? "").includes("adapter-e2e-ok"), "T7 collectResult.stdout present");
  const storedResult = executionStore.getRemoteExecutionResultByDispatchId(liveId);
  assert(!!storedResult, "T7 durable result persisted");
  assert(!!storedResult!.resultId, "T7 result identity present");

  // ===== T8: idempotency =====
  const { dispatchId: dupId } = await adapter.dispatch(request, workerId, "lease-adapter-1");
  assert(dupId === dispatchId, "T8 same idempotency key returns same dispatchId");
  const sameKeyCount = executionStore.listRemoteDispatchesByJob("job-adapter-1").length;
  assert(sameKeyCount === 1, "T8 only one logical dispatch for idempotency key");

  // ===== T9: identical duplicate result -> ACK =====
  const replayResult = { ...jobResult, resultSha256: storedResult!.resultSha256 };
  await client.reportResult(workerId, replayResult);
  assert(true, "T9 identical duplicate result ACKed");

  // ===== T10: conflicting duplicate -> rejected =====
  const conflicting = { ...replayResult, resultSha256: "deadbeef-conflict" };
  await expectThrow(
    () => client.reportResult(workerId, conflicting),
    "conflicting_duplicate_result",
    "T10 conflicting duplicate rejected"
  );

  // ===== T11: worker ownership =====
  const workerB = "worker-adapter-b";
  const credB = "credential-adapter-b";
  workerStore.registerWorker({
    workerId: workerB,
    hostname: "localhost",
    capabilities: { operations: ["node"] },
    status: "ONLINE",
    registeredAt: Date.now(),
  });
  authStore.setCredential(workerB, credB);
  const clientB = new WorkerGatewayClient(`http://127.0.0.1:${port}`, workerB, credB);
  await clientB.connect();
  const authedB = await clientB.authenticate(workerB, credB);
  assert(authedB, "T11 worker B authenticates");
  await expectThrow(
    () => clientB.reportResult(workerB, replayResult),
    "dispatch_ownership_violation",
    "T11 worker B cannot report on worker A's dispatch"
  );

  // ===== T12: cancellation explicitly not supported =====
  await expectThrow(
    () => client.cancelJob(workerId, liveId),
    "cancellation_not_implemented",
    "T12 cancellation explicitly rejected (not falsely reported as success)"
  );

  await agent.stop();
  await gateway.stop();

  console.log(`\nRemote Adapter E2E: ${pass} PASS, ${fail} FAIL`);
  if (fail > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });