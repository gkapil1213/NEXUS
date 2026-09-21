-- 158_phase168_project_memberships.sql
-- Phase 168 - durable project-scoped authorization.
--
-- Adds project_memberships: the authoritative (project, user, role,
-- status) table. Project rows themselves remain in nexus_records; this
-- table is the canonical membership source of truth.
--
-- NOTE: execution_jobs does NOT gain a project_id column. The authoritative
-- project link for execution is Execution.project_id (KV, src/core/types.ts).
-- execution_jobs carry payload.executionId which resolves to the Execution
-- row. Adding a second project_id on execution_jobs would be a duplicate
-- source of truth - rejected per Phase 168 section 2.

CREATE TABLE IF NOT EXISTS project_memberships (
  membership_id TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  role          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_pm_project_user
  ON project_memberships(project_id, user_id);

CREATE INDEX IF NOT EXISTS idx_pm_user
  ON project_memberships(user_id);

CREATE INDEX IF NOT EXISTS idx_pm_project_status
  ON project_memberships(project_id, status);