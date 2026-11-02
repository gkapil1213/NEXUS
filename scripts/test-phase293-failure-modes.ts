// Phase 293b: envelope acceptance failure modes.

import Database from "better-sqlite3";
import { join } from "path";
import { readFileSync, readdirSync } from "fs";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { WorkerEnvelopeStore, ENVELOPE_VERSION } from "../src/core/worker-envelope-store";
import { EnvHmacKeyProvider } from "../src/core/envelope-hmac-key-provider";
import { WorkerMessageHandlerTracker, sanitizeHandlerError } from "../src/core/worker-message-handler-tracker";

let passed = 0;
let failed = 0;

function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log("PASS:", label);
  } else {
    failed++;
    console.log("FAIL:", label, detail ?? "");
  }
}

function openFreshDb(): Database.Database {
  const db = new Database(":memory:");
  const migrationsDir = join(process.cwd(), "src", "db", "migrations");
  const files = readdirSync(migrationsDir)
    .filter((f: string) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    db.exec(readFileSync(join(migrationsDir, file), "utf8"));
  }
  return db;
}

async function main(): Promise<void> {
  console.log("Phase 293b envelope acceptance failure modes\n");

  // F1: envelope persist failure rolls back messageId insert
  const raw1 = openFreshDb();
  const engine1 = SQLiteEngine.fromDatabase(raw1);
  const provider1 = new EnvHmacKeyProvider({
    NEXUS_ENVELOPE_HMAC_KID: "test-k1",
    NEXUS_ENVELOPE_HMAC_KEY_HEX: "ab".repeat(32),
  });
  const store1 = new WorkerEnvelopeStore(engine1, provider1);

  raw1.exec(`
    CREATE TRIGGER phase293b_fail_envelope_insert
    BEFORE INSERT ON worker_message_envelopes
    BEGIN
      SELECT RAISE(ABORT, 'phase293b_forced_failure');
    END;
  `);

  const messageId1 = "m-f1";
  const sessionId1 = "s-f1";

  let threw1 = false;
  try {
    const tx = raw1.transaction(() => {
      raw1.prepare(
        "INSERT OR IGNORE INTO worker_message_ids (message_id, session_id, seen_at, handler_status) VALUES (?, ?, ?, 'PENDING')"
      ).run(messageId1, sessionId1, Date.now());

      const result = store1.persist({
        messageId: messageId1,
        messageType: "HEARTBEAT",
        workerId: "w-1",
        sessionId: sessionId1,
        payload: { v: 1 },
        envelopeVersion: ENVELOPE_VERSION,
        acceptedAt: Date.now(),
      });
      if (!result.persisted) {
        throw new Error("envelope_persist_failed:" + result.reason);
      }
    });
    tx();
  } catch {
    threw1 = true;
  }

  check("F1: envelope persist failure throws", threw1);

  const msgRow1 = raw1.prepare(
    "SELECT message_id FROM worker_message_ids WHERE message_id = ?"
  ).get(messageId1);
  check("F1: messageId rolled back (row absent)", !msgRow1);

  const envRow1 = raw1.prepare(
    "SELECT message_id FROM worker_message_envelopes WHERE message_id = ?"
  ).get(messageId1);
  check("F1: envelope row absent after rollback", !envRow1);

  raw1.close();

  // F2: sanitizeHandlerError behavior
  check("F2: stable code passes through",
    sanitizeHandlerError("unknown_message_type") === "unknown_message_type");
  check("F2: SQL collapsed to handler_error",
    sanitizeHandlerError("SELECT * FROM worker_message_ids") === "handler_error");
  check("F2: path collapsed to handler_error",
    sanitizeHandlerError("C:\\private\\nexus.db") === "handler_error");
  check("F2: empty string collapsed to handler_error",
    sanitizeHandlerError("") === "handler_error");
  check("F2: long message collapsed to handler_error",
    sanitizeHandlerError("x".repeat(500)) === "handler_error");
  check("F2: handler_error is idempotent",
    sanitizeHandlerError("handler_error") === "handler_error");

  // F3: markFailedInFlightByOwner sanitizes at tracker boundary
  const raw3 = openFreshDb();
  const engine3 = SQLiteEngine.fromDatabase(raw3);
  const tracker3 = new WorkerMessageHandlerTracker(engine3);

  const messageId3 = "m-f3";
  raw3.prepare(
    "INSERT INTO worker_message_ids (message_id, session_id, seen_at, handler_status) VALUES (?, 's', ?, 'PROCESSING')"
  ).run(messageId3, Date.now());

  const rawError3 = "C:\\private\\PH293B_PATH.db SELECT PH293B_SQL token=PH293B_SECRET";
  const now3 = Date.now();
  const tok3 = 1;
  raw3.prepare(
    "UPDATE worker_message_ids SET handler_owner_id = 'test-owner', handler_claim_expires_at = ?, fencing_token = ? WHERE message_id = ?"
  ).run(now3 + 60000, tok3, messageId3);

  const ok3 = tracker3.markFailedInFlightByOwner(messageId3, "test-owner", rawError3, tok3);
  check("F3: markFailedInFlightByOwner succeeds", ok3 === true);

  const row3 = raw3.prepare(
    "SELECT handler_last_error FROM worker_message_ids WHERE message_id = ?"
  ).get(messageId3) as any;
  check("F3: handler_last_error is sanitized (not raw error)",
    row3?.handler_last_error === "handler_error");
  check("F3: handler_last_error excludes path sentinel",
    !String(row3?.handler_last_error ?? "").includes("PH293B_PATH"));
  check("F3: handler_last_error excludes SQL sentinel",
    !String(row3?.handler_last_error ?? "").includes("PH293B_SQL"));
  check("F3: handler_last_error excludes secret sentinel",
    !String(row3?.handler_last_error ?? "").includes("PH293B_SECRET"));

  raw3.close();

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e: any) => {
  console.error("FATAL:", e);
  process.exitCode = 2;
});