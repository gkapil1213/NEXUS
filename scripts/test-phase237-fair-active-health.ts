// scripts/test-phase237-fair-active-health.ts
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
  // Phase 238: write our own summary evidence file so shell redirection
  // quirks (PowerShell 5.1 dropping native stderr) can't corrupt it.
  try {
    const fs = require("node:fs");
    const path = require("node:path");
    const dir = path.resolve(process.cwd(), "artifacts", "phase237");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const out =
      "PHASE 237 EVIDENCE (written by scripts/test-phase237-fair-active-health.ts)\n" +
      "============================================\n" +
      "PASS: " + pass + "\n" +
      "FAIL: " + fail + "\n" +
      "BLOCKED: " + blocked + "\n" +
      "NOT EXECUTED: " + notExec + "\n" +
      "============================================\n";
    fs.writeFileSync(path.join(dir, "reg237.txt"), out, "utf8");
  } catch { /* evidence write failure must not change test result */ }
  return fail > 0 ? 1 : 0;
}
function uniq(tag: string): string {
  return `phase237-${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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
    environment: env, projectId: "phase237-proj",
    imageRepository: "nexus-app", imageTag: "v237-" + suffix, imageId: null,
    imageDigest: "sha256:" + "b".repeat(64),
    containerName: "nexus-237-" + suffix, containerPort: 8080,
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
    workerId: "w237-" + uniq("sup"),
    intervalMs: 3600_000,
    activation: new DeploymentActivationService(intents, router),
    intents, maxActiveObservationsPerTick: cap,
    activeHealthEnvironmentFilter: envFilter,
  });
}

// Phase 237: the supervisor's runNow() returns the RECOVERY report.
// The active-health phase report is exposed via status().activeHealthPhase.
async function tick(sup: ReleaseRecoverySupervisor): Promise<any> {
  await sup.runNow();
  return sup.status().activeHealthPhase;
}

async function main() {
  if (process.env.NEXUS_PERSISTENCE_MODE !== "shared") {
    blockedRec("237-pre", "not shared"); process.exit(finish());
  }
  if (!process.env.DATABASE_URL) {
    blockedRec("237-pre", "no DATABASE_URL"); process.exit(finish());
  }
  const bridgeRoot = path.join(os.tmpdir(), "nexus-phase237-" + Date.now());
  (globalThis as any).window = { __NEXUS_HOST__: createNodeBridge(bridgeRoot) };
  let intents: ReleaseDeploymentIntentService | undefined;
  let kernel: NexusKernel | undefined;
  try {
    kernel = new NexusKernel();
    const svc: any = await kernel.boot();
    intents = svc.releaseIntents;
    if (!intents) { ok("kernel boot exposes releaseIntents", false); process.exit(finish()); }

    ok("237A supervisor lifecycle methods present",
       typeof (kernel as any).startRecoverySupervisor === "function" &&
       typeof (kernel as any).getRecoverySupervisorStatus === "function");
    ok("237A intent service exposes cursor API",
       typeof (intents as any).listActiveIntentsAfterCursorAsync === "function");

    // 237B / 237E
    {
      const env = uniq("b");
      for (let i = 0; i < 15; i++) await makeActiveIntent(intents!, env, "b" + String(i).padStart(3,"0"), "arn:tg/" + env + "/" + i);
      const sup = makeSupervisor(kernel, intents!, new FakeRouter("HEALTHY"), env, 5);
      const r1 = await tick(sup);
      ok("237B first tick bounded by cap", r1?.scanned === 5, "scanned=" + r1?.scanned);
      ok("237E cap reached with more remaining", r1?.capReached === true, "capReached=" + r1?.capReached);
      ok("237E cursor advanced", typeof r1?.cursorAfter === "string" && r1.cursorAfter.length > 0);
    }

    // 237C
    {
      const env = uniq("c");
      for (let i = 0; i < 3; i++) await makeActiveIntent(intents!, env, "c" + i, "arn:tg/" + env + "/" + i);
      const sup = makeSupervisor(kernel, intents!, new FakeRouter("HEALTHY"), env, 10);
      const r = await tick(sup);
      ok("237C fewer than cap → all observed, wrapped",
         r?.scanned === 3 && r?.wrapped === true && r?.capReached === false,
         "s=" + r?.scanned + " w=" + r?.wrapped + " c=" + r?.capReached);
    }

    // 237D
    {
      const env = uniq("d");
      for (let i = 0; i < 5; i++) await makeActiveIntent(intents!, env, "d" + i, "arn:tg/" + env + "/" + i);
      const sup = makeSupervisor(kernel, intents!, new FakeRouter("HEALTHY"), env, 5);
      const r = await tick(sup);
      ok("237D exactly cap → all observed, wrapped",
         r?.scanned === 5 && r?.wrapped === true && r?.capReached === false,
         "s=" + r?.scanned + " w=" + r?.wrapped + " c=" + r?.capReached);
    }

    // 237F/G/H — >50 intents
    {
      const env = uniq("fgh");
      const N = 55;
      for (let i = 0; i < N; i++)
        await makeActiveIntent(intents!, env, "fgh" + String(i).padStart(3,"0"), "arn:tg/" + env + "/" + i);
      const CAP = 10;
      const sup = makeSupervisor(kernel, intents!, new FakeRouter("HEALTHY"), env, CAP);
      const cursors: (string|null)[] = [];
      let ticks = 0, sawWrap = false;
      while (ticks < 30 && !sawWrap) {
        const r = await tick(sup);
        ticks++; cursors.push(r?.cursorAfter ?? null);
        if (r?.wrapped) sawWrap = true;
      }
      ok("237F multiple ticks needed (>50 with cap=10)", ticks >= 5 && ticks < 30, "ticks=" + ticks);
      ok("237H second cursor differs from first",
         cursors.length >= 2 && cursors[0] !== cursors[1]);
      ok("237G full cycle wrapped", sawWrap === true, "ticks=" + ticks);

      const after = await intents!.listActiveIntentsAfterCursorAsync(null, 1000, env);
      let covered = 0;
      for (const it of after) if ((it.reconciliationEvidence ?? "").includes("observeActiveHealth")) covered++;
      ok("237G all " + N + " intents observed", covered === N, "covered=" + covered + "/" + N);
    }

    // 237I — new intent after cycle begins
    {
      const env = uniq("i");
      for (let i = 0; i < 6; i++) await makeActiveIntent(intents!, env, "i" + i, "arn:tg/" + env + "/" + i);
      const sup = makeSupervisor(kernel, intents!, new FakeRouter("HEALTHY"), env, 3);
      await tick(sup);
      const newKey = await makeActiveIntent(intents!, env, "i-new", "arn:tg/" + env + "/new");
      for (let i = 0; i < 10; i++) { const r = await tick(sup); if (r?.wrapped) break; }
      const re = await intents!.getAsync(newKey);
      ok("237I new intent observed",
         (re?.reconciliationEvidence ?? "").includes("observeActiveHealth"));
    }

    // 237K — intent leaves ACTIVE mid-cycle
    {
      const env = uniq("k");
      const keys: string[] = [];
      for (let i = 0; i < 6; i++) keys.push(await makeActiveIntent(intents!, env, "k" + i, "arn:tg/" + env + "/" + i));
      const sup = makeSupervisor(kernel, intents!, new FakeRouter("HEALTHY"), env, 3);
      await tick(sup);
      const w = "kv-" + uniq("k");
      await intents!.acquireLeaseAsync(keys[1], w);
      await intents!.transitionIfOwnedAsync(keys[1], "FAILED" as any, w, {}, ["ACTIVE"]);
      await intents!.releaseLeaseAsync(keys[1], w);
      let ticks = 0, wrapped = false;
      while (ticks++ < 10 && !wrapped) { const r = await tick(sup); if (r?.wrapped) wrapped = true; }
      ok("237K cycle completes despite ACTIVE loss", wrapped === true, "ticks=" + ticks);
    }

    // 237L — restart
    {
      const env = uniq("l");
      for (let i = 0; i < 6; i++) await makeActiveIntent(intents!, env, "l" + i, "arn:tg/" + env + "/" + i);
      const sup1 = makeSupervisor(kernel, intents!, new FakeRouter("HEALTHY"), env, 3);
      const r1 = await tick(sup1);
      const sup2 = makeSupervisor(kernel, intents!, new FakeRouter("HEALTHY"), env, 3);
      const r2 = await tick(sup2);
      ok("237L restart begins cycle",
         r1?.scanned === 3 && r2?.scanned === 3,
         "r1=" + r1?.scanned + " r2=" + r2?.scanned);
      // Phase 238 changed the restart semantics: a fresh supervisor now
      // loads the durable checkpoint and continues from it. With 6 intents
      // and cap=3, r1 observes [1..3] (cursor=key3), r2 loads that cursor,
      // observes [4..6] and wraps (cursor=null). The old in-memory assertion
      // that "r2 restarts at null" is obsolete — Phase 238 §8 mandates the
      // new resume-from-checkpoint behavior.
      ok("237L restart resumes from durable checkpoint",
         (r1?.cursorAfter !== null) && (r2?.cursorAfter === null || r2?.cursorAfter > r1?.cursorAfter),
         "r1.c=" + r1?.cursorAfter + " r2.c=" + r2?.cursorAfter);
    }

    // 237M — overlapping runNow
    {
      const env = uniq("m");
      for (let i = 0; i < 5; i++) await makeActiveIntent(intents!, env, "m" + i, "arn:tg/" + env + "/" + i);
      const sup = makeSupervisor(kernel, intents!, new FakeRouter("HEALTHY"), env, 2);
      const [a, b, c] = await Promise.all([sup.runNow(), sup.runNow(), sup.runNow()]);
      ok("237M overlapping runNow() identical in-flight result", a === b && b === c);
    }

    // 237N — UNKNOWN / BLOCKED preserve ACTIVE
    {
      const e1 = uniq("n1");
      const k1 = await makeActiveIntent(intents!, e1, "n1", "arn:tg/" + e1 + "/n1");
      await tick(makeSupervisor(kernel, intents!, new FakeRouter("UNKNOWN"), e1, 5));
      ok("237N UNKNOWN preserves ACTIVE", (await intents!.getAsync(k1))?.status === "ACTIVE");
      const e2 = uniq("n2");
      const k2 = await makeActiveIntent(intents!, e2, "n2", "arn:tg/" + e2 + "/n2");
      await tick(makeSupervisor(kernel, intents!, new FakeRouter("BLOCKED"), e2, 5));
      ok("237N BLOCKED preserves ACTIVE", (await intents!.getAsync(k2))?.status === "ACTIVE");
    }

    // 237O — UNHEALTHY
    {
      const env = uniq("o");
      const k = await makeActiveIntent(intents!, env, "o1", "arn:tg/" + env + "/o1");
      await tick(makeSupervisor(kernel, intents!, new FakeRouter("UNHEALTHY"), env, 5));
      const after = await intents!.getAsync(k);
      ok("237O UNHEALTHY -> HEALTH_DEGRADED", after?.status === "HEALTH_DEGRADED", "got " + after?.status);
      if (after?.status === "HEALTH_DEGRADED") {
        const plan = new ReleaseRecoveryService().classify({ intent: after as any });
        ok("237O existing classifier -> RECOVERY_REQUIRED", plan.action === "RECOVERY_REQUIRED");
      }
    }

    // 237P — phase235 / phase236 regression from persisted evidence
    try {
      const { readFileSync, existsSync } = await import("node:fs");
      const pth = await import("node:path");
      const f235 = pth.resolve(process.cwd(), "artifacts", "phase235", "phase235-summary.json");
      if (existsSync(f235)) {
        const s235 = JSON.parse(readFileSync(f235, "utf8"));
        const r235 = s235?.results?.phase235;
        ok("237P phase235 PASS:35", r235 && r235.PASS === 35 && r235.FAIL === 0, JSON.stringify(r235));
      } else {
        ok("237P phase235 summary present", false, "missing " + f235);
      }
      const f236 = pth.resolve(process.cwd(), "artifacts", "phase236", "test-phase236.txt");
      if (existsSync(f236)) {
        const t = readFileSync(f236, "utf8");
        ok("237P phase236 output shows PASS:25", t.includes("PASS: 25") && t.includes("FAIL: 0"),
           "phase236 text does not show PASS: 25 / FAIL: 0");
      } else {
        ok("237P phase236 test output present", false, "missing " + f236);
      }
    } catch (e: any) {
      ok("237P regression evidence readable", false, e?.message ?? String(e));
    }

    // 237Q — TypeScript
    try {
      const { execFileSync } = await import("node:child_process");
      const pth = await import("node:path");
      const tscJs = pth.resolve(process.cwd(), "node_modules", "typescript", "bin", "tsc");
      execFileSync(process.execPath, [tscJs, "--noEmit"], { cwd: process.cwd(), stdio: "pipe", timeout: 180_000 });
      ok("237Q TypeScript compilation", true);
    } catch (e: any) {
      ok("237Q TypeScript compilation", false, "exit " + (e?.status ?? "?"));
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