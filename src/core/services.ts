/**
 * NEXUS Phase 1 — service layer (the API foundation).
 *
 * Every operation: validates input → checks authorization via can() →
 * performs the change → records audit → emits events → returns a consistent
 * result. Denials are audited. Secrets never appear in results. This is the
 * boundary a future HTTP transport will expose.
 */

import type { AuditService } from "./audit";
import { digestOf, nid, type NexusEngine } from "./db";
import { Err, toSystemError } from "./errors";
import type { EventService } from "./events";
import { can, validateProjectInput } from "./security";
import { authorizeProject, projectPermissionAllowed } from "./project-authorization";
import type {
  ArtifactReference,
  Evidence,
  EvidenceInput,
  Execution,
  ExecutionStatus,
  Permission,
  Project,
  ProjectStatus,
  PublicUser,
} from "./types";

/** Credential-free identity used across all service boundaries. */
export type Actor = PublicUser;

export interface ServiceContext {
  engine: NexusEngine;
  events: EventService;
  audit: AuditService;
  // Phase 168: durable project membership source of truth.
  memberships: import("./project-membership-store").ProjectMembershipStore;
}

async function authorize(
  ctx: ServiceContext,
  actor: Actor,
  permission: Permission,
  resource: { type: string; id: string },
): Promise<void> {
  if (!can(actor, permission)) {
    await ctx.audit.record({
      actor: actor.email,
      action: `denied:${permission}`,
      resource_type: resource.type,
      resource_id: resource.id,
      result: "deny",
      metadata: { role: actor.role, permission },
    });
    throw Err.denied("PERMISSION_DENIED", `permission denied: role ${actor.role} does not hold '${permission}'`);
  }
}

/**
 * Phase 170: resolve the execution-scoped resource's owning project and
 * require the actor to hold 'permission' on it. actor=null is preserved
 * only for the CI/CD pipeline and reconciliation workers that operate
 * under worker ownership rather than a user identity.
 */
async function authorizeExecutionScope(
  ctx: ServiceContext,
  actor: Actor | null,
  executionId: string,
  permission: Permission,
): Promise<Execution> {
  const execution = await ctx.engine.get<Execution>("executions", executionId);
  if (!execution) throw Err.notFound("EXECUTION_NOT_FOUND", "execution not found");
  if (actor === null) return execution;
  try {
    await authorizeProject(ctx, actor, permission, execution.project_id);
  } catch {
    // Phase 170: enumeration resistance. A caller who cannot prove project
    // access sees the same error as a nonexistent execution - the caller
    // cannot distinguish "foreign execution" from "no such execution".
    // The original denial is already recorded in the audit trail.
    throw Err.notFound("EXECUTION_NOT_FOUND", "execution not found");
  }
  return execution;
}

/* ------------------------------ ProjectService ----------------------------- */

export class ProjectService {
  constructor(private ctx: ServiceContext) {}

  async create(actor: Actor, input: { name: string; description?: string; repository?: string; default_branch?: string }): Promise<Project> {
    await authorize(this.ctx, actor, "project:create", { type: "project", id: "*" });
    const clean = validateProjectInput(input);
    const now = Date.now();
    const project: Project = {
      id: nid("prj"),
      ...clean,
      status: "ACTIVE",
      created_at: now,
      updated_at: now,
    };
    // Phase 168: project row + creator's PROJECT_OWNER membership are
    // committed in one SQLite transaction. Either both succeed or
    // neither does. Bypasses engine.put on purpose - engine.put is
    // async and cannot participate in better-sqlite3's synchronous
    // transaction callback. Both tables live in the same database.
    this.ctx.memberships.insertProjectWithOwner(project, actor.id);
    await this.ctx.audit.record({
      actor: actor.email,
      action: "project.create",
      resource_type: "project",
      resource_id: project.id,
      result: "allow",
      metadata: { name: project.name },
    });
    await this.ctx.events.emit({ type: "project.created", source: "ProjectService", payload: { project_id: project.id, name: project.name } });
    return project;
  }

  async get(actor: Actor, id: string): Promise<Project> {
    // Phase 168: existence + membership are checked by authorizeProject
    // in a single call. Both "project missing" and "not a member"
    // surface as PROJECT_ACCESS_DENIED so unauthorized callers cannot
    // enumerate project existence.
    await authorizeProject(this.ctx, actor, "project:read", id);
    const project = await this.ctx.engine.get<Project>("projects", id);
    if (!project) throw Err.notFound("PROJECT_NOT_FOUND", "project not found");
    return project;
  }

