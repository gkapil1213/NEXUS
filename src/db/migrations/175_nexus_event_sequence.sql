-- Migration 175: monotonic per-store sequence allocation.
-- Replaces EventService's non-atomic maxSeq()+1 with a single-statement
-- counter, so two processes cannot allocate the same value. Also removes
-- a full-table JSON scan from the emit hot path.

CREATE TABLE IF NOT EXISTS nexus_sequences (
  store TEXT PRIMARY KEY,
  next  INTEGER NOT NULL
);