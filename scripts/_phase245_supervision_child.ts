// scripts/_phase245_supervision_child.ts
// Helper child process for Phase 245 A15 (process restart durability).
// Invoked as: tsx _phase245_supervision_child.ts <cmd> <dbUrl> <args...>
import { PgClient } from "../src/core/pg-client";
import { PgAsyncEngine } from "../src/core/pg-async-engine";
import { AsyncExecutionRecoveryOperationStore } from "../src/core/execution-recovery-operation-store";

async function main() {
  const [cmd, url, ...args] = process.argv.slice(2);
  if (!cmd || !url) { console.error("usage: child <cmd> <url> [args...]"); process.exit(2); }

  const pg = new PgClient();
  await pg.connect(url);
  const asyncDb = new PgAsyncEngine(pg);
  const ops = new AsyncExecutionRecoveryOperationStore(asyncDb);

  try {
    if (cmd === "create-op") {
      const [jobId, opType] = args;
      const r = await ops.createOrGetOperation({
        jobId, leaseId: null, workerId: "child-w",
        operationType: (opType as any) ?? "ORPHAN_RECOVERY",
      });
      console.log(JSON.stringify({ created: r.created, operationId: r.operation.operationId }));
    } else {
      console.error("unknown cmd: " + cmd);
      process.exit(2);
    }
  } finally {
    try { await pg.close(); } catch {}
  }
}

main().catch((e) => { console.error(e?.stack ?? e); process.exit(1); });