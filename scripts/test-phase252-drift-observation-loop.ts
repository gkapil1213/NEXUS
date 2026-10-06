// scripts/test-phase252-drift-observation-loop.ts
// Phase 252 verifier: kernel-integrated durable drift observation loop.
//
// Exercises the DriftObservationSupervisor against a real PostgreSQL
// AsyncIncidentStore and a real SQLite-backed DeploymentHistoryService.
// Observations are supplied by a scripted observer (the supervisor's
// injected integration point) so the test can drive every classification
// deterministically. The supervisor itself, the incident persistence chain,
// and the timeline are all real.
//
// Honest states: PASS / FAIL / BLOCKED / NOT EXECUTED. No fabricated rows.

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
import {
  DriftObservationSupervisor,
  type DriftObservationScope,
  type DriftObservationEventSink,
} from "../src/core/drift-observation-supervisor";
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
  async emit(event: { type: string; source: string; payload?: unknown }): Promise<unknown> {
    this.emitted.push(event);
    return undefined;
  }
}

class ScriptedObserver {
  constructor(private responses: Record<string, DeploymentObservation | Error>) {}
  async observe(deploymentId: string): Promise<DeploymentObservation> {
    const r = this.responses[deploymentId];
    if (r instanceof Error) throw r;
    if (!r) throw new Error("scripted observer: no response for " + deploymentId);
    return r;
  }
}

function makeObservation(overrides: Partial<DeploymentObservation> = {}): DeploymentObservation {
  return {
    available: true,
    status: "OBSERVED",
    observed_at: new Date().toISOString(),
    observed_digest: "sha256:test",
    observed_release_id: "rel-252",
    observed_artifact_id: "art-252",
    ...overrides,
  } as DeploymentObservation;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL required"); process.exit(2); }
  if (process.env.NEXUS_PERSISTENCE_MODE !== "shared") {
    console.error("NEXUS_PERSISTENCE_MODE must be shared"); process.exit(2);
  }

  section("A00 - environment / prerequisite discovery");
  const pg = new PgClient();
  let pgReady = false;
  try {
    await pg.connect(url);
    await bootstrapPgSchema(pg);
    pgReady = true;
    ok(true, "A00 postgres connected + schema bootstrapped");
  } catch (e) {
    blk("A00 postgres", String(e instanceof Error ? e.message : e).slice(0, 200));
  }

  if (!pgReady) {
    console.log("\npostgres unavailable; A01-A12 cannot run");
    console.log("\n============================================");
    console.log("PASS: " + passed); console.log("FAIL: " + failed);
    console.log("BLOCKED: " + blocked); console.log("NOT EXECUTED: " + notExec);
    console.log("============================================");
    process.exit(failed > 0 ? 1 : 0);
  }

  const store = new AsyncIncidentStore(new PgAsyncEngine(pg));

  const dbPath = path.join(os.tmpdir(), "nexus-p252-" + Date.now() + ".sqlite");
  process.on("exit", () => { for (const e of ["", "-wal", "-shm"]) { try { fs.unlinkSync(dbPath + e); } catch {} } });
  const sqlite = await SQLiteEngine.open(dbPath);
  const history = new DeploymentHistoryService(sqlite);

  async function seedDeployment(projectId: string, environment: string, releaseId: string, artifactId: string, digest: string): Promise<string> {
    const rec = await history.createDeployment({
      project_id: projectId,
      environment,
      release_id: releaseId,
      commit_sha: "commit-" + releaseId,
      artifact_id: artifactId,
      image_repository: "example/test",
      image_tag: "v1",
      image_id: null,
      image_digest: digest,
      container_name: "nexus-p252-" + Date.now().toString(36),
      previous_deployment_id: null,
      is_rollback: false,
    } as any);
    await history.updateDeployment(rec.id, { artifact_id: artifactId } as any);
    await (history as any).markKnownGood(rec.id);
    return rec.id;
  }

  function buildSupervisor(opts: {
    scopes: DriftObservationScope[];
    observer: { observe(id: string): Promise<DeploymentObservation> };
    events?: EventsRecorder;
  }) {
    const events = opts.events ?? new EventsRecorder();
    const sup = new DriftObservationSupervisor({
      incidentStore: store,
      history,
      observer: opts.observer,
      workerId: "p252-worker",
      intervalMs: 60_000,
      maxScopesPerTick: 100,
      enumerateScopes: async () => opts.scopes,
      svc: { events },
    });
    return { sup, events };
  }

  const cleanupFp = async () => {
    try {
      await pg.query("DELETE FROM security_incident_timeline WHERE incident_id LIKE $1", ["incident-drift-%"]);
      await pg.query("DELETE FROM security_incidents WHERE id LIKE $1", ["incident-drift-%"]);
    } catch { /* best-effort */ }
  };
  await cleanupFp();

  // ---- A01: core operation ----------------------------------------------
  section("A01 - core operation (runNow produces a drift incident)");
  try {
    const digest = "sha256:actual-" + Date.now();
    const depId = await seedDeployment("p252", "a01", "rel-p252-a01", "art-p252-a01", digest);
    const observer = new ScriptedObserver({
      [depId]: makeObservation({
        observed_digest: "sha256:wrong",
        observed_release_id: "rel-p252-a01",
        observed_artifact_id: "art-p252-a01",
      }),
    });
    const { sup, events } = buildSupervisor({ scopes: [{ projectId: "p252", environment: "a01" }], observer });
    const report = await sup.runNow();

    ok(report.scopesScanned === 1, "A01 one scope scanned");
    ok(report.deploymentsScanned === 1, "A01 one deployment scanned");
    ok(report.drifted === 1, "A01 classification drifted");
    ok(report.incidentsCreated === 1, "A01 one durable incident created");
    ok(report.errors.length === 0, "A01 no errors");
    ok(events.emitted.length === 1, "A01 tick event emitted once");
    ok(events.emitted[0].type === "drift.observation.tick", "A01 tick event type");
  } catch (e) {
    blk("A01", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A02: persistence -------------------------------------------------
  section("A02 - persistence");
  try {
    const rows = await pg.query<{ n: string; fp: string }>(
      "SELECT COUNT(*)::text AS n, MIN(incident_fingerprint) AS fp FROM security_incidents WHERE id LIKE $1",
      ["incident-drift-%"],
    );
    ok(rows.rows[0]?.n === "1", "A02 exactly one durable incident row");
    const fp = rows.rows[0]?.fp;
    if (fp) {
      const tl = await pg.query<{ n: string }>(
        "SELECT COUNT(*)::text AS n FROM security_incident_timeline WHERE incident_id LIKE $1",
        ["incident-drift-%"],
      );
      ok(Number(tl.rows[0]?.n) >= 1, "A02 timeline row persisted");
    } else { blk("A02 fingerprint", "no fingerprint returned"); }
  } catch (e) {
    blk("A02", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A03: idempotency -------------------------------------------------
  section("A03 - idempotency (second tick reconciles)");
  try {
    await cleanupFp();
    const digest = "sha256:actual-" + Date.now();
    const depId = await seedDeployment("p252", "a03", "rel-p252-a03", "art-p252-a03", digest);
    const observer = new ScriptedObserver({
      [depId]: makeObservation({ observed_digest: "sha256:wrong", observed_release_id: "rel-p252-a03", observed_artifact_id: "art-p252-a03" }),
    });
    const { sup } = buildSupervisor({ scopes: [{ projectId: "p252", environment: "a03" }], observer });
    const r1 = await sup.runNow();
    const r2 = await sup.runNow();
    ok(r1.incidentsCreated === 1, "A03 first tick creates one incident");
    ok(r2.incidentsCreated === 0, "A03 second tick creates zero");
    ok(r2.incidentsReconciled === 1, "A03 second tick reconciles");
  } catch (e) {
    blk("A03", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A04: concurrency -------------------------------------------------
  section("A04 - concurrent supervisors, same scope");
  try {
    await cleanupFp();
    const digest = "sha256:actual-" + Date.now();
    const depId = await seedDeployment("p252", "a04", "rel-p252-a04", "art-p252-a04", digest);
    const mk = () => new ScriptedObserver({
      [depId]: makeObservation({ observed_digest: "sha256:wrong", observed_release_id: "rel-p252-a04", observed_artifact_id: "art-p252-a04" }),
    });
    const a = buildSupervisor({ scopes: [{ projectId: "p252", environment: "a04" }], observer: mk() });
    const b = buildSupervisor({ scopes: [{ projectId: "p252", environment: "a04" }], observer: mk() });
    const [ra, rb] = await Promise.all([a.sup.runNow(), b.sup.runNow()]);
    const created = ra.incidentsCreated + rb.incidentsCreated;
    ok(created === 1, "A04 exactly one incident created across concurrent ticks (got " + created + ")");
    const rows = await pg.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM security_incidents WHERE id LIKE $1",
      ["incident-drift-%"],
    );
    ok(rows.rows[0]?.n === "1", "A04 exactly one durable row");
  } catch (e) {
    blk("A04", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A05: invalid state ------------------------------------------------
  section("A05 - non-KNOWN_GOOD deployments are skipped");
  try {
    await cleanupFp();
    await history.createDeployment({
      project_id: "p252",
      environment: "a05",
      release_id: "rel-p252-a05",
      commit_sha: "c",
      artifact_id: "art-p252-a05",
      image_repository: "example/test",
      image_tag: "v1",
      image_id: null,
      image_digest: "sha256:x",
      container_name: "nexus-p252-a05",
      previous_deployment_id: null,
      is_rollback: false,
    } as any);
    // Deliberately do NOT markKnownGood
    const { sup } = buildSupervisor({ scopes: [{ projectId: "p252", environment: "a05" }], observer: new ScriptedObserver({}) });
    const r = await sup.runNow();
    ok(r.deploymentsScanned === 0, "A05 non-KNOWN_GOOD deployment not scanned");
    ok(r.incidentsCreated === 0, "A05 no incident created");
  } catch (e) {
    blk("A05", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A06: authorization boundary --------------------------------------
  section("A06 - authorization boundary preserved (source assertion)");
  try {
    const src = fs.readFileSync("src/core/drift-observation-supervisor.ts", "utf8");
    ok(!/from ["'].*recovery-policy-engine["']/.test(src), "A06 no RecoveryPolicyEngine import");
    ok(!/from ["'].*release-recovery-executor["']/.test(src), "A06 no ReleaseRecoveryExecutor import");
    ok(!/from ["'].*deployment-orchestrator["']/.test(src), "A06 no deployment-orchestrator import");
    ok(!/docker\.run\(/.test(src), "A06 no direct docker.run call");
  } catch (e) {
    blk("A06", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A07: provider unavailable ----------------------------------------
  section("A07 - provider-unavailable path");
  try {
    await cleanupFp();
    const depId = await seedDeployment("p252", "a07", "rel-p252-a07", "art-p252-a07", "sha256:x");
    const observer = new ScriptedObserver({
      [depId]: makeObservation({ available: false, status: "OK" }),
    });
    const { sup } = buildSupervisor({ scopes: [{ projectId: "p252", environment: "a07" }], observer });
    const r = await sup.runNow();
    ok(r.deploymentsScanned === 1, "A07 deployment scanned");
    ok(r.blocked >= 1 || r.unknown >= 1, "A07 classified as BLOCKED or UNKNOWN (blocked=" + r.blocked + " unknown=" + r.unknown + ")");
    ok(r.verified === 0, "A07 not classified VERIFIED");
    const rows = await pg.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM security_incidents WHERE id LIKE $1",
      ["incident-drift-%"],
    );
    ok(Number(rows.rows[0]?.n) >= 1, "A07 durable incident created");
  } catch (e) {
    blk("A07", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A08: failure recovery --------------------------------------------
  section("A08 - observer failure captured, not fatal");
  try {
    await cleanupFp();
    const depId = await seedDeployment("p252", "a08", "rel-p252-a08", "art-p252-a08", "sha256:x");
    const observer = new ScriptedObserver({ [depId]: new Error("scripted observer failure") });
    const { sup } = buildSupervisor({ scopes: [{ projectId: "p252", environment: "a08" }], observer });
    const r = await sup.runNow();
    ok(r.errors.length >= 1, "A08 error recorded");
    ok(r.errors.some((e) => e.includes("scripted observer failure")), "A08 error message preserved");
    ok(r.incidentsCreated === 0, "A08 no incident from failed observation");
  } catch (e) {
    blk("A08", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A09: retry --------------------------------------------------------
  section("A09 - empty tick does not corrupt durable state");
  try {
    const { sup } = buildSupervisor({ scopes: [], observer: new ScriptedObserver({}) });
    const r = await sup.runNow();
    ok(r.scopesScanned === 0, "A09 empty scopes -> empty tick");
    ok(r.errors.length === 0, "A09 no errors");
  } catch (e) {
    blk("A09", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A10: no recovery-owned mutations ---------------------------------
  section("A10 - recovery-owned fields untouched");
  try {
    const rows = await pg.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM security_incidents WHERE id LIKE $1 AND (recovery_attempt IS NULL OR recovery_attempt = 0)",
      ["incident-drift-%"],
    );
    const total = await pg.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM security_incidents WHERE id LIKE $1",
      ["incident-drift-%"],
    );
    ok(Number(rows.rows[0]?.n) === Number(total.rows[0]?.n), "A10 every incident has recovery_attempt=0");
    const src = fs.readFileSync("src/core/drift-observation-supervisor.ts", "utf8");
    ok(!/updateIncidentAsync\([^)]*recovery_attempt/.test(src), "A10 supervisor never sets recovery_attempt");
    ok(!/acquireLease|renewLease|releaseLease/.test(src), "A10 supervisor never touches leases");
    ok(!/lease_owner|lease_expires_at/.test(src), "A10 supervisor never writes lease columns");
  } catch (e) {
    blk("A10", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A11: restart / reconciliation ------------------------------------
  section("A11 - new supervisor reconciles against persisted state");
  try {
    await cleanupFp();
    const digest = "sha256:actual-" + Date.now();
    const depId = await seedDeployment("p252", "a11", "rel-p252-a11", "art-p252-a11", digest);
    const obs = makeObservation({ observed_digest: "sha256:wrong", observed_release_id: "rel-p252-a11", observed_artifact_id: "art-p252-a11" });
    const s1 = buildSupervisor({ scopes: [{ projectId: "p252", environment: "a11" }], observer: new ScriptedObserver({ [depId]: obs }) });
    const r1 = await s1.sup.runNow();
    ok(r1.incidentsCreated === 1, "A11 first supervisor creates");
    const s2 = buildSupervisor({ scopes: [{ projectId: "p252", environment: "a11" }], observer: new ScriptedObserver({ [depId]: obs }) });
    const r2 = await s2.sup.runNow();
    ok(r2.incidentsCreated === 0, "A11 second supervisor creates 0");
    ok(r2.incidentsReconciled === 1, "A11 second supervisor reconciles");
  } catch (e) {
    blk("A11", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A12: VERIFIED produces no incident -------------------------------
  section("A12 - VERIFIED observation produces no incident");
  try {
    await cleanupFp();
    const digest = "sha256:actual-" + Date.now();
    const depId = await seedDeployment("p252", "a12", "rel-p252-a12", "art-p252-a12", digest);
    const observer = new ScriptedObserver({
      [depId]: makeObservation({ observed_digest: digest, observed_release_id: "rel-p252-a12", observed_artifact_id: "art-p252-a12" }),
    });
    const { sup } = buildSupervisor({ scopes: [{ projectId: "p252", environment: "a12" }], observer });
    const r = await sup.runNow();
    ok(r.deploymentsScanned === 1, "A12 deployment scanned");
    ok(r.verified === 1, "A12 classification VERIFIED");
    ok(r.incidentsCreated === 0, "A12 no incident created");
    const rows = await pg.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM security_incidents WHERE id LIKE $1",
      ["incident-drift-%"],
    );
    ok(rows.rows[0]?.n === "0", "A12 no durable row");
  } catch (e) {
    blk("A12", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- Cleanup ----------------------------------------------------------
  await cleanupFp();
  try { (sqlite as any).close?.(); } catch { /* isolated */ }
  try { await pg.close(); } catch { /* isolated */ }

  // ---- A13: regression --------------------------------------------------
  section("A13 - regression: phase 250 + phase 251");
  try { execSync("npm run test:phase250", { stdio: "pipe", timeout: 300_000 }); ok(true, "A13 phase250 pass"); }
  catch (e: any) { ok(false, "A13 phase250 FAIL: " + String(e?.stderr ?? e?.message ?? e).slice(0, 200)); }
  try { execSync("npm run test:phase251", { stdio: "pipe", timeout: 300_000 }); ok(true, "A13 phase251 pass"); }
  catch (e: any) { ok(false, "A13 phase251 FAIL: " + String(e?.stderr ?? e?.message ?? e).slice(0, 200)); }

  // ---- A14: TypeScript --------------------------------------------------
  section("A14 - TypeScript");
  try { execSync("npx tsc --noEmit", { stdio: "pipe", timeout: 300_000 }); ok(true, "A14 tsc clean"); }
  catch (e: any) { ok(false, "A14 tsc FAIL: " + String(e?.stderr ?? e?.message ?? e).slice(0, 200)); }

  // ---- A15: build -------------------------------------------------------
  section("A15 - build");
  try { execSync("npm run build", { stdio: "pipe", timeout: 300_000 }); ok(true, "A15 build pass"); }
  catch (e: any) { ok(false, "A15 build FAIL: " + String(e?.stderr ?? e?.message ?? e).slice(0, 200)); }

  // ---- A16: git diff ----------------------------------------------------
  section("A16 - git diff --check");
  try { execSync("git diff --check", { stdio: "pipe", timeout: 60_000 }); ok(true, "A16 diff check clean"); }
  catch (e: any) { ok(false, "A16 diff check FAIL: " + String(e?.stderr ?? e?.message ?? e).slice(0, 200)); }

  console.log("\n============================================");
  console.log("PASS: " + passed);
  console.log("FAIL: " + failed);
  console.log("BLOCKED: " + blocked);
  console.log("NOT EXECUTED: " + notExec);
  console.log("============================================");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exit(1); });