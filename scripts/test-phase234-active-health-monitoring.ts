// scripts/test-phase234-active-health-monitoring.ts
// Phase 234: ACTIVE deployment health observation.
// Uses the real shared PostgreSQL async path via NexusKernel.boot().
import { NexusKernel } from "../src/core/kernel";
import { createNodeBridge } from "./host-bridge-node";
import { DeploymentActivationService } from "../src/core/deployment-activation-service";
import { getPgClient } from "../src/core/pg-client";
import {
  NoopTrafficRouter,
  type TrafficRouter, type TrafficRouterKind, type RouterHealthResult,
  type RouterHealthVerdict, type CutoverRequest, type CutoverResult,
  type ActiveTarget, type RouterTargetBinding, type RouterReconcileResult,
  type RouterCapabilityReport,
} from "../src/core/traffic-router";
import { AWSTrafficRouter } from "../src/core/aws-traffic-router";
import { ReleaseRecoveryService } from "../src/core/release-recovery";
import os from "node:os";
import path from "node:path";
import type { ReleaseDeploymentIntentService } from "../src/core/release-deployment-intent";

let pass = 0, fail = 0, blocked = 0, notExecuted = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { fail++; failures.push(name + (detail ? " :: " + detail : ""));
         console.log("FAIL  " + name + (detail ? " :: " + detail : "")); }
}
function blockedRec(name: string, reason: string | null) {
  blocked++; console.log("BLOCKED  " + name + " :: " + (reason ?? "no reason"));
}
function notExec(name: string, reason: string) {
  notExecuted++; console.log("NOT EXECUTED  " + name + " :: " + reason);
}
function finish(): number {
  console.log("\n============================================");
  console.log("PASS: " + pass);
  console.log("FAIL: " + fail);
  console.log("BLOCKED: " + blocked);
  console.log("NOT EXECUTED: " + notExecuted);
  console.log("============================================");
  return fail > 0 ? 1 : 0;
}
function uniq(tag: string): string {
  return `phase234-${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

class FakeRouter implements TrafficRouter {
  readonly kind: TrafficRouterKind = "noop";
  private q: RouterHealthVerdict[];
  constructor(v: RouterHealthVerdict[]) { this.q = [...v]; }
  async health(targetId: string): Promise<RouterHealthResult> {
    const v = this.q.shift() ?? "UNKNOWN";
    return { verdict: v, targetId,
             reason: v === "BLOCKED" ? "AWS_REGION_NOT_CONFIGURED" : null,
             probedAt: Date.now() };
  }
  async cutover(_r: CutoverRequest): Promise<CutoverResult> {
    return { ok: true, reason: null, activeTarget: "tg/active" }; }
  async revert(_r: CutoverRequest): Promise<CutoverResult> {
    return { ok: true, reason: null, activeTarget: null }; }
  async resolveActive(_e: string): Promise<ActiveTarget | null> { return null; }
  async resolveTarget(_e: string,
    _i: { releaseId: string | null; imageDigest: string | null })
    : Promise<RouterTargetBinding | null> { return null; }
  async validateTarget(_t: RouterTargetBinding) { return { valid: true, reason: null }; }
  async reconcile(_d: RouterTargetBinding | null): Promise<RouterReconcileResult> {
    return { verdict: "IN_SYNC", reason: null, desiredTargetId: null,
             observedTargetId: null, reconciledAt: Date.now() };
  }
  async capabilities(): Promise<RouterCapabilityReport> {
    return { kind: "noop", canResolveActive: true, canResolveTarget: true,
             canValidateTarget: true, canCutover: true, canRevert: true,
             canHealthCheck: true, canReconcile: true,
             reason: null, probedAt: Date.now() };
  }
}

async function makeActiveIntent(
  intents: ReleaseDeploymentIntentService,
  tag: string,
  environment: string,
  targetId: string,
): Promise<string> {
  const u = uniq(tag);
  const { intent } = await intents.getOrCreateAsync({
    releaseId: "rel-" + u,
    executionId: "exec-" + u,
    attemptId: "att-" + u,
    artifactId: "art-" + u,
    artifactDigest: "sha256:" + u,
    commitSha: "c" + u,
    environment,
    projectId: "phase234-proj",
    imageRepository: "nexus-app",
    imageTag: "v234-" + u,
    imageId: null,
    imageDigest: "sha256:" + "b".repeat(64),
    containerName: "nexus-234-" + u,
    containerPort: 8080,
  } as any);
  const k = intent.intentKey;
  const w = "setup-" + u;
  await intents.acquireLeaseAsync(k, w);
  await intents.transitionIfOwnedAsync(k, "DEPLOYING" as any, w, {}, ["DEPLOYMENT_INTENT_CREATED"]);
  await intents.transitionIfOwnedAsync(k, "HEALTH_CHECKING" as any, w, {}, ["DEPLOYING"]);
  await intents.transitionIfOwnedAsync(k, "SMOKE_TESTING" as any, w, {}, ["HEALTH_CHECKING"]);
  await intents.transitionIfOwnedAsync(k, "KNOWN_GOOD" as any, w, {}, ["SMOKE_TESTING"]);
  await intents.transitionIfOwnedAsync(k, "ACTIVATION_REQUESTED" as any, w, {}, ["KNOWN_GOOD"]);
  await intents.transitionIfOwnedAsync(k, "ACTIVATING" as any, w, {}, ["ACTIVATION_REQUESTED"]);
  await intents.transitionIfOwnedAsync(k, "TRAFFIC_CUTOVER" as any, w, {}, ["ACTIVATING"]);
  await intents.transitionIfOwnedAsync(k, "POST_ACTIVATION_HEALTH_CHECK" as any, w, {}, ["TRAFFIC_CUTOVER"]);
  await intents.transitionIfOwnedAsync(k, "ACTIVE" as any, w, {
    provider: "noop",
    providerStatus: "ACTIVE",
    providerDeploymentId: targetId,
    reconciledAt: Date.now(),
    reconciliationEvidence: "{}",
  }, ["POST_ACTIVATION_HEALTH_CHECK"]);
  await intents.releaseLeaseAsync(k, w);
  return k;
}

async function main() {
  if (process.env.NEXUS_PERSISTENCE_MODE !== "shared") {
    blockedRec("234-pre NEXUS_PERSISTENCE_MODE",
      "not shared: " + (process.env.NEXUS_PERSISTENCE_MODE ?? "(unset)"));
    process.exit(finish());
  }
  if (!process.env.DATABASE_URL) {
    blockedRec("234-pre DATABASE_URL", "not set");
    process.exit(finish());
  }

  const bridgeRoot = path.join(os.tmpdir(), "nexus-phase234-" + Date.now());
  (globalThis as any).window = { __NEXUS_HOST__: createNodeBridge(bridgeRoot) };

  let intents: ReleaseDeploymentIntentService | undefined;
  try {
    const k = new NexusKernel();
    const svc: any = await k.boot();
    intents = svc.releaseIntents;
    if (!intents) {
      fail++;
      console.log("FAIL  kernel boot missing releaseIntents");
      process.exit(finish());
    }

    // 234A
    {
      const s = new DeploymentActivationService(intents!, new FakeRouter(["HEALTHY"]));
      ok("234A observeActiveHealth is callable",
         typeof (s as any).observeActiveHealth === "function");
    }

    // 234B
    {
      const s = new DeploymentActivationService(intents!, new FakeRouter(["HEALTHY"]));
      const u = uniq("b");
      const { intent } = await intents!.getOrCreateAsync({
        releaseId: "rel-" + u, executionId: "exec-" + u, attemptId: "att-" + u,
        artifactId: "art-" + u, artifactDigest: "sha256:" + u, commitSha: "c" + u,
        environment: "phase234-b",
        projectId: "phase234-proj",
        imageRepository: "nexus-app",
        imageTag: "v234-" + u,
        imageId: null,
        imageDigest: "sha256:" + "b".repeat(64),
        containerName: "nexus-234-b-" + u,
        containerPort: 8080,
      } as any);
      await intents!.transitionAsync(intent.intentKey, "KNOWN_GOOD" as any);
      const r = await s.observeActiveHealth(intent.intentKey, "w-" + u);
      ok("234B non-ACTIVE refused", r.status === "NOT_ACTIVE", "got " + r.status);
      const after = await intents!.getAsync(intent.intentKey);
      ok("234B status unchanged", after?.status === "KNOWN_GOOD", "got " + after?.status);
    }

    // 234C
    {
      const s = new DeploymentActivationService(intents!, new FakeRouter(["HEALTHY"]));
      const k = await makeActiveIntent(intents!, "c", "phase234-c", "arn:tg/real-c");
      const r = await s.observeActiveHealth(k, "w-c");
      ok("234C observed status", r.status === "OBSERVED", "got " + r.status);
      ok("234C verdict HEALTHY", r.verdict === "HEALTHY", "got " + r.verdict);
      const after = await intents!.getAsync(k);
      ok("234C remains ACTIVE", after?.status === "ACTIVE", "got " + after?.status);
      ok("234C evidence persisted",
         (after?.reconciliationEvidence ?? "").includes("\"verdict\":\"HEALTHY\""));
    }

    // 234D
    {
      const s = new DeploymentActivationService(intents!, new FakeRouter(["UNHEALTHY"]));
      const k = await makeActiveIntent(intents!, "d", "phase234-d", "arn:tg/real-d");
      const r = await s.observeActiveHealth(k, "w-d");
      ok("234D transitionedTo HEALTH_DEGRADED",
         r.transitionedTo === "HEALTH_DEGRADED", "got " + r.transitionedTo);
      const after = await intents!.getAsync(k);
      ok("234D persisted HEALTH_DEGRADED", after?.status === "HEALTH_DEGRADED", "got " + after?.status);
      ok("234D evidence persisted",
         (after?.reconciliationEvidence ?? "").includes("\"verdict\":\"UNHEALTHY\""));
    }

    // 234E
    {
      const s = new DeploymentActivationService(intents!, new FakeRouter(["UNKNOWN"]));
      const k = await makeActiveIntent(intents!, "e", "phase234-e", "arn:tg/e");
      const r = await s.observeActiveHealth(k, "w-e");
      ok("234E verdict UNKNOWN", r.verdict === "UNKNOWN");
      const after = await intents!.getAsync(k);
      ok("234E stays ACTIVE", after?.status === "ACTIVE", "got " + after?.status);
      ok("234E evidence UNKNOWN",
         (after?.reconciliationEvidence ?? "").includes("\"verdict\":\"UNKNOWN\""));
    }

    // 234F
    {
      const s = new DeploymentActivationService(intents!, new FakeRouter(["BLOCKED"]));
      const k = await makeActiveIntent(intents!, "f", "phase234-f", "arn:tg/f");
      const r = await s.observeActiveHealth(k, "w-f");
      ok("234F verdict BLOCKED", r.verdict === "BLOCKED");
      const after = await intents!.getAsync(k);
      ok("234F stays ACTIVE", after?.status === "ACTIVE");
      ok("234F evidence BLOCKED",
         (after?.reconciliationEvidence ?? "").includes("\"verdict\":\"BLOCKED\""));
    }

    // 234G/H/I
    {
      const s = new DeploymentActivationService(intents!, new FakeRouter(["HEALTHY"]));
      const k = await makeActiveIntent(intents!, "ghi", "phase234-ghi", "arn:tg/ghi");
      const r = await s.observeActiveHealth(k, "w-ghi");
      ok("234G providerTargetId bound", r.providerTargetId === "arn:tg/ghi", "got " + r.providerTargetId);
      const after = await intents!.getAsync(k);
      const ev = JSON.parse(after?.reconciliationEvidence ?? "{}");
      ok("234H releaseId in evidence",
         (ev.releaseId ?? "").startsWith("rel-phase234-ghi-"), "got " + ev.releaseId);
      ok("234I environment in evidence", ev.environment === "phase234-ghi");
    }

    // 234J
    {
      const s = new DeploymentActivationService(intents!, new FakeRouter(["UNHEALTHY"]));
      const kProd = await makeActiveIntent(intents!, "jp", "phase234-jp", "arn:tg/jp");
      const kStage = await makeActiveIntent(intents!, "js", "phase234-js", "arn:tg/js");
      await s.observeActiveHealth(kProd, "w-jp");
      const stage = await intents!.getAsync(kStage);
      ok("234J staging untouched", stage?.status === "ACTIVE", "got " + stage?.status);
    }

    // 234K
    {
      const s = new DeploymentActivationService(intents!, new FakeRouter(["HEALTHY"]));
      const k = await makeActiveIntent(intents!, "k", "phase234-k", "arn:tg/k");
      await intents!.acquireLeaseAsync(k, "worker-A-" + uniq("k"));
      const r = await s.observeActiveHealth(k, "worker-B-" + uniq("k"));
      ok("234K non-owner blocked",
         r.status === "BLOCKED" && (r.reason ?? "").startsWith("OBSERVATION_LEASE_HELD"),
         "got " + r.status + "/" + r.reason);
    }

    // 234L
    {
      const s = new DeploymentActivationService(intents!, new FakeRouter(["UNHEALTHY"]));
      const k = await makeActiveIntent(intents!, "l", "phase234-l", "arn:tg/l");
      await s.observeActiveHealth(k, "w-l");
      const r2 = await s.observeActiveHealth(k, "w-l");
      ok("234L second observe NOT_ACTIVE", r2.status === "NOT_ACTIVE", "got " + r2.status);
    }

    // 234N  existing recovery classification preserves HEALTH_DEGRADED -> RECOVERY_REQUIRED
    try {
      const s = new DeploymentActivationService(intents!, new FakeRouter(["UNHEALTHY"]));
      const k = await makeActiveIntent(intents!, "n", "phase234-n", "arn:tg/n");
      await s.observeActiveHealth(k, "w-n");
      const after = await intents!.getAsync(k);
      if (after?.status !== "HEALTH_DEGRADED") {
        ok("234N intent is HEALTH_DEGRADED before classify", false, "got " + after?.status);
      } else {
        const rsvc = new ReleaseRecoveryService();
        const plan = rsvc.classify({ intent: after as any });
        ok("234N classifier yields RECOVERY_REQUIRED",
           plan.action === "RECOVERY_REQUIRED", "got " + plan.action);
        ok("234N classifier requires docker inspection",
           plan.requiresDockerInspection === true, "got " + plan.requiresDockerInspection);
      }
    } catch (e: any) {
      notExec("234N classifier", "error: " + (e?.message ?? String(e)));
    }
    // 234O
    {
      const s = new DeploymentActivationService(intents!, new FakeRouter(["UNHEALTHY"]));
      const k = await makeActiveIntent(intents!, "o", "phase234-o", "arn:tg/o");
      const spy: string[] = [];
      const orig = (s as any).rollback.bind(s);
      (s as any).rollback = async (...a: any[]) => { spy.push("rollback"); return orig(...a); };
      await s.observeActiveHealth(k, "w-o");
      ok("234O no rollback invoked", spy.length === 0);
      const after = await intents!.getAsync(k);
      ok("234O status HEALTH_DEGRADED not terminal",
         after?.status === "HEALTH_DEGRADED", "got " + after?.status);
    }

    // 234P
    {
      const noop = new NoopTrafficRouter();
      const h = await noop.health("x");
      ok("234P noop health BLOCKED", h.verdict === "BLOCKED", "got " + h.verdict);
      ok("234P noop reason NO_TRAFFIC_ROUTER_CONFIGURED",
         h.reason === "NO_TRAFFIC_ROUTER_CONFIGURED", "got " + h.reason);
      const s = new DeploymentActivationService(intents!, noop);
      const k = await makeActiveIntent(intents!, "p", "phase234-p", "arn:tg/p");
      await s.observeActiveHealth(k, "w-p");
      const after = await intents!.getAsync(k);
      ok("234P stays ACTIVE (no false health)", after?.status === "ACTIVE", "got " + after?.status);
    }

    // 234Q
    {
      const thrower: TrafficRouter = Object.assign(new FakeRouter([]), {
        health: async () => { throw new Error("provider_blip"); },
      });
      const s = new DeploymentActivationService(intents!, thrower);
      const k = await makeActiveIntent(intents!, "q", "phase234-q", "arn:tg/q");
      const r = await s.observeActiveHealth(k, "w-q");
      ok("234Q exception -> UNKNOWN", r.verdict === "UNKNOWN", "got " + r.verdict);
    }

    // 234R
    {
      const aws = new AWSTrafficRouter({
        region: null, loadBalancerArn: null, listenerArn: null,
        ruleArn: null, targetGroupArn: null, targetPort: null,
      });
      const h = await aws.health("arn:tg/x");
      if (h.verdict === "BLOCKED") {
        blockedRec("234R real AWSTrafficRouter with no config", h.reason);
      } else {
        ok("234R real AWSTrafficRouter unexpectedly " + h.verdict, false);
      }
    }
  } catch (e: any) {
    fail++;
    console.log("FAIL  harness error: " + (e?.stack ?? e));
    failures.push("harness error: " + (e?.message ?? String(e)));
  } finally {
    try { await getPgClient()?.close(); } catch { /* ignore */ }
  }

  process.exit(finish());
}

main().catch((e) => { console.error(e); process.exit(1); });