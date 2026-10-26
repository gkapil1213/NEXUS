import { redactSecrets } from "../src/core/secret-redaction";
import { redactMetadata } from "../src/core/audit";

let passed = 0;
let failed = 0;

function ok(condition: boolean, label: string): void {
  if (condition) {
    passed++;
    console.log("PASS " + label);
  } else {
    failed++;
    console.log("FAIL " + label);
  }
}

function section(label: string): void {
  console.log("\n--- " + label + " ---");
}

function main(): void {
  section("283-1 shared redactor does not execute getters");
  {
    let getterCalls = 0;
    const input = Object.defineProperties({}, {
      safe: { enumerable: true, value: "preserved" },
      computed: {
        enumerable: true,
        get() {
          getterCalls++;
          return "getter-secret-value";
        },
      },
    });

    const output = redactSecrets(input) as Record<string, unknown>;
    ok(getterCalls === 0, "283-1 getter invocation count is zero");
    ok(output.safe === "preserved", "283-1 ordinary data property preserved");
    ok(
      !JSON.stringify(output).includes("getter-secret-value"),
      "283-1 getter return value absent"
    );
  }

  section("283-2 shared redactor does not execute sensitive getters");
  {
    let getterCalls = 0;
    const input = Object.defineProperty({}, "password", {
      enumerable: true,
      get() {
        getterCalls++;
        return "sensitive-getter-value";
      },
    });

    const output = redactSecrets(input) as Record<string, unknown>;
    ok(getterCalls === 0, "283-2 sensitive getter invocation count is zero");
    ok(output.password === "[REDACTED]", "283-2 sensitive marker preserved");
  }

  section("283-3 audit normalizer does not execute array index getters");
  {
    let getterCalls = 0;
    const input: unknown[] = ["safe"];
    Object.defineProperty(input, "1", {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls++;
        return "array-getter-secret";
      },
    });
    input.length = 2;

    const output = redactMetadata(input) as unknown[];
    ok(getterCalls === 0, "283-3 array getter invocation count is zero");
    ok(output[0] === "safe", "283-3 ordinary array element preserved");
    ok(
      !JSON.stringify(output).includes("array-getter-secret"),
      "283-3 array getter return value absent"
    );
  }

  section("283-4 audit normalizer omits non-enumerable accessors");
  {
    let getterCalls = 0;
    const input = Object.defineProperty({}, "hidden", {
      enumerable: false,
      get() {
        getterCalls++;
        return "hidden-secret";
      },
    });

    const output = redactMetadata(input) as Record<string, unknown>;
    ok(getterCalls === 0, "283-4 hidden getter invocation count is zero");
    ok(!("hidden" in output), "283-4 non-enumerable accessor omitted");
  }

  section("283-5 shared redactor does not execute Error field getters");
  {
    let getterCalls = 0;
    const error = new Error("fallback");

    for (const key of ["name", "message", "stack"] as const) {
      Object.defineProperty(error, key, {
        configurable: true,
        enumerable: false,
        get() {
          getterCalls++;
          return "error-getter-secret";
        },
      });
    }

    const output = redactSecrets(error) as Record<string, unknown>;
    const serialized = JSON.stringify(output);

    ok(getterCalls === 0, "283-5 Error getters were never invoked");
    ok(output.name === "[getter]", "283-5 name accessor safely marked");
    ok(output.message === "[getter]", "283-5 message accessor safely marked");
    ok(output.stack === "[getter]", "283-5 stack accessor safely marked");
    ok(
      !serialized.includes("error-getter-secret"),
      "283-5 Error getter secrets absent"
    );
  }
  console.log("\n============================================");
  console.log("PASS: " + passed);
  console.log("FAIL: " + failed);
  console.log("============================================");
  process.exitCode = failed > 0 ? 1 : 0;
}

main();
