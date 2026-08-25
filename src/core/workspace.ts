/**
 * NEXUS Phase 2 — Pass 3: Workspace & sandbox isolation.
 *
 *   WorkspaceService  — lifecycle (CREATING→READY→ACTIVE→CLEANING→DESTROYED),
 *                       TTL, ownership, idempotent cleanup, honest failure.
 *   FileAccessPolicy  — the SINGLE centralized path/containment gate. Every
 *                       file operation routes through it; agents never check
 *                       paths themselves.
 *   ExecutionSandbox  — abstraction + BrowserSandbox. This runtime provides a
 *                       LOGICAL_BOUNDARY (path + store confinement), NOT OS/
 *                       container/VM isolation. isolationReport() says so
 *                       explicitly — see IsolationBoundary.
 *
 * Security posture:
 *  - Fail closed: any unresolved path, expired workspace, foreign workspace or
 *    limit breach is DENIED/BLOCKED + audited + evented. Never redirected.
 *  - No host filesystem access: files live only in the workspace_files store,
 *    keyed (workspace_id, path). There is no path that reaches the host FS.
 *  - Secrets never enter the workspace layer; file contents are never stored
 *    in audit records (only path + classification + decision).
 */

import { nid, type NexusEngine } from "./db";
import { Err } from "./errors";
import { safeWorkspacePath, type AuthorizationService } from "./security";
import type { AuditService } from "./audit";
import type { EventService } from "./events";
import type {
  ExecutionSandbox,
  FileOp,
  SandboxIsolationReport,
  User,
  WorkspaceFileRecord,
  WorkspaceLimits,
  WorkspaceRecord,
  WorkspaceStatus,
} from "./types";

/** Minimal authenticated identity for policy decisions (avoids import cycle). */
export type WorkspaceActor = Pick<User, "id" | "email" | "role" | "status">;

/* ------------------------------- Configuration ----------------------------- */

export const DEFAULT_WORKSPACE_LIMITS: WorkspaceLimits = {
  max_file_bytes: 64 * 1024, // 64 KB per file
  max_total_bytes: 1024 * 1024, // 1 MB per workspace
  max_file_count: 200,
  max_output_bytes: 256 * 1024, // 256 KB collected output
};

export const DEFAULT_WORKSPACE_TTL_MS = 60 * 60 * 1000; // 1 hour

/* --------------------------- Lifecycle transition -------------------------- */

/** Legal workspace state transitions. Anything else is rejected (fail closed). */
const WORKSPACE_TRANSITIONS: Record<WorkspaceStatus, WorkspaceStatus[]> = {
  CREATING: ["READY", "FAILED"],
  READY: ["ACTIVE", "CLEANING"],
  ACTIVE: ["CLEANING", "FAILED"],
  CLEANING: ["DESTROYED", "FAILED"],
  FAILED: ["CLEANING"], // allow reclaiming a failed workspace
  DESTROYED: [], // terminal — a destroyed workspace is never reused
};

function canTransition(from: WorkspaceStatus, to: WorkspaceStatus): boolean {
  return WORKSPACE_TRANSITIONS[from].includes(to);
}

/* ------------------------------ FileAccessPolicy --------------------------- */

export interface PathDecision {
  allowed: boolean;
  normalized: string | null;
  reason: string;
  classification: "inside" | "traversal" | "absolute" | "foreign" | "system" | "invalid";
}

/**
 * Centralized file-access gate. Given a workspace and a requested path, decide
 * whether the path is inside this workspace's boundary. Pure — no side
 * effects; the caller performs audit/event. Fail closed.
 */
export class FileAccessPolicy {
  /** Decide whether `path` is a legal member of `workspace`. */
  decide(workspace: WorkspaceRecord, path: string, otherWorkspaceIds: ReadonlySet<string>): PathDecision {
    // 1. Normalize + reject traversal/absolute/control/system via the shared
    //    path policy. safeWorkspacePath THROWS on violation; we translate to a
    //    structured decision (never let it escape as an unhandled error).
    let normalized: string;
    try {
      normalized = safeWorkspacePath(path);
    } catch (e) {
      const msg = (e as Error).message;
      const classification: PathDecision["classification"] = msg.includes("traversal")
        ? "traversal"
        : msg.includes("absolute")
          ? "absolute"
          : msg.includes("system") || msg.includes("credential")
            ? "system"
            : "invalid";
      return { allowed: false, normalized: null, reason: msg, classification };
    }

    // 2. Encoded / mixed-separator traversal that survived normalization.
    if (/%2e%2e|\.\.%2f|%2f\.\./i.test(path) || normalized.includes("..")) {
      return { allowed: false, normalized: null, reason: "encoded or mixed-separator traversal detected", classification: "traversal" };
    }

    // 3. Foreign-workspace / symlink-style escape: the normalized path must not
    //    reference another workspace boundary or an escape reference.
    if (normalized.includes("ws://") || normalized.startsWith("@")) {
      return { allowed: false, normalized: null, reason: "workspace-reference escape is not permitted", classification: "foreign" };
    }
    for (const other of otherWorkspaceIds) {
      if (other !== workspace.id && normalized.includes(other)) {
        return { allowed: false, normalized: null, reason: "path references a different execution workspace", classification: "foreign" };
      }
    }

    return { allowed: true, normalized, reason: "path is inside the workspace boundary", classification: "inside" };
  }
}

