// scripts/test-phase263f-event-sequence-atomicity.ts
// Phase 263f verifier: EventService sequence allocation is atomic across
// concurrent processes and seeds past any existing maximum.
//
// Spawns N real child processes against one shared SQLite file. Each child
// allocates M sequence values via the real SQLiteEngine.nextSeq(). The
// parent collects all N*M values and asserts:
//
//   A. no duplicates across all allocations
//   B. the allocated range is contiguous
//   C. on a pre-populated store, the first allocation is > the existing max
//
// Runs entirely against a mkdtemp SQLite file; the production nexus.sqlite
// is never opened.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";
import { SQLiteEngine } from "../src/core/sqlite-engine";

const CHILD = join(process.cwd(), "scripts", "_phase263f_child.ts");

let passed = 0, failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log("PASS  " + msg); }
  else { failed++; console.log("FAIL  " + msg); }
}
function section(t: string): void { console.log("\n--- " + t + " ---"); }

interface ChildResult { code: number | null; stdout: string; stderr: string; }

function runChild(dbPath: string, store: string, count: number): Promise<ChildResult> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", CHILD, dbPath, store, String(count)],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, 120_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function parseAllocations(stdout: string): number[] {
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const v = JSON.parse(lines[i]);
      if (Array.isArray(v) && v.every((n) => typeof n === "number")) return v;
    } catch { /* try earlier line */ }
  }
  throw new Error("no allocation array found in child stdout");
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "nexus-263f-"));
  const dbPath = join(dir, "seq.sqlite");
  process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  const STORE = "events";
  const N = 4;
  const M = 100;

  // ---- A: concurrent allocation across processes ----------------------
  section(`A - ${N} concurrent processes x ${M} allocations`);

  // Create the schema up-front via the engine (runs migrations).
  await SQLiteEngine.open(dbPath);
  // Close immediately; children each open their own handle.

  const results = await Promise.all(
    Array.from({ length: N }, () => runChild(dbPath, STORE, M)),
  );

  for (let i = 0; i < results.length; i++) {
    ok(results[i].code === 0, `A${i + 1} child ${i} exited 0`);
    if (results[i].code !== 0) {
      console.log("  stderr:", results[i].stderr.slice(0, 300));
    }
  }

  const all: number[] = [];
  for (const r of results) {
    if (r.code !== 0) continue;
    try { all.push(...parseAllocations(r.stdout)); }
    catch (e) { console.log("  parse error:", String(e)); }
  }

  ok(all.length === N * M, `A${N + 1} collected ${all.length} of ${N * M} allocations`);

  const distinct = new Set(all);
  ok(distinct.size === all.length, `A${N + 2} all allocations unique (${distinct.size}/${all.length})`);

  const sorted = [...all].sort((a, b) => a - b);
  const min = sorted[0], max = sorted[sorted.length - 1];
  ok(sorted.every((v, i) => i === 0 || v === sorted[i - 1] + 1),
     `A${N + 3} allocated range is contiguous [${min}..${max}]`);

  // ---- B: seeding past an existing maximum ----------------------------
  section("B - seed past existing maximum on a pre-populated store");

  // Write events with seq 1..50 directly into nexus_records, then allocate.
  const raw = new Database(dbPath);
  try {
    const insert = raw.prepare(
      `INSERT INTO nexus_records (store, key, value) VALUES (?, ?, ?)
       ON CONFLICT(store, key) DO UPDATE SET value = excluded.value`,
    );
    for (let i = 1; i <= 50; i++) {
      const key = `evt_seed_${i}`;
      const value = JSON.stringify({
        id: key, seq: i, execution_id: null, attempt_id: null,
        type: "seed.event", timestamp: Date.now(), source: "phase263f",
        payload: {},
      });
      insert.run(STORE, key, value);
    }

    // Drop any counter row so nextSeq seeds fresh.
    raw.prepare("DELETE FROM nexus_sequences WHERE store = ?").run(STORE);
  } finally {
    raw.close();
  }

  const engine = await SQLiteEngine.open(dbPath);
  const first = await engine.nextSeq(STORE);
  const second = await engine.nextSeq(STORE);

  ok(first === 51, `B1 first allocation after seed is 51 (got ${first})`);
  ok(second === 52, `B2 second allocation is 52 (got ${second})`);

  console.log("\n============================================");
  console.log("PASS: " + passed);
  console.log("FAIL: " + failed);
  console.log("============================================");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL", e instanceof Error ? e.stack ?? e.message : e);
  process.exit(2);
});