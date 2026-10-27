// scripts/test-phase268-remote-result-integrity.ts
// Phase 268: remote execution result integrity — async persistence path.
//
// Exercises persistRemoteExecutionResultAndDispatchAsOwnerAsync against a
// live Postgres database. Requires NEXUS_PERSISTENCE_MODE=shared and
// DATABASE_URL. Reports BLOCKED (not FAIL) when the shared backend is not
// reachable.

import { randomUUID } from "node:crypto";
import { PgClient } from "../src/core/pg-client";
import { ExecutionStore } from "../src/core/execution-store";
import { PgAsyncEngine } from "../src/core/pg-async-engine";
import type {
  RemoteExecutionResult,
  RemoteDispatchRecord,
} from "../src/core/execution-models";

type Result = "PASS" | "FAIL" | "BLOCKED";
interface Row { id: string; name: string; result: Result; note: string; }
const rows: Row[] = [];
function record(id: string, name: string, result: Result, note: string): void {
  rows.push({ id, name, result, note });
  const mark = result === "PASS" ? "[PASS]" : result === "FAIL" ? "[FAIL]" : "[BLK ]";
  console.log(`${mark} ${id} ${name} -- ${note}`);
}
function ok(cond: boolean, msg: string): void { if (!cond) throw new Error(msg); }

const PREFIX = "phase268-ri-" + Date.now() + "-";
let client: PgClient;
let store: ExecutionStore;

async function pgExec(sql: string, params: unknown[] = []): Promise<any> {
  return await client.query(sql, params);
}

async function seedLeaseAndDispatch(opts: {
  dispatchId: string; jobId: string; workerId: string; leaseId: string;
}): Promise<void> {
  const now = Date.now();
  // 1. execution_jobs row (FK target for remote_dispatches.job_id).
  await pgExec(
    "INSERT INTO execution_jobs (id, idempotency_key, job_type, payload, status, " +
    "  retry_policy, timeout_ms, created_at, updated_at, last_attempt_at, " +
    "  next_attempt_at, current_lease_id, cancellation_requested, " +
    "  cancellation_acknowledged, priority) " +
    "VALUES ($1, $2, 'remote.exec', '{}', 'RUNNING', NULL, NULL, $3, $3, NULL, " +
    "  NULL, NULL, 0, 0, 0) ON CONFLICT (id) DO NOTHING",
    [opts.jobId, "idem-" + opts.jobId, now],
  );
  // 2. execution_leases row (ownership source — the sync method checks this).
  await pgExec(
    "INSERT INTO execution_leases (lease_id, job_id, worker_id, acquired_at, " +
    "  expires_at, renewed_at, released_at, status) " +
    "VALUES ($1, $2, $3, $4, $5, NULL, NULL, 'ACTIVE') " +
    "ON CONFLICT (lease_id) DO NOTHING",
    [opts.leaseId, opts.jobId, opts.workerId, now, now + 3600_000],
  );
  // 3. remote_dispatches row.
  await pgExec(
    "INSERT INTO remote_dispatches (dispatch_id, job_id, worker_id, attempt_id, " +
    "  lease_id, status, created_at, idempotency_key) " +
    "VALUES ($1, $2, $3, NULL, $4, 'DISPATCHED', $5, $6) " +
    "ON CONFLICT (dispatch_id) DO NOTHING",
    [opts.dispatchId, opts.jobId, opts.workerId, opts.leaseId, now, "idem-" + opts.dispatchId],
  );
}

async function cleanup(): Promise<void> {
  const like = PREFIX + "%";
  await pgExec("DELETE FROM remote_execution_results WHERE dispatch_id LIKE $1", [like]);
  await pgExec("DELETE FROM remote_dispatches WHERE dispatch_id LIKE $1", [like]);
  await pgExec("DELETE FROM execution_leases WHERE job_id LIKE $1", [like]);
  await pgExec("DELETE FROM execution_jobs WHERE id LIKE $1", [like]);
}

function makeResult(overrides: Partial<RemoteExecutionResult> & {
  dispatchId: string; workerId: string; leaseId: string; jobId: string;
}): RemoteExecutionResult {
  return {
    resultId: "result-" + overrides.dispatchId,
    jobId: overrides.jobId,
    attemptId: undefined,
    workerId: overrides.workerId,
    dispatchId: overrides.dispatchId,
    leaseId: overrides.leaseId,
    success: true,
    exitCode: 0,
    stdoutRef: "hello",
    stderrRef: "",
    evidence: { test: true },
    createdAt: Date.now(),
    stdoutSha256: "a".repeat(64),
    stderrSha256: "b".repeat(64),
    resultSha256: "c".repeat(64),
    verificationStatus: "VERIFIED",
    verifiedAt: 1700000000000,
    ...overrides,
  };
}

