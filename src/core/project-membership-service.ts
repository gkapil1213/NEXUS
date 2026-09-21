// src/core/project-membership-service.ts
//
// Phase 169 - durable project membership administration service.
//
// Business rules + authorization + audit + events live here.
// Persistence + transactions + uniqueness live in
// ProjectMembershipStore (SQL). Authorization uses Phase 168
// authorizeProject for every operation.
//
// Enumeration resistance: an actor without access to a project sees
// the same PROJECT_ACCESS_DENIED error the Phase 168 layer already
// produces for missing projects - cannot distinguish "project does
// not exist" from "project exists but I am not a member".

import { Err } from "./errors";
import { authorizeProject } from "./project-authorization";
import type { ServiceContext, Actor } from "./services";
import type {
  ProjectMembershipRole,
  ProjectMembership,
} from "./project-membership-store";

const VALID_ROLES: ReadonlyArray<ProjectMembershipRole> = [
  "PROJECT_OWNER",
  "PROJECT_ADMIN",
  "PROJECT_OPERATOR",
  "PROJECT_VIEWER",
];

// Roles that may be assigned through addMember()/changeRole(). OWNER is
// intentionally excluded - it is only reachable through transferOwnership
// and initial project creation.
const ASSIGNABLE_ROLES: ReadonlyArray<ProjectMembershipRole> = [
  "PROJECT_ADMIN",
  "PROJECT_OPERATOR",
  "PROJECT_VIEWER",
];

export interface MembershipView {
  membershipId: string;
  projectId: string;
  userId: string;
  role: ProjectMembershipRole;
  status: "ACTIVE" | "SUSPENDED" | "REVOKED";
  createdAt: number;
  updatedAt: number;
}

