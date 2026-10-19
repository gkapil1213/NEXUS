// scripts/test-phase271-event-redaction.ts
// Phase 271 - Event payload key-based redaction.
//
// Covers PHASE271_PLAN.md Coverage section (271-1 through 271-8).
//
// Harness uses SQLiteEngine.open(dbPath) -- the production initialization
// path that runs migrations and creates nexus_records / nexus_sequences.
// SQLiteEngine.fromDatabase() alone does NOT create those tables and causes
// "no such table: nexus_records" on EventService.emit().
//
// Expected: 271-1 through 271-8 validate event-boundary redaction and emission.
// 271-7b verifies URL-shaped credentials are redacted in free-text error values;
// other unrecognized secret formats may remain undetected.

import { join } from "path";
import { unlinkSync } from "fs";
import os from "os";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { EventService } from "../src/core/events";

let passed = 0, failed = 0, blocked = 0;
function ok(c: boolean, m: string) {
  if (c) { passed++; console.log("PASS  " + m); }
  else { failed++; console.log("FAIL  " + m); }
}
function section(t: string) { console.log("\n--- " + t + " ---"); }
function uniq(t: string) { return `p271-${t}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`; }
function clean(p: string) {
  for (const e of ["", "-wal", "-shm"]) { try { unlinkSync(p + e); } catch {} }
}

async function makeHarness(path: string): Promise<SQLiteEngine> {
  // Production init path: migrations + nexus_records + nexus_sequences.
  return await SQLiteEngine.open(path);
}

