// scripts/run-phase105-pass2.ts
// Phase 105 Pass 2: durable GitHub Actions CI execution — deterministic tests.
//
// Every test uses a fake GitHubActionsClient at the HTTP boundary and the real
// NexusEngine for persistence. No live GitHub call. Live capability probe at
// the end reports BLOCKED honestly when credentials are absent.

import { openEngine, type NexusEngine } from "../src/core/db";
import {
  CiPipelineEngine,
  type CiCicdBridge,
  type CiContext,
  type CiServices,
  type GitProvider,
} from "../src/core/cicd";
import { CICDProviderRegistry } from "../src/core/cicd-provider-registry";
import { CICDRunManager } from "../src/core/cicd-run-manager";
import {
  GitHubActionsCICDProvider,
  mapGitHubStatus,
  type GitHubActionsClient,
} from "../src/core/github-actions-cicd-provider";
import type { CiPipelineRun, CiRunStatus } from "../src/core/types";
import type { GitHubWorkflowRun } from "../src/core/github";
import { EventService } from "../src/core/events";
import { AuditService } from "../src/core/audit";
import { EvidenceService, ArtifactService, type Actor } from "../src/core/services";
import { existsSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log("[PASSED] " + name + (detail ? "  Evidence: " + detail : "")); }
  else { fail++; console.log("[FAILED] " + name + (detail ? "  Evidence: " + detail : "")); }
}

let uidCounter = 0;
function uid(): string {
  uidCounter++;
  return Date.now().toString(36) + "-" + uidCounter + "-" + Math.random().toString(36).slice(2, 6);
}

interface CallTracker { dispatches: number; cancels: number; statuses: number; }
interface FakeConfig {
  state?: { connected: boolean; reason?: string | null };
  onDispatch?: (opts: any) => void | Promise<void>;
  listRuns?: (opts: any) => GitHubWorkflowRun[] | Promise<GitHubWorkflowRun[]>;
  getRun?: (owner: string, repo: string, id: string | number) => GitHubWorkflowRun | null | Promise<GitHubWorkflowRun | null>;
  onCancel?: (owner: string, repo: string, id: string | number) => void | Promise<void>;
}
function fakeGithub(cfg: FakeConfig, track: CallTracker): GitHubActionsClient {
  return {
    state: () => cfg.state ?? { connected: true },
    async dispatchWorkflow(opts) { track.dispatches++; if (cfg.onDispatch) await cfg.onDispatch(opts); },
    async listWorkflowRuns(opts) { return cfg.listRuns ? await cfg.listRuns(opts) : []; },
    async getWorkflowRun(o, r, id) { track.statuses++; return cfg.getRun ? await cfg.getRun(o, r, id) : null; },
    async cancelWorkflowRun(o, r, id) { track.cancels++; if (cfg.onCancel) await cfg.onCancel(o, r, id); },
  };
}

function wfRun(over: Partial<GitHubWorkflowRun>): GitHubWorkflowRun {
  return {
    id: 1, name: "nexus-ci", head_branch: "nexus/devops/exec-1", head_sha: "sha-1",
    status: "queued", conclusion: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    html_url: "https://github.com/o/r/actions/runs/1",
    event: "workflow_dispatch", run_attempt: 1,
    ...over,
  };
}

function makeBridge(cfg: FakeConfig): { bridge: CiCicdBridge; track: CallTracker } {
  const track: CallTracker = { dispatches: 0, cancels: 0, statuses: 0 };
  const fake = fakeGithub(cfg, track);
  const provider = new GitHubActionsCICDProvider(fake, { resolveTimeoutMs: 100, resolveIntervalMs: 5 });
  const registry = new CICDProviderRegistry();
  registry.register(provider);
  const manager = new CICDRunManager(registry);
  return { bridge: { registry, manager, providerId: "github-actions" }, track };
}

