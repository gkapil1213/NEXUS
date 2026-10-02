// scripts/test-phase229-aws-production-traffic-integration.ts
// Phase 229 - real AWS production traffic integration.
//
// Honest verification: this environment has the AWS CLI but no credentials
// and no region. Every test that reaches a real AWS mutation is expected to
// report BLOCKED with the specific missing capability. Tests that verify
// the framework (interface, factory, classifier, lease, previous-target
// capture, secret redaction) report PASS.
//
// Never fabricate AWS success. Never translate BLOCKED into PASS.

import { NexusKernel } from "../src/core/kernel";
import { AWSTrafficRouter, readAwsTrafficRouterConfig } from "../src/core/aws-traffic-router";
import { discoverTrafficRouter } from "../src/core/traffic-router-factory";
import { NoopTrafficRouter, NO_TRAFFIC_ROUTER_REASON } from "../src/core/traffic-router";
import { ReleaseRecoveryService } from "../src/core/release-recovery";
import { createNodeBridge } from "./host-bridge-node";
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { PgClient } from "../src/core/pg-client";

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

function intentInput(tag: string) {
  return {
    releaseId: rid("rel229-"),
    executionId: rid("exec229-"),
    attemptId: rid("att229-"),
    artifactId: "art229-" + tag,
    artifactDigest: "sha256:" + "a".repeat(64),
    commitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    environment: "phase229-test-" + tag,
    projectId: "phase229-proj",
    imageRepository: "nexus-app",
    imageTag: "version-a",
    imageId: null,
    imageDigest: "sha256:" + "b".repeat(64),
    containerName: "nexus-229-" + tag,
    containerPort: 8080,
  };
}

async function walkToKnownGood(intents: any, key: string, worker: string) {
  await intents.acquireLeaseAsync(key, worker);
  await intents.transitionIfOwnedAsync(key, "DEPLOYING", worker, {}, ["DEPLOYMENT_INTENT_CREATED"]);
  await intents.transitionIfOwnedAsync(key, "HEALTH_CHECKING", worker, {}, ["DEPLOYING"]);
  await intents.transitionIfOwnedAsync(key, "SMOKE_TESTING", worker, {}, ["HEALTH_CHECKING"]);
  await intents.transitionIfOwnedAsync(key, "KNOWN_GOOD", worker, {}, ["SMOKE_TESTING"]);
  await intents.releaseLeaseAsync(key, worker);
}

