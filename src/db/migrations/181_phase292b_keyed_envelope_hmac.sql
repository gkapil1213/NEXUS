-- Phase 292B Block B: keyed envelope integrity.
--
-- Migration 180 added envelope_sha256 (unkeyed, tamper-*detecting* only).
-- This migration adds the keyed MAC that actually authenticates envelope
-- identity against an attacker who can rewrite the SQLite file.
--
--   kid            : which HMAC key signed this row. NULL for legacy rows.
--   envelope_hmac  : hex HMAC-SHA-256 over canonicalEnvelopeInput(...).
--                    NULL for legacy rows.
--
-- Legacy rows (both NULL) remain loadable but fail strict verification.
-- New rows MUST populate both. Uniqueness of message_id already enforced.

ALTER TABLE worker_message_envelopes ADD COLUMN kid TEXT;
ALTER TABLE worker_message_envelopes ADD COLUMN envelope_hmac TEXT;
