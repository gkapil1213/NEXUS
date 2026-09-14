// scripts/test-phase122-recovery-evidence-reconciliation.ts
// Phase 122 — recovery evidence reconciliation tests.
import { openEngine } from "../src/core/db";
import { EventService } from "../src/core/events";
import { AuditService } from "../src/core/audit";
import { ExecutionStore } from "../src/core/execution-store";
import { ReleaseDeploymentIntentService } from "../src/core/release-deployment-intent";
import { ReleaseRecoveryEvidenceReconciler } from "../src/core/release-recovery-evidence-reconciliation";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log("[PASSED] " + name + (detail ? " | " + detail : "")); }
  else { fail++; console.error("[FAILED] " + name + (detail ? " | " + detail : "")); }
}
const RUN = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
const T = (s: string) => s + "-" + RUN;

async function newEnv() {
  const engine = await openEngine();
  const store = new ExecutionStore(engine);
  const events = new EventService(engine);
  await events.init();
  const audit = new AuditService(engine);
  return { engine, store, events, audit };
}

interface Seed {
  intentKey: string; releaseId: string; executionId: string; artifactId: string;
  artifactDigest: string; environment: string; projectId: string;
  containerName: string; containerPort: number; imageId: string; imageDigest: string;
  status?: string;
}

function seedIntent(store: ExecutionStore, o: Seed) {
  store.createReleaseIntentIdempotent({
    intentKey: o.intentKey, releaseId: o.releaseId, executionId: o.executionId,
    artifactId: o.artifactId, artifactDigest: o.artifactDigest, commitSha: "c",
    environment: o.environment, projectId: o.projectId,
    imageRepository: "nexus/img", imageTag: "v1",
    imageId: o.imageId, imageDigest: o.imageDigest,
    containerName: o.containerName, containerPort: o.containerPort,
    intentKind: "ROLLBACK", rollbackTargetReleaseId: o.releaseId,
    rollbackJobId: T("job"),
  } as any);
  if (o.status) {
    store.updateReleaseIntentStatus(o.intentKey, o.status as any, {});
  }
}

function evidenceBase(intent: any, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    intentKey: intent.intentKey,
    intentKind: "ROLLBACK",
    executionId: intent.executionId,
    projectId: intent.projectId,
    releaseId: intent.releaseId,
    rollbackTargetReleaseId: intent.rollbackTargetReleaseId ?? null,
    artifactId: intent.artifactId,
    expectedArtifactDigest: intent.artifactDigest,
    expectedImageId: intent.imageId,
    observedContainerId: "cid-x",
    observedImageId: intent.imageId,
    hostPort: intent.containerPort,
    stagingUrl: "http://127.0.0.1:" + intent.containerPort,
    recoveryWorkerId: "w",
    timestamp: Date.now(),
    ...overrides,
  };
}

async function emitStarted(events: EventService, intent: any, overrides: Record<string, unknown> = {}) {
  await events.emit({
    type: "release.recovery.rollback.verification_started" as any,
    source: "test",
    execution_id: intent.executionId,
    payload: evidenceBase(intent, overrides) as any,
  });
}

async function emitDecision(
  events: EventService, intent: any,
  kind: "passed" | "failed" | "blocked",
  status: string,
  overrides: Record<string, unknown> = {},
) {
  await events.emit({
    type: ("release.recovery.rollback.verification_" + kind) as any,
    source: "test",
    execution_id: intent.executionId,
    payload: { ...evidenceBase(intent), verificationStatus: status, reason: "test", ...overrides } as any,
  });
}

async function emitVerified(events: EventService, intent: any) {
  await events.emit({
    type: "release.recovery.rollback.verified" as any,
    source: "test",
    execution_id: intent.executionId,
    payload: { ...evidenceBase(intent), verificationStatus: "VERIFIED", reason: "test" } as any,
  });
}

function reconcilerFor(store: ExecutionStore, events: EventService, audit: AuditService) {
  return new ReleaseRecoveryEvidenceReconciler({
    intents: new ReleaseDeploymentIntentService(store),
    events: events as any,
    audit: audit as any,
    workerId: "w-recon",
  });
}

async function allEventsFor(events: EventService, executionId: string): Promise<any[]> {
  return (await events.byExecution(executionId)) as any[];
}

