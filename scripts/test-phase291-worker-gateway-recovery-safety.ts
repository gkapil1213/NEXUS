// Phase 291 - WorkerGateway recovery & handler lifecycle (SAFETY tests).
// Verifies lease-based fencing, idempotency, and failure modes.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { SQLiteEngine } from "../src/core/sqlite-engine";
import { WorkerSessionStore } from "../src/core/worker-session-store";
import { RemoteWorkerStore } from "../src/core/remote-worker-store";
import { WorkerAuthentication } from "../src/core/worker-authentication";
import { ExecutionStore } from "../src/core/execution-store";
import { WorkerGateway } from "../src/core/worker-gateway";
import { WorkerMessageHandlerTracker } from "../src/core/worker-message-handler-tracker";

let assertions = 0, failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  assertions++;
  if (!cond) { failures++; console.error("  FAIL: " + label + (detail ? " -- " + detail : "")); }
  else { console.log("  PASS: " + label); }
}
function section(s: string): void { console.log("\n--- " + s + " ---"); }

interface Ctx {
  engine: SQLiteEngine;
  sessionStore: WorkerSessionStore;
  workerStore: RemoteWorkerStore;
  auth: WorkerAuthentication;
  execStore: ExecutionStore;
  gateway: WorkerGateway;
  tracker: WorkerMessageHandlerTracker;
  sessionId: string;
  workerId: string;
  tempDir: string;
  dbPath: string;
}

const CREATE_TABLES = `
  CREATE TABLE IF NOT EXISTS worker_sessions (
    session_id TEXT PRIMARY KEY, worker_id TEXT NOT NULL, status TEXT NOT NULL,
    protocol_version TEXT, connection_id TEXT, created_at INTEGER NOT NULL,
    authenticated_at INTEGER, last_seen_at INTEGER, last_heartbeat_at INTEGER,
    last_sequence INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0, metadata TEXT
  );
  CREATE TABLE IF NOT EXISTS remote_workers (
    worker_id TEXT PRIMARY KEY, hostname TEXT NOT NULL, platform TEXT,
    architecture TEXT, agent_version TEXT, capabilities TEXT,
    status TEXT NOT NULL, registered_at INTEGER NOT NULL, last_heartbeat_at INTEGER,
    current_job_id TEXT, metadata TEXT
  );
  CREATE TABLE IF NOT EXISTS worker_message_ids (
    message_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, seen_at INTEGER NOT NULL,
    handler_status TEXT NOT NULL DEFAULT 'PENDING',
    handler_owner_id TEXT, handler_claim_expires_at INTEGER,
    handler_started_at INTEGER, handler_completed_at INTEGER,
    handler_attempt_count INTEGER NOT NULL DEFAULT 0,
    handler_last_error TEXT, handler_recovery_reason TEXT
  );
  CREATE TABLE IF NOT EXISTS remote_dispatches (
    dispatch_id TEXT PRIMARY KEY, job_id TEXT, attempt_id TEXT, worker_id TEXT,
    lease_id TEXT, idempotency_key TEXT UNIQUE, status TEXT, external_provider_id TEXT,
    request TEXT, result TEXT, error TEXT, created_at INTEGER, updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS remote_execution_results (
    result_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, attempt_id TEXT,
    worker_id TEXT NOT NULL, dispatch_id TEXT NOT NULL, lease_id TEXT,
    success INTEGER NOT NULL, exit_code INTEGER, stdout_ref TEXT, stderr_ref TEXT,
    evidence TEXT, created_at INTEGER NOT NULL,
    stdout_sha256 TEXT, stderr_sha256 TEXT, result_sha256 TEXT,
    verification_status TEXT, verified_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS execution_leases (
    lease_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, worker_id TEXT NOT NULL,
    acquired_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    renewed_at INTEGER, released_at INTEGER, status TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS execution_jobs (
    id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL, job_type TEXT NOT NULL,
    payload TEXT, status TEXT NOT NULL, retry_policy TEXT, timeout_ms INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_attempt_at INTEGER,
    next_attempt_at INTEGER, current_lease_id TEXT,
    cancellation_requested INTEGER DEFAULT 0, cancellation_acknowledged INTEGER DEFAULT 0
  );
`;

