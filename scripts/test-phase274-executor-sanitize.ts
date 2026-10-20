// scripts/test-phase274-executor-sanitize.ts
// Phase 274 — Executor sanitize() integration with canonical redactSecrets.
//
// Phase 274 finding: six engineering executors had local sanitize() functions
// narrower than redactSecrets. Their output is persisted to engineering_run_events
// and the artifact store. A ghp_ token or AKIA key in build/test stdout/stderr
// was persisted unredacted.
//
// This test verifies that each of the six sanitize() functions now handles every
// secret format that redactSecrets handles:
//   - GitHub tokens (ghp_, gho_)
//   - Provider API keys (sk-)
//   - AWS access keys (AKIA)
//   - PEM private key blocks
//   - Embedded credentials (api_key=...)
//   - postgres:// URLs with credentials
//   - Bearer tokens
//
// No synthetic secret value is printed in the assertion messages.

import assert from "node:assert/strict";

import { sanitize as sanitizeBuild }     from "../src/core/engineering-build-executor";
import { sanitize as sanitizeDiagnosis } from "../src/core/engineering-diagnosis-executor";
import { sanitize as sanitizeReleaseReady } from "../src/core/engineering-release-ready-executor";
import { sanitize as sanitizeRepair }    from "../src/core/engineering-repair-executor";
import { sanitize as sanitizeSecurityReview } from "../src/core/engineering-security-review-executor";
import { sanitize as sanitizeTest }      from "../src/core/engineering-test-executor";

let passed = 0, failed = 0;
function ok(c: boolean, m: string) {
  if (c) { passed++; console.log("PASS  " + m); }
  else { failed++; console.log("FAIL  " + m); }
}
function section(t: string) { console.log("\n--- " + t + " ---"); }

// Synthetic secret values — constructed so they match the canonical patterns
// and never appear in assertion messages.
const SYNTH = {
  github_token: "ghp_" + "A".repeat(20) + "zzz",
  aws_access_key: "AKIA" + "A".repeat(16),
  provider_api_key: "sk-" + "A".repeat(16),
  pem_block: "-----BEGIN RSA PRIVATE KEY-----\n" + "MIIEow".repeat(8) + "\n-----END RSA PRIVATE KEY-----",
  api_key_kv: "api_key=" + "A".repeat(20),
  postgres_url: "postgres://user:supersecretpw@db.example.test/nexus",
  bearer: "Bearer " + "A".repeat(24),
};

function assertRedacted(name: string, input: string, mustNotContain: string[], mustContain: string[]) {
  const out = sanitizeFixture(name, input);
  for (const s of mustNotContain) {
    ok(!out.includes(s), `${name}: must not contain raw secret`);
  }
  for (const m of mustContain) {
    ok(out.includes(m), `${name}: must contain ${m}`);
  }
}

// Dispatch by name to the correct sanitize
const SANITIZERS: Record<string, (s: string) => string> = {
  build: sanitizeBuild,
  diagnosis: sanitizeDiagnosis,
  release_ready: sanitizeReleaseReady,
  repair: sanitizeRepair,
  security_review: sanitizeSecurityReview,
  test: sanitizeTest,
};
function sanitizeFixture(name: string, s: string): string {
  const fn = SANITIZERS[name];
  if (!fn) throw new Error("unknown sanitizer: " + name);
  return fn(s);
}

async function main() {
  console.log("=== Phase 274 — Executor sanitize() integration ===\n");

  const executors = ["build", "diagnosis", "release_ready", "repair", "security_review", "test"] as const;

  for (const executor of executors) {
    section(`274-${executor}: sanitize handles all canonical patterns`);

    // 1. GitHub token
    {
      const out = sanitizeFixture(executor, `stdout: ${SYNTH.github_token}`);
      ok(!out.includes(SYNTH.github_token), `${executor}: ghp_ token not redacted`);
      ok(out.includes("[REDACTED:github_token]"), `${executor}: ghp_ marker present`);
    }

    // 2. AWS access key
    {
      const out = sanitizeFixture(executor, `error: ${SYNTH.aws_access_key}`);
      ok(!out.includes(SYNTH.aws_access_key), `${executor}: AKIA key not redacted`);
      ok(out.includes("[REDACTED:aws_access_key]"), `${executor}: AKIA marker present`);
    }

    // 3. Provider API key
    {
      const out = sanitizeFixture(executor, `api call failed: ${SYNTH.provider_api_key}`);
      ok(!out.includes(SYNTH.provider_api_key), `${executor}: sk- key not redacted`);
      ok(out.includes("[REDACTED:provider_api_key]"), `${executor}: sk- marker present`);
    }

    // 4. PEM private key
    {
      const out = sanitizeFixture(executor, `key:\n${SYNTH.pem_block}\nend`);
      ok(!out.includes("BEGIN RSA PRIVATE KEY"), `${executor}: PEM header not redacted`);
      ok(!out.includes("MIIEow"), `${executor}: PEM body not redacted`);
      ok(out.includes("[REDACTED:private_key]"), `${executor}: PEM marker present`);
    }

    // 5. api_key=... embedded
    {
      const out = sanitizeFixture(executor, `config: ${SYNTH.api_key_kv}`);
      ok(!out.includes(SYNTH.api_key_kv), `${executor}: api_key= not redacted`);
      ok(out.includes("[REDACTED:embedded_credential]"), `${executor}: api_key marker present`);
    }

    // 6. postgres:// URL credentials
    {
      const out = sanitizeFixture(executor, `connect: ${SYNTH.postgres_url}`);
      ok(!out.includes("supersecretpw"), `${executor}: postgres password not redacted`);
      ok(out.includes("postgres://[REDACTED]@"), `${executor}: postgres marker present`);
    }

    // 7. Bearer token
    {
      const out = sanitizeFixture(executor, `Authorization: ${SYNTH.bearer}`);
      ok(!out.includes(SYNTH.bearer), `${executor}: Bearer token not redacted`);
      ok(out.includes("[REDACTED:bearer_token]"), `${executor}: Bearer marker present`);
    }

    // 8. Empty input safety
    {
      const out = sanitizeFixture(executor, "");
      ok(out === "", `${executor}: empty input returns empty`);
    }

    // 9. Non-secret content preserved
    {
      const out = sanitizeFixture(executor, "build finished in 1.2s with exit code 0");
      ok(out === "build finished in 1.2s with exit code 0",
         `${executor}: non-secret text preserved exactly`);
    }
  }

  console.log("\n============================================");
  console.log("PASS: " + passed);
  console.log("FAIL: " + failed);
  console.log("============================================");
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((e) => {
  console.error("Phase 274 harness failure:", e);
  process.exitCode = 1;
});