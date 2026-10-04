// scripts/test-phase249-post-deployment-integrity.ts
// Phase 249 — Post-Deployment Integrity & Drift Enforcement verifier.
// Uses a deterministic test observer for the DeploymentObserver interface
// (the interface is explicitly designed to be injected). No fake deployment,
// no fake scanner, no fake security decision.
import fs from "node:fs";
import path from "node:path";
import {
  DeploymentObserver,
  DeploymentObservation,
  evaluateDeploymentIntegrity,
  ExpectedDeploymentIdentity,
} from "../src/core/post-deployment-integrity";

let passed = 0, failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log("PASS  " + msg); }
  else { failed++; console.log("FAIL  " + msg); }
}
function section(t: string): void { console.log("\n--- " + t + " ---"); }

const EXPECTED: ExpectedDeploymentIdentity = {
  deployment_id: "dep-249",
  release_id: "rel-249",
  artifact_id: "art-249",
  artifact_digest: "sha256-expected-A",
  environment: "production",
};

function observed(mut: Partial<DeploymentObservation>): DeploymentObservation {
  return {
    deployment_id: "dep-249",
    available: true,
    status: "OBSERVED",
    observed_release_id: "rel-249",
    observed_artifact_id: "art-249",
    observed_digest: "sha256-expected-A",
    observed_provider: "test-provider",
    observed_revision: "rev-1",
    observed_at: new Date().toISOString(),
    ...mut,
  };
}

// Test observer — always returns a pre-canned observation.
class FixedObserver implements DeploymentObserver {
  constructor(private obs: DeploymentObservation) {}
  async observe(_id: string): Promise<DeploymentObservation> { return this.obs; }
}

