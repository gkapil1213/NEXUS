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
    "audit:read", "event:read", "evidence:read",
    "artifact:read", "artifact:create",
    "workspace:create", "workspace:read", "workspace:delete",
  ],
  PROJECT_OPERATOR: [
    "project:read",
    "execution:read", "execution:create", "execution:cancel", "execution:retry",
    "audit:read", "event:read", "evidence:read",
    "artifact:read", "artifact:create",
    "workspace:create", "workspace:read", "workspace:delete",
  ],
  PROJECT_VIEWER: [
    "project:read",
    "execution:read",
    "audit:read", "event:read", "evidence:read",
    "artifact:read",
    "workspace:read",
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
    const existing = this.get(projectId, userId);
    if (existing) {
      this.db.prepare(
        "UPDATE project_memberships SET role = ?, status = 'ACTIVE', updated_at = ? WHERE membership_id = ?"
      ).run(role, now, existing.membershipId);
      return { ...existing, role, status: "ACTIVE", updatedAt: now };
    }
    const id = nid("pm");
    this.db.prepare(
      "INSERT INTO project_memberships " +
      "(membership_id, project_id, user_id, role, status, created_at, updated_at) " +
      "VALUES (?,?,?,?,?,?,?)"
    ).run(id, projectId, userId, role, "ACTIVE", now, now);
    return {
      membershipId: id, projectId, userId, role,
      status: "ACTIVE", createdAt: now, updatedAt: now,
    };
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
