// scripts/_phase199_reclaim_child.ts
// Phase 199: independent-process claimant for concurrency tests.
// Usage: tsx _phase199_reclaim_child.ts <cmd> <url> <args...>

import { PgClient } from "../src/core/pg-client";
import { PgAsyncEngine } from "../src/core/pg-async-engine";
import { AsyncExecutionRecoveryOperationStore } from "../src/core/execution-recovery-operation-store";

async function main(): Promise<void> {
  const [, , cmd, url, ...args] = process.argv;
  if (!cmd || !url) { console.error("usage: <cmd> <url> [args]"); process.exit(2); }

  const pg = new PgClient();
  await pg.connect(url);
  const asyncDb = new PgAsyncEngine(pg);
  const ops = new AsyncExecutionRecoveryOperationStore(asyncDb);

  try {
    if (cmd === "claim") {
      const [operationId, owner, durationMs] = args;
      const r = await ops.claimOperation({
        operationId,
        owner,
        durationMs: Number(durationMs) || 60_000,
      });
      console.log(JSON.stringify({ claimed: r.claimed, owner, operationId }));
    } else if (cmd === "read") {
      const op = await ops.getOperation(args[0]);
      console.log(JSON.stringify({ found: !!op, state: op?.state ?? null, claimOwner: op?.claimOwner ?? null }));
    } else {
      console.error("unknown cmd: " + cmd);
      process.exit(2);
    }
  } finally {
    try { await pg.close(); } catch { /* ignore */ }
  }
}

main().catch((e) => { console.error("CHILD_FAIL:", e?.stack ?? e); process.exit(1); });