  async list(actor: Actor): Promise<Project[]> {
    // Phase 168: platform admins (OWNER) see every project; ordinary
    // actors see only projects where they hold an ACTIVE membership
    // whose role permits project:read. Filtering is enforced here, at
    // the service layer, not in any UI.
    if (!can(actor, "project:read")) {
      throw Err.denied("PERMISSION_DENIED", `role '${actor.role}' does not hold 'project:read'`);
    }
    const rows = await this.ctx.engine.all<Project>("projects");
    const visible = rows.filter((p) => projectPermissionAllowed(this.ctx, actor, "project:read", p.id));
    return visible.sort((a, b) => b.created_at - a.created_at);
  }

  async update(actor: Actor, id: string, patch: Partial<{ name: string; description: string; repository: string; default_branch: string; status: ProjectStatus }>): Promise<Project> {
    // Phase 168: project:archive / project:update enforced via the
    // actor's project membership. Platform admins bypass membership.
    const permission: Permission = patch.status === "ARCHIVED" ? "project:archive" : "project:update";
    await authorizeProject(this.ctx, actor, permission, id);

    const project = await this.ctx.engine.get<Project>("projects", id);
    if (!project) throw Err.notFound("PROJECT_NOT_FOUND", "project not found");

    const changes: string[] = [];
    if (patch.name !== undefined || patch.description !== undefined || patch.repository !== undefined || patch.default_branch !== undefined) {
      const clean = validateProjectInput({
        name: patch.name ?? project.name,
        description: patch.description ?? project.description,
        repository: patch.repository ?? project.repository,
        default_branch: patch.default_branch ?? project.default_branch,
      });
      if (clean.name !== project.name) { project.name = clean.name; changes.push("name"); }
      if (clean.description !== project.description) { project.description = clean.description; changes.push("description"); }
      if (clean.repository !== project.repository) { project.repository = clean.repository; changes.push("repository"); }
      if (clean.default_branch !== project.default_branch) { project.default_branch = clean.default_branch; changes.push("default_branch"); }
    }
    if (patch.status !== undefined && patch.status !== project.status) {
      const allowed: Record<ProjectStatus, ProjectStatus[]> = {
        ACTIVE: ["PAUSED", "ARCHIVED"],
        PAUSED: ["ACTIVE", "ARCHIVED"],
        ARCHIVED: ["ACTIVE"],
      };
      if (!allowed[project.status].includes(patch.status)) {
        throw Err.validation("INVALID_LIFECYCLE", `cannot move project from ${project.status} to ${patch.status}`);
      }
      project.status = patch.status;
      changes.push(`status:${patch.status}`);
    }
    if (changes.length === 0) return project;

    project.updated_at = Date.now();
    await this.ctx.engine.put("projects", project.id, project);
    await this.ctx.audit.record({
      actor: actor.email,
      action: patch.status === "ARCHIVED" ? "project.archive" : "project.update",
      resource_type: "project",
      resource_id: project.id,
      result: "allow",
      metadata: { changes },
    });
    await this.ctx.events.emit({
      type: patch.status === "ARCHIVED" ? "project.archived" : "project.updated",
      source: "ProjectService",
      payload: { project_id: project.id, changes },
    });
    return project;
  }
}

/* ----------------------------- ExecutionService ---------------------------- */

export class ExecutionService {
  constructor(private ctx: ServiceContext) {}

  async createQueued(actor: Actor, projectId: string, request: string): Promise<Execution> {
    // Phase 168: project-scoped. Requires global execution:create +
    // ACTIVE project membership whose role permits execution:create.
    await authorizeProject(this.ctx, actor, "execution:create", projectId);

    const now = Date.now();
    const execution: Execution = {
      id: nid("exe"),
      project_id: projectId,
      request,
      status: "QUEUED",
      started_at: now,
      completed_at: null,
      created_by: actor.id,
      error: null,
      metadata: {},
    };
    await this.ctx.engine.put("executions", execution.id, execution);
    return execution;
  }

