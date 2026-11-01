// Phase 292B: gateway now fails closed without HMAC key material.
// Test-only defaults; do not reuse outside the test suite.
process.env.NEXUS_ENVELOPE_HMAC_KID ??= "test-k1";
process.env.NEXUS_ENVELOPE_HMAC_KEY_HEX ??= "ab".repeat(32);
// Phase 290 - transactional worker sequence consumption (Design B, Strict B1).
// Real file-backed SQLite. No mocks of transaction/uniqueness behavior.
//
// Charter Â§5 coverage (implemented here):
//   1  concurrent same messageId + same sequence
//   2  concurrent same sequence, different messageIds
//   3  concurrent distinct sequences
//   4  duplicate after success
//   7  restart recovery after accept
//  11  out-of-order + repeated sequence
//  12  session isolation
//  16  JOB_CANCEL not spanned by transaction (observational)
//
// Coverage via existing suites (run in verification):
//   9, 10  timestamp rules          -> test-phase288 A5/A6
//  15      JOB_RESULT integrity     -> test-phase288 E3-E8
//  17, 18  migration integrity     -> test-phase195
//  20      regression               -> all 8 gateway suites
//
// Explicitly NOT EXECUTED here (documented in closure report):
//   5, 6   handler-fail-before/after-side-effect (needs injected mock DispatchService)
//  13, 14 persistence errors during accept/complete (needs monkeypatching)

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
    const tempDir = mkdtempSync(join(tmpdir(), "nexus-p290-"));
    const dbPath = join(tempDir, "test.sqlite");
    const engine = await SQLiteEngine.open(dbPath);
    const db = engine.getDatabase();

    // Insert session + worker rows directly via SQL to avoid depending on
    // RemoteWorkerStore's internal API (which may not expose createWorker).
    // Phase 290's transactional path only needs:
    //  - a worker_sessions row that sessionStore.getSession can read
    //  - a remote_workers row that workerStore.getWorker can read (HEARTBEAT)
    const workerId = "w-p290-" + randomUUID().slice(0, 8);
    const sessionId = "s-p290-" + randomUUID().slice(0, 8);
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

    const sessionStore = new WorkerSessionStore(engine);
    const workerStore = new RemoteWorkerStore(engine);
    const auth = new WorkerAuthentication(workerStore);
    const execStore = new ExecutionStore(engine);
    const gateway = new WorkerGateway(0, sessionStore, workerStore, auth, execStore, engine);

    return { engine, sessionStore, workerStore, auth, execStore, gateway, sessionId, workerId, tempDir, dbPath };
}

function cleanupCtx(ctx: Ctx): void {
    try { ctx.engine.close(); } catch {}
    try { rmSync(ctx.tempDir, { recursive: true, force: true }); } catch {}
}

