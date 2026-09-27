-- Migration 168: Phase 210 - evidence-backed release safety attestations.
-- One row per (release_id, verification_run_id, commit_sha). The unique index
-- gives idempotent re-evaluation: repeated gate calls against unchanged
-- inputs do not create duplicate rows. Attestation is written only after the
-- decision has been fully computed, never in the middle.

CREATE TABLE IF NOT EXISTS release_attestations (
  attestation_id      TEXT PRIMARY KEY,
  release_id          TEXT NOT NULL,
  execution_id        TEXT NOT NULL,
  verification_run_id TEXT NOT NULL,
  commit_sha          TEXT NOT NULL,
  artifact_id         TEXT,
  artifact_digest     TEXT,
  verification_status TEXT NOT NULL,
  result_digest       TEXT NOT NULL,
  evidence_digest     TEXT NOT NULL,
  decision            TEXT NOT NULL,
  reasons_json        TEXT,
  policy_version      TEXT NOT NULL,
  decided_at          INTEGER NOT NULL,
  created_at          INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_release_attestations_unique
  ON release_attestations(release_id, verification_run_id, commit_sha);

CREATE INDEX IF NOT EXISTS idx_release_attestations_release
  ON release_attestations(release_id);

CREATE INDEX IF NOT EXISTS idx_release_attestations_commit
  ON release_attestations(commit_sha);
