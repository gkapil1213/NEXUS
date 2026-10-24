// scripts/test-phase279-redaction-boundary-integration.ts
//
// Phase 279 — Production Redaction-Boundary Integration Audit.
//
// Confirmed finding: src/core/redaction.ts (the legacy Phase 105 redactor)
// misses every credential class that Phases 276-278 hardened elsewhere.
// Its ~28 script importers call `console.error(redactSecrets(e.message))`
// at operator-run sink sites. The pre-fix probe confirmed all 7 classes leak.
//
// This suite asserts:
//   - Pre-fix failing (279-1..279-7): the 7 credential classes
//   - Pre-fix passing (279-8..279-13): legacy behavior preserved + negatives
//
// Real production function. Synthetic credentials. No mocks.

import { redactSecrets } from "../src/core/redaction";

let passed = 0, failed = 0;
function ok(c: boolean, m: string) {
  if (c) { passed++; console.log("PASS  " + m); }
  else { failed++; console.log("FAIL  " + m); }
}
function section(t: string) { console.log("\n--- " + t + " ---"); }

const F_SK_CLASSIC = "sk-" + "A".repeat(24);
const F_SK_PROJ    = "sk-proj-" + "B".repeat(24);
const F_ASIA       = "ASIA" + "D".repeat(16);
const F_GHU        = "ghu_" + "G".repeat(20);
const F_BEARER     = "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.SflKxwRJSMeKKF2QT4";
const F_URL_DB     = "postgres://user:pw@h/db";
const F_PEM        = "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----";

function main() {
  console.log("=== Phase 279 — redaction boundary integration ===\n");

  section("279-1 sk-proj-* redacted by src/core/redaction.ts (Finding #1)");
  {
    const out = redactSecrets("upstream: " + F_SK_PROJ + " end");
    ok(!out.includes(F_SK_PROJ), "279-1 sk-proj full removed");
    ok(/\[REDACTED|=\*\*\*REDACTED\*\*\*/.test(out), "279-1 sk-proj marker present");
  }

  section("279-2 sk-classic redacted");
  {
    const out = redactSecrets("api " + F_SK_CLASSIC);
    ok(!out.includes(F_SK_CLASSIC), "279-2 sk-* full removed");
    ok(/\[REDACTED|=\*\*\*REDACTED\*\*\*/.test(out), "279-2 sk-* marker present");
  }

  section("279-3 ASIA* redacted");
  {
    const out = redactSecrets("creds " + F_ASIA + " expired");
    ok(!out.includes(F_ASIA), "279-3 ASIA full removed");
    ok(/\[REDACTED|=\*\*\*REDACTED\*\*\*/.test(out), "279-3 ASIA marker present");
  }

  section("279-4 ghu_* redacted");
  {
    const out = redactSecrets("token " + F_GHU + " end");
    ok(!out.includes(F_GHU), "279-4 ghu_* full removed");
    ok(/\[REDACTED|=\*\*\*REDACTED\*\*\*/.test(out), "279-4 ghu_* marker present");
  }

  section("279-5 bare Bearer redacted");
  {
    const tail = F_BEARER.slice("Bearer ".length);
    const out = redactSecrets("Authorization without prefix: " + F_BEARER);
    ok(!out.includes(tail), "279-5 Bearer token core removed");
    ok(/\[REDACTED|=\*\*\*REDACTED\*\*\*/.test(out), "279-5 Bearer marker present");
  }

  section("279-6 URL credentials redacted");
  {
    const out = redactSecrets("connection " + F_URL_DB);
    ok(!out.includes("user:pw"), "279-6 URL userinfo removed");
    ok(/\[REDACTED|=\*\*\*REDACTED\*\*\*/.test(out), "279-6 URL marker present");
  }

  section("279-7 PEM private key redacted");
  {
    const out = redactSecrets(F_PEM);
    ok(!out.includes("AAAA"), "279-7 PEM body removed");
    ok(/\[REDACTED|=\*\*\*REDACTED\*\*\*/.test(out), "279-7 PEM marker present");
  }

  section("279-8 legacy password= still produces =***REDACTED*** form");
  {
    const out = redactSecrets("password=secret123");
    ok(!out.includes("secret123"), "279-8 password value removed");
    ok(/password=\*\*\*REDACTED\*\*\*/.test(out), "279-8 password uses legacy marker");
  }

  section("279-9 legacy Authorization: Bearer form preserved");
  {
    const out = redactSecrets("Authorization: Bearer sometokenvalue123");
    ok(!out.includes("sometokenvalue123"), "279-9 Authorization value removed");
  }

  section("279-10 AKIA redacted");
  {
    const akia = "AKIA" + "C".repeat(16);
    const out = redactSecrets("key " + akia);
    ok(!out.includes(akia), "279-10 AKIA removed");
  }

  section("279-11 negatives — non-secret text unchanged");
  {
    ok(redactSecrets("") === "", "279-11 empty string passthrough");
    ok(redactSecrets("hello world") === "hello world", "279-11 plain text unchanged");
    ok(redactSecrets("token_count=42") === "token_count=42", "279-11 token_count unchanged");
  }

  section("279-12 idempotence");
  {
    const once  = redactSecrets("upstream: " + F_SK_PROJ + " end");
    const twice = redactSecrets(once);
    ok(once === twice, "279-12 second pass no-op");
    const pemOnce  = redactSecrets(F_PEM);
    const pemTwice = redactSecrets(pemOnce);
    ok(pemOnce === pemTwice, "279-12 PEM second pass no-op");
  }

  section("279-13 safe metadata preserved");
  {
    const out = redactSecrets("session_started_at=1700000000000 token_count=42");
    ok(out.includes("session_started_at"), "279-13 session_started_at preserved");
    ok(out.includes("token_count"), "279-13 token_count preserved");
  }

  console.log("\n============================================");
  console.log("PASS: " + passed);
  console.log("FAIL: " + failed);
  console.log("============================================");
  process.exitCode = failed > 0 ? 1 : 0;
}

main();