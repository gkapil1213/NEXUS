-- 159_phase169_single_active_owner.sql
-- Phase 169 - enforce exactly one ACTIVE project owner per project.
--
-- A partial unique index makes "one ACTIVE PROJECT_OWNER per project" a
-- database invariant, not just a service-layer check. This forces any
-- ownership transfer to demote the previous owner and promote the new
-- owner inside a single transaction - otherwise SQLite rejects the
-- intermediate state where two rows would both satisfy the constraint.
--
-- Only ACTIVE PROJECT_OWNER rows participate. Demoted ex-owners (now
-- PROJECT_ADMIN) and SUSPENDED / REVOKED owners are excluded.

CREATE UNIQUE INDEX IF NOT EXISTS uq_pm_single_active_owner
  ON project_memberships(project_id)
  WHERE role = 'PROJECT_OWNER' AND status = 'ACTIVE';