/* ------------------------------ WorkspaceService --------------------------- */

export interface WorkspaceServices {
  engine: NexusEngine;
  authz: AuthorizationService;
  audit: AuditService;
  events: EventService;
  policy: FileAccessPolicy;
  limits: WorkspaceLimits;
}

export class WorkspaceService {
  constructor(private svc: WorkspaceServices) {}

  /** All currently-live workspace ids (used for foreign-workspace detection). */
  private async liveWorkspaceIds(): Promise<Set<string>> {
    const all = await this.svc.engine.all<WorkspaceRecord>("workspaces");
    return new Set(all.filter((w) => w.status !== "DESTROYED").map((w) => w.id));
  }

  private async auditWs(
    actor: WorkspaceActor,
    action: string,
    ws: WorkspaceRecord,
    result: "allow" | "deny" | "error" | "info",
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.svc.audit.record({
      actor: actor.email,
      action,
      resource_type: "workspace",
      resource_id: ws.id,
      result,
      metadata,
    });
  }

  private async emitWs(type: Parameters<WorkspaceServices["events"]["emit"]>[0]["type"], ws: WorkspaceRecord, payload: Record<string, unknown>): Promise<void> {
    await this.svc.events.emit({ type, source: "WorkspaceService", execution_id: ws.execution_id, payload: { workspace_id: ws.id, ...payload } });
  }

  /** Create a workspace for exactly one execution. Requires workspace:create. */
  async create(
    actor: WorkspaceActor,
    input: { project_id: string; execution_id: string; ttl_ms?: number },
  ): Promise<WorkspaceRecord> {
    await this.svc.authz.authorize(actor, "workspace:create", { type: "workspace", id: input.execution_id });

    const now = Date.now();
    const ws: WorkspaceRecord = {
      id: nid("ws"),
      project_id: input.project_id,
      execution_id: input.execution_id,
      owner_identity_id: actor.id,
      status: "CREATING",
      file_count: 0,
      total_bytes: 0,
      created_at: now,
      updated_at: now,
      expires_at: now + (input.ttl_ms ?? DEFAULT_WORKSPACE_TTL_MS),
      destroyed_at: null,
    };
    await this.svc.engine.put("workspaces", ws.id, ws);
    await this.auditWs(actor, "workspace.created", ws, "allow", { project_id: ws.project_id, execution_id: ws.execution_id });
    await this.emitWs("workspace.created", ws, { status: ws.status });

    // Provisioning is synchronous in this runtime; move CREATING → READY.
    return this.transition(actor, ws.id, "READY");
  }

  async get(actor: WorkspaceActor, id: string): Promise<WorkspaceRecord> {
    await this.svc.authz.authorize(actor, "workspace:read", { type: "workspace", id });
    const ws = await this.svc.engine.get<WorkspaceRecord>("workspaces", id);
    if (!ws) throw Err.notFound("WORKSPACE_NOT_FOUND", "workspace not found");
    return ws;
  }

  /** Activate (READY → ACTIVE). Expired workspaces are BLOCKED, never activated. */
  async activate(actor: WorkspaceActor, id: string): Promise<WorkspaceRecord> {
    await this.svc.authz.authorize(actor, "workspace:create", { type: "workspace", id });
    const ws = await this.mustGet(id);

    if (this.isExpired(ws)) {
      await this.auditWs(actor, "workspace.expired", ws, "deny", { reason: "ttl elapsed before activation" });
      await this.emitWs("workspace.expired", ws, {});
      throw Err.security("WORKSPACE_EXPIRED", "workspace is expired and cannot be activated");
    }
    return this.transition(actor, id, "ACTIVE");
  }

