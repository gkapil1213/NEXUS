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
import { WorkerTransport } from "../src/core/worker-transport";

let pass = 0;
let fail = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    pass++;
    console.log(`PASS: ${message}`);
  } else {
    fail++;
    console.error(`FAIL: ${message}`);
  }
}

class GatewayWorkerTransport implements WorkerTransport {
  constructor(
    private client: WorkerGatewayClient
  ) {}

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async authenticate(workerId: string, credential: string): Promise<boolean> {
    return this.client.authenticate(workerId, credential);
  }

  async heartbeat(workerId: string, currentJobId?: string): Promise<void> {
    await this.client.heartbeat(workerId, currentJobId);
  }

  async receiveJob(workerId: string): Promise<any | null> {
    return this.client.receiveJob(workerId);
  }

  async reportResult(workerId: string, result: any): Promise<void> {
    await this.client.reportResult(workerId, result);
  }

  async cancelJob(workerId: string, jobId: string): Promise<void> {
    await this.client.cancelJob(workerId, jobId);
  }

  async disconnect(): Promise<void> {
    await this.client.disconnect();
  }
}

async function main(): Promise<void> {
  const rawDb = new Database(":memory:");
  const engine = SQLiteEngine.fromDatabase(rawDb);

  rawDb.exec(`
    CREATE TABLE worker_sessions (
      session_id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL,
      status TEXT NOT NULL,
      protocol_version TEXT,
      connection_id TEXT,
      created_at INTEGER NOT NULL,
      authenticated_at INTEGER,
      last_seen_at INTEGER,
      last_heartbeat_at INTEGER,
      last_sequence INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0,
      metadata TEXT
    );

    CREATE TABLE remote_dispatches (
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

    CREATE TABLE remote_execution_results (
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
  `);

  const authStore = new SqliteWorkerAuthStore(engine);
  const auth = new WorkerAuthentication(authStore);
  const sessionStore = new WorkerSessionStore(engine);
  const workerStore = new RemoteWorkerStore(engine);
const executionStore = new ExecutionStore(engine);

  const workerId = "worker-e2e-1";
  const credential = "gateway-e2e-credential";

  workerStore.registerWorker({
    workerId,
    hostname: "localhost",
    platform: process.platform,
    architecture: process.arch,
    agentVersion: "e2e-test",
    capabilities: {
      operations: ["node"],
    },
    status: "ONLINE",
    registeredAt: Date.now(),
  });

  authStore.setCredential(workerId, credential);

  const gateway = new WorkerGateway(
    0,
    sessionStore,
    workerStore,
    auth,
    executionStore
  );

  gateway.start();

  await new Promise(resolve => setTimeout(resolve, 50));

  const port = (gateway as any).server.address().port;

  console.log(`Gateway listening on port ${port}`);

  const client = new WorkerGatewayClient(
    `http://127.0.0.1:${port}`,
    workerId,
    credential
  );

  const transport = new GatewayWorkerTransport(client);

  const config: WorkerConfig = {
    workerId,
    credentialRef: credential,
    capabilities: ["node"],
    executionTimeoutMs: 5000,
    heartbeatIntervalMs: 30000,
  };

  const security = new WorkerSecurity({
    allowedOperations: ["node"],
    allowedExecutables: ["node"],
  });

  const sandbox = new WorkerSandbox();

  const agent = new WorkerAgent(
    config,
    security,
    transport,
    sandbox
  );

  try {
    await agent.start();

    assert(true, "WorkerAgent authenticated through real gateway transport");

    const job = {
      jobId: "job-gateway-agent-e2e",
      dispatchId: "dispatch-gateway-agent-e2e",
      leaseId: "lease-gateway-agent-e2e",
      operation: "node",
      executable: "node",
      args: [
        "-e",
        "process.stdout.write('NEXUS_GATEWAY_AGENT_REAL_EXECUTION')"
      ],
      cwd: process.cwd(),
      timeoutMs: 5000,
    };

    gateway.offerJob(workerId, job);

    const result = await agent.processOnce();

    assert(
      result !== null,
      "WorkerAgent received a real job from the HTTP gateway"
    );

    assert(
      result?.success === true,
      "WorkerAgent completed the real process successfully"
    );

    assert(
      result?.stdout?.includes("NEXUS_GATEWAY_AGENT_REAL_EXECUTION") === true,
      "Real process stdout returned through WorkerAgent"
    );

    assert(
      result?.jobId === job.jobId,
      "Result preserves job identity"
    );

    assert(
      result?.dispatchId === job.dispatchId,
      "Result preserves dispatch identity"
    );

    assert(
      result?.leaseId === job.leaseId,
      "Result preserves lease identity"
    );

    assert(
      result?.stdoutSha256 !== undefined,
      "WorkerAgent generated stdout integrity digest"
    );

    assert(
      result?.resultSha256 !== undefined,
      "WorkerAgent generated result integrity digest"
    );

    const stored = gateway.getResult(job.jobId);

    assert(
      stored !== undefined,
      "Gateway received the WorkerAgent result"
    );

    assert(
      stored?.workerId === workerId,
      "Gateway result is associated with the correct worker"
    );

    assert(
      stored?.result?.dispatchId === job.dispatchId,
      "Gateway stored the correct dispatch result"
    );

    const worker = workerStore.getWorker(workerId);

    assert(
      worker?.lastHeartbeatAt !== undefined,
      "Worker heartbeat reached durable worker state"
    );

    await agent.stop();

    console.log(`\nWORKER_GATEWAY_AGENT_E2E: ${pass} PASS, ${fail} FAIL`);

    if (fail > 0) {
      process.exitCode = 1;
    }
  } finally {
    try {
      await agent.stop();
    } catch {
      // Agent may already be stopped.
    }

    try {
      gateway.stop();
    } catch {
      // Gateway may already be stopped.
    }

    rawDb.close();
  }
}

main().catch(err => {
  console.error("Worker gateway agent E2E harness error:", err);
  process.exit(1);
});
