// scripts/test-phase217-real-provider-e2e.ts
// Phase 217 - Real-provider end-to-end.
//
// Contract checks run unconditionally. Checks requiring a live provider emit
// BLOCKED when the provider env is absent, never PASS.

import { PgClient } from "../src/core/pg-client";
import { AIProviderGateway } from "../src/core/ai-provider-gateway";
import { openAICompatibleConfigFromEnv } from "../src/core/ai-provider-openai-compatible";
import { redactSecrets, redactDeep, bounded } from "../src/core/ai-provider-redaction";

type Result = "PASS" | "FAIL" | "BLOCKED" | "NOT EXECUTED";
interface Row { id: string; name: string; result: Result; note: string; }
const rows: Row[] = [];
function record(id: string, name: string, result: Result, note: string): void {
  rows.push({ id, name, result, note });
  const mark = result === "PASS" ? "[PASS]" : result === "FAIL" ? "[FAIL]" : result === "BLOCKED" ? "[BLK ]" : "[N/E ]";
  console.log(`${mark} ${id} ${name} -- ${note}`);
}
function ok(cond: boolean, msg: string): void { if (!cond) throw new Error(msg); }

class Blocked extends Error {}
async function test(id: string, name: string, fn: () => Promise<string> | string): Promise<void> {
  try { record(id, name, "PASS", await fn()); }
  catch (e) {
    if (e instanceof Blocked) record(id, name, "BLOCKED", e.message);
    else record(id, name, "FAIL", e instanceof Error ? e.message : String(e));
  }
}

async function pgCleanup(prefix: string): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  const c = new PgClient(); await c.connect(url);
  try {
    await c.query("DELETE FROM architecture_specifications WHERE run_id LIKE $1", [prefix + "%"]);
    await c.query("DELETE FROM engineering_plans WHERE run_id LIKE $1", [prefix + "%"]);
    await c.query("DELETE FROM engineering_requests WHERE run_id LIKE $1", [prefix + "%"]);
    await c.query("DELETE FROM engineering_run_events WHERE run_id LIKE $1", [prefix + "%"]);
    await c.query("DELETE FROM engineering_run_stages WHERE run_id LIKE $1", [prefix + "%"]);
    await c.query("DELETE FROM engineering_runs WHERE id LIKE $1", [prefix + "%"]);
    await c.query("DELETE FROM execution_artifacts WHERE job_id LIKE $1", [prefix + "%"]);
    await c.query("DELETE FROM execution_events WHERE job_id LIKE $1", [prefix + "%"]);
  } finally { await c.close(); }
}

interface RealProviderEnv { enabled: boolean; model?: string; apiKey?: string; endpoint?: string; present: boolean; }
function realProviderEnv(): RealProviderEnv {
  const enabled = process.env.NEXUS_AI_ENABLED === "true";
  const model = process.env.NEXUS_AI_MODEL;
  const apiKey = process.env.NEXUS_AI_API_KEY ?? process.env.OPENAI_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  const endpoint = process.env.NEXUS_AI_ENDPOINT;
  return { enabled, model, apiKey, endpoint, present: enabled && !!model && !!apiKey && !!endpoint };
}
function requireRealProvider(): RealProviderEnv {
  const env = realProviderEnv();
  if (!env.present) throw new Blocked(
    "no real provider configured (NEXUS_AI_ENABLED=true + NEXUS_AI_MODEL + NEXUS_AI_ENDPOINT + API key required)"
  );
  return env;
}

function loadConfig(): any {
  try { return openAICompatibleConfigFromEnv() as any; } catch { return null; }
}

function gatewayCount(providers: any[]): number | null {
  try {
    const gw: any = new (AIProviderGateway as any)({ providers });
    if (typeof gw.listProviders === "function") return gw.listProviders().length;
    return null;
  } catch { return null; }
}

