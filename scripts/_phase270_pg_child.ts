// scripts/_phase270_pg_child.ts
// Phase 270 Postgres child: drives a single recovery-operation lifecycle step
// against a real PostgreSQL database, optionally injects a fault, and exits.
// Emits structured JSON as the last stdout line for parent parsing.
//
// Usage: tsx _phase270_pg_child.ts <cmd> <url> <jobId> [--fault=<hook>] [--owner=<id>]
//
// Commands:
//   create                create or get operation (state=PENDING)
//   claim                 claim operation (state=CLAIMED)
//   mark-in-progress      CLAIMED -> IN_PROGRESS
//   mark-completed        IN_PROGRESS/CLAIMED -> COMPLETED
//   mark-failed           CLAIMED/IN_PROGRESS -> FAILED
//   mark-recovery-required  CLAIMED/IN_PROGRESS -> RECOVERY_REQUIRED
//   read-state            read persisted row, no mutation
//
// Fault hooks (--fault=<hook>):
//   after-create, after-claim, after-in-progress, before-complete, db-error

import Database from "better-sqlite3";
import { PgClient } from "../src/core/pg-client";
import { PgAsyncEngine } from "../src/core/pg-async-engine";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";

function parseArgs() {
  const [, , cmd, url, jobId, ...rest] = process.argv;
  if (!cmd || !url || !jobId) {
    console.error("usage: <cmd> <url> <jobId> [--fault=<hook>] [--owner=<id>]");
    process.exit(2);
  }
  const opts: Record<string, string> = {};
  for (const arg of rest) {
    const m = /^--([^=]+)=(.*)$/.exec(arg);
    if (m) opts[m[1]] = m[2];
  }
  return { cmd, url, jobId, fault: opts.fault || "", owner: opts.owner || "child-w" };
}

async function main(): Promise<void> {
  const { cmd, url, jobId, fault, owner } = parseArgs();

  const mem = new Database(":memory:");
  const syncEngine = SQLiteEngine.fromDatabase(mem);
  const pg = new PgClient();
  await pg.connect(url);
  const asyncDb = new PgAsyncEngine(pg);
  const store = new ExecutionStore(syncEngine, asyncDb);

  try {
    const ops: any = (store as any).recoveryOpsAsync;
    if (!ops) {
      console.error("CHILD_FAIL: recoveryOpsAsync not found on store");
      process.exit(1);
    }

    const emit = (payload: any) => {
      console.log(JSON.stringify({ ok: true, ...payload }));
    };

    switch (cmd) {
      case "create": {
        const r = await ops.createOrGetOperation({
          jobId, leaseId: null, workerId: owner, operationType: "TIMEOUT", now: Date.now(),
        });
        const opId = r.operation.operationId;
        if (fault === "after-create") {
          console.error("CHILD_FAULT: after-create");
          process.exit(1);
        }
        emit({ opId, state: r.operation.state, created: r.created });
        break;
      }
      case "claim": {
        const r = await ops.createOrGetOperation({
          jobId, leaseId: null, workerId: owner, operationType: "TIMEOUT", now: Date.now(),
        });
        const opId = r.operation.operationId;
        const c = await ops.claimOperation({ operationId: opId, owner, durationMs: 60000, now: Date.now() });
        if (fault === "after-claim") {
          console.error("CHILD_FAULT: after-claim");
          process.exit(1);
        }
        const after = await ops.getOperation(opId);
        emit({ opId, claimed: c.claimed, state: after.state, claimOwner: after.claimOwner, attemptCount: after.attemptCount });
        break;
      }
      case "mark-in-progress": {
        const r = await ops.createOrGetOperation({ jobId, leaseId: null, workerId: owner, operationType: "TIMEOUT", now: Date.now() });
        const opId = r.operation.operationId;
        await ops.claimOperation({ operationId: opId, owner, durationMs: 60000, now: Date.now() });
        const ok = await ops.markInProgress(opId, owner, Date.now());
        if (fault === "after-in-progress") {
          console.error("CHILD_FAULT: after-in-progress");
          process.exit(1);
        }
        const after = await ops.getOperation(opId);
        emit({ opId, ok, state: after.state, claimOwner: after.claimOwner });
        break;
      }
      case "mark-completed": {
        const r = await ops.createOrGetOperation({ jobId, leaseId: null, workerId: owner, operationType: "TIMEOUT", now: Date.now() });
        const opId = r.operation.operationId;
        await ops.claimOperation({ operationId: opId, owner, durationMs: 60000, now: Date.now() });
        await ops.markInProgress(opId, owner, Date.now());
        if (fault === "before-complete") {
          console.error("CHILD_FAULT: before-complete");
          process.exit(1);
        }
        if (fault === "db-error") {
          try { await pg.close(); } catch {}
        }
        const ok = await ops.markCompleted(opId, owner, Date.now());
        const after = await ops.getOperation(opId);
        emit({ opId, ok, state: after.state, completedAt: after.completedAt });
        break;
      }
      case "mark-failed": {
        const r = await ops.createOrGetOperation({ jobId, leaseId: null, workerId: owner, operationType: "TIMEOUT", now: Date.now() });
        const opId = r.operation.operationId;
        await ops.claimOperation({ operationId: opId, owner, durationMs: 60000, now: Date.now() });
        const ok = await ops.markFailed(opId, owner, "child-induced failure", Date.now());
        const after = await ops.getOperation(opId);
        emit({ opId, ok, state: after.state, lastError: after.lastError });
        break;
      }
      case "mark-recovery-required": {
        const r = await ops.createOrGetOperation({ jobId, leaseId: null, workerId: owner, operationType: "TIMEOUT", now: Date.now() });
        const opId = r.operation.operationId;
        await ops.claimOperation({ operationId: opId, owner, durationMs: 60000, now: Date.now() });
        const ok = await ops.markRecoveryRequired(opId, owner, "child-induced escalation", Date.now());
        const after = await ops.getOperation(opId);
        emit({ opId, ok, state: after.state, lastError: after.lastError, claimOwner: after.claimOwner });
        break;
      }
      case "read-state": {
        const r = await ops.createOrGetOperation({ jobId, leaseId: null, workerId: owner, operationType: "TIMEOUT", now: Date.now() });
        const opId = r.operation.operationId;
        const op = await ops.getOperation(opId);
        emit({ opId, state: op.state, claimOwner: op.claimOwner, attemptCount: op.attemptCount, lastError: op.lastError });
        break;
      }
      default:
        console.error("unknown cmd: " + cmd);
        process.exit(2);
    }
  } finally {
    try { await pg.close(); } catch {}
    try { mem.close(); } catch {}
  }
}

main().catch((e) => { console.error("CHILD_FAIL:", e?.stack ?? e); process.exit(1); });