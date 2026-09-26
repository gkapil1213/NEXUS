// scripts/test-phase200-recovery-finalization.ts
// Phase 200: durable recovery-execution finalization.
// Tests the reconciler against explicit crash-boundary states on both
// SQLite (in-process) and PostgreSQL (via DATABASE_URL).

import Database from "better-sqlite3";
import { join } from "path";
import { spawn } from "node:child_process";
import { PgClient } from "../src/core/pg-client";
import { PgAsyncEngine } from "../src/core/pg-async-engine";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { ExecutionEngine } from "../src/core/execution-engine";
import { MigrationRunner } from "../src/core/migration-runner";
import { bootstrapPgSchema } from "../src/core/pg-bootstrap";

let pass = 0, fail = 0, blocked = 0;
function ok(name: string, cond: boolean, d = ""): void {
  if (cond) { pass++; console.log(`[PASSED] ${name}${d ? "  " + d : ""}`); }
  else      { fail++; console.log(`[FAILED] ${name}${d ? "  " + d : ""}`); }
}
function blk(name: string, why: string): void {
  blocked++; console.log(`[BLOCKED] ${name}  ${why}`);
}

const MIG_DIR = join(process.cwd(), "src", "db", "migrations");
const deps = { events: { emit: () => undefined } } as any;

function makeSQLiteEngine() {
  const rawDb = new Database(":memory:");
  new MigrationRunner(rawDb, MIG_DIR).run();
  const syncEngine = SQLiteEngine.fromDatabase(rawDb);
  return { rawDb, syncEngine };
}

function seedJobAndLease(rawDb: any, s: {
  jobId: string; jobStatus: string; leaseId: string;
  leaseStatus?: string; retryPolicy?: any;
}) {
  const now = Date.now();
  const rp = s.retryPolicy ? JSON.stringify(s.retryPolicy) : null;
  const leaseStatus = s.leaseStatus ?? "EXPIRED";
  const exp = leaseStatus === "EXPIRED" ? now - 1000 : now + 60000;
  rawDb.prepare(
    "INSERT INTO execution_jobs (id, idempotency_key, job_type, payload, status, retry_policy, created_at, updated_at) " +
    "VALUES (?, ?, 'engineering', '{}', ?, ?, ?, ?)"
  ).run(s.jobId, `k_${s.jobId}`, s.jobStatus, rp, now, now);
  rawDb.prepare(
    "INSERT INTO execution_leases (lease_id, job_id, worker_id, acquired_at, expires_at, status) " +
    "VALUES (?, ?, 'worker-A', ?, ?, ?)"
  ).run(s.leaseId, s.jobId, now - 5000, exp, leaseStatus);
}

function seedOpWithState(store: any, s: {
  jobId: string; leaseId: string; opType: string;
  opState: "PENDING" | "CLAIMED" | "IN_PROGRESS";
  claimExpired?: boolean;
}): string {
  const created = store.recoveryOps.createOrGetOperation({
    jobId: s.jobId, leaseId: s.leaseId, workerId: "worker-A", operationType: s.opType,
  });
  const opId = created.operation.operationId;
  if (s.opState === "PENDING") return opId;

  const claimNow = s.claimExpired ? Date.now() - 10_000 : Date.now();
  const dur = s.claimExpired ? 1000 : 60000;
  store.recoveryOps.claimOperation({ operationId: opId, owner: "worker-A", durationMs: dur, now: claimNow });
  if (s.opState === "CLAIMED") return opId;
  store.recoveryOps.markInProgress(opId, "worker-A", claimNow);
  return opId;
}

function getOp(rawDb: any, opId: string) {
  return rawDb.prepare("SELECT state FROM execution_recovery_operations WHERE operation_id = ?").get(opId) as any;
}
function getJob(rawDb: any, jobId: string) {
  return rawDb.prepare("SELECT status FROM execution_jobs WHERE id = ?").get(jobId) as any;
}

