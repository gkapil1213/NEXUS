// scripts/test-phase120-production-rollback-verification.ts
import { openEngine } from "../src/core/db";
import { ExecutionStore } from "../src/core/execution-store";
import { ReleaseDeploymentIntentService } from "../src/core/release-deployment-intent";
import { ReleaseRecoveryService } from "../src/core/release-recovery";
import { ReleaseRecoveryExecutor } from "../src/core/release-recovery-executor";
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
  return {
    async run(op: DockerOp): Promise<DockerResult> {
      const over = script(op) ?? {};
      return { status: "SUCCEEDED", command: "docker " + op.kind, exit_code: 0, stdout: "", stderr: "", duration_ms: 1, blocked_reason: null, ...over } as DockerResult;
    },
  } as any;
}
function dockerMatches(name: string, imageId: string, port: number): DockerAdapter {
  return mockDocker((op) => {
    if (op.kind === "inspect" && (op as any).image === name) {
      return { stdout: JSON.stringify([{ Id: "cid", Image: imageId,
        NetworkSettings: { Ports: { [port + "/tcp"]: [{ HostPort: String(port) }] } } }]) };
    }
    return undefined;
  });
}
function dockerMatchesNoPort(name: string, imageId: string): DockerAdapter {
  return mockDocker((op) => {
    if (op.kind === "inspect" && (op as any).image === name) {
      return { stdout: JSON.stringify([{ Id: "cid", Image: imageId, NetworkSettings: { Ports: {} } }]) };
    }
    return undefined;
  });
}
function dockerIdentityMismatch(name: string): DockerAdapter {
  return mockDocker((op) => {
    if (op.kind === "inspect" && (op as any).image === name) {
      return { stdout: JSON.stringify([{ Id: "cid", Image: "sha256:WRONG", NetworkSettings: { Ports: {} } }]) };
    }
    return undefined;
  });
}

const fakeSvc: any = { events: { emit: async () => {} }, audit: { record: async () => {} } };

async function newStore() {
  const engine = await openEngine();
  return new ExecutionStore(engine);
}

interface Seed { intentKey: string; releaseId: string; executionId: string; artifactId: string;
  artifactDigest: string; environment: string; projectId: string; containerName: string;
  containerPort: number; imageId: string; imageDigest: string; kind: "DEPLOY" | "ROLLBACK"; }
function seedIntent(store: ExecutionStore, o: Seed) {
  store.createReleaseIntentIdempotent({
    intentKey: o.intentKey, releaseId: o.releaseId, executionId: o.executionId,
    artifactId: o.artifactId, artifactDigest: o.artifactDigest, commitSha: "c",
    environment: o.environment, projectId: o.projectId,
    imageRepository: "nexus/img", imageTag: "v1", imageId: o.imageId, imageDigest: o.imageDigest,
    containerName: o.containerName, containerPort: o.containerPort,
    intentKind: o.kind, rollbackTargetReleaseId: o.releaseId, rollbackJobId: T("job"),
  });
  store.updateReleaseIntentStatus(o.intentKey, "ROLLING_BACK", {});
}

async function main() {
  console.log("NEXUS PHASE 120 PRODUCTION ROLLBACK VERIFICATION TESTS");
  console.log("=====================================================\n");

  /* ---------- T1: verifier receives inspected URL, rollback not called ---------- */
  {
    const store = await newStore();
    const key = T("rollback:rel-t1:staging"); const cname = T("c-t1");
    seedIntent(store, { intentKey: key, releaseId: T("rel-t1"), executionId: T("exec-t1"),
      artifactId: T("art-t1"), artifactDigest: "d1", environment: "staging",
      projectId: "proj-t1", containerName: cname, containerPort: 4173,
      imageId: "sha256:img-t1", imageDigest: "d1", kind: "ROLLBACK" });

    let capturedUrl: string | undefined = undefined;
    let capturedPort: number | undefined = undefined;
    let rollbackCalls = 0;
    const executor = new ReleaseRecoveryExecutor({
      intents: new ReleaseDeploymentIntentService(store), recovery: new ReleaseRecoveryService(),
      orchestrator: {} as any, history: {} as any,
      docker: dockerMatches(cname, "sha256:img-t1", 4173),
      smoke: {} as SmokeTestService, svc: fakeSvc, workerId: "w-t1",
      rollback: { async rollback() { rollbackCalls++; return { status: "COMPLETED", deploymentId: null, message: "no" }; } },
      verifyRecoveredRollback: { async verify(_i: any, ctx: any) {
        capturedUrl = ctx?.stagingUrl; capturedPort = ctx?.hostPort;
        return { status: "VERIFIED", message: "ok" };
      } },
    });
    await executor.runOnce();
    check("T1 verifier received stagingUrl http://127.0.0.1:4173", capturedUrl === "http://127.0.0.1:4173", "url=" + capturedUrl);
    check("T1 verifier received hostPort=4173", capturedPort === 4173, "port=" + capturedPort);
    check("T1 rollback delegate NOT called", rollbackCalls === 0, "rollbackCalls=" + rollbackCalls);
  }

  /* ---------- T2: canonical smoke PASS → terminal FAILED, event emitted ---------- */
  {
    const store = await newStore();
    const key = T("rollback:rel-t2:staging"); const cname = T("c-t2");
    seedIntent(store, { intentKey: key, releaseId: T("rel-t2"), executionId: T("exec-t2"),
      artifactId: T("art-t2"), artifactDigest: "d2", environment: "staging",
      projectId: "proj-t2", containerName: cname, containerPort: 8080,
      imageId: "sha256:img-t2", imageDigest: "d2", kind: "ROLLBACK" });

    let events: string[] = [];
    const svc = { events: { emit: async (e: any) => { events.push(e.type); } }, audit: { record: async () => {} } };
    let rollbackCalls = 0;
    const executor = new ReleaseRecoveryExecutor({
      intents: new ReleaseDeploymentIntentService(store), recovery: new ReleaseRecoveryService(),
      orchestrator: {} as any, history: {} as any,
      docker: dockerMatches(cname, "sha256:img-t2", 8080),
      smoke: {} as SmokeTestService, svc: svc as any, workerId: "w-t2",
      rollback: { async rollback() { rollbackCalls++; return { status: "COMPLETED", deploymentId: null, message: "no" }; } },
      verifyRecoveredRollback: { async verify() { return { status: "VERIFIED", message: "smoke PASS" }; } },
    });
    await executor.runOnce();
    const fresh = store.getReleaseIntent(key);
    check("T2 intent terminal FAILED", fresh?.status === "FAILED", "status=" + fresh?.status);
    check("T2 recovery reason recorded", (fresh?.recoveryReason ?? "").includes("verified"), "reason=" + fresh?.recoveryReason);
    check("T2 rollback delegate NOT called", rollbackCalls === 0, "rollbackCalls=" + rollbackCalls);
    check("T2 verified event emitted", events.includes("release.recovery.rollback.verified"), "events=" + JSON.stringify(events));
  }

  /* ---------- T3: smoke FAIL → VERIFICATION_FAILED ---------- */
  {
    const store = await newStore();
    const key = T("rollback:rel-t3:staging"); const cname = T("c-t3");
    seedIntent(store, { intentKey: key, releaseId: T("rel-t3"), executionId: T("exec-t3"),
      artifactId: T("art-t3"), artifactDigest: "d3", environment: "staging",
      projectId: "proj-t3", containerName: cname, containerPort: 8080,
      imageId: "sha256:img-t3", imageDigest: "d3", kind: "ROLLBACK" });

    let rollbackCalls = 0;
    const executor = new ReleaseRecoveryExecutor({
      intents: new ReleaseDeploymentIntentService(store), recovery: new ReleaseRecoveryService(),
      orchestrator: {} as any, history: {} as any,
      docker: dockerMatches(cname, "sha256:img-t3", 8080),
      smoke: {} as SmokeTestService, svc: fakeSvc, workerId: "w-t3",
      rollback: { async rollback() { rollbackCalls++; return { status: "COMPLETED", deploymentId: null, message: "no" }; } },
      verifyRecoveredRollback: { async verify() { return { status: "VERIFICATION_FAILED", message: "smoke reported FAIL" }; } },
    });
    await executor.runOnce();
    const fresh = store.getReleaseIntent(key);
    check("T3 intent VERIFICATION_FAILED", fresh?.status === "VERIFICATION_FAILED", "status=" + fresh?.status);
    check("T3 failure reason persisted", (fresh?.failureReason ?? "").includes("smoke reported FAIL"), "reason=" + fresh?.failureReason);
    check("T3 rollback delegate NOT called", rollbackCalls === 0, "rollbackCalls=" + rollbackCalls);
  }

  /* ---------- T4: smoke BLOCKED → RECOVERY_REQUIRED, blocked count ---------- */
  {
    const store = await newStore();
    const key = T("rollback:rel-t4:staging"); const cname = T("c-t4");
    seedIntent(store, { intentKey: key, releaseId: T("rel-t4"), executionId: T("exec-t4"),
      artifactId: T("art-t4"), artifactDigest: "d4", environment: "staging",
      projectId: "proj-t4", containerName: cname, containerPort: 8080,
      imageId: "sha256:img-t4", imageDigest: "d4", kind: "ROLLBACK" });

    let rollbackCalls = 0;
    const executor = new ReleaseRecoveryExecutor({
      intents: new ReleaseDeploymentIntentService(store), recovery: new ReleaseRecoveryService(),
      orchestrator: {} as any, history: {} as any,
      docker: dockerMatches(cname, "sha256:img-t4", 8080),
      smoke: {} as SmokeTestService, svc: fakeSvc, workerId: "w-t4",
      rollback: { async rollback() { rollbackCalls++; return { status: "COMPLETED", deploymentId: null, message: "no" }; } },
      verifyRecoveredRollback: { async verify() { return { status: "BLOCKED", message: "playwright unavailable" }; } },
    });
    const report = await executor.runOnce();
    const fresh = store.getReleaseIntent(key);
    check("T4 intent RECOVERY_REQUIRED", fresh?.status === "RECOVERY_REQUIRED", "status=" + fresh?.status);
    check("T4 blocked count incremented", report.blocked >= 1, "blocked=" + report.blocked);
    check("T4 rollback delegate NOT called", rollbackCalls === 0, "rollbackCalls=" + rollbackCalls);
    check("T4 blocked reason persisted", (fresh?.recoveryReason ?? "").includes("playwright unavailable"), "reason=" + fresh?.recoveryReason);
  }

  /* ---------- T5: MATCHES_INTENT but no hostPort → RECOVERY_REQUIRED, verifier not called ---------- */
  {
    const store = await newStore();
    const key = T("rollback:rel-t5:staging"); const cname = T("c-t5");
    seedIntent(store, { intentKey: key, releaseId: T("rel-t5"), executionId: T("exec-t5"),
      artifactId: T("art-t5"), artifactDigest: "d5", environment: "staging",
      projectId: "proj-t5", containerName: cname, containerPort: 8080,
      imageId: "sha256:img-t5", imageDigest: "d5", kind: "ROLLBACK" });

    let verifyCalls = 0; let rollbackCalls = 0;
    const executor = new ReleaseRecoveryExecutor({
      intents: new ReleaseDeploymentIntentService(store), recovery: new ReleaseRecoveryService(),
      orchestrator: {} as any, history: {} as any,
      docker: dockerMatchesNoPort(cname, "sha256:img-t5"),
      smoke: {} as SmokeTestService, svc: fakeSvc, workerId: "w-t5",
      rollback: { async rollback() { rollbackCalls++; return { status: "COMPLETED", deploymentId: null, message: "no" }; } },
      verifyRecoveredRollback: { async verify() { verifyCalls++; return { status: "VERIFIED", message: "" }; } },
    });
    await executor.runOnce();
    const fresh = store.getReleaseIntent(key);
    check("T5 no hostPort -> RECOVERY_REQUIRED", fresh?.status === "RECOVERY_REQUIRED", "status=" + fresh?.status);
    check("T5 verifier NOT called", verifyCalls === 0, "verifyCalls=" + verifyCalls);
    check("T5 rollback delegate NOT called", rollbackCalls === 0, "rollbackCalls=" + rollbackCalls);
  }

  /* ---------- T6: identity mismatch — no verify, no rollback ---------- */
  {
    const store = await newStore();
    const key = T("rollback:rel-t6:staging"); const cname = T("c-t6");
    seedIntent(store, { intentKey: key, releaseId: T("rel-t6"), executionId: T("exec-t6"),
      artifactId: T("art-t6"), artifactDigest: "d6", environment: "staging",
      projectId: "proj-t6", containerName: cname, containerPort: 8080,
      imageId: "sha256:img-t6", imageDigest: "d6", kind: "ROLLBACK" });

    let verifyCalls = 0; let rollbackCalls = 0;
    const executor = new ReleaseRecoveryExecutor({
      intents: new ReleaseDeploymentIntentService(store), recovery: new ReleaseRecoveryService(),
      orchestrator: {} as any, history: {} as any,
      docker: dockerIdentityMismatch(cname),
      smoke: {} as SmokeTestService, svc: fakeSvc, workerId: "w-t6",
      rollback: { async rollback() { rollbackCalls++; return { status: "COMPLETED", deploymentId: null, message: "no" }; } },
      verifyRecoveredRollback: { async verify() { verifyCalls++; return { status: "VERIFIED", message: "" }; } },
    });
    await executor.runOnce();
    check("T6 verifier NOT called on identity mismatch", verifyCalls === 0, "verifyCalls=" + verifyCalls);
    check("T6 rollback delegate NOT called on identity mismatch", rollbackCalls === 0, "rollbackCalls=" + rollbackCalls);
  }

  /* ---------- T7: lease contention — non-owner does not verify ---------- */
  {
    const store = await newStore();
    const key = T("rollback:rel-t7:staging"); const cname = T("c-t7");
    seedIntent(store, { intentKey: key, releaseId: T("rel-t7"), executionId: T("exec-t7"),
      artifactId: T("art-t7"), artifactDigest: "d7", environment: "staging",
      projectId: "proj-t7", containerName: cname, containerPort: 8080,
      imageId: "sha256:img-t7", imageDigest: "d7", kind: "ROLLBACK" });

    const intentSvc = new ReleaseDeploymentIntentService(store);
    intentSvc.acquireLease(key, "other-worker", 120_000);

    let verifyCalls = 0; let rollbackCalls = 0;
    const executor = new ReleaseRecoveryExecutor({
      intents: intentSvc, recovery: new ReleaseRecoveryService(),
      orchestrator: {} as any, history: {} as any,
      docker: dockerMatches(cname, "sha256:img-t7", 8080),
      smoke: {} as SmokeTestService, svc: fakeSvc, workerId: "w-t7",
      rollback: { async rollback() { rollbackCalls++; return { status: "COMPLETED", deploymentId: null, message: "no" }; } },
      verifyRecoveredRollback: { async verify() { verifyCalls++; return { status: "VERIFIED", message: "" }; } },
    });
    const report = await executor.runOnce();
    const fresh = store.getReleaseIntent(key);
    check("T7 non-owner: verifier NOT called", verifyCalls === 0, "verifyCalls=" + verifyCalls);
    check("T7 non-owner: rollback NOT called", rollbackCalls === 0, "rollbackCalls=" + rollbackCalls);
    check("T7 non-owner: intent remains ROLLING_BACK", fresh?.status === "ROLLING_BACK", "status=" + fresh?.status);
    check("T7 report records lease contention", report.leaseHeld >= 1, "leaseHeld=" + report.leaseHeld);
  }

  /* ---------- T8: replay is idempotent ---------- */
  {
    const store = await newStore();
    const key = T("rollback:rel-t8:staging"); const cname = T("c-t8");
    seedIntent(store, { intentKey: key, releaseId: T("rel-t8"), executionId: T("exec-t8"),
      artifactId: T("art-t8"), artifactDigest: "d8", environment: "staging",
      projectId: "proj-t8", containerName: cname, containerPort: 8080,
      imageId: "sha256:img-t8", imageDigest: "d8", kind: "ROLLBACK" });

    let verifyCalls = 0; let rollbackCalls = 0;
    const executor = new ReleaseRecoveryExecutor({
      intents: new ReleaseDeploymentIntentService(store), recovery: new ReleaseRecoveryService(),
      orchestrator: {} as any, history: {} as any,
      docker: dockerMatches(cname, "sha256:img-t8", 8080),
      smoke: {} as SmokeTestService, svc: fakeSvc, workerId: "w-t8",
      rollback: { async rollback() { rollbackCalls++; return { status: "COMPLETED", deploymentId: null, message: "no" }; } },
      verifyRecoveredRollback: { async verify() { verifyCalls++; return { status: "VERIFIED", message: "" }; } },
    });
    await executor.runOnce();
    await executor.runOnce();
    const fresh = store.getReleaseIntent(key);
    check("T8 rollback delegate never called", rollbackCalls === 0, "rollbackCalls=" + rollbackCalls);
    check("T8 verifier called once across two runs", verifyCalls === 1, "verifyCalls=" + verifyCalls);
    check("T8 intent stable terminal FAILED", fresh?.status === "FAILED", "status=" + fresh?.status);
  }

  /* ---------- T9: legacy DEPLOY intent preserves rollback delegate path ---------- */
  {
    const store = await newStore();
    const key = T("intent:legacy-t9:staging"); const cname = T("c-t9");
    seedIntent(store, { intentKey: key, releaseId: T("rel-t9"), executionId: T("exec-t9"),
      artifactId: T("art-t9"), artifactDigest: "d9", environment: "staging",
      projectId: "proj-t9", containerName: cname, containerPort: 8080,
      imageId: "sha256:img-t9", imageDigest: "d9", kind: "DEPLOY" });

    let rollbackCalls = 0; let verifyCalls = 0;
    const executor = new ReleaseRecoveryExecutor({
      intents: new ReleaseDeploymentIntentService(store), recovery: new ReleaseRecoveryService(),
      orchestrator: {} as any, history: {} as any,
      docker: dockerMatches(cname, "sha256:img-t9", 8080),
      smoke: {} as SmokeTestService, svc: fakeSvc, workerId: "w-t9",
      rollback: { async rollback() { rollbackCalls++; return { status: "COMPLETED", deploymentId: null, message: "legacy" }; } },
      verifyRecoveredRollback: { async verify() { verifyCalls++; return { status: "VERIFIED", message: "" }; } },
    });
    await executor.runOnce();
    check("T9 legacy DEPLOY uses rollback delegate", rollbackCalls === 1, "rollbackCalls=" + rollbackCalls);
    check("T9 legacy DEPLOY does not use verifyRecoveredRollback", verifyCalls === 0, "verifyCalls=" + verifyCalls);
  }

  console.log("");
  console.log("RESULT: " + pass + " passed, " + fail + " failed");
  if (fail > 0) process.exit(1);
  process.exit(0);
}

main().catch((e) => { console.error("[FATAL]", e); process.exit(2); });