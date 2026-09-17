// scripts/test-phase138-recovery.ts
// Phase 138 - deployment crash recovery and reconciliation.

import Database from "better-sqlite3";
import { join } from "path";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { MigrationRunner } from "../src/core/migration-runner";
import { ExecutionStore } from "../src/core/execution-store";
import { ReleaseDeploymentIntentService } from "../src/core/release-deployment-intent";
import { ReleaseRecoveryService } from "../src/core/release-recovery";
import { ReleaseRecoveryExecutor } from "../src/core/release-recovery-executor";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log("  ok   " + msg); }
  else      { failed++; console.log("  FAIL " + msg); }
}

function makeHarness(workerId: string): any {
  const rawDb = new Database(":memory:");
  const migrationsDir = join(process.cwd(), "src", "db", "migrations");
  new MigrationRunner(rawDb, migrationsDir).run();
  const db = SQLiteEngine.fromDatabase(rawDb);
  const store = new ExecutionStore(db as any);
  const intents = new ReleaseDeploymentIntentService(store);

  const deployCalls = { count: 0 };
  const docker = { verdict: "MISSING", reason: undefined, hostPort: undefined };
  const smoke = { verdict: "PASS" };

  const orchestrator = {
    async deploy(_req: any) {
      deployCalls.count++;
      return { deployment: { id: "dep-recovery-1", status: "KNOWN_GOOD", failure_reason: null }, rollback: null };
    },
  };

  const dockerAdapter = {
    async run(req: { kind: string; image: string }) {
      if (docker.verdict === "MISSING") {
        return { status: "FAILED", stdout: "", stderr: "Error: No such object: " + req.image, exit_code: 1 };
      }
      if (docker.verdict === "BLOCKED") {
        return { status: "BLOCKED", blocked_reason: docker.reason ?? "host executor unavailable" };
      }
      const imageId = docker.verdict === "MATCHES_INTENT" ? "img-1" : "img-other";
      const ports: any = docker.hostPort
        ? { "8080/tcp": [{ HostPort: String(docker.hostPort) }] }
        : {};
      const doc = { Id: "cid-recovery", Image: imageId, NetworkSettings: { Ports: ports } };
      return { status: "SUCCEEDED", stdout: JSON.stringify([doc]), stderr: "", exit_code: 0 };
    },
  };

  const smokeSvc = {
    async run(_args: any) { return { verdict: smoke.verdict, message: "" }; },
  };

  const svc = {
    events: { emit: async (e: any) => e },
    audit: { record: async (e: any) => e },
  };

  const executor = new ReleaseRecoveryExecutor({
    intents,
    recovery: new ReleaseRecoveryService(),
    orchestrator,
    history: {},
    docker: dockerAdapter,
    smoke: smokeSvc,
    svc,
    workerId,
    reconciler: { reconcile: async () => ({}) },
    verifyRecoveredRollback: undefined,
    leaseTtlMs: 30000,
  } as any);

  return { store, intents, deployCalls, docker, smoke, executor };
}

async function seedIntent(intents: any, status: string, patch: any = {}): string {
  const result = await intents.getOrCreate({
    releaseId: "rel-1",
    executionId: "exec-1",
    artifactId: "art-1",
    artifactDigest: "sha256:abc",
    commitSha: "deadbeef",
    environment: "production",
    projectId: "proj-1",
    imageRepository: "registry/img",
    imageTag: "v1.0.0",
    imageId: "img-1",
    imageDigest: "sha256:abc",
    containerName: "container-1",
    containerPort: 8080,
  });
  intents.transition(result.intent.intentKey, status, patch);
  return result.intent.intentKey;
}

async function main() {
  console.log("=== Phase 138 - Deployment Crash Recovery ===\n");

  console.log("T01 - crash after DEPLOYING: container missing -> RECOVERY_REQUIRED");
  {
    const h = makeHarness("nexus-A");
    const key = await seedIntent(h.intents, "DEPLOYING", { provider: "canonical-deployment-orchestrator", startedAt: Date.now() });
    h.docker.verdict = "MISSING";
    await h.executor.runOnce();
    const fresh = h.intents.get(key);
    ok(fresh?.status === "RECOVERY_REQUIRED", "T01 intent at RECOVERY_REQUIRED");
    ok(typeof fresh?.reconciledAt === "number", "T01 reconciledAt set");
    ok(fresh?.providerStatus === "UNKNOWN", "T01 providerStatus=UNKNOWN");
    ok(h.deployCalls.count === 0, "T01 orchestrator.deploy not called");
  }

  console.log("\nT02 - crash before KNOWN_GOOD: recovery resumes verification");
  {
    const h = makeHarness("nexus-B");
    const key = await seedIntent(h.intents, "HEALTH_CHECKING", { deploymentId: "dep-existing" });
    h.docker.verdict = "MATCHES_INTENT";
    h.docker.hostPort = 12345;
    h.smoke.verdict = "PASS";
    await h.executor.runOnce();
    const fresh = h.intents.get(key);
    ok(fresh?.status === "KNOWN_GOOD", "T02 intent reaches KNOWN_GOOD");
    ok(typeof fresh?.reconciledAt === "number", "T02 reconciledAt set");
    ok(h.deployCalls.count === 0, "T02 orchestrator.deploy not called");
  }

  console.log("\nT03 - ambiguous smoke does NOT fabricate success");
  {
    const h = makeHarness("nexus-C");
    const key = await seedIntent(h.intents, "SMOKE_TESTING", { deploymentId: "dep-existing" });
    h.docker.verdict = "MATCHES_INTENT";
    h.docker.hostPort = 12345;
    h.smoke.verdict = "BLOCKED";
    await h.executor.runOnce();
    const fresh = h.intents.get(key);
    ok(fresh?.status === "RECOVERY_REQUIRED", "T03 intent at RECOVERY_REQUIRED");
    ok(fresh?.status !== "KNOWN_GOOD", "T03 not converted to KNOWN_GOOD");
    ok(fresh?.status !== "FAILED", "T03 not converted to FAILED");
    ok(fresh?.providerStatus === "UNKNOWN", "T03 providerStatus=UNKNOWN");
  }

  console.log("\nT04 - stale worker blocked by live lease");
  {
    const h = makeHarness("nexus-D");
    const key = await seedIntent(h.intents, "DEPLOYING");
    const other = h.intents.acquireLease(key, "nexus-OTHER", 30000);
    ok(other.acquired, "T04 other worker acquired lease");
    h.docker.verdict = "MISSING";
    const report = await h.executor.runOnce();
    const fresh = h.intents.get(key);
    ok(fresh?.status === "DEPLOYING", "T04 intent unchanged under foreign lease");
    ok(report.leaseHeld > 0, "T04 report.leaseHeld > 0");
    ok(h.deployCalls.count === 0, "T04 orchestrator.deploy not called");
  }

  console.log("\n--- Phase 138: " + passed + " passed, " + failed + " failed ---");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error("PHASE138 DRIVER CRASH:", err); process.exit(1); });