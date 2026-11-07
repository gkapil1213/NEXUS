#!/usr/bin/env tsx
/**
 * Phase 293c — persistent sanitization regression tests.
 *
 * Drives the REAL CicdReconciliationService block()/retry()/reconcileOpen()
 * against an isolated in-memory DB seeded with migration 150, and the REAL
 * HealthAgent.checkHttpHealth(). Asserts on actual persisted columns, actual
 * emitted event payloads, actual returned diagnostics, and actual health
 * records. No sanitizer replication. No simulation of persistence.
 */
import { openEngine } from "../src/core/db";
import { ObservabilityService } from "../src/core/observability-service";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CicdReconciliationService } from "../src/core/cicd-reconciliation.service";
import { CiArtifactReconciliationService } from "../src/core/ci-artifact-reconciliation.service";
import { HealthAgent } from "../src/core/health-agent";
import { sanitizeHandlerError } from "../src/core/error-sanitizer";

let passed = 0, failed = 0, notTested = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed++; console.log(`PASS: ${name}`); }
  else { failed++; console.log(`FAIL: ${name}`, detail ?? ""); }
}
function notTestedMark(name: string, reason: string) {
  notTested++; console.log(`NOT TESTED: ${name} — ${reason}`);
}
function assertNoSentinels(name: string, value: unknown, sentinels: string[]) {
  const s = typeof value === "string" ? value : JSON.stringify(value ?? null);
  for (const sent of sentinels) {
    check(`${name} excludes ${JSON.stringify(sent.slice(0, 24))}`, !s.includes(sent), { value: s, sentinel: sent });
  }
}

const SENT_PATH = "C:\\Users\\pc\\SECRET_PATH_SENTINEL\\db.sqlite";
const SENT_SQL  = "SELECT * FROM users WHERE password = 'SENTINEL_SQL_ROW'";
const SENT_PW   = "password=SENTINEL_PW_8831";
const SENT_TOK  = "sk_live_SENTINEL_TOKEN_9f2a";
const SENT_AWS  = "AKIA_SENTINEL_AWS_ACCESS_KEY";
const SENT_PEM  = "-----BEGIN PRIVATE KEY-----SENTINEL_PEM-----END PRIVATE KEY-----";
const SENT_ML   = "Error: boom\n  at C:/Users/pc/SENTINEL_STACK/app.ts:42:7\n  password=SENTINEL_MULTILINE";
const ALL_SENTINELS = [SENT_PATH, SENT_SQL, SENT_PW, SENT_TOK, SENT_AWS, SENT_PEM,
  "SENTINEL_STACK", "SENTINEL_MULTILINE", "SENTINEL_PATH_SENTINEL", "SENTINEL_SQL_ROW",
  "SENTINEL_PW_8831", "SENTINEL_TOKEN_9f2a", "SENTINEL_AWS_ACCESS_KEY", "SENTINEL_PEM"];

function newDb(): Database.Database {
  const db = new Database(":memory:");
  const sql = readFileSync(
    join(process.cwd(), "src", "db", "migrations", "150_phase132_durable_ci_reconciliation.sql"),
    "utf8",
  );
  db.exec(sql);
  db.exec("CREATE TABLE IF NOT EXISTS nexus_records (store TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (store, key))");
  return db;
}
const fakeCiEngine = () => ({ pollRun: async (run: Record<string, unknown>) => ({ ...run, status: "RUNNING" }) }) as any;
const fakeEngineStore = () => ({ get: async () => undefined }) as any;
const fakeProvider = () => ({
  listArtifacts: async () => [],
  downloadArtifact: async () => Buffer.alloc(0),
}) as any;
const fakeArtifactService = () => ({
  register: async (_a: unknown, executionId: string, input: { kind: string; name: string; content: string }) => ({
    id: "art_x", execution_id: executionId, kind: input.kind, name: input.name,
    digest: "deadbeef", size: input.content.length, location: "artifact://art_x", created_at: Date.now(),
  }),
}) as any;

