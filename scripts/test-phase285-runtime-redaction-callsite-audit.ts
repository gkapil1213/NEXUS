// scripts/test-phase285-runtime-redaction-callsite-audit.ts
//
// Phase 285 — runtime redaction call-site audit.
//
// Section 1 — emitServerEvent: nested objects, arrays, and sensitive
//   metadata keys must not reach stdout.
// Section 2 — emitAccessLog direct call: credential-shaped values in a
//   passed-in path must be scrubbed by clip()/redactText().
// Section 3 — real HTTP boundary via createHttpApp: the access-log
//   middleware must not record query strings.
// Section 4 — redactText: short credential values, punctuation
//   preservation, quoted/unquoted values, safe suffixes, idempotence.
//
// Synthetic sentinels only. No live credentials.
//
// Assertion accounting: `check(cond, label)` increments `passed` or
// `failed` and records failures. The test does not throw on the first
// failure; it accumulates and reports the actual totals. Exit code is
// 1 whenever `failed > 0`.

import { emitServerEvent, emitAccessLog } from "../src/server/logging";
import { createHttpApp } from "../src/server/http";
import { redactText } from "../src/core/audit";

// ---------------------------------------------------------------------------
// Assertion counter
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(condition: boolean, label: string): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(label);
    console.error("  FAIL " + label);
  }
}

// ---------------------------------------------------------------------------
// stdout capture helper
// ---------------------------------------------------------------------------

interface CapturedOutput {
  chunks: string[];
  restore: () => void;
}

function captureStdout(): CapturedOutput {
  const chunks: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: unknown, ...args: unknown[]) => {
    chunks.push(
      typeof chunk === "string"
        ? chunk
        : Buffer.isBuffer(chunk)
          ? chunk.toString("utf8")
          : String(chunk),
    );
    const callback = args.find((arg) => typeof arg === "function");
    if (callback) (callback as () => void)();
    return true;
  }) as typeof process.stdout.write;
  return {
    chunks,
    restore: () => { process.stdout.write = original; },
  };
}

