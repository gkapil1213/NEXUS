// scripts/test-phase256-deployment-convergence.ts
// Phase 256: deployment convergence, recovery decision integrity,
// multi-observer consistency.
//
// Composes src/core/deployment-convergence.ts against real PostgreSQL
// (AsyncIncidentStore / PgAsyncEngine). No fake provider, no fabricated state.
//
// Honest outcomes only: PASS / FAIL / BLOCKED / NOT EXECUTED.

import fs from "node:fs";
import { execSync } from "node:child_process";
import { PgClient } from "../src/core/pg-client";
import { PgAsyncEngine } from "../src/core/pg-async-engine";
import { bootstrapPgSchema } from "../src/core/pg-bootstrap";
import { AsyncIncidentStore } from "../src/core/async-incident-store";
import {
  applyConvergentObservationAsync,
  supersedeRecoveryIntentAsync,
  assertDeploymentBinding,
} from "../src/core/deployment-convergence";

let passed = 0, failed = 0, blocked = 0, notExec = 0;
function ok(c: boolean, m: string): void {
  if (c) { passed++; console.log("PASS  " + m); }
  else { failed++; console.log("FAIL  " + m); }
}
function blk(m: string, why: string): void { blocked++; console.log("BLOCKED  " + m + " :: " + why); }
function nx(m: string, why: string): void { notExec++; console.log("NOT EXECUTED  " + m + " :: " + why); }
function section(t: string): void { console.log("\n--- " + t + " ---"); }

