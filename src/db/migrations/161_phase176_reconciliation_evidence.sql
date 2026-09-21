-- Migration 161: Phase 176 - durable reconciliation provenance on release intents.
--
-- When a release intent reaches a terminal state via recovery reconciliation,
-- the authority for that decision must be reconstructible from durable state.
-- This column stores a bounded JSON envelope describing the evidence the
-- deciding worker observed: evidence source, container/running image identity,
-- health/smoke verdicts, worker/attempt ids, and identity bindings the worker
-- checked. It is written only alongside a terminal transition and is never
-- used to make a decision (decisions still run through the existing
-- inspection/verification path). It exists so the audit trail has the
-- "why" attached to the intent, not just an audit event in a separate table.
--
-- Backward compatible: existing rows default to NULL; readers treat NULL as
-- "no provenance recorded" (pre-Phase-176 behavior preserved).

ALTER TABLE release_deployment_intents ADD COLUMN reconciliation_evidence TEXT;

CREATE INDEX IF NOT EXISTS idx_release_intents_reconciled
ON release_deployment_intents(reconciled_at);