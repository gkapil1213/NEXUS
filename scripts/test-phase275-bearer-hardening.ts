// scripts/test-phase275-bearer-hardening.ts
// Phase 275 — Bearer token redaction hardening.
//
// The Phase 274 Bearer pattern only matched [Bb]earer + [A-Za-z0-9._-]{16,}.
// It missed mixed-case schemes, base64 padding (+/=/~), and had no \b anchor.
// Phase 275 widens Bearer matching to cover RFC b64token characters and padding.
//
// This test asserts the widened pattern behaves correctly across:
//   - case variants (Bearer/bearer/BEARER/mixed)
//   - base64url separators (. -) and base64 chars (+ /) and padding (=)
//   - tilde (~)
//   - Authorization headers, diagnostics, embedded error text
//   - multiple tokens in one string
//   - preservation of surrounding text
//   - empty and non-secret input
//   - idempotence across repeated calls
//   - all six engineering executors continue to redact via redactSecrets
//
// No synthetic secret value is printed in assertion messages.

import assert from "node:assert/strict";
import { redactSecrets } from "../src/core/secret-redaction";
import { sanitize as sanitizeBuild } from "../src/core/engineering-build-executor";
import { sanitize as sanitizeDiagnosis } from "../src/core/engineering-diagnosis-executor";
import { sanitize as sanitizeReleaseReady } from "../src/core/engineering-release-ready-executor";
import { sanitize as sanitizeRepair } from "../src/core/engineering-repair-executor";
import { sanitize as sanitizeSecurityReview } from "../src/core/engineering-security-review-executor";
import { sanitize as sanitizeTest } from "../src/core/engineering-test-executor";

let passed = 0, failed = 0;
function ok(c: boolean, m: string) {
  if (c) { passed++; console.log("PASS  " + m); }
  else { failed++; console.log("FAIL  " + m); }
}
function section(t: string) { console.log("\n--- " + t + " ---"); }

// Synthetic tokens — clearly fake, never printed in assertion messages
const T_PLAIN   = "aBcDeFgHiJkLmNoPqRsTuVwX";
const T_B64URL  = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.SflKxwRJSMeKKF2QT4";
const T_B64STD  = "aBcDeF+/" + "x".repeat(20) + "/xyz";
const T_PADDED  = "a".repeat(20) + "==";
const T_TILDE   = "aBcDeF" + "~".repeat(20);