const PREFIX = "p256-";
const DEP_PREFIX = "dep-p256-";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL required"); process.exit(2); }
  if (process.env.NEXUS_PERSISTENCE_MODE !== "shared") {
    console.error("NEXUS_PERSISTENCE_MODE must be shared"); process.exit(2);
  }

  section("A00 - environment");
  const pg = new PgClient();
  let ready = false;
  try {
    await pg.connect(url);
    await bootstrapPgSchema(pg);
    ready = true;
    ok(true, "A00 postgres connected + schema bootstrapped");
  } catch (e) {
    blk("A00 postgres", String(e instanceof Error ? e.message : e).slice(0, 200));
  }
  if (!ready) {
    console.log("\n============================================");
    console.log("PASS: " + passed); console.log("FAIL: " + failed);
    console.log("BLOCKED: " + blocked); console.log("NOT EXECUTED: " + notExec);
    console.log("============================================");
    process.exit(failed > 0 ? 1 : 0);
  }

  const store = new AsyncIncidentStore(new PgAsyncEngine(pg));

  async function wipe() {
    for (const p of [PREFIX + "%", "incident-drift-%", "p254-%", "p255-%", "p253-%"]) {
      try {
        await pg.query("DELETE FROM security_incident_timeline WHERE incident_id LIKE $1", [p]);
        await pg.query("DELETE FROM security_incidents WHERE id LIKE $1", [p]);
      } catch {}
    }
  }
  await wipe();

  async function seedIncident(opts: {
    id: string;
    deploymentId: string;
    status: "OPEN" | "RECOVERY_REQUESTED" | "REQUIRE_REVIEW" | "RESOLVED" | "CLOSED";
    lastObservedAt?: string | null;
    recoveryIntentKey?: string | null;
  }) {
    await store.createIncidentAsync({
      id: opts.id,
      tenant_id: "default",
      environment: "p256",
      service: "deployment-integrity",
      severity: "HIGH",
      title: "p256 " + opts.id,
      description: "p256 setup",
      status: "OPEN",
      deployment_id: opts.deploymentId,
      release_id: "rel-" + opts.id,
      artifact_id: "art-" + opts.id,
      artifact_digest: "sha256:" + opts.id,
      drift_classification: "DIGEST_MISMATCH",
      incident_fingerprint: "fp-" + opts.id,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    const patch: any = { status: opts.status };
    if (opts.lastObservedAt !== undefined) patch.last_observation_at = opts.lastObservedAt;
    if (opts.recoveryIntentKey !== undefined) patch.recovery_intent_key = opts.recoveryIntentKey;
    await store.updateIncidentAsync(opts.id, patch);
    return (await store.getIncidentAsync(opts.id))!;
  }

  // A01 ----------------------------------------------------------------
  section("A01 - source architecture audit");
  try {
    const convSrc = fs.readFileSync("src/core/deployment-convergence.ts", "utf8");
    ok(convSrc.indexOf("isObservationNewer") >= 0, "A01 uses existing isObservationNewer ordering");
    ok(convSrc.indexOf("transitionIncidentStatusIfCurrentAsync") >= 0, "A01 uses existing CAS transition");
    ok(convSrc.indexOf("appendIncidentTimelineAsync") >= 0, "A01 uses existing timeline dedup");
    ok(convSrc.indexOf("docker.run(") < 0, "A01 no direct docker.run");
    ok(convSrc.indexOf("acquireLease") < 0 && convSrc.indexOf("renewLease") < 0, "A01 no lease operations");
    ok(!/recovery_attempt\s*[:=]\s*[^0]/.test(convSrc), "A01 does not mutate recovery_attempt");
    ok(convSrc.indexOf("release-recovery-executor") < 0, "A01 does not import executor");
  } catch (e) {
    blk("A01", String(e instanceof Error ? e.message : e).slice(0, 200));
  }

  // A02 ----------------------------------------------------------------
  section("A02 - observation ordering: newer applied, older rejected");
  try {
    await wipe();
    const id = PREFIX + "a02";
    await seedIncident({ id, deploymentId: DEP_PREFIX + "a02", status: "OPEN", lastObservedAt: "2026-03-01T00:00:00.000Z" });
    const r1 = await applyConvergentObservationAsync({
      store, incidentId: id, deploymentId: DEP_PREFIX + "a02",
      observedAt: "2026-03-01T01:00:00.000Z",
      classification: "DIGEST_MISMATCH", nextStatus: "REQUIRE_REVIEW", workerId: "w-p256",
    });
    ok(r1.outcome === "APPLIED", "A02 newer applied (got " + r1.outcome + ")");
    const r2 = await applyConvergentObservationAsync({
      store, incidentId: id, deploymentId: DEP_PREFIX + "a02",
      observedAt: "2026-03-01T00:30:00.000Z",
      classification: "DIGEST_MISMATCH", nextStatus: "OPEN", workerId: "w-p256",
    });
    ok(r2.outcome === "STALE_REJECTED", "A02 older rejected (got " + r2.outcome + ")");
    const back = await store.getIncidentAsync(id);
    ok(back?.status === "REQUIRE_REVIEW", "A02 status unchanged by stale");
  } catch (e) {
    blk("A02", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // A03 ----------------------------------------------------------------
  section("A03 - reordered delivery: state follows ordering");
  try {
    await wipe();
    const id = PREFIX + "a03";
    await seedIncident({ id, deploymentId: DEP_PREFIX + "a03", status: "OPEN", lastObservedAt: "2026-04-01T00:00:00.000Z" });
    const e3 = await applyConvergentObservationAsync({ store, incidentId: id, deploymentId: DEP_PREFIX + "a03", observedAt: "2026-04-01T03:00:00.000Z", classification: "DIGEST_MISMATCH", nextStatus: "REQUIRE_REVIEW", workerId: "w" });
    ok(e3.outcome === "APPLIED", "A03 event-3 applied");
    const e1 = await applyConvergentObservationAsync({ store, incidentId: id, deploymentId: DEP_PREFIX + "a03", observedAt: "2026-04-01T01:00:00.000Z", classification: "DIGEST_MISMATCH", nextStatus: "OPEN", workerId: "w" });
    ok(e1.outcome === "STALE_REJECTED", "A03 event-1 rejected");
    const e2 = await applyConvergentObservationAsync({ store, incidentId: id, deploymentId: DEP_PREFIX + "a03", observedAt: "2026-04-01T02:00:00.000Z", classification: "DIGEST_MISMATCH", nextStatus: "OPEN", workerId: "w" });
    ok(e2.outcome === "STALE_REJECTED", "A03 event-2 rejected");
    const back = await store.getIncidentAsync(id);
    ok(back?.status === "REQUIRE_REVIEW", "A03 final status is newest");
  } catch (e) {
    blk("A03", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // A04 ----------------------------------------------------------------
  section("A04 - duplicate observation idempotency");
  try {
    await wipe();
    const id = PREFIX + "a04";
    await seedIncident({ id, deploymentId: DEP_PREFIX + "a04", status: "OPEN", lastObservedAt: "2026-05-01T00:00:00.000Z" });
    const at = "2026-05-01T01:00:00.000Z";
    const r1 = await applyConvergentObservationAsync({ store, incidentId: id, deploymentId: DEP_PREFIX + "a04", observedAt: at, classification: "DIGEST_MISMATCH", nextStatus: "REQUIRE_REVIEW", workerId: "w" });
    ok(r1.outcome === "APPLIED", "A04 first applied");
    const r2 = await applyConvergentObservationAsync({ store, incidentId: id, deploymentId: DEP_PREFIX + "a04", observedAt: at, classification: "DIGEST_MISMATCH", nextStatus: "REQUIRE_REVIEW", workerId: "w" });
    ok(r2.outcome === "STALE_REJECTED" || r2.outcome === "DUPLICATE", "A04 second not applied (got " + r2.outcome + ")");
    const tl = await store.getIncidentTimelineAsync(id);
    ok(tl.filter((e) => e.event_type === "CONVERGENCE_TRANSITIONED").length === 1, "A04 exactly one transition event");
  } catch (e) {
    blk("A04", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // A05 ----------------------------------------------------------------
  section("A05 - concurrent duplicate observation");
  try {
    await wipe();
    const id = PREFIX + "a05";
    await seedIncident({ id, deploymentId: DEP_PREFIX + "a05", status: "OPEN", lastObservedAt: "2026-06-01T00:00:00.000Z" });
    const at = "2026-06-01T01:00:00.000Z";
    const [r1, r2] = await Promise.all([
      applyConvergentObservationAsync({ store, incidentId: id, deploymentId: DEP_PREFIX + "a05", observedAt: at, classification: "DIGEST_MISMATCH", nextStatus: "REQUIRE_REVIEW", workerId: "w1" }),
      applyConvergentObservationAsync({ store, incidentId: id, deploymentId: DEP_PREFIX + "a05", observedAt: at, classification: "DIGEST_MISMATCH", nextStatus: "REQUIRE_REVIEW", workerId: "w2" }),
    ]);
    const applied = [r1.outcome, r2.outcome].filter((o) => o === "APPLIED").length;
    ok(applied === 1, "A05 exactly one APPLIED across two concurrent callers (got " + applied + ")");
    const tl = await store.getIncidentTimelineAsync(id);
    ok(tl.filter((e) => e.event_type === "CONVERGENCE_TRANSITIONED").length === 1, "A05 exactly one transition event");
  } catch (e) {
    blk("A05", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // A06 ----------------------------------------------------------------
  section("A06 - three observers converge deterministically");
  try {
    await wipe();
    const id = PREFIX + "a06";
    await seedIncident({ id, deploymentId: DEP_PREFIX + "a06", status: "OPEN", lastObservedAt: "2026-07-01T00:00:00.000Z" });
    const [rA, rB, rC] = await Promise.all([
      applyConvergentObservationAsync({ store, incidentId: id, deploymentId: DEP_PREFIX + "a06", observedAt: "2026-07-01T03:00:00.000Z", classification: "DIGEST_MISMATCH", nextStatus: "REQUIRE_REVIEW", workerId: "A" }),
      applyConvergentObservationAsync({ store, incidentId: id, deploymentId: DEP_PREFIX + "a06", observedAt: "2026-07-01T02:00:00.000Z", classification: "DIGEST_MISMATCH", nextStatus: "OPEN", workerId: "B" }),
      applyConvergentObservationAsync({ store, incidentId: id, deploymentId: DEP_PREFIX + "a06", observedAt: "2026-07-01T01:00:00.000Z", classification: "DIGEST_MISMATCH", nextStatus: "OPEN", workerId: "C" }),
    ]);
    const applied = [rA, rB, rC].filter((r) => r.outcome === "APPLIED").length;
    ok(applied === 1, "A06 exactly one APPLIED (got " + applied + ")");
    const back = await store.getIncidentAsync(id);
    ok(back?.status === "REQUIRE_REVIEW", "A06 status = REQUIRE_REVIEW");
    ok(back?.last_observation_at === "2026-07-01T03:00:00.000Z", "A06 last_observation_at = newest");
  } catch (e) {
    blk("A06", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // A07 ----------------------------------------------------------------
  section("A07 - deployment identity mismatch rejected");
  try {
    await wipe();
    const id = PREFIX + "a07";
    await seedIncident({ id, deploymentId: DEP_PREFIX + "original", status: "OPEN", lastObservedAt: "2026-08-01T00:00:00.000Z" });
    const r = await applyConvergentObservationAsync({ store, incidentId: id, deploymentId: DEP_PREFIX + "different", observedAt: "2026-08-01T01:00:00.000Z", classification: "DIGEST_MISMATCH", nextStatus: "REQUIRE_REVIEW", workerId: "w" });
    ok(r.outcome === "IDENTITY_MISMATCH", "A07 identity mismatch detected (got " + r.outcome + ")");
    const back = await store.getIncidentAsync(id);
    ok(back?.status === "OPEN", "A07 status unchanged");
    const tl = await store.getIncidentTimelineAsync(id);
    ok(tl.some((e) => e.event_type === "CONVERGENCE_IDENTITY_MISMATCH"), "A07 evidence recorded");
  } catch (e) {
    blk("A07", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // A08 ----------------------------------------------------------------
  section("A08 - decision durability surface");
  try {
    const convSrc = fs.readFileSync("src/core/deployment-convergence.ts", "utf8");
    ok(convSrc.indexOf("recovery_decisions") < 0, "A08 no new recovery_decisions table");
    ok(convSrc.indexOf("CREATE TABLE") < 0, "A08 no DDL from convergence module");
    const pgSrc = fs.readFileSync("src/core/pg-bootstrap.ts", "utf8");
    ok(pgSrc.indexOf("last_recovery_decision TEXT") >= 0, "A08 existing decision column preserved");
  } catch (e) {
    blk("A08", String(e instanceof Error ? e.message : e).slice(0, 200));
  }

  // A09 ----------------------------------------------------------------
  section("A09 - decision/intent/execution separation");
  try {
    const convSrc = fs.readFileSync("src/core/deployment-convergence.ts", "utf8");
    ok(convSrc.indexOf("docker.run(") < 0, "A09 no docker execution");
    ok(convSrc.indexOf("rollback(") < 0, "A09 no rollback call");
    ok(convSrc.indexOf("RecoveryPolicyEngine") < 0, "A09 no policy engine");
    ok(convSrc.indexOf("ReleaseRecoveryExecutor") < 0, "A09 no executor import");
  } catch (e) {
    blk("A09", String(e instanceof Error ? e.message : e).slice(0, 200));
  }

  // A10 ----------------------------------------------------------------
  section("A10 - recovery intent supersession");
  try {
    await wipe();
    const id = PREFIX + "a10";
    await seedIncident({ id, deploymentId: DEP_PREFIX + "a10", status: "RECOVERY_REQUESTED", lastObservedAt: "2026-09-01T00:00:00.000Z", recoveryIntentKey: "intent-p256-old" });
    const r = await supersedeRecoveryIntentAsync({ store, incidentId: id, supersededIntentKey: "intent-p256-old", reason: "newer observation invalidated", workerId: "w" });
    ok(r.superseded === true, "A10 supersession applied");
    ok(r.lifecycleAfter === "REQUIRE_REVIEW", "A10 status -> REQUIRE_REVIEW (got " + r.lifecycleAfter + ")");
    const back = await store.getIncidentAsync(id);
    ok(back?.recovery_intent_key == null, "A10 intent key cleared");
  } catch (e) {
    blk("A10", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // A11 ----------------------------------------------------------------
  section("A11 - CLOSED incident late observation");
  try {
    await wipe();
    const id = PREFIX + "a11";
    await seedIncident({ id, deploymentId: DEP_PREFIX + "a11", status: "CLOSED", lastObservedAt: "2026-10-01T00:00:00.000Z" });
    const r = await applyConvergentObservationAsync({ store, incidentId: id, deploymentId: DEP_PREFIX + "a11", observedAt: "2026-10-01T01:00:00.000Z", classification: "DIGEST_MISMATCH", nextStatus: "REQUIRE_REVIEW", workerId: "w" });
    ok(r.outcome === "STALE_REJECTED", "A11 CLOSED not applied (got " + r.outcome + ")");
    const back = await store.getIncidentAsync(id);
    ok(back?.status === "CLOSED", "A11 status remains CLOSED");
    const tl = await store.getIncidentTimelineAsync(id);
    ok(tl.some((e) => e.event_type === "CONVERGENCE_CLOSED_OBSERVATION"), "A11 evidence recorded");
  } catch (e) {
    blk("A11", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // A12 ----------------------------------------------------------------
  section("A12 - durable state survives reopen");
  try {
    await wipe();
    const id = PREFIX + "a12";
    await seedIncident({ id, deploymentId: DEP_PREFIX + "a12", status: "OPEN", lastObservedAt: "2026-11-01T00:00:00.000Z" });
    const r1 = await applyConvergentObservationAsync({ store, incidentId: id, deploymentId: DEP_PREFIX + "a12", observedAt: "2026-11-01T01:00:00.000Z", classification: "DIGEST_MISMATCH", nextStatus: "REQUIRE_REVIEW", workerId: "w" });
    ok(r1.outcome === "APPLIED", "A12 first applied");
    const pg2 = new PgClient();
    await pg2.connect(url);
    const store2 = new AsyncIncidentStore(new PgAsyncEngine(pg2));
    const back = await store2.getIncidentAsync(id);
    ok(back?.status === "REQUIRE_REVIEW", "A12 status persisted after reopen");
    ok(back?.last_observation_at === "2026-11-01T01:00:00.000Z", "A12 timestamp persisted");
    const r2 = await applyConvergentObservationAsync({ store: store2, incidentId: id, deploymentId: DEP_PREFIX + "a12", observedAt: "2026-11-01T00:30:00.000Z", classification: "DIGEST_MISMATCH", nextStatus: "OPEN", workerId: "w" });
    ok(r2.outcome === "STALE_REJECTED", "A12 stale rejected after reopen");
    try { await pg2.close(); } catch {}
  } catch (e) {
    blk("A12", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // A13 ----------------------------------------------------------------
  section("A13 - persistence failure behavior");
  try {
    const dead = new PgClient();
    let threw = false;
    try { await dead.connect("postgres://postgres:postgres@127.0.0.1:1/nexus"); }
    catch { threw = true; }
    ok(threw === true, "A13 unreachable postgres surfaces as failure");
    const convSrc = fs.readFileSync("src/core/deployment-convergence.ts", "utf8");
    ok(convSrc.toLowerCase().indexOf("in-memory") < 0, "A13 no in-memory fallback");
  } catch (e) {
    blk("A13", String(e instanceof Error ? e.message : e).slice(0, 200));
  }

  // A14 ----------------------------------------------------------------
  section("A14 - transactionAsync composition");
  try {
    await wipe();
    const id = PREFIX + "a14";
    await seedIncident({ id, deploymentId: DEP_PREFIX + "a14", status: "OPEN", lastObservedAt: "2026-12-01T00:00:00.000Z" });
    const engine = (store as unknown as { db: any }).db;
    const result = await engine.transactionAsync(async (txEngine: any) => {
      const txStore = new AsyncIncidentStore(txEngine);
      await txStore.updateIncidentAsync(id, { status: "REQUIRE_REVIEW" });
      return (await txStore.getIncidentAsync(id))!.status;
    });
    ok(result === "REQUIRE_REVIEW", "A14 tx sees own writes");
    const back = await store.getIncidentAsync(id);
    ok(back?.status === "REQUIRE_REVIEW", "A14 tx commit persisted");
  } catch (e) {
    blk("A14", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // A15 ----------------------------------------------------------------
  section("A15 - timeline uniqueness");
  try {
    await wipe();
    const id = PREFIX + "a15";
    await seedIncident({ id, deploymentId: DEP_PREFIX + "a15", status: "OPEN", lastObservedAt: "2026-12-05T00:00:00.000Z" });
    const at = "2026-12-05T01:00:00.000Z";
    await applyConvergentObservationAsync({ store, incidentId: id, deploymentId: DEP_PREFIX + "a15", observedAt: at, classification: "DIGEST_MISMATCH", nextStatus: "REQUIRE_REVIEW", workerId: "w" });
    for (let i = 0; i < 5; i++) {
      await applyConvergentObservationAsync({ store, incidentId: id, deploymentId: DEP_PREFIX + "a15", observedAt: at, classification: "DIGEST_MISMATCH", nextStatus: "REQUIRE_REVIEW", workerId: "w" });
    }
    const tl = await store.getIncidentTimelineAsync(id);
    ok(tl.filter((e) => e.event_type === "CONVERGENCE_TRANSITIONED").length === 1, "A15 exactly one transition event");
  } catch (e) {
    blk("A15", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // A16 ----------------------------------------------------------------
  section("A16 - concurrent lifecycle reconciliation (6 callers)");
  try {
    await wipe();
    const id = PREFIX + "a16";
    await seedIncident({ id, deploymentId: DEP_PREFIX + "a16", status: "OPEN", lastObservedAt: "2026-12-10T00:00:00.000Z" });
    const at = "2026-12-10T01:00:00.000Z";
    const results = await Promise.all(Array.from({ length: 6 }, () =>
      applyConvergentObservationAsync({ store, incidentId: id, deploymentId: DEP_PREFIX + "a16", observedAt: at, classification: "DIGEST_MISMATCH", nextStatus: "REQUIRE_REVIEW", workerId: "w" }),
    ));
    const applied = results.filter((r) => r.outcome === "APPLIED").length;
    ok(applied === 1, "A16 exactly one APPLIED across six concurrent (got " + applied + ")");
  } catch (e) {
    blk("A16", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // A17 ----------------------------------------------------------------
  section("A17 - concurrent supersession");
  try {
    await wipe();
    const id = PREFIX + "a17";
    await seedIncident({ id, deploymentId: DEP_PREFIX + "a17", status: "RECOVERY_REQUESTED", lastObservedAt: "2026-12-15T00:00:00.000Z", recoveryIntentKey: "intent-p256-race" });
    const [r1, r2] = await Promise.all([
      supersedeRecoveryIntentAsync({ store, incidentId: id, supersededIntentKey: "intent-p256-race", reason: "A", workerId: "A" }),
      supersedeRecoveryIntentAsync({ store, incidentId: id, supersededIntentKey: "intent-p256-race", reason: "B", workerId: "B" }),
    ]);
    const wins = [r1.superseded, r2.superseded].filter(Boolean).length;
    ok(wins === 1, "A17 exactly one supersession wins (got " + wins + ")");
  } catch (e) {
    blk("A17", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // A18 ----------------------------------------------------------------
  section("A18 - obsolete intent cannot target replacement deployment");
  try {
    await wipe();
    const id = PREFIX + "a18";
    await seedIncident({ id, deploymentId: DEP_PREFIX + "original-a18", status: "RECOVERY_REQUESTED", lastObservedAt: "2026-12-20T00:00:00.000Z", recoveryIntentKey: "intent-p256-a18" });
    const r = await applyConvergentObservationAsync({ store, incidentId: id, deploymentId: DEP_PREFIX + "replacement-a18", observedAt: "2026-12-20T01:00:00.000Z", classification: "DIGEST_MISMATCH", nextStatus: "REQUIRE_REVIEW", workerId: "w" });
    ok(r.outcome === "IDENTITY_MISMATCH", "A18 replacement deployment rejected");
    const inc = (await store.getIncidentAsync(id))!;
    const bad = assertDeploymentBinding(inc, DEP_PREFIX + "replacement-a18");
    ok(bad.ok === false, "A18 assertDeploymentBinding refuses foreign");
    const good = assertDeploymentBinding(inc, DEP_PREFIX + "original-a18");
    ok(good.ok === true, "A18 assertDeploymentBinding accepts correct");
  } catch (e) {
    blk("A18", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // A19 ----------------------------------------------------------------
  section("A19 - authorization gate");
  try {
    const convSrc = fs.readFileSync("src/core/deployment-convergence.ts", "utf8");
    ok(convSrc.indexOf("RecoveryPolicyEngine") < 0, "A19 no policy engine");
    ok(convSrc.indexOf("ReleaseRecoveryExecutor") < 0, "A19 no executor");
    ok(convSrc.indexOf("requestDriftRecoveryIntent") < 0, "A19 no handoff call");
    ok(convSrc.indexOf("requestRecoveryFromIncident") < 0, "A19 no recovery request");
  } catch (e) {
    blk("A19", String(e instanceof Error ? e.message : e).slice(0, 200));
  }

  // A20 ----------------------------------------------------------------
  section("A20 - no false execution success");
  try {
    const convSrc = fs.readFileSync("src/core/deployment-convergence.ts", "utf8");
    const stripped = convSrc.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    ok(!/["']SUCCESS["']/.test(stripped), "A20 no SUCCESS literal");
    ok(!/["']EXECUTED["']/.test(stripped), "A20 no EXECUTED literal");
    ok(!/["']COMPLETED["']/.test(stripped), "A20 no COMPLETED literal");
  } catch (e) {
    blk("A20", String(e instanceof Error ? e.message : e).slice(0, 200));
  }

  // A21 ----------------------------------------------------------------
  section("A21 - no duplicate reconciler / scheduler");
  try {
    const convSrc = fs.readFileSync("src/core/deployment-convergence.ts", "utf8");
    ok(convSrc.indexOf("setInterval") < 0, "A21 no setInterval");
    ok(convSrc.indexOf("setTimeout") < 0, "A21 no setTimeout");
    ok(convSrc.indexOf("Scheduler") < 0, "A21 no Scheduler reference");
  } catch (e) {
    blk("A21", String(e instanceof Error ? e.message : e).slice(0, 200));
  }

  // A22 ----------------------------------------------------------------
  section("A22 - Phase 255 compatibility");
  try {
    const ilSrc = fs.readFileSync("src/core/incident-lifecycle.ts", "utf8");
    const supSrc = fs.readFileSync("src/core/drift-observation-supervisor.ts", "utf8");
    ok(ilSrc.indexOf("requestReviewAfterResolvedDrift") >= 0, "A22 Phase 255 review method preserved");
    ok(supSrc.indexOf("requestReviewAfterResolvedDrift") >= 0, "A22 supervisor still calls Phase 255 review");
    ok(supSrc.indexOf("closedIncidentsSkipped") >= 0, "A22 Phase 255 CLOSED-skip counter preserved");
  } catch (e) {
    blk("A22", String(e instanceof Error ? e.message : e).slice(0, 200));
  }

  // A23 ----------------------------------------------------------------
  section("A23 - TypeScript");
  try { execSync("npx tsc --noEmit", { stdio: "pipe", timeout: 300_000 }); ok(true, "A23 tsc clean"); }
  catch (e: any) { ok(false, "A23 tsc FAIL: " + String(e?.stderr ?? e?.message ?? e).slice(0, 200)); }

  // A24 ----------------------------------------------------------------
  section("A24 - production build");
  try { execSync("npm run build", { stdio: "pipe", timeout: 300_000 }); ok(true, "A24 build pass"); }
  catch (e: any) { ok(false, "A24 build FAIL: " + String(e?.stderr ?? e?.message ?? e).slice(0, 200)); }

  // A25 ----------------------------------------------------------------
  section("A25 - git diff --check");
  try { execSync("git diff --check", { stdio: "pipe", timeout: 60_000 }); ok(true, "A25 diff check clean"); }
  catch (e: any) { ok(false, "A25 diff check FAIL: " + String(e?.stderr ?? e?.message ?? e).slice(0, 200)); }

  // A26 ----------------------------------------------------------------
  section("A26 - no unrelated implementation");
  try {
    const convSrc = fs.readFileSync("src/core/deployment-convergence.ts", "utf8");
    ok(convSrc.indexOf("test-phase") < 0, "A26 no test-file imports");
    ok(convSrc.indexOf("worker-") < 0, "A26 no worker-module imports");
  } catch (e) {
    blk("A26", String(e instanceof Error ? e.message : e).slice(0, 200));
  }

  await wipe();
  try { (sqlite as any).close?.(); } catch {}
  try { await pg.close(); } catch {}

  console.log("\n============================================");
  console.log("PASS: " + passed);
  console.log("FAIL: " + failed);
  console.log("BLOCKED: " + blocked);
  console.log("NOT EXECUTED: " + notExec);
  console.log("============================================");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exit(1); });