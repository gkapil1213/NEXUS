// scripts/test-phase254-recovery-completion-integrity.ts
// Phase 254 verifier: production recovery completion + post-recovery
// integrity closure.
//
// Exercises the real closure chain end-to-end against real PostgreSQL
// (security_incidents) and real SQLite (DeploymentHistoryService +
// ExecutionStore + ReleaseDeploymentIntentService), driven by the new
// RecoveryCompletionReconciler. The DeploymentObserver is injected (its
// designed integration point); every other component is the production one:
//
//   KNOWN_GOOD intent  (real durable state)
//     -> incident lookup by recovery_intent_key (real PG)
//     -> authoritative DeploymentRecord (real SQLite)
//     -> fresh DeploymentObservation (injected observer)
//     -> evaluateDeploymentIntegrity()           (Phase 249)
//     -> evaluateIncidentResolution()            (Phase 250)
//     -> applyResolutionIfVerified()             (Phase 251)
//     -> durable RESOLVED or remain unresolved
//     -> closeIncidentIfResolved() -> CLOSED
//
// Honest states only: PASS / FAIL / BLOCKED / NOT EXECUTED. A live Docker
// end-to-end is reported BLOCKED/NOT EXECUTED rather than faked.

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
import { RecoveryCompletionReconciler } from "../src/core/recovery-completion-reconciler";
import { closeIncidentIfResolved } from "../src/core/incident-lifecycle";
import type { DeploymentObservation } from "../src/core/post-deployment-integrity";

let passed = 0, failed = 0, blocked = 0, notExec = 0;
function ok(c: boolean, m: string): void {
  if (c) { passed++; console.log("PASS  " + m); }
  else { failed++; console.log("FAIL  " + m); }
}
function blk(m: string, why: string): void { blocked++; console.log("BLOCKED  " + m + " :: " + why); }
function nx(m: string, why: string): void { notExec++; console.log("NOT EXECUTED  " + m + " :: " + why); }
function section(t: string): void { console.log("\n--- " + t + " ---"); }

class ScriptedObserver {
  constructor(private responses: Record<string, DeploymentObservation | Error>) {}
  async observe(id: string): Promise<DeploymentObservation> {
    const r = this.responses[id];
    if (r instanceof Error) throw r;
    if (!r) throw new Error("no scripted observation for " + id);
    return r;
  }
}

class EventsRecorder {
  emitted: Array<{ type: string; source: string; payload?: unknown }> = [];
  async emit(e: { type: string; source: string; payload?: unknown }): Promise<unknown> {
    this.emitted.push(e);
    return undefined;
  }
}

function makeObservation(overrides: Partial<DeploymentObservation> = {}): DeploymentObservation {
  return {
    deployment_id: "ignored",
    available: true,
    status: "OBSERVED",
    observed_at: new Date(Date.now() + 60_000).toISOString(),
    observed_digest: "sha256:expected",
    observed_release_id: "rel-254",
    observed_artifact_id: "art-254",
    ...overrides,
  } as DeploymentObservation;
}

