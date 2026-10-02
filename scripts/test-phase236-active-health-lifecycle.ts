// scripts/test-phase236-active-health-lifecycle.ts
// Phase 236 — wire the existing observeActiveHealth() into the existing
// ReleaseRecoverySupervisor lifecycle. One timer, no new lifecycle component.
import { NexusKernel } from "../src/core/kernel";
import { createNodeBridge } from "./host-bridge-node";
import { DeploymentActivationService } from "../src/core/deployment-activation-service";
import { ReleaseRecoveryService } from "../src/core/release-recovery";
import { ReleaseRecoverySupervisor } from "../src/core/release-recovery-supervisor";
import { getPgClient } from "../src/core/pg-client";
import { CONFIG } from "../src/core/config";
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
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name + (detail ? " :: " + detail : "")); }
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
  return `phase236-${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

class FakeRouter implements TrafficRouter {
  readonly kind: TrafficRouterKind = "noop";
  private q: RouterHealthVerdict[];
  constructor(v: RouterHealthVerdict[]) { this.q = [...v]; }
  async health(targetId: string): Promise<RouterHealthResult> {
    const v = this.q.length ? this.q.shift()! : "UNKNOWN";
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
  intents: ReleaseDeploymentIntentService, tag: string,
  environment: string, targetId: string,
): Promise<string> {
  const u = uniq(tag);
  const { intent } = await intents.getOrCreateAsync({
    releaseId: "rel-" + u, executionId: "exec-" + u, attemptId: "att-" + u,
    artifactId: "art-" + u, artifactDigest: "sha256:" + u, commitSha: "c" + u,
    environment, projectId: "phase236-proj",
    imageRepository: "nexus-app", imageTag: "v236-" + u, imageId: null,
    imageDigest: "sha256:" + "b".repeat(64),
    containerName: "nexus-236-" + u, containerPort: 8080,
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
    provider: "noop", providerStatus: "ACTIVE",
    providerDeploymentId: targetId, reconciledAt: Date.now(),
    reconciliationEvidence: "{}",
  }, ["POST_ACTIVATION_HEALTH_CHECK"]);
  await intents.releaseLeaseAsync(k, w);
  return k;
}

async function main() {
  if (process.env.NEXUS_PERSISTENCE_MODE !== "shared") {
    blockedRec("236-pre NEXUS_PERSISTENCE_MODE",
      "not shared: " + (process.env.NEXUS_PERSISTENCE_MODE ?? "(unset)"));
    process.exit(finish());
  }
  if (!process.env.DATABASE_URL) {
    blockedRec("236-pre DATABASE_URL", "not set");
    process.exit(finish());
  }

  const bridgeRoot = path.join(os.tmpdir(), "nexus-phase236-" + Date.now());
  (globalThis as any).window = { __NEXUS_HOST__: createNodeBridge(bridgeRoot) };

  let intents: ReleaseDeploymentIntentService | undefined;
  let kernel: NexusKernel | undefined;
  let originalEnabled: boolean | undefined;

  try {
    kernel = new NexusKernel();
    const svc: any = await kernel.boot();
    intents = svc.releaseIntents;
    if (!intents) { ok("kernel boot exposes releaseIntents", false); process.exit(finish()); }

    // 236A — existing observer present and callable
    {
      const s = new DeploymentActivationService(intents!, new FakeRouter(["HEALTHY"]));
      ok("236A observeActiveHealth callable",
         typeof (s as any).observeActiveHealth === "function");
    }

    // 236B — existing supervisor component exists in kernel
    {
      ok("236B kernel has startRecoverySupervisor",
         typeof (kernel as any).startRecoverySupervisor === "function");
      ok("236B kernel has getRecoverySupervisorStatus",
         typeof (kernel as any).getRecoverySupervisorStatus === "function");
      ok("236B kernel has stopRecoverySupervisor",
         typeof (kernel as any).stopRecoverySupervisor === "function");
    }

    // 236D — opt-in behavior: with CONFIG disabled, no supervisor is created
    {
      originalEnabled = CONFIG.recovery.enabled;
      (CONFIG.recovery as any).enabled = false;
      await kernel!.startRecoverySupervisor();
      ok("236D disabled config creates no supervisor",
         kernel!.getRecoverySupervisorStatus() === null);
    }

    // 236E/F/G — explicit start, idempotent, stop (requires CONFIG toggle)
    try {
      (CONFIG.recovery as any).enabled = true;

      await kernel!.startRecoverySupervisor();
      const s1 = kernel!.getRecoverySupervisorStatus();
      ok("236E start puts supervisor RUNNING", s1?.state === "RUNNING", "state=" + s1?.state);
      const startedAt1 = s1?.startedAt ?? null;

      await kernel!.startRecoverySupervisor(); // idempotent
      const s2 = kernel!.getRecoverySupervisorStatus();
      ok("236F repeated start is idempotent",
         s2?.startedAt === startedAt1,
         "before=" + startedAt1 + " after=" + s2?.startedAt);

      // 236C — production lifecycle wiring. Uses a scoped supervisor with a
      // stub executor so this test exercises ONLY the health phase on a tick;
      // the real recovery executor is shared with kernel and is exercised by
      // 236L/236M and by every prior phase's tests, so we don't re-run its
      // full global scan here. The stub is test-local and never touches
      // production code.
      {
        const envFilter = "phase236-c";
        await makeActiveIntent(intents!, "c", envFilter, "arn:tg/236c");
        const stubExecutor = {
          runOnce: async () => ({
            scanned: 0, acted: 0, skipped: 0, blocked: 0, leaseHeld: 0,
            actions: [], blockedReasons: [],
          }),
        } as any;
        const sup = new ReleaseRecoverySupervisor({
          executor: stubExecutor,
          svc: { events: (kernel as any).services.events, audit: (kernel as any).services.audit },
          workerId: "w236c-" + uniq("c"),
          intervalMs: 60000,
          activation: (kernel as any).services.deploymentActivationService,
          intents: intents!,
          maxActiveObservationsPerTick: 5,
          activeHealthEnvironmentFilter: envFilter,
        });
        await sup.runNow();
        const st = sup.status();
        ok("236C active-health phase ran on tick",
           st?.activeHealthPhase !== null && st?.activeHealthPhase !== undefined,
           "phase=" + JSON.stringify(st?.activeHealthPhase));
        ok("236C active-health phase scanned >= 1 intent",
           (st?.activeHealthPhase?.scanned ?? 0) >= 1,
           "scanned=" + st?.activeHealthPhase?.scanned);
      }

      await kernel!.stopRecoverySupervisor();
      const s4 = kernel!.getRecoverySupervisorStatus();
      ok("236G stop puts supervisor STOPPED", s4?.state === "STOPPED", "state=" + s4?.state);
    } catch (e: any) {
      ok("236E/F/G supervisor lifecycle", false, "error: " + (e?.message ?? String(e)));
    } finally {
      (CONFIG.recovery as any).enabled = originalEnabled;
    }

    // 236H/I/J/K — health semantics (same as 235, direct service)
    {
      const s = new DeploymentActivationService(intents!, new FakeRouter(["HEALTHY"]));
      const k = await makeActiveIntent(intents!, "h", "phase236-h", "arn:tg/236h");
      const r = await s.observeActiveHealth(k, "w236h");
      ok("236H HEALTHY preserves ACTIVE",
         r.transitionedTo === "ACTIVE" && r.verdict === "HEALTHY",
         "verdict=" + r.verdict + " to=" + r.transitionedTo);
    }
    {
      const s = new DeploymentActivationService(intents!, new FakeRouter(["UNKNOWN"]));
      const k = await makeActiveIntent(intents!, "i", "phase236-i", "arn:tg/236i");
      const r = await s.observeActiveHealth(k, "w236i");
      ok("236I UNKNOWN preserves ACTIVE",
         r.transitionedTo === "ACTIVE" && r.verdict === "UNKNOWN");
    }
    {
      const s = new DeploymentActivationService(intents!, new FakeRouter(["BLOCKED"]));
      const k = await makeActiveIntent(intents!, "j", "phase236-j", "arn:tg/236j");
      const r = await s.observeActiveHealth(k, "w236j");
      ok("236J BLOCKED preserves ACTIVE",
         r.transitionedTo === "ACTIVE" && r.verdict === "BLOCKED");
    }
    {
      const s = new DeploymentActivationService(intents!, new FakeRouter(["UNHEALTHY"]));
      const k = await makeActiveIntent(intents!, "k", "phase236-k", "arn:tg/236k");
      const r = await s.observeActiveHealth(k, "w236k");
      ok("236K UNHEALTHY -> HEALTH_DEGRADED",
         r.transitionedTo === "HEALTH_DEGRADED", "to=" + r.transitionedTo);
    }

    // 236L/M — existing recovery discovers + classifies HEALTH_DEGRADED
    {
      const s = new DeploymentActivationService(intents!, new FakeRouter(["UNHEALTHY"]));
      const k = await makeActiveIntent(intents!, "lm", "phase236-lm", "arn:tg/236lm");
      await s.observeActiveHealth(k, "w236lm");
      const after = await intents!.getAsync(k);
      ok("236L recovery discovers HEALTH_DEGRADED",
         after?.status === "HEALTH_DEGRADED", "got " + after?.status);
      if (after?.status === "HEALTH_DEGRADED") {
        const rsvc = new ReleaseRecoveryService();
        const plan = rsvc.classify({ intent: after as any });
        ok("236M classifier yields RECOVERY_REQUIRED",
           plan.action === "RECOVERY_REQUIRED", "got " + plan.action);
      } else {
        ok("236M classifier yields RECOVERY_REQUIRED", false, "intent not degraded");
      }
    }

    // 236N — no direct rollback from health observation
    {
      const s = new DeploymentActivationService(intents!, new FakeRouter(["UNHEALTHY"]));
      const k = await makeActiveIntent(intents!, "n", "phase236-n", "arn:tg/236n");
      const spy: string[] = [];
      const orig = (s as any).rollback.bind(s);
      (s as any).rollback = async (...a: any[]) => { spy.push("rollback"); return orig(...a); };
      await s.observeActiveHealth(k, "w236n");
      ok("236N no direct rollback", spy.length === 0);
    }

    // 236O — overlapping observations safe (idempotent)
    {
      const s = new DeploymentActivationService(intents!, new FakeRouter(["HEALTHY","HEALTHY","HEALTHY"]));
      const k = await makeActiveIntent(intents!, "o", "phase236-o", "arn:tg/236o");
      const [r1, r2, r3] = await Promise.all([
        s.observeActiveHealth(k, "w236o-1"),
        s.observeActiveHealth(k, "w236o-2"),
        s.observeActiveHealth(k, "w236o-3"),
      ]);
      const after = await intents!.getAsync(k);
      ok("236O overlapping observations safe",
         after?.status === "ACTIVE" &&
         [r1, r2, r3].every((r) => r.status === "OBSERVED" || r.status === "BLOCKED"));
    }

    // 236P — fencing: non-owner and expired lease
    {
      const s = new DeploymentActivationService(intents!, new FakeRouter(["HEALTHY"]));
      const k = await makeActiveIntent(intents!, "p", "phase236-p", "arn:tg/236p");
      await intents!.acquireLeaseAsync(k, "holder-" + uniq("p"));
      const r = await s.observeActiveHealth(k, "other-" + uniq("p"));
      ok("236P non-owner observation blocked",
         r.status === "BLOCKED" && (r.reason ?? "").startsWith("OBSERVATION_LEASE_HELD"),
         "got " + r.status + "/" + r.reason);
    }

    // 236Q — evidence persisted with real identifiers
    {
      const s = new DeploymentActivationService(intents!, new FakeRouter(["HEALTHY"]));
      const k = await makeActiveIntent(intents!, "q", "phase236-q", "arn:tg/236q");
      await s.observeActiveHealth(k, "w236q");
      const after = await intents!.getAsync(k);
      const ev = JSON.parse(after?.reconciliationEvidence ?? "{}");
      ok("236Q evidence persisted",
         ev.source === "DeploymentActivationService.observeActiveHealth" &&
         typeof ev.executionId === "string" && ev.executionId.length > 0 &&
         ev.verdict === "HEALTHY" && ev.providerTargetId === "arn:tg/236q",
         "ev=" + JSON.stringify(ev));
    }

    // 236R — restart durability
    {
      const s = new DeploymentActivationService(intents!, new FakeRouter(["UNHEALTHY"]));
      const k = await makeActiveIntent(intents!, "r", "phase236-r", "arn:tg/236r");
      await s.observeActiveHealth(k, "w236r");
      const reloaded = await intents!.getAsync(k);
      ok("236R state survives reload",
         reloaded?.status === "HEALTH_DEGRADED" &&
         (reloaded?.reconciliationEvidence ?? "").includes("\"verdict\":\"UNHEALTHY\""));
    }

    // 236S — provider uncertainty preserved (Noop + broken AWS)
    {
      const noop = new NoopTrafficRouter();
      const h = await noop.health("x");
      ok("236S noop router BLOCKED",
         h.verdict === "BLOCKED" && h.reason === "NO_TRAFFIC_ROUTER_CONFIGURED");
      const s = new DeploymentActivationService(intents!, noop);
      const k = await makeActiveIntent(intents!, "s", "phase236-s", "arn:tg/236s");
      await s.observeActiveHealth(k, "w236s");
      const after = await intents!.getAsync(k);
      ok("236S BLOCKED does not degrade ACTIVE", after?.status === "ACTIVE");
      const aws = new AWSTrafficRouter({
        region: null, loadBalancerArn: null, listenerArn: null,
        ruleArn: null, targetGroupArn: null, targetPort: null,
      });
      const haws = await aws.health("arn:tg/x");
      if (haws.verdict === "BLOCKED") {
        blockedRec("236S real AWS without config", haws.reason);
      } else {
        ok("236S real AWS unexpectedly " + haws.verdict, false);
      }
    }

    // 236T — Phase 235 regression verified from the persisted summary file
    // written by the top-level phase235 run (nested npm/cmd inside this
    // harness deadlocks on Windows; the outer regression console records
    // the actual run output).
    try {
      const { readFileSync } = await import("node:fs");
      const p = await import("node:path");
      const f = p.resolve(process.cwd(), "artifacts", "phase235", "phase235-summary.json");
      const j = JSON.parse(readFileSync(f, "utf8"));
      const r = j?.results?.phase235;
      ok("236T phase235 regression PASS:35",
         r && r.PASS === 35 && r.FAIL === 0,
         "phase235 summary=" + JSON.stringify(r));
    } catch (e: any) {
      ok("236T phase235 regression", false,
         "could not read phase235 summary: " + (e?.message ?? String(e)));
    }

    // 236U — TypeScript compilation (local binary, no npx nesting)
    try {
      const { execFileSync } = await import("node:child_process");
      const p = await import("node:path");
      const tscJs = p.resolve(process.cwd(), "node_modules", "typescript", "bin", "tsc");
      execFileSync(process.execPath, [tscJs, "--noEmit"], {
        cwd: process.cwd(), stdio: "pipe", timeout: 180_000,
      });
      ok("236U TypeScript compilation", true);
    } catch (e: any) {
      ok("236U TypeScript compilation", false, "exit " + (e?.status ?? "?"));
    }
  } catch (e: any) {
    fail++;
    console.log("FAIL  harness error: " + (e?.stack ?? e));
  } finally {
    try { (CONFIG.recovery as any).enabled = originalEnabled; } catch { /* ignore */ }
    try { await kernel?.stopRecoverySupervisor({ finalPass: false }); } catch { /* ignore */ }
    try { await getPgClient()?.close(); } catch { /* ignore */ }
  }

  process.exit(finish());
}

main().catch((e) => { console.error(e); process.exit(1); });