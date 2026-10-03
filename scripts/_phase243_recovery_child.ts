// scripts/_phase243_recovery_child.ts
// Phase 243 verifier child. One command per process invocation. Talks to
// the real PostgreSQL recovery-operation store. No SQLite, no in-memory
// coordination. Emits one JSON line on stdout.
import { PgClient } from "../src/core/pg-client";
import { PgAsyncEngine } from "../src/core/pg-async-engine";
import { AsyncExecutionRecoveryOperationStore } from "../src/core/execution-recovery-operation-store";

const argv = process.argv.slice(2);
const cmd = argv[0];
const url = argv[1];
const args = argv.slice(2);

function emit(o: unknown): void { console.log(JSON.stringify(o)); }

async function main(): Promise<void> {
  if (!cmd || !url) { emit({ error: "usage: child <cmd> <url> [args...]" }); process.exit(2); }
  const pg = new PgClient();
  await pg.connect(url);
  const ops = new AsyncExecutionRecoveryOperationStore(new PgAsyncEngine(pg));

  try {
    if (cmd === "probe") {
      const p = await pg.probe();
      emit({ ok: p.ok === true });
      return;
    }

    if (cmd === "create-op") {
      const [jobId, idempotencyKey] = args;
      const r = await ops.createOrGetOperation({
        jobId, leaseId: null, workerId: "child",
        operationType: "ORPHAN_RECOVERY",
        idempotencyKey,
      });
      emit({ operationId: r.operation.operationId, created: r.created, state: r.operation.state,
             nextAttemptAt: r.operation.nextAttemptAt, lastFailureClass: r.operation.lastFailureClass });
      return;
    }

    if (cmd === "claim-op") {
      const [operationId, owner, durationMsStr] = args;
      const durationMs = Number(durationMsStr ?? 60000);
      const r = await ops.claimOperation({ operationId, owner, durationMs });
      emit({ claimed: r.claimed, reason: r.reason ?? null,
             state: r.operation?.state ?? null, attemptCount: r.operation?.attemptCount ?? null });
      return;
    }

    if (cmd === "renew-op") {
      const [operationId, owner, durationMsStr] = args;
      const durationMs = Number(durationMsStr ?? 60000);
      const r = await ops.renewOperationClaim({ operationId, owner, durationMs });
      emit({ renewed: r.renewed, reason: r.reason ?? null });
      return;
    }

    if (cmd === "complete-op") {
      const [operationId, owner] = args;
      const ok = await ops.markCompleted(operationId, owner);
      emit({ completed: ok });
      return;
    }

    if (cmd === "fail-op") {
      const [operationId, owner, error, failureClass, nextAttemptAtStr] = args;
      const nextAttemptAt = nextAttemptAtStr && nextAttemptAtStr !== "null" ? Number(nextAttemptAtStr) : null;
      const ok = await ops.markFailed(operationId, owner, error, Date.now(), {
        failureClass: failureClass ?? null,
        nextAttemptAt,
      });
      emit({ failed: ok });
      return;
    }

    if (cmd === "read-op") {
      const [operationId] = args;
      const op = await ops.getOperation(operationId);
      emit({ found: !!op, op: op ?? null });
      return;
    }

    if (cmd === "list-resumable") {
      const nowStr = args[0];
      const now = nowStr ? Number(nowStr) : Date.now();
      const list = await ops.listResumableOperations(now);
      emit({ count: list.length, ids: list.map((o) => o.operationId) });
      return;
    }

    if (cmd === "count-ops-for-job") {
      const [jobId] = args;
      const rows = await pg.query<{ cnt: string }>(
        "SELECT COUNT(*)::text AS cnt FROM execution_recovery_operations WHERE job_id = $1",
        [jobId],
      );
      emit({ count: Number(rows.rows[0]?.cnt ?? 0) });
      return;
    }

    emit({ error: "unknown cmd: " + cmd });
    process.exit(2);
  } finally {
    try { await pg.close(); } catch { /* ignore */ }
  }
}

main().catch((e) => { emit({ error: String((e as Error)?.message ?? e) }); process.exit(1); });