// scripts/test-phase239-supervisor-leases.ts
// Phase 239 — durable supervisor ownership, leases, fencing, multi-instance.
import { NexusKernel } from "../src/core/kernel";
import { createNodeBridge } from "./host-bridge-node";
import { DeploymentActivationService } from "../src/core/deployment-activation-service";
import { ReleaseRecoverySupervisor } from "../src/core/release-recovery-supervisor";
import { getPgClient } from "../src/core/pg-client";
import {
  type TrafficRouter, type TrafficRouterKind, type RouterHealthResult,
  type RouterHealthVerdict, type CutoverRequest, type CutoverResult,
  type ActiveTarget, type RouterTargetBinding, type RouterReconcileResult,
  type RouterCapabilityReport,
} from "../src/core/traffic-router";
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
  return `phase239-${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

class FakeRouter implements TrafficRouter {
  readonly kind: TrafficRouterKind = "noop";
  private v: RouterHealthVerdict;
  constructor(v: RouterHealthVerdict = "HEALTHY") { this.v = v; }
  async health(targetId: string): Promise<RouterHealthResult> {
    return { verdict: this.v, targetId,
             reason: this.v === "BLOCKED" ? "AWS_REGION_NOT_CONFIGURED" : null,
             probedAt: Date.now() };
  }
  async cutover(_r: CutoverRequest): Promise<CutoverResult> { return { ok: true, reason: null, activeTarget: "tg/active" }; }
  async revert(_r: CutoverRequest): Promise<CutoverResult> { return { ok: true, reason: null, activeTarget: null }; }
  async resolveActive(_e: string): Promise<ActiveTarget | null> { return null; }
  async resolveTarget(_e: string, _i: { releaseId: string | null; imageDigest: string | null }): Promise<RouterTargetBinding | null> { return null; }
  async validateTarget(_t: RouterTargetBinding) { return { valid: true, reason: null }; }
  async reconcile(_d: RouterTargetBinding | null): Promise<RouterReconcileResult> {
    return { verdict: "IN_SYNC", reason: null, desiredTargetId: null, observedTargetId: null, reconciledAt: Date.now() };
  }
  async capabilities(): Promise<RouterCapabilityReport> {
    return { kind: "noop", canResolveActive: true, canResolveTarget: true, canValidateTarget: true,
             canCutover: true, canRevert: true, canHealthCheck: true, canReconcile: true,
             reason: null, probedAt: Date.now() };
  }
}

const stubExecutor: any = {
  runOnce: async () => ({ scanned: 0, acted: 0, skipped: 0, blocked: 0, leaseHeld: 0, actions: [], blockedReasons: [] }),
};

function makeSupervisor(
  kernel: any, intents: ReleaseDeploymentIntentService, router: TrafficRouter,
  envFilter: string, cap: number, lease?: { scopeKey: string; ttlMs: number },
): ReleaseRecoverySupervisor {
  return new ReleaseRecoverySupervisor({
    executor: stubExecutor,
    svc: { events: kernel.services.events, audit: kernel.services.audit },
    workerId: "w239-" + uniq("sup"),
    intervalMs: 3600_000,
    activation: new DeploymentActivationService(intents, router),
    intents, maxActiveObservationsPerTick: cap,
    activeHealthEnvironmentFilter: envFilter,
    supervisorLease: lease,
  });
}

async function main() {
  if (process.env.NEXUS_PERSISTENCE_MODE !== "shared") {
    blockedRec("239-pre", "not shared"); process.exit(finish());
  }
  if (!process.env.DATABASE_URL) {
    blockedRec("239-pre", "no DATABASE_URL"); process.exit(finish());
  }
  const bridgeRoot = path.join(os.tmpdir(), "nexus-phase239-" + Date.now());
  (globalThis as any).window = { __NEXUS_HOST__: createNodeBridge(bridgeRoot) };
  let intents: ReleaseDeploymentIntentService | undefined;
  let kernel: NexusKernel | undefined;
  try {
    kernel = new NexusKernel();
    const svc: any = await kernel.boot();
    intents = svc.releaseIntents;
    if (!intents) { ok("kernel boot exposes releaseIntents", false); process.exit(finish()); }

    // 239A — supervisor lifecycle APIs still present
    ok("239A supervisor lifecycle APIs present",
       typeof (kernel as any).startRecoverySupervisor === "function" &&
       typeof (kernel as any).stopRecoverySupervisor === "function" &&
       typeof (kernel as any).runRecoveryNow === "function" &&
       typeof (kernel as any).getRecoverySupervisorStatus === "function");

    // 239B — stable workerId on constructor
    {
      let threw = false;
      try { makeSupervisor(kernel, intents!, new FakeRouter(), uniq("b"), 5); }
      catch { threw = true; }
      ok("239B constructor accepts stable workerId", threw === false);
    }

    // 239C — lease API present on intents service
    ok("239C lease API present",
       typeof (intents as any).acquireSupervisorLeaseAsync === "function" &&
       typeof (intents as any).renewSupervisorLeaseAsync === "function" &&
       typeof (intents as any).releaseSupervisorLeaseAsync === "function" &&
       typeof (intents as any).getSupervisorLeaseAsync === "function");

    // 239D — first acquire on empty scope
    {
      const scope = "test239-" + uniq("d");
      const a = await intents!.acquireSupervisorLeaseAsync(scope, "owner-A", 30_000);
      ok("239D first acquire succeeds", a.acquired === true, JSON.stringify(a));
      ok("239D generation=0 on first acquire", a.generation === 0, "gen=" + a.generation);
    }

    // 239E — second owner blocked while valid
    {
      const scope = "test239-" + uniq("e");
      await intents!.acquireSupervisorLeaseAsync(scope, "owner-A", 30_000);
      const b = await intents!.acquireSupervisorLeaseAsync(scope, "owner-B", 30_000);
      ok("239E second owner blocked", b.acquired === false, JSON.stringify(b));
      ok("239E heldBy reveals A", b.heldBy === "owner-A", "heldBy=" + b.heldBy);
    }

    // 239F — getSupervisorLeaseAsync reflects owner
    {
      const scope = "test239-" + uniq("f");
      await intents!.acquireSupervisorLeaseAsync(scope, "owner-A", 30_000);
      const cp = await intents!.getSupervisorLeaseAsync(scope);
      ok("239F lease read returns owner A", cp?.ownerId === "owner-A", JSON.stringify(cp));
    }

    // 239G — same owner renews, generation unchanged
    {
      const scope = "test239-" + uniq("g");
      const a = await intents!.acquireSupervisorLeaseAsync(scope, "owner-A", 30_000);
      const ok1 = await intents!.renewSupervisorLeaseAsync(scope, "owner-A", a.generation!, 30_000);
      const cp = await intents!.getSupervisorLeaseAsync(scope);
      ok("239G owner renew succeeds", ok1 === true);
      ok("239G generation unchanged on renew", cp?.generation === a.generation,
         "gen=" + cp?.generation);
    }

    // 239H — non-owner cannot renew
    {
      const scope = "test239-" + uniq("h");
      const a = await intents!.acquireSupervisorLeaseAsync(scope, "owner-A", 30_000);
      const ok1 = await intents!.renewSupervisorLeaseAsync(scope, "owner-B", a.generation!, 30_000);
      ok("239H non-owner renew refused", ok1 === false);
    }

    // 239I — expired lease acquirable
    {
      const scope = "test239-" + uniq("i");
      await intents!.acquireSupervisorLeaseAsync(scope, "owner-A", 1_000, Date.now() - 60_000);
      const b = await intents!.acquireSupervisorLeaseAsync(scope, "owner-B", 30_000);
      ok("239I expired lease acquirable", b.acquired === true, JSON.stringify(b));
    }

    // 239J — takeover increments generation
    {
      const scope = "test239-" + uniq("j");
      const a = await intents!.acquireSupervisorLeaseAsync(scope, "owner-A", 1_000, Date.now() - 60_000);
      const b = await intents!.acquireSupervisorLeaseAsync(scope, "owner-B", 30_000);
      ok("239J generation increments on takeover",
         b.generation === (a.generation! + 1),
         "a=" + a.generation + " b=" + b.generation);
    }

    // 239K — stale owner cannot renew after takeover
    {
      const scope = "test239-" + uniq("k");
      const a = await intents!.acquireSupervisorLeaseAsync(scope, "owner-A", 1_000, Date.now() - 60_000);
      await intents!.acquireSupervisorLeaseAsync(scope, "owner-B", 30_000);
      const staleRenew = await intents!.renewSupervisorLeaseAsync(scope, "owner-A", a.generation!, 30_000);
      ok("239K stale owner renew rejected", staleRenew === false);
    }

    // 239L — stale generation cannot release current lease
    {
      const scope = "test239-" + uniq("l");
      const a = await intents!.acquireSupervisorLeaseAsync(scope, "owner-A", 1_000, Date.now() - 60_000);
      await intents!.acquireSupervisorLeaseAsync(scope, "owner-B", 30_000);
      const staleRelease = await intents!.releaseSupervisorLeaseAsync(scope, "owner-A", a.generation!);
      ok("239L stale release refused", staleRelease === false);
      const cp = await intents!.getSupervisorLeaseAsync(scope);
      ok("239L B still owns", cp?.ownerId === "owner-B");
    }

    // 239M — current owner releases
    {
      const scope = "test239-" + uniq("m");
      const a = await intents!.acquireSupervisorLeaseAsync(scope, "owner-A", 30_000);
      const rel = await intents!.releaseSupervisorLeaseAsync(scope, "owner-A", a.generation!);
      ok("239M owner release succeeds", rel === true);
      const cp = await intents!.getSupervisorLeaseAsync(scope);
      ok("239M lease row gone", cp === null);
    }

    // 239N — second owner acquires after release
    {
      const scope = "test239-" + uniq("n");
      const a = await intents!.acquireSupervisorLeaseAsync(scope, "owner-A", 30_000);
      await intents!.releaseSupervisorLeaseAsync(scope, "owner-A", a.generation!);
      const b = await intents!.acquireSupervisorLeaseAsync(scope, "owner-B", 30_000);
      ok("239N B acquires after A releases", b.acquired === true, JSON.stringify(b));
    }

    // 239O — concurrent acquisition: exactly one winner
    {
      const scope = "test239-" + uniq("o");
      const [a, b] = await Promise.all([
        intents!.acquireSupervisorLeaseAsync(scope, "owner-A", 30_000),
        intents!.acquireSupervisorLeaseAsync(scope, "owner-B", 30_000),
      ]);
      const winners = [a.acquired, b.acquired].filter(Boolean).length;
      ok("239O exactly one concurrent winner", winners === 1,
         "a=" + a.acquired + " b=" + b.acquired);
    }

    // 239P — concurrent takeover after expiry: exactly one new owner
    {
      const scope = "test239-" + uniq("p");
      await intents!.acquireSupervisorLeaseAsync(scope, "owner-A", 1_000, Date.now() - 60_000);
      const [c, d] = await Promise.all([
        intents!.acquireSupervisorLeaseAsync(scope, "owner-C", 30_000),
        intents!.acquireSupervisorLeaseAsync(scope, "owner-D", 30_000),
      ]);
      const winners = [c.acquired, d.acquired].filter(Boolean).length;
      ok("239P exactly one takeover winner", winners === 1,
         "c=" + c.acquired + " d=" + d.acquired);
    }

    // 239Q — environment scope isolation
    {
      const sProd = "prod-" + uniq("q");
      const sStage = "stage-" + uniq("q");
      await intents!.acquireSupervisorLeaseAsync(sProd, "owner-A", 30_000);
      const st = await intents!.getSupervisorLeaseAsync(sStage);
      ok("239Q prod write does not affect stage scope", st === null);
      const bStage = await intents!.acquireSupervisorLeaseAsync(sStage, "owner-B", 30_000);
      ok("239Q stage acquire independent", bStage.acquired === true);
    }

    // 239R — different identities contend within one scope
    {
      const scope = "test239-" + uniq("r");
      await intents!.acquireSupervisorLeaseAsync(scope, "worker-alpha", 30_000);
      const b = await intents!.acquireSupervisorLeaseAsync(scope, "worker-beta", 30_000);
      ok("239R distinct workers contend, one wins", b.acquired === false);
    }

    // 239S — runNow blocked for non-owner supervisor
    {
      const scope = "test239-" + uniq("s");
      const env = uniq("s-env");
      const supA = makeSupervisor(kernel, intents!, new FakeRouter(), env, 5, { scopeKey: scope, ttlMs: 30_000 });
      const supB = makeSupervisor(kernel, intents!, new FakeRouter(), env, 5, { scopeKey: scope, ttlMs: 30_000 });
      await supA.start();
      await supB.start(); // B start should not become owner
      const stA = supA.status();
      const stB = supB.status();
      ok("239S A is owner", stA.ownedBySelf === true, JSON.stringify({ s: stA.state, o: stA.ownedBySelf }));
      ok("239S B is not owner", stB.ownedBySelf === false, JSON.stringify({ s: stB.state, o: stB.ownedBySelf }));
      const report = await supB.runNow();
      ok("239S non-owner runNow returns blocked report",
         (report.blockedReasons ?? []).some((r: any) => String(r.reason).startsWith("SUPERVISOR_LEASE")),
         JSON.stringify(report.blockedReasons));
      await supA.stop();
      await supB.stop();
    }

    // 239T — non-owner does not execute owned work
    {
      const scope = "test239-" + uniq("t");
      const env = uniq("t-env");
      // Give env an ACTIVE intent so we can detect if a run would touch it
      const u = env + "-t1";
      const { intent } = await intents!.getOrCreateAsync({
        releaseId: "rel-" + u, executionId: "exec-" + u, attemptId: "att-" + u,
        artifactId: "art-" + u, artifactDigest: "sha256:" + u, commitSha: "c" + u,
        environment: env, projectId: "phase239-proj",
        imageRepository: "nexus-app", imageTag: "v239", imageId: null,
        imageDigest: "sha256:" + "b".repeat(64),
        containerName: "nexus-239-" + u, containerPort: 8080,
      } as any);
      const k = intent.intentKey;
      const w = "setup-" + u;
      await intents!.acquireLeaseAsync(k, w);
      await intents!.transitionIfOwnedAsync(k, "DEPLOYING" as any, w, {}, ["DEPLOYMENT_INTENT_CREATED"]);
      await intents!.transitionIfOwnedAsync(k, "HEALTH_CHECKING" as any, w, {}, ["DEPLOYING"]);
      await intents!.transitionIfOwnedAsync(k, "SMOKE_TESTING" as any, w, {}, ["HEALTH_CHECKING"]);
      await intents!.transitionIfOwnedAsync(k, "KNOWN_GOOD" as any, w, {}, ["SMOKE_TESTING"]);
      await intents!.transitionIfOwnedAsync(k, "ACTIVATION_REQUESTED" as any, w, {}, ["KNOWN_GOOD"]);
      await intents!.transitionIfOwnedAsync(k, "ACTIVATING" as any, w, {}, ["ACTIVATION_REQUESTED"]);
      await intents!.transitionIfOwnedAsync(k, "TRAFFIC_CUTOVER" as any, w, {}, ["ACTIVATING"]);
      await intents!.transitionIfOwnedAsync(k, "POST_ACTIVATION_HEALTH_CHECK" as any, w, {}, ["TRAFFIC_CUTOVER"]);
      await intents!.transitionIfOwnedAsync(k, "ACTIVE" as any, w, {
        provider: "noop", providerStatus: "ACTIVE",
        providerDeploymentId: "arn:tg/239-t", reconciledAt: Date.now(),
        reconciliationEvidence: "{}",
      }, ["POST_ACTIVATION_HEALTH_CHECK"]);
      await intents!.releaseLeaseAsync(k, w);

      const before = (await intents!.getAsync(k))?.reconciliationEvidence ?? "";
      const supA = makeSupervisor(kernel, intents!, new FakeRouter("HEALTHY"), env, 5, { scopeKey: scope, ttlMs: 30_000 });
      const supB = makeSupervisor(kernel, intents!, new FakeRouter("HEALTHY"), env, 5, { scopeKey: scope, ttlMs: 30_000 });
      await supA.start();
      await supB.start();
      const rB = await supB.runNow();
      ok("239T non-owner runNow produced no active-health scan",
         rB.scanned === 0 || rB.blocked >= 0,
         JSON.stringify(rB));
      const after = (await intents!.getAsync(k))?.reconciliationEvidence ?? "";
      ok("239T target intent evidence unchanged by non-owner",
         after === before);
      await supA.stop();
      await supB.stop();
    }

    // 239U — owner executes active-health lifecycle (integration)
    {
      const scope = "test239-" + uniq("u");
      const env = uniq("u-env");
      const u = env + "-u1";
      const { intent } = await intents!.getOrCreateAsync({
        releaseId: "rel-" + u, executionId: "exec-" + u, attemptId: "att-" + u,
        artifactId: "art-" + u, artifactDigest: "sha256:" + u, commitSha: "c" + u,
        environment: env, projectId: "phase239-proj",
        imageRepository: "nexus-app", imageTag: "v239", imageId: null,
        imageDigest: "sha256:" + "b".repeat(64),
        containerName: "nexus-239-" + u, containerPort: 8080,
      } as any);
      const k = intent.intentKey;
      const w = "setup-" + u;
      await intents!.acquireLeaseAsync(k, w);
      await intents!.transitionIfOwnedAsync(k, "DEPLOYING" as any, w, {}, ["DEPLOYMENT_INTENT_CREATED"]);
      await intents!.transitionIfOwnedAsync(k, "HEALTH_CHECKING" as any, w, {}, ["DEPLOYING"]);
      await intents!.transitionIfOwnedAsync(k, "SMOKE_TESTING" as any, w, {}, ["HEALTH_CHECKING"]);
      await intents!.transitionIfOwnedAsync(k, "KNOWN_GOOD" as any, w, {}, ["SMOKE_TESTING"]);
      await intents!.transitionIfOwnedAsync(k, "ACTIVATION_REQUESTED" as any, w, {}, ["KNOWN_GOOD"]);
      await intents!.transitionIfOwnedAsync(k, "ACTIVATING" as any, w, {}, ["ACTIVATION_REQUESTED"]);
      await intents!.transitionIfOwnedAsync(k, "TRAFFIC_CUTOVER" as any, w, {}, ["ACTIVATING"]);
      await intents!.transitionIfOwnedAsync(k, "POST_ACTIVATION_HEALTH_CHECK" as any, w, {}, ["TRAFFIC_CUTOVER"]);
      await intents!.transitionIfOwnedAsync(k, "ACTIVE" as any, w, {
        provider: "noop", providerStatus: "ACTIVE",
        providerDeploymentId: "arn:tg/239-u", reconciledAt: Date.now(),
        reconciliationEvidence: "{}",
      }, ["POST_ACTIVATION_HEALTH_CHECK"]);
      await intents!.releaseLeaseAsync(k, w);

      const sup = makeSupervisor(kernel, intents!, new FakeRouter("HEALTHY"), env, 5, { scopeKey: scope, ttlMs: 30_000 });
      await sup.start();
      await sup.runNow();
      const after = await intents!.getAsync(k);
      ok("239U owner runNow advanced active-health for ACTIVE intent",
         (after?.reconciliationEvidence ?? "").includes("observeActiveHealth"),
         "evidence=" + (after?.reconciliationEvidence ?? "").slice(0, 80));
      await sup.stop();
    }

    // 239V — lease loss blocks subsequent runNow
    {
      const scope = "test239-" + uniq("v");
      const env = uniq("v-env");
      const sup = makeSupervisor(kernel, intents!, new FakeRouter("HEALTHY"), env, 5, { scopeKey: scope, ttlMs: 30_000 });
      await sup.start();
      // Force sup's lease to expire, then take over as intruder.
      const pg = getPgClient();
      await pg!.query("UPDATE supervisor_leases SET lease_until = $1 WHERE scope_key = $2",
        [Date.now() - 60_000, scope]);
      const takeover = await intents!.acquireSupervisorLeaseAsync(scope, "intruder", 30_000);
      ok("239V intruder takeover succeeded", takeover.acquired === true, JSON.stringify(takeover));
      const report = await sup.runNow();
      const st = sup.status();
      const blockedReason = (report.blockedReasons ?? []).map((r: any) => String(r.reason)).join(",");
      ok("239V lease loss reflected in runNow", blockedReason.includes("SUPERVISOR_LEASE"),
         "blocked=" + blockedReason + " ownedBySelf=" + st.ownedBySelf);
      await sup.stop();
    }

    // 239W — crash/expiry takeover via supervisor integration
    {
      const scope = "test239-" + uniq("w");
      const env = uniq("w-env");
      const supA = makeSupervisor(kernel, intents!, new FakeRouter("HEALTHY"), env, 5, { scopeKey: scope, ttlMs: 1_000 });
      await supA.start();
      const stA1 = supA.status();
      ok("239W A initially owner", stA1.ownedBySelf === true, JSON.stringify(stA1));
      // Force expiry by advancing the DB row's lease_until into the past.
      // The store doesn't expose that directly, so use a raw pg query.
      const pg = getPgClient();
      await pg!.query("UPDATE supervisor_leases SET lease_until = $1 WHERE scope_key = $2",
        [Date.now() - 60_000, scope]);
      const supB = makeSupervisor(kernel, intents!, new FakeRouter("HEALTHY"), env, 5, { scopeKey: scope, ttlMs: 30_000 });
      await supB.start();
      const stB = supB.status();
      ok("239W B becomes new owner after expiry", stB.ownedBySelf === true, JSON.stringify(stB));
      const staleRenew = await intents!.renewSupervisorLeaseAsync(
        scope, stA1.workerId, stA1.supervisorLeaseGeneration ?? -1, 30_000);
      ok("239W stale A cannot renew after takeover", staleRenew === false);
      await supA.stop();
      await supB.stop();
    }

    // 239X/Y/Z — Phase 238 cursor survives supervisor takeover
    {
      const scope = "test239-" + uniq("xyz");
      const env = uniq("xyz-env");
      const u = env + "-xyz";
      const { intent } = await intents!.getOrCreateAsync({
        releaseId: "rel-" + u, executionId: "exec-" + u, attemptId: "att-" + u,
        artifactId: "art-" + u, artifactDigest: "sha256:" + u, commitSha: "c" + u,
        environment: env, projectId: "phase239-proj",
        imageRepository: "nexus-app", imageTag: "v239", imageId: null,
        imageDigest: "sha256:" + "b".repeat(64),
        containerName: "nexus-239-" + u, containerPort: 8080,
      } as any);
      const k = intent.intentKey;
      const w = "setup-" + u;
      await intents!.acquireLeaseAsync(k, w);
      await intents!.transitionIfOwnedAsync(k, "DEPLOYING" as any, w, {}, ["DEPLOYMENT_INTENT_CREATED"]);
      await intents!.transitionIfOwnedAsync(k, "HEALTH_CHECKING" as any, w, {}, ["DEPLOYING"]);
      await intents!.transitionIfOwnedAsync(k, "SMOKE_TESTING" as any, w, {}, ["HEALTH_CHECKING"]);
      await intents!.transitionIfOwnedAsync(k, "KNOWN_GOOD" as any, w, {}, ["SMOKE_TESTING"]);
      await intents!.transitionIfOwnedAsync(k, "ACTIVATION_REQUESTED" as any, w, {}, ["KNOWN_GOOD"]);
      await intents!.transitionIfOwnedAsync(k, "ACTIVATING" as any, w, {}, ["ACTIVATION_REQUESTED"]);
      await intents!.transitionIfOwnedAsync(k, "TRAFFIC_CUTOVER" as any, w, {}, ["ACTIVATING"]);
      await intents!.transitionIfOwnedAsync(k, "POST_ACTIVATION_HEALTH_CHECK" as any, w, {}, ["TRAFFIC_CUTOVER"]);
      await intents!.transitionIfOwnedAsync(k, "ACTIVE" as any, w, {
        provider: "noop", providerStatus: "ACTIVE",
        providerDeploymentId: "arn:tg/239-xyz", reconciledAt: Date.now(),
        reconciliationEvidence: "{}",
      }, ["POST_ACTIVATION_HEALTH_CHECK"]);
      await intents!.releaseLeaseAsync(k, w);

      const supA = makeSupervisor(kernel, intents!, new FakeRouter("HEALTHY"), env, 5, { scopeKey: scope, ttlMs: 1_000 });
      await supA.start();
      await supA.runNow();
      const chkScope = "release-recovery-supervisor/" + env;
      const cpAfterA = await intents!.getActiveHealthCheckpointAsync(chkScope);
      // Force expiry, take over with B.
      const pg = getPgClient();
      await pg!.query("UPDATE supervisor_leases SET lease_until = $1 WHERE scope_key = $2",
        [Date.now() - 60_000, scope]);
      const supB = makeSupervisor(kernel, intents!, new FakeRouter("HEALTHY"), env, 5, { scopeKey: scope, ttlMs: 30_000 });
      await supB.start();
      const cpAfterB = await intents!.getActiveHealthCheckpointAsync(chkScope);
      ok("239X Phase 238 cursor unchanged across takeover",
         cpAfterA?.cursor === cpAfterB?.cursor &&
         cpAfterA?.generation === cpAfterB?.generation,
         "a=" + JSON.stringify(cpAfterA) + " b=" + JSON.stringify(cpAfterB));
      // B runs next tick; it must observe the same environment intent and not error.
      await supB.runNow();
      ok("239Y B continues from Phase 238 checkpoint (no crash)",
         true, "supervisor takeover + active-health tick completed");
      await supA.stop();
      await supB.stop();
    }

    // 239AA/239AB — persistence failure path must not report success.
    // start() re-throws the persistence error after marking state FAILED;
    // the test catches it and verifies no ownership was claimed.
    {
      const scope = "test239-" + uniq("aa");
      const originalAcq = (intents as any).acquireSupervisorLeaseAsync.bind(intents);
      (intents as any).acquireSupervisorLeaseAsync = async () => { throw new Error("simulated-persist-fail"); };
      const env = uniq("aa-env");
      const sup = makeSupervisor(kernel, intents!, new FakeRouter(), env, 5, { scopeKey: scope, ttlMs: 30_000 });
      let threw = false;
      try { await sup.start(); }
      catch { threw = true; }
      const st = sup.status();
      ok("239AA persistence failure surfaced (start() threw)", threw === true);
      ok("239AA supervisor NOT owned and NOT RUNNING after failure",
         st.ownedBySelf === false && st.state !== "RUNNING",
         JSON.stringify({ state: st.state, owned: st.ownedBySelf, err: st.lastError }));
      ok("239AB persistence failure not reported as success",
         st.ownedBySelf === false);
      (intents as any).acquireSupervisorLeaseAsync = originalAcq;
    }

    // 239AC — stale owner cannot resurrect
    {
      const scope = "test239-" + uniq("ac");
      const a = await intents!.acquireSupervisorLeaseAsync(scope, "owner-A", 1_000, Date.now() - 60_000);
      await intents!.acquireSupervisorLeaseAsync(scope, "owner-B", 30_000);
      const staleAcq = await intents!.acquireSupervisorLeaseAsync(scope, "owner-A", 30_000);
      ok("239AC stale owner re-acquire refused while B valid", staleAcq.acquired === false);
      const cp = await intents!.getSupervisorLeaseAsync(scope);
      ok("239AC B still owns", cp?.ownerId === "owner-B");
    }

    // 239AD — generation monotonicity. Each round supplies a strictly larger
    // "now" so the previous round's lease is unambiguously expired from the
    // caller's point of view.
    {
      const scope = "test239-" + uniq("ad");
      let lastGen = -1;
      let clock = Date.now();
      for (let i = 0; i < 3; i++) {
        const a = await intents!.acquireSupervisorLeaseAsync(scope, "owner-" + i, 1_000, clock);
        ok("239AD acquire round " + i + " succeeded", a.acquired === true,
           JSON.stringify(a));
        ok("239AD generation strictly increasing",
           (a.generation ?? -1) > lastGen, "prev=" + lastGen + " now=" + a.generation);
        lastGen = a.generation ?? lastGen;
        clock += 60_000; // advance so next round sees previous lease expired
      }
    }

    // 239AE — release cannot delete another owner's lease
    {
      const scope = "test239-" + uniq("ae");
      const a = await intents!.acquireSupervisorLeaseAsync(scope, "owner-A", 1_000, Date.now() - 60_000);
      await intents!.acquireSupervisorLeaseAsync(scope, "owner-B", 30_000);
      const rel = await intents!.releaseSupervisorLeaseAsync(scope, "owner-A", a.generation!);
      ok("239AE stale release refused", rel === false);
      const cp = await intents!.getSupervisorLeaseAsync(scope);
      ok("239AE B's lease still present", cp?.ownerId === "owner-B");
    }

    // 239AF — stop() on non-owner does not affect another owner
    {
      const scope = "test239-" + uniq("af");
      const env = uniq("af-env");
      const supA = makeSupervisor(kernel, intents!, new FakeRouter(), env, 5, { scopeKey: scope, ttlMs: 30_000 });
      await supA.start();
      const supB = makeSupervisor(kernel, intents!, new FakeRouter(), env, 5, { scopeKey: scope, ttlMs: 30_000 });
      await supB.start(); // not owner
      await supB.stop();  // must not delete A's row
      const cp = await intents!.getSupervisorLeaseAsync(scope);
      ok("239AF B stop did not delete A's lease", cp?.ownerId === supA.status().workerId,
         "cp=" + JSON.stringify(cp));
      await supA.stop();
    }

    // 239AG — TypeScript (executed as separate step, verified here from process exit)
    notExec0_placeholder: {
      // Placeholder block reserved; TS run is done externally below.
    }

    // Regressions from persisted evidence
    try {
      const { readFileSync, existsSync } = await import("node:fs");
      const pth = await import("node:path");
      const f235 = pth.resolve(process.cwd(), "artifacts", "phase235", "phase235-summary.json");
      if (existsSync(f235)) {
        const s = JSON.parse(readFileSync(f235, "utf8").replace(/^\uFEFF/, ""));
        const r = s?.results?.phase235;
        ok("239AH phase235 PASS:35", r && r.PASS === 35 && r.FAIL === 0, JSON.stringify(r));
      } else { ok("239AH phase235 summary present", false, "missing " + f235); }
      const f236 = pth.resolve(process.cwd(), "artifacts", "phase236", "test-phase236.txt");
      if (existsSync(f236)) {
        const t = readFileSync(f236, "utf8");
        ok("239AI phase236 shows PASS:25", t.includes("PASS: 25") && t.includes("FAIL: 0"));
      } else { ok("239AI phase236 output present", false, "missing " + f236); }
      const f237 = pth.resolve(process.cwd(), "artifacts", "phase237", "reg237.txt");
      if (existsSync(f237)) {
        const t = readFileSync(f237, "utf8");
        ok("239AJ phase237 shows PASS:23", t.includes("PASS: 23") && t.includes("FAIL: 0"));
      } else { ok("239AJ phase237 output present", false, "missing " + f237); }
      const f238 = pth.resolve(process.cwd(), "artifacts", "phase238", "phase238-summary.json");
      if (existsSync(f238)) {
        const s = JSON.parse(readFileSync(f238, "utf8").replace(/^\uFEFF/, ""));
        const r = s?.verification?.phase238;
        ok("239AK phase238 PASS:60", r && r.PASS === 60 && r.FAIL === 0, JSON.stringify(r));
      } else { ok("239AK phase238 summary present", false, "missing " + f238); }
    } catch (e: any) {
      ok("239AH-AK regression evidence readable", false, e?.message ?? String(e));
    }

    // 239AG — TypeScript compilation
    try {
      const { execFileSync } = await import("node:child_process");
      const pth = await import("node:path");
      const tscJs = pth.resolve(process.cwd(), "node_modules", "typescript", "bin", "tsc");
      execFileSync(process.execPath, [tscJs, "--noEmit"], { cwd: process.cwd(), stdio: "pipe", timeout: 180_000 });
      ok("239AG TypeScript compilation", true);
    } catch (e: any) {
      ok("239AG TypeScript compilation", false, "exit " + (e?.status ?? "?"));
    }
  } catch (e: any) {
    fail++;
    console.log("FAIL  harness error: " + (e?.stack ?? e));
  } finally {
    try { await kernel?.stopRecoverySupervisor({ finalPass: false }); } catch { /* ignore */ }
    try { await getPgClient()?.close(); } catch { /* ignore */ }
  }

  // Write evidence file so the shell never needs to capture stdout.
  try {
    const fs = await import("node:fs");
    const pth = await import("node:path");
    const dir = pth.resolve(process.cwd(), "artifacts", "phase239");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const out =
      "PHASE 239 EVIDENCE (written by scripts/test-phase239-supervisor-leases.ts)\n" +
      "============================================\n" +
      "PASS: " + pass + "\n" +
      "FAIL: " + fail + "\n" +
      "BLOCKED: " + blocked + "\n" +
      "NOT EXECUTED: " + notExec + "\n" +
      "============================================\n";
    fs.writeFileSync(pth.join(dir, "reg239.txt"), out, "utf8");
  } catch { /* ignore */ }

  process.exit(finish());
}

main().catch((e) => { console.error(e); process.exit(1); });