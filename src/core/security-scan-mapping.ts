import type {
  SecurityExecution,
  SecurityEvidence,
  SecurityFinding,
  SecurityScannerCategory,
  SecurityEvidenceStatus,
  FindingSeverity,
} from "./types";
import type { ScannerScanResult } from "./security-scanners";

/**
 * Supports both existing scanner-adapter findings and canonical
 * partial findings extracted by the central security runner.
 */
type LegacyScannerFinding = ScannerScanResult["findings"][number];

export type ScannerMappingFinding =
  | Partial<SecurityFinding>
  | LegacyScannerFinding;

export interface ScannerMappingResult {
  kind: SecurityScannerCategory;
  scanner: string;
  status: unknown;
  findings: ScannerMappingFinding[];
  blocked_reason?: string | null;
  duration_ms?: number;
}

function isLegacyScannerFinding(
  finding: ScannerMappingFinding,
): finding is LegacyScannerFinding {
  return "id" in finding;
}

/**
 * Unknown severity remains UNKNOWN. It must never silently become LOW.
 */
function toFindingSeverity(s: unknown): FindingSeverity {
  const lower = String(s ?? "").toLowerCase().trim();

  if (lower === "critical") return "CRITICAL";
  if (lower === "high") return "HIGH";
  if (lower === "medium" || lower === "moderate") return "MEDIUM";
  if (lower === "low" || lower === "info") return "LOW";

  return "UNKNOWN";
}

/**
 * Unknown and missing scanner statuses fail closed.
 */
function toEvidenceStatus(s: unknown): SecurityEvidenceStatus {
  if (s === "PASSED") return "PASS";
  if (s === "FAILED") return "FAIL";
  return "BLOCKED";
}

export interface BuildExecutionInput {
  projectId: string;
  executionId: string;
  commitSha: string;
  artifactDigest?: string;
  releaseId?: string;
  environment: string;
}

export interface BuildExecutionValidationError extends Error {
  code:
    | "MISSING_PROJECT_ID"
    | "MISSING_EXECUTION_ID"
    | "MISSING_COMMIT_SHA"
    | "MISSING_ENVIRONMENT";
}

function assertBuildExecutionInput(input: BuildExecutionInput): void {
  const err = (
    code: BuildExecutionValidationError["code"],
    msg: string,
  ): never => {
    const error = new Error(msg) as BuildExecutionValidationError;
    error.code = code;
    throw error;
  };

  if (!input || typeof input !== "object") {
    err("MISSING_PROJECT_ID", "BuildExecutionInput required");
  }

  if (typeof input.projectId !== "string" || input.projectId.length === 0) {
    err("MISSING_PROJECT_ID", "projectId is required");
  }

  if (typeof input.executionId !== "string" || input.executionId.length === 0) {
    err("MISSING_EXECUTION_ID", "executionId is required");
  }

  if (typeof input.commitSha !== "string" || input.commitSha.length === 0) {
    err("MISSING_COMMIT_SHA", "commitSha is required");
  }

  if (typeof input.environment !== "string" || input.environment.length === 0) {
    err("MISSING_ENVIRONMENT", "environment is required");
  }
}

export function buildExecution(
  input: BuildExecutionInput,
): SecurityExecution {
  assertBuildExecutionInput(input);

  return {
    id: "secexec_" + input.executionId,
    project_id: input.projectId,
    execution_id: input.executionId,
    commit_sha: input.commitSha,
    artifact_digest: input.artifactDigest,
    release_id: input.releaseId,
    status: "RUNNING",
    started_at: new Date().toISOString(),
  };
}

export function buildEvidenceList(
  results: ScannerMappingResult[],
  input: BuildExecutionInput,
): SecurityEvidence[] {
  assertBuildExecutionInput(input);

  return results.map((result, index) => {
    const scannerName =
      typeof result.scanner === "string" ? result.scanner.trim() : "";

    const hasScanner = scannerName.length > 0;
    const status = hasScanner
      ? toEvidenceStatus(result.status)
      : "BLOCKED";

    const now = new Date().toISOString();

    return {
      id: "secev_" + input.executionId + "_" + index,
      project_id: input.projectId,
      execution_id: input.executionId,
      release_id: input.releaseId,
      commit_sha: input.commitSha,
      artifact_digest: input.artifactDigest,
      environment: input.environment,
      scanner: hasScanner ? scannerName : "unknown_scanner",
      category: result.kind,
      status,
      started_at: now,
      duration_ms:
        typeof result.duration_ms === "number" &&
        Number.isFinite(result.duration_ms)
          ? Math.max(0, result.duration_ms)
          : 0,
      created_at: now,
    };
  });
}

export function buildFindingList(
  results: ScannerMappingResult[],
  evidenceList: SecurityEvidence[],
  input: BuildExecutionInput,
): SecurityFinding[] {
  assertBuildExecutionInput(input);

  const output: SecurityFinding[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const evidence = evidenceList[i];

    if (!evidence) continue;

    const rawFindings = Array.isArray(result.findings)
      ? result.findings
      : [];

    for (let j = 0; j < rawFindings.length; j++) {
      const finding = rawFindings[j];
      const legacy = isLegacyScannerFinding(finding);

      const scanner = finding.scanner || result.scanner;
      const category = finding.category || result.kind;
      const title =
        typeof finding.title === "string" && finding.title.trim()
          ? finding.title.trim()
          : "Unclassified security finding";

      const fingerprint =
        typeof finding.fingerprint === "string" &&
        finding.fingerprint.trim()
          ? finding.fingerprint
          : [
              scanner,
              category,
              title,
              finding.file ?? "",
              finding.line ?? "",
            ].join(":");

      const findingId = legacy
        ? finding.id
        : finding.finding_id || `secfind_${fingerprint}`;

      const now = new Date().toISOString();

      output.push({
        finding_id: findingId,
        evidence_id: evidence.id,
        project_id: input.projectId,
        execution_id: input.executionId,
        release_id: input.releaseId,
        artifact_digest: input.artifactDigest,
        scanner,
        category,
        severity: toFindingSeverity(finding.severity),
        title,
        description: finding.description,
        fingerprint,
        file: finding.file ?? undefined,
        line: finding.line ?? undefined,
        column: legacy ? undefined : finding.column,
        package: legacy ? undefined : finding.package,
        dependency: legacy ? undefined : finding.dependency,
        version: legacy ? undefined : finding.version,
        fixed_version: legacy ? undefined : finding.fixed_version,
        cve: legacy ? undefined : finding.cve,
        cwe: legacy ? undefined : finding.cwe,
        resource: finding.resource ?? undefined,
        location: legacy ? undefined : finding.location,
        target: legacy ? undefined : finding.target,
        evidence_reference: legacy ? undefined : finding.evidence_reference,
        first_seen: now,
        last_seen: now,
        status: "NEW",
        created_at: now,
        updated_at: now,
      });
    }
  }

  return output;
}

export function mapScannerResultsToPolicyFindings(
  results: ScannerMappingResult[],
): Array<{
  severity: string;
  category: string;
  scanner: string;
  title: string;
}> {
  return results.flatMap((result) => {
    const rawFindings = Array.isArray(result.findings)
      ? result.findings
      : [];

    return rawFindings.map((finding) => ({
      severity: String(finding.severity ?? "unknown").toLowerCase(),
      category: finding.category ?? result.kind,
      scanner: finding.scanner || result.scanner,
      title: finding.title || "Unclassified security finding",
    }));
  });
}

