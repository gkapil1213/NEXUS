/**
 * NEXUS Phase 1 — domain type system.
 *
 * Strong, discriminated types for the whole platform foundation. No `any`:
 * unknown external data enters only through validators (see security.ts).
 */



export type Id = string;

/* --------------------------------- Errors --------------------------------- */

export type ErrorCategory =
  | "validation"
  | "auth"
  | "authorization"
  | "not_found"
  | "conflict"
  | "persistence"
  | "startup"
  | "runtime"
  | "security";

export interface SystemError {
  code: string;
  message: string;
  category: ErrorCategory;
  recoverable: boolean;
  details?: Record<string, unknown>;
  timestamp: number;
}

/* -------------------------------- Security -------------------------------- */

export const ROLES = ["OWNER", "ADMIN", "OPERATOR", "DEVELOPER", "ENGINEER", "VIEWER"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "project:create",
  "project:read",
  "project:update",
  "project:archive",
  "execution:create",
  "execution:read",
  "execution:cancel",
  "execution:retry",
  "agent:register",
  "agent:read",
  "agent:execute",
  "agent:configure",
  "artifact:read",
  "artifact:create",
  "workspace:create",
  "workspace:read",
  "workspace:delete",
  "secret:reference",
  "secret:manage",
  "approval:request",
  "approval:decide",
  "event:read",
  "audit:read",
  "evidence:read",
  "config:read",
  "system:health",
  "system:configure",
  "github:connect",
  "evidence:read",
  "security:manage",
  "config:read",
  "github:read",
  "github:push",
  // Phase 3 Pass 3 — CI/CD + Git provider foundation. Provider-specific read/
  // write (github:read/github:push) are reused where applicable; these are the
  // provider-agnostic pipeline/git/change-request capabilities.
  "pipeline:create",
  "pipeline:read",
  "pipeline:execute",
  "git:read",
  "git:write",
  "change-request:create",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Identity lifecycle: ACTIVE → SUSPENDED / DISABLED. Non-active identities
 *  cannot authenticate or pass any authorization check. */
export type IdentityStatus = "active" | "suspended" | "disabled";

export interface User {
  id: Id;
  email: string;
  name: string;
  role: Role;
  status: IdentityStatus;
  password_hash: string; // PBKDF2 — plaintext never persisted
  salt: string;
  iterations: number;
  created_at: number;
  updated_at: number; // Phase 2 — last identity change (status/role)
}

/** Public view of a user — never includes credential material. */
export interface PublicUser {
  id: Id;
  email: string;
  name: string;
  role: Role;
  status: IdentityStatus;
  created_at: number;
  updated_at: number;
}

export interface Session {
  token: string;
  user_id: Id;
  created_at: number;
  expires_at: number;
  revoked: boolean;
}

/** A pointer to a secret — never the value. */
export interface SecretReference {
  id: Id;
  name: string;
  provider: "local" | "vault" | "aws" | "gcp" | "azure";
  path: string;
  created_at: number;
}

/* --------------------------------- Project -------------------------------- */

export type ProjectStatus = "ACTIVE" | "PAUSED" | "ARCHIVED";

export interface Project {
  id: Id;
  name: string;
  description: string;
  status: ProjectStatus;
  repository: string;
  default_branch: string;
  created_at: number;
  updated_at: number;
}

/* -------------------------------- Execution ------------------------------- */

export type ExecutionStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";

export interface Execution {
  id: Id;
  project_id: Id;
  request: string;
  status: ExecutionStatus;
  started_at: number;
  completed_at: number | null;
  created_by: Id;
  error: SystemError | null;
  metadata: Record<string, unknown>;
}

export interface Task {
  id: Id;
  execution_id: Id;
  label: string;
  status: "PENDING" | "RUNNING" | "DONE" | "FAILED";
  created_at: number;
}

/* ---------------------------------- Agents -------------------------------- */

/**
 * Phase 2 Pass 2 — the centralized capability model. Deliberately narrow:
 * read/inspect/analyze/generate only. There is NO shell, command, filesystem
 * or deployment capability — arbitrary execution is out of scope by design.
 */
export const AGENT_CAPABILITIES = [
  "inspect",
  "analyze",
  "plan",
  "read_project",
  "read_execution",
  "run_test",
  "generate_artifact",
  // Phase 3 Pass 1 — DevOps build pipeline capabilities
  "build",
  "detect_project",
  "generate_sbom",
] as const;
export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

/* ------------------------- Pass 2 — risk & policy -------------------------- */

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type OperationType =
  | "PROJECT_INSPECT"
  | "PROJECT_ANALYZE"
  | "EXECUTION_INSPECT"
  | "TEST_RUN"
  | "ARTIFACT_GENERATE";

/** Canonical mapping for every operation. An operation with no mapping can
 *  never execute — the policy engine fails closed on unknown operations. */
export interface OperationSpec {
  operation: OperationType;
  capability: AgentCapability;
  permission: Permission;
  risk: RiskLevel;
}

export type AgentExecutionStatus =
  | "QUEUED"
  | "AUTHORIZED"
  | "BLOCKED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED";

/** Persisted record of one policy-gated agent execution. */
export interface AgentExecutionRecord {
  id: Id;
  execution_id: Id;
  agent_id: Id;
  operation: OperationType;
  identity_id: Id;
  project_id: Id;
  risk: RiskLevel;
  decision: PolicyVerdict;
  status: AgentExecutionStatus;
  started_at: number;
  completed_at: number | null;
  result_summary: string;
  error: SystemError | null;
}

export interface AgentDefinition {
  id: Id;
  name: string;
  description: string;
  version: string;
  capabilities: AgentCapability[];
  /** Phase 2 — declared risk of the operations this agent performs. */
  risk_level?: "LOW" | "MEDIUM" | "HIGH";
  /** Phase 2 — permissions the invoking identity must hold for this agent
   *  to be allowed to run. Agents never inherit permissions from requests. */
  required_permissions?: Permission[];
}

export interface AgentContext {
  execution_id: Id;
  project_id: Id;
  request: string;
  permissions: Permission[];
  configuration: Record<string, unknown>; // safe values only — never secrets
  evidence_refs: Id[];
  secret_refs: SecretReference[]; // references only; values never enter context
  /** Pass 3 — workspace boundary. Present only when the execution was granted
   *  a workspace. Never a host path, never another execution's workspace. */
  workspace_id?: Id;
  workspace_reference?: string; // "ws://<id>" — logical reference, not a host path
  allowed_root?: string; // normalized root the file policy confines ops to
  authorized_file_operations?: FileOp[];
}

/** Discriminated outcome of an agent run. */
export type AgentOutcome =
  | { status: "completed"; summary: string; artifacts: ArtifactInput[]; evidence: EvidenceInput[] }
  | { status: "failed"; summary: string; error: SystemError };

export interface AgentRun {
  id: Id;
  execution_id: Id;
  agent_id: Id;
  started_at: number;
  completed_at: number | null;
  status: "RUNNING" | "SUCCEEDED" | "FAILED";
  outcome_summary: string;
  error: SystemError | null;
}

/* ---------------------------------- Events -------------------------------- */

export type NexusEventType =
  | "execution.created"
  | "execution.started"
  | "execution.completed"
  | "execution.failed"
  | "execution.cancelled"
  | "agent.started"
  | "agent.completed"
  | "agent.failed"
  | "decision.created"
  | "evidence.created"
  | "project.created"
  | "project.updated"
  | "project.archived"
  // Phase 2 — security & isolation events (append-only, ordered like all others)
  | "session.refreshed"
  | "authorization.granted"
  | "authorization.denied"
  | "secret.requested"
  | "secret.denied"
  | "workspace.created"
  | "workspace.destroyed"
  | "command.blocked"
  | "network.blocked"
  | "approval.requested"
  | "approval.decided"
  // Phase 2 Pass 3 — workspace & sandbox isolation events (append-only)
  | "workspace.activated"
  | "workspace.access.denied"
  | "workspace.file.read"
  | "workspace.file.write"
  | "workspace.path.blocked"
  | "workspace.expired"
  | "workspace.cleanup.started"
  | "workspace.cleanup.completed"
  | "workspace.cleanup.failed"
  // Phase 3 Pass 1 — DevOps pipeline events (append-only, strictly ordered)
  | "devops.pipeline.started"
  | "devops.pipeline.completed"
  | "devops.pipeline.failed"
  | "devops.pipeline.blocked"
  | "devops.detect.started"
  | "devops.detect.completed"
  | "devops.build.started"
  | "devops.build.completed"
  | "devops.test.started"
  | "devops.test.completed"
  | "devops.security.started"
  | "devops.security.completed"
  | "devops.sbom.started"
  | "devops.sbom.completed"
  | "devops.artifact.started"
  | "devops.artifact.completed"
  // Phase 3 Pass 2 — container pipeline events (append-only, strictly ordered)
  | "docker.detect.started"
  | "docker.detect.completed"
  | "dockerfile.generate.started"
  | "dockerfile.generate.completed"
  | "dockerfile.validation.started"
  | "dockerfile.validation.completed"
  | "docker.build.started"
  | "docker.build.completed"
  | "docker.image.inspect.started"
  | "docker.image.inspect.completed"
  | "docker.scan.started"
  | "docker.scan.completed"
  | "sbom.started"
  | "sbom.completed"
  | "artifact.register.started"
  | "artifact.register.completed"
  // Phase 3 Pass 3 — CI/CD + Git provider events (append-only, strictly ordered)
  | "pipeline.plan.created"
  | "pipeline.generation.started"
  | "pipeline.generation.completed"
  | "pipeline.validation.started"
  | "pipeline.validation.completed"
  | "git.provider.requested"
  | "git.provider.completed"
  | "git.provider.blocked"
  | "git.branch.created"
  | "git.commit.created"
  | "change.request.created"
  | "change.request.updated"
  | "pipeline.submitted"
  | "pipeline.started"
  | "pipeline.completed"
  | "pipeline.failed"
  | "pipeline.blocked";

export interface NexusEvent {
  id: Id;
  seq: number; // strictly increasing — append-only ordering guarantee
  execution_id: Id | null;
  type: NexusEventType;
  timestamp: number;
  source: string;
  payload: Record<string, unknown>;
}

/* ---------------------------------- Audit --------------------------------- */

export type AuditResult = "allow" | "deny" | "error" | "info";

export interface AuditRecord {
  id: Id;
  timestamp: number;
  actor: string; // user id or email; "system" for platform actions
  action: string;
  resource_type: string;
  resource_id: string;
  result: AuditResult;
  metadata: Record<string, unknown>; // always secret-redacted before storage
}

/* --------------------------------- Evidence ------------------------------- */

/** Where a piece of evidence came from — categories must never be mixed. */
export type EvidenceSource = "REAL_EXECUTION" | "STATIC_ANALYSIS" | "ENVIRONMENT_BLOCK";

export type EvidenceType = "hash" | "log" | "report" | "metric" | "file";

export interface EvidenceInput {
  type: EvidenceType;
  source: EvidenceSource;
  content: string; // raw content — hashed + stored at record time
  metadata?: Record<string, unknown>;
}

export interface Evidence {
  id: Id;
  execution_id: Id;
  type: EvidenceType;
  source: EvidenceSource;
  content_reference: string; // "evidence://<id>"
  timestamp: number;
  hash: string; // real sha256:<hex> of the content
  metadata: Record<string, unknown>;
}

/* --------------------------------- Artifacts ------------------------------ */

export interface ArtifactInput {
  kind: string;
  name: string;
  content: string; // real bytes/content — digested at record time
}

export interface ArtifactReference {
  id: Id;
  execution_id: Id;
  kind: string;
  name: string;
  digest: string; // real sha256:<hex>
  size: number;
  location: string; // "artifact://<id>"
  created_at: number;
}

/* -------------------------------- Decisions ------------------------------- */

export interface Decision {
  id: Id;
  execution_id: Id;
  type: string;
  options: string[];
  chosen: string;
  rationale: string;
  made_by: string;
  timestamp: number;
}

/* ---------------------------------- Health -------------------------------- */

export type SubsystemStatus = "healthy" | "degraded" | "blocked";

export interface SubsystemHealth {
  name: string;
  status: SubsystemStatus;
  detail: string;
  latency_ms: number | null;
}

export interface HealthReport {
  status: SubsystemStatus;
  subsystems: SubsystemHealth[];
  version: string;
  engine: string;
  timestamp: number;
}

/* ------------------------------ Kernel boot ------------------------------- */

export type BootStepStatus = "pending" | "running" | "ok" | "fail";

export interface BootStep {
  id: string;
  label: string;
  status: BootStepStatus;
  detail: string | null;
}

/* --------------------------------- Results -------------------------------- */

/** Structured API result — consistent success/error envelope. */
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: SystemError };

