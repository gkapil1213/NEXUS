// scripts/test-phase277-redaction-coverage.ts
//
// Phase 277 — Secret-Redaction Coverage Completion and Regression Hardening.
//
// Targeted coverage gaps left open by Phase 276:
//   Gap A  provider `sk-` keys with hyphenated components (e.g. `sk-proj-...`)
//   Gap B  AWS access key IDs with the `ASIA` prefix (temporary STS credentials)
//
// Both gaps existed in BOTH the shared redactor (src/core/secret-redaction.ts)
// and the provider redactor (src/core/ai-provider-redaction.ts). This suite
// exercises both real production functions in parallel so the two cannot
// silently drift apart on these formats.
//
// Test method: real functions, real inputs, no mocks. Synthetic tokens only.

import { redactSecrets as sharedRedact } from "../src/core/secret-redaction";
import { redactSecrets as aiRedact }     from "../src/core/ai-provider-redaction";

let passed = 0, failed = 0;
function ok(c: boolean, m: string) {
  if (c) { passed++; console.log("PASS  " + m); }
  else { failed++; console.log("FAIL  " + m); }
}
function section(t: string) { console.log("\n--- " + t + " ---"); }

// Synthetic fixtures — never real credentials.
const F_SK_PLAIN    = "sk-" + "A".repeat(24);                                // classic sk- form
const F_SK_PROJ     = "sk-proj-" + "B".repeat(24);                           // hyphenated, OpenAI-style
const F_ASIA        = "ASIA" + "C".repeat(16);                               // ASIA + 16 uppercase
const F_AKIA        = "AKIA" + "D".repeat(16);                               // AKIA + 16 uppercase
const F_SHORT_SK    = "sk-short";                                            // below length floor
const F_DEGEN_SK    = "sk--" + "E".repeat(20);                               // sk--<alnum> — malformed
const F_SHORT_ASIA  = "ASIA1234";                                            // length < 20
const F_NON_SECRET  = "sk-not-a-key-but-looks-similar";                      // below sk- length floor? see tests