const actor = { id: "ci-test", email: "ci-test@nexus.local" } as unknown as Actor;
function mkCtx(suffix: string, attempt = 1): CiContext {
  return {
    actor,
    project_id: "proj-ci-" + suffix,
    execution_id: "exec-ci-" + suffix,
    attempt,
    correlation_id: "corr-ci-" + suffix,
  };
}

// GitHub runs use the external path; provider arg is only inspected for kind=static.
const remoteProvider = { name: "github", kind: "remote" } as unknown as GitProvider;

async function main(): Promise<void> {
  console.log("NEXUS PHASE 105 PASS 2 — DURABLE GITHUB ACTIONS CI EXECUTION TESTS");
  console.log("=================================================================\n");

  const engine: NexusEngine = await openEngine();
  const events = new EventService(engine);
  await events.init();
  const audit = new AuditService(engine);
  const svcCtx = { engine, events, audit };
  const evidence = new EvidenceService(svcCtx);
  const artifacts = new ArtifactService(svcCtx);

  function mkServices(bridge?: CiCicdBridge): CiServices {
    return { engine, events, audit, evidence, artifacts, authz: {} as any, cicd: bridge };
  }
  async function persistExtras(run: CiPipelineRun, extras: Partial<CiPipelineRun>): Promise<CiPipelineRun> {
    Object.assign(run, extras);
    run.updated_at = Date.now();
    await engine.put("ci_pipeline_runs", run.id, run);
    return run;
  }

  // ============================================================
  // T01–T03  Persistence + idempotency
  // ============================================================
  {
    const suffix = uid();
    const ctx = mkCtx(suffix);
    const eng = new CiPipelineEngine(mkServices());
    const { run, created } = await eng.submitRun(ctx, "github", "owner/repo", "nexus/devops/" + ctx.execution_id);
    const found = await engine.byIndex<CiPipelineRun>("ci_pipeline_runs", "byExecution", ctx.execution_id);
    check("T01 CI run persistence exists",
      created === true && found.some((r) => r.id === run.id),
      "run=" + run.id + " found=" + found.length);
  }
  {
    const suffix = uid();
    const ctx = mkCtx(suffix);
    const eng = new CiPipelineEngine(mkServices());
    const a = await eng.submitRun(ctx, "github", "owner/repo", "nexus/devops/" + ctx.execution_id);
    const b = await eng.submitRun(ctx, "github", "owner/repo", "nexus/devops/" + ctx.execution_id);
    check("T02 attempt idempotency", a.run.id === b.run.id && b.created === false, "created2=" + b.created);
  }
  {
    const suffix = uid();
    const eng = new CiPipelineEngine(mkServices());
    const a = await eng.submitRun(mkCtx(suffix, 1), "github", "owner/repo", "nexus/devops/exec-" + suffix);
    const b = await eng.submitRun(mkCtx(suffix, 2), "github", "owner/repo", "nexus/devops/exec-" + suffix);
    check("T03 different attempts → different runs", a.run.id !== b.run.id, "a=" + a.run.id + " b=" + b.run.id);
  }

  // ============================================================
  // T04–T12  Dispatch path
  // ============================================================
  {
    const suffix = uid();
    const ctx = mkCtx(suffix);
    const { bridge, track } = makeBridge({
      listRuns: () => [wfRun({ id: 77, head_branch: "nexus/devops/" + ctx.execution_id, head_sha: "abcdef1234", created_at: new Date().toISOString() })],
    });
    const eng = new CiPipelineEngine(mkServices(bridge));
    const { run: r } = await eng.submitRun(ctx, "github", "owner/repo", "nexus/devops/" + ctx.execution_id);
    await persistExtras(r, { workflow_file: ".github/workflows/nexus-ci.yml", commit_sha: "abcdef1234" });
    await eng.startRun(r, ctx, remoteProvider);
    const persisted = await engine.get<CiPipelineRun>("ci_pipeline_runs", r.id);
    check("T04 external_run_id persisted after dispatch",
      persisted?.external_run_id === "77" && track.dispatches === 1,
      "ext=" + persisted?.external_run_id + " dispatches=" + track.dispatches);
  }
  {
    const { bridge } = makeBridge({});
    const p = bridge.registry.get("github-actions");
    const missing = bridge.registry.get("nope");
    check("T05 provider registry resolution",
      !!p && p.id === "github-actions" && missing === undefined,
      "found=" + (p?.id ?? "null") + " missing=" + (missing ?? "null"));
  }
  {
    const suffix = uid();
    const ctx = mkCtx(suffix);
    const { bridge, track } = makeBridge({ state: { connected: false, reason: "no token" } });
    const eng = new CiPipelineEngine(mkServices(bridge));
    const { run: r } = await eng.submitRun(ctx, "github", "owner/repo", "nexus/devops/" + ctx.execution_id);
    await persistExtras(r, { workflow_file: ".github/workflows/nexus-ci.yml", commit_sha: "abc" });
    const after = await eng.startRun(r, ctx, remoteProvider);
    check("T06 missing credential BLOCKED",
      after.status === "BLOCKED" && track.dispatches === 0 && !r.external_run_id,
      "status=" + after.status + " dispatches=" + track.dispatches);
  }
  {
    const suffix = uid();
    const ctx = mkCtx(suffix);
    const { bridge, track } = makeBridge({ listRuns: () => [wfRun({ id: 1, head_branch: "nexus/devops/" + ctx.execution_id })] });
    const eng = new CiPipelineEngine(mkServices(bridge));
    const { run: r } = await eng.submitRun(ctx, "github", "owner/repo", "nexus/devops/" + ctx.execution_id);
    const after = await eng.startRun(r, ctx, remoteProvider);
    check("T07 workflow_file missing → BLOCKED",
      after.status === "BLOCKED" && track.dispatches === 0,
      "status=" + after.status + " dispatches=" + track.dispatches);
  }
  {
    const suffix = uid();
    const ctx = mkCtx(suffix);
    const { bridge, track } = makeBridge({ listRuns: () => [wfRun({ id: 1, head_branch: "nexus/devops/" + ctx.execution_id })] });
    const eng = new CiPipelineEngine(mkServices(bridge));
    const { run: r } = await eng.submitRun(ctx, "github", "owner/repo", "nexus/devops/" + ctx.execution_id);
    await persistExtras(r, { workflow_file: ".github/workflows/nexus-ci.yml" });
    const after = await eng.startRun(r, ctx, remoteProvider);
    check("T08 commit_sha missing → BLOCKED",
      after.status === "BLOCKED" && track.dispatches === 0,
      "status=" + after.status + " dispatches=" + track.dispatches);
  }
  {
    const suffix = uid();
    const ctx = mkCtx(suffix);
    const { bridge } = makeBridge({});
    const eng = new CiPipelineEngine(mkServices(bridge));
    const { run: r } = await eng.submitRun(ctx, "github", "owner/repo", "nexus/devops/" + ctx.execution_id);
    const after = await eng.startRun(r, ctx, remoteProvider);
    check("T09 workflow commit required before dispatch",
      after.status === "BLOCKED" && /workflow_file|commit_sha/.test(after.blocked_reason ?? ""),
      "reason=" + after.blocked_reason);
  }
  {
    const suffix = uid();
    const ctx = mkCtx(suffix);
    const { bridge } = makeBridge({
      listRuns: () => [wfRun({ id: 12345, head_branch: "nexus/devops/" + ctx.execution_id, head_sha: "abcdef", created_at: new Date().toISOString() })],
    });
    const eng = new CiPipelineEngine(mkServices(bridge));
    const { run: r } = await eng.submitRun(ctx, "github", "owner/repo", "nexus/devops/" + ctx.execution_id);
    await persistExtras(r, { workflow_file: ".github/workflows/nexus-ci.yml", commit_sha: "abcdef" });
    const after = await eng.startRun(r, ctx, remoteProvider);
    check("T10 real external run ID persisted",
      after.external_run_id === "12345" && after.status === "RUNNING",
      "ext=" + after.external_run_id + " status=" + after.status);
  }
  {
    const suffix = uid();
    const ctx = mkCtx(suffix);
    const { bridge } = makeBridge({
      listRuns: () => [wfRun({ id: 999, head_branch: "nexus/devops/" + ctx.execution_id, head_sha: "abcdef", created_at: new Date().toISOString() })],
    });
    const eng = new CiPipelineEngine(mkServices(bridge));
    const { run: r } = await eng.submitRun(ctx, "github", "owner/repo", "nexus/devops/" + ctx.execution_id);
    await persistExtras(r, { workflow_file: ".github/workflows/nexus-ci.yml", commit_sha: "abcdef" });
    await eng.startRun(r, ctx, remoteProvider);
    const persisted = await engine.get<CiPipelineRun>("ci_pipeline_runs", r.id);
    check("T11 external_run_id persisted (ordering before RUNNING)",
      persisted?.external_run_id === "999" && persisted?.status === "RUNNING",
      "ext=" + persisted?.external_run_id + " status=" + persisted?.status);
  }
  {
    const suffix = uid();
    const ctx = mkCtx(suffix);
    const { bridge, track } = makeBridge({
      listRuns: () => [wfRun({ id: 555, head_branch: "nexus/devops/" + ctx.execution_id, head_sha: "abcdef", created_at: new Date().toISOString() })],
    });
    const eng = new CiPipelineEngine(mkServices(bridge));
    const { run: r } = await eng.submitRun(ctx, "github", "owner/repo", "nexus/devops/" + ctx.execution_id);
    await persistExtras(r, { workflow_file: ".github/workflows/nexus-ci.yml", commit_sha: "abcdef" });
    await eng.startRun(r, ctx, remoteProvider);
    const refreshed = await engine.get<CiPipelineRun>("ci_pipeline_runs", r.id);
    const after2 = await eng.startRun(refreshed!, ctx, remoteProvider);
    check("T12 duplicate startRun → one dispatch total",
      track.dispatches === 1 && after2.external_run_id === "555",
      "dispatches=" + track.dispatches + " ext=" + after2.external_run_id);
  }

  // ============================================================
  // T13–T14  Resumption + terminal short-circuit
  // ============================================================
  {
    const suffix = uid();
    const ctx = mkCtx(suffix);
    const { bridge, track } = makeBridge({});
    const eng = new CiPipelineEngine(mkServices(bridge));
    const { run: r } = await eng.submitRun(ctx, "github", "owner/repo", "nexus/devops/" + ctx.execution_id);
    await persistExtras(r, { external_run_id: "99999", status: "QUEUED" });
    const after = await eng.startRun(r, ctx, remoteProvider);
    check("T13 existing non-terminal → resumes to RUNNING without re-dispatch",
      track.dispatches === 0 && after.status === "RUNNING" && after.external_run_id === "99999",
      "dispatches=" + track.dispatches + " status=" + after.status);
  }
  {
    const suffix = uid();
    const ctx = mkCtx(suffix);
    const { bridge, track } = makeBridge({});
    const eng = new CiPipelineEngine(mkServices(bridge));
    const { run: r } = await eng.submitRun(ctx, "github", "owner/repo", "nexus/devops/" + ctx.execution_id);
    await persistExtras(r, { external_run_id: "terminal-1", status: "SUCCEEDED" });
    const after = await eng.startRun(r, ctx, remoteProvider);
    check("T14 existing terminal → unchanged, no dispatch",
      after.status === "SUCCEEDED" && track.dispatches === 0,
      "status=" + after.status + " dispatches=" + track.dispatches);
  }

  // ============================================================
  // T15–T20  Status mapping (pure, via mapGitHubStatus)
  // ============================================================
  check("T15 queued → QUEUED", mapGitHubStatus(wfRun({ status: "queued", conclusion: null })) === "QUEUED");
  check("T16 in_progress → RUNNING", mapGitHubStatus(wfRun({ status: "in_progress", conclusion: null })) === "RUNNING");
  check("T17 success → SUCCEEDED", mapGitHubStatus(wfRun({ status: "completed", conclusion: "success" })) === "SUCCEEDED");
  check("T18 failure → FAILED", mapGitHubStatus(wfRun({ status: "completed", conclusion: "failure" })) === "FAILED");
  check("T19 cancelled → CANCELLED", mapGitHubStatus(wfRun({ status: "completed", conclusion: "cancelled" })) === "CANCELLED");
  check("T20 unknown → BLOCKED (never SUCCEEDED)",
    mapGitHubStatus(wfRun({ status: "completed", conclusion: null })) === "BLOCKED"
    && mapGitHubStatus(wfRun({ status: "mystery" as never, conclusion: null })) === "BLOCKED");

  // ============================================================
  // T21–T23  Engine poll: legal/illegal transitions + BLOCKED mapping
  // ============================================================
  async function pollSeed(externalStatus: Partial<GitHubWorkflowRun>, startStatus: CiRunStatus = "RUNNING"): Promise<CiPipelineRun> {
    const suffix = uid();
    const ctx = mkCtx(suffix);
    const { bridge } = makeBridge({
      getRun: () => wfRun({ id: 900, head_branch: "nexus/devops/" + ctx.execution_id, ...externalStatus }),
    });
    const eng = new CiPipelineEngine(mkServices(bridge));
    const { run: r } = await eng.submitRun(ctx, "github", "owner/repo", "nexus/devops/" + ctx.execution_id);
    await persistExtras(r, {
      workflow_file: ".github/workflows/nexus-ci.yml",
      commit_sha: "abcdef",
      external_run_id: "900",
      status: startStatus,
    });
    return eng.pollRun(r, ctx);
  }
  {
    const after = await pollSeed({ status: "queued", conclusion: null }, "RUNNING");
    check("T21 illegal transition rejected (RUNNING→QUEUED stays RUNNING)", after.status === "RUNNING", "status=" + after.status);
  }
  {
    const after = await pollSeed({ status: "in_progress", conclusion: null }, "RUNNING");
    check("T21b in_progress poll keeps RUNNING (no-op)", after.status === "RUNNING", "status=" + after.status);
  }
  {
    const after = await pollSeed({ status: "completed", conclusion: "success" });
    check("T22 success completion → SUCCEEDED", after.status === "SUCCEEDED", "status=" + after.status);
  }
  {
    const after = await pollSeed({ status: "completed", conclusion: "failure" });
    check("T23 failure completion → FAILED", after.status === "FAILED", "status=" + after.status);
  }
  {
    const after = await pollSeed({ status: "completed", conclusion: "cancelled" });
    check("T23b cancelled completion → CANCELLED", after.status === "CANCELLED", "status=" + after.status);
  }
  {
    const after = await pollSeed({ status: "mystery" as never, conclusion: null });
    check("T23c unknown external status → BLOCKED", after.status === "BLOCKED", "status=" + after.status);
  }

  // ============================================================
  // T24–T27  Cancellation
  // ============================================================
  {
    const suffix = uid();
    const ctx = mkCtx(suffix);
    const seen = { owner: "", repo: "", id: "" };
    const { bridge, track } = makeBridge({
      onCancel: (o, r, id) => { seen.owner = o; seen.repo = r; seen.id = String(id); },
    });
    const eng = new CiPipelineEngine(mkServices(bridge));
    const { run: r } = await eng.submitRun(ctx, "github", "owner/repo", "nexus/devops/" + ctx.execution_id);
    await persistExtras(r, { external_run_id: "424242", status: "RUNNING" });
    await eng.cancelRun(r, ctx);
    check("T24 cancel targets exact external run",
      track.cancels === 1 && seen.owner === "owner" && seen.repo === "repo" && seen.id === "424242",
      "calls=" + track.cancels + " target=" + JSON.stringify(seen));
  }
  {
    const suffix = uid();
    const ctx = mkCtx(suffix);
    const { bridge } = makeBridge({ onCancel: () => {} });
    const eng = new CiPipelineEngine(mkServices(bridge));
    const { run: r } = await eng.submitRun(ctx, "github", "owner/repo", "nexus/devops/" + ctx.execution_id);
    await persistExtras(r, { external_run_id: "1", status: "RUNNING" });
    const after = await eng.cancelRun(r, ctx);
    check("T25 cancellation → CANCELLED", after.status === "CANCELLED", "status=" + after.status);
  }
  {
    const suffix = uid();
    const ctx = mkCtx(suffix);
    const { bridge, track } = makeBridge({});
    const eng = new CiPipelineEngine(mkServices(bridge));
    const { run: r } = await eng.submitRun(ctx, "github", "owner/repo", "nexus/devops/" + ctx.execution_id);
    const after = await eng.cancelRun(r, ctx);
    check("T26 cancel without external_run_id → BLOCKED",
      after.status === "BLOCKED" && track.cancels === 0,
      "status=" + after.status + " calls=" + track.cancels);
  }
  {
    const suffix = uid();
    const ctx = mkCtx(suffix);
    const { bridge } = makeBridge({ onCancel: () => { throw new Error("HTTP 403"); } });
    const eng = new CiPipelineEngine(mkServices(bridge));
    const { run: r } = await eng.submitRun(ctx, "github", "owner/repo", "nexus/devops/" + ctx.execution_id);
    await persistExtras(r, { external_run_id: "1", status: "RUNNING" });
    const after = await eng.cancelRun(r, ctx);
    check("T27 cancel API failure → BLOCKED", after.status === "BLOCKED", "status=" + after.status);
  }

  // ============================================================
  // T28  Redaction
  // ============================================================
  {
    const suffix = uid();
    const ctx = mkCtx(suffix);
    const fakeToken = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234";
    const { bridge } = makeBridge({ state: { connected: false, reason: "no token " + fakeToken } });
    const eng = new CiPipelineEngine(mkServices(bridge));
    const { run: r } = await eng.submitRun(ctx, "github", "owner/repo", "nexus/devops/" + ctx.execution_id);
    await persistExtras(r, { workflow_file: ".github/workflows/nexus-ci.yml", commit_sha: "abcdef" });
    const after = await eng.startRun(r, ctx, remoteProvider);
    const persisted = await engine.get<CiPipelineRun>("ci_pipeline_runs", r.id);
    const serialized = JSON.stringify(persisted);
    check("T28 error does not contain secrets",
      !serialized.includes("ghp_ABCDEF") && !/ghp_[A-Za-z0-9]{20,}/.test(serialized),
      "blocked_reason=" + (after.blocked_reason ?? ""));
  }

  // ============================================================
  // T29–T31  Restart recovery + ambiguity + provider honesty
  // ============================================================
  {
    const suffix = uid();
    const ctx = mkCtx(suffix);
    const { bridge, track } = makeBridge({});
    const eng = new CiPipelineEngine(mkServices(bridge));
    const { run: r } = await eng.submitRun(ctx, "github", "owner/repo", "nexus/devops/" + ctx.execution_id);
    await persistExtras(r, { workflow_file: ".github/workflows/nexus-ci.yml", commit_sha: "abc", external_run_id: "resume-1" });
    const after = await eng.startRun(r, ctx, remoteProvider);
    check("T29 restart recovery: QUEUED + external → RUNNING, no dispatch",
      after.status === "RUNNING" && track.dispatches === 0,
      "status=" + after.status + " dispatches=" + track.dispatches);
  }
  {
    const suffix = uid();
    const ctx = mkCtx(suffix);
    const { bridge } = makeBridge({
      getRun: () => wfRun({ id: 5, head_branch: "nexus/devops/" + ctx.execution_id, status: "completed", conclusion: "success" }),
    });
    const eng = new CiPipelineEngine(mkServices(bridge));
    const { run: r } = await eng.submitRun(ctx, "github", "owner/repo", "nexus/devops/" + ctx.execution_id);
    await persistExtras(r, { external_run_id: "5", status: "RUNNING" });
    const after = await eng.pollRun(r, ctx);
    check("T30 restart recovery: RUNNING + completed external → SUCCEEDED", after.status === "SUCCEEDED", "status=" + after.status);
  }
  {
    const suffix = uid();
    const ctx = mkCtx(suffix);
    const { bridge } = makeBridge({
      listRuns: () => [
        wfRun({ id: 1, head_branch: "nexus/devops/" + ctx.execution_id, head_sha: "abcdef", created_at: new Date().toISOString() }),
        wfRun({ id: 2, head_branch: "nexus/devops/" + ctx.execution_id, head_sha: "abcdef", created_at: new Date().toISOString() }),
      ],
    });
    const eng = new CiPipelineEngine(mkServices(bridge));
    const { run: r } = await eng.submitRun(ctx, "github", "owner/repo", "nexus/devops/" + ctx.execution_id);
    await persistExtras(r, { workflow_file: ".github/workflows/nexus-ci.yml", commit_sha: "abcdef" });
    const after = await eng.startRun(r, ctx, remoteProvider);
    const persisted = await engine.get<CiPipelineRun>("ci_pipeline_runs", r.id);
    check("T31 ambiguous external run → BLOCKED, no fabricated id",
      after.status === "BLOCKED" && !persisted?.external_run_id,
      "status=" + after.status + " ext=" + persisted?.external_run_id);
  }

  // ============================================================
  // T32  Provider failure + static provider safety
  // ============================================================
  {
    const suffix = uid();
    const ctx = mkCtx(suffix);
    const { bridge } = makeBridge({ onDispatch: () => { throw new Error("HTTP 500"); } });
    const eng = new CiPipelineEngine(mkServices(bridge));
    const { run: r } = await eng.submitRun(ctx, "github", "owner/repo", "nexus/devops/" + ctx.execution_id);
    await persistExtras(r, { workflow_file: ".github/workflows/nexus-ci.yml", commit_sha: "abcdef" });
    const after = await eng.startRun(r, ctx, remoteProvider);
    check("T32 provider failure → BLOCKED, no fabricated success",
      after.status === "BLOCKED" && !after.external_run_id,
      "status=" + after.status + " ext=" + after.external_run_id);
  }
  {
    const suffix = uid();
    const ctx = mkCtx(suffix);
    const { bridge } = makeBridge({});
    const eng = new CiPipelineEngine(mkServices(bridge));
    const { run: r } = await eng.submitRun(ctx, "github", "owner/repo", "nexus/devops/" + ctx.execution_id);
    const after = await eng.startRun(r, ctx, { name: "github", kind: "static" } as unknown as GitProvider);
    check("T32b static provider cannot produce production success", after.status === "BLOCKED", "status=" + after.status);
  }

  // ============================================================
  // T33–T35  Lineage preservation
  // ============================================================
  {
    const suffix = uid();
    const ctx = mkCtx(suffix);
    const { bridge } = makeBridge({
      listRuns: () => [wfRun({ id: 3, head_branch: "nexus/devops/" + ctx.execution_id, created_at: new Date().toISOString() })],
    });
    const eng = new CiPipelineEngine(mkServices(bridge));
    const { run: r } = await eng.submitRun(ctx, "github", "owner/repo", "nexus/devops/" + ctx.execution_id);
    await persistExtras(r, { workflow_file: ".github/workflows/nexus-ci.yml", commit_sha: "cafebabe1234" });
    const after = await eng.startRun(r, ctx, remoteProvider);
    check("T33 workflow_file + commit_sha preserved",
      after.workflow_file === ".github/workflows/nexus-ci.yml" && after.commit_sha === "cafebabe1234",
      "wf=" + after.workflow_file + " sha=" + after.commit_sha);
  }
  {
    const suffix = uid();
    const ctx = mkCtx(suffix);
    const { bridge } = makeBridge({
      listRuns: () => [wfRun({ id: 4, head_branch: "nexus/devops/" + ctx.execution_id, created_at: new Date().toISOString() })],
    });
    const eng = new CiPipelineEngine(mkServices(bridge));
    const { run: r } = await eng.submitRun(ctx, "github", "owner/repo", "nexus/devops/" + ctx.execution_id);
    await persistExtras(r, { workflow_file: ".github/workflows/nexus-ci.yml", commit_sha: "abcdef" });
    const after = await eng.startRun(r, ctx, remoteProvider);
    check("T34 correlation_id + project_id preserved",
      after.correlation_id === ctx.correlation_id && after.project_id === ctx.project_id,
      "corr=" + after.correlation_id + " project=" + after.project_id);
  }
  {
    const suffix = uid();
    const ctx = mkCtx(suffix, 3);
    const { bridge } = makeBridge({
      listRuns: () => [wfRun({ id: 7, head_branch: "nexus/devops/" + ctx.execution_id, created_at: new Date().toISOString() })],
    });
    const eng = new CiPipelineEngine(mkServices(bridge));
    const { run: r } = await eng.submitRun(ctx, "github", "owner/repo", "nexus/devops/" + ctx.execution_id);
    await persistExtras(r, { workflow_file: ".github/workflows/nexus-ci.yml", commit_sha: "abcdef" });
    const after = await eng.startRun(r, ctx, remoteProvider);
    check("T35 attempt preserved", after.attempt === 3, "attempt=" + after.attempt);
  }

  // ============================================================
  // T36–T37  Phase 104 + worker-phase integrity
  // ============================================================
  {
    // Phase 104 contract files: must remain byte-identical.
    const FROZEN = [
      "src/core/release-recovery.ts",
      "src/core/release-recovery-executor.ts",
      "src/core/release-recovery-inspection.ts",
      "src/core/release-deployment-intent.ts",
      "src/core/execution-store.ts",
    ];
    // Phase 104 file that Phase 107 extends additively: must be present, may
    // differ by the sanctioned digest-override addendum only.
    const EXTENDED = ["src/core/deployment-release-bridge.ts"];

    const allPresent = [...FROZEN, ...EXTENDED].every((f) => existsSync(f));
    let frozenClean = false;
    try {
      const status = execSync("git status --short -- " + FROZEN.join(" "), { encoding: "utf8" });
      frozenClean = status.trim() === "";
    } catch { frozenClean = false; }

    check(
      "T36 Phase 104 frozen files present and unchanged; extended file present",
      allPresent && frozenClean,
      "present=" + allPresent + " frozenClean=" + frozenClean,
    );
  }
  {
    let tracked = -1, onDisk = -1;
    try {
      const ls = execSync('git ls-files "src/core/worker-phase*.ts"', { encoding: "utf8" });
      tracked = ls.trim().split("\n").filter((x) => x).length;
    } catch {}
    try {
      onDisk = readdirSync("src/core").filter((n) => n.startsWith("worker-phase") && n.endsWith(".ts")).length;
    } catch {}
    check("T37 worker-phase integrity 717/717", tracked === 717 && onDisk === 717, "tracked=" + tracked + " onDisk=" + onDisk);
  }

  // ============================================================
  // Live capability probe
  // ============================================================
  console.log("\n=== Live GitHub Actions capability ===");
  const token = process.env.GITHUB_TOKEN || process.env.NEXUS_GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    console.log("BLOCKED — GitHub Actions live capability unavailable (no GITHUB_TOKEN / NEXUS_GITHUB_TOKEN / GH_TOKEN in env)");
  } else {
    console.log("Credential present (length " + token.length + "). Live dispatch is not performed by Pass 2's deterministic suite.");
  }

  console.log("\n=================================================================");
  console.log("PASS: " + pass + "  FAIL: " + fail);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(2); });