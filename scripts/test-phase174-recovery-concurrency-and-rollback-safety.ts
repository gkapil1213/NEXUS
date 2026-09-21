// scripts/test-phase174-recovery-concurrency-and-rollback-safety.ts
//
// Phase 174 - recovery concurrency and rollback safety.
//
// Real SQLite + real ExecutionStore + real intent service. Every assertion
// fails if the durable fencing regresses. No fake providers, no fake
// deployments. The store is the source of truth.
//
// Note: getOrCreate() derives intentKey from the input fields. Tests
// capture the returned intent.intentKey and use it for every subsequent
// store call.

import Database from "better-sqlite3";
import { join } from "path";
import { MigrationRunner } from "../src/core/migration-runner";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { ReleaseDeploymentIntentService } from "../src/core/release-deployment-intent";

let passed = 0, failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log("  ok   " + msg); }
  else { failed++; console.log("  FAIL " + msg); }
}
function section(t: string): void { console.log("\n" + t); }

interface H { raw: Database.Database; engine: SQLiteEngine; store: ExecutionStore; intents: ReleaseDeploymentIntentService; }

function mkHarness(): H {
  const raw = new Database(":memory:");
  new MigrationRunner(raw, join(process.cwd(), "src", "db", "migrations")).run();
  raw.exec(
    "CREATE TABLE IF NOT EXISTS nexus_records (store TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (store, key));",
  );
  const engine = SQLiteEngine.fromDatabase(raw);
  const store = new ExecutionStore(raw);
  const intents = new ReleaseDeploymentIntentService(store);
  return { raw, engine, store, intents };
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
    imageId: null,
    imageDigest: "sha256:" + prefix,
    containerName: "c-" + prefix,
    containerPort: 8080,
    attemptId: "att-" + prefix,
    ...extra,
  };
}

async function newIntent(h: H, prefix: string, extra: Record<string, unknown> = {}): Promise<string> {
  const { intent } = await h.intents.getOrCreate(mkInput(prefix, extra) as any);
  return intent.intentKey;
}

