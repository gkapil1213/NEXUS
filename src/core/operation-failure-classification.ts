// src/core/operation-failure-classification.ts
// Phase 242: deterministic failure classification for durable retry
// orchestration on execution recovery operations.
//
// Distinct from worker-deployment-recovery.classifyFailure (deployment-level)
// and from AI provider retryable flags.

export type OperationFailureClass =
  | "RETRYABLE"
  | "NON_RETRYABLE"
  | "PERSISTENCE_UNAVAILABLE";

const PERSISTENCE_PATTERNS: string[] = [
  "PERSISTENCE_UNAVAILABLE",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "connection terminated",
  "could not connect",
  "database is unavailable",
  "SHARED_PERSISTENCE_UNREACHABLE",
];

const NON_RETRYABLE_PATTERNS: string[] = [
  "NON_RETRYABLE",
  "INVALID_INPUT",
  "VALIDATION_FAILED",
  "AUTHORIZATION_FAILED",
  "AUTH_FAILED",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "UNSUPPORTED_OPERATION",
  "MALFORMED",
  "SCHEMA_VIOLATION",
];

const RETRYABLE_PATTERNS: string[] = [
  "TIMEOUT",
  "ETIMEDOUT",
  "temporarily unavailable",
  "temporary",
  "unavailable",
  "429",
  "503",
  "504",
  "server error",
];

export function classifyOperationFailure(
  error: string | null | undefined,
): OperationFailureClass {
  const msg = String(error ?? "");
  for (const p of PERSISTENCE_PATTERNS) if (msg.includes(p)) return "PERSISTENCE_UNAVAILABLE";
  for (const p of NON_RETRYABLE_PATTERNS) if (msg.includes(p)) return "NON_RETRYABLE";
  for (const p of RETRYABLE_PATTERNS) if (msg.includes(p)) return "RETRYABLE";
  // Safe default: unknown failures are NON_RETRYABLE to avoid retry storms.
  return "NON_RETRYABLE";
}