async function main() {
  console.log("NEXUS PHASE 122 RECOVERY EVIDENCE RECONCILIATION TESTS");
  console.log("=====================================================\n");

  /* ---- T1 ---- */
  {
    const { store, events, audit } = await newEnv();
    const key = T("k-t1");
    seedIntent(store, {
      intentKey: key, releaseId: T("rel-t1"), executionId: T("exec-t1"),
      artifactId: T("art-t1"), artifactDigest: "d-t1", environment: "staging",
      projectId: "p-t1", containerName: T("c-t1"), containerPort: 4173,
      imageId: "sha256:img-t1", imageDigest: "dg-t1", status: "FAILED",
    });
    const intent = store.getReleaseIntent(key)!;
    await emitStarted(events, intent);
    await emitDecision(events, intent, "passed", "VERIFIED");
    await emitVerified(events, intent);
    const r = await reconcilerFor(store, events, audit).reconcile(key);
    check("T1 verified evidence reconciles as CONSISTENT", r.verdict === "CONSISTENT", "verdict=" + r.verdict + " reason=" + r.reason);
    check("T1 decision is VERIFIED", r.decision === "VERIFIED");
  }

  /* ---- T2 ---- */
  {
    const { store, events, audit } = await newEnv();
    const key = T("k-t2");
    seedIntent(store, {
      intentKey: key, releaseId: T("rel-t2"), executionId: T("exec-t2"),
      artifactId: T("art-t2"), artifactDigest: "d-t2", environment: "staging",
      projectId: "p-t2", containerName: T("c-t2"), containerPort: 4173,
      imageId: "sha256:img-t2", imageDigest: "dg-t2", status: "FAILED",
    });
    const intent = store.getReleaseIntent(key)!;
    await emitStarted(events, intent, { intentKey: T("other-t2") });
    await emitDecision(events, intent, "passed", "VERIFIED");
    const r = await reconcilerFor(store, events, audit).reconcile(key);
    check("T2 intent identity mismatch -> RECOVERY_REQUIRED", r.verdict === "RECOVERY_REQUIRED", "reason=" + r.reason);
  }

  /* ---- T3 ---- */
  {
    const { store, events, audit } = await newEnv();
    const key = T("k-t3");
    seedIntent(store, {
      intentKey: key, releaseId: T("rel-t3"), executionId: T("exec-t3"),
      artifactId: T("art-t3"), artifactDigest: "d-t3", environment: "staging",
      projectId: "p-t3", containerName: T("c-t3"), containerPort: 4173,
      imageId: "sha256:img-t3", imageDigest: "dg-t3", status: "FAILED",
    });
    const intent = store.getReleaseIntent(key)!;
    await emitStarted(events, intent, { executionId: T("other-exec-t3") });
    await emitDecision(events, intent, "passed", "VERIFIED");
    const r = await reconcilerFor(store, events, audit).reconcile(key);
    check("T3 execution identity mismatch -> RECOVERY_REQUIRED", r.verdict === "RECOVERY_REQUIRED", "reason=" + r.reason);
  }

  /* ---- T4 ---- */
  {
    const { store, events, audit } = await newEnv();
    const key = T("k-t4");
    seedIntent(store, {
      intentKey: key, releaseId: T("rel-t4"), executionId: T("exec-t4"),
      artifactId: T("art-t4"), artifactDigest: "d-t4", environment: "staging",
      projectId: "p-t4", containerName: T("c-t4"), containerPort: 4173,
      imageId: "sha256:img-t4", imageDigest: "dg-t4", status: "FAILED",
    });
    const intent = store.getReleaseIntent(key)!;
    await emitStarted(events, intent, { releaseId: T("other-rel-t4") });
    await emitDecision(events, intent, "passed", "VERIFIED");
    const r = await reconcilerFor(store, events, audit).reconcile(key);
    check("T4 release identity mismatch -> RECOVERY_REQUIRED", r.verdict === "RECOVERY_REQUIRED", "reason=" + r.reason);
  }

  /* ---- T5 ---- */
  {
    const { store, events, audit } = await newEnv();
    const key = T("k-t5");
    seedIntent(store, {
      intentKey: key, releaseId: T("rel-t5"), executionId: T("exec-t5"),
      artifactId: T("art-t5"), artifactDigest: "d-t5", environment: "staging",
      projectId: "p-t5", containerName: T("c-t5"), containerPort: 4173,
      imageId: "sha256:img-t5", imageDigest: "dg-t5", status: "FAILED",
    });
    const intent = store.getReleaseIntent(key)!;
    await emitStarted(events, intent, { rollbackTargetReleaseId: T("other-target-t5") });
    await emitDecision(events, intent, "passed", "VERIFIED");
    const r = await reconcilerFor(store, events, audit).reconcile(key);
    check("T5 rollback target mismatch -> RECOVERY_REQUIRED", r.verdict === "RECOVERY_REQUIRED", "reason=" + r.reason);
  }

  /* ---- T6 ---- */
  {
    const { store, events, audit } = await newEnv();
    const key = T("k-t6");
    seedIntent(store, {
      intentKey: key, releaseId: T("rel-t6"), executionId: T("exec-t6"),
      artifactId: T("art-t6"), artifactDigest: "d-t6", environment: "staging",
      projectId: "p-t6", containerName: T("c-t6"), containerPort: 4173,
      imageId: "sha256:img-t6", imageDigest: "dg-t6", status: "FAILED",
    });
    const intent = store.getReleaseIntent(key)!;
    await emitStarted(events, intent, { expectedArtifactDigest: "TAMPERED" });
    await emitDecision(events, intent, "passed", "VERIFIED");
    const r = await reconcilerFor(store, events, audit).reconcile(key);
    check("T6 expected artifact digest mismatch -> RECOVERY_REQUIRED", r.verdict === "RECOVERY_REQUIRED", "reason=" + r.reason);
  }

  /* ---- T7 ---- */
  {
    const { store, events, audit } = await newEnv();
    const key = T("k-t7");
    seedIntent(store, {
      intentKey: key, releaseId: T("rel-t7"), executionId: T("exec-t7"),
      artifactId: T("art-t7"), artifactDigest: "d-t7", environment: "staging",
      projectId: "p-t7", containerName: T("c-t7"), containerPort: 4173,
      imageId: "sha256:img-t7", imageDigest: "dg-t7", status: "FAILED",
    });
    const intent = store.getReleaseIntent(key)!;
    await emitStarted(events, intent, { observedImageId: "sha256:WRONG" });
    await emitDecision(events, intent, "passed", "VERIFIED");
    const r = await reconcilerFor(store, events, audit).reconcile(key);
    check("T7 observed image mismatch -> RECOVERY_REQUIRED", r.verdict === "RECOVERY_REQUIRED", "reason=" + r.reason);
  }

  /* ---- T8 ---- */
  {
    const { store, events, audit } = await newEnv();
    const key = T("k-t8");
    seedIntent(store, {
      intentKey: key, releaseId: T("rel-t8"), executionId: T("exec-t8"),
      artifactId: T("art-t8"), artifactDigest: "d-t8", environment: "staging",
      projectId: "p-t8", containerName: T("c-t8"), containerPort: 4173,
      imageId: "sha256:img-t8", imageDigest: "dg-t8", status: "FAILED",
    });
    const intent = store.getReleaseIntent(key)!;
    await emitDecision(events, intent, "passed", "VERIFIED");
    const r = await reconcilerFor(store, events, audit).reconcile(key);
    check("T8 missing verification_started -> RECOVERY_REQUIRED", r.verdict === "RECOVERY_REQUIRED", "reason=" + r.reason);
  }

  /* ---- T9 ---- */
  {
    const { store, events, audit } = await newEnv();
    const key = T("k-t9");
    seedIntent(store, {
      intentKey: key, releaseId: T("rel-t9"), executionId: T("exec-t9"),
      artifactId: T("art-t9"), artifactDigest: "d-t9", environment: "staging",
      projectId: "p-t9", containerName: T("c-t9"), containerPort: 4173,
      imageId: "sha256:img-t9", imageDigest: "dg-t9", status: "FAILED",
    });
    const intent = store.getReleaseIntent(key)!;
    await emitStarted(events, intent);
    const r = await reconcilerFor(store, events, audit).reconcile(key);
    check("T9 verification decision missing -> RECOVERY_REQUIRED", r.verdict === "RECOVERY_REQUIRED", "reason=" + r.reason);
  }

  /* ---- T11 ---- */
  {
    const { store, events, audit } = await newEnv();
    const key = T("k-t11");
    seedIntent(store, {
      intentKey: key, releaseId: T("rel-t11"), executionId: T("exec-t11"),
      artifactId: T("art-t11"), artifactDigest: "d-t11", environment: "staging",
      projectId: "p-t11", containerName: T("c-t11"), containerPort: 4173,
      imageId: "sha256:img-t11", imageDigest: "dg-t11", status: "ROLLING_BACK",
    });
    const intent = store.getReleaseIntent(key)!;
    await emitStarted(events, intent);
    await emitDecision(events, intent, "passed", "VERIFIED");
    await emitVerified(events, intent);
    const r = await reconcilerFor(store, events, audit).reconcile(key);
    check("T11 passed evidence + nonterminal state -> RECOVERY_REQUIRED", r.verdict === "RECOVERY_REQUIRED", "reason=" + r.reason);
  }

  /* ---- T12 ---- */
  {
    const { store, events, audit } = await newEnv();
    const key = T("k-t12");
    seedIntent(store, {
      intentKey: key, releaseId: T("rel-t12"), executionId: T("exec-t12"),
      artifactId: T("art-t12"), artifactDigest: "d-t12", environment: "staging",
      projectId: "p-t12", containerName: T("c-t12"), containerPort: 4173,
      imageId: "sha256:img-t12", imageDigest: "dg-t12", status: "VERIFICATION_FAILED",
    });
    const intent = store.getReleaseIntent(key)!;
    await emitStarted(events, intent);
    await emitDecision(events, intent, "failed", "VERIFICATION_FAILED");
    const r = await reconcilerFor(store, events, audit).reconcile(key);
    check("T12 failed evidence + VERIFICATION_FAILED -> CONSISTENT", r.verdict === "CONSISTENT", "reason=" + r.reason);
    check("T12 decision is VERIFICATION_FAILED", r.decision === "VERIFICATION_FAILED");
  }

  /* ---- T13 ---- */
  {
    const { store, events, audit } = await newEnv();
    const key = T("k-t13");
    seedIntent(store, {
      intentKey: key, releaseId: T("rel-t13"), executionId: T("exec-t13"),
      artifactId: T("art-t13"), artifactDigest: "d-t13", environment: "staging",
      projectId: "p-t13", containerName: T("c-t13"), containerPort: 4173,
      imageId: "sha256:img-t13", imageDigest: "dg-t13", status: "FAILED",
    });
    const intent = store.getReleaseIntent(key)!;
    await emitStarted(events, intent);
    await emitDecision(events, intent, "failed", "VERIFICATION_FAILED");
    const r = await reconcilerFor(store, events, audit).reconcile(key);
    check("T13 failed evidence + FAILED status -> RECOVERY_REQUIRED", r.verdict === "RECOVERY_REQUIRED", "reason=" + r.reason);
  }

  /* ---- T14 ---- */
  {
    const { store, events, audit } = await newEnv();
    const key = T("k-t14");
    seedIntent(store, {
      intentKey: key, releaseId: T("rel-t14"), executionId: T("exec-t14"),
      artifactId: T("art-t14"), artifactDigest: "d-t14", environment: "staging",
      projectId: "p-t14", containerName: T("c-t14"), containerPort: 4173,
      imageId: "sha256:img-t14", imageDigest: "dg-t14", status: "RECOVERY_REQUIRED",
    });
    const intent = store.getReleaseIntent(key)!;
    await emitStarted(events, intent);
    await emitDecision(events, intent, "blocked", "BLOCKED");
    const r = await reconcilerFor(store, events, audit).reconcile(key);
    check("T14 blocked evidence + RECOVERY_REQUIRED -> CONSISTENT", r.verdict === "CONSISTENT", "reason=" + r.reason);
    check("T14 decision is BLOCKED", r.decision === "BLOCKED");
  }

  /* ---- T15 ---- */
  {
    const { store, events, audit } = await newEnv();
    const key = T("k-t15");
    seedIntent(store, {
      intentKey: key, releaseId: T("rel-t15"), executionId: T("exec-t15"),
      artifactId: T("art-t15"), artifactDigest: "d-t15", environment: "staging",
      projectId: "p-t15", containerName: T("c-t15"), containerPort: 4173,
      imageId: "sha256:img-t15", imageDigest: "dg-t15", status: "RECOVERY_REQUIRED",
    });
    const intent = store.getReleaseIntent(key)!;
    await emitStarted(events, intent);
    await emitDecision(events, intent, "blocked", "EXCEPTION", { reason: "verifier threw" });
    const r = await reconcilerFor(store, events, audit).reconcile(key);
    check("T15 verification exception -> RECOVERY_REQUIRED", r.verdict === "RECOVERY_REQUIRED", "reason=" + r.reason);
    check("T15 decision is EXCEPTION", r.decision === "EXCEPTION");
  }

  /* ---- T16 ---- */
  {
    const { store, events, audit } = await newEnv();
    const key = T("k-t16");
    seedIntent(store, {
      intentKey: key, releaseId: T("rel-t16"), executionId: T("exec-t16"),
      artifactId: T("art-t16"), artifactDigest: "d-t16", environment: "staging",
      projectId: "p-t16", containerName: T("c-t16"), containerPort: 4173,
      imageId: "sha256:img-t16", imageDigest: "dg-t16", status: "FAILED",
    });
    const intent = store.getReleaseIntent(key)!;
    await emitStarted(events, intent);
    await emitDecision(events, intent, "passed", "VERIFIED");
    await emitDecision(events, intent, "failed", "VERIFICATION_FAILED");
    const r = await reconcilerFor(store, events, audit).reconcile(key);
    check("T16 contradictory decisions -> RECOVERY_REQUIRED", r.verdict === "RECOVERY_REQUIRED", "reason=" + r.reason);
  }

  /* ---- T17 ---- */
  {
    const { store, events, audit } = await newEnv();
    const key = T("k-t17");
    seedIntent(store, {
      intentKey: key, releaseId: T("rel-t17"), executionId: T("exec-t17"),
      artifactId: T("art-t17"), artifactDigest: "d-t17", environment: "staging",
      projectId: "p-t17", containerName: T("c-t17"), containerPort: 4173,
      imageId: "sha256:img-t17", imageDigest: "dg-t17", status: "FAILED",
    });
    const intent = store.getReleaseIntent(key)!;
    await emitStarted(events, intent);
    await emitDecision(events, intent, "passed", "VERIFIED");
    await emitVerified(events, intent);
    const rec = reconcilerFor(store, events, audit);
    const r1 = await rec.reconcile(key);
    const r2 = await rec.reconcile(key);
    const reconciledCount = (await allEventsFor(events, intent.executionId))
      .filter((e) => e.type === "release.recovery.rollback.evidence.reconciled").length;
    check("T17 reconcile idempotent: same verdict", r1.verdict === r2.verdict, "v1=" + r1.verdict + " v2=" + r2.verdict);
    check("T17 no duplicate reconciled event emitted", reconciledCount === 1, "reconciledCount=" + reconciledCount);
  }

  /* ---- T18 ---- */
  {
    const { store, events, audit } = await newEnv();
    const key = T("k-t18");
    seedIntent(store, {
      intentKey: key, releaseId: T("rel-t18"), executionId: T("exec-t18"),
      artifactId: T("art-t18"), artifactDigest: "d-t18", environment: "staging",
      projectId: "p-t18", containerName: T("c-t18"), containerPort: 4173,
      imageId: "sha256:img-t18", imageDigest: "dg-t18", status: "FAILED",
    });
    const intent = store.getReleaseIntent(key)!;
    await emitStarted(events, intent);
    await emitDecision(events, intent, "passed", "VERIFIED", { expectedImageId: "sha256:A" });
    await emitDecision(events, intent, "passed", "VERIFIED", { expectedImageId: "sha256:B" });
    const r = await reconcilerFor(store, events, audit).reconcile(key);
    check("T18 conflicting duplicate passed events -> RECOVERY_REQUIRED", r.verdict === "RECOVERY_REQUIRED", "reason=" + r.reason);
  }

  /* ---- T19 ---- */
  {
    const { store, events, audit } = await newEnv();
    const key = T("k-t19");
    seedIntent(store, {
      intentKey: key, releaseId: T("rel-t19"), executionId: T("exec-t19"),
      artifactId: T("art-t19"), artifactDigest: "d-t19", environment: "staging",
      projectId: "p-t19", containerName: T("c-t19"), containerPort: 4173,
      imageId: "sha256:img-t19", imageDigest: "dg-t19", status: "FAILED",
    });
    const intent = store.getReleaseIntent(key)!;
    await emitStarted(events, intent);
    await emitDecision(events, intent, "passed", "VERIFIED");
    await emitVerified(events, intent);
    const rec = reconcilerFor(store, events, audit);
    await rec.reconcile(key);
    await rec.reconcile(key);
    const startedCount = (await allEventsFor(events, intent.executionId))
      .filter((e) => e.type === "release.recovery.rollback.verification_started").length;
    const passedCount = (await allEventsFor(events, intent.executionId))
      .filter((e) => e.type === "release.recovery.rollback.verification_passed").length;
    check("T19 replay: no second verification_started", startedCount === 1, "started=" + startedCount);
    check("T19 replay: no duplicate verification_passed", passedCount === 1, "passed=" + passedCount);
  }

  /* ---- T20 ---- */
  {
    const { store, events, audit } = await newEnv();
    const key = T("k-t20");
    seedIntent(store, {
      intentKey: key, releaseId: T("rel-t20"), executionId: T("exec-t20"),
      artifactId: T("art-t20"), artifactDigest: "d-t20", environment: "staging",
      projectId: "p-t20", containerName: T("c-t20"), containerPort: 4173,
      imageId: "sha256:img-t20", imageDigest: "dg-t20", status: "ROLLING_BACK",
    });
    const r = await reconcilerFor(store, events, audit).reconcile(key);
    check("T20 no evidence + active state -> RECOVERY_REQUIRED", r.verdict === "RECOVERY_REQUIRED", "reason=" + r.reason);
  }

  /* ---- T21 ---- */
  {
    const { store, events, audit } = await newEnv();
    const key = T("k-t21");
    seedIntent(store, {
      intentKey: key, releaseId: T("rel-t21"), executionId: T("exec-t21"),
      artifactId: T("art-t21"), artifactDigest: "d-t21", environment: "staging",
      projectId: "p-t21", containerName: T("c-t21"), containerPort: 4173,
      imageId: "sha256:img-t21", imageDigest: "dg-t21", status: "FAILED",
    });
    const intent = store.getReleaseIntent(key)!;
    await events.emit({
      type: "release.recovery.rollback.verification_started" as any,
      source: "test", execution_id: T("other-exec-t21"),
      payload: evidenceBase(intent) as any,
    });
    await events.emit({
      type: "release.recovery.rollback.verification_passed" as any,
      source: "test", execution_id: T("other-exec-t21"),
      payload: { ...evidenceBase(intent), verificationStatus: "VERIFIED", reason: "test" } as any,
    });
    const r = await reconcilerFor(store, events, audit).reconcile(key);
    check("T21 evidence from another execution -> RECOVERY_REQUIRED", r.verdict === "RECOVERY_REQUIRED", "reason=" + r.reason);
  }

  /* ---- T22 ---- */
  {
    const { store, events, audit } = await newEnv();
    const key = T("k-t22");
    seedIntent(store, {
      intentKey: key, releaseId: T("rel-t22"), executionId: T("exec-t22"),
      artifactId: T("art-t22"), artifactDigest: "d-t22", environment: "staging",
      projectId: "p-t22", containerName: T("c-t22"), containerPort: 4173,
      imageId: "sha256:img-t22", imageDigest: "dg-t22", status: "FAILED",
    });
    const intent = store.getReleaseIntent(key)!;
    await emitStarted(events, intent);
    await emitDecision(events, intent, "passed", "VERIFIED");
    await emitVerified(events, intent);
    await reconcilerFor(store, events, audit).reconcile(key);
    const reconciled = (await allEventsFor(events, intent.executionId))
      .find((e) => e.type === "release.recovery.rollback.evidence.reconciled");
    const json = JSON.stringify(reconciled?.payload ?? {});
    const hasCreds = /https?:\/\/[^"\s]*@/.test(json) || /:\/\/[^/]+:[^/]+@/.test(json);
    check("T22 reconciled payload contains no credential-bearing URL", !hasCreds, "payload=" + json.slice(0, 200));
  }

  /* ---- T23 ---- */
  {
    const { store, events, audit } = await newEnv();
    const key = T("k-t23");
    seedIntent(store, {
      intentKey: key, releaseId: T("rel-t23"), executionId: T("exec-t23"),
      artifactId: T("art-t23"), artifactDigest: "d-t23", environment: "staging",
      projectId: "p-t23", containerName: T("c-t23"), containerPort: 4173,
      imageId: "sha256:img-t23", imageDigest: "dg-t23", status: "FAILED",
    });
    const intent = store.getReleaseIntent(key)!;
    await emitStarted(events, intent, { password: "hunter2" } as any);
    await emitDecision(events, intent, "passed", "VERIFIED");
    const r = await reconcilerFor(store, events, audit).reconcile(key);
    check("T23 forbidden key in evidence -> RECOVERY_REQUIRED", r.verdict === "RECOVERY_REQUIRED", "reason=" + r.reason);
  }

  /* ---- T24 ---- */
  {
    const { engine, store, events, audit } = await newEnv();
    const key = T("k-t24");
    seedIntent(store, {
      intentKey: key, releaseId: T("rel-t24"), executionId: T("exec-t24"),
      artifactId: T("art-t24"), artifactDigest: "d-t24", environment: "staging",
      projectId: "p-t24", containerName: T("c-t24"), containerPort: 4173,
      imageId: "sha256:img-t24", imageDigest: "dg-t24", status: "FAILED",
    });
    const intent = store.getReleaseIntent(key)!;
    await emitStarted(events, intent);
    await emitDecision(events, intent, "passed", "VERIFIED");
    await emitVerified(events, intent);
    const events2 = new EventService(engine);
    await events2.init();
    const audit2 = new AuditService(engine);
    const store2 = new ExecutionStore(engine);
    const r = await reconcilerFor(store2, events2, audit2).reconcile(key);
    check("T24 reconciliation survives reload -> CONSISTENT", r.verdict === "CONSISTENT", "verdict=" + r.verdict + " reason=" + r.reason);
  }

  /* ---- T25 ---- */
  {
    const { store, events, audit } = await newEnv();
    const key = T("k-t25");
    seedIntent(store, {
      intentKey: key, releaseId: T("rel-t25"), executionId: T("exec-t25"),
      artifactId: T("art-t25"), artifactDigest: "d-t25", environment: "staging",
      projectId: "p-t25", containerName: T("c-t25"), containerPort: 4173,
      imageId: "sha256:img-t25", imageDigest: "dg-t25", status: "FAILED",
    });
    const intent = store.getReleaseIntent(key)!;
    await emitStarted(events, intent);
    await emitDecision(events, intent, "passed", "VERIFIED");
    await emitVerified(events, intent);
    await reconcilerFor(store, events, audit).reconcile(key);
    const records = await audit.byResource(key);
    const ours = records.filter((r: any) => r.action === "release.recovery.rollback.evidence.reconcile");
    check("T25 reconciliation decision durably audited", ours.length >= 1, "audit_count=" + ours.length);
    check("T25 audit metadata records verdict", ours.length > 0 && (ours[0].metadata as any)?.verdict === "CONSISTENT");
  }

  /* ---- T28 ---- */
  {
    const { store, events, audit } = await newEnv();
    const key = T("k-t28");
    seedIntent(store, {
      intentKey: key, releaseId: T("rel-t28"), executionId: T("exec-t28"),
      artifactId: T("art-t28"), artifactDigest: "d-t28", environment: "staging",
      projectId: "p-t28", containerName: T("c-t28"), containerPort: 4173,
      imageId: "sha256:img-t28", imageDigest: "dg-t28", status: "FAILED",
    });
    const intent = store.getReleaseIntent(key)!;
    await emitStarted(events, intent);
    await emitDecision(events, intent, "passed", "VERIFIED");
    await emitVerified(events, intent);
    const rec = reconcilerFor(store, events, audit);
    const r1 = await rec.reconcile(key);
    const r2 = await rec.reconcile(key);
    const r3 = await rec.reconcile(key);
    const same =
      r1.verdict === r2.verdict && r2.verdict === r3.verdict &&
      r1.decision === r2.decision && r2.decision === r3.decision &&
      r1.reason === r2.reason && r2.reason === r3.reason;
    check("T28 reconciliation decision deterministic", same, "v=" + r1.verdict + " d=" + r1.decision);
  }

  console.log("\nRESULT: " + pass + " passed, " + fail + " failed");
  if (fail > 0) process.exit(1);
  process.exit(0);
}

main().catch((e) => { console.error("[FATAL]", e); process.exit(2); });