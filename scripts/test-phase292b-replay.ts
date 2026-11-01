// Phase 292B Slice 3: tests for quarantine transitions in recoverIncompleteMessages.

import Database from "better-sqlite3";
import { join } from "path";
import { readFileSync, readdirSync } from "fs";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { WorkerMessageHandlerTracker } from "../src/core/worker-message-handler-tracker";
import { WorkerEnvelopeStore, MessageEnvelope, ENVELOPE_VERSION } from "../src/core/worker-envelope-store";
import { EnvHmacKeyProvider } from "../src/core/envelope-hmac-key-provider";
import { buildDefaultHandlerRegistry } from "../src/core/handler-registry";
import { WorkerRecoveryInspection } from "../src/core/worker-recovery-inspection";

let passed = 0;
let failed = 0;

function check(label: string, cond: boolean, detail?: string): void {
  if (cond) { passed++; console.log("  PASS: " + label); }
  else { failed++; console.log("  FAIL: " + label + (detail ? " -- " + detail : "")); }
}

function section(s: string): void { console.log("\n--- " + s + " ---"); }

function openFreshDb(): Database.Database {
  const db = new Database(":memory:");
  const migrationsDir = join(process.cwd(), "src", "db", "migrations");
  const files = readdirSync(migrationsDir).filter((f: string) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const sql = readFileSync(join(migrationsDir, f), "utf8");
    db.exec(sql);
  }
  return db;
}

function makeCtx() {
  const raw = openFreshDb();
  const engine = SQLiteEngine.fromDatabase(raw);
  const tracker = new WorkerMessageHandlerTracker(engine);
  const envelopes = new WorkerEnvelopeStore(engine, new EnvHmacKeyProvider({ NEXUS_ENVELOPE_HMAC_KID: "test-k1", NEXUS_ENVELOPE_HMAC_KEY_HEX: "ab".repeat(32) } as any));
  const registry = buildDefaultHandlerRegistry();
  const inspector = new WorkerRecoveryInspection(engine, tracker, envelopes, registry);

  function insertAccepted(messageId: string, sessionId: string): void {
    engine.prepare(
      "INSERT INTO worker_message_ids (message_id, session_id, seen_at, handler_status) VALUES (?, ?, ?, 'PENDING')"
    ).run(messageId, sessionId, Date.now());
  }

  function makeEnvelope(messageId: string, type: string, sessionId: string, payload: unknown): MessageEnvelope {
    return {
      messageId,
      messageType: type,
      workerId: "worker-1",
      sessionId,
      payload,
      envelopeVersion: ENVELOPE_VERSION,
      acceptedAt: Date.now(),
    };
  }

  function getRow(messageId: string): any {
    return engine.prepare(
      "SELECT handler_status, quarantine_reason, handler_recovery_reason, fencing_token FROM worker_message_ids WHERE message_id = ?"
    ).get(messageId);
  }

  return { raw, engine, tracker, envelopes, registry, inspector, insertAccepted, makeEnvelope, getRow };
}

console.log("Phase 292B Slice 3 quarantine transition tests\n");

// Q1
{
  section("Q1 JOB_OFFER envelope -> QUARANTINE decision -> row quarantined");
  const c = makeCtx();
  c.insertAccepted("m-q1", "s-q1");
  c.envelopes.persist(c.makeEnvelope("m-q1", "JOB_OFFER", "s-q1", { workerId: "w" }));

  const inspection = c.inspector.inspectOnce();
  const decision = inspection.decisions.find((d: any) => d.messageId === "m-q1");
  check("Q1 inspection returns QUARANTINE decision", decision?.kind === "QUARANTINE", JSON.stringify(decision));
  check("Q1 decision reason is not_replay_eligible",
    decision?.kind === "QUARANTINE" && decision.reason === "not_replay_eligible");

  if (decision?.kind === "QUARANTINE") {
    const ok = c.tracker.markQuarantined(
      decision.messageId,
      null,
      decision.reason,
      decision.fencingToken,
    );
    check("Q1 markQuarantined returns true", ok === true);
  }

  const row = c.getRow("m-q1");
  check("Q1 row status is QUARANTINED", row?.handler_status === "QUARANTINED", "got=" + row?.handler_status);
  check("Q1 quarantine_reason is not_replay_eligible",
    row?.quarantine_reason === "not_replay_eligible", "got=" + row?.quarantine_reason);
}

