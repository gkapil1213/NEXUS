// scripts/test-phase281-audit-metadata-normalization.ts
//
// Phase 281 — audit metadata normalization regression.
//
// Phase 280 identified that Map and Set contents were silently lost because
// Object.entries() sees no enumerable string keys on those types. Related
// gaps: Date -> {}, NaN/+/-Infinity -> null (via JSON.stringify), Symbol and
// function values dropped, class instances recursed without identity.
//
// This suite exercises the real redactMetadata implementation. Canary
// strings only. No real credentials.

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
  console.log("=== Phase 281 — audit metadata normalization ===\n");

  section("281-1 Map contents survive normalization");
  {
    const m = new Map<string, string>([["alpha", "one"], ["beta", "two"]]);
    const out = redactMetadata(m) as any;
    ok(out.$map !== undefined, "281-1 $map marker present");
    ok(Array.isArray(out.$map) && out.$map.length === 2, "281-1 two entries preserved");
    ok(out.$map.some((e: [unknown, unknown]) => e[0] === "alpha" && e[1] === "one"), "281-1 alpha=one");
    ok(out.$map.some((e: [unknown, unknown]) => e[0] === "beta" && e[1] === "two"), "281-1 beta=two");
    ok(serializes(out), "281-1 serializes");
  }

  section("281-2 Nested Map values normalized");
  {
    const m = new Map([["outer", new Map([["inner", "value"]])]]);
    const out = redactMetadata(m) as any;
    ok(out.$map?.[0]?.[1]?.$map?.[0]?.[0] === "inner", "281-2 nested inner key");
    ok(out.$map?.[0]?.[1]?.$map?.[0]?.[1] === "value", "281-2 nested inner value");
    ok(serializes(out), "281-2 serializes");
  }

  section("281-3 Sensitive map values cannot bypass redaction");
  {
    const m = new Map<string, string>([["k", "prefix " + CANARY_SK + " suffix"], ["safe", "visible"]]);
    const out = redactMetadata(m) as any;
    const j = JSON.stringify(out);
    ok(!j.includes(CANARY_SK), "281-3 canary absent");
    ok(j.includes("visible"), "281-3 safe preserved");
  }

  section("281-4 Set elements survive normalization");
  {
    const s = new Set(["alpha", "beta"]);
    const out = redactMetadata(s) as any;
    ok(out.$set !== undefined, "281-4 $set marker present");
    ok(Array.isArray(out.$set) && out.$set.length === 2, "281-4 two elements");
    ok(out.$set.includes("alpha") && out.$set.includes("beta"), "281-4 elements present");
    ok(serializes(out), "281-4 serializes");
  }

  section("281-5 Secret-bearing Set elements redacted");
  {
    const s = new Set(["auth " + CANARY_SK, "plain"]);
    const out = redactMetadata(s) as any;
    const j = JSON.stringify(out);
    ok(!j.includes(CANARY_SK), "281-5 canary absent");
    ok(j.includes("plain"), "281-5 plain preserved");
  }

  section("281-6 Nested arrays and objects preserved");
  {
    const out = redactMetadata({ arr: [1, [2, 3]], obj: { x: 1 } }) as any;
    ok(JSON.stringify(out.arr) === "[1,[2,3]]", "281-6 nested array");
    ok(JSON.stringify(out.obj) === "{\"x\":1}", "281-6 nested object");
  }

  section("281-7 BigInt still decimal string");
  {
    const out = redactMetadata({ n: 42n }) as any;
    ok(out.n === "42", "281-7 bigint -> string");
    ok(serializes(out), "281-7 serializes");
  }

  section("281-8 Date deterministic including invalid");
  {
    const d = new Date("2026-01-15T00:00:00.000Z");
    ok((redactMetadata({ d }) as any).d === "2026-01-15T00:00:00.000Z", "281-8 valid -> ISO");

    const bad = new Date("not-a-date");
    const out2 = redactMetadata({ d: bad }) as any;
    ok(out2.d === "[Invalid Date]", "281-8 invalid -> marker");
    ok(serializes(out2), "281-8 invalid serializes");
  }

  section("281-9 undefined/symbol/function follow documented policy");
  {
    const out = redactMetadata({ u: undefined, s: Symbol("x"), f: () => 1 }) as any;
    ok(out.s === "[symbol]", "281-9 symbol -> marker");
    ok(out.f === "[function]", "281-9 function -> marker");
    ok(!("u" in out) || out.u === undefined, "281-9 undefined policy");
  }

  section("281-10 Non-finite numbers follow documented policy");
  {
    const out = redactMetadata({ nan: NaN, inf: Infinity, ninf: -Infinity, n: 42 }) as any;
    ok(out.nan === "NaN", "281-10 NaN -> string");
    ok(out.inf === "Infinity", "281-10 +Inf -> string");
    ok(out.ninf === "-Infinity", "281-10 -Inf -> string");
    ok(out.n === 42, "281-10 finite preserved");
  }

  section("281-11 Self-referential object terminates");
  {
    const obj: any = { name: "root" };
    obj.self = obj;
    const out = redactMetadata(obj);
    ok(serializes(out), "281-11 serializes");
    ok(JSON.stringify(out).includes("[truncated]"), "281-11 depth truncation");
  }

  section("281-12 Mutually cyclic objects terminate");
  {
    const a: any = { name: "a" };
    const b: any = { name: "b", other: a };
    a.other = b;
    ok(serializes(redactMetadata(a)), "281-12 serializes");
  }

  section("281-13 Cyclic array terminates");
  {
    const arr: any[] = [1, 2];
    arr.push(arr);
    ok(serializes(redactMetadata(arr)), "281-13 serializes");
  }

  section("281-14 Repeated acyclic references");
  {
    const shared = { name: "shared" };
    const out = redactMetadata({ a: shared, b: shared }) as any;
    ok(out.a.name === "shared" && out.b.name === "shared", "281-14 refs preserved");
    ok(serializes(out), "281-14 serializes");
  }

  section("281-15 Deeply nested respects depth");
  {
    let deep: any = { v: "leaf" };
    for (let i = 0; i < 20; i++) deep = { v: "level" + i, next: deep };
    ok(JSON.stringify(redactMetadata(deep)).includes("[truncated]"), "281-15 depth truncates");
  }

  section("281-16 Unsupported class instance policy");
  {
    class Custom { field = "value"; method() { return 1; } }
    const out = redactMetadata(new Custom()) as any;
    ok(out.$class === "Custom", "281-16 $class marker");
    ok(out.field === "value", "281-16 field preserved");
    ok(!("method" in out), "281-16 method omitted");
  }

  section("281-17 Normalization result serializes");
  {
    const inputs: unknown[] = [
      { a: 1 }, [1, 2], new Map([["k", "v"]]), new Set([1, 2]),
      new Date(), 42n, NaN, Infinity, -Infinity, Symbol("s"), () => 1,
      { nested: { deep: [1, { x: 2 }] } },
    ];
    for (const inp of inputs) {
      ok(serializes(redactMetadata(inp)), `281-17 serializes ${Object.prototype.toString.call(inp)}`);
    }
  }

  section("281-18 Secret canaries absent in normalized output");
  {
    const out = redactMetadata({
      note: "token " + CANARY_SK,
      m: new Map([["k", CANARY_SK]]),
      s: new Set([CANARY_SK]),
      nested: { api_key: CANARY_PASS, safe: "visible" },
    });
    const j = JSON.stringify(out);
    ok(!j.includes(CANARY_SK), "281-18 sk-proj absent");
    ok(!j.includes(CANARY_PASS), "281-18 password absent");
    ok(j.includes("visible"), "281-18 safe preserved");
  }

  section("281-19 Input graph not mutated");
  {
    const map = new Map([["k", "v"]]);
    const set = new Set([1, 2]);
    const obj = { a: map, b: set, c: { d: "e" } };
    const mapSize = map.size, setSize = set.size, objKeys = JSON.stringify(Object.keys(obj));
    redactMetadata(obj);
    ok(map.size === mapSize, "281-19 map size unchanged");
    ok(set.size === setSize, "281-19 set size unchanged");
    ok(JSON.stringify(Object.keys(obj)) === objKeys, "281-19 obj keys unchanged");
    ok(map.get("k") === "v", "281-19 map entry unchanged");
    ok(set.has(1) && set.has(2), "281-19 set entries unchanged");
  }

  section("281-20 Ordinary JSON-compatible metadata preserved");
  {
    const out = redactMetadata({
      s: "plain", n: 42, b: true, z: null,
      arr: [1, "two"], obj: { a: 1 },
    }) as any;
    ok(out.s === "plain" && out.n === 42 && out.b === true && out.z === null, "281-20 scalars");
    ok(JSON.stringify(out.arr) === "[1,\"two\"]", "281-20 array");
    ok(JSON.stringify(out.obj) === "{\"a\":1}", "281-20 object");
  }

  section("281-21 Repeated references produce distinct output nodes");
  {
    const shared = { name: "shared" };
    const out = redactMetadata({ a: shared, b: shared }) as any;
    // Documented policy: no WeakSet memoization. a and b are distinct output
    // objects even though they came from the same input reference.
    ok(out.a !== out.b, "281-21 a and b are distinct instances");
    ok(out.a.name === "shared" && out.b.name === "shared", "281-21 both carry field");
  }

  section("281-22 Map collisions preserved by array-of-pairs");
  {
    const d1 = new Date("2026-01-01T00:00:00.000Z");
    const d2 = new Date("2026-01-01T00:00:00.000Z");
    const m = new Map([[d1, "first"], [d2, "second"]]);
    const out = redactMetadata(m) as any;
    ok(Array.isArray(out.$map) && out.$map.length === 2,
       "281-22 both entries preserved despite identical normalized keys");
    ok(out.$map.some((e: any) => e[1] === "first"), "281-22 first value present");
    ok(out.$map.some((e: any) => e[1] === "second"), "281-22 second value present");
  }
  console.log("\n============================================");
  console.log("PASS: " + passed);
  console.log("FAIL: " + failed);
  console.log("============================================");
  process.exit(failed > 0 ? 1 : 0);
}

main();