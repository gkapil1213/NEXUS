// src/core/execution-audit-provenance-service.ts
//
// Phase 167 - production audit / provenance control-plane service.
//
// Read-only service boundary over Phase 165/166 durable outcome provenance.
// Every method: validate input -> authorize -> read through ExecutionStore
// -> record AuditService entry -> return controlled DTO.
//
// SCOPE LIMITATION (reported honestly, not faked):
//   NEXUS has NO user<->project membership model and no per-resource
//   authorization. can(actor, permission) is a global role->permission
//   matrix; its _resource parameter is unused. Cross-project isolation
//   (Phase 167 sections 4/5/14.B/14.H) is therefore NOT implemented.
//   This service enforces a single global audit:read permission.

import { can } from "./security";
import { Err } from "./errors";
import type { AuditService } from "./audit";
import type { ExecutionAuditStore } from "./execution-store";
import type {
  ExecutionOutcomeProvenance,
  ExecutionJobStatus,
} from "./execution-models";

export type ProvenanceView = ExecutionOutcomeProvenance;

export interface RetryLineageView {
  jobId: string;
  steps: Array<{
    provenanceId: string;
    attemptId: string;
    attemptNumber: number;
    outcome: ExecutionJobStatus;
    predecessorAttemptId: string | null;
  }>;
}

export interface VerificationView {
  status: "verified" | "hash_mismatch" | "not_found";
  provenanceId: string | null;
  expected: string | null;
  actual: string | null;
}

export interface PageView<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export const AUDIT_PAGE_DEFAULT = 25;
export const AUDIT_PAGE_MAX = 100;

export interface AuditActor {
  id: string;
  email: string;
  role: string;
  status: string;
}

interface Cursor {
  terminalizedAt: number;
  provenanceId: string;
}

function encodeCursor(c: Cursor): string {
  const json = JSON.stringify({ t: c.terminalizedAt, p: c.provenanceId });
  return Buffer.from(json, "utf8").toString("base64url");
}

function decodeCursor(s: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
  } catch {
    throw Err.validation("INVALID_CURSOR", "cursor is not a valid opaque token");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as any).t !== "number" ||
    typeof (parsed as any).p !== "string" ||
    (parsed as any).p.length === 0 ||
    (parsed as any).p.length > 256
  ) {
    throw Err.validation("INVALID_CURSOR", "cursor contents are malformed");
  }
  return { terminalizedAt: (parsed as any).t, provenanceId: (parsed as any).p };
}

function validateIdentifier(value: string, field: string, maxLen = 256): string {
  if (typeof value !== "string") {
    throw Err.validation("INVALID_IDENTIFIER", field + " must be a string");
  }
  const t = value.trim();
  if (t.length === 0 || t.length > maxLen) {
    throw Err.validation("INVALID_IDENTIFIER", field + " length out of range");
  }
  if (!/^[A-Za-z0-9._:\-]+$/.test(t)) {
    throw Err.validation("INVALID_IDENTIFIER", field + " contains disallowed characters");
  }
  return t;
}

function validateLimit(limit: number | undefined): number {
  if (limit === undefined) return AUDIT_PAGE_DEFAULT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw Err.validation("INVALID_LIMIT", "limit must be a positive integer");
  }
  if (limit > AUDIT_PAGE_MAX) {
    throw Err.validation("INVALID_LIMIT", "limit must be <= " + AUDIT_PAGE_MAX);
  }
  return limit;
}

export class ExecutionAuditProvenanceService {
  constructor(
    private readonly store: ExecutionAuditStore,
    private readonly audit: AuditService,
  ) {}

  private async authorize(
    actor: AuditActor,
    action: string,
    resourceType: string,
    resourceId: string,
  ): Promise<void> {
    if (!can(actor as any, "audit:read")) {
      await this.audit.record({
        actor: actor.email,
        action: "audit:denied:" + action,
        resource_type: resourceType,
        resource_id: resourceId,
        result: "deny",
        metadata: { role: actor.role, reason: "missing audit:read" },
      });
      throw Err.denied("AUDIT_READ_DENIED", "role '" + actor.role + "' does not hold 'audit:read'");
    }
  }

  private async recordAccess(
    actor: AuditActor,
    action: string,
    resourceType: string,
    resourceId: string,
    outcome: "ok" | "not_found" | "integrity_failure" | "hash_mismatch",
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await this.audit.record({
      actor: actor.email,
      action: "audit:" + action,
      resource_type: resourceType,
      resource_id: resourceId,
      result: "allow",
      metadata: { role: actor.role, outcome, ...metadata },
    });
  }

  async getProvenanceById(actor: AuditActor, provenanceId: string): Promise<ProvenanceView> {
    const id = validateIdentifier(provenanceId, "provenanceId");
    await this.authorize(actor, "read:provenance", "provenance", id);
    const res = this.store.queryProvenanceById(id);
    if (res.kind === "not_found") {
      await this.recordAccess(actor, "read:provenance", "provenance", id, "not_found");
      throw Err.notFound("PROVENANCE_NOT_FOUND", "provenance record not found");
    }
    if (res.kind === "integrity_failure") {
      await this.recordAccess(actor, "read:provenance", "provenance", id, "integrity_failure", { failureKind: res.failure.kind });
      throw Err.integrity("PROVENANCE_INTEGRITY_FAILURE", "provenance failed consistency checks");
    }
    await this.recordAccess(actor, "read:provenance", "provenance", id, "ok");
    return res.record;
  }

