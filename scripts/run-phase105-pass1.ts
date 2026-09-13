// scripts/run-phase105-pass1.ts
// Phase 105 Pass 1: real GitHub Actions CI adapter foundation — deterministic tests.
//
// Every test uses a fake GitHubActionsClient at the HTTP boundary. No live
// GitHub call is made in this file. A separate live-capability probe lives
// at the end and reports BLOCKED honestly when credentials are unavailable.

import {
  GitHubActionsCICDProvider,
  mapGitHubStatus,
  type GitHubActionsClient,
} from "../src/core/github-actions-cicd-provider";
import type { GitHubWorkflowRun } from "../src/core/github";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log("[PASSED] " + name + (detail ? "  Evidence: " + detail : "")); }
  else { fail++; console.log("[FAILED] " + name + (detail ? "  Evidence: " + detail : "")); }
}

function run(over: Partial<GitHubWorkflowRun>): GitHubWorkflowRun {
  return {
    id: 1, name: "nexus-ci", head_branch: "nexus/devops/exec-1", head_sha: "sha-1",
    status: "queued", conclusion: null, created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(), html_url: "https://github.com/o/r/actions/runs/1",
    event: "workflow_dispatch", run_attempt: 1,
    ...over,
  };
}

interface FakeConfig {
  state?: { connected: boolean; reason?: string | null };
  onDispatch?: (opts: any) => void | Promise<void>;
  listRuns?: (opts: any) => GitHubWorkflowRun[] | Promise<GitHubWorkflowRun[]>;
  getRun?: (owner: string, repo: string, id: string | number) => GitHubWorkflowRun | null | Promise<GitHubWorkflowRun | null>;
  onCancel?: (owner: string, repo: string, id: string | number) => void | Promise<void>;
}
function fakeGithub(cfg: FakeConfig = {}): GitHubActionsClient {
  return {
    state: () => cfg.state ?? { connected: true },
    async dispatchWorkflow(opts) { if (cfg.onDispatch) await cfg.onDispatch(opts); },
    async listWorkflowRuns(opts) { return cfg.listRuns ? await cfg.listRuns(opts) : []; },
    async getWorkflowRun(o, r, id) { return cfg.getRun ? await cfg.getRun(o, r, id) : null; },
    async cancelWorkflowRun(o, r, id) { if (cfg.onCancel) await cfg.onCancel(o, r, id); },
  };
}

const validReq = {
  owner: "octocat", repo: "hello-world", workflow: ".github/workflows/nexus-ci.yml",
  ref: "nexus/devops/exec-1",
};

async function main(): Promise<void> {
  console.log("NEXUS PHASE 105 PASS 1 — GITHUB ACTIONS CI ADAPTER TESTS");
  console.log("=======================================================\n");

  const provider = new GitHubActionsCICDProvider(fakeGithub(), {
    resolveTimeoutMs: 50, resolveIntervalMs: 5,
  });

  // ---- Validation (1-6) ----
  check("T01 valid request passes validation", provider.validateRequest(validReq).valid === true, JSON.stringify(provider.validateRequest(validReq)));
  check("T02 missing owner is invalid", provider.validateRequest({ ...validReq, owner: "" }).valid === false);
  check("T03 missing repo is invalid", provider.validateRequest({ ...validReq, repo: "" }).valid === false);
  check("T04 missing workflow is invalid", provider.validateRequest({ ...validReq, workflow: "" }).valid === false);
  check("T05 missing ref is invalid", provider.validateRequest({ ...validReq, ref: "" }).valid === false);
  check("T06 unsafe workflow path is invalid",
    provider.validateRequest({ ...validReq, workflow: "../../etc/passwd" }).valid === false
    && provider.validateRequest({ ...validReq, workflow: "/etc/passwd" }).valid === false
    && provider.validateRequest({ ...validReq, workflow: "https://evil.com/wf.yml" }).valid === false);

  // ---- Authentication (7-8) ----
  {
    const p = new GitHubActionsCICDProvider(fakeGithub({ state: { connected: false, reason: "no token" } }));
    let threw = false;
    let msg = "";
    try { await p.trigger(validReq); } catch (e) { threw = true; msg = (e as Error).message; }
    check("T07 missing GitHub credential blocks trigger", threw === true && /BLOCKED/.test(msg), msg);
    check("T08 blocked error does not include token material", /ghp_|gho_|github_pat_/.test(msg) === false, msg);
  }

  // ---- Trigger (9-13) ----
  {
    let dispatched = 0;
    const p = new GitHubActionsCICDProvider(fakeGithub({
      onDispatch: () => { dispatched++; },
      listRuns: () => [run({ id: 42, head_branch: "nexus/devops/exec-1", created_at: new Date().toISOString() })],
    }), { resolveTimeoutMs: 100, resolveIntervalMs: 5 });
    const res = await p.trigger(validReq);
    check("T09 valid trigger calls the dispatch boundary", dispatched === 1, "dispatch=" + dispatched);
    check("T10 uniquely resolved run yields real externalRunId", res.externalRunId === "42", "externalRunId=" + res.externalRunId);
  }
  {
    const p = new GitHubActionsCICDProvider(fakeGithub({
      listRuns: () => [],
    }), { resolveTimeoutMs: 30, resolveIntervalMs: 5, maxResolveAttempts: 2 });
    let threw = false; let msg = "";
    try { await p.trigger(validReq); } catch (e) { threw = true; msg = (e as Error).message; }
    check("T11 no matching run → BLOCKED (no fabricated id)", threw === true && /BLOCKED/.test(msg), msg);
  }
  {
    const p = new GitHubActionsCICDProvider(fakeGithub({
      listRuns: () => [
        run({ id: 10, head_branch: "nexus/devops/exec-1" }),
        run({ id: 11, head_branch: "nexus/devops/exec-1" }),
      ],
    }), { resolveTimeoutMs: 30, resolveIntervalMs: 5, maxResolveAttempts: 2 });
    let threw = false; let msg = "";
    try { await p.trigger(validReq); } catch (e) { threw = true; msg = (e as Error).message; }
    check("T12 ambiguous matching runs → BLOCKED", threw === true && /BLOCKED/.test(msg), msg);
  }
  {
    const p = new GitHubActionsCICDProvider(fakeGithub({
      onDispatch: () => { throw new Error("HTTP 500 from GitHub"); },
    }));
    let threw = false; let msg = "";
    try { await p.trigger(validReq); } catch (e) { threw = true; msg = (e as Error).message; }
    check("T13 dispatch API failure propagates as failure", threw === true && /HTTP 500/.test(msg), msg);
  }

  // ---- Status (14-19) ----
  async function statusOf(run: GitHubWorkflowRun): Promise<string> {
    const p = new GitHubActionsCICDProvider(fakeGithub({ getRun: () => run }));
    const res = await p.getStatus("1", { owner: "octocat", repo: "hello-world" });
    return res.status;
  }
  check("T14 status queued → QUEUED", (await statusOf(run({ status: "queued", conclusion: null }))) === "QUEUED");
  check("T15 status in_progress → RUNNING", (await statusOf(run({ status: "in_progress", conclusion: null }))) === "RUNNING");
  check("T16 completed+success → SUCCEEDED", (await statusOf(run({ status: "completed", conclusion: "success" }))) === "SUCCEEDED");
  check("T17 completed+failure → FAILED", (await statusOf(run({ status: "completed", conclusion: "failure" }))) === "FAILED");
  check("T18 completed+cancelled → CANCELLED", (await statusOf(run({ status: "completed", conclusion: "cancelled" }))) === "CANCELLED");
  check("T19 unknown/ambiguous conclusion → BLOCKED (never SUCCEEDED)",
    (await statusOf(run({ status: "completed", conclusion: null }))) === "BLOCKED"
    && (await statusOf(run({ status: "mystery" as never, conclusion: null }))) === "BLOCKED");

  // ---- Cancel (20-21) ----
  {
    let cancelled = 0;
    const p = new GitHubActionsCICDProvider(fakeGithub({
      onCancel: (o, r, id) => { cancelled++; if (o !== "octocat" || r !== "hello-world" || String(id) !== "9") throw new Error("wrong target"); },
    }));
    await p.cancel("9", { owner: "octocat", repo: "hello-world" });
    check("T20 valid cancel calls the real API boundary with exact target", cancelled === 1, "calls=" + cancelled);
  }
  {
    const p = new GitHubActionsCICDProvider(fakeGithub({
      onCancel: () => { throw new Error("HTTP 403 from GitHub"); },
    }));
    let threw = false; let msg = "";
    try { await p.cancel("9", { owner: "octocat", repo: "hello-world" }); } catch (e) { threw = true; msg = (e as Error).message; }
    check("T21 cancel API failure is surfaced", threw === true && /403/.test(msg), msg);
  }

  // ---- Security (22-25) ----
  {
    const p = new GitHubActionsCICDProvider(fakeGithub({
      onDispatch: () => {},
      listRuns: () => [run({ id: 7 })],
    }), { resolveTimeoutMs: 100, resolveIntervalMs: 5 });
    const res = await p.trigger(validReq);
    const serialized = JSON.stringify(res);
    check("T22 token never appears in serialized result", !/ghp_|gho_|github_pat_|Bearer /.test(serialized), serialized);
  }
  {
    const p = new GitHubActionsCICDProvider(fakeGithub({
      state: { connected: false, reason: "no token ghp_shouldnotleak0000000000000000000000" },
    }));
    let msg = "";
    try { await p.trigger(validReq); } catch (e) { msg = (e as Error).message; }
    check("T23 token never appears in error message", !/ghp_shouldnotleak/.test(msg), msg);
  }
  check("T24 arbitrary API host cannot be supplied as owner",
    provider.validateRequest({ ...validReq, owner: "https://evil.com" }).valid === false
    && provider.validateRequest({ ...validReq, owner: "evil.com/path" }).valid === false);
  check("T25 arbitrary URL cannot be supplied as ref or workflow",
    provider.validateRequest({ ...validReq, ref: "https://evil.com" }).valid === false
    && provider.validateRequest({ ...validReq, workflow: "http://evil.com/wf.yml" }).valid === false);

  // ---- Live capability probe (§18) ----
  console.log("\n=== Live GitHub Actions capability ===");
  const token = process.env.GITHUB_TOKEN || process.env.NEXUS_GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    console.log("BLOCKED — GitHub Actions live capability unavailable (no GITHUB_TOKEN / NEXUS_GITHUB_TOKEN / GH_TOKEN in env)");
  } else {
    console.log("Credential present (length " + token.length + "). Live provider read-only probe belongs to the deploy/runtime pass — not performed in Pass 1.");
  }

  console.log("\n=======================================================");
  console.log("PASS: " + pass + "  FAIL: " + fail);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(2); });