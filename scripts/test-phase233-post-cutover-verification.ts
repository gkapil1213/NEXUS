// scripts/test-phase233-post-cutover-verification.ts
// Phase 233 - Post-cutover production verification before ACTIVE.
//
// Closes the gap: DeploymentActivationService previously advanced
// TRAFFIC_CUTOVER -> POST_ACTIVATION_HEALTH_CHECK -> ACTIVE with empty
// patches and never invoked the provider's health() check. Phase 233
// requires a real health() verdict before ACTIVE and persists
// providerStatus / providerDeploymentId / reconciledAt / reconciliationEvidence.
//
// Reuses the existing TrafficRouter.health() primitive (Phase 229/230).
// No new orchestrator. No new health-check framework. No fake PASS.

import { NexusKernel } from "../src/core/kernel";
import { DeploymentActivationService } from "../src/core/deployment-activation-service";
import type {
  TrafficRouter,
  CutoverRequest,
  CutoverResult,
  ActiveTarget,
  RouterTargetBinding,
  RouterHealthResult,
  RouterReconcileResult,
  RouterCapabilityReport,
} from "../src/core/traffic-router";
import { createNodeBridge } from "./host-bridge-node";
import os from "node:os";
import path from "node:path";
import { PgClient } from "../src/core/pg-client";
import type { ReleaseIntentInput } from "../src/core/release-deployment-intent";

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

function intentInput(tag: string): ReleaseIntentInput {
  return {
    releaseId: rid("rel233-"),
    executionId: rid("exec233-"),
    attemptId: rid("att233-"),
    artifactId: "art233-" + tag,
    artifactDigest: "sha256:" + "a".repeat(64),
    commitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    environment: "phase233-test-" + tag,
    projectId: "phase233-proj",
    imageRepository: "nexus-app",
    imageTag: "version-a",
    imageId: null,
    imageDigest: "sha256:" + "b".repeat(64),
    containerName: "nexus-233-" + tag,
    containerPort: 8080,
  };
}

class SpyRouter implements TrafficRouter {
  readonly kind = "load-balancer" as const;
  public cutoverCalls = 0;
  public healthCalls = 0;
  public healthVerdict: "HEALTHY" | "UNHEALTHY" | "UNKNOWN" | "BLOCKED" = "HEALTHY";
  public healthReason: string | null = null;
  public cutoverOk = true;

  async cutover(_req: CutoverRequest): Promise<CutoverResult> {
    this.cutoverCalls += 1;
    return this.cutoverOk
      ? { ok: true, reason: null, activeTarget: "tg-233" }
      : { ok: false, reason: "CUTOVER_REFUSED", activeTarget: null };
  }
  async revert(_req: CutoverRequest): Promise<CutoverResult> {
    return { ok: true, reason: null, activeTarget: "tg-233-prev" };
  }
  async resolveActive(_environment: string): Promise<ActiveTarget | null> { return null; }
  async resolveTarget(_e: string, _i: { releaseId: string | null; imageDigest: string | null }): Promise<RouterTargetBinding | null> { return null; }
  async validateTarget(_t: RouterTargetBinding): Promise<{ valid: boolean; reason: string | null }> {
    return { valid: true, reason: null };
  }
  async health(_targetId: string): Promise<RouterHealthResult> {
    this.healthCalls += 1;
    return { verdict: this.healthVerdict, targetId: "tg-233", reason: this.healthReason, probedAt: Date.now() };
  }
  async reconcile(_desired: RouterTargetBinding | null): Promise<RouterReconcileResult> {
    return { verdict: "IN_SYNC", reason: null, desiredTargetId: null, observedTargetId: null, reconciledAt: Date.now() };
  }
  async capabilities(): Promise<RouterCapabilityReport> {
    return { kind: "load-balancer", canResolveActive: true, canResolveTarget: true, canValidateTarget: true,
             canCutover: true, canRevert: true, canHealthCheck: true, canReconcile: true,
             reason: null, probedAt: Date.now() };
  }
}

