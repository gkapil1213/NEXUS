// Phase 292B Slice 1: tests for the read-only recovery inspection layer.

import Database from "better-sqlite3";
import { join } from "path";
import { readFileSync, readdirSync } from "fs";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { WorkerMessageHandlerTracker } from "../src/core/worker-message-handler-tracker";
import { WorkerEnvelopeStore, MessageEnvelope, ENVELOPE_VERSION } from "../src/core/worker-envelope-store";
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
  const envelopes = new WorkerEnvelopeStore(engine);
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

  return { raw, engine, tracker, envelopes, registry, inspector, insertAccepted, makeEnvelope };
}

function rowSnapshot(engine: SQLiteEngine, messageId: string): any {
  return engine.prepare(
    "SELECT handler_status, fencing_token, handler_owner_id, handler_claim_expires_at, retry_count, next_retry_at, quarantine_reason FROM worker_message_ids WHERE message_id = ?"
  ).get(messageId);
}

console.log("Phase 292B Slice 1 inspection tests\n");

// I1
{
  section("I1 eligible HEARTBEAT -> REPLAY_ELIGIBLE");
  const c = makeCtx();
  c.insertAccepted("m-i1", "s-i1");
  c.envelopes.persist(c.makeEnvelope("m-i1", "HEARTBEAT", "s-i1", { currentJobId: null }));
  const r = c.inspector.inspectOnce();
  const d = r.decisions.find((x: any) => x.messageId === "m-i1");
  check("I1 decision kind REPLAY_ELIGIBLE", d?.kind === "REPLAY_ELIGIBLE", JSON.stringify(d));
  check("I1 envelope present", d?.kind === "REPLAY_ELIGIBLE" && d.envelope.messageId === "m-i1");
}

// I2
{
  section("I2 eligible JOB_RESULT -> REPLAY_ELIGIBLE");
  const c = makeCtx();
  c.insertAccepted("m-i2", "s-i2");
  c.envelopes.persist(c.makeEnvelope("m-i2", "JOB_RESULT", "s-i2", { jobId: "j", result: {} }));
  const r = c.inspector.inspectOnce();
  const d = r.decisions.find((x: any) => x.messageId === "m-i2");
  check("I2 decision kind REPLAY_ELIGIBLE", d?.kind === "REPLAY_ELIGIBLE", JSON.stringify(d));
}

// I3
{
  section("I3 JOB_OFFER -> QUARANTINE not_replay_eligible");
  const c = makeCtx();
  c.insertAccepted("m-i3", "s-i3");
  c.envelopes.persist(c.makeEnvelope("m-i3", "JOB_OFFER", "s-i3", {}));
  const r = c.inspector.inspectOnce();
  const d = r.decisions.find((x: any) => x.messageId === "m-i3");
  check("I3 decision kind QUARANTINE", d?.kind === "QUARANTINE", JSON.stringify(d));
  check("I3 reason not_replay_eligible", d?.kind === "QUARANTINE" && d.reason === "not_replay_eligible");
}

// I4
{
  section("I4 JOB_CANCEL -> QUARANTINE not_replay_eligible");
  const c = makeCtx();
  c.insertAccepted("m-i4", "s-i4");
  c.envelopes.persist(c.makeEnvelope("m-i4", "JOB_CANCEL", "s-i4", { jobId: "j" }));
  const r = c.inspector.inspectOnce();
  const d = r.decisions.find((x: any) => x.messageId === "m-i4");
  check("I4 decision kind QUARANTINE", d?.kind === "QUARANTINE", JSON.stringify(d));
  check("I4 reason not_replay_eligible", d?.kind === "QUARANTINE" && d.reason === "not_replay_eligible");
}

// I5
{
  section("I5 tampered payload -> QUARANTINE integrity_fail");
  const c = makeCtx();
  c.insertAccepted("m-i5", "s-i5");
  c.envelopes.persist(c.makeEnvelope("m-i5", "HEARTBEAT", "s-i5", { currentJobId: "a" }));
  c.engine.prepare("UPDATE worker_message_envelopes SET payload_json = ? WHERE message_id = ?").run(
    JSON.stringify({ currentJobId: "tampered" }), "m-i5"
  );
  const r = c.inspector.inspectOnce();
  const d = r.decisions.find((x: any) => x.messageId === "m-i5");
  check("I5 decision kind QUARANTINE", d?.kind === "QUARANTINE", JSON.stringify(d));
  check("I5 reason integrity_fail", d?.kind === "QUARANTINE" && d.reason === "integrity_fail");
  check("I5 messageType null on tamper", d?.kind === "QUARANTINE" && d.messageType === null);
}

