// src/core/github-actions-cicd-provider.ts
// Phase 105 Pass 1: real GitHub Actions CI adapter foundation.
//
// Implements the existing CICDProvider. Every operation is a real GitHub REST
// call made through the existing GitHubService credential boundary — never a
// new GitHub client, never a shell, never the gh CLI. The provider NEVER
// fabricates an external run id and NEVER maps an unknown state to success.

import type { CICDProvider, CICDStatusContext } from "./cicd-provider";
import type { GitHubWorkflowRun, GitHubWorkflowArtifact } from "./github";

/**
 * Structural subset of GitHubService required by this provider. The real
 * GitHubService satisfies this shape, and tests can supply a deterministic
 * stub without constructing a full authenticated service.
 */
export interface GitHubActionsClient {
  /**
   * Structural subset of GitHubService.ConnectionState. `connected` is the
   * authoritative signal; `reason` is optional and used only by test fakes
   * to exercise the token-redaction path (the real service never populates it).
   */
  state(): { connected: boolean; reason?: string | null };
  dispatchWorkflow(opts: {
    owner: string;
    repo: string;
    workflow: string;
    ref: string;
    inputs?: Record<string, string>;
  }): Promise<void>;
  listWorkflowRuns(opts: {
    owner: string;
    repo: string;
    workflow: string;
    event?: string;
    branch?: string;
    createdSinceIso?: string;
    perPage?: number;
  }): Promise<GitHubWorkflowRun[]>;
  getWorkflowRun(owner: string, repo: string, runId: string | number): Promise<GitHubWorkflowRun | null>;
  cancelWorkflowRun(owner: string, repo: string, runId: string | number): Promise<void>;
  listWorkflowRunArtifacts(opts: { owner: string; repo: string; runId: string | number; perPage?: number }): Promise<GitHubWorkflowArtifact[]>;
  downloadWorkflowRunArtifact(opts: { owner: string; repo: string; artifactId: string | number; maxBytes?: number }): Promise<Buffer>;
}

export interface GitHubActionsRequest {
  owner: string;
  repo: string;
  workflow: string;
  ref: string;
  inputs?: Record<string, string>;
  /** Optional: when the workflow commit is known, disambiguate the new run. */
  expected_head_sha?: string | null;
}

export interface GitHubActionsProviderOptions {
  resolveTimeoutMs?: number;
  resolveIntervalMs?: number;
  /** Fixed bound on retries within the resolve loop. */
  maxResolveAttempts?: number;
}

const OWNER_REPO_RE = /^[A-Za-z0-9_.-]+$/;
const WORKFLOW_RE = /^[A-Za-z0-9_./-]+\.(yml|yaml)$/;
const REF_RE = /^[A-Za-z0-9_./-]+$/;

export class GitHubActionsCICDProvider implements CICDProvider {
  readonly id = "github-actions";

  constructor(
    private readonly github: GitHubActionsClient,
    private readonly opts: GitHubActionsProviderOptions = {},
  ) {}