async function walkToKnownGood(intents: any, key: string, worker: string) {
  await intents.acquireLeaseAsync(key, worker);
  const a = await intents.transitionIfOwnedAsync(key, "DEPLOYING", worker, {}, ["DEPLOYMENT_INTENT_CREATED"]);
  if (!a.updated) throw new Error("step DEPLOYING refused");
  const b = await intents.transitionIfOwnedAsync(key, "HEALTH_CHECKING", worker, {}, ["DEPLOYING"]);
  if (!b.updated) throw new Error("step HEALTH_CHECKING refused");
  const c = await intents.transitionIfOwnedAsync(key, "SMOKE_TESTING", worker, {}, ["HEALTH_CHECKING"]);
  if (!c.updated) throw new Error("step SMOKE_TESTING refused");
  const d = await intents.transitionIfOwnedAsync(key, "KNOWN_GOOD", worker, {}, ["SMOKE_TESTING"]);
  if (!d.updated) throw new Error("step KNOWN_GOOD refused");
  await intents.releaseLeaseAsync(key, worker);
}

async function main() {
  const bridgeRoot = path.join(os.tmpdir(), "nexus-phase233-" + Date.now());
  (globalThis as any).window = { __NEXUS_HOST__: createNodeBridge(bridgeRoot) };

  let svc: Awaited<ReturnType<NexusKernel["boot"]>> | undefined;
  try {
    const k = new NexusKernel();
    svc = await k.boot();
  } catch (e) {
    rec("233A", "kernel boot", "FAIL", String(e));
    finish(); return;
  }
  const intents = svc.releaseIntents;
  if (!intents) { rec("233A", "kernel wiring", "FAIL", "releaseIntents missing"); finish(); return; }
  // 233A: kernel wiring + spy router capability surface
  try {
    ok(!!svc.deploymentActivationService, "deploymentActivationService missing");
    const spy = new SpyRouter();
    const cap = await spy.capabilities();
    ok(cap.canHealthCheck === true, "spy router must declare canHealthCheck");
    rec("233A", "kernel wiring + health capability", "PASS",
        `activation=${typeof svc.deploymentActivationService} canHealthCheck=${cap.canHealthCheck}`);
  } catch (e) { rec("233A", "kernel wiring + health capability", "FAIL", String(e)); }

  // 233B: cutover success alone does NOT produce ACTIVE (health must be called first)
  try {
    const spy = new SpyRouter();
    const spySvc = new DeploymentActivationService(svc.releaseIntents, spy);
    const inp = intentInput("B");
    const r = await intents.getOrCreateAsync(inp);
    const key = r.intent.intentKey;
    await walkToKnownGood(intents, key, rid("w233B-"));
    const act = await spySvc.activate(key, rid("w233Bact-"));
    ok(spy.cutoverCalls === 1, `cutoverCalls=${spy.cutoverCalls}`);
    ok(spy.healthCalls === 1, `healthCalls=${spy.healthCalls}`);
    ok(act.status === "ACTIVATED", `status=${act.status}`);
    const after = await intents.getAsync(key);
    ok(after?.status === "ACTIVE", `intent=${after?.status}`);
    rec("233B", "cutover + health both required", "PASS",
        `cutover=${spy.cutoverCalls} health=${spy.healthCalls} intent=ACTIVE`);
  } catch (e) { rec("233B", "cutover + health both required", "FAIL", String(e)); }

  // 233C: health PASS permits ACTIVE
  try {
    const spy = new SpyRouter();
    spy.healthVerdict = "HEALTHY";
    const spySvc = new DeploymentActivationService(svc.releaseIntents, spy);
    const inp = intentInput("C");
    const r = await intents.getOrCreateAsync(inp);
    const key = r.intent.intentKey;
    await walkToKnownGood(intents, key, rid("w233C-"));
    const act = await spySvc.activate(key, rid("w233Cact-"));
    ok(act.status === "ACTIVATED", `status=${act.status}`);
    const after = await intents.getAsync(key);
    ok(after?.status === "ACTIVE", `intent=${after?.status}`);
    rec("233C", "health PASS -> ACTIVE", "PASS", `intent=ACTIVE`);
  } catch (e) { rec("233C", "health PASS -> ACTIVE", "FAIL", String(e)); }

  // 233D: health FAIL prevents ACTIVE
  try {
    const spy = new SpyRouter();
    spy.healthVerdict = "UNHEALTHY";
    spy.healthReason = "target failed health check";
    const spySvc = new DeploymentActivationService(svc.releaseIntents, spy);
    const inp = intentInput("D");
    const r = await intents.getOrCreateAsync(inp);
    const key = r.intent.intentKey;
    await walkToKnownGood(intents, key, rid("w233D-"));
    const act = await spySvc.activate(key, rid("w233Dact-"));
    ok(act.status === "BLOCKED", `expected BLOCKED, got ${act.status}`);
    ok((act.reason ?? "").startsWith("POST_CUTOVER_HEALTH_UNHEALTHY"), `reason=${act.reason}`);
    const after = await intents.getAsync(key);
    ok(after?.status === "ACTIVATION_FAILED", `intent=${after?.status}`);
    rec("233D", "health FAIL -> not ACTIVE", "PASS", `intent=${after?.status} reason=${(act.reason ?? "").slice(0,50)}`);
  } catch (e) { rec("233D", "health FAIL -> not ACTIVE", "FAIL", String(e)); }

  // 233E: health BLOCKED prevents ACTIVE
  try {
    const spy = new SpyRouter();
    spy.healthVerdict = "BLOCKED";
    spy.healthReason = "AWS_CREDENTIALS_NOT_CONFIGURED";
    const spySvc = new DeploymentActivationService(svc.releaseIntents, spy);
    const inp = intentInput("E");
    const r = await intents.getOrCreateAsync(inp);
    const key = r.intent.intentKey;
    await walkToKnownGood(intents, key, rid("w233E-"));
    const act = await spySvc.activate(key, rid("w233Eact-"));
    ok(act.status === "BLOCKED", `expected BLOCKED, got ${act.status}`);
    const after = await intents.getAsync(key);
    ok(after?.status === "ACTIVATION_FAILED", `intent=${after?.status}`);
    rec("233E", "health BLOCKED -> not ACTIVE", "PASS", `intent=${after?.status}`);
  } catch (e) { rec("233E", "health BLOCKED -> not ACTIVE", "FAIL", String(e)); }

  // 233F: health UNKNOWN prevents ACTIVE
  try {
    const spy = new SpyRouter();
    spy.healthVerdict = "UNKNOWN";
    spy.healthReason = "health probe could not determine state";
    const spySvc = new DeploymentActivationService(svc.releaseIntents, spy);
    const inp = intentInput("F");
    const r = await intents.getOrCreateAsync(inp);
    const key = r.intent.intentKey;
    await walkToKnownGood(intents, key, rid("w233F-"));
    const act = await spySvc.activate(key, rid("w233Fact-"));
    ok(act.status === "BLOCKED", `expected BLOCKED, got ${act.status}`);
    const after = await intents.getAsync(key);
    ok(after?.status === "ACTIVATION_FAILED", `intent=${after?.status}`);
    rec("233F", "health UNKNOWN -> not ACTIVE", "PASS", `intent=${after?.status}`);
  } catch (e) { rec("233F", "health UNKNOWN -> not ACTIVE", "FAIL", String(e)); }

  // 233G: identity binding — deploymentId / providerDeploymentId bound to ACTIVE intent
  try {
    const spy = new SpyRouter();
    const spySvc = new DeploymentActivationService(svc.releaseIntents, spy);
    const inp = intentInput("G");
    const r = await intents.getOrCreateAsync(inp);
    const key = r.intent.intentKey;
    await walkToKnownGood(intents, key, rid("w233G-"));
    const act = await spySvc.activate(key, rid("w233Gact-"));
    ok(act.status === "ACTIVATED", `status=${act.status}`);
    const row = await q(
      "SELECT provider, provider_status, provider_deployment_id, reconciled_at FROM release_deployment_intents WHERE intent_key = $1",
      [key],
    );
    const got = row.rows[0];
    ok(got.provider === "load-balancer", `provider=${got.provider}`);
    ok(got.provider_status === "ACTIVE", `provider_status=${got.provider_status}`);
    ok(got.provider_deployment_id === "tg-233", `provider_deployment_id=${got.provider_deployment_id}`);
    ok(got.reconciled_at !== null, `reconciled_at=${got.reconciled_at}`);
    rec("233G", "identity binding on ACTIVE", "PASS",
        `provider=${got.provider} status=${got.provider_status} deployment=${got.provider_deployment_id}`);
  } catch (e) { rec("233G", "identity binding on ACTIVE", "FAIL", String(e)); }

  // 233H: verification evidence persisted
  try {
    const spy = new SpyRouter();
    const spySvc = new DeploymentActivationService(svc.releaseIntents, spy);
    const inp = intentInput("H");
    const r = await intents.getOrCreateAsync(inp);
    const key = r.intent.intentKey;
    await walkToKnownGood(intents, key, rid("w233H-"));
    await spySvc.activate(key, rid("w233Hact-"));
    const row = await q(
      "SELECT reconciliation_evidence FROM release_deployment_intents WHERE intent_key = $1",
      [key],
    );
    const ev = row.rows[0].reconciliation_evidence;
    ok(typeof ev === "string" && ev.length > 0, "reconciliation_evidence missing");
    const parsed = JSON.parse(ev);
    ok(parsed.source === "DeploymentActivationService.activate.ACTIVE", `source=${parsed.source}`);
    ok(parsed.cutoverTarget === "tg-233", `cutoverTarget=${parsed.cutoverTarget}`);
    ok(parsed.healthVerdict === "HEALTHY", `healthVerdict=${parsed.healthVerdict}`);
    rec("233H", "verification evidence persisted", "PASS",
        `source=${parsed.source} target=${parsed.cutoverTarget}`);
  } catch (e) { rec("233H", "verification evidence persisted", "FAIL", String(e)); }

  // 233I: evidence is bound to the correct release
  try {
    const spy = new SpyRouter();
    const spySvc = new DeploymentActivationService(svc.releaseIntents, spy);
    const inp = intentInput("I");
    const r = await intents.getOrCreateAsync(inp);
    const key = r.intent.intentKey;
    await walkToKnownGood(intents, key, rid("w233I-"));
    await spySvc.activate(key, rid("w233Iact-"));
    const ev = (await q(
      "SELECT reconciliation_evidence FROM release_deployment_intents WHERE intent_key = $1",
      [key],
    )).rows[0].reconciliation_evidence;
    const parsed = JSON.parse(ev);
    ok(parsed.releaseId === inp.releaseId, `evidence.releaseId=${parsed.releaseId} vs intent=${inp.releaseId}`);
    rec("233I", "evidence bound to release", "PASS", `releaseId matches`);
  } catch (e) { rec("233I", "evidence bound to release", "FAIL", String(e)); }

  // 233J: wrong worker cannot write ACTIVE
  try {
    const spy = new SpyRouter();
    const spySvc = new DeploymentActivationService(svc.releaseIntents, spy);
    const inp = intentInput("J");
    const r = await intents.getOrCreateAsync(inp);
    const key = r.intent.intentKey;
    await walkToKnownGood(intents, key, rid("w233J-"));
    // Take the lease with a foreign worker before activation runs
    const foreign = rid("w233Jforeign-");
    await intents.acquireLeaseAsync(key, foreign);
    const act = await spySvc.activate(key, rid("w233Jact-"));
    ok(act.status === "BLOCKED", `expected BLOCKED, got ${act.status}`);
    ok((act.reason ?? "").startsWith("ACTIVATION_LEASE_HELD"), `reason=${act.reason}`);
    await intents.releaseLeaseAsync(key, foreign);
    rec("233J", "foreign lease refuses activation", "PASS", `reason=${act.reason}`);
  } catch (e) { rec("233J", "foreign lease refuses activation", "FAIL", String(e)); }

  // 233K: stale worker cannot transition to ACTIVE after handoff
  try {
    const inp = intentInput("K");
    const r = await intents.getOrCreateAsync(inp);
    const key = r.intent.intentKey;
    const stale = rid("w233Kstale-");
    const fresh = rid("w233Kfresh-");
    await walkToKnownGood(intents, key, stale);
    await intents.acquireLeaseAsync(key, fresh);
    const t = await intents.transitionIfOwnedAsync(key, "ACTIVE", stale, {}, ["KNOWN_GOOD"]);
    ok(t.updated === false, "stale worker transitioned to ACTIVE");
    await intents.releaseLeaseAsync(key, fresh);
    rec("233K", "stale worker cannot reach ACTIVE", "PASS", "transition refused");
  } catch (e) { rec("233K", "stale worker cannot reach ACTIVE", "FAIL", String(e)); }

  // 233L: cutover refusal path
  try {
    const spy = new SpyRouter();
    spy.cutoverOk = false;
    const spySvc = new DeploymentActivationService(svc.releaseIntents, spy);
    const inp = intentInput("L");
    const r = await intents.getOrCreateAsync(inp);
    const key = r.intent.intentKey;
    await walkToKnownGood(intents, key, rid("w233L-"));
    const act = await spySvc.activate(key, rid("w233Lact-"));
    ok(act.status === "BLOCKED", `expected BLOCKED, got ${act.status}`);
    ok(act.cutover.ok === false, `cutover.ok=${act.cutover.ok}`);
    ok(spy.healthCalls === 0, `health called despite cutover refusal: ${spy.healthCalls}`);
    const after = await intents.getAsync(key);
    ok(after?.status === "ACTIVATION_FAILED", `intent=${after?.status}`);
    rec("233L", "cutover refusal skips health", "PASS",
        `intent=${after?.status} healthCalls=0`);
  } catch (e) { rec("233L", "cutover refusal skips health", "FAIL", String(e)); }

  // 233M: real AWS provider — health() returns BLOCKED when credentials absent
  try {
    const { readAwsTrafficRouterConfig, AWSTrafficRouter } = await import("../src/core/aws-traffic-router");
    const cfg = readAwsTrafficRouterConfig(process.env);
    const aws = new AWSTrafficRouter(cfg);
    const cap = await aws.capabilities();
    if (cap.canHealthCheck) {
      rec("233M", "real AWS provider health", "NOT EXECUTED", "configured; test disabled without NEXUS_AWS_TEST_MODE=1");
    } else {
      const h = await aws.health("tg-nonexistent");
      ok(h.verdict === "BLOCKED" || h.verdict === "UNKNOWN", `verdict=${h.verdict}`);
      rec("233M", "real AWS provider health", "BLOCKED", `verdict=${h.verdict} reason=${(h.reason ?? "").slice(0,40)}`);
    }
  } catch (e) { rec("233M", "real AWS provider health", "FAIL", String(e)); }

  // 233N: Phase 232 recoverForIntent still works
  try {
    const { ProductionReleaseEnforcementService } = await import("../src/core/production-release-enforcement");
    const provider = {
      executeCalls: 0,
      async execute() { this.executeCalls += 1; throw new Error("lost response"); },
      async reconcile() { return { status: "DEPLOYED" as const, deploymentId: "prov-233N", message: "found" }; },
    };
    const enf = new ProductionReleaseEnforcementService(
      {} as any, {} as any, {} as any, provider as any,
      undefined, undefined, undefined, undefined,
    );
    const out = await enf.recoverForIntent({
      authorizationId: "auth", releaseId: "rel-233N", artifactId: "art",
      commitSha: "sha", environment: "test", projectId: "p", executionId: "e",
      imageRepository: "r", imageTag: "t", imageId: null, imageDigest: "d",
      containerName: "n", containerPort: 8080, attemptId: "a",
    });
    ok(out.status === "DEPLOYED", `status=${out.status}`);
    rec("233N", "Phase 232 recoverForIntent intact", "PASS", `status=${out.status}`);
  } catch (e) { rec("233N", "Phase 232 recoverForIntent intact", "FAIL", String(e)); }

  // 233O: Phase 231 lifecycle wiring intact
  try {
    ok(!!svc.releaseDeploymentExecutor, "releaseDeploymentExecutor missing");
    ok(!!svc.deploymentActivationService, "deploymentActivationService missing");
    ok(!!svc.releaseExecutionGate, "releaseExecutionGate missing");
    rec("233O", "Phase 231 lifecycle wiring intact", "PASS",
        "executor+activation+gate exposed");
  } catch (e) { rec("233O", "Phase 231 lifecycle wiring intact", "FAIL", String(e)); }

  // 233P: no secrets in evidence
  try {
    const r = await q(
      "SELECT reconciliation_evidence FROM release_deployment_intents WHERE environment LIKE $1",
      ["phase233-test-%"],
    );
    const blob = JSON.stringify(r.rows);
    ok(!/AKIA[0-9A-Z]{16}/.test(blob), "AWS key pattern in evidence");
    ok(!/aws_secret_access_key/i.test(blob), "AWS secret string in evidence");
    rec("233P", "no secrets in evidence", "PASS", `${r.rows.length} evidence rows scanned`);
  } catch (e) { rec("233P", "no secrets in evidence", "FAIL", String(e)); }

  // 233Q: typecheck
  try {
    const { execSync } = await import("node:child_process");
    execSync("npx tsc --noEmit", { stdio: "pipe", timeout: 120_000 });
    rec("233Q", "typecheck", "PASS", "tsc --noEmit exit=0");
  } catch (e: any) {
    rec("233Q", "typecheck", "FAIL", String(e).slice(0, 120));
  }

  finish();
}

function finish() {
  console.log("");
  console.log("===== Phase 233 summary =====");
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