import { openEngine, resetEngineForTesting } from "../src/core/db";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import Database from "better-sqlite3";
import { ExecutionStore } from "../src/core/execution-store";
import { LeaseManager } from "../src/core/lease-manager";
import { RecoveryStore } from "../src/core/recovery-store";
import { RemoteWorkerStore } from "../src/core/remote-worker-store";
import { redactSecrets } from "../src/core/redaction";
import * as fs from "fs";
import * as path from "path";

let passed = 0, failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`PASS: ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL: ${name} - ${e.message}`); }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nexus_records (
  store TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (store, key)
);
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
CREATE TABLE IF NOT EXISTS execution_attempts (
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
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS execution_workers (
  worker_id TEXT PRIMARY KEY,
  hostname TEXT,
  capabilities TEXT,
  status TEXT NOT NULL,
  last_heartbeat_at INTEGER,
  current_job_id TEXT,
  registered_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS execution_leases (
  lease_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  renewed_at INTEGER,
  released_at INTEGER,
  status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS execution_artifacts (
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
CREATE TABLE IF NOT EXISTS execution_releases (
  release_id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  build_info TEXT,
  artifact_id TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS execution_deployments (
  deployment_id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  rollback_deployment_id TEXT,
  evidence TEXT
);
CREATE TABLE IF NOT EXISTS execution_approvals (
  approval_id TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  requested_action TEXT NOT NULL,
  decision TEXT NOT NULL,
  decided_at INTEGER,
  decided_by TEXT,
  reason TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS execution_events (
  event_id TEXT PRIMARY KEY,
  job_id TEXT,
  deployment_id TEXT,
  event_type TEXT NOT NULL,
  payload TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS recovery_policies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  target_type TEXT NOT NULL,
  conditions TEXT NOT NULL,
  actions TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS recovery_jobs (
  id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  error TEXT,
  result TEXT
);
CREATE TABLE IF NOT EXISTS remote_workers (
  worker_id TEXT PRIMARY KEY,
  hostname TEXT,
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
`;

async function main() {
  resetEngineForTesting();
  process.env.NEXUS_PERSISTENCE_ENGINE = "memory";
  const memEngine = await openEngine();
  await test("architecture: memory engine selected", () => { if (memEngine.kind !== "memory") throw new Error("expected memory"); });

  const rawDb = new Database(":memory:");
  const engine = SQLiteEngine.fromDatabase(rawDb);
  engine.exec(SCHEMA);

  // Generic engine tests (10)
  await test("engine put/get", async () => { await engine.put("kv", "k1", { a: 1 }); const v = await engine.get("kv", "k1"); if (!v || v.a !== 1) throw new Error("bad"); });
  await test("engine get missing", async () => { const v = await engine.get("kv", "missing"); if (v !== undefined) throw new Error("expected undefined"); });
  await test("engine all", async () => { await engine.put("kv", "k2", { a: 2 }); const all = await engine.all("kv"); if (all.length < 2) throw new Error("missing"); });
  await test("engine del", async () => { await engine.del("kv", "k2"); const v = await engine.get("kv", "k2"); if (v !== undefined) throw new Error("not deleted"); });
  await test("engine clear", async () => { await engine.put("kv", "tmp", {}); await engine.clear("kv"); if ((await engine.all("kv")).length !== 0) throw new Error("not cleared"); });
  await test("engine maxSeq", async () => { await engine.put("kv", "s1", { seq: 1 }); await engine.put("kv", "s2", { seq: 9 }); const m = await engine.maxSeq("kv"); if (m !== 9) throw new Error("bad max"); });
  await test("engine stores", () => { if (!engine.stores().includes("kv")) throw new Error("missing kv"); });
  await test("engine sqlQuery", () => { const rows = engine.sqlQuery("SELECT 1 as n"); if (rows[0].n !== 1) throw new Error("bad"); });
  await test("engine prepare get/all", () => { const stmt = engine.prepare("SELECT ? as x"); if (stmt.get(7).x !== 7) throw new Error("bad get"); if (stmt.all(8)[0].x !== 8) throw new Error("bad all"); });
  await test("engine exec multiple", () => { engine.exec("CREATE TABLE IF NOT EXISTS e1 (id INTEGER); CREATE TABLE IF NOT EXISTS e2 (id INTEGER);"); if (engine.sqlQuery("SELECT name FROM sqlite_master WHERE name = 'e1'").length !== 1) throw new Error("exec failed"); });

  // Transaction tests (4)
  await test("tx commit", () => { engine.transaction(() => { engine.prepare("CREATE TABLE IF NOT EXISTS tx (id INTEGER PRIMARY KEY, val TEXT)").run(); engine.prepare("INSERT INTO tx (val) VALUES (?)").run("a"); }); if (engine.prepare("SELECT val FROM tx WHERE id=1").get().val !== "a") throw new Error("not committed"); });
  await test("tx rollback", () => { try { engine.transaction(() => { engine.prepare("INSERT INTO tx (val) VALUES (?)").run("b"); throw new Error("force"); }); } catch {} if (engine.prepare("SELECT COUNT(*) as c FROM tx").get().c !== 1) throw new Error("rollback failed"); });
  await test("tx nested rollback", () => { try { engine.transaction(() => { engine.transaction(() => { engine.prepare("INSERT INTO tx (val) VALUES (?)").run("c"); }); throw new Error("outer"); }); } catch {} if (engine.prepare("SELECT COUNT(*) as c FROM tx").get().c !== 1) throw new Error("nested rollback failed"); });
  await test("tx constraint rollback", () => { try { engine.transaction(() => { engine.prepare("INSERT INTO execution_jobs (id, idempotency_key, job_type, status, created_at, updated_at) VALUES (?,?,?,?,?,?)").run("dup1","dupKey","test","PENDING",1,1); engine.prepare("INSERT INTO execution_jobs (id, idempotency_key, job_type, status, created_at, updated_at) VALUES (?,?,?,?,?,?)").run("dup2","dupKey","test","PENDING",1,1); }); } catch {} const cnt = engine.prepare("SELECT COUNT(*) as c FROM execution_jobs WHERE idempotency_key = ?").get("dupKey").c; if (cnt !== 0) throw new Error("constraint rollback failed"); });

  // ExecutionStore jobs (10)
  const execStore = new ExecutionStore(engine);
  for (let i = 1; i <= 10; i++) {
    const job = { id: `job${i}`, idempotencyKey: `idem${i}`, jobType: "test", payload: "{}", status: "PENDING", retryPolicy: "{}", timeoutMs: 1000, createdAt: Date.now(), updatedAt: Date.now() };
    await test(`execution: create job ${i}`, () => { execStore.createJob(job as any); if (!execStore.getJob(`job${i}`)) throw new Error("not created"); });
  }
  await test("execution: idempotency duplicate", () => { try { execStore.createJob({ id: "job11", idempotencyKey: "idem1", jobType: "test", payload: "{}", status: "PENDING", retryPolicy: "{}", timeoutMs: 1000, createdAt: Date.now(), updatedAt: Date.now() } as any); } catch { return; } throw new Error("should have thrown"); });
  await test("execution: list jobs by status", () => { if (execStore.listJobsByStatus("PENDING").length < 10) throw new Error("list failed"); });
  await test("execution: update job", () => { const job = execStore.getJob("job1"); job!.status = "RUNNING"; execStore.updateJob(job!); if (execStore.getJob("job1")?.status !== "RUNNING") throw new Error("update failed"); });
  await test("execution: register worker", () => { execStore.registerWorker({ workerId: "w1", hostname: "host", capabilities: "[]", status: "ACTIVE", lastHeartbeatAt: Date.now(), currentJobId: null, registeredAt: Date.now() } as any); if (!execStore.getWorker("w1")) throw new Error("worker missing"); });
  await test("execution: list workers", () => { if (execStore.listWorkers().length === 0) throw new Error("no workers"); });
  await test("execution: update worker", () => { const w = execStore.getWorker("w1"); w!.status = "DRAINING"; execStore.updateWorker(w!); if (execStore.getWorker("w1")?.status !== "DRAINING") throw new Error("worker update failed"); });

  // LeaseManager concurrency (4)
  const lm = new LeaseManager(execStore);
  await test("lease: acquire", () => { const lease = lm.acquireLease("job1", "w1", 60000); if (!lease || lease.jobId !== "job1") throw new Error("lease failed"); });
  await test("lease: duplicate prevention", () => { try { lm.acquireLease("job1", "w2", 60000); } catch { return; } throw new Error("duplicate allowed"); });
  await test("lease: release", () => { const active = lm.getActiveLeaseForJob("job1"); lm.releaseLease(active!.leaseId); const after = lm.getActiveLeaseForJob("job1"); if (after) throw new Error("lease not released"); });
  await test("lease: renew", () => { const lease = lm.acquireLease("job1", "w1", 60000); const renewed = lm.renewLease(lease.leaseId, 120000); if (renewed.expiresAt <= lease.expiresAt) throw new Error("renew failed"); });

  // Execution attempts (5)
  for (let i = 1; i <= 5; i++) {
    const attempt = { id: `att${i}`, jobId: "job1", attemptNumber: i, status: "COMPLETED", workerId: "w1", leaseId: null, startedAt: Date.now(), completedAt: Date.now(), error: null, evidence: null, createdAt: Date.now() };
    await test(`execution: create attempt ${i}`, () => { execStore.createAttempt(attempt as any); if (!execStore.getAttempt(`att${i}`)) throw new Error("missing"); });
  }
  await test("execution: list attempts", () => { if (execStore.listAttemptsForJob("job1").length < 5) throw new Error("list failed"); });

  // Artifacts (5)
  for (let i = 1; i <= 5; i++) {
    const artifact = { artifactId: `art${i}`, jobId: "job1", releaseId: null, name: `artifact${i}`, type: "binary", sizeBytes: 100, checksum: `sha256:${i}`, storageRef: `ref${i}`, metadata: "{}", createdAt: Date.now() };
    await test(`artifact: add ${i}`, () => { execStore.addArtifact(artifact as any); if (!execStore.getArtifact(`art${i}`)) throw new Error("missing"); });
  }

  // Releases (5)
  for (let i = 1; i <= 5; i++) {
    const release = { releaseId: `rel${i}`, version: `1.0.${i}`, buildInfo: "{}", artifactId: `art${i}`, status: "READY", createdAt: Date.now(), updatedAt: Date.now() };
    await test(`release: add ${i}`, () => { execStore.addRelease(release as any); if (!execStore.getRelease(`rel${i}`)) throw new Error("missing"); });
  }

  // Deployments (5)
  for (let i = 1; i <= 5; i++) {
    const deployment = { deploymentId: `dep${i}`, releaseId: `rel${i}`, environment: "staging", status: "DEPLOYED", createdAt: Date.now(), updatedAt: Date.now(), rollbackDeploymentId: null, evidence: null };
    await test(`deployment: add ${i}`, () => { execStore.addDeployment(deployment as any); if (!execStore.getDeployment(`dep${i}`)) throw new Error("missing"); });
  }

  // Approvals (5)
  for (let i = 1; i <= 5; i++) {
    const approval = { approvalId: `app${i}`, deploymentId: `dep${i}`, releaseId: `rel${i}`, environment: "staging", requestedAction: "deploy", decision: "APPROVED", decidedAt: Date.now(), decidedBy: "admin", reason: "", createdAt: Date.now() };
    await test(`approval: add ${i}`, () => { execStore.addApproval(approval as any); if (!execStore.getApproval(`app${i}`)) throw new Error("missing"); });
  }

  // Events (5)
  for (let i = 1; i <= 5; i++) {
    const event = { eventId: `evt${i}`, jobId: "job1", deploymentId: null, eventType: "INFO", payload: "{}", createdAt: Date.now() };
    await test(`event: add ${i}`, () => { execStore.addEvent(event as any); });
  }

  // RecoveryStore (5)
  const recovery = new RecoveryStore(engine);
  for (let i = 1; i <= 5; i++) {
    const pol = { id: `pol${i}`, name: `policy${i}`, targetType: "job", conditions: "{}", actions: "[]", enabled: true, createdAt: Date.now(), updatedAt: Date.now() };
    await test(`recovery: add policy ${i}`, () => { recovery.addPolicy(pol as any); if (!recovery.getPolicy(`pol${i}`)) throw new Error("missing"); });
  }
  await test("recovery: list policies", () => { if (recovery.listPolicies().length < 5) throw new Error("list failed"); });

  // RemoteWorkerStore (3)
  const remote = new RemoteWorkerStore(engine);
  for (let i = 1; i <= 3; i++) {
    const worker = { workerId: `rw${i}`, hostname: `host${i}`, platform: "linux", architecture: "x64", agentVersion: "1.0", capabilities: "[]", status: "ACTIVE", registeredAt: Date.now(), lastHeartbeatAt: Date.now(), currentJobId: null, metadata: "{}" };
    await test(`remote worker: register ${i}`, () => { remote.registerWorker(worker as any); if (!remote.getWorker(`rw${i}`)) throw new Error("missing"); });
  }
  await test("remote worker: list", () => { if (remote.listWorkers().length < 3) throw new Error("list failed"); });
  await test("remote worker: revoke", () => { remote.revokeWorker("rw1"); if (remote.getWorker("rw1")?.status !== "REVOKED") throw new Error("revoke failed"); });

  // Security redaction (3)
  await test("redact password", () => { if (redactSecrets("password=secret123").includes("secret123")) throw new Error("not redacted"); });
  await test("redact token", () => { if (redactSecrets("token=abc123").includes("abc123")) throw new Error("not redacted"); });
  await test("redact api key", () => { if (redactSecrets("api_key=xyz").includes("xyz")) throw new Error("not redacted"); });

  // Browser boundary (2)
  await test("browser: db.ts no native sqlite import", () => { const c = fs.readFileSync(path.join("src", "core", "db.ts"), "utf8"); if (c.includes(`from "better-sqlite3"`) || c.includes(`require("better-sqlite3")`)) throw new Error("native import leak"); });
  await test("browser: sqlite-engine isolated", () => { const c = fs.readFileSync(path.join("src", "core", "sqlite-engine.ts"), "utf8"); if (!c.includes("better-sqlite3")) throw new Error("missing native"); });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
main().catch(e => { console.error(e); process.exit(1); });
