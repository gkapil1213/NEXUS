// scripts/test-phase247-boundaries.ts
// Phase 247 §16 boundary tests: E, L, N, O, P.
// Real behavior assertions; no source-only "it exists" claims except where
// the boundary itself is architectural (N, P).
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { SecurityApi } from "../src/core/security-api";
import { SecurityReleaseGate } from "../src/core/security-release-gate";

let passed = 0, failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log("PASS  " + msg); }
  else { failed++; console.log("FAIL  " + msg); }
}
function section(t: string): void { console.log("\n--- " + t + " ---"); }

const NINE_CATS = ["SAST","SCA","SECRET","IAC","CONTAINER","SBOM","DAST","SUPPLY_CHAIN","SIGNATURE"];

async function freshGate(): Promise<{ api: SecurityApi; gate: SecurityReleaseGate; db: any }> {
  const dbPath = path.join(os.tmpdir(), "nexus-p247b-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) + ".sqlite");
  process.on("exit", () => { for (const e of ["", "-wal", "-shm"]) { try { fs.unlinkSync(dbPath + e); } catch {} } });
  const engine = await SQLiteEngine.open(dbPath);
  const api = await SecurityApi.create(engine);
  const gate = new SecurityReleaseGate(api);
  return { api, gate, db: (api as any).engine };
}

async function seedEvidence(db: any, execId: string, digest: string, opts: { omitCategory?: string; expires?: string } = {}): Promise<void> {
  const now = new Date().toISOString();
  for (const cat of NINE_CATS) {
    if (opts.omitCategory && cat === opts.omitCategory) continue;
    const ev: any = {
      id: "evb-" + execId + "-" + cat,
      project_id: "p-" + execId,
      execution_id: execId,
      commit_sha: "c-" + execId,
      artifact_digest: digest,
      environment: "production",
      scanner: "test-" + cat,
      category: cat,
      status: "PASS",
      started_at: now,
      completed_at: now,
      duration_ms: 1,
      created_at: now,
      expires_at: opts.expires,
    };
    await db.put("security_evidence", ev.id, ev);
  }
}

async function main() {
  // ---------- E. Missing required evidence => BLOCK ----------
  section("E - missing required evidence => BLOCK");
  {
    const { gate, db } = await freshGate();
    const execId = "exec-p247b-e";
    await seedEvidence(db, execId, "sha256-e", { omitCategory: "SIGNATURE" });
    const r = await gate.evaluate({
      release_id: "rel-e", execution_id: execId, artifact_id: "art-e",
      artifact_digest: "sha256-e", environment: "production",
    });
    ok(r.canonical_status === "BLOCK", "E missing SIGNATURE => BLOCK (got " + r.canonical_status + ")");
  }

  // ---------- L. Idempotency: two gate evaluations return same result ----------
  section("L - idempotency: same inputs => same result");
  {
    const { gate, db } = await freshGate();
    const execId = "exec-p247b-l";
    const future = new Date(Date.now() + 3600_000).toISOString();
    await seedEvidence(db, execId, "sha256-l", { expires: future });
    const params = {
      release_id: "rel-l", execution_id: execId, artifact_id: "art-l",
      artifact_digest: "sha256-l", environment: "production",
    };
    const r1 = await gate.evaluate(params);
    const r2 = await gate.evaluate(params);
    ok(r1.canonical_status === r2.canonical_status,
       "L canonical_status stable (r1=" + r1.canonical_status + " r2=" + r2.canonical_status + ")");
    ok(r1.status === r2.status,
       "L legacy status stable (r1=" + r1.status + " r2=" + r2.status + ")");
    ok(r1.checks.ASSURANCE?.canonical_status === r2.checks.ASSURANCE?.canonical_status,
       "L ASSURANCE stable");
  }

  // ---------- N. Scanner boundary: gate does not invoke real scanner execution ----------
  section("N - scanner boundary: gate does not call scanner execution");
  {
    const gateSrc = fs.readFileSync("src/core/security-release-gate.ts", "utf8");
    ok(!gateSrc.includes("RealSecurityScanner"),
       "N release gate does not import RealSecurityScanner");
    ok(!gateSrc.includes("runAll("),
       "N release gate does not call runAll()");

    // Scanner adapters exist with both detect() and scan()
    const scannerSrc = fs.readFileSync("src/core/security-scanners.ts", "utf8");
    for (const cls of ["SemgrepAdapter", "GitleaksAdapter", "CheckovAdapter", "ScaAdapter"]) {
      const hasClass = scannerSrc.includes("export class " + cls);
      ok(hasClass, "N " + cls + " class present in core scanners");
    }
    ok(scannerSrc.includes("async detect("), "N detect() method present");
    ok(scannerSrc.includes("async scan("), "N scan() method present");
  }

  // ---------- O. OSV honest state ----------
  section("O - OSV unavailable: not wired into production runner");
  {
    const runnerSrc = fs.readFileSync("src/core/security-scanner-runner.ts", "utf8");
    ok(!runnerSrc.includes('scanner: "osv'),
       "O runner has no osv-scanner entry");
    ok(!runnerSrc.includes("OSVAdapter"),
       "O runner does not import OSVAdapter");

    // osv-scanner binary check
    let installed = false;
    try {
      const { execSync } = await import("node:child_process");
      execSync("osv-scanner --version", { stdio: "pipe", timeout: 5000 });
      installed = true;
    } catch {}
    ok(installed === false,
       "O osv-scanner NOT installed (verified at runtime; honest BLOCKED semantics)");
  }

  // ---------- P. No production imports of src/security/** ----------
  section("P - no production imports of removed src/security/**");
  {
    const dirs = ["src", "scripts"];
    const badPatterns = [
      /from\s+"\.\.\/security\//,
      /from\s+"\.\.\/\.\.\/security\//,
      /from\s+"src\/security\//,
    ];
    let hits: string[] = [];
    const walk = (d: string): void => {
      for (const name of fs.readdirSync(d)) {
        const full = path.join(d, name);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) { walk(full); continue; }
        if (!name.endsWith(".ts")) continue;
        const content = fs.readFileSync(full, "utf8");
        for (const re of badPatterns) {
          if (re.test(content)) hits.push(full);
        }
      }
    };
    for (const d of dirs) if (fs.existsSync(d)) walk(d);
    ok(hits.length === 0,
       "P no production imports of removed src/security/** (hits=" + hits.length + ")");
    if (hits.length > 0) for (const h of hits) console.log("   " + h);
  }

  console.log("\n============================================");
  console.log("PASS: " + passed);
  console.log("FAIL: " + failed);
  console.log("============================================");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exit(1); });