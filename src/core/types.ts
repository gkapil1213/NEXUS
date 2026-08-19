/**
 * NEXUS Phase 1 — domain type system.
 *
 * Strong, discriminated types for the whole platform foundation. No `any`:
 * unknown external data enters only through validators (see security.ts).
 */

/* ------------------------------- Identifiers ------------------------------ */

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
  "github:read",
  "github:push",
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
  | "artifact.register.completed";

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
