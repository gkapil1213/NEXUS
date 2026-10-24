// scripts/test-phase282-audit-metadata-security.ts
//
// Phase 282 - audit metadata security hardening regression.
//
// Closes two confirmed findings from the Phase 281 review:
//   A. String Map keys bypassed isSensitiveKey, letting values under
//      sensitive-looking keys (api_key, password, session_token) survive
//      redaction if they did not match a SECRET_PATTERNS regex.
//   B. Object.entries() invoked getters during redaction, allowing
//      side-effecting or throwing getters to leak or crash audit writes.
//
// This suite exercises the real redactMetadata implementation.
// Canary strings only. No real credentials.

import { redactMetadata } from "../src/core/audit";

let passed = 0;
let failed = 0;

function ok(c: boolean, m: string) {
  if (c) { passed++; console.log("PASS  " + m); }
  else { failed++; console.log("FAIL  " + m); }
}
function section(t: string) { console.log("\n--- " + t + " ---"); }
function serializes(v: unknown): boolean {
  try { JSON.stringify(v); return true; } catch { return false; }
}

const CANARY_SK = "sk-proj-" + "C".repeat(24);
const CANARY_PASS = "CANARY_PASS_" + "D".repeat(12);

function main() {
  console.log("=== Phase 282 - audit metadata security hardening ===\n");

  section("282-1 Sensitive Map keys are dropped");
  {
    const m = new Map<string, string>([
      ["api_key", "harmless-looking-value"],
      ["password", "not-a-pattern-match"],
      ["session_token", "opaque-blob"],
      ["safe_key", "visible"],
    ]);
    const out = redactMetadata(m) as any;
    ok(Array.isArray(out.$map), "282-1 $map present");
    ok(out.$map.length === 1, "282-1 only safe_key survives");
    ok(out.$map[0][0] === "safe_key" && out.$map[0][1] === "visible", "282-1 safe entry preserved");
    const j = JSON.stringify(out);
    ok(!j.includes("harmless-looking-value"), "282-1 api_key value absent");
    ok(!j.includes("not-a-pattern-match"), "282-1 password value absent");
    ok(!j.includes("opaque-blob"), "282-1 session_token value absent");
  }

  section("282-2 Sensitive Map values are redacted by pattern");
  {
    const m = new Map<string, string>([["log", "using " + CANARY_SK]]);
    const out = redactMetadata(m) as any;
    const j = JSON.stringify(out);
    ok(!j.includes(CANARY_SK), "282-2 sk-proj absent from Map value");
    ok(j.includes("[REDACTED"), "282-2 redaction marker present");
  }

  section("282-3 Nested Map inside Map still filters sensitive inner keys");
  {
    const inner = new Map<string, string>([["api_key", "secret"] ,["safe", "visible"]]);
    const outer = new Map<string, unknown>([["inner", inner]]);
    const out = redactMetadata(outer) as any;
    const j = JSON.stringify(out);
    ok(!j.includes("secret"), "282-3 inner sensitive value absent");
    ok(j.includes("visible"), "282-3 inner safe value preserved");
  }

  section("282-4 Getter is never invoked");
  {
    let invoked = 0;
    const obj: any = { plain: "value" };
    Object.defineProperty(obj, "computed", {
      get() { invoked++; return "should-not-appear"; },
      enumerable: true,
      configurable: true,
    });
    const out = redactMetadata(obj) as any;
    ok(invoked === 0, "282-4 getter call count is 0 (got " + invoked + ")");
    ok(out.plain === "value", "282-4 plain property preserved");
    ok(out.computed === "[getter]", "282-4 accessor replaced with marker");
    ok(!JSON.stringify(out).includes("should-not-appear"), "282-4 getter return absent");
  }

  section("282-5 Throwing getter does not break normalization");
  {
    const obj: any = { safe: "visible" };
    Object.defineProperty(obj, "boom", {
      get() { throw new Error("never-call-me"); },
      enumerable: true,
      configurable: true,
    });
    let threw = false;
    let out: any;
    try { out = redactMetadata(obj); } catch { threw = true; }
    ok(!threw, "282-5 throwing getter did not propagate");
    ok(out.safe === "visible", "282-5 plain field survived");
    ok(out.boom === "[getter]", "282-5 throwing accessor marker present");
  }

  section("282-6 Sensitive accessor key is dropped entirely");
  {
    const obj: any = { safe: "visible" };
    Object.defineProperty(obj, "password", {
      get() { return "secret-value"; },
      enumerable: true,
      configurable: true,
    });
    const out = redactMetadata(obj) as any;
    ok(!("password" in out), "282-6 sensitive accessor key absent");
    ok(out.safe === "visible", "282-6 safe field preserved");
  }

  section("282-7 toJSON is never invoked");
  {
    let toJsonCalls = 0;
    const obj: any = {
      plain: "value",
      toJSON() { toJsonCalls++; return "should-not-invoke"; },
    };
    const out = redactMetadata(obj) as any;
    ok(toJsonCalls === 0, "282-7 toJSON call count is 0 (got " + toJsonCalls + ")");
    ok(out.plain === "value", "282-7 plain field preserved");
    ok(out.toJSON === "[function]", "282-7 function field replaced");
    ok(!JSON.stringify(out).includes("should-not-invoke"), "282-7 toJSON return absent");
  }

  section("282-8 Undefined object-property policy");
  {
    const out = redactMetadata({ a: 1, u: undefined }) as any;
    ok(out.a === 1, "282-8 defined field preserved");
    ok("u" in out, "282-8 undefined field present in output object");
    ok(out.u === undefined, "282-8 undefined field value is undefined");
  }

  section("282-9 Undefined array-element policy");
  {
    const out = redactMetadata([1, undefined, 3]) as any;
    ok(Array.isArray(out) && out.length === 3, "282-9 array length preserved");
    ok(out[0] === 1 && out[2] === 3, "282-9 defined slots preserved");
    ok(out[1] === undefined, "282-9 undefined slot preserved as undefined");
  }

  section("282-10 BigInt and non-finite numbers");
  {
    const out = redactMetadata({
      big: 42n, nan: NaN, inf: Infinity, ninf: -Infinity, finite: 3.14,
    }) as any;
    ok(out.big === "42", "282-10 bigint -> string");
    ok(out.nan === "NaN", "282-10 NaN -> string");
    ok(out.inf === "Infinity", "282-10 +Inf -> string");
    ok(out.ninf === "-Infinity", "282-10 -Inf -> string");
    ok(out.finite === 3.14, "282-10 finite preserved");
    ok(serializes(out), "282-10 serializes");
  }

  section("282-11 Valid and invalid Date");
  {
    const d = new Date("2026-01-15T00:00:00.000Z");
    const out = redactMetadata({ d }) as any;
    ok(out.d === "2026-01-15T00:00:00.000Z", "282-11 valid date -> ISO");

    const bad = new Date("nope");
    const out2 = redactMetadata({ d: bad }) as any;
    ok(out2.d === "[Invalid Date]", "282-11 invalid date -> marker");
    ok(serializes(out2), "282-11 invalid date serializes");
  }

  section("282-12 Map key normalization collisions preserved");
  {
    const d1 = new Date("2026-01-01T00:00:00.000Z");
    const d2 = new Date("2026-01-01T00:00:00.000Z");
    const m = new Map([[d1, "first"], [d2, "second"]]);
    const out = redactMetadata(m) as any;
    ok(out.$map.length === 2, "282-12 both entries preserved");
    ok(out.$map.some((e: any) => e[1] === "first"), "282-12 first value");
    ok(out.$map.some((e: any) => e[1] === "second"), "282-12 second value");
  }

  section("282-13 Set values that normalize identically are preserved");
  {
    const d1 = new Date("2026-01-01T00:00:00.000Z");
    const d2 = new Date("2026-01-01T00:00:00.000Z");
    const s = new Set([d1, d2]);
    const out = redactMetadata(s) as any;
    ok(out.$set.length === 2, "282-13 both elements preserved");
    ok(out.$set.every((v: any) => v === "2026-01-01T00:00:00.000Z"), "282-13 both normalized");
  }

  section("282-14 Deterministic output for equivalent collection contents");
  {
    const m1 = new Map([["a", 1], ["b", 2]]);
    const m2 = new Map([["a", 1], ["b", 2]]);
    const out1 = JSON.stringify(redactMetadata(m1));
    const out2 = JSON.stringify(redactMetadata(m2));
    ok(out1 === out2, "282-14 equivalent Maps produce identical output");
  }

  section("282-15 Self-cyclic object terminates");
  {
    const obj: any = { name: "root" };
    obj.self = obj;
    const out = redactMetadata(obj);
    ok(serializes(out), "282-15 serializes");
    ok(JSON.stringify(out).includes("[truncated]"), "282-15 depth truncation");
  }

  section("282-16 Mutually cyclic objects terminate");
  {
    const a: any = { name: "a" };
    const b: any = { name: "b", other: a };
    a.other = b;
    ok(serializes(redactMetadata(a)), "282-16 serializes");
  }

  section("282-17 Cyclic array terminates");
  {
    const arr: any[] = [1, 2];
    arr.push(arr);
    ok(serializes(redactMetadata(arr)), "282-17 serializes");
  }

  section("282-18 Cyclic Map terminates");
  {
    const m: Map<string, unknown> = new Map();
    m.set("self", m);
    ok(serializes(redactMetadata(m)), "282-18 serializes");
  }

  section("282-19 Cyclic Set terminates");
  {
    const s: Set<unknown> = new Set();
    s.add(s);
    ok(serializes(redactMetadata(s)), "282-19 serializes");
  }

  section("282-20 Repeated acyclic references preserved independently");
  {
    const shared = { name: "shared" };
    const out = redactMetadata({ a: shared, b: shared }) as any;
    ok(out.a.name === "shared" && out.b.name === "shared", "282-20 both branches preserved");
    ok(out.a !== out.b, "282-20 distinct output nodes (documented policy)");
  }

  section("282-21 Depth-boundary behavior");
  {
    let deep: any = { v: "leaf" };
    for (let i = 0; i < 20; i++) deep = { v: "level" + i, next: deep };
    ok(JSON.stringify(redactMetadata(deep)).includes("[truncated]"), "282-21 depth > 10 truncates");
  }

  section("282-22 Unsupported class instance policy");
  {
    class Custom { field = "value"; method() { return 1; } }
    const out = redactMetadata(new Custom()) as any;
    ok(out.$class === "Custom", "282-22 $class marker");
    ok(out.field === "value", "282-22 field preserved");
    ok(!("method" in out), "282-22 method omitted (non-own)");
  }

  section("282-23 Error instance behavior");
  {
    const err = new Error("boom");
    const out = redactMetadata({ e: err }) as any;
    ok(out.e !== undefined, "282-23 error field present");
    ok(typeof out.e === "object", "282-23 error normalized to object");
    ok(out.e.$class === "Error" || out.e.name === "Error", "282-23 Error identifiable");
    ok(serializes(out), "282-23 serializes");
  }

  section("282-24 Symbol and function policy");
  {
    const out = redactMetadata({ s: Symbol("x"), f: () => 1 }) as any;
    ok(out.s === "[symbol]", "282-24 symbol -> marker");
    ok(out.f === "[function]", "282-24 function -> marker");
  }

  section("282-25 Secret canaries absent from normalized output");
  {
    const out = redactMetadata({
      note: "token " + CANARY_SK,
      m: new Map([["log", CANARY_SK]]),
      s: new Set([CANARY_SK]),
      nested: { api_key: CANARY_PASS, safe: "visible" },
    });
    const j = JSON.stringify(out);
    ok(!j.includes(CANARY_SK), "282-25 sk-proj absent");
    ok(!j.includes(CANARY_PASS), "282-25 password absent");
    ok(j.includes("visible"), "282-25 safe preserved");
  }

  section("282-26 Caller-owned input remains unchanged");
  {
    const map = new Map([["k", "v"]]);
    const set = new Set([1, 2]);
    const obj = { a: map, b: set, c: { d: "e" } };
    const mapSize = map.size;
    const setSize = set.size;
    const objKeys = JSON.stringify(Object.keys(obj));
    redactMetadata(obj);
    ok(map.size === mapSize, "282-26 map size unchanged");
    ok(set.size === setSize, "282-26 set size unchanged");
    ok(JSON.stringify(Object.keys(obj)) === objKeys, "282-26 obj keys unchanged");
    ok(map.get("k") === "v", "282-26 map entry unchanged");
  }

  section("282-27 Ordinary JSON-compatible metadata remains compatible");
  {
    const out = redactMetadata({
      s: "plain", n: 42, b: true, z: null,
      arr: [1, "two"], obj: { a: 1 },
    }) as any;
    ok(out.s === "plain" && out.n === 42 && out.b === true && out.z === null, "282-27 scalars");
    ok(JSON.stringify(out.arr) === "[1,\"two\"]", "282-27 array");
    ok(JSON.stringify(out.obj) === "{\"a\":1}", "282-27 object");
  }

  section("282-28 JSON.stringify succeeds for all documented outputs");
  {
    const inputs: unknown[] = [
      { a: 1 }, [1, 2], new Map([["k", "v"]]), new Set([1, 2]),
      new Date(), 42n, NaN, Infinity, -Infinity, Symbol("s"), () => 1,
      { nested: { deep: [1, { x: 2 }] } },
      new Map([["api_key", "x"]]), new Map([["safe", "y"]]),
    ];
    let allSerialize = true;
    for (const inp of inputs) {
      if (!serializes(redactMetadata(inp))) allSerialize = false;
    }
    ok(allSerialize, "282-28 all supported outputs serialize");
  }

  section("282-29 Regression: Phase 280 BigInt behavior");
  {
    const out = redactMetadata({ n: 42n }) as any;
    ok(out.n === "42", "282-29 bigint still decimal string");
    ok(serializes(out), "282-29 serializes");
  }

  section("282-30 Regression: Phase 278/279 secret boundaries");
  {
    const cases = [
      "prefix " + CANARY_SK,
      "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.SflKxwRJSMeKKF2QT4",
      "ghp_" + "E".repeat(20),
      "AKIA" + "C".repeat(16),
    ];
    for (const s of cases) {
      const out = redactMetadata({ field: s }) as any;
      ok(out.field !== s, "282-30 pattern redacted: " + s.slice(0, 20) + "...");
    }
  }

  section("282-31 Hostile proxy fails closed");
  {
    const hostile = new Proxy({}, {
      ownKeys() {
        throw new Error("hostile ownKeys");
      },
    });

    let threw = false;
    let out: unknown;

    try {
      out = redactMetadata(hostile);
    } catch {
      threw = true;
    }

    ok(!threw, "282-31 proxy error does not escape");
    ok(
      out === "[unavailable metadata]",
      "282-31 proxy produces unavailable marker",
    );
  }

  section("282-32 Own constructor getter is never invoked");
  {
    let invoked = 0;
    const obj: Record<string, unknown> = { safe: "visible" };

    Object.defineProperty(obj, "constructor", {
      get() {
        invoked++;
        throw new Error("constructor getter invoked");
      },
      enumerable: true,
      configurable: true,
    });

    const out = redactMetadata(obj) as Record<string, unknown>;

    ok(invoked === 0, "282-32 constructor getter call count is zero");
    ok(out.safe === "visible", "282-32 safe field preserved");
  }

  console.log("\n============================================");
  console.log("PASS: " + passed);
  console.log("FAIL: " + failed);
  console.log("============================================");
  process.exit(failed > 0 ? 1 : 0);
}

main();