async function main() {
  // ============================================================
  // A. Lease ownership
  // ============================================================
  section("A - Lease ownership");
  {
    const h = mkHarness();
    const k = await newIntent(h, "A1");

    const a = h.intents.acquireLease(k, "worker-A");
    ok(a.acquired === true, "A1 fresh intent: worker-A acquires");

    const b = h.intents.acquireLease(k, "worker-B");
    ok(b.acquired === false, "A2 worker-B cannot acquire while A holds");
    ok(b.holder === "worker-A", "A3 holder reported as worker-A");

    const a2 = h.intents.acquireLease(k, "worker-A");
    ok(a2.acquired === true, "A4 owner re-acquires (idempotent to self)");

    const relByB = h.intents.releaseLease(k, "worker-B");
    ok(relByB === false, "A5 non-owner cannot release");

    const relByA = h.intents.releaseLease(k, "worker-A");
    ok(relByA === true, "A6 owner releases");

    const b2 = h.intents.acquireLease(k, "worker-B");
    ok(b2.acquired === true, "A7 after owner releases, B acquires");
  }

  // ============================================================
  // B. Stale worker fencing on transitions
  // ============================================================
  section("B - Stale worker fencing on transitions");
  {
    const h = mkHarness();
    const k = await newIntent(h, "B1");
    h.intents.acquireLease(k, "worker-A");

    const ownerOk = h.intents.transitionIfOwned(k, "DEPLOYING", "worker-A", { recoveryReason: "owner ok" });
    ok(ownerOk.updated === true, "B1 owner can transition");

    const stale = h.intents.transitionIfOwned(k, "KNOWN_GOOD", "worker-B", { deploymentId: "dep-fake" });
    ok(stale.updated === false, "B2 stale worker cannot transition");
    ok(stale.intent?.status === "DEPLOYING", "B3 status unchanged after stale attempt");
    ok(stale.intent?.deploymentId === null, "B4 stale worker cannot write deploymentId");

    const stale2 = h.intents.transitionIfOwned(k, "FAILED", "worker-B", { failureReason: "stale" });
    ok(stale2.updated === false, "B5 stale worker cannot write FAILED");

    const stale3 = h.intents.transitionIfOwned(k, "ROLLING_BACK", "worker-B", { recoveryReason: "stale" });
    ok(stale3.updated === false, "B6 stale worker cannot write ROLLING_BACK");

    const stale4 = h.intents.transitionIfOwned(k, "BLOCKED", "worker-B", { failureReason: "stale" });
    ok(stale4.updated === false, "B7 stale worker cannot write BLOCKED");

    const fresh = h.intents.get(k);
    ok(fresh?.status === "DEPLOYING", "B8 final status is the owner's write");
    ok(fresh?.failureReason === null, "B9 failureReason not overwritten by stale worker");
  }

  // ============================================================
  // C. Lease expiration
  // ============================================================
  section("C - Lease expiration");
  {
    const h = mkHarness();
    const k = await newIntent(h, "C1");
    const a = h.intents.acquireLease(k, "worker-A", 50);
    ok(a.acquired === true, "C1 worker-A acquires with 50ms TTL");

    await new Promise((r) => setTimeout(r, 120));

    const b = h.intents.acquireLease(k, "worker-B");
    ok(b.acquired === true, "C2 worker-B acquires after expiry");
    ok(b.holder === "worker-B", "C3 holder is worker-B");

    const staleWrite = h.intents.transitionIfOwned(k, "KNOWN_GOOD", "worker-A", { deploymentId: "dep-stale" });
    ok(staleWrite.updated === false, "C4 expired worker-A cannot transition");
    ok(staleWrite.intent?.status === "DEPLOYMENT_INTENT_CREATED", "C5 state unchanged by stale write");

    const staleRenew = h.intents.renewLease(k, "worker-A");
    ok(staleRenew === false, "C6 expired worker-A cannot renew");
  }

  // ============================================================
  // D. Renewal fencing (Phase 174 fix)
  // ============================================================
  section("D - Renewal fencing");
  {
    const h = mkHarness();
    const k1 = await newIntent(h, "D1");
    h.intents.acquireLease(k1, "worker-A", 100_000);

    ok(h.intents.renewLease(k1, "worker-A") === true, "D1 owner can renew");
    ok(h.intents.renewLease(k1, "worker-B") === false, "D2 non-owner cannot renew");

    const k3 = await newIntent(h, "D3");
    h.intents.acquireLease(k3, "worker-A", 30);
    await new Promise((r) => setTimeout(r, 100));
    ok(h.intents.renewLease(k3, "worker-A") === false, "D3 expired lease cannot be renewed (Phase 174 fix)");

    const bAcq = h.intents.acquireLease(k3, "worker-B");
    ok(bAcq.acquired === true, "D4 worker-B acquires expired D3");
    ok(h.intents.renewLease(k3, "worker-A") === false, "D5 superseded worker-A cannot renew");

    h.intents.releaseLease(k3, "worker-B");
    ok(h.intents.renewLease(k3, "worker-B") === false, "D6 after release, renew fails");
  }

  // ============================================================
  // E. Concurrent workers converge
  // ============================================================
  section("E - Concurrent workers converge");
  {
    const h = mkHarness();
    const k = await newIntent(h, "E1");
    const a = h.intents.acquireLease(k, "worker-A");
    const b = h.intents.acquireLease(k, "worker-B");
    ok(a.acquired !== b.acquired, "E1 exactly one of two racers acquires");
    ok(a.acquired === true && b.acquired === false, "E2 worker-A wins the race");

    const loser = h.intents.transitionIfOwned(k, "DEPLOYING", "worker-B", {});
    ok(loser.updated === false, "E3 loser does not mutate state");
    ok(loser.intent?.status === "DEPLOYMENT_INTENT_CREATED", "E4 state preserved through losing attempt");

    const winner = h.intents.transitionIfOwned(k, "DEPLOYING", "worker-A", {});
    ok(winner.updated === true, "E5 winner's mutation persists");

    const k2 = await newIntent(h, "E6");
    const aOnE6 = h.intents.acquireLease(k2, "worker-A");
    const bOnE6 = h.intents.acquireLease(k2, "worker-B");
    ok(aOnE6.acquired && !bOnE6.acquired, "E6 contention on second intent resolves to single owner");
  }

  // ============================================================
  // F. Terminal transition fencing
  // ============================================================
  section("F - Terminal transition fencing");
  {
    const h = mkHarness();
    const k1 = await newIntent(h, "F1");
    h.intents.acquireLease(k1, "worker-A");
    const r = h.intents.transitionIfOwned(k1, "KNOWN_GOOD", "worker-A", { deploymentId: "dep-F1" });
    ok(r.updated === true, "F1 owner writes KNOWN_GOOD");
    ok(r.intent?.status === "KNOWN_GOOD", "F2 status is KNOWN_GOOD");
    ok(r.intent?.deploymentId === "dep-F1", "F3 deploymentId persisted");

    const k4 = await newIntent(h, "F4");
    h.intents.acquireLease(k4, "worker-A");
    const rf = h.intents.transitionIfOwned(k4, "FAILED", "worker-A", { failureReason: "x" });
    ok(rf.updated === true && rf.intent?.status === "FAILED", "F4 owner writes FAILED");

    const k5 = await newIntent(h, "F5");
    h.intents.acquireLease(k5, "worker-A");
    const rb = h.intents.transitionIfOwned(k5, "BLOCKED", "worker-A", { failureReason: "x" });
    ok(rb.updated === true && rb.intent?.status === "BLOCKED", "F5 owner writes BLOCKED");

    const k6 = await newIntent(h, "F6");
    h.intents.acquireLease(k6, "worker-A");
    const rr = h.intents.transitionIfOwned(k6, "RECOVERY_REQUIRED", "worker-A", { recoveryReason: "unknown" });
    ok(rr.updated === true && rr.intent?.status === "RECOVERY_REQUIRED", "F6 owner writes RECOVERY_REQUIRED");
  }

  // ============================================================
  // G. Expected-status guard
  // ============================================================
  section("G - Expected-status guard");
  {
    const h = mkHarness();
    const k = await newIntent(h, "G1");
    h.intents.acquireLease(k, "worker-A");

    const ok1 = h.intents.transitionIfOwned(k, "DEPLOYING", "worker-A", {}, ["DEPLOYMENT_INTENT_CREATED"]);
    ok(ok1.updated === true, "G1 expected status matches -> updated");

    const ok2 = h.intents.transitionIfOwned(k, "KNOWN_GOOD", "worker-A", {}, ["DEPLOYMENT_INTENT_CREATED"]);
    ok(ok2.updated === false, "G2 expected status mismatch -> not updated");
    ok(ok2.intent?.status === "DEPLOYING", "G3 status unchanged after mismatch");

    const ok3 = h.intents.transitionIfOwned(k, "HEALTH_CHECKING", "worker-A", {}, ["DEPLOYING", "HEALTH_CHECKING"]);
    ok(ok3.updated === true, "G4 multi-status set with match -> updated");

    const ok4 = h.intents.transitionIfOwned(k, "VERIFICATION_FAILED", "worker-B", {}, ["HEALTH_CHECKING"]);
    ok(ok4.updated === false, "G5 stale worker + wrong expected status -> not updated");
  }

  // ============================================================
  // H. Crash matrix
  // ============================================================
  section("H - Crash matrix");
  {
    const h = mkHarness();
    const k = await newIntent(h, "H1");
    const a = h.intents.acquireLease(k, "worker-A", 40);
    ok(a.acquired === true, "H1 worker-A acquires, then crashes without releasing");
    const preStatus = h.intents.get(k)?.status;
    await new Promise((r) => setTimeout(r, 100));

    const b = h.intents.acquireLease(k, "worker-B");
    ok(b.acquired === true, "H2 worker-B acquires after A's crash + lease expiry");

    const stale = h.intents.transitionIfOwned(k, "KNOWN_GOOD", "worker-A", { deploymentId: "dep-ghost" });
    ok(stale.updated === false, "H3 crashed worker cannot write after B owns");
    ok(stale.intent?.status === preStatus, "H4 durable status preserved through crash");
    ok(stale.intent?.deploymentId === null, "H5 deploymentId not written by crashed worker");

    const bWrite = h.intents.transitionIfOwned(k, "RECOVERY_REQUIRED", "worker-B", { recoveryReason: "unknown after crash" });
    ok(bWrite.updated === true && bWrite.intent?.status === "RECOVERY_REQUIRED", "H6 new owner writes authoritatively");
  }

  // ============================================================
  // I. Rollback path fencing
  // ============================================================
  section("I - Rollback path fencing");
  {
    const h = mkHarness();
    const k = await newIntent(h, "I1");
    h.intents.acquireLease(k, "worker-A");
    h.intents.transitionIfOwned(k, "VERIFICATION_FAILED", "worker-A", { failureReason: "smoke failed" });

    const rollbackStart = h.intents.transitionIfOwned(k, "ROLLING_BACK", "worker-A", { recoveryReason: "starting rollback" });
    ok(rollbackStart.updated === true, "I1 owner starts rollback (VERIFICATION_FAILED -> ROLLING_BACK)");
    ok(rollbackStart.intent?.status === "ROLLING_BACK", "I2 status is ROLLING_BACK");

    const staleComplete = h.intents.transitionIfOwned(k, "FAILED", "worker-B", { failureReason: "stale completion" });
    ok(staleComplete.updated === false, "I3 stale worker cannot complete rollback");
    ok(staleComplete.intent?.status === "ROLLING_BACK", "I4 rollback state preserved through stale attempt");

    const ownerComplete = h.intents.transitionIfOwned(k, "FAILED", "worker-A", { failureReason: "rollback verified" });
    ok(ownerComplete.updated === true && ownerComplete.intent?.status === "FAILED", "I5 owner completes rollback");
  }

  // ============================================================
  // J. Cross-project integrity
  // ============================================================
  section("J - Cross-project integrity");
  {
    const h = mkHarness();
    const k = await newIntent(h, "J1", { projectId: "proj-one" });
    h.intents.acquireLease(k, "worker-A");
    h.intents.transitionIfOwned(k, "DEPLOYING", "worker-A", {});
    const fresh = h.intents.get(k);
    ok(fresh?.projectId === "proj-one", "J1 projectId preserved through transitions");

    const r = h.intents.transitionIfOwned(k, "RECOVERY_REQUIRED", "worker-A", { recoveryReason: "x" } as any);
    ok(r.intent?.projectId === "proj-one", "J2 patch cannot override projectId");

    const k3 = await newIntent(h, "J3", { projectId: "proj-two" });
    const j1 = h.intents.get(k);
    const j3 = h.intents.get(k3);
    ok(j1?.projectId === "proj-one" && j3?.projectId === "proj-two", "J3 project scope isolated per intent");
  }

  // ============================================================
  // K. UNKNOWN provider outcome durability
  // ============================================================
  section("K - UNKNOWN provider outcome durability");
  {
    const h = mkHarness();
    const k = await newIntent(h, "K1");
    h.intents.acquireLease(k, "worker-A");
    const r = h.intents.transitionIfOwned(k, "RECOVERY_REQUIRED", "worker-A", {
      recoveryReason: "provider invocation outcome unknown",
      providerStatus: "UNKNOWN",
    });
    ok(r.updated === true, "K1 RECOVERY_REQUIRED persisted");
    ok(r.intent?.recoveryReason === "provider invocation outcome unknown", "K2 recoveryReason retained");
    ok(r.intent?.providerStatus === "UNKNOWN", "K3 providerStatus UNKNOWN retained");

    const staleClear = h.intents.transitionIfOwned(k, "KNOWN_GOOD", "worker-B", { deploymentId: "dep-X" });
    ok(staleClear.updated === false, "K4 stale worker cannot clear RECOVERY_REQUIRED to KNOWN_GOOD");
    const after = h.intents.get(k);
    ok(after?.status === "RECOVERY_REQUIRED", "K5 status remains RECOVERY_REQUIRED");
  }

  // ============================================================
  // L. Idempotency and replay
  // ============================================================
  section("L - Idempotency and replay");
  {
    const h = mkHarness();
    const i1 = mkInput("L1");
    const r1 = await h.intents.getOrCreate(i1);
    const r2 = await h.intents.getOrCreate(i1);
    ok(r1.created === true, "L1 first getOrCreate creates");
    ok(r2.created === false, "L2 second getOrCreate is idempotent");
    ok(r1.intent.intentKey === r2.intent.intentKey, "L3 same intentKey");

    const i2 = { ...i1, attemptId: "att-L1-different" };
    const r3 = await h.intents.getOrCreate(i2);
    ok(r3.intent.intentKey !== r1.intent.intentKey, "L4 different attemptId -> different intentKey");

    h.intents.acquireLease(r1.intent.intentKey, "worker-A");
    const t1 = h.intents.transitionIfOwned(r1.intent.intentKey, "DEPLOYING", "worker-A", {});
    const t2 = h.intents.transitionIfOwned(r1.intent.intentKey, "DEPLOYING", "worker-A", {});
    ok(t1.updated === true, "L5 first owner transition succeeds");
    ok(t2.updated === true, "L6 owner can re-write same status (idempotent)");
  }

  // ============================================================
  // M. Recovery-required listing
  // ============================================================
  section("M - Recovery-required listing");
  {
    const h = mkHarness();
    const k1 = await newIntent(h, "M1");
    h.intents.acquireLease(k1, "worker-A");
    h.intents.transitionIfOwned(k1, "RECOVERY_REQUIRED", "worker-A", { recoveryReason: "unknown" });

    const k2 = await newIntent(h, "M2");
    h.intents.acquireLease(k2, "worker-A");
    h.intents.transitionIfOwned(k2, "KNOWN_GOOD", "worker-A", { deploymentId: "dep-M2" });

    const recoverable = h.intents.listRecoverable();
    const keys = recoverable.map((i) => i.intentKey);
    ok(keys.includes(k1), "M1 RECOVERY_REQUIRED intent listed as recoverable");
    ok(!keys.includes(k2), "M2 KNOWN_GOOD intent not listed as recoverable");
  }

  // ============================================================
  // N. Environment concurrency detection
  // ============================================================
  section("N - Environment concurrency detection");
  {
    const h = mkHarness();
    const k = await newIntent(h, "N1", { environment: "production" });
    h.intents.acquireLease(k, "worker-A");
    const active = h.intents.hasActiveIntentForEnvironment("production", "ik-some-other");
    ok(active === true, "N1 non-terminal intent blocks other intents in same env");

    h.intents.transitionIfOwned(k, "KNOWN_GOOD", "worker-A", { deploymentId: "dep-N1" });
    const notActive = h.intents.hasActiveIntentForEnvironment("production", "ik-some-other");
    ok(notActive === false, "N2 terminal intent does not block same env");
  }

  // ============================================================
  // O. Terminal write + new-owner transition boundary
  // ============================================================
  section("O - Terminal write + new-owner transition boundary");
  {
    const h = mkHarness();
    const k = await newIntent(h, "O1");
    h.intents.acquireLease(k, "worker-A");
    h.intents.transitionIfOwned(k, "KNOWN_GOOD", "worker-A", { deploymentId: "dep-O1" });

    h.intents.releaseLease(k, "worker-A");
    h.intents.acquireLease(k, "worker-B");
    const override = h.intents.transitionIfOwned(k, "FAILED", "worker-B", { failureReason: "tried to override terminal" });
    // The store enforces ownership, not state-machine validity. A live,
    // leased owner may write any status. Terminal-state immutability is a
    // classifier concern (ALREADY_KNOWN_GOOD), not a store concern.
    ok(override.updated === true, "O1 store enforces ownership, not state-machine validity");

    const after = h.intents.get(k);
    ok(after?.failureReason === "tried to override terminal", "O2 transition by new owner persisted");
  }

  console.log("\n=== Phase 174 Summary ===");
  console.log("Passed: " + passed);
  console.log("Failed: " + failed);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL: " + (e && e.stack ? e.stack : e));
  process.exit(1);
});