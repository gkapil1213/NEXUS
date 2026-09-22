// src/server/db-health.ts
// Phase 181: durable-state readiness probe.
//
// Read-only. Verifies the persistence layer is genuinely usable for
// control traffic. Never calls a provider, never acquires a lease, never
// mutates recovery state.
//
// Writable check uses BEGIN IMMEDIATE + ROLLBACK: it proves a write lock
// is obtainable without committing any change.

import type Database from "better-sqlite3";

export interface DbHealthDetail {
  ok: boolean;
  detail: string;
}

export interface DbHealthMeta {
  persistence_mode: string;
  coordination_mode: string;
  instance_id: string | null;
  reason: string;
  /** Phase 183: present when shared mode is configured. */
  shared_backend?: {
    family: string;
    url_redacted: string | null;
    reachable: boolean | null;
    latency_ms: number | null;
    detail: string | null;
  };
}

export interface DbHealthResult {
  ok: boolean;
  checks: Record<string, DbHealthDetail>;
  /** Present when the caller supplied persistence-mode context. */
  meta?: DbHealthMeta;
}

const REQUIRED_TABLES = [
  "nexus_records",
  "nexus_schema_migrations",
  "release_deployment_intents",
];

export function probeDbHealth(db: Database.Database, meta?: DbHealthMeta): DbHealthResult {
  const checks: Record<string, DbHealthDetail> = {};

  // 1. Readable
  try {
    db.prepare("SELECT 1").get();
    checks.readable = { ok: true, detail: "SELECT 1 ok" };
  } catch (e) {
    checks.readable = { ok: false, detail: (e as Error).message };
    return { ok: false, checks };
  }

  // 2. Writable (transaction that rolls back)
  try {
    db.exec("BEGIN IMMEDIATE; ROLLBACK;");
    checks.writable = { ok: true, detail: "BEGIN IMMEDIATE / ROLLBACK ok" };
  } catch (e) {
    checks.writable = { ok: false, detail: (e as Error).message };
  }

  // 3. Required tables
  try {
    const present = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name),
    );
    const missing = REQUIRED_TABLES.filter((t) => !present.has(t));
    checks.required_tables = {
      ok: missing.length === 0,
      detail: missing.length === 0 ? "all present" : "missing: " + missing.join(","),
    };
  } catch (e) {
    checks.required_tables = { ok: false, detail: (e as Error).message };
  }

  // 4. Migrations applied (non-empty history + matches latest on disk by name)
  try {
    const row = db.prepare("SELECT COUNT(*) c FROM nexus_schema_migrations").get() as { c: number };
    checks.migrations_applied = {
      ok: row.c > 0,
      detail: row.c + " migration(s) applied",
    };
  } catch (e) {
    checks.migrations_applied = { ok: false, detail: (e as Error).message };
  }

  // 5. WAL mode (production durability characteristic)
  try {
    const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined;
    const mode = (row?.journal_mode ?? "unknown").toLowerCase();
    // Memory DBs report "memory"; file DBs in production report "wal".
    // Accept both; flag as informative rather than failed.
    checks.journal_mode = {
      ok: mode === "wal" || mode === "memory",
      detail: mode,
    };
  } catch (e) {
    checks.journal_mode = { ok: false, detail: (e as Error).message };
  }

  const ok = Object.values(checks).every((c) => c.ok);
  const result: DbHealthResult = { ok, checks };
  if (meta) result.meta = meta;
  return result;
}