  async transition(actor: Actor | null, id: string, status: ExecutionStatus, error?: ReturnType<typeof toSystemError> | null): Promise<Execution> {
    const execution = await this.ctx.engine.get<Execution>("executions", id);
    if (!execution) throw Err.notFound("EXECUTION_NOT_FOUND", "execution not found");

    // Phase 168: authorize before mutating. null actor = internal/system
    // control-plane caller (existing signature preserved for that path).
    // Every production caller in src/ passes a real actor.
    if (actor) {
      const permission: Permission = status === "CANCELLED" ? "execution:cancel" : "execution:create";
      await authorizeProject(this.ctx, actor, permission, execution.project_id);
    }

    const allowed: Record<ExecutionStatus, ExecutionStatus[]> = {
      QUEUED: ["RUNNING", "CANCELLED", "FAILED"],
      RUNNING: ["SUCCEEDED", "FAILED", "CANCELLED"],
      SUCCEEDED: [],
      FAILED: [],
      CANCELLED: [],
    };
    if (!allowed[execution.status].includes(status)) {
      throw Err.validation("INVALID_EXECUTION_TRANSITION", `cannot move execution from ${execution.status} to ${status}`);
    }
    execution.status = status;
    if (status === "SUCCEEDED" || status === "FAILED" || status === "CANCELLED") {
      execution.completed_at = Date.now();
    }
    if (error) execution.error = error;
    await this.ctx.engine.put("executions", execution.id, execution);

    if (actor) {
      await this.ctx.audit.record({
        actor: actor.email,
        action: `execution.${status.toLowerCase()}`,
        resource_type: "execution",
        resource_id: execution.id,
        result: status === "FAILED" ? "error" : "allow",
        metadata: error ? { code: error.code } : undefined,
      });
    }
    const eventType =
      status === "SUCCEEDED" ? "execution.completed" : status === "FAILED" ? "execution.failed" : status === "CANCELLED" ? "execution.cancelled" : "execution.started";
    await this.ctx.events.emit({ type: eventType, source: "ExecutionService", execution_id: execution.id, payload: { status } });
    return execution;
  }

  async get(actor: Actor, id: string): Promise<Execution> {
    const execution = await this.ctx.engine.get<Execution>("executions", id);
    // Not-found before authorization so a nonexistent id is indistinguishable
    // from an unauthorized one at the caller boundary.
    if (!execution) throw Err.notFound("EXECUTION_NOT_FOUND", "execution not found");
    await authorizeProject(this.ctx, actor, "execution:read", execution.project_id);
    return execution;
  }

  async list(actor: Actor): Promise<Execution[]> {
    if (!can(actor, "execution:read")) {
      throw Err.denied("PERMISSION_DENIED", `role '${actor.role}' does not hold 'execution:read'`);
    }
    const rows = await this.ctx.engine.all<Execution>("executions");
    const visible = rows.filter((e) => projectPermissionAllowed(this.ctx, actor, "execution:read", e.project_id));
    return visible.sort((a, b) => b.started_at - a.started_at);
  }

  async byProject(actor: Actor, projectId: string): Promise<Execution[]> {
    // Phase 168: actor-aware. Requires execution:read on the target project.
    await authorizeProject(this.ctx, actor, "execution:read", projectId);
    const rows = await this.ctx.engine.byIndex<Execution>("executions", "byProject", projectId);
    return rows.sort((a, b) => b.started_at - a.started_at);
  }

  async cancel(actor: Actor, id: string): Promise<Execution> {
    // cancel delegates the actual auth check to transition(), which applies
    // authorizeProject(..., "execution:cancel", ...) against the resolved
    // execution.project_id. Explicit load here so not-found semantics are
    // preserved for the cancel path specifically.
    const execution = await this.ctx.engine.get<Execution>("executions", id);
    if (!execution) throw Err.notFound("EXECUTION_NOT_FOUND", "execution not found");
    return this.transition(actor, id, "CANCELLED");
  }
}

/* ------------------------------ EvidenceService ---------------------------- */

export class EvidenceService {
  constructor(private ctx: ServiceContext) {}

  /** Record evidence with a REAL sha256 over the actual content.
   *  Phase 170: project-scoped. actor=null only from internal pipeline paths. */
  async record(actor: Actor | null, executionId: string, input: EvidenceInput): Promise<Evidence> {
    await authorizeExecutionScope(this.ctx, actor, executionId, "evidence:create");
    const hash = await digestOf(input.content);
    const id = nid("evi");
    const evidence: Evidence = {
      id,
      execution_id: executionId,
      type: input.type,
      source: input.source,
      content_reference: `evidence://${id}`,
      timestamp: Date.now(),
      hash,
      metadata: input.metadata ?? {},
    };
    await this.ctx.engine.put("evidence", id, { ...evidence, __content: input.content });
    await this.ctx.events.emit({ type: "evidence.created", source: "EvidenceService", execution_id: executionId, payload: { evidence_id: id, evidence_type: input.type, evidence_source: input.source } });
    return evidence;
  }