/* --------------------------------- Testing -------------------------------- */

export type TestStatus = "PASSED" | "FAILED" | "BLOCKED" | "NOT_EXECUTED";

export interface TestResult {
  name: string;
  category: string;
  status: TestStatus;
  duration_ms: number;
  evidence: string | null;
  error: string | null;
  timestamp: number;
}

export interface SuiteReport {
  results: TestResult[];
  passed: number;
  failed: number;
  blocked: number;
  duration_ms: number;
  ran_at: number;
  engine: string;
}

/* ============================ Phase 2 — Security ============================ */

/* -------------------------------- Workspaces ------------------------------- */

/** Pass 3 — full workspace lifecycle. */
export type WorkspaceStatus = "CREATING" | "READY" | "ACTIVE" | "CLEANING" | "DESTROYED" | "FAILED";

/** File operations an agent is authorized to perform inside its workspace. */
export type FileOp = "read" | "write" | "list" | "exists";

/** Configurable resource limits enforced by the workspace layer. */
export interface WorkspaceLimits {
  max_file_bytes: number;
  max_total_bytes: number;
  max_file_count: number;
  max_output_bytes: number;
}

export interface WorkspaceRecord {
  id: Id;
  project_id: Id;
  execution_id: Id;
  owner_identity_id: Id; // Pass 3 — the identity the workspace was created for
  status: WorkspaceStatus;
  file_count: number;
  total_bytes: number;
  created_at: number;
  updated_at: number; // Pass 3 — last lifecycle/state change
  expires_at: number; // Pass 3 — TTL; expired workspaces cannot be activated
  destroyed_at: number | null;
}

