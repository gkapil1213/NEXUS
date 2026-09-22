// scripts/_phase183a_child.ts
// Phase 183a child: one idempotency operation against real shared Postgres.

import { PgClient } from "../src/core/pg-client";
import { bootstrapPgSchema } from "../src/core/pg-bootstrap";
import { PgIdempotencyStore } from "../src/core/pg-idempotency-store";

async function main(): Promise<void> {
  const [, , cmd, key, principalId] = process.argv;
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL not set"); process.exit(2); }
  if (!cmd || !key) { console.error("usage: <command> <key> [principalId]"); process.exit(2); }

  const pg = new PgClient();
  await pg.connect(url);
  await bootstrapPgSchema(pg);
  const store = new PgIdempotencyStore(pg);

  try {
    if (cmd === "write") {
      const pid = principalId || "child";
      await store.store({
        idempotencyKey: key,
        principalId: pid,
        method: "POST",
        path: "/test",
        requestHash: "h-" + key,
        responseStatus: 200,
        responseBody: JSON.stringify({ ok: true, by: pid }),
        createdAt: Date.now(),
      });
      const after = await store.lookup(key);
      console.log(JSON.stringify({
        cmd, key, principalId: pid,
        storedByThisProcess: after?.principalId === pid,
        persistedPrincipalId: after?.principalId ?? null,
        pid: process.pid,
      }));
    } else if (cmd === "read") {
      const rec = await store.lookup(key);
      console.log(JSON.stringify({
        cmd, key, found: !!rec,
        persistedPrincipalId: rec?.principalId ?? null,
        pid: process.pid,
      }));
    } else if (cmd === "bootstrap") {
      await bootstrapPgSchema(pg);
      console.log(JSON.stringify({ cmd, ok: true, pid: process.pid }));
    } else {
      console.error("unknown cmd: " + cmd);
      process.exit(2);
    }
  } finally {
    try { await pg.close(); } catch { /* ignore */ }
  }
}

main().catch((e) => { console.error("CHILD_FAIL:", e.message); process.exit(1); });