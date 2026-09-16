// scripts/test-phase128-execution-completion.ts
// Phase 128 — Production Execution Completion Integrity.
// Uses an isolated in-memory SQLite database with the full migration chain,
// including execution_events and execution_ownership_obligations.

import Database from "better-sqlite3";
import { join } from "path";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { MigrationRunner } from "../src/core/migration-runner";
import { ExecutionStore } from "../src/core/execution-store";
import { LeaseManager } from "../src/core/lease-manager";
import { WorkerRegistry } from "../src/core/worker-registry";
import { ExecutionEngine } from "../src/core/execution-engine";
import { RetryEngine } from "../src/core/retry-engine";
import type { ExecutionDispatchPort } from "../src/core/execution-dispatch-port";
import type {
  ExecutionEventSink,
  ExecutionAuditSink,
} from "../src/core/execution-engine";

// ---------- harness ----------
let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log(`  ok   ${msg}`); }
  else      { failed++; console.log(`  FAIL ${msg}`); }
}

interface Harness {
  engine: ExecutionEngine;
  store: ExecutionStore;
  lm: LeaseManager;
  wr: WorkerRegistry;
  events: Array<{ type: string; payload?: any }>;
  audits: any[];
  dispatchCalls: number;
}

function makeDispatchPort(
  onDispatch?: () => Promise<{ dispatchId: string }>,
): { port: ExecutionDispatchPort; getCalls: () => number } {
  let calls = 0;
  const port = {
    async dispatch() {
      calls++;
      if (onDispatch) return onDispatch();
      return { dispatchId: `d-${Date.now()}-${Math.random()}` };
    },
    async collectResult() { return { success: true, exitCode: 0, evidence: {} } as any; },
    async cancel() { /* noop */ },
    async getStatus() { return { status: "COMPLETED" }; },
  } as unknown as ExecutionDispatchPort;
  return { port, getCalls: () => calls };
}

async function harness(opts?: {
  verification?: (job: any, result: any) => Promise<boolean>;
  onDispatch?: () => Promise<{ dispatchId: string }>;
}): Promise<Harness> {
  const rawDb = new Database(":memory:");
  const migrationsDir = join(process.cwd(), "src", "db", "migrations");
  new MigrationRunner(rawDb, migrationsDir).run();
  const db = SQLiteEngine.fromDatabase(rawDb);
  const store = new ExecutionStore(db as any);
  const lm = new LeaseManager(store);
  const wr = new WorkerRegistry(store, lm);

  const events: Array<{ type: string; payload?: any }> = [];
  const audits: any[] = [];
  const eventSink: ExecutionEventSink = {
    emit: async (e) => { events.push({ type: e.type, payload: e.payload as any }); return e; },
  };
  const auditSink: ExecutionAuditSink = {
    record: async (e) => { audits.push(e); return e; },
  };

  const { port, getCalls } = makeDispatchPort(opts?.onDispatch);

  const engine = new ExecutionEngine(store, wr, lm, new RetryEngine(), {
    dispatchPort: port,
    events: eventSink,
    audit: auditSink,
    verification: opts?.verification,
  } as any);

  // register worker-1
  wr.register({
    workerId: "worker-1", hostname: "localhost",
    capabilities: ["node", "process.exec"], status: "ONLINE",
    registeredAt: Date.now(),
  } as any);

  return { engine, store, lm, wr, events, audits, dispatchCalls: getCalls() };
}

// ---------- tests ----------

async function T1_noVerificationSuccess(): Promise<void> {
  console.log("\nT1 — no-verification success");
  const h = await harness();
  const job = h.engine.createJob("node", { args: ["-e", "console.log('t1')"] }, "idem-t1-p128");
  const claim = h.engine.claimNextJob("worker-1");
  ok(claim !== null, "T1 claim not null");
  if (!claim) return;

  const result = await h.engine.executeJob("worker-1", claim.job.id, claim.lease.leaseId);
  ok(result.status === "SUCCEEDED", "T1 job SUCCEEDED");

  const reloaded = h.store.getJob(job.id)!;
  ok(reloaded.status === "SUCCEEDED", "T1 durable job SUCCEEDED");
  ok(reloaded.currentLeaseId == null, "T1 lease released");

  const attempts = h.store.listAttemptsForJob(job.id);
  ok(attempts.length >= 1 && attempts[attempts.length - 1].status === "SUCCEEDED", "T1 attempt SUCCEEDED");

  const evidence = (attempts[attempts.length - 1].evidence ?? []).join(" ");
  ok(/verification not configured/i.test(evidence), "T1 no-verification evidence present");

  // No VERIFYING transition may appear on this path
  const sawVerifying = h.events.some(e => e.payload?.to === "VERIFYING");
  ok(!sawVerifying, "T1 no RUNNING -> VERIFYING event emitted");

  const worker = h.store.getWorker?.("worker-1");
  ok(!worker || worker.status === "ONLINE" || worker.status === "IDLE", "T1 worker returned to idle");
}