export interface WorkspaceFileRecord {
  id: Id;
  workspace_id: Id;
  path: string; // normalized, traversal-free, workspace-relative
  content: string;
  size: number;
  created_at: number;
  updated_at: number;
}

/* --------------------------------- Approvals ------------------------------- */

export type ApprovalState = "PENDING" | "APPROVED" | "REJECTED";

export interface ApprovalRecord {
  id: Id;
  operation: string;
  description: string;
  risk: "MEDIUM" | "HIGH" | "DESTRUCTIVE";
  requester: string; // email
  approver: string | null;
  state: ApprovalState;
  reason: string | null;
  created_at: number;
  decided_at: number | null;
}

/* ------------------------------ Command safety ----------------------------- */

export type CommandKind = "READ_ONLY" | "SAFE_WRITE" | "RESTRICTED" | "DESTRUCTIVE";

export interface CommandClassification {
  command: string;
  kind: CommandKind;
  risk: "LOW" | "MEDIUM" | "HIGH" | "DESTRUCTIVE";
  description: string;
}

/* ----------------------------- Natural language ---------------------------- */

/** A structured operation parsed from natural language. Only catalog intents
 *  are recognized — unrecognized text never becomes an executable command. */
export interface OperationIntent {
  verb: string;
  operation: string; // catalog id, e.g. "inspect.project"
  label: string;
  capability: AgentCapability | null;
  permission: Permission;
  risk: "LOW" | "MEDIUM" | "HIGH" | "DESTRUCTIVE";
}

/* ------------------------------ Policy decisions --------------------------- */

export type PolicyVerdict = "ALLOWED" | "DENIED" | "BLOCKED" | "REQUIRES_APPROVAL";

export interface PolicyCheck {
  name: string;
  passed: boolean | null; // null = not applicable
  detail: string;
}

export interface PolicyDecision {
  verdict: PolicyVerdict;
  reason: string;
  checks: PolicyCheck[];
}

/** Full security preview of a requested operation — every check that ran. */
export interface SecurityPreviewResult {
  operation: string;
  actor: string;
  role: Role;
  agent_id: string | null;
  permission_required: Permission;
  risk: "LOW" | "MEDIUM" | "HIGH" | "DESTRUCTIVE";
  workspace: string;
  network_access: string;
  secret_access: string;
  decision: PolicyDecision;
  evaluated_at: number;
}

/* --------------------------------- Policies -------------------------------- */

export type NetworkMode = "DENY" | "ALLOWLIST";

export interface NetworkPolicy {
  mode: NetworkMode;
  allowlist: string[]; // origins
}

export interface ExecutionLimits {
  timeout_ms: number;
  max_output_bytes: number;
  max_file_bytes: number;
  max_files: number;
}

export interface ExecutionPolicy {
  allowed_agents: string[]; // agent ids; empty = deny all
  allowed_operations: string[]; // catalog operations; empty = deny all
  allowed_environments: string[];
  limits: ExecutionLimits;
  network: NetworkPolicy;
  destructive_requires_approval: boolean;
}

/* --------------------------------- Sandbox --------------------------------- */

export type SandboxKind = "browser" | "container" | "vm" | "remote-worker";

/** Pass 3 — explicit honesty marker. LOGICAL_BOUNDARY means path/policy
 *  confinement only; REAL_ISOLATION means OS/container/VM separation and must
 *  never be claimed unless that isolation actually executed. */
export type IsolationBoundary = "REAL_ISOLATION" | "LOGICAL_BOUNDARY";

export interface SandboxIsolationReport {
  kind: SandboxKind;
  available: boolean;
  boundary: IsolationBoundary;
  filesystem: string; // honest description of the boundary
  process: string;
  network: string;
  reason: string | null; // real blocker when unavailable
}

export interface SandboxCommandResult {
  command: string;
  classification: CommandKind;
  exit_code: number; // 0 ok · non-zero failure · 124 timeout
  stdout: string;
  stderr: string;
  duration_ms: number;
  timed_out: boolean;
}

/* ------------------------------- Pass 3 types ------------------------------ */

/** A structured, allow-listed sandbox operation. Anything else is refused. */
export type SandboxOperation =
  | { kind: "list" }
  | { kind: "read"; path: string }
  | { kind: "exists"; path: string }
  | { kind: "write"; path: string; content: string };

/**
 * Sandbox abstraction. The current runtime ships BrowserSandbox, which
 * provides a LOGICAL_BOUNDARY only. Container/VM/RemoteWorker implementations
 * may be added later; isolationReport() must always state the true boundary.
 */
export interface ExecutionSandbox {
  isolationReport(): SandboxIsolationReport;
  create(actor: SandboxActor, input: { project_id: Id; execution_id: Id; ttl_ms?: number }): Promise<WorkspaceRecord>;
  prepare(actor: SandboxActor, id: Id): Promise<WorkspaceRecord>;
  execute(actor: SandboxActor, id: Id, op: SandboxOperation): Promise<{ output: string; truncated: false }>;
  collectOutput(actor: SandboxActor, id: Id): Promise<string[]>;
  cleanup(actor: SandboxActor, id: Id): Promise<WorkspaceRecord>;
  destroy(actor: SandboxActor, id: Id): Promise<WorkspaceRecord>;
}

/** Minimal authenticated identity accepted by sandbox operations. */
export type SandboxActor = { id: Id; email: string; role: Role; status: IdentityStatus };

/* ============================ Phase 3 — DevOps ============================= */

/* ------------------------------ Artifact kinds ----------------------------- */

/** Canonical artifact types registered by the DevOps pipeline. */
export type ArtifactKind =
  | "BUILD_OUTPUT"
  | "TEST_REPORT"
  | "SECURITY_REPORT"
  | "SBOM"
  | "LOG"
  // Phase 3 Pass 2 — container artifacts
  | "DOCKER_IMAGE"
  | "IMAGE_DIGEST"
  | "SOURCE_SBOM"
  | "IMAGE_SBOM"
  | "DOCKERFILE"
  | "DOCKERFILE_SCAN"
  | "IMAGE_SCAN_REPORT"
  // Phase 3 Pass 3 — CI/CD artifacts
  | "PIPELINE_CONFIG"
  | "PIPELINE_VALIDATION_REPORT"
  | "CHANGE_REQUEST"
  | "PIPELINE_LOG"
  | "PIPELINE_RESULT"
  | "report"; // Phase 1 legacy kind kept for backward compatibility

/* ---------------------------- Project detection ---------------------------- */

export type DetectedLanguage = "node" | "python" | "typescript" | "unknown";

/** Result of ProjectDetector. Fields that could not be detected are null and
 *  confidence reflects how much real evidence grounded the detection. */
export interface DetectionResult {
  language: DetectedLanguage;
  framework: string | null; // "next" | "fastapi" | null
  runtime: string | null; // "node" | "python" | null
  package_manager: string | null; // "npm" | "pip" | null
  build_command: string | null;
  test_command: string | null;
  entrypoint: string | null;
  confidence: number; // 0..1
  dockerfile: boolean; // detection only — Docker is NOT built in this pass
  docker_compose: boolean;
  evidence: string[]; // the actual files that grounded the detection
}

/* -------------------------------- Build plan ------------------------------- */

/**
 * Structured build description. Commands are validated against an allowlist —
 * an LLM string is NEVER executed directly. working_directory is confined to
 * the workspace by the Phase 2 FileAccessPolicy.
 */
export interface BuildPlan {
  runtime: "node" | "python" | "none";
  package_manager: string | null;
  install_command: string | null;
  build_command: string | null;
  test_command: string | null;
  working_directory: string; // workspace-relative; validated, never absolute/host
}

export type BuildStatus = "SUCCEEDED" | "FAILED" | "BLOCKED";

export interface BuildResult {
  status: BuildStatus;
  command: string | null; // the allow-listed command actually run (null if blocked)
  duration_ms: number;
  artifacts: { name: string; content: string }[];
  logs: string;
  error: SystemError | null;
  blocked_reason: string | null; // set only when status === "BLOCKED"
}

/* ------------------------------ Pipeline model ----------------------------- */

export type PipelineStageName =
  | "DETECTING"
  | "BUILDING"
  | "TESTING"
  | "SECURITY_REVIEW"
  // Phase 3 Pass 2 — container stages (inserted between SECURITY and SBOM)
  | "DOCKERFILE_DETECTION"
  | "DOCKERFILE_VALIDATION"
  | "DOCKER_BUILD"
  | "IMAGE_INSPECTION"
  | "IMAGE_SECURITY_SCAN"
  | "SBOM_GENERATION"
  | "ARTIFACT_REGISTRATION";

export type PipelineStatus = PipelineStageName | "COMPLETED" | "FAILED" | "BLOCKED";

export type StageStatus = "RUNNING" | "SUCCEEDED" | "FAILED" | "BLOCKED";

/** One pipeline execution. attempt + correlation_id give retry identity. */
export interface PipelineRun {
  id: Id;
  project_id: Id;
  execution_id: Id;
  attempt: number;
  correlation_id: Id;
  status: PipelineStatus;
  current_stage: PipelineStageName | null;
  created_at: number;
  updated_at: number;
  error: SystemError | null;
  blocked_reason: string | null;
  docker: { dockerfile: boolean; compose: boolean; runtime: "BLOCKED" } | null;
}

/**
 * Exactly ONE logical stage record per (execution_id + stage + attempt).
 * A stage is finalized in place (RUNNING → terminal), never duplicated.
 */
export interface PipelineStage {
  id: Id;
  run_id: Id;
  execution_id: Id;
  stage: PipelineStageName;
  attempt: number;
  correlation_id: Id;
  status: StageStatus;
  started_at: number;
  completed_at: number | null;
  duration_ms: number | null;
  evidence_id: Id | null;
  command: string | null;
  logs_ref: string | null; // artifact reference for full logs
  error: SystemError | null;
  blocked_reason: string | null;
}

/* --------------------------------- SBOM ------------------------------------ */

export interface SbomComponent {
  name: string;
  version: string;
  ecosystem: string; // "npm" | "pypi"
  dev: boolean;
}

export interface SbomResult {
  status: "SUCCEEDED" | "BLOCKED";
  format: "CycloneDX" | null;
  components: SbomComponent[];
  digest: string | null; // real sha256 over the generated SBOM document
  blocked_reason: string | null;
}

/* ------------------------------- Security scan ----------------------------- */

export interface SecurityScanResult {
  status: "PASSED" | "FAILED" | "BLOCKED";
  findings: string[]; // real static findings (secrets / unsafe config)
  external_scanner: "BLOCKED"; // OSV / external feed is unavailable in-browser
  blocked_reason: string | null;
}

/* ========================= Phase 3 Pass 2 — Containers ===================== */

/* ---------------------------- Docker runtime ------------------------------ */

/** Honest runtime capability. This environment has no Docker daemon, so build
 *  and inspect are BLOCKED — never faked as available. */
export type DockerRuntimeStatus = "AVAILABLE" | "UNAVAILABLE" | "BLOCKED";

export interface DockerRuntimeInfo {
  status: DockerRuntimeStatus;
  cli: boolean;
  daemon: boolean;
  api: boolean;
  reason: string | null; // real blocker when not AVAILABLE
}

export interface DockerfileValidationFinding {
  rule: string;
  severity: "info" | "warn" | "fail";
  evidence: string; // the offending line / pattern
  location: string; // line number or instruction
  recommendation: string;
}

export type DockerfileVerdict = "PASS" | "WARN" | "FAIL" | "BLOCKED";

export interface DockerfileValidationResult {
  verdict: DockerfileVerdict;
  findings: DockerfileValidationFinding[];
}

export interface DockerfileSource {
  origin: "USE_EXISTING" | "GENERATED";
  content: string;
  path: string;
}

export interface ImageReference {
  repository: string; // "nexus/<project>"
  tag: string; // "<commit-sha>" or "<execution-id>" — never "latest"
  digest: string | null; // "sha256:..." — only set after a REAL build
  full: string; // repository:tag
}

export interface DockerBuildResult {
  status: "SUCCEEDED" | "FAILED" | "BLOCKED";
  image: ImageReference | null; // null unless a real build produced an image
  duration_ms: number;
  logs: string;
  error: string | null;
  blocked_reason: string | null;
}

export interface ContainerImageInfo {
  id: string | null;
  repository: string | null;
  tag: string | null;
  digest: string | null;
  created: string | null;
  architecture: string | null;
  os: string | null;
  entrypoint: string[] | null;
  user: string | null;
  exposed_ports: string[] | null;
  layers: number | null;
  size_bytes: number | null;
}

export type VulnSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";

export interface ContainerScanFinding {
  severity: VulnSeverity;
  package: string;
  version: string;
  vulnerability: string;
  fixed_in: string | null;
}

export interface ContainerScanResult {
  status: "PASS" | "FAIL" | "BLOCKED";
  scanner: string | null; // adapter that ran, null when blocked
  critical: number;
  high: number;
  medium: number;
  low: number;
  findings: ContainerScanFinding[];
  blocked_reason: string | null;
}

/** Distinguishes a dependency SBOM (from source manifests) from an image SBOM
 *  (from a real built image). An image SBOM is never claimed from a source SBOM. */
export type SbomSource = "SOURCE_SBOM" | "IMAGE_SBOM";

export interface SbomRecord {
  source: SbomSource;
  format: "CycloneDX";
  generator: string;
  timestamp: number;
  digest: string; // real sha256 over the SBOM document
  components: SbomComponent[];
}

/** Registry abstraction — foundation only. Push is NOT implemented this pass. */
export interface ContainerRegistryProvider {
  name: string;
  authenticate(): Promise<{ ok: boolean; reason: string | null }>;
  push(ref: ImageReference): Promise<{ ok: boolean; reason: string | null }>;
  pull(ref: ImageReference): Promise<{ ok: boolean; reason: string | null }>;
  inspect(ref: ImageReference): Promise<{ ok: boolean; reason: string | null }>;
  delete(ref: ImageReference): Promise<{ ok: boolean; reason: string | null }>;
}

