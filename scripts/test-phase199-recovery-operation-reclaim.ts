// scripts/test-phase199-recovery-operation-reclaim.ts
// Phase 199 P3: PostgreSQL durable recovery-operation crash/reclaim verification.

import { spawn } from "node:child_process";
import Database from "better-sqlite3";
import { PgClient } from "../src/core/pg-client";
import { PgAsyncEngine } from "../src/core/pg-async-engine";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { ExecutionEngine } from "../src/core/execution-engine";
import { LeaseManager } from "../src/core/lease-manager";
import { WorkerRegistry } from "../src/core/worker-registry";
import { RetryEngine } from "../src/core/retry-engine";
import { bootstrapPgSchema } from "../src/core/pg-bootstrap";
import { AsyncExecutionRecoveryOperationStore } from "../src/core/execution-recovery-operation-store";

let pass = 0, fail = 0, blocked = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log(`[PASSED] ${name}${detail ? "  " + detail : ""}`); }
  else      { fail++; console.log(`[FAILED] ${name}${detail ? "  " + detail : ""}`); }
}
function blk(name: string, why: string): void {
  blocked++; console.log(`[BLOCKED] ${name}  ${why}`);
}

function runChild(url: string, cmd: string, ...args: string[]): Promise<any> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ["--import", "tsx", "scripts/_phase199_reclaim_child.ts", cmd, url, ...args], {
      cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    c.stdout.on("data", (d) => { stdout += d.toString(); });
    c.stderr.on("data", (d) => { stderr += d.toString(); });
    c.on("exit", (code) => {
      const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
      let json: any = null;
      for (let i = lines.length - 1; i >= 0; i--) { try { json = JSON.parse(lines[i]); break; } catch {} }
      resolve({ code, json, stdout, stderr });
    });
  });
}

function runSqliteRegression(script: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ["--import", "tsx", script], {
      cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    c.stdout.on("data", (d) => { stdout += d.toString(); });
    c.on("exit", (code) => {
      const m = stdout.match(/PASS:\s*(\d+)[\s\S]*?FAIL:\s*(\d+)/);
      if (m) {
        console.log(`  ${script}: PASS=${m[1]} FAIL=${m[2]} exit=${code}`);
      } else {
        console.log(`  ${script}: exit=${code}`);
      }
      resolve(code === 0);
    });
  });
}

