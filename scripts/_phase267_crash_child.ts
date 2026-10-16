// scripts/_phase267_crash_child.ts
// Phase 267 child: performs a specific recovery-operation lifecycle step,
// prints the operation id and owner as JSON on the last line, then either
// exits cleanly or SIGKILLs itself. Parent inspects persisted state.

import Database from "better-sqlite3";
import { join } from "path";
import { MigrationRunner } from "../src/core/migration-runner";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { ExecutionEngine } from "../src/core/execution-engine";
import { PgClient } from "../src/core/pg-client";
import { PgAsyncEngine } from "../src/core/pg-async-engine";

type Backend = "sqlite" | "postgres";

async function buildStore(backend: Backend, target: string): Promise<{
  store: any; close: () => Promise<void>; engine: ExecutionEngine;
}> {
  if (backend === "sqlite") {
    const raw = new Database(target);
    new MigrationRunner(raw, join(process.cwd(), "src", "db", "migrations")).run();
    const db = SQLiteEngine.fromDatabase(raw);
    const store = new ExecutionStore(db as any);
    const engine = new ExecutionEngine(store, {} as any, {} as any, {} as any, {} as any);
    return { store, close: async () => { try { raw.close(); } catch {} }, engine };
  }
  const pg = new PgClient();
  await pg.connect(target);
  const asyncDb = new PgAsyncEngine(pg);
  const mem = new Database(":memory:");
  new MigrationRunner(mem, join(process.cwd(), "src", "db", "migrations")).run();
  const syncEngine = SQLiteEngine.fromDatabase(mem);
  const store = new ExecutionStore(syncEngine as any, asyncDb as any);
  const engine = new ExecutionEngine(store, {} as any, {} as any, {} as any, {} as any);
  return { store, close: async () => { try { mem.close(); } catch {} try { await pg.close(); } catch {} }, engine };
}

function emit(o: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(o) + "\n");
}

async function main() {
  const [cmd, backend, target, jobId, opType] = process.argv.slice(2);
  if (!cmd || !backend || !target) { emit({ error: "usage" }); process.exit(2); }
  const b = backend as Backend;
  const { store, close, engine } = await buildStore(b, target);
  const ops: any = b === "postgres" ? (store as any).recoveryOpsAsync : (store as any).recoveryOps;

  const jid = jobId ?? ("p267-child-" + Date.now().toString(36));
  const ot = (opType ?? "ORPHAN_RECOVERY") as any;

  switch (cmd) {
    case "create-op": {
      // Ensure a job row exists so the child flow matches the engine's real usage.
      const now = Date.now();
      const jobs = b === "postgres"
        ? (store as any).createJobAsync
        : (store as any).createJob;
      const job = {
        id: jid, idempotencyKey: "p267-" + jid, jobType: "engineering",
        payload: { kind: "engineering" }, status: "FAILED",
        createdAt: now, updatedAt: now,
        cancellationRequested: 0, cancellationAcknowledged: 0,
        retryPolicy: { maxAttempts: 3, initialDelayMs: 1000, multiplier: 2, maxDelayMs: 30000 },
        timeoutMs: 60000, lastAttemptAt: now, nextAttemptAt: null, currentLeaseId: null,
      };
      try { await jobs.call(store, job); } catch {}
      const c = await ops.createOrGetOperation({ jobId: jid, leaseId: null, workerId: "w", operationType: ot, now: 1 });
      emit({ operationId: c.operation.operationId, state: c.operation.state, created: c.created });
      await close(); process.exit(0);
    }
    case "create-then-claim": {
      const now = Date.now();
      const jobs = b === "postgres" ? (store as any).createJobAsync : (store as any).createJob;
      try {
        await jobs.call(store, {
          id: jid, idempotencyKey: "p267-" + jid, jobType: "engineering",
          payload: { kind: "engineering" }, status: "FAILED",
          createdAt: now, updatedAt: now,
          cancellationRequested: 0, cancellationAcknowledged: 0,
          retryPolicy: { maxAttempts: 3, initialDelayMs: 1000, multiplier: 2, maxDelayMs: 30000 },
          timeoutMs: 60000, lastAttemptAt: now, nextAttemptAt: null, currentLeaseId: null,
        });
      } catch {}
      const c = await ops.createOrGetOperation({ jobId: jid, leaseId: null, workerId: "w", operationType: ot, now: 1 });
      const opId = c.operation.operationId;
      const owner = "child-" + process.pid;
      await ops.claimOperation({ operationId: opId, owner, durationMs: 60000, now });
      emit({ operationId: opId, owner });
      await close(); process.exit(0);
    }
    case "claim-then-crash": {
      const now = Date.now();
      const jobs = b === "postgres" ? (store as any).createJobAsync : (store as any).createJob;
      try {
        await jobs.call(store, {
          id: jid, idempotencyKey: "p267-" + jid, jobType: "engineering",
          payload: { kind: "engineering" }, status: "FAILED",
          createdAt: now, updatedAt: now,
          cancellationRequested: 0, cancellationAcknowledged: 0,
          retryPolicy: { maxAttempts: 3, initialDelayMs: 1000, multiplier: 2, maxDelayMs: 30000 },
          timeoutMs: 60000, lastAttemptAt: now, nextAttemptAt: null, currentLeaseId: null,
        });
      } catch {}
      const c = await ops.createOrGetOperation({ jobId: jid, leaseId: null, workerId: "w", operationType: ot, now: 1 });
      const opId = c.operation.operationId;
      const owner = "child-" + process.pid;
      await ops.claimOperation({ operationId: opId, owner, durationMs: 60000, now });
      emit({ operationId: opId, owner });
      // Do NOT close: simulate abrupt process death while holding a durable claim.
      process.kill(process.pid, "SIGKILL");
    }
    case "in-progress-then-crash": {
      const now = Date.now();
      const jobs = b === "postgres" ? (store as any).createJobAsync : (store as any).createJob;
      try {
        await jobs.call(store, {
          id: jid, idempotencyKey: "p267-" + jid, jobType: "engineering",
          payload: { kind: "engineering" }, status: "FAILED",
          createdAt: now, updatedAt: now,
          cancellationRequested: 0, cancellationAcknowledged: 0,
          retryPolicy: { maxAttempts: 3, initialDelayMs: 1000, multiplier: 2, maxDelayMs: 30000 },
          timeoutMs: 60000, lastAttemptAt: now, nextAttemptAt: null, currentLeaseId: null,
        });
      } catch {}
      const c = await ops.createOrGetOperation({ jobId: jid, leaseId: null, workerId: "w", operationType: ot, now: 1 });
      const opId = c.operation.operationId;
      const owner = "child-" + process.pid;
      await ops.claimOperation({ operationId: opId, owner, durationMs: 60000, now });
      await ops.markInProgress(opId, owner, now);
      emit({ operationId: opId, owner });
      process.kill(process.pid, "SIGKILL");
    }
    case "read-op": {
      const opId = process.argv[4];
      const op = await ops.getOperation(opId);
      emit({ operation: op });
      await close(); process.exit(0);
    }
    default:
      emit({ error: "unknown command: " + cmd });
      await close(); process.exit(2);
  }
}

main().catch((e) => { emit({ fatal: String(e?.stack ?? e) }); process.exit(1); });