function main() {
  console.log("=== Phase 277 — redaction coverage completion ===\n");

  section("277-1 sk-proj-* fully redacted (Gap A — both redactors)");
  {
    const provOut = aiRedact(`upstream 401: provider key ${F_SK_PROJ} rejected`);
    ok(!provOut.includes(F_SK_PROJ),            "277-1 ai: sk-proj full value removed");
    ok(provOut.includes("[REDACTED"),            "277-1 ai: marker present");
    ok(provOut.includes("upstream 401: provider key"), "277-1 ai: prefix context preserved");
    ok(provOut.includes("rejected"),             "277-1 ai: suffix context preserved");

    const sharedOut = sharedRedact(`upstream 401: provider key ${F_SK_PROJ} rejected`);
    ok(!sharedOut.includes(F_SK_PROJ),           "277-1 shared: sk-proj full value removed");
    ok(sharedOut.includes("[REDACTED"),           "277-1 shared: marker present");
    ok(sharedOut.includes("upstream 401: provider key"), "277-1 shared: prefix context preserved");
    ok(sharedOut.includes("rejected"),            "277-1 shared: suffix context preserved");
  }

  section("277-2 classic sk-* still redacted (Phase 276 regression)");
  {
    const provOut = aiRedact(`api ${F_SK_PLAIN}`);
    ok(!provOut.includes(F_SK_PLAIN), "277-2 ai: sk-* removed");
    ok(provOut.includes("[REDACTED"),  "277-2 ai: marker present");

    const sharedOut = sharedRedact(`api ${F_SK_PLAIN}`);
    ok(!sharedOut.includes(F_SK_PLAIN), "277-2 shared: sk-* removed");
    ok(sharedOut.includes("[REDACTED"),  "277-2 shared: marker present");
  }

  section("277-3 sk- negative controls (do not over-redact)");
  {
    // "sk-short" has no alphanumerics after sk- that meet the length floor.
    ok(aiRedact(F_SHORT_SK)     === F_SHORT_SK, "277-3 ai: 'sk-short' unchanged");
    ok(sharedRedact(F_SHORT_SK) === F_SHORT_SK, "277-3 shared: 'sk-short' unchanged");

    // "sk--<20 chars>" is malformed (double hyphen after sk-). Must not match.
    ok(aiRedact(F_DEGEN_SK)     === F_DEGEN_SK, "277-3 ai: 'sk--...' unchanged");
    ok(sharedRedact(F_DEGEN_SK) === F_DEGEN_SK, "277-3 shared: 'sk--...' unchanged");

    // No 'sk-' substring anywhere.
    ok(aiRedact("hello world")  === "hello world", "277-3 ai: non-secret unchanged");
    ok(sharedRedact("hello world") === "hello world", "277-3 shared: non-secret unchanged");
  }

  section("277-4 ASIA* fully redacted (Gap B — both redactors)");
  {
    const provOut = aiRedact(`temp creds: ${F_ASIA} (expires 15m)`);
    ok(!provOut.includes(F_ASIA),          "277-4 ai: ASIA full value removed");
    ok(provOut.includes("[REDACTED"),       "277-4 ai: marker present");
    ok(provOut.includes("temp creds:"),     "277-4 ai: prefix context preserved");
    ok(provOut.includes("(expires 15m)"),   "277-4 ai: suffix context preserved");

    const sharedOut = sharedRedact(`temp creds: ${F_ASIA} (expires 15m)`);
    ok(!sharedOut.includes(F_ASIA),          "277-4 shared: ASIA full value removed");
    ok(sharedOut.includes("[REDACTED"),       "277-4 shared: marker present");
    ok(sharedOut.includes("temp creds:"),     "277-4 shared: prefix context preserved");
    ok(sharedOut.includes("(expires 15m)"),   "277-4 shared: suffix context preserved");
  }

  section("277-5 AKIA* still redacted (Phase 276 regression)");
  {
    const provOut = aiRedact(`access key ${F_AKIA}`);
    ok(!provOut.includes(F_AKIA),       "277-5 ai: AKIA removed");
    ok(provOut.includes("[REDACTED"),    "277-5 ai: marker present");

    const sharedOut = sharedRedact(`access key ${F_AKIA}`);
    ok(!sharedOut.includes(F_AKIA),       "277-5 shared: AKIA removed");
    ok(sharedOut.includes("[REDACTED"),    "277-5 shared: marker present");
  }

  section("277-6 AWS access-key negative controls (do not over-redact)");
  {
    // ASIA1234 is only 8 chars — below the 20-char AWS key floor.
    ok(aiRedact(`not-a-key ${F_SHORT_ASIA}`) === `not-a-key ${F_SHORT_ASIA}`,
       "277-6 ai: short ASIA-shaped string unchanged");
    ok(sharedRedact(`not-a-key ${F_SHORT_ASIA}`) === `not-a-key ${F_SHORT_ASIA}`,
       "277-6 shared: short ASIA-shaped string unchanged");

    // A lowercase 'asia' prefix must not match — the pattern is uppercase-only.
    ok(aiRedact("asia" + "C".repeat(16)) === "asia" + "C".repeat(16),
       "277-6 ai: lowercase asia unchanged");
    ok(sharedRedact("asia" + "C".repeat(16)) === "asia" + "C".repeat(16),
       "277-6 shared: lowercase asia unchanged");
  }

  section("277-7 marker stability (consumer-visible labels unchanged)");
  {
    ok(aiRedact(`x ${F_SK_PLAIN}`).includes("[REDACTED:provider_api_key]"),
       "277-7 ai: provider_api_key marker stable");
    ok(sharedRedact(`x ${F_SK_PLAIN}`).includes("[REDACTED:provider_api_key]"),
       "277-7 shared: provider_api_key marker stable");

    ok(aiRedact(`x ${F_AKIA}`).includes("[REDACTED:aws_access_key]"),
       "277-7 ai: aws_access_key marker stable");
    ok(sharedRedact(`x ${F_AKIA}`).includes("[REDACTED:aws_access_key]"),
       "277-7 shared: aws_access_key marker stable");

    // ASIA keys use the same marker as AKIA — both are AWS access key IDs.
    ok(aiRedact(`x ${F_ASIA}`).includes("[REDACTED:aws_access_key]"),
       "277-7 ai: ASIA uses aws_access_key marker");
    ok(sharedRedact(`x ${F_ASIA}`).includes("[REDACTED:aws_access_key]"),
       "277-7 shared: ASIA uses aws_access_key marker");
  }

  section("277-8 idempotence (second pass is a no-op)");
  {
    const aiOnce  = aiRedact(`a ${F_SK_PROJ} b ${F_ASIA} c ${F_AKIA}`);
    const aiTwice = aiRedact(aiOnce);
    ok(aiOnce === aiTwice, "277-8 ai: second pass no-op");

    const sharedOnce  = sharedRedact(`a ${F_SK_PROJ} b ${F_ASIA} c ${F_AKIA}`);
    const sharedTwice = sharedRedact(sharedOnce);
    ok(sharedOnce === sharedTwice, "277-8 shared: second pass no-op");
  }

  section("277-9 no partial exposure (whole credential removed, not just prefix)");
  {
    // Confirm not just "sk-proj" prefix but the full secret material is gone.
    const skTail = F_SK_PROJ.slice(-12);          // last 12 chars of the credential
    ok(!aiRedact(F_SK_PROJ).includes(skTail),     "277-9 ai: sk-proj tail absent");
    ok(!sharedRedact(F_SK_PROJ).includes(skTail), "277-9 shared: sk-proj tail absent");

    const asiaTail = F_ASIA.slice(-8);
    ok(!aiRedact(F_ASIA).includes(asiaTail),      "277-9 ai: ASIA tail absent");
    ok(!sharedRedact(F_ASIA).includes(asiaTail),  "277-9 shared: ASIA tail absent");
  }

  section("277-10 Phase 273 safe-suffix regression (shared redactor)");
  {
    // Imported shape from Phase 273: object with safe-suffix keys must
    // preserve those keys, redact compound secret keys. Verify the fix did
    // not disturb the underlying key-matching rule.
    const payload: any = sharedRedact({
      token_count: 42,
      session_started_at: 1700000000000,
      authorization_level: "HIGH",
      client_secret: "should-be-redacted",
    });
    ok(payload.token_count === 42,               "277-10 token_count preserved");
    ok(payload.session_started_at === 1700000000000, "277-10 session_started_at preserved");
    ok(payload.authorization_level === "HIGH",   "277-10 authorization_level preserved");
    ok(!JSON.stringify(payload).includes("should-be-redacted"),
                                                 "277-10 client_secret value redacted");
  }

  console.log("\n============================================");
  console.log("PASS: " + passed);
  console.log("FAIL: " + failed);
  console.log("============================================");
  process.exitCode = failed > 0 ? 1 : 0;
}

main();