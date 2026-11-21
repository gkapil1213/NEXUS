CREATE TABLE IF NOT EXISTS http_idempotency_claims (
    idempotency_key TEXT PRIMARY KEY,
    principal_id    TEXT NOT NULL,
    method          TEXT NOT NULL,
    path            TEXT NOT NULL,
    request_hash    TEXT NOT NULL,
    state           TEXT NOT NULL CHECK (state IN ('IN_PROGRESS', 'COMPLETED')),
    response_status INTEGER,
    response_body   TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    CHECK (
        (state = 'IN_PROGRESS' AND response_status IS NULL AND response_body IS NULL)
        OR
        (state = 'COMPLETED' AND response_status BETWEEN 200 AND 299 AND response_body IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_http_idem_claims_created
    ON http_idempotency_claims(created_at);
