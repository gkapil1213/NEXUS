// scripts/test-phase121-rollback-verification-evidence.ts
// Phase 121 — durable rollback-verification evidence.

import { openEngine } from "../src/core/db";
import { EventService } from "../src/core/events";
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
  return { async run(op: DockerOp): Promise<DockerResult> {
    const over = script(op) ?? {};
    return { status: "SUCCEEDED", command: "docker " + op.kind, exit_code: 0,
      stdout: "", stderr: "", duration_ms: 1, blocked_reason: null, ...over } as DockerResult;
  } } as any;
}
function dockerMatches(name: string, imageId: string, port: number): DockerAdapter {
  return mockDocker((op) => (op.kind === "inspect" && (op as any).image === name)
    ? { stdout: JSON.stringify([{ Id: "cid-t121", Image: imageId,
        NetworkSettings: { Ports: { [port + "/tcp"]: [{ HostPort: String(port) }] } } }]) }
    : undefined);
}
function dockerMissing(name: string): DockerAdapter {
  return mockDocker((op) => (op.kind === "inspect" && (op as any).image === name)
    ? { status: "FAILED", exit_code: 1, stderr: "Error: No such container: " + name }
    : undefined);
}
function dockerIdentityMismatch(name: string): DockerAdapter {
  return mockDocker((op) => (op.kind === "inspect" && (op as any).image === name)
    ? { stdout: JSON.stringify([{ Id: "cid", Image: "sha256:WRONG", NetworkSettings: { Ports: {} } }]) }
    : undefined);
}

