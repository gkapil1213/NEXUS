// scripts/test-phase194-concurrent-lease.ts
//
// PHASE 194 Part F — true persistence-level atomicity.
//
// Two child processes race for the same expired lease. SQLite WAL +
// busy_timeout serializes writers at the file-lock level. Exactly one
// must win; exactly one ACTIVE row must remain.

import { spawn } from "node:child_process";
import { unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { LeaseManager } from "../src/core/lease-manager";

const JOB = "job_p194_race";
let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log("[PASSED] " + name + (detail ? "  " + detail : "")); }
  else      { fail++; console.log("[FAILED] " + name + (detail ? "  " + detail : "")); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// tsx ships a CLI at node_modules/tsx/dist/cli.mjs. Invoke it via the
// current Node binary — avoids the Windows "spawn EINVAL on .cmd with
// shell:false" trap entirely.
const TSX_CLI = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");

function runChild(dbPath: string, workerId: string): Promise<any> {
  return new Promise((resolve) => {
    const proc = spawn(
      process.execPath,
      [TSX_CLI, "scripts/_phase194_lease_race_child.ts", dbPath, workerId],
      { env: process.env, shell: false, windowsHide: true },
    );
    let out = "", err = "";
    proc.stdout.on("data", (d) => out += d.toString());
    proc.stderr.on("data", (d) => err += d.toString());
    proc.on("error", (e) => resolve({ workerId, spawnError: e.message }));
    proc.on("close", () => {
      const line = out.trim().split(/\r?\n/).pop() ?? "";
      try { resolve(JSON.parse(line)); }
      catch { resolve({ workerId, parseError: line, stderr: err.slice(0, 300) }); }
    });
  });
}

async function main() {
  console.log("PHASE 194 Part F — CONCURRENT LEASE TAKEOVER\n");

  const DB_PATH = path.join(os.tmpdir(), `nexus-p194-race-${Date.now()}.sqlite`);

  // ---------- Setup: job + expired A lease ----------
  {
    const engine = await SQLiteEngine.open(DB_PATH);
    const store = new ExecutionStore(engine.getDatabase(), undefined);
    const leases = new LeaseManager(store);
    const now = Date.now();
    store.createJob({
      id: JOB,
      idempotencyKey: "p194:race",
      jobType: "EXECUTION",
      payload: {},
      status: "RUNNING",
      retryPolicy: { maxAttempts: 3, initialDelayMs: 1000, multiplier: 2, maxDelayMs: 60000 },
      timeoutMs: 60000,
      createdAt: now,
      updatedAt: now,
      lastAttemptAt: now,
      nextAttemptAt: null,
      currentLeaseId: null,
      cancellationRequested: 0,
      cancellationAcknowledged: 0,
    } as any);
    leases.acquireLease(JOB, "worker-A", 50);   // short TTL, will expire
    await sleep(150);
    engine.close();
  }

  // ---------- Race: B and C simultaneously ----------
  const [b, c] = await Promise.all([
    runChild(DB_PATH, "worker-B"),
    runChild(DB_PATH, "worker-C"),
  ]);
  console.log("  B:", JSON.stringify(b));
  console.log("  C:", JSON.stringify(c));

  const winners = [b, c].filter((r) => r && r.acquired === true);
  const losers  = [b, c].filter((r) => r && r.acquired === false);

  ok("F-race: exactly one child acquired", winners.length === 1, "winners=" + winners.length);
  ok("F-race: exactly one child was rejected", losers.length === 1, "losers=" + losers.length);

  const winner = winners[0];
  ok("F-race: winner is B or C",
     winner && (winner.workerId === "worker-B" || winner.workerId === "worker-C"),
     "winner=" + (winner?.workerId ?? "?"));

  // ---------- Verify persisted state ----------
  const engine = await SQLiteEngine.open(DB_PATH);
  const db = engine.getDatabase();
  const active = db.prepare(
    "SELECT worker_id, status FROM execution_leases WHERE job_id = ? AND status = 'ACTIVE'"
  ).all(JOB) as any[];
  ok("F-race: exactly one ACTIVE lease row remains", active.length === 1, "n=" + active.length);
  ok("F-race: ACTIVE row belongs to winner",
     active[0]?.worker_id === winner?.workerId,
     "active=" + active[0]?.worker_id + " winner=" + winner?.workerId);

  const aExpired = db.prepare(
    "SELECT status FROM execution_leases WHERE job_id = ? AND worker_id = 'worker-A'"
  ).get(JOB) as any;
  ok("F-race: worker-A's lease is EXPIRED", aExpired?.status === "EXPIRED",
     "status=" + aExpired?.status);

  engine.close();
  for (const ext of ["", "-wal", "-shm"]) { try { unlinkSync(DB_PATH + ext); } catch {} }

  console.log(`\nPASS: ${pass}\nFAIL: ${fail}`);
  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch((e) => { console.error("FATAL:", e); process.exitCode = 2; });
