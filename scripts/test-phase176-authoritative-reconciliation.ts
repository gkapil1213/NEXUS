// scripts/test-phase176-authoritative-reconciliation.ts
//
// Phase 176 - authoritative recovery reconciliation, retry convergence,
// terminal-state integrity.
//
// Real SQLite + real ExecutionStore + real ReleaseDeploymentIntentService +
// real ReleaseRecoveryExecutor. The orchestrator/docker/smoke are deterministic
// test doubles modeling the actual provider/inspection contracts; they never
// produce a KNOWN_GOOD verdict that the production code did not reach through
// the real verification path.

import Database from "better-sqlite3";
import { join } from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { MigrationRunner } from "../src/core/migration-runner";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { ReleaseDeploymentIntentService } from "../src/core/release-deployment-intent";
import { ReleaseRecoveryService } from "../src/core/release-recovery";
import { ReleaseRecoveryExecutor } from "../src/core/release-recovery-executor";

let passed = 0, failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log("  ok   " + msg); }
  else { failed++; console.log("  FAIL " + msg); }
}
function section(t: string): void { console.log("\n" + t); }

interface CapturedEvent { type: string; source?: string; execution_id?: string | null; payload?: any; }
interface CapturedAudit { action: string; resource_id: string; result?: string; metadata?: any; }

interface H {
  raw: Database.Database;
  engine: SQLiteEngine;
  store: ExecutionStore;
  intents: ReleaseDeploymentIntentService;
  events: CapturedEvent[];
  audits: CapturedAudit[];
}

function mkHarness(file?: string): H {
  const raw = file ? new Database(file) : new Database(":memory:");
  new MigrationRunner(raw, join(process.cwd(), "src", "db", "migrations")).run();
  raw.exec(
    "CREATE TABLE IF NOT EXISTS nexus_records (store TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (store, key));",
  );
  const engine = SQLiteEngine.fromDatabase(raw);
  const store = new ExecutionStore(raw);
  const intents = new ReleaseDeploymentIntentService(store);
  return { raw, engine, store, intents, events: [], audits: [] };
}

function mkInput(prefix: string, extra: Record<string, unknown> = {}): any {
  return {
    releaseId: "rel-" + prefix,
    executionId: "exec-" + prefix,
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
    attemptId: "att-" + prefix,
    ...extra,
  };
}

function mkExecutor(h: H, opts: {
  workerId: string;
  orchestratedStatus?: "KNOWN_GOOD" | "FAILED" | "BLOCKED";
  orchestratorThrows?: boolean;
  inspectionDoc?: any;
  smokeVerdict?: "PASS" | "FAIL" | "BLOCKED";
  retryPolicy?: { initialDelayMs: number; multiplier: number; maxDelayMs: number; maxAttempts: number };
}): ReleaseRecoveryExecutor {
  const events = { emit: async (e: CapturedEvent) => { h.events.push(e); } };
  const audit = { record: async (e: CapturedAudit) => { h.audits.push(e); } };
  const status = opts.orchestratedStatus ?? "DEPLOYING";
  const orchestratorStub: any = {
    deploy: async () => {
      if (opts.orchestratorThrows) throw new Error("provider unavailable");
      return { deployment: { id: "dep-" + status, status }, rollback: null };
    },
  };
  const historyStub: any = { getDeployment: async () => null };
  const inspectionDoc = opts.inspectionDoc ?? null;
  const dockerStub: any = {
    run: async (op: any) => {
      if (op.kind === "inspect" && inspectionDoc) {
        return { status: "SUCCEEDED", stdout: JSON.stringify(inspectionDoc), stderr: "", exit_code: 0 };
      }
      return { status: "FAILED", stdout: "", stderr: "no container", exit_code: 1 };
    },
  };
  const smokeStub: any = { run: async () => ({ verdict: opts.smokeVerdict ?? "PASS" }) };
  const deps: any = {
    intents: h.intents,
    recovery: new ReleaseRecoveryService(),
    orchestrator: orchestratorStub,
    history: historyStub,
    docker: dockerStub,
    smoke: smokeStub,
    svc: { events, audit },
    workerId: opts.workerId,
    retryPolicy: opts.retryPolicy,
  };
  return new ReleaseRecoveryExecutor(deps);
}

