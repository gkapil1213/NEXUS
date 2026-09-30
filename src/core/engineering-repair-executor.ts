// src/core/engineering-repair-executor.ts
// Phase 222: real engineering REPAIR stage executor.
//
// Consumes the diagnosis artifact produced by EngineeringDiagnosisExecutor,
// applies a bounded, deterministic repair through WorkspaceService when the
// diagnosis carries a structured repairDirective, validates the result via
// CommandExecutor, and persists before/after evidence.
//
// When the diagnosis does not carry a directive (Phase 221 today), REPAIR
// honestly reports BLOCKED with a precise reason. NO_FAILURE_TO_DIAGNOSE is
// a real no-op SUCCEEDED. No fake repairs, no invented diffs.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { PgClient } from "./pg-client";
import type { ExecutionStore } from "./execution-store";
import type { ArtifactStore } from "./artifact-store";
import type { WorkspaceService, WorkspaceActor } from "./workspace";
import type { CommandExecutor } from "./devops";
import { safeWorkspacePath } from "./security";

export type EngineeringRepairStatus = "SUCCEEDED" | "FAILED" | "BLOCKED";

export type RepairDirectiveKind = "WRITE_FILE" | "DELETE_FILE";

export interface RepairDirective {
  kind: RepairDirectiveKind;
  path: string;
  content?: string;
}

export interface RepairTargetInfo {
  type: string;
  path: string | null;
  description: string;
}

export interface EngineeringRepairOutcome {
  status: EngineeringRepairStatus;
  reason: string;
  repairId: string | null;
  diagnosisId: string | null;
  sourceStage: string | null;
  classification: string | null;
  repairTarget: RepairTargetInfo | null;
  directive: RepairDirective | null;
  changed: boolean;
  beforeHash: string | null;
  afterHash: string | null;
  diffHash: string | null;
  validationStatus: string | null;
  artifactRef: string | null;
}

export interface EngineeringRepairExecutorDeps {
  dbUrl: string;
  store: ExecutionStore;
  artifacts: ArtifactStore;
  workspaces: WorkspaceService;
  commandExecutor?: CommandExecutor | null;
  readArtifact?: (artifactId: string) => Promise<string | null>;
}

export interface RunRepairInput {
  runId: string;
  workspaceId: string;
  actor: WorkspaceActor;
}

function genEventId(): string {
  return "eevt-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function sanitize(s: string): string {
  if (!s) return "";
  return s
    .replace(/postgres:\/\/[^@\s]+@/gi, "postgres://<redacted>@")
    .replace(/(sk-|pk-|Bearer\s+)[A-Za-z0-9._-]{16,}/g, "$1<redacted>")
    .replace(/(api[_-]?key\s*[:=]\s*)[A-Za-z0-9._-]{16,}/gi, "$1<redacted>")
    .slice(0, 8192);
}

export class EngineeringRepairExecutor {
  constructor(private readonly deps: EngineeringRepairExecutorDeps) {}

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

  async runRepair(input: RunRepairInput): Promise<EngineeringRepairOutcome> {
    const { runId, workspaceId, actor } = input;
    const stageId = runId + "__REPAIR";
    const empty = (): EngineeringRepairOutcome => ({
      status: "BLOCKED", reason: "UNKNOWN",
      repairId: null, diagnosisId: null, sourceStage: null, classification: null,
      repairTarget: null, directive: null, changed: false,
      beforeHash: null, afterHash: null, diffHash: null,
      validationStatus: null, artifactRef: null,
    });

    await this.appendEvent(runId, stageId, "engineering_repair.started", { runId, stageId });

    // 1. DIAGNOSIS job must be SUCCEEDED
    const diagJob = await this.deps.store.getJobAsync(runId + "__DIAGNOSIS");
    if (!diagJob) {
      await this.appendEvent(runId, stageId, "engineering_repair.blocked", { reason: "DIAGNOSIS_JOB_MISSING" });
      return { ...empty(), reason: "DIAGNOSIS_JOB_MISSING" };
    }
    if (diagJob.status !== "SUCCEEDED") {
      await this.appendEvent(runId, stageId, "engineering_repair.blocked", {
        reason: "DIAGNOSIS_NOT_AVAILABLE", diagnosisStatus: diagJob.status,
      });
      return { ...empty(), reason: "DIAGNOSIS_NOT_AVAILABLE:" + diagJob.status };
    }

    // 2. Load diagnosis artifact ref from the completed event
    const diagEvents = await this.withPg(async (pg) => {
      const r = await pg.query<any>(
        "SELECT payload FROM engineering_run_events WHERE run_id=$1 AND event_type=$2 " +
        "ORDER BY created_at DESC LIMIT 1",
        [runId, "engineering_diagnosis.completed"]);
      return r.rows;
    });
    if (diagEvents.length === 0) {
      await this.appendEvent(runId, stageId, "engineering_repair.blocked", { reason: "DIAGNOSIS_EVENT_MISSING" });
      return { ...empty(), reason: "DIAGNOSIS_EVENT_MISSING" };
    }

    let diagPayload: any;
    try { diagPayload = JSON.parse(diagEvents[0].payload ?? "{}"); } catch { diagPayload = {}; }

    const classification: string | null = diagPayload.classification ?? null;
    const diagnosisId: string | null = diagPayload.diagnosisId ?? null;
    const artifactRef: string | null = diagPayload.artifactRef ?? null;

    // 3. No-failure = real no-op
    if (classification === "NO_FAILURE_TO_DIAGNOSE") {
      const repairId = "rep-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
      await this.appendEvent(runId, stageId, "engineering_repair.noop", {
        repairId, diagnosisId, reason: "NO_REPAIR_REQUIRED",
      });
      await this.appendEvent(runId, stageId, "engineering_repair.completed", {
        repairId, status: "SUCCEEDED", reason: "NO_REPAIR_REQUIRED",
      });
      return {
        ...empty(),
        status: "SUCCEEDED",
        reason: "NO_REPAIR_REQUIRED",
        repairId,
        diagnosisId,
        classification,
        changed: false,
        validationStatus: "NOT_REQUIRED",
      };
    }

    // 4. Load full diagnosis artifact content
    let artifactContent: string | null = null;
    if (artifactRef && this.deps.readArtifact) {
      try { artifactContent = await this.deps.readArtifact(artifactRef.replace("artifact://", "")); } catch { /* fall through */ }
    }

    let artifact: any = null;
    if (artifactContent) {
      try { artifact = JSON.parse(artifactContent); } catch { artifact = null; }
    }

    const repairTarget: RepairTargetInfo | null = (artifact?.repairTarget) ?? null;
    const directive: RepairDirective | null = (artifact?.repairDirective) ?? null;

    // 5. No directive → BLOCKED with precise reason
    if (!directive) {
      const targetType = repairTarget?.type ?? "UNKNOWN";
      const reason = "REPAIR_NOT_IMPLEMENTABLE_FOR_TARGET:" + targetType;
      await this.appendEvent(runId, stageId, "engineering_repair.blocked", {
        reason, targetType, diagnosisId,
      });
      return { ...empty(), reason, diagnosisId, classification, repairTarget };
    }


    // 6. Validate directive path via safeWorkspacePath
    let safePath: string;
    try {
      safePath = safeWorkspacePath(directive.path);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.appendEvent(runId, stageId, "engineering_repair.blocked", {
        reason: "UNSAFE_REPAIR_PATH", detail: msg,
      });
      return { ...empty(), reason: "UNSAFE_REPAIR_PATH:" + msg, diagnosisId, classification, repairTarget, directive };
    }

    // 7. Read before state
    let beforeContent: string | null = null;
    try {
      const rec = await this.deps.workspaces.readFile(actor, workspaceId, safePath);
      beforeContent = rec.content;
    } catch { /* file does not exist — allowed for WRITE_FILE create */ }

    // 8. Compute before hash
    const beforeHash = beforeContent !== null ? sha256Hex(beforeContent) : null;

    // 9. Determine desired after state
    let desiredContent: string | null = null;
    if (directive.kind === "WRITE_FILE") {
      if (typeof directive.content !== "string") {
        await this.appendEvent(runId, stageId, "engineering_repair.blocked", { reason: "DIRECTIVE_CONTENT_MISSING" });
        return { ...empty(), reason: "DIRECTIVE_CONTENT_MISSING", diagnosisId, classification, repairTarget, directive };
      }
      desiredContent = directive.content;
    } else if (directive.kind === "DELETE_FILE") {
      desiredContent = null;
    } else {
      await this.appendEvent(runId, stageId, "engineering_repair.blocked", { reason: "UNSUPPORTED_DIRECTIVE_KIND" });
      return { ...empty(), reason: "UNSUPPORTED_DIRECTIVE_KIND", diagnosisId, classification, repairTarget, directive };
    }

    // 10. No-op detection
    const isNoOp =
      (directive.kind === "WRITE_FILE" && beforeContent === desiredContent) ||
      (directive.kind === "DELETE_FILE" && beforeContent === null);

    if (isNoOp) {
      const repairId = "rep-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
      await this.appendEvent(runId, stageId, "engineering_repair.noop", {
        repairId, diagnosisId, path: safePath, reason: "ALREADY_CORRECT",
      });
      await this.appendEvent(runId, stageId, "engineering_repair.completed", {
        repairId, status: "SUCCEEDED", reason: "ALREADY_CORRECT",
      });
      return {
        ...empty(), status: "SUCCEEDED", reason: "ALREADY_CORRECT",
        repairId, diagnosisId, sourceStage: artifact?.sourceStage ?? null,
        classification, repairTarget, directive,
        changed: false, beforeHash, afterHash: beforeHash, diffHash: null,
        validationStatus: "NOT_REQUIRED",
      };
    }

    // 11. Apply real mutation
    await this.appendEvent(runId, stageId, "engineering_repair.applied", {
      diagnosisId, path: safePath, kind: directive.kind,
      beforeHash, beforeExists: beforeContent !== null,
    });

    try {
      if (directive.kind === "WRITE_FILE") {
        await this.deps.workspaces.writeFile(actor, workspaceId, safePath, desiredContent!);
      } else if (directive.kind === "DELETE_FILE") {
        await this.deps.workspaces.deleteFile(actor, workspaceId, safePath);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.appendEvent(runId, stageId, "engineering_repair.failed", {
        reason: "WORKSPACE_MUTATION_FAILED", detail: msg,
      });
      return { ...empty(), status: "FAILED", reason: "WORKSPACE_MUTATION_FAILED:" + msg,
               diagnosisId, classification, repairTarget, directive,
               changed: false, beforeHash };
    }

    // 12. Read after state
    let afterContent: string | null = null;
    try {
      const rec = await this.deps.workspaces.readFile(actor, workspaceId, safePath);
      afterContent = rec.content;
    } catch { afterContent = null; }

    const afterHash = afterContent !== null ? sha256Hex(afterContent) : null;
    const diffBlob = JSON.stringify({ path: safePath, before: beforeContent, after: afterContent });
    const diffHash = sha256Hex(diffBlob);


    // 13. Validation
    let validationStatus = "SKIPPED";
    let validationError: string | null = null;
    let validationCommand: string | null = null;

    if (this.deps.commandExecutor) {
      // Determine validation command from the diagnosis source stage events
      const srcStage = artifact?.sourceStage ?? null;
      let cmd: string | null = null;
      if (srcStage === "BUILD" || srcStage === "TEST") {
        const evType = srcStage === "BUILD" ? "engineering_build.%" : "engineering_test.%";
        const rows = await this.withPg(async (pg) => {
          const r = await pg.query<any>(
            "SELECT payload FROM engineering_run_events WHERE run_id=$1 AND event_type LIKE $2 " +
            "ORDER BY created_at DESC LIMIT 5",
            [runId, evType]);
          return r.rows;
        });
        for (const row of rows) {
          try {
            const pl = JSON.parse(row.payload ?? "{}");
            if (typeof pl.command === "string" && pl.command.length > 0) { cmd = pl.command; break; }
          } catch { /* skip */ }
        }
      }

      if (!cmd) {
        validationStatus = "BLOCKED";
        validationError = "NO_VALIDATION_COMMAND";
      } else {
        validationCommand = cmd;
        await this.appendEvent(runId, stageId, "engineering_repair.validation_started", {
          command: cmd, sourceStage: srcStage,
        });

        // Materialize the current (mutated) workspace to a temp dir
        let cwd: string | null = null;
        try {
          const records = await this.deps.workspaces.listFiles(actor, workspaceId);
          cwd = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-repair-"));
          for (const rec of records) {
            let norm: string;
            try { norm = safeWorkspacePath(rec.path); } catch { continue; }
            const abs = path.join(cwd, norm);
            await fs.mkdir(path.dirname(abs), { recursive: true });
            await fs.writeFile(abs, rec.content, "utf8");
          }
        } catch (e) {
          validationStatus = "BLOCKED";
          validationError = "MATERIALIZE_FAILED:" + (e instanceof Error ? e.message : String(e));
        }

        if (cwd) {
          try {
            const r = await this.deps.commandExecutor.exec(cmd, cwd, {});
            if (r.exit_code === 0) {
              validationStatus = "PASS";
              await this.appendEvent(runId, stageId, "engineering_repair.validation_succeeded", {
                command: cmd, exitCode: 0,
              });
            } else {
              validationStatus = "FAIL";
              validationError = "EXIT_" + r.exit_code;
              await this.appendEvent(runId, stageId, "engineering_repair.validation_failed", {
                command: cmd, exitCode: r.exit_code,
              });
            }
          } catch (e) {
            validationStatus = "BLOCKED";
            validationError = "EXECUTOR_BLOCKED:" + (e instanceof Error ? e.message : String(e));
          } finally {
            try { await fs.rm(cwd, { recursive: true, force: true }); } catch { /* best-effort */ }
          }
        }
      }
    } else {
      validationStatus = "BLOCKED";
      validationError = "COMMAND_EXECUTOR_NOT_CONFIGURED";
    }

    // 14. Determine outcome from validation
    const repairId = "rep-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    const validationPassed = validationStatus === "PASS";
    const outcomeStatus: EngineeringRepairStatus = validationPassed ? "SUCCEEDED" : "FAILED";
    const outcomeReason = validationPassed
      ? "REPAIR_APPLIED_AND_VALIDATED"
      : "REPAIR_VALIDATION_" + validationStatus + (validationError ? ":" + validationError : "");

    // 15. Persist artifact
    const artifactContentOut = JSON.stringify({
      schemaVersion: 1,
      repairId,
      runId,
      stage: "REPAIR",
      diagnosisId,
      diagnosisArtifactRef: artifactRef,
      sourceStage: artifact?.sourceStage ?? null,
      classification,
      repairTarget,
      directive,
      changed: true,
      beforeHash,
      afterHash,
      diffHash,
      validation: {
        status: validationStatus,
        command: validationCommand,
        error: validationError,
      },
      result: outcomeStatus,
      capturedAt: new Date().toISOString(),
    }, null, 2);

    let repairArtifactRef: string | null = null;
    try {
      const record = await this.deps.artifacts.registerArtifactAsync(
        {
          artifactId: "art-repair-" + repairId,
          jobId: runId,
          name: "repair-" + repairId + ".json",
          type: "ENGINEERING_REPAIR",
          metadata: { repairId, runId, diagnosisId, result: outcomeStatus, changed: true },
          createdAt: Date.now(),
        } as any,
        artifactContentOut,
      );
      repairArtifactRef = "artifact://" + record.artifactId;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.appendEvent(runId, stageId, "engineering_repair.failed", {
        reason: "ARTIFACT_REGISTRATION_FAILED", detail: sanitize(msg),
      });
      return { ...empty(), status: "FAILED", reason: "ARTIFACT_REGISTRATION_FAILED",
               repairId, diagnosisId, classification, repairTarget, directive,
               changed: true, beforeHash, afterHash, diffHash,
               validationStatus, artifactRef: null };
    }

    await this.appendEvent(runId, stageId,
      outcomeStatus === "SUCCEEDED" ? "engineering_repair.completed" : "engineering_repair.failed",
      { repairId, status: outcomeStatus, reason: outcomeReason, artifactRef: repairArtifactRef });

    return {
      status: outcomeStatus,
      reason: outcomeReason,
      repairId,
      diagnosisId,
      sourceStage: artifact?.sourceStage ?? null,
      classification,
      repairTarget,
      directive,
      changed: true,
      beforeHash,
      afterHash,
      diffHash,
      validationStatus,
      artifactRef: repairArtifactRef,
    };
  }
}
