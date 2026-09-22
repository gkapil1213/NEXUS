// scripts/test-phase183b-release-intents.ts
// Phase 183b - release/deployment intent persistence over real Postgres.
// R01-R25. Real Postgres, real child processes.

import { spawn, type ChildProcess } from "child_process";
import Database from "better-sqlite3";
import { PgClient } from "../src/core/pg-client";
import { PgAsyncEngine } from "../src/core/pg-async-engine";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { ReleaseDeploymentIntentService } from "../src/core/release-deployment-intent";

let passed = 0, failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log("  ok   " + msg); }
  else { failed++; console.log("  FAIL " + msg); }
}
function section(t: string): void { console.log("\n" + t); }

const CHILD = "scripts/_phase183b_intents_child.ts";
const liveChildren = new Set<ChildProcess>();
process.on("exit", () => { for (const c of liveChildren) { try { c.kill("SIGKILL"); } catch {} } });

interface ChildOut { code: number | null; stdout: string; stderr: string; json: any | null; }
function parseJson(s: string): any | null {
  const lines = s.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) { try { return JSON.parse(lines[i]); } catch {} }
  return null;
}
function runChild(url: string, cmd: string, ...args: string[]): Promise<ChildOut> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", CHILD, cmd, url, ...args], {
      cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
    });
    liveChildren.add(child);
    let stdout = "", stderr = "";
    child.stdout!.on("data", (d) => { stdout += d.toString(); });
    child.stderr!.on("data", (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 60_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      liveChildren.delete(child);
      try { child.stdout?.destroy(); } catch {}
      try { child.stderr?.destroy(); } catch {}
      resolve({ code, stdout, stderr, json: parseJson(stdout) });
    });
  });
}

