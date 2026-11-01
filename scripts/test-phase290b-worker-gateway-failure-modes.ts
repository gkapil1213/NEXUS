// Phase 292B: gateway now fails closed without HMAC key material.
// Test-only defaults; do not reuse outside the test suite.
process.env.NEXUS_ENVELOPE_HMAC_KID ??= "test-k1";
process.env.NEXUS_ENVELOPE_HMAC_KEY_HEX ??= "ab".repeat(32);
// Phase 290b - WorkerGateway failure-path verification.
// Closes charter Â§5 items 5, 6, 13, 14 from Phase 290.
//
// T5 and T6 use REAL code paths (no injection).
// T13 and T14 use SQLite triggers (RAISE(ROLLBACK)) to inject persistence
// errors at the exact statement-level that the transaction must roll back.

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
import { sha256Hex, computeResultDigest } from "../src/core/integrity";

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
    sessionId: string;
    workerId: string;
    tempDir: string;
    dbPath: string;
}

async function makeCtx(): Promise<Ctx> {
    const tempDir = mkdtempSync(join(tmpdir(), "nexus-p290b-"));
    const dbPath = join(tempDir, "test.sqlite");
    const engine = await SQLiteEngine.open(dbPath);
    const db = engine.getDatabase();

    db.exec(`
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
        message_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, seen_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS execution_jobs (
        id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL, job_type TEXT NOT NULL,
        payload TEXT, status TEXT NOT NULL, retry_policy TEXT, timeout_ms INTEGER,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_attempt_at INTEGER,
        next_attempt_at INTEGER, current_lease_id TEXT,
        cancellation_requested INTEGER DEFAULT 0, cancellation_acknowledged INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS execution_leases (
        lease_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, worker_id TEXT NOT NULL,
        acquired_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        renewed_at INTEGER, released_at INTEGER, status TEXT NOT NULL
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
    `);

    const sessionStore = new WorkerSessionStore(engine);
    const workerStore = new RemoteWorkerStore(engine);
    const auth = new WorkerAuthentication(workerStore);
    const execStore = new ExecutionStore(engine);
    const gateway = new WorkerGateway(0, sessionStore, workerStore, auth, execStore, engine);

    const workerId = "w-p290b-" + randomUUID().slice(0, 8);
    const sessionId = "s-p290b-" + randomUUID().slice(0, 8);
    const now = Date.now();

    db.prepare(`
      INSERT INTO remote_workers (
        worker_id, hostname, platform, architecture, agent_version,
        capabilities, status, registered_at, last_heartbeat_at, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(workerId, "test", "linux", "x64", "1", "[]", "ONLINE", now, now, "{}");

    db.prepare(`
      INSERT INTO worker_sessions (
        session_id, worker_id, status, protocol_version, connection_id,
        created_at, authenticated_at, last_seen_at, last_heartbeat_at,
        last_sequence, expires_at, revoked, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId, workerId, "ACTIVE", "1.0", "c-" + randomUUID().slice(0, 8),
      now, now, now, now, 0, now + 60_000, 0, null
    );

    return { engine, sessionStore, workerStore, auth, execStore, gateway, sessionId, workerId, tempDir, dbPath };
}

function cleanupCtx(ctx: Ctx): void {
    try { ctx.engine.close(); } catch {}
    try { rmSync(ctx.tempDir, { recursive: true, force: true }); } catch {}
}

function seedDispatchWithLease(
    ctx: Ctx,
    opts: { expiredLease?: boolean } = {}
): { dispatchId: string; jobId: string; leaseId: string; attemptId: string } {
    const db = ctx.engine.getDatabase();
    const now = Date.now();
    const dispatchId = "disp-" + randomUUID().slice(0, 8);
    const jobId = "job-" + randomUUID().slice(0, 8);
    const leaseId = "lease-" + randomUUID().slice(0, 8);
    const attemptId = "att-" + randomUUID().slice(0, 8);
    const expiresAt = opts.expiredLease ? now - 1_000 : now + 60_000;

    db.prepare(`
      INSERT INTO execution_jobs (id, idempotency_key, job_type, status, created_at, updated_at, current_lease_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(jobId, "idem-" + jobId, "node", "RUNNING", now, now, leaseId);

    db.prepare(`
      INSERT INTO execution_leases (lease_id, job_id, worker_id, acquired_at, expires_at, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(leaseId, jobId, ctx.workerId, now, expiresAt, "ACTIVE");

    db.prepare(`
      INSERT INTO remote_dispatches (
        dispatch_id, job_id, attempt_id, worker_id, lease_id, idempotency_key,
        status, request, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      dispatchId, jobId, attemptId, ctx.workerId, leaseId, "idem-disp-" + dispatchId,
      "DISPATCHED", JSON.stringify({ operation: "node", args: ["-e", "1"] }), now, now
    );

    return { dispatchId, jobId, leaseId, attemptId };
}

function buildValidResult(seed: { dispatchId: string; jobId: string; leaseId: string }): any {
    const base = {
        jobId: seed.jobId,
        dispatchId: seed.dispatchId,
        leaseId: seed.leaseId,
        success: true,
        stdout: "ok",
        stderr: "",
        exitCode: 0,
    };
    const withChecksums = {
        ...base,
        stdoutSha256: sha256Hex(base.stdout ?? ""),
        stderrSha256: sha256Hex(base.stderr ?? ""),
    };
    return {
        ...withChecksums,
        resultSha256: computeResultDigest(withChecksums),
    };
}

async function main(): Promise<void> {
    section("T5 JOB_RESULT with non-existent dispatch (preflight rejection)");
    {
        const ctx = await makeCtx();
        const messageId = "m-t5-" + randomUUID();
        const seq = 3;
        try {
            await (ctx.gateway as any).handleMessage({
                messageId, type: "JOB_RESULT", sessionId: ctx.sessionId,
                workerId: ctx.workerId, sequence: seq, timestamp: Date.now(),
                payload: { jobId: "no-such-job", result: { dispatchId: "no-such-dispatch" } },
            });
            check("T5 throws on non-existent dispatch", false);
        } catch (e: any) {
            check("T5 throws dispatch_ownership_violation",
                  e.message === "dispatch_ownership_violation", e.message);
        }
        const lastSeq = (ctx.engine.getDatabase()
            .prepare("SELECT last_sequence FROM worker_sessions WHERE session_id = ?")
            .get(ctx.sessionId) as any).last_sequence;
        check("T5 last_sequence UNCHANGED (preflight before transaction)",
              lastSeq === 0, "lastSeq=" + lastSeq);
        const msgRows = (ctx.engine.getDatabase()
            .prepare("SELECT COUNT(*) c FROM worker_message_ids WHERE message_id = ?")
            .get(messageId) as any).c;
        check("T5 no worker_message_ids row", msgRows === 0, "rows=" + msgRows);
        check("T5 no remote_execution_results row via store",
              ctx.execStore.getRemoteExecutionResultByDispatchId("no-such-dispatch") === undefined);
        cleanupCtx(ctx);
    }

    section("T6 JOB_RESULT with expired lease (handler failure after acceptance)");
    {
        const ctx = await makeCtx();
        const seed = seedDispatchWithLease(ctx, { expiredLease: true });
        const messageId = "m-t6-" + randomUUID();
        const seq = 5;
        const result = buildValidResult(seed);
        try {
            await (ctx.gateway as any).handleMessage({
                messageId, type: "JOB_RESULT", sessionId: ctx.sessionId,
                workerId: ctx.workerId, sequence: seq, timestamp: Date.now(),
                payload: { jobId: seed.jobId, result },
            });
            check("T6 throws on expired lease", false);
        } catch (e: any) {
            check("T6 throws ownership_lost", e.message === "ownership_lost", e.message);
        }
        const lastSeq = (ctx.engine.getDatabase()
            .prepare("SELECT last_sequence FROM worker_sessions WHERE session_id = ?")
            .get(ctx.sessionId) as any).last_sequence;
        check("T6 last_sequence CONSUMED (Strict B1: accepted before handler)",
              lastSeq === seq, "lastSeq=" + lastSeq);
        const msgRows = (ctx.engine.getDatabase()
            .prepare("SELECT COUNT(*) c FROM worker_message_ids WHERE message_id = ?")
            .get(messageId) as any).c;
        check("T6 worker_message_ids row EXISTS (Strict B1)", msgRows === 1, "rows=" + msgRows);
        check("T6 no remote_execution_results row (persist was rejected before write)",
              ctx.execStore.getRemoteExecutionResultByDispatchId(seed.dispatchId) === undefined);
        const dispatch = ctx.execStore.getRemoteDispatch(seed.dispatchId);
        check("T6 dispatch status UNCHANGED (persist was rejected before update)",
              dispatch?.status === "DISPATCHED", "status=" + dispatch?.status);
        cleanupCtx(ctx);
    }

    section("T13 persistence error during tryAdvanceSequence (trigger RAISE(ROLLBACK))");
    {
        const ctx = await makeCtx();
        const messageId = "m-t13-" + randomUUID();
        const seq = 7;
        const db = ctx.engine.getDatabase();
        const beforeWorker = db.prepare("SELECT last_heartbeat_at, status FROM remote_workers WHERE worker_id = ?")
            .get(ctx.workerId) as any;

        db.exec(`
          CREATE TRIGGER trg_t13_abort_update_sessions
          BEFORE UPDATE ON worker_sessions
          BEGIN
            SELECT RAISE(ROLLBACK, 'injected_persist_error_t13');
          END;
        `);

        try {
            await (ctx.gateway as any).handleMessage({
                messageId, type: "HEARTBEAT", sessionId: ctx.sessionId,
                workerId: ctx.workerId, sequence: seq, timestamp: Date.now(),
                payload: {},
            });
            check("T13 throws on injected persist error", false);
        } catch (e: any) {
            check("T13 error message contains injected_persist_error_t13",
                  /injected_persist_error_t13/i.test(e.message ?? ""), e.message);
        }

        db.exec(`DROP TRIGGER trg_t13_abort_update_sessions;`);

        const lastSeq = db.prepare("SELECT last_sequence FROM worker_sessions WHERE session_id = ?")
            .get(ctx.sessionId) as any;
        check("T13 last_sequence UNCHANGED (transaction rolled back)",
              lastSeq.last_sequence === 0, "lastSeq=" + lastSeq.last_sequence);
        const msgRows = db.prepare("SELECT COUNT(*) c FROM worker_message_ids WHERE message_id = ?")
            .get(messageId) as any;
        check("T13 no worker_message_ids row (transaction rolled back)",
              msgRows.c === 0, "rows=" + msgRows.c);
        const afterWorker = db.prepare("SELECT last_heartbeat_at, status FROM remote_workers WHERE worker_id = ?")
            .get(ctx.workerId) as any;
        check("T13 worker.last_heartbeat_at UNCHANGED (handler never ran)",
              afterWorker.last_heartbeat_at === beforeWorker.last_heartbeat_at);
        check("T13 worker.status UNCHANGED (handler never ran)",
              afterWorker.status === beforeWorker.status);
        cleanupCtx(ctx);
    }

    section("T14 persistence error during acceptMessageDurable (trigger RAISE(ROLLBACK))");
    {
        const ctx = await makeCtx();
        const messageId = "m-t14-" + randomUUID();
        const seq = 9;
        const db = ctx.engine.getDatabase();
        const beforeWorker = db.prepare("SELECT last_heartbeat_at, status FROM remote_workers WHERE worker_id = ?")
            .get(ctx.workerId) as any;

        db.exec(`
          CREATE TRIGGER trg_t14_abort_insert_message_ids
          BEFORE INSERT ON worker_message_ids
          BEGIN
            SELECT RAISE(ROLLBACK, 'injected_persist_error_t14');
          END;
        `);

        try {
            await (ctx.gateway as any).handleMessage({
                messageId, type: "HEARTBEAT", sessionId: ctx.sessionId,
                workerId: ctx.workerId, sequence: seq, timestamp: Date.now(),
                payload: {},
            });
            check("T14 throws on injected persist error", false);
        } catch (e: any) {
            check("T14 error message contains injected_persist_error_t14",
                  /injected_persist_error_t14/i.test(e.message ?? ""), e.message);
        }

        db.exec(`DROP TRIGGER trg_t14_abort_insert_message_ids;`);

        const lastSeq = db.prepare("SELECT last_sequence FROM worker_sessions WHERE session_id = ?")
            .get(ctx.sessionId) as any;
        check("T14 last_sequence UNCHANGED (CAS in same tx, rolled back by trigger)",
              lastSeq.last_sequence === 0, "lastSeq=" + lastSeq.last_sequence);
        const msgRows = db.prepare("SELECT COUNT(*) c FROM worker_message_ids WHERE message_id = ?")
            .get(messageId) as any;
        check("T14 no worker_message_ids row", msgRows.c === 0, "rows=" + msgRows.c);
        const afterWorker = db.prepare("SELECT last_heartbeat_at, status FROM remote_workers WHERE worker_id = ?")
            .get(ctx.workerId) as any;
        check("T14 worker.last_heartbeat_at UNCHANGED (handler never ran)",
              afterWorker.last_heartbeat_at === beforeWorker.last_heartbeat_at);
        check("T14 worker.status UNCHANGED (handler never ran)",
              afterWorker.status === beforeWorker.status);
        cleanupCtx(ctx);
    }

    console.log(`\nPhase 290b failure modes: ${failures === 0 ? "PASS" : "FAIL"}`);
    console.log(`Assertions: ${assertions}; passed: ${assertions - failures}; failures: ${failures}`);
    if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(2); });