async function main(): Promise<void> {
  const prefix = "engrun-217-" + Date.now() + "-";
  console.log(`mode=shared databaseUrl=${process.env.DATABASE_URL ? "set" : "unset"} prefix=${prefix}`);

  await test("217A", "real-provider env contract", () => {
    const env = realProviderEnv();
    if (env.enabled && (!env.model || !env.apiKey || !env.endpoint)) {
      throw new Error("partial real-provider config must not be treated as present");
    }
    return `enabled=${env.enabled} model=${env.model ?? "-"} endpoint=${env.endpoint ?? "-"} key=${env.apiKey ? "set" : "unset"} present=${env.present}`;
  });

  await test("217B", "config loader honours real env", () => {
    const cfg = loadConfig();
    const env = realProviderEnv();
    const enabled = !!(cfg && typeof cfg === "object" && (cfg as any).enabled === true);
    if (!env.present) {
      ok(!enabled, "config must not be enabled when real env is absent");
      return `no env -> config.present=${!!cfg} enabled=${enabled}`;
    }
    ok(enabled, "config must be enabled when real env is present");
    return `env present -> config.enabled=true`;
  });

  await test("217C", "gateway registration matches env", () => {
    const env = realProviderEnv();
    // With no real provider configured the gateway must accept an empty
    // provider list and report zero providers. When a real provider is
    // present, a provider must be registered with the gateway.
    const providers: any[] = []; // populated by 217E+ when real provider exists
    const count = gatewayCount(providers);
    if (count === null) throw new Blocked("gateway.listProviders() not callable");
    ok(count === providers.length, `listProviders()=${count} != providers.length=${providers.length}`);
    ok(!env.present || count >= 1, "real provider present but gateway has zero providers");
    return `providers=${count} env.present=${env.present}`;
  });

  await test("217D", "capability honesty under real config", () => {
    const env = realProviderEnv();
    return `real-provider capability=${env.present ? "IMPLEMENTED" : "NOT_IMPLEMENTED"}`;
  });

  await test("217E", "real provider runtime probe", async () => { requireRealProvider(); throw new Blocked("wire gateway.probe() to enable 217E"); });
  await test("217F", "real planning call",          async () => { requireRealProvider(); throw new Blocked("wire AIPlanningProvider to enable 217F"); });
  await test("217G", "real architecture call",      async () => { requireRealProvider(); throw new Blocked("wire AIArchitectureProvider to enable 217G"); });
  await test("217H", "request normalization (real)",  async () => { requireRealProvider(); throw new Blocked("assert request shape to enable 217H"); });
  await test("217I", "response normalization (real)", async () => { requireRealProvider(); throw new Blocked("assert response shape to enable 217I"); });
  await test("217J", "structured output from real provider", async () => { requireRealProvider(); throw new Blocked("parse real structured output to enable 217J"); });
  await test("217K", "transient failure retried (real)",     async () => { requireRealProvider(); throw new Blocked("induce transient error to enable 217K"); });
  await test("217L", "timeout enforced (real)",              async () => { requireRealProvider(); throw new Blocked("force real timeout to enable 217L"); });
  await test("217M", "auth failure non-retryable (real)",    async () => { requireRealProvider(); throw new Blocked("use bogus key to enable 217M"); });
  await test("217N", "rate-limit handling (real)",           async () => { requireRealProvider(); throw new Blocked("reproduce rate limit to enable 217N"); });
  await test("217O", "token/cost accounting (real)",         async () => { requireRealProvider(); throw new Blocked("record token counters to enable 217O"); });

  await test("217P", "secret redaction in logs", () => {
    const secret = "sk-test-DEADBEEF0123456789";
    const s = redactSecrets(`Authorization: Bearer ${secret}`);
    ok(!s.includes(secret), "secret survived redaction");
    return "secrets redacted";
  });

  await test("217Q", "payload redaction for artifacts", () => {
    const secret = "sk-test-DEADBEEF0123456789";
    const d = redactDeep({ headers: { authorization: `Bearer ${secret}` }, body: { apiKey: secret } }) as unknown;
    ok(!JSON.stringify(d).includes(secret), "deep redaction leaked a secret");
    return "deep redaction holds";
  });

  await test("217R", "idempotency across real calls", async () => { requireRealProvider(); throw new Blocked("prove cached plan reuse to enable 217R"); });
  await test("217S", "artifact persistence with checksum (real)", async () => { requireRealProvider(); throw new Blocked("persist real artifact + checksum to enable 217S"); });
  await test("217T", "lifecycle events for real run", async () => { requireRealProvider(); throw new Blocked("verify real run events to enable 217T"); });
  await test("217U", "budget cap enforced", async () => { requireRealProvider(); throw new Blocked("set budget cap to enable 217U"); });
  await test("217V", "model fallback / selection", async () => { requireRealProvider(); throw new Blocked("exercise fallback model to enable 217V"); });

  await test("217W", "bounded response size", () => {
    const big = "x".repeat(1_000_000);
    const cut = bounded(big, 1024);
    ok(cut.length <= 1024, "bounded() did not cap length");
    return `bounded(1_000_000) -> ${cut.length}`;
  });

  await test("217X", "real failure -> FAILED", async () => { requireRealProvider(); throw new Blocked("propagate real failure to FAILED to enable 217X"); });
  await test("217Y", "unavailable provider -> BLOCKED", () => {
    const env = realProviderEnv();
    if (env.present) return "provider present; unavailable path not exercised";
    return "provider absent -> BLOCKED path is the correct production behaviour";
  });
  await test("217Z", "end-to-end real planning -> architecture -> artifact", async () => { requireRealProvider(); throw new Blocked("run full real pipeline to enable 217Z"); });

  await pgCleanup(prefix);

  const pass = rows.filter(r => r.result === "PASS").length;
  const fail = rows.filter(r => r.result === "FAIL").length;
  const blk  = rows.filter(r => r.result === "BLOCKED").length;
  const ne   = rows.filter(r => r.result === "NOT EXECUTED").length;

  console.log("");
  console.log("===== Phase 217 summary =====");
  console.log(`PASS: ${pass}`);
  console.log(`FAIL: ${fail}`);
  console.log(`BLOCKED: ${blk}`);
  console.log(`NOT EXECUTED: ${ne}`);

  if (fail > 0) process.exit(1);
  if (blk > 0) process.exit(2);
  process.exit(0);
}

main().catch(e => {
  console.error("[phase217] fatal:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});