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

/* ------------------------------ ProjectService ----------------------------- */

export class ProjectService {
  constructor(private ctx: ServiceContext) {}

  async create(actor: Actor, input: { name: string; description?: string; repository?: string; default_branch?: string }): Promise<Project> {
    const clean = validateProjectInput(input);
    await authorize(this.ctx, actor, "project:create", { type: "project", id: "*" });
    const now = Date.now();
    const project: Project = {
      id: nid("prj"),
      ...clean,
      status: "ACTIVE",
      created_at: now,
      updated_at: now,
    };
    await this.ctx.engine.put("projects", project.id, project);
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
    await authorize(this.ctx, actor, "project:read", { type: "project", id });
    const project = await this.ctx.engine.get<Project>("projects", id);
    if (!project) throw Err.notFound("PROJECT_NOT_FOUND", "project not found");
    return project;
  }

  async list(actor: Actor): Promise<Project[]> {
    await authorize(this.ctx, actor, "project:read", { type: "project", id: "*" });
    const rows = await this.ctx.engine.all<Project>("projects");
    return rows.sort((a, b) => b.created_at - a.created_at);
  }

  async update(actor: Actor, id: string, patch: Partial<{ name: string; description: string; repository: string; default_branch: string; status: ProjectStatus }>): Promise<Project> {
    const project = await this.ctx.engine.get<Project>("projects", id);
    if (!project) throw Err.notFound("PROJECT_NOT_FOUND", "project not found");
    const permission: Permission = patch.status === "ARCHIVED" ? "project:archive" : "project:update";
    await authorize(this.ctx, actor, permission, { type: "project", id });

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
    await authorize(this.ctx, actor, "execution:read", { type: "execution", id });
    const execution = await this.ctx.engine.get<Execution>("executions", id);
    if (!execution) throw Err.notFound("EXECUTION_NOT_FOUND", "execution not found");
    return execution;
  }

  async list(actor: Actor): Promise<Execution[]> {
    await authorize(this.ctx, actor, "execution:read", { type: "execution", id: "*" });
    const rows = await this.ctx.engine.all<Execution>("executions");
    return rows.sort((a, b) => b.started_at - a.started_at);
  }

  async byProject(projectId: string): Promise<Execution[]> {
    const rows = await this.ctx.engine.byIndex<Execution>("executions", "byProject", projectId);
    return rows.sort((a, b) => b.started_at - a.started_at);
  }

  async cancel(actor: Actor, id: string): Promise<Execution> {
    await authorize(this.ctx, actor, "execution:cancel", { type: "execution", id });
    return this.transition(actor, id, "CANCELLED");
  }
}

/* ------------------------------ EvidenceService ---------------------------- */

export class EvidenceService {
  constructor(private ctx: ServiceContext) {}

  /** Record evidence with a REAL sha256 over the actual content. */
  async record(executionId: string, input: EvidenceInput): Promise<Evidence> {
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
    await authorize(this.ctx, actor, "evidence:read", { type: "evidence", id: executionId ?? "*" });
    const rows = executionId
      ? await this.ctx.engine.byIndex<Evidence & { __content?: string }>("evidence", "byExecution", executionId)
      : await this.ctx.engine.all<Evidence & { __content?: string }>("evidence");
    return rows
      .map(({ __content: _c, ...rest }) => rest)
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  /** Re-verify integrity: recompute the digest of stored content. */
  async verify(evidenceId: string): Promise<{ ok: boolean; expected: string; actual: string }> {
    const rec = await this.ctx.engine.get<Evidence & { __content?: string }>("evidence", evidenceId);
    if (!rec) throw Err.notFound("EVIDENCE_NOT_FOUND", "evidence not found");
    const actual = await digestOf(rec.__content ?? "");
    return { ok: actual === rec.hash, expected: rec.hash, actual };
  }
}

/* ------------------------------ ArtifactService ---------------------------- */

export class ArtifactService {
  constructor(private ctx: ServiceContext) {}

  /** Register an artifact from REAL content — the digest is computed from the
   *  actual bytes, never invented. */
  async register(executionId: string, input: { kind: string; name: string; content: string }): Promise<ArtifactReference> {
    const digest = await digestOf(input.content);
    const id = nid("art");
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

  async list(executionId: string): Promise<ArtifactReference[]> {
    const rows = await this.ctx.engine.byIndex<ArtifactReference & { __content?: string }>("artifacts", "byExecution", executionId);
    return rows
      .map(({ __content: _c, ...rest }) => rest)
      .sort((a, b) => a.created_at - b.created_at);
  }
}

export type { PublicUser };
