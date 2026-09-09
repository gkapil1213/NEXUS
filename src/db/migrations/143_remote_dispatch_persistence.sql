ALTER TABLE remote_dispatches ADD COLUMN external_provider_id TEXT;
ALTER TABLE remote_dispatches ADD COLUMN request TEXT;
ALTER TABLE remote_dispatches ADD COLUMN result TEXT;
ALTER TABLE remote_dispatches ADD COLUMN updated_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_remote_dispatches_job
ON remote_dispatches(job_id);
