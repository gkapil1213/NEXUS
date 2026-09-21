// src/core/project-membership-store.ts
//
// Phase 168 - durable project membership store and project-scoped role
// matrix.
//
// SQL-backed. Shares the same better-sqlite3 handle as SQLiteEngine -
// no second database. Project rows themselves are KV (nexus_records),
// memberships are SQL. insertProjectWithOwner() commits both in a
// single SQLite transaction.

import type Database from "better-sqlite3";
import { nid } from "./db";

export type ProjectMembershipRole =
  | "PROJECT_OWNER"
  | "PROJECT_ADMIN"
  | "PROJECT_OPERATOR"
  | "PROJECT_VIEWER";

export type ProjectMembershipStatus = "ACTIVE" | "SUSPENDED" | "REVOKED";

export interface ProjectMembership {
  membershipId: string;
  projectId: string;
  userId: string;
  role: ProjectMembershipRole;
  status: ProjectMembershipStatus;
  createdAt: number;
  updatedAt: number;
}

const PROJECT_ROLE_MATRIX: Record<ProjectMembershipRole, string[]> = {
  PROJECT_OWNER: ["*"],
  PROJECT_ADMIN: [
    "project:read", "project:update", "project:archive",
    "execution:read", "execution:create", "execution:cancel", "execution:retry",
    "audit:read", "event:read", "evidence:read", "evidence:create",
    "artifact:read", "artifact:create",
    "workspace:create", "workspace:read", "workspace:delete",
    "membership:read", "membership:create", "membership:update", "membership:revoke",
  ],
  PROJECT_OPERATOR: [
    "project:read",
    "execution:read", "execution:create", "execution:cancel", "execution:retry",
    "audit:read", "event:read", "evidence:read", "evidence:create",
    "artifact:read", "artifact:create",
    "workspace:create", "workspace:read", "workspace:delete",
    "membership:read",
  ],
  PROJECT_VIEWER: [
    "project:read",
    "execution:read",
    "audit:read", "event:read", "evidence:read",
    "artifact:read",
    "workspace:read",
    "membership:read",
  ],
};

export function projectRoleAllows(role: ProjectMembershipRole, permission: string): boolean {
  const perms = PROJECT_ROLE_MATRIX[role];
  if (!perms) return false;
  if (perms.includes("*")) return true;
  return perms.includes(permission);
}

export class ProjectMembershipStore {
  constructor(private readonly db: Database.Database) {}

  get(projectId: string, userId: string): ProjectMembership | undefined {
    const row = this.db.prepare(
      "SELECT * FROM project_memberships WHERE project_id = ? AND user_id = ?"
    ).get(projectId, userId) as any;
    return row ? this.map(row) : undefined;
  }

  /**
   * Idempotent membership grant. Reactivates a revoked/suspended row
   * rather than inserting a duplicate, so the unique index on
   * (project_id, user_id) is preserved.
   */
  upsert(projectId: string, userId: string, role: ProjectMembershipRole): ProjectMembership {
    const now = Date.now();
    const id = nid("pm");
    // SQL-level upsert: relies on the unique index (project_id, user_id).
    // Under concurrent calls, one INSERT wins and the other falls through
    // to DO UPDATE on the same row - no SELECT-then-write race.
    this.db.prepare(
      "INSERT INTO project_memberships " +
      "(membership_id, project_id, user_id, role, status, created_at, updated_at) " +
      "VALUES (?,?,?,?,?,?,?) " +
      "ON CONFLICT(project_id, user_id) DO UPDATE SET " +
      "role = excluded.role, status = 'ACTIVE', updated_at = excluded.updated_at"
    ).run(id, projectId, userId, role, "ACTIVE", now, now);
    const row = this.get(projectId, userId);
    if (!row) throw new Error("upsert invariant: row missing after write");
    return row;
  }

  revoke(projectId: string, userId: string): boolean {
    const now = Date.now();
    const res = this.db.prepare(
      "UPDATE project_memberships SET status = 'REVOKED', updated_at = ? " +
      "WHERE project_id = ? AND user_id = ? AND status = 'ACTIVE'"
    ).run(now, projectId, userId);
    return res.changes > 0;
  }

  suspend(projectId: string, userId: string): boolean {
    const now = Date.now();
    const res = this.db.prepare(
      "UPDATE project_memberships SET status = 'SUSPENDED', updated_at = ? " +
      "WHERE project_id = ? AND user_id = ? AND status = 'ACTIVE'"
    ).run(now, projectId, userId);
    return res.changes > 0;
  }

  listForProject(projectId: string): ProjectMembership[] {
    const rows = this.db.prepare(
      "SELECT * FROM project_memberships WHERE project_id = ? ORDER BY created_at ASC"
    ).all(projectId) as any[];
    return rows.map((r) => this.map(r));
  }

