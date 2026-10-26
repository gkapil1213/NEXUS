// scripts/test-phase284-redaction-policy-contracts.ts
//
// Phase 284 — Redaction Policy Contracts, Drift Prevention, and Security
// Regression Gates.
//
// Establishes enforceable contracts proving:
//   1. secret-redaction.ts: SECRET_TEXT_PATTERNS is the single canonical
//      pattern source and is exported.
//   2. audit.ts derives its markers from SECRET_TEXT_PATTERNS via
//      AUDIT_MARKERS, with no independent regex policy.
//   3. Both consumers preserve their documented marker formats
//      (underscore for shared, space for audit) across every pattern.
//   4. No duplicate regex literal exists in audit.ts outside the canonical
//      source.
//   5. The URL-userinfo scrub is shared, not duplicated.
//   6. Every marker in SECRET_TEXT_PATTERNS has a translation in AUDIT_MARKERS.
//   7. redaction.ts (Phase 279 wrapper) retains its legacy pattern list and
//      its sharedRedact-before-legacy pipeline order.
//
// This test uses synthetic canaries only. No live credentials.
//
// Scope and limitations of the drift detector are documented in
// docs/phase284/SECURITY_POLICY.md. In short: this catches the specific
// regression classes named in the Phase 284 prompt. It cannot prove that no
// possible future change reintroduces a bypass.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { redactSecrets, SECRET_TEXT_PATTERNS } from "../src/core/secret-redaction";
import { redactText, redactMetadata } from "../src/core/audit";

let passed = 0;
let failed = 0;

function ok(condition: boolean, label: string): void {
  if (condition) { passed++; console.log("PASS " + label); }
  else { failed++; console.log("FAIL " + label); }
}
function section(label: string): void {
  console.log("\n--- " + label + " ---");
}
function serializes(v: unknown): boolean {
  try { JSON.stringify(v); return true; } catch { return false; }
}

const ROOT = process.cwd();
const SHARED_SRC   = readFileSync(join(ROOT, "src", "core", "secret-redaction.ts"), "utf8");
const AUDIT_SRC    = readFileSync(join(ROOT, "src", "core", "audit.ts"), "utf8");
const REDACTION_SRC = readFileSync(join(ROOT, "src", "core", "redaction.ts"), "utf8");

// ---------------------------------------------------------------------------
// Synthetic fixtures — never live credentials.
// ---------------------------------------------------------------------------
const F_GHP       = "ghp_" + "A".repeat(24);
const F_GHO       = "gho_" + "B".repeat(24);
const F_GHU       = "ghu_" + "C".repeat(24);
const F_GHS       = "ghs_" + "D".repeat(24);
const F_GHR       = "ghr_" + "E".repeat(24);
const F_SK_PROJ   = "sk-proj-" + "F".repeat(24);
const F_SK_CLASS  = "sk-" + "G".repeat(24);
const F_AKIA      = "AKIA" + "H".repeat(16);
const F_ASIA      = "ASIA" + "I".repeat(16);
const F_BEARER    = "Bearer " + "J".repeat(24);
const F_PEM       = "-----BEGIN RSA PRIVATE KEY-----\n" + "K".repeat(32) + "\n-----END RSA PRIVATE KEY-----";
const F_EMBEDDED  = "api_key=" + "L".repeat(20);
const F_URL       = "postgres://user:pass@db.example.test/nexus";

// Negative controls — must not be over-redacted.
const N_SK_SHORT  = "sk-short";
const N_ASIA_SHRT = "ASIA1234";
const N_LOWER     = "asia" + "M".repeat(16);
const N_PLAIN     = "hello world";

