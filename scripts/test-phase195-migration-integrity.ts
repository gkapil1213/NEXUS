// scripts/test-phase195-migration-integrity.ts
//
// PHASE 195 — production migration integrity.
// Fresh DB + schema contract + reopen + idempotency + upgrade + restart.
// Real SQLite via SQLiteEngine.open() (production bootstrap).
// No mocks. No swallowed errors.

import { existsSync, unlinkSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

import { SQLiteEngine } from "../src/core/sqlite-engine";
import { MigrationRunner } from "../src/core/migration-runner";
import { ExecutionStore } from "../src/core/execution-store";
import { LeaseManager } from "../src/core/lease-manager";

let pass = 0, fail = 0, blocked = 0;
function ok(n: string, c: boolean, d = "") {
  if (c) { pass++; console.log("[PASSED] " + n + (d ? "  " + d : "")); }
  else   { fail++; console.log("[FAILED] " + n + (d ? "  " + d : "")); }
}
function blk(n: string, r: string) {
  blocked++; console.log("[BLOCKED] " + n + "  " + r);
}
function clean(p: string) { for (const e of ["", "-wal", "-shm"]) { try { unlinkSync(p + e); } catch {} } }

const MIG_DIR = join(process.cwd(), "src", "db", "migrations");

function listMigrations(): string[] {
  return readdirSync(MIG_DIR).filter(f => f.endsWith(".sql")).sort();
}
function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// Tables that every production path requires after a fresh migration.
// Sourced from spec §6 and from modules we have already inspected.
const REQUIRED_TABLES = [
  // bootstrap
  "nexus_schema_migrations",
  "nexus_records",
  // execution
  "execution_jobs",
  "execution_attempts",
  "execution_leases",
  "execution_artifacts",
  // recovery
  "execution_recovery_operations",
  "execution_ownership_obligations",
  // release / deployment
  "release_deployment_intents",
  // CI reconciliation
  "ci_artifact_reconciliations",
  "ci_reconciliation_worker_ownership",
  // observability
  "execution_events",
];

async function main() {
  console.log("PHASE 195 — MIGRATION INTEGRITY\n");
  console.log("Migration directory: " + MIG_DIR);

  const files = listMigrations();
  console.log("Migration file count: " + files.length + "\n");

  // ============ §1 DISCOVERY ============
  ok("§1 migration directory exists", existsSync(MIG_DIR));
  ok("§1 >100 migration files discovered", files.length > 100, "n=" + files.length);

  const i146 = files.findIndex(f => f.startsWith("146_"));
  const i160 = files.findIndex(f => f.startsWith("160_"));
  ok("§1 migration 146 discovered", i146 >= 0, files[i146] ?? "?");
  ok("§1 migration 160 discovered", i160 >= 0, files[i160] ?? "?");
  ok("§1 deterministic lexicographic order: 146 before 160", i146 >= 0 && i160 >= 0 && i146 < i160,
     `i146=${i146} i160=${i160}`);

  // ============ §2 FRESH DB ============
  const FRESH = path.join(os.tmpdir(), `nexus-p195-fresh-${Date.now()}.sqlite`);
  clean(FRESH);
  console.log("\nFresh database: " + FRESH);

  const engine1 = await SQLiteEngine.open(FRESH);
  const db1 = engine1.getDatabase();

  const history = db1.prepare("SELECT id, filename, checksum FROM nexus_schema_migrations ORDER BY id").all() as any[];
  ok("§2 migration history populated", history.length === files.length,
     `history=${history.length} files=${files.length}`);

  const historyIds = new Set(history.map(h => h.id));
  const fileIds = files.map(f => f.replace(/\.sql$/, ""));
  const missing = fileIds.filter(id => !historyIds.has(id));
  ok("§2 no migration missing from history", missing.length === 0,
     missing.length ? missing.slice(0, 5).join(",") : "");

  // checksum integrity
  let checksumDrift = 0;
  for (const h of history) {
    const file = files.find(f => f.replace(/\.sql$/, "") === h.id);
    if (!file) continue;
    const onDisk = sha256(readFileSync(join(MIG_DIR, file), "utf8"));
    if (onDisk !== h.checksum) checksumDrift++;
  }
  ok("§2 no checksum drift", checksumDrift === 0, "drift=" + checksumDrift);

  // ensure 146 actually ran
  ok("§2 migration 146 recorded", historyIds.has(files[i146].replace(/\.sql$/, "")));
  ok("§2 migration 160 recorded", historyIds.has(files[i160].replace(/\.sql$/, "")));

  // ============ §3 SCHEMA CONTRACT ============
  console.log("");
  for (const t of REQUIRED_TABLES) {
    const row = db1.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
    ok("§3 schema contract: table " + t, !!row);
  }

  // ============ §4 REOPEN ============
  engine1.close();
  const engine1b = await SQLiteEngine.open(FRESH);
  const db1b = engine1b.getDatabase();
  const historyAfter = db1b.prepare("SELECT COUNT(*) c FROM nexus_schema_migrations").get() as any;
  ok("§4 history survives reopen", historyAfter.c === files.length, "n=" + historyAfter.c);
  const jobTbl = db1b.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='execution_jobs'").get();
  ok("§4 schema survives reopen", !!jobTbl);

  // ============ §5 IDEMPOTENCY ============
  {
    const before = (db1b.prepare("SELECT COUNT(*) c FROM nexus_schema_migrations").get() as any).c;
    const runner = new MigrationRunner(db1b, MIG_DIR);
    runner.run();  // no-op — everything is already applied
    const after = (db1b.prepare("SELECT COUNT(*) c FROM nexus_schema_migrations").get() as any).c;
    ok("§5 second run: no new history rows", before === after, `before=${before} after=${after}`);
    runner.verifyIntegrity();
    ok("§5 checksum verification passes after second run", true);
  }

  // ============ §6 UPGRADE (partial history → full) ============
  {
    const UPG = path.join(os.tmpdir(), `nexus-p195-upgrade-${Date.now()}.sqlite`);
    clean(UPG);

    // Simulate an older database: apply only the first ~100 migrations.
    const K = Math.floor(files.length * 2 / 3);
    const older = new Database(UPG);
    older.pragma("journal_mode = WAL");
    older.exec(`CREATE TABLE IF NOT EXISTS nexus_schema_migrations (
      id TEXT PRIMARY KEY, filename TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL
    )`);
    for (let i = 0; i < K; i++) {
      const fname = files[i];
      const sql = readFileSync(join(MIG_DIR, fname), "utf8");
      try { older.exec(sql); } catch (e) {
        // some migrations require prior state — abort cleanly
        console.log("§6 could not apply partial migration " + fname + ": " + (e as Error).message);
        break;
      }
      older.prepare("INSERT OR IGNORE INTO nexus_schema_migrations (id, filename, checksum, applied_at) VALUES (?,?,?,?)")
        .run(fname.replace(/\.sql$/, ""), fname, sha256(sql), new Date().toISOString());
    }
    // Insert a durable marker row we can verify survives the upgrade.
    older.exec(`CREATE TABLE IF NOT EXISTS nexus_records (store TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (store, key))`);
    older.prepare("INSERT OR REPLACE INTO nexus_records (store, key, value) VALUES (?,?,?)")
      .run("kv", "p195_upgrade_marker", JSON.stringify({ v: "preserved" }));
    const partial = (older.prepare("SELECT COUNT(*) c FROM nexus_schema_migrations").get() as any).c;
    older.close();
    console.log("\n§6 upgrade: partial DB has " + partial + " of " + files.length + " migrations");

    // Now bootstrap via production path — must complete the chain.
    const engine2 = await SQLiteEngine.open(UPG);
    const db2 = engine2.getDatabase();
    const finalCount = (db2.prepare("SELECT COUNT(*) c FROM nexus_schema_migrations").get() as any).c;
    ok("§6 upgrade completed full migration chain", finalCount === files.length,
       `final=${finalCount} expected=${files.length}`);

    const marker = db2.prepare("SELECT value FROM nexus_records WHERE store='kv' AND key=?").get("p195_upgrade_marker") as any;
    ok("§6 pre-existing row survived upgrade",
       marker !== undefined && JSON.parse(marker.value).v === "preserved");

    const j146 = db2.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='release_deployment_intents'").get();
    ok("§6 required table present after upgrade", !!j146);

    engine2.close();
    clean(UPG);
  }

  // ============ §7 RESTART DURABILITY ============
  {
    const store = new ExecutionStore(db1b, undefined);
    const leases = new LeaseManager(store);
    const now = Date.now();

    store.createJob({
      id: "job_p195", idempotencyKey: "p195:k1", jobType: "EXECUTION", payload: {},
      status: "QUEUED", retryPolicy: { maxAttempts: 3, initialDelayMs: 1000, multiplier: 2, maxDelayMs: 60000 },
      timeoutMs: 60000, createdAt: now, updatedAt: now, lastAttemptAt: now, nextAttemptAt: null,
      currentLeaseId: null, cancellationRequested: 0, cancellationAcknowledged: 0,
    } as any);
    const lease = leases.acquireLease("job_p195", "worker-p195", 60_000);
    ok("§7 execution job + lease created before restart", !!lease.leaseId);

    engine1b.close();

    const engine1c = await SQLiteEngine.open(FRESH);
    const db1c = engine1c.getDatabase();
    const store3 = new ExecutionStore(db1c, undefined);
    const leases3 = new LeaseManager(store3);

    const j = store3.getJob("job_p195");
    ok("§7 execution job survives restart", j?.id === "job_p195");
    const l = leases3.getActiveLeaseForJob("job_p195");
    ok("§7 lease survives restart", l?.workerId === "worker-p195", "worker=" + l?.workerId);
    engine1c.close();
  }

  clean(FRESH);

  console.log(`\nPASS: ${pass}\nFAIL: ${fail}\nBLOCKED: ${blocked}`);
  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch((e) => { console.error("FATAL:", e); process.exitCode = 2; });
