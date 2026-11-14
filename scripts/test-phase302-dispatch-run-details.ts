import {
  GitHubActionsCICDProvider,
  type GitHubActionsClient,
} from "../src/core/github-actions-cicd-provider";
import type { GitHubWorkflowRun } from "../src/core/github";

let pass = 0;
let fail = 0;

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    pass++;
    console.log("[PASS] " + name + (detail ? " | " + detail : ""));
  } else {
    fail++;
    console.log("[FAIL] " + name + (detail ? " | " + detail : ""));
  }
}

const request = {
  owner: "octocat",
  repo: "hello-world",
  workflow: ".github/workflows/nexus-ci.yml",
  ref: "nexus/devops/exec-1",
};

function makeRun(): GitHubWorkflowRun {
  const now = new Date().toISOString();

  return {
    id: 777,
    name: "nexus-ci",
    head_branch: request.ref,
    head_sha: "sha-1",
    status: "queued",
    conclusion: null,
    created_at: now,
    updated_at: now,
    html_url: "https://github.com/octocat/hello-world/actions/runs/777",
    event: "workflow_dispatch",
    run_attempt: 1,
  };
}

async function main(): Promise<void> {
  console.log("NEXUS PHASE 302 - DISPATCH RESPONSE REGRESSION TESTS");
  console.log("====================================================");

  // Test 1: GitHub returns HTTP 200 response details.
  {
    let dispatchCalls = 0;
    let pollCalls = 0;
    let requestedDetails = false;

    const fake = {
      state: () => ({ connected: true }),
      async dispatchWorkflow(opts: any) {
        dispatchCalls++;
        requestedDetails = opts.return_run_details === true;
        return { workflow_run_id: 123456 };
      },
      async listWorkflowRuns() {
        pollCalls++;
        return [];
      },
    } as unknown as GitHubActionsClient;

    const provider = new GitHubActionsCICDProvider(fake);
    const result = await provider.trigger(request);

    check(
      "HTTP 200 inline run ID returned directly",
      result.externalRunId === "123456",
      "externalRunId=" + result.externalRunId
    );
    check(
      "Provider requests return_run_details",
      requestedDetails
    );
    check(
      "Inline response avoids polling",
      dispatchCalls === 1 && pollCalls === 0,
      "dispatch=" + dispatchCalls + " poll=" + pollCalls
    );
  }

  // Test 2: No inline details; existing poller discovers the run.
  {
    let pollCalls = 0;

    const fake = {
      state: () => ({ connected: true }),
      async dispatchWorkflow() {
        return undefined;
      },
      async listWorkflowRuns() {
        pollCalls++;
        return [makeRun()];
      },
    } as unknown as GitHubActionsClient;

    const provider = new GitHubActionsCICDProvider(fake, {
      resolveTimeoutMs: 100,
      resolveIntervalMs: 5,
    });

    const result = await provider.trigger(request);

    check(
      "No inline details uses fallback poller",
      result.externalRunId === "777" && pollCalls > 0,
      "externalRunId=" + result.externalRunId + " pollCalls=" + pollCalls
    );
  }

  // Test 3: No inline details and no matching run must fail closed.
  {
    const fake = {
      state: () => ({ connected: true }),
      async dispatchWorkflow() {
        return undefined;
      },
      async listWorkflowRuns() {
        return [];
      },
    } as unknown as GitHubActionsClient;

    const provider = new GitHubActionsCICDProvider(fake, {
      resolveTimeoutMs: 20,
      resolveIntervalMs: 5,
      maxResolveAttempts: 1,
    });

    let blocked = false;
    let message = "";

    try {
      await provider.trigger(request);
    } catch (error) {
      message = (error as Error).message;
      blocked = message.includes("BLOCKED");
    }

    check(
      "Missing run ID fails closed",
      blocked,
      message
    );
  }

  console.log("====================================================");
  console.log("PASS: " + pass + " | FAIL: " + fail);

  if (fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error("[FATAL]", error);
  process.exit(2);
});
