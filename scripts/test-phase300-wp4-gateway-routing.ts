// scripts/test-phase300-wp4-gateway-routing.ts
// Phase 300 / WP4 - Gateway end-to-end routing test.
//
// Verifies the live handleMessage -> handlerRegistry -> jobResultHandler path
// in shared-persistence mode. Uses an in-memory SQLite engine for the
// gateway's session/security stores (they require kind === "sqlite") and an
// isolated PostgreSQL database for ExecutionStore (hasAsyncBackend() === true).
//
// Case coverage:
//   WP4-1  Successful JOB_RESULT routing                 (async path persists)
//   WP4-2  Stale worker / wrong lease rejection
//   WP4-3  Matching duplicate result                     (idempotent ACK)
//   WP4-4  Conflicting duplicate result                  (RESULT_CONFLICT)
//   WP4-5  Missing dispatch                              (ownership violation)
//   WP4-6  Gateway error mapping and response behavior
//   WP4-7  SQLite-only fallback compatibility            (hasAsyncBackend===false)

process.env.NEXUS_ENVELOPE_HMAC_KID ??= "test-k1";
process.env.NEXUS_ENVELOPE_HMAC_KEY_HEX ??= "ab".repeat(32);

import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { PgClient } from "../src/core/pg-client";
import { PgAsyncEngine } from "../src/core/pg-async-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { WorkerGateway } from "../src/core/worker-gateway";
import { WorkerSessionStore } from "../src/core/worker-session-store";
import { RemoteWorkerStore } from "../src/core/remote-worker-store";
import { WorkerAuthentication } from "../src/core/worker-authentication";
import { SqliteWorkerAuthStore } from "../src/core/sqlite-worker-auth-store";
import { EnvHmacKeyProvider } from "../src/core/envelope-hmac-key-provider";
import type { WorkerTransportMessage } from "../src/core/worker-transport-messages";
import { sha256Hex, computeResultDigest } from "../src/core/integrity";

type Result = "PASS" | "FAIL" | "BLOCKED" | "NOT EXECUTED";
interface Row { id: string; name: string; result: Result; note: string; }
const rows: Row[] = [];
function record(id: string, name: string, result: Result, note: string): void {
  rows.push({ id, name, result, note });
  const mark = result === "PASS" ? "[PASS]" : result === "FAIL" ? "[FAIL]" : result === "BLOCKED" ? "[BLK ]" : "[N/E ]";
  console.log(`${mark} ${id} ${name} -- ${note}`);
}
function ok(cond: boolean, msg: string): void { if (!cond) throw new Error(msg); }
async function test(id: string, name: string, fn: () => Promise<string>): Promise<void> {
  try { record(id, name, "PASS", await fn()); }
  catch (e) { record(id, name, "FAIL", e instanceof Error ? e.message : String(e)); }
}

async function pgExec(client: PgClient, sql: string, params: unknown[] = []): Promise<any> {
  return await client.query(sql, params);
}
async function createDb(admin: PgClient, name: string): Promise<void> { await pgExec(admin, `CREATE DATABASE "${name}"`); }
async function dropDb(admin: PgClient, name: string): Promise<void> { try { await pgExec(admin, `DROP DATABASE IF EXISTS "${name}"`); } catch {} }

