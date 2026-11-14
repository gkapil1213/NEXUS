// scripts/test-phase303-kernel-boot-failure.ts
// Phase 303: close the WP7 boot-failure verification gap.
//
// Phase 300 artifacts/phase300/wp7-readiness.md documented claims 1 and 3
// as verified-by-inspection because no boot-failure test seam existed.
// Phase 303 adds __testSetBootHooks() and asserts directly:
//
//   WP7-T1  injected afterServicesWired throw -> boot() rejects
//   WP7-T2  after failure, kernel.status === "failed" (never "ready")
//   WP7-T3  startGateway() throws NOT_BOOTED after failed boot
//   WP7-T4  retry after clearing the hook succeeds and reaches "ready"
//   WP7-T5  startGateway() no longer throws NOT_BOOTED after successful retry
//
// Env vars are set BEFORE kernel/config imports so the boot path does not
// fail earlier at HMAC provider validation (same pattern as
// scripts/test-phase301-bridge-lifecycle.ts).

process.env.NEXUS_ENVELOPE_HMAC_PROVIDER ??= "env";
process.env.NEXUS_ENVELOPE_HMAC_KID ??= "test-k1";
process.env.NEXUS_ENVELOPE_HMAC_KEY_HEX ??= "ab".repeat(32);

import { NexusKernel, __testSetBootHooks } from "../src/core/kernel";
import { CONFIG } from "../src/core/config";
import { rmSync, existsSync } from "fs";

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { pass++; console.log(`PASS: ${msg}`); }
  else { fail++; console.error(`FAIL: ${msg}`); }
}
async function expectThrow(fn: () => Promise<any>, needle: string, msg: string) {
  try { await fn(); fail++; console.error(`FAIL: ${msg} (did not throw)`); }
  catch (e: any) {
    const s = String(e?.message ?? e);
    if (s.includes(needle)) { pass++; console.log(`PASS: ${msg}`); }
    else { fail++; console.error(`FAIL: ${msg} (threw: ${s})`); }
  }
}

const TMP_DB = `.nexus-phase303-${Date.now()}.sqlite`;

async function main() {
  CONFIG.persistence.engine = "sqlite";
  CONFIG.persistence.dbName = TMP_DB;
  CONFIG.gateway.enabled = true;
  CONFIG.gateway.port = 0;

  const kernel = new NexusKernel();

  // --- WP7-T1: injected failure makes boot() reject with the hook error ---
  __testSetBootHooks({
    afterServicesWired: () => { throw new Error("__phase303_injected_boot_failure__"); },
  });
  await expectThrow(
    () => kernel.boot(),
    "__phase303_injected_boot_failure__",
    "WP7-T1 injected afterServicesWired throw propagates from boot()"
  );

  // --- WP7-T2: status is "failed", never "ready" ---
  ok(kernel.status === "failed",
     `WP7-T2 kernel.status === "failed" after injected boot failure (got "${kernel.status}")`);
  ok(!!kernel.failure, "WP7-T2b kernel.failure is populated");

  // --- WP7-T3: startGateway() rejects with NOT_BOOTED ---
  // Must enable the gateway briefly so the NOT_BOOTED guard is reachable;
  // with gateway.enabled=false the first line returns before the guard.
  await expectThrow(
    () => kernel.startGateway(),
    "requires a completed, successful boot",
    "WP7-T3 startGateway() rejects with the NOT_BOOTED guard message"
  );

  // --- WP7-T4: clearing the hook, retry boot() succeeds ---
  __testSetBootHooks(null);
  let retryErr: Error | null = null;
  try { await kernel.boot(); } catch (e) { retryErr = e as Error; }
  ok(retryErr === null, `WP7-T4 boot() retry succeeds after hook cleared${retryErr ? " (got: " + retryErr.message + ")" : ""}`);
  ok(kernel.status === "ready", `WP7-T4b kernel.status === "ready" after retry (got "${kernel.status}")`);

  // --- WP7-T5: gateway starts after successful boot ---
  try {
    let gwErr: Error | null = null;

    try {
      await kernel.startGateway();
    } catch (e) {
      gwErr = e as Error;
    }

    ok(
      gwErr === null,
      `WP7-T5 startGateway() succeeds after successful boot${gwErr ? " (got: " + gwErr.message + ")" : ""}`
    );

    const listenerAddress = kernel.workerGateway.server.address();

    ok(
      listenerAddress !== null &&
        typeof listenerAddress === "object" &&
        listenerAddress.port > 0,
      "WP7-T6 gateway listener is actually bound to an ephemeral port"
    );
  } finally {
    await kernel.stopGateway();
  }
  console.log(`\nPhase 303 WP7 boot-failure: ${pass} PASS, ${fail} FAIL`);
  if (fail > 0) throw new Error(`Phase 303 FAILED with ${fail} failing checks`);
}

export async function run(): Promise<void> {
  try { await main(); }
  finally {
    __testSetBootHooks(null);
    try {
      for (const s of ["", "-journal", "-wal", "-shm"]) {
        const f = TMP_DB + s;
        if (existsSync(f)) rmSync(f, { force: true });
      }
    } catch { /* best-effort */ }
  }
}

import { pathToFileURL } from "node:url";
const __entry = process.argv[1];
if (__entry && import.meta.url === pathToFileURL(__entry).href) {
  run().catch((e) => { console.error("FATAL:", e); process.exit(2); });
}
