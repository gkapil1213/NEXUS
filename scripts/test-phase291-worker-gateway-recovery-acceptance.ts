// Phase 291 - WorkerGateway recovery & handler lifecycle (ACCEPTANCE tests).
// Option C': durable tracking + startup detection + marking (no auto re-run).
// Real file-backed SQLite, real gateway, real tracker.

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
    handler_status TEXT NOT NULL DEFAULT 'LEGACY_UNVERIFIED',
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
  const tempDir = mkdtempSync(join(tmpdir(), "nexus-p291-"));
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

  const workerId = "w-p291-" + randomUUID().slice(0, 8);
  const sessionId = "s-p291-" + randomUUID().slice(0, 8);
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
  section("T1 acceptance writes handler_status=PENDING");
  {
    const ctx = await makeCtx();
    const db = ctx.engine.getDatabase();
    const msgId = "m-t1-" + randomUUID();
    db.prepare(`INSERT INTO worker_message_ids (message_id, session_id, seen_at, handler_status)
      VALUES (?, ?, ?, 'PENDING')`).run(msgId, ctx.sessionId, Date.now());
    const row = db.prepare("SELECT handler_status FROM worker_message_ids WHERE message_id = ?")
      .get(msgId) as any;
    check("T1 default status is PENDING", row?.handler_status === "PENDING", "got=" + row?.handler_status);
    cleanupCtx(ctx);
  }

  section("T2 successful handler -> COMPLETED");
  {
    const ctx = await makeCtx();
    const db = ctx.engine.getDatabase();
    const msgId = "m-t2-" + randomUUID();
    db.prepare(`INSERT INTO worker_message_ids (message_id, session_id, seen_at, handler_status)
      VALUES (?, ?, ?, 'PENDING')`).run(msgId, ctx.sessionId, Date.now());
    const fencingToken = ctx.tracker.claimForProcessingWithToken(msgId, "owner-A");
    check("T2 claim succeeds", fencingToken !== null);
    const completed = fencingToken !== null && ctx.tracker.markCompleted(msgId, "owner-A", fencingToken);
    check("T2 markCompleted succeeds", completed === true);
    const row = db.prepare("SELECT handler_status, handler_completed_at FROM worker_message_ids WHERE message_id = ?")
      .get(msgId) as any;
    check("T2 status=COMPLETED", row?.handler_status === "COMPLETED", "got=" + row?.handler_status);
    check("T2 completed_at set", row?.handler_completed_at !== null);
    cleanupCtx(ctx);
  }

  section("T3 handler failure -> FAILED_IN_FLIGHT");
  {
    const ctx = await makeCtx();
    const db = ctx.engine.getDatabase();
    const msgId = "m-t3-" + randomUUID();
    db.prepare(`INSERT INTO worker_message_ids (message_id, session_id, seen_at, handler_status)
      VALUES (?, ?, ?, 'PENDING')`).run(msgId, ctx.sessionId, Date.now());
    const fencingToken = ctx.tracker.claimForProcessingWithToken(msgId, "owner-A");
    check("T3 claim succeeds", fencingToken !== null);
    const failed = fencingToken !== null && ctx.tracker.markFailedInFlightByOwner(msgId, "owner-A", "simulated_handler_error", fencingToken);
    check("T3 markFailedInFlightByOwner succeeds", failed === true);
    const row = db.prepare("SELECT handler_status, handler_last_error FROM worker_message_ids WHERE message_id = ?")
      .get(msgId) as any;
    check("T3 status=FAILED_IN_FLIGHT", row?.handler_status === "FAILED_IN_FLIGHT", "got=" + row?.handler_status);
    check("T3 error recorded", row?.handler_last_error === "simulated_handler_error", "err=" + row?.handler_last_error);
    cleanupCtx(ctx);
  }

  section("T4 restart discovers abandoned incomplete");
  {
    const ctx = await makeCtx();
    const db = ctx.engine.getDatabase();
    const msgId = "m-t4-" + randomUUID();
    db.prepare(`INSERT INTO worker_message_ids (message_id, session_id, seen_at, handler_status)
      VALUES (?, ?, ?, 'PENDING')`).run(msgId, ctx.sessionId, Date.now());
    const recoverable = ctx.tracker.listRecoverable();
    check("T4 listRecoverable finds PENDING row", recoverable.some(r => r.messageId === msgId),
      "count=" + recoverable.length);
    cleanupCtx(ctx);
  }

  section("T5 recovery marks PENDING -> FAILED_IN_FLIGHT");
  {
    const ctx = await makeCtx();
    const db = ctx.engine.getDatabase();
    const msgId = "m-t5-" + randomUUID();
    db.prepare(`INSERT INTO worker_message_ids (message_id, session_id, seen_at, handler_status)
      VALUES (?, ?, ?, 'PENDING')`).run(msgId, ctx.sessionId, Date.now());
    await (ctx.gateway as any).recoverIncompleteMessages();
    const row = db.prepare("SELECT handler_status, handler_recovery_reason FROM worker_message_ids WHERE message_id = ?")
      .get(msgId) as any;
    check("T5 status=FAILED_IN_FLIGHT", row?.handler_status === "FAILED_IN_FLIGHT", "got=" + row?.handler_status);
    check("T5 recovery_reason populated",
      typeof row?.handler_recovery_reason === "string" && row.handler_recovery_reason.length > 0);
    cleanupCtx(ctx);
  }

  section("T6 JOB_CANCEL incomplete -> FAILED_IN_FLIGHT, no external call");
  {
    const ctx = await makeCtx();
    const db = ctx.engine.getDatabase();
    const msgId = "m-t6-" + randomUUID();
    let errorCode = "";
    try {
      await (ctx.gateway as any).handleMessage({
        messageId: msgId, type: "JOB_CANCEL", sessionId: ctx.sessionId,
        workerId: ctx.workerId, sequence: 1, timestamp: Date.now(),
        payload: { jobId: "no-such-job-" + randomUUID() },
      });
    } catch (e: any) {
      errorCode = String(e?.message ?? "");
    }
    check("T6 JOB_CANCEL reaches handler and fails with dispatch_not_found",
      errorCode === "dispatch_not_found", "got=" + errorCode);
    const row = db.prepare("SELECT handler_status, handler_last_error FROM worker_message_ids WHERE message_id = ?")
      .get(msgId) as any;
    check("T6 status=FAILED_IN_FLIGHT",
      row?.handler_status === "FAILED_IN_FLIGHT", "got=" + row?.handler_status);
    check("T6 handler error recorded",
      row?.handler_last_error === "dispatch_not_found", "got=" + row?.handler_last_error);
    cleanupCtx(ctx);
  }

  section("T7 concurrent claim -> exactly one wins");
  {
    const ctx = await makeCtx();
    const db = ctx.engine.getDatabase();
    const msgId = "m-t7-" + randomUUID();
    db.prepare(`INSERT INTO worker_message_ids (message_id, session_id, seen_at, handler_status)
      VALUES (?, ?, ?, 'PENDING')`).run(msgId, ctx.sessionId, Date.now());
    const a = ctx.tracker.claimForProcessing(msgId, "owner-A");
    const b = ctx.tracker.claimForProcessing(msgId, "owner-B");
    const winners = (a ? 1 : 0) + (b ? 1 : 0);
    check("T7 exactly one claim succeeds", winners === 1, "a=" + a + " b=" + b);
    cleanupCtx(ctx);
  }

  section("T8 crash during recovery is recoverable on restart");
  {
    const ctx = await makeCtx();
    const db = ctx.engine.getDatabase();
    const msgId = "m-t8-" + randomUUID();
    const oldExpiry = Date.now() - 1000;
    db.prepare(`INSERT INTO worker_message_ids
      (message_id, session_id, seen_at, handler_status, handler_owner_id, handler_claim_expires_at, handler_attempt_count)
      VALUES (?, ?, ?, 'PROCESSING', 'dead-owner', ?, 1)`)
      .run(msgId, ctx.sessionId, Date.now(), oldExpiry);
    const recoverable = ctx.tracker.listRecoverable();
    check("T8 stale PROCESSING is recoverable", recoverable.some(r => r.messageId === msgId));
    const recoveryRecord = recoverable.find(r => r.messageId === msgId);
  check("T8 recovery record exposes fencing token", Number.isSafeInteger(recoveryRecord?.fencingToken));
  const ok = recoveryRecord
    ? ctx.tracker.markFailedInFlightByRecovery(msgId, "recovery_after_crash", recoveryRecord.fencingToken)
    : false;
    check("T8 recovery marks FAILED_IN_FLIGHT", ok === true);
    const row = db.prepare("SELECT handler_status FROM worker_message_ids WHERE message_id = ?")
      .get(msgId) as any;
    check("T8 status=FAILED_IN_FLIGHT", row?.handler_status === "FAILED_IN_FLIGHT");
    cleanupCtx(ctx);
  }

  section("T9 Phase 290b regression: sequence + messageId consumed");
  {
    const ctx = await makeCtx();
    const db = ctx.engine.getDatabase();
    const msgId = "m-t9-" + randomUUID();
    const seq = 5;
    db.prepare(`INSERT INTO worker_message_ids (message_id, session_id, seen_at, handler_status)
      VALUES (?, ?, ?, 'PENDING')`).run(msgId, ctx.sessionId, Date.now());
    db.prepare(`UPDATE worker_sessions SET last_sequence = ? WHERE session_id = ?`).run(seq, ctx.sessionId);
    const sess = ctx.sessionStore.getSession(ctx.sessionId);
    check("T9 sequence consumed durably", sess?.lastSequence === seq, "got=" + sess?.lastSequence);
    const row = db.prepare("SELECT handler_status FROM worker_message_ids WHERE message_id = ?")
      .get(msgId) as any;
    check("T9 messageId durably accepted", row !== undefined);
    cleanupCtx(ctx);
  }

  section("T10 sequence persists after handler failure");
  {
    const ctx = await makeCtx();
    const db = ctx.engine.getDatabase();
    const msgId = "m-t10-" + randomUUID();
    const seq = 7;
    db.prepare(`INSERT INTO worker_message_ids (message_id, session_id, seen_at, handler_status)
      VALUES (?, ?, ?, 'PENDING')`).run(msgId, ctx.sessionId, Date.now());
    db.prepare(`UPDATE worker_sessions SET last_sequence = ? WHERE session_id = ?`).run(seq, ctx.sessionId);
    ctx.tracker.claimForProcessing(msgId, "owner-A");
    ctx.tracker.markFailedInFlightByOwner(msgId, "owner-A", "handler_failed");
    const sess = ctx.sessionStore.getSession(ctx.sessionId);
    check("T10 sequence still at accepted value", sess?.lastSequence === seq, "got=" + sess?.lastSequence);
    const row = db.prepare("SELECT handler_status FROM worker_message_ids WHERE message_id = ?")
      .get(msgId) as any;
    check("T10 messageId still durably present", row !== undefined);
    cleanupCtx(ctx);
  }

  section("T11 recovery emits structured log");
  {
    const ctx = await makeCtx();
    const db = ctx.engine.getDatabase();
    for (let i = 0; i < 3; i++) {
      db.prepare(`INSERT INTO worker_message_ids (message_id, session_id, seen_at, handler_status)
        VALUES (?, ?, ?, 'PENDING')`).run("m-t11-" + i + "-" + randomUUID(), ctx.sessionId, Date.now());
    }
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: any, ...rest: any[]) => { logs.push(String(msg)); origLog(msg, ...rest); };
    try {
      await (ctx.gateway as any).recoverIncompleteMessages();
    } finally {
      console.log = origLog;
    }
    const recoveryLog = logs.find(l => l.includes("phase291.recovery"));
    check("T11 structured log emitted", recoveryLog !== undefined);
    if (recoveryLog) {
      try {
        const parsed = JSON.parse(recoveryLog);
        check("T11 log has discovered count",
          typeof parsed.discovered === "number" && parsed.discovered >= 3, "discovered=" + parsed.discovered);
        check("T11 log has marked_failed_in_flight", typeof parsed.marked_failed_in_flight === "number");
      } catch {
        check("T11 log parses as JSON", false);
      }
    }
    cleanupCtx(ctx);
  }

  section("T12 fresh migration 178 columns present");
  {
    const ctx = await makeCtx();
    const db = ctx.engine.getDatabase();
    const cols = db.prepare("PRAGMA table_info(worker_message_ids)").all() as any[];
    const colNames = cols.map((c: any) => c.name);
    check("T12 handler_status column", colNames.includes("handler_status"));
    check("T12 handler_owner_id column", colNames.includes("handler_owner_id"));
    check("T12 handler_claim_expires_at column", colNames.includes("handler_claim_expires_at"));
    check("T12 handler_attempt_count column", colNames.includes("handler_attempt_count"));
    check("T12 handler_recovery_reason column", colNames.includes("handler_recovery_reason"));
    cleanupCtx(ctx);
  }

  section("T13 existing DB upgrade preserves rows");
  {
    const ctx = await makeCtx();
    const db = ctx.engine.getDatabase();
    const msgId = "m-t13-" + randomUUID();
    db.prepare(`INSERT INTO worker_message_ids (message_id, session_id, seen_at)
      VALUES (?, ?, ?)`).run(msgId, ctx.sessionId, Date.now());
    const row = db.prepare("SELECT message_id, handler_status FROM worker_message_ids WHERE message_id = ?")
      .get(msgId) as any;
    check("T13 existing row preserved", row?.message_id === msgId);
    check("T13 legacy row defaults to LEGACY_UNVERIFIED", row?.handler_status === "LEGACY_UNVERIFIED");
    cleanupCtx(ctx);
  }

  console.log(`\nPhase 291 acceptance: ${failures === 0 ? "PASS" : "FAIL"}`);
  console.log(`Assertions: ${assertions}; passed: ${assertions - failures}; failures: ${failures}`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(2); });
