// scripts/test-phase123-production-recovery-evidence-integration.ts
// Phase 123 — production recovery evidence reconciliation integration.
//
// Drives the REAL ReleaseRecoveryExecutor.runOnce() path with a reconciler
// wired in, exactly as src/core/kernel.ts constructs it. Asserts against
// durable EventService / AuditService state.
import { openEngine } from "../src/core/db";
import { EventService } from "../src/core/events";
import { AuditService } from "../src/core/audit";
import { ExecutionStore } from "../src/core/execution-store";
import { ReleaseDeploymentIntentService } from "../src/core/release-deployment-intent";
import { ReleaseRecoveryService } from "../src/core/release-recovery";
import { ReleaseRecoveryExecutor } from "../src/core/release-recovery-executor";
import { ReleaseRecoveryEvidenceReconciler } from "../src/core/release-recovery-evidence-reconciliation";
import type { DockerAdapter, DockerOp, DockerResult, SmokeTestService } from "../src/core/runtime";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log("[PASSED] " + name + (detail ? " | " + detail : "")); }
  else { fail++; console.error("[FAILED] " + name + (detail ? " | " + detail : "")); }
}
const RUN = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
const T = (s: string) => s + "-" + RUN;

type Script = (op: DockerOp) => Partial<DockerResult> | undefined;
function mockDocker(script: Script): DockerAdapter {
  return { async run(op: DockerOp): Promise<DockerResult> {
    const over = script(op) ?? {};
    return { status: "SUCCEEDED", command: "docker " + op.kind, exit_code: 0,
      stdout: "", stderr: "", duration_ms: 1, blocked_reason: null, ...over } as DockerResult;
  } } as any;
}
function dockerMatches(name: string, imageId: string, port: number): DockerAdapter {
  return mockDocker((op) => (op.kind === "inspect" && (op as any).image === name)
    ? { stdout: JSON.stringify([{ Id: "cid-p123", Image: imageId,
        NetworkSettings: { Ports: { [port + "/tcp"]: [{ HostPort: String(port) }] } } }]) }
    : undefined);
}

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

function buildReconciler(store: ExecutionStore, events: any, audit: any, workerId = "w-rec") {
  return new ReleaseRecoveryEvidenceReconciler({
    intents: new ReleaseDeploymentIntentService(store),
    events: events as any,
    audit: audit as any,
    workerId,
  });
}

interface ExecOpts {
  workerId?: string;
  verify?: () => Promise<{ status: "VERIFIED" | "BLOCKED" | "VERIFICATION_FAILED"; message: string }>;
  rollback?: () => Promise<{ status: "COMPLETED" | "BLOCKED" | "FAILED"; deploymentId: string | null; message: string }>;
  reconciler?: any;
}

function buildExecutor(
  store: ExecutionStore, events: any, audit: any, docker: DockerAdapter, opts: ExecOpts = {},
) {
  const workerId = opts.workerId ?? "w-exec";
  const reconciler = opts.reconciler ?? buildReconciler(store, events, audit, workerId + "-rec");
  return new ReleaseRecoveryExecutor({
    intents: new ReleaseDeploymentIntentService(store),
    recovery: new ReleaseRecoveryService(),
    orchestrator: {} as any,
    history: {} as any,
    docker,
    smoke: {} as SmokeTestService,
    svc: { events, audit } as any,
    workerId,
    rollback: opts.rollback ? ({ rollback: opts.rollback } as any) : undefined,
    verifyRecoveredRollback: opts.verify ? ({ verify: opts.verify } as any) : undefined,
    reconciler,
  });
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
    observedContainerId: "cid-p123",
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
    source: "test", execution_id: intent.executionId,
    payload: evidenceBase(intent, overrides) as any,
  });
}
async function emitDecision(events: EventService, intent: any,
  kind: "passed" | "failed" | "blocked", status: string,
  overrides: Record<string, unknown> = {},
) {
  await events.emit({
    type: ("release.recovery.rollback.verification_" + kind) as any,
    source: "test", execution_id: intent.executionId,
    payload: { ...evidenceBase(intent), verificationStatus: status, reason: "test", ...overrides } as any,
  });
}
async function emitVerified(events: EventService, intent: any) {
  await events.emit({
    type: "release.recovery.rollback.verified" as any,
    source: "test", execution_id: intent.executionId,
    payload: { ...evidenceBase(intent), verificationStatus: "VERIFIED", reason: "test" } as any,
  });
}

