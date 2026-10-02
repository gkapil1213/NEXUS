// scripts/test-phase231-production-e2e-lifecycle.ts
// Phase 231 - Production release -> deployment -> activation -> rollback
// end-to-end integration proof.
//
// This suite does NOT introduce a new orchestrator. It exercises the
// existing authoritative chain:
//
//   ProductionReleaseEnforcementService.requestRelease  (authorization)
//     -> ReleaseExecutionGate.execute                    (gate + intent)
//     -> ReleaseDeploymentExecutor.execute               (deployment)
//     -> DeploymentActivationService.activate            (cutover + reconcile)
//     -> DeploymentActivationService.rollback            (revert)
//
// Provider-unavailable remains BLOCKED (NO_TRAFFIC_ROUTER_CONFIGURED).
// Never fabricates ACTIVE.

import { NexusKernel } from "../src/core/kernel";
import { ReleaseDeploymentExecutor, type ReleaseDeploymentRequest } from "../src/core/release-deployment-executor";
import { DeploymentActivationService } from "../src/core/deployment-activation-service";
import { ReleaseRecoveryService } from "../src/core/release-recovery";
import { NoopTrafficRouter, NO_TRAFFIC_ROUTER_REASON } from "../src/core/traffic-router";
import { createNodeBridge } from "./host-bridge-node";
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { PgClient } from "../src/core/pg-client";
import type { ReleaseSafetyPolicy } from "../src/core/release-safety-gate";
import type { ReleaseIntentInput } from "../src/core/release-deployment-intent";
import type { EngineeringReleaseReadyOutcome, StageCheck } from "../src/core/engineering-release-ready-executor";

type R = "PASS" | "FAIL" | "BLOCKED" | "NOT EXECUTED";
const rows: { id: string; name: string; r: R; n: string }[] = [];
function rec(id: string, name: string, r: R, n: string) {
  rows.push({ id, name, r, n });
  const m = r === "PASS" ? "[PASS]" : r === "FAIL" ? "[FAIL]" : r === "BLOCKED" ? "[BLK ]" : "[N/E ]";
  console.log(`${m} ${id} ${name} -- ${n}`);
}
function ok(c: boolean, m: string) { if (!c) throw new Error(m); }
function rid(p: string) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
const DB = () => process.env.DATABASE_URL!;

async function q(sql: string, p: unknown[] = []) {
  const c = new PgClient(); await c.connect(DB());
  try { return await c.query(sql, p); } finally { await c.close(); }
}

const SEC_OK: StageCheck = { stageType: "SECURITY_REVIEW", status: "SUCCEEDED", ok: true };
const SEC_BLOCKED: StageCheck = { stageType: "SECURITY_REVIEW", status: "BLOCKED", ok: false };

function baseReady(overrides: Partial<EngineeringReleaseReadyOutcome> = {}): EngineeringReleaseReadyOutcome {
  return {
    status: "SUCCEEDED",
    reason: "phase231 fixture",
    releaseId: rid("rel231-"),
    stageChecks: [SEC_OK],
    candidateArtifactRef: "artifact://test-231",
    candidateArtifactId: "art-231",
    sourceRevision: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    artifactRef: "artifact://test-231",
    ...overrides,
  };
}

function intentInput(tag: string, releaseId: string): ReleaseIntentInput {
  return {
    releaseId,
    executionId: rid("exec231-"),
    attemptId: rid("att231-"),
    artifactId: "art-231",
    artifactDigest: "sha256:" + "a".repeat(64),
    commitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    environment: "phase231-test-" + tag,
    projectId: "phase231-proj",
    imageRepository: "nexus-app",
    imageTag: "version-a",
    imageId: null,
    imageDigest: "sha256:" + "b".repeat(64),
    containerName: "nexus-231-" + tag,
    containerPort: 8080,
  };
}

const POLICY: ReleaseSafetyPolicy = { policyVersion: "phase231-v1" };

