// src/core/implementation-validator.ts
// Phase 217: deterministic validator for AI-proposed ImplementationSpec.
//
// Pure. No side effects. No throws on invalid input — always returns a
// structured ImplementationValidationResult so callers can distinguish
// INVALID (bad proposal) from BLOCKED (runtime prerequisite missing).
//
// The proposal is UNTRUSTED input. This validator runs BEFORE any file is
// mutated and is the sole mechanism by which an unvalidated proposal may
// reach WorkspaceService.applyFileOperations.
//
// Conflict rule (canonical, used here and mirrored by applyFileOperations):
//   Each path may be the primary target of AT MOST ONE operation.
//     - CREATE/UPDATE/DELETE target `path`
//     - RENAME targets BOTH `from` and `to`
//   This rejects, e.g.:
//     CREATE x + CREATE x
//     DELETE x + UPDATE x
//     RENAME a->b + CREATE b
//     RENAME a->b + RENAME b->c
//   in a single deterministic pass without needing to simulate ordering.
//
// Determinism: the validator does not depend on wall-clock time, iteration
// order of maps, or randomness. Same input -> same issues (sorted).

import {
  type FileOperation,
  type ImplementationProposal,
  type ImplementationValidationIssue,
  type ImplementationValidationResult,
  isFileOperation,
} from "./implementation-contracts";
import {
  validateFileOperationPath,
  validateForbiddenPath,
} from "./implementation-path-security";

export interface WorkspaceLimitsForValidation {
  max_file_bytes: number;
  max_total_bytes: number;
  max_file_count: number;
}

export interface ValidationContext {
  /** Paths currently present in the target workspace. */
  existingPaths: ReadonlySet<string>;
  limits: WorkspaceLimitsForValidation;
  /** Optional cap on total operations in one proposal. */
  maxOperations?: number;
}

const DEFAULT_MAX_OPS = 500;

function issue(
  code: string,
  message: string,
  operationIndex?: number,
): ImplementationValidationIssue {
  return operationIndex === undefined
    ? { code, message }
    : { code, message, operationIndex };
}

function sortIssues(issues: ImplementationValidationIssue[]): ImplementationValidationIssue[] {
  return issues.slice().sort((a, b) => {
    const ai = a.operationIndex ?? -1;
    const bi = b.operationIndex ?? -1;
    if (ai !== bi) return ai - bi;
    return a.code.localeCompare(b.code);
  });
}

/**
 * Validate a proposal. Returns a result whose `issues` list is deterministic
 * for a given input.
 */
