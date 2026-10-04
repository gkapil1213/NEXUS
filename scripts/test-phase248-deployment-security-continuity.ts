// scripts/test-phase248-deployment-security-continuity.ts
// Phase 248 — Release-to-Deployment Security Continuity verifier.
// Real behavior. Real SecurityEvidence objects. Real continuity function.
// No mocks. No fabricated deployment.
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { SecurityApi } from "../src/core/security-api";
import { SecurityReleaseGate } from "../src/core/security-release-gate";
import { ProductionReleaseDecisionService } from "../src/core/production-release-decision";
import { ProductionReleaseEnforcementService } from "../src/core/production-release-enforcement";
import { evaluateDeploymentSecurityContinuity } from "../src/core/deployment-security-continuity";
import type { SecurityEvidence } from "../src/core/types";

let passed = 0, failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log("PASS  " + msg); }
  else { failed++; console.log("FAIL  " + msg); }
}
function section(t: string): void { console.log("\n--- " + t + " ---"); }

const NINE_CATS = ["SAST","SCA","SECRET","IAC","CONTAINER","SBOM","DAST","SUPPLY_CHAIN","SIGNATURE"];

function mkEvidence(id: string, cat: string, digest: string, overrides: Partial<SecurityEvidence> = {}): SecurityEvidence {
  const now = new Date();
  return {
    id,
    project_id: "p248",
    execution_id: "exec-248",
    release_id: "rel-248",
    commit_sha: "commit-248",
    artifact_id: "art-248",
    artifact_digest: digest,
    environment: "production",
    scanner: "test-" + cat,
    category: cat as any,
    status: "PASS",
    started_at: now.toISOString(),
    completed_at: now.toISOString(),
    duration_ms: 1,
    created_at: now.toISOString(),
    ...overrides,
  } as SecurityEvidence;
}

function cleanEvidence(digest: string, opts: { expires?: string } = {}): SecurityEvidence[] {
  return NINE_CATS.map((c, i) => mkEvidence("ev-248-" + c + "-" + i, c, digest, { expires_at: opts.expires }));
}

