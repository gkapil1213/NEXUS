-- 180_phase292b_envelope_metadata_integrity.sql
--
-- Phase 292B: envelope metadata integrity.
--
-- Migration 179 established worker_message_envelopes with a payload-only
-- SHA-256 (payload_sha256) covering the serialized payload_json. It did
-- NOT cover message_type, worker_id, session_id, accepted_at, or
-- envelope_version. That gap means an attacker with write access to the
-- SQLite file — or a corrupted backup, or a future migration bug — can
-- change message_type from JOB_CANCEL (not replay-eligible) to HEARTBEAT
-- (replay-eligible) without triggering any integrity check. Once Slice 4
-- enables handler replay, that tampering could invoke the wrong handler
-- on tampered metadata.
--
-- This migration adds envelope_sha256, a full-row hash covering every
-- identity field except the payload bytes (which payload_sha256 already
-- covers). The two hashes are independent: tampering with the payload
-- fails payload_sha256; tampering with any metadata field fails
-- envelope_sha256.
--
-- Migration 179 is IMMUTABLE. This migration is additive: it does not
-- modify, drop, or recreate worker_message_envelopes. Existing rows have
-- envelope_sha256 = NULL. They are UNVERIFIED and must be quarantined
-- (or manually reconciled) before replay. New rows get envelope_sha256
-- populated at persist time inside the acceptance transaction.
--
-- Backward compatibility:
--   - ALTER TABLE ADD COLUMN with no default → existing rows get NULL.
--   - hasEnvelopeSchema() will be updated to require this column; if
--     migration 180 has not been applied, the store reports the schema
--     as absent and refuse to persist or verify (honest failure).
--   - Old code paths that only need payload integrity continue to work
--     via the split verifyPayloadIntegrity / verifyMetadataIntegrity
--     methods.
--
-- Canonical form for envelope_sha256:
--   sha256( message_id || '\x00' || message_type || '\x00' ||
--           worker_id  || '\x00' || session_id   || '\x00' ||
--           envelope_version || '\x00' || accepted_at || '\x00' ||
--           payload_sha256 )
--
-- The NULL byte separator prevents field-boundary ambiguity (e.g. so
-- that messageType='AB', workerId='C' hashes differently from
-- messageType='A', workerId='BC'). payload_sha256 is included so that
-- metadata and payload are cryptographically bound: an attacker who
-- replaces both payload and payload_sha256 must also recompute
-- envelope_sha256, which requires the same write access they already
-- had — but any *partial* tampering (only payload, only metadata, or
-- payload+its hash without metadata) is detected.

ALTER TABLE worker_message_envelopes ADD COLUMN envelope_sha256 TEXT;

CREATE INDEX IF NOT EXISTS idx_worker_envelopes_envelope_sha256
  ON worker_message_envelopes (envelope_sha256)
  WHERE envelope_sha256 IS NOT NULL;