export function validateImplementationProposal(
  proposal: unknown,
  ctx: ValidationContext,
): ImplementationValidationResult {
  const issues: ImplementationValidationIssue[] = [];

  // ---------- shape ----------
  if (!proposal || typeof proposal !== "object") {
    return {
      valid: false,
      issues: [issue("PROPOSAL_NOT_OBJECT", "proposal must be an object")],
    };
  }
  const p = proposal as Record<string, unknown>;
  if (!Array.isArray(p.operations)) {
    return {
      valid: false,
      issues: [issue("PROPOSAL_OPERATIONS_MISSING", "proposal.operations must be an array")],
    };
  }
  const rawOps = p.operations as unknown[];
  if (rawOps.length === 0) {
    issues.push(issue("PROPOSAL_EMPTY", "proposal contains no operations"));
  }
  const maxOps = ctx.maxOperations ?? DEFAULT_MAX_OPS;
  if (rawOps.length > maxOps) {
    issues.push(issue("PROPOSAL_TOO_MANY_OPS", `proposal exceeds ${maxOps} operations`));
  }

  // ---------- per-op structural + path + policy ----------
  const typedOps: FileOperation[] = [];
  for (let i = 0; i < rawOps.length; i++) {
    const raw = rawOps[i];
    if (!isFileOperation(raw)) {
      issues.push(issue("OP_MALFORMED", "operation does not match a known shape", i));
      continue;
    }
    const op = raw as FileOperation;

    // Path security for the relevant paths.
    const paths: Array<{ label: string; value: string }> =
      op.kind === "RENAME"
        ? [{ label: "from", value: op.from }, { label: "to", value: op.to }]
        : [{ label: "path", value: op.path }];

    for (const { label, value } of paths) {
      const rej = validateFileOperationPath(value);
      if (rej) {
        issues.push(issue(rej.code, `${label}: ${rej.reason}`, i));
        continue;
      }
      const forbidden = validateForbiddenPath(value);
      if (forbidden) {
        issues.push(issue(forbidden.code, `${label}: ${forbidden.reason}`, i));
      }
    }

    // Per-file size (CREATE/UPDATE only).
    if (op.kind === "CREATE" || op.kind === "UPDATE") {
      if (op.content.length > ctx.limits.max_file_bytes) {
        issues.push(issue(
          "OP_FILE_TOO_LARGE",
          `content ${op.content.length} bytes exceeds per-file limit ${ctx.limits.max_file_bytes}`,
          i,
        ));
      }
    }

    typedOps.push(op);
  }

  // ---------- cross-op conflict detection ----------
  // Each path may be primary target of at most one op.
  const targetedBy = new Map<string, number[]>();
  const addTarget = (path: string, index: number): void => {
    const arr = targetedBy.get(path);
    if (arr) arr.push(index);
    else targetedBy.set(path, [index]);
  };
  for (let i = 0; i < typedOps.length; i++) {
    const op = typedOps[i];
    if (op.kind === "RENAME") {
      addTarget(op.from, i);
      addTarget(op.to, i);
    } else {
      addTarget(op.path, i);
    }
  }
  for (const [path, indices] of targetedBy) {
    if (indices.length > 1) {
      issues.push(issue(
        "OP_PATH_CONFLICT",
        `path '${path}' is targeted by ${indices.length} operations (indices ${indices.join(", ")})`,
        indices[0],
      ));
    }
  }

  // ---------- referential integrity against the workspace snapshot ----------
  // We evaluate in declaration order against a simulated projection, but only
  // to detect referential errors — cross-op conflict detection above has
  // already rejected ambiguous multi-target paths.
  const projected = new Set<string>(ctx.existingPaths);
  for (let i = 0; i < typedOps.length; i++) {
    const op = typedOps[i];
    switch (op.kind) {
      case "CREATE": {
        if (projected.has(op.path)) {
          issues.push(issue("OP_CREATE_EXISTS", `CREATE of already-existing path '${op.path}'`, i));
        }
        projected.add(op.path);
        break;
      }
      case "UPDATE": {
        if (!projected.has(op.path)) {
          issues.push(issue("OP_UPDATE_MISSING", `UPDATE of missing path '${op.path}'`, i));
        }
        break;
      }
      case "DELETE": {
        if (!projected.has(op.path)) {
          issues.push(issue("OP_DELETE_MISSING", `DELETE of missing path '${op.path}'`, i));
        }
        projected.delete(op.path);
        break;
      }
      case "RENAME": {
        if (!projected.has(op.from)) {
          issues.push(issue("OP_RENAME_MISSING", `RENAME source '${op.from}' does not exist`, i));
        }
        if (projected.has(op.to)) {
          issues.push(issue("OP_RENAME_EXISTS", `RENAME target '${op.to}' already exists`, i));
        }
        projected.delete(op.from);
        projected.add(op.to);
        break;
      }
    }
  }

  // ---------- aggregate limits on the projected state ----------
  // Sizes are only known for files whose content we can see. For pre-existing
  // files we don't receive content, so total-bytes is enforced only on the
  // delta. WorkspaceService re-enforces the exact total before mutation.
  let projectedCount = projected.size;
  if (projectedCount > ctx.limits.max_file_count) {
    issues.push(issue(
      "AGG_FILE_COUNT",
      `projected file count ${projectedCount} exceeds limit ${ctx.limits.max_file_count}`,
    ));
  }
  let deltaBytes = 0;
  for (const op of typedOps) {
    if (op.kind === "CREATE" || op.kind === "UPDATE") deltaBytes += op.content.length;
  }
  if (deltaBytes > ctx.limits.max_total_bytes) {
    issues.push(issue(
      "AGG_BYTES_DELTA",
      `proposal writes ${deltaBytes} bytes, exceeding total workspace limit ${ctx.limits.max_total_bytes}`,
    ));
  }

  return { valid: issues.length === 0, issues: sortIssues(issues) };
}

/**
 * Convenience: parse a structured-output payload into a proposal. Returns
 * `null` if the payload is not shaped like a proposal. Never throws.
 */
export function parseProposalFromStructuredOutput(structuredOutput: unknown): ImplementationProposal | null {
  if (!structuredOutput || typeof structuredOutput !== "object") return null;
  const so = structuredOutput as Record<string, unknown>;
  if (!Array.isArray(so.operations)) return null;
  return {
    operations: so.operations as FileOperation[],
    summary: typeof so.summary === "string" ? so.summary : undefined,
  };
}