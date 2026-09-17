// scripts/test-phase138-cancellation.ts
// Phase 138 section 8 commit 1: durable intent cancellation request/acknowledge.

import Database from "better-sqlite3";
import { join } from "path";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { MigrationRunner } from "../src/core/migration-runner";
import { ExecutionStore } from "../src/core/execution-store";
import { ReleaseDeploymentIntentService } from "../src/core/release-deployment-intent";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log("  ok   " + msg); }
  else      { failed++; console.log("  FAIL " + msg); }
}

function makeHarness(): { store: ExecutionStore; intents: ReleaseDeploymentIntentService } {
  const rawDb = new Database(":memory:");
  const migrationsDir = join(process.cwd(), "src", "db", "migrations");
  new MigrationRunner(rawDb, migrationsDir).run();
  const db = SQLiteEngine.fromDatabase(rawDb);
  const store = new ExecutionStore(db as any);
  const intents = new ReleaseDeploymentIntentService(store);
  return { store, intents };
}

async function seed(intents: any, status: string = "DEPLOYING"): Promise<string> {
  const r = await intents.getOrCreate({
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
  intents.transition(r.intent.intentKey, status, {});
  return r.intent.intentKey;
}

async function main() {
  console.log("=== Phase 138 section 8 - Cancellation (commit 1) ===\n");

  console.log("T-C1a - request then acknowledge");
  {
    const h = makeHarness();
    const key = await seed(h.intents, "DEPLOYING");
    const reqOk = h.intents.requestCancellation(key);
    ok(reqOk, "T-C1a request returns true");
    const after1 = h.intents.get(key);
    ok(typeof after1?.cancelRequestedAt === "number", "T-C1a cancelRequestedAt set");
    ok(after1?.cancelAcknowledgedAt == null, "T-C1a cancelAcknowledgedAt not yet set");
    const ackOk = h.intents.acknowledgeCancellation(key);
    ok(ackOk, "T-C1a acknowledge returns true");
    const after2 = h.intents.get(key);
    ok(typeof after2?.cancelAcknowledgedAt === "number", "T-C1a cancelAcknowledgedAt set");
  }

  console.log("\nT-C1b - request on terminal intent is refused");
  {
    const h = makeHarness();
    const key = await seed(h.intents, "DEPLOYING");
    h.intents.transition(key, "KNOWN_GOOD", { deploymentId: "dep-1" });
    const reqOk = h.intents.requestCancellation(key);
    ok(!reqOk, "T-C1b request returns false");
    const after = h.intents.get(key);
    ok(after?.cancelRequestedAt == null, "T-C1b cancelRequestedAt not set");
    ok(after?.status === "KNOWN_GOOD", "T-C1b status unchanged");
  }

  console.log("\nT-C1c - double-request is idempotent");
  {
    const h = makeHarness();
    const key = await seed(h.intents, "DEPLOYING");
    const first = h.intents.requestCancellation(key);
    const second = h.intents.requestCancellation(key);
    ok(first, "T-C1c first request true");
    ok(!second, "T-C1c second request false");
    const after = h.intents.get(key);
    ok(typeof after?.cancelRequestedAt === "number", "T-C1c cancelRequestedAt set once");
  }

  console.log("\nT-C1d - acknowledge without request is refused");
  {
    const h = makeHarness();
    const key = await seed(h.intents, "DEPLOYING");
    const ackOk = h.intents.acknowledgeCancellation(key);
    ok(!ackOk, "T-C1d acknowledge without request returns false");
    const after = h.intents.get(key);
    ok(after?.cancelAcknowledgedAt == null, "T-C1d cancelAcknowledgedAt not set");
  }

  console.log("\n--- Phase 138 section 8 commit 1: " + passed + " passed, " + failed + " failed ---");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error("PHASE138-CANCEL DRIVER CRASH:", err); process.exit(1); });