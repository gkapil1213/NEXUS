// Phase 292B keyed integrity smoke test.
//
// Uses SQLiteEngine.open() (which runs migrations 179/180/181 and turns on
// foreign_keys=ON). Because migration 179 declares
//   FOREIGN KEY (message_id) REFERENCES worker_message_ids(message_id),
// the test must insert into worker_message_ids before persisting an envelope
// — exactly the ordering WorkerTransportSecurity.acceptMessageDurable uses in
// production.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { EnvHmacKeyProvider, hmacEquals } from "../src/core/envelope-hmac-key-provider";
import { WorkerEnvelopeStore } from "../src/core/worker-envelope-store";

const dir = mkdtempSync(join(tmpdir(), "nexus-phase292b-"));
const engine = await SQLiteEngine.open(join(dir, "test.db"));

// Verify migration 181 applied before running (makes failures diagnosable).
const cols = (engine
  .prepare("PRAGMA table_info(worker_message_envelopes)")
  .all() as Array<{ name: string }>).map((c) => c.name);
for (const required of ["payload_sha256", "envelope_sha256", "kid", "envelope_hmac"]) {
  if (!cols.includes(required))
    throw new Error(`schema missing ${required}; migration 181 not applied. Columns: ${cols.join(",")}`);
}



// Ensure the dedup table exists and seed the FK parent row.
// (In production this row is inserted by acceptMessageDurable, and the table
// itself is created by WorkerTransportSecurity's constructor. Migration 179
// should own this table; until it does, the test seeds it.)
engine.exec(`
  CREATE TABLE IF NOT EXISTS worker_message_ids (
    message_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    seen_at INTEGER NOT NULL
  );
`);
const testKeyHex = "ab".repeat(32);
const providerEnv = {
  NEXUS_ENVELOPE_HMAC_KID: "test-k1",
  NEXUS_ENVELOPE_HMAC_KEY_HEX: testKeyHex,
};
const provider = new EnvHmacKeyProvider(providerEnv);

function expectThrow(label: string, action: () => unknown): void {
  let threw = false;
  try { action(); } catch { threw = true; }
  if (!threw) throw new Error(`${label}: expected constructor/function to reject input`);
}

// --- 0. Provider hardening: deterministic validation and defensive copies. ---
expectThrow("empty current KID", () => new EnvHmacKeyProvider({
  NEXUS_ENVELOPE_HMAC_KID: "",
  NEXUS_ENVELOPE_HMAC_KEY_HEX: testKeyHex,
}));
expectThrow("unsafe current KID", () => new EnvHmacKeyProvider({
  NEXUS_ENVELOPE_HMAC_KID: "bad/kid",
  NEXUS_ENVELOPE_HMAC_KEY_HEX: testKeyHex,
}));
expectThrow("overlong current KID", () => new EnvHmacKeyProvider({
  NEXUS_ENVELOPE_HMAC_KID: "k".repeat(129),
  NEXUS_ENVELOPE_HMAC_KEY_HEX: testKeyHex,
}));
expectThrow("unsafe historical KID", () => new EnvHmacKeyProvider({
  ...providerEnv,
  NEXUS_ENVELOPE_HMAC_KEYS_JSON: JSON.stringify([
    { kid: "bad/kid", key_hex: "cd".repeat(32) },
  ]),
}));
expectThrow("duplicate historical KIDs", () => new EnvHmacKeyProvider({
  ...providerEnv,
  NEXUS_ENVELOPE_HMAC_KEYS_JSON: JSON.stringify([
    { kid: "old-k1", key_hex: "cd".repeat(32) },
    { kid: "old-k1", key_hex: "ef".repeat(32) },
  ]),
}));
expectThrow("historical KID duplicates current KID", () => new EnvHmacKeyProvider({
  ...providerEnv,
  NEXUS_ENVELOPE_HMAC_KEYS_JSON: JSON.stringify([
    { kid: "test-k1", key_hex: "cd".repeat(32) },
  ]),
}));

if (hmacEquals("a".repeat(64), "a".repeat(64)) !== true)
  throw new Error("valid equal HMAC hex strings should compare equal");
for (const malformed of ["", "abc", "g".repeat(64), "a".repeat(65)]) {
  if (hmacEquals(malformed, "a".repeat(64)) !== false)
    throw new Error(`hmacEquals accepted malformed input: ${JSON.stringify(malformed)}`);
}
console.log("hardening: KID validation, duplicate rejection, strict HMAC hex PASS");

// Mutating returned buffers must never mutate the provider's stored key.
provider.currentKey().key.fill(0);
provider.keyForKid("test-k1")!.key.fill(0);
provider.verifiableKeys()[0].key.fill(0);
if (provider.currentKey().key.toString("hex") !== testKeyHex)
  throw new Error("provider key was mutated through a returned key buffer");
