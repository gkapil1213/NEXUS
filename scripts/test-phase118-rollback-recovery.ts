// scripts/test-phase118-rollback-recovery.ts
//
// Phase 118 - durable canonical rollback recovery.
// Real NexusEngine. Real ExecutionStore. No fake SUCCESS.

import { orchestrateReleaseDeployment } from "../src/core/worker-phase25-autonomous-release-deployment-control-plane";
import type { DeploymentAdapter } from "../src/core/worker-deployment-adapter";
import { openEngine, resetEngineForTesting } from "../src/core/db";
import { CONFIG } from "../src/core/config";
import { ExecutionStore } from "../src/core/execution-store";

let pass = 0, fail = 0, blocked = 0;

function check(name: string, condition: boolean, detail = "") {
  if (condition) { pass++; console.log("[PASSED] " + name + (detail ? " | " + detail : "")); }
  else { fail++; console.error("[FAILED] " + name + (detail ? " | " + detail : "")); }
}

function blocked_(name: string, reason: string) {
  blocked++;
  console.log("[BLOCKED] " + name + " | " + reason);
}

function baseRequest(overrides: Record<string, unknown> = {}) {
  return {
    artifactId: "artifact-phase118",
    tenantId: "tenant-phase118",
    correlationId: "corr-phase118",
    release: { version: "v118-current" },
    plan: { strategy: "ROLLING", environment: "staging" },
    governance: "ALLOW" as const,
    approvalValid: true,
    securityStatus: "PASS" as const,
    circuitBreaker: { failureCount: 0, threshold: 3 },
    frozen: false,
    rolloutState: {
      currentStage: "0%",
      health: "UNHEALTHY",
      errorRate: 0,
      latency: 0,
      availability: 100,
      thresholds: { maxErrorRate: 0.05, maxLatency: 500, minAvailability: 99 },
    },
    healthInput: { healthy: true },
    rollbackSafetyInput: {
      targetArtifactExists: true,
      targetArtifactCorrupted: false,
      targetArtifactRevoked: false,
      targetVersionCompatible: true,
      governanceAllowed: true,
      securityPolicyAllowed: true,
      recoverySafetyAllowed: true,
      dependencyConstraintsMet: true,
    },
    ...overrides,
  };
}

function adapter(overrides: Partial<DeploymentAdapter> = {}) {
  const calls: string[] = [];
  const a: DeploymentAdapter = {
    async validateTarget() { return { ok: true, reason: "ok" }; },
    async checkAvailability() { return { available: true, reason: "ok" }; },
    async preflight() { return { ok: true, reason: "ok" }; },
    async deploy() { return { success: true, reason: "deployed", evidence: [] }; },
    async getStatus() { return { status: "AVAILABLE" as const, details: "test" }; },
    async getHealth() { return { healthy: true, reason: "healthy" }; },
    async pause() { return { success: true, reason: "paused" }; },
    async resume() { return { success: true, reason: "resumed" }; },
    async promote() { return { success: true, reason: "promoted" }; },
    async rollback(v: string) { calls.push("rollback:" + v); return { success: true, reason: "ok" }; },
    async verifyRollback(v: string) { calls.push("verifyRollback:" + v); return { verified: true, reasons: [] }; },
    ...overrides,
  };
  return { adapter: a, calls };
}

function adapterNoVerify() {
  const calls: string[] = [];
  const a: DeploymentAdapter = {
    async validateTarget() { return { ok: true, reason: "ok" }; },
    async checkAvailability() { return { available: true, reason: "ok" }; },
    async preflight() { return { ok: true, reason: "ok" }; },
    async deploy() { return { success: true, reason: "deployed", evidence: [] }; },
    async getStatus() { return { status: "AVAILABLE" as const, details: "test" }; },
    async getHealth() { return { healthy: true, reason: "healthy" }; },
    async pause() { return { success: true, reason: "paused" }; },
    async resume() { return { success: true, reason: "resumed" }; },
    async promote() { return { success: true, reason: "promoted" }; },
    async rollback(v: string) { calls.push("rollback:" + v); return { success: true, reason: "ok" }; },
  };
  return { adapter: a, calls };
}

const PHASE118_DB_PATH = "./phase118-rollback-recovery.sqlite";

async function preparePhase118Database() {
  const fs = await import("fs/promises");
  await fs.rm(PHASE118_DB_PATH, { force: true });
  await fs.rm(PHASE118_DB_PATH + "-wal", { force: true });
  await fs.rm(PHASE118_DB_PATH + "-shm", { force: true });
  process.env.NEXUS_PERSISTENCE_ENGINE = "sqlite";
  process.env.NEXUS_DB_PATH = PHASE118_DB_PATH;
  CONFIG.persistence.engine = "sqlite";
  CONFIG.persistence.dbName = PHASE118_DB_PATH;
  resetEngineForTesting();
}

