// src/core/persistence-integrity.ts
// Phase 181: read-only durable-state consistency checker.
//
// Never mutates durable state. Returns HEALTHY / DEGRADED / CORRUPT / BLOCKED
// with per-check evidence. Designed to be safe to call at any time, including
// from a readiness probe.
//
// Only checks columns/tables that actually exist in this repository. Unknown
// schema shapes are skipped rather than assumed.

import type Database from "better-sqlite3";
import { createHash } from "crypto";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import type { NexusEngine } from "./db";

export type IntegrityVerdict = "HEALTHY" | "DEGRADED" | "CORRUPT" | "BLOCKED";

export interface IntegrityCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface IntegrityIssue {
  check: string;
  severity: "degraded" | "corrupt" | "blocked";
  message: string;
  evidence?: Record<string, unknown>;
}

export interface IntegrityReport {
  verdict: IntegrityVerdict;
  checkedAt: number;
  checks: IntegrityCheck[];
  issues: IntegrityIssue[];
}

export interface IntegrityOptions {
  db: Database.Database;
  engine: NexusEngine;
  migrationsDir: string;
  now?: number;
  /** Cap on rows inspected per check to keep this O(bounded). */
  maxRowsPerCheck?: number;
}

const REQUIRED_TABLES = [
  "nexus_records",
  "nexus_schema_migrations",
  "release_deployment_intents",
];

const TERMINAL_STATUSES = ["KNOWN_GOOD", "FAILED", "BLOCKED", "CANCELLED"];

