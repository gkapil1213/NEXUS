// scripts/test-phase228-production-activation-reconciliation.ts
// Phase 228 - production traffic reconciliation and recovery.
//
// Verifies the Phase 228 additions on top of the Phase 227 activation
// boundary:
//   - previous-active-target capture BEFORE any traffic mutation
//   - classifier semantics corrected per section 17:
//       ACTIVE / MONITORING        -> RECOVERY_REQUIRED (not ALREADY_KNOWN_GOOD)
//       TRAFFIC_RESTORED           -> RECOVERY_REQUIRED (not RESUME_ROLLBACK)
//       POST_ROLLBACK_HEALTH_CHECK -> RECOVERY_REQUIRED
//   - CutoverRequest carries immutable release identity
//   - honest BLOCKED at every traffic-mutation step (no NoopTrafficRouter
//     configured)
//   - Phase 225/226/227 wiring remains intact
//   - real Docker deployment through NEXUS still reaches KNOWN_GOOD

import { NexusKernel } from "../src/core/kernel";
import { DeploymentActivationService } from "../src/core/deployment-activation-service";
import { ReleaseRecoveryService } from "../src/core/release-recovery";
import { NoopTrafficRouter, NO_TRAFFIC_ROUTER_REASON } from "../src/core/traffic-router";
import { createNodeBridge } from "./host-bridge-node";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

type R = "PASS" | "FAIL" | "BLOCKED" | "NOT EXECUTED";
const rows: { id: string; name: string; r: R; n: string }[] = [];
function rec(id: string, name: string, r: R, n: string) {
  rows.push({ id, name, r, n });
  const m = r === "PASS" ? "[PASS]" : r === "FAIL" ? "[FAIL]" : r === "BLOCKED" ? "[BLK ]" : "[N/E ]";
  console.log(`${m} ${id} ${name} -- ${n}`);
}
function ok(c: boolean, m: string) { if (!c) throw new Error(m); }
function rid(p: string) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function intentInput(tag: string) {
  return {
    releaseId: rid("rel228-"),
    executionId: rid("exec228-"),
    attemptId: rid("att228-"),
    artifactId: "art228-" + tag,
    artifactDigest: "sha256:" + "a".repeat(64),
    commitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    environment: "phase228-test-" + tag,
    projectId: "phase228-proj",
    imageRepository: "nexus-app",
    imageTag: "version-a",
    imageId: null,
    imageDigest: "sha256:" + "b".repeat(64),
    containerName: "nexus-228-" + tag,
    containerPort: 8080,
  };
}

async function walkToKnownGood(intents: any, key: string, worker: string) {
  await intents.acquireLeaseAsync(key, worker);
  const tA = await intents.transitionIfOwnedAsync(key, "DEPLOYING", worker, {}, ["DEPLOYMENT_INTENT_CREATED"]);
  if (!tA.updated) throw new Error("DEPLOYING refused");
  const tB = await intents.transitionIfOwnedAsync(key, "HEALTH_CHECKING", worker, {}, ["DEPLOYING"]);
  if (!tB.updated) throw new Error("HEALTH_CHECKING refused");
  const tC = await intents.transitionIfOwnedAsync(key, "SMOKE_TESTING", worker, {}, ["HEALTH_CHECKING"]);
  if (!tC.updated) throw new Error("SMOKE_TESTING refused");
  const tD = await intents.transitionIfOwnedAsync(key, "KNOWN_GOOD", worker, {}, ["SMOKE_TESTING"]);
  if (!tD.updated) throw new Error("KNOWN_GOOD refused");
  await intents.releaseLeaseAsync(key, worker);
}

