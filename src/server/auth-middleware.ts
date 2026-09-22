// src/server/auth-middleware.ts
// Phase 179: bearer-token session middleware.
//
// Reads Authorization: Bearer <token>, validates it through the existing
// SessionService (durable sessions store), resolves the User, and attaches
// the credential-free PublicUser to req.actor. Denies with the existing
// Err.auth NexusError on any failure. No parallel auth system.

import type { RequestHandler } from "express";
import { toPublicUser } from "../core/security";
import { Err } from "../core/errors";
import type { User } from "../core/types";
import type { KernelServices } from "../core/kernel";

export interface AuthedRequest {
  actor: import("../core/types").PublicUser;
  requestId: string;
  headers: Record<string, string | string[] | undefined>;
  params: Record<string, string>;
  query: Record<string, unknown>;
  body: unknown;
  method: string;
  path: string;
  originalUrl: string;
}

export function requireSession(services: KernelServices): RequestHandler {
  return async (req: any, _res, next) => {
    try {
      const raw = req.headers.authorization ?? req.headers.Authorization;
      const header = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : undefined;
      if (!header || !header.startsWith("Bearer ")) {
        return next(Err.auth("UNAUTHENTICATED", "authentication required"));
      }
      const token = header.slice("Bearer ".length).trim();
      if (!token) return next(Err.auth("UNAUTHENTICATED", "authentication required"));

      const session = await services.sessions.validate(token);
      const user = await services.engine.get<User>("users", session.user_id);
      if (!user) return next(Err.auth("INVALID_SESSION", "session references unknown identity"));
      if (user.status !== "active") {
        return next(Err.auth("IDENTITY_DISABLED", `identity is ${user.status}`));
      }
      req.actor = toPublicUser(user);
      next();
    } catch (e) {
      next(e);
    }
  };
}