// I6
{
  section("I6 missing envelope -> BLOCKED no_envelope");
  const c = makeCtx();
  c.insertAccepted("m-i6", "s-i6");
  const r = c.inspector.inspectOnce();
  const d = r.decisions.find((x: any) => x.messageId === "m-i6");
  check("I6 decision kind BLOCKED", d?.kind === "BLOCKED", JSON.stringify(d));
  check("I6 reason no_envelope", d?.kind === "BLOCKED" && d.reason === "no_envelope");
}

// I7
{
  section("I7 inspectOnce performs no state transitions");
  const c = makeCtx();
  c.insertAccepted("m-i7a", "s-i7a");
  c.envelopes.persist(c.makeEnvelope("m-i7a", "HEARTBEAT", "s-i7a", {}));
  c.insertAccepted("m-i7b", "s-i7b");
  c.envelopes.persist(c.makeEnvelope("m-i7b", "JOB_OFFER", "s-i7b", {}));
  c.insertAccepted("m-i7c", "s-i7c");
  const before: Record<string, any> = {
    "m-i7a": rowSnapshot(c.engine, "m-i7a"),
    "m-i7b": rowSnapshot(c.engine, "m-i7b"),
    "m-i7c": rowSnapshot(c.engine, "m-i7c"),
  };
  c.inspector.inspectOnce();
  const after: Record<string, any> = {
    "m-i7a": rowSnapshot(c.engine, "m-i7a"),
    "m-i7b": rowSnapshot(c.engine, "m-i7b"),
    "m-i7c": rowSnapshot(c.engine, "m-i7c"),
  };
  const same = (k: string) => JSON.stringify(before[k]) === JSON.stringify(after[k]);
  check("I7 m-i7a unchanged", same("m-i7a"), JSON.stringify({ before: before["m-i7a"], after: after["m-i7a"] }));
  check("I7 m-i7b unchanged", same("m-i7b"), JSON.stringify({ before: before["m-i7b"], after: after["m-i7b"] }));
  check("I7 m-i7c unchanged", same("m-i7c"), JSON.stringify({ before: before["m-i7c"], after: after["m-i7c"] }));
}

// I8
{
  section("I8 session mismatch -> QUARANTINE session_mismatch");
  const c = makeCtx();
  c.insertAccepted("m-i8", "s-i8-real");
  c.envelopes.persist(c.makeEnvelope("m-i8", "HEARTBEAT", "s-i8-forged", {}));
  const r = c.inspector.inspectOnce();
  const d = r.decisions.find((x: any) => x.messageId === "m-i8");
  check("I8 decision kind QUARANTINE", d?.kind === "QUARANTINE", JSON.stringify(d));
  check("I8 reason session_mismatch", d?.kind === "QUARANTINE" && d.reason === "session_mismatch");
}

// I9
{
  section("I9 structured log emitted");
  const c = makeCtx();
  c.insertAccepted("m-i9a", "s-i9a");
  c.envelopes.persist(c.makeEnvelope("m-i9a", "HEARTBEAT", "s-i9a", {}));
  c.insertAccepted("m-i9b", "s-i9b");
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: any[]) => { logs.push(args.join(" ")); };
  try {
    c.inspector.inspectOnce();
  } finally {
    console.log = origLog;
  }
  const inspected = logs.find((l) => l.includes("phase292b.inspect"));
  check("I9 log line present", !!inspected);
  if (inspected) {
    const ev = JSON.parse(inspected);
    check("I9 log has discovered", typeof ev.discovered === "number");
    check("I9 log has replayEligible", typeof ev.replayEligible === "number");
    check("I9 log has quarantine", typeof ev.quarantine === "number");
    check("I9 log has blocked", typeof ev.blocked === "number");
    check("I9 log has byReason", typeof ev.byReason === "object");
  }
}

// I10
{
  section("I10 unknown handler -> QUARANTINE unknown_handler");
  const c = makeCtx();
  c.insertAccepted("m-i10", "s-i10");
  c.envelopes.persist(c.makeEnvelope("m-i10", "SOME_FUTURE_TYPE", "s-i10", {}));
  const r = c.inspector.inspectOnce();
  const d = r.decisions.find((x: any) => x.messageId === "m-i10");
  check("I10 decision kind QUARANTINE", d?.kind === "QUARANTINE", JSON.stringify(d));
  check("I10 reason unknown_handler", d?.kind === "QUARANTINE" && d.reason === "unknown_handler");
}

console.log("\n" + (failed === 0 ? "Phase 292B Slice 1: PASS" : "Phase 292B Slice 1: FAIL"));
console.log("Assertions: " + (passed + failed) + "; passed: " + passed + "; failures: " + failed);
process.exit(failed === 0 ? 0 : 1);
