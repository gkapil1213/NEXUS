import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MigrationRunner } from "../src/core/migration-runner";

const root = mkdtempSync(join(tmpdir(), "nexus-p291-migration-"));
const migrations = join(root, "migrations");
mkdirSync(migrations);

const source = join(process.cwd(), "src", "db", "migrations");
for (const file of [
  "177_phase289_worker_message_ids.sql",
  "178_phase291_message_handler_status.sql",
]) {
  copyFileSync(join(source, file), join(migrations, file));
}

let passed = 0;
function check(label: string, condition: boolean): void {
  assert.ok(condition, label);
  passed++;
  console.log(`PASS ${label}`);
}

try {
  // T12: fresh database, actual MigrationRunner execution.
  {
    const db = new Database(join(root, "fresh.sqlite"));
    try {
      new MigrationRunner(db, migrations).run();

      const columns = db.prepare("PRAGMA table_info(worker_message_ids)").all() as Array<{
        name: string;
      }>;
      const names = new Set(columns.map((column) => column.name));

      for (const name of [
        "message_id",
        "session_id",
        "seen_at",
        "handler_status",
        "handler_owner_id",
        "handler_claim_expires_at",
        "handler_started_at",
        "handler_completed_at",
        "handler_attempt_count",
        "handler_last_error",
        "handler_recovery_reason",
      ]) {
        check(`T12 fresh schema has ${name}`, names.has(name));
      }

      db.prepare(`
        INSERT INTO worker_message_ids (message_id, session_id, seen_at)
        VALUES ('historical-fresh', 'session-fresh', 1)
      `).run();

      const historical = db.prepare(`
        SELECT handler_status FROM worker_message_ids
        WHERE message_id = 'historical-fresh'
      `).get() as { handler_status: string };

      check(
        "T12 migration default classifies pre-existing row as LEGACY_UNVERIFIED",
        historical.handler_status === "LEGACY_UNVERIFIED",
      );

      db.prepare(`
        INSERT INTO worker_message_ids
          (message_id, session_id, seen_at, handler_status)
        VALUES ('new-accepted', 'session-fresh', 2, 'PENDING')
      `).run();

      const accepted = db.prepare(`
        SELECT handler_status FROM worker_message_ids
        WHERE message_id = 'new-accepted'
      `).get() as { handler_status: string };

      check(
        "T12 new accepted message explicitly receives PENDING",
        accepted.handler_status === "PENDING",
      );

      const applied = db.prepare(`
        SELECT id FROM nexus_schema_migrations
        WHERE id IN (
          '177_phase289_worker_message_ids',
          '178_phase291_message_handler_status'
        )
      `).all() as Array<{ id: string }>;

      check("T12 MigrationRunner recorded both migrations", applied.length === 2);
    } finally {
      db.close();
    }
  }

  // T13: a genuine legacy table and row exist before migration 178.
  {
    const legacyDir = join(root, "legacy-migrations");
    mkdirSync(legacyDir);

    copyFileSync(
      join(source, "178_phase291_message_handler_status.sql"),
      join(legacyDir, "178_phase291_message_handler_status.sql"),
    );

    const db = new Database(join(root, "legacy.sqlite"));
    try {
      db.exec(`
        CREATE TABLE worker_message_ids (
          message_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          seen_at INTEGER NOT NULL
        );
        INSERT INTO worker_message_ids
          (message_id, session_id, seen_at)
        VALUES ('pre-178-message', 'pre-178-session', 123);
      `);

      const before = db.prepare(`
        SELECT message_id, session_id, seen_at
        FROM worker_message_ids WHERE message_id = 'pre-178-message'
      `).get() as {
        message_id: string;
        session_id: string;
        seen_at: number;
      };

      check("T13 legacy row exists before migration", before.message_id === "pre-178-message");

      new MigrationRunner(db, legacyDir).run();

      const after = db.prepare(`
        SELECT message_id, session_id, seen_at, handler_status
        FROM worker_message_ids WHERE message_id = 'pre-178-message'
      `).get() as typeof before & { handler_status: string };

      check("T13 migration preserves legacy message ID", after.message_id === before.message_id);
      check("T13 migration preserves legacy session ID", after.session_id === before.session_id);
      check("T13 migration preserves legacy seen_at", after.seen_at === before.seen_at);
      check(
        "T13 legacy row becomes LEGACY_UNVERIFIED",
        after.handler_status === "LEGACY_UNVERIFIED",
      );

      const applied = db.prepare(`
        SELECT id FROM nexus_schema_migrations
        WHERE id = '178_phase291_message_handler_status'
      `).get();

      check("T13 MigrationRunner records migration 178", applied !== undefined);
    } finally {
      db.close();
    }
  }

  console.log(`\nPHASE 291 MIGRATION TESTS: PASS ${passed}/${passed}`);
} catch (error) {
  console.error("\nPHASE 291 MIGRATION TESTS: FAIL");
  console.error(error);
  process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