  async list(actor: Actor, executionId?: string): Promise<Evidence[]> {
    let rows: Array<Evidence & { __content?: string }>;
    if (executionId) {
      // Phase 170: scope by the execution's owning project.
      await authorizeExecutionScope(this.ctx, actor, executionId, "evidence:read");
      rows = await this.ctx.engine.byIndex<Evidence & { __content?: string }>("evidence", "byExecution", executionId);
    } else {
      // Phase 170: no executionId. Must not return evidence from projects the
      // actor cannot access. Global RBAC gate first, then resolve accessible
      // executions via evidence.execution_id -> Execution.project_id ->
      // authorizeProject (projectPermissionAllowed), then filter evidence.
      // No project_id column on evidence.
      await authorize(this.ctx, actor, "evidence:read", { type: "evidence", id: "*" });
      const allExecutions = await this.ctx.engine.all<Execution>("executions");
      const accessibleExecutions = new Set<string>();
      for (const exec of allExecutions) {
        if (projectPermissionAllowed(this.ctx, actor, "evidence:read", exec.project_id)) {
          accessibleExecutions.add(exec.id);
        }
      }
      const allEvidence = await this.ctx.engine.all<Evidence & { __content?: string }>("evidence");
      rows = allEvidence.filter((e) => accessibleExecutions.has(e.execution_id));
    }
    return rows
      .map(({ __content: _c, ...rest }) => rest)
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  /** Re-verify integrity: recompute the digest of stored content.
   *  Phase 170: project-scoped via the evidence's owning execution. */
  async verify(actor: Actor, evidenceId: string): Promise<{ ok: boolean; expected: string; actual: string }> {
    const rec = await this.ctx.engine.get<Evidence & { __content?: string }>("evidence", evidenceId);
    if (!rec) throw Err.notFound("EVIDENCE_NOT_FOUND", "evidence not found");
    await authorizeExecutionScope(this.ctx, actor, rec.execution_id, "evidence:read");
    const actual = await digestOf(rec.__content ?? "");
    return { ok: actual === rec.hash, expected: rec.hash, actual };
  }
}

/* ------------------------------ ArtifactService ---------------------------- */

export class ArtifactRegistrationFencedError extends Error {
  readonly code = "ARTIFACT_REGISTRATION_FENCED";
  constructor(message = "artifact registration fenced: current worker is no longer the authoritative owner") {
    super(message);
    this.name = "ArtifactRegistrationFencedError";
  }
}

export class ArtifactService {
  constructor(private ctx: ServiceContext) {}

  /** Register an artifact from REAL content — the digest is computed from the
   *  actual bytes, never invented. */
  async register(
    actor: Actor | null,
    executionId: string,
    input: { kind: string; name: string; content: string; canWrite?: () => boolean },
  ): Promise<ArtifactReference> {
    await authorizeExecutionScope(this.ctx, actor, executionId, "artifact:create");
    if (input.canWrite && !input.canWrite()) {
      throw new ArtifactRegistrationFencedError();
    }
    const digest = await digestOf(input.content);
    const id = nid("art");
    // Phase 135: re-check the fence after the async digest computation,
    // immediately before the durable write.
    if (input.canWrite && !input.canWrite()) {
      throw new ArtifactRegistrationFencedError();
    }
    const ref: ArtifactReference = {
      id,
      execution_id: executionId,
      kind: input.kind,
      name: input.name,
      digest,
      size: input.content.length,
      location: `artifact://${id}`,
      created_at: Date.now(),
    };
    await this.ctx.engine.put("artifacts", id, { ...ref, __content: input.content });
    return ref;
  }

  async list(actor: Actor | null, executionId: string): Promise<ArtifactReference[]> {
    await authorizeExecutionScope(this.ctx, actor, executionId, "artifact:read");
    const rows = await this.ctx.engine.byIndex<ArtifactReference & { __content?: string }>("artifacts", "byExecution", executionId);
    return rows
      .map(({ __content: _c, ...rest }) => rest)
      .sort((a, b) => a.created_at - b.created_at);
  }
}

export type { PublicUser };