async function seedJobAndLeasePG(pg: PgClient, s: {
  jobId: string; jobStatus: string; leaseId: string;
  leaseStatus?: string; retryPolicy?: any;
}) {
  const now = Date.now();
  const rp = s.retryPolicy ? JSON.stringify(s.retryPolicy) : null;
  const leaseStatus = s.leaseStatus ?? "EXPIRED";
  const exp = leaseStatus === "EXPIRED" ? now - 1000 : now + 60000;
  await (pg as any).query(
    "INSERT INTO execution_jobs (id, idempotency_key, job_type, payload, status, retry_policy, created_at, updated_at) " +
    "VALUES ($1, $2, 'engineering', '{}', $3, $4, $5, $6)",
    [s.jobId, `k_${s.jobId}`, s.jobStatus, rp, now, now]
  );
  await (pg as any).query(
    "INSERT INTO execution_leases (lease_id, job_id, worker_id, acquired_at, expires_at, status) " +
    "VALUES ($1, $2, 'worker-A', $3, $4, $5)",
    [s.leaseId, s.jobId, now - 5000, exp, leaseStatus]
  );
}

async function seedOpWithStatePG(store: any, s: {
  jobId: string; leaseId: string; opType: string;
  opState: "PENDING" | "CLAIMED" | "IN_PROGRESS";
  claimExpired?: boolean;
}): Promise<string> {
  const created = await store.recoveryOpsAsync.createOrGetOperation({
    jobId: s.jobId, leaseId: s.leaseId, workerId: "worker-A", operationType: s.opType,
  });
  const opId = created.operation.operationId;
  if (s.opState === "PENDING") return opId;
  const claimNow = s.claimExpired ? Date.now() - 10_000 : Date.now();
  const dur = s.claimExpired ? 1000 : 60000;
  await store.recoveryOpsAsync.claimOperation({ operationId: opId, owner: "worker-A", durationMs: dur, now: claimNow });
  if (s.opState === "CLAIMED") return opId;
  await store.recoveryOpsAsync.markInProgress(opId, "worker-A", claimNow);
  return opId;
}

function pickRows(r: any): any[] {
  return Array.isArray(r) ? r : (r?.rows ?? []);
}

// ====================================================================
async function sqliteSuite(): Promise<void> {
  console.log("=== Phase 200 SQLite finalization ===\n");

  // S1 — Crash A: PENDING op, ORPHANED job, retry allowed
  {
    const { rawDb, syncEngine } = makeSQLiteEngine();
    const store = new ExecutionStore(syncEngine as any);
    const engine = new ExecutionEngine(store, {} as any, {} as any, {} as any, deps);
    const jobId = "j_s1", leaseId = "lease_j_s1";
    seedJobAndLease(rawDb, { jobId, jobStatus: "ORPHANED", leaseId, retryPolicy: { maxAttempts: 3, initialDelayMs: 100 } });
    const opId = seedOpWithState(store, { jobId, leaseId, opType: "ORPHAN_RECOVERY", opState: "PENDING" });
    await engine.reconcileExecutionRecoveryOperations();
    ok("S1 Crash A: op COMPLETED", getOp(rawDb, opId)?.state === "COMPLETED", `state=${getOp(rawDb, opId)?.state}`);
    ok("S1 Crash A: job QUEUED", getJob(rawDb, jobId)?.status === "QUEUED", `status=${getJob(rawDb, jobId)?.status}`);
  }

  // S2 — Crash B: CLAIMED with expired claim
  {
    const { rawDb, syncEngine } = makeSQLiteEngine();
    const store = new ExecutionStore(syncEngine as any);
    const engine = new ExecutionEngine(store, {} as any, {} as any, {} as any, deps);
    const jobId = "j_s2", leaseId = "lease_j_s2";
    seedJobAndLease(rawDb, { jobId, jobStatus: "ORPHANED", leaseId, retryPolicy: { maxAttempts: 3, initialDelayMs: 100 } });
    const opId = seedOpWithState(store, { jobId, leaseId, opType: "ORPHAN_RECOVERY", opState: "CLAIMED", claimExpired: true });
    await engine.reconcileExecutionRecoveryOperations();
    ok("S2 Crash B: op COMPLETED", getOp(rawDb, opId)?.state === "COMPLETED", `state=${getOp(rawDb, opId)?.state}`);
    ok("S2 Crash B: job QUEUED", getJob(rawDb, jobId)?.status === "QUEUED", `status=${getJob(rawDb, jobId)?.status}`);
  }

  // S3 — Crash C: IN_PROGRESS, expired claim, job RUNNING (TIMEOUT step1)
  {
    const { rawDb, syncEngine } = makeSQLiteEngine();
    const store = new ExecutionStore(syncEngine as any);
    const engine = new ExecutionEngine(store, {} as any, {} as any, {} as any, deps);
    const jobId = "j_s3", leaseId = "lease_j_s3";
    seedJobAndLease(rawDb, { jobId, jobStatus: "RUNNING", leaseId, leaseStatus: "ACTIVE", retryPolicy: { maxAttempts: 3, initialDelayMs: 100 } });
    const opId = seedOpWithState(store, { jobId, leaseId, opType: "TIMEOUT", opState: "IN_PROGRESS", claimExpired: true });
    await engine.reconcileExecutionRecoveryOperations();
    ok("S3 Crash C step1: job FAILED", getJob(rawDb, jobId)?.status === "FAILED", `status=${getJob(rawDb, jobId)?.status}`);
    ok("S3 Crash C step1: op COMPLETED", getOp(rawDb, opId)?.state === "COMPLETED", `state=${getOp(rawDb, opId)?.state}`);
  }

  // S3b — Crash D for TIMEOUT: IN_PROGRESS, job FAILED (step2)
  {
    const { rawDb, syncEngine } = makeSQLiteEngine();
    const store = new ExecutionStore(syncEngine as any);
    const engine = new ExecutionEngine(store, {} as any, {} as any, {} as any, deps);
    const jobId = "j_s3b", leaseId = "lease_j_s3b";
    seedJobAndLease(rawDb, { jobId, jobStatus: "FAILED", leaseId, retryPolicy: { maxAttempts: 3, initialDelayMs: 100 } });
    const opId = seedOpWithState(store, { jobId, leaseId, opType: "TIMEOUT", opState: "IN_PROGRESS", claimExpired: true });
    await engine.reconcileExecutionRecoveryOperations();
    ok("S3b step2: job RETRY_SCHEDULED", getJob(rawDb, jobId)?.status === "RETRY_SCHEDULED", `status=${getJob(rawDb, jobId)?.status}`);
    ok("S3b step2: op COMPLETED", getOp(rawDb, opId)?.state === "COMPLETED", `state=${getOp(rawDb, opId)?.state}`);
  }

  // S4 — Crash D: IN_PROGRESS, job already QUEUED (ORPHAN_RECOVERY finalization)
  {
    const { rawDb, syncEngine } = makeSQLiteEngine();
    const store = new ExecutionStore(syncEngine as any);
    const engine = new ExecutionEngine(store, {} as any, {} as any, {} as any, deps);
    const jobId = "j_s4", leaseId = "lease_j_s4";
    seedJobAndLease(rawDb, { jobId, jobStatus: "QUEUED", leaseId });
    const opId = seedOpWithState(store, { jobId, leaseId, opType: "ORPHAN_RECOVERY", opState: "IN_PROGRESS", claimExpired: true });
    await engine.reconcileExecutionRecoveryOperations();
    ok("S4 Crash D-orphan: op COMPLETED", getOp(rawDb, opId)?.state === "COMPLETED", `state=${getOp(rawDb, opId)?.state}`);
  }

  // S5 — Crash D: IN_PROGRESS, job RETRY_SCHEDULED (TIMEOUT)
  {
    const { rawDb, syncEngine } = makeSQLiteEngine();
    const store = new ExecutionStore(syncEngine as any);
    const engine = new ExecutionEngine(store, {} as any, {} as any, {} as any, deps);
    const jobId = "j_s5", leaseId = "lease_j_s5";
    seedJobAndLease(rawDb, { jobId, jobStatus: "RETRY_SCHEDULED", leaseId });
    const opId = seedOpWithState(store, { jobId, leaseId, opType: "TIMEOUT", opState: "IN_PROGRESS", claimExpired: true });
    await engine.reconcileExecutionRecoveryOperations();
    ok("S5 Crash D-timeout: op COMPLETED", getOp(rawDb, opId)?.state === "COMPLETED", `state=${getOp(rawDb, opId)?.state}`);
  }

  // S6 — Crash D: IN_PROGRESS, job CANCELLED (CANCELLATION)
  {
    const { rawDb, syncEngine } = makeSQLiteEngine();
    const store = new ExecutionStore(syncEngine as any);
    const engine = new ExecutionEngine(store, {} as any, {} as any, {} as any, deps);
    const jobId = "j_s6", leaseId = "lease_j_s6";
    seedJobAndLease(rawDb, { jobId, jobStatus: "CANCELLED", leaseId });
    const opId = seedOpWithState(store, { jobId, leaseId, opType: "CANCELLATION", opState: "IN_PROGRESS", claimExpired: true });
    await engine.reconcileExecutionRecoveryOperations();
    ok("S6 Crash D-cancel: op COMPLETED", getOp(rawDb, opId)?.state === "COMPLETED", `state=${getOp(rawDb, opId)?.state}`);
  }

  // S7 — Idempotency: 3 reconciles, no duplicates
  {
    const { rawDb, syncEngine } = makeSQLiteEngine();
    const store = new ExecutionStore(syncEngine as any);
    const engine = new ExecutionEngine(store, {} as any, {} as any, {} as any, deps);
    const jobId = "j_s7", leaseId = "lease_j_s7";
    seedJobAndLease(rawDb, { jobId, jobStatus: "ORPHANED", leaseId, retryPolicy: { maxAttempts: 3, initialDelayMs: 100 } });
    const opId = seedOpWithState(store, { jobId, leaseId, opType: "ORPHAN_RECOVERY", opState: "PENDING" });
    await engine.reconcileExecutionRecoveryOperations();
    await engine.reconcileExecutionRecoveryOperations();
    await engine.reconcileExecutionRecoveryOperations();
    const opRows = rawDb.prepare("SELECT COUNT(*) AS c FROM execution_recovery_operations WHERE job_id = ?").get(jobId) as any;
    const reqEvents = rawDb.prepare("SELECT COUNT(*) AS c FROM execution_events WHERE job_id = ? AND event_type = 'execution.recovery.requeued'").get(jobId) as any;
    ok("S7 idempotency: op COMPLETED", getOp(rawDb, opId)?.state === "COMPLETED", `state=${getOp(rawDb, opId)?.state}`);
    ok("S7 idempotency: exactly one op row", Number(opRows?.c) === 1, `count=${opRows?.c}`);
    ok("S7 idempotency: one requeued event", Number(reqEvents?.c) === 1, `count=${reqEvents?.c}`);
  }

  // S8 — Retry exhaustion: op IN_PROGRESS, job FAILED, no retry budget
  {
    const { rawDb, syncEngine } = makeSQLiteEngine();
    const store = new ExecutionStore(syncEngine as any);
    const engine = new ExecutionEngine(store, {} as any, {} as any, {} as any, deps);
    const jobId = "j_s8", leaseId = "lease_j_s8";
    seedJobAndLease(rawDb, { jobId, jobStatus: "FAILED", leaseId, retryPolicy: { maxAttempts: 0, initialDelayMs: 0 } });
    const opId = seedOpWithState(store, { jobId, leaseId, opType: "TIMEOUT", opState: "IN_PROGRESS", claimExpired: true });
    await engine.reconcileExecutionRecoveryOperations();
    const job = getJob(rawDb, jobId);
    const op = getOp(rawDb, opId);
    ok("S8 exhaustion: job DEAD_LETTER", job?.status === "DEAD_LETTER", `status=${job?.status}`);
    ok("S8 exhaustion: op terminal",
       op?.state === "COMPLETED" || op?.state === "RECOVERY_REQUIRED",
       `state=${op?.state}`);
  }

  // S9 — Terminal no-resurrect
  {
    const { rawDb, syncEngine } = makeSQLiteEngine();
    const store = new ExecutionStore(syncEngine as any);
    const engine = new ExecutionEngine(store, {} as any, {} as any, {} as any, deps);
    const jobId = "j_s9", leaseId = "lease_j_s9";
    seedJobAndLease(rawDb, { jobId, jobStatus: "QUEUED", leaseId });
    const opId = seedOpWithState(store, { jobId, leaseId, opType: "ORPHAN_RECOVERY", opState: "PENDING" });
    await engine.reconcileExecutionRecoveryOperations();
    const before = getJob(rawDb, jobId)?.status;
    await engine.reconcileExecutionRecoveryOperations();
    await engine.reconcileExecutionRecoveryOperations();
    ok("S9 terminal: job unchanged", getJob(rawDb, jobId)?.status === before, `before=${before} after=${getJob(rawDb, jobId)?.status}`);
    ok("S9 terminal: op COMPLETED", getOp(rawDb, opId)?.state === "COMPLETED", `state=${getOp(rawDb, opId)?.state}`);
  }

  // S10 — Lease consistency post-reconcile
  {
    const { rawDb, syncEngine } = makeSQLiteEngine();
    const store = new ExecutionStore(syncEngine as any);
    const engine = new ExecutionEngine(store, {} as any, {} as any, {} as any, deps);
    const jobId = "j_s10", leaseId = "lease_j_s10";
    seedJobAndLease(rawDb, { jobId, jobStatus: "ORPHANED", leaseId, leaseStatus: "EXPIRED", retryPolicy: { maxAttempts: 3, initialDelayMs: 100 } });
    seedOpWithState(store, { jobId, leaseId, opType: "ORPHAN_RECOVERY", opState: "PENDING" });
    await engine.reconcileExecutionRecoveryOperations();
    const lease = rawDb.prepare("SELECT status FROM execution_leases WHERE lease_id = ?").get(leaseId) as any;
    ok("S10 lease not ACTIVE after finalization", lease?.status !== "ACTIVE", `status=${lease?.status}`);
  }
}

