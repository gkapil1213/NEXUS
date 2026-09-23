// scripts/test-phase184-distributed-coordination.ts
// Phase 184 distributed coordination verifier. Real Postgres, real child
// processes for every concurrency claim. No in-memory coordination.

import { spawn, execSync, type ChildProcess } from "child_process";
import Database from "better-sqlite3";
import { PgClient } from "../src/core/pg-client";
import { PgAsyncEngine } from "../src/core/pg-async-engine";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { WorkerRegistry } from "../src/core/worker-registry";
import { LeaseManager } from "../src/core/lease-manager";

let passed = 0, failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log("  ok   " + msg); }
  else { failed++; console.log("  FAIL " + msg); }
}
function section(t: string): void { console.log("\n" + t); }

const CHILD = "scripts/_phase184_distributed_child.ts";
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

function mkJob(id: string, status = "QUEUED", extra: Record<string, unknown> = {}): any {
  const now = Date.now();
  return {
    id, idempotencyKey: "p184-" + id, jobType: "engineering",
    payload: { kind: "engineering" }, status,
    createdAt: now, updatedAt: now,
    cancellationRequested: false, cancellationAcknowledged: false,
    ...extra,
  };
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
  const leaseManager = new LeaseManager(store);
  const registry = new WorkerRegistry(store, leaseManager);

  // ---------- D01 ----------
  section("D01 - shared PostgreSQL configuration");
  {
    const probe = await pg.probe();
    ok(probe.ok === true, "D01 Postgres probe ok");
    ok(store.hasAsyncBackend() === true, "D01 store.hasAsyncBackend() true");
    ok(process.env.NEXUS_PERSISTENCE_MODE === "shared", "D01 NEXUS_PERSISTENCE_MODE=shared");
    const idx = await pg.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename='execution_leases' AND indexname='idx_leases_one_active_per_job'",
    );
    ok(idx.rows.length === 1, "D01 idx_leases_one_active_per_job present (I01 enforced at DB)");
  }

  // ---------- D02 ----------
  section("D02 - multi-process worker registration");
  {
    const workers = ["p184-d02-a-" + Date.now(), "p184-d02-b-" + Date.now(), "p184-d02-c-" + Date.now()];
    const children = await Promise.all(workers.map((w) => runChild(url, "register-worker", w)));
    for (let i = 0; i < workers.length; i++) {
      ok(children[i].json?.workerId === workers[i], "D02 child " + i + " registered " + workers[i]);
    }
    const r = await pg.query<{ worker_id: string }>(
      "SELECT worker_id FROM execution_workers WHERE worker_id = ANY($1::text[])",
      [workers],
    );
    ok(r.rows.length === 3, "D02 all 3 workers visible in Postgres");
  }

  // ---------- D03 + D04 ----------
  section("D03 - concurrent job claim / D04 - exactly-one successful claimant");
  {
    const jobId = "p184-d03-" + Date.now();
    await store.createJobAsync(mkJob(jobId));

    const N = 6;
    const workers = Array.from({ length: N }, (_, i) => "p184-d03-w-" + i + "-" + Date.now());
    // Also register each worker so markBusyIO has a row when claimNextJobAsync runs.
    // For atomicClaimJobAsync directly, worker row is not required.
    const results = await Promise.all(
      workers.map((w) => runChild(url, "claim-job", jobId, w)),
    );
    const claimedCount = results.filter((r) => r.json?.claimed === true).length;
    const failedCount = results.filter((r) => r.json?.claimed === false).length;

    ok(claimedCount === 1, "D04 exactly one successful claimant (got " + claimedCount + ")");
    ok(failedCount === N - 1, "D04 losers received legitimate no-claim (got " + failedCount + ")");
    for (const r of results) {
      if (!r.json) console.log("    child raw:", r.stdout.slice(0, 200), r.stderr.slice(0, 400));
    }
    // DB-level invariant: exactly one ACTIVE lease for this job.
    const leases = await pg.query<{ lease_id: string; worker_id: string }>(
      "SELECT lease_id, worker_id FROM execution_leases WHERE job_id=$1 AND status='ACTIVE'",
      [jobId],
    );
    ok(leases.rows.length === 1, "D03 exactly one ACTIVE lease row in Postgres");
    const job = await store.getJobAsync(jobId);
    ok(job?.status === "CLAIMED", "D03 job status CLAIMED");
    ok(job?.currentLeaseId === leases.rows[0]?.lease_id, "D03 job.currentLeaseId matches lease");
    const winnerWid = leases.rows[0]?.worker_id;
    const claimedChild = results.find((r) => r.json?.claimed === true);
    ok(claimedChild?.json?.workerId === winnerWid, "D03 winner workerId matches DB lease owner");
  }

  // ---------- D05 + D06 ----------
  section("D05 - lease ownership persistence / D06 - cross-process lease visibility");
  {
    const jobId = "p184-d05-" + Date.now();
    await store.createJobAsync(mkJob(jobId));
    const wid = "p184-d05-w-" + Date.now();
    const claim = await runChild(url, "claim-job", jobId, wid);
    const leaseId = claim.json?.leaseId;
    ok(typeof leaseId === "string" && leaseId.length > 0, "D05 child returned a leaseId");

    const lease = await store.getLeaseAsync(leaseId);
    ok(lease?.workerId === wid, "D05 lease workerId persisted");
    ok(lease?.status === "ACTIVE", "D05 lease status ACTIVE");

    const child = await runChild(url, "read-active-lease-for-job", jobId);
    ok(child.json?.found === true, "D06 second process sees ACTIVE lease");
    ok(child.json?.lease?.leaseId === leaseId, "D06 second process sees same leaseId");
    ok(child.json?.lease?.workerId === wid, "D06 second process sees same workerId");
  }

  // ---------- D07 ----------
  section("D07 - heartbeat persistence");
  {
    const wid = "p184-d07-w-" + Date.now();
    await runChild(url, "register-worker", wid);
    const before = (await store.getWorkerAsync(wid))?.lastHeartbeatAt ?? 0;
    await new Promise((r) => setTimeout(r, 20));
    const hb = await runChild(url, "heartbeat", wid);
    ok(hb.json?.healthy === true, "D07 heartbeat accepted");
    const after = (await store.getWorkerAsync(wid))?.lastHeartbeatAt ?? 0;
    ok(after > before, "D07 heartbeat updated in Postgres (" + before + " -> " + after + ")");
  }

  // ---------- D08 + D09 ----------
  section("D08 - stale lease detection / D09 - stale worker recovery");
  {
    const jobId = "p184-d08-" + Date.now();
    const wid = "p184-d08-w-" + Date.now();
    await store.createJobAsync(mkJob(jobId, "QUEUED", { retryPolicy: { maxAttempts: 3, initialDelayMs: 1000, multiplier: 1, maxDelayMs: 5000 } }));
    const now = Date.now();
    // Seed expired ACTIVE lease directly in PG (simulates a dead worker).
    await pg.query(
      "INSERT INTO execution_leases (lease_id, job_id, worker_id, acquired_at, expires_at, status) " +
      "VALUES ($1,$2,$3,$4,$5,'ACTIVE')",
      ["p184-d08-lease-" + now, jobId, wid, now - 120_000, now - 60_000],
    );
    await pg.query("UPDATE execution_jobs SET status='CLAIMED', current_lease_id=$1 WHERE id=$2", [
      "p184-d08-lease-" + now, jobId,
    ]);

    const rec = await runChild(url, "run-recovery");
    if (!rec.json?.recovered) console.log("    [D09] child stderr:", rec.stderr.slice(0, 600));
    ok(rec.json?.recovered === true, "D09 recovery loop ran in independent process");
    ok((await pg.query<{ status: string }>("SELECT status FROM execution_leases WHERE lease_id=$1", ["p184-d08-lease-" + now])).rows[0]?.status === "EXPIRED", "D08 stale lease transitioned to EXPIRED");
    const jobAfterRecovery = await pg.query<{ status: string }>("SELECT status FROM execution_jobs WHERE id=$1", [jobId]);
    ok(jobAfterRecovery.rows[0]?.status === "QUEUED", "D09 job transitioned to QUEUED (got " + jobAfterRecovery.rows[0]?.status + ")");

    const newWid = "p184-d08-new-" + Date.now();
    const claim = await runChild(url, "claim-job", jobId, newWid);
    ok(claim.json?.claimed === true, "D09 replacement worker claimed recovered job");
    const activeLeases = await pg.query<{ worker_id: string }>(
      "SELECT worker_id FROM execution_leases WHERE job_id=$1 AND status='ACTIVE'",
      [jobId],
    );
    ok(activeLeases.rows.length === 1, "D08 exactly one ACTIVE lease after recovery");
    ok(activeLeases.rows[0]?.worker_id === newWid, "D09 ACTIVE lease owned by replacement worker");
  }

  // ---------- D10 ----------
  section("D10 - old worker fenced after recovery");
  {
    const jobId = "p184-d10-" + Date.now();
    const oldWid = "p184-d10-old-" + Date.now();
    const newWid = "p184-d10-new-" + Date.now();
    await store.createJobAsync(mkJob(jobId, "QUEUED", { retryPolicy: { maxAttempts: 3, initialDelayMs: 1000, multiplier: 1, maxDelayMs: 5000 } }));
    const now = Date.now();

    // Seed: old worker owns an already-expired ACTIVE lease.
    const oldLeaseId = "p184-d10-old-lease-" + now;
    await pg.query(
      "INSERT INTO execution_leases (lease_id, job_id, worker_id, acquired_at, expires_at, status) " +
      "VALUES ($1,$2,$3,$4,$5,'ACTIVE')",
      [oldLeaseId, jobId, oldWid, now - 120_000, now - 60_000],
    );
    await pg.query("UPDATE execution_jobs SET status='CLAIMED', current_lease_id=$1 WHERE id=$2", [oldLeaseId, jobId]);

    const rec10 = await runChild(url, "run-recovery");
    ok(rec10.json?.recovered === true, "D10 recovery loop ran in independent process");

    const newClaim = await runChild(url, "claim-job", jobId, newWid);
    ok(newClaim.json?.claimed === true, "D10 replacement claimed recovered job");

    // Move job to RUNNING + create an attempt bound to old lease for the completion test.
    const attemptId = "p184-d10-att-" + Date.now();
    await store.createAttemptAsync({
      id: attemptId, jobId, attemptNumber: 1, status: "RUNNING",
      createdAt: now, startedAt: now,
    } as any);
    await pg.query("UPDATE execution_jobs SET status='RUNNING' WHERE id=$1", [jobId]);

    // Old worker's completion attempt MUST be rejected.
    const oldRes = await runChild(url, "complete-attempt", attemptId, jobId, oldLeaseId, oldWid, "SUCCEEDED");
    ok(oldRes.json?.completeOk === false, "D10 old worker completion REJECTED");
    ok(oldRes.json?.reason === "WORKER_OWNERSHIP_LOST", "D10 reason = WORKER_OWNERSHIP_LOST");
    const att = await store.getAttemptAsync(attemptId);
    ok(att?.status === "RUNNING", "D10 attempt still RUNNING after fence");
    const job = await store.getJobAsync(jobId);
    ok(job?.status === "RUNNING", "D10 job still RUNNING after fence");
  }


  section("D11 - concurrent retry protection");
  {
    const jobId = "p184-d11-" + Date.now();
    const wid = "p184-d11-w-" + Date.now();
    await store.createJobAsync(mkJob(jobId, "QUEUED", { retryPolicy: { maxAttempts: 3, initialDelayMs: 1000, multiplier: 1, maxDelayMs: 5000 } }));
    const now = Date.now();
    await pg.query("INSERT INTO execution_leases (lease_id, job_id, worker_id, acquired_at, expires_at, status) VALUES ($1,$2,$3,$4,$5,'ACTIVE')", ["p184-d11-lease-" + now, jobId, wid, now - 120_000, now - 60_000]);
    await pg.query("UPDATE execution_jobs SET status='CLAIMED', current_lease_id=$1 WHERE id=$2", ["p184-d11-lease-" + now, jobId]);
    const recs = await Promise.all([runChild(url, "run-recovery"), runChild(url, "run-recovery"), runChild(url, "run-recovery"), runChild(url, "run-recovery")]);
    ok(recs.filter((r) => r.json?.recovered === true).length === 4, "D11 all 4 recovery processes ran");
    const ops = await pg.query<{ cnt: string }>("SELECT COUNT(*)::text AS cnt FROM execution_recovery_operations WHERE job_id = $1 AND operation_type = 'ORPHAN_RECOVERY'", [jobId]);
    ok(Number(ops.rows[0]?.cnt) === 1, "D11 exactly one ORPHAN_RECOVERY op (got " + ops.rows[0]?.cnt + ")");
    const job = await store.getJobAsync(jobId);
    ok(job?.status === "QUEUED" || job?.status === "RETRY_SCHEDULED", "D11 job QUEUED/RETRY_SCHEDULED (got " + job?.status + ")");
  }

  section("D12 - duplicate recovery idempotency");
  {
    const jobId = "p184-d12-" + Date.now();
    const wid = "p184-d12-w-" + Date.now();
    await store.createJobAsync(mkJob(jobId, "QUEUED", { retryPolicy: { maxAttempts: 3, initialDelayMs: 1000, multiplier: 1, maxDelayMs: 5000 } }));
    const now = Date.now();
    await pg.query("INSERT INTO execution_leases (lease_id, job_id, worker_id, acquired_at, expires_at, status) VALUES ($1,$2,$3,$4,$5,'ACTIVE')", ["p184-d12-lease-" + now, jobId, wid, now - 120_000, now - 60_000]);
    await pg.query("UPDATE execution_jobs SET status='CLAIMED', current_lease_id=$1 WHERE id=$2", ["p184-d12-lease-" + now, jobId]);
    await Promise.all([runChild(url, "run-recovery"), runChild(url, "run-recovery"), runChild(url, "run-recovery")]);
    const opRows = await pg.query<{ cnt: string }>("SELECT COUNT(*)::text AS cnt FROM execution_recovery_operations WHERE job_id = $1", [jobId]);
    ok(Number(opRows.rows[0]?.cnt) === 1, "D12 exactly one recovery op row (got " + opRows.rows[0]?.cnt + ")");
  }

  section("D13 - cancellation race");
  {
    const jobId = "p184-d13-" + Date.now();
    const wid = "p184-d13-w-" + Date.now();
    await store.createJobAsync(mkJob(jobId, "RUNNING"));
    const now = Date.now();
    const leaseId = "p184-d13-lease-" + now;
    await pg.query("INSERT INTO execution_leases (lease_id, job_id, worker_id, acquired_at, expires_at, status) VALUES ($1,$2,$3,$4,$5,'ACTIVE')", [leaseId, jobId, wid, now, now + 300_000]);
    await pg.query("UPDATE execution_jobs SET status='RUNNING', current_lease_id=$1 WHERE id=$2", [leaseId, jobId]);
    const attemptId = "p184-d13-att-" + now;
    await store.createAttemptAsync({ id: attemptId, jobId, attemptNumber: 1, status: "RUNNING", createdAt: now, startedAt: now } as any);
    await Promise.all([
      runChild(url, "cancel-job", jobId),
      runChild(url, "complete-attempt", attemptId, jobId, leaseId, wid, "SUCCEEDED"),
    ]);
    const jobAfter = await store.getJobAsync(jobId);
    const attAfter = await store.getAttemptAsync(attemptId);
    ok(attAfter?.status === "SUCCEEDED" || attAfter?.status === "RUNNING", "D13 attempt coherent (got " + attAfter?.status + ")");
    ok(jobAfter?.status !== "QUEUED", "D13 job not resurrected to QUEUED (got " + jobAfter?.status + ")");
  }

  section("D14 - concurrent completion race");
  {
    const jobId = "p184-d14-" + Date.now();
    const wid = "p184-d14-w-" + Date.now();
    await store.createJobAsync(mkJob(jobId, "RUNNING"));
    const now = Date.now();
    const leaseId = "p184-d14-lease-" + now;
    await pg.query("INSERT INTO execution_leases (lease_id, job_id, worker_id, acquired_at, expires_at, status) VALUES ($1,$2,$3,$4,$5,'ACTIVE')", [leaseId, jobId, wid, now, now + 300_000]);
    await pg.query("UPDATE execution_jobs SET status='RUNNING', current_lease_id=$1 WHERE id=$2", [leaseId, jobId]);
    const attemptId = "p184-d14-att-" + now;
    await store.createAttemptAsync({ id: attemptId, jobId, attemptNumber: 1, status: "RUNNING", createdAt: now, startedAt: now } as any);
    const comps = await Promise.all([
      runChild(url, "complete-attempt", attemptId, jobId, leaseId, wid, "SUCCEEDED"),
      runChild(url, "complete-attempt", attemptId, jobId, leaseId, wid, "SUCCEEDED"),
      runChild(url, "complete-attempt", attemptId, jobId, leaseId, wid, "SUCCEEDED"),
    ]);
    ok(comps.filter((r) => r.json?.completeOk === true).length >= 1, "D14 at least one completion applied");
    ok((await store.getAttemptAsync(attemptId))?.status === "SUCCEEDED", "D14 attempt SUCCEEDED");
    ok((await store.getJobAsync(jobId))?.status === "SUCCEEDED", "D14 job SUCCEEDED");
    const prov = await pg.query<{ cnt: string }>("SELECT COUNT(*)::text AS cnt FROM execution_outcome_provenance WHERE attempt_id = $1", [attemptId]);
    ok(Number(prov.rows[0]?.cnt) === 1, "D14 exactly one provenance row (got " + prov.rows[0]?.cnt + ")");
  }

  section("D15 - database invariant checks");
  {
    const dupActive = await pg.query<{ cnt: string }>("SELECT COUNT(*)::text AS cnt FROM (SELECT job_id FROM execution_leases WHERE status='ACTIVE' GROUP BY job_id HAVING COUNT(*)>1) x");
    ok(Number(dupActive.rows[0]?.cnt) === 0, "D15 I01: no job with >1 ACTIVE lease");
    const idx = await pg.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE tablename='execution_leases' AND indexname='idx_leases_one_active_per_job'");
    ok(idx.rows.length === 1, "D15 I01 partial unique index present");
    const badTerminal = await pg.query<{ cnt: string }>("SELECT COUNT(*)::text AS cnt FROM execution_attempts WHERE status NOT IN ('RUNNING','PENDING','SUCCEEDED','FAILED','CANCELLED','DEAD_LETTER')");
    ok(Number(badTerminal.rows[0]?.cnt) === 0, "D15 I04: no attempt in unexpected status");
  }

  section("D17 - local SQLite compatibility");
  {
    const localMem = new Database(":memory:");
    const localSync = SQLiteEngine.fromDatabase(localMem);
    const localStore = new ExecutionStore(localSync);
    ok(localStore.hasAsyncBackend() === false, "D17 local hasAsyncBackend false");
    let threw = false;
    try { await localStore.registerWorkerAsync({ workerId: "x", status: "ONLINE", registeredAt: Date.now() } as any); } catch { threw = true; }
    ok(threw, "D17 async method throws without asyncDb");
    localMem.close();
  }

  section("D18 - no silent SQLite fallback");
  {
    const uWid = "p184-d18-" + Date.now();
    await runChild(url, "register-worker", uWid);
    const inPg = await pg.query<{ worker_id: string }>("SELECT worker_id FROM execution_workers WHERE worker_id = $1", [uWid]);
    ok(inPg.rows.length === 1, "D18 worker exists in Postgres");
    let missing = false, reason = "";
    try { missing = store.getWorker(uWid) === undefined; reason = missing ? "row absent" : "row present (FAIL)"; }
    catch (e: any) { if (/no such table/i.test(String(e?.message))) { missing = true; reason = "sqlite table not created"; } else throw e; }
    ok(missing, "D18 worker NOT in SQLite - " + reason);
  }

  section("D19 - TypeScript compatibility");
  {
    let tscOk = false, tscErr = "";
    try { execSync("npx tsc --noEmit", { stdio: "pipe", timeout: 240_000 }); tscOk = true; }
    catch (e: any) { tscErr = String(e?.stderr ?? e?.message ?? e).slice(0, 300); }
    ok(tscOk, "D19 tsc --noEmit clean" + (tscOk ? "" : " — " + tscErr));
  }

  section("D20 - clean shutdown behavior");
  {
    const wId = "p184-d20-w-" + Date.now();
    await runChild(url, "register-worker", wId);
    ok((await store.getWorkerAsync(wId))?.status === "ONLINE", "D20 worker ONLINE");
    const jobId = "p184-d20-job-" + Date.now();
    await store.createJobAsync(mkJob(jobId));
    const claim = await runChild(url, "claim-job", jobId, wId);
    ok(claim.json?.claimed === true, "D20 worker claimed job");
    await registry.drainAsync(wId);
    ok((await store.getWorkerAsync(wId))?.status === "DRAINING", "D20 DRAINING persisted");
    await leaseManager.releaseLeaseAsync(claim.json.leaseId);
    ok((await store.getLeaseAsync(claim.json.leaseId))?.status === "RELEASED", "D20 lease RELEASED");
    await registry.unregisterAsync(wId);
    ok((await store.getWorkerAsync(wId))?.status === "OFFLINE", "D20 worker OFFLINE");
    const left = await pg.query<{ cnt: string }>("SELECT COUNT(*)::text AS cnt FROM execution_leases WHERE worker_id = $1 AND status = 'ACTIVE'", [wId]);
    ok(Number(left.rows[0]?.cnt) === 0, "D20 no ACTIVE leases left for offlined worker");
  }

  section("D16 - PostgreSQL restart recovery");
  {
    const rWid = "p184-d16-w-" + Date.now();
    const rJobId = "p184-d16-job-" + Date.now();
    await store.createJobAsync(mkJob(rJobId));
    await runChild(url, "register-worker", rWid);
    const claim = await runChild(url, "claim-job", rJobId, rWid);
    const leaseId = claim.json?.leaseId;
    ok(typeof leaseId === "string", "D16 lease created before restart");
    try { await pg.close(); } catch {}
    let restartErr: string | null = null;
    try { execSync("docker restart nexus-phase183-postgres", { stdio: "pipe", timeout: 90_000 }); } catch (e) { restartErr = (e as Error).message; }
    ok(restartErr === null, "D16 docker restart executed");
    let reconnected = false;
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      try { const p2 = new PgClient(); await p2.connect(url); if ((await p2.probe()).ok) { reconnected = true; await p2.close(); break; } await p2.close(); } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
    ok(reconnected, "D16 postgres reachable after restart");
    const w = await runChild(url, "read-worker", rWid);
    ok(w.json?.found === true, "D16 worker survived restart");
    const l = await runChild(url, "read-lease", leaseId!);
    ok(l.json?.lease?.status === "ACTIVE", "D16 lease ACTIVE after restart");
    const j = await runChild(url, "read-job", rJobId);
    ok(j.json?.job?.status === "CLAIMED", "D16 job CLAIMED after restart");
  }

  console.log("\n=== Phase 184 distributed coordination Summary ===");
  console.log("Passed: " + passed);
  console.log("Failed: " + failed);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exit(1); });
