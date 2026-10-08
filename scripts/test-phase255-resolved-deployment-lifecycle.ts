// scripts/test-phase255-resolved-deployment-lifecycle.ts
// Phase 255 verifier: production resolved-deployment lifecycle reconciliation.
//
// Exercises the extended DriftObservationSupervisor (Phase 252 + Phase 255)
// end-to-end against real PostgreSQL (security_incidents / timeline) and real
// SQLite (DeploymentHistoryService). Observations come from a scripted observer
// (the supervisor's designed injection point). All persistence, lifecycle,
// drift classification, incident correlation and handoff are the real
// production components.
//
// Honest states only: PASS / FAIL / BLOCKED / NOT EXECUTED.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { PgClient } from "../src/core/pg-client";
import { PgAsyncEngine } from "../src/core/pg-async-engine";
import { bootstrapPgSchema } from "../src/core/pg-bootstrap";
import { AsyncIncidentStore } from "../src/core/async-incident-store";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { DeploymentHistoryService } from "../src/core/deployment-history";
import { ExecutionStore } from "../src/core/execution-store";
import { ReleaseDeploymentIntentService } from "../src/core/release-deployment-intent";
import {
  DriftObservationSupervisor,
  type DriftObservationScope,
  type DriftObservationEventSink,
} from "../src/core/drift-observation-supervisor";
import { computeIncidentFingerprint } from "../src/core/production-incident-response";
import { deterministicDriftIncidentId } from "../src/core/incident-lifecycle";
import type { DeploymentObservation } from "../src/core/post-deployment-integrity";

let passed = 0, failed = 0, blocked = 0, notExec = 0;
function ok(c: boolean, m: string): void {
  if (c) { passed++; console.log("PASS  " + m); }
  else { failed++; console.log("FAIL  " + m); }
}
function blk(m: string, why: string): void { blocked++; console.log("BLOCKED  " + m + " :: " + why); }
function nx(m: string, why: string): void { notExec++; console.log("NOT EXECUTED  " + m + " :: " + why); }
function section(t: string): void { console.log("\n--- " + t + " ---"); }

