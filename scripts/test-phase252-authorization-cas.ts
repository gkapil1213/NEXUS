// scripts/test-phase252-authorization-cas.ts
// Phase 252 - durable production authorization CAS over real Postgres.
// Proves: cross-process issuance visibility, cross-process consume atomicity,
// and same-attempt retry idempotency. Requires DATABASE_URL.

import { spawn, type ChildProcess } from "child_process";
import Database from "better-sqlite3";
import { PgClient } from "../src/core/pg-client";
import { PgAsyncEngine } from "../src/core/pg-async-engine";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import type { StoredProductionAuthorization } from "../src/core/execution-store";

let passed = 0, failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log("  ok   " + msg); }
  else { failed++; console.log("  FAIL " + msg); }
}
function section(t: string): void { console.log("\n" + t); }

const CHILD = "scripts/_phase252_auth_cas_child.ts";
const liveChildren = new Set<ChildProcess>();
process.on("exit", () => { for (const c of liveChildren) { try { c.kill("SIGKILL"); } catch {} } });

interface ChildOut { code: number | null; stdout: string; stderr: string; json: any | null; }
function parseJson(s: string): any | null {
  const lines = s.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) { try { return JSON.parse(lines[i]); } catch {} }
  return null;
}
function runChild(url: string, cmd: string, ...args: string[]): Promise<ChildOut> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", CHILD, cmd, url, ...args], {
      cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
    });
    liveChildren.add(child);
    let stdout = "", stderr = "";
    child.stdout!.on("data", (d) => { stdout += d.toString(); });
    child.stderr!.on("data", (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 60_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      liveChildren.delete(child);
      try { child.stdout?.destroy(); } catch {}
      try { child.stderr?.destroy(); } catch {}
      resolve({ code, stdout, stderr, json: parseJson(stdout) });
    });
  });
}

function mkAuth(id: string, overrides: Partial<StoredProductionAuthorization> = {}): StoredProductionAuthorization {
  const now = Date.now();
  return {
    authorizationId: id,
    releaseId: "rel-" + id,
    artifactId: "art-" + id,
    artifactDigest: "sha256:" + "a".repeat(64),
    commitSha: "commit-" + id,
    environment: "production",
    securityDecisionId: "sd-" + id,
    approvalId: "ap-" + id,
    executionId: "exec-" + id,
    projectId: "proj-" + id,
    imageRepository: "repo",
    imageTag: "v1",
    imageId: "img",
    containerName: "c-" + id,
    containerPort: 8080,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 5 * 60_000).toISOString(),
    consumedAt: null,
    consumedByAttemptId: null,
    revokedAt: null,
    ...overrides,
  } as StoredProductionAuthorization;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL required"); process.exit(2); }

  const pg = new PgClient();
  await pg.connect(url);
  const asyncDb = new PgAsyncEngine(pg);
  const mem = new Database(":memory:");
  const syncEngine = SQLiteEngine.fromDatabase(mem);
  const store = new ExecutionStore(syncEngine, asyncDb);

  // ============================================================
  // A01 - Postgres schema
  // ============================================================
  section("A01 - production_execution_authorizations exists in Postgres");
  {
    const r = await pg.query<{ exists: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='production_execution_authorizations' AND table_schema='public') AS exists");
    ok(r.rows[0]?.exists === true, "A01 table exists");
  }

  // ============================================================
  // A02 - async issue visible cross-process
  // ============================================================
  section("A02 - createProductionAuthorizationAsync is cross-process visible");
  {
    const id = "auth-p252-a02-" + Date.now();
    await store.createProductionAuthorizationAsync(mkAuth(id));
    const child = await runChild(url, "get-auth", id);
    ok(child.json?.ok === true, "A02 child succeeded");
    ok(child.json?.found === true, "A02 child sees the authorization row");
    ok(child.json?.consumedAt == null, "A02 row is unconsumed");
    ok(child.json?.consumedByAttemptId == null, "A02 consumedByAttemptId is null");
  }

  // ============================================================
  // A03 - two different attempts race; exactly one wins
  // ============================================================
  section("A03 - concurrent different attempts: exactly one consumes");
  {
    const id = "auth-p252-a03-" + Date.now();
    await store.createProductionAuthorizationAsync(mkAuth(id));

    const [rA, rB] = await Promise.all([
      runChild(url, "consume-auth", id, "att-A"),
      runChild(url, "consume-auth", id, "att-B"),
    ]);

    const winners = (rA.json?.consumed ? 1 : 0) + (rB.json?.consumed ? 1 : 0);
    ok(winners === 1, "A03 exactly one child consumed (got " + winners + ")");

    const winner = rA.json?.consumed ? rA.json : rB.json;
    const loser  = rA.json?.consumed ? rB.json : rA.json;
    ok(winner?.consumedByAttemptId === winner?.durableConsumedByAttemptId,
       "A03 winner's durable binding matches its own attempt");
    ok(loser?.consumedByAttemptId === winner?.consumedByAttemptId,
       "A03 loser observes the winner's binding (got " + loser?.consumedByAttemptId + ")");

    // Independent verification from the parent process.
    const fresh = await store.getProductionAuthorizationAsync(id);
    ok(fresh?.consumedAt != null, "A03 durable row is consumed");
    ok(fresh?.consumedByAttemptId === winner?.consumedByAttemptId,
       "A03 durable binding matches the winner");
  }

  // ============================================================
  // A04 - same attempt retry is idempotent
  // ============================================================
  section("A04 - same-attempt retry does not corrupt binding");
  {
    const id = "auth-p252-a04-" + Date.now();
    await store.createProductionAuthorizationAsync(mkAuth(id));

    const first  = await runChild(url, "consume-auth", id, "att-SAME");
    const second = await runChild(url, "consume-auth", id, "att-SAME");

    ok(first.json?.consumed === true,  "A04 first consume wins");
    ok(second.json?.consumed === true, "A04 second consume also reports consumed (COALESCE idempotency)");
    ok(first.json?.consumedAt === second.json?.consumedAt,
       "A04 consumedAt unchanged across retry");
    ok(first.json?.consumedByAttemptId === "att-SAME" &&
       second.json?.consumedByAttemptId === "att-SAME",
       "A04 attempt binding stable");
  }

  // ============================================================
  // A05 - different attempt after consumption blocks
  // ============================================================
  section("A05 - different attempt after consumption is rejected by CAS");
  {
    const id = "auth-p252-a05-" + Date.now();
    await store.createProductionAuthorizationAsync(mkAuth(id));

    const first  = await runChild(url, "consume-auth", id, "att-FIRST");
    const second = await runChild(url, "consume-auth", id, "att-SECOND");

    ok(first.json?.consumed === true,  "A05 first attempt consumes");
    ok(second.json?.consumed === false, "A05 second attempt does not consume");
    ok(second.json?.consumedByAttemptId === "att-FIRST",
       "A05 second attempt observes first's binding");
    ok(first.json?.consumedAt === second.json?.consumedAt,
       "A05 consumedAt unchanged by loser");
  }

  console.log("\n--- Phase 252 authorization CAS: " + passed + " passed, " + failed + " failed ---");
  try { await pg.close(); } catch {}
  try { mem.close(); } catch {}
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error("PHASE252 DRIVER CRASH:", e?.stack ?? e); process.exit(1); });