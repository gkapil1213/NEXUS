// scripts/test-phase119-rollback-recovery.ts
//
// Phase 119 - crash-recovery bridge between Phase 118 durable rollback jobs
// and canonical ReleaseDeploymentIntent recovery.

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
      return {
        status: "SUCCEEDED", command: "docker " + op.kind,
        exit_code: 0, stdout: "", stderr: "",
        duration_ms: 1, blocked_reason: null,
        ...over,
      } as DockerResult;
    },
  } as any;
}
function dockerMatchesIntent(name: string, imageId: string, port: number): DockerAdapter {
  return mockDocker((op) => {
    if (op.kind === "inspect" && (op as any).image === name) {
      return { stdout: JSON.stringify([{ Id: "cid", Image: imageId,
        NetworkSettings: { Ports: { [port + "/tcp"]: [{ HostPort: "18080" }] } } }]) };
    }
    return undefined;
  });
}
function dockerMissing(name: string): DockerAdapter {
  return mockDocker((op) => {
    if (op.kind === "inspect" && (op as any).image === name)
      return { status: "FAILED", exit_code: 1, stderr: "Error: No such container: " + name };
    return undefined;
  });
}
function dockerBlocked(): DockerAdapter {
  return mockDocker((op) => (op.kind === "inspect" ? { status: "BLOCKED", blocked_reason: "host executor unavailable" } : undefined));
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
const stubOrchestrator: any = {};
const stubHistory: any = {};
const stubSmoke: SmokeTestService = { async run() { return { verdict: "PASS", health: {}, smoke: {} }; } } as any;

async function newStore() {
  const engine = await openEngine();
  return { engine, store: new ExecutionStore(engine) };
}

interface SeedOpts {
  intentKey: string; releaseId: string; executionId: string; artifactId: string;
  artifactDigest: string; environment: string; projectId?: string;
  containerName: string; containerPort: number; imageId: string | null;
  imageDigest: string; imageRepository?: string; imageTag?: string;
  rollbackTargetReleaseId: string; rollbackJobId: string; kind?: "DEPLOY" | "ROLLBACK";
}
function seedIntent(store: ExecutionStore, o: SeedOpts) {
  store.createReleaseIntentIdempotent({
    intentKey: o.intentKey,
    releaseId: o.releaseId,
    executionId: o.executionId,
    artifactId: o.artifactId,
    artifactDigest: o.artifactDigest,
    commitSha: "abc",
    environment: o.environment,
    projectId: o.projectId ?? "proj-119",
    imageRepository: o.imageRepository ?? "nexus/img",
    imageTag: o.imageTag ?? "v1",
    imageId: o.imageId,
    imageDigest: o.imageDigest,
    containerName: o.containerName,
    containerPort: o.containerPort,
    intentKind: o.kind ?? "ROLLBACK",
    rollbackTargetReleaseId: o.rollbackTargetReleaseId,
    rollbackJobId: o.rollbackJobId,
  });
  store.updateReleaseIntentStatus(o.intentKey, "ROLLING_BACK", {});
}

async function main() {
  console.log("NEXUS PHASE 119 ROLLBACK RECOVERY TESTS");
  console.log("=======================================\n");

  /* ---------- T1-T4: crash after provider success, before verification ---------- */
  {
    const { store } = await newStore();
    const intentKey = T("rollback:rel-1:staging");
    const cname = T("container-1");
    seedIntent(store, {
      intentKey, releaseId: T("rel-1"), executionId: T("exec-1"),
      artifactId: T("art-1"), artifactDigest: "sha256:digest-1", environment: "staging",
      containerName: cname, containerPort: 8080,
      imageId: "sha256:expected-1", imageDigest: "sha256:digest-1",
      rollbackTargetReleaseId: T("rel-1"), rollbackJobId: T("job-1"),
    });

    let rollbackCalls = 0;
    let verifyCalls = 0;
    const executor = new ReleaseRecoveryExecutor({
      intents: new ReleaseDeploymentIntentService(store),
      recovery: new ReleaseRecoveryService(),
      orchestrator: stubOrchestrator, history: stubHistory,
      docker: dockerMatchesIntent(cname, "sha256:expected-1", 8080),
      smoke: stubSmoke, svc: fakeSvc, workerId: "worker-A",
      rollback: { async rollback() { rollbackCalls++; return { status: "COMPLETED", deploymentId: null, message: "would rollback" }; } },
      verifyRecoveredRollback: { async verify() { verifyCalls++; return { status: "VERIFIED", message: "target running" }; } },
    });

    await executor.runOnce();
    const fresh = store.getReleaseIntent(intentKey);

    check("T1 crash-after-provider: rollback delegate NOT called again", rollbackCalls === 0, "rollbackCalls=" + rollbackCalls);
    check("T2 crash-after-provider: verify delegate IS called exactly once", verifyCalls === 1, "verifyCalls=" + verifyCalls);
    check("T3 crash-after-provider: intent reaches terminal FAILED (rollback success convention)", fresh?.status === "FAILED", "status=" + fresh?.status);
    check("T4 crash-after-provider: recoveryReason records verified", (fresh?.recoveryReason ?? "").includes("verified"), "reason=" + fresh?.recoveryReason);
  }

  /* ---------- T5: verification BLOCKED -> RECOVERY_REQUIRED, no rollback retry ---------- */
  {
    const { store } = await newStore();
    const intentKey = T("rollback:rel-2:staging");
    const cname = T("container-2");
    seedIntent(store, {
      intentKey, releaseId: T("rel-2"), executionId: T("exec-2"),
      artifactId: T("art-2"), artifactDigest: "sha256:d2", environment: "staging",
      containerName: cname, containerPort: 8080,
      imageId: "sha256:expected-2", imageDigest: "sha256:d2",
      rollbackTargetReleaseId: T("rel-2"), rollbackJobId: T("job-2"),
    });

    let rollbackCalls = 0;
    const executor = new ReleaseRecoveryExecutor({
      intents: new ReleaseDeploymentIntentService(store),
      recovery: new ReleaseRecoveryService(),
      orchestrator: stubOrchestrator, history: stubHistory,
      docker: dockerMatchesIntent(cname, "sha256:expected-2", 8080),
      smoke: stubSmoke, svc: fakeSvc, workerId: "worker-A",
      rollback: { async rollback() { rollbackCalls++; return { status: "COMPLETED", deploymentId: null, message: "should not run" }; } },
      verifyRecoveredRollback: { async verify() { return { status: "BLOCKED", message: "runtime health unavailable" }; } },
    });

    await executor.runOnce();
    const fresh = store.getReleaseIntent(intentKey);
    check("T5 verification BLOCKED -> RECOVERY_REQUIRED", fresh?.status === "RECOVERY_REQUIRED", "status=" + fresh?.status);
    check("T5 rollback delegate not retried", rollbackCalls === 0, "rollbackCalls=" + rollbackCalls);
  }

  /* ---------- T6: verification FAILS -> VERIFICATION_FAILED ---------- */
  {
    const { store } = await newStore();
    const intentKey = T("rollback:rel-3:staging");
    const cname = T("container-3");
    seedIntent(store, {
      intentKey, releaseId: T("rel-3"), executionId: T("exec-3"),
      artifactId: T("art-3"), artifactDigest: "sha256:d3", environment: "staging",
      containerName: cname, containerPort: 8080,
      imageId: "sha256:expected-3", imageDigest: "sha256:d3",
      rollbackTargetReleaseId: T("rel-3"), rollbackJobId: T("job-3"),
    });

    const executor = new ReleaseRecoveryExecutor({
      intents: new ReleaseDeploymentIntentService(store),
      recovery: new ReleaseRecoveryService(),
      orchestrator: stubOrchestrator, history: stubHistory,
      docker: dockerMatchesIntent(cname, "sha256:expected-3", 8080),
      smoke: stubSmoke, svc: fakeSvc, workerId: "worker-A",
      rollback: { async rollback() { return { status: "COMPLETED", deploymentId: null, message: "" }; } },
      verifyRecoveredRollback: { async verify() { return { status: "VERIFICATION_FAILED", message: "smoke failed" }; } },
    });

    await executor.runOnce();
    const fresh = store.getReleaseIntent(intentKey);
    check("T6 verification FAILED -> VERIFICATION_FAILED", fresh?.status === "VERIFICATION_FAILED", "status=" + fresh?.status);
  }

  /* ---------- T7: MISSING -> RECOVERY_REQUIRED, no rollback retry ---------- */
  {
    const { store } = await newStore();
    const intentKey = T("rollback:rel-4:staging");
    const cname = T("container-4");
    seedIntent(store, {
      intentKey, releaseId: T("rel-4"), executionId: T("exec-4"),
      artifactId: T("art-4"), artifactDigest: "sha256:d4", environment: "staging",
      containerName: cname, containerPort: 8080,
      imageId: "sha256:expected-4", imageDigest: "sha256:d4",
      rollbackTargetReleaseId: T("rel-4"), rollbackJobId: T("job-4"),
    });

    let rollbackCalls = 0;
    const executor = new ReleaseRecoveryExecutor({
      intents: new ReleaseDeploymentIntentService(store),
      recovery: new ReleaseRecoveryService(),
      orchestrator: stubOrchestrator, history: stubHistory,
      docker: dockerMissing(cname),
      smoke: stubSmoke, svc: fakeSvc, workerId: "worker-A",
      rollback: { async rollback() { rollbackCalls++; return { status: "COMPLETED", deploymentId: null, message: "" }; } },
      verifyRecoveredRollback: { async verify() { return { status: "VERIFIED", message: "" }; } },
    });

    await executor.runOnce();
    const fresh = store.getReleaseIntent(intentKey);
    check("T7 container MISSING -> RECOVERY_REQUIRED", fresh?.status === "RECOVERY_REQUIRED", "status=" + fresh?.status);
    check("T7 rollback delegate not retried", rollbackCalls === 0, "rollbackCalls=" + rollbackCalls);
  }

  /* ---------- T8: Docker BLOCKED -> RECOVERY_REQUIRED, no rollback retry ---------- */
  {
    const { store } = await newStore();
    const intentKey = T("rollback:rel-5:staging");
    seedIntent(store, {
      intentKey, releaseId: T("rel-5"), executionId: T("exec-5"),
      artifactId: T("art-5"), artifactDigest: "sha256:d5", environment: "staging",
      containerName: T("container-5"), containerPort: 8080,
      imageId: "sha256:expected-5", imageDigest: "sha256:d5",
      rollbackTargetReleaseId: T("rel-5"), rollbackJobId: T("job-5"),
    });

    let rollbackCalls = 0;
    const executor = new ReleaseRecoveryExecutor({
      intents: new ReleaseDeploymentIntentService(store),
      recovery: new ReleaseRecoveryService(),
      orchestrator: stubOrchestrator, history: stubHistory,
      docker: dockerBlocked(),
      smoke: stubSmoke, svc: fakeSvc, workerId: "worker-A",
      rollback: { async rollback() { rollbackCalls++; return { status: "COMPLETED", deploymentId: null, message: "" }; } },
      verifyRecoveredRollback: { async verify() { return { status: "VERIFIED", message: "" }; } },
    });

    await executor.runOnce();
    const fresh = store.getReleaseIntent(intentKey);
    check("T8 Docker inspect BLOCKED -> intent not terminal success", fresh?.status !== "FAILED" || (fresh?.failureReason ?? "").includes("blocked"), "status=" + fresh?.status);
    check("T8 rollback delegate not retried", rollbackCalls === 0, "rollbackCalls=" + rollbackCalls);
  }

  /* ---------- T9: identity mismatch -> no false success ---------- */
  {
    const { store } = await newStore();
    const intentKey = T("rollback:rel-6:staging");
    const cname = T("container-6");
    seedIntent(store, {
      intentKey, releaseId: T("rel-6"), executionId: T("exec-6"),
      artifactId: T("art-6"), artifactDigest: "sha256:d6", environment: "staging",
      containerName: cname, containerPort: 8080,
      imageId: "sha256:expected-6", imageDigest: "sha256:d6",
      rollbackTargetReleaseId: T("rel-6"), rollbackJobId: T("job-6"),
    });

    let rollbackCalls = 0;
    let verifyCalls = 0;
    const executor = new ReleaseRecoveryExecutor({
      intents: new ReleaseDeploymentIntentService(store),
      recovery: new ReleaseRecoveryService(),
      orchestrator: stubOrchestrator, history: stubHistory,
      docker: dockerIdentityMismatch(cname),
      smoke: stubSmoke, svc: fakeSvc, workerId: "worker-A",
      rollback: { async rollback() { rollbackCalls++; return { status: "COMPLETED", deploymentId: null, message: "" }; } },
      verifyRecoveredRollback: { async verify() { verifyCalls++; return { status: "VERIFIED", message: "" }; } },
    });

    await executor.runOnce();
    const fresh = store.getReleaseIntent(intentKey);
    check("T9 identity mismatch -> NOT treated as verified rollback", fresh?.status !== "FAILED" || !(fresh?.recoveryReason ?? "").includes("verified"), "status=" + fresh?.status + " reason=" + fresh?.recoveryReason);
    check("T9 verify delegate not called on identity mismatch", verifyCalls === 0, "verifyCalls=" + verifyCalls);
    check("T9 rollback delegate not called on identity mismatch", rollbackCalls === 0, "rollbackCalls=" + rollbackCalls);
  }

  /* ---------- T10: lease prevents duplicate recovery by a second worker ---------- */
  {
    const { store } = await newStore();
    const intentKey = T("rollback:rel-7:staging");
    const cname = T("container-7");
    seedIntent(store, {
      intentKey, releaseId: T("rel-7"), executionId: T("exec-7"),
      artifactId: T("art-7"), artifactDigest: "sha256:d7", environment: "staging",
      containerName: cname, containerPort: 8080,
      imageId: "sha256:expected-7", imageDigest: "sha256:d7",
      rollbackTargetReleaseId: T("rel-7"), rollbackJobId: T("job-7"),
    });

    // Simulate another worker already holding the lease
    const intentSvc = new ReleaseDeploymentIntentService(store);
    intentSvc.acquireLease(intentKey, "worker-OTHER", 120_000);

    let verifyCalls = 0;
    const executor = new ReleaseRecoveryExecutor({
      intents: intentSvc,
      recovery: new ReleaseRecoveryService(),
      orchestrator: stubOrchestrator, history: stubHistory,
      docker: dockerMatchesIntent(cname, "sha256:expected-7", 8080),
      smoke: stubSmoke, svc: fakeSvc, workerId: "worker-A",
      rollback: { async rollback() { return { status: "COMPLETED", deploymentId: null, message: "" }; } },
      verifyRecoveredRollback: { async verify() { verifyCalls++; return { status: "VERIFIED", message: "" }; } },
    });

    const report = await executor.runOnce();
    const fresh = store.getReleaseIntent(intentKey);
    check("T10 non-owner blocked by lease (no verify call)", verifyCalls === 0, "verifyCalls=" + verifyCalls);
    check("T10 non-owner did not transition state", fresh?.status === "ROLLING_BACK", "status=" + fresh?.status);
    check("T10 report counts lease contention", report.leaseHeld >= 1, "leaseHeld=" + report.leaseHeld);
  }

  /* ---------- T11: replay after successful recovery is idempotent ---------- */
  {
    const { store } = await newStore();
    const intentKey = T("rollback:rel-8:staging");
    const cname = T("container-8");
    seedIntent(store, {
      intentKey, releaseId: T("rel-8"), executionId: T("exec-8"),
      artifactId: T("art-8"), artifactDigest: "sha256:d8", environment: "staging",
      containerName: cname, containerPort: 8080,
      imageId: "sha256:expected-8", imageDigest: "sha256:d8",
      rollbackTargetReleaseId: T("rel-8"), rollbackJobId: T("job-8"),
    });

    let rollbackCalls = 0;
    let verifyCalls = 0;
    const executor = new ReleaseRecoveryExecutor({
      intents: new ReleaseDeploymentIntentService(store),
      recovery: new ReleaseRecoveryService(),
      orchestrator: stubOrchestrator, history: stubHistory,
      docker: dockerMatchesIntent(cname, "sha256:expected-8", 8080),
      smoke: stubSmoke, svc: fakeSvc, workerId: "worker-A",
      rollback: { async rollback() { rollbackCalls++; return { status: "COMPLETED", deploymentId: null, message: "" }; } },
      verifyRecoveredRollback: { async verify() { verifyCalls++; return { status: "VERIFIED", message: "" }; } },
    });

    await executor.runOnce();
    await executor.runOnce();
    const fresh = store.getReleaseIntent(intentKey);
    check("T11 replay: rollback delegate never called", rollbackCalls === 0, "rollbackCalls=" + rollbackCalls);
    check("T11 replay: verify delegate called once across both runs", verifyCalls === 1, "verifyCalls=" + verifyCalls);
    check("T11 replay: intent remains terminal FAILED", fresh?.status === "FAILED", "status=" + fresh?.status);
  }

  /* ---------- T12: legacy DEPLOY intent still uses the rollback delegate path ---------- */
  {
    const { store } = await newStore();
    const intentKey = T("intent:legacy-deploy:staging");
    const cname = T("container-legacy");
    seedIntent(store, {
      intentKey, releaseId: T("rel-legacy"), executionId: T("exec-legacy"),
      artifactId: T("art-legacy"), artifactDigest: "sha256:dlegacy", environment: "staging",
      containerName: cname, containerPort: 8080,
      imageId: "sha256:expected-legacy", imageDigest: "sha256:dlegacy",
      rollbackTargetReleaseId: T("rel-legacy"), rollbackJobId: T("job-legacy"),
      kind: "DEPLOY",
    });

    let rollbackCalls = 0;
    let verifyCalls = 0;
    const executor = new ReleaseRecoveryExecutor({
      intents: new ReleaseDeploymentIntentService(store),
      recovery: new ReleaseRecoveryService(),
      orchestrator: stubOrchestrator, history: stubHistory,
      docker: dockerMatchesIntent(cname, "sha256:expected-legacy", 8080),
      smoke: stubSmoke, svc: fakeSvc, workerId: "worker-A",
      rollback: { async rollback() { rollbackCalls++; return { status: "COMPLETED", deploymentId: null, message: "legacy" }; } },
      verifyRecoveredRollback: { async verify() { verifyCalls++; return { status: "VERIFIED", message: "" }; } },
    });

    await executor.runOnce();
    check("T12 legacy DEPLOY intent uses rollback delegate (T78 preserved)", rollbackCalls === 1, "rollbackCalls=" + rollbackCalls);
    check("T12 legacy DEPLOY intent does not use recovery-verification path", verifyCalls === 0, "verifyCalls=" + verifyCalls);
  }

  console.log("");
  console.log("RESULT: " + pass + " passed, " + fail + " failed");
  if (fail > 0) process.exit(1);
  process.exit(0);
}

main().catch((e) => { console.error("[FATAL]", e); process.exit(2); });