async function main(): Promise<void> {
  // =========================================================================
  // Section 1 — emitServerEvent: nested values must not reach stdout
  // =========================================================================

  const nestedSentinel = "NEXUS_PHASE285_NESTED_SECRET_7c91e2";
  const directSentinel = "Bearer NEXUS_PHASE285_DIRECT_TOKEN_1234567890";

  {
    const capture = captureStdout();
    try {
      emitServerEvent("phase285_redaction_probe", {
        direct: directSentinel,
        nested: { password: nestedSentinel },
        items: [{ authorization: nestedSentinel }],
      });
    } finally {
      capture.restore();
    }
    const line = capture.chunks.join("");

    check(line.length > 0, "logger should write an event");
    check(
      !line.includes("NEXUS_PHASE285_DIRECT_TOKEN_1234567890"),
      "direct string credentials should be redacted",
    );
    check(
      !line.includes(nestedSentinel),
      "nested secret values must not reach stdout",
    );
    check(
      !/"password"\s*:/.test(line),
      "sensitive metadata keys must not reach stdout",
    );
    check(
      !/"authorization"\s*:/.test(line),
      "authorization metadata keys must not reach stdout",
    );
  }

  // =========================================================================
  // Section 2 — emitAccessLog direct call with long (>=12-char) credentials
  // =========================================================================

  const longToken = "ghp_" + "A".repeat(20);
  const longApiKey = "sk-proj-" + "B".repeat(20);

  {
    const capture = captureStdout();
    try {
      emitAccessLog({
        rid: "req-phase285-direct",
        method: "GET",
        path: "/health?token=" + longToken + "&api_key=" + longApiKey,
        status: 200,
        ms: 5,
        principal: "tester@nexus.test",
        code: null,
      });
    } finally {
      capture.restore();
    }
    const line = capture.chunks.join("");

    check(line.length > 0, "emitAccessLog should write a line");
    check(
      !line.includes(longToken),
      "long GitHub token must be scrubbed from access log path",
    );
    check(
      !line.includes(longApiKey),
      "long sk- provider key must be scrubbed from access log path",
    );
    check(line.includes("/health"), "path prefix must be preserved");
    check(line.includes("req-phase285-direct"), "request id must be preserved");
  }

  // =========================================================================
  // Section 3 — real HTTP boundary via createHttpApp with accessLog: true
  // =========================================================================

  const shortApiKey = "KEYSHORT";
  const shortAccess = "ACCSHORT";
  const shortPassword = "PWSHORT";
  const shortAuth = "AUTHSHORT";

  {
    const app = createHttpApp({
      services: {} as any,
      idempotency: {} as any,
      accessLog: true,
    });

    const server: any = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });

    const capture = captureStdout();
    try {
      const port = (server.address() as any).port;
      const query =
        "api_key=" + shortApiKey +
        "&access_token=" + shortAccess +
        "&password=" + shortPassword +
        "&authorization=" + shortAuth;
      const url = "http://127.0.0.1:" + port + "/health?" + query;
      const res = await fetch(url);
      check(res.status === 200, "health should return 200");
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      capture.restore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    const lines = capture.chunks;
    const accessLine = lines.find((l) => l.includes("\"kind\":\"http.access\""));
    check(accessLine !== undefined, "an access log line should be emitted");
    const line = accessLine as string;

    check(
      !line.includes(shortApiKey),
      "short api_key credential must not reach access log stdout",
    );
    check(
      !line.includes(shortAccess),
      "short access_token credential must not reach access log stdout",
    );
    check(
      !line.includes(shortPassword),
      "short password credential must not reach access log stdout",
    );
    check(
      !line.includes(shortAuth),
      "short authorization credential must not reach access log stdout",
    );
    check(!line.includes("?"), "access log path must not contain a query string");
    check(line.includes("/health"), "access log must contain the pathname");
    check(line.includes("\"method\":\"GET\""), "access log must contain the HTTP method");
    check(line.includes("\"status\":200"), "access log must contain the status code");
    const msMatch = line.match(/"ms":(\d+)/);
    check(
      msMatch !== null && Number(msMatch[1]) >= 0,
      "access log must contain a nonnegative duration",
    );
  }

  // =========================================================================
  // Section 4 — redactText: short credentials, punctuation, safe suffixes
  // =========================================================================

  // 4a — the four original short-credential inputs
  {
    const shortCases: Array<[string, string]> = [
      ["token=ABC123", "ABC123"],
      ["password=PW123", "PW123"],
      ["api_key=KEYSHORT", "KEYSHORT"],
      ["startup failed: connection string token=ABC123", "ABC123"],
    ];
    for (const [input, secret] of shortCases) {
      const out = redactText(input);
      check(!out.includes(secret), "4a secret absent: " + input);
      check(
        out.includes("[REDACTED:embedded credential]"),
        "4a marker present: " + input,
      );
    }
  }

  // 4b — one- and two-character values
  {
    for (const input of ["token=A", "token=AB"]) {
      const out = redactText(input);
      check(
        out.includes("[REDACTED:embedded credential]"),
        "4b short value redacted: " + input,
      );
      check(
        !out.includes("=A") && !out.includes("=AB"),
        "4b value absent: " + input,
      );
    }
  }

  // 4c — quoted values
  {
    const quotedCases: Array<[string, string]> = [
      ["token='single-quoted'", "single-quoted"],
      ['token="double-quoted"', "double-quoted"],
    ];
    for (const [input, secret] of quotedCases) {
      const out = redactText(input);
      check(!out.includes(secret), "4c quoted value redacted: " + input);
    }
  }

  // 4d — alternate delimiters and whitespace
  {
    const delimCases: Array<[string, string]> = [
      ["api-key: colon-value", "colon-value"],
      ["password = spaced-value", "spaced-value"],
    ];
    for (const [input, secret] of delimCases) {
      const out = redactText(input);
      check(!out.includes(secret), "4d delimiter redaction: " + input);
    }
  }

  // 4e — multiple credentials in one message
  {
    const input = "token=ABC123 password=DEF456 api_key=GHI789";
    const out = redactText(input);
    check(!out.includes("ABC123"), "4e first credential absent");
    check(!out.includes("DEF456"), "4e second credential absent");
    check(!out.includes("GHI789"), "4e third credential absent");
  }

  // 4f — punctuation preservation
  {
    const cases: Array<{ input: string; open: string; close: string }> = [
      { input: "error: (token=ABC123)", open: "(", close: ")" },
      { input: "error: [token=ABC123]", open: "[", close: "]" },
      { input: "error: {token=ABC123}", open: "{", close: "}" },
    ];
    for (const { input, open, close } of cases) {
      const out = redactText(input);
      check(!out.includes("ABC123"), "4f credential redacted: " + input);
      check(out.includes(open), "4f opening bracket preserved: " + input);
      check(out.includes(close), "4f closing bracket preserved: " + input);
      check(
        out.includes("[REDACTED:embedded credential]"),
        "4f marker present: " + input,
      );
    }
  }

  // 4f2 — trailing-period preservation
  {
    const periodCases: Array<{ input: string; expected: string }> = [
      {
        // Trailing-period preservation: the credential value ends before
        // the `.`, so the period remains in the output. Internal periods
        // (`token=AB.C123`) are still consumed as part of the value.
        input: "error: token=ABC123.",
        expected: "error: [REDACTED:embedded credential].",
      },
      {
        input: "error: token=ABC123,",
        expected: "error: [REDACTED:embedded credential],",
      },
      {
        input: "error: token=ABC123;",
        expected: "error: [REDACTED:embedded credential];",
      },
      // A lone `]` without an opening bracket is consumed; paired brackets
      // around the credential remain preserved (see Section 4f).
      {
        input: "error: token=ABC123]",
        expected: "error: [REDACTED:embedded credential]",
      },
      {
        input: "token=ABC123] token=DEF456]",
        expected: "[REDACTED:embedded credential] [REDACTED:embedded credential]",
      },
      {
        input: "plain token=ABC123 end",
        expected: "plain [REDACTED:embedded credential] end",
      },
    ];
    for (const { input, expected } of periodCases) {
      const out = redactText(input);
      check(out === expected, "4f2 exact match: " + input);
    }
  }

  // 4g — safe suffix and no-delimiter benign cases must be unchanged
  {
    const benign = [
      "token_count=42",
      "password_length=8",
      "authorization_level=admin",
      "the token is set",
      "a password error occurred",
    ];
    for (const input of benign) {
      const out = redactText(input);
      check(out === input, "4g benign text unchanged: " + input);
    }
  }

  // 4h — GitHub token marker preservation
  {
    const ghp = "ghp_" + "A".repeat(20);
    const input = "token=" + ghp;
    const out = redactText(input);
    check(!out.includes(ghp), "4h ghp token absent");
    check(
      out.includes("[REDACTED:github token]"),
      "4h specific marker preserved: " + out,
    );
    check(
      !out.includes("[REDACTED:embedded credential]"),
      "4h generic marker did not override specific",
    );
  }

  // 4i — idempotence
  {
    const once = redactText("token=ABC123");
    const twice = redactText(once);
    check(once === twice, "4i repeated redaction is idempotent");
  }

  // 4j — empty assignment must not crash or over-redact
  {
    const out = redactText("token=");
    check(out === "token=", "4j empty assignment unchanged");
  }

  // 4k — nested metadata and sensitive object keys (audit normalizer)
  {
    const { redactMetadata } = await import("../src/core/audit");
    const payload = {
      safe: "visible",
      password: "should-be-dropped",
      nested: { token: "should-be-dropped" },
    };
    const out = redactMetadata(payload) as Record<string, unknown>;
    check(!("password" in out), "4k sensitive key dropped");
    const j = JSON.stringify(out);
    check(!j.includes("should-be-dropped"), "4k sensitive value absent");
    check(j.includes("visible"), "4k safe field preserved");
  }

  // =========================================================================
  // Summary
  // =========================================================================
  const total = passed + failed;
  if (failed === 0) {
    console.log("");
    console.log("Phase 285 runtime redaction call-site audit: PASS");
    console.log("Assertions: " + total + "; passed: " + passed + "; failures: 0");
  } else {
    console.log("");
    console.log("Phase 285 runtime redaction call-site audit: FAIL");
    console.log("Assertions: " + total + "; passed: " + passed + "; failures: " + failed);
    console.log("Failed assertions:");
    for (const f of failures) {
      console.log("  - " + f);
    }
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("Phase 285 runtime redaction call-site audit: UNEXPECTED ERROR");
  console.error((e as Error).message);
  console.error((e as Error).stack);
  process.exitCode = 1;
});
