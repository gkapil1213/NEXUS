// scripts/test-phase183a-shared-idempotency.ts
// Phase 183a - shared Postgres idempotency boundary. Real Postgres + real children.

import { spawn, type ChildProcess } from "child_process";
import { PgClient } from "../src/core/pg-client";
import { bootstrapPgSchema } from "../src/core/pg-bootstrap";
import { PgIdempotencyStore } from "../src/core/pg-idempotency-store";
import { resolveBackendConfig } from "../src/core/backend-config";
import { resolvePersistenceMode } from "../src/core/persistence-mode";

let passed = 0, failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log("  ok   " + msg); }
  else { failed++; console.log("  FAIL " + msg); }
}
function section(t: string): void { console.log("\n" + t); }

const CHILD = "scripts/_phase183a_child.ts";
const liveChildren = new Set<ChildProcess>();
process.on("exit", () => {
  for (const c of liveChildren) { try { c.kill("SIGKILL"); } catch { /* ignore */ } }
});

interface ChildOut { code: number | null; stdout: string; stderr: string; json: any | null; }

function parseJson(s: string): any | null {
  const lines = s.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch { /* try earlier */ }
  }
  return null;
}

function runChild(cmd: string, key: string, principalId?: string): Promise<ChildOut> {
  return new Promise((resolve) => {
    const args = ["--import", "tsx", CHILD, cmd, key];
    if (principalId) args.push(principalId);
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    liveChildren.add(child);
    let stdout = "", stderr = "";
    child.stdout!.on("data", (d) => { stdout += d.toString(); });
    child.stderr!.on("data", (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, 60_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      liveChildren.delete(child);
      try { child.stdout?.destroy(); } catch { /* ignore */ }
      try { child.stderr?.destroy(); } catch { /* ignore */ }
      resolve({ code, stdout, stderr, json: parseJson(stdout) });
    });
  });
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL required"); process.exit(2); }

  const pg = new PgClient();
  await pg.connect(url);
  const store = new PgIdempotencyStore(pg);

  section("A - PostgreSQL connectivity");
  {
    const probe = await pg.probe();
    ok(probe.ok === true, "A1 PostgreSQL probe returns ok");
    const v = await pg.query<{ version: string }>("SELECT version() AS version");
    ok(typeof v.rows[0]?.version === "string" && v.rows[0].version.indexOf("PostgreSQL") >= 0,
       "A2 SELECT version() confirms PostgreSQL");
  }

  section("B - Schema bootstrap idempotency");
  {
    await bootstrapPgSchema(pg);
    await bootstrapPgSchema(pg);
    const t = await pg.query<{ exists: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='nexus_idempotency_keys') AS exists");
    ok(t.rows[0]?.exists === true, "B1 nexus_idempotency_keys exists after bootstrap");
    ok(true, "B2 bootstrap idempotent (two calls, no error)");
  }

  section("C - Advisory-lock coordination under concurrent bootstrap");
  {
    const results = await Promise.all([
      runChild("bootstrap", "k"),
      runChild("bootstrap", "k"),
      runChild("bootstrap", "k"),
    ]);
    const allOk = results.every((r) => r.code === 0 && r.json?.ok === true);
    ok(allOk, "C1 three concurrent bootstrap children all succeed");
  }

  section("D - Cross-process write/read visibility");
  {
    const key = "phase183a-D-" + Date.now();
    const w = await runChild("write", key, "writer-A");
    ok(w.code === 0 && w.json?.storedByThisProcess === true,
       "D1 child A writes key; owns persisted record");
    const r = await runChild("read", key);
    ok(r.code === 0 && r.json?.found === true && r.json?.persistedPrincipalId === "writer-A",
       "D2 separate child B reads same record");
    const parent = await store.lookup(key);
    ok(parent?.principalId === "writer-A", "D3 parent process reads same record");
  }

  section("E - Concurrent identical-key convergence");
  {
    const key = "phase183a-E-" + Date.now();
    const writers = ["E-1", "E-2", "E-3", "E-4", "E-5"];
    const results = await Promise.all(writers.map((p) => runChild("write", key, p)));
    ok(results.every((r) => r.code === 0), "E1 all 5 writers exited 0");
    const persistedIds = new Set(results.map((r) => r.json?.persistedPrincipalId));
    ok(persistedIds.size === 1, "E2 exactly one principalId persisted across 5 writers");
    const recorded = [...persistedIds][0];
    ok(writers.indexOf(String(recorded)) >= 0, "E3 persisted principalId is one of the writers");
    const winners = results.filter((r) => r.json?.storedByThisProcess === true);
    ok(winners.length === 1, "E4 exactly one writer reported storedByThisProcess=true");
    const rowCount = await pg.query<{ c: string }>(
      "SELECT COUNT(*)::text AS c FROM nexus_idempotency_keys WHERE idempotency_key = $1", [key]);
    ok(rowCount.rows[0]?.c === "1", "E5 exactly one durable row for the shared key");
  }

  section("F - Transaction rollback");
  {
    const key = "phase183a-F-" + Date.now();
    let threw = false;
    try {
      await pg.withTransaction(async (client) => {
        await client.query(
          "INSERT INTO nexus_idempotency_keys " +
          "(idempotency_key, principal_id, method, path, request_hash, response_status, response_body, created_at) " +
          "VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
          [key, "rollback-tester", "POST", "/t", "h", 200, "{}", Date.now()]);
        throw new Error("intentional rollback");
      });
    } catch { threw = true; }
    ok(threw, "F1 transaction threw");
    const row = await store.lookup(key);
    ok(row === undefined, "F2 rolled-back insert is not visible");
  }

  section("G - Configuration fail-closed");
  {
    const savedUrl = process.env.DATABASE_URL;
    const savedMode = process.env.NEXUS_PERSISTENCE_MODE;

    process.env.NEXUS_PERSISTENCE_MODE = "shared";
    delete process.env.DATABASE_URL;
    const cfgMissing = resolveBackendConfig();
    ok(cfgMissing.valid === false, "G1 shared mode without DATABASE_URL is invalid");
    ok(cfgMissing.reason.toLowerCase().indexOf("requires database_url") >= 0,
       "G2 reason names the missing DATABASE_URL");

    process.env.DATABASE_URL = "not-a-url";
    const cfgBad = resolveBackendConfig();
    ok(cfgBad.valid === false, "G3 malformed DATABASE_URL is invalid");

    if (savedUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = savedUrl;
    if (savedMode === undefined) delete process.env.NEXUS_PERSISTENCE_MODE;
    else process.env.NEXUS_PERSISTENCE_MODE = savedMode;
  }

  section("H - Truthful persistence-mode reporting");
  {
    const savedUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = url;
    process.env.NEXUS_PERSISTENCE_MODE = "shared";
    const pm = resolvePersistenceMode();
    ok(pm.mode === "shared" && pm.coordination === "multi_process",
       "H1 shared mode reports multi_process coordination");
    ok(pm.sharedBackend === "postgres", "H2 shared backend family is postgres");
    ok(pm.reason.toLowerCase().indexOf("sqlite") >= 0,
       "H3 reason honestly states ExecutionStore remains local SQLite");
    if (savedUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = savedUrl;
    delete process.env.NEXUS_PERSISTENCE_MODE;
  }

  await pg.close();

  console.log("\n=== Phase 183a Summary ===");
  console.log("Passed: " + passed);
  console.log("Failed: " + failed);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });