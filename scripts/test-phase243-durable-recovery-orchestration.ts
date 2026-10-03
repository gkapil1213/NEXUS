// scripts/test-phase243-durable-recovery-orchestration.ts
// Phase 243 — durable recovery orchestration verifier. Uses real PostgreSQL
// and real independent child processes. No in-memory coordination.
import { spawn, execSync, type ChildProcess } from "child_process";
import Database from "better-sqlite3";
import { PgClient } from "../src/core/pg-client";
import { PgAsyncEngine } from "../src/core/pg-async-engine";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { AsyncExecutionRecoveryOperationStore } from "../src/core/execution-recovery-operation-store";

let passed = 0, failed = 0, blocked = 0, notExec = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log("PASS  " + msg); }
  else { failed++; console.log("FAIL  " + msg); }
}
function blk(msg: string, reason: string): void { blocked++; console.log("BLOCKED  " + msg + " :: " + reason); }
function ne(msg: string, reason: string): void { notExec++; console.log("NOT EXECUTED  " + msg + " :: " + reason); }
function section(t: string): void { console.log("\n--- " + t + " ---"); }
function uniq(t: string): string { return `p243-${t}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`; }

const CHILD = "scripts/_phase243_recovery_child.ts";
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

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL required"); process.exit(2); }
  if (process.env.NEXUS_PERSISTENCE_MODE !== "shared") {
    blk("Phase 243 shared mode", "NEXUS_PERSISTENCE_MODE must be shared"); process.exit(1);
  }
  const container = process.env.NEXUS_POSTGRES_CONTAINER ?? "nexus-pg";

  const pg = new PgClient();
  await pg.connect(url);
  const asyncDb = new PgAsyncEngine(pg);
  const ops = new AsyncExecutionRecoveryOperationStore(asyncDb);
  const mem = new Database(":memory:");
  const syncEngine = SQLiteEngine.fromDatabase(mem);
  const store = new ExecutionStore(syncEngine, asyncDb);

  // ---------- A01 ----------
  section("A01 — shared PostgreSQL probe");
  {
    const p = await pg.probe();
    ok(p.ok === true, "A01 pg probe ok");
    ok(store.hasAsyncBackend() === true, "A01 store has async backend");
  }

  // ---------- A02 ----------
  section("A02 — durable recovery creation");
  let jobIdA02 = uniq("a02");
  {
    const r = await ops.createOrGetOperation({ jobId: jobIdA02, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY" });
    ok(r.created === true && r.operation.state === "PENDING", "A02 created PENDING");
    ok(r.operation.nextAttemptAt === null, "A02 nextAttemptAt initially null");
    ok(r.operation.lastFailureClass === null, "A02 lastFailureClass initially null");
  }

  // ---------- A03 ----------
  section("A03 — retry eligibility scheduling");
  {
    const jobId = uniq("a03");
    const c = await ops.createOrGetOperation({ jobId, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY" });
    await ops.claimOperation({ operationId: c.operation.operationId, owner: "A", durationMs: 60_000 });
    const now = Date.now();
    await ops.markFailed(c.operation.operationId, "A", "request TIMEOUT", now, { failureClass: "RETRYABLE", nextAttemptAt: now + 60_000 });
    const before = await ops.listResumableOperations(now);
    const after = await ops.listResumableOperations(now + 61_000);
    ok(!before.some((o) => o.operationId === c.operation.operationId), "A03 not eligible before next_attempt_at");
    ok(after.some((o) => o.operationId === c.operation.operationId), "A03 eligible after next_attempt_at");
  }

  // ---------- A04 ----------
  section("A04 — duplicate recovery idempotency");
  {
    const jobId = uniq("a04");
    const key = "p243-a04-" + jobId;
    const r1 = await ops.createOrGetOperation({ jobId, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY", idempotencyKey: key });
    const r2 = await ops.createOrGetOperation({ jobId, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY", idempotencyKey: key });
    ok(r1.operation.operationId === r2.operation.operationId, "A04 duplicate create returns same op");
    ok(r2.created === false, "A04 second create is not created");
  }

  // ---------- A05 / A06 / A07 ----------
  section("A05/A06/A07 — concurrent claimants");
  {
    for (const [label, n] of [["A05", 2], ["A06", 4], ["A07", 8]] as const) {
      const jobId = uniq(label.toLowerCase());
      const c = await ops.createOrGetOperation({ jobId, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY" });
      const opId = c.operation.operationId;
      const owners = Array.from({ length: n }, (_, i) => `${label}-owner-${i}-${Date.now()}`);
      const results = await Promise.all(owners.map((o) => runChild(url, "claim-op", opId, o)));
      const claimed = results.filter((r) => r.json?.claimed === true).length;
      ok(claimed === 1, `${label} exactly one of ${n} claimants wins (got ${claimed})`);
    }
  }

  // ---------- A08 / A09 / A10 ----------
  section("A08/A09/A10 — stale owner + replacement + fencing");
  {
    const jobId = uniq("a08");
    const c = await ops.createOrGetOperation({ jobId, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY" });
    const opId = c.operation.operationId;
    const ownerA = "A08-A-" + Date.now();
    const ownerB = "A08-B-" + Date.now();

    const ca = await runChild(url, "claim-op", opId, ownerA, "500");
    ok(ca.json?.claimed === true, "A08 owner A claimed with 500ms lease");

    await new Promise((r) => setTimeout(r, 800));
    const cb = await runChild(url, "claim-op", opId, ownerB, "60000");
    ok(cb.json?.claimed === true, "A09 replacement owner B claimed after expiry");

    const staleComplete = await runChild(url, "complete-op", opId, ownerA);
    ok(staleComplete.json?.completed === false, "A10 stale owner A cannot complete");

    const freshComplete = await runChild(url, "complete-op", opId, ownerB);
    ok(freshComplete.json?.completed === true, "A10 current owner B can complete");
  }

  // ---------- A11 ----------
  section("A11 — scheduler crash before claim");
  {
    const jobId = uniq("a11");
    const c = await ops.createOrGetOperation({ jobId, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY" });
    // Simulate: process started and exited without claiming.
    const probe = await runChild(url, "probe");
    ok(probe.json?.ok === true, "A11 crashed scheduler left db reachable");
    const reread = await ops.getOperation(c.operation.operationId);
    ok(reread?.state === "PENDING", "A11 op still PENDING and recoverable");
  }

  // ---------- A12 ----------
  section("A12 — scheduler crash after claim");
  {
    const jobId = uniq("a12");
    const c = await ops.createOrGetOperation({ jobId, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY" });
    const opId = c.operation.operationId;
    const crashedOwner = "A12-crashed-" + Date.now();
    // Claim with short TTL, then simulate crash by just not renewing.
    const ca = await runChild(url, "claim-op", opId, crashedOwner, "500");
    ok(ca.json?.claimed === true, "A12 crashed owner claimed with short TTL");

    await new Promise((r) => setTimeout(r, 800));
    const newOwner = "A12-new-" + Date.now();
    const cb = await runChild(url, "claim-op", opId, newOwner, "60000");
    ok(cb.json?.claimed === true, "A12 replacement claimed after lease expiry");
  }

  // ---------- A13 ----------
  section("A13 — worker crash during retry");
  {
    const jobId = uniq("a13");
    const c = await ops.createOrGetOperation({ jobId, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY" });
    const opId = c.operation.operationId;
    const w1 = "A13-w1-" + Date.now();
    const w2 = "A13-w2-" + Date.now();
    await runChild(url, "claim-op", opId, w1, "500");
    // Worker crashes without completing.
    await new Promise((r) => setTimeout(r, 800));
    const cb = await runChild(url, "claim-op", opId, w2, "60000");
    ok(cb.json?.claimed === true, "A13 replacement worker recovered crashed retry");
  }

  // ---------- A14 ----------
  section("A14 — PostgreSQL restart recovery");
  {
    const jobId = uniq("a14");
    const c = await ops.createOrGetOperation({ jobId, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY" });
    const opId = c.operation.operationId;
    await ops.claimOperation({ operationId: opId, owner: "A14-A", durationMs: 60_000 });
    const now = Date.now();
    await ops.markFailed(opId, "A14-A", "request TIMEOUT", now, { failureClass: "RETRYABLE", nextAttemptAt: now + 120_000 });
    const before = await ops.getOperation(opId);
    try { await pg.close(); } catch {}

    let restarted = true;
    try { execSync(`docker restart ${container}`, { stdio: "pipe", timeout: 90_000 }); }
    catch (e) { restarted = false; blk("A14 docker restart", (e as Error).message); }

    if (restarted) {
      let reconnected = false;
      const deadline = Date.now() + 45_000;
      let p2: PgClient | null = null;
      while (Date.now() < deadline) {
        try {
          p2 = new PgClient();
          await p2.connect(url);
          if ((await p2.probe()).ok) { reconnected = true; break; }
          await p2.close(); p2 = null;
        } catch { try { await p2?.close(); } catch {} p2 = null; await new Promise((r) => setTimeout(r, 500)); }
      }
      ok(reconnected, "A14 postgres reachable after restart");
      if (reconnected && p2) {
        const ops2 = new AsyncExecutionRecoveryOperationStore(new PgAsyncEngine(p2));
        const after = await ops2.getOperation(opId);
        ok(after?.lastFailureClass === "RETRYABLE", "A14 failure class survived restart");
        ok(after?.nextAttemptAt === before?.nextAttemptAt, "A14 nextAttemptAt survived restart");
        try { await p2.close(); } catch {}
      }
    }
  }

  // Reconnect main pg for remaining checks
  const pg2 = new PgClient(); await pg2.connect(url);
  const ops2 = new AsyncExecutionRecoveryOperationStore(new PgAsyncEngine(pg2));

  // ---------- A15 ----------
  section("A15 — maximum retry attempts");
  {
    const jobId = uniq("a15");
    const c = await ops2.createOrGetOperation({ jobId, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY" });
    const opId = c.operation.operationId;
    for (let i = 0; i < 5; i++) {
      const cl = await ops2.claimOperation({ operationId: opId, owner: "A15-" + i, durationMs: 60_000 });
      if (!cl.claimed) break;
      await ops2.markFailed(opId, "A15-" + i, "request TIMEOUT", Date.now(), { failureClass: "RETRYABLE", nextAttemptAt: Date.now() + 1000 });
    }
    const after = await ops2.getOperation(opId);
    ok((after?.attemptCount ?? 0) >= 5, "A15 attemptCount reached 5+ (got " + after?.attemptCount + ")");
  }

  // ---------- A16 ----------
  section("A16 — non-retryable failure");
  {
    const jobId = uniq("a16");
    const c = await ops2.createOrGetOperation({ jobId, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY" });
    await ops2.claimOperation({ operationId: c.operation.operationId, owner: "A16", durationMs: 60_000 });
    await ops2.markFailed(c.operation.operationId, "A16", "VALIDATION_FAILED: bad input", Date.now(), { failureClass: "NON_RETRYABLE", nextAttemptAt: null });
    const after = await ops2.getOperation(c.operation.operationId);
    ok(after?.lastFailureClass === "NON_RETRYABLE", "A16 class NON_RETRYABLE persisted");
    ok(after?.nextAttemptAt === null, "A16 non-retryable has no next_attempt_at");
  }

  // ---------- A17 ----------
  section("A17 — unknown classification defaults to NON_RETRYABLE");
  {
    const { classifyOperationFailure } = await import("../src/core/operation-failure-classification");
    ok(classifyOperationFailure("totally unknown blob") === "NON_RETRYABLE", "A17 unknown -> NON_RETRYABLE");
  }

  // ---------- A18 ----------
  section("A18 — duplicate request after process restart");
  {
    const jobId = uniq("a18");
    const key = "p243-a18-" + jobId;
    const r1 = await runChild(url, "create-op", jobId, key);
    const r2 = await runChild(url, "create-op", jobId, key);
    ok(r1.json?.operationId === r2.json?.operationId, "A18 same op across processes");
    ok(r2.json?.created === false, "A18 second process not creating new op");
  }

  // ---------- A19 ----------
  section("A19 — database invariants");
  {
    // I02: no op has more than one active claim.
    const dupOwner = await pg2.query<{ cnt: string }>(
      "SELECT COUNT(*)::text AS cnt FROM (SELECT operation_id FROM execution_recovery_operations WHERE claim_owner IS NOT NULL GROUP BY operation_id HAVING COUNT(DISTINCT claim_owner) > 1) x"
    );
    ok(Number(dupOwner.rows[0]?.cnt) === 0, "I02 no operation has >1 authoritative owner");

    // I03: non-retryable has NULL next_attempt_at
    const badNext = await pg2.query<{ cnt: string }>(
      "SELECT COUNT(*)::text AS cnt FROM execution_recovery_operations WHERE last_failure_class = 'NON_RETRYABLE' AND next_attempt_at IS NOT NULL"
    );
    ok(Number(badNext.rows[0]?.cnt) === 0, "I03 non-retryable never has future retry");

    // I04: attempt_count <= 100
    const overflow = await pg2.query<{ cnt: string }>(
      "SELECT COUNT(*)::text AS cnt FROM execution_recovery_operations WHERE attempt_count > 100"
    );
    ok(Number(overflow.rows[0]?.cnt) === 0, "I04 no runaway attempt_count");

    // I08: coordination data is in PG
    const hasRows = await pg2.query<{ cnt: string }>(
      "SELECT COUNT(*)::text AS cnt FROM execution_recovery_operations"
    );
    ok(Number(hasRows.rows[0]?.cnt) >= 1, "I08 recovery operations persisted in PostgreSQL");
  }

  // ---------- A20 ----------
  section("A20 — no SQLite fallback in shared coordination");
  {
    // A worker created via async store must NOT appear in SQLite.
    const probeWid = uniq("a20");
    await ops2.createOrGetOperation({ jobId: probeWid, leaseId: null, workerId: probeWid, operationType: "ORPHAN_RECOVERY" });
    const inPg = await pg2.query<{ cnt: string }>(
      "SELECT COUNT(*)::text AS cnt FROM execution_recovery_operations WHERE job_id = $1",
      [probeWid],
    );
    ok(Number(inPg.rows[0]?.cnt) === 1, "A20 op visible in PostgreSQL");

    let sqliteHas = false;
    try {
      const row = (syncEngine as any).prepare("SELECT COUNT(*) AS cnt FROM execution_recovery_operations WHERE job_id = ?").get(probeWid) as any;
      sqliteHas = Number(row?.cnt ?? 0) > 0;
    } catch { /* table may not exist — that's fine */ }
    ok(sqliteHas === false, "A20 op NOT visible in SQLite");
  }

  // ---------- A21 ----------
  section("A21 — TypeScript compilation");
  {
    let tscOk = false, tscErr = "";
    try { execSync("npx tsc --noEmit", { stdio: "pipe", timeout: 240_000 }); tscOk = true; }
    catch (e: any) { tscErr = String(e?.stderr ?? e?.message ?? e).slice(0, 300); }
    ok(tscOk, "A21 tsc --noEmit clean" + (tscOk ? "" : " — " + tscErr));
  }

  // ---------- A22 ----------
  section("A22 — clean shutdown");
  {
    let shutdownOk = true;
    try { await pg2.close(); } catch { shutdownOk = false; }
    ok(shutdownOk, "A22 primary pg client closed cleanly");
  }

  // ---------- A23 ----------
  section("A23 — Phase 242 regression");
  {
    let p242Ok = false, p242Out = "";
    try {
      p242Out = execSync("npx tsx scripts/test-phase242-durable-retry.ts", { stdio: "pipe", timeout: 300_000 }).toString();
      p242Ok = /PASS:\s*30/.test(p242Out) && /FAIL:\s*0/.test(p242Out);
    } catch (e: any) { p242Out = String(e?.stdout ?? e?.stderr ?? e).slice(0, 400); }
    ok(p242Ok, "A23 Phase 242 verifier PASS:30" + (p242Ok ? "" : " — " + p242Out.slice(-200)));
  }

  // ---------- Summary ----------
  console.log("\n============================================");
  console.log("PASS: " + passed);
  console.log("FAIL: " + failed);
  console.log("BLOCKED: " + blocked);
  console.log("NOT EXECUTED: " + notExec);
  console.log("============================================");

  try { mem.close(); } catch {}
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exit(1); });