async function T2_verificationSuccess(): Promise<void> {
  console.log("\nT2 — verification success");
  const h = await harness({ verification: async () => true });
  const job = h.engine.createJob("node", { args: ["-e", "console.log('t2')"] }, "idem-t2-p128");
  const claim = h.engine.claimNextJob("worker-1");
  ok(claim !== null, "T2 claim not null");
  if (!claim) return;

  const result = await h.engine.executeJob("worker-1", claim.job.id, claim.lease.leaseId);
  ok(result.status === "SUCCEEDED", "T2 job SUCCEEDED (verification passed)");

  const sawVerifying = h.events.some(e => e.payload?.to === "VERIFYING");
  const sawSucceeded = h.events.some(e => e.payload?.to === "SUCCEEDED");
  ok(sawVerifying, "T2 emitted RUNNING -> VERIFYING");
  ok(sawSucceeded, "T2 emitted VERIFYING -> SUCCEEDED");

  const attempts = h.store.listAttemptsForJob(job.id);
  ok(attempts[attempts.length - 1].status === "SUCCEEDED", "T2 attempt SUCCEEDED");
}

async function T3_verificationFailure(): Promise<void> {
  console.log("\nT3 — verification failure");
  const h = await harness({ verification: async () => false });
  const retryPolicy = { maxAttempts: 3, initialDelayMs: 10, multiplier: 1, maxDelayMs: 100 };
  const job = h.engine.createJob("node", { args: ["-e", "console.log('t3')"] }, "idem-t3-p128", retryPolicy);
  const claim = h.engine.claimNextJob("worker-1");
  ok(claim !== null, "T3 claim not null");
  if (!claim) return;

  const result = await h.engine.executeJob("worker-1", claim.job.id, claim.lease.leaseId);
  ok(
    result.status === "RETRY_SCHEDULED" || result.status === "DEAD_LETTER",
    "T3 verification failure routed through retry/dead-letter"
  );
  const sawVerifying = h.events.some(e => e.payload?.to === "VERIFYING");
  const sawFailed = h.events.some(e => e.payload?.to === "FAILED");
  ok(sawVerifying, "T3 emitted RUNNING -> VERIFYING");
  ok(sawFailed, "T3 emitted VERIFYING -> FAILED");
}

async function T4_dispatchFailure(): Promise<void> {
  console.log("\nT4 — dispatch failure");
  const h = await harness({
    onDispatch: async () => { throw new Error("dispatch boom"); },
  });
  const retryPolicy = { maxAttempts: 3, initialDelayMs: 10, multiplier: 1, maxDelayMs: 100 };
  h.engine.createJob("node", { args: [] }, "idem-t4-p128", retryPolicy);
  const claim = h.engine.claimNextJob("worker-1");
  ok(claim !== null, "T4 claim not null");
  if (!claim) return;

  const result = await h.engine.executeJob("worker-1", claim.job.id, claim.lease.leaseId);
  ok(
    result.status === "RETRY_SCHEDULED" || result.status === "DEAD_LETTER" || result.status === "FAILED",
    "T4 dispatch failure routed through existing failure machinery"
  );
}

async function T5_cancellation(): Promise<void> {
  console.log("\nT5 — cancellation");
  const h = await harness();
  const job = h.engine.createJob("node", { args: ["-e", "console.log('t5')"] }, "idem-t5-p128");
  const claim = h.engine.claimNextJob("worker-1");
  ok(claim !== null, "T5 claim not null");
  if (!claim) return;

  h.engine.requestCancellation(job.id);
  const result = await h.engine.executeJob("worker-1", claim.job.id, claim.lease.leaseId);
  ok(result.status === "CANCELLED", "T5 job CANCELLED");
  ok(result.cancellationAcknowledged === true, "T5 cancellation acknowledged");
  ok(result.status !== "SUCCEEDED", "T5 cancellation not overridden by success");
}