  /**
   * Atomic project creation. Writes the project KV row and inserts the
   * creator's PROJECT_OWNER membership in a single SQLite transaction.
   * Either both succeed or neither does.
   *
   * NOTE: writes nexus_records directly rather than going through
   * NexusEngine.put(), because NexusEngine.put is async and cannot
   * participate in better-sqlite3's synchronous transaction callback.
   * Both tables live in the same database; no second store is involved.
   */
  insertProjectWithOwner(project: any, ownerUserId: string): ProjectMembership {
    const now = Date.now();
    const membershipId = nid("pm");
    const tx = this.db.transaction(() => {
      this.db.prepare(
        "INSERT INTO nexus_records (store, key, value) VALUES (?, ?, ?)"
      ).run("projects", project.id, JSON.stringify(project));
      this.db.prepare(
        "INSERT INTO project_memberships " +
        "(membership_id, project_id, user_id, role, status, created_at, updated_at) " +
        "VALUES (?,?,?,?,?,?,?)"
      ).run(membershipId, project.id, ownerUserId, "PROJECT_OWNER", "ACTIVE", now, now);
    });
    tx();
    return {
      membershipId, projectId: project.id, userId: ownerUserId,
      role: "PROJECT_OWNER", status: "ACTIVE", createdAt: now, updatedAt: now,
    };
  }

  // ---------- Phase 169: ownership safety + lifecycle ----------

