// scripts/test-phase192-restart-safety.ts
//
// PHASE 192 — Restart safety for durable CI reconciliation state.
//
// Uses an ON-DISK SQLite file so state really persists across the
// close → reopen boundary that simulates a process restart.
//
// Covers:
//   §7  durable state survives restart; recovery is deterministic
//   §9  WAL + busy_timeout pragmas are set; schema is idempotent
//   §6  reconcileOnce short-circuits on REGISTERED across restart
//   §5  ownership: graceful release, restart reacquire, crash takeover

import Database from "better-sqlite3";
import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import path from "node:path";

import { CiReconciliationOwnershipService } from "../src/core/ci-reconciliation-ownership.service";
import { CicdReconciliationService } from "../src/core/cicd-reconciliation.service";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log("[PASSED] " + name + (detail ? "  " + detail : "")); }
  else      { fail++; console.log("[FAILED] " + name + (detail ? "  " + detail : "")); }
}

const MIG_DIR = join(process.cwd(), "src", "db", "migrations");
const M150 = readFileSync(join(MIG_DIR, "150_phase132_durable_ci_reconciliation.sql"), "utf8");
const M151 = readFileSync(join(MIG_DIR, "151_phase134_reconciliation_worker_ownership.sql"), "utf8");

const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";
const DIGEST     = "sha256:" + "a".repeat(64);
const RUN_ID     = "cirun_p192_restart";

const noopEvents = { emit: async () => undefined };
const noopAudit  = { record: async () => undefined };

function newFileDb(p: string): Database.Database {
  const db = new Database(p);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  const has = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='ci_artifact_reconciliations'"
  ).get();
  if (!has) {
    db.exec("CREATE TABLE IF NOT EXISTS nexus_records (store TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (store, key))");
    db.prepare("INSERT OR REPLACE INTO nexus_records (store, key, value) VALUES (?, ?, ?)")
      .run("executions", "exec_t01", JSON.stringify({ project_id: "proj_t01" }));
    db.exec(M150);
    db.exec(M151);
  }
  return db;
}

function fakeCiEngine(status: string) {
  return { pollRun: async (run: any) => ({ ...run, status }) } as any;
}
function fakeEngineStore(run: any) {
  return { get: async (c: string, _id: string) => (c === "ci_pipeline_runs" ? run : undefined) } as any;
}
function fakeArtifacts(): any {
  return { register: async () => ({ id: "art_unused" }) };
}
function baseRun(): any {
  return {
    id: RUN_ID, execution_id: "exec_t01", project_id: "proj_t01",
    provider: "github", repository: "acme/nexus-app", ref: "main",
    status: "RUNNING", attempt: 1,
    commit_sha: COMMIT_SHA, external_run_id: "gh_run_1001",
  };
}

function countBindings(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM ci_image_digest_bindings").get() as any).n;
}
function reconRow(db: Database.Database, runId: string): any {
  return db.prepare("SELECT * FROM ci_artifact_reconciliations WHERE run_id = ?").get(runId);
}
function ownerRow(db: Database.Database): any {
  return db.prepare("SELECT worker_id, state FROM ci_reconciliation_worker_ownership WHERE ownership_id = ?")
    .get("ci-reconciliation-scheduler");
}

async function main() {
  console.log("PHASE 192 — RESTART SAFETY (on-disk SQLite)\n");

  const DB_PATH = path.join(os.tmpdir(), `nexus-p192-${Date.now()}.sqlite`);
  if (existsSync(DB_PATH)) unlinkSync(DB_PATH);

  // ---------- Phase 1: register a binding, graceful release, close ----------
  {
    const db = newFileDb(DB_PATH);
    ok("§9 WAL mode set on open", db.pragma("journal_mode", { simple: true }) === "wal");
    ok("§9 busy_timeout = 5000", db.pragma("busy_timeout", { simple: true }) === 5000);

    const own = new CiReconciliationOwnershipService(db, "worker-A", noopEvents, noopAudit);
    const acq = await own.ensureOwned();
    ok("§5 A acquired ownership", acq.owned === true, "worker=" + acq.workerId);

    // Seed the reconciliation row via the service, then flip it to REGISTERED
    // and insert a matching binding — this is what a completed reconcile
    // leaves behind. Avoids re-testing the reconcile path (covered by 132/135).
    const svc = new CicdReconciliationService(
      db, fakeCiEngine("SUCCEEDED"), fakeEngineStore(baseRun()),
      { reconcile: async () => ({ state: "BLOCKED", reason: "unused" }) } as any,
      noopEvents, noopAudit, own,
    );
    svc.ensure({
      runId: RUN_ID, executionId: "exec_t01", projectId: "proj_t01",
      providerId: "github-actions", externalRunId: "gh_run_1001",
      repository: "acme/nexus-app", commitSha: COMMIT_SHA,
    });
    const now = Date.now();
    db.prepare(
      "UPDATE ci_artifact_reconciliations SET state = 'REGISTERED', " +
      "image_repository = ?, image_tag = ?, image_digest = ?, " +
      "immutable_reference = ?, registered_artifact_id = ?, updated_at = ? WHERE run_id = ?"
    ).run(
      "ghcr.io/acme/nexus-app", "sha-abc", DIGEST,
      "ghcr.io/acme/nexus-app@" + DIGEST, "art_test_001", now, RUN_ID,
    );
    db.prepare(
      "INSERT INTO ci_image_digest_bindings " +
      "(binding_id, execution_id, project_id, run_id, provider_id, external_run_id, " +
      " repository, commit_sha, image_repository, image_tag, image_digest, " +
      " immutable_reference, nexus_artifact_id, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "bind_p192_001", "exec_t01", "proj_t01", RUN_ID,
      "github-actions", "gh_run_1001", "acme/nexus-app", COMMIT_SHA,
      "ghcr.io/acme/nexus-app", "sha-abc", DIGEST,
      "ghcr.io/acme/nexus-app@" + DIGEST, "art_test_001", now,
    );

    ok("phase1: binding row present", countBindings(db) === 1);
    ok("phase1: run row is REGISTERED", reconRow(db, RUN_ID)?.state === "REGISTERED");

    await own.release();
    ok("phase1: ownership RELEASED before close",
       ownerRow(db)?.state === "RELEASED",
       "state=" + ownerRow(db)?.state);

    db.close();
  }

  // ---------- Phase 2: reopen same file, verify persistence, replay ----------
  {
    const db = newFileDb(DB_PATH);

    ok("§7 binding row survived restart", countBindings(db) === 1);
    ok("§7 run row still REGISTERED after restart",
       reconRow(db, RUN_ID)?.state === "REGISTERED",
       "state=" + reconRow(db, RUN_ID)?.state);
    ok("§7 image_digest survived restart", reconRow(db, RUN_ID)?.image_digest === DIGEST);
    ok("§7 ownership row is visible after restart", ownerRow(db) !== undefined);

    const own2 = new CiReconciliationOwnershipService(db, "worker-B", noopEvents, noopAudit);
    const acq2 = await own2.ensureOwned();
    ok("§5 B acquires after A's graceful release",
       acq2.owned === true, "worker=" + acq2.workerId);

    const svc2 = new CicdReconciliationService(
      db, fakeCiEngine("SUCCEEDED"), fakeEngineStore(baseRun()),
      { reconcile: async () => { throw new Error("must not be called"); } } as any,
      noopEvents, noopAudit, own2,
    );
    const replay = await svc2.reconcileOnce(RUN_ID);
    ok("§6 replay short-circuits on REGISTERED (no re-reconcile)",
       replay.state === "REGISTERED", "state=" + replay.state);
    ok("§6 no duplicate binding after replay", countBindings(db) === 1);

    // Simulate crash: do NOT release. Just close.
    db.close();
  }

  // ---------- Phase 3: crash takeover ----------
  {
    const db = newFileDb(DB_PATH);

    ok("§7 B's ownership row still ACTIVE (crash-sim)",
       ownerRow(db)?.state === "ACTIVE",
       "state=" + ownerRow(db)?.state);

    const own3 = new CiReconciliationOwnershipService(db, "worker-C", noopEvents, noopAudit);
    const blocked = await own3.ensureOwned();
    ok("§8 C blocked while B's lease is live",
       blocked.owned === false, "reason=" + blocked.reason);

    // Force B's lease to expire (simulates TTL elapsing)
    db.prepare("UPDATE ci_reconciliation_worker_ownership SET expires_at = 0 WHERE ownership_id = ?")
      .run("ci-reconciliation-scheduler");

    const acq3 = await own3.ensureOwned();
    ok("§5 C takes over after B's lease expires",
       acq3.owned === true, "worker=" + acq3.workerId);

    const final = ownerRow(db);
    ok("§8 durable row now names C",
       final?.state === "ACTIVE" && final?.worker_id === "worker-C",
       "holder=" + final?.worker_id);

    db.close();
  }

  try { unlinkSync(DB_PATH); } catch {}
  try { unlinkSync(DB_PATH + "-wal"); } catch {}
  try { unlinkSync(DB_PATH + "-shm"); } catch {}

  console.log(`\nPASS: ${pass}\nFAIL: ${fail}`);
  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch((e) => { console.error("FATAL:", e); process.exit(2); });