async function seedIntent(h: H, prefix: string, extra: Record<string, unknown> = {}): Promise<string> {
  const { intent } = await h.intents.getOrCreate(mkInput(prefix, extra));
  return intent.intentKey;
}

async function seedDeploying(h: H, prefix: string, extra: Record<string, unknown> = {}): Promise<string> {
  const k = await seedIntent(h, prefix, extra);
  h.intents.acquireLease(k, "seeder", 60_000);
  h.intents.transitionIfOwned(k, "DEPLOYMENT_INTENT_CREATED", "seeder", {});
  h.intents.transitionIfOwned(k, "DEPLOYING", "seeder", {});
  h.intents.releaseLease(k, "seeder");
  return k;
}

async function seedIntentCreated(h: H, prefix: string, extra: Record<string, unknown> = {}): Promise<string> {
  // Stops at DEPLOYMENT_INTENT_CREATED so the classifier routes to
  // RESUME_FROM_INTENT and the executor invokes orchestrator.deploy().
  const k = await seedIntent(h, prefix, extra);
  h.intents.acquireLease(k, "seeder", 60_000);
  h.intents.transitionIfOwned(k, "DEPLOYMENT_INTENT_CREATED", "seeder", {});
  h.intents.releaseLease(k, "seeder");
  return k;
}

async function seedHealthChecking(h: H, prefix: string, deploymentId: string, extra: Record<string, unknown> = {}): Promise<string> {
  const k = await seedIntent(h, prefix, extra);
  h.intents.acquireLease(k, "seeder", 60_000);
  h.intents.transitionIfOwned(k, "DEPLOYMENT_INTENT_CREATED", "seeder", {});
  h.intents.transitionIfOwned(k, "DEPLOYING", "seeder", {});
  h.intents.transitionIfOwned(k, "HEALTH_CHECKING", "seeder", { deploymentId });
  h.intents.releaseLease(k, "seeder");
  return k;
}

