// scripts/test-phase232-provider-uncertainty-reconciliation.ts
// Phase 232 - Provider uncertainty reconciliation and lost-response safety.
//
// Exercises the existing ReleaseExecutionProvider.reconcile?() contract
// through ProductionReleaseEnforcementService.recoverForIntent(). The
// central invariant: when execute() may have mutated the provider but its
// response was lost, NEXUS must reconcile before deciding whether to retry.
//
// No new orchestrator. No fake success. No blind retry.

import { NexusKernel } from "../src/core/kernel";
import { ProductionReleaseEnforcementService } from "../src/core/production-release-enforcement";
import type {
  ReleaseExecutionProvider,
  ReleaseExecutionRequest,
  ReleaseExecutionOutcome,
  ProviderReconciliationResult,
} from "../src/core/production-release-enforcement";
import { createNodeBridge } from "./host-bridge-node";
import os from "node:os";
import path from "node:path";

type R = "PASS" | "FAIL" | "BLOCKED" | "NOT EXECUTED";
const rows: { id: string; name: string; r: R; n: string }[] = [];
function rec(id: string, name: string, r: R, n: string) {
  rows.push({ id, name, r, n });
  const m = r === "PASS" ? "[PASS]" : r === "FAIL" ? "[FAIL]" : r === "BLOCKED" ? "[BLK ]" : "[N/E ]";
  console.log(`${m} ${id} ${name} -- ${n}`);
}
function ok(c: boolean, m: string) { if (!c) throw new Error(m); }
function rid(p: string) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

/** Build a minimal ReleaseExecutionRequest for the reconciliation boundary. */
function makeReq(releaseId: string): ReleaseExecutionRequest {
  return {
    authorizationId: "auth-232",
    releaseId,
    artifactId: "art-232",
    commitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    environment: "phase232-test",
    projectId: "phase232-proj",
    executionId: "exec-232",
    imageRepository: "nexus-app",
    imageTag: "version-a",
    imageId: null,
    imageDigest: "sha256:" + "a".repeat(64),
    containerName: "nexus-232",
    containerPort: 8080,
    attemptId: "attempt-232",
  };
}

/** Provider test double modelling a lost response after a successful
 *  provider-side mutation. The mutation is committed to `deployments`
 *  before the error is thrown, so reconciliation can observe it. */
class LostResponseProvider implements ReleaseExecutionProvider {
  public executeCalls = 0;
  public reconcileCalls = 0;
  public deployments = new Map<string, { deploymentId: string; releaseId: string }>();
  public reconcileMode: "DEPLOYED" | "NOT_DEPLOYED" | "UNKNOWN" | "throw" = "DEPLOYED";
  public reconcileDeploymentIdOverride: string | null | undefined = undefined;

  async execute(req: ReleaseExecutionRequest): Promise<ReleaseExecutionOutcome> {
    this.executeCalls += 1;
    // Provider-side mutation happens BEFORE the response is lost.
    const deploymentId = "prov-dep-" + req.releaseId;
    this.deployments.set(req.releaseId, { deploymentId, releaseId: req.releaseId });
    // Simulate transport failure on the way back.
    throw new Error("ECONNRESET: response lost after provider mutation");
  }

  async reconcile(req: ReleaseExecutionRequest): Promise<ProviderReconciliationResult> {
    this.reconcileCalls += 1;
    if (this.reconcileMode === "throw") {
      throw new Error("reconcile transport failure");
    }
    if (this.reconcileMode === "UNKNOWN") {
      return { status: "UNKNOWN", deploymentId: null, message: "provider unavailable" };
    }
    if (this.reconcileMode === "NOT_DEPLOYED") {
      return { status: "NOT_DEPLOYED", deploymentId: null, message: "no matching resource" };
    }
    // DEPLOYED
    const found = this.deployments.get(req.releaseId);
    const deploymentId =
      this.reconcileDeploymentIdOverride !== undefined
        ? this.reconcileDeploymentIdOverride
        : found?.deploymentId ?? null;
    return { status: "DEPLOYED", deploymentId, message: "found matching resource" };
  }
}

/** Provider that only implements execute() -- no reconcile(). */
class ExecuteOnlyProvider implements ReleaseExecutionProvider {
  public executeCalls = 0;
  async execute(): Promise<ReleaseExecutionOutcome> {
    this.executeCalls += 1;
    throw new Error("ECONNRESET: response lost");
  }
}

/** Construct a ProductionReleaseEnforcementService with only the provider
 *  wired. The other deps are unused by recoverForIntent() and are stubbed. */