async function bootstrapPg(client: PgClient): Promise<void> {
  await pgExec(client, `CREATE TABLE execution_jobs (id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE, job_type TEXT NOT NULL, payload TEXT, status TEXT NOT NULL, retry_policy TEXT, timeout_ms INTEGER, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, last_attempt_at BIGINT, next_attempt_at BIGINT, current_lease_id TEXT, cancellation_requested INTEGER NOT NULL DEFAULT 0, cancellation_acknowledged INTEGER NOT NULL DEFAULT 0, priority INTEGER NOT NULL DEFAULT 0)`);
  await pgExec(client, `CREATE TABLE execution_leases (lease_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, worker_id TEXT NOT NULL, acquired_at BIGINT NOT NULL, expires_at BIGINT NOT NULL, renewed_at BIGINT, released_at BIGINT, status TEXT NOT NULL)`);
  await pgExec(client, `CREATE TABLE remote_dispatches (dispatch_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, attempt_id TEXT, worker_id TEXT NOT NULL, lease_id TEXT, idempotency_key TEXT UNIQUE NOT NULL, status TEXT NOT NULL, external_provider_id TEXT, request TEXT, result TEXT, error TEXT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, FOREIGN KEY (job_id) REFERENCES execution_jobs(id))`);
  await pgExec(client, `CREATE TABLE remote_execution_results (result_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, attempt_id TEXT, worker_id TEXT, dispatch_id TEXT UNIQUE, lease_id TEXT, success INTEGER NOT NULL, exit_code INTEGER, stdout_ref TEXT, stderr_ref TEXT, evidence TEXT, created_at BIGINT NOT NULL, stdout_sha256 TEXT, stderr_sha256 TEXT, result_sha256 TEXT, verification_status TEXT, verified_at BIGINT, FOREIGN KEY (dispatch_id) REFERENCES remote_dispatches(dispatch_id) ON DELETE CASCADE)`);
}

function bootstrapSqliteGatewaySchema(rawDb: Database): void {
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

    CREATE TABLE IF NOT EXISTS worker_message_ids (
      message_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      seen_at INTEGER NOT NULL,
      handler_status TEXT NOT NULL DEFAULT 'PENDING',
      handler_owner_id TEXT,
      handler_claim_expires_at INTEGER,
      handler_attempt_count INTEGER NOT NULL DEFAULT 0,
      handler_recovery_reason TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      next_retry_at INTEGER,
      quarantine_reason TEXT,
      fencing_token INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS worker_message_envelopes (
      message_id TEXT PRIMARY KEY,
      message_type TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL,
      envelope_version INTEGER NOT NULL DEFAULT 1,
      accepted_at INTEGER NOT NULL,
      envelope_sha256 TEXT,
      kid TEXT,
      envelope_hmac TEXT,
      FOREIGN KEY (message_id) REFERENCES worker_message_ids(message_id)
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
}

function bootstrapSqliteExecutionTables(rawDb: Database): void {
  rawDb.exec(`
    CREATE TABLE execution_jobs (id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE, job_type TEXT NOT NULL, payload TEXT, status TEXT NOT NULL, retry_policy TEXT, timeout_ms INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_attempt_at INTEGER, next_attempt_at INTEGER, current_lease_id TEXT, cancellation_requested INTEGER NOT NULL DEFAULT 0, cancellation_acknowledged INTEGER NOT NULL DEFAULT 0, priority INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE execution_leases (lease_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, worker_id TEXT NOT NULL, acquired_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, renewed_at INTEGER, released_at INTEGER, status TEXT NOT NULL);
    CREATE TABLE remote_dispatches (dispatch_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, attempt_id TEXT, worker_id TEXT NOT NULL, lease_id TEXT, idempotency_key TEXT UNIQUE NOT NULL, status TEXT NOT NULL, external_provider_id TEXT, request TEXT, result TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, FOREIGN KEY (job_id) REFERENCES execution_jobs(id));
    CREATE TABLE remote_execution_results (result_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, attempt_id TEXT, worker_id TEXT, dispatch_id TEXT UNIQUE, lease_id TEXT, success INTEGER NOT NULL, exit_code INTEGER, stdout_ref TEXT, stderr_ref TEXT, evidence TEXT, created_at INTEGER NOT NULL, stdout_sha256 TEXT, stderr_sha256 TEXT, result_sha256 TEXT, verification_status TEXT, verified_at INTEGER, FOREIGN KEY (dispatch_id) REFERENCES remote_dispatches(dispatch_id) ON DELETE CASCADE);
  `);
}

async function seedDispatchPg(pg: PgClient, o: { dispatchId: string; jobId: string; workerId: string; leaseId: string; status?: string }): Promise<void> {
  const now = Date.now();
  await pgExec(pg, "INSERT INTO execution_jobs (id, idempotency_key, job_type, payload, status, retry_policy, timeout_ms, created_at, updated_at, last_attempt_at, next_attempt_at, current_lease_id, cancellation_requested, cancellation_acknowledged, priority) VALUES ($1, $2, 'remote.exec', '{}', 'RUNNING', NULL, NULL, $3, $3, NULL, NULL, NULL, 0, 0, 0) ON CONFLICT (id) DO NOTHING", [o.jobId, "idem-job-" + o.jobId, now]);
  await pgExec(pg, "INSERT INTO execution_leases (lease_id, job_id, worker_id, acquired_at, expires_at, renewed_at, released_at, status) VALUES ($1, $2, $3, $4, $5, NULL, NULL, 'ACTIVE') ON CONFLICT (lease_id) DO NOTHING", [o.leaseId, o.jobId, o.workerId, now, now + 3600_000]);
  await pgExec(pg, "INSERT INTO remote_dispatches (dispatch_id, job_id, worker_id, attempt_id, lease_id, status, created_at, updated_at, idempotency_key) VALUES ($1, $2, $3, NULL, $4, $5, $6, $6, $7) ON CONFLICT (dispatch_id) DO NOTHING", [o.dispatchId, o.jobId, o.workerId, o.leaseId, o.status ?? "DISPATCHED", now, "idem-" + o.dispatchId]);
}

function seedDispatchSqlite(rawDb: Database, o: { dispatchId: string; jobId: string; workerId: string; leaseId: string; status?: string }): void {
  const now = Date.now();
  rawDb.prepare("INSERT OR IGNORE INTO execution_jobs (id, idempotency_key, job_type, payload, status, created_at, updated_at) VALUES (?, ?, 'remote.exec', '{}', 'RUNNING', ?, ?)").run(o.jobId, "idem-job-" + o.jobId, now, now);
  rawDb.prepare("INSERT OR IGNORE INTO execution_leases (lease_id, job_id, worker_id, acquired_at, expires_at, status) VALUES (?, ?, ?, ?, ?, 'ACTIVE')").run(o.leaseId, o.jobId, o.workerId, now, now + 3600_000);
  rawDb.prepare("INSERT OR IGNORE INTO remote_dispatches (dispatch_id, job_id, worker_id, attempt_id, lease_id, status, created_at, updated_at, idempotency_key) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)").run(o.dispatchId, o.jobId, o.workerId, o.leaseId, o.status ?? "DISPATCHED", now, now, "idem-" + o.dispatchId);
}

interface Harness {
  gateway: WorkerGateway;
  sessions: WorkerSessionStore;
  sessionId: string;
  workerId: string;
  rawDb: Database;
  isolatedPg: PgClient | null;
  admin: PgClient | null;
  dbName: string | null;
  close: () => Promise<void>;
}

async function makeHarness(sharedMode: boolean): Promise<Harness> {
  const rawDb = new Database(":memory:");
  bootstrapSqliteGatewaySchema(rawDb);
  const engine = SQLiteEngine.fromDatabase(rawDb);

  let isolatedPg: PgClient | null = null;
  let admin: PgClient | null = null;
  let dbName: string | null = null;
  let executionStore: ExecutionStore;

  if (sharedMode) {
    if (!process.env.DATABASE_URL) throw new Error("shared mode requires DATABASE_URL");
    admin = new PgClient();
    await admin.connect(process.env.DATABASE_URL);
    dbName = "nexus_p300wp4_" + randomUUID().replace(/-/g, "").slice(0, 12);
    await createDb(admin, dbName);
    const url = new URL(process.env.DATABASE_URL);
    url.pathname = "/" + dbName;
    isolatedPg = new PgClient();
    await isolatedPg.connect(url.toString());
    await bootstrapPg(isolatedPg);
    const asyncEngine = new PgAsyncEngine(isolatedPg);
    executionStore = new (ExecutionStore as any)(rawDb, asyncEngine);
  } else {
    bootstrapSqliteExecutionTables(rawDb);
    executionStore = new (ExecutionStore as any)(engine, undefined);
  }

  const sessions = new WorkerSessionStore(engine);
  const workers = new RemoteWorkerStore(engine);
  const authStore = new SqliteWorkerAuthStore(engine);
  const auth = new WorkerAuthentication(authStore, undefined, engine);
  const hmacProvider = new EnvHmacKeyProvider(process.env as any);

  const gateway = new WorkerGateway(0, sessions, workers, auth, executionStore, engine, hmacProvider);

  const sessionId = "sess-" + randomUUID();
  const workerId = "worker-A";
  const now = Date.now();
  sessions.createSession({
    sessionId,
    workerId,
    status: "ACTIVE",
    protocolVersion: "1.0",
    createdAt: now,
    authenticatedAt: now,
    lastSeenAt: now,
    lastSequence: 0,
    expiresAt: now + 60_000,
  });

  return {
    gateway, sessions, sessionId, workerId, rawDb, isolatedPg, admin, dbName,
    close: async () => {
      try { await gateway.stop(); } catch {}
      try { if (isolatedPg) await isolatedPg.close(); } catch {}
      try { rawDb.close(); } catch {}
      try { if (admin && dbName) await dropDb(admin, dbName); } catch {}
      try { if (admin) await admin.close(); } catch {}
    },
  };
}

function makeEnvelope(h: Harness, type: string, payload: any, sequence: number): WorkerTransportMessage {
  return {
    messageId: "msg-" + randomUUID(),
    type: type as any,
    sessionId: h.sessionId,
    workerId: h.workerId,
    timestamp: Date.now(),
    protocolVersion: "1.0",
    sequence,
    payload,
  };
}

function makeValidJobResult(jobId: string, dispatchId: string, leaseId: string, workerId: string, marker: string = "hello") {
  const stdout = marker;
  const stderr = "";
  const stdoutSha256 = sha256Hex(stdout);
  const stderrSha256 = sha256Hex(stderr);
  const base = {
    jobId, dispatchId, leaseId, workerId,
    success: true, exitCode: 0,
    stdout, stderr,
    evidence: { test: true },
    stdoutSha256, stderrSha256,
  };
  const resultSha256 = computeResultDigest(base);
  return { ...base, resultSha256 };
}

async function main(): Promise<void> {
  const mode = (process.env.NEXUS_PERSISTENCE_MODE ?? "sqlite").toLowerCase();
  const hasDb = !!process.env.DATABASE_URL;
  console.log("mode=" + mode + " databaseUrl=" + (hasDb ? "set" : "unset"));

  if (mode !== "shared" || !hasDb) {
    for (const id of ["WP4-1","WP4-2","WP4-3","WP4-4","WP4-5","WP4-6","WP4-7"]) {
      record(id, "requires shared mode + DATABASE_URL", "BLOCKED",
             "NEXUS_PERSISTENCE_MODE=shared and DATABASE_URL required");
    }
    return;
  }

  // WP4-1 - successful JOB_RESULT
  await test("WP4-1", "successful JOB_RESULT through real gateway persists durably in PG", async () => {
    const h = await makeHarness(true);
    try {
      const jobId = "wp4-1-job-" + randomUUID();
      const dispatchId = "wp4-1-disp-" + randomUUID();
      const leaseId = "wp4-1-lease-" + randomUUID();
      await seedDispatchPg(h.isolatedPg!, { dispatchId, jobId, workerId: h.workerId, leaseId });
      const result = makeValidJobResult(jobId, dispatchId, leaseId, h.workerId);
      const resp = await (h.gateway as any).handleMessage(makeEnvelope(h, "JOB_RESULT", { jobId, result }, 1));
      ok(resp?.type === "JOB_RESULT_ACK", "expected ACK, got " + JSON.stringify(resp));
      const rrow = await pgExec(h.isolatedPg!, "SELECT * FROM remote_execution_results WHERE dispatch_id = $1", [dispatchId]);
      ok(rrow.rows.length === 1, "expected 1 result row, got " + rrow.rows.length);
      const drow = await pgExec(h.isolatedPg!, "SELECT status FROM remote_dispatches WHERE dispatch_id = $1", [dispatchId]);
      ok(drow.rows[0]?.status === "COMPLETED", "dispatch status=" + drow.rows[0]?.status);
      return "ACK + 1 row + COMPLETED";
    } finally { await h.close(); }
  });

  // WP4-2 - stale worker rejected
  await test("WP4-2", "wrong worker in result payload is rejected without writing", async () => {
    const h = await makeHarness(true);
    try {
      const jobId = "wp4-2-job-" + randomUUID();
      const dispatchId = "wp4-2-disp-" + randomUUID();
      const leaseId = "wp4-2-lease-" + randomUUID();
      await seedDispatchPg(h.isolatedPg!, { dispatchId, jobId, workerId: h.workerId, leaseId });
      const result = makeValidJobResult(jobId, dispatchId, leaseId, "worker-WRONG");
      let threw: any = null;
      try { await (h.gateway as any).handleMessage(makeEnvelope(h, "JOB_RESULT", { jobId, result }, 1)); }
      catch (e) { threw = e; }
      ok(threw !== null, "expected rejection, got success");
      const rrow = await pgExec(h.isolatedPg!, "SELECT COUNT(*)::int AS n FROM remote_execution_results WHERE dispatch_id = $1", [dispatchId]);
      ok(rrow.rows[0].n === 0, "no result row should exist");
      const drow = await pgExec(h.isolatedPg!, "SELECT status FROM remote_dispatches WHERE dispatch_id = $1", [dispatchId]);
      ok(drow.rows[0]?.status === "DISPATCHED", "dispatch unchanged");
      return "rejected: " + (threw?.message ?? "?");
    } finally { await h.close(); }
  });

  // WP4-3 - matching duplicate ACK
  await test("WP4-3", "matching duplicate returns ACK without a second row", async () => {
    const h = await makeHarness(true);
    try {
      const jobId = "wp4-3-job-" + randomUUID();
      const dispatchId = "wp4-3-disp-" + randomUUID();
      const leaseId = "wp4-3-lease-" + randomUUID();
      await seedDispatchPg(h.isolatedPg!, { dispatchId, jobId, workerId: h.workerId, leaseId });
      const result = makeValidJobResult(jobId, dispatchId, leaseId, h.workerId);
      const resp1 = await (h.gateway as any).handleMessage(makeEnvelope(h, "JOB_RESULT", { jobId, result }, 1));
      ok(resp1?.type === "JOB_RESULT_ACK", "first submit ACK");
      const resp2 = await (h.gateway as any).handleMessage(makeEnvelope(h, "JOB_RESULT", { jobId, result }, 2));
      ok(resp2?.type === "JOB_RESULT_ACK", "second submit ACK");
      const rrow = await pgExec(h.isolatedPg!, "SELECT COUNT(*)::int AS n FROM remote_execution_results WHERE dispatch_id = $1", [dispatchId]);
      ok(rrow.rows[0].n === 1, "expected exactly 1 row, got " + rrow.rows[0].n);
      return "both ACK; exactly 1 row";
    } finally { await h.close(); }
  });

  // WP4-4 - conflicting duplicate: DIFFERENT valid contents produce different digests.
  await test("WP4-4", "conflicting duplicate rejected with RESULT_CONFLICT, original preserved", async () => {
    const h = await makeHarness(true);
    try {
      const jobId = "wp4-4-job-" + randomUUID();
      const dispatchId = "wp4-4-disp-" + randomUUID();
      const leaseId = "wp4-4-lease-" + randomUUID();
      await seedDispatchPg(h.isolatedPg!, { dispatchId, jobId, workerId: h.workerId, leaseId });
      const result1 = makeValidJobResult(jobId, dispatchId, leaseId, h.workerId, "content-A");
      const resp1 = await (h.gateway as any).handleMessage(makeEnvelope(h, "JOB_RESULT", { jobId, result: result1 }, 1));
      ok(resp1?.type === "JOB_RESULT_ACK", "first submit ACK");
      const result2 = makeValidJobResult(jobId, dispatchId, leaseId, h.workerId, "content-B");
      ok(result1.resultSha256 !== result2.resultSha256, "precondition: digests must differ");
      let threw: any = null;
      try { await (h.gateway as any).handleMessage(makeEnvelope(h, "JOB_RESULT", { jobId, result: result2 }, 2)); }
      catch (e) { threw = e; }
      ok(threw !== null, "conflicting submit should reject");
      ok((threw?.message ?? "") === "conflicting_duplicate_result",
         "expected conflicting_duplicate_result, got " + (threw?.message ?? "?"));
      const rrow = await pgExec(h.isolatedPg!, "SELECT result_sha256 FROM remote_execution_results WHERE dispatch_id = $1", [dispatchId]);
      ok(rrow.rows.length === 1, "expected exactly 1 row, got " + rrow.rows.length);
      ok(rrow.rows[0].result_sha256 === result1.resultSha256, "original digest preserved");
      return "rejected conflicting; original preserved";
    } finally { await h.close(); }
  });

  // WP4-5 - missing dispatch
  await test("WP4-5", "missing dispatch rejected with dispatch_ownership_violation", async () => {
    const h = await makeHarness(true);
    try {
      const jobId = "wp4-5-job-" + randomUUID();
      const dispatchId = "wp4-5-disp-" + randomUUID();
      const leaseId = "wp4-5-lease-" + randomUUID();
      // Do NOT seed the dispatch — the preflight should fail.
      const result = makeValidJobResult(jobId, dispatchId, leaseId, h.workerId);
      let threw: any = null;
      try { await (h.gateway as any).handleMessage(makeEnvelope(h, "JOB_RESULT", { jobId, result }, 1)); }
      catch (e) { threw = e; }
      ok(threw !== null, "missing dispatch should reject");
      ok((threw?.message ?? "") === "dispatch_ownership_violation",
         "expected dispatch_ownership_violation, got " + (threw?.message ?? "?"));
      const rrow = await pgExec(h.isolatedPg!, "SELECT COUNT(*)::int AS n FROM remote_execution_results WHERE dispatch_id = $1", [dispatchId]);
      ok(rrow.rows[0].n === 0, "no result row should exist");
      return "rejected: " + threw?.message;
    } finally { await h.close(); }
  });

  // WP4-6 - three distinct rejection reasons. Each path uses a FRESH harness so
  // session.lastSequence starts at 0 for each path and sequence numbers cannot
  // collide across paths.
  await test("WP4-6", "gateway maps distinct rejection reasons to distinct error strings", async () => {
    // Path 1: ownership_lost (wrong worker)
    {
      const h = await makeHarness(true);
      try {
        const jobId = "wp4-6a-job-" + randomUUID();
        const dispatchId = "wp4-6a-disp-" + randomUUID();
        const leaseId = "wp4-6a-lease-" + randomUUID();
        await seedDispatchPg(h.isolatedPg!, { dispatchId, jobId, workerId: h.workerId, leaseId });
        const result = makeValidJobResult(jobId, dispatchId, leaseId, "worker-WRONG");
        let threw: any = null;
        try { await (h.gateway as any).handleMessage(makeEnvelope(h, "JOB_RESULT", { jobId, result }, 1)); }
        catch (e) { threw = e; }
        ok(threw?.message === "ownership_lost", "path1 expected ownership_lost, got " + (threw?.message ?? "no-throw"));
      } finally { await h.close(); }
    }
    // Path 2: invalid_result_integrity (stdout tampered after digest was computed)
    {
      const h = await makeHarness(true);
      try {
        const jobId = "wp4-6b-job-" + randomUUID();
        const dispatchId = "wp4-6b-disp-" + randomUUID();
        const leaseId = "wp4-6b-lease-" + randomUUID();
        await seedDispatchPg(h.isolatedPg!, { dispatchId, jobId, workerId: h.workerId, leaseId });
        const bad = makeValidJobResult(jobId, dispatchId, leaseId, h.workerId);
        bad.stdout = "tampered";
        let threw: any = null;
        try { await (h.gateway as any).handleMessage(makeEnvelope(h, "JOB_RESULT", { jobId, result: bad }, 1)); }
        catch (e) { threw = e; }
        ok(threw?.message === "invalid_result_integrity", "path2 expected invalid_result_integrity, got " + (threw?.message ?? "no-throw"));
      } finally { await h.close(); }
    }
    // Path 3: conflicting_duplicate_result
    {
      const h = await makeHarness(true);
      try {
        const jobId = "wp4-6c-job-" + randomUUID();
        const dispatchId = "wp4-6c-disp-" + randomUUID();
        const leaseId = "wp4-6c-lease-" + randomUUID();
        await seedDispatchPg(h.isolatedPg!, { dispatchId, jobId, workerId: h.workerId, leaseId });
        const r1 = makeValidJobResult(jobId, dispatchId, leaseId, h.workerId, "content-A");
        await (h.gateway as any).handleMessage(makeEnvelope(h, "JOB_RESULT", { jobId, result: r1 }, 1));
        const r2 = makeValidJobResult(jobId, dispatchId, leaseId, h.workerId, "content-B");
        let threw: any = null;
        try { await (h.gateway as any).handleMessage(makeEnvelope(h, "JOB_RESULT", { jobId, result: r2 }, 2)); }
        catch (e) { threw = e; }
        ok(threw?.message === "conflicting_duplicate_result", "path3 expected conflicting_duplicate_result, got " + (threw?.message ?? "no-throw"));
      } finally { await h.close(); }
    }
    return "3 distinct error paths mapped correctly";
  });

  // WP4-7 - SQLite-only fallback (hasAsyncBackend === false)
  await test("WP4-7", "SQLite-only mode routes through sync fallback and still ACKs", async () => {
    const h = await makeHarness(false);
    try {
      const jobId = "wp4-7-job-" + randomUUID();
      const dispatchId = "wp4-7-disp-" + randomUUID();
      const leaseId = "wp4-7-lease-" + randomUUID();
      seedDispatchSqlite(h.rawDb, { dispatchId, jobId, workerId: h.workerId, leaseId });
      const result = makeValidJobResult(jobId, dispatchId, leaseId, h.workerId);
      const resp = await (h.gateway as any).handleMessage(makeEnvelope(h, "JOB_RESULT", { jobId, result }, 1));
      ok(resp?.type === "JOB_RESULT_ACK", "expected ACK on SQLite path, got " + JSON.stringify(resp));
      const rrow = h.rawDb.prepare("SELECT * FROM remote_execution_results WHERE dispatch_id = ?").get(dispatchId) as any;
      ok(!!rrow, "expected result row in SQLite");
      const drow = h.rawDb.prepare("SELECT status FROM remote_dispatches WHERE dispatch_id = ?").get(dispatchId) as any;
      ok(drow?.status === "COMPLETED", "dispatch status=" + drow?.status);
      return "SQLite-only path works: ACK + row + COMPLETED";
    } finally { await h.close(); }
  });
}

main().then(() => {
  const pass = rows.filter(r => r.result === "PASS").length;
  const fail = rows.filter(r => r.result === "FAIL").length;
  const blk = rows.filter(r => r.result === "BLOCKED").length;
  const ne = rows.filter(r => r.result === "NOT EXECUTED").length;
  console.log("\n===== Phase 300 WP4 summary =====");
  console.log("PASS: " + pass);
  console.log("FAIL: " + fail);
  console.log("BLOCKED: " + blk);
  console.log("NOT EXECUTED: " + ne);
  process.exit(fail > 0 ? 1 : (blk > 0 || ne > 0) ? 2 : 0);
}).catch((e) => { console.error("FATAL:", e); process.exit(1); });
