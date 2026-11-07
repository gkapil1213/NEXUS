const SAFE_HANDLER_ERROR_CODES = new Set([
  "handler_error",
  "handler_execution_failed",
  "recovery_after_crash",
  "unknown_message_type",
  "handler_completion_fence_missing",
  "handler_completion_fence_rejected",
  "phase292_recovery_incomplete_handler_no_payload_available",
  "integrity_fail",
  "unverified_legacy",
  "unknown_handler",
  "not_replay_eligible",
  "session_mismatch",
]);

export function sanitizeHandlerError(message: unknown): string {
  return typeof message === "string" && SAFE_HANDLER_ERROR_CODES.has(message)
    ? message
    : "handler_error";
}

const SAFE_CI_LITERAL_REASONS = new Set<string>([
  "CI_RUN_NOT_FOUND",
  "EXECUTION_NOT_FOUND",
  "EXECUTION_RECORD_MALFORMED",
  "EXECUTION_PROJECT_MISSING",
  "PROJECT_ID_MISMATCH_WITH_EXECUTION",
  "INVALID_REPOSITORY",
  "ARTIFACT_MISSING",
  "ARTIFACT_AMBIGUOUS",
  "ARTIFACT_EXPIRED",
  "DIGEST_CONFLICT_WITH_EXISTING_BINDING",
]);

const SAFE_CI_COMPOUND_REASONS = [
  {
    prefix: "ARTIFACT_VALIDATION_FAILED:",
    tails: new Set([
      "EXECUTION_ID_MISMATCH",
      "COMMIT_SHA_MISMATCH",
      "EXTERNAL_RUN_ID_MISMATCH",
      "MALFORMED_IMAGE_DIGEST",
      "IMMUTABLE_REFERENCE_MISMATCH",
      "REPOSITORY_MISMATCH",
    ]),
  },
  {
    prefix: "CI_TERMINAL_",
    tails: new Set(["FAILED", "CANCELLED", "BLOCKED"]),
  },
];

const UNMAPPED_CI_STATUS_PREFIX = "UNMAPPED_CI_STATUS:";
const UNMAPPED_CI_STATUS_TAIL = /^[A-Z_]{1,64}$/;

export function sanitizeCiReconciliationReason(reason: unknown): string {
  if (typeof reason !== "string") return "handler_error";
  if (SAFE_CI_LITERAL_REASONS.has(reason)) return reason;
  for (const { prefix, tails } of SAFE_CI_COMPOUND_REASONS) {
    if (reason.startsWith(prefix)) {
      const tail = reason.slice(prefix.length);
      if (tails.has(tail)) return reason;
    }
  }
  if (reason.startsWith(UNMAPPED_CI_STATUS_PREFIX)) {
    const tail = reason.slice(UNMAPPED_CI_STATUS_PREFIX.length);
    if (UNMAPPED_CI_STATUS_TAIL.test(tail)) return reason;
  }
  return sanitizeHandlerError(reason);
}