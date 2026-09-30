// src/core/engineering-security-review-executor.ts
// Phase 223: real engineering SECURITY_REVIEW stage executor.
//
// Consumes the authorized workspace from a completed REPAIR stage, runs the
// repository's real RealSecurityScanner against it, normalizes findings,
// evaluates them through the real SecurityPolicyEngine, persists a durable
// engineering security-review artifact via ArtifactStore, emits durable
// engineering_run_events, and returns an honest gate result.
//
// Under tsx the production ProcessExecutor is BrowserProcessExecutor (no
// child-process capability). RealSecurityScanner honestly reports every
// scanner as BLOCKED. That is the correct outcome; this executor never
// converts BLOCKED into PASS. When semgrep/gitleaks/checkov/npm are present
// on the host and a capable executor is injected, real scans run.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PgClient } from "./pg-client";
import type { ExecutionStore } from "./execution-store";
import type { ArtifactStore } from "./artifact-store";
import type { WorkspaceService, WorkspaceActor } from "./workspace";
import type { ProcessExecutor } from "./runtime";
import { RealSecurityScanner, type ScannerScanResult } from "./security-scanners";
import { SecurityPolicyEngine } from "./security-policy";
import { safeWorkspacePath } from "./security";

export type EngineeringSecurityReviewStatus = "SUCCEEDED" | "FAILED" | "BLOCKED";

export interface EngineeringSecurityReviewFinding {
  scanner: string;
  category: string;
  severity: string;
  title: string;
  file: string | null;
  line: number | null;
  resource: string | null;
}

export interface EngineeringSecurityReviewOutcome {
  status: EngineeringSecurityReviewStatus;
  reason: string;
  reviewId: string;
  findings: EngineeringSecurityReviewFinding[];
  scannerResults: ScannerScanResult[];
  policyVerdict: string;
  artifactRef: string | null;
}

export interface EngineeringSecurityReviewExecutorDeps {
  dbUrl: string;
  store: ExecutionStore;
  artifacts: ArtifactStore;
  workspaces: WorkspaceService;
  processExecutor: ProcessExecutor;
  policyEngine?: SecurityPolicyEngine;
}

export interface RunSecurityReviewInput {
  runId: string;
  workspaceId: string;
  actor: WorkspaceActor;
}

function genEventId(): string {
  return "eevt-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
}

function sanitize(s: string): string {
  if (!s) return "";
  return s
    .replace(/postgres:\/\/[^@\s]+@/gi, "postgres://<redacted>@")
    .replace(/(sk-|pk-|Bearer\s+)[A-Za-z0-9._-]{16,}/g, "$1<redacted>")
    .replace(/(api[_-]?key\s*[:=]\s*)[A-Za-z0-9._-]{16,}/gi, "$1<redacted>")
    .slice(0, 4096);
}

function mapSeverity(raw: string): "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO" | "UNKNOWN" {
  const s = (raw || "").toLowerCase();
  if (s === "critical") return "CRITICAL";
  if (s === "high") return "HIGH";
  if (s === "medium") return "MEDIUM";
  if (s === "low") return "LOW";
  if (s === "info") return "INFO";
  return "UNKNOWN";
}

export class EngineeringSecurityReviewExecutor {
  constructor(private readonly deps: EngineeringSecurityReviewExecutorDeps) {}

  private async withPg<T>(fn: (pg: PgClient) => Promise<T>): Promise<T> {
    const pg = new PgClient();
    await pg.connect(this.deps.dbUrl);
    try { return await fn(pg); } finally { await pg.close(); }
  }

  private async appendEvent(
    runId: string,
    stageId: string | null,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const pg = new PgClient();
    await pg.connect(this.deps.dbUrl);
    try {
      await pg.query(
        "INSERT INTO engineering_run_events (event_id, run_id, stage_id, event_type, payload, created_at) " +
        "VALUES ($1,$2,$3,$4,$5,$6)",
        [genEventId(), runId, stageId, eventType, JSON.stringify(payload), Date.now()],
      );
    } finally { await pg.close(); }
  }

  private async materialize(
    actor: WorkspaceActor,
    workspaceId: string,
  ): Promise<{ cwd: string; cleanup: () => Promise<void> } | { blocked: string }> {
    let records;
    try {
      records = await this.deps.workspaces.listFiles(actor, workspaceId);
    } catch (e) {
      return { blocked: "WORKSPACE_LIST_FAILED:" + (e instanceof Error ? e.message : String(e)) };
    }
    let tmpDir: string;
    try {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-secreview-"));
    } catch (e) {
      return { blocked: "TMPDIR_CREATE_FAILED:" + (e instanceof Error ? e.message : String(e)) };
    }
    try {
      for (const rec of records) {
        let norm: string;
        try { norm = safeWorkspacePath(rec.path); }
        catch { return { blocked: "UNSAFE_WORKSPACE_PATH:" + rec.path }; }
        const abs = path.join(tmpDir, norm);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, rec.content, "utf8");
      }
    } catch (e) {
      try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch {}
      return { blocked: "MATERIALIZE_WRITE_FAILED:" + (e instanceof Error ? e.message : String(e)) };
    }
    return {
      cwd: tmpDir,
      cleanup: async () => { try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch {} },
    };
  }

  async runSecurityReview(input: RunSecurityReviewInput): Promise<EngineeringSecurityReviewOutcome> {
    const { runId, workspaceId, actor } = input;
    const stageId = runId + "__SECURITY_REVIEW";
    const reviewId = "secreview-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    const empty = (status: EngineeringSecurityReviewStatus, reason: string, policyVerdict: string, artifactRef: string | null = null): EngineeringSecurityReviewOutcome => ({
      status, reason, reviewId, findings: [], scannerResults: [], policyVerdict, artifactRef,
    });

    await this.appendEvent(runId, stageId, "engineering_security_review.started", { runId, reviewId });

    // 1. REPAIR must be SUCCEEDED
    const repairJob = await this.deps.store.getJobAsync(runId + "__REPAIR");
    if (!repairJob) {
      await this.appendEvent(runId, stageId, "engineering_security_review.blocked", { reason: "REPAIR_JOB_MISSING" });
      return empty("BLOCKED", "REPAIR_JOB_MISSING", "BLOCKED");
    }
    if (repairJob.status !== "SUCCEEDED") {
      await this.appendEvent(runId, stageId, "engineering_security_review.blocked", { reason: "REPAIR_NOT_SUCCEEDED", repairStatus: repairJob.status });
      return empty("BLOCKED", "REPAIR_NOT_SUCCEEDED:" + repairJob.status, "BLOCKED");
    }

    // 2. Materialize workspace
    const prep = await this.materialize(actor, workspaceId);
    if ("blocked" in prep) {
      await this.appendEvent(runId, stageId, "engineering_security_review.blocked", { reason: "MATERIALIZATION_FAILED", detail: prep.blocked });
      return empty("BLOCKED", "MATERIALIZATION_FAILED:" + prep.blocked, "BLOCKED");
    }

    // 3. Run real scanner
    let scannerResults: ScannerScanResult[] = [];
    let scannerError: string | null = null;
    try {
      const scanner = new RealSecurityScanner(this.deps.processExecutor);
      const res = await scanner.runAll(prep.cwd);
      scannerResults = res.results;
    } catch (e) {
      scannerError = e instanceof Error ? e.message : String(e);
    } finally {
      await prep.cleanup();
    }

    if (scannerError) {
      await this.appendEvent(runId, stageId, "engineering_security_review.failed", { reason: "SCANNER_THREW", detail: scannerError.slice(0, 300) });
      return empty("FAILED", "SCANNER_THREW:" + scannerError, "BLOCKED");
    }

    await this.appendEvent(runId, stageId, "engineering_security_review.scanner_completed", {
      scannerCount: scannerResults.length,
      statuses: scannerResults.map((r) => ({ scanner: r.scanner, status: r.status })),
    });

    // 4. Normalize findings
    const findings: EngineeringSecurityReviewFinding[] = [];
    for (const r of scannerResults) {
      for (const f of r.findings) {
        findings.push({
          scanner: f.scanner,
          category: f.category,
          severity: f.severity,
          title: f.title,
          file: f.file,
          line: f.line,
          resource: f.resource,
        });
      }
    }

    // 5. Evaluate through the real SecurityPolicyEngine
    const engine = this.deps.policyEngine ?? new SecurityPolicyEngine();
    let policyVerdict: "PASS" | "FAIL" | "BLOCKED" = "BLOCKED";
    let decision: any = null;
    try {
      const execution: any = {
        id: "sec-exec-" + reviewId,
        project_id: "engineering-run",
        execution_id: runId,
        commit_sha: "unknown",
        environment: "engineering",
        scanner: "multi",
        category: "SAST",
        status: "SUCCEEDED",
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      };
      const evidenceList: any[] = scannerResults.map((r) => ({
        id: "secevid-" + r.scanner + "-" + reviewId,
        project_id: "engineering-run",
        execution_id: runId,
        commit_sha: "unknown",
        environment: "engineering",
        scanner: r.scanner,
        category: r.kind === "SAST" ? "SAST" : r.kind === "SCA" ? "SCA" : r.kind === "SECRET" ? "SECRET" : r.kind === "IAC" ? "IAC" : "CONTAINER",
        status: r.status === "PASSED" ? "PASS" : r.status === "FAILED" ? "FAIL" : "BLOCKED",
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      }));
      const policyFindings: any[] = findings.map((f) => ({
        severity: mapSeverity(f.severity),
        category: f.category,
        scanner: f.scanner,
        title: f.title,
      }));
      decision = engine.evaluate(execution, evidenceList, policyFindings as any, undefined);
      policyVerdict = (decision && decision.verdict) ? decision.verdict : "BLOCKED";
      if (policyVerdict !== "PASS" && policyVerdict !== "FAIL" && policyVerdict !== "BLOCKED") policyVerdict = "BLOCKED";
    } catch { policyVerdict = "BLOCKED"; }

    await this.appendEvent(runId, stageId, "engineering_security_review.policy_evaluated", {
      policyVerdict, findingCount: findings.length,
    });

    // 6. Determine final status
    const anyScannerRan = scannerResults.some((r) => r.status === "PASSED" || r.status === "FAILED");
    let status: EngineeringSecurityReviewStatus;
    let reason: string;
    if (!anyScannerRan) {
      status = "BLOCKED";
      reason = "SCANNERS_UNAVAILABLE";
    } else if (policyVerdict === "PASS") {
      status = "SUCCEEDED";
      reason = "SECURITY_REVIEW_PASSED";
    } else if (policyVerdict === "FAIL") {
      status = "FAILED";
      reason = "SECURITY_POLICY_FAILED";
    } else {
      status = "BLOCKED";
      reason = "SECURITY_POLICY_BLOCKED";
    }

    // 7. Persist artifact
    const artifactContent = JSON.stringify({
      schemaVersion: 1,
      reviewId,
      runId,
      workspaceId,
      stage: "SECURITY_REVIEW",
      scannerResults: scannerResults.map((r) => ({
        kind: r.kind, scanner: r.scanner, status: r.status,
        findings: r.findings.length, blocked_reason: r.blocked_reason ? sanitize(r.blocked_reason).slice(0, 200) : null,
        duration_ms: r.duration_ms,
      })),
      findings,
      policyVerdict,
      status,
      reason,
      capturedAt: new Date().toISOString(),
    }, null, 2);

    let artifactRef: string | null = null;
    try {
      const record = await this.deps.artifacts.registerArtifactAsync(
        {
          artifactId: "art-secreview-" + reviewId,
          jobId: runId,
          name: "security-review-" + reviewId + ".json",
          type: "ENGINEERING_SECURITY_REVIEW",
          metadata: { reviewId, runId, policyVerdict, status, findingCount: findings.length },
          createdAt: Date.now(),
        } as any,
        artifactContent,
      );
      artifactRef = "artifact://" + record.artifactId;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.appendEvent(runId, stageId, "engineering_security_review.failed", { reason: "ARTIFACT_REGISTRATION_FAILED", detail: sanitize(msg).slice(0, 300) });
      return empty("FAILED", "ARTIFACT_REGISTRATION_FAILED", policyVerdict, null);
    }

    const finalEvent = status === "SUCCEEDED" ? "engineering_security_review.completed" : status === "FAILED" ? "engineering_security_review.failed" : "engineering_security_review.blocked";
    await this.appendEvent(runId, stageId, finalEvent, { reviewId, status, reason, artifactRef, policyVerdict });

    return { status, reason, reviewId, findings, scannerResults, policyVerdict, artifactRef };
  }
}