// ====================================================================
async function pgSuite(url: string): Promise<void> {
  console.log("\n=== Phase 200 PostgreSQL finalization ===\n");

  const pg = new PgClient();
  await pg.connect(url);
  await bootstrapPgSchema(pg);
  ok("PG connectivity", true);

  const asyncDb = new PgAsyncEngine(pg);

  // Memory DB with migrations so sync fallbacks inside recoveryCanRetry etc. work
  const mem = new Database(":memory:");
  new MigrationRunner(mem, MIG_DIR).run();
  const syncEngine = SQLiteEngine.fromDatabase(mem);
  const store = new ExecutionStore(syncEngine as any, asyncDb);
  const engine = new ExecutionEngine(store, {} as any, {} as any, {} as any, deps);

  const uniq = Date.now().toString(36);
  const mk = (n: string) => `pg_${n}_${uniq}`;

  // P1 — Crash A on PG
  {
    const jobId = mk("s1"), leaseId = mk("lease_s1");
    await seedJobAndLeasePG(pg, { jobId, jobStatus: "ORPHANED", leaseId, retryPolicy: { maxAttempts: 3, initialDelayMs: 100 } });
    const opId = await seedOpWithStatePG(store, { jobId, leaseId, opType: "ORPHAN_RECOVERY", opState: "PENDING" });
    await engine.reconcileExecutionRecoveryOperations();
    const r = pickRows(await (pg as any).query("SELECT state FROM execution_recovery_operations WHERE operation_id = $1", [opId]));
    const jr = pickRows(await (pg as any).query("SELECT status FROM execution_jobs WHERE id = $1", [jobId]));
    ok("PG Crash A: op COMPLETED", r[0]?.state === "COMPLETED", `state=${r[0]?.state}`);
    ok("PG Crash A: job QUEUED", jr[0]?.status === "QUEUED", `status=${jr[0]?.status}`);
  }

  // P2 — Crash D on PG
  {
    const jobId = mk("s2"), leaseId = mk("lease_s2");
    await seedJobAndLeasePG(pg, { jobId, jobStatus: "QUEUED", leaseId });
    const opId = await seedOpWithStatePG(store, { jobId, leaseId, opType: "ORPHAN_RECOVERY", opState: "IN_PROGRESS", claimExpired: true });
    await engine.reconcileExecutionRecoveryOperations();
    const r = pickRows(await (pg as any).query("SELECT state FROM execution_recovery_operations WHERE operation_id = $1", [opId]));
    ok("PG Crash D: op finalized", r[0]?.state === "COMPLETED", `state=${r[0]?.state}`);
  }

  // P3 — 3-way concurrent reclaim via Phase 199 child
  {
    const jobId = mk("s3"), leaseId = mk("lease_s3");
    await seedJobAndLeasePG(pg, { jobId, jobStatus: "ORPHANED", leaseId, retryPolicy: { maxAttempts: 3, initialDelayMs: 100 } });
    const opId = await seedOpWithStatePG(store, { jobId, leaseId, opType: "ORPHAN_RECOVERY", opState: "IN_PROGRESS", claimExpired: true });
    const childPromise = (owner: string) => new Promise<any>((resolve) => {
      const c = spawn(process.execPath, ["--import", "tsx", "scripts/_phase199_reclaim_child.ts", "claim", url, opId, owner, "60000"], {
        cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      c.stdout.on("data", (d) => { out += d.toString(); });
      c.on("exit", () => {
        const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
        let json: any = null;
        for (let i = lines.length - 1; i >= 0; i--) { try { json = JSON.parse(lines[i]); break; } catch {} }
        resolve(json);
      });
    });
    const [r1, r2, r3] = await Promise.all([childPromise("r1"), childPromise("r2"), childPromise("r3")]);
    const winners = [r1, r2, r3].filter((r) => r?.claimed === true).length;
    ok("PG 3-way race: exactly one winner", winners === 1, `winners=${winners}`);
  }

  // P4 — Restart durability
  {
    const jobId = mk("s4"), leaseId = mk("lease_s4");
    await seedJobAndLeasePG(pg, { jobId, jobStatus: "ORPHANED", leaseId, retryPolicy: { maxAttempts: 3, initialDelayMs: 100 } });
    const opId = await seedOpWithStatePG(store, { jobId, leaseId, opType: "ORPHAN_RECOVERY", opState: "PENDING" });
    await engine.reconcileExecutionRecoveryOperations();

    const pg2 = new PgClient();
    await pg2.connect(url);
    try {
      const r = pickRows(await (pg2 as any).query("SELECT state FROM execution_recovery_operations WHERE operation_id = $1", [opId]));
      ok("PG restart: op COMPLETED durable", r[0]?.state === "COMPLETED", `state=${r[0]?.state}`);
    } finally {
      try { await pg2.close(); } catch {}
    }
  }

  // P5 — Execution consistency
  {
    const jobId = mk("s5"), leaseId = mk("lease_s5");
    await seedJobAndLeasePG(pg, { jobId, jobStatus: "ORPHANED", leaseId, retryPolicy: { maxAttempts: 3, initialDelayMs: 100 }, leaseStatus: "EXPIRED" });
    await seedOpWithStatePG(store, { jobId, leaseId, opType: "ORPHAN_RECOVERY", opState: "PENDING" });
    await engine.reconcileExecutionRecoveryOperations();
    const r = pickRows(await (pg as any).query("SELECT status FROM execution_leases WHERE lease_id = $1", [leaseId]));
    ok("PG execution consistency: lease not ACTIVE", r[0]?.status !== "ACTIVE", `status=${r[0]?.status}`);
  }

  try { await pg.close(); } catch {}
  try { mem.close(); } catch {}
}

// ====================================================================
async function main() {
  console.log("=== NEXUS PHASE 200 RECOVERY FINALIZATION ===\n");

  await sqliteSuite();

  const url = process.env.DATABASE_URL;
  if (!url) {
    blk("PostgreSQL suite", "DATABASE_URL not set");
  } else {
    try {
      await pgSuite(url);
    } catch (e: any) {
      blk("PostgreSQL suite", String(e?.message ?? e));
    }
  }

  console.log(`\nPASS: ${pass}\nFAIL: ${fail}\nBLOCKED: ${blocked}`);
  process.exitCode = (fail > 0 || blocked > 0) ? 1 : 0;
}
main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exitCode = 2; });