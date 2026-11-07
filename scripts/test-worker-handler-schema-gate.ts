import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NexusEngine } from "../src/core/db";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { WorkerTransportSecurity } from "../src/core/worker-transport-security";

const root = mkdtempSync(join(tmpdir(), "nexus-handler-schema-gate-"));

const requiredColumns = [
  "handler_status",
  "handler_owner_id",
  "handler_claim_expires_at",
  "handler_started_at",
  "handler_completed_at",
  "handler_attempt_count",
  "handler_last_error",
  "handler_recovery_reason",
  "fencing_token",
  "retry_count",
  "next_retry_at",
  "quarantine_reason",
] as const;

const definitions: Record<string, string> = {
  handler_status: "TEXT NOT NULL DEFAULT 'LEGACY_UNVERIFIED'",
  handler_owner_id: "TEXT",
  handler_claim_expires_at: "INTEGER",
  handler_started_at: "INTEGER",
  handler_completed_at: "INTEGER",
  handler_attempt_count: "INTEGER NOT NULL DEFAULT 0",
  handler_last_error: "TEXT",
  handler_recovery_reason: "TEXT",
  fencing_token: "INTEGER NOT NULL DEFAULT 1",
  retry_count: "INTEGER NOT NULL DEFAULT 0",
  next_retry_at: "INTEGER",
  quarantine_reason: "TEXT",
};

let passed = 0;

function check(label: string, condition: boolean): void {
  assert.ok(condition, label);
  passed++;
  console.log(`PASS ${label}`);
}

function createBaseTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE worker_message_ids (
      message_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      seen_at INTEGER NOT NULL
    );
  `);
}

function createHandlerTable(
  db: Database.Database,
  omittedColumn?: string,
): void {
  const columns = requiredColumns
    .filter((name) => name !== omittedColumn)
    .map((name) => `${name} ${definitions[name]}`);

  db.exec(`
    CREATE TABLE worker_message_ids (
      message_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      seen_at INTEGER NOT NULL,
      ${columns.join(",\n")}
    );
  `);
}

function withSqlite(
  name: string,
  setup: (db: Database.Database) => void,
  test: (security: WorkerTransportSecurity, db: Database.Database) => void,
): void {
  const rawDb = new Database(join(root, `${name}.sqlite`));

  try {
    setup(rawDb);
    const engine = SQLiteEngine.fromDatabase(rawDb);
    const security = new WorkerTransportSecurity(engine);
    test(security, rawDb);
  } finally {
    rawDb.close();
  }
}

try {
  withSqlite(
    "complete",
    (db) => createHandlerTable(db),
    (security) => {
      check(
        "T1 complete 12-column schema is accepted",
        security.hasHandlerTrackingSchema(),
      );
    },
  );

  for (const missingColumn of requiredColumns) {
    withSqlite(
      `missing-${missingColumn}`,
      (db) => createHandlerTable(db, missingColumn),
      (security) => {
        check(
          `T2 missing ${missingColumn} is rejected`,
          !security.hasHandlerTrackingSchema(),
        );
      },
    );
  }

  withSqlite(
    "phase289-only",
    createBaseTable,
    (security) => {
      check(
        "T3 Phase 289 base schema is rejected",
        !security.hasHandlerTrackingSchema(),
      );
    },
  );

  withSqlite(
    "missing-table",
    () => undefined,
    (security, db) => {
      const columns = db
        .prepare("PRAGMA table_info(worker_message_ids)")
        .all() as Array<{ name: string }>;

      const names = new Set(columns.map((column) => column.name));

      check(
        "T4 constructor creates the base table",
        names.has("message_id") &&
          names.has("session_id") &&
          names.has("seen_at"),
      );

      check(
        "T4 constructor-created base table is rejected",
        !security.hasHandlerTrackingSchema(),
      );
    },
  );

  const memoryEngine = {
    kind: "memory",
    exec: (_sql: string) => undefined,
  } as unknown as NexusEngine;

  const memorySecurity = new WorkerTransportSecurity(memoryEngine);

  check(
    "T5 non-SQLite engine is rejected",
    !memorySecurity.hasHandlerTrackingSchema(),
  );

  console.log(`\nWORKER HANDLER SCHEMA GATE: PASS ${passed}/${passed}`);
} catch (error) {
  console.error("\nWORKER HANDLER SCHEMA GATE: FAIL");
  console.error(error);
  process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