function makeHarness() {
  const db = newDb();
  const captured: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const events = { emit: async (e: { type: string; payload: Record<string, unknown> }) => { captured.push({ type: e.type, payload: e.payload }); return undefined; } };
  const audit = { record: async () => undefined };
  const reconciler = new CiArtifactReconciliationService(
    db as unknown as any,
    fakeArtifactService(),
    fakeProvider(),
  );
  const svc: any = new CicdReconciliationService(
    db as unknown as any,
    fakeCiEngine(),
    fakeEngineStore(),
    reconciler,
    events as any,
    audit as any,
  );

  function seed(runId: string) {
    const now = Date.now();
    db.prepare(
      `INSERT INTO ci_artifact_reconciliations
        (reconciliation_id, run_id, execution_id, project_id, provider_id,
         external_run_id, repository, commit_sha, workflow_file, state,
         attempts, created_at, updated_at)
       VALUES (?, ?, 'exec', NULL, 'github-actions', ?, 'repo', 'sha', NULL, 'PENDING', 0, ?, ?)`
    ).run("rec_" + runId, runId, "ext_" + runId, now, now);
  }
  function row(runId: string) {
    return db.prepare(
      `SELECT blocked_reason, last_error, state, attempts
         FROM ci_artifact_reconciliations WHERE run_id = ?`
    ).get(runId) as any;
  }
  return {
    db, captured, svc, seed, row,
    block: (runId: string, reason: string, attempts: number, artifactId?: string) =>
      svc.block(runId, reason, attempts, artifactId),
    retry: (runId: string, reason: string, attempts: number) =>
      svc.retry(runId, reason, attempts),
  };
}

