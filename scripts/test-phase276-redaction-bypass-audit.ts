// scripts/test-phase276-redaction-bypass-audit.ts
//
// Phase 276 — Secret-redaction bypass audit and regression hardening.
//
// Confirmed defects under test:
//   #1  src/core/audit.ts          redactText      — no Bearer rule
//   #2  src/core/ai-provider-redaction.ts          — misses AWS/GitHub/sk-/URL
//   #3  src/core/audit.ts          redactMetadata  — exact-match key check
//
// Phase 276 fixes:
//   A   add Bearer to SECRET_PATTERNS in audit.ts
//   B   add non-Bearer patterns to ai-provider-redaction.ts (additions only)
//   C   replace exact-match key check with normalize+substring+safe-suffix
//
// Test method: exercise the real production function, assert on its output.
// No mocks. Synthetic tokens only. Phase 271-275 fixtures unchanged.

import { redactText, redactMetadata } from "../src/core/audit";
import { redactSecrets as aiRedact } from "../src/core/ai-provider-redaction";
import { redactSecrets as sharedRedact } from "../src/core/secret-redaction";

let passed = 0, failed = 0;
function ok(c: boolean, m: string) {
  if (c) { passed++; console.log("PASS  " + m); }
  else { failed++; console.log("FAIL  " + m); }
}
function section(t: string) { console.log("\n--- " + t + " ---"); }

// Synthetic fixtures — never real credentials.
const F_BEARER_PLAIN  = "aBcDeFgHiJkLmNoPqRsTuVwX";
const F_BEARER_B64URL = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.SflKxwRJSMeKKF2QT4";
const F_BEARER_PADDED = "a".repeat(20) + "==";
const F_BEARER_TILDE  = "aBcDeF" + "~".repeat(20);
const F_AWS           = "AKIA" + "A".repeat(16);
const F_GITHUB        = "ghp_" + "A".repeat(20);
const F_PROVIDER      = "sk-" + "A".repeat(20);
const F_URL_DB        = "postgres://user:pw@h/db";

