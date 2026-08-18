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

/** Identity lifecycle beyond active/suspended. */
export type IdentityStatus = "active" | "suspended";

export interface User {
  id: Id;
  email: string;
  name: string;
  role: Role;
  status: "active" | "suspended";
  password_hash: string; // PBKDF2 — plaintext never persisted
  salt: string;
  iterations: number;
  created_at: number;
}

/** Public view of a user — never includes credential material. */
export interface PublicUser {
  id: Id;
  email: string;
  name: string;
  role: Role;
  status: "active" | "suspended";
  created_at: number;
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

export const AGENT_CAPABILITIES = ["inspect", "analyze", "plan"] as const;
export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

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
  | "approval.decided";

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

export interface WorkspaceRecord {
  id: Id;
  project_id: Id;
  execution_id: Id;
  status: "ACTIVE" | "DESTROYED";
  file_count: number;
  total_bytes: number;
  created_at: number;
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

export interface SandboxIsolationReport {
  kind: SandboxKind;
  available: boolean;
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