  /**
   * Cleanup: remove all files and move to DESTROYED. IDEMPOTENT — cleaning an
   * already-destroyed workspace is a no-op that returns the existing record.
   * A failed cleanup is recorded honestly as FAILED, never swallowed.
   */
  async cleanup(actor: WorkspaceActor, id: string): Promise<WorkspaceRecord> {
    await this.svc.authz.authorize(actor, "workspace:delete", { type: "workspace", id });
    const ws = await this.mustGet(id);

    // Idempotency: already terminal.
    if (ws.status === "DESTROYED") return ws;

    await this.auditWs(actor, "workspace.cleanup.started", ws, "info", {});
    await this.emitWs("workspace.cleanup.started", ws, {});

    try {
      await this.transition(actor, id, "CLEANING");
      // Remove every file owned by this workspace (and only this workspace).
      const files = await this.svc.engine.byIndex<WorkspaceFileRecord>("workspace_files", "byWorkspace", id);
      for (const f of files) await this.svc.engine.del("workspace_files", f.id);
      const cleaned = await this.transition(actor, id, "DESTROYED");
      cleaned.file_count = 0;
      cleaned.total_bytes = 0;
      await this.svc.engine.put("workspaces", cleaned.id, cleaned);
      await this.auditWs(actor, "workspace.cleanup.completed", cleaned, "allow", { files_removed: files.length });
      await this.emitWs("workspace.cleanup.completed", cleaned, { files_removed: files.length });
      return cleaned;
    } catch (e) {
      // Record the failure honestly; leave the workspace in FAILED so it is
      // visible and retryable — never pretend cleanup succeeded.
      await this.svc.engine.put("workspaces", id, { ...ws, status: "FAILED", updated_at: Date.now() });
      await this.auditWs(actor, "workspace.cleanup.failed", ws, "error", { reason: (e as Error).message });
      await this.emitWs("workspace.cleanup.failed", ws, { reason: (e as Error).message });
      throw e;
    }
  }

  /** Destroy: terminal. A destroyed workspace cannot be reused or re-activated. */
  async destroy(actor: WorkspaceActor, id: string): Promise<WorkspaceRecord> {
    const cleaned = await this.cleanup(actor, id);
    await this.auditWs(actor, "workspace.destroyed", cleaned, "allow", {});
    await this.emitWs("workspace.destroyed", cleaned, {});
    return cleaned;
  }

  /* ----------------------------- File operations --------------------------- */

  /** Controlled read. Passes identity → authorization → ownership → path policy. */
  async readFile(actor: WorkspaceActor, id: string, path: string): Promise<WorkspaceFileRecord> {
    await this.svc.authz.authorize(actor, "workspace:read", { type: "workspace", id });
    const ws = await this.requireActive(actor, id, "read");
    if (ws.owner_identity_id !== actor.id) {
      await this.auditWs(actor, "workspace.access.denied", ws, "deny", { op: "read", reason: "not the workspace owner" });
      throw Err.denied("WORKSPACE_FOREIGN", "denied");
    }

    await this.svc.authz.authorize(actor, "project:read", { type: "project", id: ws.project_id });
    const decision = await this.authorizePath(actor, ws, path, "read");
    const rec = await this.svc.engine.byIndex<WorkspaceFileRecord>("workspace_files", "byWorkspace", id);
    const file = rec.find((f) => f.path === decision.normalized);
    if (!file) throw Err.notFound("FILE_NOT_FOUND", `no file at '${decision.normalized}' in this workspace`);
    await this.auditWs(actor, "workspace.file.read", ws, "allow", { path: decision.normalized });
    await this.emitWs("workspace.file.read", ws, { path: decision.normalized });
    return file;
  }

