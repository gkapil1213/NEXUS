// scripts/test-phase227-production-activation.ts
// Phase 227 - production activation, traffic cutover, zero-downtime rollout.
//
// Real traffic routing does NOT exist in this environment. Per prompt section 7
// and 27, the correct outcome for cutover is BLOCKED with reason
// NO_TRAFFIC_ROUTER_CONFIGURED. This suite verifies:
//   - the activation lifecycle state machine walks correctly to TRAFFIC_CUTOVER
//   - cutover honestly returns BLOCKED via NoopTrafficRouter
//   - the intent lands in ACTIVATION_FAILED with the real reason persisted
//   - rollback request refuses when the intent is not ACTIVE
//   - identity binding is real (release id, commit sha, image id are all
//     threaded through the CutoverRequest)
//   - lease fencing protects against concurrent activations
//   - Phase 225 + Phase 226 wiring remains intact

import { NexusKernel } from "../src/core/kernel";
import { DeploymentActivationService } from "../src/core/deployment-activation-service";
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

async function main() {
  const bridgeRoot = path.join(os.tmpdir(), "nexus-phase227-" + Date.now());
  const nodeBridge = createNodeBridge(bridgeRoot);
  (globalThis as any).window = { __NEXUS_HOST__: nodeBridge };
  // 227A: activation service reachable from kernel
  let svc: Awaited<ReturnType<NexusKernel["boot"]>> | undefined;
  try {
    const k = new NexusKernel();
    svc = await k.boot();
    ok(!!svc.deploymentActivationService, "deploymentActivationService missing");
    ok(!!svc.releaseIntents, "releaseIntents missing");
    rec("227A", "kernel wiring", "PASS",
        `activation=${typeof svc.deploymentActivationService} intents=${typeof svc.releaseIntents}`);
  } catch (e) { rec("227A", "kernel wiring", "FAIL", String(e)); }

  if (!svc?.releaseIntents || !svc?.deploymentActivationService) {
    finish(); return;
  }
  const intents = svc.releaseIntents;

  // 227B: NoopTrafficRouter returns BLOCKED on every operation
  try {
    const r = new NoopTrafficRouter();
    const c = await r.cutover({
      environment: "test", intentKey: "k", releaseId: "r", commitSha: "c",
      imageRepository: "x", imageTag: "y", imageId: null, imageDigest: null,
      containerName: "n", containerPort: 0, previousContainerName: null,
    });
    ok(c.ok === false, "cutover unexpectedly ok");
    ok(c.reason === NO_TRAFFIC_ROUTER_REASON, `wrong reason: ${c.reason}`);
    const v = await r.revert({
      environment: "test", intentKey: "k", releaseId: "r", commitSha: "c",
      imageRepository: "x", imageTag: "y", imageId: null, imageDigest: null,
      containerName: "n", containerPort: 0, previousContainerName: null,
    });
    ok(v.ok === false && v.reason === NO_TRAFFIC_ROUTER_REASON, "revert not blocked");
    rec("227B", "NoopTrafficRouter BLOCKED", "PASS", `reason=${NO_TRAFFIC_ROUTER_REASON}`);
  } catch (e) { rec("227B", "NoopTrafficRouter BLOCKED", "FAIL", String(e)); }

  // Helper: build a minimal intent input
  function intentInput(tag: string) {
    return {
      releaseId: rid("rel227-"),
      executionId: rid("exec227-"),
      attemptId: rid("att227-"),
      artifactId: "art227-" + tag,
      artifactDigest: "sha256:" + "a".repeat(64),
      commitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      environment: "phase227-test-" + tag,
      imageRepository: "nexus-app",
      imageTag: "version-a",
      imageId: null,
      imageDigest: "sha256:" + "b".repeat(64),
      containerName: "nexus-227-" + tag,
      containerPort: 8080,
    };
  }

  // 227C: activate() refuses when intent is not KNOWN_GOOD
  try {
    const inp = intentInput("C");
    const r = await intents.getOrCreateAsync(inp as any);
    const key = r.intent.intentKey;
    const act = await svc.deploymentActivationService.activate(key, rid("w227C-"));
    ok(act.status === "BLOCKED", `expected BLOCKED, got ${act.status}`);
    ok((act.reason ?? "").startsWith("INTENT_NOT_KNOWN_GOOD"), `reason=${act.reason}`);
    ok(act.cutover.attempted === false, "cutover should not be attempted");
    rec("227C", "activate refuses non-KNOWN_GOOD", "PASS", `reason=${act.reason}`);
  } catch (e) { rec("227C", "activate refuses non-KNOWN_GOOD", "FAIL", String(e)); }
  // 227D: activate() on a real KNOWN_GOOD intent walks to TRAFFIC_CUTOVER,
  // cutover returns BLOCKED, intent lands in ACTIVATION_FAILED with reason.
  try {
    const inp = intentInput("D");
    const r = await intents.getOrCreateAsync(inp as any);
    const key = r.intent.intentKey;
    const w = rid("w227D-");
    const leaseD = await intents.acquireLeaseAsync(key, w);
    if (!leaseD.acquired) throw new Error(`lease not acquired; holder=${leaseD.holder}`);
    const s0 = (await intents.getAsync(key))?.status;
    const tA = await intents.transitionIfOwnedAsync(key, "DEPLOYING" as any, w, {}, ["DEPLOYMENT_INTENT_CREATED"]);
    if (!tA.updated) throw new Error(`step DEPLOYING refused; status=${(await intents.getAsync(key))?.status} (was ${s0})`);
    const tB = await intents.transitionIfOwnedAsync(key, "HEALTH_CHECKING" as any, w, {}, ["DEPLOYING"]);
    if (!tB.updated) throw new Error(`step HEALTH_CHECKING refused; status=${(await intents.getAsync(key))?.status}`);
    const tC = await intents.transitionIfOwnedAsync(key, "SMOKE_TESTING" as any, w, {}, ["HEALTH_CHECKING"]);
    if (!tC.updated) throw new Error(`step SMOKE_TESTING refused; status=${(await intents.getAsync(key))?.status}`);
    const tD = await intents.transitionIfOwnedAsync(key, "KNOWN_GOOD" as any, w, {}, ["SMOKE_TESTING"]);
    if (!tD.updated) throw new Error(`step KNOWN_GOOD refused; status=${(await intents.getAsync(key))?.status}`);
    await intents.releaseLeaseAsync(key, w);
    const chkD = await intents.getAsync(key);
    if (chkD?.status !== "KNOWN_GOOD") throw new Error(`walk ended at ${chkD?.status}`);

    const act = await svc.deploymentActivationService.activate(key, rid("w227Dact-"));
    ok(act.status === "BLOCKED", `expected BLOCKED, got ${act.status}`);
    ok(act.cutover.attempted === true, `cutover not attempted; status=${act.status} reason=${act.reason}`);
    ok(act.cutover.ok === false, "cutover should have failed");
    ok(act.cutover.reason === NO_TRAFFIC_ROUTER_REASON, `cutover reason=${act.cutover.reason}`);
    const after = await intents.getAsync(key);
    ok(after?.status === "ACTIVATION_FAILED", `intent status=${after?.status}`);
    rec("227D", "real cutover attempt -> BLOCKED", "PASS",
        `intent=${after?.status} reason=${NO_TRAFFIC_ROUTER_REASON}`);
  } catch (e) { rec("227D", "real cutover attempt -> BLOCKED", "FAIL", String(e)); }

  // 227E: rollback refuses when intent is not ACTIVE
  try {
    const inp = intentInput("E");
    const r = await intents.getOrCreateAsync(inp as any);
    const rb = await svc.deploymentActivationService.rollback(r.intent.intentKey, rid("w227E-"));
    ok(rb.status === "BLOCKED", `expected BLOCKED, got ${rb.status}`);
    ok((rb.reason ?? "").startsWith("INTENT_NOT_ACTIVE"), `reason=${rb.reason}`);
    ok(rb.cutover.attempted === false, "revert should not be attempted");
    rec("227E", "rollback refuses non-ACTIVE", "PASS", `reason=${rb.reason}`);
  } catch (e) { rec("227E", "rollback refuses non-ACTIVE", "FAIL", String(e)); }

  // 227F: identity binding -- CutoverRequest carries real release/commit/image id
  try {
    // Use a spy router to capture the CutoverRequest that DeploymentActivationService sends
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
    const w = rid("w227F-");
    await intents.acquireLeaseAsync(key, w);
    await intents.transitionIfOwnedAsync(key, "DEPLOYING" as any, w, {}, ["DEPLOYMENT_INTENT_CREATED"]);
    await intents.transitionIfOwnedAsync(key, "HEALTH_CHECKING" as any, w, {}, ["DEPLOYING"]);
    await intents.transitionIfOwnedAsync(key, "SMOKE_TESTING" as any, w, {}, ["HEALTH_CHECKING"]);
    await intents.transitionIfOwnedAsync(key, "KNOWN_GOOD" as any, w, {}, ["SMOKE_TESTING"]);
    await intents.releaseLeaseAsync(key, w);

    await spySvc.activate(key, rid("w227Fact-"));
    if (captured.length !== 1) { throw new Error(`spy called ${captured.length} times; status=${(await intents.getAsync(key))?.status}`); }
    const req = captured[0];
    ok(req.releaseId === inp.releaseId, `releaseId: ${req.releaseId} != ${inp.releaseId}`);
    ok(req.commitSha === inp.commitSha, `commitSha mismatch`);
    ok(req.imageRepository === inp.imageRepository, `imageRepository mismatch`);
    ok(req.imageTag === inp.imageTag, `imageTag mismatch`);
    ok(req.environment === inp.environment, `environment mismatch`);
    ok(req.containerName === inp.containerName, `containerName mismatch`);
    rec("227F", "identity binding", "PASS",
        `releaseId+commitSha+image+env+container threaded through CutoverRequest`);
  } catch (e) { rec("227F", "identity binding", "FAIL", String(e)); }

  // 227G: lease fencing -- second activation during first is refused
  try {
    const inp = intentInput("G");
    const r = await intents.getOrCreateAsync(inp as any);
    const key = r.intent.intentKey;
    const w1 = rid("w227G1-");
    await intents.acquireLeaseAsync(key, w1);
    await intents.transitionIfOwnedAsync(key, "DEPLOYING" as any, w1, {}, ["DEPLOYMENT_INTENT_CREATED"]);
    await intents.transitionIfOwnedAsync(key, "HEALTH_CHECKING" as any, w1, {}, ["DEPLOYING"]);
    await intents.transitionIfOwnedAsync(key, "SMOKE_TESTING" as any, w1, {}, ["HEALTH_CHECKING"]);
    await intents.transitionIfOwnedAsync(key, "KNOWN_GOOD" as any, w1, {}, ["SMOKE_TESTING"]);
    // Now hold the lease with w1 and try to activate with a different worker
    const act = await svc.deploymentActivationService.activate(key, rid("w227G2-"));
    ok(act.status === "BLOCKED", `expected BLOCKED, got ${act.status}`);
    ok((act.reason ?? "").startsWith("ACTIVATION_LEASE_HELD"), `reason=${act.reason}`);
    rec("227G", "lease fencing", "PASS", `reason=${act.reason}`);
    await intents.releaseLeaseAsync(key, w1);
  } catch (e) { rec("227G", "lease fencing", "FAIL", String(e)); }

  // 227H: Phase 225 wiring intact
  try {
    ok(!!svc.releaseDeploymentExecutor, "releaseDeploymentExecutor missing");
    ok(!!svc.releaseExecutionGate, "releaseExecutionGate missing");
    ok(!!svc.deployments, "deployments missing");
    rec("227H", "Phase 225 wiring intact", "PASS", "executor+gate+deployments exposed");
  } catch (e) { rec("227H", "Phase 225 wiring intact", "FAIL", String(e)); }

  // 227I: Phase 226 wiring intact
  try {
    ok(!!svc.releaseIntents, "releaseIntents missing");
    const r = await intents.getOrCreateAsync(intentInput("I") as any);
    ok(!!r.intent.intentKey, "getOrCreateAsync did not return a key");
    rec("227I", "Phase 226 wiring intact", "PASS", `intents work key=${r.intent.intentKey.slice(0,20)}...`);
  } catch (e) { rec("227I", "Phase 226 wiring intact", "FAIL", String(e)); }

  // 227J: real Docker deployment through canonical orchestrator -> KNOWN_GOOD
  try {
    const imageId = execSync("docker inspect nexus-app:version-a --format {{.Id}}", {
      encoding: "utf8", timeout: 10_000,
    }).trim();
    const containerName = rid("nexus-227J-");
    const out = await svc.deployments.deploy({
      project_id: "phase227-proj",
      environment: "phase227-" + Date.now().toString(36),
      release_id: "rel227-J",
      image_repository: "nexus-app",
      image_tag: "version-a",
      image_id: imageId,
      image_digest: null,
      container_name: containerName,
      container_port: 8080,
      attempt_id: rid("att227J-"),
    });
    const status = out?.deployment?.status;
    if (status === "KNOWN_GOOD" || status === "SUCCEEDED") {
      rec("227J", "real deployment through NEXUS", "PASS",
          `container=${out?.deployment?.container_id?.slice(0,12) ?? "?"} status=${status}`);
    } else {
      rec("227J", "real deployment through NEXUS", "FAIL",
          `status=${status} reason=${out?.deployment?.failure_reason ?? "?"}`);
    }
    try { execSync(`docker rm -f ${containerName}`, { stdio: "ignore", timeout: 10_000 }); } catch {}
  } catch (e) { rec("227J", "real deployment through NEXUS", "FAIL", String(e).slice(0, 120)); }

  finish();
}

function finish() {
  console.log("");
  console.log("===== Phase 227 summary =====");
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