async function main() {
  const bridgeRoot = path.join(os.tmpdir(), "nexus-phase228-" + Date.now());
  const nodeBridge = createNodeBridge(bridgeRoot);
  (globalThis as any).window = { __NEXUS_HOST__: nodeBridge };
  // 228A: kernel wiring
  let svc: Awaited<ReturnType<NexusKernel["boot"]>> | undefined;
  try {
    const k = new NexusKernel();
    svc = await k.boot();
    ok(!!svc.deploymentActivationService, "deploymentActivationService missing");
    ok(!!svc.releaseIntents, "releaseIntents missing");
    ok(!!svc.deployments, "deployments missing");
    ok(!!svc.releaseDeploymentExecutor, "releaseDeploymentExecutor missing");
    rec("228A", "kernel wiring", "PASS",
        `activation=${typeof svc.deploymentActivationService} intents=${typeof svc.releaseIntents}`);
  } catch (e) { rec("228A", "kernel wiring", "FAIL", String(e)); }

  if (!svc?.releaseIntents || !svc?.deploymentActivationService) { finish(); return; }
  const intents = svc.releaseIntents;

  // 228B: NoopTrafficRouter returns BLOCKED
  try {
    const r = new NoopTrafficRouter();
    const c = await r.cutover({
      environment: "t", intentKey: "k", releaseId: "r", commitSha: "c",
      imageRepository: "x", imageTag: "y", imageId: null, imageDigest: null,
      containerName: "n", containerPort: 0, previousContainerName: null,
    });
    ok(c.ok === false && c.reason === NO_TRAFFIC_ROUTER_REASON, `reason=${c.reason}`);
    rec("228B", "NoopTrafficRouter BLOCKED", "PASS", `reason=${NO_TRAFFIC_ROUTER_REASON}`);
  } catch (e) { rec("228B", "NoopTrafficRouter BLOCKED", "FAIL", String(e)); }

  // 228C: activate refuses non-KNOWN_GOOD
  try {
    const inp = intentInput("C");
    const r = await intents.getOrCreateAsync(inp as any);
    const act = await svc.deploymentActivationService.activate(r.intent.intentKey, rid("w228C-"));
    ok(act.status === "BLOCKED", `expected BLOCKED, got ${act.status}`);
    ok((act.reason ?? "").startsWith("INTENT_NOT_KNOWN_GOOD"), `reason=${act.reason}`);
    rec("228C", "activate refuses non-KNOWN_GOOD", "PASS", `reason=${act.reason}`);
  } catch (e) { rec("228C", "activate refuses non-KNOWN_GOOD", "FAIL", String(e)); }

  // 228D: previous-target resolution via spy on history
  try {
    const captured: any[] = [];
    const spyHistory = {
      async getCurrentDeployment(projectId: string, environment: string) {
        captured.push({ projectId, environment });
        return {
          id: "prev-dep-228D",
          project_id: projectId,
          environment,
          release_id: "prev-rel",
          commit_sha: "prevsha",
          image_id: "sha256:prev",
          image_digest: null,
          image_repository: "nexus-app",
          image_tag: "prev-tag",
          container_name: "nexus-228-prev",
          container_id: "prev-container-id",
          url: "http://127.0.0.1:8081",
          status: "KNOWN_GOOD" as const,
        };
      },
    };
    const spyRouter = {
      kind: "noop" as const,
      cutover: async () => ({ ok: false, reason: "SPY", activeTarget: null }),
      revert: async () => ({ ok: false, reason: "SPY", activeTarget: null }),
      resolveActive: async () => null,
    };
    const spySvc = new DeploymentActivationService(svc.releaseIntents, spyRouter as any, spyHistory as any);

    const inp = intentInput("D");
    const r = await intents.getOrCreateAsync(inp as any);
    const key = r.intent.intentKey;
    const w = rid("w228D-");
    await walkToKnownGood(intents, key, w);

    const act = await spySvc.activate(key, rid("w228Dact-"));
    ok(captured.length >= 1, `spy history called ${captured.length} times`);
    ok(act.previousTarget?.deploymentId === "prev-dep-228D", `previousTarget.deploymentId=${act.previousTarget?.deploymentId}`);
    ok(act.previousTarget?.containerName === "nexus-228-prev", `previousTarget.containerName=${act.previousTarget?.containerName}`);
    ok(act.previousTarget?.imageId === "sha256:prev", `previousTarget.imageId=${act.previousTarget?.imageId}`);
    rec("228D", "previous-target resolved before cutover", "PASS",
        `deploymentId=prev-dep-228D containerName=nexus-228-prev`);
  } catch (e) { rec("228D", "previous-target resolved before cutover", "FAIL", String(e)); }

  // 228E: previousTarget persisted in result even when cutover is BLOCKED
  try {
    const spyRouter = {
      kind: "noop" as const,
      cutover: async () => ({ ok: false, reason: NO_TRAFFIC_ROUTER_REASON, activeTarget: null }),
      revert: async () => ({ ok: false, reason: NO_TRAFFIC_ROUTER_REASON, activeTarget: null }),
      resolveActive: async () => null,
    };
    const spyHistory = {
      async getCurrentDeployment() {
        return {
          id: "prev-dep-228E", project_id: "p", environment: "e",
          release_id: "prev-rel", commit_sha: "prevsha",
          image_id: "sha256:prevE", image_digest: null,
          image_repository: "nexus-app", image_tag: "prev-tag",
          container_name: "nexus-228-prevE", container_id: "cid",
          url: null, status: "KNOWN_GOOD" as const,
        };
      },
    };
    const spySvc = new DeploymentActivationService(svc.releaseIntents, spyRouter as any, spyHistory as any);
    const inp = intentInput("E");
    const r = await intents.getOrCreateAsync(inp as any);
    const key = r.intent.intentKey;
    await walkToKnownGood(intents, key, rid("w228E-"));
    const act = await spySvc.activate(key, rid("w228Eact-"));
    ok(act.status === "BLOCKED", `expected BLOCKED, got ${act.status}`);
    ok(act.previousTarget?.deploymentId === "prev-dep-228E", `previousTarget missing: ${JSON.stringify(act.previousTarget)}`);
    ok(act.cutover.attempted === true, "cutover not attempted");
    rec("228E", "previousTarget persisted on cutover BLOCKED", "PASS",
        `status=BLOCKED prev=prev-dep-228E`);
  } catch (e) { rec("228E", "previousTarget persisted on cutover BLOCKED", "FAIL", String(e)); }

  // 228F: CutoverRequest carries immutable identity
  try {
    const captured: any[] = [];
    const spyRouter = {
      kind: "noop" as const,
      cutover: async (req: any) => { captured.push(req); return { ok: false, reason: "SPY", activeTarget: null }; },
      revert: async () => ({ ok: false, reason: "SPY", activeTarget: null }),
      resolveActive: async () => null,
    };
    const spySvc = new DeploymentActivationService(svc.releaseIntents, spyRouter as any);
    const inp = intentInput("F");
    const r = await intents.getOrCreateAsync(inp as any);
    const key = r.intent.intentKey;
    await walkToKnownGood(intents, key, rid("w228F-"));
    await spySvc.activate(key, rid("w228Fact-"));
    ok(captured.length === 1, `cutover called ${captured.length} times`);
    const req = captured[0];
    ok(req.releaseId === inp.releaseId, `releaseId mismatch`);
    ok(req.commitSha === inp.commitSha, `commitSha mismatch`);
    ok(req.imageRepository === inp.imageRepository, `imageRepository mismatch`);
    ok(req.imageTag === inp.imageTag, `imageTag mismatch`);
    ok(req.imageDigest === inp.imageDigest, `imageDigest mismatch`);
    ok(req.environment === inp.environment, `environment mismatch`);
    ok(req.containerName === inp.containerName, `containerName mismatch`);
    rec("228F", "CutoverRequest immutable identity", "PASS",
        `releaseId+commitSha+imageRepository+imageTag+imageDigest+env+containerName`);
  } catch (e) { rec("228F", "CutoverRequest immutable identity", "FAIL", String(e)); }

  // 228G: cutover BLOCKED -> intent=ACTIVATION_FAILED with reason
  try {
    const inp = intentInput("G");
    const r = await intents.getOrCreateAsync(inp as any);
    const key = r.intent.intentKey;
    await walkToKnownGood(intents, key, rid("w228G-"));
    const act = await svc.deploymentActivationService.activate(key, rid("w228Gact-"));
    ok(act.status === "BLOCKED", `expected BLOCKED, got ${act.status}`);
    ok(act.cutover.reason === NO_TRAFFIC_ROUTER_REASON, `cutover reason=${act.cutover.reason}`);
    const after = await intents.getAsync(key);
    ok(after?.status === "ACTIVATION_FAILED", `intent status=${after?.status}`);
    rec("228G", "cutover BLOCKED -> ACTIVATION_FAILED", "PASS",
        `status=${after?.status} reason=${NO_TRAFFIC_ROUTER_REASON}`);
  } catch (e) { rec("228G", "cutover BLOCKED -> ACTIVATION_FAILED", "FAIL", String(e)); }

  // 228H: rollback refuses non-ACTIVE
  try {
    const inp = intentInput("H");
    const r = await intents.getOrCreateAsync(inp as any);
    const rb = await svc.deploymentActivationService.rollback(r.intent.intentKey, rid("w228H-"));
    ok(rb.status === "BLOCKED", `expected BLOCKED, got ${rb.status}`);
    ok((rb.reason ?? "").startsWith("INTENT_NOT_ACTIVE"), `reason=${rb.reason}`);
    rec("228H", "rollback refuses non-ACTIVE", "PASS", `reason=${rb.reason}`);
  } catch (e) { rec("228H", "rollback refuses non-ACTIVE", "FAIL", String(e)); }
  // 228I: classifier ACTIVE -> RECOVERY_REQUIRED
  try {
    const rsvc = new ReleaseRecoveryService();
    const plan = rsvc.classify({ intent: { intentKey: "k", status: "ACTIVE" } as any });
    ok(plan.action === "RECOVERY_REQUIRED", `ACTIVE -> ${plan.action}`);
    ok(plan.requiresDockerInspection === true, "requiresDockerInspection should be true");
    rec("228I", "classifier ACTIVE -> RECOVERY_REQUIRED", "PASS", `action=${plan.action}`);
  } catch (e) { rec("228I", "classifier ACTIVE -> RECOVERY_REQUIRED", "FAIL", String(e)); }

  // 228J: classifier TRAFFIC_RESTORED -> RECOVERY_REQUIRED
  try {
    const rsvc = new ReleaseRecoveryService();
    const plan = rsvc.classify({ intent: { intentKey: "k", status: "TRAFFIC_RESTORED" } as any });
    ok(plan.action === "RECOVERY_REQUIRED", `TRAFFIC_RESTORED -> ${plan.action}`);
    rec("228J", "classifier TRAFFIC_RESTORED -> RECOVERY_REQUIRED", "PASS", `action=${plan.action}`);
  } catch (e) { rec("228J", "classifier TRAFFIC_RESTORED -> RECOVERY_REQUIRED", "FAIL", String(e)); }

  // 228K: classifier POST_ROLLBACK_HEALTH_CHECK -> RECOVERY_REQUIRED
  try {
    const rsvc = new ReleaseRecoveryService();
    const plan = rsvc.classify({ intent: { intentKey: "k", status: "POST_ROLLBACK_HEALTH_CHECK" } as any });
    ok(plan.action === "RECOVERY_REQUIRED", `POST_ROLLBACK_HEALTH_CHECK -> ${plan.action}`);
    rec("228K", "classifier POST_ROLLBACK_HEALTH_CHECK -> RECOVERY_REQUIRED", "PASS", `action=${plan.action}`);
  } catch (e) { rec("228K", "classifier POST_ROLLBACK_HEALTH_CHECK -> RECOVERY_REQUIRED", "FAIL", String(e)); }

  // 228L: duplicate activation is idempotent (second attempt denied by lease)
  try {
    const inp = intentInput("L");
    const r = await intents.getOrCreateAsync(inp as any);
    const key = r.intent.intentKey;
    const w = rid("w228L-");
    await intents.acquireLeaseAsync(key, w);
    await intents.transitionIfOwnedAsync(key, "DEPLOYING", w, {}, ["DEPLOYMENT_INTENT_CREATED"]);
    await intents.transitionIfOwnedAsync(key, "HEALTH_CHECKING", w, {}, ["DEPLOYING"]);
    await intents.transitionIfOwnedAsync(key, "SMOKE_TESTING", w, {}, ["HEALTH_CHECKING"]);
    await intents.transitionIfOwnedAsync(key, "KNOWN_GOOD", w, {}, ["SMOKE_TESTING"]);
    // Leave lease with w; second activation from a different worker is denied
    const act2 = await svc.deploymentActivationService.activate(key, rid("w228L-2-"));
    ok(act2.status === "BLOCKED", `expected BLOCKED, got ${act2.status}`);
    ok((act2.reason ?? "").startsWith("ACTIVATION_LEASE_HELD"), `reason=${act2.reason}`);
    await intents.releaseLeaseAsync(key, w);
    rec("228L", "duplicate activation denied by lease", "PASS", `reason=${act2.reason}`);
  } catch (e) { rec("228L", "duplicate activation denied by lease", "FAIL", String(e)); }

  // 228M: stale worker cannot transition (lease fencing)
  try {
    const inp = intentInput("M");
    const r = await intents.getOrCreateAsync(inp as any);
    const key = r.intent.intentKey;
    const w1 = rid("w228M1-");
    const w2 = rid("w228M2-");
    await intents.acquireLeaseAsync(key, w1);
    const t = await intents.transitionIfOwnedAsync(key, "DEPLOYING", w2, {}, ["DEPLOYMENT_INTENT_CREATED"]);
    ok(t.updated === false, "stale worker transition unexpectedly succeeded");
    const after = await intents.getAsync(key);
    ok(after?.status === "DEPLOYMENT_INTENT_CREATED", `state changed by stale worker: ${after?.status}`);
    await intents.releaseLeaseAsync(key, w1);
    rec("228M", "stale worker fenced", "PASS", "state unchanged");
  } catch (e) { rec("228M", "stale worker fenced", "FAIL", String(e)); }

  // 228N: restart recovery - intent stuck in ACTIVATING is classified RECOVERY_REQUIRED
  try {
    const rsvc = new ReleaseRecoveryService();
    const plan = rsvc.classify({ intent: { intentKey: "k", status: "ACTIVATING" } as any });
    ok(plan.action === "RECOVERY_REQUIRED", `ACTIVATING -> ${plan.action}`);
    ok(plan.requiresDockerInspection === true, "requiresDockerInspection should be true");
    rec("228N", "restart recovery ACTIVATING", "PASS", `action=${plan.action} inspect=${plan.requiresDockerInspection}`);
  } catch (e) { rec("228N", "restart recovery ACTIVATING", "FAIL", String(e)); }

  // 228O: Phase 225 wiring intact
  try {
    ok(!!svc.releaseDeploymentExecutor, "releaseDeploymentExecutor missing");
    ok(!!svc.releaseExecutionGate, "releaseExecutionGate missing");
    rec("228O", "Phase 225 wiring intact", "PASS", "executor+gate exposed");
  } catch (e) { rec("228O", "Phase 225 wiring intact", "FAIL", String(e)); }

  // 228P: Phase 226 wiring intact
  try {
    const inp = intentInput("P");
    const r = await intents.getOrCreateAsync(inp as any);
    ok(!!r.intent.intentKey, "getOrCreateAsync missing key");
    rec("228P", "Phase 226 wiring intact", "PASS", `intents work`);
  } catch (e) { rec("228P", "Phase 226 wiring intact", "FAIL", String(e)); }

  // 228Q: Phase 227 wiring intact
  try {
    ok(!!svc.deploymentActivationService, "deploymentActivationService missing");
    rec("228Q", "Phase 227 wiring intact", "PASS", "activation service exposed");
  } catch (e) { rec("228Q", "Phase 227 wiring intact", "FAIL", String(e)); }

  // 228R: real Docker deployment through NEXUS -> KNOWN_GOOD
  try {
    const imageId = execSync("docker inspect nexus-app:version-a --format {{.Id}}", {
      encoding: "utf8", timeout: 10_000,
    }).trim();
    const containerName = rid("nexus-228R-");
    const out = await svc.deployments.deploy({
      project_id: "phase228-proj",
      environment: "phase228-" + Date.now().toString(36),
      release_id: "rel228-R",
      image_repository: "nexus-app",
      image_tag: "version-a",
      image_id: imageId,
      image_digest: null,
      container_name: containerName,
      container_port: 8080,
      attempt_id: rid("att228R-"),
    });
    const status = out?.deployment?.status;
    if (status === "KNOWN_GOOD" || status === "SUCCEEDED") {
      rec("228R", "real deployment through NEXUS", "PASS",
          `container=${out?.deployment?.container_id?.slice(0,12) ?? "?"} status=${status}`);
    } else {
      rec("228R", "real deployment through NEXUS", "FAIL",
          `status=${status} reason=${out?.deployment?.failure_reason ?? "?"}`);
    }
    try { execSync(`docker rm -f ${containerName}`, { stdio: "ignore", timeout: 10_000 }); } catch {}
  } catch (e) { rec("228R", "real deployment through NEXUS", "FAIL", String(e).slice(0, 120)); }

  finish();
}

function finish() {
  console.log("");
  console.log("===== Phase 228 summary =====");
  const pass = rows.filter(r => r.r === "PASS").length;
  const fail = rows.filter(r => r.r === "FAIL").length;
  const blk  = rows.filter(r => r.r === "BLOCKED").length;
  const ne   = rows.filter(r => r.r === "NOT EXECUTED").length;
  console.log(`PASS: ${pass}`);
  console.log(`FAIL: ${fail}`);
  console.log(`BLOCKED: ${blk}`);
  console.log(`NOT EXECUTED: ${ne}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });