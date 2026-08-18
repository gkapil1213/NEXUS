/**
 * NEXUS Phase 3 — domain model.
 *
 * Every type here is backed by real execution: stages produce real evidence,
 * artifacts carry real SHA-256 digests, and capabilities that cannot run in
 * this environment are reported as honest BLOCKED results rather than fakes.
 */

/* ------------------------------ State machine ------------------------------ */

export type RequestState =
  | "RECEIVED"
  | "PLANNING"
  | "READY_TO_BUILD"
  | "BUILDING"
  | "TESTING"
  | "SECURITY_REVIEW"
  | "DOCKER_BUILD"
  | "IMAGE_SCAN"
  | "SBOM"
  | "ARTIFACT"
  | "READY_FOR_DEPLOYMENT"
  | "DEPLOYED"
  | "FAILED"
  | "CANCELLED";

export type StageName =
  | "PLANNING"
  | "READY_TO_BUILD_GATE"
  | "BUILDING"
  | "TESTING"
  | "SECURITY_REVIEW"
  | "DOCKER_BUILD"
  | "IMAGE_SCAN"
  | "SBOM"
  | "ARTIFACT"
  | "DEPLOYMENT_GATE"
  | "DEPLOYMENT";

export type StageStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "BLOCKED" | "SKIPPED";

export type RunStatus = "RUNNING" | "COMPLETED" | "BLOCKED" | "FAILED" | "CANCELLED";

/** The single source of truth for legal request-state transitions. Enforced on
 *  every move — an illegal move throws and is recorded, never silently applied. */
export const TRANSITIONS: Record<RequestState, readonly RequestState[]> = {
  RECEIVED: ["PLANNING", "CANCELLED"],
  PLANNING: ["READY_TO_BUILD", "FAILED", "CANCELLED"],
  READY_TO_BUILD: ["BUILDING", "FAILED", "CANCELLED"],
  BUILDING: ["TESTING", "FAILED", "CANCELLED"],
  TESTING: ["SECURITY_REVIEW", "FAILED", "CANCELLED"],
  SECURITY_REVIEW: ["DOCKER_BUILD", "FAILED", "CANCELLED"],
  DOCKER_BUILD: ["IMAGE_SCAN", "FAILED", "CANCELLED"],
  IMAGE_SCAN: ["SBOM", "FAILED", "CANCELLED"],
  SBOM: ["ARTIFACT", "FAILED", "CANCELLED"],
  ARTIFACT: ["READY_FOR_DEPLOYMENT", "FAILED", "CANCELLED"],
  READY_FOR_DEPLOYMENT: ["DEPLOYED", "FAILED", "CANCELLED"],
  DEPLOYED: [],
  FAILED: [
    "PLANNING",
    "READY_TO_BUILD",
    "BUILDING",
    "TESTING",
    "SECURITY_REVIEW",
    "DOCKER_BUILD",
    "IMAGE_SCAN",
    "SBOM",
    "ARTIFACT",
    "READY_FOR_DEPLOYMENT",
    "CANCELLED",
  ],
  CANCELLED: [],
};

export const STAGE_ORDER: readonly StageName[] = [
  "PLANNING",
  "READY_TO_BUILD_GATE",
  "BUILDING",
  "TESTING",
  "SECURITY_REVIEW",
  "DOCKER_BUILD",
  "IMAGE_SCAN",
  "SBOM",
  "ARTIFACT",
  "DEPLOYMENT_GATE",
  "DEPLOYMENT",
];

/* ------------------------------- Detection -------------------------------- */

export interface DetectedDependency {
  name: string;
  version: string;
  dev: boolean;
}

/** Real project-detection result. Null = no evidence, never a guess. */
export interface DetectionProfile {
  language: string | null;
  framework: string | null;
  runtime: string | null;
  package_manager: string | null;
  build_command: string | null;
  test_command: string | null;
  entrypoint: string | null;
  has_dockerfile: boolean;
  has_compose: boolean;
  dependencies: DetectedDependency[];
  /** Files that grounded the conclusions above. */
  evidence: string[];
  detected_at: number;
}

/* --------------------------------- Records -------------------------------- */

