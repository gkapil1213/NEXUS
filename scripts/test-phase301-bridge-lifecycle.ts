// scripts/test-phase301-bridge-lifecycle.ts
// Phase 301 WP1: proves Fix A — the CICD bridge is constructed
// unconditionally at boot. The provider delegates to the shared
// GitHubService and self-guards via ensureConnected(). A token
// established AFTER boot must work without rebuilding the engine.
//
// Cases:
//   WP301-BRIDGE-1  headless boot: registry.list() includes "github-actions"
//   WP301-BRIDGE-2  headless boot: manager.getStatus() reports BLOCKED (no token)
//   WP301-BRIDGE-3  headless boot: artifact reconciler is present (was undefined pre-Fix A)
//   WP301-BRIDGE-4  headless boot: scheduler is started (Fix A side-effect)
//   WP301-BRIDGE-5  with NEXUS_TEST_GITHUB_TOKEN set: post-boot connect()
//                   unblocks the same manager instance for a real API call;
//                   absent token: explicitly NOT EXECUTED (not BLOCKED, not PASS)

process.env.NEXUS_ENVELOPE_HMAC_PROVIDER ??= "env";
process.env.NEXUS_ENVELOPE_HMAC_KID ??= "test-k1";
process.env.NEXUS_ENVELOPE_HMAC_KEY_HEX ??= "ab".repeat(32);

import { NexusKernel } from "../src/core/kernel";

type R = "PASS" | "FAIL" | "BLOCKED" | "NOT EXECUTED";
const rows: { id: string; name: string; r: R; n: string }[] = [];
function rec(id: string, name: string, r: R, n: string) {
  rows.push({ id, name, r, n });
  const m = r === "PASS" ? "[PASS]" : r === "FAIL" ? "[FAIL]" : r === "BLOCKED" ? "[BLK ]" : "[N/E ]";
  console.log(`${m} ${id} ${name} -- ${n}`);
}
function ok(c: boolean, m: string) { if (!c) throw new Error(m); }
async function test(id: string, name: string, fn: () => Promise<string>): Promise<void> {
  try { rec(id, name, "PASS", await fn()); }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // A thrown error with "BLOCKED:" prefix is an honest block, not a fail.
    if (msg.startsWith("BLOCKED:")) rec(id, name, "BLOCKED", msg.slice(8).trim());
    else rec(id, name, "FAIL", msg);
  }
}

async function main(): Promise<void> {
  const kernel = new NexusKernel();
  let bootError: Error | null = null;
  try { await kernel.boot(); } catch (e) { bootError = e as Error; }

  try {
    if (bootError) {
      rec("WP301-BRIDGE-0", "kernel boot", "FAIL", bootError.message);
      return;
    }

    const services = (kernel as any).services as {
      github: { state: () => { connected: boolean }; connect: (t: string) => Promise<any> };
      cicd: {
        registry?: { list: () => Array<{ id: string }>; get: (id: string) => any };
        manager?: { getStatus: (pid: string, rid: string, ctx?: any) => Promise<any> };
        scheduler?: { stop: () => Promise<void>; isRunning: () => boolean };
        artifactReconciler?: unknown;
      };
    };

    // Fix A: the bridge lives inside CiPipelineEngine.svc.cicd, not on services.cicd.
    // services.cicd exposes { agent, validator, github, gitlab, engine, artifactReconciler, reconciliation, scheduler, ownership }
    // but NOT registry/manager; those are inside the bridge that CiPipelineEngine holds.
    const engineSvc = (services.cicd.engine as any)?.svc as { cicd?: any } | undefined;
    const bridge = engineSvc?.cicd;

    // WP301-BRIDGE-1: bridge exists at boot, provider registered
    await test("WP301-BRIDGE-1", "headless boot has live CICD bridge with provider registered", async () => {
      ok(services.cicd != null, "services.cicd missing");
      ok(bridge != null, "bridge absent from CiPipelineEngine.svc.cicd; Fix A did not wire it");
      ok(bridge.registry != null, "bridge.registry missing");
      const providers = bridge.registry.list();
      ok(providers.length > 0, "registry is empty; Fix A did not register provider");
      const hasGithubActions = providers.some((p: any) => p.id === "github-actions");
      ok(hasGithubActions, "github-actions not in registry.list(); got " + JSON.stringify(providers.map((p: any) => p.id)));
      return "bridge.registry.list() includes github-actions";
    });

    // WP301-BRIDGE-2: with no token, manager.getStatus reports BLOCKED (not fabricated)
    await test("WP301-BRIDGE-2", "manager.getStatus without connect reports BLOCKED", async () => {
      ok(bridge != null, "bridge absent");
      ok(bridge.manager != null, "bridge.manager missing");
      // Provider's ensureConnected() throws Error("BLOCKED: GitHub not connected - ...")
      try {
        await bridge.manager.getStatus("github-actions", "fake-run-id", { owner: "x", repo: "y" });
        throw new Error("expected getStatus to throw BLOCKED, but it resolved");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        ok(msg.startsWith("BLOCKED:"), "expected BLOCKED:..., got: " + msg);
        return "BLOCKED: " + msg.slice(8, 80);
      }
    });

    // WP301-BRIDGE-3: artifact reconciler is present (Fix A side-effect)
    await test("WP301-BRIDGE-3", "artifact reconciler present at headless boot", async () => {
      ok(services.cicd.artifactReconciler != null, "artifactReconciler undefined; Fix A did not wire it");
      return "artifactReconciler present";
    });

    // WP301-BRIDGE-4: scheduler started (Fix A side-effect)
    await test("WP301-BRIDGE-4", "scheduler started at headless boot", async () => {
      ok(services.cicd.scheduler != null, "scheduler undefined; Fix A did not start it");
      ok(typeof services.cicd.scheduler.isRunning === "function", "scheduler.isRunning() unavailable");
      ok(services.cicd.scheduler.isRunning() === true, "scheduler exists but is not running");
      return "scheduler.isRunning() returned true";
    });

    // WP301-BRIDGE-5: with token, post-boot connect() unblocks the SAME bridge
    const testToken = process.env.NEXUS_TEST_GITHUB_TOKEN;
    if (!testToken) {
      rec("WP301-BRIDGE-5", "post-boot connect() unblocks bridge (needs NEXUS_TEST_GITHUB_TOKEN)", "NOT EXECUTED",
        "NEXUS_TEST_GITHUB_TOKEN not set; cannot verify post-boot connect against real API");
    } else {
      await test("WP301-BRIDGE-5", "post-boot connect() unblocks same bridge for real API call", async () => {
        ok(!services.github.state().connected, "precondition: already connected?");
        const identity = await services.github.connect(testToken);
        ok(identity?.login, "connect() did not return identity");
        ok(services.github.state().connected, "state().connected still false after connect");
        // Same manager instance, no rebuild. Require a real provider API response.
        const result = await bridge.manager.getStatus(
          "github-actions",
          "999999999",
          { owner: "octocat", repo: "Hello-World" },
        );
        ok(result.status === "BLOCKED", "expected BLOCKED for deliberately nonexistent workflow run");
        ok(
          result.evidence?.reason === "workflow run not found on provider",
          "expected GitHub API not-found evidence; received: " + JSON.stringify(result),
        );
        ok(
          result.evidence?.external_run_id === "999999999",
          "not-found evidence did not preserve the requested external run ID",
        );
        return "post-boot connect reached GitHub API; expected not-found response verified (login=" + identity.login + ")";
      });
    }
  } finally {
    // Stop scheduler + any background timers, then stop kernel
    try {
      const services = (kernel as any).services as any;
      if (services?.cicd?.scheduler?.stop) await services.cicd.scheduler.stop();
    } catch { /* best-effort */ }
    try { await kernel.shutdown(); } catch { /* best-effort */ }
  }
}

main().then(() => {
  const pass = rows.filter((r) => r.r === "PASS").length;
  const fail = rows.filter((r) => r.r === "FAIL").length;
  const blk = rows.filter((r) => r.r === "BLOCKED").length;
  const ne = rows.filter((r) => r.r === "NOT EXECUTED").length;
  console.log("\n===== Phase 301 Bridge Lifecycle summary =====");
  console.log("PASS: " + pass);
  console.log("FAIL: " + fail);
  console.log("BLOCKED: " + blk);
  console.log("NOT EXECUTED: " + ne);
  process.exit(fail > 0 ? 1 : (blk > 0 || ne > 0) ? 2 : 0);
}).catch((e) => { console.error("FATAL:", e); process.exit(1); });