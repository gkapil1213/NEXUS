// scripts/_phase182_child.ts
// Phase 182 child worker. Dispatches one command against a shared SQLite
// database and prints one JSON line to stdout. Used by the Phase 182 harness
// to exercise real multi-process coordination on a shared file.

import Database from "better-sqlite3";
import { join } from "path";
import { MigrationRunner } from "../src/core/migration-runner";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { ReleaseDeploymentIntentService } from "../src/core/release-deployment-intent";
import { IdempotencyStore } from "../src/server/idempotency";

const MIGRATIONS_DIR = join(process.cwd(), "src", "db", "migrations");

function ensureBaseTables(raw: Database.Database): void {
  new MigrationRunner(raw, MIGRATIONS_DIR).run();
  raw.exec("CREATE TABLE IF NOT EXISTS nexus_records (store TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (store, key));");
}

async function main(): Promise<void> {
  const [, , cmd, dbPath, ...args] = process.argv;
  if (!cmd || !dbPath) { console.error("usage: <command> <dbPath> [args...]"); process.exit(2); }

  const raw = new Database(dbPath);
  // Phase 181 unified: fromDatabase applies WAL + busy_timeout + foreign_keys.
  SQLiteEngine.fromDatabase(raw);
  ensureBaseTables(raw);

  const store = new ExecutionStore(raw);
  const intents = new ReleaseDeploymentIntentService(store);

  try {
    switch (cmd) {
      case "open": {
        const count = (raw.prepare("SELECT COUNT(*) c FROM nexus_schema_migrations").get() as { c: number }).c;
        console.log(JSON.stringify({ ok: true, migrations: count, pid: process.pid }));
        break;
      }
      case "acquire": {
        const [intentKey, workerId] = args;
        const r = intents.acquireLease(intentKey, workerId, 60_000);
        console.log(JSON.stringify(r));
        break;
      }
      case "transition": {
        const [intentKey, workerId, toStatus] = args;
        const r = intents.transitionIfOwned(intentKey, toStatus as any, workerId, {});
        console.log(JSON.stringify({ updated: r.updated, status: r.intent?.status ?? null }));
        break;
      }
      case "hold-lease": {
        const [intentKey, workerId, holdMsStr] = args;
        const holdMs = Number(holdMsStr) || 5000;
        const r = intents.acquireLease(intentKey, workerId, holdMs + 60_000);
        console.log(JSON.stringify({ acquired: r.acquired, holder: r.holder, expiresAt: r.expiresAt, pid: process.pid }));
        // Hold until killed or timeout elapses.
        await new Promise((resolve) => setTimeout(resolve, holdMs));
        break;
      }
      case "attempt-many-acquisitions": {
        // High-contention: N attempts from a single process with distinct worker ids.
        const [intentKey, prefix, countStr] = args;
        const count = Number(countStr) || 10;
        let wins = 0;
        const winners: string[] = [];
        for (let i = 0; i < count; i++) {
          const wid = prefix + "-" + i;
          const r = intents.acquireLease(intentKey, wid, 60_000);
          if (r.acquired) { wins++; winners.push(wid); }
        }
        console.log(JSON.stringify({ attempts: count, wins, winners }));
        break;
      }
      case "run-migrations": {
        const runner = new MigrationRunner(raw, MIGRATIONS_DIR);
        runner.run();
        const count = (raw.prepare("SELECT COUNT(*) c FROM nexus_schema_migrations").get() as { c: number }).c;
        console.log(JSON.stringify({ ok: true, migrations: count, pid: process.pid }));
        break;
      }
      case "idempotency-attempt": {
        const [key, principalId] = args;
        const idem = new IdempotencyStore(raw);
        const existing = idem.lookup(key);
        if (existing) {
          console.log(JSON.stringify({ attempted: true, stored: false, existing: true, pid: process.pid }));
        } else {
          idem.store({
            idempotencyKey: key,
            principalId,
            method: "POST",
            path: "/test",
            requestHash: "hash-" + key,
            responseStatus: 200,
            responseBody: JSON.stringify({ result: "ok-from-" + principalId }),
            createdAt: Date.now(),
          });
          const after = idem.lookup(key);
          console.log(JSON.stringify({ attempted: true, stored: true, existing: false, storedBy: after?.principalId ?? null, pid: process.pid }));
        }
        break;
      }
      default:
        console.error("unknown command: " + cmd);
        process.exit(2);
    }
  } finally {
    try { raw.close(); } catch { /* ignore */ }
  }
}

main().catch((e) => {
  console.error(e && e.message ? e.message : String(e));
  process.exit(1);
});