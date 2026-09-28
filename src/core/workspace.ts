/**
 * NEXUS Phase 2 â€” Pass 3: Workspace & sandbox isolation.
 *
 *   WorkspaceService  â€” lifecycle (CREATINGâ†’READYâ†’ACTIVEâ†’CLEANINGâ†’DESTROYED),
 *                       TTL, ownership, idempotent cleanup, honest failure.
 *   FileAccessPolicy  â€” the SINGLE centralized path/containment gate. Every
 *                       file operation routes through it; agents never check
 *                       paths themselves.
 *   ExecutionSandbox  â€” abstraction + BrowserSandbox. This runtime provides a
 *                       LOGICAL_BOUNDARY (path + store confinement), NOT OS/
 *                       container/VM isolation. isolationReport() says so
 *                       explicitly â€” see IsolationBoundary.
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
import { authorizeProject } from "./project-authorization";
import { Err } from "./errors";
import { safeWorkspacePath, type AuthorizationService } from "./security";
import type { AuditService } from "./audit";
import type { ProjectMembershipStore } from "./project-membership-store";
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
  DESTROYED: [], // terminal â€” a destroyed workspace is never reused
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
 * whether the path is inside this workspace's boundary. Pure â€” no side
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
  memberships: ProjectMembershipStore;
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
    await authorizeProject(this.svc, actor, "workspace:create", input.project_id);

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

    // Provisioning is synchronous in this runtime; move CREATING â†’ READY.
    return this.transition(actor, ws.id, "READY");
  }

  async get(actor: WorkspaceActor, id: string): Promise<WorkspaceRecord> {
    const ws = await this.svc.engine.get<WorkspaceRecord>("workspaces", id);
    if (!ws) throw Err.notFound("WORKSPACE_NOT_FOUND", "workspace not found");
    await authorizeProject(this.svc, actor, "workspace:read", ws.project_id);
    return ws;
  }

  /** Activate (READY â†’ ACTIVE). Expired workspaces are BLOCKED, never activated. */
  async activate(actor: WorkspaceActor, id: string): Promise<WorkspaceRecord> {
    const ws = await this.mustGet(id);
    await authorizeProject(this.svc, actor, "workspace:create", ws.project_id);

    if (this.isExpired(ws)) {
      await this.auditWs(actor, "workspace.expired", ws, "deny", { reason: "ttl elapsed before activation" });
      await this.emitWs("workspace.expired", ws, {});
      throw Err.security("WORKSPACE_EXPIRED", "workspace is expired and cannot be activated");
    }
    return this.transition(actor, id, "ACTIVE");
  }

  /**
   * Cleanup: remove all files and move to DESTROYED. IDEMPOTENT â€” cleaning an
   * already-destroyed workspace is a no-op that returns the existing record.
   * A failed cleanup is recorded honestly as FAILED, never swallowed.
   */
  async cleanup(actor: WorkspaceActor, id: string): Promise<WorkspaceRecord> {
    const ws = await this.mustGet(id);
    await authorizeProject(this.svc, actor, "workspace:delete", ws.project_id);

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
      // visible and retryable â€” never pretend cleanup succeeded.
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

  /** Controlled read. Passes identity â†’ authorization â†’ ownership â†’ path policy. */
  async readFile(actor: WorkspaceActor, id: string, path: string): Promise<WorkspaceFileRecord> {
    const ws = await this.requireActive(actor, id, "read");
    await authorizeProject(this.svc, actor, "workspace:read", ws.project_id);
    if (ws.owner_identity_id !== actor.id) {
      await this.auditWs(actor, "workspace.access.denied", ws, "deny", { op: "read", reason: "not the workspace owner" });
      throw Err.denied("WORKSPACE_FOREIGN", "denied");
    }

    await authorizeProject(this.svc, actor, "project:read", ws.project_id);
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
    const ws = await this.requireActive(actor, id, "write");
    await authorizeProject(this.svc, actor, "workspace:create", ws.project_id);
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

  /** Controlled listing â€” only this workspace's files are ever returned. */
  async listFiles(actor: WorkspaceActor, id: string): Promise<WorkspaceFileRecord[]> {
    const ws = await this.requireActive(actor, id, "list");
    await authorizeProject(this.svc, actor, "workspace:read", ws.project_id);
    const files = await this.svc.engine.byIndex<WorkspaceFileRecord>("workspace_files", "byWorkspace", id);
    return files.filter((f) => f.workspace_id === id).sort((a, b) => a.path.localeCompare(b.path));
  }

  async exists(actor: WorkspaceActor, id: string, path: string): Promise<boolean> {
    const ws = await this.requireActive(actor, id, "exists");
    await authorizeProject(this.svc, actor, "workspace:read", ws.project_id);
    const decision = await this.authorizePath(actor, ws, path, "exists");
    const files = await this.svc.engine.byIndex<WorkspaceFileRecord>("workspace_files", "byWorkspace", id);
    return files.some((f) => f.path === decision.normalized);
  }

  /* ---------------------- Phase 217: atomic file operations ---------------- */

  /**
   * Delete a file from an ACTIVE workspace. Idempotent-safe: returns
   * `deleted: false` if the file did not exist. Limits counters are adjusted
   * downward. Path still goes through FileAccessPolicy.
   */
  async deleteFile(
    actor: WorkspaceActor,
    id: string,
    path: string,
  ): Promise<{ deleted: boolean; path: string }> {
    const ws = await this.requireActive(actor, id, "delete");
    await authorizeProject(this.svc, actor, "workspace:create", ws.project_id);
    const decision = await this.authorizePath(actor, ws, path, "write");
    const files = await this.svc.engine.byIndex<WorkspaceFileRecord>("workspace_files", "byWorkspace", id);
    const existing = files.find((f) => f.path === decision.normalized);
    if (!existing) {
      await this.auditWs(actor, "workspace.file.delete", ws, "info", { path: decision.normalized, deleted: false });
      return { deleted: false, path: decision.normalized! };
    }
    await this.svc.engine.del("workspace_files", existing.id);
    ws.file_count = Math.max(0, ws.file_count - 1);
    ws.total_bytes = Math.max(0, ws.total_bytes - existing.size);
    ws.updated_at = Date.now();
    await this.svc.engine.put("workspaces", ws.id, ws);
    await this.auditWs(actor, "workspace.file.delete", ws, "allow", { path: decision.normalized, size: existing.size });
    await this.emitWs("workspace.file.write", ws, { path: decision.normalized, deleted: true });
    return { deleted: true, path: decision.normalized! };
  }

  /**
   * Rename a file within the same workspace. Source and destination both pass
   * FileAccessPolicy. Fails closed if the source is missing or the destination
   * already exists. Size/count limits are unchanged by a rename.
   */
  async renameFile(
    actor: WorkspaceActor,
    id: string,
    from: string,
    to: string,
  ): Promise<{ renamed: boolean; from: string; to: string }> {
    const ws = await this.requireActive(actor, id, "rename");
    await authorizeProject(this.svc, actor, "workspace:create", ws.project_id);
    const fromDecision = await this.authorizePath(actor, ws, from, "write");
    const toDecision = await this.authorizePath(actor, ws, to, "write");
    const files = await this.svc.engine.byIndex<WorkspaceFileRecord>("workspace_files", "byWorkspace", id);
    const source = files.find((f) => f.path === fromDecision.normalized);
    const collision = files.find((f) => f.path === toDecision.normalized);
    if (!source) throw Err.notFound("FILE_NOT_FOUND", `rename source not found: '${fromDecision.normalized}'`);
    if (collision) throw Err.validation("FILE_EXISTS", `rename destination already exists: '${toDecision.normalized}'`);
    const renamed: WorkspaceFileRecord = {
      ...source,
      path: toDecision.normalized!,
      updated_at: Date.now(),
    };
    await this.svc.engine.put("workspace_files", renamed.id, renamed);
    ws.updated_at = Date.now();
    await this.svc.engine.put("workspaces", ws.id, ws);
    await this.auditWs(actor, "workspace.file.rename", ws, "allow", { from: fromDecision.normalized, to: toDecision.normalized });
    await this.emitWs("workspace.file.write", ws, { from: fromDecision.normalized, to: toDecision.normalized, renamed: true });
    return { renamed: true, from: fromDecision.normalized!, to: toDecision.normalized! };
  }

  /**
   * Phase 217: apply a batch of file operations ATOMICALLY at the validation
   * boundary.
   *
   * Guarantee: every operation, every path, every conflict, and every limit
   * is validated against a projected in-memory state BEFORE any write reaches
   * the store. If any step fails, NO file is mutated.
   *
   * Persistence-after-validation: the underlying engine exposes per-key
   * put/del with no cross-key transaction primitive. A mid-flush engine
   * failure is therefore surfaced honestly (thrown) and the caller must treat
   * the workspace as suspect; this method does not fabricate transactional
   * rollback it cannot provide.
   */
  async applyFileOperations(
    actor: WorkspaceActor,
    id: string,
    ops: ReadonlyArray<
      | { kind: "CREATE"; path: string; content: string }
      | { kind: "UPDATE"; path: string; content: string }
      | { kind: "DELETE"; path: string }
      | { kind: "RENAME"; from: string; to: string }
    >,
  ): Promise<{ applied: number; affected: string[] }> {
    const ws = await this.requireActive(actor, id, "apply");
    await authorizeProject(this.svc, actor, "workspace:create", ws.project_id);

    const limits = this.svc.limits;
    const files = await this.svc.engine.byIndex<WorkspaceFileRecord>("workspace_files", "byWorkspace", id);

    type Projected = { id: string | null; path: string; content: string; size: number; created_at: number };
    const byPath = new Map<string, Projected>();
    for (const f of files) {
      byPath.set(f.path, { id: f.id, path: f.path, content: f.content, size: f.size, created_at: f.created_at });
    }

    const affected = new Set<string>();
    const now = Date.now();

    // ---------- Phase 1: validate every operation against the projection ----
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];

      // 1a. Path policy gate (rejects traversal / absolute / foreign / encoded).
      if (op.kind === "RENAME") {
        await this.authorizePath(actor, ws, op.from, "write");
        await this.authorizePath(actor, ws, op.to, "write");
      } else {
        await this.authorizePath(actor, ws, op.path, "write");
      }

      // 1b. Semantic validation against projected state.
      switch (op.kind) {
        case "CREATE": {
          if (byPath.has(op.path)) {
            throw Err.validation("IMPL_CREATE_EXISTS", `CREATE of existing path: '${op.path}'`);
          }
          if (op.content.length > limits.max_file_bytes) {
            throw Err.security("WORKSPACE_LIMIT", `file exceeds ${limits.max_file_bytes} byte limit: '${op.path}'`);
          }
          byPath.set(op.path, { id: null, path: op.path, content: op.content, size: op.content.length, created_at: now });
          affected.add(op.path);
          break;
        }
        case "UPDATE": {
          const cur = byPath.get(op.path);
          if (!cur) throw Err.notFound("IMPL_UPDATE_MISSING", `UPDATE of missing path: '${op.path}'`);
          if (op.content.length > limits.max_file_bytes) {
            throw Err.security("WORKSPACE_LIMIT", `file exceeds ${limits.max_file_bytes} byte limit: '${op.path}'`);
          }
          byPath.set(op.path, { ...cur, content: op.content, size: op.content.length });
          affected.add(op.path);
          break;
        }
        case "DELETE": {
          const cur = byPath.get(op.path);
          if (!cur) throw Err.notFound("IMPL_DELETE_MISSING", `DELETE of missing path: '${op.path}'`);
          byPath.delete(op.path);
          affected.add(op.path);
          break;
        }
        case "RENAME": {
          const cur = byPath.get(op.from);
          if (!cur) throw Err.notFound("IMPL_RENAME_MISSING", `RENAME source missing: '${op.from}'`);
          if (byPath.has(op.to)) {
            throw Err.validation("IMPL_RENAME_EXISTS", `RENAME target already exists: '${op.to}'`);
          }
          byPath.delete(op.from);
          byPath.set(op.to, { ...cur, path: op.to });
          affected.add(op.from);
          affected.add(op.to);
          break;
        }
      }
    }

    // ---------- Phase 2: aggregate resource limits --------------------------
    let totalBytes = 0;
    for (const p of byPath.values()) totalBytes += p.size;
    if (byPath.size > limits.max_file_count) {
      throw Err.security("WORKSPACE_LIMIT", `workspace would exceed ${limits.max_file_count} file limit`);
    }
    if (totalBytes > limits.max_total_bytes) {
      throw Err.security("WORKSPACE_LIMIT", `workspace would exceed ${limits.max_total_bytes} byte limit`);
    }

    // ---------- Phase 3: apply. Validation has already succeeded. -----------
    const originalById = new Map(files.map((f) => [f.id, f]));
    const projectedIds = new Set<string>();

    for (const p of byPath.values()) {
      if (p.id) {
        const orig = originalById.get(p.id);
        if (!orig) {
          // The projection references a file id that no longer exists.
          throw new Error(`workspace projection inconsistency: file id ${p.id} not found`);
        }
        if (orig.path !== p.path || orig.content !== p.content) {
          const updated: WorkspaceFileRecord = {
            ...orig,
            path: p.path,
            content: p.content,
            size: p.size,
            updated_at: now,
          };
          await this.svc.engine.put("workspace_files", updated.id, updated);
        }
        projectedIds.add(p.id);
      } else {
        const newId = nid("wsf");
        const record: WorkspaceFileRecord = {
          id: newId,
          workspace_id: id,
          path: p.path,
          content: p.content,
          size: p.size,
          created_at: now,
          updated_at: now,
        };
        await this.svc.engine.put("workspace_files", newId, record);
        projectedIds.add(newId);
      }
    }

    for (const f of files) {
      if (!projectedIds.has(f.id)) {
        await this.svc.engine.del("workspace_files", f.id);
      }
    }

    ws.file_count = byPath.size;
    ws.total_bytes = totalBytes;
    ws.updated_at = now;
    await this.svc.engine.put("workspaces", ws.id, ws);

    await this.auditWs(actor, "workspace.file.apply", ws, "allow", {
      ops: ops.length,
      affected: affected.size,
    });
    await this.emitWs("workspace.file.write", ws, { ops: ops.length, affected: affected.size });

    return { applied: ops.length, affected: [...affected].sort() };
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
      throw Err.security("WORKSPACE_NOT_ACTIVE", `workspace is ${ws.status} â€” file operations require ACTIVE`);
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
 * isolation â€” isolationReport() states that plainly so nothing downstream can
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
      process: "single browser runtime â€” no separate process boundary",
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
   * max_output_bytes and is never silently truncated for security purposes â€”
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

