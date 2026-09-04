// scripts/run-phase11-pass1.ts
import Database from "better-sqlite3";
import { RecoveryStore } from "../src/core/recovery-store";
import { RecoveryPolicyEngine } from "../src/core/recovery-policy-engine";
import { RecoveryAgent } from "../src/core/recovery-agent";
import { IncidentAnalysis } from "../src/core/incident-analysis";
import { RecoveryPolicy } from "../src/core/recovery-models";

async function main() {
  console.log("=== Phase 11 Pass 1: Recovery System Verification ===");

  // 1. Setup in-memory DB and apply migration
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE recovery_policies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      target_type TEXT NOT NULL,
      conditions TEXT NOT NULL,
      actions TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE recovery_jobs (
      id TEXT PRIMARY KEY,
      policy_id TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      error TEXT,
      result TEXT
    );
  `);

  const store = new RecoveryStore(db);
  const policyEngine = new RecoveryPolicyEngine();
  const agent = new RecoveryAgent(policyEngine);

  // 2. Create a sample policy
  const now = Date.now();
  const policy: RecoveryPolicy = {
    id: "policy-1",
    name: "Restart on failure",
    targetType: "service",
    conditions: { severity: "high" },
    actions: [
      {
        id: "action-1",
        type: "restart",
        service: "nexus-test-service",
        environment: "staging",
        description: "Restart unhealthy service",
      },
    ],
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
  store.addPolicy(policy);
  console.log("Policy created:", policy.name);

  // 3. Simulate an incident
  const diagnosis: IncidentAnalysis = {
    incidentId: "incident-1",
    service: "nexus-test-service",
    environment: "staging",
    severity: "high",
    details: "Service is unhealthy",
  };

  // 4. Attempt recovery (simulate successful execution)
  const attempt = await agent.attemptRecovery(
    diagnosis,
    diagnosis.incidentId,
    diagnosis.environment,
    [],
    async () => {
      console.log("Simulated recovery action executed successfully.");
      return true;
    }
  );

  console.log("Recovery attempt:", attempt);

  // 5. Verify the result
  if (attempt.status !== "EXECUTED") {
    console.error("FAIL: Recovery attempt was not executed.");
    process.exit(1);
  }

  console.log("PASS: Recovery system successfully executed an automatic recovery.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Phase 11 verification failed:", err);
  process.exit(1);
});