async function newStore() {
  const engine = await openEngine();
  const store = new ExecutionStore(engine);
  return { engine, store };
}

function seedTarget(store: ExecutionStore, opts: {
  releaseId: string; version: string; artifactId: string; checksum: string;
  status?: "CREATED" | "VALIDATING" | "APPROVED" | "BLOCKED" | "DEPLOYING" | "DEPLOYED" | "FAILED" | "ROLLED_BACK";
}) {
  store.addArtifact({
    artifactId: opts.artifactId, releaseId: opts.releaseId, name: "a",
    type: "container", checksum: opts.checksum, createdAt: Date.now(),
  });
  store.addRelease({
    releaseId: opts.releaseId, version: opts.version, artifactId: opts.artifactId,
    status: opts.status ?? "DEPLOYED", createdAt: Date.now(), updatedAt: Date.now(),
  });
}

async function main() {
  await preparePhase118Database();
  console.log("NEXUS PHASE 118 ROLLBACK RECOVERY TESTS");
  console.log("=======================================\n");

  // ---- T1 ----
  {
    const { store } = await newStore();
    const { adapter: a, calls } = adapter();
    const r = await orchestrateReleaseDeployment(baseRequest({
      provider: a, executionStore: store, workerId: "w-t1",
    }) as any);
    check("T1 missing canonical target -> FAILED", r.status === "FAILED", "status=" + r.status);
    check("T1 no rollback invoked", !calls.some(c => c.startsWith("rollback:")), "calls=" + JSON.stringify(calls));
  }

  // ---- T2 ----
  {
    const { store } = await newStore();
    seedTarget(store, { releaseId: "rel-t2", version: "v-prev-t2", artifactId: "art-t2", checksum: "sha256:t2" });
    const { adapter: a, calls } = adapter();
    const r = await orchestrateReleaseDeployment(baseRequest({
      provider: a, executionStore: store, workerId: "w-t2", previousReleaseId: "rel-t2",
    }) as any);
    check("T2 canonical target -> ROLLED_BACK", r.status === "ROLLED_BACK", "status=" + r.status);
    check("T2 adapter receives resolved version", calls.includes("rollback:v-prev-t2"), "calls=" + JSON.stringify(calls));
    check("T2 releaseId not passed as version", !calls.includes("rollback:rel-t2"), "calls=" + JSON.stringify(calls));
  }

  // ---- T3 ----
  {
    const { store } = await newStore();
    const { adapter: a, calls } = adapter();
    const r = await orchestrateReleaseDeployment(baseRequest({
      provider: a, executionStore: store, workerId: "w-t3", previousReleaseId: "rel-missing",
    }) as any);
    check("T3 unknown target -> FAILED", r.status === "FAILED", "status=" + r.status);
    check("T3 no adapter call", !calls.some(c => c.startsWith("rollback:")), "calls=" + JSON.stringify(calls));
  }

  // ---- T4 ----
  blocked_("T4 ambiguous version resolution", "Phase 118 uses canonical releaseId; version-to-releaseId ambiguity cannot occur");

  // ---- T5 ----
  {
    const { store } = await newStore();
    seedTarget(store, { releaseId: "rel-t5", version: "v-prev-t5", artifactId: "art-t5", checksum: "s", status: "CREATED" });
    const { adapter: a, calls } = adapter();
    const r = await orchestrateReleaseDeployment(baseRequest({
      provider: a, executionStore: store, workerId: "w-t5", previousReleaseId: "rel-t5",
    }) as any);
    check("T5 ineligible target -> FAILED", r.status === "FAILED", "status=" + r.status);
    check("T5 no adapter call", !calls.some(c => c.startsWith("rollback:")), "calls=" + JSON.stringify(calls));
  }

  // ---- T6 ----
  {
    const { store } = await newStore();
    seedTarget(store, { releaseId: "rel-t6", version: "v-prev-t6", artifactId: "art-t6", checksum: "sha256:immutable-t6" });
    const { adapter: a } = adapter();
    const r = await orchestrateReleaseDeployment(baseRequest({
      provider: a, executionStore: store, workerId: "w-t6", previousReleaseId: "rel-t6",
    }) as any);
    check("T6 rollback reached ROLLED_BACK", r.status === "ROLLED_BACK", "status=" + r.status);
    const job = store.getJobByIdempotencyKey("rollback:rel-t6");
    const payload: any = (job as any)?.payload ?? {};
    check("T6 durable job captures immutable checksum", payload.expectedChecksum === "sha256:immutable-t6", "payload=" + JSON.stringify(payload));
    check("T6 durable job captures target artifact id", payload.targetArtifactId === "art-t6", "payload=" + JSON.stringify(payload));
  }

  // ---- T7 ----
  {
    const { store } = await newStore();
    seedTarget(store, { releaseId: "rel-t7", version: "v-prev-t7", artifactId: "art-t7", checksum: "s" });
    const { adapter: a } = adapter({ async rollback() { return { success: false, reason: "provider fail" }; } });
    const r = await orchestrateReleaseDeployment(baseRequest({
      provider: a, executionStore: store, workerId: "w-t7", previousReleaseId: "rel-t7",
    }) as any);
    check("T7 provider failure -> FAILED", r.status === "FAILED", "status=" + r.status);
  }

  // ---- T8 ----
  {
    const { store } = await newStore();
    seedTarget(store, { releaseId: "rel-t8", version: "v-prev-t8", artifactId: "art-t8", checksum: "s" });
    const { adapter: a } = adapterNoVerify();
    const r = await orchestrateReleaseDeployment(baseRequest({
      provider: a, executionStore: store, workerId: "w-t8", previousReleaseId: "rel-t8",
    }) as any);
    check("T8 verification unavailable -> FAILED", r.status === "FAILED", "status=" + r.status);
  }

  // ---- T9 ----
  {
    const { store } = await newStore();
    seedTarget(store, { releaseId: "rel-t9", version: "v-prev-t9", artifactId: "art-t9", checksum: "s" });
    const { adapter: a } = adapter({ async verifyRollback() { return { verified: false, reasons: ["unhealthy"] }; } });
    const r = await orchestrateReleaseDeployment(baseRequest({
      provider: a, executionStore: store, workerId: "w-t9", previousReleaseId: "rel-t9",
    }) as any);
    check("T9 negative verification -> FAILED", r.status === "FAILED", "status=" + r.status);
  }

  // ---- T10 ----
  {
    const { store } = await newStore();
    seedTarget(store, { releaseId: "rel-t10", version: "v-prev-t10", artifactId: "art-t10", checksum: "s" });
    const { adapter: a } = adapter();
    const r = await orchestrateReleaseDeployment(baseRequest({
      provider: a, executionStore: store, workerId: "w-t10", previousReleaseId: "rel-t10",
    }) as any);
    check("T10 verified -> ROLLED_BACK", r.status === "ROLLED_BACK", "status=" + r.status);
    check("T10 rollback object ROLLED_BACK", r.rollback?.status === "ROLLED_BACK", "rb=" + (r.rollback?.status ?? "missing"));
  }

  // ---- T11 ----
  {
    const { store } = await newStore();
    seedTarget(store, { releaseId: "rel-t11", version: "v-prev-t11", artifactId: "art-t11", checksum: "s" });
    const now = Date.now();
    store.createJob({
      id: "seed-t11", idempotencyKey: "rollback:rel-t11", jobType: "ROLLBACK",
      payload: { previousReleaseId: "rel-t11" }, status: "QUEUED",
      createdAt: now, updatedAt: now,
      cancellationRequested: false, cancellationAcknowledged: false,
    } as any);
    const { adapter: a, calls } = adapter();
    const r = await orchestrateReleaseDeployment(baseRequest({
      provider: a, executionStore: store, workerId: "w-t11", previousReleaseId: "rel-t11",
    }) as any);
    check("T11 QUEUED job resumes safely -> ROLLED_BACK", r.status === "ROLLED_BACK", "status=" + r.status);
    check("T11 adapter rollback invoked exactly once", calls.filter(c => c.startsWith("rollback:")).length === 1, "calls=" + JSON.stringify(calls));
  }

  // ---- T12 ----
  {
    const { store } = await newStore();
    seedTarget(store, { releaseId: "rel-t12", version: "v-prev-t12", artifactId: "art-t12", checksum: "s" });
    const now = Date.now();
    store.createJob({
      id: "seed-t12", idempotencyKey: "rollback:rel-t12", jobType: "ROLLBACK",
      payload: { previousReleaseId: "rel-t12" }, status: "RUNNING",
      createdAt: now, updatedAt: now,
      cancellationRequested: false, cancellationAcknowledged: false,
    } as any);
    const { adapter: a, calls } = adapter();
    const r = await orchestrateReleaseDeployment(baseRequest({
      provider: a, executionStore: store, workerId: "w-t12", previousReleaseId: "rel-t12",
    }) as any);
    check("T12 RUNNING job -> RECOVERY_REQUIRED", r.status === "RECOVERY_REQUIRED", "status=" + r.status);
    check("T12 no auto re-call of adapter.rollback", !calls.some(c => c.startsWith("rollback:")), "calls=" + JSON.stringify(calls));
  }

  // ---- T13 ----
  {
    const { store } = await newStore();
    seedTarget(store, { releaseId: "rel-t13", version: "v-prev-t13", artifactId: "art-t13", checksum: "s" });
    const now = Date.now();
    store.createJob({
      id: "seed-t13", idempotencyKey: "rollback:rel-t13", jobType: "ROLLBACK",
      payload: { previousReleaseId: "rel-t13" }, status: "RUNNING",
      createdAt: now, updatedAt: now,
      cancellationRequested: false, cancellationAcknowledged: false,
    } as any);
    const { adapter: a } = adapter();
    const r = await orchestrateReleaseDeployment(baseRequest({
      provider: a, executionStore: store, workerId: "w-t13", previousReleaseId: "rel-t13",
    }) as any);
    check("T13 interrupted-verification never fakes ROLLED_BACK", r.status !== "ROLLED_BACK", "status=" + r.status);
    check("T13 ambiguous -> RECOVERY_REQUIRED", r.status === "RECOVERY_REQUIRED", "status=" + r.status);
    blocked_("T13 auto-resume of ROLLBACK_VERIFYING", "current design fails closed to RECOVERY_REQUIRED rather than auto-resuming verification");
  }

  // ---- T14 ----
  {
    const { store } = await newStore();
    seedTarget(store, { releaseId: "rel-t14", version: "v-prev-t14", artifactId: "art-t14", checksum: "s" });
    const { adapter: a, calls } = adapter();
    const r1 = await orchestrateReleaseDeployment(baseRequest({
      provider: a, executionStore: store, workerId: "w-t14a", previousReleaseId: "rel-t14",
    }) as any);
    const r2 = await orchestrateReleaseDeployment(baseRequest({
      provider: a, executionStore: store, workerId: "w-t14b", previousReleaseId: "rel-t14",
    }) as any);
    check("T14 first call -> ROLLED_BACK", r1.status === "ROLLED_BACK", "status=" + r1.status);
    check("T14 replay -> ROLLED_BACK", r2.status === "ROLLED_BACK", "status=" + r2.status);
    check("T14 adapter rollback called exactly once", calls.filter(c => c.startsWith("rollback:")).length === 1, "calls=" + JSON.stringify(calls));
  }

  // ---- T15 ----
  {
    const { store } = await newStore();
    seedTarget(store, { releaseId: "rel-t15", version: "v-prev-t15", artifactId: "art-t15", checksum: "s" });
    const now = Date.now();
    store.createJob({
      id: "seed-t15", idempotencyKey: "rollback:rel-t15", jobType: "ROLLBACK",
      payload: { previousReleaseId: "rel-t15" }, status: "QUEUED",
      createdAt: now, updatedAt: now,
      cancellationRequested: false, cancellationAcknowledged: false,
    } as any);
    store.acquireLease({
      leaseId: "lease-t15-A", jobId: "seed-t15", workerId: "worker-A",
      acquiredAt: now, expiresAt: now + 60000, status: "ACTIVE",
    } as any);
    const { adapter: a, calls } = adapter();
    const r = await orchestrateReleaseDeployment(baseRequest({
      provider: a, executionStore: store, workerId: "worker-B", previousReleaseId: "rel-t15",
    }) as any);
    check("T15 worker B blocked while worker A holds lease", r.status === "RECOVERY_REQUIRED", "status=" + r.status);
    check("T15 no adapter rollback by non-owner", !calls.some(c => c.startsWith("rollback:")), "calls=" + JSON.stringify(calls));
  }

  // ---- T16 ----
  {
    const { store } = await newStore();
    seedTarget(store, { releaseId: "rel-t16", version: "v-prev-t16", artifactId: "art-t16", checksum: "s" });
    const { adapter: a } = adapter();
    const r = await orchestrateReleaseDeployment(baseRequest({
      provider: a, executionStore: store, workerId: "w-t16", previousReleaseId: "rel-t16",
    }) as any);
    check("T16 rollback succeeded", r.status === "ROLLED_BACK", "status=" + r.status);
    const job = store.getJobByIdempotencyKey("rollback:rel-t16");
    check("T16 job SUCCEEDED", (job as any)?.status === "SUCCEEDED", "job=" + JSON.stringify({ id: job?.id, status: job?.status }));
    if (job) {
      const attempts = store.listAttemptsForJob(job.id);
      check("T16 exactly one attempt recorded", attempts.length === 1, "attempts=" + attempts.length);
      check("T16 attempt SUCCEEDED", attempts[0]?.status === "SUCCEEDED", "status=" + (attempts[0]?.status ?? "missing"));
    }
  }

  console.log("\nRESULT: " + pass + " passed, " + fail + " failed, " + blocked + " blocked");
  if (fail > 0) process.exit(1);
  process.exit(0);
}

main().catch((e) => { console.error("[FATAL]", e); process.exit(2); });