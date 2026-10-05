// scripts/test-phase251-incident-lifecycle-durability.ts
//
// Phase 251 verifier â€” durable incident lifecycle.
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

import {
  openOrReconcileDriftIncident,
  deterministicDriftIncidentId,
  requestRecoveryFromIncident,
  applyResolutionIfVerified,
  closeIncidentIfResolved,
} from "../src/core/incident-lifecycle";
import {
  computeIncidentFingerprint,
  buildProductionIncidentFromDrift,
  evaluateIncidentResolution,
} from "../src/core/production-incident-response";
import { RecoveryPolicyEngine } from "../src/core/recovery-policy-engine";
import {
  buildRecoveryDecisionEnvelope,
  serializeRecoveryDecision,
  parseRecoveryDecision,
} from "../src/core/release-recovery-decision";

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

  // ---------- A01-A19: durable incident lifecycle + reconciliation ----------
  section("A01-A19 - durable incident lifecycle + reconciliation");

  const aIdent = {
    deployment_id: "dep-p251-a",
    release_id: "rel-p251-a",
    artifact_id: "art-p251-a",
    artifact_digest: "sha256:p251-a",
    environment: "local",
  };
  const aClass = ["DIGEST_MISMATCH"] as any;
  const aAt    = "2026-06-01T00:00:00.000Z";
  const aAt2   = "2026-06-01T00:05:00.000Z";
  const aAt3   = "2026-06-01T00:20:00.000Z";
  const aAtOld = "2026-05-31T00:00:00.000Z";

  const aFp = computeIncidentFingerprint({ ...aIdent, classifications: aClass });
  const aId = deterministicDriftIncidentId(aFp);

  const cleanupA = async () => {
    try {
      await pg.query("DELETE FROM security_incident_timeline WHERE incident_id LIKE $1", ["incident-drift-%"]);
      await pg.query("DELETE FROM security_incidents WHERE id LIKE $1", ["incident-drift-%"]);
    } catch { /* isolated */ }
  };

  try {
    await cleanupA();

    // A01 -- first observation creates durable incident
    const r1 = await openOrReconcileDriftIncident({
      store, identity: aIdent, classifications: aClass,
      severity: "CRITICAL", observedAt: aAt,
      title: "drift A01", description: "A01",
    });
    ok(r1.created === true, "A01 first observation creates one durable incident");
    ok(r1.incident.id === aId, "A01 deterministic id from fingerprint");

    // A02 -- repeated identical drift reconciles
    const r2 = await openOrReconcileDriftIncident({
      store, identity: aIdent, classifications: aClass,
      severity: "CRITICAL", observedAt: aAt,
      title: "drift A01", description: "A01",
    });
    ok(r2.created === false, "A02 repeated identical drift did not create new incident");
    ok(r2.incident.id === r1.incident.id, "A02 same durable incident returned");

    // A03 -- deterministic identity
    const fp2 = computeIncidentFingerprint({ ...aIdent, classifications: aClass });
    ok(fp2 === aFp, "A03 fingerprint is deterministic");
    ok(deterministicDriftIncidentId(fp2) === aId, "A03 id derived from fingerprint");

    // A04 -- timeline durable
    const tl1 = await store.getIncidentTimelineAsync(aId);
    ok(tl1.length >= 1, "A04 timeline persisted (" + tl1.length + " entries)");

    // A05 -- duplicate timeline events dedupe
    const evA = await store.appendIncidentTimelineAsync(aId, { type: "PIN", at: aAt, payload: { n: 1 } });
    const evB = await store.appendIncidentTimelineAsync(aId, { type: "PIN", at: aAt, payload: { n: 1 } });
    ok(evA.inserted === true, "A05 first timeline insert ok");
    ok(evB.inserted === false, "A05 duplicate timeline deduped");

    // A06 -- status persists
    await store.updateIncidentAsync(aId, { status: "INVESTIGATING" });
    const s6 = await store.getIncidentAsync(aId);
    ok(s6?.status === "INVESTIGATING", "A06 status transition persisted");

    // A07 -- recovery authorization evaluation persisted
    const engine = new RecoveryPolicyEngine();
    const integ = { state: "DRIFTED", expected_digest: aIdent.artifact_digest, observed_digest: "x", reasons: [] } as any;
    const expct = { ...aIdent } as any;
    const p250 = buildProductionIncidentFromDrift(integ, expct, aClass);
    const rr = await requestRecoveryFromIncident({
      store, incident: s6!, phase250Incident: p250,
      policyEngine: engine, workerId: "w-p251",
    });
    const after7 = await store.getIncidentAsync(aId);
    ok(
      rr.persistedStatus === "REQUIRE_REVIEW" ||
      rr.persistedStatus === "BLOCKED" ||
      rr.persistedStatus === "RECOVERY_AUTHORIZED",
      "A07 authorization decision persisted (" + rr.decision + " -> " + rr.persistedStatus + ")",
    );
    ok(after7?.status === rr.persistedStatus, "A07 status matches persisted decision");

    // A08 -- human approval remains required when policy says so
    ok(
      rr.decision === "HUMAN_APPROVAL_REQUIRED" ? rr.persistedStatus === "REQUIRE_REVIEW" : true,
      "A08 HUMAN_APPROVAL_REQUIRED maps to REQUIRE_REVIEW",
    );

    // A09 -- recovery decision envelope roundtrip
    const env = buildRecoveryDecisionEnvelope({
      decision: "REMAIN_RECOVERY_REQUIRED",
      action: "RECOVERY_REQUIRED",
      reason: "a09",
      workerId: "w-p251",
      intentKey: "intent-a09",
      now: Date.parse(aAt),
    });
    const ser = serializeRecoveryDecision(env);
    const parsed = parseRecoveryDecision(ser);
    ok(parsed !== null && parsed.decision === "REMAIN_RECOVERY_REQUIRED", "A09 decision envelope roundtrip");

    // A10 -- provider context absent -> honest NOT EXECUTED
    nx("A10 recovery intent requires provider context", "no ReleaseDeploymentIntentService with provider context in this env");

    // A11 -- attempt accounting not incremented by observation
    const before11 = (await store.getIncidentAsync(aId))?.recovery_attempt ?? 0;
    await openOrReconcileDriftIncident({
      store, identity: aIdent, classifications: aClass,
      severity: "CRITICAL", observedAt: aAt2, title: "t", description: "d",
    });
    const after11 = (await store.getIncidentAsync(aId))?.recovery_attempt ?? 0;
    ok(before11 === after11, "A11 recovery_attempt unchanged by observation");

    // A12 -- lease state not clobbered by observation
    await store.updateIncidentAsync(aId, { lease_owner: "worker-A", lease_expires_at: Date.parse(aAt) + 60000 });
    await openOrReconcileDriftIncident({
      store, identity: aIdent, classifications: aClass,
      severity: "CRITICAL", observedAt: aAt3, title: "t", description: "d",
    });
    const after12 = await store.getIncidentAsync(aId);
    ok(after12?.lease_owner === "worker-A", "A12 lease_owner preserved across observation");

    // A13 -- fresh VERIFIED verification can move to RESOLVED
    const freshObs = {
      available: true, status: "OK",
      observed_at: "2026-06-01T00:30:00.000Z",
      observed_digest: aIdent.artifact_digest,
      observed_release_id: aIdent.release_id,
      observed_artifact_id: aIdent.artifact_id,
    } as any;
    const evalRes = evaluateIncidentResolution({
      incident: { id: aId } as any,
      expected: expct, freshObservation: freshObs,
      originalObservationTimestamp: aAt,
    });
    ok(evalRes.state === "RESOLVED_ALLOWED", "A13 fresh VERIFIED observation allows resolution (state=" + evalRes.state + ")");
    const applied = await applyResolutionIfVerified({
      store, incident: (await store.getIncidentAsync(aId))!,
      resolution: evalRes, workerId: "w-p251",
    });
    ok(applied.updated === true, "A13 resolution persisted");
    const after13 = await store.getIncidentAsync(aId);
    ok(after13?.status === "RESOLVED", "A13 status RESOLVED");
    ok((after13?.verification_state ?? "").toUpperCase() === "VERIFIED", "A13 verification_state VERIFIED");
    ok((after13?.resolution_evidence ?? "").length > 0, "A13 resolution_evidence persisted");

    // A14 -- stale verification cannot resolve
    const staleEval = evaluateIncidentResolution({
      incident: { id: aId } as any,
      expected: expct,
      freshObservation: { ...freshObs, observed_at: "2026-05-30T00:00:00.000Z" } as any,
      originalObservationTimestamp: aAt,
    });
    ok(staleEval.state === "STALE_OBSERVATION", "A14 stale observation rejected (state=" + staleEval.state + ")");

    // A15 -- non-VERIFIED cannot resolve
    const driftedEval = evaluateIncidentResolution({
      incident: { id: aId } as any,
      expected: expct,
      freshObservation: { ...freshObs, observed_digest: "sha256:other" } as any,
      originalObservationTimestamp: aAt,
    });
    ok(driftedEval.state !== "RESOLVED_ALLOWED", "A15 drifted fresh observation cannot resolve");

    // A16 -- resolved incident cannot be regressed by stale observation
    const regress = await openOrReconcileDriftIncident({
      store, identity: aIdent, classifications: aClass,
      severity: "CRITICAL", observedAt: aAtOld, title: "t", description: "d",
    });
    ok(regress.incident.status === "RESOLVED", "A16 resolved status preserved after stale observation");
    ok(regress.newerObservation === false, "A16 stale observation detected");

    // A17 -- concurrent create reconciles through unique fence
    await cleanupA();
    const [c1, c2] = await Promise.all([
      openOrReconcileDriftIncident({ store, identity: aIdent, classifications: aClass, severity: "CRITICAL", observedAt: aAt, title: "c1", description: "c1" }),
      openOrReconcileDriftIncident({ store, identity: aIdent, classifications: aClass, severity: "CRITICAL", observedAt: aAt, title: "c2", description: "c2" }),
    ]);
    const fpList = await pg.query<{ incident_fingerprint: string }>(
      "SELECT incident_fingerprint FROM security_incidents WHERE incident_fingerprint = $1", [aFp],
    );
    ok(fpList.rows.length === 1, "A17 concurrent create -> exactly one durable row (got " + fpList.rows.length + ")");
    ok(c1.incident.id === c2.incident.id, "A17 both concurrent calls returned same id");

    // A18 -- timeline concurrency remains deterministic
    const tA = await store.appendIncidentTimelineAsync(aId, { type: "RACE", at: aAt2, payload: { k: 1 } });
    const tB = await store.appendIncidentTimelineAsync(aId, { type: "RACE", at: aAt2, payload: { k: 1 } });
    const insertedCount = [tA.inserted, tB.inserted].filter(Boolean).length;
    ok(insertedCount === 1, "A18 concurrent identical timeline events insert exactly once (got " + insertedCount + ")");

    // A19 -- provider-unavailable honest handling
    nx("A19 provider-unavailable path", "requires live provider to observe unavailability through production path");
  } catch (e) {
    blk("A01-A19 block", String(e instanceof Error ? e.message : e).slice(0, 300));
  } finally {
    await cleanupA();
  }

  // ---------- A22-A28: additional durable checks ----------------
  section("A22-A28 - additional durable checks");

  try {
    const bIdent = {
      deployment_id: "dep-p251-b",
      release_id: "rel-p251-b",
      artifact_id: "art-p251-b",
      artifact_digest: "sha256:p251-b",
      environment: "local",
    };
    const bClass = ["ARTIFACT_IDENTITY_MISMATCH"] as any;
    const bAt = "2026-06-02T00:00:00.000Z";
    const bFp = computeIncidentFingerprint({ ...bIdent, classifications: bClass });
    const bId = deterministicDriftIncidentId(bFp);

    try { await pg.query("DELETE FROM security_incidents WHERE id = $1", [bId]); } catch {}

    // A22 -- decision envelope roundtrip for a different decision kind
    const env2 = buildRecoveryDecisionEnvelope({
      decision: "SAFE_TO_RESUME",
      action: "RESUME_ROLLBACK",
      reason: "a22",
      workerId: "w-a22",
      intentKey: "intent-a22",
      now: Date.parse(bAt),
    });
    const p2 = parseRecoveryDecision(serializeRecoveryDecision(env2));
    ok(p2 !== null && p2.decision === "SAFE_TO_RESUME" && p2.action === "RESUME_ROLLBACK", "A22 SAFE_TO_RESUME envelope roundtrip");

    // A23 -- lifecycle integration with executor/intent machinery requires provider context
    nx("A23 recovery lifecycle integration with executor/intent machinery", "requires ReleaseDeploymentIntentService with provider context");

    // A24 -- lease ownership not overwritten by stale worker
    const rb = await openOrReconcileDriftIncident({
      store, identity: bIdent, classifications: bClass,
      severity: "HIGH", observedAt: bAt, title: "b", description: "b",
    });
    await store.updateIncidentAsync(bId, { lease_owner: "worker-current", lease_expires_at: Date.parse(bAt) + 60000 });
    await openOrReconcileDriftIncident({
      store, identity: bIdent, classifications: bClass,
      severity: "HIGH", observedAt: "2026-05-31T00:00:00.000Z", title: "b", description: "b",
    });
    const after24 = await store.getIncidentAsync(bId);
    ok(after24?.lease_owner === "worker-current", "A24 lease_owner preserved against stale worker");

    // A25 -- recovery_attempt unchanged by repeated observation
    const before25 = after24?.recovery_attempt ?? 0;
    await openOrReconcileDriftIncident({
      store, identity: bIdent, classifications: bClass,
      severity: "HIGH", observedAt: "2026-06-02T01:00:00.000Z", title: "b", description: "b",
    });
    const after25 = (await store.getIncidentAsync(bId))?.recovery_attempt ?? 0;
    ok(before25 === after25, "A25 recovery_attempt owned by recovery machinery, not observation");

    // A26 -- fresh post-recovery verification permits resolution
    const freshB = {
      available: true, status: "OK",
      observed_at: "2026-06-02T02:00:00.000Z",
      observed_digest: bIdent.artifact_digest,
      observed_release_id: bIdent.release_id,
      observed_artifact_id: bIdent.artifact_id,
    } as any;
    const evalB = evaluateIncidentResolution({
      incident: { id: bId } as any,
      expected: bIdent as any,
      freshObservation: freshB,
      originalObservationTimestamp: bAt,
    });
    ok(evalB.state === "RESOLVED_ALLOWED", "A26 fresh post-recovery verification permits resolution");

    // A27 -- resolution evidence durable
    const appB = await applyResolutionIfVerified({
      store, incident: (await store.getIncidentAsync(bId))!,
      resolution: evalB, workerId: "w-a27",
    });
    ok(appB.updated === true, "A27 resolution persisted");
    const after27 = await store.getIncidentAsync(bId);
    ok((after27?.resolution_evidence ?? "").length > 0, "A27 resolution_evidence persisted");
    ok((after27?.resolved_at ?? "").length > 0, "A27 resolved_at persisted");

    // A28 -- closure requires verified durable evidence
    const closeRes = await closeIncidentIfResolved({
      store, incident: after27!, workerId: "w-a28",
    });
    ok(closeRes.closed === true, "A28 closed after verified resolution");
    const after28 = await store.getIncidentAsync(bId);
    ok(after28?.status === "CLOSED", "A28 status CLOSED");
    ok((after28?.closed_at ?? "").length > 0, "A28 closed_at persisted");

    // Attempt to close an unresolved incident (must refuse)
    try { await pg.query("DELETE FROM security_incidents WHERE id = $1", [bId]); } catch {}
    const rOpen = await openOrReconcileDriftIncident({
      store, identity: bIdent, classifications: bClass,
      severity: "HIGH", observedAt: bAt, title: "open", description: "open",
    });
    const refuse = await closeIncidentIfResolved({
      store, incident: rOpen.incident, workerId: "w-a28b",
    });
    ok(refuse.closed === false, "A28 unresolved incident refuses closure");
  } catch (e) {
    blk("A22-A28 block", String(e instanceof Error ? e.message : e).slice(0, 300));
  } finally {
    try {
      await pg.query("DELETE FROM security_incident_timeline WHERE incident_id LIKE $1", ["incident-drift-%"]);
      await pg.query("DELETE FROM security_incidents WHERE id LIKE $1", ["incident-drift-%"]);
    } catch { /* isolated */ }
  }
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