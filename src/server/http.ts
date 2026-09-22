// src/server/http.ts
// Phase 179: production operator HTTP boundary.
//
// Builds an Express application over an existing booted kernel. This is
// the operator control surface for release recovery. It never opens a
// listener by itself (that is the caller's responsibility, see
// scripts/run-server.ts), and it never becomes a shortcut around recovery
// safety: every control flow delegates to Phase 178 services.

import express, { type Application } from "express";
import { nid } from "../core/db";
import { sendError } from "./errors";
import { requireSession } from "./auth-middleware";
import { createRecoveryRouter } from "../api/recovery/routes";
import type { KernelServices } from "../core/kernel";
import type { IdempotencyStore } from "./idempotency";

export interface HttpAppDeps {
  services: KernelServices;
  idempotency: IdempotencyStore;
}

export function createHttpApp(deps: HttpAppDeps): Application {
  const app = express();
  app.disable("x-powered-by");

  // Request ID: accepts inbound X-Request-Id or generates one. Echoed on
  // the response and available to every downstream handler as req.requestId.
  app.use((req: any, res, next) => {
    const raw = req.headers["x-request-id"];
    const incoming = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : undefined;
    const rid = incoming && incoming.length > 0 ? incoming : nid("req");
    req.requestId = rid;
    res.setHeader("X-Request-Id", rid);
    next();
  });

  app.use(express.json({ limit: "64kb" }));

  app.get("/health", (req: any, res) => {
    res.json({ requestId: req.requestId, data: { ok: true } });
  });

  app.use("/api/recovery", requireSession(deps.services), createRecoveryRouter(deps));

  // 404 (unmatched route)
  app.use((req: any, res) => {
    res.status(404).json({
      requestId: req.requestId ?? null,
      error: {
        code: "NOT_FOUND",
        message: "route not found",
        category: "not_found",
        recoverable: false,
        timestamp: Date.now(),
      },
    });
  });

  // Terminal error handler
  app.use((err: unknown, req: any, res: any, _next: unknown) => {
    sendError(res, req.requestId ?? "req_unknown", err);
  });

  return app;
}