function main() {
  console.log("=== Phase 276 — redaction bypass audit ===\n");

  section("276-1 audit.redactText — Bearer token (defect #1)");
  {
    const input  = `upstream 401: got "Bearer ${F_BEARER_PLAIN}"`;
    const output = redactText(input);
    ok(!output.includes(F_BEARER_PLAIN), "276-1 plain Bearer token removed");
    ok(/\[REDACTED/i.test(output),       "276-1 redaction marker present");
    ok(output.includes("upstream 401"),  "276-1 non-secret context preserved");
    // Phase 276: the `audit.ts` contract (matching Phase 275's shared redactor)
    // replaces the entire `Bearer <token>` span with a marker. The scheme word
    // is consumed by the redaction, not preserved. The marker is the contract;
    // the assertion below is the correct check for it. See Phase 276 final
    // report §known-gaps for the pre-existing `[REDACTED:<label>]` vs
    // `[REDACTED:<label_underscore>]` divergence between audit.ts and
    // secret-redaction.ts — out of Phase 276 scope.
  }
  {
    const input  = "Authorization: Bearer " + F_BEARER_B64URL;
    const output = redactText(input);
    ok(!output.includes(F_BEARER_B64URL), "276-1 b64url Bearer token removed");
    ok(/\[REDACTED/i.test(output),         "276-1 b64url marker present");
    ok(output.includes("Authorization: "), "276-1 header prefix preserved");
  }
  {
    const input  = "bearer " + F_BEARER_PADDED;
    const output = redactText(input);
    ok(!output.includes(F_BEARER_PADDED), "276-1 padded Bearer token removed");
    ok(/\[REDACTED/i.test(output),         "276-1 padded marker present");
  }
  {
    const input  = "BEARER " + F_BEARER_TILDE;
    const output = redactText(input);
    ok(!output.includes(F_BEARER_TILDE), "276-1 tilde Bearer token removed");
    ok(/\[REDACTED/i.test(output),        "276-1 tilde marker present");
  }
  {
    ok(redactText("Bearer") === "Bearer",
       "276-1 bare scheme preserved (negative control)");
    ok(redactText("Bearer short") === "Bearer short",
       "276-1 short token preserved (negative control)");
    ok(redactText("hello world") === "hello world",
       "276-1 non-secret unchanged (negative control)");
  }

  section("276-2 ai-provider-redaction — non-Bearer classes (defect #2)");
  {
    const out = aiRedact(`key ${F_AWS}`);
    ok(!out.includes(F_AWS),        "276-2 AWS access key removed");
    ok(/\[REDACTED/i.test(out),     "276-2 AWS marker present");
  }
  {
    const out = aiRedact(`token ${F_GITHUB}`);
    ok(!out.includes(F_GITHUB),     "276-2 GitHub token removed");
    ok(/\[REDACTED/i.test(out),     "276-2 GitHub marker present");
  }
  {
    const out = aiRedact(`api ${F_PROVIDER}`);
    ok(!out.includes(F_PROVIDER),   "276-2 provider sk- key removed");
    ok(/\[REDACTED/i.test(out),     "276-2 sk- marker present");
  }
  {
    const out = aiRedact(`connection ${F_URL_DB}`);
    ok(!out.includes("user:pw"),    "276-2 URL userinfo removed");
    ok(out.includes("postgres://"), "276-2 URL scheme preserved");
    ok(out.includes("@h/db"),       "276-2 URL host preserved");
  }

  section("276-3 audit.redactMetadata — compound keys (defect #3)");
  {
    const r = redactMetadata({
      client_secret:       "SyntheticSecretValue123",
      refresh_token:       "SyntheticRefreshValue123",
      access_token:        "SyntheticAccessValue123",
      session_id:          "SyntheticSessionValue123",
      aws_secret_key:      "SyntheticAwsValue123",
      password:            "SyntheticPasswordValue123",
      nested: { refresh_token: "SyntheticRefreshValue123" },
    }) as Record<string, unknown>;
    const text = JSON.stringify(r);
    ok(!text.includes("SyntheticSecretValue123"),  "276-3 client_secret redacted");
    ok(!text.includes("SyntheticRefreshValue123"), "276-3 refresh_token redacted (top level)");
    ok(!text.includes("SyntheticAccessValue123"),  "276-3 access_token redacted");
    ok(!text.includes("SyntheticSessionValue123"), "276-3 session_id redacted");
    ok(!text.includes("SyntheticAwsValue123"),     "276-3 aws_secret_key redacted");
    ok(!text.includes("SyntheticPasswordValue123"),"276-3 password still redacted (regression)");
  }
  {
    const r = redactMetadata({
      token_count:        42,
      authorization_level: "HIGH",
      session_started_at: 1700000000000,
      user:               "alice",
    }) as Record<string, unknown>;
    ok(r.token_count === 42,              "276-3 token_count preserved (safe suffix)");
    ok(r.authorization_level === "HIGH",  "276-3 authorization_level preserved (safe suffix)");
    ok(r.session_started_at === 1700000000000,
                                          "276-3 session_started_at preserved (safe suffix)");
    ok(r.user === "alice",                "276-3 non-secret field preserved");
  }

  section("276-4 idempotence");
  {
    const once  = redactText("Authorization: Bearer " + F_BEARER_PLAIN);
    const twice = redactText(once);
    ok(once === twice, "276-4 redactText second pass is no-op");

    const aiOnce  = aiRedact(`key ${F_AWS} token ${F_GITHUB}`);
    const aiTwice = aiRedact(aiOnce);
    ok(aiOnce === aiTwice, "276-4 aiRedact second pass is no-op");
  }

  section("276-5 Phase 271-275 cross-redactor regression");
  {
    ok(sharedRedact(F_GITHUB).includes("[REDACTED:github_token]"),
       "276-5 shared: ghp_ still redacted");
    ok(sharedRedact(F_AWS).includes("[REDACTED:aws_access_key]"),
       "276-5 shared: AKIA still redacted");
    ok(sharedRedact(F_PROVIDER).includes("[REDACTED:provider_api_key]"),
       "276-5 shared: sk- still redacted");
    ok(sharedRedact("Bearer " + F_BEARER_B64URL).includes("[REDACTED:bearer_token]"),
       "276-5 shared: Bearer still redacted");
    ok(sharedRedact(F_URL_DB).includes("postgres://[REDACTED]@"),
       "276-5 shared: URL creds still redacted");
    ok(sharedRedact("-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----")
         .includes("[REDACTED:private_key]"),
       "276-5 shared: PEM still redacted");
  }

  console.log("\n============================================");
  console.log("PASS: " + passed);
  console.log("FAIL: " + failed);
  console.log("============================================");
  process.exitCode = failed > 0 ? 1 : 0;
}

main();
