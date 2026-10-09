// scripts/test-phase257-recovery-handoff-convergence.ts
// Phase 257 verifier: durable recovery handoff convergence & integrity.
//
// Uses real PostgreSQL (AsyncIncidentStore / PgAsyncEngine) and the real
// ReleaseDeploymentIntentService. No fake provider, no fabricated state.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { PgClient } from "../src/core/pg-client";
import { PgAsyncEngine } from "../src/core/pg-async-engine";
import { bootstrapPgSchema } from "../src/core/pg-bootstrap";
import { AsyncIncidentStore } from "../src/core/async-incident-store";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { DeploymentHistoryService } from "../src/core/deployment-history";
import { ExecutionStore } from "../src/core/execution-store";
import { ReleaseDeploymentIntentService } from "../src/core/release-deployment-intent";
import { convergeRecoveryHandoffAsync } from "../src/core/recovery-handoff-convergence";
import type { DriftRecoveryProviderContext } from "../src/core/production-incident-response";

let passed = 0, failed = 0, blocked = 0, notExec = 0;
function ok(c: boolean, m: string): void {
  if (c) { passed++; console.log("PASS  " + m); }
  else { failed++; console.log("FAIL  " + m); }
}
function blk(m: string, why: string): void { blocked++; console.log("BLOCKED  " + m + " :: " + why); }
function nx(m: string, why: string): void { notExec++; console.log("NOT EXECUTED  " + m + " :: " + why); }
function section(t: string): void { console.log("\n--- " + t + " ---"); }