async function newEnv() {
  const engine = await openEngine();
  const store = new ExecutionStore(engine);
  const events = new EventService(engine);
  await events.init();
  const svc = { events, audit: { record: async () => {} } };
  return { engine, store, svc };
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

async function eventsFor(engine: any, intentKey: string): Promise<any[]> {
  const all = (await engine.all("events")) as any[];
  return all.filter((e) => e?.payload && e.payload.intentKey === intentKey);
}
function eventTypes(list: any[]): string[] { return list.map((e) => e.type); }

const forbiddenKey = /password|token|secret|auth|cookie|api[_-]?key|credential/i;

async function main() {
  console.log("NEXUS PHASE 121 ROLLBACK VERIFICATION EVIDENCE TESTS");
  console.log("====================================================\n");

  /* ---- Group 1-5: verified rollback with full evidence ---- */
  {
    const { engine, store, svc } = await newEnv();
    const key = T("rollback:rel-t1:staging"); const cname = T("c-t1");
    seedIntent(store, { intentKey: key, releaseId: T("rel-t1"), executionId: T("exec-t1"),
      artifactId: T("art-t1"), artifactDigest: "sha256:expected-art-t1", environment: "staging",
      projectId: "proj-t1", containerName: cname, containerPort: 4173,
      imageId: "sha256:img-t1", imageDigest: "sha256:digest-t1", kind: "ROLLBACK" });

    let rollbackCalls = 0;
    const executor = new ReleaseRecoveryExecutor({
      intents: new ReleaseDeploymentIntentService(store), recovery: new ReleaseRecoveryService(),
      orchestrator: {} as any, history: {} as any,
      docker: dockerMatches(cname, "sha256:img-t1", 4173),
      smoke: {} as SmokeTestService, svc: svc as any, workerId: "w-t1",
      rollback: { async rollback() { rollbackCalls++; return { status: "COMPLETED", deploymentId: null, message: "no" }; } },
      verifyRecoveredRollback: { async verify() { return { status: "VERIFIED", message: "health+smoke PASS" }; } },
    });
    await executor.runOnce();

    const evs = await eventsFor(engine, key);
    const types = eventTypes(evs);
    const started = evs.find((e) => e.type === "release.recovery.rollback.verification_started");

    check("T1 verified rollback creates durable evidence", !!started, "events=" + JSON.stringify(types));
    check("T2 evidence records intent identity", started?.payload?.intentKey === key, "key=" + started?.payload?.intentKey);
    check("T3 evidence records expected immutable identity",
      started?.payload?.expectedImageId === "sha256:img-t1" && started?.payload?.expectedArtifactDigest === "sha256:expected-art-t1",
      "payload=" + JSON.stringify({ i: started?.payload?.expectedImageId, d: started?.payload?.expectedArtifactDigest }));
    check("T4 evidence records observed container/image identity",
      started?.payload?.observedContainerId === "cid-t121" && started?.payload?.observedImageId === "sha256:img-t1",
      "observed=" + JSON.stringify({ c: started?.payload?.observedContainerId, i: started?.payload?.observedImageId }));
    check("T5 evidence records verification URL",
      started?.payload?.stagingUrl === "http://127.0.0.1:4173",
      "url=" + started?.payload?.stagingUrl);
    check("T6 PASS -> terminal FAILED convention", store.getReleaseIntent(key)?.status === "FAILED",
      "status=" + store.getReleaseIntent(key)?.status);
    check("T7 PASS -> verification_passed + rollback.verified both emitted",
      types.includes("release.recovery.rollback.verification_passed") && types.includes("release.recovery.rollback.verified"),
      "types=" + JSON.stringify(types));
    check("T13 rollback provider never re-called (verified path)", rollbackCalls === 0, "rollbackCalls=" + rollbackCalls);
  }

  /* ---- T8: VERIFICATION_FAILED ---- */
  {
    const { engine, store, svc } = await newEnv();
    const key = T("rollback:rel-t8:staging"); const cname = T("c-t8");
    seedIntent(store, { intentKey: key, releaseId: T("rel-t8"), executionId: T("exec-t8"),
      artifactId: T("art-t8"), artifactDigest: "d8", environment: "staging",
      projectId: "proj-t8", containerName: cname, containerPort: 8080,
      imageId: "sha256:img-t8", imageDigest: "d8", kind: "ROLLBACK" });

    let rollbackCalls = 0;
    const executor = new ReleaseRecoveryExecutor({
      intents: new ReleaseDeploymentIntentService(store), recovery: new ReleaseRecoveryService(),
      orchestrator: {} as any, history: {} as any,
      docker: dockerMatches(cname, "sha256:img-t8", 8080),
      smoke: {} as SmokeTestService, svc: svc as any, workerId: "w-t8",
      rollback: { async rollback() { rollbackCalls++; return { status: "COMPLETED", deploymentId: null, message: "no" }; } },
      verifyRecoveredRollback: { async verify() { return { status: "VERIFICATION_FAILED", message: "smoke reported FAIL" }; } },
    });
    await executor.runOnce();

    const evs = await eventsFor(engine, key);
    const types = eventTypes(evs);
    const failedEv = evs.find((e) => e.type === "release.recovery.rollback.verification_failed");
    check("T8 FAIL produces verification_failed evidence",
      !!failedEv && failedEv.payload.verificationStatus === "VERIFICATION_FAILED",
      "types=" + JSON.stringify(types));
    check("T8 FAIL -> intent VERIFICATION_FAILED", store.getReleaseIntent(key)?.status === "VERIFICATION_FAILED",
      "status=" + store.getReleaseIntent(key)?.status);
    check("T8 FAIL -> no verification_passed emitted", !types.includes("release.recovery.rollback.verification_passed"));
    check("T13 rollback provider never re-called (FAIL path)", rollbackCalls === 0);
  }

  /* ---- T9: BLOCKED ---- */
  {
    const { engine, store, svc } = await newEnv();
    const key = T("rollback:rel-t9:staging"); const cname = T("c-t9");
    seedIntent(store, { intentKey: key, releaseId: T("rel-t9"), executionId: T("exec-t9"),
      artifactId: T("art-t9"), artifactDigest: "d9", environment: "staging",
      projectId: "proj-t9", containerName: cname, containerPort: 8080,
      imageId: "sha256:img-t9", imageDigest: "d9", kind: "ROLLBACK" });

    const executor = new ReleaseRecoveryExecutor({
      intents: new ReleaseDeploymentIntentService(store), recovery: new ReleaseRecoveryService(),
      orchestrator: {} as any, history: {} as any,
      docker: dockerMatches(cname, "sha256:img-t9", 8080),
      smoke: {} as SmokeTestService, svc: svc as any, workerId: "w-t9",
      rollback: { async rollback() { return { status: "COMPLETED", deploymentId: null, message: "no" }; } },
      verifyRecoveredRollback: { async verify() { return { status: "BLOCKED", message: "playwright unavailable" }; } },
    });
    await executor.runOnce();

    const evs = await eventsFor(engine, key);
    const blockedEv = evs.find((e) => e.type === "release.recovery.rollback.verification_blocked");
    check("T9 BLOCKED produces verification_blocked evidence",
      !!blockedEv && blockedEv.payload.verificationStatus === "BLOCKED",
      "reason=" + blockedEv?.payload?.reason);
    check("T9 BLOCKED -> intent RECOVERY_REQUIRED",
      store.getReleaseIntent(key)?.status === "RECOVERY_REQUIRED",
      "status=" + store.getReleaseIntent(key)?.status);
    check("T17 BLOCKED cannot produce VERIFIED",
      !eventTypes(evs).includes("release.recovery.rollback.verification_passed"));
  }

  /* ---- T10: Missing container ---- */
  {
    const { engine, store, svc } = await newEnv();
    const key = T("rollback:rel-t10:staging"); const cname = T("c-t10");
    seedIntent(store, { intentKey: key, releaseId: T("rel-t10"), executionId: T("exec-t10"),
      artifactId: T("art-t10"), artifactDigest: "d10", environment: "staging",
      projectId: "proj-t10", containerName: cname, containerPort: 8080,
      imageId: "sha256:img-t10", imageDigest: "d10", kind: "ROLLBACK" });

    const executor = new ReleaseRecoveryExecutor({
      intents: new ReleaseDeploymentIntentService(store), recovery: new ReleaseRecoveryService(),
      orchestrator: {} as any, history: {} as any,
      docker: dockerMissing(cname),
      smoke: {} as SmokeTestService, svc: svc as any, workerId: "w-t10",
      rollback: { async rollback() { return { status: "COMPLETED", deploymentId: null, message: "no" }; } },
      verifyRecoveredRollback: { async verify() { return { status: "VERIFIED", message: "" }; } },
    });
    await executor.runOnce();

    const types = eventTypes(await eventsFor(engine, key));
    check("T10 missing container does not create verification_started",
      !types.includes("release.recovery.rollback.verification_started"), "types=" + JSON.stringify(types));
    check("T10 missing container does not create verification_passed",
      !types.includes("release.recovery.rollback.verification_passed"));
  }

  /* ---- T11: Identity mismatch ---- */
  {
    const { store, svc } = await newEnv();
    const key = T("rollback:rel-t11:staging"); const cname = T("c-t11");
    seedIntent(store, { intentKey: key, releaseId: T("rel-t11"), executionId: T("exec-t11"),
      artifactId: T("art-t11"), artifactDigest: "d11", environment: "staging",
      projectId: "proj-t11", containerName: cname, containerPort: 8080,
      imageId: "sha256:img-t11", imageDigest: "d11", kind: "ROLLBACK" });

    let verifyCalls = 0;
    const executor = new ReleaseRecoveryExecutor({
      intents: new ReleaseDeploymentIntentService(store), recovery: new ReleaseRecoveryService(),
      orchestrator: {} as any, history: {} as any,
      docker: dockerIdentityMismatch(cname),
      smoke: {} as SmokeTestService, svc: svc as any, workerId: "w-t11",
      rollback: { async rollback() { return { status: "COMPLETED", deploymentId: null, message: "no" }; } },
      verifyRecoveredRollback: { async verify() { verifyCalls++; return { status: "VERIFIED", message: "" }; } },
    });
    await executor.runOnce();
    check("T11 identity mismatch does not invoke verifier", verifyCalls === 0, "verifyCalls=" + verifyCalls);
  }

  /* ---- T12: Lease contention ---- */
  {
    const { store, svc } = await newEnv();
    const key = T("rollback:rel-t12:staging"); const cname = T("c-t12");
    seedIntent(store, { intentKey: key, releaseId: T("rel-t12"), executionId: T("exec-t12"),
      artifactId: T("art-t12"), artifactDigest: "d12", environment: "staging",
      projectId: "proj-t12", containerName: cname, containerPort: 8080,
      imageId: "sha256:img-t12", imageDigest: "d12", kind: "ROLLBACK" });

    const intentSvc = new ReleaseDeploymentIntentService(store);
    intentSvc.acquireLease(key, "other-worker", 120_000);

    let verifyCalls = 0;
    const executor = new ReleaseRecoveryExecutor({
      intents: intentSvc, recovery: new ReleaseRecoveryService(),
      orchestrator: {} as any, history: {} as any,
      docker: dockerMatches(cname, "sha256:img-t12", 8080),
      smoke: {} as SmokeTestService, svc: svc as any, workerId: "w-t12",
      rollback: { async rollback() { return { status: "COMPLETED", deploymentId: null, message: "no" }; } },
      verifyRecoveredRollback: { async verify() { verifyCalls++; return { status: "VERIFIED", message: "" }; } },
    });
    const report = await executor.runOnce();
    check("T12 lease contention does not invoke verifier", verifyCalls === 0, "verifyCalls=" + verifyCalls);
    check("T12 lease contention recorded", report.leaseHeld >= 1, "leaseHeld=" + report.leaseHeld);
  }

  /* ---- T14-T15: Replay safety ---- */
  {
    const { engine, store, svc } = await newEnv();
    const key = T("rollback:rel-t14:staging"); const cname = T("c-t14");
    seedIntent(store, { intentKey: key, releaseId: T("rel-t14"), executionId: T("exec-t14"),
      artifactId: T("art-t14"), artifactDigest: "d14", environment: "staging",
      projectId: "proj-t14", containerName: cname, containerPort: 8080,
      imageId: "sha256:img-t14", imageDigest: "d14", kind: "ROLLBACK" });

    let verifyCalls = 0;
    const executor = new ReleaseRecoveryExecutor({
      intents: new ReleaseDeploymentIntentService(store), recovery: new ReleaseRecoveryService(),
      orchestrator: {} as any, history: {} as any,
      docker: dockerMatches(cname, "sha256:img-t14", 8080),
      smoke: {} as SmokeTestService, svc: svc as any, workerId: "w-t14",
      rollback: { async rollback() { return { status: "COMPLETED", deploymentId: null, message: "no" }; } },
      verifyRecoveredRollback: { async verify() { verifyCalls++; return { status: "VERIFIED", message: "" }; } },
    });
    await executor.runOnce();
    await executor.runOnce();

    const evs = await eventsFor(engine, key);
    const types = eventTypes(evs);
    const startedCount = types.filter((t) => t === "release.recovery.rollback.verification_started").length;
    const passedCount = types.filter((t) => t === "release.recovery.rollback.verification_passed").length;

    check("T14 replay does not execute verification again", verifyCalls === 1 && startedCount === 1,
      "verifyCalls=" + verifyCalls + " startedCount=" + startedCount);
    check("T15 replay does not duplicate successful evidence", passedCount === 1, "passedCount=" + passedCount);
  }

  /* ---- T16: Verification exception ---- */
  {
    const { engine, store, svc } = await newEnv();
    const key = T("rollback:rel-t16:staging"); const cname = T("c-t16");
    seedIntent(store, { intentKey: key, releaseId: T("rel-t16"), executionId: T("exec-t16"),
      artifactId: T("art-t16"), artifactDigest: "d16", environment: "staging",
      projectId: "proj-t16", containerName: cname, containerPort: 8080,
      imageId: "sha256:img-t16", imageDigest: "d16", kind: "ROLLBACK" });

    const executor = new ReleaseRecoveryExecutor({
      intents: new ReleaseDeploymentIntentService(store), recovery: new ReleaseRecoveryService(),
      orchestrator: {} as any, history: {} as any,
      docker: dockerMatches(cname, "sha256:img-t16", 8080),
      smoke: {} as SmokeTestService, svc: svc as any, workerId: "w-t16",
      rollback: { async rollback() { return { status: "COMPLETED", deploymentId: null, message: "no" }; } },
      verifyRecoveredRollback: { async verify(): Promise<any> { throw new Error("simulated verifier explosion"); } },
    });
    await executor.runOnce();

    const evs = await eventsFor(engine, key);
    const types = eventTypes(evs);
    const blockedEv = evs.find((e) => e.type === "release.recovery.rollback.verification_blocked");
    check("T16 exception does not produce VERIFIED",
      !types.includes("release.recovery.rollback.verification_passed"));
    check("T16 exception -> verification_blocked with EXCEPTION status",
      !!blockedEv && blockedEv.payload.verificationStatus === "EXCEPTION",
      "status=" + blockedEv?.payload?.verificationStatus);
    check("T16 exception -> intent RECOVERY_REQUIRED",
      store.getReleaseIntent(key)?.status === "RECOVERY_REQUIRED");
  }

  /* ---- T18: No secrets in evidence ---- */
  {
    const { engine, store, svc } = await newEnv();
    const key = T("rollback:rel-t18:staging"); const cname = T("c-t18");
    seedIntent(store, { intentKey: key, releaseId: T("rel-t18"), executionId: T("exec-t18"),
      artifactId: T("art-t18"), artifactDigest: "d18", environment: "staging",
      projectId: "proj-t18", containerName: cname, containerPort: 8080,
      imageId: "sha256:img-t18", imageDigest: "d18", kind: "ROLLBACK" });

    const executor = new ReleaseRecoveryExecutor({
      intents: new ReleaseDeploymentIntentService(store), recovery: new ReleaseRecoveryService(),
      orchestrator: {} as any, history: {} as any,
      docker: dockerMatches(cname, "sha256:img-t18", 8080),
      smoke: {} as SmokeTestService, svc: svc as any, workerId: "w-t18",
      rollback: { async rollback() { return { status: "COMPLETED", deploymentId: null, message: "no" }; } },
      verifyRecoveredRollback: { async verify() { return { status: "VERIFIED", message: "ok" }; } },
    });
    await executor.runOnce();

    const evs = await eventsFor(engine, key);
    const flat = JSON.stringify(evs);
    const leaks: string[] = [];
    for (const e of evs) {
      for (const k of Object.keys(e.payload ?? {})) {
        if (forbiddenKey.test(k)) leaks.push("key:" + k);
      }
    }
    // Also check any value that looks like a bearer/JWT (base64url with two dots).
    if (/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(flat)) leaks.push("jwt-like-value");
    if (/Bearer\s+[A-Za-z0-9._-]{20,}/.test(flat)) leaks.push("bearer-header");
    check("T18 evidence contains no secrets/tokens/credentials", leaks.length === 0,
      leaks.length ? "leaks=" + JSON.stringify(leaks) : "scan clean");
  }

  console.log("");
  console.log("RESULT: " + pass + " passed, " + fail + " failed");
  if (fail > 0) process.exit(1);
  process.exit(0);
}

main().catch((e) => { console.error("[FATAL]", e); process.exit(2); });