async function main() {
  console.log("=== Phase 271 - Event Redaction and Emission Integrity ===\n");

  // 271-1: top-level sensitive key
  section("271-1 top-level sensitive key redaction");
  {
    const dbPath = join(os.tmpdir(), `nexus-p271-1-${Date.now()}.sqlite`);
    clean(dbPath);
    const engine = await makeHarness(dbPath);
    try {
      const svc = new EventService(engine);
      await svc.init();
      const src = uniq("src");
      await svc.emit({
        type: "decision.created",
        source: src,
        payload: { password: "supersecret", user: "alice" },
      });
      const rows = await engine.all<any>("events");
      const stored = rows.find((r: any) => r.source === src);
      const p = (stored && stored.payload) || {};
      ok(p.password === "[REDACTED]", "271-1 password redacted, got=" + JSON.stringify(p.password));
      ok(p.user === "alice", "271-1 user preserved, got=" + JSON.stringify(p.user));
    } finally {
      try { await (engine as any).close(); } catch {}
      clean(dbPath);
    }
  }

  // 271-2: nested object recursion
  section("271-2 nested object recursion");
  {
    const dbPath = join(os.tmpdir(), `nexus-p271-2-${Date.now()}.sqlite`);
    clean(dbPath);
    const engine = await makeHarness(dbPath);
    try {
      const svc = new EventService(engine);
      await svc.init();
      const src = uniq("src");
      await svc.emit({
        type: "decision.created",
        source: src,
        payload: { outer: { token: "secret123" }, name: "svc" },
      });
      const rows = await engine.all<any>("events");
      const stored = rows.find((r: any) => r.source === src);
      const p = (stored && stored.payload) || {};
      ok(p.outer && p.outer.token === "[REDACTED]",
         "271-2 nested token redacted, got=" + JSON.stringify(p.outer && p.outer.token));
      ok(p.name === "svc", "271-2 name preserved, got=" + JSON.stringify(p.name));
    } finally {
      try { await (engine as any).close(); } catch {}
      clean(dbPath);
    }
  }

  // 271-3: array element redaction
  section("271-3 array element redaction");
  {
    const dbPath = join(os.tmpdir(), `nexus-p271-3-${Date.now()}.sqlite`);
    clean(dbPath);
    const engine = await makeHarness(dbPath);
    try {
      const svc = new EventService(engine);
      await svc.init();
      const src = uniq("src");
      await svc.emit({
        type: "decision.created",
        source: src,
        payload: { tokens: ["a", "b"], label: "x" },
      });
      const rows = await engine.all<any>("events");
      const stored = rows.find((r: any) => r.source === src);
      const p = (stored && stored.payload) || {};
      ok(p.tokens === "[REDACTED]",
         "271-3 array under sensitive key redacted whole, got=" + JSON.stringify(p.tokens));
      ok(p.label === "x", "271-3 label preserved, got=" + JSON.stringify(p.label));
    } finally {
      try { await (engine as any).close(); } catch {}
      clean(dbPath);
    }
  }

  // 271-4: non-secret fields preserved byte-for-byte
  section("271-4 non-secret fields preserved byte-for-byte");
  {
    const dbPath = join(os.tmpdir(), `nexus-p271-4-${Date.now()}.sqlite`);
    clean(dbPath);
    const engine = await makeHarness(dbPath);
    try {
      const svc = new EventService(engine);
      await svc.init();
      const src = uniq("src");
      const original = { reason: "timeout", code: 42, ok: true, nested: { a: 1, b: [1, 2, 3] } };
      await svc.emit({ type: "decision.created", source: src, payload: original });
      const rows = await engine.all<any>("events");
      const stored = rows.find((r: any) => r.source === src);
      const p = (stored && stored.payload) || {};
      ok(p.reason === "timeout", "271-4 reason preserved, got=" + JSON.stringify(p.reason));
      ok(p.code === 42, "271-4 code preserved, got=" + JSON.stringify(p.code));
      ok(p.ok === true, "271-4 ok preserved, got=" + JSON.stringify(p.ok) + " type=" + typeof p.ok);
      ok(p.nested && p.nested.a === 1, "271-4 nested.a preserved, got=" + JSON.stringify(p.nested && p.nested.a));
      ok(Array.isArray(p.nested && p.nested.b) && p.nested.b.length === 3,
         "271-4 nested.b array preserved, got=" + JSON.stringify(p.nested && p.nested.b));
    } finally {
      try { await (engine as any).close(); } catch {}
      clean(dbPath);
    }
  }

  // 271-5: null / undefined payload safety
  section("271-5 null / undefined payload safety");
  {
    const dbPath = join(os.tmpdir(), `nexus-p271-5-${Date.now()}.sqlite`);
    clean(dbPath);
    const engine = await makeHarness(dbPath);
    try {
      const svc = new EventService(engine);
      await svc.init();
      const src1 = uniq("src-u");
      const src2 = uniq("src-n");
      await svc.emit({ type: "decision.created", source: src1 });
      await svc.emit({ type: "decision.created", source: src2, payload: undefined });
      const rows = await engine.all<any>("events");
      const stored1 = rows.find((r: any) => r.source === src1);
      const stored2 = rows.find((r: any) => r.source === src2);
      ok(stored1 && stored1.payload && Object.keys(stored1.payload).length === 0,
         "271-5 undefined payload becomes empty object");
      ok(stored2 && stored2.payload && Object.keys(stored2.payload).length === 0,
         "271-5 explicit undefined payload becomes empty object");
    } finally {
      try { await (engine as any).close(); } catch {}
      clean(dbPath);
    }
  }

  // 271-6: SQL scan finds no raw secret
  section("271-6 persisted row contains no raw secret");
  {
    const dbPath = join(os.tmpdir(), `nexus-p271-6-${Date.now()}.sqlite`);
    clean(dbPath);
    const engine = await makeHarness(dbPath);
    try {
      const svc = new EventService(engine);
      await svc.init();
      const src = uniq("src");
      const secret = "unique-secret-xyz-123";
      await svc.emit({
        type: "decision.created",
        source: src,
        payload: { password: secret, user: "bob" },
      });
      const rows = await engine.all<any>("events");
      const stored = rows.find((r: any) => r.source === src);
      // Check the serialized payload of the persisted event does not contain the secret string.
      const serialized = JSON.stringify((stored && stored.payload) || {});
      ok(serialized.indexOf(secret) === -1,
         "271-6 serialized payload contains no raw secret value");
    } finally {
      try { await (engine as any).close(); } catch {}
      clean(dbPath);
    }
  }

  // 271-7a: connectionstring key redacted
  section("271-7a connectionstring key redacted (URL case)");
  {
    const dbPath = join(os.tmpdir(), `nexus-p271-7a-${Date.now()}.sqlite`);
    clean(dbPath);
    const engine = await makeHarness(dbPath);
    try {
      const svc = new EventService(engine);
      await svc.init();
      const src = uniq("src");
      await svc.emit({
        type: "decision.created",
        source: src,
        payload: { connectionstring: "postgres://u:secret@h/db", note: "x" },
      });
      const rows = await engine.all<any>("events");
      const stored = rows.find((r: any) => r.source === src);
      const p = (stored && stored.payload) || {};
      ok(p.connectionstring === "[REDACTED]",
         "271-7a connectionstring redacted, got=" + JSON.stringify(p.connectionstring));
      ok(p.note === "x", "271-7a note preserved");
    } finally {
      try { await (engine as any).close(); } catch {}
      clean(dbPath);
    }
  }

  // 271-7b: redact credentials embedded in free-text error strings
  section("271-7b URL credentials redacted inside error strings");
  {
    const dbPath = join(os.tmpdir(), `nexus-p271-7b-${Date.now()}.sqlite`);
    clean(dbPath);
    const engine = await makeHarness(dbPath);
    try {
      const svc = new EventService(engine);
      await svc.init();
      const src = uniq("src");
      const message =
        "Connection failed: postgres://u:secret@h/db (retry later)";
      await svc.emit({
        type: "decision.created",
        source: src,
        payload: { error: message },
      });

      const rows = await engine.all<any>("events");
      const stored = rows.find((r: any) => r.source === src);
      const p = (stored && stored.payload) || {};
      const errorText = String(p.error ?? "");

      ok(!errorText.includes("u:secret@"),
         "271-7b credentials must not remain in stored error text");
      ok(errorText.includes("postgres://[REDACTED]@h/db"),
         "271-7b URL authority should be visibly redacted, got=" +
         JSON.stringify(errorText));
      ok(errorText.includes("Connection failed:") &&
         errorText.includes("(retry later)"),
         "271-7b surrounding error context should be preserved, got=" +
         JSON.stringify(errorText));
    } finally {
      try { await (engine as any).close(); } catch {}
      clean(dbPath);
    }
  }
  // 271-8: performance - 1000 emits < 2000ms
  section("271-8 performance: 1000 emits under 2000ms");
  {
    const dbPath = join(os.tmpdir(), `nexus-p271-8-${Date.now()}.sqlite`);
    clean(dbPath);
    const engine = await makeHarness(dbPath);
    try {
      const svc = new EventService(engine);
      await svc.init();
      const start = Date.now();
      for (let i = 0; i < 1000; i++) {
        await svc.emit({
          type: "decision.created",
          source: "perf",
          payload: { password: "x" + i, note: "n" + i },
        });
      }
      const elapsed = Date.now() - start;
      ok(elapsed < 2000, "271-8 1000 emits in " + elapsed + "ms (bound: 2000ms)");
    } finally {
      try { await (engine as any).close(); } catch {}
      clean(dbPath);
    }
  }

  console.log("\n============================================");
  console.log("PASS: " + passed);
  console.log("FAIL: " + failed);
  console.log("BLOCKED: " + blocked);
  console.log("============================================");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exit(2); });