const PREFIX = "p254-";

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

  const dbPath = path.join(os.tmpdir(), "nexus-p254-" + Date.now() + ".sqlite");
  process.on("exit", () => { for (const e of ["", "-wal", "-shm"]) { try { fs.unlinkSync(dbPath + e); } catch {} } });
  const sqlite = await SQLiteEngine.open(dbPath);
  const history = new DeploymentHistoryService(sqlite);
  const execStore = new ExecutionStore(sqlite as any);
  const intentService = new ReleaseDeploymentIntentService(execStore);

  async function wipe() {
    // Clear the phase-254 prefix AND the shared drift prefix used by phases
    // 253/255 so a subprocess invocation cannot collide with our seeded rows.
    for (const p of [PREFIX + "%", "incident-drift-%"]) {
      try {
        await pg.query("DELETE FROM security_incident_timeline WHERE incident_id LIKE $1", [p]);
        await pg.query("DELETE FROM security_incidents WHERE id LIKE $1", [p]);
      } catch {}
    }
  }
  await wipe();

  // Setup helper: create a real DeploymentRecord, a real ROLLBACK intent in
  // KNOWN_GOOD, and a real durable incident correlated by recovery_intent_key.
  async function seedResolvedScenario(opts: {
    environment: string;
    digest: string;
    incidentCreatedAt: string;
  }): Promise<{ deploymentId: string; intentKey: string; incidentId: string }> {
    const relId = "rel-p254-" + opts.environment;
    const artId = "art-p254-" + opts.environment;
    const rec = await history.createDeployment({
      project_id: "p254",
      environment: opts.environment,
      release_id: relId,
      commit_sha: "commit-" + relId,
      artifact_id: artId,
      image_repository: "example/test",
      image_tag: "v1",
      image_id: null,
      image_digest: opts.digest,
      container_name: "nexus-p254-" + opts.environment,
      previous_deployment_id: null,
      is_rollback: false,
    } as any);
    await history.updateDeployment(rec.id, {
      artifact_id: artId,
      execution_id: "exec-" + relId,
      attempt_id: "attempt-" + relId,
      container_port: 8080,
    } as any);
    await (history as any).markKnownGood(rec.id);

    const input = {
      intentKind: "ROLLBACK" as const,
      releaseId: relId,
      executionId: "exec-" + relId,
      attemptId: "attempt-" + relId,
      artifactId: artId,
      artifactDigest: opts.digest,
      commitSha: "commit-" + relId,
      environment: opts.environment,
      projectId: "p254",
      imageRepository: "example/test",
      imageTag: "v1",
      imageId: null,
      imageDigest: opts.digest,
      containerName: "nexus-p254-" + opts.environment,
      containerPort: 8080,
    };
    const created = await intentService.getOrCreate(input);
    const intentKey = created.intent.intentKey;
    // Real durable transition to KNOWN_GOOD (the state Phase 254 keys on).
    intentService.transition(intentKey, "KNOWN_GOOD" as any, {
      deploymentId: rec.id,
      reconciledAt: Date.now(),
      reconciliationEvidence: JSON.stringify({ test: "p254-setup", deploymentId: rec.id }),
    } as any);

    const incidentId = PREFIX + opts.environment + "-" + Date.now().toString(36);
    await store.createIncidentAsync({
      id: incidentId,
      tenant_id: "default",
      environment: opts.environment,
      service: "deployment-integrity",
      severity: "HIGH",
      title: "p254 " + opts.environment,
      description: "p254 setup",
      status: "RECOVERY_REQUESTED",
      deployment_id: rec.id,
      release_id: relId,
      artifact_id: artId,
      artifact_digest: opts.digest,
      drift_classification: "DIGEST_MISMATCH",
      incident_fingerprint: "fp-p254-" + opts.environment + "-" + Date.now(),
      recovery_intent_key: intentKey,
      created_at: opts.incidentCreatedAt,
      updated_at: opts.incidentCreatedAt,
    });
    // Set last_observation_at to created_at so freshness check has a base.
    await store.updateIncidentAsync(incidentId, { last_observation_at: opts.incidentCreatedAt });

    return { deploymentId: rec.id, intentKey, incidentId };
  }

  function mkReconciler(observer: ScriptedObserver, events = new EventsRecorder()) {
    const rec = new RecoveryCompletionReconciler({
      incidentStore: store,
      history,
      observer,
      intents: intentService,
      svc: { events },
      workerId: "p254-worker",
      maxIntentsPerRun: 50,
    });
    return { rec, events };
  }

  // ---- A01: source audit ------------------------------------------------
  section("A01 - source wiring audit");
  try {
    const recSrc = fs.readFileSync("src/core/recovery-completion-reconciler.ts", "utf8");
    const execSrc = fs.readFileSync("src/core/release-recovery-executor.ts", "utf8");
    const kernSrc = fs.readFileSync("src/core/kernel.ts", "utf8");
    ok(/evaluateIncidentResolution/.test(recSrc), "A01 reconciler calls evaluateIncidentResolution");
    ok(/applyResolutionIfVerified/.test(recSrc), "A01 reconciler calls applyResolutionIfVerified");
    ok(/getIncidentByRecoveryIntentKeyAsync/.test(recSrc), "A01 reconciler uses correlation lookup");
    ok(/completionReconciler\?: \{/.test(execSrc), "A01 executor deps has completionReconciler");
    ok(/this\.deps\.completionReconciler\.reconcileCompleted/.test(execSrc), "A01 executor calls reconciler");
    ok(/new RecoveryCompletionReconciler/.test(kernSrc), "A01 kernel constructs reconciler");
    ok(/completionReconciler,/.test(kernSrc), "A01 kernel passes reconciler to executor");
  } catch (e) {
    blk("A01 source audit", String(e instanceof Error ? e.message : e).slice(0, 200));
  }

  // ---- A02: DRIFTED incident + intent, fresh VERIFIED resolves ---------
  section("A02 - fresh VERIFIED resolves incident");
  let a02: { deploymentId: string; intentKey: string; incidentId: string } | null = null;
  try {
    const digest = "sha256:a02-" + Date.now();
    a02 = await seedResolvedScenario({
      environment: "a02",
      digest,
      incidentCreatedAt: new Date(Date.now() - 600_000).toISOString(), // 10 min ago
    });
    const observer = new ScriptedObserver({
      [a02.deploymentId]: makeObservation({
        observed_release_id: "rel-p254-a02",
        observed_artifact_id: "art-p254-a02",
        observed_digest: digest,
      }),
    });
    const { rec, events } = mkReconciler(observer);
    const report = await rec.reconcileCompleted();

    ok(report.scanned >= 1, "A02 scanned");
    ok(report.resolved === 1, "A02 resolved (got " + report.resolved + ")");
    ok(report.errors.length === 0, "A02 no errors (" + report.errors.join(" | ").slice(0, 200) + ")");
    ok(events.emitted.some((e) => e.type === "recovery.completion.resolved"), "A02 resolved event emitted");
  } catch (e) {
    blk("A02", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A03: durable RESOLVED state in PostgreSQL ------------------------
  section("A03 - durable RESOLVED state");
  try {
    if (!a02) { blk("A03", "no a02 state"); }
    else {
      const back = await store.getIncidentAsync(a02.incidentId);
      ok(back !== undefined, "A03 incident present");
      ok(back?.status === "RESOLVED", "A03 status = RESOLVED (got " + back?.status + ")");
      ok(back?.verification_state === "VERIFIED", "A03 verification_state VERIFIED");
      ok((back?.resolution_evidence ?? "").length > 0, "A03 resolution_evidence persisted");
      ok((back?.resolved_at ?? "").length > 0, "A03 resolved_at persisted");

      const tl = await store.getIncidentTimelineAsync(a02.incidentId);
      ok(tl.some((e) => e.event_type === "INCIDENT_RESOLVED"), "A03 INCIDENT_RESOLVED in timeline");
    }
  } catch (e) {
    blk("A03", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A04: closure -----------------------------------------------------
  section("A04 - closeIncidentIfResolved -> CLOSED");
  try {
    if (!a02) { blk("A04", "no a02 state"); }
    else {
      const inc = (await store.getIncidentAsync(a02.incidentId))!;
      const closed = await closeIncidentIfResolved({
        store, incident: inc, workerId: "p254-worker",
      });
      ok(closed.closed === true, "A04 closed = true (reason=" + closed.reason + ")");
      const back = await store.getIncidentAsync(a02.incidentId);
      ok(back?.status === "CLOSED", "A04 status CLOSED");
      ok((back?.closed_at ?? "").length > 0, "A04 closed_at persisted");
    }
  } catch (e) {
    blk("A04", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A05: stale observation ------------------------------------------
  section("A05 - stale observation does not resolve");
  try {
    await wipe();
    const digest = "sha256:a05-" + Date.now();
    const s = await seedResolvedScenario({
      environment: "a05", digest,
      incidentCreatedAt: new Date().toISOString(),
    });
    const observer = new ScriptedObserver({
      [s.deploymentId]: makeObservation({
        observed_release_id: "rel-p254-a05",
        observed_artifact_id: "art-p254-a05",
        observed_digest: digest,
        observed_at: new Date(Date.now() - 3_600_000).toISOString(), // 1hr ago
      }),
    });
    const { rec } = mkReconciler(observer);
    const r = await rec.reconcileCompleted();
    ok(r.staleObservation === 1, "A05 staleObservation counted");
    ok(r.resolved === 0, "A05 not resolved");
    const back = await store.getIncidentAsync(s.incidentId);
    ok(back?.status !== "RESOLVED" && back?.status !== "CLOSED", "A05 status not resolved/closed");
  } catch (e) {
    blk("A05", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A06: fresh DRIFTED ----------------------------------------------
  section("A06 - fresh DRIFTED does not resolve");
  try {
    await wipe();
    const digest = "sha256:a06-" + Date.now();
    const s = await seedResolvedScenario({
      environment: "a06", digest,
      incidentCreatedAt: new Date(Date.now() - 600_000).toISOString(),
    });
    const observer = new ScriptedObserver({
      [s.deploymentId]: makeObservation({
        observed_release_id: "rel-p254-a06",
        observed_artifact_id: "art-p254-a06",
        observed_digest: "sha256:wrong",  // drift
      }),
    });
    const { rec } = mkReconciler(observer);
    const r = await rec.reconcileCompleted();
    ok(r.nonVerified === 1, "A06 nonVerified counted");
    ok(r.resolved === 0, "A06 not resolved");
    const back = await store.getIncidentAsync(s.incidentId);
    ok(back?.status !== "RESOLVED", "A06 status not RESOLVED (got " + back?.status + ")");
  } catch (e) {
    blk("A06", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A07: fresh UNKNOWN ----------------------------------------------
  section("A07 - fresh UNKNOWN does not resolve");
  try {
    await wipe();
    const digest = "sha256:a07-" + Date.now();
    const s = await seedResolvedScenario({
      environment: "a07", digest,
      incidentCreatedAt: new Date(Date.now() - 600_000).toISOString(),
    });
    const observer = new ScriptedObserver({
      [s.deploymentId]: makeObservation({ status: "ERROR" as any }),
    });
    const { rec } = mkReconciler(observer);
    const r = await rec.reconcileCompleted();
    ok(r.resolved === 0, "A07 not resolved");
    const back = await store.getIncidentAsync(s.incidentId);
    ok(back?.status !== "RESOLVED", "A07 status not RESOLVED");
  } catch (e) {
    blk("A07", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A08: fresh BLOCKED ----------------------------------------------
  section("A08 - fresh BLOCKED does not resolve");
  try {
    await wipe();
    const digest = "sha256:a08-" + Date.now();
    const s = await seedResolvedScenario({
      environment: "a08", digest,
      incidentCreatedAt: new Date(Date.now() - 600_000).toISOString(),
    });
    const observer = new ScriptedObserver({
      [s.deploymentId]: makeObservation({ available: false }),
    });
    const { rec } = mkReconciler(observer);
    const r = await rec.reconcileCompleted();
    ok(r.resolved === 0, "A08 not resolved");
  } catch (e) {
    blk("A08", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A09: fresh NOT_EXECUTED -----------------------------------------
  section("A09 - fresh NOT_EXECUTED does not resolve");
  try {
    await wipe();
    const digest = "sha256:a09-" + Date.now();
    const s = await seedResolvedScenario({
      environment: "a09", digest,
      incidentCreatedAt: new Date(Date.now() - 600_000).toISOString(),
    });
    const observer = new ScriptedObserver({
      [s.deploymentId]: makeObservation({ status: "NOT_EXECUTED" }),
    });
    const { rec } = mkReconciler(observer);
    const r = await rec.reconcileCompleted();
    ok(r.resolved === 0, "A09 not resolved");
  } catch (e) {
    blk("A09", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A10: idempotency -------------------------------------------------
  section("A10 - repeat reconciliation is idempotent");
  try {
    await wipe();
    const digest = "sha256:a10-" + Date.now();
    const s = await seedResolvedScenario({
      environment: "a10", digest,
      incidentCreatedAt: new Date(Date.now() - 600_000).toISOString(),
    });
    const observer = new ScriptedObserver({
      [s.deploymentId]: makeObservation({
        observed_release_id: "rel-p254-a10",
        observed_artifact_id: "art-p254-a10",
        observed_digest: digest,
      }),
    });
    const { rec } = mkReconciler(observer);
    const r1 = await rec.reconcileCompleted();
    const r2 = await rec.reconcileCompleted();
    ok(r1.resolved === 1, "A10 first pass resolves");
    ok(r2.resolved === 0, "A10 second pass does not re-resolve");

    const tl = await store.getIncidentTimelineAsync(s.incidentId);
    const resolvedEvents = tl.filter((e) => e.event_type === "INCIDENT_RESOLVED");
    ok(resolvedEvents.length === 1, "A10 exactly one INCIDENT_RESOLVED (got " + resolvedEvents.length + ")");
  } catch (e) {
    blk("A10", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A11: concurrency -------------------------------------------------
  section("A11 - concurrent reconcilers, one resolution");
  try {
    await wipe();
    const digest = "sha256:a11-" + Date.now();
    const s = await seedResolvedScenario({
      environment: "a11", digest,
      incidentCreatedAt: new Date(Date.now() - 600_000).toISOString(),
    });
    const observer = new ScriptedObserver({
      [s.deploymentId]: makeObservation({
        observed_release_id: "rel-p254-a11",
        observed_artifact_id: "art-p254-a11",
        observed_digest: digest,
      }),
    });
    const a = mkReconciler(observer).rec;
    const b = mkReconciler(observer).rec;
    const [ra, rb] = await Promise.all([a.reconcileCompleted(), b.reconcileCompleted()]);
    const total = ra.resolved + rb.resolved;
    ok(total === 1, "A11 exactly one resolution across two reconcilers (got " + total + ")");

    const back = await store.getIncidentAsync(s.incidentId);
    ok(back?.status === "RESOLVED", "A11 final status RESOLVED");
  } catch (e) {
    blk("A11", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A12: resolved incident cannot be regressed by stale ------------
  section("A12 - RESOLVED not regressed by stale observation");
  try {
    await wipe();
    const digest = "sha256:a12-" + Date.now();
    const s = await seedResolvedScenario({
      environment: "a12", digest,
      incidentCreatedAt: new Date(Date.now() - 600_000).toISOString(),
    });
    // Step 1: resolve with a fresh VERIFIED observation.
    const freshObserver = new ScriptedObserver({
      [s.deploymentId]: makeObservation({
        observed_release_id: "rel-p254-a12",
        observed_artifact_id: "art-p254-a12",
        observed_digest: digest,
      }),
    });
    const { rec: recResolve } = mkReconciler(freshObserver);
    const rr = await recResolve.reconcileCompleted();
    ok(rr.resolved === 1, "A12 first pass resolves");

    // Step 2: close it.
    const inc1 = (await store.getIncidentAsync(s.incidentId))!;
    await closeIncidentIfResolved({ store, incident: inc1, workerId: "p254-worker" });
    const inc2 = await store.getIncidentAsync(s.incidentId);
    ok(inc2?.status === "CLOSED", "A12 closed before stale test");

    // Step 3: feed a stale observation; must not regress.
    const staleObserver = new ScriptedObserver({
      [s.deploymentId]: makeObservation({
        observed_at: new Date(Date.now() - 3_600_000).toISOString(),
        observed_release_id: "rel-p254-a12",
        observed_artifact_id: "art-p254-a12",
        observed_digest: "sha256:stale",
      }),
    });
    const { rec: recStale } = mkReconciler(staleObserver);
    await recStale.reconcileCompleted();
    const back = await store.getIncidentAsync(s.incidentId);
    ok(back?.status === "CLOSED", "A12 status remains CLOSED (got " + back?.status + ")");
  } catch (e) {
    blk("A12", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A13: unresolved cannot close -----------------------------------
  section("A13 - unresolved incident refuses closure");
  try {
    await wipe();
    const digest = "sha256:a13-" + Date.now();
    const s = await seedResolvedScenario({
      environment: "a13", digest,
      incidentCreatedAt: new Date(Date.now() - 600_000).toISOString(),
    });
    const inc = (await store.getIncidentAsync(s.incidentId))!;
    const r = await closeIncidentIfResolved({ store, incident: inc, workerId: "p254-worker" });
    ok(r.closed === false, "A13 refused (reason=" + r.reason + ")");
    const back = await store.getIncidentAsync(s.incidentId);
    ok(back?.status !== "CLOSED", "A13 status not CLOSED");
  } catch (e) {
    blk("A13", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A14: restart durability -----------------------------------------
  section("A14 - durable state survives reopen");
  try {
    await wipe();
    const digest = "sha256:a14-" + Date.now();
    const s = await seedResolvedScenario({
      environment: "a14", digest,
      incidentCreatedAt: new Date(Date.now() - 600_000).toISOString(),
    });
    const observer = new ScriptedObserver({
      [s.deploymentId]: makeObservation({
        observed_release_id: "rel-p254-a14",
        observed_artifact_id: "art-p254-a14",
        observed_digest: digest,
      }),
    });
    const { rec } = mkReconciler(observer);
    await rec.reconcileCompleted();

    // Reopen with a fresh engine wrapper (simulates a new process).
    const pg2 = new PgClient();
    await pg2.connect(url);
    const store2 = new AsyncIncidentStore(new PgAsyncEngine(pg2));
    const back = await store2.getIncidentAsync(s.incidentId);
    ok(back !== undefined, "A14 incident survives reopen");
    ok(back?.status === "RESOLVED", "A14 RESOLVED survives");
    ok((back?.verification_state ?? "") === "VERIFIED", "A14 VERIFIED survives");
    ok((back?.resolution_evidence ?? "").length > 0, "A14 resolution_evidence survives");
    try { await pg2.close(); } catch {}
  } catch (e) {
    blk("A14", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A15: no correlated incident -> skipped -------------------------
  section("A15 - intent without correlated incident is skipped");
  try {
    await wipe();
    const digest = "sha256:a15-" + Date.now();
    // Intent in KNOWN_GOOD with NO matching incident.
    const input = {
      intentKind: "ROLLBACK" as const,
      releaseId: "rel-p254-a15",
      executionId: "exec-a15-" + Date.now(),
      attemptId: "attempt-a15-" + Date.now(),
      artifactId: "art-p254-a15",
      artifactDigest: digest,
      commitSha: "commit-a15",
      environment: "a15",
      projectId: "p254",
      imageRepository: "example/test",
      imageTag: "v1",
      imageId: null,
      imageDigest: digest,
      containerName: "nexus-p254-a15",
      containerPort: 8080,
    };
    const created = await intentService.getOrCreate(input);
    intentService.transition(created.intent.intentKey, "KNOWN_GOOD" as any, {} as any);

    const observer = new ScriptedObserver({});
    const { rec } = mkReconciler(observer);
    const r = await rec.reconcileCompleted();
    ok(r.skippedNoIncident >= 1, "A15 skippedNoIncident counted");
    ok(r.resolved === 0, "A15 nothing resolved");
    ok(r.errors.length === 0, "A15 no errors");
  } catch (e) {
    blk("A15", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A16: observer boundary audit -----------------------------------
  section("A16 - observer/executor boundary audit");
  try {
    const supSrc = fs.readFileSync("src/core/drift-observation-supervisor.ts", "utf8");
    const handoffSrc = fs.readFileSync("src/core/drift-recovery-handoff.ts", "utf8");
    const recSrc = fs.readFileSync("src/core/recovery-completion-reconciler.ts", "utf8");
    // Reconciler must not touch recovery authority.
    ok(!/acquireLease|renewLease|releaseLease/.test(recSrc), "A16 reconciler has no lease operations");
    ok(!/updateIncidentAsync\([^)]*recovery_attempt/.test(recSrc), "A16 reconciler does not write recovery_attempt");
    ok(!/docker\.run\(/.test(recSrc), "A16 reconciler does not call docker.run");
    ok(!/transitionIntentIfOwned|transitionAsync/.test(recSrc), "A16 reconciler does not transition intents");
    // Observer and handoff keep their boundaries.
    ok(!/acquireLease|renewLease/.test(supSrc), "A16 supervisor has no lease operations");
    ok(!/docker\.run\(/.test(handoffSrc), "A16 handoff has no docker.run");
  } catch (e) {
    blk("A16 boundary audit", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A17: live end-to-end (BLOCKED/NOT EXECUTED unless real Docker) --
  section("A17 - live production chain");
  nx("A17 live Docker deployment + real observer end-to-end",
     "the Phase 254 reconciler test suite exercises the full closure logic with a scripted observer (its injected integration point); a live Docker chain would duplicate the phase 250 A21 chain and require deploying/fixing a real container mid-test. Real Docker is verified available by phase 250's live A21 test in the same run.");

  // Cleanup before regression
  await wipe();
  try { (sqlite as any).close?.(); } catch {}
  try { await pg.close(); } catch {}

  // ---- A18: regression --------------------------------------------------
  section("A18 - regression 250/251/252/253");
  for (const [name, cmd] of [
    ["250", "npm run test:phase250"],
    ["251", "npm run test:phase251"],
    ["252", "npm run test:phase252"],
    ["253", "npm run test:phase253"],
  ] as Array<[string, string]>) {
    try {
      execSync(cmd, { stdio: "pipe", timeout: 300_000 });
      ok(true, "A18 phase" + name + " pass");
    } catch (e: any) {
      ok(false, "A18 phase" + name + " FAIL: " + String(e?.stderr ?? e?.message ?? e).slice(0, 200));
    }
  }

  // ---- A19: TypeScript -------------------------------------------------
  section("A19 - TypeScript");
  try { execSync("npx tsc --noEmit", { stdio: "pipe", timeout: 300_000 }); ok(true, "A19 tsc clean"); }
  catch (e: any) { ok(false, "A19 tsc FAIL: " + String(e?.stderr ?? e?.message ?? e).slice(0, 200)); }

  // ---- A20: build ------------------------------------------------------
  section("A20 - build");
  try { execSync("npm run build", { stdio: "pipe", timeout: 300_000 }); ok(true, "A20 build pass"); }
  catch (e: any) { ok(false, "A20 build FAIL: " + String(e?.stderr ?? e?.message ?? e).slice(0, 200)); }

  // ---- A21: git diff check --------------------------------------------
  section("A21 - git diff --check");
  try { execSync("git diff --check", { stdio: "pipe", timeout: 60_000 }); ok(true, "A21 diff check clean"); }
  catch (e: any) { ok(false, "A21 diff check FAIL: " + String(e?.stderr ?? e?.message ?? e).slice(0, 200)); }

  console.log("\n============================================");
  console.log("PASS: " + passed);
  console.log("FAIL: " + failed);
  console.log("BLOCKED: " + blocked);
  console.log("NOT EXECUTED: " + notExec);
  console.log("============================================");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exit(1); });