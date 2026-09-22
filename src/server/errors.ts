// src/server/errors.ts
// Phase 179: map NexusError -> HTTP status + SystemError envelope.
//
// Categories are the repository's own (src/core/errors.ts / types.ts
// ErrorCategory). No new error format is introduced.

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

export function sendError(res: Response, requestId: string, e: unknown): void {
  const err = toSystemError(e);
  const status = CATEGORY_TO_STATUS[err.category] ?? 500;
  res.status(status).json({ requestId, error: err });
}