  /** Number of ACTIVE PROJECT_OWNER memberships for this project. */
  countActiveOwners(projectId: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS n FROM project_memberships " +
      "WHERE project_id = ? AND role = 'PROJECT_OWNER' AND status = 'ACTIVE'"
    ).get(projectId) as any;
    return row ? row.n : 0;
  }

  /**
   * Change a member's project role. Refuses:
   *   - assigning PROJECT_OWNER through this path (use transferOwnership)
   *   - demoting/suspending the last ACTIVE owner (last-owner invariant)
   * Runs inside a better-sqlite3 transaction so the invariant check and
   * the UPDATE are atomic.
   */
  changeRole(
    projectId: string,
    userId: string,
    newRole: ProjectMembershipRole,
  ): { ok: true; previous: ProjectMembership; updated: ProjectMembership } |
     { ok: false; reason: "NOT_ACTIVE" | "INVALID_TARGET_ROLE" | "LAST_OWNER" } {
    const tx = this.db.transaction((): any => {
      const existing = this.get(projectId, userId);
      if (!existing || existing.status !== "ACTIVE") {
        return { ok: false, reason: "NOT_ACTIVE" };
      }
      if (newRole === "PROJECT_OWNER") {
        return { ok: false, reason: "INVALID_TARGET_ROLE" };
      }
      // last-owner guard: if target is the sole ACTIVE owner and new role
      // is not PROJECT_OWNER, refuse.
      if (existing.role === "PROJECT_OWNER" && this.countActiveOwners(projectId) <= 1) {
        return { ok: false, reason: "LAST_OWNER" };
      }
      const now = Date.now();
      this.db.prepare(
        "UPDATE project_memberships SET role = ?, updated_at = ? WHERE membership_id = ?"
      ).run(newRole, now, existing.membershipId);
      return {
        ok: true,
        previous: existing,
        updated: { ...existing, role: newRole, updatedAt: now },
      };
    });
    return tx();
  }

  /**
   * Suspend an ACTIVE member. Refuses if target is the last ACTIVE owner.
   */
  suspendSafe(
    projectId: string,
    userId: string,
  ): { ok: true; previous: ProjectMembership; updated: ProjectMembership } |
     { ok: false; reason: "NOT_ACTIVE" | "LAST_OWNER" } {
    const tx = this.db.transaction((): any => {
      const existing = this.get(projectId, userId);
      if (!existing || existing.status !== "ACTIVE") {
        return { ok: false, reason: "NOT_ACTIVE" };
      }
      if (existing.role === "PROJECT_OWNER" && this.countActiveOwners(projectId) <= 1) {
        return { ok: false, reason: "LAST_OWNER" };
      }
      const now = Date.now();
      this.db.prepare(
        "UPDATE project_memberships SET status = 'SUSPENDED', updated_at = ? " +
        "WHERE membership_id = ?"
      ).run(now, existing.membershipId);
      return {
        ok: true,
        previous: existing,
        updated: { ...existing, status: "SUSPENDED", updatedAt: now },
      };
    });
    return tx();
  }

  /**
   * Revoke an ACTIVE member. Refuses if target is the last ACTIVE owner.
   */
  revokeSafe(
    projectId: string,
    userId: string,
  ): { ok: true; previous: ProjectMembership; updated: ProjectMembership } |
     { ok: false; reason: "NOT_ACTIVE" | "LAST_OWNER" } {
    const tx = this.db.transaction((): any => {
      const existing = this.get(projectId, userId);
      if (!existing || existing.status !== "ACTIVE") {
        return { ok: false, reason: "NOT_ACTIVE" };
      }
      if (existing.role === "PROJECT_OWNER" && this.countActiveOwners(projectId) <= 1) {
        return { ok: false, reason: "LAST_OWNER" };
      }
      const now = Date.now();
      this.db.prepare(
        "UPDATE project_memberships SET status = 'REVOKED', updated_at = ? " +
        "WHERE membership_id = ?"
      ).run(now, existing.membershipId);
      return {
        ok: true,
        previous: existing,
        updated: { ...existing, status: "REVOKED", updatedAt: now },
      };
    });
    return tx();
  }

  /**
   * Restore a SUSPENDED member back to ACTIVE with their existing role.
   * REVOKED memberships cannot be restored through this path - a fresh
   * upsert() is the only way back in, which is an explicit re-grant.
   */
  restoreSuspended(
    projectId: string,
    userId: string,
  ): { ok: true; previous: ProjectMembership; updated: ProjectMembership } |
     { ok: false; reason: "NOT_SUSPENDED" } {
    const tx = this.db.transaction((): any => {
      const existing = this.get(projectId, userId);
      if (!existing || existing.status !== "SUSPENDED") {
        return { ok: false, reason: "NOT_SUSPENDED" };
      }
      const now = Date.now();
      this.db.prepare(
        "UPDATE project_memberships SET status = 'ACTIVE', updated_at = ? " +
        "WHERE membership_id = ?"
      ).run(now, existing.membershipId);
      return {
        ok: true,
        previous: existing,
        updated: { ...existing, status: "ACTIVE", updatedAt: now },
      };
    });
    return tx();
  }

  /**
   * Transfer project ownership from one ACTIVE owner to another ACTIVE
   * member. Transactional; both updates commit or neither does. The
   * partial unique index uq_pm_single_active_owner plus the ordering
   * (demote first, then promote) guarantees exactly one ACTIVE owner
   * is visible at commit time, even under concurrent transfers.
   *
   * oldOwnerNewRole defaults to PROJECT_ADMIN. It must not be
   * PROJECT_OWNER (that would violate the invariant).
   */
  transferOwnership(
    projectId: string,
    fromUserId: string,
    toUserId: string,
    oldOwnerNewRole: ProjectMembershipRole = "PROJECT_ADMIN",
  ): { ok: true; previousOwner: ProjectMembership; newOwner: ProjectMembership; demotedOwner: ProjectMembership } |
     { ok: false; reason: "FROM_NOT_OWNER" | "TO_NOT_ACTIVE" | "TO_IS_FROM" | "INVALID_DEMOTION_ROLE" } {
    const tx = this.db.transaction((): any => {
      const from = this.get(projectId, fromUserId);
      const to = this.get(projectId, toUserId);
      if (!from || from.status !== "ACTIVE" || from.role !== "PROJECT_OWNER") {
        return { ok: false, reason: "FROM_NOT_OWNER" };
      }
      if (!to || to.status !== "ACTIVE") {
        return { ok: false, reason: "TO_NOT_ACTIVE" };
      }
      if (fromUserId === toUserId) {
        return { ok: false, reason: "TO_IS_FROM" };
      }
      if (oldOwnerNewRole === "PROJECT_OWNER") {
        return { ok: false, reason: "INVALID_DEMOTION_ROLE" };
      }
      const now = Date.now();
      // Order matters for the partial unique index: demote old owner
      // first (freeing the single-ACTIVE-owner slot), then promote target.
      this.db.prepare(
        "UPDATE project_memberships SET role = ?, updated_at = ? WHERE membership_id = ?"
      ).run(oldOwnerNewRole, now, from.membershipId);
      this.db.prepare(
        "UPDATE project_memberships SET role = 'PROJECT_OWNER', updated_at = ? WHERE membership_id = ?"
      ).run(now, to.membershipId);
      return {
        ok: true,
        previousOwner: from,
        newOwner: { ...to, role: "PROJECT_OWNER", updatedAt: now },
        demotedOwner: { ...from, role: oldOwnerNewRole, updatedAt: now },
      };
    });
    return tx();
  }
  private map(row: any): ProjectMembership {
    return {
      membershipId: row.membership_id,
      projectId: row.project_id,
      userId: row.user_id,
      role: row.role as ProjectMembershipRole,
      status: row.status as ProjectMembershipStatus,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
