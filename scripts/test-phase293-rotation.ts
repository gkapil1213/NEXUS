// Phase 293b: envelope HMAC rotation and key verification.
// Hermetic — SQLite :memory:, no AWS account, no process spawn.

import Database from "better-sqlite3";
import { join } from "path";
import { readFileSync, readdirSync } from "fs";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { WorkerEnvelopeStore, ENVELOPE_VERSION } from "../src/core/worker-envelope-store";
import { EnvHmacKeyProvider } from "../src/core/envelope-hmac-key-provider";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) { passed++; console.log("PASS:", label); }
  else { failed++; console.log("FAIL:", label, detail ?? ""); }
}

function openFreshDb(): Database.Database {
  const db = new Database(":memory:");
  const migrationsDir = join(process.cwd(), "src", "db", "migrations");
  for (const file of readdirSync(migrationsDir).filter((f: string) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(migrationsDir, file), "utf8"));
  }
  return db;
}

function seedParent(engine: SQLiteEngine, messageId: string, sessionId: string): void {
  engine.prepare(
    "INSERT INTO worker_message_ids (message_id, session_id, seen_at, handler_status) VALUES (?, ?, ?, 'PENDING')"
  ).run(messageId, sessionId, Date.now());
}

function makeEnvelope(messageId: string): any {
  return {
    messageId,
    messageType: "HEARTBEAT",
    workerId: "w-1",
    sessionId: "s-1",
    payload: { v: 1 },
    envelopeVersion: ENVELOPE_VERSION,
    acceptedAt: Date.now(),
  };
}

async function main(): Promise<void> {
  console.log("Phase 293b envelope rotation tests\n");

  const raw = openFreshDb();
  const engine = SQLiteEngine.fromDatabase(raw);

  // --- Phase 1: sign with k1, verify with k1 ---
  const k1Only = new EnvHmacKeyProvider({
    NEXUS_ENVELOPE_HMAC_KID: "k1",
    NEXUS_ENVELOPE_HMAC_KEY_HEX: "ab".repeat(32),
  });
  const store1 = new WorkerEnvelopeStore(engine, k1Only);
  seedParent(engine, "m-phase1", "s-1");
  const r1 = store1.persist(makeEnvelope("m-phase1"));
  check("Phase 1: persist with k1 succeeds", r1.persisted === true);
  const e1 = store1.load("m-phase1")!;
  check("Phase 1: row signed with k1", e1.kid === "k1");
  check("Phase 1: k1 verifies under k1", store1.verifyIntegrity(e1).ok === true);

  // --- Phase 2: rotate to k2 (k1 retired), verify old row with k1 in retired ---
  const k1k2 = new EnvHmacKeyProvider({
    NEXUS_ENVELOPE_HMAC_KID: "k2",
    NEXUS_ENVELOPE_HMAC_KEY_HEX: "cd".repeat(32),
    NEXUS_ENVELOPE_HMAC_KEYS_JSON: JSON.stringify([
      { kid: "k1", key_hex: "ab".repeat(32) },
    ]),
  });
  const store2 = new WorkerEnvelopeStore(engine, k1k2);

  // Old row (signed with k1) must still verify because k1 is in retired
  check("Phase 2: k1-signed row verifies while k1 in retired",
    store2.verifyIntegrity(e1).ok === true);

  // New row signs with k2
  seedParent(engine, "m-phase2", "s-1");
  const r2 = store2.persist(makeEnvelope("m-phase2"));
  check("Phase 2: persist with k2 succeeds", r2.persisted === true);
  const e2 = store2.load("m-phase2")!;
  check("Phase 2: new row signed with k2", e2.kid === "k2");
  check("Phase 2: k2 row verifies under k2", store2.verifyIntegrity(e2).ok === true);

  // --- Phase 3: drop k1 (only k2 known), old row must fail with unknown_kid ---
  const k2Only = new EnvHmacKeyProvider({
    NEXUS_ENVELOPE_HMAC_KID: "k2",
    NEXUS_ENVELOPE_HMAC_KEY_HEX: "cd".repeat(32),
  });
  const store3 = new WorkerEnvelopeStore(engine, k2Only);
  const v3 = store3.verifyIntegrity(e1); // k1-signed row
  check("Phase 3: k1-signed row fails when k1 dropped",
    v3.ok === false && (v3 as any).reason === "unknown_kid");
  check("Phase 3: k2-signed row still verifies",
    store3.verifyIntegrity(e2).ok === true);

  // --- Phase 4: tamper detection survives rotation ---
  const tampered = { ...e2, acceptedAt: e2.acceptedAt + 1 };
  const v4 = store3.verifyIntegrity(tampered);
  check("Phase 4: tampered row detected as metadata_mismatch",
    v4.ok === false && (v4 as any).reason === "metadata_mismatch");

  raw.close();
  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => { console.error("FATAL:", e); process.exitCode = 2; });
