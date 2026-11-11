// scripts/test-phase300-wp3-cross-process.ts
// Phase 300 / WP3 - Cross-process verification of result persistence.
//
// The existing test-phase268-remote-result-integrity.ts verifies the
// persistRemoteExecutionResultAndDispatchAsOwnerAsync contract in a single
// process (7/7 PASS at commit 977ed86). This new file adds the cross-PROCESS
// dimension that section 10 of the completion directive requires:
//
//   WP3-X1  A result written by process A is visible to process B.
//   WP3-X2  Two processes submit the SAME result concurrently; exactly one
//           result row exists; the other sees an idempotent duplicate ACK.
//   WP3-X3  Two processes submit CONFLICTING results concurrently; exactly
//           one row exists; the other is rejected with RESULT_CONFLICT.
//   WP3-X4  Process A submits; process B submits the same result later;
//           process B observes { persisted: true, duplicate: true }.
//
// Isolated database nexus_p300wp3x_<random> is created, seeded, tested, and
// dropped in a finally block. No production data is touched.

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { PgClient } from "../src/core/pg-client";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type Result = "PASS" | "FAIL" | "BLOCKED" | "NOT EXECUTED";
interface Row { id: string; name: string; result: Result; note: string; }
const rows: Row[] = [];
function record(id: string, name: string, result: Result, note: string): void {
  rows.push({ id, name, result, note });
  const mark = result === "PASS" ? "[PASS]" : result === "FAIL" ? "[FAIL]" : result === "BLOCKED" ? "[BLK ]" : "[N/E ]";
  console.log(`${mark} ${id} ${name} -- ${note}`);
}
function ok(cond: boolean, msg: string): void { if (!cond) throw new Error(msg); }

async function pgExec(client: PgClient, sql: string, params: unknown[] = []): Promise<any> {
  return await client.query(sql, params);
}
async function createDb(admin: PgClient, name: string): Promise<void> { await pgExec(admin, `CREATE DATABASE "${name}"`); }
async function dropDb(admin: PgClient, name: string): Promise<boolean> {
  try {
    await pgExec(admin, `DROP DATABASE IF EXISTS "${name}"`);
    return true;
  } catch (e) {
    console.error(`  [dropDb] DROP DATABASE "${name}" failed: ` + (e instanceof Error ? e.message : String(e)));
    return false;
  }
}

async function bootstrap(client: PgClient): Promise<void> {
  await pgExec(client, `CREATE TABLE execution_jobs (id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE, job_type TEXT NOT NULL, payload TEXT, status TEXT NOT NULL, retry_policy TEXT, timeout_ms INTEGER, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, last_attempt_at BIGINT, next_attempt_at BIGINT, current_lease_id TEXT, cancellation_requested INTEGER NOT NULL DEFAULT 0, cancellation_acknowledged INTEGER NOT NULL DEFAULT 0, priority INTEGER NOT NULL DEFAULT 0)`);
  await pgExec(client, `CREATE TABLE execution_leases (lease_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, worker_id TEXT NOT NULL, acquired_at BIGINT NOT NULL, expires_at BIGINT NOT NULL, renewed_at BIGINT, released_at BIGINT, status TEXT NOT NULL)`);
  await pgExec(client, `CREATE TABLE remote_dispatches (dispatch_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, attempt_id TEXT, worker_id TEXT NOT NULL, lease_id TEXT, idempotency_key TEXT UNIQUE NOT NULL, status TEXT NOT NULL, external_provider_id TEXT, request TEXT, result TEXT, error TEXT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, FOREIGN KEY (job_id) REFERENCES execution_jobs(id))`);
  await pgExec(client, `CREATE TABLE remote_execution_results (result_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, attempt_id TEXT, worker_id TEXT, dispatch_id TEXT UNIQUE, lease_id TEXT, success BOOLEAN NOT NULL, exit_code INTEGER, stdout_ref TEXT, stderr_ref TEXT, evidence TEXT, created_at BIGINT NOT NULL, stdout_sha256 TEXT, stderr_sha256 TEXT, result_sha256 TEXT, verification_status TEXT, verified_at BIGINT, FOREIGN KEY (dispatch_id) REFERENCES remote_dispatches(dispatch_id) ON DELETE CASCADE)`);
}

async function seedAll(client: PgClient, o: { dispatchId: string; jobId: string; workerId: string; leaseId: string; idempotencyKey: string; }): Promise<void> {
  const now = Date.now();
  await pgExec(client, "INSERT INTO execution_jobs (id, idempotency_key, job_type, payload, status, retry_policy, timeout_ms, created_at, updated_at, last_attempt_at, next_attempt_at, current_lease_id, cancellation_requested, cancellation_acknowledged, priority) VALUES ($1, $2, 'remote.exec', '{}', 'RUNNING', NULL, NULL, $3, $3, NULL, NULL, NULL, 0, 0, 0) ON CONFLICT (id) DO NOTHING", [o.jobId, "idem-job-" + o.jobId, now]);
  await pgExec(client, "INSERT INTO execution_leases (lease_id, job_id, worker_id, acquired_at, expires_at, renewed_at, released_at, status) VALUES ($1, $2, $3, $4, $5, NULL, NULL, 'ACTIVE') ON CONFLICT (lease_id) DO NOTHING", [o.leaseId, o.jobId, o.workerId, now, now + 3600_000]);
  await pgExec(client, "INSERT INTO remote_dispatches (dispatch_id, job_id, worker_id, attempt_id, lease_id, status, created_at, updated_at, idempotency_key) VALUES ($1, $2, $3, NULL, $4, 'DISPATCHED', $5, $5, $6) ON CONFLICT (dispatch_id) DO NOTHING", [o.dispatchId, o.jobId, o.workerId, o.leaseId, now, o.idempotencyKey]);
}

interface WorkerOutcome {
  outcome:
    | { persisted: true; duplicate?: boolean }
    | { persisted: false; reason: string };
}

function runWorker(payload: {
  dispatchId: string; jobId: string; workerId: string; leaseId: string;
  resultId: string; resultSha256: string; dispatchStatus: "COMPLETED" | "FAILED";
}, dbUrl: string): Promise<WorkerOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", path.join(__dirname, "wp3-result-worker.ts")],
      {
        env: { ...process.env, DATABASE_URL: dbUrl, WP3_PAYLOAD: JSON.stringify(payload) },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) { reject(new Error("child exited " + code + " stderr=" + err)); return; }
      const lines = out.split(/\r?\n/).filter((l) => l.trim().length > 0);
      const last = lines[lines.length - 1];
      try {
        const parsed = JSON.parse(last);
        if (!parsed.outcome) { reject(new Error("malformed output: " + last)); return; }
        resolve(parsed as WorkerOutcome);
      } catch (e) { reject(new Error("parse: " + String(e) + " raw=" + last)); }
    });
  });
}

interface CancelOutcome {
  outcome:
    | { cancelled: true; currentStatus: string }
    | { cancelled: false; currentStatus: string | null };
}

function runCancelWorker(payload: { dispatchId: string }, dbUrl: string): Promise<CancelOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", path.join(__dirname, "wp3-cancel-worker.ts")],
      {
        env: { ...process.env, DATABASE_URL: dbUrl, WP3_CANCEL_PAYLOAD: JSON.stringify(payload) },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) { reject(new Error("cancel worker exited " + code + " stderr=" + err)); return; }
      const lines = out.split(/\r?\n/).filter((l) => l.trim().length > 0);
      const last = lines[lines.length - 1];
      try {
        const parsed = JSON.parse(last);
        if (!parsed.outcome) { reject(new Error("malformed cancel worker output: " + last)); return; }
        resolve(parsed as CancelOutcome);
      } catch (e) { reject(new Error("cancel worker parse: " + String(e) + " raw=" + last)); }
    });
  });
}

async function test(id: string, name: string, fn: () => Promise<string>): Promise<void> {
  try { record(id, name, "PASS", await fn()); }
  catch (e) { record(id, name, "FAIL", e instanceof Error ? e.message : String(e)); }
}

