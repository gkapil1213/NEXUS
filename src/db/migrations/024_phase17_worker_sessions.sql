-- Phase 17.2: Secure Worker Transport & Session Layer
ALTER TABLE worker_sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'CREATED';
ALTER TABLE worker_sessions ADD COLUMN protocol_version TEXT;
ALTER TABLE worker_sessions ADD COLUMN connection_id TEXT;
ALTER TABLE worker_sessions ADD COLUMN last_seen_at INTEGER;
ALTER TABLE worker_sessions ADD COLUMN last_heartbeat_at INTEGER;
ALTER TABLE worker_sessions ADD COLUMN last_sequence INTEGER DEFAULT 0;
ALTER TABLE worker_sessions ADD COLUMN authenticated_at INTEGER;
ALTER TABLE worker_sessions ADD COLUMN metadata TEXT;