async function main() {
  // ---------- A01. Matching identity => VERIFIED ----------
  section("A01 - matching release/artifact/digest => VERIFIED");
  {
    const r = evaluateDeploymentIntegrity(EXPECTED, observed({}));
    ok(r.state === "VERIFIED", "A01 state VERIFIED (got " + r.state + ")");
    ok(r.reasons.length > 0, "A01 has reason");
  }

  // ---------- A02. Digest mismatch => DRIFTED ----------
  section("A02 - digest mismatch => DRIFTED");
  {
    const r = evaluateDeploymentIntegrity(EXPECTED, observed({ observed_digest: "sha256-observed-B" }));
    ok(r.state === "DRIFTED", "A02 state DRIFTED (got " + r.state + ")");
    ok(r.reasons.some((x) => x.includes("digest drift")), "A02 reason mentions digest drift");
  }

  // ---------- A03. Artifact mismatch => DRIFTED ----------
  section("A03 - artifact mismatch => DRIFTED");
  {
    const r = evaluateDeploymentIntegrity(EXPECTED, observed({ observed_artifact_id: "art-OTHER" }));
    ok(r.state === "DRIFTED", "A03 state DRIFTED (got " + r.state + ")");
    ok(r.reasons.some((x) => x.includes("artifact drift")), "A03 reason mentions artifact drift");
  }

  // ---------- A04. Release mismatch => DRIFTED ----------
  section("A04 - release mismatch => DRIFTED");
  {
    const r = evaluateDeploymentIntegrity(EXPECTED, observed({ observed_release_id: "rel-OTHER" }));
    ok(r.state === "DRIFTED", "A04 state DRIFTED (got " + r.state + ")");
    ok(r.reasons.some((x) => x.includes("release drift")), "A04 reason mentions release drift");
  }

  // ---------- A05. Missing observed identity => UNKNOWN ----------
  section("A05 - incomplete observed identity => UNKNOWN");
  {
    const r = evaluateDeploymentIntegrity(EXPECTED, observed({ observed_digest: null }));
    ok(r.state === "UNKNOWN", "A05 state UNKNOWN (got " + r.state + ")");
  }

  // ---------- A06. Observer unavailable => BLOCKED ----------
  section("A06 - observer unavailable => BLOCKED");
  {
    const r = evaluateDeploymentIntegrity(EXPECTED, observed({
      available: false, status: "NOT_EXECUTED", reason: "provider down",
    }));
    ok(r.state === "BLOCKED", "A06 state BLOCKED (got " + r.state + ")");
    ok(r.reasons.some((x) => x.includes("observer unavailable")), "A06 reason mentions unavailable");
  }

  // ---------- A07. Observation NOT_EXECUTED => NOT_EXECUTED ----------
  section("A07 - observation NOT_EXECUTED => NOT_EXECUTED");
  {
    const r = evaluateDeploymentIntegrity(EXPECTED, observed({
      available: true, status: "NOT_EXECUTED", reason: "observer intentionally skipped",
    }));
    ok(r.state === "NOT_EXECUTED", "A07 state NOT_EXECUTED (got " + r.state + ")");
  }

  // ---------- A08. Observation ERROR => UNKNOWN ----------
  section("A08 - observation ERROR => UNKNOWN");
  {
    const r = evaluateDeploymentIntegrity(EXPECTED, observed({
      available: true, status: "ERROR", reason: "transport timeout",
    }));
    ok(r.state === "UNKNOWN", "A08 state UNKNOWN (got " + r.state + ")");
  }

  // ---------- A09. Multi-drift: all reasons captured ----------
  section("A09 - multi-drift captures all reasons");
  {
    const r = evaluateDeploymentIntegrity(EXPECTED, observed({
      observed_release_id: "rel-X",
      observed_artifact_id: "art-X",
      observed_digest: "sha256-X",
    }));
    ok(r.state === "DRIFTED", "A09 state DRIFTED");
    ok(r.reasons.length === 3, "A09 captured 3 reasons (got " + r.reasons.length + ")");
  }

  // ---------- A10. Idempotency: same observation => same result ----------
  section("A10 - idempotent for identical observations");
  {
    const obs = observed({ observed_digest: "sha256-different" });
    const r1 = evaluateDeploymentIntegrity(EXPECTED, obs);
    const r2 = evaluateDeploymentIntegrity(EXPECTED, obs);
    ok(r1.state === r2.state, "A10 state stable");
    ok(r1.reasons.join("|") === r2.reasons.join("|"), "A10 reasons stable");
    ok(r1.state === "DRIFTED", "A10 state is DRIFTED");
  }

  // ---------- A11. Test observer round-trips through interface ----------
  section("A11 - DeploymentObserver interface is injectable");
  {
    const obs = new FixedObserver(observed({}));
    const back = await obs.observe("dep-249");
    ok(back.observed_digest === "sha256-expected-A", "A11 observer returns expected digest");
    const r = evaluateDeploymentIntegrity(EXPECTED, back);
    ok(r.state === "VERIFIED", "A11 verified via observer");
  }

  // ---------- A12. Enforcement source wires integrity ----------
  section("A12 - production-release-enforcement imports and calls integrity");
  {
    const src = fs.readFileSync("src/core/production-release-enforcement.ts", "utf8");
    ok(src.includes("evaluateDeploymentIntegrity"), "A12 imports/calls evaluateDeploymentIntegrity");
    ok(src.includes("DeploymentObserver"), "A12 uses DeploymentObserver interface");
    ok(src.includes("postDeploymentIntegrity"), "A12 attaches postDeploymentIntegrity to result");
    ok(src.includes("deployment.integrity.verified"), "A12 audits verified");
    ok(src.includes("deployment.integrity.unknown"), "A12 audits unknown");
  }

  // ---------- A13. No src/security imports anywhere ----------
  section("A13 - boundary: no src/security imports");
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
    ok(bad.length === 0, "A13 no src/security imports (hits=" + bad.length + ")");
  }

  // ---------- A14. No SQLite production fallback in new module ----------
  section("A14 - no SQLite fallback in post-deployment-integrity");
  {
    const src = fs.readFileSync("src/core/post-deployment-integrity.ts", "utf8");
    ok(!src.includes("better-sqlite3"), "A14 no better-sqlite3 import");
    ok(!src.includes("openEngine"), "A14 no openEngine call");
    ok(!src.includes("SQLiteEngine"), "A14 no SQLiteEngine reference");
  }

  // ---------- A15. Precedence sanity ----------
  section("A15 - fail-closed precedence");
  {
    // unavailable > anything
    const unavailable = observed({ available: false, status: "OBSERVED", observed_digest: "sha256-expected-A" });
    ok(evaluateDeploymentIntegrity(EXPECTED, unavailable).state === "BLOCKED",
       "A15 unavailable dominates even if observed matches");

    // error > drift
    const error = observed({ status: "ERROR", observed_digest: "sha256-different" });
    ok(evaluateDeploymentIntegrity(EXPECTED, error).state === "UNKNOWN",
       "A15 error dominates drift");

    // not_executed > drift
    const notExec = observed({ status: "NOT_EXECUTED", observed_digest: "sha256-different" });
    ok(evaluateDeploymentIntegrity(EXPECTED, notExec).state === "NOT_EXECUTED",
       "A15 not_executed dominates drift");

    // incomplete > drift
    const incomplete = observed({ observed_digest: null, observed_release_id: "rel-OTHER" });
    ok(evaluateDeploymentIntegrity(EXPECTED, incomplete).state === "UNKNOWN",
       "A15 incomplete identity dominates drift");
  }

  console.log("\n============================================");
  console.log("PASS: " + passed);
  console.log("FAIL: " + failed);
  console.log("============================================");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exit(1); });