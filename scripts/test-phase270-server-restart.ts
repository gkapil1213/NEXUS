// scripts/test-phase270-server-restart.ts
// Phase 270 Section 3 - REAL PostgreSQL server restart.
//
// [REAL POSTGRES SERVER RESTART] -- distinct from child-process restart.
// Uses docker to restart the disposable nexus-pg container.
// Reports [BLOCKED] if docker or the container is unavailable.
//
// Requires:
//   DATABASE_URL                      (postgres://...loopback-only)
//   NEXUS_PHASE270_ALLOW_PG_TESTS=1   (safety opt-in)
//   docker CLI available              (for restart)
//   nexus-pg container present        (restartable)

import { execSync } from "node:child_process";
import { PgClient } from "../src/core/pg-client";
import { PgAsyncEngine } from "../src/core/pg-async-engine";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import Database from "better-sqlite3";

let pass = 0, fail = 0, blocked = 0;
function ok(c: boolean, m: string, d = "") {
  if (c) { pass++; console.log("PASS  " + m + (d ? "  " + d : "")); }
  else   { fail++; console.log("FAIL  " + m + (d ? "  " + d : "")); }
}
function blk(reason: string) { blocked++; console.log("[BLOCKED] " + reason); }
function uniq(t: string) { return `p270srv-${t}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }

function checkSafety(): { ok: boolean; reason?: string } {
  const url = process.env.DATABASE_URL;
  if (!url) return { ok: false, reason: "DATABASE_URL not set" };
  if (process.env.NEXUS_PHASE270_ALLOW_PG_TESTS !== "1") {
    return { ok: false, reason: "NEXUS_PHASE270_ALLOW_PG_TESTS must equal 1" };
  }
  let parsed: URL;
  try { parsed = new URL(url); } catch { return { ok: false, reason: "DATABASE_URL invalid" }; }
  const host = parsed.hostname;
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
    return { ok: false, reason: "host must be loopback, got " + host };
  }
  return { ok: true };
}

function checkContainer(): { ok: boolean; reason?: string } {
  try {
    const out = execSync('docker ps --filter "name=^/nexus-pg$" --format "{{.Names}}"', { encoding: "utf8", timeout: 5000 }).trim();
    if (out !== "nexus-pg") return { ok: false, reason: "nexus-pg container not running" };
  } catch (e: any) {
    return { ok: false, reason: "docker CLI unavailable: " + (e?.message ?? String(e)) };
  }
  return { ok: true };
}

async function waitForPgReady(timeoutMs = 60000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const out = execSync('docker exec nexus-pg pg_isready -U postgres', { encoding: "utf8", timeout: 5000 }).trim();
      if (out.includes("accepting connections")) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

async function openStore(url: string): Promise<{ pg: PgClient; ops: any; close: () => Promise<void> }> {
  const mem = new Database(":memory:");
  const syncEngine = SQLiteEngine.fromDatabase(mem);
  const pg = new PgClient();
  await pg.connect(url);
  const asyncDb = new PgAsyncEngine(pg);
  const store = new ExecutionStore(syncEngine, asyncDb);
  return { pg, ops: (store as any).recoveryOpsAsync, close: async () => { try { await pg.close(); } catch {} try { mem.close(); } catch {} } };
}

async function main() {
  console.log("=== Phase 270 - PostgreSQL Server Restart ===\n");
  const safety = checkSafety();
  if (!safety.ok) {
    blk(safety.reason!);
    console.log(`\nPASS: ${pass}\nFAIL: ${fail}\nBLOCKED: ${blocked}`);
    process.exit(0);
  }
  const containerCheck = checkContainer();
  if (!containerCheck.ok) {
    blk(containerCheck.reason!);
    console.log(`\nPASS: ${pass}\nFAIL: ${fail}\nBLOCKED: ${blocked}`);
    process.exit(0);
  }

  const url = process.env.DATABASE_URL!;
  const jobId = uniq("srv1");
  let opId: string | undefined;

  console.log("--- Phase A: create + claim durable op before restart ---");
  {
    const h = await openStore(url);
    try {
      const c = await h.ops.createOrGetOperation({
        jobId, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY", now: Date.now(),
      });
      opId = c.operation.operationId;
      ok(!!opId, "Phase A op created", "opId=" + opId);
      const cl = await h.ops.claimOperation({ operationId: opId!, owner: "pre-restart-owner", durationMs: 600000, now: Date.now() });
      ok(cl.claimed === true, "Phase A claim succeeded");
      const after = await h.ops.getOperation(opId!);
      ok(after.state === "CLAIMED", "Phase A state=CLAIMED", "got=" + after.state);
      ok(after.claimOwner === "pre-restart-owner", "Phase A owner set", "got=" + after.claimOwner);
    } finally { await h.close(); }
  }

  console.log("\n--- Phase B: [REAL POSTGRES SERVER RESTART] docker restart nexus-pg ---");
  let restartOk = false;
  try {
    execSync("docker restart nexus-pg", { encoding: "utf8", timeout: 60000 });
    restartOk = true;
    ok(true, "Phase B docker restart command succeeded");
  } catch (e: any) {
    ok(false, "Phase B docker restart failed", String(e?.message ?? e));
  }

  if (restartOk) {
    console.log("\n--- Phase C: wait for PG readiness ---");
    const ready = await waitForPgReady(60000);
    ok(ready, "Phase C PG accepting connections after restart");

    if (ready) {
      console.log("\n--- Phase D: [REAL POSTGRES SERVER RESTART] reconnect + verify durability ---");
      let h2: { pg: PgClient; ops: any; close: () => Promise<void> } | null = null;
      try {
        h2 = await openStore(url);
        const op = await h2.ops.getOperation(opId!);
        ok(!!op, "Phase D op readable after restart");
        ok(op.state === "CLAIMED", "Phase D state=CLAIMED preserved", "got=" + op?.state);
        ok(op.claimOwner === "pre-restart-owner", "Phase D owner preserved", "got=" + op?.claimOwner);

        console.log("\n--- Phase E: [REAL POSTGRES SERVER RESTART] no false success ---");
        const jobId2 = uniq("srv2");
        const c2 = await h2.ops.createOrGetOperation({
          jobId: jobId2, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY", now: Date.now(),
        });
        ok(!!c2.operation.operationId, "Phase E new op created post-restart");
      } catch (e: any) {
        ok(false, "Phase D/E post-restart verification threw", String(e?.message ?? e));
      } finally {
        if (h2) try { await h2.close(); } catch {}
      }
    } else {
      blk("Phase D skipped: PG did not become ready within 60s");
    }
  } else {
    blk("Phase B-E skipped: docker restart failed");
  }

  console.log("\n============================================");
  console.log("PASS: " + pass);
  console.log("FAIL: " + fail);
  console.log("BLOCKED: " + blocked);
  console.log("============================================");
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exit(2); });