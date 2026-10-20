// scripts/test-phase273-end-to-end-redaction.ts
// Phase 273 — End-to-end secret redaction audit and regression hardening.
//
// This file starts RED on the current code. Each failing assertion documents
// a concrete gap that Phase 273 will fix. After the fixes land, this file
// goes green without touching Phase 271 or Phase 272.
//
// Conventions match Phase 271 / Phase 272: PASS/FAIL counters, section banner,
// unique sentinel values. Imports the real implementation; no mocks.

import assert from "node:assert/strict";
import { redactSecrets } from "../src/core/secret-redaction";

let passed = 0, failed = 0;
function ok(c: boolean, m: string) {
  if (c) { passed++; console.log("PASS  " + m); }
  else { failed++; console.log("FAIL  " + m); }
}
function section(t: string) { console.log("\n--- " + t + " ---"); }
function sentinel(prefix: string): string {
  return `P273_${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function main() {
  console.log("=== Phase 273 — End-to-End Redaction ===\n");

  // 273-1: redactSecrets catches GitHub tokens in free text (baseline).
  // The *executor-local sanitize* gap is documented in the report; Fix 1
  // makes executors delegate to redactSecrets. This assertion proves the
  // target behavior that Fix 1 relies on.
  section("273-1 redactSecrets catches ghp_ tokens in free text");
  {
    const token = "ghp_" + sentinel("GITHUB").padEnd(24, "x");
    const text = `build output: token=${token}`;
    const redacted = redactSecrets(text);
    ok(!redacted.includes(token),
       "273-1 ghp_ token must not survive redaction, got=" + JSON.stringify(redacted));
    ok(redacted.includes("[REDACTED:github_token]"),
       "273-1 ghp_ redaction uses [REDACTED:github_token], got=" + JSON.stringify(redacted));
  }

  // 273-2: redactSecrets(Error) must not return {} and must redact message.
  section("273-2 Error instance handling");
  {
    const token = "ghp_" + sentinel("ERRTOK").padEnd(24, "x");
    const err = new Error(`connect failed: token=${token} on db`);
    const redacted = redactSecrets(err) as any;
    ok(redacted !== undefined && redacted !== null,
       "273-2 redactSecrets(Error) must not return null/undefined");
    ok(typeof redacted === "object",
       "273-2 redactSecrets(Error) must return object");
    ok(!JSON.stringify(redacted).includes(token),
       "273-2 Error's serialized form must not contain raw token");
    ok(typeof redacted.message === "string",
       "273-2 redacted Error must preserve .message, got=" + JSON.stringify(redacted));
  }

  // 273-3: cyclic objects must not throw RangeError.
  section("273-3 cyclic object safety");
  {
    const a: any = { name: "root" };
    const b: any = { name: "child", parent: a };
    a.child = b;
    let threw: any = null;
    let result: any = null;
    try { result = redactSecrets(a); } catch (e) { threw = e; }
    ok(threw === null, "273-3 cyclic object must not throw, got=" + (threw && threw.message));
    ok(result !== null, "273-3 cyclic object must return value");
    if (result !== null) {
      const serialized = JSON.stringify(result);
      ok(serialized.includes("[REDACTED:cycle]"),
         "273-3 self-reference becomes [REDACTED:cycle], got=" + serialized);
    }
  }

  // 273-4: non-secret metadata with sensitive substrings must survive.
  section("273-4 non-secret metadata preservation");
  {
    const input = {
      session_started_at: 12345,
      authorization_level: "admin",
      token_count: 7,
      token: "must-be-redacted",
      password: "must-be-redacted",
    };
    const redacted = redactSecrets(input) as any;
    ok(redacted.session_started_at === 12345,
       "273-4 session_started_at survives, got=" + JSON.stringify(redacted.session_started_at));
    ok(redacted.authorization_level === "admin",
       "273-4 authorization_level survives, got=" + JSON.stringify(redacted.authorization_level));
    ok(redacted.token_count === 7,
       "273-4 token_count survives, got=" + JSON.stringify(redacted.token_count));
    ok(redacted.token === "[REDACTED]",
       "273-4 plain token redacted, got=" + JSON.stringify(redacted.token));
    ok(redacted.password === "[REDACTED]",
       "273-4 password redacted, got=" + JSON.stringify(redacted.password));
  }

  // 273-5: Phase 271 regression — password redaction.
  section("273-5 Phase 271 regression");
  {
    const redacted = redactSecrets({ password: "supersecret", user: "alice" }) as any;
    ok(redacted.password === "[REDACTED]", "273-5 password still [REDACTED]");
    ok(redacted.user === "alice", "273-5 user still preserved");
  }

  // 273-6: Phase 272 regression — URL credentials.
  section("273-6 Phase 272 regression — URL credentials");
  {
    const text = "Connection failed: postgres://user:secretpw@db.example.test/nexus";
    const redacted = redactSecrets(text) as string;
    assert.ok(typeof redacted === "string");
    ok(!redacted.includes("secretpw"), "273-6 password must not survive");
    ok(/postgres:\/\/\[REDACTED\]@db\.example\.test/.test(redacted),
       "273-6 preserves postgres://[REDACTED]@db.example.test/, got=" + JSON.stringify(redacted));
  }

  // 273-7: Phase 272 regression — nested evidence shape.
  section("273-7 Phase 272 regression — nested evidence shape");
  {
    const input = {
      metadata: { execution_id: "phase273-regression", duration_ms: 123 },
      config: {
        password: "pw",
        nested: { access_token: "tk" },
        connectionString: "postgres://u:p@h/db",
      },
    };
    const redacted = redactSecrets(input) as any;
    ok(redacted.metadata.execution_id === "phase273-regression", "273-7 execution_id preserved");
    ok(redacted.metadata.duration_ms === 123, "273-7 duration_ms preserved");
    ok(redacted.config.password === "[REDACTED]", "273-7 password redacted");
    ok(redacted.config.nested.access_token === "[REDACTED]", "273-7 access_token redacted");
    ok(redacted.config.connectionString === "[REDACTED]", "273-7 connectionString redacted");
  }

  console.log("\n============================================");
  console.log("PASS: " + passed);
  console.log("FAIL: " + failed);
  console.log("============================================");
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((e) => {
  console.error("Phase 273 harness failure:", e);
  process.exitCode = 1;
});