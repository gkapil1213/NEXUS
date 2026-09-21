// src/core/project-authorization.ts
//
// Phase 168 - project-scoped authorization extension.
//
// This is NOT a parallel authorization engine. It extends the existing
// security.ts + services.ts authorize() pipeline with two focused
// helpers:
//
//   resolveProjectForJobId(engine, getJob, jobId) - authoritative link
//     from the scheduler-layer execution_jobs row, through
//     payload.executionId, to the Execution KV row's project_id.
//     Returns null for system-scoped jobs (no Execution or Execution has
//     no project).
//
//   authorizeProject(ctx, actor, permission, projectId) - the canonical
//     project authorization call. Enforces the full order:
//       active actor -> global permission -> project exists ->
//       active membership -> role permits.
//
// Fail-closed: any missing step denies. Any unexpected engine failure
// propagates as a real error, never a silent allow.

import { can } from "./security";
import { Err } from "./errors";
import { projectRoleAllows, type ProjectMembership } from "./project-membership-store";
import type { AuditService } from "./audit";
import type { ProjectMembershipStore } from "./project-membership-store";
import type { Execution } from "./types";
import type { NexusEngine } from "./db";

/**
 * Roles that retain cross-project authority. Deliberately narrow: OWNER
 * only. These are platform admin identities, not ordinary project members.
 */
const PLATFORM_ADMIN_ROLES = new Set(["OWNER"]);

export interface ProjectAuthCtx {
  engine: NexusEngine;
  audit: AuditService;
  memberships: ProjectMembershipStore;
}

export interface ProjectAuthActor {
  id: string;
  email: string;
  role: string;
  status: string;
}

export function isPlatformAdmin(actor: { role: string }): boolean {
  return PLATFORM_ADMIN_ROLES.has(actor.role);
}

/**
 * Resolve the authoritative project for a scheduler job.
 *
 * Chain: jobId -> execution_jobs.payload.executionId -> executions KV ->
 *        Execution.project_id.
 *
 * Returns:
 *   - string  : project-scoped job, this is the project id
 *   - null    : system-scoped job (no Execution, or Execution has no
 *               project). Callers must treat this as "global permission
 *               only" per Phase 168 section 15.
 *
 * Never invents a project. Never defaults to a placeholder.
 */
export async function resolveProjectForJobId(
  engine: NexusEngine,
  getJob: (id: string) => { payload?: any } | undefined,
  jobId: string,
): Promise<string | null> {
  const job = getJob(jobId);
  if (!job) return null;
  const payload = job.payload;
  const executionId =
    payload && typeof payload === "object" && typeof (payload as any).executionId === "string"
      ? (payload as any).executionId
      : null;
  if (!executionId) return null;
  const execution = await engine.get<Execution>("executions", executionId);
  if (!execution) return null;
  const pid = execution.project_id;
  if (typeof pid !== "string" || pid.length === 0) return null;
  return pid;
}

/**
 * Canonical project authorization. Call this AFTER resolving the
 * authoritative project id from the resource itself.
 *
 * Order (per Phase 168 section 8):
 *   1. actor is active              (can() enforces)
 *   2. global permission held       (can())
 *   3. project exists               (engine.get "projects")
 *   4. active membership exists     (ProjectMembershipStore)
 *   5. membership role permits      (projectRoleAllows)
 *
 * Platform admins (OWNER) skip steps 4/5 - documented cross-project
 * administrative path. Returns null in that case.
 *
 * Fail-closed. Every missing step denies via Err.denied with a stable
 * code. Uses the same error shape for "project_not_found" and
 * "not_a_member" so unauthorized callers cannot enumerate project
 * existence.
 */
export async function authorizeProject(
  ctx: ProjectAuthCtx,
  actor: ProjectAuthActor,
  permission: string,
  projectId: string,
): Promise<ProjectMembership | null> {
  // steps 1 + 2
  if (!can(actor as any, permission as any)) {
    await ctx.audit.record({
      actor: actor.email,
      action: `denied:${permission}`,
      resource_type: "project",
      resource_id: projectId,
      result: "deny",
      metadata: { role: actor.role, permission, reason: "global_permission" },
    });
    throw Err.denied(
      "PERMISSION_DENIED",
      `role '${actor.role}' does not hold '${permission}'`,
    );
  }

  // step 3
  const project = await ctx.engine.get("projects", projectId);
  if (!project) {
    await ctx.audit.record({
      actor: actor.email,
      action: `denied:${permission}`,
      resource_type: "project",
      resource_id: projectId,
      result: "deny",
      metadata: { role: actor.role, permission, reason: "project_not_found" },
    });
    throw Err.denied("PROJECT_ACCESS_DENIED", "access denied");
  }

  // platform admins bypass steps 4-5
  if (isPlatformAdmin(actor)) return null;

  // step 4
  const membership = ctx.memberships.get(projectId, actor.id);
  if (!membership || membership.status !== "ACTIVE") {
    await ctx.audit.record({
      actor: actor.email,
      action: `denied:${permission}`,
      resource_type: "project",
      resource_id: projectId,
      result: "deny",
      metadata: {
        role: actor.role,
        permission,
        reason: membership ? `membership_${membership.status}` : "no_membership",
      },
    });
    throw Err.denied("PROJECT_ACCESS_DENIED", "access denied");
  }

  // step 5
  if (!projectRoleAllows(membership.role, permission)) {
    await ctx.audit.record({
      actor: actor.email,
      action: `denied:${permission}`,
      resource_type: "project",
      resource_id: projectId,
      result: "deny",
      metadata: {
        role: actor.role,
        permission,
        membershipRole: membership.role,
        reason: "insufficient_project_role",
      },
    });
    throw Err.denied("PROJECT_ACCESS_DENIED", "access denied");
  }

  return membership;
}

/**
 * Non-throwing project permission check. Used by list operations that
 * filter rather than throw. Returns true only for platform admins or
 * active members whose role permits the permission.
 */
export function projectPermissionAllowed(
  ctx: ProjectAuthCtx,
  actor: ProjectAuthActor,
  permission: string,
  projectId: string,
): boolean {
  if (!can(actor as any, permission as any)) return false;
  if (isPlatformAdmin(actor)) return true;
  const membership = ctx.memberships.get(projectId, actor.id);
  if (!membership || membership.status !== "ACTIVE") return false;
  return projectRoleAllows(membership.role, permission);
}