async function main() {
  const bridgeRoot = path.join(os.tmpdir(), "nexus-phase229-" + Date.now());
  const nodeBridge = createNodeBridge(bridgeRoot);
  (globalThis as any).window = { __NEXUS_HOST__: nodeBridge };

  // 229A: kernel wiring
  let svc: Awaited<ReturnType<NexusKernel["boot"]>> | undefined;
  try {
    const k = new NexusKernel();
    svc = await k.boot();
    ok(!!svc.deploymentActivationService, "deploymentActivationService missing");
    rec("229A", "kernel wiring", "PASS", `activation=${typeof svc.deploymentActivationService}`);
  } catch (e) { rec("229A", "kernel wiring", "FAIL", String(e)); }
  if (!svc?.releaseIntents || !svc?.deploymentActivationService) { finish(); return; }
  const intents = svc.releaseIntents;

  // 229B: provider discovery returns honest kind
  try {
    const d = await discoverTrafficRouter();
    // Phase 230 factory shape: kind is one of aws-selected / aws-selected-blocked / noop-no-config
    const validKinds = ["aws-selected", "aws-selected-blocked", "noop-no-config"];
    ok(validKinds.includes(d.kind), `unexpected kind=${d.kind}`);
    ok(d.routerKind === "noop" || d.routerKind === "load-balancer", `unexpected routerKind=${d.routerKind}`);
    rec("229B", "provider discovery", "PASS",
        `kind=${d.kind} routerKind=${d.routerKind} reason=${(d.reason ?? "").slice(0, 60)}`);
  } catch (e) { rec("229B", "provider discovery", "FAIL", String(e)); }

  // 229C: no traffic router -> cutover BLOCKED
  try {
    const r = new NoopTrafficRouter();
    const out = await r.cutover({
      environment: "t", intentKey: "k", releaseId: "r", commitSha: "c",
      imageRepository: "x", imageTag: "y", imageId: null, imageDigest: null,
      containerName: "n", containerPort: 0, previousContainerName: null,
    });
    ok(out.ok === false, "Noop cutover must be BLOCKED");
    ok(out.reason === NO_TRAFFIC_ROUTER_REASON, `reason=${out.reason}`);
    rec("229C", "no router -> BLOCKED", "PASS", `reason=${NO_TRAFFIC_ROUTER_REASON}`);
  } catch (e) { rec("229C", "no router -> BLOCKED", "FAIL", String(e)); }

  // 229D: AWS CLI present
  try {
    const r = execSync("where.exe aws", { encoding: "utf8", timeout: 5_000 }).trim();
    ok(!!r, "aws CLI not on PATH");
    rec("229D", "AWS CLI discovered", "PASS", r.split("\n")[0].trim());
  } catch (e) {
    rec("229D", "AWS CLI discovered", "BLOCKED", String(e).slice(0, 120));
  }

  // 229E: AWS credentials status classified as BLOCKED
  try {
    let stderr = "";
    try {
      execSync("aws sts get-caller-identity", { encoding: "utf8", stdio: "pipe", timeout: 10_000 });
      rec("229E", "AWS credentials", "PASS", "credentials configured");
    } catch (e: any) {
      stderr = String(e.stderr ?? e.stdout ?? e.message ?? "");
      const isNoCred = /NoCredentials|Unable to locate credentials/i.test(stderr);
      ok(isNoCred, `unexpected AWS error: ${stderr.slice(0, 120)}`);
      rec("229E", "AWS credentials", "BLOCKED", "AWS_CREDENTIALS_NOT_CONFIGURED");
    }
  } catch (e) { rec("229E", "AWS credentials", "FAIL", String(e)); }

  // 229F: AWSTrafficRouter.capabilities() returns honest report
  try {
    const cfg = readAwsTrafficRouterConfig(process.env);
    const aws = new AWSTrafficRouter(cfg);
    const cap = await aws.capabilities();
    ok(cap.canCutover === false, `expected canCutover=false, got ${cap.canCutover}`);
    ok(!!cap.reason, "capabilities must include a reason when disabled");
    rec("229F", "AWS capabilities honest", "PASS",
        `canCutover=false reason=${(cap.reason ?? "").slice(0, 60)}`);
  } catch (e) { rec("229F", "AWS capabilities honest", "FAIL", String(e)); }
  // 229G: active-target discovery yields null when unconfigured
  try {
    const noop = new NoopTrafficRouter();
    const a1 = await noop.resolveActive("phase229");
    ok(a1 === null, "Noop.resolveActive must be null");
    const cfg = readAwsTrafficRouterConfig(process.env);
    const aws = new AWSTrafficRouter(cfg);
    const a2 = await aws.resolveActive("phase229");
    ok(a2 === null, "AWS.resolveActive must be null when unconfigured");
    rec("229G", "active-target discovery", "PASS", "both routers return null when unconfigured");
  } catch (e) { rec("229G", "active-target discovery", "FAIL", String(e)); }

  // 229H: candidate validation refuses when unconfigured
  try {
    const noop = new NoopTrafficRouter();
    const v = await noop.validateTarget({
      environment: "t", provider: "noop", providerTargetId: "x",
      endpoint: null, releaseId: null, deploymentId: null, commitSha: null,
      imageRepository: null, imageTag: null, imageId: null, imageDigest: null,
      containerId: null, containerName: null, containerPort: null, observedAt: 0,
    });
    ok(v.valid === false, "Noop.validateTarget must be invalid");
    rec("229H", "candidate validation", "PASS", `valid=false reason=${NO_TRAFFIC_ROUTER_REASON}`);
  } catch (e) { rec("229H", "candidate validation", "FAIL", String(e)); }

  // 229I: previous-target persistence via history spy
  try {
    const { DeploymentActivationService } = await import("../src/core/deployment-activation-service");
    const captured: any[] = [];
    const spyHistory = {
      async getCurrentDeployment(projectId: string, environment: string) {
        captured.push({ projectId, environment });
        return {
          id: "prev-229I", project_id: projectId, environment,
          release_id: "prev-rel", commit_sha: "prevsha",
          image_id: "sha256:prev", image_digest: null,
          image_repository: "nexus-app", image_tag: "prev",
          container_name: "nexus-prev", container_id: "cid",
          url: "http://127.0.0.1:8081", status: "KNOWN_GOOD" as const,
        };
      },
    };
    const spyRouter = {
      kind: "noop" as const,
      cutover: async () => ({ ok: false, reason: NO_TRAFFIC_ROUTER_REASON, activeTarget: null }),
      revert: async () => ({ ok: false, reason: NO_TRAFFIC_ROUTER_REASON, activeTarget: null }),
      resolveActive: async () => null,
      resolveTarget: async () => null,
      validateTarget: async () => ({ valid: false, reason: NO_TRAFFIC_ROUTER_REASON }),
      health: async () => ({ verdict: "BLOCKED" as const, targetId: null, reason: NO_TRAFFIC_ROUTER_REASON, probedAt: Date.now() }),
      reconcile: async () => ({ verdict: "PROVIDER_UNAVAILABLE" as const, reason: NO_TRAFFIC_ROUTER_REASON, desiredTargetId: null, observedTargetId: null, reconciledAt: Date.now() }),
      capabilities: async () => ({ kind: "noop" as const, canResolveActive: false, canResolveTarget: false, canValidateTarget: false, canCutover: false, canRevert: false, canHealthCheck: false, canReconcile: false, reason: NO_TRAFFIC_ROUTER_REASON, probedAt: Date.now() }),
    };
    const spySvc = new DeploymentActivationService(svc.releaseIntents, spyRouter as any, spyHistory as any);
    const inp = intentInput("I");
    const r = await intents.getOrCreateAsync(inp as any);
    await walkToKnownGood(intents, r.intent.intentKey, rid("w229I-"));
    const act = await spySvc.activate(r.intent.intentKey, rid("w229Iact-"));
    ok(captured.length >= 1, `history not consulted: ${captured.length}`);
    ok(act.previousTarget?.deploymentId === "prev-229I", `prev=${act.previousTarget?.deploymentId}`);
    rec("229I", "previous-target persisted", "PASS", `prev=prev-229I`);
  } catch (e) { rec("229I", "previous-target persisted", "FAIL", String(e)); }

  // 229J: cutover without config -> BLOCKED -> ACTIVATION_FAILED
  try {
    const inp = intentInput("J");
    const r = await intents.getOrCreateAsync(inp as any);
    await walkToKnownGood(intents, r.intent.intentKey, rid("w229J-"));
    const act = await svc.deploymentActivationService.activate(r.intent.intentKey, rid("w229Jact-"));
    ok(act.status === "BLOCKED", `expected BLOCKED, got ${act.status}`);
    const after = await intents.getAsync(r.intent.intentKey);
    ok(after?.status === "ACTIVATION_FAILED", `intent status=${after?.status}`);
    rec("229J", "cutover BLOCKED -> ACTIVATION_FAILED", "PASS",
        `intent=ACTIVATION_FAILED reason=${(act.reason ?? "").slice(0, 40)}`);
  } catch (e) { rec("229J", "cutover BLOCKED -> ACTIVATION_FAILED", "FAIL", String(e)); }

  // 229K: reconciliation honest when unconfigured
  try {
    const noop = new NoopTrafficRouter();
    const rc = await noop.reconcile(null);
    ok(rc.verdict === "PROVIDER_UNAVAILABLE", `Noop verdict=${rc.verdict}`);
    const cfg = readAwsTrafficRouterConfig(process.env);
    const aws = new AWSTrafficRouter(cfg);
    const ra = await aws.reconcile(null);
    ok(ra.verdict === "PROVIDER_UNAVAILABLE" || ra.verdict === "AUTHENTICATION_BLOCKED" || ra.verdict === "TARGET_MISSING",
       `AWS verdict=${ra.verdict}`);
    rec("229K", "reconciliation classification", "PASS",
        `noop=${rc.verdict} aws=${ra.verdict}`);
  } catch (e) { rec("229K", "reconciliation classification", "FAIL", String(e)); }

  // 229L: ACTIVE cannot be reached without provider confirmation
  try {
    const inp = intentInput("L");
    const r = await intents.getOrCreateAsync(inp as any);
    await walkToKnownGood(intents, r.intent.intentKey, rid("w229L-"));
    const act = await svc.deploymentActivationService.activate(r.intent.intentKey, rid("w229Lact-"));
    ok(act.status !== "ACTIVATED", `expected not ACTIVATED, got ${act.status}`);
    const after = await intents.getAsync(r.intent.intentKey);
    ok(after?.status !== "ACTIVE", `intent reached ACTIVE without provider: ${after?.status}`);
    rec("229L", "no fake ACTIVE without provider", "PASS",
        `intent=${after?.status} act=${act.status}`);
  } catch (e) { rec("229L", "no fake ACTIVE without provider", "FAIL", String(e)); }

  // 229M: drift detection classifies honestly
  try {
    const noop = new NoopTrafficRouter();
    const rc = await noop.reconcile({
      environment: "t", provider: "noop", providerTargetId: "desired-1",
      endpoint: null, releaseId: null, deploymentId: null, commitSha: null,
      imageRepository: null, imageTag: null, imageId: null, imageDigest: null,
      containerId: null, containerName: null, containerPort: null, observedAt: 0,
    });
    ok(rc.verdict !== "IN_SYNC", "noop must not be IN_SYNC");
    rec("229M", "drift not silently accepted", "PASS", `verdict=${rc.verdict}`);
  } catch (e) { rec("229M", "drift not silently accepted", "FAIL", String(e)); }

  // 229N: duplicate activation denied by lease
  try {
    const inp = intentInput("N");
    const r = await intents.getOrCreateAsync(inp as any);
    const key = r.intent.intentKey;
    const w = rid("w229N-");
    await intents.acquireLeaseAsync(key, w);
    await intents.transitionIfOwnedAsync(key, "DEPLOYING", w, {}, ["DEPLOYMENT_INTENT_CREATED"]);
    await intents.transitionIfOwnedAsync(key, "HEALTH_CHECKING", w, {}, ["DEPLOYING"]);
    await intents.transitionIfOwnedAsync(key, "SMOKE_TESTING", w, {}, ["HEALTH_CHECKING"]);
    await intents.transitionIfOwnedAsync(key, "KNOWN_GOOD", w, {}, ["SMOKE_TESTING"]);
    const act2 = await svc.deploymentActivationService.activate(key, rid("w229N2-"));
    ok(act2.status === "BLOCKED", `expected BLOCKED, got ${act2.status}`);
    ok((act2.reason ?? "").startsWith("ACTIVATION_LEASE_HELD"), `reason=${act2.reason}`);
    await intents.releaseLeaseAsync(key, w);
    rec("229N", "duplicate activation denied", "PASS", `reason=${act2.reason}`);
  } catch (e) { rec("229N", "duplicate activation denied", "FAIL", String(e)); }
  // 229O: lease fencing -- non-holder refused
  try {
    const inp = intentInput("O");
    const r = await intents.getOrCreateAsync(inp as any);
    const key = r.intent.intentKey;
    const w1 = rid("w229O1-");
    const w2 = rid("w229O2-");
    await intents.acquireLeaseAsync(key, w1);
    const t = await intents.transitionIfOwnedAsync(key, "DEPLOYING", w2, {}, ["DEPLOYMENT_INTENT_CREATED"]);
    ok(t.updated === false, "non-holder transition succeeded");
    await intents.releaseLeaseAsync(key, w1);
    rec("229O", "lease fencing", "PASS", "non-holder refused");
  } catch (e) { rec("229O", "lease fencing", "FAIL", String(e)); }

  // 229P: stale worker rejected after lease handoff
  try {
    const inp = intentInput("P");
    const r = await intents.getOrCreateAsync(inp as any);
    const key = r.intent.intentKey;
    const w1 = rid("w229P1-");
    const w2 = rid("w229P2-");
    await intents.acquireLeaseAsync(key, w1);
    await intents.releaseLeaseAsync(key, w1);
    await intents.acquireLeaseAsync(key, w2);
    const t = await intents.transitionIfOwnedAsync(key, "DEPLOYING", w1, {}, ["DEPLOYMENT_INTENT_CREATED"]);
    ok(t.updated === false, "stale worker transition succeeded");
    await intents.releaseLeaseAsync(key, w2);
    rec("229P", "stale worker fenced", "PASS", "old worker rejected");
  } catch (e) { rec("229P", "stale worker fenced", "FAIL", String(e)); }

  // 229Q: partial cutover / unknown classified as RECOVERY_REQUIRED
  try {
    const rsvc = new ReleaseRecoveryService();
    const p = rsvc.classify({ intent: { intentKey: "k", status: "TRAFFIC_CUTOVER" } as any });
    ok(p.action === "RECOVERY_REQUIRED", `TRAFFIC_CUTOVER -> ${p.action}`);
    ok(p.requiresDockerInspection === true, "requiresDockerInspection should be true");
    rec("229Q", "partial cutover classification", "PASS", `action=${p.action} inspect=${p.requiresDockerInspection}`);
  } catch (e) { rec("229Q", "partial cutover classification", "FAIL", String(e)); }

  // 229R: restart recovery for POST_ACTIVATION_HEALTH_CHECK
  try {
    const rsvc = new ReleaseRecoveryService();
    const p = rsvc.classify({ intent: { intentKey: "k", status: "POST_ACTIVATION_HEALTH_CHECK" } as any });
    ok(p.action === "RECOVERY_REQUIRED", `POST_ACTIVATION_HEALTH_CHECK -> ${p.action}`);
    rec("229R", "restart recovery", "PASS", `action=${p.action}`);
  } catch (e) { rec("229R", "restart recovery", "FAIL", String(e)); }

  // 229S: rollback refuses non-ACTIVE
  try {
    const inp = intentInput("S");
    const r = await intents.getOrCreateAsync(inp as any);
    const rb = await svc.deploymentActivationService.rollback(r.intent.intentKey, rid("w229S-"));
    ok(rb.status === "BLOCKED", `expected BLOCKED, got ${rb.status}`);
    ok((rb.reason ?? "").startsWith("INTENT_NOT_ACTIVE"), `reason=${rb.reason}`);
    rec("229S", "rollback refuses non-ACTIVE", "PASS", `reason=${rb.reason}`);
  } catch (e) { rec("229S", "rollback refuses non-ACTIVE", "FAIL", String(e)); }

  // 229T: rollback provider verification honest
  try {
    const noop = new NoopTrafficRouter();
    const r = await noop.revert({
      environment: "t", intentKey: "k", releaseId: "r", commitSha: "c",
      imageRepository: "x", imageTag: "y", imageId: null, imageDigest: null,
      containerName: "n", containerPort: 0, previousContainerName: null,
    });
    ok(r.ok === false && r.reason === NO_TRAFFIC_ROUTER_REASON, `revert reason=${r.reason}`);
    rec("229T", "rollback provider verification", "PASS", `revert BLOCKED reason=${r.reason}`);
  } catch (e) { rec("229T", "rollback provider verification", "FAIL", String(e)); }

  // 229U: post-rollback health honest
  try {
    const noop = new NoopTrafficRouter();
    const h = await noop.health("x");
    ok(h.verdict === "BLOCKED", `verdict=${h.verdict}`);
    rec("229U", "post-rollback health", "PASS", `verdict=${h.verdict}`);
  } catch (e) { rec("229U", "post-rollback health", "FAIL", String(e)); }

  // 229V: missing previous target -- null is not a target
  try {
    const { DeploymentActivationService } = await import("../src/core/deployment-activation-service");
    const noHistory = undefined;
    const r = new NoopTrafficRouter();
    const act = new DeploymentActivationService(svc.releaseIntents, r, noHistory as any);
    const inp = intentInput("V");
    const got = await intents.getOrCreateAsync(inp as any);
    await walkToKnownGood(intents, got.intent.intentKey, rid("w229V-"));
    const out = await act.activate(got.intent.intentKey, rid("w229Vact-"));
    ok(out.previousTarget === undefined || out.previousTarget === null,
       `previousTarget should be null when no history: ${JSON.stringify(out.previousTarget)}`);
    rec("229V", "missing previous target handling", "PASS", "previousTarget=null, no fabrication");
  } catch (e) { rec("229V", "missing previous target handling", "FAIL", String(e)); }

  // 229W: AWS router with bad config returns BLOCKED reason
  try {
    const aws = new AWSTrafficRouter({
      region: null, loadBalancerArn: null, listenerArn: null, targetGroupArn: null, targetPort: null,
    });
    const out = await aws.cutover({
      environment: "t", intentKey: "k", releaseId: "r", commitSha: "c",
      imageRepository: "x", imageTag: "y", imageId: null, imageDigest: null,
      containerName: "n", containerPort: 0, previousContainerName: null,
    });
    ok(out.ok === false, "expected BLOCKED");
    ok(!!out.reason, "reason must be set");
    rec("229W", "AWS bad config -> BLOCKED", "PASS", `reason=${out.reason}`);
  } catch (e) { rec("229W", "AWS bad config -> BLOCKED", "FAIL", String(e)); }

  // 229X: audit evidence -- intent rows in Postgres
  try {
    const r = await q("SELECT COUNT(*)::int AS n FROM release_deployment_intents WHERE environment LIKE $1", ["phase229-test-%"]);
    ok(r.rows[0].n >= 1, "no phase229 intents persisted");
    rec("229X", "audit evidence persisted", "PASS", `intents=${r.rows[0].n}`);
  } catch (e) { rec("229X", "audit evidence persisted", "FAIL", String(e)); }
  // 229Y: secret redaction -- evidence does not contain AWS key patterns
  try {
    const r = await q("SELECT failure_reason, recovery_reason FROM release_deployment_intents WHERE environment LIKE $1", ["phase229-test-%"]);
    const blob = JSON.stringify(r.rows);
    ok(!/AKIA[0-9A-Z]{16}/.test(blob), "AWS access key pattern present");
    ok(!/aws_secret_access_key/i.test(blob), "AWS secret key string present");
    rec("229Y", "secret redaction", "PASS", "no AWS key patterns in persisted intents");
  } catch (e) { rec("229Y", "secret redaction", "FAIL", String(e)); }

  // 229Z: authorization / environment isolation
  try {
    const inp1 = intentInput("Z1");
    const inp2 = intentInput("Z2");
    const a = await intents.getOrCreateAsync(inp1 as any);
    const b = await intents.getOrCreateAsync(inp2 as any);
    ok(a.intent.intentKey !== b.intent.intentKey, "cross-env keys collided");
    ok(a.intent.environment !== b.intent.environment, "environments collided");
    rec("229Z", "environment isolation", "PASS", `env1=${a.intent.environment} env2=${b.intent.environment}`);
  } catch (e) { rec("229Z", "environment isolation", "FAIL", String(e)); }

  // 229AA: Phase 225 wiring
  try {
    ok(!!svc.releaseDeploymentExecutor, "releaseDeploymentExecutor missing");
    ok(!!svc.releaseExecutionGate, "releaseExecutionGate missing");
    ok(!!svc.deployments, "deployments missing");
    rec("229AA", "Phase 225 wiring intact", "PASS", "executor+gate+deployments exposed");
  } catch (e) { rec("229AA", "Phase 225 wiring intact", "FAIL", String(e)); }

  // 229AB: Phase 226 wiring
  try {
    const r = await intents.getOrCreateAsync(intentInput("AB") as any);
    ok(!!r.intent.intentKey, "getOrCreateAsync missing key");
    rec("229AB", "Phase 226 wiring intact", "PASS", "intents work");
  } catch (e) { rec("229AB", "Phase 226 wiring intact", "FAIL", String(e)); }

  // 229AC: Phase 227 wiring
  try {
    ok(!!svc.deploymentActivationService, "deploymentActivationService missing");
    rec("229AC", "Phase 227 wiring intact", "PASS", "activation service exposed");
  } catch (e) { rec("229AC", "Phase 227 wiring intact", "FAIL", String(e)); }

  // 229AD: real Docker deployment through NEXUS
  try {
    const imageId = execSync("docker inspect nexus-app:version-a --format {{.Id}}", {
      encoding: "utf8", timeout: 10_000,
    }).trim();
    const containerName = rid("nexus-229AD-");
    const out = await svc.deployments.deploy({
      project_id: "phase229-proj",
      environment: "phase229-" + Date.now().toString(36),
      release_id: "rel229-AD",
      image_repository: "nexus-app",
      image_tag: "version-a",
      image_id: imageId,
      image_digest: null,
      container_name: containerName,
      container_port: 8080,
      attempt_id: rid("att229AD-"),
    });
    const status = out?.deployment?.status;
    if (status === "KNOWN_GOOD" || status === "SUCCEEDED") {
      rec("229AD", "real deployment through NEXUS", "PASS",
          `container=${out?.deployment?.container_id?.slice(0,12) ?? "?"} status=${status}`);
    } else {
      rec("229AD", "real deployment through NEXUS", "FAIL",
          `status=${status} reason=${out?.deployment?.failure_reason ?? "?"}`);
    }
    try { execSync(`docker rm -f ${containerName}`, { stdio: "ignore", timeout: 10_000 }); } catch {}
  } catch (e) { rec("229AD", "real deployment through NEXUS", "FAIL", String(e).slice(0, 120)); }

  // 229AE: real AWS production traffic NOT EXECUTED (credentials missing)
  try {
    const aws = new AWSTrafficRouter(readAwsTrafficRouterConfig(process.env));
    const cap = await aws.capabilities();
    if (cap.canCutover) {
      rec("229AE", "real AWS cutover", "NOT EXECUTED", "config present but test disabled without NEXUS_AWS_TEST_MODE=1");
    } else {
      rec("229AE", "real AWS cutover", "BLOCKED", `cannot execute: ${cap.reason}`);
    }
  } catch (e) { rec("229AE", "real AWS cutover", "FAIL", String(e)); }

  finish();
}

function finish() {
  console.log("");
  console.log("===== Phase 229 summary =====");
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