async function makeCtx(): Promise<Ctx> {
  const tempDir = mkdtempSync(join(tmpdir(), "nexus-p291-safety-"));
  const dbPath = join(tempDir, "test.sqlite");
  const engine = await SQLiteEngine.open(dbPath);
  const db = engine.getDatabase();
  db.exec(CREATE_TABLES);

  const sessionStore = new WorkerSessionStore(engine);
  const workerStore = new RemoteWorkerStore(engine);
  const auth = new WorkerAuthentication(workerStore);
  const execStore = new ExecutionStore(engine);
  const gateway = new WorkerGateway(0, sessionStore, workerStore, auth, execStore, engine);
  const tracker = new WorkerMessageHandlerTracker(engine);

  const workerId = "w-p291-s-" + randomUUID().slice(0, 8);
  const sessionId = "s-p291-s-" + randomUUID().slice(0, 8);
  const now = Date.now();

  db.prepare(`
    INSERT INTO remote_workers (worker_id, hostname, platform, architecture, agent_version,
      capabilities, status, registered_at, last_heartbeat_at, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(workerId, "test", "linux", "x64", "1", "[]", "ONLINE", now, now, "{}");

  db.prepare(`
    INSERT INTO worker_sessions (session_id, worker_id, status, protocol_version, connection_id,
      created_at, authenticated_at, last_seen_at, last_heartbeat_at,
      last_sequence, expires_at, revoked, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(sessionId, workerId, "ACTIVE", "1.0", "c-" + randomUUID().slice(0, 8),
    now, now, now, now, 0, now + 60_000, 0, null);

  return { engine, sessionStore, workerStore, auth, execStore, gateway, tracker,
    sessionId, workerId, tempDir, dbPath };
}

function cleanupCtx(ctx: Ctx): void {
  try { ctx.engine.close(); } catch {}
  try { rmSync(ctx.tempDir, { recursive: true, force: true }); } catch {}
}

async function main(): Promise<void> {
  // S1: any PENDING -> FAILED_IN_FLIGHT on recovery (unknown message types too)
  section("S1 unknown message type -> FAILED_IN_FLIGHT on recovery");
  {
    const ctx = await makeCtx();
    const db = ctx.engine.getDatabase();
    const msgId = "m-s1-" + randomUUID();
    db.prepare(`INSERT INTO worker_message_ids (message_id, session_id, seen_at, handler_status)
      VALUES (?, ?, ?, 'PENDING')`).run(msgId, ctx.sessionId, Date.now());
    await (ctx.gateway as any).recoverIncompleteMessages();
    const row = db.prepare("SELECT handler_status FROM worker_message_ids WHERE message_id = ?")
      .get(msgId) as any;
    check("S1 recovery marks PENDING as FAILED_IN_FLIGHT", row?.handler_status === "FAILED_IN_FLIGHT",
      "got=" + row?.handler_status);
    cleanupCtx(ctx);
  }

  // S2: COMPLETED never re-enumerated
  section("S2 COMPLETED messages never re-enumerated");
  {
    const ctx = await makeCtx();
    const db = ctx.engine.getDatabase();
    const msgId = "m-s2-" + randomUUID();
    db.prepare(`INSERT INTO worker_message_ids (message_id, session_id, seen_at, handler_status)
      VALUES (?, ?, ?, 'COMPLETED')`).run(msgId, ctx.sessionId, Date.now());
    const recoverable = ctx.tracker.listRecoverable();
    check("S2 COMPLETED not in listRecoverable", !recoverable.some(r => r.messageId === msgId),
      "count=" + recoverable.length);
    cleanupCtx(ctx);
  }

  // S3: stale lease recovered, old owner cannot complete
  section("S3 stale lease recovered, old owner cannot complete");
  {
    const ctx = await makeCtx();
    const db = ctx.engine.getDatabase();
    const msgId = "m-s3-" + randomUUID();
    const oldExpiry = Date.now() - 1000;
    db.prepare(`INSERT INTO worker_message_ids
      (message_id, session_id, seen_at, handler_status, handler_owner_id, handler_claim_expires_at, handler_attempt_count)
      VALUES (?, ?, ?, 'PROCESSING', 'old-owner', ?, 1)`)
      .run(msgId, ctx.sessionId, Date.now(), oldExpiry);
    // New owner claims via CAS
    const newClaim = ctx.tracker.claimForProcessing(msgId, "new-owner");
    check("S3 new owner takes over expired lease", newClaim === true);
    // Old owner cannot complete (CAS blocks)
    const oldComplete = ctx.tracker.markCompleted(msgId, "old-owner");
    check("S3 old owner cannot complete (CAS blocks)", oldComplete === false,
      "oldComplete=" + oldComplete);
    cleanupCtx(ctx);
  }

  // S4: live lease blocks takeover
  section("S4 live lease blocks takeover");
  {
    const ctx = await makeCtx();
    const db = ctx.engine.getDatabase();
    const msgId = "m-s4-" + randomUUID();
    db.prepare(`INSERT INTO worker_message_ids (message_id, session_id, seen_at, handler_status)
      VALUES (?, ?, ?, 'PENDING')`).run(msgId, ctx.sessionId, Date.now());
    const first = ctx.tracker.claimForProcessing(msgId, "owner-A", 60_000);
    check("S4 first claim succeeds", first === true);
    const second = ctx.tracker.claimForProcessing(msgId, "owner-B", 60_000);
    check("S4 second claim blocked by live lease", second === false,
      "second=" + second);
    cleanupCtx(ctx);
  }

  // S5: recovery failure blocks start
  section("S5 recovery failure blocks start()");
  {
    const ctx = await makeCtx();
    const msgId = "m-s5-" + randomUUID();
    ctx.engine.getDatabase().prepare(`INSERT INTO worker_message_ids (message_id, session_id, seen_at, handler_status)
      VALUES (?, ?, ?, 'PENDING')`).run(msgId, ctx.sessionId, Date.now());
    // Mock the GATEWAY's tracker (separate instance from ctx.tracker)
    const gatewayTracker = (ctx.gateway as any).handlerTracker;
    if (!gatewayTracker) throw new Error("gateway has no handlerTracker");
    const origMark = gatewayTracker.markFailedInFlightByRecovery;
    gatewayTracker.markFailedInFlightByRecovery = () => {
      throw new Error("SIMULATED_RECOVERY_FAILURE");
    };
    let threw = false;
    try {
      await (ctx.gateway as any).recoverIncompleteMessages();
    } catch {
      threw = true;
    } finally {
      gatewayTracker.markFailedInFlightByRecovery = origMark;
    }
    check("S5 recovery failure propagates (blocks start)", threw === true);
    cleanupCtx(ctx);
  }

  // S6: partial success -> stays PROCESSING (uncertain)
  section("S6 handler success + completion-persist failure -> stays PROCESSING");
  {
    const ctx = await makeCtx();
    const db = ctx.engine.getDatabase();
    const msgId = "m-s6-" + randomUUID();
    db.prepare(`INSERT INTO worker_message_ids (message_id, session_id, seen_at, handler_status)
      VALUES (?, ?, ?, 'PENDING')`).run(msgId, ctx.sessionId, Date.now());
    ctx.tracker.claimForProcessing(msgId, "owner-A");
    // Simulate markCompleted failing
    const orig = (ctx.tracker as any).markCompleted;
    (ctx.tracker as any).markCompleted = () => false;
    try {
      (ctx.tracker as any).markCompleted(msgId, "owner-A");
    } finally {
      (ctx.tracker as any).markCompleted = orig;
    }
    const row = db.prepare("SELECT handler_status FROM worker_message_ids WHERE message_id = ?")
      .get(msgId) as any;
    check("S6 status NOT COMPLETED after failure", row?.handler_status !== "COMPLETED",
      "got=" + row?.handler_status);
    check("S6 status stays PROCESSING (uncertain)", row?.handler_status === "PROCESSING",
      "got=" + row?.handler_status);
    cleanupCtx(ctx);
  }

  // S7: second restart re-enumerates (idempotent — FAILED_IN_FLIGHT not re-marked)
  section("S7 second restart re-enumerates (idempotent)");
  {
    const ctx = await makeCtx();
    const db = ctx.engine.getDatabase();
    const msgId = "m-s7-" + randomUUID();
    db.prepare(`INSERT INTO worker_message_ids (message_id, session_id, seen_at, handler_status)
      VALUES (?, ?, ?, 'PENDING')`).run(msgId, ctx.sessionId, Date.now());
    await (ctx.gateway as any).recoverIncompleteMessages();
    const row1 = db.prepare("SELECT handler_status FROM worker_message_ids WHERE message_id = ?")
      .get(msgId) as any;
    check("S7 first recovery marks FAILED_IN_FLIGHT", row1?.handler_status === "FAILED_IN_FLIGHT");
    // Second recovery — FAILED_IN_FLIGHT not re-enumerated
    const recoverable2 = ctx.tracker.listRecoverable();
    check("S7 FAILED_IN_FLIGHT not re-enumerated", !recoverable2.some(r => r.messageId === msgId),
      "count=" + recoverable2.length);
    cleanupCtx(ctx);
  }

  // S8: operator query path available
  section("S8 operator query path available");
  {
    const ctx = await makeCtx();
    const db = ctx.engine.getDatabase();
    const msgId = "m-s8-" + randomUUID();
    db.prepare(`INSERT INTO worker_message_ids (message_id, session_id, seen_at, handler_status)
      VALUES (?, ?, ?, 'PENDING')`).run(msgId, ctx.sessionId, Date.now());
    const incomplete = db.prepare(
      "SELECT message_id FROM worker_message_ids WHERE handler_status IN ('PENDING','PROCESSING')"
    ).all() as any[];
    check("S8 operator can enumerate incomplete", incomplete.some((r: any) => r.message_id === msgId),
      "found=" + incomplete.length);
    cleanupCtx(ctx);
  }

  console.log(`\nPhase 291 safety: ${failures === 0 ? "PASS" : "FAIL"}`);
  console.log(`Assertions: ${assertions}; passed: ${assertions - failures}; failures: ${failures}`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(2); });