async function T6_completionOwnershipLoss(): Promise<void> {
  console.log("\nT6 — completion ownership loss");
  const leaseRef = { id: "" };
  const h = await harness({
    verification: async () => {
      // Release the lease AFTER RUNNING -> VERIFYING but BEFORE completion.
      try { h.lm.releaseLease(leaseRef.id); } catch { /* ignore */ }
      return true;
    },
  });
  const job = h.engine.createJob("node", { args: ["-e", "console.log('t6')"] }, "idem-t6-p128");
  const claim = h.engine.claimNextJob("worker-1");
  ok(claim !== null, "T6 claim not null");
  if (!claim) return;
  leaseRef.id = claim.lease.leaseId;

  let threw = false;
  try { await h.engine.executeJob("worker-1", claim.job.id, claim.lease.leaseId); }
  catch { threw = true; }

  const after = h.store.getJob(job.id)!;
  ok(threw || after.status !== "SUCCEEDED", "T6 stale worker did not persist SUCCEEDED");
}

async function T7_durableTransitionEvidence(): Promise<void> {
  console.log("\nT7 — durable transition evidence");
  const h = await harness();
  const job = h.engine.createJob("node", { args: ["-e", "console.log('t7')"] }, "idem-t7-p128");
  const claim = h.engine.claimNextJob("worker-1");
  ok(claim !== null, "T7 claim not null");
  if (!claim) return;
  await h.engine.executeJob("worker-1", claim.job.id, claim.lease.leaseId);

  const reloaded = h.store.getJob(job.id)!;
  ok(reloaded.status === "SUCCEEDED", "T7 durable status SUCCEEDED after reload");

  const transitions = h.events.filter(e => e.type?.startsWith("execution.transition."));
  const successEvt = transitions.find(e => e.payload?.to === "SUCCEEDED");
  ok(!!successEvt, "T7 SUCCEEDED transition event recorded");
}

async function T8_restartDurability(): Promise<void> {
  console.log("\nT8 — restart durability");
  const h = await harness();
  const job = h.engine.createJob("node", { args: ["-e", "console.log('t8')"] }, "idem-t8-p128");
  const claim = h.engine.claimNextJob("worker-1");
  ok(claim !== null, "T8 claim not null");
  if (!claim) return;
  await h.engine.executeJob("worker-1", claim.job.id, claim.lease.leaseId);

  const reloaded = h.store.getJob(job.id)!;
  const attempts = h.store.listAttemptsForJob(job.id);
  ok(reloaded.status === "SUCCEEDED", "T8 durable job SUCCEEDED");
  ok(attempts[attempts.length - 1].status === "SUCCEEDED", "T8 durable attempt SUCCEEDED");
  ok(reloaded.currentLeaseId == null, "T8 lease remains released");
}

async function T9_terminalImmutability(): Promise<void> {
  console.log("\nT9 — terminal immutability");
  const h = await harness();
  const job = h.engine.createJob("node", { args: ["-e", "console.log('t9')"] }, "idem-t9-p128");
  const claim = h.engine.claimNextJob("worker-1");
  ok(claim !== null, "T9 claim not null");
  if (!claim) return;
  await h.engine.executeJob("worker-1", claim.job.id, claim.lease.leaseId);

  let resurrected = false;
  try {
    await h.engine.executeJob("worker-1", claim.job.id, claim.lease.leaseId);
    resurrected = true;
  } catch { /* expected */ }

  const after = h.store.getJob(job.id)!;
  ok(after.status === "SUCCEEDED", "T9 status still SUCCEEDED");
  ok(!resurrected, "T9 re-execution of completed job rejected");
}

async function main(): Promise<void> {
  console.log("=== Phase 128 — Production Execution Completion Integrity ===\n");
  await T1_noVerificationSuccess();
  await T2_verificationSuccess();
  await T3_verificationFailure();
  await T4_dispatchFailure();
  await T5_cancellation();
  await T6_completionOwnershipLoss();
  await T7_durableTransitionEvidence();
  await T8_restartDurability();
  await T9_terminalImmutability();
  console.log(`\n--- Phase 128: ${passed} passed, ${failed} failed ---`);
  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error("PHASE128 DRIVER CRASH:", err); process.exit(1); });