  /** Controlled write with size/count/total limits. Fail closed (BLOCKED). */
  async writeFile(actor: WorkspaceActor, id: string, path: string, content: string): Promise<WorkspaceFileRecord> {
    await this.svc.authz.authorize(actor, "workspace:create", { type: "workspace", id });
    const ws = await this.requireActive(actor, id, "write");
    const decision = await this.authorizePath(actor, ws, path, "write");

    const limits = this.svc.limits;
    const size = content.length;
    if (size > limits.max_file_bytes) {
      await this.auditWs(actor, "workspace.access.denied", ws, "deny", { path: decision.normalized, reason: "file size limit exceeded" });
      throw Err.security("WORKSPACE_LIMIT", `file exceeds the ${limits.max_file_bytes} byte limit`);
    }

    const existing = await this.svc.engine.byIndex<WorkspaceFileRecord>("workspace_files", "byWorkspace", id);
    const current = existing.find((f) => f.path === decision.normalized);
    const projectedCount = current ? ws.file_count : ws.file_count + 1;
    const projectedBytes = ws.total_bytes - (current?.size ?? 0) + size;
    if (projectedCount > limits.max_file_count) {
      await this.auditWs(actor, "workspace.access.denied", ws, "deny", { path: decision.normalized, reason: "file count limit exceeded" });
      throw Err.security("WORKSPACE_LIMIT", `workspace exceeds the ${limits.max_file_count} file limit`);
    }
    if (projectedBytes > limits.max_total_bytes) {
      await this.auditWs(actor, "workspace.access.denied", ws, "deny", { path: decision.normalized, reason: "total workspace size limit exceeded" });
      throw Err.security("WORKSPACE_LIMIT", `workspace exceeds the ${limits.max_total_bytes} byte limit`);
    }

    const now = Date.now();
    const file: WorkspaceFileRecord = {
      id: current?.id ?? nid("wsf"),
      workspace_id: id,
      path: decision.normalized!,
      content,
      size,
      created_at: current?.created_at ?? now,
      updated_at: now,
    };
    await this.svc.engine.put("workspace_files", file.id, file);

    ws.file_count = projectedCount;
    ws.total_bytes = projectedBytes;
    ws.updated_at = now;
    await this.svc.engine.put("workspaces", ws.id, ws);

    await this.auditWs(actor, "workspace.file.write", ws, "allow", { path: decision.normalized, size });
    await this.emitWs("workspace.file.write", ws, { path: decision.normalized, size });
    return file;
  }

  /** Controlled listing — only this workspace's files are ever returned. */
  async listFiles(actor: WorkspaceActor, id: string): Promise<WorkspaceFileRecord[]> {
    await this.svc.authz.authorize(actor, "workspace:read", { type: "workspace", id });
    await this.requireActive(actor, id, "list");
    const files = await this.svc.engine.byIndex<WorkspaceFileRecord>("workspace_files", "byWorkspace", id);
    return files.filter((f) => f.workspace_id === id).sort((a, b) => a.path.localeCompare(b.path));
  }

  async exists(actor: WorkspaceActor, id: string, path: string): Promise<boolean> {
    await this.svc.authz.authorize(actor, "workspace:read", { type: "workspace", id });
    const ws = await this.requireActive(actor, id, "exists");
    const decision = await this.authorizePath(actor, ws, path, "exists");
    const files = await this.svc.engine.byIndex<WorkspaceFileRecord>("workspace_files", "byWorkspace", id);
    return files.some((f) => f.path === decision.normalized);
  }

  /* --------------------------------- internals ----------------------------- */

  private async mustGet(id: string): Promise<WorkspaceRecord> {
    const ws = await this.svc.engine.get<WorkspaceRecord>("workspaces", id);
    if (!ws) throw Err.notFound("WORKSPACE_NOT_FOUND", "workspace not found");
    return ws;
  }

  private isExpired(ws: WorkspaceRecord): boolean {
    return Date.now() > ws.expires_at;
  }

  /** Require an ACTIVE, unexpired workspace owned by (or deletable by) the actor. */
  private async requireActive(actor: WorkspaceActor, id: string, op: string): Promise<WorkspaceRecord> {
    const ws = await this.mustGet(id);

    if (ws.status !== "ACTIVE") {
      await this.auditWs(actor, "workspace.access.denied", ws, "deny", { op, reason: `workspace is ${ws.status}, not ACTIVE` });
      throw Err.security("WORKSPACE_NOT_ACTIVE", `workspace is ${ws.status} — file operations require ACTIVE`);
    }
    if (this.isExpired(ws)) {
      await this.auditWs(actor, "workspace.expired", ws, "deny", { op, reason: "ttl elapsed" });
      await this.emitWs("workspace.expired", ws, { op });
      throw Err.security("WORKSPACE_EXPIRED", "workspace is expired");
    }
    // Ownership: the creating identity, or an identity holding workspace:delete.
    const isOwner = ws.owner_identity_id === actor.id;
    const canDelete = this.svc.authz.decide(actor, "workspace:delete").allowed;
    if (!isOwner && !canDelete) {
      await this.auditWs(actor, "workspace.access.denied", ws, "deny", { op, reason: "not the workspace owner" });
      throw Err.denied("WORKSPACE_FOREIGN", "permission denied: workspace belongs to another execution");
    }
    return ws;
  }