async function main(): Promise<void> {
  console.log("=== NEXUS PHASE 199 P3 ===\n");

  const url = process.env.DATABASE_URL;
  if (!url) {
    blk("PostgreSQL connectivity", "DATABASE_URL not set");
    console.log(`\nPASS: ${pass}\nFAIL: ${fail}\nBLOCKED: ${blocked}`);
    process.exitCode = 0;
    return;
  }

  const pg = new PgClient();
  try {
    await pg.connect(url);
    await pg.query("SELECT 1", []);
    ok("PostgreSQL connectivity", true);
  } catch (e: any) {
    blk("PostgreSQL connectivity", String(e?.message ?? e));
    console.log(`\nPASS: ${pass}\nFAIL: ${fail}\nBLOCKED: ${blocked}`);
    process.exitCode = 0;
    return;
  }

  try {
    await bootstrapPgSchema(pg);
    ok("Schema availability", true);
  } catch (e: any) {
    blk("Schema bootstrap", String(e?.message ?? e));
    try { await pg.close(); } catch {}
    console.log(`\nPASS: ${pass}\nFAIL: ${fail}\nBLOCKED: ${blocked}`);
    process.exitCode = 0;
    return;
  }

  const asyncDb = new PgAsyncEngine(pg);
  const ops = new AsyncExecutionRecoveryOperationStore(asyncDb);

  const uniq = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const jobId = `job_p199_${uniq}`;
  const leaseId = `lease_p199_${uniq}`;
  const operationType = "ORPHAN_RECOVERY" as any;

  // P1 — create
  const created = await ops.createOrGetOperation({ jobId, leaseId, workerId: "worker-A", operationType });
  ok("P1 create operation state=PENDING", created.operation.state === "PENDING", `state=${created.operation.state}`);
  const opId = created.operation.operationId;

  // P2 — Worker A claims
  const tA = Date.now();
  const claimA = await ops.claimOperation({ operationId: opId, owner: "worker-A", durationMs: 1000, now: tA });
  ok("P2 Worker A claim", claimA.claimed === true, `claimed=${claimA.claimed}`);

  // P3 — mark IN_PROGRESS
  const ipA = await ops.markInProgress(opId, "worker-A", tA);
  ok("P3 Worker A markInProgress", ipA === true, `ok=${ipA}`);

  // P4 — simulate crash: wait for TTL to elapse
  await new Promise((r) => setTimeout(r, 1300));
  const opAfterWait = await ops.getOperation(opId);
  ok("P4 claim expired (state IN_PROGRESS, claim still attributed)",
     opAfterWait?.state === "IN_PROGRESS" && opAfterWait?.claimOwner === "worker-A",
     `state=${opAfterWait?.state} owner=${opAfterWait?.claimOwner}`);

  // P5 — Worker B discovery via production list methods
  const incomplete = await ops.listIncompleteOperations();
  ok("P5 listIncompleteOperations finds abandoned op", incomplete.some((o) => o.operationId === opId));
  const resumable = await ops.listResumableOperations();
  ok("P5 listResumableOperations finds abandoned op", resumable.some((o) => o.operationId === opId));

  // P6 — Worker B reclaims
  const tB = Date.now();
  const claimB = await ops.claimOperation({ operationId: opId, owner: "worker-B", durationMs: 60_000, now: tB });
  ok("P6 Worker B reclaim", claimB.claimed === true, `claimed=${claimB.claimed}`);
  const ipB = await ops.markInProgress(opId, "worker-B", tB);
  ok("P6 Worker B markInProgress", ipB === true, `ok=${ipB}`);

  // P7 — Worker A stale mutations must be rejected
  const tNow = Date.now();
  const staleComplete = await ops.markCompleted(opId, "worker-A", tNow);
  ok("P7 Worker A markCompleted rejected", staleComplete === false, `ok=${staleComplete}`);
  const staleFailed = await ops.markFailed(opId, "worker-A", "stale attempt", tNow);
  ok("P7 Worker A markFailed rejected", staleFailed === false);
  const staleRequired = await ops.markRecoveryRequired(opId, "worker-A", "stale attempt", tNow);
  ok("P7 Worker A markRecoveryRequired rejected", staleRequired === false);
  const afterStale = await ops.getOperation(opId);
  ok("P7 state remains IN_PROGRESS owned by Worker B",
     afterStale?.state === "IN_PROGRESS" && afterStale?.claimOwner === "worker-B",
     `state=${afterStale?.state} owner=${afterStale?.claimOwner}`);

  // P8 — Worker B completes
  const completeB = await ops.markCompleted(opId, "worker-B", Date.now());
  ok("P8 Worker B markCompleted", completeB === true, `ok=${completeB}`);
  const finalOp = await ops.getOperation(opId);
  ok("P8 final state=COMPLETED", finalOp?.state === "COMPLETED", `state=${finalOp?.state}`);
  ok("P8 completed_at set", finalOp?.completedAt != null, `completed_at=${finalOp?.completedAt}`);

  // P9 — idempotency
  const idem = await ops.createOrGetOperation({ jobId, leaseId, workerId: "worker-A", operationType });
  ok("P9 createOrGet idempotent", idem.created === false && idem.operation.operationId === opId,
     `created=${idem.created}`);
  const claimCompleted = await ops.claimOperation({ operationId: opId, owner: "worker-C", durationMs: 60_000 });
  ok("P9 claim on COMPLETED rejected", claimCompleted.claimed === false, `claimed=${claimCompleted.claimed}`);

  // P10 — reconciler-level test
  const jobId2 = `job_p199_recon_${uniq}`;
  const leaseId2 = `lease_p199_recon_${uniq}`;
  const now2 = Date.now();
  await pg.query(
    "INSERT INTO execution_jobs (id, idempotency_key, job_type, payload, status, created_at, updated_at) " +
    "VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [jobId2, `idem_${jobId2}`, "execution", "{}", "QUEUED", now2, now2],
  );
  const op2 = await ops.createOrGetOperation({ jobId: jobId2, leaseId: leaseId2, workerId: "worker-A", operationType });
  const tSeed = Date.now();
  await ops.claimOperation({ operationId: op2.operation.operationId, owner: "worker-A", durationMs: 500, now: tSeed });
  await ops.markInProgress(op2.operation.operationId, "worker-A", tSeed);
  await new Promise((r) => setTimeout(r, 800));   // claim expires

  const mem = new Database(":memory:");
  const syncEngine = SQLiteEngine.fromDatabase(mem);
  const store = new ExecutionStore(syncEngine, asyncDb);
  const leases = new LeaseManager(store);
  const workerRegistry = new WorkerRegistry(store, leases as any);
  const retryEngine = new RetryEngine();
  const deps = { events: { emit: () => undefined } } as any;
  const engine = new ExecutionEngine(store, workerRegistry, leases, retryEngine, deps);

  ok("P10 store reports hasAsyncBackend", store.hasAsyncBackend() === true);

  await engine.recoverStaleJobs(Date.now());

  const afterReconcile = await ops.getOperation(op2.operation.operationId);
  ok("P10 reconciler finalized abandoned op",
     afterReconcile?.state === "COMPLETED",
     `state=${afterReconcile?.state}`);

  // P11 — concurrent reclaim across two independent processes
  const jobId3 = `job_p199_race_${uniq}`;
  const leaseId3 = `lease_p199_race_${uniq}`;
  const op3 = await ops.createOrGetOperation({ jobId: jobId3, leaseId: leaseId3, workerId: "worker-A", operationType });
  const tRace = Date.now();
  await ops.claimOperation({ operationId: op3.operation.operationId, owner: "seed", durationMs: 200, now: tRace });
  await ops.markInProgress(op3.operation.operationId, "seed", tRace);
  await new Promise((r) => setTimeout(r, 400));   // claim expires

  const [r1, r2] = await Promise.all([
    runChild(url, "claim", op3.operation.operationId, "racer-1", "60000"),
    runChild(url, "claim", op3.operation.operationId, "racer-2", "60000"),
  ]);
  const winners = [r1, r2].filter((r) => r.json?.claimed === true).length;
  ok("P11 concurrent reclaim: exactly one winner", winners === 1,
     `winners=${winners} r1=${r1.json?.claimed} r2=${r2.json?.claimed}`);

  // P12 — restart durability
  try { await pg.close(); } catch {}
  const pg2 = new PgClient();
  await pg2.connect(url);
  const asyncDb2 = new PgAsyncEngine(pg2);
  const ops2 = new AsyncExecutionRecoveryOperationStore(asyncDb2);
  const afterRestart = await ops2.getOperation(opId);
  ok("P12 restart durability: state readable",
     afterRestart?.state === "COMPLETED",
     `state=${afterRestart?.state}`);
  const afterRestartRace = await ops2.getOperation(op3.operation.operationId);
  ok("P12 restart durability: race op owned by racer",
     afterRestartRace?.claimOwner === "racer-1" || afterRestartRace?.claimOwner === "racer-2",
     `owner=${afterRestartRace?.claimOwner}`);
  try { await pg2.close(); } catch {}

  // SQLite regression
  console.log("\n--- SQLite regression ---");
  const sqliteScripts = [
    "scripts/test-phase144-durable-recovery-operations.ts",
    "scripts/test-phase157-recovery-operation-idempotency.ts",
    "scripts/test-phase178-recovery-operations-control.ts",
    "scripts/test-phase197-stall-recovery.ts",
    "scripts/test-phase198-ownership.ts",
  ];
  let allGreen = true;
  for (const s of sqliteScripts) {
    const okScript = await runSqliteRegression(s);
    if (!okScript) allGreen = false;
  }
  ok("SQLite regression aggregate", allGreen);

  console.log(`\nPASS: ${pass}\nFAIL: ${fail}\nBLOCKED: ${blocked}`);
  process.exitCode = fail > 0 || blocked > 0 ? 1 : 0;
}

main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exitCode = 2; });