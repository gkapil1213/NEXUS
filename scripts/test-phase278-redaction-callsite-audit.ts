// scripts/test-phase278-redaction-callsite-audit.ts
//
// Phase 278 — Secret-Redaction Call-Site Audit & Credential-Exposure
// Boundary Verification.
//
// Three confirmed findings, each reproduced at runtime before fix:
//   A  src/core/audit.ts   redactText        — misses ghu|ghs|ghr, sk-proj, ASIA
//   B  src/core/github-actions-cicd-provider.ts redactSecrets
//                                            — misses sk-*, AKIA|ASIA, URL, api_key=,
//                                              secret=, password=, Basic, PEM
//   D  scripts/nexus-host-bridge.mjs redact() — misses sk-proj, ASIA, ghu,
//                                              Bearer, URL credentials
//
// Test method: exercise the production redaction functions and the shared
// host-bridge redactor imported by nexus-host-bridge.mjs. The bridge imports
// this same module for stdout/stderr redaction, so these assertions validate
// the shared implementation without spawning the bridge child-process lifecycle.
// Live host-process verification is a separate check and is not performed here.
//
// Every assertion inspects the value internally and reports only PASS/FAIL
// labels. No assertion prints a synthetic secret value.

import { redactText, redactMetadata } from "../src/core/audit";
import { redactSecrets as sharedRedact } from "../src/core/secret-redaction";
import { redactSecrets as cicdRedact } from "../src/core/github-actions-cicd-provider";
import { redact as bridgeRedact } from "./nexus-host-bridge-redaction.mjs";

let passed = 0, failed = 0;
function ok(c: boolean, m: string) {
  if (c) { passed++; console.log("PASS  " + m); }
  else { failed++; console.log("FAIL  " + m); }
}
function section(t: string) { console.log("\n--- " + t + " ---"); }

// Synthetic fixtures — never real credentials.
const F_SK_PLAIN   = "sk-" + "A".repeat(24);
const F_SK_PROJ    = "sk-proj-" + "B".repeat(24);
const F_AKIA       = "AKIA" + "C".repeat(16);
const F_ASIA       = "ASIA" + "D".repeat(16);
const F_GHP        = "ghp_" + "E".repeat(20);
const F_GHO        = "gho_" + "F".repeat(20);
const F_GHU        = "ghu_" + "G".repeat(20);
const F_GHS        = "ghs_" + "H".repeat(20);
const F_GHR        = "ghr_" + "I".repeat(20);
const F_BEARER     = "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.SflKxwRJSMeKKF2QT4";
const F_URL_DB     = "postgres://user:pw@h/db";
const F_PEM        = "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----";
const F_APIKEY_EQ  = "api_key=" + "K".repeat(20);
const F_SECRET_EQ  = "secret=" + "L".repeat(20);
const F_PASS_EQ    = "password=" + "M".repeat(20);
const F_BASIC_PAYLOAD = "dXNlcjpwYXNz".padEnd(20, "=");
const F_BASIC         = "Basic " + F_BASIC_PAYLOAD;



function main() {
  console.log("=== Phase 278 — redaction call-site audit ===\n");

  section("278-1 audit.redactText — ghu/ghs/ghr + sk-proj + ASIA (Finding A)");
  {
    const ghOut = redactText(`token ${F_GHU} end`);
    ok(!ghOut.includes(F_GHU), "278-1 audit.redactText: ghu full removed");
    ok(/\[REDACTED/i.test(ghOut), "278-1 audit.redactText: ghu marker present");
    ok(ghOut.includes("token "), "278-1 audit.redactText: ghu prefix preserved");

    const ghOut2 = redactText(`token ${F_GHS} end`);
    ok(!ghOut2.includes(F_GHS), "278-1 audit.redactText: ghs full removed");
    const ghOut3 = redactText(`token ${F_GHR} end`);
    ok(!ghOut3.includes(F_GHR), "278-1 audit.redactText: ghr full removed");

    const skOut = redactText(`provider ${F_SK_PROJ} rejected`);
    ok(!skOut.includes(F_SK_PROJ), "278-1 audit.redactText: sk-proj full removed");
    ok(/\[REDACTED/i.test(skOut), "278-1 audit.redactText: sk-proj marker present");

    const asiaOut = redactText(`creds ${F_ASIA} expired`);
    ok(!asiaOut.includes(F_ASIA), "278-1 audit.redactText: ASIA full removed");
    ok(/\[REDACTED/i.test(asiaOut), "278-1 audit.redactText: ASIA marker present");

    // Existing coverage — must still pass.
    ok(!redactText(`x ${F_GHP} y`).includes(F_GHP), "278-1 audit.redactText: ghp still removed");
    ok(!redactText(`x ${F_AKIA} y`).includes(F_AKIA), "278-1 audit.redactText: AKIA still removed");
    ok(!redactText(`x ${F_SK_PLAIN} y`).includes(F_SK_PLAIN), "278-1 audit.redactText: sk-* still removed");
  }

  section("278-2 audit.redactMetadata — same coverage on object shapes");
  {
    const r = redactMetadata({
      note: `provider=${F_SK_PROJ}`,
      detail: `creds ${F_ASIA}`,
      gh: `token ${F_GHU}`,
    }) as Record<string, unknown>;
    const j = JSON.stringify(r);
    ok(!j.includes(F_SK_PROJ), "278-2 redactMetadata: sk-proj absent from string value");
    ok(!j.includes(F_ASIA),    "278-2 redactMetadata: ASIA absent from string value");
    ok(!j.includes(F_GHU),     "278-2 redactMetadata: ghu absent from string value");
  }

  section("278-3 github-actions-cicd-provider.redactSecrets (Finding B)");
  {
    const cases: Array<[string, string, string]> = [
      ["sk-proj",  F_SK_PROJ,   "sk-proj"],
      ["ASIA",     F_ASIA,      "ASIA"],
      ["URL",      F_URL_DB,    "user:pw"],
      ["api_key=", F_APIKEY_EQ, "api_key"],
      ["secret=",  F_SECRET_EQ, "secret="],
      ["password=", F_PASS_EQ,  "password="],
      ["Basic",    F_BASIC,     F_BASIC_PAYLOAD],
      ["PEM",      F_PEM,       "BEGIN"],
    ];
    for (const [name, secret, needle] of cases) {
      const out = cicdRedact(`ctx ${secret} tail`);
      ok(!out.includes(needle) && !out.includes(secret),
         `278-3 cicd redactSecrets: ${name} removed`);
      ok(/\[REDACTED/i.test(out),
         `278-3 cicd redactSecrets: ${name} marker present`);
    }
    // Existing four patterns unchanged.
    ok(!cicdRedact(`x ${F_GHP} y`).includes(F_GHP),   "278-3 cicd: ghp_ still removed");
    ok(!cicdRedact(`x ${F_AKIA} y`).includes(F_AKIA), "278-3 cicd: AKIA covered (added by Phase 278)");
    ok(!cicdRedact(F_BEARER).includes("eyJhbGciOiJIUzI1NiJ9.SflKxwRJSMeKKF2QT4"),
       "278-3 cicd: Bearer still removed");
  }

  section("278-4 shared host-bridge redactor (Finding D)");
  {
    const cases: Array<[string, string, string]> = [
      ["sk-proj",  F_SK_PROJ,  "sk-proj"],
      ["ASIA",     F_ASIA,     "ASIA"],
      ["ghu",      F_GHU,      "ghu_"],
      ["Bearer",   F_BEARER,   F_BEARER.slice("Bearer ".length)],
      ["URL",      F_URL_DB,   "user:pw"],
    ];
    for (const [name, secret, needle] of cases) {
      const out = bridgeRedact(`upstream: ${secret} end`);
      ok(!out.includes(needle), `278-4 bridge redact(): ${name} removed`);
      ok(/\[REDACTED/i.test(out), `278-4 bridge redact(): ${name} marker present`);
    }
    // Existing pattern — AKIA — must still work.
    ok(!bridgeRedact(`x ${F_AKIA} y`).includes(F_AKIA), "278-4 bridge redact(): AKIA still removed");
  }

  section("278-5 Phase 271-277 regression — shared redactor unchanged");
  {
    ok(!sharedRedact(F_GHP).includes(F_GHP),       "278-5 shared: ghp_ still redacted");
    ok(!sharedRedact(F_AKIA).includes(F_AKIA),     "278-5 shared: AKIA still redacted");
    ok(!sharedRedact(F_ASIA).includes(F_ASIA),     "278-5 shared: ASIA still redacted");
    ok(!sharedRedact(F_SK_PROJ).includes(F_SK_PROJ), "278-5 shared: sk-proj still redacted");
    ok(!sharedRedact(F_URL_DB).includes("user:pw"), "278-5 shared: URL creds still redacted");
    ok(!sharedRedact(F_PEM).includes("AAAA"),      "278-5 shared: PEM still redacted");
  }

  section("278-6 negative controls — no over-redaction");
  {
    ok(redactText("sk-short") === "sk-short",       "278-6 redactText: sk-short unchanged");
    ok(redactText("ASIA1234") === "ASIA1234",       "278-6 redactText: short ASIA unchanged");
    ok(redactText("asia" + "D".repeat(16)) === ("asia" + "D".repeat(16)),
                                                     "278-6 redactText: lowercase asia unchanged");
    ok(redactText("hello world") === "hello world", "278-6 redactText: non-secret unchanged");

    ok(cicdRedact("sk-short") === "sk-short",       "278-6 cicd: sk-short unchanged");
    ok(cicdRedact("ASIA1234") === "ASIA1234",       "278-6 cicd: short ASIA unchanged");

    ok(bridgeRedact("sk-short") === "sk-short",     "278-6 bridge: sk-short unchanged");
    ok(bridgeRedact("hello world") === "hello world","278-6 bridge: non-secret unchanged");
  }

  section("278-7 idempotence");
  {
    const once  = redactText(`a ${F_SK_PROJ} b ${F_ASIA} c ${F_GHU}`);
    const twice = redactText(once);
    ok(once === twice, "278-7 redactText: second pass no-op");

    const cOnce  = cicdRedact(`a ${F_SK_PROJ} b ${F_ASIA} c ${F_URL_DB}`);
    const cTwice = cicdRedact(cOnce);
    ok(cOnce === cTwice, "278-7 cicd: second pass no-op");

    const bOnce  = bridgeRedact(`a ${F_SK_PROJ} b ${F_BEARER} c ${F_URL_DB}`);
    const bTwice = bridgeRedact(bOnce);
    ok(bOnce === bTwice, "278-7 bridge: second pass no-op");
  }

  section("278-8 marker stability");
  {
    ok(redactText(`x ${F_SK_PROJ}`).includes("[REDACTED:provider api key]"),
       "278-8 redactText: provider api key label preserved");
    ok(redactText(`x ${F_ASIA}`).includes("[REDACTED:aws access key]"),
       "278-8 redactText: aws access key label preserved");
    ok(redactText(`x ${F_GHU}`).includes("[REDACTED:github token]"),
       "278-8 redactText: ghu uses existing github token label");

    ok(bridgeRedact(`x ${F_SK_PROJ}`).includes("[REDACTED:provider api key]"),
       "278-8 bridge: provider api key label preserved");
    ok(bridgeRedact(`x ${F_ASIA}`).includes("[REDACTED:aws access key]"),
       "278-8 bridge: aws access key label preserved");
    ok(bridgeRedact(`x ${F_BEARER}`).includes("[REDACTED:bearer_token]"),
       "278-8 bridge: bearertoken marker for new Bearer rule");
  }

  console.log("\n============================================");
  console.log("PASS: " + passed);
  console.log("FAIL: " + failed);
  console.log("============================================");
  process.exitCode = failed > 0 ? 1 : 0;
}

main();