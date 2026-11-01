// Phase 292B Block A: envelope HMAC key provider contract.
//
// PURPOSE: supply the HMAC-SHA-256 signing key that authenticates the
// complete envelope identity. The key MUST live outside SQLite; a hash
// stored next to the data it protects provides no defense against an
// attacker who can rewrite the data.
//
// DESIGN:
//   - One provider instance per process. Not a global singleton. Injected
//     at the composition root into every consumer that signs or verifies
//     envelopes.
//   - No default key. No fallback. No auto-provisioning. Construction
//     without valid configuration throws.
//   - currentKey() throws if no signing key is available.
//   - keyForKid() returns undefined on miss (a row signed under a retired
//     kid is unverifiable, not a provider failure).
//   - Rotation via KID-to-key map: current kid signs new envelopes,
//     previously-known kids remain verifiable until dropped.

import { createHmac, timingSafeEqual } from "node:crypto";

export interface EnvelopeHmacKey {
  readonly kid: string;
  readonly key: Buffer;
}

export interface EnvelopeHmacKeyProvider {
  currentKey(): EnvelopeHmacKey;
  verifiableKeys(): ReadonlyArray<EnvelopeHmacKey>;
  keyForKid(kid: string): EnvelopeHmacKey | undefined;
}

const HMAC_KEY_BYTES = 32;
const HEX_64 = /^[0-9a-fA-F]{64}$/;

function decodeHexKey(hex: string, source: string): Buffer {
  if (typeof hex !== "string" || !HEX_64.test(hex)) {
    throw new Error(`invalid_envelope_hmac_key: ${source} must be 64 hex characters (32 bytes)`);
  }
  const buf = Buffer.from(hex, "hex");
  if (buf.length !== HMAC_KEY_BYTES) {
    throw new Error(`invalid_envelope_hmac_key: ${source} decoded to ${buf.length} bytes, expected ${HMAC_KEY_BYTES}`);
  }
  return buf;
}

export class EnvHmacKeyProvider implements EnvelopeHmacKeyProvider {
  private readonly current: EnvelopeHmacKey;
  private readonly extra: ReadonlyArray<EnvelopeHmacKey>;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const kid = env.NEXUS_ENVELOPE_HMAC_KID;
    const keyHex = env.NEXUS_ENVELOPE_HMAC_KEY_HEX;
    if (!kid) {
      throw new Error("missing_envelope_hmac_kid: NEXUS_ENVELOPE_HMAC_KID must be set to enable envelope signing");
    }
    if (!keyHex) {
      throw new Error("missing_envelope_hmac_key: NEXUS_ENVELOPE_HMAC_KEY_HEX must be set to enable envelope signing");
    }
    this.current = { kid, key: decodeHexKey(keyHex, "NEXUS_ENVELOPE_HMAC_KEY_HEX") };

    const keysJson = env.NEXUS_ENVELOPE_HMAC_KEYS_JSON;
    if (!keysJson) {
      this.extra = [];
    } else {
      let parsed: unknown;
      try { parsed = JSON.parse(keysJson); }
      catch { throw new Error("invalid_envelope_hmac_keys_json: NEXUS_ENVELOPE_HMAC_KEYS_JSON is not valid JSON"); }
      if (!Array.isArray(parsed)) {
        throw new Error("invalid_envelope_hmac_keys_json: NEXUS_ENVELOPE_HMAC_KEYS_JSON must be a JSON array");
      }
      const extras: EnvelopeHmacKey[] = [];
      for (let i = 0; i < parsed.length; i++) {
        const entry = parsed[i];
        if (!entry || typeof entry !== "object" || typeof (entry as any).kid !== "string" || typeof (entry as any).key_hex !== "string") {
          throw new Error(`invalid_envelope_hmac_keys_json: entry ${i} must have string kid and key_hex`);
        }
        const kidE = (entry as any).kid as string;
        if (kidE === kid) {
          throw new Error(`invalid_envelope_hmac_keys_json: entry ${i} duplicates the current kid`);
        }
        extras.push({ kid: kidE, key: decodeHexKey((entry as any).key_hex, `KEYS_JSON[${i}]`) });
      }
      this.extra = extras;
    }
  }

  currentKey(): EnvelopeHmacKey { return this.current; }
  verifiableKeys(): ReadonlyArray<EnvelopeHmacKey> { return [this.current, ...this.extra]; }
  keyForKid(kid: string): EnvelopeHmacKey | undefined {
    if (kid === this.current.kid) return this.current;
    return this.extra.find((k) => k.kid === kid);
  }
}

/** Canonical HMAC input: fixed field order, NUL separators, payloadSha256 included. */
export function canonicalEnvelopeInput(envelope: {
  messageId: string;
  messageType: string;
  workerId: string;
  sessionId: string;
  envelopeVersion: number;
  acceptedAt: number;
  payloadSha256: string;
}): string {
  return [
    envelope.messageId,
    envelope.messageType,
    envelope.workerId,
    envelope.sessionId,
    String(envelope.envelopeVersion),
    String(envelope.acceptedAt),
    envelope.payloadSha256,
  ].join('\x00');
}

export function computeEnvelopeHmac(key: EnvelopeHmacKey, envelope: {
  messageId: string;
  messageType: string;
  workerId: string;
  sessionId: string;
  envelopeVersion: number;
  acceptedAt: number;
  payloadSha256: string;
}): string {
  return createHmac("sha256", key.key).update(canonicalEnvelopeInput(envelope)).digest("hex");
}

/** Constant-time hex comparison. */
export function hmacEquals(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  try {
    const bufA = Buffer.from(a, 'hex');
    const bufB = Buffer.from(b, 'hex');
    if (bufA.length !== bufB.length || bufA.length === 0) return false;
    return timingSafeEqual(bufA, bufB);
  } catch { return false; }
}