  validateRequest(request: any): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!request || typeof request !== "object") {
      return { valid: false, errors: ["request must be an object"] };
    }
    const r = request as Partial<GitHubActionsRequest>;

    if (typeof r.owner !== "string" || r.owner.length === 0) errors.push("owner is required");
    else if (!OWNER_REPO_RE.test(r.owner)) errors.push("owner must match [A-Za-z0-9_.-]+ (no scheme, no path separators)");

    if (typeof r.repo !== "string" || r.repo.length === 0) errors.push("repo is required");
    else if (!OWNER_REPO_RE.test(r.repo)) errors.push("repo must match [A-Za-z0-9_.-]+ (no scheme, no path separators)");

    if (typeof r.workflow !== "string" || r.workflow.length === 0) errors.push("workflow is required");
    else {
      const wf = r.workflow;
      if (wf.includes("://")) errors.push("workflow must not contain a URL scheme");
      else if (wf.startsWith("/")) errors.push("workflow must be a repository-relative path");
      else if (wf.split("/").includes("..")) errors.push("workflow path must not contain '..'");
      else if (!WORKFLOW_RE.test(wf)) errors.push("workflow must be a .yml or .yaml path");
    }

    if (typeof r.ref !== "string" || r.ref.length === 0) errors.push("ref is required");
    else {
      const ref = r.ref;
      if (ref.includes("://")) errors.push("ref must not contain a URL scheme");
      else if (ref.length > 200) errors.push("ref length out of range");
      else if (!REF_RE.test(ref)) errors.push("ref contains disallowed characters");
      else if (ref.includes("..")) errors.push("ref must not contain '..'");
      else if (ref.startsWith("/") || ref.endsWith("/")) errors.push("ref must not start or end with '/'");
    }

    if (r.inputs !== undefined) {
      if (typeof r.inputs !== "object" || r.inputs === null) errors.push("inputs must be an object");
      else {
        for (const [k, v] of Object.entries(r.inputs)) {
          if (typeof v !== "string") errors.push("input '" + k + "' must be a string");
          else if (v.length > 4000) errors.push("input '" + k + "' exceeds 4000 chars");
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  private ensureConnected(): void {
    const st = this.github.state();
    if (!st.connected) {
      throw new Error("BLOCKED: GitHub not connected — " + redactSecrets(st.reason ?? "no credential present"));
    }
  }

  async trigger(request: any): Promise<{ externalRunId: string }> {
    const v = this.validateRequest(request);
    if (!v.valid) {
      throw new Error("BLOCKED: invalid GitHub Actions request: " + v.errors.join("; "));
    }
    const r = request as GitHubActionsRequest;
    this.ensureConnected();

    const dispatchEpochMs = Date.now();
    await this.github.dispatchWorkflow({
      owner: r.owner,
      repo: r.repo,
      workflow: r.workflow,
      ref: r.ref,
      inputs: r.inputs ?? {},
    });

    const externalRunId = await this.resolveNewRun(r, dispatchEpochMs);
    if (!externalRunId) {
      throw new Error(
        "BLOCKED: GitHub accepted the dispatch but the newly-created run could not be identified unambiguously; refusing to guess an external run id",
      );
    }
    return { externalRunId };
  }

  private async resolveNewRun(r: GitHubActionsRequest, sinceMs: number): Promise<string | null> {
    const timeoutMs = this.opts.resolveTimeoutMs ?? 20_000;
    const intervalMs = this.opts.resolveIntervalMs ?? 1_500;
    const maxAttempts = this.opts.maxResolveAttempts ?? Math.max(1, Math.ceil(timeoutMs / intervalMs));
    const windowStartIso = new Date(sinceMs - 5_000).toISOString();

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let runs: GitHubWorkflowRun[] = [];
      try {
        runs = await this.github.listWorkflowRuns({
          owner: r.owner,
          repo: r.repo,
          workflow: r.workflow,
          event: "workflow_dispatch",
          branch: r.ref,
          createdSinceIso: windowStartIso,
          perPage: 30,
        });
      } catch {
        // transient API/network error — retry until deadline, then null
      }

      const matching = runs.filter((run) => {
        if (run.head_branch !== r.ref) return false;
        if (r.expected_head_sha && run.head_sha !== r.expected_head_sha) return false;
        const created = Date.parse(run.created_at);
        return Number.isFinite(created) && created >= sinceMs - 5_000;
      });

      if (matching.length === 1) return String(matching[0].id);
      if (matching.length > 1) return null; // ambiguous — never guess

      if (attempt < maxAttempts - 1) {
        await new Promise((res) => setTimeout(res, intervalMs));
      }
    }
    return null;
  }

  async getStatus(
    externalRunId: string,
    ctx?: CICDStatusContext,
  ): Promise<{ status: string; logs?: string; evidence?: any }> {
    this.ensureConnected();
    if (!ctx?.owner || !ctx?.repo) {
      return {
        status: "BLOCKED",
        evidence: { reason: "getStatus requires owner and repo context for GitHub Actions" },
      };
    }
    const run = await this.github.getWorkflowRun(ctx.owner, ctx.repo, externalRunId);
    if (!run) {
      return {
        status: "BLOCKED",
        evidence: {
          reason: "workflow run not found on provider",
          external_run_id: externalRunId,
          owner: ctx.owner,
          repo: ctx.repo,
        },
      };
    }
    return {
      status: mapGitHubStatus(run),
      evidence: {
        external_run_id: String(run.id),
        run_attempt: run.run_attempt,
        head_sha: run.head_sha,
        head_branch: run.head_branch,
        html_url: run.html_url,
        raw_status: run.status,
        raw_conclusion: run.conclusion,
        created_at: run.created_at,
        updated_at: run.updated_at,
      },
    };
  }

  async cancel(externalRunId: string, ctx?: CICDStatusContext): Promise<void> {
    this.ensureConnected();
    if (!ctx?.owner || !ctx?.repo) {
      throw new Error("BLOCKED: cancel requires owner and repo context for GitHub Actions");
    }
    await this.github.cancelWorkflowRun(ctx.owner, ctx.repo, externalRunId);
  }

  /**
   * Phase 132: list artifacts for the exact external run.
   */
  async listArtifacts(
    externalRunId: string,
    ctx?: CICDStatusContext,
  ): Promise<GitHubWorkflowArtifact[]> {
    this.ensureConnected();
    if (!ctx?.owner || !ctx?.repo) {
      throw new Error("BLOCKED: listArtifacts requires owner and repo context for GitHub Actions");
    }
    if (!externalRunId || typeof externalRunId !== "string") {
      throw new Error("BLOCKED: listArtifacts requires a non-empty externalRunId");
    }
    return this.github.listWorkflowRunArtifacts({
      owner: ctx.owner,
      repo: ctx.repo,
      runId: externalRunId,
    });
  }

  /**
   * Phase 132: download a specific artifact bound to the exact run.
   * Never follows arbitrary URLs; uses the GitHubService authenticated boundary.
   */
  async downloadArtifact(
    externalRunId: string,
    artifactId: string | number,
    ctx?: CICDStatusContext,
    maxBytes?: number,
  ): Promise<Buffer> {
    this.ensureConnected();
    if (!ctx?.owner || !ctx?.repo) {
      throw new Error("BLOCKED: downloadArtifact requires owner and repo context for GitHub Actions");
    }
    if (!externalRunId || typeof externalRunId !== "string") {
      throw new Error("BLOCKED: downloadArtifact requires a non-empty externalRunId");
    }
    if (artifactId === undefined || artifactId === null || String(artifactId).length === 0) {
      throw new Error("BLOCKED: downloadArtifact requires a non-empty artifactId");
    }
    const artifacts = await this.github.listWorkflowRunArtifacts({
      owner: ctx.owner,
      repo: ctx.repo,
      runId: externalRunId,
    });
    const match = artifacts.find((a) => String(a.id) === String(artifactId));
    if (!match) {
      throw new Error("BLOCKED: artifact does not belong to the given external run");
    }
    if (match.expired) {
      throw new Error("BLOCKED: GitHub reports the artifact as expired");
    }
    return this.github.downloadWorkflowRunArtifact({
      owner: ctx.owner,
      repo: ctx.repo,
      artifactId,
      maxBytes,
    });
  }
}

/**
 * Conservative mapping from real GitHub Actions state to the existing
 * provider-neutral CI model. Any state not positively known is BLOCKED,
 * never SUCCEEDED.
 */
export function mapGitHubStatus(run: GitHubWorkflowRun): string {
  const s = (run.status ?? "").toLowerCase();
  const c = (run.conclusion ?? "").toLowerCase();
  if (s === "completed") {
    if (c === "success") return "SUCCEEDED";
    if (c === "cancelled") return "CANCELLED";
    if (c === "failure" || c === "timed_out" || c === "action_required") return "FAILED";
    if (c === "neutral" || c === "skipped") return "FAILED";
    return "BLOCKED";
  }
  if (s === "in_progress") return "RUNNING";
  if (s === "queued" || s === "waiting" || s === "requested" || s === "pending") return "QUEUED";
  return "BLOCKED";
}

/**
 * Phase 105: strip anything that looks like a credential from a string before
 * it can reach an error, evidence, audit record, or event payload. Tokens are
 * never valid input to a NEXUS-produced message, so removal is unconditional.
 */
export function redactSecrets(input: string): string {
  return input
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED]")
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{10,}/gi, "Bearer [REDACTED]")
    .replace(/token[=:]\s*[A-Za-z0-9._~+/=-]{10,}/gi, "token=[REDACTED]");
}
