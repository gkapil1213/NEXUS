// scripts/_phase252_auth_cas_child.ts
// Phase 252 child: one durable-authorization operation against real Postgres.
// Reports outcome as a single-line JSON object on stdout.

import Database from "better-sqlite3";
import { PgClient } from "../src/core/pg-client";
import { PgAsyncEngine } from "../src/core/pg-async-engine";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";

async function main(): Promise<void> {
  const [, , cmd, url, authorizationId, attemptId] = process.argv;
  if (!cmd || !url) { console.error("usage: <cmd> <url> [authorizationId] [attemptId]"); process.exit(2); }

  const mem = new Database(":memory:");
  const syncEngine = SQLiteEngine.fromDatabase(mem);
  const pg = new PgClient();
  await pg.connect(url);
  const asyncDb = new PgAsyncEngine(pg);
  const store = new ExecutionStore(syncEngine, asyncDb);

  try {
    switch (cmd) {
      case "get-auth": {
        const row = await store.getProductionAuthorizationAsync(authorizationId!);
        console.log(JSON.stringify({
          ok: true, found: !!row,
          consumedAt: row?.consumedAt ?? null,
          consumedByAttemptId: row?.consumedByAttemptId ?? null,
          pid: process.pid,
        }));
        break;
      }
      case "consume-auth": {
        const cas = await store.consumeProductionAuthorizationAsync(authorizationId!, attemptId!);
        const back = await store.getProductionAuthorizationAsync(authorizationId!);
        console.log(JSON.stringify({
          ok: true,
          consumed: cas.consumed,
          consumedAt: cas.consumedAt,
          consumedByAttemptId: cas.consumedByAttemptId,
          durableConsumedAt: back?.consumedAt ?? null,
          durableConsumedByAttemptId: back?.consumedByAttemptId ?? null,
          pid: process.pid,
        }));
        break;
      }
      default:
        console.error("unknown cmd: " + cmd);
        process.exit(2);
    }
  } finally {
    try { await pg.close(); } catch { /* ignore */ }
    try { mem.close(); } catch { /* ignore */ }
  }
}

main().catch((e) => { console.error("CHILD_FAIL:", e?.stack ?? e); process.exit(1); });