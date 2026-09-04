-- Phase 17.4: Worker Artifact, Log & Result Integrity
ALTER TABLE remote_execution_results ADD COLUMN stdout_sha256 TEXT;
ALTER TABLE remote_execution_results ADD COLUMN stderr_sha256 TEXT;
ALTER TABLE remote_execution_results ADD COLUMN result_sha256 TEXT;
ALTER TABLE remote_execution_results ADD COLUMN verification_status TEXT DEFAULT 'PENDING';
ALTER TABLE remote_execution_results ADD COLUMN verified_at INTEGER;

ALTER TABLE execution_artifacts ADD COLUMN integrity_verified_at INTEGER;
ALTER TABLE execution_artifacts ADD COLUMN integrity_status TEXT DEFAULT 'PENDING';
ALTER TABLE execution_artifacts ADD COLUMN immutable INTEGER DEFAULT 0;