(async () => {
  console.log("\n--- T1: shared sanitizer baseline ---");
  check("T1 approved passes", sanitizeHandlerError("handler_execution_failed") === "handler_execution_failed");
  check("T1 integrity_fail passes", sanitizeHandlerError("integrity_fail") === "integrity_fail");
  for (const s of [SENT_PATH, SENT_SQL, SENT_PW, SENT_TOK, SENT_AWS, SENT_PEM, SENT_ML])
    check(`T1 collapses ${s.slice(0, 20)}`, sanitizeHandlerError(s) === "handler_error");
  check("T1 non-string collapses", sanitizeHandlerError(undefined) === "handler_error");
  check("T1 idempotent", sanitizeHandlerError("handler_error") === "handler_error");

  console.log("\n--- T2: REAL block()/retry() against actual DB rows + events ---");
  for (const adversarial of [
    SENT_PATH, SENT_SQL, SENT_PW, SENT_TOK, SENT_AWS, SENT_PEM, SENT_ML,
    "POLL_THREW:" + SENT_PW, "RECONCILE_THREW:" + SENT_SQL,
  ]) {
    const tag = adversarial.slice(0, 24).replace(/\s+/g, "_");
    {
      const h = makeHarness(); h.seed("rb");
      const result = await h.block("rb", adversarial, 1);
      const p = h.row("rb");
      assertNoSentinels(`T2 block row.blocked_reason [${tag}]`, p.blocked_reason, ALL_SENTINELS);
      assertNoSentinels(`T2 block row.last_error [${tag}]`, p.last_error, ALL_SENTINELS);
      assertNoSentinels(`T2 block return.blockedReason [${tag}]`, result.blockedReason, ALL_SENTINELS);
      const evt = h.captured.find(e => e.type === "ci.reconciliation.blocked");
      check(`T2 block event emitted [${tag}]`, !!evt);
      if (evt) assertNoSentinels(`T2 block event.payload.reason [${tag}]`, evt.payload.reason, ALL_SENTINELS);
      h.db.close();
    }
    {
      const h = makeHarness(); h.seed("rr");
      await h.retry("rr", adversarial, 1);
      const p = h.row("rr");
      assertNoSentinels(`T2 retry row.last_error [${tag}]`, p.last_error, ALL_SENTINELS);
      const evt = h.captured.find(e => e.type === "ci.reconciliation.retry");
      check(`T2 retry event emitted [${tag}]`, !!evt);
      if (evt) assertNoSentinels(`T2 retry event.payload.reason [${tag}]`, evt.payload.reason, ALL_SENTINELS);
      h.db.close();
    }
  }
  {
    const h = makeHarness(); h.seed("rok");
    await h.block("rok", "UNMAPPED_CI_STATUS:CONFIGURATION_ERROR", 1);
    check("T2 approved block code persisted", h.row("rok").blocked_reason === "UNMAPPED_CI_STATUS:CONFIGURATION_ERROR", h.row("rok").blocked_reason);
    h.db.close();
  }
  {
    const h = makeHarness(); h.seed("rok2");
    await h.retry("rok2", "CI_RUN_NOT_FOUND", 1);
    check("T2 approved retry code persisted", h.row("rok2").last_error === "CI_RUN_NOT_FOUND", h.row("rok2").last_error);
    h.db.close();
  }

  console.log("\n--- T3: REAL reconcileOpen() exception diagnostic ---");
  try {
    const h = makeHarness(); h.seed("ro");
    (h.svc as any).reconcileOnce = async () => { throw new Error(SENT_PATH + " " + SENT_PW); };
    const results = await h.svc.reconcileOpen();
    const b = results.find((r: any) => r.runId === "ro");
    check("T3 reconcileOpen produced BLOCKED", !!b && b.result.state === "BLOCKED");
    if (b) assertNoSentinels("T3 reconcileOpen blockedReason", b.result.blockedReason, ALL_SENTINELS);
    h.db.close();
  } catch (e) {
    notTestedMark("T3 reconcileOpen", (e as Error).message);
  }

  console.log("\n--- T4: REAL HealthAgent + ObservabilityService storage ---");
  try {
    process.env.NEXUS_PERSISTENCE_ENGINE = "memory";

    const engine = await openEngine();
    const obs = new ObservabilityService(engine);
    const agent = new HealthAgent(obs);

    const before = await obs.listHealthChecks(1000);
    const previousIds = new Set(before.map((record) => record.id));

    await agent.checkHttpHealth(
      "http://127.0.0.1:1/?s=" +
        encodeURIComponent(SENT_PATH + " " + SENT_PW),
      50,
    );

    const after = await obs.listHealthChecks(1000);
    const newRecords = after.filter(
      (record) => !previousIds.has(record.id),
    );

    check("T4 health record persisted", newRecords.length >= 1);

    const stored = newRecords[newRecords.length - 1];

    check(
      "T4 health status BLOCKED",
      stored?.status === "BLOCKED",
      stored?.status,
    );

    check(
      "T4 health target excludes query and path",
      stored?.target === "http://127.0.0.1:1",
      stored?.target,
    );

    assertNoSentinels(
      "T4 complete persisted health record",
      stored,
      ALL_SENTINELS,
    );

    const reread = stored
      ? await obs.getHealthCheck(stored.id)
      : undefined;

    check("T4 health record readable from engine", !!reread);

    assertNoSentinels(
      "T4 reread health record",
      reread,
      ALL_SENTINELS,
    );
  } catch (e) {
    notTestedMark(
      "T4 HealthAgent persistence",
      (e as Error).message,
    );
  }

  const phaseStatus =
    failed > 0
      ? "FAIL"
      : notTested > 0
        ? "BLOCKED"
        : "PASS";

  console.log(`\nPhase 293c: ${phaseStatus}`);
  console.log(
    `Assertions: ${passed + failed}; passed: ${passed}; failed: ${failed}; notTested: ${notTested}`,
  );

  if (notTested > 0) {
    console.log(
      `BLOCKED: ${notTested} test path(s) were not executed.`,
    );
  }

  process.exitCode = phaseStatus === "PASS" ? 0 : 1;
})();