/* ========================= Phase 3 Pass 4 — CI execution =================== */

/** The ordered CI execution stages. */
export const CI_STAGES = [
  "CHECKOUT",
  "DETECT",
  "BUILD",
  "TEST",
  "SECURITY",
  "SBOM",
  "ARTIFACT",
  "DOCKER",
  "STAGING",
  "HEALTH",
  "SMOKE",
  "QUALITY_GATE",
] as const;
export type CiStageName = (typeof CI_STAGES)[number];

/** Per-stage states. BLOCKED ≠ FAILED ≠ PASSED — never collapsed.
 *  Distinct from the Pass 3 remote-pipeline `CiStageStatus`. */
export type CiExecStageStatus = "PENDING" | "RUNNING" | "PASSED" | "FAILED" | "BLOCKED" | "SKIPPED" | "CANCELLED";

/** Final pipeline states. VERIFIED only when all required stages PASSED. */
export type CiExecutionStatus = "QUEUED" | "RUNNING" | "VERIFIED" | "FAILED" | "BLOCKED" | "CANCELLED";

/** Stages that MUST pass for a pipeline to reach VERIFIED. */
export const REQUIRED_CI_STAGES: CiStageName[] = [
  "CHECKOUT",
  "DETECT",
  "BUILD",
  "TEST",
  "SECURITY",
  "SBOM",
  "ARTIFACT",
  "DOCKER",
  "STAGING",
  "HEALTH",
  "SMOKE",
  "QUALITY_GATE",
];

/**
 * Controlled execution context. ONLY references — never secret values.
 * A secret must never be placed here; agents resolve them via CredentialService.
 */
export interface CiExecutionContext {
  execution_id: string;
  project_id: string;
  pipeline_id: string | null;
  commit_sha: string | null;
  workspace_id: string | null;
  environment_id: string | null;
  artifact_ids: string[];
}

export interface CiExecution {
  id: string;
  idempotency_key: string; // (project, commit_sha, pipeline) — dedups submissions
  project_id: string;
  pipeline_id: string | null;
  commit_sha: string | null;
  workspace_id: string | null;
  environment_id: string | null;
  status: CiExecutionStatus;
  current_stage: CiStageName | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  completed_at: number | null;
  error: SystemError | null;
  blocked_reason: string | null;
  correlation_id: string;
}

export interface CiStageRecord {
  id: string;
  execution_id: string;
  stage: CiStageName;
  attempt: number;
  status: CiExecStageStatus;
  started_at: number | null;
  completed_at: number | null;
  duration_ms: number | null;
  exit_code: number | null;
  command: string | null;
  logs_ref: string | null; // evidence:// reference (stdout/stderr, redacted)
  artifacts: string[]; // artifact ids produced by this stage
  evidence_id: string | null;
  error: SystemError | null;
  blocked_reason: string | null;
  retryable: boolean;
}

export interface CiAttempt {
  id: string;
  execution_id: string;
  attempt: number;
  status: CiExecutionStatus;
  started_at: number;
  completed_at: number | null;
  retry_reason: string | null;
}

export interface StagingDeployment {
  id: string;
  execution_id: string;
  provider: string;
  container_id: string | null;
  image_digest: string | null;
  environment: string;
  host: string | null;
  port: number | null;
  started_at: number | null;
  status: "PENDING" | "RUNNING" | "HEALTHY" | "FAILED" | "BLOCKED" | "STOPPED";
  blocked_reason: string | null;
}

export interface HealthCheckResult {
  id: string;
  execution_id: string;
  endpoint: string;
  status_code: number | null;
  response_time_ms: number | null;
  attempts: number;
  ok: boolean;
  error: string | null;
  checked_at: number;
}

export interface SmokeTestResult {
  id: string;
  execution_id: string;
  target: string;
  ok: boolean;
  status: "PASSED" | "FAILED" | "BLOCKED";
  detail: string | null;
  ran_at: number;
}

export interface QualityGateResult {
  id: string;
  execution_id: string;
  verdict: "VERIFIED" | "FAILED" | "BLOCKED";
  required_passed: number;
  required_total: number;
  blocking_stages: { stage: CiStageName; status: CiExecStageStatus; reason: string | null }[];
  evaluated_at: number;
}

/* ===================== Phase 3 Pass 3 — CI/CD + Git provider ================= */

/** Supported CI/git providers. GitHub Actions + GitLab CI initially. */
export type CiProvider = "github" | "gitlab";

/** Canonical pipeline step types. Provider generators map these to YAML. */
export type PipelineStepType =
  | "checkout"
  | "install"
  | "lint"
  | "test"
  | "security"
  | "build"
  | "artifact"
  | "docker";

/**
 * A single structured pipeline step. `command` is an allow-listed shell
 * command; `uses`/`with` map to provider actions (e.g. actions/checkout).
 * NEVER an arbitrary AI-authored command string.
 */
export interface PipelineStep {
  type: PipelineStepType;
  name: string;
  command?: string | null;
  uses?: string | null;
  with?: Record<string, string> | null;
  needs?: PipelineStepType[] | null;
}

/**
 * Structured pipeline plan produced by the PipelineAgent from real project
 * detection. Only applicable steps are included (e.g. no docker step unless
 * Docker is genuinely configured).
 */
export interface PipelinePlan {
  provider: CiProvider;
  project_type: string; // language/framework from detection
  install_step: PipelineStep | null;
  lint_step: PipelineStep | null;
  test_step: PipelineStep | null;
  security_step: PipelineStep | null;
  build_step: PipelineStep | null;
  artifact_step: PipelineStep | null;
  docker_step: PipelineStep | null;
  steps: PipelineStep[]; // ordered, applicable-only
  docker: boolean; // true only when Docker config is genuinely available
  generated_at: number;
}

