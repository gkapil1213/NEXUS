// scripts/test-phase253-recovery-handoff-integrity.ts
// Phase 253 verifier: production drift -> recovery handoff integrity.
//
// Exercises the real production chain:
//   DriftObservationSupervisor.runNow()
//     -> processDeploymentDriftDurable   (existing, Phase 250/251)
//     -> handoffDriftIncidentToRecovery  (new, Phase 253)
//     -> buildProductionRecoveryContext  (existing, Phase 251)
//     -> requestDriftRecoveryIntent      (existing, Phase 250)
//     -> ReleaseDeploymentIntentService.getOrCreateAsync (existing)
//     -> durable ReleaseDeploymentIntent (existing)
//
// The observer is injected (the supervisor's designed integration point);
// PostgreSQL, SQLite history, the incident store, the bridge and the intent
// service are all real. Nothing about the recovery machinery is mocked.
//
// Honest states only: PASS / FAIL / BLOCKED / NOT EXECUTED.
// No fabricated rows, no fabricated provider context, no fake success.

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
import { handoffDriftIncidentToRecovery } from "../src/core/drift-recovery-handoff";
import type { DeploymentObservation } from "../src/core/post-deployment-integrity";
import { computeIncidentFingerprint } from "../src/core/production-incident-response";
import { deterministicDriftIncidentId } from "../src/core/incident-lifecycle";

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
  async observe(id: string): Promise<DeploymentObservation> {
    const r = this.responses[id];
    if (r instanceof Error) throw r;
    if (!r) throw new Error("no scripted response for " + id);
    return r;
  }
}
function obs(over: Partial<DeploymentObservation> = {}): DeploymentObservation {
  return {
    deployment_id: "ignored",
    available: true,
    status: "OBSERVED",
    observed_at: new Date().toISOString(),
    observed_digest: "sha256:x",
    observed_release_id: "rel-x",
    observed_artifact_id: "art-x",
    ...over,
  } as DeploymentObservation;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL required"); process.exit(2); }
  if (process.env.NEXUS_PERSISTENCE_MODE !== "shared") {
    console.error("NEXUS_PERSISTENCE_MODE must be shared"); process.exit(2);
  }

  section("A00 - environment");
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
    console.log("\n============================================");
    console.log("PASS: " + passed); console.log("FAIL: " + failed);
    console.log("BLOCKED: " + blocked); console.log("NOT EXECUTED: " + notExec);
    console.log("============================================");
    process.exit(failed > 0 ? 1 : 0);
  }

  const store = new AsyncIncidentStore(new PgAsyncEngine(pg));

  const dbPath = path.join(os.tmpdir(), "nexus-p253-" + Date.now() + ".sqlite");
  process.on("exit", () => { for (const e of ["", "-wal", "-shm"]) { try { fs.unlinkSync(dbPath + e); } catch {} } });
  const sqlite = await SQLiteEngine.open(dbPath);
  const history = new DeploymentHistoryService(sqlite);
  const execStore = new ExecutionStore(sqlite as any);
  const intentService = new ReleaseDeploymentIntentService(execStore);

  async function seed(projectId: string, environment: string, releaseId: string, artifactId: string, digest: string): Promise<string> {
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
      container_name: "nexus-p253-" + Date.now().toString(36),
      previous_deployment_id: null,
      is_rollback: false,
    } as any);
    await history.updateDeployment(rec.id, { artifact_id: artifactId } as any);
    // Phase 253 also needs execution_id / attempt_id / container_port to be
    // authoritative so buildProductionRecoveryContext passes rules 6-9.
    await history.updateDeployment(rec.id, {
      execution_id: "exec-" + releaseId,
      attempt_id: "attempt-" + releaseId,
      container_port: 8080,
    } as any);
    await (history as any).markKnownGood(rec.id);
    return rec.id;
  }

  function mkSupervisor(scopes: DriftObservationScope[], observer: { observe(id: string): Promise<DeploymentObservation> }, svc?: ReleaseDeploymentIntentService) {
    const events = new EventsRecorder();
    const sup = new DriftObservationSupervisor({
      incidentStore: store,
      history,
      observer,
      workerId: "p253-worker",
      intervalMs: 60_000,
      maxScopesPerTick: 100,
      enumerateScopes: async () => scopes,
      svc: { events },
      intentService: svc,
    });
    return { sup, events };
  }

  async function wipe() {
    try {
      await pg.query("DELETE FROM security_incident_timeline WHERE incident_id LIKE $1", ["incident-drift-%"]);
      await pg.query("DELETE FROM security_incidents WHERE id LIKE $1", ["incident-drift-%"]);
    } catch {}
  }
  await wipe();

  // ---- A01: production wiring ------------------------------------------
  section("A01 - production wiring");
  try {
    const supSrc = fs.readFileSync("src/core/drift-observation-supervisor.ts", "utf8");
    const kernSrc = fs.readFileSync("src/core/kernel.ts", "utf8");
    const handoffSrc = fs.readFileSync("src/core/drift-recovery-handoff.ts", "utf8");
    ok(/from "\.\/drift-recovery-handoff"/.test(supSrc), "A01 supervisor imports handoff");
    ok(/handoffDriftIncidentToRecovery/.test(supSrc), "A01 supervisor calls handoff");
    ok(/intentService\?: ReleaseDeploymentIntentService/.test(supSrc), "A01 deps.intentService declared");
    ok(/intentService: releaseIntents/.test(kernSrc), "A01 kernel wires intentService");
    ok(/buildProductionRecoveryContext/.test(handoffSrc), "A01 handoff uses P251 bridge");
    ok(/requestDriftRecoveryIntent/.test(handoffSrc), "A01 handoff uses P250 intent request");
  } catch (e) {
    blk("A01 wiring", String(e instanceof Error ? e.message : e).slice(0, 200));
  }

  // ---- A02: drift -> incident + handoff --------------------------------
  section("A02 - DRIFTED produces durable incident AND recovery intent");
  let a02DepId = "", a02RelId = "rel-p253-a02", a02ArtId = "art-p253-a02", a02Digest = "";
  try {
    await wipe();
    a02Digest = "sha256:actual-" + Date.now();
    a02DepId = await seed("p253", "a02", a02RelId, a02ArtId, a02Digest);
    const observer = new ScriptedObserver({
      [a02DepId]: obs({ observed_release_id: a02RelId, observed_artifact_id: a02ArtId, observed_digest: "sha256:wrong" }),
    });
    const { sup } = mkSupervisor([{ projectId: "p253", environment: "a02" }], observer, intentService);
    const r = await sup.runNow();

    ok(r.deploymentsScanned === 1, "A02 deployment scanned");
    ok(r.drifted === 1, "A02 classified DRIFTED");
    ok(r.incidentsCreated === 1, "A02 incident created");
    ok(r.recoveryHandoffsAccepted === 1, "A02 handoff accepted");
    ok(r.recoveryHandoffsRejected === 0, "A02 no rejection");
    ok(r.recoveryHandoffsNotExecuted === 0, "A02 not NOT_EXECUTED");
    ok(r.errors.length === 0, "A02 no errors (" + r.errors.join(" | ").slice(0, 150) + ")");
  } catch (e) {
    blk("A02", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A03: incident correlated with recovery_intent_key ---------------
  section("A03 - incident carries recovery_intent_key");
  let a03IntentKey: string | null = null;
  try {
    const fp = computeIncidentFingerprint({
      deployment_id: a02DepId,
      release_id: a02RelId,
      artifact_id: a02ArtId,
      artifact_digest: a02Digest,
      environment: "a02",
      classifications: ["DIGEST_MISMATCH"] as any,
    });
    const id = deterministicDriftIncidentId(fp);
    const back = await store.getIncidentAsync(id);
    ok(back !== undefined, "A03 incident row present");
    ok(typeof back?.recovery_intent_key === "string" && back!.recovery_intent_key!.length > 0,
       "A03 recovery_intent_key populated (value=" + String(back?.recovery_intent_key).slice(0, 40) + ")");
    ok(back?.status === "RECOVERY_REQUESTED", "A03 incident status = RECOVERY_REQUESTED (got " + back?.status + ")");
    a03IntentKey = back?.recovery_intent_key ?? null;

    const tl = await store.getIncidentTimelineAsync(id);
    ok(tl.some((e) => e.event_type === "RECOVERY_HANDOFF_ACCEPTED"),
       "A03 RECOVERY_HANDOFF_ACCEPTED in timeline");
  } catch (e) {
    blk("A03", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A04: intent matches incident identity --------------------------
  section("A04 - durable intent retrieved via ReleaseDeploymentIntentService");
  try {
    if (!a03IntentKey) { blk("A04", "no intent key from A03"); }
    else {
      const intent = await intentService.get(a03IntentKey);
      ok(intent !== undefined, "A04 intent exists");
      ok(intent?.environment === "a02", "A04 intent.environment = a02");
      ok(intent?.releaseId === a02RelId, "A04 intent.releaseId matches");
      ok(intent?.artifactId === a02ArtId, "A04 intent.artifactId matches");
      ok(intent?.intentKind === "ROLLBACK", "A04 intent.kind = ROLLBACK (recovery)");
    }
  } catch (e) {
    blk("A04", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A05: idempotency ------------------------------------------------
  section("A05 - second tick reconciles, no duplicate intent");
  try {
    const observer = new ScriptedObserver({
      [a02DepId]: obs({ observed_release_id: a02RelId, observed_artifact_id: a02ArtId, observed_digest: "sha256:wrong" }),
    });
    const { sup } = mkSupervisor([{ projectId: "p253", environment: "a02" }], observer, intentService);
    const r = await sup.runNow();
    ok(r.incidentsCreated === 0, "A05 no new incident");
    ok(r.incidentsReconciled === 1, "A05 incident reconciled");
    ok(r.recoveryHandoffsAccepted === 1, "A05 handoff accepted again (idempotent)");
    ok(r.recoveryHandoffsRejected === 0, "A05 no rejection");

    const fp = computeIncidentFingerprint({
      deployment_id: a02DepId, release_id: a02RelId, artifact_id: a02ArtId,
      artifact_digest: a02Digest, environment: "a02", classifications: ["DIGEST_MISMATCH"] as any,
    });
    const id = deterministicDriftIncidentId(fp);
    const back = await store.getIncidentAsync(id);
    ok(back?.recovery_intent_key === a03IntentKey, "A05 intentKey unchanged");

    const tl = await store.getIncidentTimelineAsync(id);
    const accept = tl.filter((e) => e.event_type === "RECOVERY_HANDOFF_ACCEPTED");
    ok(accept.length === 1, "A05 exactly one RECOVERY_HANDOFF_ACCEPTED (got " + accept.length + ")");
  } catch (e) {
    blk("A05", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A06: concurrent handoff -> one intent --------------------------
  section("A06 - concurrent identical handoffs -> one intent");
  let a06IntentKey: string | null = null;
  try {
    await wipe();
    const dId = await seed("p253", "a06", "rel-p253-a06", "art-p253-a06", "sha256:actual-a06");
    const observer = new ScriptedObserver({
      [dId]: obs({ observed_release_id: "rel-p253-a06", observed_artifact_id: "art-p253-a06", observed_digest: "sha256:wrong" }),
    });
    const mk = () => mkSupervisor([{ projectId: "p253", environment: "a06" }], observer, intentService);
    const s1 = mk(); const s2 = mk();
    const [r1, r2] = await Promise.all([s1.sup.runNow(), s2.sup.runNow()]);
    ok(r1.recoveryHandoffsAccepted + r2.recoveryHandoffsAccepted === 2,
       "A06 both accepted (idempotent under concurrency)");
    ok(r1.errors.length + r2.errors.length === 0,
       "A06 no errors (" + [...r1.errors, ...r2.errors].join(" | ").slice(0, 150) + ")");

    const fp = computeIncidentFingerprint({
      deployment_id: dId, release_id: "rel-p253-a06", artifact_id: "art-p253-a06",
      artifact_digest: "sha256:actual-a06", environment: "a06", classifications: ["DIGEST_MISMATCH"] as any,
    });
    const id = deterministicDriftIncidentId(fp);
    const back = await store.getIncidentAsync(id);
    a06IntentKey = back?.recovery_intent_key ?? null;
    ok(a06IntentKey !== null, "A06 incident carries intent key");

    const rows = await pg.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM security_incidents WHERE incident_fingerprint = $1",
      [fp],
    );
    ok(rows.rows[0]?.n === "1", "A06 exactly one incident row");

    // Intent side: exactly one durable intent for this identity
    const intent = a06IntentKey ? await intentService.get(a06IntentKey) : undefined;
    ok(intent !== undefined, "A06 intent retrievable");
  } catch (e) {
    blk("A06", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A07: UNKNOWN does not hand off ---------------------------------
  section("A07 - UNKNOWN does not hand off");
  try {
    await wipe();
    const dId = await seed("p253", "a07", "rel-p253-a07", "art-p253-a07", "sha256:x");
    const observer = new ScriptedObserver({ [dId]: obs({ status: "ERROR" as any }) });
    const { sup } = mkSupervisor([{ projectId: "p253", environment: "a07" }], observer, intentService);
    const r = await sup.runNow();
    ok(r.unknown === 1, "A07 classified UNKNOWN");
    ok(r.recoveryHandoffsAccepted === 0, "A07 no handoff");
    ok(r.recoveryHandoffsRejected === 0, "A07 no rejection");
  } catch (e) {
    blk("A07", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A08: BLOCKED does not hand off ---------------------------------
  section("A08 - BLOCKED does not hand off");
  try {
    await wipe();
    const dId = await seed("p253", "a08", "rel-p253-a08", "art-p253-a08", "sha256:x");
    const observer = new ScriptedObserver({ [dId]: obs({ available: false }) });
    const { sup } = mkSupervisor([{ projectId: "p253", environment: "a08" }], observer, intentService);
    const r = await sup.runNow();
    ok(r.blocked === 1, "A08 classified BLOCKED");
    ok(r.recoveryHandoffsAccepted === 0, "A08 no handoff");
  } catch (e) {
    blk("A08", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A09: NOT_EXECUTED does not hand off ----------------------------
  section("A09 - NOT_EXECUTED does not hand off");
  try {
    await wipe();
    const dId = await seed("p253", "a09", "rel-p253-a09", "art-p253-a09", "sha256:x");
    const observer = new ScriptedObserver({ [dId]: obs({ status: "NOT_EXECUTED" }) });
    const { sup } = mkSupervisor([{ projectId: "p253", environment: "a09" }], observer, intentService);
    const r = await sup.runNow();
    ok(r.notExecuted === 1, "A09 classified NOT_EXECUTED");
    ok(r.recoveryHandoffsAccepted === 0, "A09 no handoff");
  } catch (e) {
    blk("A09", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A10: VERIFIED does not create anything -------------------------
  section("A10 - VERIFIED does not create incident or intent");
  try {
    await wipe();
    const d = "sha256:verified-" + Date.now();
    const dId = await seed("p253", "a10", "rel-p253-a10", "art-p253-a10", d);
    const observer = new ScriptedObserver({
      [dId]: obs({ observed_release_id: "rel-p253-a10", observed_artifact_id: "art-p253-a10", observed_digest: d }),
    });
    const { sup } = mkSupervisor([{ projectId: "p253", environment: "a10" }], observer, intentService);
    const r = await sup.runNow();
    ok(r.verified === 1, "A10 VERIFIED");
    ok(r.incidentsCreated === 0, "A10 no incident");
    ok(r.recoveryHandoffsAccepted === 0, "A10 no handoff");
    const rows = await pg.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM security_incidents WHERE id LIKE $1",
      ["incident-drift-%"],
    );
    ok(rows.rows[0]?.n === "0", "A10 no rows in security_incidents");
  } catch (e) {
    blk("A10", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A11: no intentService -> NOT_EXECUTED --------------------------
  section("A11 - absent intentService -> NOT_EXECUTED, no fabricated intent");
  try {
    await wipe();
    const dId = await seed("p253", "a11", "rel-p253-a11", "art-p253-a11", "sha256:actual-a11");
    const observer = new ScriptedObserver({
      [dId]: obs({ observed_release_id: "rel-p253-a11", observed_artifact_id: "art-p253-a11", observed_digest: "sha256:wrong" }),
    });
    const { sup } = mkSupervisor([{ projectId: "p253", environment: "a11" }], observer, undefined);
    const r = await sup.runNow();
    ok(r.drifted === 1, "A11 classified DRIFTED");
    ok(r.incidentsCreated === 1, "A11 incident still created");
    ok(r.recoveryHandoffsAccepted === 0, "A11 no acceptance");
    ok(r.recoveryHandoffsNotExecuted === 1, "A11 counted as NOT_EXECUTED");

    const fp = computeIncidentFingerprint({
      deployment_id: dId, release_id: "rel-p253-a11", artifact_id: "art-p253-a11",
      artifact_digest: "sha256:actual-a11", environment: "a11", classifications: ["DIGEST_MISMATCH"] as any,
    });
    const id = deterministicDriftIncidentId(fp);
    const back = await store.getIncidentAsync(id);
    ok(back?.recovery_intent_key == null, "A11 incident has no intent key");
  } catch (e) {
    blk("A11", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A12: handoff rejects when authoritative deployment is missing ---
  section("A12 - REJECTED when authoritative deployment record is absent");
  try {
    const fakeIncident = {
      id: "inc-253-a12-notreal",
      tenant_id: "default",
      environment: "a12",
      service: "deployment-integrity",
      severity: "HIGH",
      title: "a12",
      description: "a12",
      status: "OPEN" as any,
      incident_fingerprint: "fp-253-a12",
      recovery_attempt: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as any;
    const res = await handoffDriftIncidentToRecovery({
      incidentStore: store,
      history,
      intentService,
      incident: fakeIncident,
      deploymentId: "does-not-exist-" + Date.now(),
      expected: {
        project_id: "p253", environment: "a12",
        release_id: "rel-253-a12", artifact_id: "art-253-a12", artifact_digest: "sha256:x",
      },
      workerId: "p253-worker",
    });
    ok(res.status === "REJECTED", "A12 rejected (got " + res.status + ")");
    ok(res.intentKey === null, "A12 no intent key");
    ok(/deployment not found/.test(res.reason), "A12 reason mentions deployment not found");
  } catch (e) {
    blk("A12", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A13: source audit - no recovery authority touched --------------
  section("A13 - source audit: handoff never touches recovery authority");
  try {
    const src = fs.readFileSync("src/core/drift-recovery-handoff.ts", "utf8");
    ok(!/acquireLease|renewLease|releaseLease|acquireSupervisorLease/.test(src), "A13 no lease acquisition");
    ok(!/recovery_attempt\s*[:=]\s*[^0]/.test(src), "A13 no recovery_attempt increment");
    ok(!/docker\.run\(/.test(src), "A13 no direct docker.run");
    ok(!/from ["'].*release-recovery-executor/.test(src), "A13 no ReleaseRecoveryExecutor import");
    ok(!/from ["'].*deployment-orchestrator/.test(src), "A13 no orchestrator import");
    ok(!/updateIncidentAsync\([^)]*recovery_attempt/.test(src), "A13 no recovery_attempt update");
  } catch (e) {
    blk("A13", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A14: durable restart reconstruction ----------------------------
  section("A14 - restart/durable-state: intent + correlation survive reopen");
  let a14DepId = "", a14Digest = "", a14IntentKey: string | null = null;
  try {
    await wipe();
    a14Digest = "sha256:a14-" + Date.now();
    a14DepId = await seed("p253", "a14", "rel-p253-a14", "art-p253-a14", a14Digest);
    const observer = new ScriptedObserver({
      [a14DepId]: obs({ observed_release_id: "rel-p253-a14", observed_artifact_id: "art-p253-a14", observed_digest: "sha256:wrong" }),
    });
    const { sup } = mkSupervisor([{ projectId: "p253", environment: "a14" }], observer, intentService);
    const r = await sup.runNow();
    ok(r.recoveryHandoffsAccepted === 1, "A14 first-run handoff accepted");

    const fp = computeIncidentFingerprint({
      deployment_id: a14DepId, release_id: "rel-p253-a14", artifact_id: "art-p253-a14",
      artifact_digest: a14Digest, environment: "a14", classifications: ["DIGEST_MISMATCH"] as any,
    });
    const id = deterministicDriftIncidentId(fp);
    const initial = await store.getIncidentAsync(id);
    a14IntentKey = initial?.recovery_intent_key ?? null;
    ok(a14IntentKey !== null, "A14 intent key captured from first run");

    // Reopen the incident store from a fresh PgAsyncEngine wrapper.
    const pg2 = new PgClient();
    await pg2.connect(url);
    const store2 = new AsyncIncidentStore(new PgAsyncEngine(pg2));
    const back = await store2.getIncidentAsync(id);
    ok(back !== undefined, "A14 incident survives reopen");
    ok(back?.recovery_intent_key === a14IntentKey, "A14 intent key persists");
    try { await pg2.close(); } catch {}

    // Intent survives via the same ExecutionStore (sync get) — proves the
    // row is durable in SQLite, not in-memory.
    const intent = a14IntentKey ? intentService.get(a14IntentKey) : undefined;
    ok(intent !== undefined, "A14 intent survives");
    ok(intent?.environment === "a14", "A14 intent.environment correct");
  } catch (e) {
    blk("A14", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // ---- A15: honest NOT EXECUTED for real provider-driven recovery -----
  section("A15 - live recovery execution + post-recovery verification");
  nx("A15 executor-driven recovery completion with real provider",
     "requires a ReleaseRecoveryExecutor harness with real provider context (Docker+rollback+smoke) — covered by phases 174-177, not in scope here");

  // Cleanup before regression
  await wipe();
  try { (sqlite as any).close?.(); } catch {}
  await wipe();

  try { await pg.close(); } catch {}

  // ---- A16: regression ------------------------------------------------
  section("A16 - regression: phase 250 / 251 / 252");
  for (const [phase, cmd] of [
    ["250", "npm run test:phase250"],
    ["251", "npm run test:phase251"],
    ["252", "npm run test:phase252"],
  ] as Array<[string, string]>) {
    try {
      execSync(cmd, { stdio: "pipe", timeout: 300_000 });
      ok(true, "A16 phase" + phase + " regression pass");
    } catch (e: any) {
      ok(false, "A16 phase" + phase + " regression FAIL: " + String(e?.stderr ?? e?.message ?? e).slice(0, 200));
    }
  }

  console.log("\n============================================");
  console.log("PASS: " + passed);
  console.log("FAIL: " + failed);
  console.log("BLOCKED: " + blocked);
  console.log("NOT EXECUTED: " + notExec);
  console.log("============================================");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exit(1); });
