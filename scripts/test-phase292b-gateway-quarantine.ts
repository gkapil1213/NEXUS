// Phase 292B: gateway now fails closed without HMAC key material.
// Test-only defaults; do not reuse outside the test suite.
process.env.NEXUS_ENVELOPE_HMAC_KID ??= "test-k1";
process.env.NEXUS_ENVELOPE_HMAC_KEY_HEX ??= "ab".repeat(32);
// Phase 292B Slice 3: real WorkerGateway startup recovery integration test.
// Uses migration-backed SQLite and the real gateway, stores and tracker.

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
import { WorkerEnvelopeStore, ENVELOPE_VERSION } from "../src/core/worker-envelope-store";
import { EnvHmacKeyProvider } from "../src/core/envelope-hmac-key-provider";

let assertions = 0;
let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  assertions++;
  if (condition) console.log("  PASS: " + label);
  else {
    failures++;
    console.error("  FAIL: " + label + (detail ? " -- " + detail : ""));
  }
}

function section(label: string): void {
  console.log("\n--- " + label + " ---");
}

async function main(): Promise<void> {
  const tempDir = mkdtempSync(join(tmpdir(), "nexus-p292b-gateway-"));
  const dbPath = join(tempDir, "gateway.sqlite");
  let engine: SQLiteEngine | undefined;
  let gateway: WorkerGateway | undefined;
  let started = false;

  try {
    engine = await SQLiteEngine.open(dbPath);
    const db = engine.getDatabase();

    const sessionStore = new WorkerSessionStore(engine);
    const workerStore = new RemoteWorkerStore(engine);
    const auth = new WorkerAuthentication(workerStore);
    const executionStore = new ExecutionStore(engine);
    const tracker = new WorkerMessageHandlerTracker(engine);
    const hmacProvider = new EnvHmacKeyProvider(process.env);
    const envelopes = new WorkerEnvelopeStore(engine, hmacProvider);

    const workerId = "w-p292b-" + randomUUID();
    const sessionId = "s-p292b-" + randomUUID();
    const now = Date.now();

    db.prepare(`
      INSERT INTO remote_workers (
        worker_id, hostname, platform, architecture, agent_version,
        capabilities, status, registered_at, last_heartbeat_at, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(workerId, "gateway-test", "linux", "x64", "1", "[]", "ONLINE", now, now, "{}");

    db.prepare(`
      INSERT INTO worker_sessions (
        session_id, worker_id, status, protocol_version, connection_id,
        created_at, authenticated_at, last_seen_at, last_heartbeat_at,
        last_sequence, expires_at, revoked, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, workerId, "ACTIVE", "1.0", "gateway-test", now, now,
      now, now, 0, now + 60_000, 0, null);

    function insertPending(messageId: string): void {
      db.prepare(`
        INSERT INTO worker_message_ids (message_id, session_id, seen_at, handler_status)
        VALUES (?, ?, ?, 'PENDING')
      `).run(messageId, sessionId, Date.now());
    }

    function persistEnvelope(messageId: string, messageType: string): void {
      envelopes.persist({
        messageId,
        messageType,
        workerId,
        sessionId,
        payload: messageType === "HEARTBEAT" ? { currentJobId: null } : {},
        envelopeVersion: ENVELOPE_VERSION,
        acceptedAt: Date.now(),
      });
    }

    const quarantineId = "m-quarantine-" + randomUUID();
    const replayEligibleId = "m-replay-eligible-" + randomUUID();
    const blockedId = "m-blocked-" + randomUUID();

    insertPending(quarantineId);
    persistEnvelope(quarantineId, "JOB_OFFER");

    insertPending(replayEligibleId);
    persistEnvelope(replayEligibleId, "HEARTBEAT");

    insertPending(blockedId);
    // Deliberately no envelope for this message.

    const before = new Map<string, number>();
    for (const id of [quarantineId, replayEligibleId, blockedId]) {
      const row = db.prepare(
        "SELECT fencing_token FROM worker_message_ids WHERE message_id = ?"
      ).get(id) as any;
      before.set(id, Number(row.fencing_token));
    }

    gateway = new WorkerGateway(
      0, sessionStore, workerStore, auth, executionStore, engine, hmacProvider
    );

    section("G1 startup recovery quarantines explicit QUARANTINE decision");
    await gateway.start();
    started = true;

    const q = db.prepare(`
      SELECT handler_status, quarantine_reason, fencing_token
      FROM worker_message_ids WHERE message_id = ?
    `).get(quarantineId) as any;

    check("G1 JOB_OFFER status is QUARANTINED", q?.handler_status === "QUARANTINED");
    check("G1 reason is not_replay_eligible", q?.quarantine_reason === "not_replay_eligible");
    check("G1 fencing token increments exactly once",
      Number(q?.fencing_token) === (before.get(quarantineId) ?? 0) + 1);

    section("G2 REPLAY_ELIGIBLE retains Phase 291 fallback");
    const r = db.prepare(`
      SELECT handler_status, fencing_token
      FROM worker_message_ids WHERE message_id = ?
    `).get(replayEligibleId) as any;

    check("G2 HEARTBEAT is FAILED_IN_FLIGHT, not replayed",
      r?.handler_status === "FAILED_IN_FLIGHT");
    check("G2 fencing token increments exactly once",
      Number(r?.fencing_token) === (before.get(replayEligibleId) ?? 0) + 1);

    section("G3 BLOCKED missing envelope retains Phase 291 fallback");
    const b = db.prepare(`
      SELECT handler_status, fencing_token
      FROM worker_message_ids WHERE message_id = ?
    `).get(blockedId) as any;

    check("G3 missing-envelope row is FAILED_IN_FLIGHT",
      b?.handler_status === "FAILED_IN_FLIGHT");
    check("G3 fencing token increments exactly once",
      Number(b?.fencing_token) === (before.get(blockedId) ?? 0) + 1);

    section("G4 quarantined and failed rows are no longer recoverable");
    const remaining = tracker.listRecoverable().map((row) => row.messageId);
    check("G4 all three recovered rows leave recoverable set",
      !remaining.includes(quarantineId) &&
      !remaining.includes(replayEligibleId) &&
      !remaining.includes(blockedId));

  } finally {
    if (started && gateway) {
      try { await gateway.stop(); } catch {}
    }
    try { engine?.close(); } catch {}
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }

  console.log(`\nGateway quarantine integration: ${failures === 0 ? "PASS" : "FAIL"}`);
  console.log(`Assertions: ${assertions}; passed: ${assertions - failures}; failures: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("Gateway quarantine integration: ERROR", error);
  process.exit(1);
});