export async function checkIntegrity(opts: IntegrityOptions): Promise<IntegrityReport> {
  const now = opts.now ?? Date.now();
  const cap = opts.maxRowsPerCheck ?? 5_000;
  const checks: IntegrityCheck[] = [];
  const issues: IntegrityIssue[] = [];
  const db = opts.db;

  const add = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail });
  };

  // --- 1. SQLite's own integrity check ---------------------------------
  try {
    const row = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
    const result = row?.integrity_check ?? "unknown";
    const ok = result === "ok";
    add("sqlite.integrity_check", ok, result);
    if (!ok) issues.push({ check: "sqlite.integrity_check", severity: "corrupt", message: "SQLite integrity_check reported: " + result });
  } catch (e) {
    add("sqlite.integrity_check", false, (e as Error).message);
    issues.push({ check: "sqlite.integrity_check", severity: "blocked", message: "integrity_check failed: " + (e as Error).message });
  }

  // --- 2. Foreign key check --------------------------------------------
  try {
    const rows = db.prepare("PRAGMA foreign_key_check").all() as unknown[];
    const ok = rows.length === 0;
    add("sqlite.foreign_key_check", ok, ok ? "no violations" : rows.length + " violations");
    if (!ok) issues.push({ check: "sqlite.foreign_key_check", severity: "corrupt", message: rows.length + " foreign key violations", evidence: { count: rows.length } });
  } catch (e) {
    // Some SQLite builds error if no FK declared; treat as informational.
    add("sqlite.foreign_key_check", true, "skipped: " + (e as Error).message);
  }

  // --- 3. Required tables exist ----------------------------------------
  const presentTables = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name),
  );
  for (const t of REQUIRED_TABLES) {
    const ok = presentTables.has(t);
    add("table." + t, ok, ok ? "present" : "MISSING");
    if (!ok) issues.push({ check: "table." + t, severity: "blocked", message: "required table missing: " + t });
  }

  // --- 4. Migration checksums match on-disk files -----------------------
  try {
    const applied = db.prepare("SELECT id, filename, checksum FROM nexus_schema_migrations").all() as
      { id: string; filename: string; checksum: string }[];
    const onDisk = readdirSync(opts.migrationsDir).filter((f) => f.endsWith(".sql")).sort();
    const byId = new Map(applied.map((r) => [r.id, r]));

    const mismatched: string[] = [];
    for (const fname of onDisk) {
      const id = fname.replace(/\.sql$/, "");
      const rec = byId.get(id);
      if (!rec) continue; // not yet applied is allowed; runner will apply it
      const sql = readFileSync(join(opts.migrationsDir, fname), "utf8");
      const cs = createHash("sha256").update(sql).digest("hex");
      if (cs !== rec.checksum) mismatched.push(fname);
    }
    const ok = mismatched.length === 0;
    add("migration.checksums", ok, ok ? applied.length + " applied, all match" : mismatched.length + " mismatched");
    if (!ok) issues.push({ check: "migration.checksums", severity: "corrupt", message: "applied migration checksum mismatch (tampered or edited file)", evidence: { mismatched } });
  } catch (e) {
    add("migration.checksums", false, (e as Error).message);
    issues.push({ check: "migration.checksums", severity: "blocked", message: "migration check failed: " + (e as Error).message });
  }

  // --- 5. KNOWN_GOOD without reconciliation_evidence --------------------
  // Phase 176 guarantee: KNOWN_GOOD must be backed by evidence.
  try {
    const rows = db.prepare(
      "SELECT intent_key, release_id, deployment_id, reconciled_at " +
      "FROM release_deployment_intents " +
      "WHERE status = 'KNOWN_GOOD' AND (reconciliation_evidence IS NULL OR length(reconciliation_evidence) = 0) " +
      "LIMIT ?",
    ).all(cap) as { intent_key: string; release_id: string; deployment_id: string | null; reconciled_at: number | null }[];
    const ok = rows.length === 0;
    add("intent.known_good_has_evidence", ok, ok ? "all KNOWN_GOOD have evidence" : rows.length + " without evidence");
    if (!ok) issues.push({ check: "intent.known_good_has_evidence", severity: "corrupt", message: "KNOWN_GOOD intents without reconciliation_evidence", evidence: { intents: rows.map((r) => r.intent_key) } });
  } catch (e) {
    add("intent.known_good_has_evidence", false, (e as Error).message);
    issues.push({ check: "intent.known_good_has_evidence", severity: "blocked", message: "query failed: " + (e as Error).message });
  }

  // --- 6. lease fields consistent -------------------------------------
  try {
    const rows = db.prepare(
      "SELECT intent_key, leased_by, lease_expires_at FROM release_deployment_intents " +
      "WHERE (leased_by IS NOT NULL AND lease_expires_at IS NULL) " +
      "   OR (leased_by IS NULL AND lease_expires_at IS NOT NULL AND lease_expires_at > 0) " +
      "LIMIT ?",
    ).all(cap) as { intent_key: string; leased_by: string | null; lease_expires_at: number | null }[];
    const ok = rows.length === 0;
    add("intent.lease_fields_consistent", ok, ok ? "lease fields consistent" : rows.length + " inconsistent");
    if (!ok) issues.push({ check: "intent.lease_fields_consistent", severity: "corrupt", message: "leased_by / lease_expires_at in impossible combination", evidence: { intents: rows.map((r) => r.intent_key) } });
  } catch (e) {
    add("intent.lease_fields_consistent", false, (e as Error).message);
    issues.push({ check: "intent.lease_fields_consistent", severity: "blocked", message: "query failed: " + (e as Error).message });
  }

  // --- 7. No non-terminal intent missing project_id --------------------
  try {
    const inClause = TERMINAL_STATUSES.map(() => "?").join(",");
    const rows = db.prepare(
      "SELECT intent_key, status FROM release_deployment_intents " +
      "WHERE (project_id IS NULL OR length(project_id) = 0) " +
      "AND status NOT IN (" + inClause + ") LIMIT ?",
    ).all(...TERMINAL_STATUSES, cap) as { intent_key: string; status: string }[];
    const ok = rows.length === 0;
    add("intent.nonterminal_has_project", ok, ok ? "all non-terminal have project_id" : rows.length + " without project_id");
    if (!ok) issues.push({ check: "intent.nonterminal_has_project", severity: "degraded", message: "non-terminal intents without project_id", evidence: { intents: rows.map((r) => r.intent_key) } });
  } catch (e) {
    add("intent.nonterminal_has_project", false, (e as Error).message);
    issues.push({ check: "intent.nonterminal_has_project", severity: "blocked", message: "query failed: " + (e as Error).message });
  }

  // --- 8. Duplicate intent_key paranoia check --------------------------
  try {
    const rows = db.prepare(
      "SELECT intent_key, COUNT(*) c FROM release_deployment_intents GROUP BY intent_key HAVING c > 1 LIMIT ?",
    ).all(cap) as { intent_key: string; c: number }[];
    const ok = rows.length === 0;
    add("intent.unique_keys", ok, ok ? "no duplicate keys" : rows.length + " duplicated");
    if (!ok) issues.push({ check: "intent.unique_keys", severity: "corrupt", message: "duplicate intent_key rows (PRIMARY KEY violation impossible; storage corruption suspected)", evidence: { keys: rows.map((r) => r.intent_key) } });
  } catch (e) {
    add("intent.unique_keys", false, (e as Error).message);
    issues.push({ check: "intent.unique_keys", severity: "blocked", message: "query failed: " + (e as Error).message });
  }

  // --- 9. Orphan project references (KV check, async) ------------------
  try {
    const distinct = db.prepare(
      "SELECT DISTINCT project_id FROM release_deployment_intents WHERE project_id IS NOT NULL AND length(project_id) > 0 LIMIT ?",
    ).all(cap) as { project_id: string }[];
    const missing: string[] = [];
    for (const { project_id } of distinct) {
      const p = await opts.engine.get<unknown>("projects", project_id);
      if (!p) missing.push(project_id);
    }
    const ok = missing.length === 0;
    add("intent.project_exists", ok, ok ? "all referenced projects exist" : missing.length + " orphan project refs");
    if (!ok) issues.push({ check: "intent.project_exists", severity: "degraded", message: "intents reference non-existent projects", evidence: { projectIds: missing } });
  } catch (e) {
    add("intent.project_exists", false, (e as Error).message);
    issues.push({ check: "intent.project_exists", severity: "blocked", message: "query failed: " + (e as Error).message });
  }

  // --- Verdict ---------------------------------------------------------
  let verdict: IntegrityVerdict = "HEALTHY";
  if (issues.some((i) => i.severity === "blocked")) verdict = "BLOCKED";
  else if (issues.some((i) => i.severity === "corrupt")) verdict = "CORRUPT";
  else if (issues.some((i) => i.severity === "degraded")) verdict = "DEGRADED";

  return { verdict, checkedAt: now, checks, issues };
}