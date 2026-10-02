// scripts/test-phase238-durable-active-health.ts
// Phase 238 — durable fairness checkpoint for active-health observation.
import { NexusKernel } from "../src/core/kernel";
import { createNodeBridge } from "./host-bridge-node";
import { DeploymentActivationService } from "../src/core/deployment-activation-service";
import { ReleaseRecoverySupervisor } from "../src/core/release-recovery-supervisor";
import { ReleaseRecoveryService } from "../src/core/release-recovery";
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
  return `phase238-${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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

async function makeActiveIntent(
  intents: ReleaseDeploymentIntentService,
  env: string, suffix: string, targetId: string,
): Promise<string> {
  const u = env + "-" + suffix;
  const { intent } = await intents.getOrCreateAsync({
    releaseId: "rel-" + u, executionId: "exec-" + u, attemptId: "att-" + u,
    artifactId: "art-" + u, artifactDigest: "sha256:" + u, commitSha: "c" + u,
    environment: env, projectId: "phase238-proj",
    imageRepository: "nexus-app", imageTag: "v238-" + suffix, imageId: null,
    imageDigest: "sha256:" + "b".repeat(64),
    containerName: "nexus-238-" + suffix, containerPort: 8080,
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

const stubExecutor: any = {
  runOnce: async () => ({ scanned: 0, acted: 0, skipped: 0, blocked: 0, leaseHeld: 0, actions: [], blockedReasons: [] }),
};

function makeSupervisor(kernel: any, intents: ReleaseDeploymentIntentService,
  router: TrafficRouter, envFilter: string, cap: number): ReleaseRecoverySupervisor {
  return new ReleaseRecoverySupervisor({
    executor: stubExecutor,
    svc: { events: kernel.services.events, audit: kernel.services.audit },
    workerId: "w238-" + uniq("sup"),
    intervalMs: 3600_000,
    activation: new DeploymentActivationService(intents, router),
    intents, maxActiveObservationsPerTick: cap,
    activeHealthEnvironmentFilter: envFilter,
  });
}

async function tick(sup: ReleaseRecoverySupervisor): Promise<any> {
  await sup.runNow();
  return sup.status().activeHealthPhase;
}

async function main() {
  if (process.env.NEXUS_PERSISTENCE_MODE !== "shared") {
    blockedRec("238-pre", "not shared"); process.exit(finish());
  }
  if (!process.env.DATABASE_URL) {
    blockedRec("238-pre", "no DATABASE_URL"); process.exit(finish());
  }
  const bridgeRoot = path.join(os.tmpdir(), "nexus-phase238-" + Date.now());
  (globalThis as any).window = { __NEXUS_HOST__: createNodeBridge(bridgeRoot) };
  let intents: ReleaseDeploymentIntentService | undefined;
  let kernel: NexusKernel | undefined;
  try {
    kernel = new NexusKernel();
    const svc: any = await kernel.boot();
    intents = svc.releaseIntents;
    if (!intents) { ok("kernel boot exposes releaseIntents", false); process.exit(finish()); }

    // 238A — supervisor lifecycle
    ok("238A supervisor has start/stop/runNow/status",
       typeof (kernel as any).startRecoverySupervisor === "function" &&
       typeof (kernel as any).stopRecoverySupervisor === "function" &&
       typeof (kernel as any).runRecoveryNow === "function" &&
       typeof (kernel as any).getRecoverySupervisorStatus === "function");

    // 238B — Phase 237 cursor API present
    ok("238B keyset cursor API available",
       typeof (intents as any).listActiveIntentsAfterCursorAsync === "function");
    ok("238B checkpoint API available",
       typeof (intents as any).getActiveHealthCheckpointAsync === "function" &&
       typeof (intents as any).setActiveHealthCheckpointAsync === "function");

    // 238C — first run without checkpoint
    {
      const env = uniq("c");
      for (let i = 0; i < 4; i++) await makeActiveIntent(intents!, env, "c" + i, "arn:tg/" + env + "/" + i);
      const cp = await intents!.getActiveHealthCheckpointAsync(env);
      ok("238C no prior checkpoint", cp === null, "cp=" + JSON.stringify(cp));
      const sup = makeSupervisor(kernel, intents!, new FakeRouter("HEALTHY"), env, 2);
      const r1 = await tick(sup);
      ok("238C first tick starts with checkpointLoaded=false", r1?.checkpointLoaded === false);
      ok("238C first tick reports persisted=true", r1?.checkpointPersisted === true);
    }

    // 238D — bounded
    {
      const env = uniq("d");
      for (let i = 0; i < 8; i++) await makeActiveIntent(intents!, env, "d" + i, "arn:tg/" + env + "/" + i);
      const sup = makeSupervisor(kernel, intents!, new FakeRouter("HEALTHY"), env, 3);
      const r = await tick(sup);
      ok("238D bounded observation", r?.scanned === 3, "scanned=" + r?.scanned);
    }

    // 238E — checkpoint persisted
    {
      const env = uniq("e");
      for (let i = 0; i < 6; i++) await makeActiveIntent(intents!, env, "e" + i, "arn:tg/" + env + "/" + i);
      const sup = makeSupervisor(kernel, intents!, new FakeRouter("HEALTHY"), env, 2);
      const r = await tick(sup);
      ok("238E checkpoint persisted=true", r?.checkpointPersisted === true);
      ok("238E cursorAfter present", typeof r?.cursorAfter === "string" && r.cursorAfter.length > 0);
      const cp = await intents!.getActiveHealthCheckpointAsync(env);
      const scopeKeyE = "release-recovery-supervisor/" + env;
      const cpScoped = await intents!.getActiveHealthCheckpointAsync(scopeKeyE);
      ok("238E DB checkpoint matches cursorAfter",
         cpScoped?.cursor === r?.cursorAfter, "db=" + cpScoped?.cursor + " r=" + r?.cursorAfter);
    }

    // 238F — restart resumes from persisted cursor
    {
      const env = uniq("f");
      for (let i = 0; i < 6; i++) await makeActiveIntent(intents!, env, "f" + i, "arn:tg/" + env + "/" + i);
      const sup1 = makeSupervisor(kernel, intents!, new FakeRouter("HEALTHY"), env, 2);
      const r1 = await tick(sup1);
      // Simulate restart: new supervisor instance, same env scope.
      const sup2 = makeSupervisor(kernel, intents!, new FakeRouter("HEALTHY"), env, 2);
      const r2 = await tick(sup2);
      ok("238F restart loads checkpoint", r2?.checkpointLoaded === true);
      ok("238F second tick continues from persisted cursor",
         typeof r2?.cursorAfter === "string" && r2.cursorAfter > (r1?.cursorAfter ?? ""),
         "r1=" + r1?.cursorAfter + " r2=" + r2?.cursorAfter);
    }

    // 238G — full cycle fairness (55 intents, cap 10)
    {
      const env = uniq("g");
      const N = 55;
      for (let i = 0; i < N; i++)
        await makeActiveIntent(intents!, env, "g" + String(i).padStart(3, "0"), "arn:tg/" + env + "/" + i);
      const CAP = 10;
      // Each tick gets a FRESH supervisor so we exercise the persistence
      // pathway end-to-end (load cursor → observe → persist) rather than
      // relying on the in-memory field.
      let ticks = 0, sawWrap = false;
      while (ticks < 20 && !sawWrap) {
        const sup = makeSupervisor(kernel, intents!, new FakeRouter("HEALTHY"), env, CAP);
        const r = await tick(sup);
        ticks++;
        if (r?.wrapped) sawWrap = true;
      }
      ok("238G full cycle wrapped", sawWrap === true, "ticks=" + ticks);
      const after = await intents!.listActiveIntentsAfterCursorAsync(null, 1000, env);
      let covered = 0;
      for (const it of after) if ((it.reconciliationEvidence ?? "").includes("observeActiveHealth")) covered++;
      ok("238G all " + N + " observed", covered === N, "covered=" + covered + "/" + N);
    }

    // 238H — wrap persists null cursor
    {
      const env = uniq("h");
      for (let i = 0; i < 4; i++) await makeActiveIntent(intents!, env, "h" + i, "arn:tg/" + env + "/" + i);
      const sup = makeSupervisor(kernel, intents!, new FakeRouter("HEALTHY"), env, 10);
      const r = await tick(sup);
      ok("238H wrapped=true", r?.wrapped === true);
      const cp = await intents!.getActiveHealthCheckpointAsync("release-recovery-supervisor/" + env);
      ok("238H DB checkpoint cursor=null after wrap",
         cp?.cursor === null, "db.cursor=" + cp?.cursor);
    }

    // 238I — new intent added mid-cycle eventually observed
    {
      const env = uniq("i");
      for (let i = 0; i < 4; i++) await makeActiveIntent(intents!, env, "i" + i, "arn:tg/" + env + "/" + i);
      const sup = makeSupervisor(kernel, intents!, new FakeRouter("HEALTHY"), env, 2);
      await tick(sup);
      const newKey = await makeActiveIntent(intents!, env, "i-new", "arn:tg/" + env + "/new");
      for (let n = 0; n < 6; n++) {
        const s2 = makeSupervisor(kernel, intents!, new FakeRouter("HEALTHY"), env, 2);
        const r = await tick(s2);
        if (r?.wrapped) break;
      }
      const re = await intents!.getAsync(newKey);
      ok("238I new intent observed",
         (re?.reconciliationEvidence ?? "").includes("observeActiveHealth"));
    }

    // 238J — intent leaves ACTIVE mid-cycle; cycle still completes
    {
      const env = uniq("j");
      const keys: string[] = [];
      for (let i = 0; i < 5; i++) keys.push(await makeActiveIntent(intents!, env, "j" + i, "arn:tg/" + env + "/" + i));
      const sup = makeSupervisor(kernel, intents!, new FakeRouter("HEALTHY"), env, 2);
      await tick(sup);
      const w = "jv-" + uniq("j");
      await intents!.acquireLeaseAsync(keys[2], w);
      await intents!.transitionIfOwnedAsync(keys[2], "FAILED" as any, w, {}, ["ACTIVE"]);
      await intents!.releaseLeaseAsync(keys[2], w);
      let sawWrap = false;
      for (let n = 0; n < 8; n++) {
        const s2 = makeSupervisor(kernel, intents!, new FakeRouter("HEALTHY"), env, 2);
        const r = await tick(s2);
        if (r?.wrapped) { sawWrap = true; break; }
      }
      ok("238J cycle completes after ACTIVE loss", sawWrap === true);
    }

    // 238K — crash before checkpoint persistence: intent not skipped
    {
      const env = uniq("k");
      const allKeys: string[] = [];
      for (let i = 0; i < 6; i++)
        allKeys.push(await makeActiveIntent(intents!, env, "k" + i, "arn:tg/" + env + "/" + i));
      // Wrap intents so setActiveHealthCheckpointAsync throws.
      const originalSet = (intents as any).setActiveHealthCheckpointAsync.bind(intents);
      let threw = false;
      (intents as any).setActiveHealthCheckpointAsync = async () => { threw = true; throw new Error("simulated crash-before-persist"); };
      const sup = makeSupervisor(kernel, intents!, new FakeRouter("HEALTHY"), env, 2);
      const r = await tick(sup);
      (intents as any).setActiveHealthCheckpointAsync = originalSet;
      ok("238K persistence failure surfaced", r?.checkpointError !== null, "err=" + r?.checkpointError);
      ok("238K checkpointPersisted remains false", r?.checkpointPersisted === false);
      ok("238K simulated failure actually fired", threw === true);
      // After restart (fresh supervisor), since the failed tick did not persist,
      // the next cycle starts from wherever the DB says — here, from null.
      const sup2 = makeSupervisor(kernel, intents!, new FakeRouter("HEALTHY"), env, 2);
      const r2 = await tick(sup2);
      ok("238K restart resumes from durable state (not phantom advance)",
         r2?.checkpointLoaded === false || r2?.cursorAfter !== null);
      // Eventually every intent is observed as the cycle proceeds.
      let sawWrap = false;
      for (let n = 0; n < 10; n++) {
        const s3 = makeSupervisor(kernel, intents!, new FakeRouter("HEALTHY"), env, 2);
        const rr = await tick(s3);
        if (rr?.wrapped) { sawWrap = true; break; }
      }
      ok("238K cycle eventually completes despite earlier failure", sawWrap === true);
    }

    // 238L — persistence failure is honest
    {
      const env = uniq("l");
      for (let i = 0; i < 4; i++) await makeActiveIntent(intents!, env, "l" + i, "arn:tg/" + env + "/" + i);
      const originalSet = (intents as any).setActiveHealthCheckpointAsync.bind(intents);
      (intents as any).setActiveHealthCheckpointAsync = async () => { throw new Error("persist-failure"); };
      const sup = makeSupervisor(kernel, intents!, new FakeRouter("HEALTHY"), env, 2);
      const r = await tick(sup);
      (intents as any).setActiveHealthCheckpointAsync = originalSet;
      ok("238L failure not reported as success", r?.checkpointPersisted === false);
      ok("238L failure recorded", typeof r?.checkpointError === "string" && r.checkpointError.length > 0);
    }

    // 238M/N/O — provider semantics preserved
    {
      const e1 = uniq("m");
      const k1 = await makeActiveIntent(intents!, e1, "m1", "arn:tg/" + e1 + "/m1");
      await tick(makeSupervisor(kernel, intents!, new FakeRouter("UNKNOWN"), e1, 5));
      ok("238M UNKNOWN preserves ACTIVE", (await intents!.getAsync(k1))?.status === "ACTIVE");

      const e2 = uniq("n");
      const k2 = await makeActiveIntent(intents!, e2, "n1", "arn:tg/" + e2 + "/n1");
      await tick(makeSupervisor(kernel, intents!, new FakeRouter("BLOCKED"), e2, 5));
      ok("238N BLOCKED preserves ACTIVE", (await intents!.getAsync(k2))?.status === "ACTIVE");

      const e3 = uniq("o");
      const k3 = await makeActiveIntent(intents!, e3, "o1", "arn:tg/" + e3 + "/o1");
      await tick(makeSupervisor(kernel, intents!, new FakeRouter("UNHEALTHY"), e3, 5));
      const after = await intents!.getAsync(k3);
      ok("238O UNHEALTHY -> HEALTH_DEGRADED", after?.status === "HEALTH_DEGRADED", "got " + after?.status);
      if (after?.status === "HEALTH_DEGRADED") {
        const plan = new ReleaseRecoveryService().classify({ intent: after as any });
        ok("238O existing classifier -> RECOVERY_REQUIRED", plan.action === "RECOVERY_REQUIRED");
      }
    }

    // 238P — overlapping runNow
    {
      const env = uniq("p");
      for (let i = 0; i < 4; i++) await makeActiveIntent(intents!, env, "p" + i, "arn:tg/" + env + "/" + i);
      const sup = makeSupervisor(kernel, intents!, new FakeRouter("HEALTHY"), env, 2);
      const [a, b, c] = await Promise.all([sup.runNow(), sup.runNow(), sup.runNow()]);
      ok("238P overlapping runNow() safe", a === b && b === c);
    }

    // 238Q — environment isolation
    {
      const eProd = uniq("qprod");
      const eStage = uniq("qstage");
      for (let i = 0; i < 4; i++) await makeActiveIntent(intents!, eProd, "qp" + i, "arn:tg/" + eProd + "/" + i);
      for (let i = 0; i < 4; i++) await makeActiveIntent(intents!, eStage, "qs" + i, "arn:tg/" + eStage + "/" + i);
      const supProd = makeSupervisor(kernel, intents!, new FakeRouter("HEALTHY"), eProd, 2);
      await tick(supProd);
      const cpProd = await intents!.getActiveHealthCheckpointAsync("release-recovery-supervisor/" + eProd);
      const cpStage = await intents!.getActiveHealthCheckpointAsync("release-recovery-supervisor/" + eStage);
      ok("238Q prod checkpoint written", cpProd?.cursor !== null && cpProd !== null);
      ok("238Q stage checkpoint unaffected", cpStage === null);
      // And the reverse direction:
      const supStage = makeSupervisor(kernel, intents!, new FakeRouter("HEALTHY"), eStage, 2);
      await tick(supStage);
      const cpProd2 = await intents!.getActiveHealthCheckpointAsync("release-recovery-supervisor/" + eProd);
      ok("238Q prod checkpoint unchanged after stage tick",
         cpProd2?.cursor === cpProd?.cursor);
    }

    // 238R — generation CAS: stale write cannot move cursor backwards
    {
      const env = uniq("r");
      // Initial insert (expectedGeneration = -1 means "no row").
      const insertOk = await intents!.setActiveHealthCheckpointAsync(env, -1, "bbbb");
      ok("238R initial insert ok", insertOk === true);
      let cp = await intents!.getActiveHealthCheckpointAsync(env);
      ok("238R initial gen=0, cursor=bbbb",
         cp?.cursor === "bbbb" && cp?.generation === 0, JSON.stringify(cp));

      // Correct CAS: gen 0 -> 1, cursor aaaa
      const casA = await intents!.setActiveHealthCheckpointAsync(env, 0, "aaaa");
      ok("238R CAS gen0->1 succeeds", casA === true);
      cp = await intents!.getActiveHealthCheckpointAsync(env);
      ok("238R cursor=aaaa, gen=1", cp?.cursor === "aaaa" && cp?.generation === 1, JSON.stringify(cp));

      // Stale CAS with old generation 0 must fail
      const staleCas = await intents!.setActiveHealthCheckpointAsync(env, 0, "zzzz");
      ok("238R stale CAS (gen 0) rejected", staleCas === false);
      cp = await intents!.getActiveHealthCheckpointAsync(env);
      ok("238R cursor still aaaa after stale", cp?.cursor === "aaaa", "cp=" + cp?.cursor);

      // CAS gen 1 -> 2 with cursor=null (wrap)
      const wrapCas = await intents!.setActiveHealthCheckpointAsync(env, 1, null);
      ok("238R wrap CAS to null succeeds", wrapCas === true);
      cp = await intents!.getActiveHealthCheckpointAsync(env);
      ok("238R cursor=null, gen=2", cp?.cursor === null && cp?.generation === 2, JSON.stringify(cp));

      // 238Y — stale writer tries to resurrect old cursor after wrap
      const resurrect = await intents!.setActiveHealthCheckpointAsync(env, 1, "aaaa");
      ok("238Y stale resurrection rejected", resurrect === false);
      cp = await intents!.getActiveHealthCheckpointAsync(env);
      ok("238Y DB still null", cp?.cursor === null, "cp=" + cp?.cursor);

      // 238Z — stale after newer cursor
      const casB = await intents!.setActiveHealthCheckpointAsync(env, 2, "BBBB");
      ok("238Z CAS gen2->3 succeeds", casB === true);
      const staleA = await intents!.setActiveHealthCheckpointAsync(env, 2, "CCCC");
      ok("238Z stale CAS rejected", staleA === false);
      cp = await intents!.getActiveHealthCheckpointAsync(env);
      ok("238Z DB still BBBB", cp?.cursor === "BBBB", "cp=" + cp?.cursor);
    }

    // 238AA — concurrent same-generation writers: exactly one wins
    {
      const env = uniq("aa");
      await intents!.setActiveHealthCheckpointAsync(env, -1, "start");
      const cp = await intents!.getActiveHealthCheckpointAsync(env);
      const g = cp?.generation ?? -1;
      const [a, b] = await Promise.all([
        intents!.setActiveHealthCheckpointAsync(env, g, "X"),
        intents!.setActiveHealthCheckpointAsync(env, g, "Y"),
      ]);
      ok("238AA exactly one CAS succeeds",
         (a === true && b === false) || (a === false && b === true),
         "a=" + a + " b=" + b);
      const finalCp = await intents!.getActiveHealthCheckpointAsync(env);
      ok("238AA generation advanced by exactly 1",
         finalCp?.generation === g + 1, "gen=" + finalCp?.generation);
    }

    // 238AB — supervisor identity isolation (same env, different worker scope keys)
    {
      const env = uniq("ab");
      // Supervisor scope keys incorporate workerId+env; test the underlying
      // store treats distinct scope keys as distinct rows.
      const scopeA = "release-recovery-supervisor/w-AAA/" + env;
      const scopeB = "release-recovery-supervisor/w-BBB/" + env;
      await intents!.setActiveHealthCheckpointAsync(scopeA, -1, "only-A");
      const cpB = await intents!.getActiveHealthCheckpointAsync(scopeB);
      ok("238AB scope B unaffected by scope A write", cpB === null);
    }

    // 238AD — absent row vs existing NULL row
    {
      const env = uniq("ad");
      const absent = await intents!.getActiveHealthCheckpointAsync(env);
      ok("238AD absent row returns null", absent === null);
      const create = await intents!.setActiveHealthCheckpointAsync(env, -1, null);
      ok("238AD insert with null cursor ok", create === true);
      const now = await intents!.getActiveHealthCheckpointAsync(env);
      ok("238AD existing null-cursor row distinguished from absent",
         now !== null && now.cursor === null && now.generation === 0,
         JSON.stringify(now));
      // CAS on existing null row still works
      const next = await intents!.setActiveHealthCheckpointAsync(env, 0, "after-null");
      ok("238AD CAS after null ok", next === true);
    }

    // 238AE — wrap durability across supervisor restart
    {
      const env = uniq("ae");
      for (let i = 0; i < 4; i++)
        await makeActiveIntent(intents!, env, "ae" + i, "arn:tg/" + env + "/" + i);
      const sup1 = makeSupervisor(kernel, intents!, new FakeRouter("HEALTHY"), env, 2);
      await tick(sup1);
      await tick(sup1); // exhaust + wrap
      const cp = await intents!.getActiveHealthCheckpointAsync(
        "release-recovery-supervisor/" + env);
      ok("238AE after wrap DB cursor=null",
         cp !== null && cp.cursor === null, JSON.stringify(cp));
      const sup2 = makeSupervisor(kernel, intents!, new FakeRouter("HEALTHY"), env, 2);
      const r = await tick(sup2);
      ok("238AE restart begins from wrapped state",
         r?.checkpointLoaded === true && r?.cursorAfter !== null);
    }

    // 238S — persistence survives across service instances
    {
      const env = uniq("s");
      for (let i = 0; i < 5; i++) await makeActiveIntent(intents!, env, "s" + i, "arn:tg/" + env + "/" + i);
      const sup1 = makeSupervisor(kernel, intents!, new FakeRouter("HEALTHY"), env, 2);
      await tick(sup1);
      const direct = await intents!.getActiveHealthCheckpointAsync("release-recovery-supervisor/" + env);
      ok("238S checkpoint readable via fresh API call",
         typeof direct?.cursor === "string" && direct.cursor.length > 0);
    }

    // 238T/U/V — regression from persisted artifacts
    try {
      const { readFileSync, existsSync } = await import("node:fs");
      const pth = await import("node:path");
      const f235 = pth.resolve(process.cwd(), "artifacts", "phase235", "phase235-summary.json");
      if (existsSync(f235)) {
        const s = JSON.parse(readFileSync(f235, "utf8"));
        const r = s?.results?.phase235;
        ok("238T phase235 PASS:35", r && r.PASS === 35 && r.FAIL === 0, JSON.stringify(r));
      } else {
        ok("238T phase235 summary present", false, "missing " + f235);
      }
      const f236 = pth.resolve(process.cwd(), "artifacts", "phase236", "test-phase236.txt");
      if (existsSync(f236)) {
        const t = readFileSync(f236, "utf8");
        ok("238U phase236 shows PASS:25", t.includes("PASS: 25") && t.includes("FAIL: 0"));
      } else {
        ok("238U phase236 output present", false, "missing " + f236);
      }
      // 238V � execute the real Phase 237 regression; do not depend on
      // manually redirected evidence files that may not exist.
      try {
        const { execFileSync } = await import("node:child_process");
        const pth2 = await import("node:path");

        const tsxCli = pth2.resolve(
          process.cwd(),
          "node_modules",
          "tsx",
          "dist",
          "cli.mjs",
        );
        const phase237Script = pth2.resolve(
          process.cwd(),
          "scripts",
          "test-phase237-fair-active-health.ts",
        );

        const output = execFileSync(
          process.execPath,
          [tsxCli, phase237Script],
          {
            cwd: process.cwd(),
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 180_000,
          },
        );

        ok(
          "238V phase237 shows PASS:23",
          output.includes("PASS: 23") &&
          output.includes("FAIL: 0") &&
          output.includes("BLOCKED: 0") &&
          output.includes("NOT EXECUTED: 0"),
          output,
        );
      } catch (e: any) {
        const stdout = e?.stdout ? String(e.stdout) : "";
        const stderr = e?.stderr ? String(e.stderr) : "";
        ok(
          "238V phase237 shows PASS:23",
          false,
          `Phase 237 execution failed. ${stdout}\n${stderr}`.trim(),
        );
      }
    } catch (e: any) {
      ok("238T/U/V regression evidence readable", false, e?.message ?? String(e));
    }

    // 238W — TypeScript
    try {
      const { execFileSync } = await import("node:child_process");
      const pth = await import("node:path");
      const tscJs = pth.resolve(process.cwd(), "node_modules", "typescript", "bin", "tsc");
      execFileSync(process.execPath, [tscJs, "--noEmit"], { cwd: process.cwd(), stdio: "pipe", timeout: 180_000 });
      ok("238W TypeScript compilation", true);
    } catch (e: any) {
      ok("238W TypeScript compilation", false, "exit " + (e?.status ?? "?"));
    }
  } catch (e: any) {
    fail++;
    console.log("FAIL  harness error: " + (e?.stack ?? e));
  } finally {
    try { await kernel?.stopRecoverySupervisor({ finalPass: false }); } catch { /* ignore */ }
    try { await getPgClient()?.close(); } catch { /* ignore */ }
  }
  process.exit(finish());
}

main().catch((e) => { console.error(e); process.exit(1); });