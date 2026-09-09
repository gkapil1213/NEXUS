CREATE TABLE IF NOT EXISTS remote_dispatches (
    dispatch_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    worker_id TEXT NOT NULL,
    lease_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    status TEXT NOT NULL,
    external_provider_id TEXT,
    request TEXT,
    result TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (job_id) REFERENCES execution_jobs(id),
    FOREIGN KEY (attempt_id) REFERENCES execution_attempts(id),
    FOREIGN KEY (worker_id) REFERENCES execution_workers(worker_id),
    FOREIGN KEY (lease_id) REFERENCES execution_leases(lease_id)
);
CREATE INDEX idx_remote_dispatches_job ON remote_dispatches(job_id);
