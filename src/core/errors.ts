/**
 * NEXUS Phase 1 — structured errors.
 *
 * Every failure carries code, message, category, recoverability and a
 * timestamp. Sensitive internals (stack traces, query details, secret
 * material) never cross into user-facing messages.
 */

import type { ErrorCategory, SystemError } from "./types";

export class NexusError extends Error {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly recoverable: boolean;
  readonly details: Record<string, unknown>;
  readonly timestamp: number;

  constructor(
    code: string,
    message: string,
    category: ErrorCategory,
    opts: { recoverable?: boolean; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "NexusError";
    this.code = code;
    this.category = category;
    this.recoverable = opts.recoverable ?? false;
    this.details = opts.details ?? {};
    this.timestamp = Date.now();
  }

  /** Serializable view — safe to return through API boundaries. */
  toSystemError(): SystemError {
    return {
      code: this.code,
      message: this.message,
      category: this.category,
      recoverable: this.recoverable,
      details: this.details,
      timestamp: this.timestamp,
    };
  }
}

export function isNexusError(e: unknown): e is NexusError {
  return e instanceof NexusError;
}

/** Coerce any thrown value into a SystemError without leaking internals. */
export function toSystemError(e: unknown, fallbackCode = "INTERNAL"): SystemError {
  if (isNexusError(e)) return e.toSystemError();
  const message = e instanceof Error && e.message ? e.message : "internal error";
  return {
    code: fallbackCode,
    message,
    category: "runtime",
    recoverable: false,
    timestamp: Date.now(),
  };
}

/* --------------------------- Common constructors --------------------------- */

export const Err = {
  validation: (code: string, message: string, details?: Record<string, unknown>) =>
    new NexusError(code, message, "validation", { recoverable: true, details }),
  auth: (code: string, message: string) => new NexusError(code, message, "auth", { recoverable: true }),
  denied: (code: string, message: string) => new NexusError(code, message, "authorization"),
  notFound: (code: string, message: string) => new NexusError(code, message, "not_found"),
  conflict: (code: string, message: string) => new NexusError(code, message, "conflict", { recoverable: true }),
  persistence: (code: string, message: string) => new NexusError(code, message, "persistence"),
  startup: (code: string, message: string, details?: Record<string, unknown>) =>
    new NexusError(code, message, "startup", { details }),
  security: (code: string, message: string) => new NexusError(code, message, "security"),
  runtime: (code: string, message: string) => new NexusError(code, message, "runtime"),
};
