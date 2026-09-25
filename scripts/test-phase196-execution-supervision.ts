// scripts/test-phase196-execution-supervision.ts
import { unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { LeaseManager } from "../src/core/lease-manager";
import { ExecutionEngine } from "../src/core/execution-engine";
import { RetryEngine } from "../src/core/retry-engine";
import { WorkerRegistry } from "../src/core/worker-registry";

let pass = 0, fail = 0;
function ok(n: string, c: boolean, d = "") {
  if (c) { pass++; console.log("[PASSED] " + n + (d ? "  " + d : "")); }
  else   { fail++; console.log("[FAILED] " + n + (d ? "  " + d : "")); }
}
function clean(p: string) { for (const e of ["", "-wal", "-shm"]) { try { unlinkSync(p + e); } catch {} } }

async function open(dbPath: string) {
  const engine = await SQLiteEngine.open(dbPath);
  const db = engine.getDatabase();
  const store = new ExecutionStore(db, undefined);
  const leases = new LeaseManager(store);
  const workerRegistry = new WorkerRegistry(store, leases as any);
  const retryEngine = new RetryEngine();
  const events: Array<{ type: string; payload: any }> = [];
  const deps = { events: { emit: (e: any) => { events.push({ type: e.type, payload: e.payload }); return undefined; } } } as any;
  const execEngine = new ExecutionEngine(store, workerRegistry, leases, retryEngine, deps);
  return { engine, db, store, leases, execEngine, events };
}

function makeJob(id: string, now: number): any {
  return { id, idempotencyKey: "p196:" + id, jobType: "EXECUTION", payload: {},
    status: "RUNNING", retryPolicy: { maxAttempts: 3, initialDelayMs: 1000, multiplier: 2, maxDelayMs: 60000 },
    timeoutMs: 60000, createdAt: now, updatedAt: now, lastAttemptAt: now,
    nextAttemptAt: null, currentLeaseId: null, cancellationRequested: 0, cancellationAcknowledged: 0 };
}
function makeAttempt(id: string, jobId: string, workerId: string, leaseId: string, now: number): any {
  return { id, jobId, attemptNumber: 1, status: "RUNNING", workerId, leaseId,
    startedAt: now, completedAt: null, error: null, evidence: null, createdAt: now };
}

async function main() {
  console.log("PHASE 196 — EXECUTION SUPERVISION\n");
  const DB = path.join(os.tmpdir(), `nexus-p196-${Date.now()}.sqlite`);
  clean(DB);
  const h = await open(DB);
  const { engine, db, store, leases, execEngine, events } = h;

  console.log("§1 schema");
  const ac = (db.prepare("PRAGMA table_info(execution_attempts)").all() as any[]).map((r) => r.name);
  ok("§1 execution_attempts.heartbeat_at exists", ac.includes("heartbeat_at"));
  ok("§1 execution_attempts.last_progress_at exists", ac.includes("last_progress_at"));
  const jc = (db.prepare("PRAGMA table_info(execution_jobs)").all() as any[]).map((r) => r.name);
  ok("§1 execution_jobs.supervision_state exists", jc.includes("supervision_state"));
  ok("§1 execution_jobs.failure_class exists", jc.includes("failure_class"));
  ok("§1 execution_jobs.supervision_updated_at exists", jc.includes("supervision_updated_at"));

  console.log("\n§2 setup");
  const JOB = "job_p196_01", ATT = "att_p196_01", WORKER = "worker-A", NOW = Date.now();
  store.createJob(makeJob(JOB, NOW));
  const lease = leases.acquireLease(JOB, WORKER, 60_000);
  store.createAttempt(makeAttempt(ATT, JOB, WORKER, lease.leaseId, NOW));
  ok("§2 job created", store.getJob(JOB)?.id === JOB);
  ok("§2 lease acquired", !!lease.leaseId, "leaseId=" + lease.leaseId);
  ok("§2 attempt created", store.getAttempt(ATT)?.id === ATT);

  console.log("\n§3 heartbeat / progress");
  const hb = await execEngine.recordHeartbeat(JOB, ATT, WORKER, lease.leaseId, NOW);
  ok("§3 recordHeartbeat ok", hb.ok === true, "reason=" + (hb.reason ?? "none"));
  const pr = await execEngine.recordProgress(JOB, ATT, WORKER, lease.leaseId, NOW);
  ok("§3 recordProgress ok", pr.ok === true, "reason=" + (pr.reason ?? "none"));
  const ts = store.getAttemptProgress(ATT);
  ok("§3 heartbeat persisted", ts.heartbeatAt === NOW, "hb=" + ts.heartbeatAt);
  ok("§3 progress persisted", ts.lastProgressAt === NOW, "pr=" + ts.lastProgressAt);
  ok("§3 heartbeat event emitted", events.some((e) => e.type === "execution.supervision.heartbeat"));
  ok("§3 progress event emitted", events.some((e) => e.type === "execution.supervision.progress"));

  console.log("\n§4 classifier");
  const HB_TO = 5_000, PR_TO = 3_000;
  let v = execEngine.classifySupervision(JOB, NOW + 100, HB_TO, PR_TO);
  ok("§4a HEALTHY when both timestamps fresh", v.verdict === "HEALTHY", "verdict=" + v.verdict);
  const LATER = NOW + HB_TO + 1_000;
  v = execEngine.classifySupervision(JOB, LATER, HB_TO, PR_TO);
  ok("§4b HEARTBEAT_TIMEOUT when only HB aged out", v.verdict === "HEARTBEAT_TIMEOUT", "verdict=" + v.verdict + " reason=" + v.reason);
  await execEngine.recordHeartbeat(JOB, ATT, WORKER, lease.leaseId, LATER);
  v = execEngine.classifySupervision(JOB, LATER, HB_TO, PR_TO);
  ok("§4c PROGRESS_TIMEOUT when HB fresh but PR aged out", v.verdict === "PROGRESS_TIMEOUT", "verdict=" + v.verdict + " reason=" + v.reason);
  const TERM_JOB = "job_p196_term";
  store.createJob({ ...makeJob(TERM_JOB, NOW), status: "SUCCEEDED" });
  v = execEngine.classifySupervision(TERM_JOB, NOW, HB_TO, PR_TO);
  ok("§4d NOT_RUNNING for terminal job", v.verdict === "NOT_RUNNING", "verdict=" + v.verdict);
  const NO_ATT = "job_p196_noatt";
  store.createJob(makeJob(NO_ATT, NOW));
  v = execEngine.classifySupervision(NO_ATT, NOW, HB_TO, PR_TO);
  ok("§4e NO_ATTEMPT when RUNNING without attempt", v.verdict === "NO_ATTEMPT", "verdict=" + v.verdict);
  v = execEngine.classifySupervision("job_p196_missing", NOW, HB_TO, PR_TO);
  ok("§4f NOT_RUNNING for missing job", v.verdict === "NOT_RUNNING", "reason=" + v.reason);

  console.log("\n§5 supervisor tick");
  const STALE_TO = HB_TO;
  const FUTURE = LATER + STALE_TO + 2_000;
  const beforeFlag = events.filter((e) => e.type === "execution.supervision.stall_detected").length;
  const rpt = execEngine.runSupervisionPass(FUTURE, STALE_TO, HB_TO, PR_TO);
  const afterFlag = events.filter((e) => e.type === "execution.supervision.stall_detected").length;
  ok("§5 supervision pass scanned >= 1", rpt.scanned >= 1, "scanned=" + rpt.scanned);
  ok("§5 supervision pass flagged >= 1", rpt.flagged >= 1, "flagged=" + rpt.flagged);
  ok("§5 stall_detected event emitted", afterFlag > beforeFlag, "before=" + beforeFlag + " after=" + afterFlag);
  const row = db.prepare("SELECT supervision_state, failure_class FROM execution_jobs WHERE id = ?").get(JOB) as any;
  ok("§5 supervision_state = SUSPECTED_STALL", row?.supervision_state === "SUSPECTED_STALL", "got=" + row?.supervision_state);
  ok("§5 failure_class recorded", row?.failure_class === "HEARTBEAT_TIMEOUT" || row?.failure_class === "PROGRESS_TIMEOUT", "got=" + row?.failure_class);

  console.log("\n§6 fencing");
  const bad = await execEngine.recordHeartbeat(JOB, ATT, "worker-B", lease.leaseId, FUTURE);
  ok("§6 wrong worker heartbeat rejected", bad.ok === false, "reason=" + bad.reason);
  const badLease = await execEngine.recordHeartbeat(JOB, ATT, WORKER, "lease_notreal", FUTURE);
  ok("§6 wrong lease heartbeat rejected", badLease.ok === false, "reason=" + badLease.reason);

  console.log("\n§7 restart durability");
  const hbBefore = store.getAttemptProgress(ATT).heartbeatAt;
  const prBefore = store.getAttemptProgress(ATT).lastProgressAt;
  engine.close();
  const h2 = await open(DB);
  const row2 = h2.db.prepare("SELECT supervision_state FROM execution_jobs WHERE id = ?").get(JOB) as any;
  const ts2 = h2.store.getAttemptProgress(ATT);
  ok("§7 heartbeat survives reopen", ts2.heartbeatAt === hbBefore, "before=" + hbBefore + " after=" + ts2.heartbeatAt);
  ok("§7 progress survives reopen", ts2.lastProgressAt === prBefore, "before=" + prBefore + " after=" + ts2.lastProgressAt);
  ok("§7 supervision_state survives reopen", row2?.supervision_state === "SUSPECTED_STALL", "got=" + row2?.supervision_state);
  h2.engine.close();
  clean(DB);
  console.log(`\nPASS: ${pass}\nFAIL: ${fail}`);
  process.exitCode = fail > 0 ? 1 : 0;
}
main().catch((e) => { console.error("FATAL:", e); process.exitCode = 2; });
