// scripts/test-phase270-crash-restart-recovery.ts
// Phase 270 - PostgreSQL crash/restart recovery (real child processes, real PG).
//
// Categories:
//   [REAL CHILD-PROCESS RESTART]      spawn child, kill/exit it, spawn new process
//   [IN-PROCESS FAULT INJECTION]      deterministic fault hook inside one process
// Real PG server restart is tested separately in test-phase270-server-restart.ts.

import { spawn } from "node:child_process";
import { PgClient } from "../src/core/pg-client";
import { PgAsyncEngine } from "../src/core/pg-async-engine";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import Database from "better-sqlite3";

let pass = 0, fail = 0, blocked = 0;
function ok(c: boolean, m: string, d = "") {
  if (c) { pass++; console.log("PASS  " + m + (d ? "  " + d : "")); }
  else   { fail++; console.log("FAIL  " + m + (d ? "  " + d : "")); }
}
function section(t: string) { console.log("\n--- " + t + " ---"); }
function uniq(t: string) { return `p270-${t}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }

function runChild(url: string, ...args: string[]): Promise<{ code: number | null; json: any; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/_phase270_pg_child.ts", ...args], {
      cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout!.on("data", (d) => { stdout += d.toString(); });
    child.stderr!.on("data", (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 30_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
      let json: any = null;
      for (let i = lines.length - 1; i >= 0; i--) { try { json = JSON.parse(lines[i]); break; } catch {} }
      resolve({ code, json, stderr });
    });
  });
}

async function openStore(url: string): Promise<{ pg: PgClient; ops: any; close: () => Promise<void> }> {
  const mem = new Database(":memory:");
  const syncEngine = SQLiteEngine.fromDatabase(mem);
  const pg = new PgClient();
  await pg.connect(url);
  const asyncDb = new PgAsyncEngine(pg);
  const store = new ExecutionStore(syncEngine, asyncDb);
  return { pg, ops: (store as any).recoveryOpsAsync, close: async () => { try { await pg.close(); } catch {} try { mem.close(); } catch {} } };
}

async function sqlRows(pg: PgClient, sql: string, params: any[]): Promise<any[]> {
  const r: any = await (pg as any).query(sql, params);
  if (Array.isArray(r)) return r;
  if (r && Array.isArray(r.rows)) return r.rows;
  return [];
}

async function main() {
  console.log("=== Phase 270 - PostgreSQL Crash/Restart Recovery ===\n");
  const url = process.env.DATABASE_URL;
  if (!url) { console.log("[BLOCKED] DATABASE_URL not set"); process.exit(0); }

  // Sc270-1: created, child killed before claim; op persists as PENDING
  section("Sc270-1 [REAL CHILD-PROCESS RESTART] op created, child killed before claim");
  {
    const jobId = uniq("sc270-1");
    const r1 = await runChild(url, "create", url, jobId, "--fault=after-create");
    ok(r1.code === 1, "Sc270-1 child exited with fault code 1", "got=" + r1.code);
    ok(r1.stderr.includes("CHILD_FAULT: after-create"), "Sc270-1 fault hook reached");

    const h = await openStore(url);
    try {
      // Child exited before emitting JSON; retrieve opId via idempotent create
      const c = await h.ops.createOrGetOperation({
        jobId, leaseId: null, workerId: "recovery", operationType: "TIMEOUT", now: Date.now(),
      });
      const opId = c.operation.operationId;
      ok(c.created === false, "Sc270-1 op already existed (child persisted it)");
      const op = await h.ops.getOperation(opId);
      ok(!!op, "Sc270-1 operation readable across process boundary");
      ok(op.state === "PENDING", "Sc270-1 state=PENDING", "got=" + op.state);
      ok(op.claimOwner == null, "Sc270-1 claim_owner null", "got=" + op.claimOwner);
    } finally { await h.close(); }
  }

  // Sc270-2: claimed, child killed before progress
  section("Sc270-2 [REAL CHILD-PROCESS RESTART] op claimed, child killed before progress");
  {
    const jobId = uniq("sc270-2");
    const r1 = await runChild(url, "claim", url, jobId, "--fault=after-claim", "--owner=child-a");
    ok(r1.code === 1, "Sc270-2 child exited with fault code 1", "got=" + r1.code);
    ok(r1.stderr.includes("CHILD_FAULT: after-claim"), "Sc270-2 fault hook reached");

    const h = await openStore(url);
    try {
      const c = await h.ops.createOrGetOperation({
        jobId, leaseId: null, workerId: "recovery", operationType: "TIMEOUT", now: Date.now(),
      });
      const op = await h.ops.getOperation(c.operation.operationId);
      ok(op.state === "CLAIMED", "Sc270-2 state=CLAIMED", "got=" + op.state);
      ok(op.claimOwner === "child-a", "Sc270-2 owner preserved", "got=" + op.claimOwner);
      ok(op.attemptCount === 1, "Sc270-2 attempt_count=1", "got=" + op.attemptCount);
    } finally { await h.close(); }
  }

  // Sc270-3: IN_PROGRESS, child killed
  section("Sc270-3 [REAL CHILD-PROCESS RESTART] op IN_PROGRESS, child killed");
  {
    const jobId = uniq("sc270-3");
    const r1 = await runChild(url, "mark-in-progress", url, jobId, "--fault=after-in-progress", "--owner=child-a");
    ok(r1.code === 1, "Sc270-3 child exited with fault code 1", "got=" + r1.code);
    ok(r1.stderr.includes("CHILD_FAULT: after-in-progress"), "Sc270-3 fault hook reached");

    const h = await openStore(url);
    try {
      const c = await h.ops.createOrGetOperation({
        jobId, leaseId: null, workerId: "recovery", operationType: "TIMEOUT", now: Date.now(),
      });
      const op = await h.ops.getOperation(c.operation.operationId);
      ok(op.state === "IN_PROGRESS", "Sc270-3 state=IN_PROGRESS", "got=" + op.state);
      ok(op.claimOwner === "child-a", "Sc270-3 owner preserved", "got=" + op.claimOwner);
    } finally { await h.close(); }
  }

  // Sc270-4: mutation committed before completion, fault hook fires
  section("Sc270-4 [IN-PROCESS FAULT INJECTION] fault after mutation commit, before op completion");
  {
    const jobId = uniq("sc270-4");
    const r1 = await runChild(url, "mark-completed", url, jobId, "--fault=before-complete", "--owner=child-a");
    ok(r1.code === 1, "Sc270-4 child exited with fault code 1", "got=" + r1.code);

    const h = await openStore(url);
    try {
      const c = await h.ops.createOrGetOperation({
        jobId, leaseId: null, workerId: "recovery", operationType: "TIMEOUT", now: Date.now(),
      });
      const op = await h.ops.getOperation(c.operation.operationId);
      ok(op.state !== "COMPLETED", "Sc270-4 op did not falsely complete", "got=" + op.state);
      ok(op.state === "IN_PROGRESS", "Sc270-4 op stays IN_PROGRESS (claim not released)", "got=" + op.state);
    } finally { await h.close(); }
  }

  // Sc270-5: expired claim reclaimed by new child
  section("Sc270-5 [REAL CHILD-PROCESS RESTART] expired claim recovered by second child");
  {
    const jobId = uniq("sc270-5");
    const r1 = await runChild(url, "claim", url, jobId, "--owner=child-a");
    ok(r1.code === 0 && r1.json?.claimed === true, "Sc270-5 child A claimed");
    const opId = r1.json?.opId;

    const h = await openStore(url);
    try {
      await (h.pg as any).query(
        "UPDATE execution_recovery_operations SET claim_expires_at = 0 WHERE operation_id = $1", [opId]
      );
    } finally { await h.close(); }

    const r2 = await runChild(url, "claim", url, jobId, "--owner=child-b");
    ok(r2.code === 0 && r2.json?.claimed === true, "Sc270-5 child B reclaimed after expiry");
    ok(r2.json?.claimOwner === "child-b", "Sc270-5 owner is child-b", "got=" + r2.json?.claimOwner);
  }

  // Sc270-6: two children compete
  section("Sc270-6 [REAL CHILD-PROCESS RESTART] two children race to claim same op");
  {
    const jobId = uniq("sc270-6");
    const rc = await runChild(url, "create", url, jobId);
    ok(rc.code === 0, "Sc270-6 setup: op created");

    const [a, b] = await Promise.all([
      runChild(url, "claim", url, jobId, "--owner=race-a"),
      runChild(url, "claim", url, jobId, "--owner=race-b"),
    ]);
    const claimedA = a.json?.claimed === true;
    const claimedB = b.json?.claimed === true;
    ok((claimedA ? 1 : 0) + (claimedB ? 1 : 0) === 1, "Sc270-6 exactly one child claimed",
       "a=" + claimedA + " b=" + claimedB);
  }

  // Sc270-7: idempotent create across 3 children
  section("Sc270-7 [REAL CHILD-PROCESS RESTART] repeated create returns same op");
  {
    const jobId = uniq("sc270-7");
    const r1 = await runChild(url, "create", url, jobId);
    const r2 = await runChild(url, "create", url, jobId);
    const r3 = await runChild(url, "create", url, jobId);
    ok(r1.json?.opId === r2.json?.opId, "Sc270-7 first and second create same opId");
    ok(r2.json?.opId === r3.json?.opId, "Sc270-7 second and third create same opId");

    const h = await openStore(url);
    try {
      const rows = await sqlRows(h.pg,
        "SELECT COUNT(*)::text AS c FROM execution_recovery_operations WHERE job_id = $1", [jobId]);
      const cnt = Number(rows[0]?.c);
      ok(cnt === 1, "Sc270-7 exactly one row", "got=" + cnt);
    } finally { await h.close(); }
  }

  // Sc270-8: stale ownership cannot finalize
  section("Sc270-8 [REAL CHILD-PROCESS RESTART] stale owner cannot finalize");
  {
    const jobId = uniq("sc270-8");
    const r1 = await runChild(url, "claim", url, jobId, "--owner=owner-a");
    const opId = r1.json?.opId;
    ok(r1.json?.claimed === true, "Sc270-8 owner-a claimed");

    const h = await openStore(url);
    try {
      await (h.pg as any).query(
        "UPDATE execution_recovery_operations SET claim_expires_at = 0 WHERE operation_id = $1", [opId]
      );
    } finally { await h.close(); }

    const r2 = await runChild(url, "claim", url, jobId, "--owner=owner-b");
    ok(r2.json?.claimed === true, "Sc270-8 owner-b reclaimed");

    const h2 = await openStore(url);
    try {
      const staleAttempt = await h2.ops.markCompleted(opId, "owner-a", Date.now());
      ok(staleAttempt === false, "Sc270-8 stale owner-a cannot finalize", "got=" + staleAttempt);
    } finally { await h2.close(); }
  }

  // Sc270-9: DB error during finalization
  section("Sc270-9 [IN-PROCESS FAULT INJECTION] DB error during finalization not reported as success");
  {
    const jobId = uniq("sc270-9");
    const r1 = await runChild(url, "mark-completed", url, jobId, "--fault=db-error", "--owner=child-a");
    ok(r1.code !== 0, "Sc270-9 child exited non-zero on DB error", "got=" + r1.code);
    ok(!r1.json?.ok, "Sc270-9 did not report success when DB failed");

    const h = await openStore(url);
    try {
      const c = await h.ops.createOrGetOperation({
        jobId, leaseId: null, workerId: "recovery", operationType: "TIMEOUT", now: Date.now(),
      });
      const op = await h.ops.getOperation(c.operation.operationId);
      ok(op && op.state !== "COMPLETED", "Sc270-9 op not marked COMPLETED despite DB error",
         "got=" + op?.state);
    } finally { await h.close(); }
  }

  console.log("\n============================================");
  console.log("PASS: " + pass);
  console.log("FAIL: " + fail);
  console.log("BLOCKED: " + blocked);
  console.log("============================================");
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exit(2); });