function mkInput(prefix: string, over: Record<string, unknown> = {}): any {
  return {
    releaseId: "rel-" + prefix,
    executionId: "exec-" + prefix,
    attemptId: "att-" + prefix,
    artifactId: "art-" + prefix,
    artifactDigest: "sha256:" + prefix,
    commitSha: "c-" + prefix,
    environment: "production",
    projectId: "proj-" + prefix,
    imageRepository: "nexus/" + prefix,
    imageTag: "v1",
    imageId: "sha256-img-" + prefix,
    imageDigest: "sha256:dig-" + prefix,
    containerName: "c-" + prefix,
    containerPort: 8080,
    ...over,
  };
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL required"); process.exit(2); }

  const pg = new PgClient();
  await pg.connect(url);
  const asyncDb = new PgAsyncEngine(pg);
  const mem = new Database(":memory:");
  const syncEngine = SQLiteEngine.fromDatabase(mem);
  const store = new ExecutionStore(syncEngine, asyncDb);
  const service = new ReleaseDeploymentIntentService(store);

  // ============================================================
  // R01-R03 Schema
  // ============================================================
  section("R01-R03 - Postgres schema");
  {
    const t = await pg.query<{ exists: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = $1 AND table_schema='public') AS exists",
      ["release_deployment_intents"]);
    ok(t.rows[0]?.exists === true, "R01 release_deployment_intents exists");

    const c = await pg.query<{ c: string }>(
      "SELECT COUNT(*)::text AS c FROM information_schema.columns WHERE table_name = $1",
      ["release_deployment_intents"]);
    ok(c.rows[0]?.c === "42", "R02 42 authoritative columns (got " + c.rows[0]?.c + ")");

    const idx = await pg.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename = $1",
      ["release_deployment_intents"]);
    const names = new Set(idx.rows.map((r) => r.indexname));
    for (const required of [
      "idx_release_intents_status",
      "idx_release_intents_reconciled",
      "idx_release_intents_next_retry",
      "idx_release_intents_reconcile",
      "idx_release_intents_provider_deployment",
      "idx_release_intents_rollback_job",
      "idx_release_intents_rollback_target",
      "idx_release_intents_kind",
      "idx_release_intents_release_environment",
    ]) {
      ok(names.has(required), "R03 " + required + " present");
    }
  }

  // ============================================================
  // R04-R07 Create / get / idempotency / dup protection
  // ============================================================
  section("R04-R07 - create / get / idempotency");
  let r04Key = "";
  const r04Prefix = "r04-" + Date.now();
  {
    const inp = mkInput(r04Prefix);
    const r = await service.getOrCreateAsync(inp);
    r04Key = r.intent.intentKey;
    ok(r.created === true, "R04 createIntent (created=true)");
    ok(r.intent.status === "DEPLOYMENT_INTENT_CREATED", "R04 initial status DEPLOYMENT_INTENT_CREATED");
    ok(r.intent.attemptId === "att-" + r04Prefix, "R04 attemptId persisted");

    const got = await service.getAsync(r04Key);
    ok(got?.intentKey === r04Key, "R05 get returns the same intent");

    const again = await service.getOrCreateAsync(inp);
    ok(again.created === false, "R06 getOrCreate idempotent (created=false)");
    ok(again.intent.intentKey === r04Key, "R06 same intentKey");

    const rowCount = await pg.query<{ c: string }>(
      "SELECT COUNT(*)::text AS c FROM release_deployment_intents WHERE intent_key = $1", [r04Key]);
    ok(rowCount.rows[0]?.c === "1", "R07 no duplicate row for the same intent key");
  }

  // ============================================================
  // R08-R09 Status transition + conditional
  // ============================================================
  section("R08-R09 - transitions");
  {
    const r = await service.transitionAsync(r04Key, "DEPLOYING" as any, { provider: "test-provider" });
    ok(r?.status === "DEPLOYING", "R08 transitionAsync to DEPLOYING");

    // R09: transitionIfOwned by a non-owner must be rejected
    const lr = await service.acquireLeaseAsync(r04Key, "worker-owner", 60_000);
    ok(lr.acquired === true, "R09 owner acquired lease");

    const stale = await service.transitionIfOwnedAsync(
      r04Key, "HEALTH_CHECKING" as any, "worker-stale", {});
    ok(stale.updated === false, "R09 stale worker transitionIfOwned rejected");

    const owner = await service.transitionIfOwnedAsync(
      r04Key, "HEALTH_CHECKING" as any, "worker-owner", {});
    ok(owner.updated === true, "R09 owner transitionIfOwned applied");
    ok(owner.intent?.status === "HEALTH_CHECKING", "R09 owner status updated");
  }

  // ============================================================
  // R10-R12 Lease
  // ============================================================
  section("R10-R12 - lease");
  {
    const key = (await service.getOrCreateAsync(mkInput("r10"))).intent.intentKey;

    const r10 = await service.acquireLeaseAsync(key, "w-r10", 60_000);
    ok(r10.acquired === true, "R10 acquireLease");

    const r11 = await service.renewLeaseAsync(key, "w-r10", 120_000);
    ok(r11 === true, "R11 renewLease");

    const r12 = await service.releaseLeaseAsync(key, "w-r10");
    ok(r12 === true, "R12 releaseLease");

    const after = await service.getAsync(key);
    ok(after?.leasedBy === null && after?.leaseExpiresAt === null, "R12 lease cleared");
  }

  // ============================================================
  // R13 Stale-worker fencing (lease expiry)
  // ============================================================
  section("R13 - stale-worker fencing");
  {
    const key = (await service.getOrCreateAsync(mkInput("r13"))).intent.intentKey;
    await service.acquireLeaseAsync(key, "w-old", 1);   // 1ms lease
    await new Promise((r) => setTimeout(r, 20));

    // A new worker takes over after expiry
    const newLease = await service.acquireLeaseAsync(key, "w-new", 60_000);
    ok(newLease.acquired === true, "R13 new worker acquires after expiry");

    // Old worker cannot renew
    const renewByOld = await service.renewLeaseAsync(key, "w-old", 60_000);
    ok(renewByOld === false, "R13 stale worker cannot renew");

    // Old worker cannot mutate via transitionIfOwned
    const stale = await service.transitionIfOwnedAsync(
      key, "DEPLOYING" as any, "w-old", {});
    ok(stale.updated === false, "R13 stale worker cannot mutate via transitionIfOwned");
  }

  // ============================================================
  // R14 Terminal-state fencing
  // ============================================================
  section("R14 - terminal-state fencing");
  {
    const key = (await service.getOrCreateAsync(mkInput("r14"))).intent.intentKey;
    await service.acquireLeaseAsync(key, "w-r14", 60_000);
    await service.transitionIfOwnedAsync(key, "DEPLOYING" as any, "w-r14", {});
    await service.transitionIfOwnedAsync(key, "KNOWN_GOOD" as any, "w-r14", { deploymentId: "dep-r14" });

    const after = await service.getAsync(key);
    ok(after?.status === "KNOWN_GOOD", "R14 KNOWN_GOOD persisted");

    // Re-attempting getOrCreate on the same input returns the terminal record;
    // it does not create a fresh non-terminal intent.
    const again = await service.getOrCreateAsync(mkInput("r14"));
    ok(again.created === false, "R14 no duplicate create on terminal");
    ok(again.intent.status === "KNOWN_GOOD", "R14 terminal status preserved");
  }

  // ============================================================
  // R15 attemptId binding
  // ============================================================
  section("R15 - attemptId binding");
  {
    const a = await service.getOrCreateAsync(mkInput("r15", { attemptId: "att-A-r15" }));
    const b = await service.getOrCreateAsync(mkInput("r15", { attemptId: "att-B-r15" }));
    ok(a.intent.intentKey !== b.intent.intentKey, "R15 different attemptId -> different intent key");
    ok(a.intent.attemptId === "att-A-r15", "R15 attempt A retained");
    ok(b.intent.attemptId === "att-B-r15", "R15 attempt B retained");
  }

  // ============================================================
  // R16-R17 Recovery query + retry scheduling
  // ============================================================
  section("R16-R17 - recovery + retry");
  {
    const key = (await service.getOrCreateAsync(mkInput("r16"))).intent.intentKey;
    const retryAt = Date.now() + 60_000;
    await service.transitionAsync(key, "RECOVERY_REQUIRED" as any, {
      recoveryReason: "r16",
      providerStatus: "UNKNOWN",
      recoveryAttempts: 2,
      nextRetryAt: retryAt,
      lastFailureClass: "RECOVERY_REQUIRED",
    } as any);

    const rec = await service.listRecoverableAsync();
    ok(rec.some((i) => i.intentKey === key), "R16 recovery query includes RECOVERY_REQUIRED intent");

    const after = await service.getAsync(key);
    ok(after?.recoveryAttempts === 2, "R17 recoveryAttempts persisted");
    ok(after?.nextRetryAt === retryAt, "R17 nextRetryAt persisted");
    ok(after?.lastFailureClass === "RECOVERY_REQUIRED", "R17 lastFailureClass persisted");
  }

  // ============================================================
  // R18 Provider state
  // ============================================================
  section("R18 - provider state");
  {
    const key = (await service.getOrCreateAsync(mkInput("r18"))).intent.intentKey;
    await service.transitionAsync(key, "DEPLOYING" as any, {
      provider: "canonical-deployment-orchestrator",
      providerStatus: "DEPLOYED",
      providerDeploymentId: "dep-r18",
      startedAt: Date.now(),
    } as any);
    const after = await service.getAsync(key);
    ok(after?.provider === "canonical-deployment-orchestrator", "R18 provider persisted");
    ok(after?.providerStatus === "DEPLOYED", "R18 providerStatus persisted");
    ok(after?.providerDeploymentId === "dep-r18", "R18 providerDeploymentId persisted");
    ok(typeof after?.startedAt === "number", "R18 startedAt persisted");
  }

  // ============================================================
  // R19 Reconciliation state
  // ============================================================
  section("R19 - reconciliation state");
  {
    const key = (await service.getOrCreateAsync(mkInput("r19"))).intent.intentKey;
    const evidence = JSON.stringify({ source: "r19", timestamp: Date.now() });
    await service.transitionAsync(key, "KNOWN_GOOD" as any, {
      deploymentId: "dep-r19",
      reconciledAt: Date.now(),
      reconciliationEvidence: evidence,
    } as any);
    const after = await service.getAsync(key);
    ok(after?.reconciliationEvidence === evidence, "R19 reconciliationEvidence persisted");
    ok(typeof after?.reconciledAt === "number", "R19 reconciledAt persisted");
  }

  // ============================================================
  // R20 Recovery-decision persistence
  // ============================================================
  section("R20 - recovery-decision persistence");
  {
    const key = (await service.getOrCreateAsync(mkInput("r20"))).intent.intentKey;
    const decision = JSON.stringify({ decision: "RETRY", timestamp: Date.now() });
    // Direct durable write to the decision columns (schema-level check).
    await pg.query(
      "UPDATE release_deployment_intents SET last_recovery_decision = $1, last_recovery_decision_at = $2 WHERE intent_key = $3",
      [decision, Date.now(), key]);
    const after = await service.getAsync(key);
    ok(after?.lastRecoveryDecision === decision, "R20 lastRecoveryDecision round-trips");
    ok(typeof after?.lastRecoveryDecisionAt === "number", "R20 lastRecoveryDecisionAt round-trips");
  }

  // ============================================================
  // R21 Cross-process visibility
  // ============================================================
  section("R21 - cross-process visibility");
  {
    const prefix = "r21-" + Date.now();
    const w = await runChild(url, "create-intent", prefix);
    ok(w.code === 0 && w.json?.created === true, "R21 child created intent");

    const childKey = w.json.intentKey;
    const parentGet = await service.getAsync(childKey);
    ok(parentGet?.intentKey === childKey, "R21 parent reads child-created intent");

    const r = await runChild(url, "get-intent", childKey);
    ok(r.code === 0 && r.json?.found === true, "R21 second child reads the same intent");
  }

  // ============================================================
  // R22 Restart durability
  // ============================================================
  section("R22 - restart durability");
  {
    const key = (await service.getOrCreateAsync(mkInput("r22"))).intent.intentKey;
    await service.transitionAsync(key, "DEPLOYING" as any, { provider: "r22" } as any);

    // Simulate restart: new PgClient, new store, new service
    const pg2 = new PgClient();
    await pg2.connect(url);
    const asyncDb2 = new PgAsyncEngine(pg2);
    const store2 = new ExecutionStore(syncEngine, asyncDb2);
    const service2 = new ReleaseDeploymentIntentService(store2);

    const after = await service2.getAsync(key);
    ok(after?.intentKey === key, "R22 intent visible after restart");
    ok(after?.status === "DEPLOYING", "R22 status survived restart");
    ok(after?.provider === "r22", "R22 provider metadata survived restart");

    await pg2.close();
  }

  // ============================================================
  // R23 Concurrent get-or-create
  // ============================================================
  section("R23 - concurrent get-or-create");
  {
    const prefix = "r23-" + Date.now();
    const writers = [0, 1, 2, 3, 4].map(() => runChild(url, "create-race", prefix));
    const results = await Promise.all(writers);
    const okCount = results.filter((r) => r.code === 0 && r.json?.ok === true).length;
    ok(okCount === 5, "R23 all 5 processes completed without error (got " + okCount + ")");

    const createdCount = results.filter((r) => r.json?.created === true).length;
    ok(createdCount === 1, "R23 exactly one process reported created=true (got " + createdCount + ")");

    // Verify only one row exists
    const keys = new Set(results.map((r) => r.json?.intentKey));
    ok(keys.size === 1, "R23 all processes converged on the same intent key");
    const onlyKey = [...keys][0];
    const count = await pg.query<{ c: string }>(
      "SELECT COUNT(*)::text AS c FROM release_deployment_intents WHERE intent_key = $1", [onlyKey]);
    ok(count.rows[0]?.c === "1", "R23 exactly one durable row");
  }

  // ============================================================
  // R24 Concurrent lease protection
  // ============================================================
  section("R24 - concurrent lease protection");
  {
    const key = (await service.getOrCreateAsync(mkInput("r24"))).intent.intentKey;
    const [a, b] = await Promise.all([
      runChild(url, "acquire-lease", key, "w-A"),
      runChild(url, "acquire-lease", key, "w-B"),
    ]);
    const claimed = [a, b].filter((r) => r.json?.acquired === true);
    ok(claimed.length === 1, "R24 exactly one process acquires the lease");

    const after = await service.getAsync(key);
    ok(after?.leasedBy === "w-A" || after?.leasedBy === "w-B", "R24 winner is one of the racers");
  }

  // ============================================================
  // R25 SQLite-mode compatibility
  // ============================================================
  section("R25 - SQLite compatibility");
  {
    // Fresh store with NO async backend — pure sync SQLite
    const mem2 = new Database(":memory:");
    const syncEngine2 = SQLiteEngine.fromDatabase(mem2);
    // Run migrations
    const { MigrationRunner } = await import("../src/core/migration-runner");
    const { join } = await import("path");
    new MigrationRunner(mem2, join(process.cwd(), "src", "db", "migrations")).run();
    mem2.exec(`CREATE TABLE IF NOT EXISTS nexus_records (store TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (store, key));`);
    const store2 = new ExecutionStore(syncEngine2);
    const service2 = new ReleaseDeploymentIntentService(store2);

    ok(service2.hasAsyncBackend() === false, "R25 hasAsyncBackend() false in SQLite-only store");

    const r = await service2.getOrCreate(mkInput("r25"));
    ok(r.created === true, "R25 sync create works");

    const got = service2.get(r.intent.intentKey);
    ok(got?.intentKey === r.intent.intentKey, "R25 sync get works");

    const lr = service2.acquireLease(r.intent.intentKey, "w-sync");
    ok(lr.acquired === true, "R25 sync lease works");

    const tr = service2.transitionIfOwned(r.intent.intentKey, "DEPLOYING" as any, "w-sync", {});
    ok(tr.updated === true, "R25 sync owned transition works");

    const list = service2.listRecoverable();
    ok(list.length >= 1, "R25 sync listRecoverable works");

    // Async method on this store must throw
    let threw = false;
    try { await service2.getAsync(r.intent.intentKey); } catch { threw = true; }
    ok(threw, "R25 async method throws without asyncDb");

    mem2.close();
  }

  await pg.close();
  try { mem.close(); } catch {}

  console.log("\n=== Phase 183b release intents Summary ===");
  console.log("Passed: " + passed);
  console.log("Failed: " + failed);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });