-- Phase 177: durable recovery decision journal.
-- Adds an explicit, queryable record of the last authoritative recovery
-- decision the control loop produced for an intent. Distinct from
-- reconciliation_evidence (which is provenance for the deciding worker).
ALTER TABLE release_deployment_intents ADD COLUMN last_recovery_decision TEXT;
ALTER TABLE release_deployment_intents ADD COLUMN last_recovery_decision_at INTEGER;