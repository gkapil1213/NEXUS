// src/core/release-recovery-decision.ts
// Phase 177: durable recovery decision journal.
//
// A "recovery decision" is the durable, authoritative answer the recovery
// control loop produced for a given intent during a reconciliation cycle.
// It is distinct from the intent's state-machine status:
//
//   - status    describes WHERE the intent is (PENDING, DEPLOYING, ...)
//   - decision  describes WHAT the recovery loop decided to do about it
//
// Decisions are recorded as a bounded JSON envelope on the intent so a
// restarted supervisor can reconstruct the last authoritative answer without
// re-running reconciliation against stale evidence.
//
// This module is PURE. It never touches the store. It never re-implements the
// classifier. It only maps an already-produced RecoveryAction + retry
// bookkeeping to one of the durable decision kinds.

import type { RecoveryAction } from "./release-recovery";

export type RecoveryDecisionKind =
  | "KNOWN_GOOD"                  // authoritative success; terminal
  | "SAFE_TO_RESUME"              // reconciled; recovery may proceed under lease
  | "RETRY"                       // scheduled for bounded re-attempt
  | "EXHAUST"                     // bounded re-attempts exhausted
  | "REMAIN_RECOVERY_REQUIRED"    // undecidable; requires operator or new evidence
  | "FAILED"                      // terminal failure decided by recovery
  | "BLOCKED";                    // terminal block decided by recovery

export interface RecoveryDecisionEnvelope {
  decision: RecoveryDecisionKind;
  action: RecoveryAction;
  reason: string;
  attempts: number;
  maxAttempts: number;
  nextRetryAt: number | null;
  workerId: string;
  intentKey: string;
  timestamp: number;
}

const MAX_REASON_LEN = 500;
const MAX_ENVELOPE_LEN = 4096;

export function buildRecoveryDecisionEnvelope(input: {
  decision: RecoveryDecisionKind;
  action: RecoveryAction;
  reason: string;
  attempts?: number;
  maxAttempts?: number;
  nextRetryAt?: number | null;
  workerId: string;
  intentKey: string;
  now?: number;
}): RecoveryDecisionEnvelope {
  const rawReason = typeof input.reason === "string" ? input.reason : "";
  const reason = rawReason.length > MAX_REASON_LEN
    ? rawReason.slice(0, MAX_REASON_LEN - 11) + "...[trunc]"
    : rawReason;
  return {
    decision: input.decision,
    action: input.action,
    reason,
    attempts: Math.max(0, Math.floor(input.attempts ?? 0)),
    maxAttempts: Math.max(0, Math.floor(input.maxAttempts ?? 0)),
    nextRetryAt: input.nextRetryAt ?? null,
    workerId: input.workerId,
    intentKey: input.intentKey,
    timestamp: input.now ?? Date.now(),
  };
}

export function serializeRecoveryDecision(env: RecoveryDecisionEnvelope): string {
  const json = JSON.stringify(env);
  if (json.length > MAX_ENVELOPE_LEN) {
    throw new Error(
      "release-recovery-decision: envelope exceeds " + MAX_ENVELOPE_LEN + " bytes",
    );
  }
  return json;
}

export function parseRecoveryDecision(
  raw: string | null | undefined,
): RecoveryDecisionEnvelope | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.decision !== "string") return null;
    if (typeof obj.intentKey !== "string") return null;
    return obj as unknown as RecoveryDecisionEnvelope;
  } catch {
    return null;
  }
}