  /** Centralized path authorization: policy decision + deny-audit on refusal. */
  private async authorizePath(actor: WorkspaceActor, ws: WorkspaceRecord, path: string, op: FileOp): Promise<PathDecision> {
    const others = await this.liveWorkspaceIds();
    const decision = this.svc.policy.decide(ws, path, others);
    if (!decision.allowed) {
      await this.auditWs(actor, "workspace.path.blocked", ws, "deny", { op, path, classification: decision.classification, reason: decision.reason });
      await this.emitWs("workspace.path.blocked", ws, { op, classification: decision.classification });
      throw Err.security("PATH_BLOCKED", `permission denied: ${decision.reason}`);
    }
    return decision;
  }

  /** Apply a legal lifecycle transition; reject illegal ones (fail closed). */
  private async transition(actor: WorkspaceActor, id: string, to: WorkspaceStatus): Promise<WorkspaceRecord> {
    const ws = await this.mustGet(id);
    if (!canTransition(ws.status, to)) {
      throw Err.validation("INVALID_WORKSPACE_TRANSITION", `cannot move workspace from ${ws.status} to ${to}`);
    }
    ws.status = to;
    ws.updated_at = Date.now();
    if (to === "DESTROYED") ws.destroyed_at = ws.updated_at;
    await this.svc.engine.put("workspaces", ws.id, ws);
    if (to === "ACTIVE") {
      await this.auditWs(actor, "workspace.activated", ws, "allow", {});
      await this.emitWs("workspace.activated", ws, {});
    }
    return ws;
  }
}

/* ------------------------------ ExecutionSandbox --------------------------- */

/**
 * Browser sandbox. Provides a LOGICAL_BOUNDARY: every operation is confined to
 * the workspace store via FileAccessPolicy. This is NOT OS/container/VM
 * isolation — isolationReport() states that plainly so nothing downstream can
 * claim stronger guarantees than exist.
 */
export class BrowserSandbox implements ExecutionSandbox {
  constructor(private workspaces: WorkspaceService) {}

  isolationReport(): SandboxIsolationReport {
    return {
      kind: "browser",
      available: true,
      boundary: "LOGICAL_BOUNDARY",
      filesystem: "workspace-scoped object store; no host filesystem access; paths confined by FileAccessPolicy",
      process: "single browser runtime — no separate process boundary",
      network: "no network access granted to sandbox operations",
      reason: "OS/container/VM isolation is UNAVAILABLE in a browser runtime; only logical path/store confinement is provided",
    };
  }

  /** Create + activate a sandboxed workspace for one execution. */
  async create(actor: WorkspaceActor, input: { project_id: string; execution_id: string; ttl_ms?: number }): Promise<WorkspaceRecord> {
    return this.workspaces.create(actor, input);
  }

  async prepare(actor: WorkspaceActor, id: string): Promise<WorkspaceRecord> {
    return this.workspaces.activate(actor, id);
  }

  /**
   * Execute a structured, allow-listed file operation. No arbitrary commands:
   * only read/list/exists/write within the workspace. Output is bounded by
   * max_output_bytes and is never silently truncated for security purposes —
   * an over-limit read is BLOCKED.
   */
  async execute(
    actor: WorkspaceActor,
    id: string,
    op: { kind: "list" } | { kind: "read"; path: string } | { kind: "exists"; path: string } | { kind: "write"; path: string; content: string },
  ): Promise<{ output: string; truncated: false }> {
    const limits = this.workspaces["svc"].limits;
    let output: string;
    if (op.kind === "list") {
      const files = await this.workspaces.listFiles(actor, id);
      output = files.map((f) => `${f.path}\t${f.size}`).join("\n");
    } else if (op.kind === "read") {
      const file = await this.workspaces.readFile(actor, id, op.path);
      output = file.content;
    } else if (op.kind === "exists") {
      output = String(await this.workspaces.exists(actor, id, op.path));
    } else {
      const file = await this.workspaces.writeFile(actor, id, op.path, op.content);
      output = `wrote ${file.path} (${file.size} bytes)`;
    }
    if (output.length > limits.max_output_bytes) {
      throw Err.security("OUTPUT_LIMIT", `operation output exceeds the ${limits.max_output_bytes} byte limit (not truncated)`);
    }
    return { output, truncated: false };
  }

  async collectOutput(actor: WorkspaceActor, id: string): Promise<string[]> {
    const files = await this.workspaces.listFiles(actor, id);
    return files.map((f) => f.path);
  }

  async cleanup(actor: WorkspaceActor, id: string): Promise<WorkspaceRecord> {
    return this.workspaces.cleanup(actor, id);
  }

  async destroy(actor: WorkspaceActor, id: string): Promise<WorkspaceRecord> {
    return this.workspaces.destroy(actor, id);
  }
}