console.log("hardening: defensive key-buffer copies PASS");
// Retired-kid positive path: verify that keyForKid returns the correct
// retired key when the kid matches a key in NEXUS_ENVELOPE_HMAC_KEYS_JSON
// (not just the current key).
{
  const retiredProvider = new EnvHmacKeyProvider({
    NEXUS_ENVELOPE_HMAC_KID: "current-k",
    NEXUS_ENVELOPE_HMAC_KEY_HEX: "ab".repeat(32),
    NEXUS_ENVELOPE_HMAC_KEYS_JSON: JSON.stringify([
      { kid: "retired-k1", key_hex: "cd".repeat(32) },
      { kid: "retired-k2", key_hex: "ef".repeat(32) },
    ]),
  });
  const k1 = retiredProvider.keyForKid("retired-k1");
  const k2 = retiredProvider.keyForKid("retired-k2");
  const unknown = retiredProvider.keyForKid("nonexistent");
  if (!k1 || k1.kid !== "retired-k1" || k1.key.toString("hex") !== "cd".repeat(32))
    throw new Error("retired kid k1 not returned correctly");
  if (!k2 || k2.kid !== "retired-k2" || k2.key.toString("hex") !== "ef".repeat(32))
    throw new Error("retired kid k2 not returned correctly");
  if (unknown !== undefined)
    throw new Error("unknown kid should return undefined");
  console.log("retired_key_verifies PASS (k1, k2, unknown)");
}

const store = new WorkerEnvelopeStore(engine as any, provider);

function seedMessageId(messageId: string, sessionId: string): void {
  engine
    .prepare("INSERT INTO worker_message_ids (message_id, session_id, seen_at) VALUES (?, ?, ?)")
    .run(messageId, sessionId, Date.now());
}

const baseEnv = {
  messageType: "ping",
  workerId: "w-1",
  sessionId: "s-1",
  envelopeVersion: 1,
  acceptedAt: Date.now(),
  payload: { hello: "world" },
};

// --- 1. Happy path: sign, persist, load, verify. ---
const m1 = { messageId: "m-1", ...baseEnv };
seedMessageId("m-1", "s-1");
const r = store.persist(m1 as any);
if (!r.persisted) throw new Error("persist failed: " + r.reason);
console.log("persist:", r.kid, r.envelopeHmac?.slice(0, 16) + "...");

const loaded = store.load("m-1");
if (!loaded) throw new Error("load failed");
const v = store.verifyIntegrity(loaded!);
if (!v.ok) throw new Error("verify failed: " + JSON.stringify(v));
console.log("verify: ok");

// --- 2. Tamper: in-memory mutation must be detected. ---
loaded!.acceptedAt += 1;
const v2 = store.verifyIntegrity(loaded!);
if (v2.ok) throw new Error("tampered envelope verified!");
console.log("tamper detected:", (v2 as any).reason);

// --- 3. Unknown kid: row signed by a key the current provider doesn't know. ---
const retired = new EnvHmacKeyProvider({
  NEXUS_ENVELOPE_HMAC_KID: "k0",
  NEXUS_ENVELOPE_HMAC_KEY_HEX: "cd".repeat(32),
});
const storeRetired = new WorkerEnvelopeStore(engine as any, retired);
seedMessageId("m-2", "s-1");
const r2 = storeRetired.persist({ messageId: "m-2", ...baseEnv } as any);
if (!r2.persisted) throw new Error("persist2 failed: " + r2.reason);

const loaded2 = store.load("m-2")!;
const v3 = store.verifyIntegrity(loaded2); // current provider is k1, row signed by k0
if (v3.ok || (v3 as any).reason !== "unknown_kid")
  throw new Error("expected unknown_kid, got: " + JSON.stringify(v3));
console.log("unknown_kid detected");

// --- 4. Legacy row: no kid, no HMAC, must be rejected as legacy_unverified. ---
seedMessageId("m-3", "s-1");
engine.prepare(
  `INSERT INTO worker_message_envelopes
     (message_id, message_type, worker_id, session_id, payload_json,
      payload_sha256, envelope_version, accepted_at, envelope_sha256)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
).run("m-3", "ping", "w-1", "s-1", '{"x":1}', "deadbeef", 1, Date.now());
const loaded3 = store.load("m-3")!;
const v4 = store.verifyIntegrity(loaded3);
if (v4.ok || (v4 as any).reason !== "legacy_unverified")
  throw new Error("expected legacy_unverified, got: " + JSON.stringify(v4));
console.log("legacy_unverified detected");

// --- 5. FK enforcement sanity: persist without a parent must fail closed. ---
// persist() must map the FK violation to persistence_error without throwing.
let r5: ReturnType<typeof store.persist>;
try {
  r5 = store.persist({ messageId: "m-orphan", ...baseEnv } as any);
} catch (e) {
  throw new Error("persist() must not throw on FK violation; got: " + (e as Error).message);
}
if (r5.persisted || r5.reason !== "persistence_error")
  throw new Error("orphan persist should fail with persistence_error, got: " + JSON.stringify(r5));
console.log("fk enforcement: ok (orphan row rejected)");

console.log("ALL OK");



