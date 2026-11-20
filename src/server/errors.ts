// src/server/errors.ts
// Phase 180: NexusError -> HTTP status + SystemError envelope.
//
// Reuses the existing core/errors.ts hierarchy -- no parallel error model.
// Most categories map 1:1 to a status. A handful of codes override the
// category mapping because the semantic status is more specific than the
// category (e.g. RATE_LIMITED is authorization-category but should be 429).

import type { Response } from "express";
import { toSystemError } from "../core/errors";

const CATEGORY_TO_STATUS: Record<string, number> = {
  auth: 401,
  authorization: 403,
  validation: 400,
  not_found: 404,
  conflict: 409,
  integrity_failure: 409,
  persistence: 500,
  runtime: 500,
  security: 403,
  startup: 500,
};

const CODE_TO_STATUS: Record<string, number> = {
  RATE_LIMITED: 429,
  REQUEST_TIMEOUT: 503,
  REQUEST_TOO_LARGE: 413,
};

const PUBLIC_ERROR_MESSAGES: Record<string, string> = {
  auth: "Authentication required or session invalid.",
  authorization: "You are not authorized to perform this action.",
  validation: "The request contains invalid input.",
  not_found: "The requested resource was not found.",
  conflict: "The request conflicts with the current resource state.",
  integrity_failure: "The request could not be completed due to an integrity constraint.",
  persistence: "A storage operation could not be completed.",
  runtime: "An internal operation failed.",
  security: "The request was rejected by a security control.",
  startup: "The service could not complete the requested operation.",
};

export function sendError(res: Response, requestId: string, e: unknown): void {
  if (res.headersSent) return;

  const err = toSystemError(e);
  const status =
    CODE_TO_STATUS[err.code] ??
    CATEGORY_TO_STATUS[err.category] ??
    500;

  const safeError = {
    code: err.code,
    message: PUBLIC_ERROR_MESSAGES[err.category] ?? "An internal error occurred.",
    category: err.category,
    recoverable: err.recoverable,
    timestamp: err.timestamp,
  };

  res.status(status).json({ requestId, error: safeError });
}