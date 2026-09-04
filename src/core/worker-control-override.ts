import Database from "better-sqlite3";

export type OverrideType = "STOP_AUTONOMOUS_CONTROL" | "PAUSE_AUTONOMOUS_CONTROL" | "RESUME_AUTONOMOUS_CONTROL" | "CANCEL_DECISION" | "CANCEL_ACTION";

export interface ControlOverride {
  overrideId: string;
  overrideType: OverrideType;
  targetScope: string;
  actor: string;
  reason?: string;
  createdAt: number;
  expiresAt?: number;
}

export class WorkerControlOverrideStore {
  constructor(private db: Database.Database) {}

  create(override: ControlOverride): void {
    this.db.prepare(`
      INSERT INTO control_overrides (override_id, override_type, target_scope, actor, reason, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      override.overrideId,
      override.overrideType,
      override.targetScope,
      override.actor,
      override.reason,
      override.createdAt,
      override.expiresAt
    );
  }

  isActive(type: OverrideType): boolean {
    return this.hasActiveOverride(type);
  }

  hasActiveOverride(type: OverrideType): boolean {
    const row = this.db.prepare(`
      SELECT 1 FROM control_overrides
      WHERE override_type = ? AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY created_at DESC LIMIT 1
    `).get(type, Date.now());
    return !!row;
  }
}
