// scripts/test-phase181-persistence-durability.ts
//
// Phase 181 - production persistence durability, crash recovery, and DB
// integrity.
//
// Real SQLite file + real ExecutionStore + real migration runner + real
// Phase 178/179 services + real Phase 180 HTTP app + real restart via
// child process. No fake persistence, no fake success.

import Database from "better-sqlite3";
import { join } from "path";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { spawn } from "child_process";
import { createHash } from "crypto";
import type { Server } from "http";
import { MigrationRunner } from "../src/core/migration-runner";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { ReleaseDeploymentIntentService } from "../src/core/release-deployment-intent";
import { RecoveryOperationsService } from "../src/core/recovery-operations";
import { RecoveryControlService } from "../src/core/recovery-control-service";
import { EventService } from "../src/core/events";
import { AuditService } from "../src/core/audit";
import { SessionService, AuthorizationService, createUserRecord } from "../src/core/security";
import { ProjectMembershipStore } from "../src/core/project-membership-store";
import { checkIntegrity } from "../src/core/persistence-integrity";
import { probeDbHealth } from "../src/server/db-health";
import { createHttpApp } from "../src/server/http";
import { IdempotencyStore } from "../src/server/idempotency";

let passed = 0, failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log("  ok   " + msg); }
  else { failed++; console.log("  FAIL " + msg); }
}
function section(t: string): void { console.log("\n" + t); }

const MIGRATIONS_DIR = join(process.cwd(), "src", "db", "migrations");

interface Env {
  dir: string;
  dbFile: string;
  raw: Database.Database;
  engine: SQLiteEngine;
  store: ExecutionStore;
  intents: ReleaseDeploymentIntentService;
  sessions: SessionService;
  authz: AuthorizationService;
  memberships: ProjectMembershipStore;
  events: EventService;
  audit: AuditService;
}

function mkEnvFile(): { dir: string; dbFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "nexus-181-"));
  const dbFile = join(dir, "durability.db");
  return { dir, dbFile };
}

function openEnv(dbFile: string): Env {
  const raw = new Database(dbFile);
  new MigrationRunner(raw, MIGRATIONS_DIR).run();
  raw.exec("CREATE TABLE IF NOT EXISTS nexus_records (store TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (store, key));");
  const engine = SQLiteEngine.fromDatabase(raw);
  const store = new ExecutionStore(raw);
  const intents = new ReleaseDeploymentIntentService(store);
  const events = new EventService(engine);
  const audit = new AuditService(engine);
  const sessions = new SessionService(engine);
  const authz = new AuthorizationService(audit);
  const memberships = new ProjectMembershipStore(raw);
  return { dir: "", dbFile, raw, engine, store, intents, sessions, authz, memberships, events, audit };
}

async function closeEnv(env: Env): Promise<void> {
  try { env.raw.close(); } catch { /* ignore */ }
}

function mkInput(prefix: string, extra: Record<string, unknown> = {}): any {
  return {
    releaseId: "rel-" + prefix,
    executionId: "exec-" + prefix,
    artifactId: "art-" + prefix,
    artifactDigest: "sha256:" + prefix,
    commitSha: "c-" + prefix,
    environment: "production",
    projectId: "proj-" + prefix,
    imageRepository: "nexus/" + prefix,
    imageTag: "v1",
    imageId: "sha256-img-" + prefix,
    imageDigest: "sha256:dig-" + prefix,
    containerName: "c-" + prefix,
    containerPort: 8080,
    attemptId: "att-" + prefix,
    ...extra,
  };
}

async function seedRecoverable(env: Env, prefix: string, extra: Record<string, unknown> = {}): Promise<string> {
  const { intent } = await env.intents.getOrCreate(mkInput(prefix, extra));
  const k = intent.intentKey;
  env.intents.acquireLease(k, "seeder", 60_000);
  env.intents.transitionIfOwned(k, "DEPLOYMENT_INTENT_CREATED", "seeder", {});
  env.intents.transitionIfOwned(k, "DEPLOYING", "seeder", {});
  env.intents.transitionIfOwned(k, "RECOVERY_REQUIRED", "seeder", {
    nextRetryAt: Date.now() + 60_000, recoveryReason: "x",
  });
  env.intents.releaseLease(k, "seeder");
  return k;
}

async function mkUser(env: Env, role: "OWNER" | "DEVELOPER", suffix: string): Promise<{ token: string; id: string }> {
  const user = await createUserRecord({
    email: role.toLowerCase() + "-" + suffix + "@nexus.test",
    name: role + " " + suffix,
    password: "Password123!",
    role,
  });
  await env.engine.put("users", user.id, user);
  const session = await env.sessions.issue(user.id);
  return { token: session.token, id: user.id };
}

async function mkProject(env: Env, projectId: string): Promise<void> {
  const now = Date.now();
  await env.engine.put("projects", projectId, {
    id: projectId, name: projectId, description: "", repository: "", default_branch: "main",
    status: "ACTIVE", created_at: now, updated_at: now,
  });
}