async function eventsForIntent(events: EventService, executionId: string, intentKey: string): Promise<any[]> {
  const all = (await events.byExecution(executionId)) as any[];
  return all.filter((e) => e?.payload && e.payload.intentKey === intentKey);
}
function reconciledOf(evs: any[]): any[] {
  return evs.filter((e) => e.type === "release.recovery.rollback.evidence.reconciled");
}

async function main() {
  console.log("NEXUS PHASE 123 PRODUCTION RECOVERY EVIDENCE INTEGRATION TESTS");
  console.log("=============================================================\n");

  /* ---- T1: executor uses reconciler when wired ---- */
  {
    const { store, events, audit } = await newEnv();
    const key = T("k-t1"); const cname = T("c-t1");
    seedIntent(store, {
      intentKey: key, releaseId: T("rel-t1"), executionId: T("exec-t1"),
      artifactId: T("art-t1"), artifactDigest: "d1", environment: "staging",
      projectId: "p-t1", containerName: cname, containerPort: 4173,
      imageId: "sha256:img-t1", imageDigest: "dg1", status: "ROLLING_BACK",
    });
    const exec = buildExecutor(store, events, audit, dockerMatches(cname, "sha256:img-t1", 4173), {
      verify: async () => ({ status: "VERIFIED", message: "PASS" }),
      rollback: async () => ({ status: "COMPLETED", deploymentId: null, message: "no" }),
    });
    await exec.runOnce();
    const evs = await eventsForIntent(events, store.getReleaseIntent(key)!.executionId, key);
    check("T1 production executor produced reconciled event", reconciledOf(evs).length >= 1,
      "reconciled=" + reconciledOf(evs).length);
  }

  /* ---- T2 + T3: verified rollback reaches reconciliation, CONSISTENT/VERIFIED ---- */
  let t3report: any = null;
  {
    const { store, events, audit } = await newEnv();
    const key = T("k-t3"); const cname = T("c-t3");
    seedIntent(store, {
      intentKey: key, releaseId: T("rel-t3"), executionId: T("exec-t3"),
      artifactId: T("art-t3"), artifactDigest: "d3", environment: "staging",
      projectId: "p-t3", containerName: cname, containerPort: 4173,
      imageId: "sha256:img-t3", imageDigest: "dg3", status: "ROLLING_BACK",
    });
    let rollbackCalls = 0, verifyCalls = 0;
    const exec = buildExecutor(store, events, audit, dockerMatches(cname, "sha256:img-t3", 4173), {
      verify: async () => { verifyCalls++; return { status: "VERIFIED", message: "PASS" }; },
      rollback: async () => { rollbackCalls++; return { status: "COMPLETED", deploymentId: null, message: "no" }; },
    });
    t3report = await exec.runOnce();
    const intent = store.getReleaseIntent(key)!;
    const evs = await eventsForIntent(events, intent.executionId, key);
    const rec = reconciledOf(evs);
    check("T2 recoverable ROLLBACK reached reconciliation via runOnce", rec.length >= 1,
      "report.scanned=" + t3report.scanned + " acted=" + t3report.acted);
    check("T3 reconciled verdict CONSISTENT", rec.length >= 1 && rec[0].payload.verdict === "CONSISTENT",
      "verdict=" + (rec[0]?.payload?.verdict ?? "none"));
    check("T3 reconciled decision VERIFIED", rec.length >= 1 && rec[0].payload.decision === "VERIFIED",
      "decision=" + (rec[0]?.payload?.decision ?? "none"));
    check("T3 intent terminal FAILED", intent.status === "FAILED", "status=" + intent.status);
    check("T3 no rollback provider re-call", rollbackCalls === 0, "rollbackCalls=" + rollbackCalls);
    check("T3 verify called exactly once", verifyCalls === 1, "verifyCalls=" + verifyCalls);
  }

  /* ---- T4: FAILED verification path ---- */
  {
    const { store, events, audit } = await newEnv();
    const key = T("k-t4"); const cname = T("c-t4");
    seedIntent(store, {
      intentKey: key, releaseId: T("rel-t4"), executionId: T("exec-t4"),
      artifactId: T("art-t4"), artifactDigest: "d4", environment: "staging",
      projectId: "p-t4", containerName: cname, containerPort: 8080,
      imageId: "sha256:img-t4", imageDigest: "dg4", status: "ROLLING_BACK",
    });
    const exec = buildExecutor(store, events, audit, dockerMatches(cname, "sha256:img-t4", 8080), {
      verify: async () => ({ status: "VERIFICATION_FAILED", message: "smoke FAIL" }),
      rollback: async () => ({ status: "COMPLETED", deploymentId: null, message: "no" }),
    });
    await exec.runOnce();
    const intent = store.getReleaseIntent(key)!;
    const rec = reconciledOf(await eventsForIntent(events, intent.executionId, key));
    check("T4 FAILED verdict CONSISTENT", rec.length >= 1 && rec[0].payload.verdict === "CONSISTENT",
      "verdict=" + (rec[0]?.payload?.verdict ?? "none"));
    check("T4 FAILED decision VERIFICATION_FAILED",
      rec.length >= 1 && rec[0].payload.decision === "VERIFICATION_FAILED",
      "decision=" + (rec[0]?.payload?.decision ?? "none"));
    check("T4 intent VERIFICATION_FAILED", intent.status === "VERIFICATION_FAILED", "status=" + intent.status);
  }

  /* ---- T5: BLOCKED path ---- */
  {
    const { store, events, audit } = await newEnv();
    const key = T("k-t5"); const cname = T("c-t5");
    seedIntent(store, {
      intentKey: key, releaseId: T("rel-t5"), executionId: T("exec-t5"),
      artifactId: T("art-t5"), artifactDigest: "d5", environment: "staging",
      projectId: "p-t5", containerName: cname, containerPort: 8080,
      imageId: "sha256:img-t5", imageDigest: "dg5", status: "ROLLING_BACK",
    });
    const exec = buildExecutor(store, events, audit, dockerMatches(cname, "sha256:img-t5", 8080), {
      verify: async () => ({ status: "BLOCKED", message: "playwright unavailable" }),
      rollback: async () => ({ status: "COMPLETED", deploymentId: null, message: "no" }),
    });
    await exec.runOnce();
    const intent = store.getReleaseIntent(key)!;
    const rec = reconciledOf(await eventsForIntent(events, intent.executionId, key));
    check("T5 BLOCKED verdict CONSISTENT", rec.length >= 1 && rec[0].payload.verdict === "CONSISTENT",
      "verdict=" + (rec[0]?.payload?.verdict ?? "none"));
    check("T5 BLOCKED decision BLOCKED", rec.length >= 1 && rec[0].payload.decision === "BLOCKED",
      "decision=" + (rec[0]?.payload?.decision ?? "none"));
    check("T5 intent RECOVERY_REQUIRED", intent.status === "RECOVERY_REQUIRED", "status=" + intent.status);
  }

  /* ---- T6: EXCEPTION path ---- */
  {
    const { store, events, audit } = await newEnv();
    const key = T("k-t6"); const cname = T("c-t6");
    seedIntent(store, {
      intentKey: key, releaseId: T("rel-t6"), executionId: T("exec-t6"),
      artifactId: T("art-t6"), artifactDigest: "d6", environment: "staging",
      projectId: "p-t6", containerName: cname, containerPort: 8080,
      imageId: "sha256:img-t6", imageDigest: "dg6", status: "ROLLING_BACK",
    });
    const exec = buildExecutor(store, events, audit, dockerMatches(cname, "sha256:img-t6", 8080), {
      verify: async () => { throw new Error("verifier exploded"); },
      rollback: async () => ({ status: "COMPLETED", deploymentId: null, message: "no" }),
    });
    await exec.runOnce();
    const intent = store.getReleaseIntent(key)!;
    const rec = reconciledOf(await eventsForIntent(events, intent.executionId, key));
    check("T6 EXCEPTION verdict RECOVERY_REQUIRED",
      rec.length >= 1 && rec[0].payload.verdict === "RECOVERY_REQUIRED",
      "verdict=" + (rec[0]?.payload?.verdict ?? "none"));
    check("T6 EXCEPTION decision EXCEPTION", rec.length >= 1 && rec[0].payload.decision === "EXCEPTION",
      "decision=" + (rec[0]?.payload?.decision ?? "none"));
    check("T6 intent RECOVERY_REQUIRED", intent.status === "RECOVERY_REQUIRED", "status=" + intent.status);
  }

  /* ---- T7: missing evidence fails closed ---- */
  {
    const { store, events, audit } = await newEnv();
    const key = T("k-t7");
    seedIntent(store, {
      intentKey: key, releaseId: T("rel-t7"), executionId: T("exec-t7"),
      artifactId: T("art-t7"), artifactDigest: "d7", environment: "staging",
      projectId: "p-t7", containerName: T("c-t7"), containerPort: 4173,
      imageId: "sha256:img-t7", imageDigest: "dg7", status: "FAILED",
    });
    const exec = buildExecutor(store, events, audit, mockDocker(() => undefined));
    await exec.runOnce();
    const intent = store.getReleaseIntent(key)!;
    const rec = reconciledOf(await eventsForIntent(events, intent.executionId, key));
    check("T7 missing evidence -> RECOVERY_REQUIRED",
      rec.length >= 1 && rec[0].payload.verdict === "RECOVERY_REQUIRED",
      "verdict=" + (rec[0]?.payload?.verdict ?? "none") + " reason=" + (rec[0]?.payload?.reason ?? ""));
  }

  /* ---- T8: contradictory evidence fails closed ---- */
  {
    const { store, events, audit } = await newEnv();
    const key = T("k-t8");
    seedIntent(store, {
      intentKey: key, releaseId: T("rel-t8"), executionId: T("exec-t8"),
      artifactId: T("art-t8"), artifactDigest: "d8", environment: "staging",
      projectId: "p-t8", containerName: T("c-t8"), containerPort: 4173,
      imageId: "sha256:img-t8", imageDigest: "dg8", status: "FAILED",
    });
    const intent = store.getReleaseIntent(key)!;
    await emitStarted(events, intent);
    await emitDecision(events, intent, "passed", "VERIFIED");
    await emitDecision(events, intent, "failed", "VERIFICATION_FAILED");
    const exec = buildExecutor(store, events, audit, mockDocker(() => undefined));
    await exec.runOnce();
    const rec = reconciledOf(await eventsForIntent(events, intent.executionId, key));
    check("T8 contradictory evidence -> RECOVERY_REQUIRED",
      rec.length >= 1 && rec[0].payload.verdict === "RECOVERY_REQUIRED",
      "verdict=" + (rec[0]?.payload?.verdict ?? "none"));
  }

  /* ---- T9-T14: identity mismatches ---- */
  const mismatches: Array<{ id: string; over: Record<string, unknown> }> = [
    { id: "T9",  over: { intentKey: T("other-t9") } },
    { id: "T10", over: { executionId: T("other-exec") } },
    { id: "T11", over: { releaseId: T("other-rel") } },
    { id: "T12", over: { rollbackTargetReleaseId: T("other-target") } },
    { id: "T13", over: { expectedArtifactDigest: "TAMPERED" } },
    { id: "T14", over: { observedImageId: "sha256:WRONG" } },
  ];
  for (const m of mismatches) {
    const { store, events, audit } = await newEnv();
    const key = T("k-" + m.id.toLowerCase());
    seedIntent(store, {
      intentKey: key, releaseId: T("rel-" + m.id), executionId: T("exec-" + m.id),
      artifactId: T("art-" + m.id), artifactDigest: "d", environment: "staging",
      projectId: "p-" + m.id, containerName: T("c-" + m.id), containerPort: 4173,
      imageId: "sha256:img-" + m.id, imageDigest: "dg", status: "FAILED",
    });
    const intent = store.getReleaseIntent(key)!;
    await emitStarted(events, intent, m.over);
    await emitDecision(events, intent, "passed", "VERIFIED");
    const exec = buildExecutor(store, events, audit, mockDocker(() => undefined));
    await exec.runOnce();
    const rec = reconciledOf(await eventsForIntent(events, intent.executionId, key));
    check(m.id + " identity mismatch -> RECOVERY_REQUIRED",
      rec.length >= 1 && rec[0].payload.verdict === "RECOVERY_REQUIRED",
      "reason=" + (rec[0]?.payload?.reason ?? "none"));
  }

  /* ---- T15 + T16: survives reload, durable event ---- */
  {
    const { engine, store, events, audit } = await newEnv();
    const key = T("k-t15");
    seedIntent(store, {
      intentKey: key, releaseId: T("rel-t15"), executionId: T("exec-t15"),
      artifactId: T("art-t15"), artifactDigest: "d15", environment: "staging",
      projectId: "p-t15", containerName: T("c-t15"), containerPort: 4173,
      imageId: "sha256:img-t15", imageDigest: "dg15", status: "FAILED",
    });
    const intent = store.getReleaseIntent(key)!;
    await emitStarted(events, intent);
    await emitDecision(events, intent, "passed", "VERIFIED");
    await emitVerified(events, intent);

    const exec1 = buildExecutor(store, events, audit, mockDocker(() => undefined));
    await exec1.runOnce();

    // Fresh services on the same engine — durable reload.
    const events2 = new EventService(engine); await events2.init();
    const audit2 = new AuditService(engine);
    const store2 = new ExecutionStore(engine);
    const rec2 = await buildReconciler(store2, events2, audit2, "w-reload").reconcile(key);
    check("T15 reload reconciliation returns CONSISTENT", rec2.verdict === "CONSISTENT",
      "verdict=" + rec2.verdict + " reason=" + rec2.reason);

    const after = reconciledOf(await eventsForIntent(events2, intent.executionId, key));
    check("T16 reconciled event durable after reload", after.length >= 1, "count=" + after.length);
  }

  /* ---- T17: audit durable ---- */
  {
    const { store, events, audit } = await newEnv();
    const key = T("k-t17");
    seedIntent(store, {
      intentKey: key, releaseId: T("rel-t17"), executionId: T("exec-t17"),
      artifactId: T("art-t17"), artifactDigest: "d17", environment: "staging",
      projectId: "p-t17", containerName: T("c-t17"), containerPort: 4173,
      imageId: "sha256:img-t17", imageDigest: "dg17", status: "FAILED",
    });
    const intent = store.getReleaseIntent(key)!;
    await emitStarted(events, intent);
    await emitDecision(events, intent, "passed", "VERIFIED");
    await emitVerified(events, intent);
    await buildExecutor(store, events, audit, mockDocker(() => undefined)).runOnce();

    const records = await audit.byResource(key);
    const ours = records.filter((r: any) => r.action === "release.recovery.rollback.evidence.reconcile");
    check("T17 reconciliation audit record durable", ours.length >= 1, "count=" + ours.length);
  }

  /* ---- T18 + T19 + T20: replay safety ---- */
  {
    const { store, events, audit } = await newEnv();
    const key = T("k-t18"); const cname = T("c-t18");
    seedIntent(store, {
      intentKey: key, releaseId: T("rel-t18"), executionId: T("exec-t18"),
      artifactId: T("art-t18"), artifactDigest: "d18", environment: "staging",
      projectId: "p-t18", containerName: cname, containerPort: 4173,
      imageId: "sha256:img-t18", imageDigest: "dg18", status: "ROLLING_BACK",
    });
    let rollbackCalls = 0, verifyCalls = 0;
    const opts = {
      verify: async () => { verifyCalls++; return { status: "VERIFIED" as const, message: "PASS" }; },
      rollback: async () => { rollbackCalls++; return { status: "COMPLETED" as const, deploymentId: null, message: "no" }; },
    };
    const exec = buildExecutor(store, events, audit, dockerMatches(cname, "sha256:img-t18", 4173), opts);
    await exec.runOnce();
    await exec.runOnce();
    await exec.runOnce();

    const intent = store.getReleaseIntent(key)!;
    const rec = reconciledOf(await eventsForIntent(events, intent.executionId, key));
    check("T18 repeated recovery: exactly one reconciled event", rec.length === 1, "reconciled=" + rec.length);
    check("T19 repeated recovery: rollback never re-invoked", rollbackCalls === 0, "rollbackCalls=" + rollbackCalls);
    check("T20 repeated recovery: verify invoked exactly once", verifyCalls === 1, "verifyCalls=" + verifyCalls);
  }

  /* ---- T21: concurrent recovery workers ---- */
  {
    const { store, events, audit } = await newEnv();
    const key = T("k-t21"); const cname = T("c-t21");
    seedIntent(store, {
      intentKey: key, releaseId: T("rel-t21"), executionId: T("exec-t21"),
      artifactId: T("art-t21"), artifactDigest: "d21", environment: "staging",
      projectId: "p-t21", containerName: cname, containerPort: 4173,
      imageId: "sha256:img-t21", imageDigest: "dg21", status: "ROLLING_BACK",
    });
    let rollbackCalls = 0, verifyCalls = 0;
    const opts = {
      verify: async () => { verifyCalls++; await new Promise((r) => setTimeout(r, 20)); return { status: "VERIFIED" as const, message: "PASS" }; },
      rollback: async () => { rollbackCalls++; return { status: "COMPLETED" as const, deploymentId: null, message: "no" }; },
    };
    const execA = buildExecutor(store, events, audit, dockerMatches(cname, "sha256:img-t21", 4173), { ...opts, workerId: "w-A" });
    const execB = buildExecutor(store, events, audit, dockerMatches(cname, "sha256:img-t21", 4173), { ...opts, workerId: "w-B" });
    await Promise.all([execA.runOnce(), execB.runOnce()]);

    const intent = store.getReleaseIntent(key)!;
    const rec = reconciledOf(await eventsForIntent(events, intent.executionId, key));
    check("T21 concurrent workers: at most one reconciled event", rec.length <= 1, "reconciled=" + rec.length);
    if (rec.length === 1) {
      check("T21 single reconciled event has consistent verdict",
        rec[0].payload.verdict === "CONSISTENT" && rec[0].payload.decision === "VERIFIED",
        "verdict=" + rec[0].payload.verdict + " decision=" + rec[0].payload.decision);
    }
    check("T21 rollback not re-invoked under concurrency", rollbackCalls === 0, "rollbackCalls=" + rollbackCalls);
  }

  /* ---- T22: fail-closed on persistence failure ---- */
  {
    const { store, events, audit } = await newEnv();
    const key = T("k-t22");
    seedIntent(store, {
      intentKey: key, releaseId: T("rel-t22"), executionId: T("exec-t22"),
      artifactId: T("art-t22"), artifactDigest: "d22", environment: "staging",
      projectId: "p-t22", containerName: T("c-t22"), containerPort: 4173,
      imageId: "sha256:img-t22", imageDigest: "dg22", status: "FAILED",
    });
    const intent = store.getReleaseIntent(key)!;
    await emitStarted(events, intent);
    await emitDecision(events, intent, "passed", "VERIFIED");
    await emitVerified(events, intent);

    const failingEvents = {
      emit: events.emit.bind(events),
      byExecution: async () => { throw new Error("simulated persistence failure"); },
    };
    const failingReconciler = buildReconciler(store, failingEvents as any, audit, "w-fail");
    const exec = buildExecutor(store, events, audit, mockDocker(() => undefined), { reconciler: failingReconciler });
    const report = await exec.runOnce();

    const rec = reconciledOf(await eventsForIntent(events, intent.executionId, key));
    check("T22 persistence failure: no reconciled event written", rec.length === 0, "reconciled=" + rec.length);
    check("T22 persistence failure: report.blocked >= 1", report.blocked >= 1, "blocked=" + report.blocked);
    const errEvs = (await events.byExecution(intent.executionId)).filter(
      (e: any) => e.type === "release.recovery.error" && /reconciliation failed/.test(String(e?.payload?.error ?? "")),
    );
    check("T22 persistence failure: release.recovery.error emitted", errEvs.length >= 1, "errors=" + errEvs.length);
  }

  /* ---- T23: no secrets in reconciliation evidence ---- */
  {
    const { store, events, audit } = await newEnv();
    const key = T("k-t23");
    seedIntent(store, {
      intentKey: key, releaseId: T("rel-t23"), executionId: T("exec-t23"),
      artifactId: T("art-t23"), artifactDigest: "d23", environment: "staging",
      projectId: "p-t23", containerName: T("c-t23"), containerPort: 4173,
      imageId: "sha256:img-t23", imageDigest: "dg23", status: "FAILED",
    });
    const intent = store.getReleaseIntent(key)!;
    await emitStarted(events, intent);
    await emitDecision(events, intent, "passed", "VERIFIED");
    await emitVerified(events, intent);
    await buildExecutor(store, events, audit, mockDocker(() => undefined)).runOnce();

    const rec = reconciledOf(await eventsForIntent(events, intent.executionId, key));
    const json = JSON.stringify(rec[0]?.payload ?? {});
    const forbidden = /password|token|secret|cookie|authorization|api[_-]?key|credential/i;
    check("T23 reconciled payload contains no forbidden keys", !forbidden.test(json), "payload=" + json.slice(0, 160));
  }

  /* ---- T24: lease respected ---- */
  {
    const { store, events, audit } = await newEnv();
    const key = T("k-t24"); const cname = T("c-t24");
    seedIntent(store, {
      intentKey: key, releaseId: T("rel-t24"), executionId: T("exec-t24"),
      artifactId: T("art-t24"), artifactDigest: "d24", environment: "staging",
      projectId: "p-t24", containerName: cname, containerPort: 4173,
      imageId: "sha256:img-t24", imageDigest: "dg24", status: "ROLLING_BACK",
    });
    // Non-owner worker pre-acquires lease with a long TTL.
    const intentsSvc = new ReleaseDeploymentIntentService(store);
    const lease = intentsSvc.acquireLease(key, "other-worker", 600_000);
    check("T24 pre-lease acquired", lease.acquired === true, "holder=" + (lease as any).holder);

    let rollbackCalls = 0, verifyCalls = 0;
    const exec = buildExecutor(store, events, audit, dockerMatches(cname, "sha256:img-t24", 4173), {
      workerId: "w-t24",
      verify: async () => { verifyCalls++; return { status: "VERIFIED", message: "PASS" }; },
      rollback: async () => { rollbackCalls++; return { status: "COMPLETED", deploymentId: null, message: "no" }; },
    });
    const report = await exec.runOnce();

    check("T24 lease contention reported", report.leaseHeld >= 1, "leaseHeld=" + report.leaseHeld);
    check("T24 verify not invoked under lease", verifyCalls === 0, "verifyCalls=" + verifyCalls);
    check("T24 rollback not invoked under lease", rollbackCalls === 0, "rollbackCalls=" + rollbackCalls);
    check("T24 intent still ROLLING_BACK", store.getReleaseIntent(key)!.status === "ROLLING_BACK",
      "status=" + store.getReleaseIntent(key)!.status);
  }

  console.log("\nRESULT: " + pass + " passed, " + fail + " failed");
  if (fail > 0) process.exit(1);
  process.exit(0);
}

main().catch((e) => { console.error("[FATAL]", e); process.exit(2); });