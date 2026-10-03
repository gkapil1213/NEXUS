// scripts/test-phase240-supervisor-lease-hardening.ts
import { NexusKernel } from "../src/core/kernel";
import { createNodeBridge } from "./host-bridge-node";
import { ReleaseRecoverySupervisor } from "../src/core/release-recovery-supervisor";
import { getPgClient } from "../src/core/pg-client";
import os from "node:os";
import path from "node:path";
import type { ReleaseDeploymentIntentService } from "../src/core/release-deployment-intent";

let pass = 0, fail = 0, blocked = 0, notExec = 0;
function ok(n: string, c: boolean, d = "") {
  if (c) { pass++; console.log("PASS  " + n); }
  else { fail++; console.log("FAIL  " + n + (d ? " :: " + d : "")); }
}
function blockedRec(n: string, r: string | null) {
  blocked++; console.log("BLOCKED  " + n + " :: " + (r ?? "no reason"));
}
function finish() {
  console.log("\n============================================");
  console.log("PASS: " + pass);
  console.log("FAIL: " + fail);
  console.log("BLOCKED: " + blocked);
  console.log("NOT EXECUTED: " + notExec);
  console.log("============================================");
  return fail > 0 ? 1 : 0;
}
function uniq(t: string) {
  return `phase240-${t}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const stubExecutor: any = {
  runOnce: async () => ({ scanned: 0, acted: 0, skipped: 0, blocked: 0, leaseHeld: 0, actions: [], blockedReasons: [] }),
};

function mkSup(kernel: any, intents: ReleaseDeploymentIntentService, scope: string, ttl: number) {
  return new ReleaseRecoverySupervisor({
    executor: stubExecutor,
    svc: { events: kernel.services.events, audit: kernel.services.audit },
    workerId: "w240-" + uniq("w"),
    intervalMs: 3600_000,
    intents,
    supervisorLease: { scopeKey: scope, ttlMs: ttl },
  });
}

async function main() {
  if (process.env.NEXUS_PERSISTENCE_MODE !== "shared") {
    blockedRec("240-pre", "not shared"); process.exit(finish());
  }
  if (!process.env.DATABASE_URL) {
    blockedRec("240-pre", "no DATABASE_URL"); process.exit(finish());
  }
  const br = path.join(os.tmpdir(), "nexus-phase240-" + Date.now());
  (globalThis as any).window = { __NEXUS_HOST__: createNodeBridge(br) };
  let intents: ReleaseDeploymentIntentService | undefined;
  let kernel: NexusKernel | undefined;
  let pg: ReturnType<typeof getPgClient> = null;
  try {
    kernel = new NexusKernel();
    const svc: any = await kernel.boot();
    intents = svc.releaseIntents;
    pg = getPgClient();
    if (!intents || !pg) { ok("kernel boot + pg", false); process.exit(finish()); }

    ok("240A supervisor lifecycle present",
       typeof (kernel as any).startRecoverySupervisor === "function" &&
       typeof (kernel as any).runRecoveryNow === "function");

    ok("240B lease APIs present",
       typeof (intents as any).acquireSupervisorLeaseAsync === "function" &&
       typeof (intents as any).renewSupervisorLeaseAsync === "function" &&
       typeof (intents as any).releaseSupervisorLeaseAsync === "function" &&
       typeof (intents as any).getSupervisorLeaseAsync === "function");

    {
      const scope = uniq("c");
      const a = await intents!.acquireSupervisorLeaseAsync(scope, "A", 30_000);
      ok("240C first acquire succeeds", a.acquired === true);
      ok("240C generation = 0", a.generation === 0);
    }

    {
      const scope = uniq("de");
      const a = await intents!.acquireSupervisorLeaseAsync(scope, "A", 30_000);
      const ok1 = await intents!.renewSupervisorLeaseAsync(scope, "A", a.generation!, 30_000);
      ok("240D same-owner renewal succeeds", ok1 === true);
      const cp = await intents!.getSupervisorLeaseAsync(scope);
      ok("240D generation unchanged", cp?.generation === a.generation);
    }

    {
      const scope = uniq("f");
      const a = await intents!.acquireSupervisorLeaseAsync(scope, "A", 30_000);
      const r = await intents!.renewSupervisorLeaseAsync(scope, "B", a.generation!, 30_000);
      ok("240E non-owner renewal rejected", r === false);
    }

    {
      const scope = uniq("g");
      const a = await intents!.acquireSupervisorLeaseAsync(scope, "A", 1_000, Date.now() - 60_000);
      const b = await intents!.acquireSupervisorLeaseAsync(scope, "B", 30_000);
      ok("240F expired takeover succeeds", b.acquired === true);
      ok("240G generation increments", b.generation === (a.generation! + 1));
    }

    {
      const scope = uniq("h");
      const a = await intents!.acquireSupervisorLeaseAsync(scope, "A", 1_000, Date.now() - 60_000);
      await intents!.acquireSupervisorLeaseAsync(scope, "B", 30_000);
      const r = await intents!.renewSupervisorLeaseAsync(scope, "A", a.generation!, 30_000);
      ok("240H stale renewal rejected", r === false);
    }

    {
      const scope = uniq("i");
      const a = await intents!.acquireSupervisorLeaseAsync(scope, "A", 1_000, Date.now() - 60_000);
      await intents!.acquireSupervisorLeaseAsync(scope, "B", 30_000);
      const r = await intents!.releaseSupervisorLeaseAsync(scope, "A", a.generation!);
      ok("240I stale release rejected", r === false);
      const cp = await intents!.getSupervisorLeaseAsync(scope);
      ok("240I B still owns", cp?.ownerId === "B");
    }

    {
      const scope = uniq("jk");
      const sup = mkSup(kernel, intents!, scope, 30_000);
      await sup.start();
      const ownerReport = await sup.runNow();
      ok("240J owner runNow not lease-blocked",
         !(ownerReport.blockedReasons ?? []).some((r: any) => String(r.reason).startsWith("SUPERVISOR_LEASE")),
         JSON.stringify(ownerReport.blockedReasons));

      await pg!.query("UPDATE supervisor_leases SET lease_until = $1 WHERE scope_key = $2",
        [Date.now() - 60_000, scope]);
      await intents!.acquireSupervisorLeaseAsync(scope, "intruder", 30_000);
      const staleReport = await sup.runNow();
      const blk = (staleReport.blockedReasons ?? []).map((r: any) => String(r.reason)).join(",");
      ok("240K stale admission blocked", blk.includes("SUPERVISOR_LEASE"), "blk=" + blk);
      await sup.stop();
    }

    {
      const scope = uniq("l");
      const sup = mkSup(kernel, intents!, scope, 30_000);
      await sup.start();
      const orig = (intents as any).renewSupervisorLeaseAsync.bind(intents);
      (intents as any).renewSupervisorLeaseAsync = async () => { throw new Error("simulated-db-outage"); };
      const r = await sup.runNow();
      (intents as any).renewSupervisorLeaseAsync = orig;
      const reason = (r.blockedReasons ?? []).map((x: any) => String(x.reason)).join(",");
      ok("240L persistence failure → PERSISTENCE_UNAVAILABLE (not OWNERSHIP_LOST)",
         reason.includes("SUPERVISOR_LEASE_PERSISTENCE_UNAVAILABLE") &&
         !reason.includes("SUPERVISOR_LEASE_LOST"),
         "reason=" + reason);
      await sup.stop();
    }

    {
      const scope = uniq("m");
      const sup = mkSup(kernel, intents!, scope, 60_000);
      await sup.start();
      const s1 = sup.status();
      const g1 = s1.supervisorLeaseGeneration;
      const u1 = s1.supervisorLeaseUntil;
      await new Promise((r) => setTimeout(r, 100));
      await sup.runNow();
      const s2 = sup.status();
      ok("240M watchdog renewal (gen stable, expiry extended/equal)",
         s2.supervisorLeaseGeneration === g1 &&
         (s2.supervisorLeaseUntil ?? 0) >= (u1 ?? 0));
      await sup.stop();
    }

    {
      const fs = await import("node:fs");
      const src = fs.readFileSync("src/core/release-recovery-supervisor.ts", "utf8");
      const count = (src.match(/setInterval\(/g) ?? []).length;
      ok("240N no second scheduler (single setInterval)", count === 1, "count=" + count);
    }

    {
      const scope = uniq("o");
      const [a, b] = await Promise.all([
        intents!.acquireSupervisorLeaseAsync(scope, "A", 30_000),
        intents!.acquireSupervisorLeaseAsync(scope, "B", 30_000),
      ]);
      ok("240O exactly one concurrent acquisition winner",
         [a.acquired, b.acquired].filter(Boolean).length === 1);
    }

    {
      const scope = uniq("p");
      await intents!.acquireSupervisorLeaseAsync(scope, "A", 1_000, Date.now() - 60_000);
      const [c, d] = await Promise.all([
        intents!.acquireSupervisorLeaseAsync(scope, "C", 30_000),
        intents!.acquireSupervisorLeaseAsync(scope, "D", 30_000),
      ]);
      ok("240P exactly one concurrent takeover winner",
         [c.acquired, d.acquired].filter(Boolean).length === 1);
    }

    {
      const scope = uniq("q");
      const a = await intents!.acquireSupervisorLeaseAsync(scope, "A", 1_000, Date.now() - 60_000);
      const [takeover, staleRenew] = await Promise.all([
        intents!.acquireSupervisorLeaseAsync(scope, "B", 30_000),
        intents!.renewSupervisorLeaseAsync(scope, "A", a.generation!, 30_000),
      ]);
      ok("240Q renewal/takeover race fenced",
         takeover.acquired === true && staleRenew === false,
         "t=" + takeover.acquired + " s=" + staleRenew);
    }

    {
      const scope = uniq("r");
      const supA = mkSup(kernel, intents!, scope, 1_000);
      await supA.start();
      const stA = supA.status();
      await pg!.query("UPDATE supervisor_leases SET lease_until = $1 WHERE scope_key = $2",
        [Date.now() - 60_000, scope]);
      const supB = mkSup(kernel, intents!, scope, 30_000);
      await supB.start();
      ok("240R B became new owner", supB.status().ownedBySelf === true);
      const stale = await intents!.renewSupervisorLeaseAsync(
        scope, stA.workerId, stA.supervisorLeaseGeneration ?? -1, 30_000);
      ok("240R A cannot renew after B", stale === false);
      await supA.stop();
      await supB.stop();
    }

    {
      const env = uniq("s-env");
      const chkScope = "release-recovery-supervisor/" + env;
      await intents!.setActiveHealthCheckpointAsync(chkScope, -1, "seed-cursor");
      const before = await intents!.getActiveHealthCheckpointAsync(chkScope);

      const scope = uniq("s");
      const supA = mkSup(kernel, intents!, scope, 1_000);
      await supA.start();
      await pg!.query("UPDATE supervisor_leases SET lease_until = $1 WHERE scope_key = $2",
        [Date.now() - 60_000, scope]);
      const supB = mkSup(kernel, intents!, scope, 30_000);
      await supB.start();

      const after = await intents!.getActiveHealthCheckpointAsync(chkScope);
      ok("240S checkpoint unchanged across takeover",
         before?.cursor === after?.cursor && before?.generation === after?.generation,
         JSON.stringify({ before, after }));
      await supA.stop();
      await supB.stop();
    }

    try {
      const { execFileSync } = await import("node:child_process");
      const out = execFileSync("npx", ["tsx", "scripts/test-phase239-supervisor-leases.ts"],
        { cwd: process.cwd(), encoding: "utf8", timeout: 240_000, shell: true });
      ok("240T Phase 239 regression PASS:56", /PASS:\s*56/.test(out),
         "no PASS:56 in child output");
    } catch (e: any) {
      ok("240T Phase 239 regression", false,
         "exit " + (e?.status ?? "?") + " " + ((e?.stdout ?? "") + "").slice(0, 200));
    }

    try {
      const { execFileSync } = await import("node:child_process");
      const pathMod = await import("node:path");
      const tsc = pathMod.resolve(process.cwd(), "node_modules", "typescript", "bin", "tsc");
      execFileSync(process.execPath, [tsc, "--noEmit"], { cwd: process.cwd(), stdio: "pipe", timeout: 180_000 });
      ok("240 TypeScript compilation", true);
    } catch (e: any) {
      ok("240 TypeScript compilation", false, "exit " + (e?.status ?? "?"));
    }
  } catch (e: any) {
    fail++;
    console.log("FAIL harness error: " + (e?.stack ?? e));
  } finally {
    try { await kernel?.stopRecoverySupervisor({ finalPass: false }); } catch {}
    try { await pg?.close(); } catch {}
  }
  process.exit(finish());
}

main().catch((e) => { console.error(e); process.exit(1); });