async function freshEnv(): Promise<{ api: SecurityApi; gate: SecurityReleaseGate; prd: ProductionReleaseDecisionService; enf: ProductionReleaseEnforcementService; db: any }> {
  const dbPath = path.join(os.tmpdir(), "nexus-p248-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) + ".sqlite");
  process.on("exit", () => { for (const e of ["", "-wal", "-shm"]) { try { fs.unlinkSync(dbPath + e); } catch {} } });
  const engine = await SQLiteEngine.open(dbPath);
  const api = await SecurityApi.create(engine);
  const gate = new SecurityReleaseGate(api);
  const prd = new ProductionReleaseDecisionService(api, gate);
  const enf = new ProductionReleaseEnforcementService(api, gate, prd);
  return { api, gate, prd, enf, db: (api as any).engine };
}

async function main() {
  // ---------- A01. Clean continuity => ALLOW ----------
  section("A01 - clean identity + fresh evidence => ALLOW");
  {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const r = evaluateDeploymentSecurityContinuity({
      release_id: "rel-A",
      artifact_id: "art-A",
      artifact_digest: "sha256-A",
      commit_sha: "commit-A",
      environment: "production",
      execution_id: "exec-A",
      evidence: cleanEvidence("sha256-A", { expires: future }),
      expected_security_decision_digest: "sha256-A",
    });
    ok(r.decision === "ALLOW", "A01 ALLOW (got " + r.decision + ")");
    ok(r.assurance === "VALID", "A01 assurance VALID (got " + r.assurance + ")");
  }

  // ---------- A02. Old ALLOW vs new BLOCK canonical => BLOCK ----------
  section("A02 - latest canonical decision BLOCK overrides => BLOCK");
  {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const r = evaluateDeploymentSecurityContinuity({
      release_id: "rel-A", artifact_id: "art-A", artifact_digest: "sha256-A",
      commit_sha: "commit-A", environment: "production", execution_id: "exec-A",
      evidence: cleanEvidence("sha256-A", { expires: future }),
      expected_security_decision_digest: "sha256-A",
      latest_canonical_decision: "BLOCK",
    });
    ok(r.decision === "BLOCK", "A02 canonical BLOCK wins (got " + r.decision + ")");
  }

  // ---------- A03. Canonical REQUIRE_REVIEW => REQUIRE_REVIEW ----------
  section("A03 - canonical decision REQUIRE_REVIEW => REQUIRE_REVIEW");
  {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const r = evaluateDeploymentSecurityContinuity({
      release_id: "rel-A", artifact_id: "art-A", artifact_digest: "sha256-A",
      commit_sha: "commit-A", environment: "production", execution_id: "exec-A",
      evidence: cleanEvidence("sha256-A", { expires: future }),
      expected_security_decision_digest: "sha256-A",
      latest_canonical_decision: "REQUIRE_REVIEW",
    });
    ok(r.decision === "REQUIRE_REVIEW", "A03 REQUIRE_REVIEW (got " + r.decision + ")");
  }

  // ---------- A04. Security decision digest mismatch => BLOCK ----------
  section("A04 - security decision digest != target digest => BLOCK");
  {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const r = evaluateDeploymentSecurityContinuity({
      release_id: "rel-A", artifact_id: "art-A", artifact_digest: "sha256-B",
      commit_sha: "commit-A", environment: "production", execution_id: "exec-A",
      evidence: cleanEvidence("sha256-B", { expires: future }),
      expected_security_decision_digest: "sha256-A", // approved digest ≠ target
    });
    ok(r.decision === "BLOCK", "A04 decision digest mismatch => BLOCK (got " + r.decision + ")");
    ok(r.assurance === "INVALID", "A04 assurance INVALID (got " + r.assurance + ")");
  }

  // ---------- A05. Artifact digest mismatch in evidence => BLOCK ----------
  section("A05 - evidence bound to different digest => BLOCK");
  {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const r = evaluateDeploymentSecurityContinuity({
      release_id: "rel-A", artifact_id: "art-A", artifact_digest: "sha256-B",
      commit_sha: "commit-A", environment: "production", execution_id: "exec-A",
      evidence: cleanEvidence("sha256-A", { expires: future }), // wrong digest
      expected_security_decision_digest: "sha256-B",
    });
    ok(r.decision === "BLOCK", "A05 evidence digest mismatch => BLOCK (got " + r.decision + ")");
  }

  // ---------- A06. Stale evidence => BLOCK ----------
  section("A06 - expired evidence => BLOCK (STALE)");
  {
    const past = new Date(Date.now() - 60_000).toISOString();
    const r = evaluateDeploymentSecurityContinuity({
      release_id: "rel-A", artifact_id: "art-A", artifact_digest: "sha256-A",
      commit_sha: "commit-A", environment: "production", execution_id: "exec-A",
      evidence: cleanEvidence("sha256-A", { expires: past }),
      expected_security_decision_digest: "sha256-A",
    });
    ok(r.decision === "BLOCK", "A06 stale => BLOCK (got " + r.decision + ")");
    ok(r.assurance === "STALE", "A06 assurance STALE (got " + r.assurance + ")");
  }

  // ---------- A07. BLOCKED scanner in evidence => BLOCK ----------
  section("A07 - scanner BLOCKED => BLOCK");
  {
    const ev = cleanEvidence("sha256-A");
    ev[0] = { ...ev[0], status: "BLOCKED" };
    const r = evaluateDeploymentSecurityContinuity({
      release_id: "rel-A", artifact_id: "art-A", artifact_digest: "sha256-A",
      commit_sha: "commit-A", environment: "production", execution_id: "exec-A",
      evidence: ev,
      expected_security_decision_digest: "sha256-A",
    });
    ok(r.decision === "BLOCK", "A07 BLOCKED scanner => BLOCK (got " + r.decision + ")");
    ok(r.assurance === "BLOCKED", "A07 assurance BLOCKED (got " + r.assurance + ")");
  }

  // ---------- A08. NOT_RUN scanner in evidence => BLOCK ----------
  section("A08 - scanner NOT_RUN => BLOCK");
  {
    const ev = cleanEvidence("sha256-A");
    ev[0] = { ...ev[0], status: "NOT_RUN" as any };
    const r = evaluateDeploymentSecurityContinuity({
      release_id: "rel-A", artifact_id: "art-A", artifact_digest: "sha256-A",
      commit_sha: "commit-A", environment: "production", execution_id: "exec-A",
      evidence: ev,
      expected_security_decision_digest: "sha256-A",
    });
    ok(r.decision === "BLOCK", "A08 NOT_RUN => BLOCK (got " + r.decision + ")");
    ok(r.assurance === "NOT_EXECUTED", "A08 assurance NOT_EXECUTED (got " + r.assurance + ")");
  }

  // ---------- A09. Missing evidence (empty set) => not ALLOW ----------
  section("A09 - empty evidence set is not ALLOW");
  {
    const r = evaluateDeploymentSecurityContinuity({
      release_id: "rel-A", artifact_id: "art-A", artifact_digest: "sha256-A",
      commit_sha: "commit-A", environment: "production", execution_id: "exec-A",
      evidence: [],
      expected_security_decision_digest: "sha256-A",
    });
    ok(r.decision !== "ALLOW", "A09 empty evidence != ALLOW (got " + r.decision + ")");
  }

  // ---------- A10. Idempotency: same input => same output ----------
  section("A10 - idempotency: identical inputs => identical decision");
  {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const input = {
      release_id: "rel-A", artifact_id: "art-A", artifact_digest: "sha256-A",
      commit_sha: "commit-A", environment: "production", execution_id: "exec-A",
      evidence: cleanEvidence("sha256-A", { expires: future }),
      expected_security_decision_digest: "sha256-A",
    };
    const r1 = evaluateDeploymentSecurityContinuity(input);
    const r2 = evaluateDeploymentSecurityContinuity(input);
    ok(r1.decision === r2.decision, "A10 decision stable (" + r1.decision + ")");
    ok(r1.assurance === r2.assurance, "A10 assurance stable (" + r1.assurance + ")");
  }

  // ---------- A11. Freshness boundary: expires exactly at now => not ALLOW ----------
  section("A11 - expires_at == now => not ALLOW");
  {
    const now = Date.now();
    const at = new Date(now).toISOString();
    const r = evaluateDeploymentSecurityContinuity({
      release_id: "rel-A", artifact_id: "art-A", artifact_digest: "sha256-A",
      commit_sha: "commit-A", environment: "production", execution_id: "exec-A",
      evidence: cleanEvidence("sha256-A", { expires: at }),
      expected_security_decision_digest: "sha256-A",
      now,
    });
    ok(r.decision === "BLOCK", "A11 expires_at==now => BLOCK (got " + r.decision + ")");
  }

  // ---------- A12. Enforcement module wires continuity ----------
  section("A12 - enforcement imports and calls continuity");
  {
    const enfSrc = fs.readFileSync("src/core/production-release-enforcement.ts", "utf8");
    ok(enfSrc.includes("evaluateDeploymentSecurityContinuity"),
       "A12 enforcement imports continuity function");
    ok(enfSrc.includes("deployment.security.blocked"),
       "A12 enforcement audits deployment.security.blocked");
    ok(enfSrc.includes("deployment.security.review_required"),
       "A12 enforcement audits deployment.security.review_required");
  }

  // ---------- A13. End-to-end via real SecurityApi + gate ----------
  section("A13 - real SecurityApi supplies evidence to continuity");
  {
    const { api, db } = await freshEnv();
    const execId = "exec-248-e2e";
    const future = new Date(Date.now() + 3600_000).toISOString();

    for (const cat of NINE_CATS) {
      const ev: any = {
        id: "ev-248-e2e-" + cat,
        project_id: "p-248",
        execution_id: execId,
        commit_sha: "commit-e2e",
        artifact_digest: "sha256-e2e",
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

    const evidence = await api.getEvidence(execId);
    ok(evidence.length === NINE_CATS.length,
       "A13 api.getEvidence returned " + evidence.length + " items");

    const r = evaluateDeploymentSecurityContinuity({
      release_id: "rel-e2e",
      artifact_id: "art-e2e",
      artifact_digest: "sha256-e2e",
      commit_sha: "commit-e2e",
      environment: "production",
      execution_id: execId,
      evidence,
      expected_security_decision_digest: "sha256-e2e",
    });
    ok(r.decision === "ALLOW", "A13 e2e ALLOW (got " + r.decision + ")");
  }

  // ---------- A14. No production imports of src/security ----------
  section("A14 - boundary: no src/security imports in production");
  {
    const walk = (d: string): string[] => {
      const out: string[] = [];
      for (const name of fs.readdirSync(d)) {
        const full = path.join(d, name);
        const st = fs.statSync(full);
        if (st.isDirectory()) out.push(...walk(full));
        else if (name.endsWith(".ts")) out.push(full);
      }
      return out;
    };
    const files = [...walk("src"), ...walk("scripts")];
    const bad = files.filter((f) => {
      const s = fs.readFileSync(f, "utf8");
      return /from\s+"[^"]*src\/security\//.test(s) || /from\s+"\.\.\/security\//.test(s);
    });
    ok(bad.length === 0, "A14 no src/security imports (hits=" + bad.length + ")");
    if (bad.length > 0) for (const b of bad) console.log("   " + b);
  }

  console.log("\n============================================");
  console.log("PASS: " + passed);
  console.log("FAIL: " + failed);
  console.log("============================================");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exit(1); });