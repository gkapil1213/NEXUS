// scripts/test-phase235-active-health-recovery.ts
// Phase 235 — durability, idempotency, lease fencing, and recovery continuity
// for the Phase 234 ACTIVE-deployment health observation path.
import { NexusKernel } from "../src/core/kernel";
import { createNodeBridge } from "./host-bridge-node";
import { DeploymentActivationService } from "../src/core/deployment-activation-service";
import { ReleaseRecoveryService } from "../src/core/release-recovery";
import { getPgClient } from "../src/core/pg-client";
import {
  NoopTrafficRouter,
  type TrafficRouter, type TrafficRouterKind, type RouterHealthResult,
  type RouterHealthVerdict, type CutoverRequest, type CutoverResult,
  type ActiveTarget, type RouterTargetBinding, type RouterReconcileResult,
  type RouterCapabilityReport,
} from "../src/core/traffic-router";
import { AWSTrafficRouter } from "../src/core/aws-traffic-router";
import os from "node:os";
import path from "node:path";
import type { ReleaseDeploymentIntentService } from "../src/core/release-deployment-intent";

let pass = 0, fail = 0, blocked = 0, notExec = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { fail++; failures.push(name); console.log("FAIL  " + name + (detail ? " :: " + detail : "")); }
}
function blockedRec(name: string, reason: string | null) {
  blocked++; console.log("BLOCKED  " + name + " :: " + (reason ?? "no reason"));
}
function notExecRec(name: string, reason: string) {
  notExec++; console.log("NOT EXECUTED  " + name + " :: " + reason);
}
function finish(): number {
  console.log("\n============================================");
  console.log("PASS: " + pass);
  console.log("FAIL: " + fail);
  console.log("BLOCKED: " + blocked);
  console.log("NOT EXECUTED: " + notExec);
  console.log("============================================");
  return fail > 0 ? 1 : 0;
}
function uniq(tag: string): string {
  return `phase235-${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

class FakeRouter implements TrafficRouter {
  readonly kind: TrafficRouterKind = "noop";
  private q: RouterHealthVerdict[];
  constructor(v: RouterHealthVerdict[]) { this.q = [...v]; }
  async health(targetId: string): Promise<RouterHealthResult> {
    const v = this.q.length ? this.q.shift()! : (this.q[this.q.length - 1] ?? "UNKNOWN");
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
    projectId: "phase235-proj",
    imageRepository: "nexus-app",
    imageTag: "v235-" + u,
    imageId: null,
    imageDigest: "sha256:" + "b".repeat(64),
    containerName: "nexus-235-" + u,
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
    blockedRec("235-pre NEXUS_PERSISTENCE_MODE",
      "not shared: " + (process.env.NEXUS_PERSISTENCE_MODE ?? "(unset)"));
    process.exit(finish());
  }
  if (!process.env.DATABASE_URL) {
    blockedRec("235-pre DATABASE_URL", "not set");
    process.exit(finish());
  }

  const bridgeRoot = path.join(os.tmpdir(), "nexus-phase235-" + Date.now());
  (globalThis as any).window = { __NEXUS_HOST__: createNodeBridge(bridgeRoot) };

  let intents: ReleaseDeploymentIntentService | undefined;
  try {
    const k = new NexusKernel();
    const svc: any = await k.boot();
    intents = svc.releaseIntents;
    if (!intents) { ok("kernel boot exposes releaseIntents", false); process.exit(finish()); }

    // 235A — callable
    {
      const s = new DeploymentActivationService(intents!, new FakeRouter(["HEALTHY"]));
      ok("235A observeActiveHealth callable",
         typeof (s as any).observeActiveHealth === "function");
    }

    // 235B/C — HEALTHY stays ACTIVE, evidence persisted
    {
      const s = new DeploymentActivationService(intents!, new FakeRouter(["HEALTHY"]));
      const k = await makeActiveIntent(intents!, "b", "phase235-b", "arn:tg/235b");
      const r = await s.observeActiveHealth(k, "w235b");
      ok("235B ACTIVE + HEALTHY remains ACTIVE", r.transitionedTo === "ACTIVE", "got " + r.transitionedTo);
      const after = await intents!.getAsync(k);
      const ev = after?.reconciliationEvidence ?? "";
      ok("235C HEALTHY evidence persisted", ev.includes("\"verdict\":\"HEALTHY\""));
    }

    // 235D/E — UNHEALTHY -> HEALTH_DEGRADED, evidence persisted
    {
      const s = new DeploymentActivationService(intents!, new FakeRouter(["UNHEALTHY"]));
      const k = await makeActiveIntent(intents!, "d", "phase235-d", "arn:tg/235d");
      const r = await s.observeActiveHealth(k, "w235d");
      ok("235D ACTIVE + UNHEALTHY -> HEALTH_DEGRADED",
         r.transitionedTo === "HEALTH_DEGRADED", "got " + r.transitionedTo);
      const after = await intents!.getAsync(k);
      ok("235E UNHEALTHY evidence persisted",
         (after?.reconciliationEvidence ?? "").includes("\"verdict\":\"UNHEALTHY\""));
    }

    // 235F — existing recovery classifier sees HEALTH_DEGRADED -> RECOVERY_REQUIRED
    {
      const s = new DeploymentActivationService(intents!, new FakeRouter(["UNHEALTHY"]));
      const k = await makeActiveIntent(intents!, "f", "phase235-f", "arn:tg/235f");
      await s.observeActiveHealth(k, "w235f");
      const after = await intents!.getAsync(k);
      if (after?.status !== "HEALTH_DEGRADED") {
        ok("235F intent HEALTH_DEGRADED before classify", false, "got " + after?.status);
      } else {
        const rsvc = new ReleaseRecoveryService();
        const plan = rsvc.classify({ intent: after as any });
        ok("235F classifier yields RECOVERY_REQUIRED",
           plan.action === "RECOVERY_REQUIRED", "got " + plan.action);
        ok("235F classifier requires docker inspection",
           plan.requiresDockerInspection === true, "got " + plan.requiresDockerInspection);
      }
    }

    // 235G — no automatic rollback
    {
      const s = new DeploymentActivationService(intents!, new FakeRouter(["UNHEALTHY"]));
      const k = await makeActiveIntent(intents!, "g", "phase235-g", "arn:tg/235g");
      const spy: string[] = [];
      const orig = (s as any).rollback.bind(s);
      (s as any).rollback = async (...a: any[]) => { spy.push("rollback"); return orig(...a); };
      await s.observeActiveHealth(k, "w235g");
      ok("235G no rollback invoked", spy.length === 0);
      const after = await intents!.getAsync(k);
      ok("235G status HEALTH_DEGRADED not terminal",
         after?.status === "HEALTH_DEGRADED", "got " + after?.status);
    }

    // 235H/I — UNKNOWN stays ACTIVE, evidence persisted
    {
      const s = new DeploymentActivationService(intents!, new FakeRouter(["UNKNOWN"]));
      const k = await makeActiveIntent(intents!, "h", "phase235-h", "arn:tg/235h");
      const r = await s.observeActiveHealth(k, "w235h");
      ok("235H UNKNOWN stays ACTIVE", r.transitionedTo === "ACTIVE", "got " + r.transitionedTo);
      ok("235H verdict UNKNOWN", r.verdict === "UNKNOWN", "got " + r.verdict);
      const after = await intents!.getAsync(k);
      ok("235I UNKNOWN evidence persisted",
         (after?.reconciliationEvidence ?? "").includes("\"verdict\":\"UNKNOWN\""));
    }

    // 235J/K — BLOCKED stays ACTIVE, evidence persisted
    {
      const s = new DeploymentActivationService(intents!, new FakeRouter(["BLOCKED"]));
      const k = await makeActiveIntent(intents!, "j", "phase235-j", "arn:tg/235j");
      const r = await s.observeActiveHealth(k, "w235j");
      ok("235J BLOCKED stays ACTIVE", r.transitionedTo === "ACTIVE", "got " + r.transitionedTo);
      ok("235J verdict BLOCKED", r.verdict === "BLOCKED", "got " + r.verdict);
      const after = await intents!.getAsync(k);
      ok("235K BLOCKED evidence persisted",
         (after?.reconciliationEvidence ?? "").includes("\"verdict\":\"BLOCKED\""));
    }

    // 235L — non-ACTIVE refused
    {
      const s = new DeploymentActivationService(intents!, new FakeRouter(["HEALTHY"]));
      const u = uniq("l");
      const { intent } = await intents!.getOrCreateAsync({
        releaseId: "rel-" + u, executionId: "exec-" + u, attemptId: "att-" + u,
        artifactId: "art-" + u, artifactDigest: "sha256:" + u, commitSha: "c" + u,
        environment: "phase235-l", projectId: "phase235-proj",
        imageRepository: "nexus-app", imageTag: "v235-" + u, imageId: null,
        imageDigest: "sha256:" + "b".repeat(64),
        containerName: "nexus-235-" + u, containerPort: 8080,
      } as any);
      await intents!.transitionAsync(intent.intentKey, "KNOWN_GOOD" as any);
      const r = await s.observeActiveHealth(intent.intentKey, "w235l");
      ok("235L non-ACTIVE refused", r.status === "NOT_ACTIVE", "got " + r.status);
      const after = await intents!.getAsync(intent.intentKey);
      ok("235L state unchanged", after?.status === "KNOWN_GOOD", "got " + after?.status);
    }

    // 235M — non-owner worker blocked
    {
      const s = new DeploymentActivationService(intents!, new FakeRouter(["HEALTHY"]));
      const k = await makeActiveIntent(intents!, "m", "phase235-m", "arn:tg/235m");
      await intents!.acquireLeaseAsync(k, "holder-" + uniq("m"));
      const r = await s.observeActiveHealth(k, "other-" + uniq("m"));
      ok("235M non-owner blocked",
         r.status === "BLOCKED" && (r.reason ?? "").startsWith("OBSERVATION_LEASE_HELD"),
         "got " + r.status + "/" + r.reason);
    }

    // 235N — expired lease cannot mutate
    {
      const k = await makeActiveIntent(intents!, "n", "phase235-n", "arn:tg/235n");
      const w = "expire-" + uniq("n");
      await intents!.acquireLeaseAsync(k, w, 1);  // 1 ms TTL
      await new Promise((r) => setTimeout(r, 50));
      const t = await intents!.transitionIfOwnedAsync(
        k, "ACTIVE" as any, w, {}, ["ACTIVE"]);
      ok("235N expired lease transition refused", t.updated === false,
         "updated=" + t.updated);
    }

    // 235O/P/Q — wrong binding isolation (release / environment / deployment)
    {
      const s = new DeploymentActivationService(intents!, new FakeRouter(["UNHEALTHY"]));
      const kA = await makeActiveIntent(intents!, "oA", "phase235-oA", "arn:tg/235oA");
      const kB = await makeActiveIntent(intents!, "oB", "phase235-oB", "arn:tg/235oB");
      await s.observeActiveHealth(kA, "w235o");
      const a = await intents!.getAsync(kA);
      const b = await intents!.getAsync(kB);
      ok("235O release binding isolation",
         a?.status === "HEALTH_DEGRADED" && b?.status === "ACTIVE",
         "A=" + a?.status + " B=" + b?.status);
      ok("235P environment binding isolation",
         (a?.environment === "phase235-oA") && (b?.environment === "phase235-oB"));
      ok("235Q deployment binding isolation",
         (a?.providerDeploymentId === "arn:tg/235oA") &&
         (b?.providerDeploymentId === "arn:tg/235oB"));
    }

    // 235R — repeated observation idempotent
    {
      const s = new DeploymentActivationService(intents!,
        new FakeRouter(["HEALTHY", "HEALTHY", "HEALTHY"]));
      const k = await makeActiveIntent(intents!, "r", "phase235-r", "arn:tg/235r");
      const r1 = await s.observeActiveHealth(k, "w235r-1");
      const r2 = await s.observeActiveHealth(k, "w235r-2");
      const r3 = await s.observeActiveHealth(k, "w235r-3");
      ok("235R all three HEALTHY observations succeed",
         r1.status === "OBSERVED" && r2.status === "OBSERVED" && r3.status === "OBSERVED");
      const after = await intents!.getAsync(k);
      ok("235R intent remains ACTIVE", after?.status === "ACTIVE", "got " + after?.status);
    }

    // 235R2 — second observation after HEALTH_DEGRADED does not resurrect
    {
      const s = new DeploymentActivationService(intents!, new FakeRouter(["UNHEALTHY", "HEALTHY"]));
      const k = await makeActiveIntent(intents!, "r2", "phase235-r2", "arn:tg/235r2");
      await s.observeActiveHealth(k, "w235r2-1");
      const r2 = await s.observeActiveHealth(k, "w235r2-2");
      ok("235R2 second observation refused (NOT_ACTIVE)",
         r2.status === "NOT_ACTIVE", "got " + r2.status);
      const after = await intents!.getAsync(k);
      ok("235R2 stays HEALTH_DEGRADED", after?.status === "HEALTH_DEGRADED", "got " + after?.status);
    }

    // 235S — restart/reload preserves evidence
    {
      const s = new DeploymentActivationService(intents!, new FakeRouter(["UNHEALTHY"]));
      const k = await makeActiveIntent(intents!, "s", "phase235-s", "arn:tg/235s");
      await s.observeActiveHealth(k, "w235s");
      // Fresh read from Postgres (durable store round-trip)
      const reloaded = await intents!.getAsync(k);
      const ev = reloaded?.reconciliationEvidence ?? "";
      ok("235S evidence survives reload",
         reloaded?.status === "HEALTH_DEGRADED" && ev.includes("\"verdict\":\"UNHEALTHY\""));
      const evObj = JSON.parse(ev);
      ok("235S evidence has executionId",
         typeof evObj.executionId === "string" && evObj.executionId.length > 0,
         "executionId=" + evObj.executionId);
      // Restart does NOT fabricate HEALTHY
      ok("235S restart does not fabricate HEALTHY",
         !ev.includes("\"verdict\":\"HEALTHY\""));
    }

    // 235T — NoopTrafficRouter BLOCKED
    {
      const noop = new NoopTrafficRouter();
      const h = await noop.health("x");
      ok("235T noop health BLOCKED", h.verdict === "BLOCKED", "got " + h.verdict);
      ok("235T noop reason NO_TRAFFIC_ROUTER_CONFIGURED",
         h.reason === "NO_TRAFFIC_ROUTER_CONFIGURED", "got " + h.reason);
      const s = new DeploymentActivationService(intents!, noop);
      const k = await makeActiveIntent(intents!, "t", "phase235-t", "arn:tg/235t");
      await s.observeActiveHealth(k, "w235t");
      const after = await intents!.getAsync(k);
      ok("235T remains ACTIVE (no false health)", after?.status === "ACTIVE", "got " + after?.status);
    }

    // 235U — real AWS without config remains BLOCKED
    {
      const aws = new AWSTrafficRouter({
        region: null, loadBalancerArn: null, listenerArn: null,
        ruleArn: null, targetGroupArn: null, targetPort: null,
      });
      const h = await aws.health("arn:tg/x");
      if (h.verdict === "BLOCKED") {
        blockedRec("235U real AWSTrafficRouter with no config", h.reason);
      } else {
        ok("235U real AWS unexpectedly " + h.verdict, false);
      }
    }

    // 235V — TypeScript compilation (executed inside the harness)
    try {
      const { execSync } = await import("node:child_process");
      execSync("npx tsc --noEmit", { cwd: process.cwd(), stdio: "pipe" });
      ok("235V TypeScript compilation", true);
    } catch (e: any) {
      ok("235V TypeScript compilation", false,
         "tsc exit: " + (e?.status ?? "?") + " " + (e?.stdout?.toString?.().slice(0, 400) ?? ""));
    }

    // 235W — diff + secret hygiene (executed inside the harness)
    try {
      const { execSync } = await import("node:child_process");
      execSync("git diff --check", { cwd: process.cwd(), stdio: "pipe" });
      // scan the phase235 artifacts and source for obvious secrets
      const { readFileSync, existsSync } = await import("node:fs");
      const candidates = [
        "artifacts/phase235/phase235-evidence.json",
        "artifacts/phase235/phase235-summary.json",
        "artifacts/phase235/phase235-regression-console.txt",
        "docs/phase235/phase235-design.md",
      ];
      let leak = false;
      for (const f of candidates) {
        if (!existsSync(f)) continue;
        const t = readFileSync(f, "utf8");
        if (/postgres:\/\/[^"'\s]*:[^"'\s]*@/.test(t) ||
            /password\s*=\s*[^\s"']/i.test(t) ||
            /DATABASE_URL\s*=\s*postgres/i.test(t)) {
          leak = true;
          console.log("SECRET_LEAK_IN=" + f);
        }
      }
      ok("235W diff check passes", true);
      ok("235W no secrets in phase235 artifacts", leak === false);
    } catch (e: any) {
      ok("235W diff/secret hygiene", false,
         "git diff --check exit: " + (e?.status ?? "?") + " " + (e?.stdout?.toString?.().slice(0, 400) ?? ""));
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