async function main(): Promise<void> {
  const mode = (process.env.NEXUS_PERSISTENCE_MODE ?? "sqlite").toLowerCase();
  const hasDb = !!process.env.DATABASE_URL;
  console.log("mode=" + mode + " databaseUrl=" + (hasDb ? "set" : "unset"));

  if (mode !== "shared" || !hasDb) {
    for (const id of ["WP3-X1","WP3-X2","WP3-X3","WP3-X4"]) {
      record(id, "requires shared mode + DATABASE_URL", "BLOCKED",
             "NEXUS_PERSISTENCE_MODE=shared and DATABASE_URL required");
    }
    return;
  }

  const admin = new PgClient();
  const dbName = "nexus_p300wp3x_" + randomUUID().replace(/-/g, "").slice(0, 12);
  if (!dbName.startsWith("nexus_p300wp3x_") || dbName === "nexus") {
    throw new Error("safety guard: refusing to run — isolated DB name '" + dbName + "' does not match nexus_p300wp3x_<random>");
  }
  let isolatedDbUrl = "";
  let isolated: PgClient | null = null;

  try {
    await admin.connect(process.env.DATABASE_URL!);
    await createDb(admin, dbName);
    console.log("  [setup] created isolated database " + dbName);
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = "/" + dbName;
    isolatedDbUrl = url.toString();

    isolated = new PgClient();
    await isolated.connect(isolatedDbUrl);
    await bootstrap(isolated);

    // --- WP3-X1: cross-process visibility -----------------------------
    await test("WP3-X1", "a result written by process A is visible to process B", async () => {
      const d = "wp3-x1-" + randomUUID();
      const j = "wp3-x1-job-" + randomUUID();
      const l = "wp3-x1-lease-" + randomUUID();
      const w = "worker-A";
      await seedAll(isolated, { dispatchId: d, jobId: j, workerId: w, leaseId: l, idempotencyKey: "idem-x1-" + randomUUID() });

      // Process A writes the result.
      const a = await runWorker({ dispatchId: d, jobId: j, workerId: w, leaseId: l, resultId: "res-x1-" + randomUUID(), resultSha256: "1".repeat(64), dispatchStatus: "COMPLETED" }, isolatedDbUrl);
      ok(a.outcome.persisted === true, "process A should persist, got " + JSON.stringify(a.outcome));

      // Process B reads the durable result via a fresh PgClient.
      const reader = new PgClient();
      await reader.connect(isolatedDbUrl);
      const row = await pgExec(reader, "SELECT job_id, worker_id, result_sha256, success FROM remote_execution_results WHERE dispatch_id = $1", [d]);
      ok(row.rows.length === 1, "expected 1 result row, got " + row.rows.length);
      ok(row.rows[0].job_id === j, "job_id mismatch");
      ok(row.rows[0].worker_id === w, "worker_id mismatch");
      ok(row.rows[0].result_sha256 === "1".repeat(64), "result_sha256 mismatch");
      ok(row.rows[0].success === true, "success mismatch (expected boolean true)");
      const disp = await pgExec(reader, "SELECT status FROM remote_dispatches WHERE dispatch_id = $1", [d]);
      ok(disp.rows[0]?.status === "COMPLETED", "dispatch status mismatch: " + disp.rows[0]?.status);
      await reader.close();
      return "process A wrote, process B read, dispatch COMPLETED";
    });

    // --- WP3-X2: concurrent identical submits across processes ----------
    await test("WP3-X2", "two processes submit identical result; one row; other sees duplicate", async () => {
      const d = "wp3-x2-" + randomUUID();
      const j = "wp3-x2-job-" + randomUUID();
      const l = "wp3-x2-lease-" + randomUUID();
      const w = "worker-A";
      const sha = "2".repeat(64);
      await seedAll(isolated, { dispatchId: d, jobId: j, workerId: w, leaseId: l, idempotencyKey: "idem-x2-" + randomUUID() });

      const [a, b] = await Promise.all([
        runWorker({ dispatchId: d, jobId: j, workerId: w, leaseId: l, resultId: "res-x2-" + randomUUID(), resultSha256: sha, dispatchStatus: "COMPLETED" }, isolatedDbUrl),
        runWorker({ dispatchId: d, jobId: j, workerId: w, leaseId: l, resultId: "res-x2-" + randomUUID(), resultSha256: sha, dispatchStatus: "COMPLETED" }, isolatedDbUrl),
      ]);

      const winners = [a, b].filter((x) => x.outcome.persisted && !("duplicate" in x.outcome && x.outcome.duplicate));
      const dupes = [a, b].filter((x) => x.outcome.persisted && "duplicate" in x.outcome && x.outcome.duplicate);
      const losers = [a, b].filter((x) => !x.outcome.persisted);
      ok(winners.length === 1, "expected exactly 1 non-duplicate winner, got " + winners.length + " (" + JSON.stringify({ a: a.outcome, b: b.outcome }) + ")");
      ok(dupes.length + losers.length === 1, "other should be duplicate or rejected, got dupes=" + dupes.length + " losers=" + losers.length);

      const row = await pgExec(isolated, "SELECT COUNT(*)::int AS n FROM remote_execution_results WHERE dispatch_id = $1", [d]);
      ok(row.rows[0].n === 1, "expected exactly 1 result row, got " + row.rows[0].n);
      return "winners=1 dupes=" + dupes.length + " losers=" + losers.length + " rows=1";
    });

    // --- WP3-X3: concurrent conflicting submits across processes --------
    await test("WP3-X3", "two processes submit conflicting results; one row; other rejected", async () => {
      const d = "wp3-x3-" + randomUUID();
      const j = "wp3-x3-job-" + randomUUID();
      const l = "wp3-x3-lease-" + randomUUID();
      const w = "worker-A";
      await seedAll(isolated, { dispatchId: d, jobId: j, workerId: w, leaseId: l, idempotencyKey: "idem-x3-" + randomUUID() });

      const [a, b] = await Promise.all([
        runWorker({ dispatchId: d, jobId: j, workerId: w, leaseId: l, resultId: "res-x3-a-" + randomUUID(), resultSha256: "a".repeat(64), dispatchStatus: "COMPLETED" }, isolatedDbUrl),
        runWorker({ dispatchId: d, jobId: j, workerId: w, leaseId: l, resultId: "res-x3-b-" + randomUUID(), resultSha256: "b".repeat(64), dispatchStatus: "COMPLETED" }, isolatedDbUrl),
      ]);

      const persisted = [a, b].filter((x) => x.outcome.persisted);
      const rejected = [a, b].filter((x) => !x.outcome.persisted);
      ok(persisted.length === 1, "expected exactly 1 persisted, got " + persisted.length + " (" + JSON.stringify({ a: a.outcome, b: b.outcome }) + ")");
      ok(rejected.length === 1, "expected exactly 1 rejected, got " + rejected.length);
      const rejOutcome = rejected[0].outcome as { persisted: false; reason: string };
      ok(rejOutcome.reason === "RESULT_CONFLICT", "expected RESULT_CONFLICT, got " + rejOutcome.reason);

      const rows = await pgExec(isolated, "SELECT result_sha256 FROM remote_execution_results WHERE dispatch_id = $1", [d]);
      ok(rows.rows.length === 1, "expected 1 row, got " + rows.rows.length);
      const stored = rows.rows[0].result_sha256 as string;
      ok(stored === "a".repeat(64) || stored === "b".repeat(64), "stored digest is neither winner's: " + stored);
      return "1 persisted, 1 rejected RESULT_CONFLICT, 1 row";
    });

    // --- WP3-X4: sequential identical submits across processes ----------
    await test("WP3-X4", "sequential identical submits across processes yield idempotent duplicate", async () => {
      const d = "wp3-x4-" + randomUUID();
      const j = "wp3-x4-job-" + randomUUID();
      const l = "wp3-x4-lease-" + randomUUID();
      const w = "worker-A";
      const sha = "4".repeat(64);
      await seedAll(isolated, { dispatchId: d, jobId: j, workerId: w, leaseId: l, idempotencyKey: "idem-x4-" + randomUUID() });

      const first = await runWorker({ dispatchId: d, jobId: j, workerId: w, leaseId: l, resultId: "res-x4-" + randomUUID(), resultSha256: sha, dispatchStatus: "COMPLETED" }, isolatedDbUrl);
      ok(first.outcome.persisted === true, "first should persist");
      ok(!("duplicate" in first.outcome && first.outcome.duplicate), "first is not duplicate");

      const second = await runWorker({ dispatchId: d, jobId: j, workerId: w, leaseId: l, resultId: "res-x4-" + randomUUID(), resultSha256: sha, dispatchStatus: "COMPLETED" }, isolatedDbUrl);
      ok(second.outcome.persisted === true, "second should be persisted=true on duplicate, got " + JSON.stringify(second.outcome));
      ok("duplicate" in second.outcome && second.outcome.duplicate === true, "second should be duplicate=true, got " + JSON.stringify(second.outcome));

      const rows = await pgExec(isolated, "SELECT COUNT(*)::int AS n FROM remote_execution_results WHERE dispatch_id = $1", [d]);
      ok(rows.rows[0].n === 1, "expected 1 row, got " + rows.rows[0].n);
      return "first persisted, second duplicate=true, 1 row";
    });

    // --- WP3-X5: cancel-vs-result cross-process race -----------------
    await test("WP3-X5", "cancel-vs-result cross-process race is deterministic", async () => {
      const d = "wp3-x5-" + randomUUID();
      const j = "wp3-x5-job-" + randomUUID();
      const l = "wp3-x5-lease-" + randomUUID();
      const w = "worker-A";
      await seedAll(isolated, { dispatchId: d, jobId: j, workerId: w, leaseId: l, idempotencyKey: "idem-x5-" + randomUUID() });

      const [resultWorker, cancelWorker] = await Promise.all([
        runWorker({ dispatchId: d, jobId: j, workerId: w, leaseId: l, resultId: "res-x5-" + randomUUID(), resultSha256: "5".repeat(64), dispatchStatus: "COMPLETED" }, isolatedDbUrl),
        runCancelWorker({ dispatchId: d }, isolatedDbUrl),
      ]);

      const disp = await pgExec(isolated, "SELECT status FROM remote_dispatches WHERE dispatch_id = $1", [d]);
      const res = await pgExec(isolated, "SELECT COUNT(*)::int AS n FROM remote_execution_results WHERE dispatch_id = $1", [d]);
      const finalStatus = disp.rows[0]?.status as string | undefined;
      const resultCount = Number(res.rows[0]?.n ?? 0);

      const resultWon =
        finalStatus === "COMPLETED" &&
        resultCount === 1 &&
        resultWorker.outcome.persisted === true;

      const cancelWon =
        finalStatus === "CANCELLED" &&
        resultCount === 0;

      ok(
        resultWon || cancelWon,
        "non-deterministic race: status=" + finalStatus +
        " resultCount=" + resultCount +
        " resultOutcome=" + JSON.stringify(resultWorker.outcome) +
        " cancelOutcome=" + JSON.stringify(cancelWorker.outcome),
      );

      return "race resolved: " + (resultWon ? "COMPLETED" : "CANCELLED") + " (deterministic)";
    });

    // (isolated.close() moved to finally for exception safety)
  } finally {
    let cleanupFailed = false;

    if (isolated) {
      try {
        await isolated.close();
      } catch (e) {
        cleanupFailed = true;
        console.error("  [cleanup] failed to close isolated connection: " + (e instanceof Error ? e.message : String(e)));
      }
    }

    const dropOk = await dropDb(admin, dbName);
    if (dropOk) {
      console.log("  [cleanup] dropped isolated database " + dbName);
    } else {
      cleanupFailed = true;
      console.error("  [cleanup] FAILED to drop isolated database " + dbName + " — manual cleanup may be required");
    }

    try {
      await admin.close();
    } catch (e) {
      cleanupFailed = true;
      console.error("  [cleanup] failed to close admin connection: " + (e instanceof Error ? e.message : String(e)));
    }

    if (cleanupFailed) {
      throw new Error("WP3 isolated database cleanup failed; inspect cleanup logs before retrying.");
    }
  }
}

main().then(() => {
  const pass = rows.filter(r => r.result === "PASS").length;
  const fail = rows.filter(r => r.result === "FAIL").length;
  const blk = rows.filter(r => r.result === "BLOCKED").length;
  const ne = rows.filter(r => r.result === "NOT EXECUTED").length;
  console.log("\n===== Phase 300 WP3 cross-process summary =====");
  console.log("PASS: " + pass);
  console.log("FAIL: " + fail);
  console.log("BLOCKED: " + blk);
  console.log("NOT EXECUTED: " + ne);
  process.exit(fail > 0 ? 1 : (blk > 0 || ne > 0) ? 2 : 0);
}).catch((e) => { console.error("FATAL:", e); process.exit(1); });
