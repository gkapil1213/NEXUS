// scripts/test-phase193-boot-failure.ts
//
// PHASE 193 — §7 boot failure cleanup.
//
// Injects failures at each boot stage, verifies boot throws, verifies
// bootPromise is cleared so retry is possible, and verifies both a retry
// on the same kernel and a fresh kernel boot succeed afterwards.

import { SQLiteEngine } from "../src/core/sqlite-engine";
import { EventService } from "../src/core/events";
import { AuditService } from "../src/core/audit";
import { NexusKernel } from "../src/core/kernel";
import * as db from "../src/core/db";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log("[PASSED] " + name + (detail ? "  " + detail : "")); }
  else      { fail++; console.log("[FAILED] " + name + (detail ? "  " + detail : "")); }
}

interface Injection { name: string; inject: () => () => void; }

async function testFailure(inj: Injection): Promise<void> {
  console.log("\n--- " + inj.name + " ---");

  // 1. Boot with injection -> must throw
  db.resetEngineForTesting();
  const restore = inj.inject();
  const k = new NexusKernel();
  let threw = false, msg = "";
  try { await k.boot(); } catch (e) { threw = true; msg = (e as Error)?.message ?? String(e); }
  restore();
  db.resetEngineForTesting();

  ok(`${inj.name}: boot threw`, threw, `msg=${msg}`);
  ok(`${inj.name}: kernel.status=failed`, (k as any).status === "failed");
  ok(`${inj.name}: bootPromise cleared (retry possible)`, (k as any).bootPromise === undefined);

  // 2. Retry on the same kernel after failure
  const k2 = new NexusKernel();
  try {
    const svc = await k2.boot();
    ok(`${inj.name}: fresh kernel boots after failure`, !!svc);
    await k2.shutdown();
  } catch (e) {
    ok(`${inj.name}: fresh kernel boots after failure`, false, (e as Error)?.message ?? String(e));
  }

  // 3. Old kernel can be retried too (the failed one)
  db.resetEngineForTesting();
  try {
    const svc = await k.boot();
    ok(`${inj.name}: retry on previously-failed kernel succeeds`, !!svc);
    ok(`${inj.name}: kernel.status=ready after retry`, (k as any).status === "ready");
    await k.shutdown();
  } catch (e) {
    ok(`${inj.name}: retry on previously-failed kernel succeeds`, false, (e as Error)?.message ?? String(e));
  }
}

async function main() {
  console.log("PHASE 193 — §7 BOOT FAILURE CLEANUP\n");

  await testFailure({
    name: "F01 persistence probe failure",
    inject: () => {
      const orig = (SQLiteEngine.prototype as any).put;
      (SQLiteEngine.prototype as any).put = async () => { throw new Error("injected: engine.put"); };
      return () => { (SQLiteEngine.prototype as any).put = orig; };
    },
  });

  await testFailure({
    name: "F03 events.init failure",
    inject: () => {
      const orig = (EventService.prototype as any).init;
      (EventService.prototype as any).init = async () => { throw new Error("injected: events.init"); };
      return () => { (EventService.prototype as any).init = orig; };
    },
  });

  await testFailure({
    name: "F04 audit.probe failure",
    inject: () => {
      const orig = (AuditService.prototype as any).probe;
      (AuditService.prototype as any).probe = async () => { throw new Error("injected: audit.probe"); };
      return () => { (AuditService.prototype as any).probe = orig; };
    },
  });

  console.log(`\nPASS: ${pass}\nFAIL: ${fail}`);
  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch((e) => { console.error("FATAL:", e); process.exit(2); });
