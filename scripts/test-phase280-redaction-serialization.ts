// Phase 280 — Redaction Metadata Serialization Regression
//
// Exercises the production redactMetadata() function with synthetic data.
// Reports assertion labels only; never prints canary values.

import { redactMetadata } from "../src/core/audit";

let passed = 0;
let failed = 0;

function check(condition: boolean, label: string): void {
  if (condition) {
    passed++;
    console.log(`PASS  ${label}`);
  } else {
    failed++;
    console.log(`FAIL  ${label}`);
  }
}

function serializes(value: unknown): boolean {
  try {
    return JSON.stringify(value) !== undefined;
  } catch {
    return false;
  }
}

function main(): void {
  console.log("=== Phase 280: metadata serialization regression ===");

  // BigInt must be converted before JSON serialization.
  const bigintResult = redactMetadata({ count: 123n }) as Record<string, unknown>;
  check(bigintResult.count === "123", "280-1 BigInt converted to decimal string");
  check(serializes(bigintResult), "280-2 BigInt metadata is JSON-serializable");

  // Sensitive keys must be removed, including nested keys.
  const nestedResult = redactMetadata({
    details: {
      api_key: "CANARY_SECRET_PHASE280",
      label: "safe-value",
    },
  });
  const nestedJson = JSON.stringify(nestedResult);
  check(!nestedJson.includes("CANARY_SECRET_PHASE280"), "280-3 nested sensitive value absent");
  check(nestedJson.includes("safe-value"), "280-4 unrelated metadata preserved");

  // Secret-like strings must be redacted by the production implementation.
  const textResult = JSON.stringify(
    redactMetadata({ note: "synthetic sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ" }),
  );
  check(
    !textResult.includes("sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ"),
    "280-5 secret-like string absent after redaction",
  );

  // Cyclic input must terminate at the depth limit and remain serializable.
  const cyclic: Record<string, unknown> = { label: "cycle-safe" };
  cyclic.self = cyclic;
  const cycleResult = redactMetadata(cyclic);
  const cycleJson = JSON.stringify(cycleResult);
  check(cycleJson.includes("[truncated]"), "280-6 cyclic input reaches depth truncation");
  check(serializes(cycleResult), "280-7 cyclic input result is JSON-serializable");

  // These currently lose their contents because Object.entries() sees no
  // enumerable string keys on Map/Set. Verify behavior without claiming
  // this is credential-leak protection or preserving their contents.
  const mapResult = redactMetadata(
    new Map([["label", "map-value"], ["api_key", "CANARY_SECRET_PHASE280"]]),
  );
  const setResult = redactMetadata(new Set(["set-value", "CANARY_SECRET_PHASE280"]));
  check(serializes(mapResult), "280-8 Map result is JSON-serializable");
  check(serializes(setResult), "280-9 Set result is JSON-serializable");

  // JSON.stringify omits symbol-valued object properties.
  const symbolResult = redactMetadata({ label: Symbol("safe-symbol") });
  check(serializes(symbolResult), "280-10 symbol-valued metadata is JSON-serializable");

  // The input graph should not be mutated by redaction.
  const original = { details: { label: "unchanged" } };
  redactMetadata(original);
  check(original.details.label === "unchanged", "280-11 input object remains unchanged");

  console.log(`\nPhase 280 result: PASS=${passed} FAIL=${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main();