async function main() {
  console.log("=== Phase 275 — Bearer token hardening ===\n");

  section("275-1 case-insensitive scheme");
  for (const scheme of ["Bearer", "bearer", "BEARER", "BeArEr", "bEaReR"]) {
    const input = scheme + " " + T_PLAIN;
    const out = redactSecrets(input);
    ok(!out.includes(T_PLAIN), "275-1 " + scheme + ": token not present");
    ok(out.includes("[REDACTED:bearer_token]"), "275-1 " + scheme + ": marker present");
  }

  section("275-2 base64url separators");
  {
    const input = "Authorization: Bearer " + T_B64URL;
    const out = redactSecrets(input);
    ok(!out.includes(T_B64URL), "275-2 base64url token not present");
    ok(out.includes("[REDACTED:bearer_token]"), "275-2 marker present");
    ok(out.includes("Authorization: "), "275-2 header prefix preserved");
  }

  section("275-3 base64 with + and /");
  {
    const input = "Failed: Bearer " + T_B64STD + " end";
    const out = redactSecrets(input);
    ok(!out.includes(T_B64STD), "275-3 base64+ token not present");
    ok(out.includes("[REDACTED:bearer_token]"), "275-3 marker present");
    ok(out.includes("Failed: "), "275-3 prefix preserved");
    ok(out.includes(" end"), "275-3 suffix preserved");
  }

  section("275-4 padding characters");
  {
    const input = "bearer " + T_PADDED;
    const out = redactSecrets(input);
    ok(!out.includes(T_PADDED), "275-4 padded token not present");
    ok(out.includes("[REDACTED:bearer_token]"), "275-4 marker present");
  }

  section("275-5 tilde in token");
  {
    const input = "BEARER " + T_TILDE;
    const out = redactSecrets(input);
    ok(!out.includes(T_TILDE), "275-5 tilde token not present");
    ok(out.includes("[REDACTED:bearer_token]"), "275-5 marker present");
  }

  section("275-6 multiple Bearer tokens");
  {
    const t1 = "a".repeat(20) + "1111";
    const t2 = "b".repeat(20) + "2222";
    const input = "first: Bearer " + t1 + " second: bearer " + t2;
    const out = redactSecrets(input);
    ok(!out.includes(t1), "275-6 first token not present");
    ok(!out.includes(t2), "275-6 second token not present");
    const markerCount = (out.match(/\[REDACTED:bearer_token\]/g) || []).length;
    ok(markerCount === 2, "275-6 two markers present, got=" + markerCount);
  }

  section("275-7 token boundary and malformed padding");
  {
    const token = "a".repeat(24);
    const input = "Authorization: Bearer " + token + ", next=ok";
    const out = redactSecrets(input);
    ok(!out.includes(token), "275-7 valid token followed by comma is redacted");
    ok(out.includes("[REDACTED:bearer_token]"), "275-7 redaction marker present");
    ok(out.includes(", next=ok"), "275-7 punctuation and following context preserved");

    const malformed = "Bearer " + token + "==unexpected";
    const malformedOut = redactSecrets(malformed);
    ok(!malformedOut.includes(token), "275-7 malformed padding cannot expose token core");
    ok(malformedOut.includes("[REDACTED:bearer_token]"), "275-7 malformed token-like value is redacted");

    const adjacent = "Bearer " + token + "suffix";
    const adjacentOut = redactSecrets(adjacent);
    ok(!adjacentOut.includes(token), "275-7 adjacent token characters cannot expose token core");
    ok(adjacentOut.includes("[REDACTED:bearer_token]"), "275-7 adjacent token-like value is redacted");
  }

  section("275-8 diagnostic embedding");
  {
    const input = 'upstream error (401): got "Bearer ' + T_PLAIN + '"';
    const out = redactSecrets(input);
    ok(!out.includes(T_PLAIN), "275-7 diagnostic token not present");
    ok(out.includes("[REDACTED:bearer_token]"), "275-7 marker present");
    ok(out.includes("upstream error (401)"), "275-7 diagnostic context preserved");
  }

  section("275-8 surrounding text preservation");
  {
    const input = "prefix Bearer " + T_PLAIN + " suffix";
    const out = redactSecrets(input);
    ok(out.startsWith("prefix "), "275-8 prefix preserved");
    ok(out.endsWith(" suffix"), "275-8 suffix preserved");
  }

  section("275-9 empty and non-secret input");
  {
    ok(redactSecrets("") === "", "275-9 empty string passthrough");
    ok(redactSecrets("hello world") === "hello world", "275-9 non-secret unchanged");
    ok(redactSecrets("Bearer") === "Bearer", "275-9 bare scheme preserved");
    ok(redactSecrets("Bearer short") === "Bearer short", "275-9 short token preserved");
  }

  section("275-10 idempotence");
  {
    const input = "Bearer " + T_PLAIN;
    const once = redactSecrets(input);
    const twice = redactSecrets(once);
    ok(once === twice, "275-10 second pass is no-op");
  }

  section("275-11 other patterns unaffected");
  {
    const ghp = "ghp_" + "A".repeat(20);
    ok(redactSecrets(ghp).includes("[REDACTED:github_token]"), "275-11 ghp_ still redacted");
    const akia = "AKIA" + "A".repeat(16);
    ok(redactSecrets(akia).includes("[REDACTED:aws_access_key]"), "275-11 AKIA still redacted");
    const sk = "sk-" + "A".repeat(16);
    ok(redactSecrets(sk).includes("[REDACTED:provider_api_key]"), "275-11 sk- still redacted");
    const pg = "postgres://user:pw@h/db";
    ok(redactSecrets(pg).includes("postgres://[REDACTED]@"), "275-11 postgres still redacted");
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----";
    ok(redactSecrets(pem).includes("[REDACTED:private_key]"), "275-11 PEM still redacted");
  }

  section("275-12 six executors delegate correctly");
  const executors: Array<[string, (s: string) => string]> = [
    ["build", sanitizeBuild],
    ["diagnosis", sanitizeDiagnosis],
    ["release_ready", sanitizeReleaseReady],
    ["repair", sanitizeRepair],
    ["security_review", sanitizeSecurityReview],
    ["test", sanitizeTest],
  ];
  for (const [name, fn] of executors) {
    const input = "Bearer " + T_PLAIN;
    const out = fn(input);
    ok(!out.includes(T_PLAIN), "275-12 " + name + ": token not present");
    ok(out.includes("[REDACTED:bearer_token]"), "275-12 " + name + ": marker present");
  }

  console.log("\n============================================");
  console.log("PASS: " + passed);
  console.log("FAIL: " + failed);
  console.log("============================================");
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((e) => {
  console.error("Phase 275 harness failure:", e);
  process.exitCode = 1;
});