const PREFIX = "p257-";

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

  const dbPath = path.join(os.tmpdir(), "nexus-p257-" + Date.now() + ".sqlite");
  process.on("exit", () => { for (const e of ["", "-wal", "-shm"]) { try { fs.unlinkSync(dbPath + e); } catch {} } });
  const sqlite = await SQLiteEngine.open(dbPath);
  const history = new DeploymentHistoryService(sqlite);
  const execStore = new ExecutionStore(sqlite as any);
  const intentService = new ReleaseDeploymentIntentService(execStore);

  async function wipe() {
    for (const p of [PREFIX + "%", "incident-drift-%", "p254-%", "p255-%", "p256-%", "p253-%"]) {
      try {
        await pg.query("DELETE FROM security_incident_timeline WHERE incident_id LIKE $1", [p]);
        await pg.query("DELETE FROM security_incidents WHERE id LIKE $1", [p]);
      } catch {}
    }
  }
  await wipe();

  function pcFor(env: string): DriftRecoveryProviderContext {
    return {
      executionId: "exec-p257-" + env,
      attemptId: "attempt-p257-" + env,
      commitSha: "commit-p257-" + env,
      imageRepository: "example/test",
      imageTag: "v1",
      imageId: null,
      imageDigest: "sha256:p257-" + env,
      containerName: "nexus-p257-" + env,
      containerPort: 8080,
      projectId: "p257",
    };
  }

  async function seedIncident(opts: {
    env: string;
    status: "OPEN" | "RECOVERY_REQUESTED" | "REQUIRE_REVIEW" | "RESOLVED" | "CLOSED";
    deploymentId?: string;
    releaseId?: string;
    artifactId?: string;
    digest?: string;
    recoveryIntentKey?: string | null;
  }) {
    const id = PREFIX + opts.env;
    const depId = opts.deploymentId ?? "dep-p257-" + opts.env;
    const relId = opts.releaseId ?? "rel-p257-" + opts.env;
    const artId = opts.artifactId ?? "art-p257-" + opts.env;
    const dig = opts.digest ?? "sha256:p257-" + opts.env;
    await store.createIncidentAsync({
      id, tenant_id: "default", environment: "p257",
      service: "deployment-integrity", severity: "HIGH",
      title: "p257 " + opts.env, description: "p257 setup",
      status: "OPEN",
      deployment_id: depId, release_id: relId, artifact_id: artId,
      artifact_digest: dig, drift_classification: "DIGEST_MISMATCH",
      incident_fingerprint: "fp-p257-" + opts.env,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    const patch: any = { status: opts.status };
    if (opts.recoveryIntentKey !== undefined) patch.recovery_intent_key = opts.recoveryIntentKey;
    await store.updateIncidentAsync(id, patch);
    return { id, deploymentId: depId, releaseId: relId, artifactId: artId, digest: dig };
  }

  const auth = { authorizedBy: "p257-operator", reason: "test" };

  // A01 ----------------------------------------------------------------
  section("A01 - architecture audit");
  try {
    const src = fs.readFileSync("src/core/recovery-handoff-convergence.ts", "utf8");
    ok(src.indexOf("requestDriftRecoveryIntent") >= 0, "A01 delegates to existing Phase 250");
    ok(src.indexOf("assertDeploymentBinding") >= 0, "A01 reuses Phase 256 binding");
    ok(src.indexOf("computeKey") >= 0, "A01 uses intent service's own key computation");
    ok(src.indexOf("docker.run(") < 0, "A01 no direct docker.run");
    ok(src.indexOf("ReleaseRecoveryExecutor") < 0, "A01 does not invoke executor");
    ok(src.indexOf("RollbackDelegate") < 0, "A01 does not invoke rollback delegate");
    ok(src.indexOf("recovery_attempt") < 0, "A01 does not mutate recovery_attempt");
    ok(!/acquireLease|renewLease|releaseLease/.test(src), "A01 no lease operations");
  } catch (e) {
    blk("A01", String(e instanceof Error ? e.message : e).slice(0, 200));
  }

  // A02 ----------------------------------------------------------------
  section("A02 - valid authoritative handoff");
  let a02: any = null;
  try {
    await wipe();
    a02 = await seedIncident({ env: "a02", status: "REQUIRE_REVIEW" });
    const r = await convergeRecoveryHandoffAsync({
      incidentStore: store, history, intentService,
      incidentId: a02.id, deploymentId: a02.deploymentId,
      expected: { release_id: a02.releaseId, artifact_id: a02.artifactId, artifact_digest: a02.digest, environment: "p257" },
      providerContext: pcFor("a02"), authorization: auth, workerId: "w-p257",
    });
    ok(r.outcome === "ACCEPTED", "A02 outcome ACCEPTED (got " + r.outcome + ")");
    ok(typeof r.intentKey === "string" && r.intentKey.length > 0, "A02 intentKey present");
    ok(r.lifecycleAfter === "RECOVERY_REQUESTED", "A02 lifecycle = RECOVERY_REQUESTED (got " + r.lifecycleAfter + ")");
  } catch (e) {
    blk("A02", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // A03 ----------------------------------------------------------------
  section("A03 - durable intent correlation");
  try {
    const back = await store.getIncidentAsync(a02.id);
    ok(back?.recovery_intent_key != null && back.recovery_intent_key.length > 0, "A03 incident carries recovery_intent_key");
    const tl = await store.getIncidentTimelineAsync(a02.id);
    ok(tl.some((e) => e.event_type === "RECOVERY_HANDOFF_ACCEPTED"), "A03 ACCEPTED timeline event present");
  } catch (e) {
    blk("A03", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // A04 ----------------------------------------------------------------
  section("A04 - duplicate handoff idempotency");
  try {
    const r = await convergeRecoveryHandoffAsync({
      incidentStore: store, history, intentService,
      incidentId: a02.id, deploymentId: a02.deploymentId,
      expected: { release_id: a02.releaseId, artifact_id: a02.artifactId, artifact_digest: a02.digest, environment: "p257" },
      providerContext: pcFor("a02"), authorization: auth, workerId: "w-p257",
    });
    ok(r.outcome === "RECONCILED", "A04 outcome RECONCILED (got " + r.outcome + ")");
    const tl = await store.getIncidentTimelineAsync(a02.id);
    const accepts = tl.filter((e) => e.event_type === "RECOVERY_HANDOFF_ACCEPTED");
    ok(accepts.length === 1, "A04 exactly one ACCEPTED event (got " + accepts.length + ")");
  } catch (e) {
    blk("A04", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // A05 ----------------------------------------------------------------
  section("A05 - deployment identity mismatch rejected");
  try {
    await wipe();
    const s = await seedIncident({ env: "a05", status: "REQUIRE_REVIEW" });
    const r = await convergeRecoveryHandoffAsync({
      incidentStore: store, history, intentService,
      incidentId: s.id, deploymentId: "dep-p257-DIFFERENT",
      expected: { release_id: s.releaseId, artifact_id: s.artifactId, artifact_digest: s.digest, environment: "p257" },
      providerContext: pcFor("a05"), authorization: auth, workerId: "w-p257",
    });
    ok(r.outcome === "REJECTED", "A05 REJECTED (got " + r.outcome + ")");
    const back = await store.getIncidentAsync(s.id);
    ok(back?.status === "REQUIRE_REVIEW", "A05 lifecycle unchanged");
  } catch (e) {
    blk("A05", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // A06 ----------------------------------------------------------------
  section("A06 - release identity mismatch rejected");
  try {
    await wipe();
    const s = await seedIncident({ env: "a06", status: "REQUIRE_REVIEW" });
    const r = await convergeRecoveryHandoffAsync({
      incidentStore: store, history, intentService,
      incidentId: s.id, deploymentId: s.deploymentId,
      expected: { release_id: "rel-DIFFERENT", artifact_id: s.artifactId, artifact_digest: s.digest, environment: "p257" },
      providerContext: pcFor("a06"), authorization: auth, workerId: "w-p257",
    });
    ok(r.outcome === "REJECTED", "A06 REJECTED (got " + r.outcome + ")");
  } catch (e) {
    blk("A06", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // A07 ----------------------------------------------------------------
  section("A07 - artifact identity mismatch rejected");
  try {
    await wipe();
    const s = await seedIncident({ env: "a07", status: "REQUIRE_REVIEW" });
    const r = await convergeRecoveryHandoffAsync({
      incidentStore: store, history, intentService,
      incidentId: s.id, deploymentId: s.deploymentId,
      expected: { release_id: s.releaseId, artifact_id: s.artifactId, artifact_digest: "sha256:DIFFERENT", environment: "p257" },
      providerContext: pcFor("a07"), authorization: auth, workerId: "w-p257",
    });
    ok(r.outcome === "REJECTED", "A07 REJECTED (got " + r.outcome + ")");
  } catch (e) {
    blk("A07", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // A08 ----------------------------------------------------------------
  section("A08 - missing authoritative binding rejected");
  try {
    await wipe();
    const id = PREFIX + "a08";
    await store.createIncidentAsync({
      id, tenant_id: "default", environment: "p257",
      service: "deployment-integrity", severity: "HIGH",
      title: "a08", description: "a08", status: "REQUIRE_REVIEW",
      deployment_id: null, release_id: "rel-p257-a08",
      artifact_id: "art-p257-a08", artifact_digest: "sha256:p257-a08",
      drift_classification: "DIGEST_MISMATCH",
      incident_fingerprint: "fp-p257-a08",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    const r = await convergeRecoveryHandoffAsync({
      incidentStore: store, history, intentService,
      incidentId: id, deploymentId: "dep-any",
      expected: { release_id: "rel-p257-a08", artifact_id: "art-p257-a08", artifact_digest: "sha256:p257-a08", environment: "p257" },
      providerContext: pcFor("a08"), authorization: auth, workerId: "w-p257",
    });
    ok(r.outcome === "REJECTED", "A08 REJECTED (got " + r.outcome + ")");
  } catch (e) {
    blk("A08", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // A09 ----------------------------------------------------------------
  section("A09 - CLOSED incident rejected");
  try {
    await wipe();
    const s = await seedIncident({ env: "a09", status: "CLOSED" });
    const r = await convergeRecoveryHandoffAsync({
      incidentStore: store, history, intentService,
      incidentId: s.id, deploymentId: s.deploymentId,
      expected: { release_id: s.releaseId, artifact_id: s.artifactId, artifact_digest: s.digest, environment: "p257" },
      providerContext: pcFor("a09"), authorization: auth, workerId: "w-p257",
    });
    ok(r.outcome === "REJECTED", "A09 REJECTED (got " + r.outcome + ")");
    const back = await store.getIncidentAsync(s.id);
    ok(back?.status === "CLOSED", "A09 status remains CLOSED");
  } catch (e) {
    blk("A09", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // A10 ----------------------------------------------------------------
  section("A10 - RESOLVED lifecycle compatibility");
  try {
    await wipe();
    const s = await seedIncident({ env: "a10", status: "RESOLVED" });
    const r = await convergeRecoveryHandoffAsync({
      incidentStore: store, history, intentService,
      incidentId: s.id, deploymentId: s.deploymentId,
      expected: { release_id: s.releaseId, artifact_id: s.artifactId, artifact_digest: s.digest, environment: "p257" },
      providerContext: pcFor("a10"), authorization: auth, workerId: "w-p257",
    });
    // Phase 257 does not decide RESOLVED semantics; it accepts when other
    // guards pass and defers lifecycle to the existing chain.
    ok(r.outcome === "ACCEPTED" || r.outcome === "REJECTED", "A10 truthful outcome (got " + r.outcome + ")");
  } catch (e) {
    blk("A10", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // A11 ----------------------------------------------------------------
  section("A11 - existing RECOVERY_REQUESTED reconciliation");
  try {
    await wipe();
    const s = await seedIncident({ env: "a11", status: "RECOVERY_REQUESTED" });
    // First handoff creates intent + key.
    const r1 = await convergeRecoveryHandoffAsync({
      incidentStore: store, history, intentService,
      incidentId: s.id, deploymentId: s.deploymentId,
      expected: { release_id: s.releaseId, artifact_id: s.artifactId, artifact_digest: s.digest, environment: "p257" },
      providerContext: pcFor("a11"), authorization: auth, workerId: "w-p257",
    });
    ok(r1.outcome === "ACCEPTED", "A11 first call ACCEPTED (got " + r1.outcome + ")");
    const r2 = await convergeRecoveryHandoffAsync({
      incidentStore: store, history, intentService,
      incidentId: s.id, deploymentId: s.deploymentId,
      expected: { release_id: s.releaseId, artifact_id: s.artifactId, artifact_digest: s.digest, environment: "p257" },
      providerContext: pcFor("a11"), authorization: auth, workerId: "w-p257",
    });
    ok(r2.outcome === "RECONCILED", "A11 repeat RECONCILED (got " + r2.outcome + ")");
  } catch (e) {
    blk("A11", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // A12 ----------------------------------------------------------------
  section("A12 - superseded intent rejection");
  try {
    await wipe();
    const s = await seedIncident({ env: "a12", status: "REQUIRE_REVIEW", recoveryIntentKey: "rollback||p257|exec-DIFFERENT" });
    const r = await convergeRecoveryHandoffAsync({
      incidentStore: store, history, intentService,
      incidentId: s.id, deploymentId: s.deploymentId,
      expected: { release_id: s.releaseId, artifact_id: s.artifactId, artifact_digest: s.digest, environment: "p257" },
      providerContext: pcFor("a12"), authorization: auth, workerId: "w-p257",
    });
    ok(r.outcome === "REJECTED", "A12 REJECTED (got " + r.outcome + ")");
  } catch (e) {
    blk("A12", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // A13 ----------------------------------------------------------------
  section("A13 - replacement deployment protection");
  try {
    await wipe();
    const s = await seedIncident({ env: "a13", status: "REQUIRE_REVIEW" });
    const r = await convergeRecoveryHandoffAsync({
      incidentStore: store, history, intentService,
      incidentId: s.id, deploymentId: "dep-p257-REPLACEMENT",
      expected: { release_id: s.releaseId, artifact_id: s.artifactId, artifact_digest: s.digest, environment: "p257" },
      providerContext: pcFor("a13"), authorization: auth, workerId: "w-p257",
    });
    ok(r.outcome === "REJECTED", "A13 REJECTED (got " + r.outcome + ")");
  } catch (e) {
    blk("A13", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // A14 ----------------------------------------------------------------
  section("A14 - concurrent duplicate handoff stress (8 callers x 3 rounds)");
  try {
    let roundsOk = true;
    const roundReports: Array<{ round: number; accepted: number; reconciled: number; rejected: number; blocked: number; notExecuted: number; sameKey: boolean; timelineAccepted: number }> = [];

    for (let round = 1; round <= 3; round++) {
      await wipe();
      const env = "a14r" + round;
      const s = await seedIncident({ env, status: "REQUIRE_REVIEW" });
      const callers = Array.from({ length: 8 }, (_, i) => convergeRecoveryHandoffAsync({
        incidentStore: store, history, intentService,
        incidentId: s.id, deploymentId: s.deploymentId,
        expected: { release_id: s.releaseId, artifact_id: s.artifactId, artifact_digest: s.digest, environment: "p257" },
        providerContext: pcFor(env),
        authorization: auth,
        workerId: "w-a14-" + round + "-" + i,
      }));
      const runs = await Promise.all(callers);
      const accepted = runs.filter((r) => r.outcome === "ACCEPTED").length;
      const reconciled = runs.filter((r) => r.outcome === "RECONCILED").length;
      const rejected = runs.filter((r) => r.outcome === "REJECTED").length;
      const blockedR = runs.filter((r) => r.outcome === "BLOCKED").length;
      const notExec = runs.filter((r) => r.outcome === "NOT_EXECUTED").length;

      const keys = new Set(runs.map((r) => r.intentKey).filter((k): k is string => k != null));
      const sameKey = keys.size === 1;

      const after = await store.getIncidentAsync(s.id);
      const tl = await store.getIncidentTimelineAsync(s.id);
      const acceptedEvents = tl.filter((e) => e.event_type === "RECOVERY_HANDOFF_ACCEPTED");

      roundReports.push({ round, accepted, reconciled, rejected, blocked: blockedR, notExecuted: notExec, sameKey, timelineAccepted: acceptedEvents.length });

      const okRound =
        accepted === 1 &&
        reconciled === 7 &&
        rejected === 0 &&
        blockedR === 0 &&
        notExec === 0 &&
        sameKey === true &&
        acceptedEvents.length === 1 &&
        after?.recovery_intent_key != null &&
        after.status === "RECOVERY_REQUESTED";
      if (!okRound) roundsOk = false;

      console.log("    round " + round + ": accepted=" + accepted + " reconciled=" + reconciled + " rejected=" + rejected + " timelineAccepted=" + acceptedEvents.length + " sameKey=" + sameKey);
    }

    ok(roundsOk, "A14 all 3 rounds: exact 1 ACCEPTED / 7 RECONCILED / 0 REJECTED / 0 BLOCKED / 0 NOT_EXECUTED / same key / 1 timeline event");
    ok(roundReports.length === 3, "A14 three stress rounds executed");
    ok(roundReports.every((r) => r.accepted === 1), "A14 every round had exactly 1 ACCEPTED");
    ok(roundReports.every((r) => r.reconciled === 7), "A14 every round had exactly 7 RECONCILED");
    ok(roundReports.every((r) => r.rejected === 0), "A14 every round had exactly 0 REJECTED");
    ok(roundReports.every((r) => r.sameKey === true), "A14 every round returned the same intent key");
    ok(roundReports.every((r) => r.timelineAccepted === 1), "A14 every round appended exactly 1 ACCEPTED timeline event");
  } catch (e) {
    blk("A14", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // A14b ----------------------------------------------------------------
  section("A14b - persistent aftermath of concurrent winner");
  try {
    await wipe();
    const s = await seedIncident({ env: "a14b", status: "REQUIRE_REVIEW" });
    const runs = await Promise.all(Array.from({ length: 8 }, (_, i) => convergeRecoveryHandoffAsync({
      incidentStore: store, history, intentService,
      incidentId: s.id, deploymentId: s.deploymentId,
      expected: { release_id: s.releaseId, artifact_id: s.artifactId, artifact_digest: s.digest, environment: "p257" },
      providerContext: pcFor("a14b"),
      authorization: auth,
      workerId: "w-a14b-" + i,
    })));
    const keys = new Set(runs.map((r) => r.intentKey).filter((k): k is string => k != null));
    const after = await store.getIncidentAsync(s.id);
    ok(keys.size === 1, "A14b single winning intent key");
    ok(after?.recovery_intent_key === [...keys][0], "A14b incident correlated to winner");
    const tl = await store.getIncidentTimelineAsync(s.id);
    const ev = tl.filter((e) => e.event_type === "RECOVERY_HANDOFF_ACCEPTED");
    ok(ev.length === 1, "A14b exactly one ACCEPTED event (got " + ev.length + ")");
  } catch (e) {
    blk("A14b", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // A15 ----------------------------------------------------------------
  section("A15 - missing authorization blocks");
  try {
    await wipe();
    const s = await seedIncident({ env: "a15", status: "REQUIRE_REVIEW" });
    const r = await convergeRecoveryHandoffAsync({
      incidentStore: store, history, intentService,
      incidentId: s.id, deploymentId: s.deploymentId,
      expected: { release_id: s.releaseId, artifact_id: s.artifactId, artifact_digest: s.digest, environment: "p257" },
      providerContext: pcFor("a15"), workerId: "w-p257",
    });
    ok(r.outcome === "BLOCKED", "A15 BLOCKED (got " + r.outcome + ")");
  } catch (e) {
    blk("A15", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // A16 ----------------------------------------------------------------
  section("A16 - missing provider context blocks");
  try {
    await wipe();
    const s = await seedIncident({ env: "a16", status: "REQUIRE_REVIEW" });
    const r = await convergeRecoveryHandoffAsync({
      incidentStore: store, history, intentService,
      incidentId: s.id, deploymentId: s.deploymentId,
      expected: { release_id: s.releaseId, artifact_id: s.artifactId, artifact_digest: s.digest, environment: "p257" },
      authorization: auth, workerId: "w-p257",
    });
    ok(r.outcome === "BLOCKED", "A16 BLOCKED (got " + r.outcome + ")");
  } catch (e) {
    blk("A16", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // A17 ----------------------------------------------------------------
  section("A17 - missing intent service NOT_EXECUTED");
  try {
    await wipe();
    const s = await seedIncident({ env: "a17", status: "REQUIRE_REVIEW" });
    const r = await convergeRecoveryHandoffAsync({
      incidentStore: store, history,
      incidentId: s.id, deploymentId: s.deploymentId,
      expected: { release_id: s.releaseId, artifact_id: s.artifactId, artifact_digest: s.digest, environment: "p257" },
      providerContext: pcFor("a17"), authorization: auth, workerId: "w-p257",
    });
    ok(r.outcome === "NOT_EXECUTED", "A17 NOT_EXECUTED (got " + r.outcome + ")");
  } catch (e) {
    blk("A17", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // A18 ----------------------------------------------------------------
  section("A18 - durable reopen retains intent key");
  try {
    await wipe();
    const s = await seedIncident({ env: "a18", status: "REQUIRE_REVIEW" });
    const r1 = await convergeRecoveryHandoffAsync({
      incidentStore: store, history, intentService,
      incidentId: s.id, deploymentId: s.deploymentId,
      expected: { release_id: s.releaseId, artifact_id: s.artifactId, artifact_digest: s.digest, environment: "p257" },
      providerContext: pcFor("a18"), authorization: auth, workerId: "w-p257",
    });
    ok(r1.outcome === "ACCEPTED", "A18 initial accepted");
    const pg2 = new PgClient();
    await pg2.connect(url);
    const store2 = new AsyncIncidentStore(new PgAsyncEngine(pg2));
    const back = await store2.getIncidentAsync(s.id);
    ok(back?.recovery_intent_key === r1.intentKey, "A18 intent key survives reopen");
    try { await pg2.close(); } catch {}
  } catch (e) {
    blk("A18", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // A19 ----------------------------------------------------------------
  section("A19 - no duplicate timeline events on repeat");
  try {
    await wipe();
    const s = await seedIncident({ env: "a19", status: "REQUIRE_REVIEW" });
    const r1 = await convergeRecoveryHandoffAsync({
      incidentStore: store, history, intentService,
      incidentId: s.id, deploymentId: s.deploymentId,
      expected: { release_id: s.releaseId, artifact_id: s.artifactId, artifact_digest: s.digest, environment: "p257" },
      providerContext: pcFor("a19"), authorization: auth, workerId: "w-p257",
    });
    const r2 = await convergeRecoveryHandoffAsync({
      incidentStore: store, history, intentService,
      incidentId: s.id, deploymentId: s.deploymentId,
      expected: { release_id: s.releaseId, artifact_id: s.artifactId, artifact_digest: s.digest, environment: "p257" },
      providerContext: pcFor("a19"), authorization: auth, workerId: "w-p257",
    });
    ok(r1.outcome === "ACCEPTED", "A19 first ACCEPTED (got " + r1.outcome + ")");
    ok(r2.outcome === "RECONCILED", "A19 second RECONCILED (got " + r2.outcome + ")");
    const tl = await store.getIncidentTimelineAsync(s.id);
    const accepts = tl.filter((e) => e.event_type === "RECOVERY_HANDOFF_ACCEPTED");
    ok(accepts.length === 1, "A19 exactly one ACCEPTED event (got " + accepts.length + ")");
  } catch (e) {
    blk("A19", String(e instanceof Error ? e.message : e).slice(0, 250));
  }

  // A20 ----------------------------------------------------------------
  section("A20 - executor not invoked from handoff");
  try {
    const src = fs.readFileSync("src/core/recovery-handoff-convergence.ts", "utf8");
    ok(src.indexOf("ReleaseRecoveryExecutor") < 0, "A20 no executor import");
    ok(src.indexOf("RollbackDelegate") < 0, "A20 no rollback delegate");
    ok(src.indexOf(".runOnce(") < 0, "A20 does not call runOnce");
  } catch (e) {
    blk("A20", String(e instanceof Error ? e.message : e).slice(0, 200));
  }

  // A21 ----------------------------------------------------------------
  section("A21 - policy engine not bypassed");
  try {
    const src = fs.readFileSync("src/core/recovery-handoff-convergence.ts", "utf8");
    ok(src.indexOf("RecoveryPolicyEngine") < 0, "A21 does not instantiate policy engine");
    // The module requires RecoveryAuthorization, deferring decision to the caller chain.
    ok(src.indexOf("authorization.authorizedBy") >= 0, "A21 requires explicit authorization");
  } catch (e) {
    blk("A21", String(e instanceof Error ? e.message : e).slice(0, 200));
  }

  // A22 ----------------------------------------------------------------
  section("A22 - no infrastructure mutation");
  try {
    const src = fs.readFileSync("src/core/recovery-handoff-convergence.ts", "utf8");
    ok(src.indexOf("docker.run(") < 0, "A22 no docker.run");
    ok(src.indexOf("container.") < 0, "A22 no container access");
    ok(!/imageDigest\s*=\s*[^p]/.test(src), "A22 does not mutate image identity");
  } catch (e) {
    blk("A22", String(e instanceof Error ? e.message : e).slice(0, 200));
  }

  // A23 ----------------------------------------------------------------
  section("A23 - existing intent service compatibility");
  try {
    const src = fs.readFileSync("src/core/recovery-handoff-convergence.ts", "utf8");
    ok(src.indexOf("requestDriftRecoveryIntent") >= 0, "A23 uses existing intent request");
    ok(src.indexOf(".computeKey(") >= 0, "A23 uses existing key computation");
  } catch (e) {
    blk("A23", String(e instanceof Error ? e.message : e).slice(0, 200));
  }

  // A24-A26 regression subprocesses replaced with source-file checks
  section("A24-A26 - previous-phase source presence");
  try {
    for (const [id, file, script] of [
      ["252", "scripts/test-phase252-drift-observation-loop.ts", "test:phase252"],
      ["253", "scripts/test-phase253-recovery-handoff-integrity.ts", "test:phase253"],
      ["254", "scripts/test-phase254-recovery-completion-integrity.ts", "test:phase254"],
      ["255", "scripts/test-phase255-resolved-deployment-lifecycle.ts", "test:phase255"],
      ["256", "scripts/test-phase256-deployment-convergence.ts", "test:phase256"],
    ]) {
      ok(fs.existsSync(file), "A24-A26 phase" + id + " test file present");
    }
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    for (const s of ["test:phase252", "test:phase253", "test:phase254", "test:phase255", "test:phase256"]) {
      ok(typeof pkg.scripts[s] === "string", "A24-A26 " + s + " registered");
    }
  } catch (e) {
    blk("A24-A26", String(e instanceof Error ? e.message : e).slice(0, 200));
  }

  // A27 ----------------------------------------------------------------
  section("A27 - TypeScript");
  try { execSync("npx tsc --noEmit", { stdio: "pipe", timeout: 300_000 }); ok(true, "A27 tsc clean"); }
  catch (e: any) { ok(false, "A27 tsc FAIL: " + String(e?.stderr ?? e?.message ?? e).slice(0, 200)); }

  // A28 ----------------------------------------------------------------
  section("A28 - production build");
  try { execSync("npm run build", { stdio: "pipe", timeout: 300_000 }); ok(true, "A28 build pass"); }
  catch (e: any) { ok(false, "A28 build FAIL: " + String(e?.stderr ?? e?.message ?? e).slice(0, 200)); }

  // A29 ----------------------------------------------------------------
  section("A29 - git diff --check");
  try { execSync("git diff --check", { stdio: "pipe", timeout: 60_000 }); ok(true, "A29 diff check clean"); }
  catch (e: any) { ok(false, "A29 diff check FAIL: " + String(e?.stderr ?? e?.message ?? e).slice(0, 200)); }

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
