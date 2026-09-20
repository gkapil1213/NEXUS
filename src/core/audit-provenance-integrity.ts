// src/core/audit-provenance-integrity.ts
//
// Phase 166 - durable execution audit trail & provenance query integrity.
//
// This module is PURE. It never writes to the database, never mutates a
// stored provenance record, and never repairs a corrupt row. It
// reconstructs the exact Phase 165 evidence-hash payload and returns a
// deterministic verdict.
//
// Phase 165 write path (execution-store.ts, inside the terminalize
// transaction) computed the evidence hash as:
//
//   const evidenceHash = sha256(JSON.stringify({
//     outcome: input.attemptStatus,
//     previous_state: attemptBefore.status,
//     attempt_id: input.attemptId,
//     evidence_json: evidenceJson,
//     terminalized_at: terminalizedAt,
//   }));
//
// Note: this is plain JSON.stringify on an object literal, NOT
// canonicalize(). Key order is significant and MUST be preserved exactly.
// Do not switch to canonicalize() - that would reorder keys and invalidate
// every historical hash.

import { sha256 } from "./sha256";
import type {
  ExecutionAttempt,
  ExecutionOutcomeProvenance,
} from "./execution-models";

export type ProvenanceIntegrityFailureKind =
  | "hash_mismatch"
  | "source_attempt_missing"
  | "source_attempt_job_mismatch"
  | "source_attempt_id_mismatch"
  | "source_attempt_number_mismatch"
  | "source_attempt_outcome_mismatch"
  | "malformed_evidence_json"
  | "predecessor_not_in_job"
  | "predecessor_attempt_number_not_less"
  | "predecessor_cycle";

export interface ProvenanceIntegrityFailure {
  provenanceId: string;
  kind: ProvenanceIntegrityFailureKind;
  detail?: unknown;
}

export type ProvenanceVerificationResult =
  | { kind: "verified" }
  | { kind: "hash_mismatch"; expected: string; actual: string };

export type ProvenanceQueryResult =
  | { kind: "ok"; record: ExecutionOutcomeProvenance }
  | { kind: "not_found" }
  | { kind: "integrity_failure"; failure: ProvenanceIntegrityFailure };

export interface RetryLineageStep {
  provenance: ExecutionOutcomeProvenance;
  predecessorAttemptId: string | null;
}

export type RetryLineageResult =
  | { kind: "ok"; steps: RetryLineageStep[] }
  | { kind: "integrity_failure"; failure: ProvenanceIntegrityFailure };

/**
 * Reconstruct the exact Phase 165 evidence-hash payload and return the hash.
 *
 * Inputs are raw column values as stored:
 *   outcome        - provenance.outcome
 *   previousState  - provenance.previous_state
 *   attemptId      - provenance.attempt_id
 *   evidenceJson   - provenance.evidence_json (raw string, may be null)
 *   terminalizedAt - provenance.terminalized_at (integer)
 */
export function reconstructPhase165EvidenceHash(input: {
  outcome: string;
  previousState: string;
  attemptId: string;
  evidenceJson: string | null;
  terminalizedAt: number;
}): string {
  const payload = JSON.stringify({
    outcome: input.outcome,
    previous_state: input.previousState,
    attempt_id: input.attemptId,
    evidence_json: input.evidenceJson,
    terminalized_at: input.terminalizedAt,
  });
  return sha256(payload);
}

/**
 * Verify a stored provenance record's evidence hash against its own
 * immutable fields.
 *
 * `rawEvidenceJson` MUST be the value of the evidence_json column exactly
 * as persisted - do NOT pass a re-stringified value from the mapped
 * `evidence` array. Round-tripping through JSON.parse/JSON.stringify can
 * normalize whitespace or key order and would silently mask tampering.
 */
export function verifyProvenanceEvidenceHash(
  record: ExecutionOutcomeProvenance,
  rawEvidenceJson: string | null,
): ProvenanceVerificationResult {
  const expected = reconstructPhase165EvidenceHash({
    outcome: record.outcome,
    previousState: record.previousState,
    attemptId: record.attemptId,
    evidenceJson: rawEvidenceJson,
    terminalizedAt: record.terminalizedAt,
  });
  if (expected === record.evidenceHash) return { kind: "verified" };
  return { kind: "hash_mismatch", expected, actual: record.evidenceHash };
}

/**
 * Cross-record integrity checks between a provenance record and its
 * durable source attempt row. Per Phase 166 section 4 these must FAIL
 * rather than silently repair when the source is missing or contradictory.
 */
export function validateProvenanceAgainstAttempt(
  record: ExecutionOutcomeProvenance,
  attempt: ExecutionAttempt | undefined,
): ProvenanceIntegrityFailure | null {
  if (!attempt) {
    return { provenanceId: record.provenanceId, kind: "source_attempt_missing" };
  }
  if (attempt.jobId !== record.jobId) {
    return {
      provenanceId: record.provenanceId,
      kind: "source_attempt_job_mismatch",
      detail: { provenanceJobId: record.jobId, attemptJobId: attempt.jobId },
    };
  }
  if (attempt.id !== record.attemptId) {
    return {
      provenanceId: record.provenanceId,
      kind: "source_attempt_id_mismatch",
      detail: { provenanceAttemptId: record.attemptId, attemptId: attempt.id },
    };
  }
  if (attempt.attemptNumber !== record.attemptNumber) {
    return {
      provenanceId: record.provenanceId,
      kind: "source_attempt_number_mismatch",
      detail: {
        provenanceAttemptNumber: record.attemptNumber,
        attemptNumber: attempt.attemptNumber,
      },
    };
  }
  if (attempt.status !== record.outcome) {
    return {
      provenanceId: record.provenanceId,
      kind: "source_attempt_outcome_mismatch",
      detail: {
        provenanceOutcome: record.outcome,
        attemptStatus: attempt.status,
      },
    };
  }
  return null;
}

/**
 * Validate a whole lineage (already ordered by attempt_number ascending).
 *
 * Checks:
 *   - predecessor_attempt_id, if non-null, refers to an attempt in the
 *     same job with a strictly smaller attempt_number
 *   - no cycles in the predecessor graph
 */
export function validateRetryLineage(
  records: ExecutionOutcomeProvenance[],
): ProvenanceIntegrityFailure | null {
  const byAttemptId = new Map<string, ExecutionOutcomeProvenance>();
  for (const r of records) byAttemptId.set(r.attemptId, r);

  for (const r of records) {
    const pred = r.predecessorAttemptId;
    if (pred === null) continue;
    const predRec = byAttemptId.get(pred);
    if (!predRec || predRec.jobId !== r.jobId) {
      return {
        provenanceId: r.provenanceId,
        kind: "predecessor_not_in_job",
        detail: { predecessorAttemptId: pred, jobId: r.jobId },
      };
    }
    if (!(predRec.attemptNumber < r.attemptNumber)) {
      return {
        provenanceId: r.provenanceId,
        kind: "predecessor_attempt_number_not_less",
        detail: {
          predNumber: predRec.attemptNumber,
          attemptNumber: r.attemptNumber,
        },
      };
    }
  }

  for (const r of records) {
    const seen = new Set<string>();
    let cur: ExecutionOutcomeProvenance | undefined = r;
    while (cur && cur.predecessorAttemptId) {
      if (seen.has(cur.attemptId)) {
        return {
          provenanceId: r.provenanceId,
          kind: "predecessor_cycle",
          detail: { attemptId: cur.attemptId },
        };
      }
      seen.add(cur.attemptId);
      cur = byAttemptId.get(cur.predecessorAttemptId);
    }
  }

  return null;
}