// Q2
{
  section("Q2 HEARTBEAT envelope -> REPLAY_ELIGIBLE decision -> Phase 291 fallback");
  const c = makeCtx();
  c.insertAccepted("m-q2", "s-q2");
  c.envelopes.persist(c.makeEnvelope("m-q2", "HEARTBEAT", "s-q2", { currentJobId: null }));

  const inspection = c.inspector.inspectOnce();
  const decision = inspection.decisions.find((d: any) => d.messageId === "m-q2");
  check("Q2 inspection returns REPLAY_ELIGIBLE decision",
    decision?.kind === "REPLAY_ELIGIBLE", JSON.stringify(decision));

  const recoverable = c.tracker.listRecoverable();
  const m = recoverable.find((r: any) => r.messageId === "m-q2");
  check("Q2 row is recoverable", m !== undefined);
  if (m) {
    const ok = c.tracker.markFailedInFlightByRecovery(
      m.messageId,
      "phase292_recovery: incomplete_handler_no_payload_available",
      m.fencingToken,
    );
    check("Q2 markFailedInFlightByRecovery returns true", ok === true);
  }

  const row = c.getRow("m-q2");
  check("Q2 row status is FAILED_IN_FLIGHT (Phase 291 fallback)",
    row?.handler_status === "FAILED_IN_FLIGHT", "got=" + row?.handler_status);
  check("Q2 row is NOT quarantine",
    row?.handler_status !== "QUARANTINED");
}

// Q3
{
  section("Q3 no envelope -> BLOCKED decision -> Phase 291 fallback");
  const c = makeCtx();
  c.insertAccepted("m-q3", "s-q3");

  const inspection = c.inspector.inspectOnce();
  const decision = inspection.decisions.find((d: any) => d.messageId === "m-q3");
  check("Q3 inspection returns BLOCKED decision",
    decision?.kind === "BLOCKED", JSON.stringify(decision));

  const recoverable = c.tracker.listRecoverable();
  const m = recoverable.find((r: any) => r.messageId === "m-q3");
  check("Q3 row is recoverable", m !== undefined);
  if (m) {
    const ok = c.tracker.markFailedInFlightByRecovery(
      m.messageId,
      "phase292_recovery: incomplete_handler_no_payload_available",
      m.fencingToken,
    );
    check("Q3 markFailedInFlightByRecovery returns true", ok === true);
  }

  const row = c.getRow("m-q3");
  check("Q3 row status is FAILED_IN_FLIGHT (Phase 291 T5 compat)",
    row?.handler_status === "FAILED_IN_FLIGHT", "got=" + row?.handler_status);
}

// Q4
{
  section("Q4 tampered envelope -> QUARANTINE integrity_fail decision");
  const c = makeCtx();
  c.insertAccepted("m-q4", "s-q4");
  c.envelopes.persist(c.makeEnvelope("m-q4", "HEARTBEAT", "s-q4", { currentJobId: "a" }));
  c.engine.prepare("UPDATE worker_message_envelopes SET payload_json = ? WHERE message_id = ?").run(
    JSON.stringify({ currentJobId: "tampered" }), "m-q4"
  );

  const inspection = c.inspector.inspectOnce();
  const decision = inspection.decisions.find((d: any) => d.messageId === "m-q4");
  check("Q4 inspection returns QUARANTINE decision", decision?.kind === "QUARANTINE");
  check("Q4 decision reason is integrity_fail",
    decision?.kind === "QUARANTINE" && decision.reason === "integrity_fail");

  if (decision?.kind === "QUARANTINE") {
    const ok = c.tracker.markQuarantined(
      decision.messageId,
      null,
      decision.reason,
      decision.fencingToken,
    );
    check("Q4 markQuarantined returns true", ok === true);
  }

  const row = c.getRow("m-q4");
  check("Q4 row status is QUARANTINED", row?.handler_status === "QUARANTINED");
  check("Q4 quarantine_reason is integrity_fail",
    row?.quarantine_reason === "integrity_fail");
}

console.log("\n" + (failed === 0 ? "Phase 292B Slice 3: PASS" : "Phase 292B Slice 3: FAIL"));
console.log("Assertions: " + (passed + failed) + "; passed: " + passed + "; failures: " + failed);
process.exit(failed === 0 ? 0 : 1);