  async getProvenanceByAttempt(actor: AuditActor, attemptId: string): Promise<ProvenanceView> {
    const id = validateIdentifier(attemptId, "attemptId");
    await this.authorize(actor, "read:attempt", "attempt", id);
    const res = this.store.queryProvenanceByAttempt(id);
    if (res.kind === "not_found") {
      await this.recordAccess(actor, "read:attempt", "attempt", id, "not_found");
      throw Err.notFound("PROVENANCE_NOT_FOUND", "provenance for attempt not found");
    }
    if (res.kind === "integrity_failure") {
      await this.recordAccess(actor, "read:attempt", "attempt", id, "integrity_failure", { failureKind: res.failure.kind });
      throw Err.integrity("PROVENANCE_INTEGRITY_FAILURE", "provenance failed consistency checks");
    }
    await this.recordAccess(actor, "read:attempt", "attempt", id, "ok");
    return res.record;
  }

  async getProvenanceByRecoveryOperation(actor: AuditActor, recoveryOperationId: string): Promise<ProvenanceView> {
    const id = validateIdentifier(recoveryOperationId, "recoveryOperationId");
    await this.authorize(actor, "read:recovery_operation", "recovery_operation", id);
    const res = this.store.queryProvenanceByRecoveryOperation(id);
    if (res.kind === "not_found") {
      await this.recordAccess(actor, "read:recovery_operation", "recovery_operation", id, "not_found");
      throw Err.notFound("PROVENANCE_NOT_FOUND", "provenance for recovery operation not found");
    }
    if (res.kind === "integrity_failure") {
      await this.recordAccess(actor, "read:recovery_operation", "recovery_operation", id, "integrity_failure", { failureKind: res.failure.kind });
      throw Err.integrity("PROVENANCE_INTEGRITY_FAILURE", "provenance failed consistency checks");
    }
    await this.recordAccess(actor, "read:recovery_operation", "recovery_operation", id, "ok");
    return res.record;
  }

  async getProvenanceByJob(
    actor: AuditActor,
    jobId: string,
    options: { limit?: number; cursor?: string | null } = {},
  ): Promise<PageView<ProvenanceView>> {
    const id = validateIdentifier(jobId, "jobId");
    const limit = validateLimit(options.limit);
    const cursor = options.cursor ? decodeCursor(options.cursor) : null;
    await this.authorize(actor, "read:job", "job", id);
    const page = this.store.pageProvenanceByJob(id, limit, cursor);
    if (page.kind === "integrity_failure") {
      await this.recordAccess(actor, "read:job", "job", id, "integrity_failure", { failureKind: page.failure.kind });
      throw Err.integrity("PROVENANCE_INTEGRITY_FAILURE", "provenance failed consistency checks");
    }
    await this.recordAccess(actor, "read:job", "job", id, "ok", { returned: page.records.length, hasMore: page.hasMore });
    let nextCursor: string | null = null;
    if (page.hasMore && page.records.length > 0) {
      const last = page.records[page.records.length - 1];
      nextCursor = encodeCursor({ terminalizedAt: last.terminalizedAt, provenanceId: last.provenanceId });
    }
    return { items: page.records, nextCursor, hasMore: page.hasMore };
  }

  async getRetryLineage(actor: AuditActor, jobId: string): Promise<RetryLineageView> {
    const id = validateIdentifier(jobId, "jobId");
    await this.authorize(actor, "read:retry_lineage", "job", id);
    const res = this.store.queryRetryLineage(id);
    if (res.kind === "integrity_failure") {
      await this.recordAccess(actor, "read:retry_lineage", "job", id, "integrity_failure", { failureKind: res.failure.kind });
      throw Err.integrity("PROVENANCE_INTEGRITY_FAILURE", "provenance failed consistency checks");
    }
    await this.recordAccess(actor, "read:retry_lineage", "job", id, "ok", { steps: res.steps.length });
    return {
      jobId: id,
      steps: res.steps.map((s) => ({
        provenanceId: s.provenance.provenanceId,
        attemptId: s.provenance.attemptId,
        attemptNumber: s.provenance.attemptNumber,
        outcome: s.provenance.outcome,
        predecessorAttemptId: s.predecessorAttemptId,
      })),
    };
  }

  async verifyByAttempt(actor: AuditActor, attemptId: string): Promise<VerificationView> {
    const id = validateIdentifier(attemptId, "attemptId");
    await this.authorize(actor, "verify:attempt", "attempt", id);
    const res = this.store.verifyProvenanceByAttempt(id);
    if (res.kind === "not_found") {
      await this.recordAccess(actor, "verify:attempt", "attempt", id, "not_found");
      return { status: "not_found", provenanceId: null, expected: null, actual: null };
    }
    if (res.kind === "verified") {
      await this.recordAccess(actor, "verify:attempt", "attempt", id, "ok");
      return { status: "verified", provenanceId: id, expected: null, actual: null };
    }
    await this.recordAccess(actor, "verify:attempt", "attempt", id, "hash_mismatch");
    return { status: "hash_mismatch", provenanceId: id, expected: res.expected, actual: res.actual };
  }

  async verifyById(actor: AuditActor, provenanceId: string): Promise<VerificationView> {
    const id = validateIdentifier(provenanceId, "provenanceId");
    await this.authorize(actor, "verify:provenance", "provenance", id);
    const res = this.store.verifyProvenanceById(id);
    if (res.kind === "not_found") {
      await this.recordAccess(actor, "verify:provenance", "provenance", id, "not_found");
      return { status: "not_found", provenanceId: null, expected: null, actual: null };
    }
    if (res.kind === "verified") {
      await this.recordAccess(actor, "verify:provenance", "provenance", id, "ok");
      return { status: "verified", provenanceId: id, expected: null, actual: null };
    }
    await this.recordAccess(actor, "verify:provenance", "provenance", id, "hash_mismatch");
    return { status: "hash_mismatch", provenanceId: id, expected: res.expected, actual: res.actual };
  }
}