function toView(m: ProjectMembership): MembershipView {
  return {
    membershipId: m.membershipId,
    projectId: m.projectId,
    userId: m.userId,
    role: m.role,
    status: m.status,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

function assertValidRole(role: string): asserts role is ProjectMembershipRole {
  if (!VALID_ROLES.includes(role as ProjectMembershipRole)) {
    throw Err.validation("INVALID_PROJECT_ROLE", "unknown project role: " + role);
  }
}

function assertAssignableRole(role: string): asserts role is ProjectMembershipRole {
  assertValidRole(role);
  if (!ASSIGNABLE_ROLES.includes(role as ProjectMembershipRole)) {
    throw Err.validation(
      "ROLE_NOT_ASSIGNABLE",
      "PROJECT_OWNER is only reachable via transferOwnership",
    );
  }
}

export class ProjectMembershipService {
  constructor(private readonly ctx: ServiceContext) {}

  private get store() { return this.ctx.memberships; }

  private async requireUser(userId: string): Promise<void> {
    const u = await this.ctx.engine.get("users", userId);
    if (!u) {
      throw Err.validation("UNKNOWN_USER", "target user does not exist");
    }
  }

  private async audit(
    actor: Actor,
    action: string,
    projectId: string,
    metadata: Record<string, unknown>,
    result: "allow" | "deny" | "error" = "allow",
  ): Promise<void> {
    await this.ctx.audit.record({
      actor: actor.email,
      action,
      resource_type: "project_membership",
      resource_id: projectId,
      result,
      metadata,
    });
  }

  private async emit(
    type:
      | "project.member.added"
      | "project.member.role_changed"
      | "project.member.suspended"
      | "project.member.restored"
      | "project.member.revoked"
      | "project.ownership.transferred",
    projectId: string,
    userId: string,
    payload: Record<string, unknown> = {},
  ): Promise<void> {
    await this.ctx.events.emit({
      type,
      source: "ProjectMembershipService",
      payload: { project_id: projectId, user_id: userId, ...payload },
    });
  }

  // ---------- reads ----------

  async listMembers(actor: Actor, projectId: string): Promise<MembershipView[]> {
    await authorizeProject(this.ctx, actor, "membership:read", projectId);
    return this.store.listForProject(projectId).map(toView);
  }

  async getMembership(actor: Actor, projectId: string, userId: string): Promise<MembershipView> {
    await authorizeProject(this.ctx, actor, "membership:read", projectId);
    const m = this.store.get(projectId, userId);
    if (!m) throw Err.notFound("MEMBERSHIP_NOT_FOUND", "membership not found");
    return toView(m);
  }

  // ---------- mutations ----------

  async addMember(
    actor: Actor,
    projectId: string,
    targetUserId: string,
    role: ProjectMembershipRole,
  ): Promise<MembershipView> {
    await authorizeProject(this.ctx, actor, "membership:create", projectId);
    assertAssignableRole(role);
    await this.requireUser(targetUserId);

    const existing = this.store.get(projectId, targetUserId);
    if (existing && existing.status === "ACTIVE") {
      // Idempotency: same role -> return as-is; different role -> reject
      // (caller should use changeRole).
      if (existing.role === role) return toView(existing);
      throw Err.conflict("MEMBERSHIP_ALREADY_EXISTS", "member already active with a different role");
    }

    // upsert reactivates SUSPENDED/REVOKED. This is an explicit re-grant.
    const m = this.store.upsert(projectId, targetUserId, role);
    await this.audit(actor, "project.member.add", projectId, {
      target_user: targetUserId,
      role,
      previous_status: existing?.status ?? null,
    });
    await this.emit("project.member.added", projectId, targetUserId, { role });
    return toView(m);
  }

  async changeRole(
    actor: Actor,
    projectId: string,
    targetUserId: string,
    newRole: ProjectMembershipRole,
  ): Promise<MembershipView> {
    await authorizeProject(this.ctx, actor, "membership:update", projectId);
    assertAssignableRole(newRole);

    const res = this.store.changeRole(projectId, targetUserId, newRole);
    if (!res.ok) {
      if (res.reason === "NOT_ACTIVE") {
        throw Err.notFound("MEMBERSHIP_NOT_FOUND", "active membership not found");
      }
      if (res.reason === "INVALID_TARGET_ROLE") {
        throw Err.validation("ROLE_NOT_ASSIGNABLE", "cannot assign PROJECT_OWNER via changeRole");
      }
      if (res.reason === "LAST_OWNER") {
        throw Err.conflict("LAST_OWNER_PROTECTED", "cannot change role of the last active owner");
      }
    }
    const { previous, updated } = res as { previous: ProjectMembership; updated: ProjectMembership };
    await this.audit(actor, "project.member.role_change", projectId, {
      target_user: targetUserId,
      old_role: previous.role,
      new_role: updated.role,
    });
    await this.emit("project.member.role_changed", projectId, targetUserId, {
      old_role: previous.role,
      new_role: updated.role,
    });
    return toView(updated);
  }

  async suspendMember(actor: Actor, projectId: string, targetUserId: string): Promise<MembershipView> {
    await authorizeProject(this.ctx, actor, "membership:update", projectId);
    const res = this.store.suspendSafe(projectId, targetUserId);
    if (!res.ok) {
      if (res.reason === "NOT_ACTIVE") {
        throw Err.notFound("MEMBERSHIP_NOT_FOUND", "active membership not found");
      }
      throw Err.conflict("LAST_OWNER_PROTECTED", "cannot suspend the last active owner");
    }
    await this.audit(actor, "project.member.suspend", projectId, { target_user: targetUserId });
    await this.emit("project.member.suspended", projectId, targetUserId);
    return toView(res.updated);
  }

  async restoreMember(actor: Actor, projectId: string, targetUserId: string): Promise<MembershipView> {
    await authorizeProject(this.ctx, actor, "membership:update", projectId);
    const res = this.store.restoreSuspended(projectId, targetUserId);
    if (!res.ok) {
      throw Err.conflict("MEMBERSHIP_NOT_RESTORABLE", "membership is not SUSPENDED");
    }
    await this.audit(actor, "project.member.restore", projectId, { target_user: targetUserId });
    await this.emit("project.member.restored", projectId, targetUserId, { role: res.updated.role });
    return toView(res.updated);
  }

  async revokeMember(actor: Actor, projectId: string, targetUserId: string): Promise<MembershipView> {
    await authorizeProject(this.ctx, actor, "membership:revoke", projectId);
    const res = this.store.revokeSafe(projectId, targetUserId);
    if (!res.ok) {
      if (res.reason === "NOT_ACTIVE") {
        throw Err.notFound("MEMBERSHIP_NOT_FOUND", "active membership not found");
      }
      throw Err.conflict("LAST_OWNER_PROTECTED", "cannot revoke the last active owner");
    }
    await this.audit(actor, "project.member.revoke", projectId, { target_user: targetUserId });
    await this.emit("project.member.revoked", projectId, targetUserId);
    return toView(res.updated);
  }

  async transferOwnership(
    actor: Actor,
    projectId: string,
    fromUserId: string,
    toUserId: string,
    oldOwnerNewRole: ProjectMembershipRole = "PROJECT_ADMIN",
  ): Promise<{ previousOwner: MembershipView; newOwner: MembershipView; demotedOwner: MembershipView }> {
    await authorizeProject(this.ctx, actor, "membership:update", projectId);
    if (oldOwnerNewRole === "PROJECT_OWNER") {
      throw Err.validation("INVALID_DEMOTION_ROLE", "old owner cannot remain PROJECT_OWNER");
    }
    assertAssignableRole(oldOwnerNewRole);

    const res = this.store.transferOwnership(projectId, fromUserId, toUserId, oldOwnerNewRole);
    if (!res.ok) {
      if (res.reason === "FROM_NOT_OWNER") {
        throw Err.conflict("FROM_NOT_ACTIVE_OWNER", "source is not an active PROJECT_OWNER");
      }
      if (res.reason === "TO_NOT_ACTIVE") {
        throw Err.conflict("TARGET_NOT_ACTIVE", "target membership is not ACTIVE");
      }
      if (res.reason === "TO_IS_FROM") {
        throw Err.validation("SELF_TRANSFER", "cannot transfer ownership to self");
      }
      throw Err.validation("INVALID_DEMOTION_ROLE", "invalid demotion role");
    }
    await this.audit(actor, "project.ownership.transfer", projectId, {
      from_user: fromUserId,
      to_user: toUserId,
      old_owner_new_role: oldOwnerNewRole,
    });
    await this.emit("project.ownership.transferred", projectId, toUserId, {
      from_user: fromUserId,
      to_user: toUserId,
      old_owner_new_role: oldOwnerNewRole,
    });
    return {
      previousOwner: toView(res.previousOwner),
      newOwner: toView(res.newOwner),
      demotedOwner: toView(res.demotedOwner),
    };
  }
}