async function main(): Promise<void> {
    // T1 - the critical test: same messageId AND same sequence.
    // Under the buggy version, the loser's CAS advanced last_sequence. Under
    // the fixed version, the loser's transaction rolls back.
    section("T1 concurrent same messageId AND same sequence");
    {
        const ctx = await makeCtx();
        const msgId = "m-t1-" + randomUUID();
        const seq = 5;
        const [r1, r2] = await Promise.all([
            (ctx.gateway as any).handleMessage({
                messageId: msgId, type: "HEARTBEAT", sessionId: ctx.sessionId,
                workerId: ctx.workerId, sequence: seq, timestamp: Date.now(), payload: {},
            }).then(() => "ok").catch((e: any) => e.message),
            (ctx.gateway as any).handleMessage({
                messageId: msgId, type: "HEARTBEAT", sessionId: ctx.sessionId,
                workerId: ctx.workerId, sequence: seq, timestamp: Date.now(), payload: {},
            }).then(() => "ok").catch((e: any) => e.message),
        ]);
        const okCount = [r1, r2].filter(x => x === "ok").length;
        const dups = [r1, r2].filter(x => x === "duplicate_message").length;
        const seqLosses = [r1, r2].filter(x => x === "invalid_sequence").length;
        check("T1 exactly one of two concurrent same-messageId requests succeeds",
              okCount === 1, JSON.stringify({ r1, r2 }));
        check("T1 the loser rejected (duplicate_message or invalid_sequence)",
              dups + seqLosses === 1, JSON.stringify({ r1, r2 }));
        const rows = (ctx.engine.getDatabase()
            .prepare("SELECT COUNT(*) c FROM worker_message_ids WHERE message_id = ?").get(msgId) as any).c;
        check("T1 exactly one messageId row exists", rows === 1, "rows=" + rows);
        const lastSeq = (ctx.engine.getDatabase()
            .prepare("SELECT last_sequence FROM worker_sessions WHERE session_id = ?")
            .get(ctx.sessionId) as any).last_sequence;
        check("T1 last_sequence === seq (loser did NOT consume sequence)",
              lastSeq === seq, "lastSeq=" + lastSeq);
        cleanupCtx(ctx);
    }

    // T2 - two different messageIds, same sequence.
    section("T2 concurrent same sequence, different messageIds");
    {
        const ctx = await makeCtx();
        const seq = 5;
        const [r1, r2] = await Promise.all([
            (ctx.gateway as any).handleMessage({
                messageId: "m-t2a-" + randomUUID(), type: "HEARTBEAT",
                sessionId: ctx.sessionId, workerId: ctx.workerId,
                sequence: seq, timestamp: Date.now(), payload: {},
            }).then(() => "ok").catch((e: any) => e.message),
            (ctx.gateway as any).handleMessage({
                messageId: "m-t2b-" + randomUUID(), type: "HEARTBEAT",
                sessionId: ctx.sessionId, workerId: ctx.workerId,
                sequence: seq, timestamp: Date.now(), payload: {},
            }).then(() => "ok").catch((e: any) => e.message),
        ]);
        const okCount = [r1, r2].filter(x => x === "ok").length;
        const seqLosses = [r1, r2].filter(x => x === "invalid_sequence").length;
        check("T2 exactly one of two concurrent same-sequence requests succeeds",
              okCount === 1, JSON.stringify({ r1, r2 }));
        check("T2 the loser throws invalid_sequence", seqLosses === 1, JSON.stringify({ r1, r2 }));
        const last = (ctx.engine.getDatabase()
            .prepare("SELECT last_sequence FROM worker_sessions WHERE session_id = ?")
            .get(ctx.sessionId) as any).last_sequence;
        check("T2 last_sequence === seq (monotone, exactly once)",
              last === seq, "last=" + last);
        cleanupCtx(ctx);
    }

    // T3 - concurrent distinct sequences.
    section("T3 concurrent distinct sequences");
    {
        const ctx = await makeCtx();
        const [r1, r2] = await Promise.all([
            (ctx.gateway as any).handleMessage({
                messageId: "m-t3a-" + randomUUID(), type: "HEARTBEAT",
                sessionId: ctx.sessionId, workerId: ctx.workerId,
                sequence: 5, timestamp: Date.now(), payload: {},
            }).then(() => "ok").catch((e: any) => e.message),
            (ctx.gateway as any).handleMessage({
                messageId: "m-t3b-" + randomUUID(), type: "HEARTBEAT",
                sessionId: ctx.sessionId, workerId: ctx.workerId,
                sequence: 6, timestamp: Date.now(), payload: {},
            }).then(() => "ok").catch((e: any) => e.message),
        ]);
        const last = (ctx.engine.getDatabase()
            .prepare("SELECT last_sequence FROM worker_sessions WHERE session_id = ?")
            .get(ctx.sessionId) as any).last_sequence;
        // Both orderings acceptable: (5 then 6) => last=6 both ok; (6 then 5) => last=6, seq=5 gets invalid.
        check("T3 last_sequence monotone (>= 5)", last >= 5, "last=" + last);
        check("T3 at least one succeeds", [r1, r2].filter(x => x === "ok").length >= 1, JSON.stringify({ r1, r2 }));
        cleanupCtx(ctx);
    }

    // T4 - duplicate after success.
    section("T4 duplicate after success");
    {
        const ctx = await makeCtx();
        const msgId = "m-t4-" + randomUUID();
        await (ctx.gateway as any).handleMessage({
            messageId: msgId, type: "HEARTBEAT", sessionId: ctx.sessionId,
            workerId: ctx.workerId, sequence: 1, timestamp: Date.now(), payload: {},
        });
        const seqBefore = (ctx.engine.getDatabase()
            .prepare("SELECT last_sequence FROM worker_sessions WHERE session_id = ?")
            .get(ctx.sessionId) as any).last_sequence;
        try {
            await (ctx.gateway as any).handleMessage({
                messageId: msgId, type: "HEARTBEAT", sessionId: ctx.sessionId,
                workerId: ctx.workerId, sequence: 2, timestamp: Date.now(), payload: {},
            });
            check("T4 duplicate after success rejected", false);
        } catch (e: any) {
            check("T4 duplicate rejected with duplicate_message",
                  e.message === "duplicate_message", e.message);
        }
        const seqAfter = (ctx.engine.getDatabase()
            .prepare("SELECT last_sequence FROM worker_sessions WHERE session_id = ?")
            .get(ctx.sessionId) as any).last_sequence;
        check("T4 duplicate did NOT advance sequence", seqAfter === seqBefore,
              "before=" + seqBefore + " after=" + seqAfter);
        cleanupCtx(ctx);
    }

    // T7 - restart recovery after accept.
    section("T7 restart recovery after accept");
    {
        const ctx = await makeCtx();
        const msgId = "m-t7-" + randomUUID();
        await (ctx.gateway as any).handleMessage({
            messageId: msgId, type: "HEARTBEAT", sessionId: ctx.sessionId,
            workerId: ctx.workerId, sequence: 1, timestamp: Date.now(), payload: {},
        });
        ctx.engine.close();
        const engine2 = await SQLiteEngine.open(ctx.dbPath);
        const ss2 = new WorkerSessionStore(engine2);
        const ws2 = new RemoteWorkerStore(engine2);
        const auth2 = new WorkerAuthentication(ws2);
        const exec2 = new ExecutionStore(engine2);
        const gw2 = new WorkerGateway(0, ss2, ws2, auth2, exec2, engine2);
        try {
            await (gw2 as any).handleMessage({
                messageId: msgId, type: "HEARTBEAT", sessionId: ctx.sessionId,
                workerId: ctx.workerId, sequence: 2, timestamp: Date.now(), payload: {},
            });
            check("T7 restart replay rejected", false);
        } catch (e: any) {
            check("T7 restart replay rejected with duplicate_message",
                  e.message === "duplicate_message", e.message);
        }
        engine2.close();
        try { rmSync(ctx.tempDir, { recursive: true, force: true }); } catch {}
    }

    // T11 - out-of-order sequence.
    section("T11 out-of-order + repeated sequence");
    {
        const ctx = await makeCtx();
        await (ctx.gateway as any).handleMessage({
            messageId: "m-t11a-" + randomUUID(), type: "HEARTBEAT",
            sessionId: ctx.sessionId, workerId: ctx.workerId,
            sequence: 10, timestamp: Date.now(), payload: {},
        });
        try {
            await (ctx.gateway as any).handleMessage({
                messageId: "m-t11b-" + randomUUID(), type: "HEARTBEAT",
                sessionId: ctx.sessionId, workerId: ctx.workerId,
                sequence: 5, timestamp: Date.now(), payload: {},
            });
            check("T11 out-of-order rejected", false);
        } catch (e: any) {
            check("T11 out-of-order rejected with invalid_sequence",
                  e.message === "invalid_sequence", e.message);
        }
        cleanupCtx(ctx);
    }

    // T12 - session isolation.
    section("T12 session isolation");
    {
        const ctx = await makeCtx();
        const w2 = "w-p290b-" + randomUUID().slice(0, 8);
        const s2 = "s-p290b-" + randomUUID().slice(0, 8);
        const now2 = Date.now();
        const db2 = ctx.engine.getDatabase();
        db2.prepare(`
          INSERT INTO remote_workers (
            worker_id, hostname, platform, architecture, agent_version,
            capabilities, status, registered_at, last_heartbeat_at, metadata
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(w2, "test2", "linux", "x64", "1", "[]", "ONLINE", now2, now2, "{}");
        db2.prepare(`
          INSERT INTO worker_sessions (
            session_id, worker_id, status, protocol_version, connection_id,
            created_at, authenticated_at, last_seen_at, last_heartbeat_at,
            last_sequence, expires_at, revoked, metadata
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          s2, w2, "ACTIVE", "1.0", "c-" + randomUUID().slice(0, 8),
          now2, now2, now2, now2, 0, now2 + 60_000, 0, null
        );
        await (ctx.gateway as any).handleMessage({
            messageId: "m-t12a-" + randomUUID(), type: "HEARTBEAT",
            sessionId: ctx.sessionId, workerId: ctx.workerId,
            sequence: 5, timestamp: Date.now(), payload: {},
        });
        await (ctx.gateway as any).handleMessage({
            messageId: "m-t12b-" + randomUUID(), type: "HEARTBEAT",
            sessionId: s2, workerId: w2,
            sequence: 5, timestamp: Date.now(), payload: {},
        });
        const aSeq = (ctx.engine.getDatabase()
            .prepare("SELECT last_sequence FROM worker_sessions WHERE session_id = ?")
            .get(ctx.sessionId) as any).last_sequence;
        const bSeq = (ctx.engine.getDatabase()
            .prepare("SELECT last_sequence FROM worker_sessions WHERE session_id = ?")
            .get(s2) as any).last_sequence;
        check("T12 session A last_sequence = 5", aSeq === 5, "aSeq=" + aSeq);
        check("T12 session B last_sequence = 5", bSeq === 5, "bSeq=" + bSeq);
        cleanupCtx(ctx);
    }

    // T16 - JOB_CANCEL observationally fast (no tx-held-across-await).
    section("T16 JOB_CANCEL not spanned by transaction");
    {
        const ctx = await makeCtx();
        const t0 = Date.now();
        const r = await (ctx.gateway as any).handleMessage({
            messageId: "m-t16-" + randomUUID(), type: "JOB_CANCEL",
            sessionId: ctx.sessionId, workerId: ctx.workerId,
            sequence: 1, timestamp: Date.now(),
            payload: { jobId: "no-such-job" },
        }).then(() => "ok").catch((e: any) => e.message);
        const elapsed = Date.now() - t0;
        check("T16 JOB_CANCEL completed quickly (no held tx)",
              elapsed < 1000, "elapsed=" + elapsed + "ms, r=" + r);
        cleanupCtx(ctx);
    }

    console.log(`\nPhase 290 concurrency: ${failures === 0 ? "PASS" : "FAIL"}`);
    console.log(`Assertions: ${assertions}; passed: ${assertions - failures}; failures: ${failures}`);
    if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(2); });
