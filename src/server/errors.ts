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

export function sendError(res: Response, requestId: string, e: unknown): void {
  if (res.headersSent) return;
  const err = toSystemError(e);
  const status =
    CODE_TO_STATUS[err.code] ??
    CATEGORY_TO_STATUS[err.category] ??
    500;
  res.status(status).json({ requestId, error: err });
}