function makeDispatch(
  dispatchId: string,
  status: "COMPLETED" | "FAILED",
  identity: { jobId: string; workerId: string; leaseId: string; attemptId?: string },
): RemoteDispatchRecord {
  return {
    dispatchId,
    jobId: identity.jobId,
    workerId: identity.workerId,
    leaseId: identity.leaseId,
    attemptId: identity.attemptId,
    idempotencyKey: "idem-" + dispatchId,
    status,
    createdAt: 0,
    updatedAt: Date.now(),
    result: { success: status === "COMPLETED", exitCode: 0, stdout: "hello", stderr: "" },
  };
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
    for (const id of ["268-ri-A","268-ri-B","268-ri-C","268-ri-D","268-ri-E","268-ri-F","268-ri-G"]) {
      record(id, "requires shared mode + DATABASE_URL", "BLOCKED",
             "NEXUS_PERSISTENCE_MODE=shared and DATABASE_URL required");
    }
    return;
  }

  client = new PgClient();
  await client.connect(process.env.DATABASE_URL!);
  const asyncEngine = new PgAsyncEngine(client);
  store = new (ExecutionStore as any)({} as any, asyncEngine);

  try {
    await test("268-ri-A", "stale ownership — wrong worker rejected", async () => {
      const d = PREFIX + "A-" + randomUUID();
      const j = PREFIX + "A-job-" + randomUUID();
      const l = PREFIX + "A-lease-" + randomUUID();
      await seedLeaseAndDispatch({ dispatchId: d, jobId: j, workerId: "worker-A", leaseId: l });
      const r = makeResult({ dispatchId: d, workerId: "worker-A", leaseId: l, jobId: j });
      const out = await store.persistRemoteExecutionResultAndDispatchAsOwnerAsync(
        r, makeDispatch(d, "COMPLETED", { jobId: j, workerId: "worker-A", leaseId: l }), l, "worker-B",
      );
      ok(!out.persisted, "expected persisted=false, got " + JSON.stringify(out));
      ok(out.reason === "WORKER_OWNERSHIP_LOST", "expected WORKER_OWNERSHIP_LOST, got " + out.reason);
      const cnt = await pgExec("SELECT COUNT(*)::int AS n FROM remote_execution_results WHERE dispatch_id = $1", [d]);
      ok(cnt.rows[0].n === 0, "no result row should exist; found " + cnt.rows[0].n);
      return "rejected without writing";
    });

    await test("268-ri-B", "stale ownership — wrong lease rejected", async () => {
      const d = PREFIX + "B-" + randomUUID();
      const j = PREFIX + "B-job-" + randomUUID();
      const l = PREFIX + "B-lease-" + randomUUID();
      await seedLeaseAndDispatch({ dispatchId: d, jobId: j, workerId: "worker-A", leaseId: l });
      const r = makeResult({ dispatchId: d, workerId: "worker-A", leaseId: l, jobId: j });
      const out = await store.persistRemoteExecutionResultAndDispatchAsOwnerAsync(
        r, makeDispatch(d, "COMPLETED", { jobId: j, workerId: "worker-A", leaseId: l }), l + "-WRONG", "worker-A",
      );
      ok(!out.persisted, "expected persisted=false");
      ok(out.reason === "WORKER_OWNERSHIP_LOST", "expected WORKER_OWNERSHIP_LOST");
      return "rejected without writing";
    });

    await test("268-ri-C", "matching duplicate — idempotent replay", async () => {
      const d = PREFIX + "C-" + randomUUID();
      const j = PREFIX + "C-job-" + randomUUID();
      const l = PREFIX + "C-lease-" + randomUUID();
      await seedLeaseAndDispatch({ dispatchId: d, jobId: j, workerId: "worker-A", leaseId: l });
      const r = makeResult({ dispatchId: d, workerId: "worker-A", leaseId: l, jobId: j });
      const first = await store.persistRemoteExecutionResultAndDispatchAsOwnerAsync(
        r, makeDispatch(d, "COMPLETED", { jobId: j, workerId: "worker-A", leaseId: l }), l, "worker-A",
      );
      ok(first.persisted, "first submit must persist: " + JSON.stringify(first));
      ok(!first.duplicate, "first submit is not a duplicate");

      // Simulate a stale dispatch row while preserving the durable result.
      await pgExec(
        "UPDATE remote_dispatches SET status = 'DISPATCHED', result = NULL, error = NULL " +
        "WHERE dispatch_id = $1",
        [d],
      );
      const second = await store.persistRemoteExecutionResultAndDispatchAsOwnerAsync(
        r, makeDispatch(d, "COMPLETED", { jobId: j, workerId: "worker-A", leaseId: l }), l, "worker-A",
      );
      ok(second.persisted, "second submit persists as idempotent replay: " + JSON.stringify(second));
      ok(second.duplicate === true, "second submit flagged duplicate");

      const dispatchState = await pgExec(
        "SELECT status, result, error FROM remote_dispatches WHERE dispatch_id = $1",
        [d],
      );
      ok(dispatchState.rows.length === 1, "dispatch row must still exist");
      ok(dispatchState.rows[0].status === "COMPLETED",
        "matching replay must reconcile dispatch to COMPLETED");
      ok(dispatchState.rows[0].result != null,
        "matching replay must restore the dispatch result");
      ok(dispatchState.rows[0].error == null,
        "successful replay must clear stale dispatch error");
      const cnt = await pgExec("SELECT COUNT(*)::int AS n FROM remote_execution_results WHERE dispatch_id = $1", [d]);
      ok(cnt.rows[0].n === 1, "exactly one row, found " + cnt.rows[0].n);
      return "one row; second submit returned duplicate=true";
    });

    await test("268-ri-D", "conflicting duplicate — original preserved", async () => {
      const d = PREFIX + "D-" + randomUUID();
      const j = PREFIX + "D-job-" + randomUUID();
      const l = PREFIX + "D-lease-" + randomUUID();
      await seedLeaseAndDispatch({ dispatchId: d, jobId: j, workerId: "worker-A", leaseId: l });
      const r1 = makeResult({ dispatchId: d, workerId: "worker-A", leaseId: l, jobId: j,
                             resultSha256: "1".repeat(64) });
      const first = await store.persistRemoteExecutionResultAndDispatchAsOwnerAsync(
        r1, makeDispatch(d, "COMPLETED", { jobId: j, workerId: "worker-A", leaseId: l }), l, "worker-A",
      );
      ok(first.persisted, "first submit succeeds");
      const r2 = makeResult({ dispatchId: d, workerId: "worker-A", leaseId: l, jobId: j,
                             resultSha256: "2".repeat(64) });
      const second = await store.persistRemoteExecutionResultAndDispatchAsOwnerAsync(
        r2, makeDispatch(d, "COMPLETED", { jobId: j, workerId: "worker-A", leaseId: l }), l, "worker-A",
      );
      ok(!second.persisted, "conflicting submit must reject");
      ok(second.reason === "RESULT_CONFLICT", "expected RESULT_CONFLICT, got " + second.reason);
      const row = await pgExec("SELECT result_sha256 FROM remote_execution_results WHERE dispatch_id = $1", [d]);
      ok(row.rows.length === 1, "exactly one row");
      ok(row.rows[0].result_sha256 === "1".repeat(64), "original digest preserved");
      return "conflict rejected; original digest intact";
    });

    await test("268-ri-E", "concurrent submissions — single winner, one row", async () => {
      const d = PREFIX + "E-" + randomUUID();
      const j = PREFIX + "E-job-" + randomUUID();
      const l = PREFIX + "E-lease-" + randomUUID();
      await seedLeaseAndDispatch({ dispatchId: d, jobId: j, workerId: "worker-A", leaseId: l });
      const r = makeResult({ dispatchId: d, workerId: "worker-A", leaseId: l, jobId: j });
      const results = await Promise.all([
        store.persistRemoteExecutionResultAndDispatchAsOwnerAsync(r, makeDispatch(d, "COMPLETED", { jobId: j, workerId: "worker-A", leaseId: l }), l, "worker-A"),
        store.persistRemoteExecutionResultAndDispatchAsOwnerAsync(r, makeDispatch(d, "COMPLETED", { jobId: j, workerId: "worker-A", leaseId: l }), l, "worker-A"),
      ]);
      const winners = results.filter((x) => x.persisted && !x.duplicate).length;
      const dupes = results.filter((x) => x.persisted && x.duplicate).length;
      const losers = results.filter((x) => !x.persisted).length;
      ok(winners === 1, "exactly one non-duplicate winner, got " + winners);
      ok(dupes + losers === 1, "other is duplicate or rejected, got dup=" + dupes + " lose=" + losers);
      const cnt = await pgExec("SELECT COUNT(*)::int AS n FROM remote_execution_results WHERE dispatch_id = $1", [d]);
      ok(cnt.rows[0].n === 1, "exactly one row in results, found " + cnt.rows[0].n);
      return "winners=1, dupes=" + dupes + ", losers=" + losers + ", rows=1";
    });
    await test("268-ri-F", "mismatched dispatch job identity rejected", async () => {
      const d = PREFIX + "F-" + randomUUID();
      const j = PREFIX + "F-job-" + randomUUID();
      const l = PREFIX + "F-lease-" + randomUUID();
      await seedLeaseAndDispatch({ dispatchId: d, jobId: j, workerId: "worker-A", leaseId: l });

      const r = makeResult({ dispatchId: d, workerId: "worker-A", leaseId: l, jobId: j });
      const badDispatch = makeDispatch(d, "COMPLETED", {
        jobId: j + "-WRONG", workerId: "worker-A", leaseId: l,
      });

      const out = await store.persistRemoteExecutionResultAndDispatchAsOwnerAsync(
        r, badDispatch, l, "worker-A",
      );
      ok(!out.persisted, "mismatched dispatch must not persist");
      ok(out.reason === "DISPATCH_IDENTITY_MISMATCH",
        "expected DISPATCH_IDENTITY_MISMATCH, got " + out.reason);

      const cnt = await pgExec(
        "SELECT COUNT(*)::int AS n FROM remote_execution_results WHERE dispatch_id = $1", [d],
      );
      ok(Number(cnt.rows[0].n) === 0, "no result row should be inserted");

      const state = await pgExec(
        "SELECT status FROM remote_dispatches WHERE dispatch_id = $1", [d],
      );
      ok(state.rows[0]?.status === "DISPATCHED",
        "original dispatch status must remain DISPATCHED");
      return "rejected; no result inserted; dispatch unchanged";
    });

    await test("268-ri-G", "mismatched result attempt identity rejected", async () => {
      const d = PREFIX + "G-" + randomUUID();
      const j = PREFIX + "G-job-" + randomUUID();
      const l = PREFIX + "G-lease-" + randomUUID();
      await seedLeaseAndDispatch({ dispatchId: d, jobId: j, workerId: "worker-A", leaseId: l });

      const r = makeResult({
        dispatchId: d, workerId: "worker-A", leaseId: l, jobId: j,
        attemptId: "unexpected-attempt",
      });
      const dispatch = makeDispatch(d, "COMPLETED", {
        jobId: j, workerId: "worker-A", leaseId: l,
      });

      const out = await store.persistRemoteExecutionResultAndDispatchAsOwnerAsync(
        r, dispatch, l, "worker-A",
      );
      ok(!out.persisted, "mismatched attempt must not persist");
      ok(out.reason === "DISPATCH_IDENTITY_MISMATCH",
        "expected DISPATCH_IDENTITY_MISMATCH, got " + out.reason);

      const cnt = await pgExec(
        "SELECT COUNT(*)::int AS n FROM remote_execution_results WHERE dispatch_id = $1", [d],
      );
      ok(Number(cnt.rows[0].n) === 0, "no result row should be inserted");

      const state = await pgExec(
        "SELECT status FROM remote_dispatches WHERE dispatch_id = $1", [d],
      );
      ok(state.rows[0]?.status === "DISPATCHED",
        "original dispatch status must remain DISPATCHED");
      return "rejected; no result inserted; dispatch unchanged";
    });
  } finally {
    await cleanup();
    await client.close();
  }
}

main().then(() => {
  const pass = rows.filter(r => r.result === "PASS").length;
  const fail = rows.filter(r => r.result === "FAIL").length;
  const blk  = rows.filter(r => r.result === "BLOCKED").length;
  console.log("\n===== Phase 268-ri summary =====");
  console.log("PASS: " + pass);
  console.log("FAIL: " + fail);
  console.log("BLOCKED: " + blk);
  process.exit(fail > 0 ? 1 : blk > 0 ? 2 : 0);
}).catch((e) => { console.error("FATAL:", e); process.exit(1); });
