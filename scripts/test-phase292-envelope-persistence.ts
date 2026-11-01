// Phase 292 Block A - envelope persistence + fencing token + retry tracking.
// Real file-backed SQLite via SQLiteEngine.open() exercises migration 179.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { SQLiteEngine } from "../src/core/sqlite-engine";
import { WorkerEnvelopeStore, ENVELOPE_VERSION, MAX_PAYLOAD_BYTES } from "../src/core/worker-envelope-store";
import { EnvHmacKeyProvider } from "../src/core/envelope-hmac-key-provider";
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
  store: WorkerEnvelopeStore;
  tracker: WorkerMessageHandlerTracker;
  tempDir: string;
  dbPath: string;
}

async function makeCtx(): Promise<Ctx> {
  const tempDir = mkdtempSync(join(tmpdir(), "nexus-p292-"));
  const dbPath = join(tempDir, "test.sqlite");
  const engine = await SQLiteEngine.open(dbPath);
  const keyProvider = new EnvHmacKeyProvider({
    NEXUS_ENVELOPE_HMAC_KID: "phase292-persistence-test",
    NEXUS_ENVELOPE_HMAC_KEY_HEX: "ab".repeat(32),
  });
  return { engine, store: new WorkerEnvelopeStore(engine, keyProvider), tracker: new WorkerMessageHandlerTracker(engine), tempDir, dbPath };
}

function cleanup(ctx: Ctx): void {
  try { ctx.engine.close(); } catch {}
  try { rmSync(ctx.tempDir, { recursive: true, force: true }); } catch {}
}

async function main(): Promise<void> {
  section("T1 migration 179 creates envelope, outbox, reconciliation tables");
  {
    const ctx = await makeCtx();
    const db = ctx.engine.getDatabase();
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('worker_message_envelopes','worker_external_side_effects','worker_message_reconciliations')"
    ).all() as Array<{ name: string }>;
    const names = new Set(tables.map(t => t.name));
    check("T1 worker_message_envelopes exists", names.has("worker_message_envelopes"));
    check("T1 worker_external_side_effects exists", names.has("worker_external_side_effects"));
    check("T1 worker_message_reconciliations exists", names.has("worker_message_reconciliations"));
    cleanup(ctx);
  }

  section("T2 hasEnvelopeSchema detects migration 179");
  {
    const ctx = await makeCtx();
    check("T2 hasEnvelopeSchema returns true", ctx.store.hasEnvelopeSchema() === true);
    cleanup(ctx);
  }

  section("T3 persist + load round-trip");
  {
    const ctx = await makeCtx();
    const msgId = "m-t3-" + randomUUID();
    ctx.engine.getDatabase().prepare(
      `INSERT INTO worker_message_ids (message_id, session_id, seen_at, handler_status) VALUES (?, ?, ?, 'PENDING')`
    ).run(msgId, "sess-t3", Date.now());

    const result = ctx.store.persist({
      messageId: msgId, messageType: "HEARTBEAT", workerId: "w-t3", sessionId: "sess-t3",
      payload: { currentJobId: "job-t3", nested: { x: 1 } },
      envelopeVersion: ENVELOPE_VERSION, acceptedAt: Date.now(),
    });
    check("T3 persist succeeds", result.persisted === true, JSON.stringify(result));
    check("T3 sha256 returned (64 hex)", typeof result.payloadSha256 === "string" && result.payloadSha256!.length === 64);

    const loaded = ctx.store.load(msgId);
    check("T3 load returns envelope", loaded !== undefined);
    check("T3 type preserved", loaded?.messageType === "HEARTBEAT");
    check("T3 payload round-trips", JSON.stringify(loaded?.payload) === JSON.stringify({ currentJobId: "job-t3", nested: { x: 1 } }));
    check("T3 acceptedAt preserved", loaded?.acceptedAt !== undefined);
    cleanup(ctx);
  }

  section("T4 integrity verification detects tamper");
  {
    const ctx = await makeCtx();
    const msgId = "m-t4-" + randomUUID();
    ctx.engine.getDatabase().prepare(
      `INSERT INTO worker_message_ids (message_id, session_id, seen_at, handler_status) VALUES (?, ?, ?, 'PENDING')`
    ).run(msgId, "sess-t4", Date.now());
    ctx.store.persist({
      messageId: msgId, messageType: "HEARTBEAT", workerId: "w-t4", sessionId: "sess-t4",
      payload: { v: 1 }, envelopeVersion: ENVELOPE_VERSION, acceptedAt: Date.now(),
    });
    const loaded = ctx.store.load(msgId)!;
    const intactVerification = ctx.store.verifyIntegrity(loaded);
    check("T4 intact payload verifies", intactVerification.ok === true);
    const tampered = { ...loaded, payload: { v: 2 } };
    const tamperedVerification = ctx.store.verifyIntegrity(tampered);
    check("T4 tampered payload fails", tamperedVerification.ok === false);
    check("T4 tamper rejected as payload mismatch", !tamperedVerification.ok && tamperedVerification.reason === "payload_mismatch");
    cleanup(ctx);
  }

  section("T5 duplicate message_id rejected");
  {
    const ctx = await makeCtx();
    const msgId = "m-t5-" + randomUUID();
    ctx.engine.getDatabase().prepare(
      `INSERT INTO worker_message_ids (message_id, session_id, seen_at, handler_status) VALUES (?, ?, ?, 'PENDING')`
    ).run(msgId, "sess-t5", Date.now());
    const env = { messageId: msgId, messageType: "HEARTBEAT", workerId: "w-t5", sessionId: "sess-t5", payload: {}, envelopeVersion: ENVELOPE_VERSION, acceptedAt: Date.now() };
    const first = ctx.store.persist(env);
    const second = ctx.store.persist(env);
    check("T5 first persist succeeds", first.persisted === true);
    check("T5 second rejected as duplicate", second.persisted === false && second.reason === "duplicate_message_id", JSON.stringify(second));
    cleanup(ctx);
  }

  section("T6 payload size limit");
  {
    const ctx = await makeCtx();
    const msgId = "m-t6-" + randomUUID();
    ctx.engine.getDatabase().prepare(
      `INSERT INTO worker_message_ids (message_id, session_id, seen_at, handler_status) VALUES (?, ?, ?, 'PENDING')`
    ).run(msgId, "sess-t6", Date.now());
    const big = "x".repeat(MAX_PAYLOAD_BYTES + 1024);
    const result = ctx.store.persist({
      messageId: msgId, messageType: "HEARTBEAT", workerId: "w-t6", sessionId: "sess-t6",
      payload: { big }, envelopeVersion: ENVELOPE_VERSION, acceptedAt: Date.now(),
    });
    check("T6 oversized rejected", result.persisted === false && result.reason === "payload_too_large", JSON.stringify({ persisted: result.persisted, reason: result.reason }));
    cleanup(ctx);
  }

  section("T7 unsupported envelope version rejected");
  {
    const ctx = await makeCtx();
    const msgId = "m-t7-" + randomUUID();
    ctx.engine.getDatabase().prepare(
      `INSERT INTO worker_message_ids (message_id, session_id, seen_at, handler_status) VALUES (?, ?, ?, 'PENDING')`
    ).run(msgId, "sess-t7", Date.now());
    const result = ctx.store.persist({
      messageId: msgId, messageType: "HEARTBEAT", workerId: "w-t7", sessionId: "sess-t7",
      payload: {}, envelopeVersion: 999, acceptedAt: Date.now(),
    });
    check("T7 invalid version rejected", result.persisted === false && result.reason === "invalid_payload");
    cleanup(ctx);
  }

  section("T8 fencing token starts at 1");
  {
    const ctx = await makeCtx();
    const msgId = "m-t8-" + randomUUID();
    ctx.engine.getDatabase().prepare(
      `INSERT INTO worker_message_ids (message_id, session_id, seen_at, handler_status) VALUES (?, ?, ?, 'PENDING')`
    ).run(msgId, "sess-t8", Date.now());
    const tok = ctx.tracker.getFencingToken(msgId);
    check("T8 initial fencing_token = 1", tok === 1, "got=" + tok);
    cleanup(ctx);
  }

  section("T9 markRetryPending bumps fencing_token");
  {
    const ctx = await makeCtx();
    const msgId = "m-t9-" + randomUUID();
    ctx.engine.getDatabase().prepare(
      `INSERT INTO worker_message_ids (message_id, session_id, seen_at, handler_status) VALUES (?, ?, ?, 'PENDING')`
    ).run(msgId, "sess-t9", Date.now());
    const tokT9 = ctx.tracker.claimForProcessingWithToken(msgId, "owner-a");
    check("T9 claim succeeds", tokT9 !== null);
    const tokBefore = ctx.tracker.getFencingToken(msgId)!;
    const past = Date.now() - 1000;
    check("T9 markRetryPending succeeds", tokT9 !== null && ctx.tracker.markRetryPending(msgId, "owner-a", "transient", past, tokT9) === true);
    const tokAfter = ctx.tracker.getFencingToken(msgId)!;
    check("T9 fencing_token bumped +1", tokAfter === tokBefore + 1, `${tokBefore} -> ${tokAfter}`);
    cleanup(ctx);
  }

  section("T10 claimForReplay bumps fencing_token");
  {
    const ctx = await makeCtx();
    const msgId = "m-t10-" + randomUUID();
    ctx.engine.getDatabase().prepare(
      `INSERT INTO worker_message_ids (message_id, session_id, seen_at, handler_status) VALUES (?, ?, ?, 'PENDING')`
    ).run(msgId, "sess-t10", Date.now());
    const tokT10a = ctx.tracker.claimForProcessingWithToken(msgId, "owner-a");
    const past = Date.now() - 1000;
    if (tokT10a !== null) {
      ctx.tracker.markRetryPending(msgId, "owner-a", "transient", past, tokT10a);
    }
    const tokBefore = ctx.tracker.getFencingToken(msgId)!;
    const replayTok = ctx.tracker.claimForReplay(msgId, "owner-b");
    check("T10 claimForReplay succeeds", replayTok !== null);
    const tokAfter = ctx.tracker.getFencingToken(msgId)!;
    check("T10 fencing_token bumped +1", tokAfter === tokBefore + 1, `${tokBefore} -> ${tokAfter}`);
    cleanup(ctx);
  }

  section("T11 markQuarantined bumps fencing_token");
  {
    const ctx = await makeCtx();
    const msgId = "m-t11-" + randomUUID();
    ctx.engine.getDatabase().prepare(
      `INSERT INTO worker_message_ids (message_id, session_id, seen_at, handler_status) VALUES (?, ?, ?, 'PENDING')`
    ).run(msgId, "sess-t11", Date.now());
    const tokBefore = ctx.tracker.getFencingToken(msgId)!;
    check("T11 quarantine succeeds", ctx.tracker.markQuarantined(msgId, null, "test_quarantine", tokBefore) === true);
    const tokAfter = ctx.tracker.getFencingToken(msgId)!;
    check("T11 fencing_token bumped +1", tokAfter === tokBefore + 1, `${tokBefore} -> ${tokAfter}`);

    const row = ctx.engine.getDatabase().prepare(
      "SELECT handler_status, quarantine_reason FROM worker_message_ids WHERE message_id = ?"
    ).get(msgId) as any;
    check("T11 status = QUARANTINED", row?.handler_status === "QUARANTINED");
    check("T11 quarantine_reason recorded", row?.quarantine_reason === "test_quarantine");
    cleanup(ctx);
  }

  section("T12 listRetryDue returns due messages with fencingToken");
  {
    const ctx = await makeCtx();
    const msgId = "m-t12-" + randomUUID();
    ctx.engine.getDatabase().prepare(
      `INSERT INTO worker_message_ids (message_id, session_id, seen_at, handler_status) VALUES (?, ?, ?, 'PENDING')`
    ).run(msgId, "sess-t12", Date.now());
    const tokT12 = ctx.tracker.claimForProcessingWithToken(msgId, "owner-a");
    const past = Date.now() - 1000;
    if (tokT12 !== null) {
      ctx.tracker.markRetryPending(msgId, "owner-a", "due-now", past, tokT12);
    }
    const due = ctx.tracker.listRetryDue();
    const found = due.find(d => d.messageId === msgId);
    check("T12 listRetryDue contains message", found !== undefined);
    check("T12 fencingToken present in result", typeof found?.fencingToken === "number");
    check("T12 retryCount = 1", found?.retryCount === 1);
    cleanup(ctx);
  }

  section("T13 stale-owner fencing monotonicity");
  {
    const ctx = await makeCtx();
    const msgId = "m-t13-" + randomUUID();
    ctx.engine.getDatabase().prepare(
      `INSERT INTO worker_message_ids (message_id, session_id, seen_at, handler_status) VALUES (?, ?, ?, 'PENDING')`
    ).run(msgId, "sess-t13", Date.now());
    const tokT13a = ctx.tracker.claimForProcessingWithToken(msgId, "owner-a");
    check("T13 initial claim succeeds", tokT13a !== null);
    const tokA = ctx.tracker.getFencingToken(msgId)!;

    if (tokT13a !== null) {
      ctx.tracker.markRetryPending(msgId, "owner-a", "retry-for-race", Date.now() - 1000, tokT13a);
    }
    const replayTokT13 = ctx.tracker.claimForReplay(msgId, "owner-b");
    check("T13 replay claim succeeds", replayTokT13 !== null);
    const tokB = ctx.tracker.getFencingToken(msgId)!;

    check("T13 owner-b's token > owner-a's token", tokB > tokA, `A=${tokA} B=${tokB}`);

    // Now owner-a (stale) attempts markCompleted with their old token via SQL CAS.
    // Simulating what Block B will do: CAS on fencing_token.
    const staleAttempt = ctx.engine.getDatabase().prepare(
      `UPDATE worker_message_ids
         SET handler_status = 'COMPLETED'
       WHERE message_id = ? AND fencing_token = ?`
    ).run(msgId, tokA);
    check("T13 stale-owner write rejected (0 changes)", staleAttempt.changes === 0, "changes=" + staleAttempt.changes);

    const currentOwnerWrite = ctx.engine.getDatabase().prepare(
      `UPDATE worker_message_ids
         SET handler_status = 'COMPLETED'
       WHERE message_id = ? AND fencing_token = ?`
    ).run(msgId, tokB);
    check("T13 current-owner write accepted (1 change)", currentOwnerWrite.changes === 1, "changes=" + currentOwnerWrite.changes);
    cleanup(ctx);
  }

  console.log(`\nPhase 292 Block A: ${failures === 0 ? "PASS" : "FAIL"}`);
  console.log(`Assertions: ${assertions}; passed: ${assertions - failures}; failures: ${failures}`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(2); });