function main(): void {
  console.log("=== Phase 284 — redaction policy contracts ===\n");

  // -------------------------------------------------------------------------
  section("284-1 canonical source is exported and shaped correctly");
  {
    ok(Array.isArray(SECRET_TEXT_PATTERNS), "284-1 SECRET_TEXT_PATTERNS is an array");
    ok(SECRET_TEXT_PATTERNS.length >= 8,
       "284-1 SECRET_TEXT_PATTERNS has at least 8 entries (got " + SECRET_TEXT_PATTERNS.length + ")");
    let shapeOk = true;
    let markerFormatOk = true;
    for (const entry of SECRET_TEXT_PATTERNS) {
      if (!Array.isArray(entry) || entry.length !== 2) { shapeOk = false; break; }
      const re = (entry as any)[0];
      const marker = (entry as any)[1];
      if (!(re instanceof RegExp)) { shapeOk = false; break; }
      if (typeof marker !== "string") { shapeOk = false; break; }
      if (!/^\[REDACTED:[a-z_]+\]$/.test(marker)) { markerFormatOk = false; }
    }
    ok(shapeOk, "284-1 every entry is [RegExp, string]");
    ok(markerFormatOk, "284-1 every shared marker is underscore-based");
  }

  // -------------------------------------------------------------------------
  section("284-2 audit consumes the canonical source (source-level)");
  {
    ok(/import\s*\{[^}]*SECRET_TEXT_PATTERNS[^}]*\}\s*from\s*["']\.\/secret-redaction["']/.test(AUDIT_SRC),
       "284-2 audit.ts imports SECRET_TEXT_PATTERNS from ./secret-redaction");

    ok(!/\bSECRET_PATTERNS\b/.test(AUDIT_SRC),
       "284-2 audit.ts has no SECRET_PATTERNS identifier (old duplicate gone)");

    ok(/AUDIT_TEXT_PATTERNS[\s\S]{0,80}=\s*SECRET_TEXT_PATTERNS\.map\(/.test(AUDIT_SRC),
       "284-2 AUDIT_TEXT_PATTERNS is derived from SECRET_TEXT_PATTERNS.map(...)");
  }

  // -------------------------------------------------------------------------
  section("284-3 drift detector: no duplicate pattern source in audit.ts");
  {
    const stripped = AUDIT_SRC
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

    const regexLiteralMatches = stripped.match(/(?<![\w/])\/(?![\s*\/])[^\n\/]{1,200}\/[gimsuy]*/g) ?? [];
    ok(regexLiteralMatches.length === 0,
       "284-3 audit.ts contains zero independent RegExp literals outside comments (found " +
       regexLiteralMatches.length + ")");

    const sharedUrl = (SHARED_SRC.match(/a-z0-9\+\.\\?-\]\*:\\\/\\\//g) ?? []).length;
    const auditUrl  = (AUDIT_SRC.match(/a-z0-9\+\.\\?-\]\*:\\\/\\\//g) ?? []).length;
    ok(sharedUrl >= 1, "284-3 URL-userinfo regex present in secret-redaction.ts");
    ok(auditUrl === 0, "284-3 URL-userinfo regex absent from audit.ts (found " + auditUrl + ")");
  }

  // -------------------------------------------------------------------------
  section("284-3b redaction.ts is a documented exception (locked shape)");
  {
    // redaction.ts (Phase 279 wrapper) intentionally maintains a legacy
    // key=value replacement list. It is NOT part of the canonical
    // SECRET_TEXT_PATTERNS policy; it preserves the legacy
    // `***REDACTED***` output shape locked by test-phase279.
    //
    // This section locks the wrapper's current shape and pipeline order so
    // that accidental changes are caught. It does NOT assert that
    // redaction.ts consumes SECRET_TEXT_PATTERNS — that consolidation is
    // out of Phase 284's scope and would break test-phase279.
    const legacyBlock = REDACTION_SRC.match(/const legacyPatterns\s*=\s*\[([\s\S]*?)\r?\n\s*\];/);
    const legacyMatches = legacyBlock
      ? legacyBlock[1].split(/\r?\n/).filter((line) => /^\s*\/.*\/(?:gi|g|i),?\s*$/.test(line))
      : [];
    ok(legacyMatches.length === 10,
       "284-3b redaction.ts legacyPatterns has exactly 10 entries (found " + legacyMatches.length + ")");

    ok(REDACTION_SRC.includes("/AWS_SECRET_ACCESS_KEY"),
       "284-3b redaction.ts still covers AWS_SECRET_ACCESS_KEY");
    ok(REDACTION_SRC.includes("/COSIGN_PASSWORD"),
       "284-3b redaction.ts still covers COSIGN_PASSWORD");
    ok(REDACTION_SRC.includes("/Authorization"),
       "284-3b redaction.ts still covers Authorization");

    const sharedRedactCall  = REDACTION_SRC.indexOf("sharedRedact(text)");
    const legacyLoopStart   = REDACTION_SRC.indexOf("for (const pattern of legacyPatterns)");
    ok(sharedRedactCall >= 0 && legacyLoopStart >= 0 && sharedRedactCall < legacyLoopStart,
       "284-3b redaction.ts calls sharedRedact before the legacy pattern loop");
  }

  // -------------------------------------------------------------------------
  section("284-4 AUDIT_MARKERS covers every canonical marker (drift guard)");
  {
    const auditMarkerBlock = AUDIT_SRC.match(/const AUDIT_MARKERS[\s\S]*?=\s*\{([\s\S]*?)\r?\n\};/);
    const markerKeys = auditMarkerBlock
      ? (auditMarkerBlock[1].match(/"\[REDACTED:[^"]+\]"\s*:/g) ?? [])
          .map((m) => m.slice(1, m.indexOf('"', 1)))
      : [];
    const distinctSharedMarkers = Array.from(new Set(SECRET_TEXT_PATTERNS.map(([, m]) => m)));
    const missing = distinctSharedMarkers.filter((m) => !markerKeys.includes(m));
    ok(missing.length === 0,
       "284-4 every canonical marker has an AUDIT_MARKERS entry (missing: " +
       JSON.stringify(missing) + ")");

    const markerValues = (AUDIT_SRC.match(/:\s*["'`](\[REDACTED:[^"'`]+\])["'`]/g) ?? [])
      .map((m) => (m.match(/\[REDACTED:[^\]]+\]/) as RegExpMatchArray)[0]);
    let allSpaced = true;
    for (const v of markerValues) { if (/_[a-z]/.test(v)) { allSpaced = false; } }
    ok(markerValues.length > 0, "284-4 AUDIT_MARKERS has at least one entry");
    ok(allSpaced, "284-4 no audit marker contains an underscore-separated suffix");
  }

  // -------------------------------------------------------------------------
  section("284-5 marker compatibility matrix — shared path");
  {
    const cases: Array<[string, string, string]> = [
      [F_GHP, "github_token", F_GHP],
      [F_GHO, "github_oauth_token", F_GHO],
      [F_GHU, "github_token", F_GHU],
      [F_GHS, "github_token", F_GHS],
      [F_GHR, "github_token", F_GHR],
      [F_SK_PROJ, "provider_api_key", F_SK_PROJ],
      [F_SK_CLASS, "provider_api_key", F_SK_CLASS],
      [F_AKIA, "aws_access_key", F_AKIA],
      [F_ASIA, "aws_access_key", F_ASIA],
      [F_BEARER, "bearer_token", F_BEARER],
      [F_PEM, "private_key", F_PEM],
      [F_EMBEDDED, "embedded_credential", F_EMBEDDED],
    ];
    for (const [input, label, secret] of cases) {
      const out = redactSecrets("prefix " + input + " suffix") as string;
      ok(!out.includes(secret), "284-5 shared: " + label + " absent");
      ok(out.includes("[REDACTED:" + label + "]"), "284-5 shared: " + label + " marker present");
      ok(out.includes("prefix ") && out.includes(" suffix"), "284-5 shared: " + label + " context preserved");
    }

    const urlOut = redactSecrets(F_URL) as string;
    ok(urlOut.includes("postgres://[REDACTED]@db.example.test/nexus"),
       "284-5 shared: URL userinfo redacted, host preserved");
  }

  // -------------------------------------------------------------------------
  section("284-6 marker compatibility matrix — audit path");
  {
    const cases: Array<[string, string, string]> = [
      [F_GHP, "github token", F_GHP],
      [F_GHO, "github oauth token", F_GHO],
      [F_GHU, "github token", F_GHU],
      [F_SK_PROJ, "provider api key", F_SK_PROJ],
      [F_SK_CLASS, "provider api key", F_SK_CLASS],
      [F_AKIA, "aws access key", F_AKIA],
      [F_ASIA, "aws access key", F_ASIA],
      [F_BEARER, "bearer token", F_BEARER],
      [F_PEM, "private key", F_PEM],
      [F_EMBEDDED, "embedded credential", F_EMBEDDED],
    ];
    for (const [input, label, secret] of cases) {
      const out = redactText("prefix " + input + " suffix");
      ok(!out.includes(secret), "284-6 audit: " + label + " absent");
      ok(out.includes("[REDACTED:" + label + "]"), "284-6 audit: " + label + " marker present");
      ok(out.includes("prefix ") && out.includes(" suffix"), "284-6 audit: " + label + " context preserved");
    }

    const urlOut = redactText(F_URL);
    ok(urlOut.includes("postgres://[REDACTED]@db.example.test/nexus"),
       "284-6 audit: URL userinfo redacted, host preserved");
  }

  // -------------------------------------------------------------------------
  section("284-7 negative controls — no over-redaction");
  {
    for (const n of [N_SK_SHORT, N_ASIA_SHRT, N_LOWER, N_PLAIN]) {
      const sharedOut = redactSecrets(n) as string;
      const auditOut  = redactText(n);
      ok(sharedOut === n, "284-7 shared: " + n.slice(0, 20) + " unchanged");
      ok(auditOut === n,  "284-7 audit: " + n.slice(0, 20) + " unchanged");
    }
  }

  // -------------------------------------------------------------------------
  section("284-8 idempotence — redacted output is stable");
  {
    for (const input of [F_GHP, F_ASIA, F_PEM, F_URL]) {
      const shared1 = redactSecrets(input) as string;
      const shared2 = redactSecrets(shared1) as string;
      ok(shared1 === shared2, "284-8 shared idempotent for " + input.slice(0, 20));
      const audit1 = redactText(input);
      const audit2 = redactText(audit1);
      ok(audit1 === audit2, "284-8 audit idempotent for " + input.slice(0, 20));
    }
  }

  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  section("284-9 derived-marker consistency — shared/audit differ only by underscores");
  {
    for (const [, sharedMarker] of SECRET_TEXT_PATTERNS) {
      const expectedAuditMarker = sharedMarker.replace(/_/g, " ");
      const expectedMapping = "\"" + sharedMarker + "\": \"" + expectedAuditMarker + "\"";
      ok(
        AUDIT_SRC.includes(expectedMapping),
        "284-9 " + sharedMarker + " has the expected explicit audit marker mapping"
      );
    }
  }

  // -------------------------------------------------------------------------
  section("284-10 metadata path preserves getter-safety and sensitive-key rules");
  {
    const salted = redactMetadata({ salt: "abc", user: "alice" }) as Record<string, unknown>;
    ok(!("salt" in salted), "284-10 salt is dropped (audit-specific extension)");
    ok(salted.user === "alice", "284-10 ordinary field preserved");

    let getterCalls = 0;
    const obj: Record<string, unknown> = { safe: "visible" };
    Object.defineProperty(obj, "computed", {
      enumerable: true,
      get() { getterCalls++; return "should-not-appear"; },
    });
    const out = redactMetadata(obj) as Record<string, unknown>;
    ok(getterCalls === 0, "284-10 audit getter never invoked");
    ok(out.computed === "[getter]", "284-10 audit accessor marked [getter]");
    ok(!JSON.stringify(out).includes("should-not-appear"), "284-10 getter return value absent");
  }

  // -------------------------------------------------------------------------
  section("284-11 serialization safety");
  {
    const samples: unknown[] = [
      redactSecrets(F_GHP),
      redactText(F_GHP),
      redactMetadata({ sk: F_SK_PROJ, url: F_URL }),
      redactSecrets({ a: F_AKIA, b: [F_BEARER] }),
    ];
    let allSerialize = true;
    for (const s of samples) { if (!serializes(s)) allSerialize = false; }
    ok(allSerialize, "284-11 representative outputs serialize with JSON.stringify");
  }

  // -------------------------------------------------------------------------
  console.log("\n============================================");
  console.log("PASS: " + passed);
  console.log("FAIL: " + failed);
  console.log("============================================");
  process.exitCode = failed > 0 ? 1 : 0;
}

main();
