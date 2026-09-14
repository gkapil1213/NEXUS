import {
  orchestrateReleaseDeployment,
} from "../src/core/worker-phase25-autonomous-release-deployment-control-plane";

import type { DeploymentAdapter } from "../src/core/worker-deployment-adapter";

let pass = 0;
let fail = 0;

function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    pass++;
    console.log("[PASSED] " + name + (detail ? " | " + detail : ""));
  } else {
    fail++;
    console.error("[FAILED] " + name + (detail ? " | " + detail : ""));
  }
}

function baseRequest(overrides: Record<string, unknown> = {}) {
  return {
    artifactId: "artifact-phase117",
    tenantId: "tenant-phase117",
    correlationId: "corr-phase117",
    release: {
      version: "v117-current",
    },
    plan: {
      strategy: "ROLLING",
      environment: "staging",
    },
    governance: "ALLOW" as const,
    approvalValid: true,
    securityStatus: "PASS" as const,
    circuitBreaker: {
      failureCount: 0,
      threshold: 3,
    },
    frozen: false,
    rolloutState: {
      currentStage: "0%",
      health: "UNHEALTHY",
      errorRate: 0,
      latency: 0,
      availability: 100,
      thresholds: {
        maxErrorRate: 0.05,
        maxLatency: 500,
        minAvailability: 99,
      },
    },
    healthInput: {
      healthy: true,
    },
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
    async validateTarget() {
      return { ok: true, reason: "ok" };
    },

    async checkAvailability() {
      return { available: true, reason: "ok" };
    },

    async preflight() {
      return { ok: true, reason: "ok" };
    },

    async deploy() {
      return {
        success: true,
        reason: "deployed",
        evidence: ["deploy-evidence"],
      };
    },

    async getStatus() {
      return {
        status: "AVAILABLE",
        details: "test adapter",
      };
    },

    async getHealth() {
      return {
        healthy: true,
        reason: "healthy",
      };
    },

    async pause() {
      return { success: true, reason: "paused" };
    },

    async resume() {
      return { success: true, reason: "resumed" };
    },

    async promote() {
      return { success: true, reason: "promoted" };
    },

    async rollback(previousVersion: string) {
      calls.push("rollback:" + previousVersion);
      return {
        success: true,
        reason: "rollback executed",
      };
    },

    ...overrides,
  };

  return { adapter: a, calls };
}

async function main() {
  console.log("NEXUS PHASE 117 ROLLBACK REGRESSION TESTS");
  console.log("=========================================");

  // T1: Missing previousVersion must fail closed and must not call rollback.
  {
    const { adapter: a, calls } = adapter();

    const result = await orchestrateReleaseDeployment(
      baseRequest({ provider: a })
    );

    check(
      "T1 missing previousVersion -> FAILED",
      result.status === "FAILED",
      "status=" + result.status
    );

    check(
      "T1 missing previousVersion -> rollback not called",
      calls.length === 0,
      "calls=" + JSON.stringify(calls)
    );
  }

  // T2: Rollback safety denial must prevent adapter execution.
  {
    const { adapter: a, calls } = adapter();

    const result = await orchestrateReleaseDeployment(
      baseRequest({
        provider: a,
        previousVersion: "v116-previous",
        rollbackSafetyInput: {
          targetArtifactExists: false,
          targetArtifactCorrupted: false,
          targetArtifactRevoked: false,
          targetVersionCompatible: true,
          governanceAllowed: true,
          securityPolicyAllowed: true,
          recoverySafetyAllowed: true,
          dependencyConstraintsMet: true,
        },
      })
    );

    check(
      "T2 rollback safety denied -> FAILED",
      result.status === "FAILED",
      "status=" + result.status
    );

    check(
      "T2 rollback safety denied -> rollback not called",
      calls.length === 0,
      "calls=" + JSON.stringify(calls)
    );
  }

  // T3: Adapter rollback failure must never produce ROLLED_BACK.
  {
    const { adapter: a } = adapter({
      async rollback() {
        return {
          success: false,
          reason: "rollback provider failure",
        };
      },
    });

    const result = await orchestrateReleaseDeployment(
      baseRequest({
        provider: a,
        previousVersion: "v116-previous",
      })
    );

    check(
      "T3 adapter rollback failure -> FAILED",
      result.status === "FAILED",
      "status=" + result.status
    );
  }

  // T4: Missing independent verification must fail closed.
  {
    const { adapter: a } = adapter();

    const result = await orchestrateReleaseDeployment(
      baseRequest({
        provider: a,
        previousVersion: "v116-previous",
      })
    );

    check(
      "T4 missing verifyRollback -> FAILED",
      result.status === "FAILED",
      "status=" + result.status
    );
  }

  // T5: Negative verification must never produce ROLLED_BACK.
  {
    const { adapter: a } = adapter({
      async verifyRollback() {
        return {
          verified: false,
          reasons: ["previous version is not healthy"],
        };
      },
    });

    const result = await orchestrateReleaseDeployment(
      baseRequest({
        provider: a,
        previousVersion: "v116-previous",
      })
    );

    check(
      "T5 verification false -> FAILED",
      result.status === "FAILED",
      "status=" + result.status
    );
  }

  // T6: Positive independent verification permits ROLLED_BACK.
  {
    const { adapter: a } = adapter({
      async verifyRollback(previousVersion: string) {
        return {
          verified: previousVersion === "v116-previous",
          reasons: [],
        };
      },
    });

    const result = await orchestrateReleaseDeployment(
      baseRequest({
        provider: a,
        previousVersion: "v116-previous",
      })
    );

    check(
      "T6 verified rollback -> ROLLED_BACK",
      result.status === "ROLLED_BACK",
      "status=" + result.status
    );

    check(
      "T6 rollback object reaches ROLLED_BACK",
      result.rollback?.status === "ROLLED_BACK",
      "rollback=" + (result.rollback?.status ?? "missing")
    );
  }

  // T7: Exact previousVersion must be passed to adapter.
  {
    const { adapter: a, calls } = adapter({
      async verifyRollback(previousVersion: string) {
        return {
          verified: previousVersion === "v116-previous",
          reasons: [],
        };
      },
    });

    const result = await orchestrateReleaseDeployment(
      baseRequest({
        provider: a,
        previousVersion: "v116-previous",
      })
    );

    check(
      "T7 exact rollback target passed",
      calls.includes("rollback:v116-previous"),
      "calls=" + JSON.stringify(calls)
    );

    check(
      "T7 current release version was not used as rollback target",
      !calls.includes("rollback:v117-current"),
      "calls=" + JSON.stringify(calls)
    );

    check(
      "T7 final status remains ROLLED_BACK",
      result.status === "ROLLED_BACK",
      "status=" + result.status
    );
  }

  console.log("");
  console.log(`RESULT: ${pass} passed, ${fail} failed`);

  if (fail > 0) {
    process.exit(1);
  }

  process.exit(0);
}

main().catch((error) => {
  console.error("[FATAL]", error);
  process.exit(2);
});
