// src/core/implementation-contracts.ts
// Phase 217: deterministic implementation specification contract.
//
// An ImplementationSpec is the AI provider's structured proposal for how to
// change an isolated workspace. It is UNTRUSTED INPUT until it has passed
// implementation-validator.ts. No field on this contract may be executed as
// a shell command. All mutation flows through WorkspaceService.

import { createHash } from "node:crypto";

export type FileOperationKind = "CREATE" | "UPDATE" | "DELETE" | "RENAME";

export interface CreateOp { kind: "CREATE"; path: string; content: string; }
export interface UpdateOp { kind: "UPDATE"; path: string; content: string; }
export interface DeleteOp { kind: "DELETE"; path: string; }
export interface RenameOp { kind: "RENAME"; from: string; to: string; }

export type FileOperation = CreateOp | UpdateOp | DeleteOp | RenameOp;

export type ImplementationStatus =
  | "PROPOSED"
  | "VALIDATED"
  | "INVALID"
  | "APPLIED"
  | "FAILED"
  | "BLOCKED";

export interface ImplementationSpec {
  implementationId: string;
  runId: string;
  workspaceId: string;
  planId: string;
  architectureId: string;
  providerId: string;
  model: string;
  requestHash: string;
  contentHash: string;
  operations: FileOperation[];
  status: ImplementationStatus;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Provider-side shape (no ids, no hash, no status — those are assigned by NEXUS). */
export interface ImplementationProposal {
  operations: FileOperation[];
  summary?: string;
}

export interface ImplementationValidationIssue {
  code: string;
  message: string;
  operationIndex?: number;
}

export interface ImplementationValidationResult {
  valid: boolean;
  issues: ImplementationValidationIssue[];
}

/**
 * Canonical serialization. Deterministic across process runs:
 *  - operations are sorted by (kind, path) so an equal logical set hashes equal
 *  - file contents are hashed, not embedded in the digest input
 *  - no timestamps, no ids, no provider metadata enter the canonical form
 */
export function canonicalizeOperations(ops: readonly FileOperation[]): string {
  const normalized = ops.map((op) => {
    switch (op.kind) {
      case "CREATE":
      case "UPDATE":
        return { kind: op.kind, path: op.path, contentHash: sha256Hex(op.content) };
      case "DELETE":
        return { kind: "DELETE", path: op.path };
      case "RENAME":
        return { kind: "RENAME", from: op.from, to: op.to };
    }
  });
  normalized.sort((a, b) => {
    const ak = a.kind + "|" + ("path" in a ? a.path : (a as any).from);
    const bk = b.kind + "|" + ("path" in b ? b.path : (b as any).from);
    return ak.localeCompare(bk);
  });
  return JSON.stringify(normalized);
}

export function computeImplementationContentHash(ops: readonly FileOperation[]): string {
  return sha256Hex(canonicalizeOperations(ops));
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function isFileOperation(v: unknown): v is FileOperation {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  switch (o.kind) {
    case "CREATE":
    case "UPDATE":
      return typeof o.path === "string" && typeof o.content === "string";
    case "DELETE":
      return typeof o.path === "string";
    case "RENAME":
      return typeof o.from === "string" && typeof o.to === "string";
    default:
      return false;
  }
}