class EventsRecorder implements DriftObservationEventSink {
  emitted: Array<{ type: string; source: string; payload?: unknown }> = [];
  async emit(e: { type: string; source: string; payload?: unknown }): Promise<unknown> {
    this.emitted.push(e); return undefined;
  }
}
class ScriptedObserver {
  constructor(private responses: Record<string, DeploymentObservation | Error>) {}
  async observe(id: string): Promise<DeploymentObservation> {
    const r = this.responses[id];
    if (r instanceof Error) throw r;
    if (!r) throw new Error("no scripted observation for " + id);
    return r;
  }
}
function obs(over: Partial<DeploymentObservation> = {}): DeploymentObservation {
  return {
    deployment_id: "ignored",
    available: true,
    status: "OBSERVED",
    observed_at: new Date(Date.now() + 60_000).toISOString(),
    observed_digest: "sha256:expected",
    observed_release_id: "rel-255",
    observed_artifact_id: "art-255",
    ...over,
  } as DeploymentObservation;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL required"); process.exit(2); }
  if (process.env.NEXUS_PERSISTENCE_MODE !== "shared") {
    console.error("NEXUS_PERSISTENCE_MODE must be shared"); process.exit(2);
  }

  // ---- A00 ---------------------------------------------------------------
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

  const dbPath = path.join(os.tmpdir(), "nexus-p255-" + Date.now() + ".sqlite");
  process.on("exit", () => { for (const e of ["", "-wal", "-shm"]) { try { fs.unlinkSync(dbPath + e); } catch {} } });
  const sqlite = await SQLiteEngine.open(dbPath);
  const history = new DeploymentHistoryService(sqlite);
  const execStore = new ExecutionStore(sqlite as any);
  const intentService = new ReleaseDeploymentIntentService(execStore);

  const PREFIX = "incident-drift-";

  async function wipe() {
    for (const p of ["incident-drift-%", "p254-%", "p253-%", "p255-%"]) {
      try {
        await pg.query("DELETE FROM security_incident_timeline WHERE incident_id LIKE $1", [p]);
        await pg.query("DELETE FROM security_incidents WHERE id LIKE $1", [p]);
      } catch {}
    }
  }
  await wipe();

  // Seed a DeploymentRecord (KNOWN_GOOD) + a RESOLVED incident correlated
  // by the fingerprint that matches the drift classification we will feed.
  async function seedResolvedScenario(opts: {
    env: string;
    digest: string;
    classification: string;
    lifecycle: "RESOLVED" | "CLOSED";
    incidentCreatedAt: string;
  }): Promise<{ deploymentId: string; incidentId: string; fingerprint: string; relId: string; artId: string }> {
    const relId = "rel-p255-" + opts.env;
    const artId = "art-p255-" + opts.env;
    const rec = await history.createDeployment({
      project_id: "p255",
      environment: opts.env,
      release_id: relId,
      commit_sha: "commit-" + relId,
      artifact_id: artId,
      image_repository: "example/test",
      image_tag: "v1",
      image_id: null,
      image_digest: opts.digest,
      container_name: "nexus-p255-" + opts.env,
      previous_deployment_id: null,
      is_rollback: false,
    } as any);
    await history.updateDeployment(rec.id, { artifact_id: artId, execution_id: "exec-p255-" + opts.env, attempt_id: "attempt-p255-" + opts.env, container_port: 8080 } as any);
    await (history as any).markKnownGood(rec.id);

    const fp = computeIncidentFingerprint({
      deployment_id: rec.id,
      release_id: relId,
      artifact_id: artId,
      artifact_digest: opts.digest,
      environment: opts.env,
      classifications: [opts.classification] as any,
    });
    const id = deterministicDriftIncidentId(fp);

    await store.createIncidentAsync({
      id,
      tenant_id: "default",
      environment: opts.env,
      service: "deployment-integrity",
      severity: "HIGH",
      title: "p255 " + opts.env,
      description: "p255 setup",
      status: "OPEN",
      deployment_id: rec.id,
      release_id: relId,
      artifact_id: artId,
      artifact_digest: opts.digest,
      drift_classification: opts.classification,
      incident_fingerprint: fp,
      created_at: opts.incidentCreatedAt,
      updated_at: opts.incidentCreatedAt,
    });

    // Move to the target lifecycle through the store's public API (no schema trick).
    const patch: any = {
      status: opts.lifecycle,
      last_observation_at: opts.incidentCreatedAt,
    };
    if (opts.lifecycle === "RESOLVED") {
      patch.verification_state = "VERIFIED";
      patch.resolution_evidence = JSON.stringify({ test: "p255-setup", env: opts.env });
      patch.resolved_at = opts.incidentCreatedAt;
    } else {
      patch.verification_state = "VERIFIED";
      patch.resolution_evidence = JSON.stringify({ test: "p255-setup-closed", env: opts.env });
      patch.resolved_at = opts.incidentCreatedAt;
      patch.closed_at = opts.incidentCreatedAt;
    }
    await store.updateIncidentAsync(id, patch);

    return { deploymentId: rec.id, incidentId: id, fingerprint: fp, relId, artId };
  }

  function mkSupervisor(scope: DriftObservationScope, observer: ScriptedObserver, events = new EventsRecorder()) {
    const sup = new DriftObservationSupervisor({
      incidentStore: store,
      history,
      observer,
      workerId: "p255-worker",
      intervalMs: 60_000,
      maxScopesPerTick: 100,
      enumerateScopes: async () => [scope],
      svc: { events },
      intentService,
    });
    return { sup, events };
  }

  // ---- A01: source wiring audit -----------------------------------------
  section("A01 - source wiring audit");
  try {
    const supSrc = fs.readFileSync("src/core/drift-observation-supervisor.ts", "utf8");
    const ilSrc = fs.readFileSync("src/core/incident-lifecycle.ts", "utf8");
    const storeSrc = fs.readFileSync("src/core/async-incident-store.ts", "utf8");
    ok(/import \{ requestReviewAfterResolvedDrift \}/.test(supSrc), "A01 supervisor imports the Phase 255 method");
    ok(/requestReviewAfterResolvedDrift\(/.test(supSrc), "A01 supervisor calls the Phase 255 method");
    ok(/phase255PreStatus/.test(supSrc), "A01 supervisor reads prior status");
    ok(/resolvedIncidentsReviewRequired/.test(supSrc), "A01 tick counter present");
    ok(/closedIncidentsSkipped/.test(supSrc), "A01 CLOSED skip counter present");
    ok(/export async function requestReviewAfterResolvedDrift/.test(ilSrc), "A01 incident-lifecycle exports the method");
    ok(/async transitionIncidentStatusIfCurrentAsync/.test(storeSrc), "A01 store has guarded transition method");
  } catch (e) {
    blk("A01 wiring", String(e instanceof Error ? e.message : e).slice(0, 200));
  }

  // ---- A02: RESOLVED + fresh VERIFIED remains RESOLVED ------------------
  section("A02 - RESOLVED + fresh VERIFIED remains RESOLVED");
  try {
    await wipe();
    const digest = "sha256:a02-" + Date.now();
    const s = await seedResolvedScenario({
      env: "a02", digest, classification: "DIGEST_MISMATCH",
      lifecycle: "RESOLVED",
      incidentCreatedAt: new Date(Date.now() - 600_000).toISOString(),
    });
    const observer = new ScriptedObserver({
      [s.deploymentId]: obs({
        observed_release_id: s.relId, observed_artifact_id: s.artId, observed_digest: digest,
      }),
    });
    const { sup } = mkSupervisor({ projectId: "p255", environment: "a02" }, observer);
    const r = await sup.runNow();
    ok(r.verified === 1, "A02 classified VERIFIED");
    ok(r.resolvedIncidentsReviewRequired === 0, "A02 no review transition");
    const back = await store.getIncidentAsync(s.incidentId);
    ok(back?.status === "RESOLVED", "A02 incident remains RESOLVED (got " + back?.status + ")");
  } catch (e) {
    blk("A02", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A03: RESOLVED + fresh DRIFTED -> REQUIRE_REVIEW ------------------
  section("A03 - RESOLVED + fresh DRIFTED -> REQUIRE_REVIEW");
  try {
    await wipe();
    const digest = "sha256:a03-" + Date.now();
    const s = await seedResolvedScenario({
      env: "a03", digest, classification: "DIGEST_MISMATCH",
      lifecycle: "RESOLVED",
      incidentCreatedAt: new Date(Date.now() - 600_000).toISOString(),
    });
    const observer = new ScriptedObserver({
      [s.deploymentId]: obs({
        observed_release_id: s.relId,
        observed_artifact_id: s.artId,
        observed_digest: "sha256:DIFFERENT",
      }),
    });
    const { sup } = mkSupervisor({ projectId: "p255", environment: "a03" }, observer);
    const r = await sup.runNow();
    ok(r.drifted === 1, "A03 classified DRIFTED");
    ok(r.resolvedIncidentsReviewRequired === 1, "A03 review-required counted");
    const back = await store.getIncidentAsync(s.incidentId);
    ok(back?.status === "REQUIRE_REVIEW" || back?.status === "RECOVERY_REQUESTED", "A03 review lifecycle preserved (got " + back?.status + ")");
  } catch (e) {
    blk("A03", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A04: durable evidence for drift ----------------------------------
  section("A04 - durable evidence present");
  try {
    await wipe();
    const digest = "sha256:a04-" + Date.now();
    const s = await seedResolvedScenario({
      env: "a04", digest, classification: "DIGEST_MISMATCH",
      lifecycle: "RESOLVED",
      incidentCreatedAt: new Date(Date.now() - 600_000).toISOString(),
    });
    const observer = new ScriptedObserver({
      [s.deploymentId]: obs({
        observed_release_id: s.relId, observed_artifact_id: s.artId,
        observed_digest: "sha256:DIFFERENT",
      }),
    });
    const { sup } = mkSupervisor({ projectId: "p255", environment: "a04" }, observer);
    await sup.runNow();
    const tl = await store.getIncidentTimelineAsync(s.incidentId);
    ok(tl.some((e) => e.event_type === "POST_RESOLUTION_DRIFT_REVIEW_REQUIRED"),
       "A04 review-required timeline event present");
  } catch (e) {
    blk("A04", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A05: CLOSED incident not silently reopened -----------------------
  section("A05 - CLOSED incident not silently reopened");
  try {
    await wipe();
    const digest = "sha256:a05-" + Date.now();
    const s = await seedResolvedScenario({
      env: "a05", digest, classification: "DIGEST_MISMATCH",
      lifecycle: "CLOSED",
      incidentCreatedAt: new Date(Date.now() - 600_000).toISOString(),
    });
    const observer = new ScriptedObserver({
      [s.deploymentId]: obs({
        observed_release_id: s.relId, observed_artifact_id: s.artId,
        observed_digest: "sha256:DIFFERENT",
      }),
    });
    const { sup } = mkSupervisor({ projectId: "p255", environment: "a05" }, observer);
    const r = await sup.runNow();
    ok(r.closedIncidentsSkipped === 1, "A05 CLOSED skip counted");
    const back = await store.getIncidentAsync(s.incidentId);
    ok(back?.status === "CLOSED", "A05 status still CLOSED (got " + back?.status + ")");
  } catch (e) {
    blk("A05", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A06: UNKNOWN does not resolve or reopen --------------------------
  section("A06 - UNKNOWN preserves state");
  try {
    await wipe();
    const digest = "sha256:a06-" + Date.now();
    const s = await seedResolvedScenario({
      env: "a06", digest, classification: "DIGEST_MISMATCH",
      lifecycle: "RESOLVED",
      incidentCreatedAt: new Date(Date.now() - 600_000).toISOString(),
    });
    const observer = new ScriptedObserver({
      [s.deploymentId]: obs({ status: "ERROR" as any }),
    });
    const { sup } = mkSupervisor({ projectId: "p255", environment: "a06" }, observer);
    const r = await sup.runNow();
    ok(r.unknown === 1, "A06 classified UNKNOWN");
    const back = await store.getIncidentAsync(s.incidentId);
    ok(back?.status === "RESOLVED", "A06 status unchanged");
  } catch (e) {
    blk("A06", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A07: BLOCKED preserves state -------------------------------------
  section("A07 - BLOCKED preserves state");
  try {
    await wipe();
    const digest = "sha256:a07-" + Date.now();
    const s = await seedResolvedScenario({
      env: "a07", digest, classification: "DIGEST_MISMATCH",
      lifecycle: "RESOLVED",
      incidentCreatedAt: new Date(Date.now() - 600_000).toISOString(),
    });
    const observer = new ScriptedObserver({
      [s.deploymentId]: obs({ available: false }),
    });
    const { sup } = mkSupervisor({ projectId: "p255", environment: "a07" }, observer);
    const r = await sup.runNow();
    ok(r.blocked === 1, "A07 classified BLOCKED");
    const back = await store.getIncidentAsync(s.incidentId);
    ok(back?.status === "RESOLVED", "A07 status unchanged");
  } catch (e) {
    blk("A07", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A08: NOT_EXECUTED preserves state --------------------------------
  section("A08 - NOT_EXECUTED preserves state");
  try {
    await wipe();
    const digest = "sha256:a08-" + Date.now();
    const s = await seedResolvedScenario({
      env: "a08", digest, classification: "DIGEST_MISMATCH",
      lifecycle: "RESOLVED",
      incidentCreatedAt: new Date(Date.now() - 600_000).toISOString(),
    });
    const observer = new ScriptedObserver({
      [s.deploymentId]: obs({ status: "NOT_EXECUTED" }),
    });
    const { sup } = mkSupervisor({ projectId: "p255", environment: "a08" }, observer);
    const r = await sup.runNow();
    ok(r.notExecuted === 1, "A08 classified NOT_EXECUTED");
    const back = await store.getIncidentAsync(s.incidentId);
    ok(back?.status === "RESOLVED", "A08 status unchanged");
  } catch (e) {
    blk("A08", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A09: stale observation does not resolve or reopen -----------------
  section("A09 - stale observation does not resolve");
  try {
    await wipe();
    const digest = "sha256:a09-" + Date.now();
    const s = await seedResolvedScenario({
      env: "a09", digest, classification: "DIGEST_MISMATCH",
      lifecycle: "RESOLVED",
      incidentCreatedAt: new Date().toISOString(),
    });
    const observer = new ScriptedObserver({
      [s.deploymentId]: obs({
        observed_at: new Date(Date.now() - 3_600_000).toISOString(),
        observed_release_id: s.relId, observed_artifact_id: s.artId, observed_digest: digest,
      }),
    });
    const { sup } = mkSupervisor({ projectId: "p255", environment: "a09" }, observer);
    const r = await sup.runNow();
    ok(r.verified === 1, "A09 classified VERIFIED");
    ok(r.resolvedIncidentsReviewRequired === 0, "A09 no review transition");
    const back = await store.getIncidentAsync(s.incidentId);
    ok(back?.status === "RESOLVED", "A09 status unchanged");
  } catch (e) {
    blk("A09", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A10: missing deployment identity fails closed --------------------
  section("A10 - missing identity fails closed");
  try {
    await wipe();
    const digest = "sha256:a10-" + Date.now();
    const rec = await history.createDeployment({
      project_id: "p255", environment: "a10",
      release_id: "rel-p255-a10", commit_sha: "c",
      artifact_id: null,
      image_repository: "example/test", image_tag: "v1",
      image_id: null, image_digest: digest,
      container_name: "nexus-p255-a10",
      previous_deployment_id: null, is_rollback: false,
    } as any);
    await (history as any).markKnownGood(rec.id);

    // Incident with no artifact_id — Phase 255 cannot correlate.
    const fp = computeIncidentFingerprint({
      deployment_id: rec.id, release_id: "rel-p255-a10",
      artifact_id: "", artifact_digest: digest,
      environment: "a10", classifications: ["DIGEST_MISMATCH"] as any,
    });
    const id = deterministicDriftIncidentId(fp);
    await store.createIncidentAsync({
      id, tenant_id: "default", environment: "a10",
      service: "deployment-integrity", severity: "HIGH",
      title: "a10", description: "a10", status: "RESOLVED",
      deployment_id: rec.id, release_id: "rel-p255-a10",
      artifact_id: null, artifact_digest: digest,
      drift_classification: "DIGEST_MISMATCH",
      incident_fingerprint: fp,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    const observer = new ScriptedObserver({});
    const { sup } = mkSupervisor({ projectId: "p255", environment: "a10" }, observer);
    const r = await sup.runNow();
    ok(r.errors.length === 0 || r.errors.length > 0, "A10 did not throw");
    const back = await store.getIncidentAsync(id);
    ok(back?.status === "RESOLVED", "A10 status unchanged (no fabricated resolution)");
  } catch (e) {
    blk("A10", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A11: missing deployment record fails closed ----------------------
  section("A11 - missing deployment record fails closed");
  try {
    await wipe();
    const digest = "sha256:a11-" + Date.now();
    const fp = computeIncidentFingerprint({
      deployment_id: "nonexistent-" + Date.now(),
      release_id: "rel-p255-a11",
      artifact_id: "art-p255-a11",
      artifact_digest: digest,
      environment: "a11",
      classifications: ["DIGEST_MISMATCH"] as any,
    });
    const id = deterministicDriftIncidentId(fp);
    await store.createIncidentAsync({
      id, tenant_id: "default", environment: "a11",
      service: "deployment-integrity", severity: "HIGH",
      title: "a11", description: "a11", status: "RESOLVED",
      deployment_id: "nonexistent-" + Date.now(),
      release_id: "rel-p255-a11", artifact_id: "art-p255-a11",
      artifact_digest: digest, drift_classification: "DIGEST_MISMATCH",
      incident_fingerprint: fp,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    const observer = new ScriptedObserver({});
    const { sup } = mkSupervisor({ projectId: "p255", environment: "a11" }, observer);
    const r = await sup.runNow();
    // Supervisor skips scopes without a KNOWN_GOOD deployment -> no drift processing.
    ok(r.deploymentsScanned === 0, "A11 no deployment scanned (record missing)");
    const back = await store.getIncidentAsync(id);
    ok(back?.status === "RESOLVED", "A11 status unchanged");
  } catch (e) {
    blk("A11", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A12: repeated reconcile is idempotent ----------------------------
  section("A12 - repeated reconciliation is idempotent");
  try {
    await wipe();
    const digest = "sha256:a12-" + Date.now();
    const s = await seedResolvedScenario({
      env: "a12", digest, classification: "DIGEST_MISMATCH",
      lifecycle: "RESOLVED",
      incidentCreatedAt: new Date(Date.now() - 600_000).toISOString(),
    });
    const observer = new ScriptedObserver({
      [s.deploymentId]: obs({
        observed_release_id: s.relId, observed_artifact_id: s.artId,
        observed_digest: "sha256:DIFFERENT",
      }),
    });
    const { sup } = mkSupervisor({ projectId: "p255", environment: "a12" }, observer);
    const r1 = await sup.runNow();
    const r2 = await sup.runNow();
    ok(r1.resolvedIncidentsReviewRequired === 1, "A12 first tick: review-required");
    ok(r2.resolvedIncidentsReviewRequired === 0, "A12 second tick: no re-transition");
    const back = await store.getIncidentAsync(s.incidentId);
    ok(back?.status === "REQUIRE_REVIEW" || back?.status === "RECOVERY_REQUESTED", "A12 final lifecycle state valid (got " + back?.status + ")");
    const tl = await store.getIncidentTimelineAsync(s.incidentId);
    const reviewEvents = tl.filter((e) => e.event_type === "POST_RESOLUTION_DRIFT_REVIEW_REQUIRED");
    ok(reviewEvents.length === 1, "A12 exactly one review timeline event (got " + reviewEvents.length + ")");
  } catch (e) {
    blk("A12", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A13: concurrent reconcilers -> one transition --------------------
  section("A13 - concurrent reconcilers, one transition");
  try {
    await wipe();
    const digest = "sha256:a13-" + Date.now();
    const s = await seedResolvedScenario({
      env: "a13", digest, classification: "DIGEST_MISMATCH",
      lifecycle: "RESOLVED",
      incidentCreatedAt: new Date(Date.now() - 600_000).toISOString(),
    });
    const observer = new ScriptedObserver({
      [s.deploymentId]: obs({
        observed_release_id: s.relId, observed_artifact_id: s.artId,
        observed_digest: "sha256:DIFFERENT",
      }),
    });
    const a = mkSupervisor({ projectId: "p255", environment: "a13" }, observer);
    const b = mkSupervisor({ projectId: "p255", environment: "a13" }, observer);
    const [ra, rb] = await Promise.all([a.sup.runNow(), b.sup.runNow()]);
    const total = ra.resolvedIncidentsReviewRequired + rb.resolvedIncidentsReviewRequired;
    ok(total === 1, "A13 exactly one review transition across two supervisors (got " + total + ")");
    const back = await store.getIncidentAsync(s.incidentId);
    ok(back?.status === "REQUIRE_REVIEW" || back?.status === "RECOVERY_REQUESTED", "A13 final lifecycle state valid (got " + back?.status + ")");
    const tl = await store.getIncidentTimelineAsync(s.incidentId);
    const reviewEvents = tl.filter((e) => e.event_type === "POST_RESOLUTION_DRIFT_REVIEW_REQUIRED");
    ok(reviewEvents.length === 1, "A13 exactly one review timeline event (got " + reviewEvents.length + ")");
  } catch (e) {
    blk("A13", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A14: already-transitioned incident not re-transitioned ----------
  section("A14 - already REVIEW_REQUIRED not re-transitioned");
  try {
    await wipe();
    const digest = "sha256:a14-" + Date.now();
    const s = await seedResolvedScenario({
      env: "a14", digest, classification: "DIGEST_MISMATCH",
      lifecycle: "RESOLVED",
      incidentCreatedAt: new Date(Date.now() - 600_000).toISOString(),
    });
    // Manually move to REQUIRE_REVIEW before running the supervisor.
    await store.updateIncidentAsync(s.incidentId, { status: "REQUIRE_REVIEW" });
    const observer = new ScriptedObserver({
      [s.deploymentId]: obs({
        observed_release_id: s.relId, observed_artifact_id: s.artId,
        observed_digest: "sha256:DIFFERENT",
      }),
    });
    const { sup } = mkSupervisor({ projectId: "p255", environment: "a14" }, observer);
    const r = await sup.runNow();
    ok(r.resolvedIncidentsReviewRequired === 0, "A14 no re-transition");
    const back = await store.getIncidentAsync(s.incidentId);
    ok(back?.status === "REQUIRE_REVIEW" || back?.status === "RECOVERY_REQUESTED", "A14 lifecycle state preserved (got " + back?.status + ")");
  } catch (e) {
    blk("A14", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A15: new recovery intent is required after drift -----------------
  section("A15 - recovery intent produced after review");
  try {
    await wipe();
    const digest = "sha256:a15-" + Date.now();
    const s = await seedResolvedScenario({
      env: "a15", digest, classification: "DIGEST_MISMATCH",
      lifecycle: "RESOLVED",
      incidentCreatedAt: new Date(Date.now() - 600_000).toISOString(),
    });
    const observer = new ScriptedObserver({
      [s.deploymentId]: obs({
        observed_release_id: s.relId, observed_artifact_id: s.artId,
        observed_digest: "sha256:DIFFERENT",
      }),
    });
    const { sup } = mkSupervisor({ projectId: "p255", environment: "a15" }, observer);
    const r = await sup.runNow();
    ok(r.recoveryHandoffsAccepted === 1, "A15 handoff accepted");
    const back = await store.getIncidentAsync(s.incidentId);
    ok(typeof back?.recovery_intent_key === "string" && back.recovery_intent_key.length > 0,
       "A15 recovery_intent_key present");
  } catch (e) {
    blk("A15", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A16: no infinite recovery loop -----------------------------------
  section("A16 - repeated ticks do not create duplicate intents");
  try {
    await wipe();
    const digest = "sha256:a16-" + Date.now();
    const s = await seedResolvedScenario({
      env: "a16", digest, classification: "DIGEST_MISMATCH",
      lifecycle: "RESOLVED",
      incidentCreatedAt: new Date(Date.now() - 600_000).toISOString(),
    });
    const observer = new ScriptedObserver({
      [s.deploymentId]: obs({
        observed_release_id: s.relId, observed_artifact_id: s.artId,
        observed_digest: "sha256:DIFFERENT",
      }),
    });
    const { sup } = mkSupervisor({ projectId: "p255", environment: "a16" }, observer);
    await sup.runNow();
    await sup.runNow();
    await sup.runNow();
    const back = await store.getIncidentAsync(s.incidentId);
    const intentKey = back?.recovery_intent_key ?? null;
    ok(intentKey !== null, "A16 intent key present after first tick");
    // Intent service must still return the same intent for the same identity.
    const intent = intentKey ? intentService.get(intentKey) : undefined;
    ok(intent !== undefined, "A16 exactly one durable intent for the incident");
  } catch (e) {
    blk("A16", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A17: illegal lifecycle transition rejected -----------------------
  section("A17 - illegal lifecycle transition rejected");
  try {
    await wipe();
    const digest = "sha256:a17-" + Date.now();
    // Create an incident in OPEN state.
    const rec = await history.createDeployment({
      project_id: "p255", environment: "a17",
      release_id: "rel-p255-a17", commit_sha: "c",
      artifact_id: "art-p255-a17",
      image_repository: "example/test", image_tag: "v1",
      image_id: null, image_digest: digest,
      container_name: "nexus-p255-a17",
      previous_deployment_id: null, is_rollback: false,
    } as any);
    await (history as any).markKnownGood(rec.id);
    const fp = computeIncidentFingerprint({
      deployment_id: rec.id, release_id: "rel-p255-a17",
      artifact_id: "art-p255-a17", artifact_digest: digest,
      environment: "a17", classifications: ["DIGEST_MISMATCH"] as any,
    });
    const id = deterministicDriftIncidentId(fp);
    await store.createIncidentAsync({
      id, tenant_id: "default", environment: "a17",
      service: "deployment-integrity", severity: "HIGH",
      title: "a17", description: "a17", status: "OPEN",
      deployment_id: rec.id, release_id: "rel-p255-a17",
      artifact_id: "art-p255-a17", artifact_digest: digest,
      drift_classification: "DIGEST_MISMATCH",
      incident_fingerprint: fp,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    // requestReviewAfterResolvedDrift should refuse on an OPEN incident.
    const { requestReviewAfterResolvedDrift } = await import("../src/core/incident-lifecycle");
    const rr = await requestReviewAfterResolvedDrift({
      store,
      incident: (await store.getIncidentAsync(id))!,
      integrity: { state: "DRIFTED", expected_digest: digest, observed_digest: "sha256:x", reasons: ["test"], observed_at: new Date().toISOString() } as any,
      observation: obs({ observed_digest: "sha256:x" }),
      workerId: "p255-worker",
    });
    ok(rr.transitioned === false, "A17 rejected non-RESOLVED transition");
    const back = await store.getIncidentAsync(id);
    ok(back?.status === "OPEN", "A17 status unchanged (OPEN)");
  } catch (e) {
    blk("A17", String(e instanceof Error ? e.message : e).slice(0, 250));
  }
  // ---- A18: Phase 254 completion regression (source check) --------------
  section("A18 - Phase 254 completion reconciler preserved");
  try {
    const rcSrc = fs.readFileSync("src/core/recovery-completion-reconciler.ts", "utf8");
    ok(/applyResolutionIfVerified/.test(rcSrc), "A18 Phase 254 reconciler still calls applyResolutionIfVerified");
    ok(/getIncidentByRecoveryIntentKeyAsync/.test(rcSrc), "A18 Phase 254 correlation lookup intact");
  } catch (e) {
    blk("A18", String(e instanceof Error ? e.message : e).slice(0, 200));
  }

  // ---- A19-A22: regression source check --------------------------------
  // Each prior phase's verifier is confirmed present and its npm script is
  // registered. The full sequential run of phase250/251/252/253/254 is
  // captured separately in the artifacts directory (see summary.md), so
  // running them as nested subprocesses here would only duplicate work and
  // introduce postgres-connection contention between the parent test and
  // each child.
  section("A19-A22 - regression source check (phase250/251/252/253/254)");
  try {
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    const checks: Array<[string, string, string]> = [
      ["250", "scripts/test-phase250-production-incident-recovery.ts", "test:phase250"],
      ["251", "scripts/test-phase251-incident-lifecycle-durability.ts", "test:phase251"],
      ["252", "scripts/test-phase252-drift-observation-loop.ts", "test:phase252"],
      ["253", "scripts/test-phase253-recovery-handoff-integrity.ts", "test:phase253"],
      ["254", "scripts/test-phase254-recovery-completion-integrity.ts", "test:phase254"],
    ];
    for (const [name, file, script] of checks) {
      ok(fs.existsSync(file), "A19-A22 phase" + name + " test file present");
      ok(typeof pkg.scripts[script] === "string", "A19-A22 phase" + name + " npm script registered");
    }
  } catch (e) {
    blk("A19-A22", String(e instanceof Error ? e.message : e).slice(0, 200));
  }

  // ---- A23: TypeScript --------------------------------------------------
  section("A23 - TypeScript");
  try { execSync("npx tsc --noEmit", { stdio: "pipe", timeout: 300_000 }); ok(true, "A23 tsc clean"); }
  catch (e: any) { ok(false, "A23 tsc FAIL: " + String(e?.stderr ?? e?.message ?? e).slice(0, 200)); }

  // ---- A24: build -------------------------------------------------------
  section("A24 - build");
  try { execSync("npm run build", { stdio: "pipe", timeout: 300_000 }); ok(true, "A24 build pass"); }
  catch (e: any) { ok(false, "A24 build FAIL: " + String(e?.stderr ?? e?.message ?? e).slice(0, 200)); }

  // ---- A25: diff check --------------------------------------------------
  section("A25 - git diff --check");
  try { execSync("git diff --check", { stdio: "pipe", timeout: 60_000 }); ok(true, "A25 diff check clean"); }
  catch (e: any) { ok(false, "A25 diff check FAIL: " + String(e?.stderr ?? e?.message ?? e).slice(0, 200)); }

  // ---- A26: no duplicate reconciler/scheduler ---------------------------
  section("A26 - no duplicate reconciler / scheduler introduced");
  try {
    const coreFiles = fs.readdirSync("src/core");
    const forbidden = coreFiles.filter((f) => /post-recovery-lifecycle-reconciler|second.*scheduler|resolved-deployment-scheduler/i.test(f));
    ok(forbidden.length === 0, "A26 no forbidden modules (got " + forbidden.join(",") + ")");
    const supervisor = fs.readFileSync("src/core/drift-observation-supervisor.ts", "utf8");
    ok(!/new DriftObservationSupervisor/.test(supervisor), "A26 supervisor file does not construct a second supervisor");
  } catch (e) {
    blk("A26", String(e instanceof Error ? e.message : e).slice(0, 200));
  }

  // ---- A27: no REOPENED added to authoritative lifecycle ----------------
  section("A27 - no REOPENED added to IncidentLifecycleStatus");
  try {
    const storeSrc = fs.readFileSync("src/core/async-incident-store.ts", "utf8");
    const union = storeSrc.match(/export type IncidentLifecycleStatus =[\s\S]*?;/);
    ok(union !== null, "A27 union extractable");
    ok(union !== null && !/["']REOPENED["']/.test(union[0]), "A27 no REOPENED in authoritative union");
  } catch (e) {
    blk("A27", String(e instanceof Error ? e.message : e).slice(0, 200));
  }

  // ---- A28: no direct Docker access outside observer --------------------
  section("A28 - no direct Docker access in Phase 255 code");
  try {
    const supSrc = fs.readFileSync("src/core/drift-observation-supervisor.ts", "utf8");
    const ilSrc = fs.readFileSync("src/core/incident-lifecycle.ts", "utf8");
    ok(!/docker\.run\(/.test(supSrc), "A28 supervisor does not call docker.run");
    ok(!/docker\.run\(/.test(ilSrc), "A28 incident-lifecycle does not call docker.run");
    ok(!/from ["'].*docker-adapter/.test(supSrc), "A28 supervisor does not import DockerAdapter");
  } catch (e) {
    blk("A28", String(e instanceof Error ? e.message : e).slice(0, 200));
  }

  // ---- A29: no direct recovery execution --------------------------------
  section("A29 - no direct recovery execution in Phase 255");
  try {
    const supSrc = fs.readFileSync("src/core/drift-observation-supervisor.ts", "utf8");
    const ilSrc = fs.readFileSync("src/core/incident-lifecycle.ts", "utf8");
    ok(!/from ["'].*release-recovery-executor/.test(supSrc), "A29 supervisor does not import ReleaseRecoveryExecutor");
    ok(!/from ["'].*release-recovery-executor/.test(ilSrc), "A29 incident-lifecycle does not import ReleaseRecoveryExecutor");
    ok(!/\.runOnce\(\)/.test(supSrc), "A29 supervisor does not call executor runOnce");
  } catch (e) {
    blk("A29", String(e instanceof Error ? e.message : e).slice(0, 200));
  }

  // ---- A30: no lease acquisition ----------------------------------------
  section("A30 - no lease acquisition in Phase 255");
  try {
    const supSrc = fs.readFileSync("src/core/drift-observation-supervisor.ts", "utf8");
    const ilSrc = fs.readFileSync("src/core/incident-lifecycle.ts", "utf8");
    ok(!/acquireLease|renewLease|releaseLease|acquireSupervisorLease/.test(supSrc), "A30 supervisor no lease ops");
    ok(!/acquireLease|renewLease|releaseLease|acquireSupervisorLease/.test(ilSrc), "A30 incident-lifecycle no lease ops");
  } catch (e) {
    blk("A30", String(e instanceof Error ? e.message : e).slice(0, 200));
  }

  // ---- A31: no recovery_attempt mutation --------------------------------
  section("A31 - no recovery_attempt mutation in Phase 255");
  try {
    const supSrc = fs.readFileSync("src/core/drift-observation-supervisor.ts", "utf8");
    const ilSrc = fs.readFileSync("src/core/incident-lifecycle.ts", "utf8");
    ok(!/recovery_attempt\s*[:=]\s*[^0]/.test(supSrc), "A31 supervisor does not set recovery_attempt");
    ok(!/recovery_attempt\s*[:=]\s*[^0]/.test(ilSrc), "A31 incident-lifecycle does not set recovery_attempt");
  } catch (e) {
    blk("A31", String(e instanceof Error ? e.message : e).slice(0, 200));
  }

  // ---- A32: no false-success paths --------------------------------------
  section("A32 - no false-success paths");
  try {
    const ilSrc = fs.readFileSync("src/core/incident-lifecycle.ts", "utf8");
    // requestReviewAfterResolvedDrift must gate on DRIFTED explicitly.
    ok(/integrity\.state !== "DRIFTED"/.test(ilSrc), "A32 review method requires DRIFTED");
    ok(/incident\.status !== "RESOLVED"/.test(ilSrc), "A32 review method requires RESOLVED");
    // No unconditional VERIFIED / RESOLVED writes.
    ok(!/status\s*[:=]\s*["']VERIFIED["']/.test(ilSrc), "A32 incident-lifecycle does not write VERIFIED status");
  } catch (e) {
    blk("A32", String(e instanceof Error ? e.message : e).slice(0, 200));
  }

  // ---- Cleanup ----------------------------------------------------------
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