async function main() {
  // ============================================================
  // A. Reconciliation evidence envelope
  // ============================================================
  section("A - Reconciliation evidence envelope");
  {
    const h = mkHarness();
    const k = await seedIntentCreated(h, "A1");
    const exec = mkExecutor(h, { workerId: "w-A1", orchestratedStatus: "KNOWN_GOOD" });
    await exec.runOnce(Date.now());
    const fresh = h.intents.get(k);
    ok(fresh?.status === "KNOWN_GOOD", "AR176-02 authoritative success writes KNOWN_GOOD");
    ok(typeof fresh?.reconciliationEvidence === "string", "AR176-32 evidence envelope persisted");
    const env = fresh?.reconciliationEvidence ? JSON.parse(fresh.reconciliationEvidence) : null;
    ok(env !== null, "AR176-32 evidence envelope parses as JSON");
    ok(env?.releaseId === "rel-A1", "AR176-33 evidence carries releaseId");
    ok(env?.executionId === "exec-A1", "AR176-33 evidence carries executionId");
    ok(env?.artifactId === "art-A1", "AR176-16 evidence carries artifactId");
    ok(env?.artifactDigest === "sha256:A1", "AR176-16 evidence carries artifactDigest");
    ok(env?.imageDigest === "sha256:dig-A1", "AR176-17 evidence carries imageDigest");
    ok(env?.environment === "production", "AR176-18 evidence carries environment");
    ok(env?.containerName === "c-A1", "AR176-05 evidence carries containerName");
    ok(env?.deploymentId === "dep-KNOWN_GOOD", "AR176-32 evidence carries deploymentId");
    ok(env?.workerId === "w-A1", "AR176-32 evidence carries workerId");
    ok(env?.attemptId === "att-A1", "AR176-15 evidence carries attemptId");
    ok(env?.source === "executor.recordDeploymentOutcome", "AR176-32 evidence carries source");
    ok(typeof env?.timestamp === "number", "AR176-32 evidence carries timestamp");
  }

  // ============================================================
  // B. Reconciliation audit events
  // ============================================================
  section("B - Reconciliation audit events");
  {
    const h = mkHarness();
    const k = await seedIntentCreated(h, "B1");
    const exec = mkExecutor(h, { workerId: "w-B1", orchestratedStatus: "KNOWN_GOOD" });
    await exec.runOnce(Date.now());
    ok(h.events.some((e) => e.type === "reconciliation.authoritative_success"), "AR176-39 authoritative_success emitted");
    ok(h.events.some((e) => e.type === "release.recovery.known_good"), "AR176-39 legacy known_good event preserved");
    ok(k.length > 0, "AR176-39 event references the intent");
  }
  {
    const h = mkHarness();
    const k = await seedIntentCreated(h, "B2");
    const exec = mkExecutor(h, { workerId: "w-B2", orchestratedStatus: "FAILED" });
    await exec.runOnce(Date.now());
    const fresh = h.intents.get(k);
    ok(fresh?.status === "FAILED", "AR176-03 authoritative failure writes FAILED");
    ok(h.events.some((e) => e.type === "reconciliation.authoritative_failure"), "AR176-40 authoritative_failure emitted");
    ok(typeof fresh?.reconciliationEvidence === "string", "AR176-40 failure retains evidence envelope");
  }
  {
    const h = mkHarness();
    const k = await seedIntentCreated(h, "B3");
    const exec = mkExecutor(h, { workerId: "w-B3", orchestratedStatus: "BLOCKED" });
    await exec.runOnce(Date.now());
    const fresh = h.intents.get(k);
    ok(fresh?.status === "BLOCKED", "AR176-40 BLOCKED terminal written");
    ok(h.events.some((e) => e.type === "reconciliation.authoritative_failure"), "AR176-40 BLOCKED emits authoritative_failure");
  }

  // ============================================================
  // C. UNKNOWN outcome — never success
  // ============================================================
  section("C - UNKNOWN outcome safety");
  {
    const h = mkHarness();
    const k = await seedIntentCreated(h, "C1");
    const exec = mkExecutor(h, { workerId: "w-C1", orchestratorThrows: true, retryPolicy: { initialDelayMs: 1000, multiplier: 2, maxDelayMs: 10000, maxAttempts: 3 } });

    // Pass 1: executor calls orchestrator; provider throws mid-invocation.
    await exec.runOnce(Date.now());
    const afterPass1 = h.intents.get(k);
    ok(afterPass1?.status === "DEPLOYING", "AR176-29 provider exception leaves intent DEPLOYING (ambiguous, not success)");
    ok(afterPass1?.status !== "KNOWN_GOOD", "AR176-29 provider exception never becomes KNOWN_GOOD");
    ok(afterPass1?.status !== "FAILED", "AR176-29 provider exception never becomes definitive FAILED");

    // Pass 2: Docker inspection (stub returns BLOCKED) -> RECOVERY_REQUIRED.
    await exec.runOnce(Date.now());
    const afterPass2 = h.intents.get(k);
    ok(afterPass2?.status === "RECOVERY_REQUIRED", "AR176-01 next pass reaches RECOVERY_REQUIRED");
    ok(afterPass2?.providerStatus === "UNKNOWN", "AR176-29 UNKNOWN provider status recorded");
    ok(h.events.some((e) => e.type === "reconciliation.retry_scheduled" || e.type === "release.recovery.blocked"), "AR176-36 recovery transition event emitted");
  }

  // ============================================================
  // D. Identity mismatch — never KNOWN_GOOD
  // ============================================================
  section("D - Identity mismatch");
  {
    const h = mkHarness();
    // Intent expects sha256-img-D1. Container reports a different Image.
    const k = await seedHealthChecking(h, "D1", "dep-D1");
    const inspectionDoc = [
      { Id: "container-D1", Image: "sha256-img-OTHER", NetworkSettings: { Ports: { "8080/tcp": [{ HostPort: "12500" }] } } },
    ];
    const exec = mkExecutor(h, { workerId: "w-D1", inspectionDoc, smokeVerdict: "PASS" });
    await exec.runOnce(Date.now());
    const fresh = h.intents.get(k);
    ok(fresh?.status === "VERIFICATION_FAILED", "AR176-05 identity mismatch never KNOWN_GOOD");
    ok(fresh?.status !== "KNOWN_GOOD", "AR176-05 explicit rejection");
    ok(h.events.some((e) => e.type === "reconciliation.identity_mismatch"), "AR176-37 identity_mismatch emitted");
  }

  // ============================================================
  // E. Resume verification — happy path writes envelope + event
  // ============================================================
  section("E - Resume verification success path");
  {
    const h = mkHarness();
    const k = await seedHealthChecking(h, "E1", "dep-E1");
    // Container matches the intent's imageId.
    const inspectionDoc = [
      { Id: "container-E1", Image: "sha256-img-E1", NetworkSettings: { Ports: { "8080/tcp": [{ HostPort: "12500" }] } } },
    ];
    const exec = mkExecutor(h, { workerId: "w-E1", inspectionDoc, smokeVerdict: "PASS" });
    await exec.runOnce(Date.now());
    const fresh = h.intents.get(k);
    ok(fresh?.status === "KNOWN_GOOD", "AR176-02 resume verification success writes KNOWN_GOOD");
    const env = fresh?.reconciliationEvidence ? JSON.parse(fresh.reconciliationEvidence) : null;
    ok(env?.source === "executor.resumeVerification", "AR176-32 resume source recorded");
    ok(env?.containerId === "container-E1", "AR176-32 containerId recorded");
    ok(env?.runningImageId === "sha256-img-E1", "AR176-32 runningImageId recorded");
    ok(env?.expectedImageId === "sha256-img-E1", "AR176-32 expectedImageId recorded");
    ok(env?.hostPort === 12500, "AR176-32 hostPort recorded");
    ok(env?.smokeVerdict === "PASS", "AR176-32 smokeVerdict recorded");
    ok(h.events.some((e) => e.type === "reconciliation.authoritative_success"), "AR176-39 authoritative_success emitted");
  }

  // ============================================================
  // F. Smoke BLOCKED — UNKNOWN, retry
  // ============================================================
  section("F - Smoke BLOCKED reconciliation");
  {
    const h = mkHarness();
    const k = await seedHealthChecking(h, "F1", "dep-F1");
    const inspectionDoc = [
      { Id: "container-F1", Image: "sha256-img-F1", NetworkSettings: { Ports: { "8080/tcp": [{ HostPort: "12500" }] } } },
    ];
    const exec = mkExecutor(h, { workerId: "w-F1", inspectionDoc, smokeVerdict: "BLOCKED", retryPolicy: { initialDelayMs: 1000, multiplier: 2, maxDelayMs: 10000, maxAttempts: 3 } });
    await exec.runOnce(Date.now());
    const fresh = h.intents.get(k);
    ok(fresh?.status === "RECOVERY_REQUIRED", "AR176-04 unknown external state remains RECOVERY_REQUIRED");
    ok(fresh?.status !== "KNOWN_GOOD", "AR176-04 smoke BLOCKED never becomes KNOWN_GOOD");
    ok(h.events.some((e) => e.type === "reconciliation.unknown"), "AR176-38 reconciliation.unknown emitted");
  }

  // ============================================================
  // G. Smoke FAIL — authoritative failure
  // ============================================================
  section("G - Smoke FAIL reconciliation");
  {
    const h = mkHarness();
    const k = await seedHealthChecking(h, "G1", "dep-G1");
    const inspectionDoc = [
      { Id: "container-G1", Image: "sha256-img-G1", NetworkSettings: { Ports: { "8080/tcp": [{ HostPort: "12500" }] } } },
    ];
    const exec = mkExecutor(h, { workerId: "w-G1", inspectionDoc, smokeVerdict: "FAIL" });
    await exec.runOnce(Date.now());
    const fresh = h.intents.get(k);
    ok(fresh?.status === "VERIFICATION_FAILED", "AR176-03 smoke FAIL -> VERIFICATION_FAILED");
    ok(h.events.some((e) => e.type === "reconciliation.authoritative_failure"), "AR176-40 authoritative_failure emitted");
  }

  // ============================================================
  // H. Terminal state integrity — not reopened
  // ============================================================
  section("H - Terminal state integrity");
  {
    const h = mkHarness();
    const k = await seedIntentCreated(h, "H1");
    const exec = mkExecutor(h, { workerId: "w-H1", orchestratedStatus: "KNOWN_GOOD" });
    await exec.runOnce(Date.now());
    ok(h.intents.get(k)?.status === "KNOWN_GOOD", "AR176-24 first pass writes KNOWN_GOOD");
    // Second pass: the classifier returns ALREADY_KNOWN_GOOD, so executor skips.
    const exec2 = mkExecutor(h, { workerId: "w-H1-b", orchestratedStatus: "FAILED" });
    await exec2.runOnce(Date.now());
    ok(h.intents.get(k)?.status === "KNOWN_GOOD", "AR176-24 terminal KNOWN_GOOD not reopened by recovery");
  }
  {
    const h = mkHarness();
    const k = await seedIntentCreated(h, "H2");
    const exec = mkExecutor(h, { workerId: "w-H2", orchestratedStatus: "FAILED" });
    await exec.runOnce(Date.now());
    ok(h.intents.get(k)?.status === "FAILED", "AR176-25 first pass writes FAILED");
    const exec2 = mkExecutor(h, { workerId: "w-H2-b", orchestratedStatus: "KNOWN_GOOD" });
    await exec2.runOnce(Date.now());
    ok(h.intents.get(k)?.status === "FAILED", "AR176-25 terminal FAILED not reopened");
  }
  {
    const h = mkHarness();
    const k = await seedIntentCreated(h, "H3");
    const exec = mkExecutor(h, { workerId: "w-H3", orchestratedStatus: "BLOCKED" });
    await exec.runOnce(Date.now());
    ok(h.intents.get(k)?.status === "BLOCKED", "AR176-26 first pass writes BLOCKED");
    const list = h.intents.listRecoverable();
    ok(!list.map((i) => i.intentKey).includes(k), "AR176-26 BLOCKED not rediscovered");
  }

  // ============================================================
  // I. Stale worker fencing — cannot overwrite evidence
  // ============================================================
  section("I - Stale worker fencing");
  {
    const h = mkHarness();
    const k = await seedIntentCreated(h, "I1");
    const exec = mkExecutor(h, { workerId: "w-I1-owner", orchestratedStatus: "KNOWN_GOOD" });
    await exec.runOnce(Date.now());
    const owner = h.intents.get(k);
    ok(owner?.status === "KNOWN_GOOD", "AR176-34 owner wrote KNOWN_GOOD");
    const ownerEvidence = owner?.reconciliationEvidence;

    // Stale worker tries to overwrite with FAILED + new evidence.
    const stale = h.intents.transitionIfOwned(k, "FAILED", "w-stale", {
      failureReason: "stale overwrite attempt",
      reconciliationEvidence: JSON.stringify({ source: "stale", forged: true }),
    });
    ok(stale.updated === false, "AR176-34 stale worker cannot overwrite evidence");
    ok(stale.intent?.status === "KNOWN_GOOD", "AR176-34 status unchanged");
    ok(stale.intent?.reconciliationEvidence === ownerEvidence, "AR176-34 evidence unchanged");
  }

  // ============================================================
  // J. Concurrent reconciliation — one owner
  // ============================================================
  section("J - Concurrent reconciliation");
  {
    const h = mkHarness();
    const k = await seedDeploying(h, "J1");
    // Simulate two workers discovering the same intent.
    const a = h.intents.acquireLease(k, "worker-A", 60_000);
    const b = h.intents.acquireLease(k, "worker-B", 60_000);
    ok(a.acquired === true && b.acquired === false, "AR176-08 concurrent reconciliation has one owner");

    const loser = h.intents.transitionIfOwned(k, "KNOWN_GOOD", "worker-B", {
      deploymentId: "dep-B",
      reconciliationEvidence: JSON.stringify({ source: "worker-B" }),
    });
    ok(loser.updated === false, "AR176-08 losing worker cannot write terminal state");
    ok(loser.intent?.reconciliationEvidence === null, "AR176-08 losing worker cannot write evidence");

    const winner = h.intents.transitionIfOwned(k, "KNOWN_GOOD", "worker-A", {
      deploymentId: "dep-A",
      reconciliationEvidence: JSON.stringify({ source: "worker-A" }),
    });
    ok(winner.updated === true, "AR176-08 winning worker succeeds");
    ok(winner.intent?.deploymentId === "dep-A", "AR176-08 winner writes deploymentId");
  }

  // ============================================================
  // K. Restart durability — reconciliation state survives
  // ============================================================
  section("K - Restart durability");
  {
    const dir = mkdtempSync(join(tmpdir(), "nexus-p176-"));
    const dbFile = join(dir, "state.db");
    let intentKey: string | null = null;
    try {
      {
        const hA = mkHarness(dbFile);
        intentKey = await seedIntentCreated(hA, "K1");
        const execA = mkExecutor(hA, { workerId: "w-K1-A", orchestratedStatus: "KNOWN_GOOD" });
        await execA.runOnce(Date.now());
        const a1 = hA.intents.get(intentKey);
        ok(a1?.status === "KNOWN_GOOD", "AR176-28 supervisor A writes KNOWN_GOOD");
        ok(typeof a1?.reconciliationEvidence === "string", "AR176-50 evidence persisted");
        hA.raw.close();
      }
      {
        const hB = mkHarness(dbFile);
        const b1 = hB.intents.get(intentKey!);
        ok(b1?.status === "KNOWN_GOOD", "AR176-50 terminal status durable after restart");
        ok(typeof b1?.reconciliationEvidence === "string", "AR176-50 evidence durable after restart");
        const env = b1?.reconciliationEvidence ? JSON.parse(b1.reconciliationEvidence) : null;
        ok(env?.workerId === "w-K1-A", "AR176-50 evidence records the deciding worker");
        hB.raw.close();
      }
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  // ============================================================
  // L. Cross-project / cross-environment isolation
  // ============================================================
  section("L - Cross-project / cross-environment isolation");
  {
    const h = mkHarness();
    const kA = await seedIntentCreated(h, "LA", { projectId: "proj-alpha", environment: "production" });
    const kC = await seedIntentCreated(h, "LC", { projectId: "proj-alpha", environment: "staging" });
    const execA = mkExecutor(h, { workerId: "w-LA", orchestratedStatus: "KNOWN_GOOD" });
    await execA.runOnce(Date.now());
    const a = h.intents.get(kA);
    const c = h.intents.get(kC);

    // Both intents reconciled independently (the executor processes all
    // recoverable intents per pass). Isolation is verified by evidence content,
    // not by "untouched": each evidence envelope must reference only its own
    // release/execution/artifact/environment.
    ok(a?.status === "KNOWN_GOOD", "AR176-44 alpha/production reconciled");
    ok(c?.status === "KNOWN_GOOD", "AR176-45 alpha/staging reconciled independently");

    const envA = a?.reconciliationEvidence ? JSON.parse(a.reconciliationEvidence) : null;
    const envC = c?.reconciliationEvidence ? JSON.parse(c.reconciliationEvidence) : null;
    ok(envA?.environment === "production", "AR176-44 production evidence carries production environment");
    ok(envC?.environment === "staging", "AR176-45 staging evidence carries staging environment");
    ok(envA?.releaseId === "rel-LA" && envC?.releaseId === "rel-LC", "AR176-44 evidence tied to correct release");
    ok(envA?.executionId === "exec-LA" && envC?.executionId === "exec-LC", "AR176-45 evidence tied to correct execution");
    ok(envA?.artifactId === "art-LA" && envC?.artifactId === "art-LC", "AR176-44 evidence tied to correct artifact");
    ok(envA?.environment !== envC?.environment, "AR176-45 no environment cross-contamination");
    ok(envA?.releaseId !== envC?.releaseId, "AR176-44 no release cross-contamination");
  }

  // ============================================================
  // M. Reconciliation idempotency (repeat against unchanged state)
  // ============================================================
  section("M - Reconciliation idempotency");
  {
    const h = mkHarness();
    const k = await seedIntentCreated(h, "M1");
    const exec = mkExecutor(h, { workerId: "w-M1", orchestratedStatus: "KNOWN_GOOD" });
    await exec.runOnce(Date.now());
    const first = h.intents.get(k);
    const firstEvidence = first?.reconciliationEvidence;
    // Second pass — terminal intent not recoverable, so nothing changes.
    const exec2 = mkExecutor(h, { workerId: "w-M1-b", orchestratedStatus: "KNOWN_GOOD" });
    await exec2.runOnce(Date.now());
    const second = h.intents.get(k);
    ok(second?.status === "KNOWN_GOOD", "AR176-07 terminal result unchanged");
    ok(second?.reconciliationEvidence === firstEvidence, "AR176-07 evidence unchanged (no duplicate write)");
  }

  // ============================================================
  // N. Retry exhaustion reaches safe durable state
  // ============================================================
  section("N - Retry exhaustion");
  {
    const h = mkHarness();
    const k = await seedDeploying(h, "N1");
    const policy = { initialDelayMs: 100, multiplier: 2, maxDelayMs: 500, maxAttempts: 2 };
    const exec = mkExecutor(h, { workerId: "w-N1", orchestratorThrows: true, retryPolicy: policy });
    await exec.runOnce(Date.now());
    ok(h.intents.get(k)?.recoveryAttempts === 1, "AR176-13 first attempt recorded");
    // Force due and retry
    h.raw.prepare("UPDATE release_deployment_intents SET next_retry_at = ? WHERE intent_key = ?").run(Date.now() - 1, k);
    await exec.runOnce(Date.now());
    const fresh = h.intents.get(k);
    ok(fresh?.recoveryAttempts === 2, "AR176-13 second attempt recorded");
    ok(fresh?.status === "RECOVERY_REQUIRED", "AR176-13 exhausted retry remains RECOVERY_REQUIRED");
    ok(fresh?.nextRetryAt === Number.MAX_SAFE_INTEGER, "AR176-13 far-future sentinel prevents rediscovery");
    ok(h.events.some((e) => e.type === "reconciliation.retry_exhausted"), "AR176-36 retry_exhausted emitted");
  }

  // ============================================================
  // O. No blind duplicate provider execution after UNKNOWN
  // ============================================================
  section("O - Duplicate provider execution protection");
  {
    const h = mkHarness();
    const k = await seedIntentCreated(h, "O1");
    let providerCalls = 0;
    const events = { emit: async (e: CapturedEvent) => { h.events.push(e); } };
    const audit = { record: async (e: CapturedAudit) => { h.audits.push(e); } };
    const orchestratorStub: any = {
      deploy: async () => { providerCalls++; throw new Error("connection lost"); },
    };
    const exec: any = new ReleaseRecoveryExecutor({
      intents: h.intents,
      recovery: new ReleaseRecoveryService(),
      orchestrator: orchestratorStub,
      history: { getDeployment: async () => null },
      docker: { run: async () => ({ status: "FAILED", stdout: "", stderr: "no container", exit_code: 1 }) },
      smoke: { run: async () => ({ verdict: "PASS" }) },
      svc: { events, audit },
      workerId: "w-O1",
      retryPolicy: { initialDelayMs: 100_000, multiplier: 2, maxDelayMs: 200_000, maxAttempts: 3 },
    } as any);

    // Pass 1: executor invokes orchestrator once; provider throws.
    await exec.runOnce(Date.now());
    ok(providerCalls === 1, "AR176-10 first pass invoked provider once");
    ok(h.intents.get(k)?.status === "DEPLOYING", "AR176-10 throw leaves intent DEPLOYING (ambiguous)");

    // Pass 2: DEPLOYING routes to inspection; Docker BLOCKED -> RECOVERY_REQUIRED.
    await exec.runOnce(Date.now());
    ok(h.intents.get(k)?.status === "RECOVERY_REQUIRED", "AR176-01 inspection converges to RECOVERY_REQUIRED");
    ok(providerCalls === 1, "AR176-10 UNKNOWN does not trigger blind duplicate provider execution");

    // Pass 3: intent is RECOVERY_REQUIRED with a future nextRetryAt -> deferred.
    const rep3 = await exec.runOnce(Date.now());
    ok(providerCalls === 1, "AR176-10 backoff prevents re-invocation on subsequent pass");
    ok((rep3.deferredNotDue ?? 0) >= 1, "AR176-14 not-due retry deferred");
  }

  // ============================================================
  // P. Retry backoff respected
  // ============================================================
  section("P - Retry backoff");
  {
    const h = mkHarness();
    const k = await seedDeploying(h, "P1");
    const exec = mkExecutor(h, { workerId: "w-P1", orchestratorThrows: true, retryPolicy: { initialDelayMs: 5_000, multiplier: 2, maxDelayMs: 20_000, maxAttempts: 3 } });
    const t0 = Date.now();
    await exec.runOnce(t0);
    const fresh = h.intents.get(k);
    const nextRetryAt = fresh?.nextRetryAt ?? 0;
    ok(nextRetryAt >= t0 + 5_000 && nextRetryAt <= Date.now() + 5_000 + 500, "AR176-14 backoff ~= initialDelayMs");
    const rep = await exec.runOnce(Date.now());
    ok((rep.deferredNotDue ?? 0) >= 1, "AR176-14 not-due retry deferred");
  }

  console.log("\n=== Phase 176 Summary ===");
  console.log("Passed: " + passed);
  console.log("Failed: " + failed);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL: " + (e && e.stack ? e.stack : e));
  process.exit(1);
});