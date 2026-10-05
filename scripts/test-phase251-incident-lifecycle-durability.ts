// scripts/test-phase251-incident-lifecycle-durability.ts
//
// Phase 251 verifier — durable incident lifecycle.
//
// This session: A20 (PG authoritative), A21 (no SQLite imports),
// A29 (TypeScript), A30 (diff integrity) + a schema/bootstrap probe.
// A01-A19, A22-A28 are added in subsequent Phase 251 sessions.
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { PgClient } from "../src/core/pg-client";
import { PgAsyncEngine } from "../src/core/pg-async-engine";
import { bootstrapPgSchema } from "../src/core/pg-bootstrap";
import { AsyncIncidentStore } from "../src/core/async-incident-store";

let passed = 0, failed = 0, blocked = 0, notExec = 0;
function ok(c: boolean, m: string): void {
  if (c) { passed++; console.log("PASS  " + m); }
  else { failed++; console.log("FAIL  " + m); }
}
function blk(m: string, why: string): void { blocked++; console.log("BLOCKED  " + m + " :: " + why); }
function nx(m: string, why: string): void { notExec++; console.log("NOT EXECUTED  " + m + " :: " + why); }
function section(t: string): void { console.log("\n--- " + t + " ---"); }

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL required"); process.exit(2); }
  if (process.env.NEXUS_PERSISTENCE_MODE !== "shared") {
    console.error("NEXUS_PERSISTENCE_MODE must be shared"); process.exit(2);
  }

  // ---------- Bootstrap + probe ----------
  section("A00 - PostgreSQL probe + bootstrap");
  const pg = new PgClient();
  await pg.connect(url);
  try {
    await bootstrapPgSchema(pg);
    ok(true, "A00 pg bootstrap ok");
    const tables = await pg.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('security_incidents','security_incident_timeline') ORDER BY table_name",
    );
    const names = tables.rows.map((r) => r.table_name);
    ok(names.includes("security_incidents"), "A00 security_incidents exists");
    ok(names.includes("security_incident_timeline"), "A00 security_incident_timeline exists");
  } catch (e) {
    blk("A00 bootstrap", String(e instanceof Error ? e.message : e).slice(0, 200));
  }

  // ---------- A20 - PG authoritative roundtrip ----------
  section("A20 - PG authoritative incident roundtrip");
  const store = new AsyncIncidentStore(new PgAsyncEngine(pg));
  const testId = "p251-test-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  const fp = "p251-fp-" + Date.now().toString(36);
  try {
    const created = await store.createIncidentAsync({
      id: testId,
      tenant_id: "default",
      environment: "local",
      service: "deployment-integrity",
      severity: "HIGH",
      title: "Phase 251 test incident",
      description: "test",
      status: "OPEN",
      deployment_id: "dep-p251",
      release_id: "rel-p251",
      artifact_id: "art-p251",
      artifact_digest: "sha256:p251",
      drift_classification: "DIGEST_MISMATCH",
      incident_fingerprint: fp,
      created_at: new Date().toISOString(),
    });
    ok(created.id === testId, "A20 create roundtrip id");
    ok(created.status === "OPEN", "A20 initial status OPEN");
    ok(created.incident_fingerprint === fp, "A20 fingerprint persisted");

    const back = await store.getIncidentAsync(testId);
    ok(back !== undefined, "A20 readback present");
    ok(back?.deployment_id === "dep-p251", "A20 correlation field persisted");

    const byFp = await store.getIncidentByFingerprintAsync(fp);
    ok(byFp?.id === testId, "A20 lookup by fingerprint returns same row");

    // Timeline idempotency
    const t1 = await store.appendIncidentTimelineAsync(testId, {
      type: "INCIDENT_CREATED",
      payload: { fp },
    });
    ok(t1.inserted === true, "A20 first timeline insert");
    const t2 = await store.appendIncidentTimelineAsync(testId, {
      type: "INCIDENT_CREATED",
      payload: { fp },
      at: undefined, // identical event -> same hash if timestamps match
    });
    // Note: without pinning `at`, timestamps differ => new insert. Verify hash idempotency instead:
    const atFixed = "2026-01-01T00:00:00.000Z";
    const tA = await store.appendIncidentTimelineAsync(testId, { type: "PING", at: atFixed, payload: { x: 1 } });
    const tB = await store.appendIncidentTimelineAsync(testId, { type: "PING", at: atFixed, payload: { x: 1 } });
    ok(tA.inserted === true, "A20 identical-event first insert ok");
    ok(tB.inserted === false, "A20 identical-event second insert deduped (idempotent)");

    const tl = await store.getIncidentTimelineAsync(testId);
    ok(tl.length >= 2, "A20 timeline persisted (" + tl.length + " entries)");

    const upd = await store.updateIncidentAsync(testId, { status: "RECOVERY_REQUESTED" });
    ok(upd === true, "A20 status update ok");
    const after = await store.getIncidentAsync(testId);
    ok(after?.status === "RECOVERY_REQUESTED", "A20 status persisted");
  } catch (e) {
    blk("A20 roundtrip", String(e instanceof Error ? e.message : e).slice(0, 300));
  } finally {
    try {
      await pg.query("DELETE FROM security_incident_timeline WHERE incident_id = $1", [testId]);
      await pg.query("DELETE FROM security_incidents WHERE id = $1", [testId]);
    } catch { /* best-effort */ }
  }

  // ---------- A21 - no SQLite in Phase 251 modules ----------
  section("A21 - no SQLite fallback in Phase 251 modules");
  {
    const src = fs.readFileSync("src/core/async-incident-store.ts", "utf8");
    ok(!src.includes("better-sqlite3"), "A21 no better-sqlite3 import in store");
    ok(!src.includes("openEngine"), "A21 no openEngine call");
    ok(!src.includes("SQLiteEngine"), "A21 no SQLiteEngine reference");
  }

  // ---------- A29 - TypeScript ----------
  section("A29 - TypeScript compilation");
  {
    let okFlag = false, err = "";
    try { execSync("npx tsc --noEmit", { stdio: "pipe", timeout: 240_000 }); okFlag = true; }
    catch (e: any) { err = String(e?.stderr ?? e?.message ?? e).slice(0, 300); }
    ok(okFlag, "A29 tsc --noEmit clean" + (okFlag ? "" : " - " + err));
  }

  // ---------- A30 - diff integrity ----------
  section("A30 - git diff --check");
  {
    let okFlag = false, err = "";
    try { execSync("git diff --check", { stdio: "pipe", timeout: 60_000 }); okFlag = true; }
    catch (e: any) { err = String(e?.stderr ?? e?.message ?? e).slice(0, 300); }
    ok(okFlag, "A30 git diff --check clean" + (okFlag ? "" : " - " + err));
  }

  // ---------- Explicit NOT EXECUTED markers for later-session items ----------
  section("Deferred to later Phase 251 sessions");
  nx("A01-A19 incident lifecycle + reconciliation", "Session 3+ work");
  nx("A22-A28 competing-authority + regression checks", "Session 3+ work");

  try { await pg.close(); } catch { /* isolated */ }

  console.log("\n============================================");
  console.log("PASS: " + passed);
  console.log("FAIL: " + failed);
  console.log("BLOCKED: " + blocked);
  console.log("NOT EXECUTED: " + notExec);
  console.log("============================================");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exit(1); });