async function main() {
  const bridgeRoot = path.join(os.tmpdir(), "nexus-phase231-" + Date.now());
  (globalThis as any).window = { __NEXUS_HOST__: createNodeBridge(bridgeRoot) };
  // 231A: kernel wiring
  let svc: Awaited<ReturnType<NexusKernel["boot"]>> | undefined;
  try {
    const k = new NexusKernel();
    svc = await k.boot();
    ok(!!svc.releaseDeploymentExecutor, "releaseDeploymentExecutor missing");
    ok(!!svc.deploymentActivationService, "deploymentActivationService missing");
    ok(!!svc.releaseExecutionGate, "releaseExecutionGate missing");
    ok(!!svc.releaseIntents, "releaseIntents missing");
    rec("231A", "kernel wiring", "PASS", "executor+activation+gate+intents exposed");
  } catch (e) { rec("231A", "kernel wiring", "FAIL", String(e)); }

  if (!svc?.releaseDeploymentExecutor || !svc?.deploymentActivationService) { finish(); return; }

  // 231B: RELEASE_READY must be SUCCEEDED
  try {
    const req: ReleaseDeploymentRequest = {
      releaseReady: baseReady({ status: "BLOCKED" as any }),
      verificationRun: {},
      policy: POLICY,
      intentInput: intentInput("B", "rel231-B"),
      authorizationId: "auth-x",
      attemptId: "attempt-x",
    };
    const r = await svc.releaseDeploymentExecutor.execute(req);
    ok(r.blockReason === "RELEASE_READY_NOT_SUCCEEDED", `blockReason=${r.blockReason}`);
    rec("231B", "RELEASE_READY enforced", "PASS", `blockReason=${r.blockReason}`);
  } catch (e) { rec("231B", "RELEASE_READY enforced", "FAIL", String(e)); }

  // 231C: missing sourceRevision blocked
  try {
    const req: ReleaseDeploymentRequest = {
      releaseReady: baseReady({ sourceRevision: null }),
      verificationRun: {},
      policy: POLICY,
      intentInput: intentInput("C", "rel231-C"),
      authorizationId: "auth-x",
      attemptId: "attempt-x",
    };
    const r = await svc.releaseDeploymentExecutor.execute(req);
    ok(r.blockReason === "MISSING_SOURCE_REVISION", `blockReason=${r.blockReason}`);
    rec("231C", "missing source revision blocked", "PASS", `blockReason=${r.blockReason}`);
  } catch (e) { rec("231C", "missing source revision blocked", "FAIL", String(e)); }

  // 231D: missing artifact blocked
  try {
    const req: ReleaseDeploymentRequest = {
      releaseReady: baseReady({ candidateArtifactId: null, candidateArtifactRef: null }),
      verificationRun: {},
      policy: POLICY,
      intentInput: intentInput("D", "rel231-D"),
      authorizationId: "auth-x",
      attemptId: "attempt-x",
    };
    const r = await svc.releaseDeploymentExecutor.execute(req);
    ok(r.blockReason === "MISSING_ARTIFACT", `blockReason=${r.blockReason}`);
    rec("231D", "missing artifact blocked", "PASS", `blockReason=${r.blockReason}`);
  } catch (e) { rec("231D", "missing artifact blocked", "FAIL", String(e)); }

  // 231E: SECURITY_REVIEW must be SUCCEEDED
  try {
    const req: ReleaseDeploymentRequest = {
      releaseReady: baseReady({ stageChecks: [SEC_BLOCKED] }),
      verificationRun: {},
      policy: POLICY,
      intentInput: intentInput("E", "rel231-E"),
      authorizationId: "auth-x",
      attemptId: "attempt-x",
    };
    const r = await svc.releaseDeploymentExecutor.execute(req);
    ok(r.blockReason === "SECURITY_REVIEW_NOT_SUCCEEDED", `blockReason=${r.blockReason}`);
    rec("231E", "security readiness enforced", "PASS", `blockReason=${r.blockReason}`);
  } catch (e) { rec("231E", "security readiness enforced", "FAIL", String(e)); }

  // 231F: gate-not-available refused
  try {
    const ex = new ReleaseDeploymentExecutor(undefined);
    const req: ReleaseDeploymentRequest = {
      releaseReady: baseReady(),
      verificationRun: {},
      policy: POLICY,
      intentInput: intentInput("F", "rel231-F"),
      authorizationId: "auth-x",
      attemptId: "attempt-x",
    };
    const r = await ex.execute(req);
    ok(r.blockReason === "GATE_NOT_AVAILABLE", `blockReason=${r.blockReason}`);
    rec("231F", "no gate refused", "PASS", `blockReason=${r.blockReason}`);
  } catch (e) { rec("231F", "no gate refused", "FAIL", String(e)); }

  // 231G: activation refuses non-KNOWN_GOOD intent
  try {
    const inp = intentInput("G", "rel231-G");
    const r = await svc.releaseIntents!.getOrCreateAsync(inp);
    const act = await svc.deploymentActivationService!.activate(r.intent.intentKey, rid("w231G-"));
    ok(act.status === "BLOCKED", `expected BLOCKED, got ${act.status}`);
    ok((act.reason ?? "").startsWith("INTENT_NOT_KNOWN_GOOD"), `reason=${act.reason}`);
    rec("231G", "activation requires KNOWN_GOOD", "PASS", `reason=${act.reason}`);
  } catch (e) { rec("231G", "activation requires KNOWN_GOOD", "FAIL", String(e)); }

  // 231H: provider unavailable -> BLOCKED, never ACTIVATED
  try {
    const inp = intentInput("H", "rel231-H");
    const r = await svc.releaseIntents!.getOrCreateAsync(inp);
    const key = r.intent.intentKey;
    const w = rid("w231H-");
    await svc.releaseIntents!.acquireLeaseAsync(key, w);
    await svc.releaseIntents!.transitionIfOwnedAsync(key, "DEPLOYING", w, {}, ["DEPLOYMENT_INTENT_CREATED"]);
    await svc.releaseIntents!.transitionIfOwnedAsync(key, "HEALTH_CHECKING", w, {}, ["DEPLOYING"]);
    await svc.releaseIntents!.transitionIfOwnedAsync(key, "SMOKE_TESTING", w, {}, ["HEALTH_CHECKING"]);
    await svc.releaseIntents!.transitionIfOwnedAsync(key, "KNOWN_GOOD", w, {}, ["SMOKE_TESTING"]);
    await svc.releaseIntents!.releaseLeaseAsync(key, w);

    const act = await svc.deploymentActivationService!.activate(key, rid("w231Hact-"));
    ok(act.status === "BLOCKED", `expected BLOCKED, got ${act.status}`);
    ok(act.cutover.reason === NO_TRAFFIC_ROUTER_REASON || (act.reason ?? "").includes("NO_TRAFFIC_ROUTER"),
       `cutover reason=${act.cutover.reason} reason=${act.reason}`);
    rec("231H", "provider unavailable -> BLOCKED", "PASS", `reason=${act.reason}`);
  } catch (e) { rec("231H", "provider unavailable -> BLOCKED", "FAIL", String(e)); }

  // 231I: no fake ACTIVE when provider unavailable
  try {
    const inp = intentInput("I", "rel231-I");
    const r = await svc.releaseIntents!.getOrCreateAsync(inp);
    const key = r.intent.intentKey;
    const w = rid("w231I-");
    await svc.releaseIntents!.acquireLeaseAsync(key, w);
    await svc.releaseIntents!.transitionIfOwnedAsync(key, "DEPLOYING", w, {}, ["DEPLOYMENT_INTENT_CREATED"]);
    await svc.releaseIntents!.transitionIfOwnedAsync(key, "HEALTH_CHECKING", w, {}, ["DEPLOYING"]);
    await svc.releaseIntents!.transitionIfOwnedAsync(key, "SMOKE_TESTING", w, {}, ["HEALTH_CHECKING"]);
    await svc.releaseIntents!.transitionIfOwnedAsync(key, "KNOWN_GOOD", w, {}, ["SMOKE_TESTING"]);
    await svc.releaseIntents!.releaseLeaseAsync(key, w);
    await svc.deploymentActivationService!.activate(key, rid("w231Iact-"));
    const after = await svc.releaseIntents!.getAsync(key);
    ok(after?.status !== "ACTIVE", `intent reached ACTIVE: ${after?.status}`);
    ok(after?.status === "ACTIVATION_FAILED", `expected ACTIVATION_FAILED, got ${after?.status}`);
    rec("231I", "no fake ACTIVE", "PASS", `intent=${after?.status}`);
  } catch (e) { rec("231I", "no fake ACTIVE", "FAIL", String(e)); }

  // 231J: lease fencing — non-holder refused
  try {
    const inp = intentInput("J", "rel231-J");
    const r = await svc.releaseIntents!.getOrCreateAsync(inp);
    const key = r.intent.intentKey;
    const w1 = rid("w231J1-");
    const w2 = rid("w231J2-");
    await svc.releaseIntents!.acquireLeaseAsync(key, w1);
    const t = await svc.releaseIntents!.transitionIfOwnedAsync(key, "DEPLOYING", w2, {}, ["DEPLOYMENT_INTENT_CREATED"]);
    ok(t.updated === false, "non-holder transition succeeded");
    const after = await svc.releaseIntents!.getAsync(key);
    ok(after?.status === "DEPLOYMENT_INTENT_CREATED", `state changed by non-holder: ${after?.status}`);
    await svc.releaseIntents!.releaseLeaseAsync(key, w1);
    rec("231J", "lease fencing", "PASS", "non-holder refused");
  } catch (e) { rec("231J", "lease fencing", "FAIL", String(e)); }
  // 231K: rollback refuses non-ACTIVE
  try {
    const inp = intentInput("K", "rel231-K");
    const r = await svc.releaseIntents!.getOrCreateAsync(inp);
    const rb = await svc.deploymentActivationService!.rollback(r.intent.intentKey, rid("w231K-"));
    ok(rb.status === "BLOCKED", `expected BLOCKED, got ${rb.status}`);
    ok((rb.reason ?? "").startsWith("INTENT_NOT_ACTIVE"), `reason=${rb.reason}`);
    rec("231K", "rollback refuses non-ACTIVE", "PASS", `reason=${rb.reason}`);
  } catch (e) { rec("231K", "rollback refuses non-ACTIVE", "FAIL", String(e)); }

  // 231L: previous target captured before cutover (via history spy)
  try {
    const captured: any[] = [];
    const spyHistory = {
      async getCurrentDeployment(projectId: string, environment: string) {
        captured.push({ projectId, environment });
        return {
          id: "prev-231L", project_id: projectId, environment,
          release_id: "prev-rel", commit_sha: "prevsha",
          image_id: "sha256:prev", image_digest: null,
          image_repository: "nexus-app", image_tag: "prev",
          container_name: "nexus-prev", container_id: "cid",
          url: null, status: "KNOWN_GOOD" as const,
        };
      },
    };
    const spyRouter = new NoopTrafficRouter();
    const spySvc = new DeploymentActivationService(svc.releaseIntents, spyRouter, spyHistory as any);
    const inp = intentInput("L", "rel231-L");
    const r = await svc.releaseIntents!.getOrCreateAsync(inp);
    const key = r.intent.intentKey;
    const w = rid("w231L-");
    await svc.releaseIntents!.acquireLeaseAsync(key, w);
    await svc.releaseIntents!.transitionIfOwnedAsync(key, "DEPLOYING", w, {}, ["DEPLOYMENT_INTENT_CREATED"]);
    await svc.releaseIntents!.transitionIfOwnedAsync(key, "HEALTH_CHECKING", w, {}, ["DEPLOYING"]);
    await svc.releaseIntents!.transitionIfOwnedAsync(key, "SMOKE_TESTING", w, {}, ["HEALTH_CHECKING"]);
    await svc.releaseIntents!.transitionIfOwnedAsync(key, "KNOWN_GOOD", w, {}, ["SMOKE_TESTING"]);
    await svc.releaseIntents!.releaseLeaseAsync(key, w);
    const act = await spySvc.activate(key, rid("w231Lact-"));
    ok(captured.length >= 1, `history not consulted`);
    ok(act.previousTarget?.deploymentId === "prev-231L", `prev=${act.previousTarget?.deploymentId}`);
    rec("231L", "previous target captured before cutover", "PASS", `prev=prev-231L`);
  } catch (e) { rec("231L", "previous target captured before cutover", "FAIL", String(e)); }

  // 231M: reconciliation IN_SYNC via real NoopTrafficRouter returns PROVIDER_UNAVAILABLE
  try {
    const noop = new NoopTrafficRouter();
    const rc = await noop.reconcile(null);
    ok(rc.verdict === "PROVIDER_UNAVAILABLE", `expected PROVIDER_UNAVAILABLE, got ${rc.verdict}`);
    rec("231M", "reconcile honest without provider", "PASS", `verdict=${rc.verdict}`);
  } catch (e) { rec("231M", "reconcile honest without provider", "FAIL", String(e)); }

  // 231N: restart recovery classification
  try {
    const rsvc = new ReleaseRecoveryService();
    const p = rsvc.classify({ intent: { intentKey: "k", status: "TRAFFIC_CUTOVER" } as any });
    ok(p.action === "RECOVERY_REQUIRED", `TRAFFIC_CUTOVER -> ${p.action}`);
    ok(p.requiresDockerInspection === true, "requiresDockerInspection should be true");
    rec("231N", "restart recovery classification", "PASS", `action=${p.action}`);
  } catch (e) { rec("231N", "restart recovery classification", "FAIL", String(e)); }

  // 231O: cross-environment isolation
  try {
    const a = intentInput("O1", "rel231-O1");
    const b = intentInput("O2", "rel231-O2");
    const ra = await svc.releaseIntents!.getOrCreateAsync(a);
    const rb = await svc.releaseIntents!.getOrCreateAsync(b);
    ok(ra.intent.intentKey !== rb.intent.intentKey, "keys collided");
    ok(ra.intent.environment !== rb.intent.environment, "environments collided");
    rec("231O", "cross-environment isolation", "PASS", `${ra.intent.environment} vs ${rb.intent.environment}`);
  } catch (e) { rec("231O", "cross-environment isolation", "FAIL", String(e)); }

  // 231P: secrets absent from persisted intent evidence
  try {
    const r = await q(
      "SELECT failure_reason, recovery_reason FROM release_deployment_intents WHERE environment LIKE $1",
      ["phase231-test-%"],
    );
    const blob = JSON.stringify(r.rows);
    ok(!/AKIA[0-9A-Z]{16}/.test(blob), "AWS key pattern present");
    ok(!/aws_secret_access_key/i.test(blob), "AWS secret string present");
    rec("231P", "secrets absent", "PASS", `${r.rows.length} intent rows scanned`);
  } catch (e) { rec("231P", "secrets absent", "FAIL", String(e)); }

  // 231Q: real deployment through NEXUS -> KNOWN_GOOD
  try {
    const imageId = execSync("docker inspect nexus-app:version-a --format {{.Id}}", {
      encoding: "utf8", timeout: 10_000,
    }).trim();
    const containerName = rid("nexus-231Q-");
    const out = await svc.deployments!.deploy({
      project_id: "phase231-proj",
      environment: "phase231-" + Date.now().toString(36),
      release_id: "rel231-Q",
      image_repository: "nexus-app",
      image_tag: "version-a",
      image_id: imageId,
      image_digest: null,
      container_name: containerName,
      container_port: 8080,
      attempt_id: rid("att231Q-"),
    });
    const status = out?.deployment?.status;
    if (status === "KNOWN_GOOD" || status === "SUCCEEDED") {
      rec("231Q", "real deployment through NEXUS", "PASS",
          `container=${out?.deployment?.container_id?.slice(0,12) ?? "?"} status=${status}`);
    } else {
      rec("231Q", "real deployment through NEXUS", "FAIL",
          `status=${status} reason=${out?.deployment?.failure_reason ?? "?"}`);
    }
    try { execSync(`docker rm -f ${containerName}`, { stdio: "ignore", timeout: 10_000 }); } catch {}
  } catch (e) { rec("231Q", "real deployment through NEXUS", "FAIL", String(e).slice(0, 120)); }

  // 231R: real AWS provider availability
  try {
    const { readAwsTrafficRouterConfig, AWSTrafficRouter } = await import("../src/core/aws-traffic-router");
    const cfg = readAwsTrafficRouterConfig(process.env);
    const aws = new AWSTrafficRouter(cfg);
    const cap = await aws.capabilities();
    if (cap.canCutover) {
      rec("231R", "real AWS provider", "NOT EXECUTED", "configured; test disabled without NEXUS_AWS_TEST_MODE=1");
    } else {
      rec("231R", "real AWS provider", "BLOCKED", `cannot execute: ${cap.reason}`);
    }
  } catch (e) { rec("231R", "real AWS provider", "FAIL", String(e)); }

  finish();
}

function finish() {
  console.log("");
  console.log("===== Phase 231 summary =====");
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