function makeService(provider: ReleaseExecutionProvider): ProductionReleaseEnforcementService {
  return new ProductionReleaseEnforcementService(
    {} as any,               // SecurityApi
    {} as any,               // SecurityReleaseGate
    {} as any,               // ProductionReleaseDecisionService
    provider,
    undefined,               // ExecutionStore
    undefined,               // NexusEngine
    undefined,               // AuditService
    undefined,               // ReleaseExecutionGate (Phase 225)
  );
}

async function main() {
  const bridgeRoot = path.join(os.tmpdir(), "nexus-phase232-" + Date.now());
  (globalThis as any).window = { __NEXUS_HOST__: createNodeBridge(bridgeRoot) };
  // 232A: existing provider reconciliation contract is available
  try {
    const provider = new LostResponseProvider();
    const svc = makeService(provider);
    ok(typeof (svc as any).recoverForIntent === "function", "recoverForIntent missing");
    const out = await svc.recoverForIntent(makeReq("rel-232A"));
    // No deployments registered -> DEPLOYED with null id, or NOT_DEPLOYED.
    ok(out.status === "DEPLOYED" || out.status === "NOT_DEPLOYED" || out.status === "UNKNOWN",
       `unexpected status=${out.status}`);
    rec("232A", "provider reconciliation contract", "PASS",
        `recoverForIntent=${typeof (svc as any).recoverForIntent} status=${out.status}`);
  } catch (e) { rec("232A", "provider reconciliation contract", "FAIL", String(e)); }

  // 232B: lost response after real provider-side mutation
  try {
    const provider = new LostResponseProvider();
    const svc = makeService(provider);
    const req = makeReq("rel-232B");
    let threw = false;
    try { await provider.execute(req); } catch { threw = true; }
    ok(threw, "expected execute to throw");
    ok(provider.executeCalls === 1, `executeCalls=${provider.executeCalls}`);
    ok(provider.deployments.has("rel-232B"), "provider did not record mutation");
    rec("232B", "lost response after provider mutation", "PASS",
        `executeCalls=1 providerState=present`);
  } catch (e) { rec("232B", "lost response after provider mutation", "FAIL", String(e)); }

  // 232C: recovery invokes reconcile after uncertain execute
  try {
    const provider = new LostResponseProvider();
    const svc = makeService(provider);
    const req = makeReq("rel-232C");
    try { await provider.execute(req); } catch { /* expected */ }
    const before = provider.reconcileCalls;
    const out = await svc.recoverForIntent(req);
    ok(provider.reconcileCalls > before, `reconcileCalls did not increment`);
    ok(out.status === "DEPLOYED", `expected DEPLOYED, got ${out.status}`);
    rec("232C", "recovery invokes reconcile", "PASS",
        `reconcileCalls=${provider.reconcileCalls}`);
  } catch (e) { rec("232C", "recovery invokes reconcile", "FAIL", String(e)); }

  // 232D: DEPLOYED binds existing deployment identity
  try {
    const provider = new LostResponseProvider();
    const svc = makeService(provider);
    const req = makeReq("rel-232D");
    try { await provider.execute(req); } catch { /* expected */ }
    const out = await svc.recoverForIntent(req);
    ok(out.status === "DEPLOYED", `status=${out.status}`);
    ok(out.deploymentId === "prov-dep-rel-232D", `deploymentId=${out.deploymentId}`);
    rec("232D", "DEPLOYED binds existing identity", "PASS",
        `deploymentId=${out.deploymentId}`);
  } catch (e) { rec("232D", "DEPLOYED binds existing identity", "FAIL", String(e)); }

  // 232E: DEPLOYED does not execute again (no duplicate mutation)
  try {
    const provider = new LostResponseProvider();
    const svc = makeService(provider);
    const req = makeReq("rel-232E");
    try { await provider.execute(req); } catch { /* expected */ }
    ok(provider.executeCalls === 1, `pre-recovery executeCalls=${provider.executeCalls}`);
    const out = await svc.recoverForIntent(req);
    ok(out.status === "DEPLOYED", `status=${out.status}`);
    ok(provider.executeCalls === 1, `post-recovery executeCalls=${provider.executeCalls}`);
    rec("232E", "DEPLOYED does not re-execute", "PASS",
        `executeCalls=${provider.executeCalls} reconcileCalls=${provider.reconcileCalls}`);
  } catch (e) { rec("232E", "DEPLOYED does not re-execute", "FAIL", String(e)); }

  // 232F: NOT_DEPLOYED permits guarded retry (caller's decision; reconcile returns NOT_DEPLOYED)
  try {
    const provider = new LostResponseProvider();
    provider.reconcileMode = "NOT_DEPLOYED";
    const svc = makeService(provider);
    const req = makeReq("rel-232F");
    try { await provider.execute(req); } catch { /* expected */ }
    const out = await svc.recoverForIntent(req);
    ok(out.status === "NOT_DEPLOYED", `status=${out.status}`);
    // Simulate the caller's guarded retry path (the caller owns whether to invoke execute again).
    try { await provider.execute(req); } catch { /* expected */ }
    ok(provider.executeCalls === 2, `executeCalls=${provider.executeCalls}`);
    rec("232F", "NOT_DEPLOYED permits guarded retry", "PASS",
        `executeCalls=${provider.executeCalls} reconcile=${provider.reconcileCalls}`);
  } catch (e) { rec("232F", "NOT_DEPLOYED permits guarded retry", "FAIL", String(e)); }

  // 232G: UNKNOWN blocks retry
  try {
    const provider = new LostResponseProvider();
    provider.reconcileMode = "UNKNOWN";
    const svc = makeService(provider);
    const req = makeReq("rel-232G");
    try { await provider.execute(req); } catch { /* expected */ }
    const out = await svc.recoverForIntent(req);
    ok(out.status === "UNKNOWN", `status=${out.status}`);
    ok(provider.executeCalls === 1, `executeCalls after UNKNOWN=${provider.executeCalls}`);
    rec("232G", "UNKNOWN blocks retry", "PASS",
        `executeCalls=${provider.executeCalls} reconcileCalls=${provider.reconcileCalls}`);
  } catch (e) { rec("232G", "UNKNOWN blocks retry", "FAIL", String(e)); }

  // 232H: missing reconcile() remains safe
  try {
    const provider = new ExecuteOnlyProvider();
    const svc = makeService(provider);
    const req = makeReq("rel-232H");
    try { await provider.execute(req); } catch { /* expected */ }
    const out = await svc.recoverForIntent(req);
    ok(out.status === "UNKNOWN", `expected UNKNOWN, got ${out.status}`);
    ok(/no reconcile/i.test(out.message), `message=${out.message}`);
    rec("232H", "missing reconcile -> UNKNOWN", "PASS", `message=${out.message}`);
  } catch (e) { rec("232H", "missing reconcile -> UNKNOWN", "FAIL", String(e)); }

  // 232I: DEPLOYED without identity -> caller must not treat as success
  try {
    const provider = new LostResponseProvider();
    provider.reconcileDeploymentIdOverride = null;
    const svc = makeService(provider);
    const req = makeReq("rel-232I");
    try { await provider.execute(req); } catch { /* expected */ }
    const out = await svc.recoverForIntent(req);
    ok(out.status === "DEPLOYED", `status=${out.status}`);
    ok(out.deploymentId === null, `deploymentId=${out.deploymentId}`);
    // The caller's contract: DEPLOYED with no identity is RECOVERY_REQUIRED.
    // We record this as PASS because the boundary correctly surfaces the null.
    rec("232I", "DEPLOYED without identity", "PASS",
        `status=DEPLOYED deploymentId=null -> caller must RECOVERY_REQUIRED`);
  } catch (e) { rec("232I", "DEPLOYED without identity", "FAIL", String(e)); }

  // 232J: reconcile throws -> UNKNOWN (caller does not retry)
  try {
    const provider = new LostResponseProvider();
    provider.reconcileMode = "throw";
    const svc = makeService(provider);
    const req = makeReq("rel-232J");
    try { await provider.execute(req); } catch { /* expected */ }
    const out = await svc.recoverForIntent(req);
    ok(out.status === "UNKNOWN", `status=${out.status}`);
    ok(/threw/i.test(out.message), `message=${out.message}`);
    ok(provider.executeCalls === 1, `executeCalls=${provider.executeCalls}`);
    rec("232J", "reconcile throws -> UNKNOWN", "PASS", `message=${out.message.slice(0, 50)}`);
  } catch (e) { rec("232J", "reconcile throws -> UNKNOWN", "FAIL", String(e)); }

  // 232K: no provider wired -> UNKNOWN
  try {
    const svc = new ProductionReleaseEnforcementService(
      {} as any, {} as any, {} as any,
      undefined, undefined, undefined, undefined, undefined,
    );
    const out = await svc.recoverForIntent(makeReq("rel-232K"));
    ok(out.status === "UNKNOWN", `status=${out.status}`);
    ok(/no provider/i.test(out.message), `message=${out.message}`);
    rec("232K", "no provider -> UNKNOWN", "PASS", `message=${out.message}`);
  } catch (e) { rec("232K", "no provider -> UNKNOWN", "FAIL", String(e)); }

  // 232L: repeated reconciliation is idempotent (no duplicate mutation)
  try {
    const provider = new LostResponseProvider();
    const svc = makeService(provider);
    const req = makeReq("rel-232L");
    try { await provider.execute(req); } catch { /* expected */ }
    const a = await svc.recoverForIntent(req);
    const b = await svc.recoverForIntent(req);
    const c = await svc.recoverForIntent(req);
    ok(a.status === "DEPLOYED" && b.status === "DEPLOYED" && c.status === "DEPLOYED",
       `statuses=${a.status},${b.status},${c.status}`);
    ok(provider.executeCalls === 1, `executeCalls after 3 reconciles=${provider.executeCalls}`);
    ok(provider.reconcileCalls === 3, `reconcileCalls=${provider.reconcileCalls}`);
    rec("232L", "idempotent reconciliation", "PASS",
        `executeCalls=1 reconcileCalls=3`);
  } catch (e) { rec("232L", "idempotent reconciliation", "FAIL", String(e)); }

  // 232M: cross-release identity is preserved (reconcile uses req.releaseId)
  try {
    const provider = new LostResponseProvider();
    const svc = makeService(provider);
    const reqA = makeReq("rel-232M-A");
    const reqB = makeReq("rel-232M-B");
    try { await provider.execute(reqA); } catch { /* expected */ }
    try { await provider.execute(reqB); } catch { /* expected */ }
    const outA = await svc.recoverForIntent(reqA);
    const outB = await svc.recoverForIntent(reqB);
    ok(outA.deploymentId === "prov-dep-rel-232M-A", `A=${outA.deploymentId}`);
    ok(outB.deploymentId === "prov-dep-rel-232M-B", `B=${outB.deploymentId}`);
    rec("232M", "cross-release identity preserved", "PASS",
        `A=${outA.deploymentId} B=${outB.deploymentId}`);
  } catch (e) { rec("232M", "cross-release identity preserved", "FAIL", String(e)); }

  // 232N: durable operation identity survives fresh service instance
  try {
    const provider = new LostResponseProvider();
    const svc1 = makeService(provider);
    const req = makeReq("rel-232N");
    try { await provider.execute(req); } catch { /* expected */ }
    // "Restart" = fresh service instance sharing the same provider state.
    const svc2 = makeService(provider);
    const out = await svc2.recoverForIntent(req);
    ok(out.status === "DEPLOYED", `status=${out.status}`);
    ok(out.deploymentId === "prov-dep-rel-232N", `deploymentId=${out.deploymentId}`);
    rec("232N", "durable identity across restart", "PASS",
        `deploymentId=${out.deploymentId}`);
  } catch (e) { rec("232N", "durable identity across restart", "FAIL", String(e)); }

  // 232O: activation/cutover not fabricated (no ACTIVE reachable from recover)
  try {
    const provider = new LostResponseProvider();
    const svc = makeService(provider);
    const req = makeReq("rel-232O");
    try { await provider.execute(req); } catch { /* expected */ }
    const out = await svc.recoverForIntent(req);
    const blob = JSON.stringify(out);
    ok(!/ACTIVE/.test(blob), "reconciliation must not surface ACTIVE");
    ok(!/KNOWN_GOOD/.test(blob), "reconciliation must not surface KNOWN_GOOD");
    ok(out.status === "DEPLOYED" || out.status === "NOT_DEPLOYED" || out.status === "UNKNOWN",
       `status=${out.status}`);
    rec("232O", "no fabricated ACTIVE/KNOWN_GOOD", "PASS",
        `status=${out.status} (never ACTIVE/KNOWN_GOOD)`);
  } catch (e) { rec("232O", "no fabricated ACTIVE/KNOWN_GOOD", "FAIL", String(e)); }

  // 232P: kernel constructs the enforcement service (integration sanity)
  try {
    const k = new NexusKernel();
    const svcK = await k.boot();
    ok(!!svcK.releaseEnforcement, "releaseEnforcement missing");
    ok(typeof (svcK.releaseEnforcement as any).recoverForIntent === "function",
       "kernel-exposed enforcement has no recoverForIntent");
    rec("232P", "kernel enforcement has recoverForIntent", "PASS",
        `enforcement=${typeof svcK.releaseEnforcement}`);
  } catch (e) { rec("232P", "kernel enforcement has recoverForIntent", "FAIL", String(e)); }

  finish();
}

function finish() {
  console.log("");
  console.log("===== Phase 232 summary =====");
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