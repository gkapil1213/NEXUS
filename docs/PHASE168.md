# Phase 168 - Durable Project-Scoped Authorization

## Objective

Add durable project membership + resource-scoped authorization. No second
identity system, no second authorization engine, no second database.
Closes the isolation gap documented at the end of Phase 167.

## Architecture

Two layers:

  GLOBAL   can(actor, permission)                  src/core/security.ts
  PROJECT  authorizeProject(ctx, actor, perm, id)  src/core/project-authorization.ts

authorizeProject enforces in order:
  1. actor status active
  2. global role holds permission
  3. project exists
  4. ACTIVE membership
  5. membership role permits permission

Platform admin (OWNER) bypasses steps 4-5 only. Every other role, including
ADMIN, needs a real membership.

## Files

- src/core/project-membership-store.ts  SQL-backed membership + PROJECT_* role matrix
- src/core/project-authorization.ts     authorizeProject + resolveProjectForJobId
- src/db/migrations/158_phase168_project_memberships.sql
- scripts/test-phase168-project-authorization.ts

## Membership model

    project_memberships(membership_id, project_id, user_id, role, status,
                        created_at, updated_at) UNIQUE(project_id, user_id)

Roles: PROJECT_OWNER / PROJECT_ADMIN / PROJECT_OPERATOR / PROJECT_VIEWER.
Status: ACTIVE / SUSPENDED / REVOKED. upsert() reactivates; revoke()/suspend()
flip status only on ACTIVE rows. insertProjectWithOwner() writes the project
row and the creator PROJECT_OWNER membership in one better-sqlite3 txn.

## Execution project link

    execution_jobs.payload.executionId -> executions KV -> Execution.project_id

execution_jobs deliberately gains NO project_id column - that would be a
second source of truth. Jobs with no executionId are system-scoped: no
membership required; only the platform admin may read them via provenance.

## Service enforcement

- ProjectService create/get/list/update
- ExecutionService createQueued/get/list/byProject/cancel/transition
- WorkspaceService create/get/activate/cleanup/readFile/writeFile/listFiles/exists
- ExecutionAuditProvenanceService every read method

Non-authorized callers receive PROJECT_ACCESS_DENIED or, for project-scoped
provenance reads, PROVENANCE_NOT_FOUND - so resource existence is not
enumerable.

## Isolation invariant

    User A + Project A -> ALLOW
    User A + Project B -> DENY
    User B + Project B -> ALLOW
    User B + Project A -> DENY

Verified for projects, executions, workspaces, and provenance (by ID /
attempt / recovery / job / retry lineage / verification).

## Migration

Migration 158 is additive. It does NOT backfill existing projects - pre-168
NEXUS had no authoritative ownership record for them, and inventing one is
forbidden by the spec. Pre-existing projects remain readable by the platform
admin; anyone else must be granted membership explicitly.

## Tests and regression

    Phase 168    44 / 0
    Phase 167    52 / 0
    Phase 166   118 / 0
    Phase 165    94 / 0
    tsc --noEmit   clean
    npm run build  clean
    git diff --check  clean

## Known limitations

1. Shared nexus.sqlite boot hang. The 68 MB dev database at the repo root
   does not currently complete NexusKernel.boot() - boot blocks synchronously
   before the first step fires. Independent of Phase 168: reproduced with
   Phase 168 code reverted; all Phase 168 / 167 / 166 / 165 suites use
   in-memory DBs and pass. Deferred to a follow-up phase.
2. Pre-Phase-168 projects have no memberships (see Migration).
3. Migration applied_at uses new Date().toISOString() - pre-existing runner
   behavior, unchanged here.
