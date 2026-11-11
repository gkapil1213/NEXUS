// scripts/test-phase300-sqlite-race.ts
// Phase 300 Section 6: SQLite synchronous result/cancellation regression.

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { ExecutionStore } from "../src/core/execution-store";
import { MigrationRunner } from "../src/core/migration-runner";

type Result = "PASS" | "FAIL" | "BLOCKED";
interface Row { id: string; name: string; result: Result; note: string }
const rows: Row[] = [];
function record(id: string, name: string, result: Result, note: string): void {
  rows.push({ id, name, result, note });
  const mark = result === "PASS" ? "[PASS]" : result === "FAIL" ? "[FAIL]" : "[BLK ]";
  console.log(`${mark} ${id} ${name} -- ${note}`);
}
function ok(cond: boolean, msg: string): void { if (!cond) throw new Error(msg); }
async function test(id: string, name: string, fn: () => Promise<string>): Promise<void> {
  try { record(id, name, "PASS", await fn()); }
  catch (e) { record(id, name, "FAIL", e instanceof Error ? e.message : String(e)); }
}

async function main(): Promise<void> {
  const dbPath = path.join(os.tmpdir(), `nexus_p300sqlite_${randomUUID().replace(/-/g, "").slice(0, 12)}.db`);
  const db = new Database(dbPath);
  const migrationsDir = path.join(process.cwd(), "src", "db", "migrations");
  const runner = new MigrationRunner(db, migrationsDir);
  runner.run();

  const store = new (ExecutionStore as any)(db as any);
  console.log(`sqlite db: ${dbPath}`);
  console.log(`migrations: applied`);

  function seed(jobId: string, dispatchId: string, leaseId: string, workerId: string): void {
    const now = Date.now();
    db.prepare(
      "INSERT INTO execution_jobs (id, idempotency_key, job_type, payload, status, retry_policy, timeout_ms, created_at, updated_at, last_attempt_at, next_attempt_at, current_lease_id, cancellation_requested, cancellation_acknowledged) " +
      "VALUES (?, ?, 'remote.exec', '{}', 'RUNNING', NULL, NULL, ?, ?, NULL, NULL, NULL, 0, 0)"
    ).run(jobId, "idem-job-" + jobId, now, now);
    db.prepare(
      "INSERT INTO execution_leases (lease_id, job_id, worker_id, acquired_at, expires_at, renewed_at, released_at, status) " +
      "VALUES (?, ?, ?, ?, ?, NULL, NULL, 'ACTIVE')"
    ).run(leaseId, jobId, workerId, now, now + 3600_000);
    db.prepare(
      "INSERT INTO remote_dispatches (dispatch_id, job_id, worker_id, attempt_id, lease_id, status, created_at, updated_at, idempotency_key) " +
      "VALUES (?, ?, ?, NULL, ?, 'DISPATCHED', ?, ?, ?)"
    ).run(dispatchId, jobId, workerId, leaseId, now, now, "idem-" + dispatchId);
  }

  function makeResult(dispatchId: string, jobId: string, workerId: string, leaseId: string): any {
    const now = Date.now();
    return {
      resultId: "res-" + dispatchId,
      jobId, attemptId: undefined, workerId, dispatchId, leaseId,
      success: true, exitCode: 0,
      stdoutRef: "out", stderrRef: "",
      evidence: { test: true },
      createdAt: now,
      stdoutSha256: "a".repeat(64), stderrSha256: "b".repeat(64), resultSha256: "c".repeat(64),
      verificationStatus: "VERIFIED", verifiedAt: now,
    };
  }

  function makeDispatch(dispatchId: string, jobId: string, workerId: string, leaseId: string, status: string): any {
    return {
      dispatchId, jobId, workerId, leaseId, attemptId: undefined,
      idempotencyKey: "idem-" + dispatchId, status,
      createdAt: 0, updatedAt: Date.now(),
      result: { success: true, exitCode: 0, stdout: "out", stderr: "" },
    };
  }

  try {
    await test("SQLITE-B1", "late result cannot overwrite CANCELLED", async () => {
      const d = "b1-" + randomUUID(), j = "b1-job-" + randomUUID();
      const l = "b1-lease-" + randomUUID(), w = "worker-A";
      seed(j, d, l, w);

      const cancelOut = store.cancelRemoteDispatchIfNotTerminal(d);
      ok(cancelOut.cancelled === true, "cancel should succeed, got " + JSON.stringify(cancelOut));
      const st1 = db.prepare("SELECT status FROM remote_dispatches WHERE dispatch_id = ?").get(d) as { status: string };
      ok(st1.status === "CANCELLED", "expected CANCELLED after cancel, got " + st1.status);

      const persistOut = store.persistRemoteExecutionResultAndDispatchAsOwner(
        makeResult(d, j, w, l), makeDispatch(d, j, w, l, "COMPLETED"), l, w
      );

      ok(persistOut.persisted === false, "late result must be rejected, got " + JSON.stringify(persistOut));
      ok(persistOut.reason === "DISPATCH_TERMINAL", "expected DISPATCH_TERMINAL, got " + persistOut.reason);

      const st2 = db.prepare("SELECT status FROM remote_dispatches WHERE dispatch_id = ?").get(d) as { status: string };
      ok(st2.status === "CANCELLED", "dispatch must remain CANCELLED, got " + st2.status);

      const cnt = db.prepare("SELECT COUNT(*) AS n FROM remote_execution_results WHERE dispatch_id = ?").get(d) as { n: number };
      ok(cnt.n === 0, "no result row should exist, got " + cnt.n);

      return "cancel first; late result rejected; CANCELLED durable; 0 rows";
    });

    await test("SQLITE-B2", "cancel cannot overwrite COMPLETED", async () => {
      const d = "b2-" + randomUUID(), j = "b2-job-" + randomUUID();
      const l = "b2-lease-" + randomUUID(), w = "worker-A";
      seed(j, d, l, w);

      const persistOut = store.persistRemoteExecutionResultAndDispatchAsOwner(
        makeResult(d, j, w, l), makeDispatch(d, j, w, l, "COMPLETED"), l, w
      );
      ok(persistOut.persisted === true, "result should persist, got " + JSON.stringify(persistOut));

      const st1 = db.prepare("SELECT status FROM remote_dispatches WHERE dispatch_id = ?").get(d) as { status: string };
      ok(st1.status === "COMPLETED", "expected COMPLETED, got " + st1.status);

      const cnt1 = db.prepare("SELECT COUNT(*) AS n FROM remote_execution_results WHERE dispatch_id = ?").get(d) as { n: number };
      ok(cnt1.n === 1, "1 result row expected, got " + cnt1.n);

      const cancelOut = store.cancelRemoteDispatchIfNotTerminal(d);
      ok(cancelOut.cancelled === false, "cancel should reject on COMPLETED, got " + JSON.stringify(cancelOut));
      ok(cancelOut.currentStatus === "COMPLETED", "currentStatus should be COMPLETED, got " + cancelOut.currentStatus);

      const st2 = db.prepare("SELECT status FROM remote_dispatches WHERE dispatch_id = ?").get(d) as { status: string };
      ok(st2.status === "COMPLETED", "dispatch must remain COMPLETED, got " + st2.status);

      const cnt2 = db.prepare("SELECT COUNT(*) AS n FROM remote_execution_results WHERE dispatch_id = ?").get(d) as { n: number };
      ok(cnt2.n === 1, "result row must remain, got " + cnt2.n);

      return "result first; cancel rejected; COMPLETED durable; 1 row";
    });
  } finally {
    try { db.close(); } catch {}
    try { fs.unlinkSync(dbPath); console.log(`  [cleanup] removed ${dbPath}`); }
    catch (e) { console.error(`  [cleanup] failed: ${e instanceof Error ? e.message : String(e)}`); }
  }

  const pass = rows.filter(r => r.result === "PASS").length;
  const fail = rows.filter(r => r.result === "FAIL").length;
  const blk = rows.filter(r => r.result === "BLOCKED").length;
  console.log("\n===== Phase 300 SQLite race summary =====");
  console.log("PASS: " + pass);
  console.log("FAIL: " + fail);
  console.log("BLOCKED: " + blk);
  process.exit(fail > 0 ? 1 : blk > 0 ? 2 : 0);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });