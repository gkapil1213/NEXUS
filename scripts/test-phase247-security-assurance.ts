// scripts/test-phase247-security-assurance.ts
// Phase 247 — Continuous Security Assurance verifier.
// Real assertions on real behavior. Uses real SecurityApi + SecurityReleaseGate.
// No mocks. No fabricated evidence.
import path from "node:path";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { SecurityApi } from "../src/core/security-api";
import { SecurityReleaseGate } from "../src/core/security-release-gate";
import {
  assessEvidenceAssurance,
  assessEvidenceSet,
  worseState,
} from "../src/core/security-assurance";
import type { SecurityEvidence } from "../src/core/types";

let passed = 0, failed = 0, blocked = 0, notExec = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log("PASS  " + msg); }
  else { failed++; console.log("FAIL  " + msg); }
}
function blk(msg: string, reason: string): void { blocked++; console.log("BLOCKED  " + msg + " :: " + reason); }
function section(t: string): void { console.log("\n--- " + t + " ---"); }

const TARGET = {
  artifact_digest: "sha256-target-abc",
  release_id: "rel-target",
  execution_id: "exec-target",
  commit_sha: "commit-target",
};

function evidence(overrides: Partial<SecurityEvidence> & { id: string; scanner: string; category: any }): SecurityEvidence {
  const now = new Date();
  return {
    id: overrides.id,
    project_id: "p-test",
    execution_id: "exec-target",
    release_id: "rel-target",
    commit_sha: "commit-target",
    artifact_id: "art-1",
    artifact_digest: "sha256-target-abc",
    environment: "production",
    scanner: overrides.scanner,
    category: overrides.category,
    status: "PASS",
    started_at: now.toISOString(),
    completed_at: now.toISOString(),
    duration_ms: 10,
    created_at: now.toISOString(),
    ...overrides,
  } as SecurityEvidence;
}

const NINE_CATS = ["SAST","SCA","SECRET","IAC","CONTAINER","SBOM","DAST","SUPPLY_CHAIN","SIGNATURE"];

function cleanSet(): SecurityEvidence[] {
  return NINE_CATS.map((c, i) => evidence({
    id: "ev-clean-" + c + "-" + i,
    scanner: "test-" + c,
    category: c,
  }));
}

async function main() {
  // ---------- A. Baseline: pure function happy path ----------
  section("A - assessEvidenceSet: fresh, bound evidence => VALID");
  {
    const set = assessEvidenceSet(cleanSet(), TARGET);
    ok(set.overall === "VALID", "A overall VALID (got " + set.overall + ")");
    ok(set.perEvidence.every((p) => p.state === "VALID"), "A all perEvidence VALID");
    ok(set.reasons.length === 0, "A no reasons");
  }

  // ---------- B. STALE (expires_at in past) ----------
  section("B - expired evidence => STALE");
  {
    const past = new Date(Date.now() - 60_000).toISOString();
    const ev = evidence({ id: "ev-stale", scanner: "test", category: "SCA", expires_at: past });
    const a = assessEvidenceAssurance(ev, TARGET);
    ok(a.state === "STALE", "B single item STALE (got " + a.state + ")");

    const set = assessEvidenceSet([ev], TARGET);
    ok(set.overall === "STALE", "B set STALE (got " + set.overall + ")");
  }

  // ---------- C. INVALID (digest mismatch) ----------
  section("C - artifact digest mismatch => INVALID");
  {
    const ev = evidence({ id: "ev-mismatch", scanner: "test", category: "SCA", artifact_digest: "sha256-WRONG" });
    const a = assessEvidenceAssurance(ev, TARGET);
    ok(a.state === "INVALID", "C single item INVALID (got " + a.state + ")");

    const set = assessEvidenceSet([ev], TARGET);
    ok(set.overall === "INVALID", "C set INVALID (got " + set.overall + ")");
  }

  // ---------- D. INVALID (target requires binding but evidence has none) ----------
  section("D - target requires artifact binding but evidence lacks it => INVALID");
  {
    const ev = evidence({ id: "ev-nodigest", scanner: "test", category: "SCA" });
    delete (ev as any).artifact_digest;
    const a = assessEvidenceAssurance(ev, TARGET);
    ok(a.state === "INVALID", "D no-digest INVALID (got " + a.state + ")");
  }

  // ---------- E. BLOCKED (scanner blocked) ----------
  section("E - scanner BLOCKED => BLOCKED");
  {
    const ev = evidence({ id: "ev-blocked", scanner: "test", category: "SCA", status: "BLOCKED" });
    const a = assessEvidenceAssurance(ev, TARGET);
    ok(a.state === "BLOCKED", "E single item BLOCKED (got " + a.state + ")");
  }

  // ---------- F. NOT_EXECUTED (scanner never ran) ----------
  section("F - scanner NOT_RUN => NOT_EXECUTED");
  {
    const ev = evidence({ id: "ev-notrun", scanner: "test", category: "SCA", status: "NOT_RUN" });
    const a = assessEvidenceAssurance(ev, TARGET);
    ok(a.state === "NOT_EXECUTED", "F single item NOT_EXECUTED (got " + a.state + ")");
  }

  // ---------- G. REQUIRES_REVIEW (release_id mismatch) ----------
  section("G - release_id mismatch => REQUIRES_REVIEW");
  {
    const ev = evidence({ id: "ev-relmismatch", scanner: "test", category: "SCA", release_id: "rel-OTHER" });
    const a = assessEvidenceAssurance(ev, TARGET);
    ok(a.state === "REQUIRES_REVIEW", "G release mismatch REQUIRES_REVIEW (got " + a.state + ")");
  }

  // ---------- H. Precedence: worst-wins ----------
  section("H - precedence: worst-wins");
  {
    ok(worseState("VALID", "STALE") === "STALE", "H VALID vs STALE -> STALE");
    ok(worseState("STALE", "INVALID") === "INVALID", "H STALE vs INVALID -> INVALID");
    ok(worseState("INVALID", "BLOCKED") === "BLOCKED", "H INVALID vs BLOCKED -> BLOCKED");
    ok(worseState("REQUIRES_REVIEW", "VALID") === "REQUIRES_REVIEW", "H REQUIRES_REVIEW vs VALID -> REQUIRES_REVIEW");
    ok(worseState("REQUIRES_REVIEW", "STALE") === "STALE", "H REQUIRES_REVIEW vs STALE -> STALE");
    ok(worseState("NOT_EXECUTED", "REQUIRES_REVIEW") === "NOT_EXECUTED", "H NOT_EXECUTED vs REQUIRES_REVIEW -> NOT_EXECUTED");
  }

  // ---------- I. Mixed set: BLOCKED dominates ----------
  section("I - mixed set: BLOCKED dominates");
  {
    const set = [
      ...cleanSet().slice(1),
      evidence({ id: "ev-blocked-2", scanner: "test", category: "SAST", status: "BLOCKED" }),
    ];
    const result = assessEvidenceSet(set, TARGET);
    ok(result.overall === "BLOCKED", "I mixed set overall BLOCKED (got " + result.overall + ")");
    ok(result.reasons.some((r) => r.includes("BLOCKED")), "I reason mentions BLOCKED");
  }

  // ---------- J. Mixed set: INVALID dominates STALE ----------
  section("J - mixed set: INVALID dominates STALE");
  {
    const past = new Date(Date.now() - 60_000).toISOString();
    const set = [
      evidence({ id: "ev-stale-2", scanner: "test", category: "SAST", expires_at: past }),
      evidence({ id: "ev-invalid-2", scanner: "test", category: "SCA", artifact_digest: "sha256-WRONG" }),
    ];
    const result = assessEvidenceSet(set, TARGET);
    ok(result.overall === "INVALID", "J mixed set overall INVALID (got " + result.overall + ")");
  }

  // ---------- K. Release gate integration: STALE evidence blocks ----------
  section("K - release gate: STALE evidence => BLOCK");
  {
    const dbPath = path.join(
      (await import("node:os")).tmpdir(),
      "nexus-p247-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) + ".sqlite",
    );
    const fs = await import("node:fs");
    process.on("exit", () => { for (const e of ["", "-wal", "-shm"]) { try { fs.unlinkSync(dbPath + e); } catch {} } });

    const engine = await SQLiteEngine.open(dbPath);
    const api = await SecurityApi.create(engine);
    const gate = new SecurityReleaseGate(api);

    // Seed NINE categories, one of which is expired
    const past = new Date(Date.now() - 60_000).toISOString();
    const execId = "exec-p247-k";
    const db = (api as any).engine;

    for (const cat of NINE_CATS) {
      const ev: any = {
        id: "ev-k-" + cat,
        project_id: "p-k",
        execution_id: execId,
        commit_sha: "commit-k",
        artifact_digest: "sha256-target-abc",
        environment: "production",
        scanner: "test-" + cat,
        category: cat,
        status: cat === "SCA" ? "PASS" : "PASS",
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        duration_ms: 1,
        created_at: new Date().toISOString(),
        expires_at: cat === "SCA" ? past : undefined,
      };
      await db.put("security_evidence", ev.id, ev);
    }

    const result = await gate.evaluate({
      release_id: "rel-k",
      execution_id: execId,
      artifact_id: "art-k",
      artifact_digest: "sha256-target-abc",
      environment: "production",
    });

    ok(result.canonical_status === "BLOCK",
       "K stale evidence blocks canonical_status=BLOCK (got " + result.canonical_status + ")");
    ok(result.checks.ASSURANCE !== undefined,
       "K ASSURANCE check present in gate result");
    ok(result.checks.ASSURANCE?.canonical_status === "BLOCK",
       "K ASSURANCE.canonical_status=BLOCK (got " + result.checks.ASSURANCE?.canonical_status + ")");
  }

  // ---------- L. Release gate integration: digest mismatch blocks ----------
  section("L - release gate: digest mismatch => BLOCK");
  {
    const os = await import("node:os");
    const fs = await import("node:fs");
    const dbPath = path.join(os.tmpdir(), "nexus-p247-l-" + Date.now() + ".sqlite");
    process.on("exit", () => { for (const e of ["", "-wal", "-shm"]) { try { fs.unlinkSync(dbPath + e); } catch {} } });

    const engine = await SQLiteEngine.open(dbPath);
    const api = await SecurityApi.create(engine);
    const gate = new SecurityReleaseGate(api);
    const db = (api as any).engine;
    const execId = "exec-p247-l";

    for (const cat of NINE_CATS) {
      const ev: any = {
        id: "ev-l-" + cat,
        project_id: "p-l",
        execution_id: execId,
        commit_sha: "commit-l",
        artifact_digest: cat === "SCA" ? "sha256-DIFFERENT" : "sha256-target-abc",
        environment: "production",
        scanner: "test-" + cat,
        category: cat,
        status: "PASS",
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        duration_ms: 1,
        created_at: new Date().toISOString(),
      };
      await db.put("security_evidence", ev.id, ev);
    }

    const result = await gate.evaluate({
      release_id: "rel-l",
      execution_id: execId,
      artifact_id: "art-l",
      artifact_digest: "sha256-target-abc",
      environment: "production",
    });

    ok(result.canonical_status === "BLOCK",
       "L digest mismatch blocks (got " + result.canonical_status + ")");
  }

  // ---------- M. Release gate: all-fresh evidence passes assurance ----------
  section("M - release gate: fresh, bound evidence passes ASSURANCE");
  {
    const os = await import("node:os");
    const fs = await import("node:fs");
    const dbPath = path.join(os.tmpdir(), "nexus-p247-m-" + Date.now() + ".sqlite");
    process.on("exit", () => { for (const e of ["", "-wal", "-shm"]) { try { fs.unlinkSync(dbPath + e); } catch {} } });

    const engine = await SQLiteEngine.open(dbPath);
    const api = await SecurityApi.create(engine);
    const gate = new SecurityReleaseGate(api);
    const db = (api as any).engine;
    const execId = "exec-p247-m";
    const future = new Date(Date.now() + 3600_000).toISOString();

    for (const cat of NINE_CATS) {
      const ev: any = {
        id: "ev-m-" + cat,
        project_id: "p-m",
        execution_id: execId,
        commit_sha: "commit-m",
        artifact_digest: "sha256-target-abc",
        environment: "production",
        scanner: "test-" + cat,
        category: cat,
        status: "PASS",
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        duration_ms: 1,
        created_at: new Date().toISOString(),
        expires_at: future,
      };
      await db.put("security_evidence", ev.id, ev);
    }

    const result = await gate.evaluate({
      release_id: "rel-m",
      execution_id: execId,
      artifact_id: "art-m",
      artifact_digest: "sha256-target-abc",
      environment: "production",
    });

    ok(result.checks.ASSURANCE?.canonical_status === "ALLOW",
       "M ASSURANCE passes for fresh evidence (got " + result.checks.ASSURANCE?.canonical_status + ")");
  }

  console.log("\n============================================");
  console.log("PASS: " + passed);
  console.log("FAIL: " + failed);
  console.log("BLOCKED: " + blocked);
  console.log("NOT EXECUTED: " + notExec);
  console.log("============================================");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exit(1); });