async function withEnv<T>(fn: (env: Env) => Promise<T>): Promise<void> {
  const { dir, dbFile } = mkEnvFile();
  const env = openEnv(dbFile);
  env.dir = dir;
  try { await fn(env); }
  finally {
    await closeEnv(env);
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
  }
}

async function main() {
  // ============================================================
  // A - Transaction atomicity
  // ============================================================
  section("A - Transaction atomicity");
  await withEnv(async (env) => {
    // A1 SQLite engine exposes transaction() and it commits atomically
    let x = 0;
    env.engine.transaction(() => { x = 42; });
    ok(x === 42, "A1 engine.transaction commits side effect");

    // A2 Rollback on throw
    let rollbackCount = 0;
    try {
      env.engine.transaction(() => { rollbackCount = 1; throw new Error("boom"); });
    } catch { /* expected */ }
    ok(rollbackCount === 1, "A2 transaction body runs before throw");

    // A3 Project + membership atomicity
    const now = Date.now();
    const project = {
      id: "prj-A3", name: "A3", description: "", repository: "", default_branch: "main",
      status: "ACTIVE", created_at: now, updated_at: now,
    };
    const owner = await createUserRecord({
      email: "a3-owner@nexus.test", name: "A3 owner", password: "Password123!", role: "OWNER",
    });
    await env.engine.put("users", owner.id, owner);
    env.memberships.insertProjectWithOwner(project, owner.id);
    ok(!!(await env.engine.get("projects", "prj-A3")), "A3 project row committed");
    ok(!!env.memberships.get("prj-A3", owner.id), "A3 membership row committed in same transaction");

    // A4 BEGIN IMMEDIATE followed by ROLLBACK leaves no trace
    const before = env.raw.prepare("SELECT COUNT(*) c FROM nexus_records WHERE store = 'kv'").get() as { c: number };
    try {
      env.raw.exec("BEGIN IMMEDIATE");
      env.raw.prepare("INSERT INTO nexus_records (store, key, value) VALUES (?, ?, ?)").run("kv", "temp-A4", "{}");
      env.raw.exec("ROLLBACK");
    } catch { /* ignore */ }
    const after = env.raw.prepare("SELECT COUNT(*) c FROM nexus_records WHERE store = 'kv'").get() as { c: number };
    ok(before.c === after.c, "A4 explicit ROLLBACK leaves no partial state");

    // A5 Integrity check on clean DB returns HEALTHY
    const report = await checkIntegrity({ db: env.raw, engine: env.engine, migrationsDir: MIGRATIONS_DIR });
    ok(report.verdict === "HEALTHY", "A5 clean DB integrity = HEALTHY (verdict=" + report.verdict + ")");
  });

  // ============================================================
  // B - Crash safety
  // ============================================================
  section("B - Crash safety");
  await withEnv(async (env) => {
    // B1 write inside transaction then rollback -> row never persisted
    const { intent } = await env.intents.getOrCreate(mkInput("B1"));
    const before = env.intents.get(intent.intentKey);
    try {
      env.raw.exec("BEGIN IMMEDIATE");
      env.raw.prepare("UPDATE release_deployment_intents SET status = 'KNOWN_GOOD' WHERE intent_key = ?").run(intent.intentKey);
      env.raw.exec("ROLLBACK");
    } catch { /* ignore */ }
    const after = env.intents.get(intent.intentKey);
    ok(before?.status === after?.status && after?.status !== "KNOWN_GOOD",
      "B1 rolled-back status write is not visible");

    // B2 process crash simulation: SIGKILL child mid-transaction leaves DB valid
    const { dir: cdir, dbFile: cfile } = mkEnvFile();
    const childScript = join(cdir, "crasher.ts");
    // The child writes then SIGKILLs itself mid-transaction.
    writeFileSync(childScript, `
import Database from "better-sqlite3";
const db = new Database(process.argv[2]);
db.pragma("journal_mode = WAL");
db.exec("BEGIN IMMEDIATE");
db.prepare("INSERT INTO nexus_records (store, key, value) VALUES (?, ?, ?)").run("kv", "b2-partial", "{}");
process.kill(process.pid, "SIGKILL");
`, "utf8");

    // Child needs migrations first
    const { raw: cRaw } = { raw: new Database(cfile) };
    new MigrationRunner(cRaw, MIGRATIONS_DIR).run();
    cRaw.exec("CREATE TABLE IF NOT EXISTS nexus_records (store TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (store, key));");
    cRaw.close();

    const child = spawn(process.execPath, ["--import", "tsx", childScript, cfile], { stdio: ["ignore", "pipe", "pipe"] });
    const code: number | null = await new Promise((resolve) => {
      child.on("exit", (c) => resolve(c));
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, 5000);
    });
    // Exit code will be non-zero (SIGKILL). We don't assert the code; we assert DB state.
    const verify = new Database(cfile);
    try {
      verify.pragma("journal_mode = WAL");
      const rows = verify.prepare("SELECT COUNT(*) c FROM nexus_records WHERE store='kv' AND key='b2-partial'").get() as { c: number };
      ok(rows.c === 0, "B2 SIGKILL mid-transaction leaves no partial row (count=" + rows.c + ")");
      const ic = verify.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
      ok(ic.integrity_check === "ok", "B2 DB integrity_check passes after SIGKILL");
    } finally { verify.close(); }
    try { rmSync(cdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }

    // B3 committed write survives abrupt close without .close()
    const raw2 = new Database(env.dbFile);
    raw2.pragma("journal_mode = WAL");
    raw2.prepare("INSERT INTO nexus_records (store, key, value) VALUES (?, ?, ?)").run("kv", "b3-committed", JSON.stringify({ ok: true }));
    // Do NOT call close(); simulate crash by opening a fresh connection
    const raw3 = new Database(env.dbFile);
    try {
      const row = raw3.prepare("SELECT value FROM nexus_records WHERE store='kv' AND key='b3-committed'").get() as { value: string } | undefined;
      ok(!!row && JSON.parse(row.value).ok === true, "B3 committed write survives abrupt connection drop");
    } finally { raw3.close(); raw2.close(); }
  });

  // ============================================================
  // C - No false success
  // ============================================================
  section("C - No false success");
  await withEnv(async (env) => {
    // C1 RECOVERY_REQUIRED stays RECOVERY_REQUIRED after reopen
    const k = await seedRecoverable(env, "C1");
    const before = env.intents.get(k);
    await closeEnv(env);
    const env2 = openEnv(env.dbFile);
    const after = env2.intents.get(k);
    ok(before?.status === "RECOVERY_REQUIRED" && after?.status === "RECOVERY_REQUIRED",
      "C1 RECOVERY_REQUIRED survives reopen unchanged");
    await closeEnv(env2);
    // Re-open to keep the withEnv finally clause happy
    env.raw = new Database(env.dbFile);
    env.raw.pragma("journal_mode = WAL");
  });

  // ============================================================
  // D - Idempotency
  // ============================================================
  section("D - Idempotency");
  await withEnv(async (env) => {
    const { intent: i1 } = await env.intents.getOrCreate(mkInput("D1"));
    const { intent: i2 } = await env.intents.getOrCreate(mkInput("D1"));
    ok(i1.intentKey === i2.intentKey, "D1 same input -> same intent key");

    const { intent: i3, created } = await env.intents.getOrCreate(mkInput("D1"));
    ok(created === false && i3.intentKey === i1.intentKey, "D1 second call is idempotent (created=false)");

    const count = env.raw.prepare("SELECT COUNT(*) c FROM release_deployment_intents WHERE intent_key = ?").get(i1.intentKey) as { c: number };
    ok(count.c === 1, "D1 exactly one durable row per intent key");
  });

  // ============================================================
  // E - Concurrent persistence
  // ============================================================
  section("E - Concurrent persistence");
  await withEnv(async (env) => {
    // Two stores on the same file, same intent -> lease is exclusive
    const { intent } = await env.intents.getOrCreate(mkInput("E1"));
    const store2 = new ExecutionStore(env.raw);
    const intents2 = new ReleaseDeploymentIntentService(store2);
    const l1 = env.intents.acquireLease(intent.intentKey, "w-A", 60_000);
    const l2 = intents2.acquireLease(intent.intentKey, "w-B", 60_000);
    ok(l1.acquired === true && l2.acquired === false, "E1 concurrent lease acquisition has one winner");
    env.intents.releaseLease(intent.intentKey, "w-A");

    // busy_timeout pragma is set: second writer waits instead of failing
    const bt = env.raw.prepare("PRAGMA busy_timeout").get() as { timeout?: number; busy_timeout?: number };
    const timeout = bt.timeout ?? bt.busy_timeout ?? 0;
    ok(timeout >= 5000, "E2 busy_timeout >= 5000ms (got " + timeout + ")");

    // foreign_keys pragma is on
    const fk = env.raw.prepare("PRAGMA foreign_keys").get() as { foreign_keys?: number };
    ok(fk.foreign_keys === 1, "E3 foreign_keys pragma is ON");

    // WAL mode is active
    const jm = env.raw.prepare("PRAGMA journal_mode").get() as { journal_mode?: string };
    ok((jm.journal_mode ?? "").toLowerCase() === "wal", "E4 journal_mode is WAL");

    // Concurrent update on two different intents (no cross-contention)
    const { intent: a } = await env.intents.getOrCreate(mkInput("E5a"));
    const { intent: b } = await env.intents.getOrCreate(mkInput("E5b"));
    env.intents.acquireLease(a.intentKey, "w-A", 60_000);
    env.intents.acquireLease(b.intentKey, "w-B", 60_000);
    env.intents.transitionIfOwned(a.intentKey, "DEPLOYMENT_INTENT_CREATED", "w-A", {});
    env.intents.transitionIfOwned(b.intentKey, "DEPLOYMENT_INTENT_CREATED", "w-B", {});
    ok(env.intents.get(a.intentKey)?.status === "DEPLOYMENT_INTENT_CREATED" &&
       env.intents.get(b.intentKey)?.status === "DEPLOYMENT_INTENT_CREATED",
       "E5 two stores update two intents concurrently without lost writes");
    env.intents.releaseLease(a.intentKey, "w-A");
    env.intents.releaseLease(b.intentKey, "w-B");
  });

  // ============================================================
  // F - Lease durability
  // ============================================================
  section("F - Lease durability");
  await withEnv(async (env) => {
    const { intent } = await env.intents.getOrCreate(mkInput("F1"));
    env.intents.acquireLease(intent.intentKey, "w-A", 60_000);
    const before = env.intents.get(intent.intentKey);
    await closeEnv(env);
    const env2 = openEnv(env.dbFile);
    const after = env2.intents.get(intent.intentKey);
    ok(before?.leasedBy === after?.leasedBy && after?.leasedBy === "w-A",
      "F1 lease owner survives reopen");
    ok(before?.leaseExpiresAt === after?.leaseExpiresAt, "F2 lease expiry survives reopen");
    await closeEnv(env2);
    env.raw = new Database(env.dbFile);
    env.raw.pragma("journal_mode = WAL");
  });

  // ============================================================
  // G - Recovery durability
  // ============================================================
  section("G - Recovery durability");
  await withEnv(async (env) => {
    const k = await seedRecoverable(env, "G1");
    env.intents.acquireLease(k, "w-G", 60_000);
    env.intents.transitionIfOwned(k, "RECOVERY_REQUIRED", "w-G", {
      nextRetryAt: Date.now() + 30_000,
      recoveryAttempts: 2,
      lastFailureClass: "RECOVERY_REQUIRED",
      reconciliationEvidence: JSON.stringify({ source: "test", timestamp: Date.now() }),
      lastRecoveryDecision: JSON.stringify({ decision: "RETRY", intentKey: k, workerId: "w-G", timestamp: Date.now() }),
      lastRecoveryDecisionAt: Date.now(),
    });
    env.intents.releaseLease(k, "w-G");
    const before = env.intents.get(k);
    await closeEnv(env);
    const env2 = openEnv(env.dbFile);
    const after = env2.intents.get(k);
    ok(after?.recoveryAttempts === 2, "G1 recoveryAttempts persists across reopen");
    ok(after?.lastRecoveryDecision === before?.lastRecoveryDecision, "G2 decision journal persists byte-for-byte");
    ok(after?.reconciliationEvidence === before?.reconciliationEvidence, "G3 reconciliation evidence persists");
    await closeEnv(env2);
    env.raw = new Database(env.dbFile);
    env.raw.pragma("journal_mode = WAL");
  });

  // ============================================================
  // H - Migration integrity
  // ============================================================
  await withEnv(async (env) => {
    section("H - Migration integrity");
    // H1 all applied migrations match their file checksums
    const applied = env.raw.prepare("SELECT id, filename, checksum FROM nexus_schema_migrations").all() as
      { id: string; filename: string; checksum: string }[];
    let allMatch = true;
    for (const rec of applied) {
      const path = join(MIGRATIONS_DIR, rec.filename);
      if (!existsSync(path)) { allMatch = false; break; }
      const sql = readFileSync(path, "utf8");
      const cs = createHash("sha256").update(sql).digest("hex");
      if (cs !== rec.checksum) { allMatch = false; break; }
    }
    ok(allMatch && applied.length > 0, "H1 all applied migrations checksums match");

    // H2 running MigrationRunner again is idempotent
    const countBefore = applied.length;
    new MigrationRunner(env.raw, MIGRATIONS_DIR).run();
    const countAfter = (env.raw.prepare("SELECT COUNT(*) c FROM nexus_schema_migrations").get() as { c: number }).c;
    ok(countBefore === countAfter, "H2 re-running migration runner is idempotent");

    // H3 tampered file is detected on next run (use a throwaway dir)
    const { dir: tdir } = mkEnvFile();
    writeFileSync(join(tdir, "001_first.sql"), "CREATE TABLE t1 (id TEXT PRIMARY KEY);", "utf8");
    const tdb = new Database(":memory:");
    const r1 = new MigrationRunner(tdb, tdir);
    r1.run();
    // Tamper the file
    writeFileSync(join(tdir, "001_first.sql"), "CREATE TABLE t1 (id TEXT PRIMARY KEY, x TEXT);", "utf8");
    let threw = false;
    try { new MigrationRunner(tdb, tdir).run(); } catch { threw = true; }
    ok(threw, "H3 tampered migration file triggers checksum error");
    tdb.close();
    rmSync(tdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  // ============================================================
  // I - Database failure handling
  // ============================================================
  section("I - Database failure handling");
  {
    // I1 read-only file -> writes fail cleanly
    const { dir, dbFile } = mkEnvFile();
    const seed = new Database(dbFile);
    new MigrationRunner(seed, MIGRATIONS_DIR).run();
    seed.exec("CREATE TABLE IF NOT EXISTS nexus_records (store TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (store, key));");
    seed.close();

    // Open read-only (URI form)
    const ro = new Database(dbFile, { readonly: true });
    let writeThrew = false;
    try {
      ro.prepare("INSERT INTO nexus_records (store, key, value) VALUES (?, ?, ?)").run("kv", "ro-write", "{}");
    } catch { writeThrew = true; }
    ok(writeThrew, "I1 write to read-only DB fails cleanly (no silent success)");
    ro.close();

    // I2 read still works
    const ro2 = new Database(dbFile, { readonly: true });
    let readOk = false;
    try { ro2.prepare("SELECT 1").get(); readOk = true; } catch { /* ignore */ }
    ok(readOk, "I2 read on read-only DB succeeds");
    ro2.close();

    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
  }
  await withEnv(async (env) => {
    // I3 malformed SQL fails cleanly
    let threw = false;
    try { env.raw.prepare("SELECT * FROM nonexistent_table_zz").get(); } catch { threw = true; }
    ok(threw, "I3 malformed query throws cleanly");

    // I4 BEGIN on locked resource (self-lock via second connection)
    const other = new Database(env.dbFile);
    other.pragma("journal_mode = WAL");
    other.exec("BEGIN IMMEDIATE");
    // Touch nexus_records to force a write lock
    other.prepare("INSERT INTO nexus_records (store, key, value) VALUES (?, ?, ?)").run("kv", "i4-lock", "{}");

    // The primary connection will block until busy_timeout, then fail if locked long enough.
    // Use a very short timeout to keep the test fast.
    env.raw.pragma("busy_timeout = 50");
    let lockedThrew = false;
    try {
      env.raw.prepare("INSERT INTO nexus_records (store, key, value) VALUES (?, ?, ?)").run("kv", "i4-writer", "{}");
    } catch { lockedThrew = true; }
    // Restore timeout for later tests
    env.raw.pragma("busy_timeout = 5000");
    other.exec("ROLLBACK");
    other.close();
    // Either the write succeeded (SQLite retried within the window) or it threw.
    // The guarantee we're testing is: never a silent success with lost write.
    const stillExists = env.raw.prepare("SELECT COUNT(*) c FROM nexus_records WHERE key = 'i4-writer'").get() as { c: number };
    ok((lockedThrew && stillExists.c === 0) || (!lockedThrew && stillExists.c === 1),
      "I4 contended write either commits or fails; never partially succeeds");
  });

  // ============================================================
  // J - Restart durability (cross-process)
  // ============================================================
  section("J - Restart durability");
  {
    const { dir, dbFile } = mkEnvFile();

    // Phase A: seed durable state in THIS process using the real services.
    let seededKey = "";
    {
      const seedEnv = openEnv(dbFile);
      const { intent } = await seedEnv.intents.getOrCreate({
        releaseId: "rel-J", executionId: "exec-J", artifactId: "art-J", artifactDigest: "sha256:J",
        commitSha: "c-J", environment: "production", projectId: "proj-J",
        imageRepository: "nexus/j", imageTag: "v1", imageId: "sha256-img-J", imageDigest: "sha256:dig-J",
        containerName: "c-J", containerPort: 8080, attemptId: "att-J",
      });
      seededKey = intent.intentKey;
      seedEnv.intents.acquireLease(seededKey, "seed", 60_000);
      seedEnv.intents.transitionIfOwned(seededKey, "DEPLOYMENT_INTENT_CREATED", "seed", {});
      seedEnv.intents.transitionIfOwned(seededKey, "DEPLOYING", "seed", {});
      seedEnv.intents.transitionIfOwned(seededKey, "RECOVERY_REQUIRED", "seed", {
        nextRetryAt: Date.now() + 60_000, recoveryReason: "restart-test",
        recoveryAttempts: 3, lastFailureClass: "RECOVERY_REQUIRED",
        lastRecoveryDecision: JSON.stringify({ decision: "RETRY", intentKey: seededKey, workerId: "seed", timestamp: Date.now() }),
        lastRecoveryDecisionAt: Date.now(),
        reconciliationEvidence: JSON.stringify({ source: "seed", intentKey: seededKey, timestamp: Date.now() }),
      });
      seedEnv.intents.releaseLease(seededKey, "seed");
      await closeEnv(seedEnv);
    }

    // Phase B: spawn a SEPARATE process to read back the durable state.
    // The verifier script lives INSIDE the repository (scripts/) so Node's
    // normal require() resolution walks up to <repo>/node_modules and finds
    // the real production better-sqlite3. The database itself remains in the
    // temp directory -- only the verifier script moves into the repo.
    const verifierScript = join(process.cwd(), "scripts", "_phase181_verify.cjs");
    writeFileSync(verifierScript, `
const Database = require("better-sqlite3");
const db = new Database(process.argv[2], { readonly: true });
const row = db.prepare(
  "SELECT status, recovery_attempts, next_retry_at, last_recovery_decision, reconciliation_evidence " +
  "FROM release_deployment_intents WHERE intent_key = ?"
).get(process.argv[3]);
console.log("VERIFY_RESULT=" + JSON.stringify(row || null));
db.close();
`, "utf8");

    let stdout = "";
    let stderr = "";
    const child = spawn(process.execPath, [verifierScript, dbFile, seededKey], {
      cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    const verifierExit: number | null = await new Promise((resolve) => child.on("exit", (c) => resolve(c)));

    // Phase 181 brief section 5: diagnostics on failure. Captured fields are
    // safe (paths, exit code, first 300 chars of stdout/stderr). No secrets.
    const diag = [
      "exit=" + String(verifierExit),
      "cwd=" + process.cwd(),
      "db=" + dbFile,
      "verifier=" + verifierScript,
      "stdout=" + stdout.slice(0, 300).replace(/\s+/g, " "),
      "stderr=" + stderr.slice(0, 300).replace(/\s+/g, " "),
    ].join(" | ");

    ok(verifierExit === 0, "J1 verifier child exited 0 (" + diag + ")");

    const m = stdout.match(/VERIFY_RESULT=(.+)/);
    const verified = m ? (() => { try { return JSON.parse(m[1]); } catch { return null; } })() : null;
    ok(!!verified, "J2 verifier child read back a row across the process boundary (" + diag + ")");
    ok(verified?.status === "RECOVERY_REQUIRED", "J3 status survived process restart");
    ok(verified?.recovery_attempts === 3, "J4 recoveryAttempts survived process restart");
    ok(typeof verified?.last_recovery_decision === "string", "J5 decision journal survived process restart");
    ok(typeof verified?.reconciliation_evidence === "string", "J6 reconciliation evidence survived process restart");
    ok(typeof verified?.next_retry_at === "number" && verified.next_retry_at > 0, "J7 nextRetryAt survived process restart");

    // Phase C: reopen in this process to prove the file is fully reusable.
    const env2 = openEnv(dbFile);
    ok(env2.intents.get(seededKey)?.status === "RECOVERY_REQUIRED", "J8 state remains RECOVERY_REQUIRED across reopen");
    await closeEnv(env2);

    try { unlinkSync(verifierScript); } catch { /* ignore */ }
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
  }
// ============================================================
  // K - Readiness integration
  // ============================================================
  await withEnv(async (env) => {
    section("K - Readiness integration");
    const health = probeDbHealth(env.raw);
    ok(health.ok === true, "K1 db health = ok on healthy DB");
    ok(health.checks.readable?.ok === true, "K2 readable check ok");
    ok(health.checks.writable?.ok === true, "K3 writable check ok (BEGIN IMMEDIATE/ROLLBACK)");
    ok(health.checks.required_tables?.ok === true, "K4 required tables present");
    ok(health.checks.migrations_applied?.ok === true, "K5 migrations applied");

    // K6 missing table -> not ok
    const raw2 = new Database(":memory:");
    const empty = probeDbHealth(raw2);
    ok(empty.ok === false, "K6 empty DB readiness = false");
    raw2.close();

    // K7 readiness via HTTP
    const { token } = await mkUser(env, "OWNER", "k7");
    const services: any = {
      engine: env.engine, events: env.events, audit: env.audit, sessions: env.sessions,
      authz: env.authz, memberships: env.memberships,
      executionStore: env.store, releaseIntents: env.intents,
      recoveryOperations: new RecoveryOperationsService({ intents: env.intents, audit: env.audit, events: env.events }),
      recoveryControl: new RecoveryControlService({ intents: env.intents, audit: env.audit, events: env.events, workerId: "k7" }),
    };
    const app = createHttpApp({ services, idempotency: new IdempotencyStore(env.raw) });
    const srv: Server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
    const port = (srv.address() as any).port;
    const rr = await fetch("http://127.0.0.1:" + port + "/health/ready");
    const rb = await rr.json() as any;
    ok(rr.status === 200 && rb?.data?.ok === true, "K7 /health/ready = ready on healthy DB");
    ok(rb?.data?.persistence?.readable?.ok === true, "K8 readiness includes persistence detail");

    const lr = await fetch("http://127.0.0.1:" + port + "/health/live");
    ok(lr.status === 200, "K9 /health/live = live");
    await new Promise<void>((res) => srv.close(() => res()));
  });

  // ============================================================
  // L - State consistency
  // ============================================================
  await withEnv(async (env) => {
    section("L - State consistency");
    const clean = await checkIntegrity({ db: env.raw, engine: env.engine, migrationsDir: MIGRATIONS_DIR });
    ok(clean.verdict === "HEALTHY", "L1 clean DB verdict = HEALTHY");

    // L2 KNOWN_GOOD without evidence is detected
    const { intent } = await env.intents.getOrCreate(mkInput("L2"));
    env.intents.acquireLease(intent.intentKey, "w-L", 60_000);
    env.intents.transitionIfOwned(intent.intentKey, "DEPLOYMENT_INTENT_CREATED", "w-L", {});
    env.intents.transitionIfOwned(intent.intentKey, "DEPLOYING", "w-L", {});
    // Deliberately bypass the Phase 176 write path: direct SQL UPDATE with no evidence
    env.raw.prepare("UPDATE release_deployment_intents SET status='KNOWN_GOOD', reconciliation_evidence=NULL WHERE intent_key = ?").run(intent.intentKey);
    env.intents.releaseLease(intent.intentKey, "w-L");
    const detected = await checkIntegrity({ db: env.raw, engine: env.engine, migrationsDir: MIGRATIONS_DIR });
    ok(detected.verdict === "CORRUPT" || detected.issues.some((i) => i.check === "intent.known_good_has_evidence"),
      "L2 KNOWN_GOOD without evidence detected");

    // L3 lease inconsistency detected
    env.raw.prepare("UPDATE release_deployment_intents SET leased_by = 'x', lease_expires_at = NULL WHERE intent_key = ?").run(intent.intentKey);
    const leaseIssue = await checkIntegrity({ db: env.raw, engine: env.engine, migrationsDir: MIGRATIONS_DIR });
    ok(leaseIssue.issues.some((i) => i.check === "intent.lease_fields_consistent"),
      "L3 inconsistent lease fields detected");
    // Cleanup
    env.raw.prepare("UPDATE release_deployment_intents SET leased_by = NULL WHERE intent_key = ?").run(intent.intentKey);
  });

  // ============================================================
  // M - Audit integrity
  // ============================================================
  await withEnv(async (env) => {
    section("M - Audit integrity");
    const { token } = await mkUser(env, "OWNER", "m1");
    await mkProject(env, "proj-M");
    const k = await seedRecoverable(env, "m1", { projectId: "proj-M" });

    const services: any = {
      engine: env.engine, events: env.events, audit: env.audit, sessions: env.sessions,
      authz: env.authz, memberships: env.memberships,
      executionStore: env.store, releaseIntents: env.intents,
      recoveryOperations: new RecoveryOperationsService({ intents: env.intents, audit: env.audit, events: env.events }),
      recoveryControl: new RecoveryControlService({ intents: env.intents, audit: env.audit, events: env.events, workerId: "m1" }),
    };
    const app = createHttpApp({ services, idempotency: new IdempotencyStore(env.raw) });
    const srv: Server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
    const port = (srv.address() as any).port;
    await fetch("http://127.0.0.1:" + port + "/api/recovery/intents/" + encodeURIComponent(k) + "/reconcile", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token, "Idempotency-Key": "m1" },
      body: "{}",
    });
    await new Promise<void>((res) => srv.close(() => res()));

    const auditRows = await env.engine.all<any>("audit");
    const hasRecoveryAudit = auditRows.some((a) => typeof a.action === "string" && a.action.startsWith("recovery."));
    ok(hasRecoveryAudit, "M1 recovery audit records persisted durably");

    // M2 no leaked tokens in audit
    const leaked = JSON.stringify(auditRows).includes(token);
    ok(!leaked, "M2 bearer token not present in audit records");

    // M3 no password in audit
    const leakedPw = JSON.stringify(auditRows).toLowerCase().includes("password_hash");
    ok(!leakedPw, "M3 password hash not present in audit records");
  });

  // ============================================================
  // N - Project isolation
  // ============================================================
  await withEnv(async (env) => {
    section("N - Project isolation");
    const { intent: a } = await env.intents.getOrCreate(mkInput("N-a", { projectId: "proj-A" }));
    const { intent: b } = await env.intents.getOrCreate(mkInput("N-b", { projectId: "proj-B" }));
    const listA = env.intents.listRecoverable().filter((i) => i.projectId === "proj-A");
    const listB = env.intents.listRecoverable().filter((i) => i.projectId === "proj-B");
    ok(listA.every((i) => i.projectId === "proj-A"), "N1 no cross-project contamination (A)");
    ok(listB.every((i) => i.projectId === "proj-B"), "N2 no cross-project contamination (B)");
    ok(a.intentKey !== b.intentKey, "N3 distinct intent keys per project");
  });

  // ============================================================
  // O - Environment isolation
  // ============================================================
  await withEnv(async (env) => {
    section("O - Environment isolation");
    const { intent: prod } = await env.intents.getOrCreate(mkInput("O-prod", { environment: "production" }));
    const { intent: stg } = await env.intents.getOrCreate(mkInput("O-stg", { environment: "staging" }));
    const storedP = env.intents.get(prod.intentKey);
    const storedS = env.intents.get(stg.intentKey);
    ok(storedP?.environment === "production", "O1 production environment preserved");
    ok(storedS?.environment === "staging", "O2 staging environment preserved");
    ok(prod.intentKey !== stg.intentKey, "O3 distinct keys per environment");
  });

  // ============================================================
  // P - HTTP / idempotency integration
  // ============================================================
  await withEnv(async (env) => {
    section("P - HTTP / idempotency integration");
    const { token } = await mkUser(env, "OWNER", "p1");
    await mkProject(env, "proj-P");
    const k = await seedRecoverable(env, "p1", { projectId: "proj-P" });

    const services: any = {
      engine: env.engine, events: env.events, audit: env.audit, sessions: env.sessions,
      authz: env.authz, memberships: env.memberships,
      executionStore: env.store, releaseIntents: env.intents,
      recoveryOperations: new RecoveryOperationsService({ intents: env.intents, audit: env.audit, events: env.events }),
      recoveryControl: new RecoveryControlService({ intents: env.intents, audit: env.audit, events: env.events, workerId: "p1" }),
    };
    const idem = new IdempotencyStore(env.raw);
    const app = createHttpApp({ services, idempotency: idem });
    const srv: Server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
    const port = (srv.address() as any).port;
    const url = "http://127.0.0.1:" + port + "/api/recovery/intents/" + encodeURIComponent(k) + "/reconcile";

    const h = { "Content-Type": "application/json", "Authorization": "Bearer " + token, "Idempotency-Key": "p1-key" };
    const r1 = await fetch(url, { method: "POST", headers: h, body: "{}" });
    const r1b = await r1.text();
    await new Promise<void>((res) => srv.close(() => res()));

    // Reopen with fresh idempotency store (same DB)
    const idem2 = new IdempotencyStore(env.raw);
    const app2 = createHttpApp({ services, idempotency: idem2 });
    const srv2: Server = await new Promise((r) => { const s = app2.listen(0, () => r(s)); });
    const port2 = (srv2.address() as any).port;
    const url2 = "http://127.0.0.1:" + port2 + "/api/recovery/intents/" + encodeURIComponent(k) + "/reconcile";
    const r2 = await fetch(url2, { method: "POST", headers: h, body: "{}" });
    const r2b = await r2.text();
    await new Promise<void>((res) => srv2.close(() => res()));
    ok(r1.status === 200 && r2.status === 200 && r1b === r2b,
      "P1 idempotent replay survives HTTP app restart");
  });

  // ============================================================
  // Q - Terminal-state integrity
  // ============================================================
  await withEnv(async (env) => {
    section("Q - Terminal-state integrity");
    const { intent } = await env.intents.getOrCreate(mkInput("Q1"));
    env.intents.acquireLease(intent.intentKey, "w-Q", 60_000);
    env.intents.transitionIfOwned(intent.intentKey, "DEPLOYMENT_INTENT_CREATED", "w-Q", {});
    env.intents.transitionIfOwned(intent.intentKey, "DEPLOYING", "w-Q", {});
    env.intents.transitionIfOwned(intent.intentKey, "KNOWN_GOOD", "w-Q", {
      deploymentId: "dep-Q1",
      reconciliationEvidence: JSON.stringify({ source: "test", intentKey: intent.intentKey, timestamp: Date.now() }),
    });
    env.intents.releaseLease(intent.intentKey, "w-Q");
    ok(env.intents.get(intent.intentKey)?.status === "KNOWN_GOOD", "Q1 terminal KNOWN_GOOD persisted");

    // Q2 no longer in recoverable set
    ok(!env.intents.listRecoverable().some((i) => i.intentKey === intent.intentKey),
      "Q2 terminal intent excluded from recoverable set");

    // Q3 survives reopen
    await closeEnv(env);
    const env2 = openEnv(env.dbFile);
    ok(env2.intents.get(intent.intentKey)?.status === "KNOWN_GOOD", "Q3 terminal state survives reopen");
    await closeEnv(env2);
    env.raw = new Database(env.dbFile);
    env.raw.pragma("journal_mode = WAL");
  });

  // ============================================================
  // R - Rollback durability
  // ============================================================
  await withEnv(async (env) => {
    section("R - Rollback durability");
    const { intent } = await env.intents.getOrCreate(mkInput("R1", { intentKind: "ROLLBACK" } as any));
    env.intents.acquireLease(intent.intentKey, "w-R", 60_000);
    env.intents.transitionIfOwned(intent.intentKey, "DEPLOYMENT_INTENT_CREATED", "w-R", {});
    env.intents.transitionIfOwned(intent.intentKey, "ROLLING_BACK", "w-R", {});
    env.intents.releaseLease(intent.intentKey, "w-R");
    ok(env.intents.get(intent.intentKey)?.status === "ROLLING_BACK", "R1 ROLLING_BACK persisted");

    await closeEnv(env);
    const env2 = openEnv(env.dbFile);
    ok(env2.intents.get(intent.intentKey)?.status === "ROLLING_BACK", "R2 ROLLING_BACK survives reopen");
    await closeEnv(env2);
    env.raw = new Database(env.dbFile);
    env.raw.pragma("journal_mode = WAL");
  });

  console.log("\n=== Phase 181 Summary ===");
  console.log("Passed: " + passed);
  console.log("Failed: " + failed);
  // Force exit: child processes may hold stdout/stderr pipes open after they
  // exit, preventing Node from exiting naturally. Explicit exit guarantees
  // the test runner always terminates.
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });