// src/core/engineering-diagnosis-executor.ts
// Phase 221: real engineering DIAGNOSIS stage executor.
//
// Consumes BUILD/TEST execution evidence from durable job + event state,
// classifies the failure from evidence alone, and produces a durable
// diagnostic artifact that the REPAIR stage can act on.
//
// Never fabricates evidence. Missing or ambiguous evidence remains UNKNOWN,
// and missing prerequisites remain BLOCKED rather than being disguised
// as SUCCEEDED.

import { PgClient } from "./pg-client";
import type { ExecutionStore } from "./execution-store";
import type { ArtifactStore } from "./artifact-store";
import type { WorkspaceActor } from "./workspace";

export type EngineeringDiagnosisStatus = "SUCCEEDED" | "FAILED" | "BLOCKED";

export type DiagnosisClassification =
  | "BUILD_FAILURE"
  | "TEST_FAILURE"
  | "COMPILATION_FAILURE"
  | "TYPE_ERROR"
  | "DEPENDENCY_FAILURE"
  | "COMMAND_NOT_FOUND"
  | "PERMISSION_FAILURE"
  | "NETWORK_FAILURE"
  | "TIMEOUT"
  | "TEST_ASSERTION_FAILURE"
  | "TEST_RUNTIME_FAILURE"
  | "CONFIGURATION_FAILURE"
  | "UNKNOWN_FAILURE"
  | "NO_FAILURE_TO_DIAGNOSE";

export type DiagnosisConfidence = "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";

export interface DiagnosisEvidence {
  sourceStage: "BUILD" | "TEST" | null;
  sourceJobId: string | null;
  sourceStatus: string | null;
  exitCode: number | null;
  command: string | null;
  reason: string | null;
  stderrExcerpt: string | null;
  sourceArtifactRefs: string[];
  eventTypes: string[];
}

export interface DiagnosisRepairTarget {
  type: string;
  path: string | null;
  description: string;
}

export interface EngineeringDiagnosisOutcome {
  status: EngineeringDiagnosisStatus;
  reason: string;
  diagnosisId: string | null;
  classification: DiagnosisClassification;
  rootCause: string;
  confidence: DiagnosisConfidence;
  evidence: DiagnosisEvidence;
  repairTarget: DiagnosisRepairTarget | null;
  artifactRef: string | null;
}

export interface EngineeringDiagnosisExecutorDeps {
  dbUrl: string;
  store: ExecutionStore;
  artifacts: ArtifactStore;
}

export interface RunDiagnosisInput {
  runId: string;
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

export class EngineeringDiagnosisExecutor {
  constructor(private readonly deps: EngineeringDiagnosisExecutorDeps) {}

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

  async runDiagnosis(input: RunDiagnosisInput): Promise<EngineeringDiagnosisOutcome> {
    const { runId } = input;
    const stageId = runId + "__DIAGNOSIS";
    const empty = (): DiagnosisEvidence => ({
      sourceStage: null, sourceJobId: null, sourceStatus: null,
      exitCode: null, command: null, reason: null, stderrExcerpt: null,
      sourceArtifactRefs: [], eventTypes: [],
    });
    const blocked = (reason: string, detail: string): EngineeringDiagnosisOutcome => ({
      status: "BLOCKED", reason,
      diagnosisId: null, classification: "UNKNOWN_FAILURE",
      rootCause: detail, confidence: "UNKNOWN",
      evidence: empty(), repairTarget: null, artifactRef: null,
    });

    await this.appendEvent(runId, stageId, "engineering_diagnosis.started", { runId, stageId });

    // 1. Load BUILD and TEST jobs
    const buildJob = await this.deps.store.getJobAsync(runId + "__BUILD");
    const testJob  = await this.deps.store.getJobAsync(runId + "__TEST");

    if (!buildJob) {
      await this.appendEvent(runId, stageId, "engineering_diagnosis.blocked", { reason: "BUILD_JOB_MISSING" });
      return blocked("BUILD_JOB_MISSING", "BUILD prerequisite job is missing");
    }

    // 2. Determine terminal source
    const BUILD_FAILED = new Set(["FAILED", "DEAD_LETTER"]);
    const SUCCEEDED    = new Set(["SUCCEEDED"]);
    const BLOCKED_S    = new Set(["BLOCKED"]);

    let sourceStage: "BUILD" | "TEST" | null = null;
    let sourceJobId: string | null = null;
    let sourceStatus: string | null = null;

    if (testJob && BUILD_FAILED.has(testJob.status)) {
      sourceStage = "TEST"; sourceJobId = testJob.id; sourceStatus = testJob.status;
    } else if (BUILD_FAILED.has(buildJob.status)) {
      sourceStage = "BUILD"; sourceJobId = buildJob.id; sourceStatus = buildJob.status;
    } else if (testJob && BLOCKED_S.has(testJob.status)) {
      await this.appendEvent(runId, stageId, "engineering_diagnosis.blocked", {
        reason: "SOURCE_STAGE_BLOCKED", sourceStage: "TEST",
      });
      return blocked("SOURCE_STAGE_BLOCKED", "TEST is BLOCKED — no diagnostic evidence available");
    } else if (BLOCKED_S.has(buildJob.status) && (!testJob || !SUCCEEDED.has(testJob.status))) {
      await this.appendEvent(runId, stageId, "engineering_diagnosis.blocked", {
        reason: "SOURCE_STAGE_BLOCKED", sourceStage: "BUILD",
      });
      return blocked("SOURCE_STAGE_BLOCKED", "BUILD is BLOCKED — no diagnostic evidence available");
    } else if (SUCCEEDED.has(buildJob.status) && testJob && SUCCEEDED.has(testJob.status)) {
      // Successful pipeline — nothing to diagnose
      await this.appendEvent(runId, stageId, "engineering_diagnosis.completed", {
        classification: "NO_FAILURE_TO_DIAGNOSE",
      });
      return {
        status: "SUCCEEDED", reason: "NO_FAILURE_TO_DIAGNOSE",
        diagnosisId: null, classification: "NO_FAILURE_TO_DIAGNOSE",
        rootCause: "All prerequisite stages succeeded — no failure to diagnose",
        confidence: "HIGH",
        evidence: empty(), repairTarget: null, artifactRef: null,
      };
    } else {
      await this.appendEvent(runId, stageId, "engineering_diagnosis.blocked", {
        reason: "INSUFFICIENT_EVIDENCE",
        buildStatus: buildJob.status, testStatus: testJob?.status ?? null,
      });
      return blocked("INSUFFICIENT_EVIDENCE",
        "Prerequisite stages are not in a diagnosable terminal state");
    }

    // 3. Gather evidence from events
    const evRows = await this.withPg(async (pg) => {
      const r = await pg.query<any>(
        "SELECT event_type, payload FROM engineering_run_events WHERE run_id=$1 " +
        "AND (event_type LIKE $2 OR event_type LIKE $3) ORDER BY created_at ASC",
        [runId, "engineering_build.%", "engineering_test.%"]);
      return r.rows;
    });

    const prefix = sourceStage === "BUILD" ? "engineering_build." : "engineering_test.";
    let exitCode: number | null = null;
    let command: string | null = null;
    let reason: string | null = null;
    let stderrExcerpt: string | null = null;
    const eventTypes: string[] = [];

    for (const row of evRows) {
      eventTypes.push(row.event_type);
      if (!row.event_type.startsWith(prefix)) continue;
      try {
        const payload = JSON.parse(row.payload ?? "{}");
        if (typeof payload.exitCode === "number") exitCode = payload.exitCode;
        if (typeof payload.command === "string") command = payload.command;
        if (typeof payload.error === "string") stderrExcerpt = payload.error;
        if (typeof payload.reason === "string") reason = payload.reason;
        if (typeof payload.exit_code === "number" && exitCode === null) exitCode = payload.exit_code;
      } catch { /* malformed event payload is not evidence */ }
    }

    await this.appendEvent(runId, stageId, "engineering_diagnosis.evidence_collected", {
      sourceStage, sourceJobId, sourceStatus,
      exitCode, eventCount: eventTypes.length,
    });

    // 4. Classify from evidence
    const cls = this.classify(sourceStage!, reason, stderrExcerpt, exitCode);

    await this.appendEvent(runId, stageId, "engineering_diagnosis.classified", {
      classification: cls.classification,
      confidence: cls.confidence,
      repairTarget: cls.repairTarget,
    });

    // 5. Build the diagnostic artifact
    const diagnosisId = "diag-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    const evidence: DiagnosisEvidence = {
      sourceStage,
      sourceJobId,
      sourceStatus,
      exitCode,
      command,
      reason,
      stderrExcerpt: stderrExcerpt ? sanitize(stderrExcerpt) : null,
      sourceArtifactRefs: [],
      eventTypes,
    };

    const artifactContent = JSON.stringify({
      schemaVersion: 1,
      diagnosisId,
      runId,
      stage: "DIAGNOSIS",
      sourceStage,
      sourceJobId,
      classification: cls.classification,
      confidence: cls.confidence,
      rootCause: cls.rootCause,
      repairTarget: cls.repairTarget,
      evidence,
      capturedAt: new Date().toISOString(),
    }, null, 2);

    let artifactRef: string | null = null;
    try {
      const record = await this.deps.artifacts.registerArtifactAsync(
        {
          artifactId: "art-diagnosis-" + diagnosisId,
          jobId: runId,
          name: "diagnosis-" + diagnosisId + ".json",
          type: "ENGINEERING_DIAGNOSIS",
          metadata: {
            diagnosisId, runId, sourceStage,
            classification: cls.classification,
            confidence: cls.confidence,
          },
          createdAt: Date.now(),
        } as any,
        artifactContent,
      );
      artifactRef = "artifact://" + record.artifactId;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.appendEvent(runId, stageId, "engineering_diagnosis.failed", {
        reason: "ARTIFACT_REGISTRATION_FAILED", detail: msg,
      });
      return {
        status: "FAILED", reason: "ARTIFACT_REGISTRATION_FAILED",
        diagnosisId, classification: cls.classification,
        rootCause: cls.rootCause, confidence: cls.confidence,
        evidence, repairTarget: cls.repairTarget, artifactRef: null,
      };
    }

    await this.appendEvent(runId, stageId, "engineering_diagnosis.completed", {
      diagnosisId, classification: cls.classification,
      confidence: cls.confidence, artifactRef,
    });

    return {
      status: "SUCCEEDED",
      reason: "DIAGNOSIS_COMPLETED",
      diagnosisId,
      classification: cls.classification,
      rootCause: cls.rootCause,
      confidence: cls.confidence,
      evidence,
      repairTarget: cls.repairTarget,
      artifactRef,
    };
  }


  private classify(
    sourceStage: "BUILD" | "TEST",
    reason: string | null,
    stderr: string | null,
    exitCode: number | null,
  ): {
    classification: DiagnosisClassification;
    confidence: DiagnosisConfidence;
    rootCause: string;
    repairTarget: DiagnosisRepairTarget | null;
  } {
    const hay = ((stderr ?? "") + " " + (reason ?? "")).toLowerCase();
    const has = (re: RegExp) => re.test(hay);

    // Common across both stages
    if (has(/enotfound|getaddrinfo|econnrefused|econnreset|etimedout|network/)) {
      return {
        classification: "NETWORK_FAILURE",
        confidence: "MEDIUM",
        rootCause: "Network resolution or connection failure detected in stderr/reason",
        repairTarget: { type: "NETWORK", path: null, description: "Network / connectivity configuration" },
      };
    }
    if (has(/eacces|permission denied|access is denied/)) {
      return {
        classification: "PERMISSION_FAILURE",
        confidence: "MEDIUM",
        rootCause: "Permission denied in stderr/reason",
        repairTarget: { type: "PERMISSIONS", path: null, description: "File or process permission" },
      };
    }
    if (has(/timed? ?out|timeout|etimedout/)) {
      return {
        classification: "TIMEOUT",
        confidence: "MEDIUM",
        rootCause: "Command or operation timed out",
        repairTarget: { type: "TIMEOUT", path: null, description: "Command timeout / performance" },
      };
    }
    if (has(/module_not_found|cannot find module|module not found|no such file or directory.*node_modules/)) {
      return {
        classification: "DEPENDENCY_FAILURE",
        confidence: "HIGH",
        rootCause: "A required module or dependency could not be resolved",
        repairTarget: { type: "DEPENDENCY_MANIFEST", path: "package.json", description: "Missing or unresolved dependency" },
      };
    }
    if (has(/command not found|is not recognized|enoent.*command/)) {
      return {
        classification: "COMMAND_NOT_FOUND",
        confidence: "MEDIUM",
        rootCause: "A required command was not found on the execution host",
        repairTarget: { type: "ENVIRONMENT", path: null, description: "Missing command / toolchain" },
      };
    }

    // Stage-specific fallbacks
    if (sourceStage === "BUILD") {
      if (has(/error ts\d+|typescript|type .* is not assignable/)) {
        return {
          classification: "TYPE_ERROR",
          confidence: "HIGH",
          rootCause: "TypeScript compiler reported a type error",
          repairTarget: { type: "SOURCE_FILE", path: null, description: "Type error in source" },
        };
      }
      if (has(/syntaxerror|unexpected token|parse error/)) {
        return {
          classification: "COMPILATION_FAILURE",
          confidence: "HIGH",
          rootCause: "Build encountered a compilation / syntax failure",
          repairTarget: { type: "SOURCE_FILE", path: null, description: "Compilation failure" },
        };
      }
      if (has(/configuration|config error|invalid config/)) {
        return {
          classification: "CONFIGURATION_FAILURE",
          confidence: "MEDIUM",
          rootCause: "Build configuration is invalid",
          repairTarget: { type: "CONFIG_FILE", path: null, description: "Build configuration" },
        };
      }
      return {
        classification: "BUILD_FAILURE",
        confidence: exitCode !== null ? "MEDIUM" : "LOW",
        rootCause: "BUILD exited non-zero; specific class not determinable from available evidence",
        repairTarget: { type: "BUILD_OUTPUT", path: null, description: "Build output" },
      };
    }

    // sourceStage === "TEST"
    if (has(/assertionerror|assert\.|expected .* received|expect\(/)) {
      return {
        classification: "TEST_ASSERTION_FAILURE",
        confidence: "HIGH",
        rootCause: "A test assertion failed",
        repairTarget: { type: "SOURCE_FILE", path: null, description: "Test / application code asserting incorrectly" },
      };
    }
    if (has(/configuration|config error|invalid config/)) {
      return {
        classification: "CONFIGURATION_FAILURE",
        confidence: "MEDIUM",
        rootCause: "Test configuration is invalid",
        repairTarget: { type: "CONFIG_FILE", path: null, description: "Test configuration" },
      };
    }
    return {
      classification: "TEST_RUNTIME_FAILURE",
      confidence: exitCode !== null ? "MEDIUM" : "LOW",
      rootCause: "TEST exited non-zero; specific class not determinable from available evidence",
      repairTarget: { type: "TEST_OUTPUT", path: null, description: "Test runtime output" },
    };
  }
}