export interface EngineeringRequest {
  id: string;
  org: string;
  project: string;
  prompt: string;
  state: RequestState;
  /** Files that form the real, in-browser workspace this request builds. */
  workspace: Record<string, string>;
  attempt: number;
  error: { code: string; message: string } | null;
  resume_state: RequestState | null;
  created_at: number;
  updated_at: number;
}

export interface OrchestrationRun {
  id: string;
  correlation_id: string;
  request_id: string;
  org: string;
  status: RunStatus;
  current_stage: StageName | null;
  halted_at_stage: StageName | null;
  attempt: number;
  error: { code: string; message: string } | null;
  blocked_reason: string | null;
  started_at: number;
  updated_at: number; // liveness heartbeat
  finished_at: number | null;
  started_by: string;
}

export interface StageRecord {
  id: string;
  run_id: string;
  request_id: string;
  attempt: number;
  correlation_id: string;
  stage: StageName;
  status: StageStatus;
  started_at: number | null;
  finished_at: number | null;
  duration_ms: number | null;
  evidence: Record<string, unknown>;
  error: string | null;
  blocked_reason: string | null;
}

export interface TransitionRecord {
  id: string;
  run_id: string;
  request_id: string;
  correlation_id: string;
  from_state: RequestState;
  to_state: RequestState;
  stage: StageName | null;
  reason: string | null;
  seq: number;
  created_at: number;
}

export interface BuildRecord {
  id: string;
  run_id: string;
  request_id: string;
  command: string;
  exit_code: number;
  duration_ms: number;
  stdout: string;
  stderr: string;
  artifacts: string[];
  status: "SUCCEEDED" | "FAILED" | "BLOCKED";
}

export type ArtifactType =
  | "detection"
  | "build_package"
  | "test_report"
  | "security_report"
  | "sbom"
  | "dockerfile"
  | "docker_image"
  | "log";

export interface ArtifactRecord {
  id: string;
  org: string;
  run_id: string;
  request_id: string;
  correlation_id: string;
  type: ArtifactType;
  name: string;
  digest: string; // real sha256:<hex>
  size: number;
  location: string; // ws://<request>/<path>
  created_at: number;
}

export interface ApprovalRecord {
  id: string;
  org: string;
  request_id: string;
  run_id: string;
  subject: string;
  policy: string;
  risk: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  decision: "PENDING" | "HUMAN_APPROVED" | "AUTO_REJECTED";
  decided_by: string | null;
  created_at: number;
  decided_at: number | null;
}

export interface DeploymentEvent {
  at: number;
  event: string;
  detail: string;
}

export interface DeploymentRecord {
  id: string;
  org: string;
  request_id: string;
  run_id: string;
  environment: "STAGING" | "PRODUCTION";
  status: "BLOCKED" | "DEPLOYED" | "ROLLED_BACK" | "FAILED";
  reason: string | null;
  events: DeploymentEvent[];
  created_at: number;
}

export interface RollbackRecord {
  id: string;
  org: string;
  request_id: string;
  run_id: string;
  from_artifact: string;
  to_artifact: string;
  status: "ROLLED_BACK" | "BLOCKED";
  reason: string | null;
  created_at: number;
}

/* ----------------------------- Test / security ---------------------------- */

export interface TestResult {
  suite: string;
  total: number;
  passed: number;
  failed: number;
  duration_ms: number;
  failures: string[];
  exit_code: number;
  status: "PASSED" | "FAILED" | "BLOCKED";
}

export type SecuritySeverity = "critical" | "high" | "medium" | "low" | "info";

export interface SecurityFinding {
  severity: SecuritySeverity;
  rule: string;
  detail: string;
  file: string | null;
}

export interface SecurityResult {
  scanner: string;
  outcome: "PASSED" | "FAILED" | "BLOCKED";
  findings: SecurityFinding[];
  scanned_files: number;
  blocked_reason: string | null;
  duration_ms: number;
}

export interface SbomResult {
  format: "CycloneDX";
  spec: string;
  components: number;
  digest: string;
  location: string;
}

/* --------------------------------- Errors --------------------------------- */

export class NexusError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "NexusError";
    this.code = code;
  }
}

/** Internal signal that a stage halted (failed or blocked). Never leaks out as
 *  a generic "orchestration error". */
export class StageHalt extends Error {
  kind: "failed" | "blocked";
  constructor(kind: "failed" | "blocked", message: string) {
    super(message);
    this.name = "StageHalt";
    this.kind = kind;
  }
}