/** Generated provider-specific pipeline configuration. */
export interface PipelineConfig {
  provider: CiProvider;
  filename: string; // ".github/workflows/nexus-ci.yml" | ".gitlab-ci.yml"
  content: string; // the YAML
  digest: string; // real sha256 over content
}

export type PipelineValidationVerdict = "VALID" | "INVALID" | "BLOCKED";

export interface PipelineValidationFinding {
  rule: string;
  severity: "info" | "warn" | "error";
  evidence: string; // the offending line/pattern
  location: string; // line number or step name
  recommendation: string;
}

export interface PipelineValidationResult {
  verdict: PipelineValidationVerdict;
  findings: PipelineValidationFinding[];
}

/** A pull/merge request. Never auto-merged; no deployment. */
export type ChangeRequestStatus = "OPEN" | "MERGED" | "CLOSED";

export interface ChangeRequest {
  execution_id: string;
  id: Id;
  provider: CiProvider;
  repository: string; // "owner/repo"
  source_branch: string;
  target_branch: string;
  commit: string; // head commit sha
  title: string;
  description: string;
  status: ChangeRequestStatus;
  remote_id: number | null; // provider PR/MR number when created remotely
  remote_url: string | null;
  created_at: number;
}

/** Remote pipeline run status model (provider-agnostic). */
export type CiRunStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "BLOCKED" | "CANCELLED";
export type CiStageStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "BLOCKED" | "SKIPPED";

export interface CiPipelineRun {
  id: Id;
  execution_id: Id;
  project_id: Id;
  provider: CiProvider;
  repository: string;
  ref: string; // branch
  status: CiRunStatus;
  attempt: number;
  correlation_id: Id;
  created_at: number;
  updated_at: number;
  error: SystemError | null;
  blocked_reason: string | null;
}

/** An audited git operation (branch/commit/PR creation, status fetch). */
export type GitOperationType =
  | "get_repository"
  | "list_branches"
  | "get_commit"
  | "create_branch"
  | "create_commit"
  | "create_pull_request"
  | "get_pull_request"
  | "pipeline_status"
  | "commit_status";

export interface GitOperation {
  id: Id;
  execution_id: Id | null;
  provider: CiProvider;
  operation: GitOperationType;
  repository: string;
  ref: string | null;
  commit_sha: string | null;
  status: "SUCCEEDED" | "FAILED" | "BLOCKED";
  blocked_reason: string | null;
  created_at: number;
}

/** Git provider primitives shared by GitHub/GitLab adapters + static fixture. */
export interface GitRepo {
  full_name: string; // "owner/repo"
  default_branch: string;
  is_private: boolean;
}
export interface GitBranch {
  name: string;
  sha: string;
  is_protected: boolean;
}
export interface GitCommit {
  sha: string;
  message: string;
  author: string;
}
export interface GitChangeRequest {
  number: number;
  head: string;
  base: string;
  state: string;
  url: string | null;
}
export interface GitFileChange {
  path: string;
  content: string;
}

/* NEXUS Phase 3 deployment and rollback shared contracts */

export type DeploymentStatus =
  | "PENDING"
  | "DEPLOYING"
  | "HEALTH_CHECKING"
  | "SMOKE_TESTING"
  | "VERIFIED"
  | "KNOWN_GOOD"
  | "FAILED"
  | "ROLLED_BACK"
  | "BLOCKED";

export type DeploymentCheckStatus =
  | "PENDING"
  | "PASS"
  | "FAIL"
  | "FAILED"
  | "BLOCKED"
  | "VERIFIED";

export interface DeploymentRecord {
  id: string;

  project_id: string;

  environment: string;

  release_id?: string | null;

  commit_sha?: string | null;

  artifact_id?: string | null;

  image?: string | null;

  image_id?: string | null;

  image_repository?: string | null;

  image_tag?: string | null;

  image_digest?: string | null;

  container_name?: string | null;

  container_id?: string | null;

  url?: string | null;
  failure_reason?: string | null;
  status: DeploymentStatus;

  health_status?: DeploymentCheckStatus | null;

  smoke_status?: DeploymentCheckStatus | null;

  quality_gate_status?: DeploymentCheckStatus | null;

  quality_gate?: DeploymentCheckStatus | null;

  is_rollback?: boolean;
  failure_injected?: boolean;  verified?: boolean;

  started_at: number;

  completed_at?: number | null;

  reason?: string | null;

  previous_deployment_id?: string | null;
}

export interface RollbackResult {
  status: DeploymentCheckStatus;

  deployment_id?: string | null;

  from_deployment_id?: string | null;

  to_deployment_id?: string | null;

  rollback_deployment_id?: string | null;  restored_image?: string | null;

  restored_image_id?: string | null;

  restored_release_id?: string | null;  restored_digest?: string | null;

  reason: string | null;

  started_at?: number;

  completed_at?: number | null;
  running_image_id?: string | null;
  running_container_id?: string | null;
  identity_matches?: boolean;
  health_status?: DeploymentCheckStatus | null;
  smoke_status?: DeploymentCheckStatus | null;
  quality_gate?: DeploymentCheckStatus | null;
}

export interface RollbackTestReport {
  status: DeploymentCheckStatus;

  original_deployment_id?: string | null;

  rollback_deployment_id?: string | null;

  running_image_id?: string | null;
  running_container_id?: string | null;
  health_status: DeploymentCheckStatus;

  smoke_status: DeploymentCheckStatus;

  reason: string | null;
}
/* ===================== Phase 4 Pass 1 — Security Control Plane ===================== */

export type SecurityExecutionStatus =
  | "QUEUED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "BLOCKED"
  | "CANCELLED";

export interface SecurityExecution {
  id: Id;
  project_id: Id;
  execution_id: Id;
  commit_sha: string;
  artifact_digest?: string;
  release_id?: Id;
  status: SecurityExecutionStatus;
  started_at: string;
  completed_at?: string;
  verdict?: "PASS" | "FAIL" | "BLOCKED";
}

export type SecurityEvidenceStatus = "PASS" | "FAIL" | "BLOCKED" | "NOT_RUN" | "UNKNOWN";
export type SecurityScannerCategory =
  | "SAST"
  | "SCA"
  | "SECRET"
  | "IAC"
  | "CONTAINER"
  | "SBOM"
  | "DAST"
  | "SUPPLY_CHAIN"
  | "SIGNATURE"
  | "AUTHENTICATION"
  | "CONFIGURATION"
  | "DEPENDENCY";

export interface SecurityEvidence {
  id: Id;
  project_id: Id;
  execution_id: Id;
  release_id?: Id;
  commit_sha: string;
  artifact_id?: Id;
  artifact_digest?: string;
  environment: string;
  scanner: string;
  category: SecurityScannerCategory;
  status: SecurityEvidenceStatus;
  started_at: string;
  completed_at?: string;
  duration_ms?: number;
  raw_reference?: string;
  normalized_reference?: string;
  created_at: string;
  sha256?: string;
  expires_at?: string;
}

export type FindingSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO" | "UNKNOWN";

export type FindingStatus =
  | "NEW"
  | "CONFIRMED"
  | "REOPENED"
  | "FALSE_POSITIVE"
  | "ACCEPTED_RISK"
  | "RESOLVED"
  | "OPEN"
  | "ACKNOWLEDGED"
  | "IN_PROGRESS"
  | "MITIGATED"
  | "EXPIRED";

export interface SecurityFinding {
  finding_id: Id;
  evidence_id: Id;
  project_id: Id;
  execution_id: Id;
  release_id?: Id;
  artifact_digest?: string;
  scanner: string;
  category: SecurityScannerCategory;
  severity: FindingSeverity;
  title: string;
  description?: string;
  fingerprint: string;
  file?: string;
  line?: number;
  column?: number;
  package?: string;
  dependency?: string;
  version?: string;
  fixed_version?: string;
  cve?: string;
  cwe?: string;
  resource?: string;
  location?: string;
  target?: string; // optional field added for Trivy target
  evidence_reference?: string;
  first_seen: string;
  last_seen: string;
  status: FindingStatus;
    // False positive / accepted risk metadata
  false_positive_reason?: string;
  false_positive_actor?: string;
  false_positive_at?: string;
  false_positive_evidence?: string;
  accepted_risk_reason?: string;
  approved_by?: string;
  approved_at?: string;
  expires_at?: string;   // ISO timestamp
  scope?: string;
  created_at: string;
  updated_at: string;
}

export interface SecurityDecision {
  id: Id;
  project_id: Id;
  execution_id: Id;
  release_id?: Id;
  artifact_digest?: string;
  policy_id: string;
  policy_version: string;
  verdict: "PASS" | "FAIL" | "BLOCKED";
  reasons: string[];
  created_at: string;
}

export interface RiskAssessment {
  id: Id;
  project_id: Id;
  execution_id: Id;
  release_id?: Id;
  artifact_digest?: string;
  severity_counts: Record<FindingSeverity, number>;
  correlated_findings: number;
  risk_score: number;
  explanation: string[];
  created_at: string;
}
/* ===================== Phase 4 Pass 7 — Continuous Security Operations ===================== */

export type SecurityFindingLifecycleStatus =
  | "OPEN"
  | "ACKNOWLEDGED"
  | "IN_PROGRESS"
  | "MITIGATED"
  | "RESOLVED"
  | "REOPENED"
  | "FALSE_POSITIVE"
  | "ACCEPTED_RISK"
  | "EXPIRED";

export interface SecurityFindingObservation {
  id: Id;
  finding_id: Id;
  execution_id: Id;
  observed_at: string;
  severity: FindingSeverity;
  raw_data?: string;
}

export interface SecurityRiskSnapshot {
  id: Id;
  project_id: Id;
  execution_id?: Id;
  timestamp: string;
  critical: number;
  high: number;
  medium: number;
  low: number;
  unknown: number;
  risk_score: number;
}

export type ScannerHealthStatus = "HEALTHY" | "DEGRADED" | "FAILED" | "UNAVAILABLE" | "STALE";

export interface SecurityScannerHealth {
  id: Id;
  scanner: string;
  version?: string;
  available: boolean;
  last_execution?: string;
  last_success?: string;
  last_failure?: string;
  duration_ms?: number;
  timeout_count: number;
  failure_count: number;
  findings_count: number;
  health: ScannerHealthStatus;
  updated_at: string;
}

export interface SecurityPolicyEvaluationRecord {
  id: Id;
  policy_version: string;
  execution_id: Id;
  release_id?: Id;
  artifact_digest?: string;
  decision: "PASS" | "FAIL" | "BLOCKED";
  reasons: string[];
  rules_evaluated: unknown;
  timestamp: string;
}

export interface SecurityOverride {
  id: Id;
  actor: string;
  reason: string;
  scope: string;
  expiration?: string;
  affected_release_id?: string;
  affected_artifact_digest?: string;
  created_at: string;
}

export interface SecurityRiskAcceptance {
  id: Id;
  finding_id: Id;
  actor: string;
  reason: string;
  scope: string;
  expiration: string;
  created_at: string;
}

export type DriftEventType =
  | "artifact_changed"
  | "image_digest_changed"
  | "sbom_changed"
  | "policy_changed"
  | "deployment_mismatch"
  | "evidence_mismatch";

export interface SecurityDriftEvent {
  id: Id;
  project_id?: Id;
  artifact_digest_expected?: string;
  artifact_digest_actual?: string;
  type: DriftEventType;
  details?: string;
  detected_at: string;
}













