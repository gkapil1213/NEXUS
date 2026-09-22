// src/server/http.ts
// Phase 179/180: production operator HTTP boundary.
//
// Phase 179: build the operator surface over the existing kernel.
// Phase 180: harden it -- security headers, bounded request IDs, body cap,
//   per-request timeout, rate limiting (auth-fail / read / control buckets),
//   liveness vs readiness split, opt-in structured access logging.
//
// No new server, no new router framework, no new auth, no new authz, no
// new idempotency store. Every control flow delegates to Phase 178
// services which own the recovery safety guarantees.

import express, { type Application } from "express";
import { nid } from "../core/db";
import { Err } from "../core/errors";
import { sendError } from "./errors";
import { requireSession } from "./auth-middleware";
import { createRecoveryRouter } from "../api/recovery/routes";
import type { KernelServices } from "../core/kernel";
import type { IdempotencyStore } from "./idempotency";
import { RateLimiter, type RateLimitOptions, type RateLimitBucket } from "./rate-limit";
import { emitAccessLog } from "./logging";

/** Inbound X-Request-Id is accepted only if it matches this. Otherwise we
 *  generate one. Prevents header-injection / unbounded request IDs. */
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

const DEFAULT_TIMEOUT_MS = 30_000;

export interface HttpAppDeps {
  services: KernelServices;
  idempotency: IdempotencyStore;
  /** Optional. Defaults to enabled with permissive single-process limits. */
  rateLimit?: RateLimitOptions;
  /** Optional. Emits one structured JSON line per request when true. */
  accessLog?: boolean;
  /** Optional. Per-request deadline in ms. Default 30000. */
  requestTimeoutMs?: number;
}

export function createHttpApp(deps: HttpAppDeps): Application {
  const app = express();
  app.disable("x-powered-by");

  const limiter = new RateLimiter(deps.rateLimit);
  const accessLogOn = deps.accessLog === true;
  const timeoutMs = deps.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  // --- 1. Request ID (bounded) ---
  app.use((req: any, res, next) => {
    const raw = req.headers["x-request-id"];
    const incoming = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : undefined;
    const rid = incoming && REQUEST_ID_RE.test(incoming) ? incoming : nid("req");
    req.requestId = rid;
    res.setHeader("X-Request-Id", rid);
    next();
  });

  // --- 2. Security headers ---
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  // --- 3. Access log (opt-in) ---
  if (accessLogOn) {
    app.use((req: any, res, next) => {
      const start = Date.now();
      res.on("finish", () => {
        emitAccessLog({
          rid: req.requestId,
          method: req.method,
          path: req.originalUrl || req.url,
          status: res.statusCode,
          ms: Date.now() - start,
          principal: req.actor?.email ?? null,
          code: null,
        });
      });
      next();
    });
  }

  // --- 4. Content-Type gate (before body parsing) ---
  // Reject non-JSON bodies on state-changing methods when a body is present.
  // Content-Length: 0 or missing -> no body -> allowed. Charset params OK.
  app.use((req: any, res, next) => {
    const m = String(req.method).toUpperCase();
    if (m !== "POST" && m !== "PUT" && m !== "PATCH") return next();
    const len = Number(req.headers["content-length"] ?? 0);
    if (!Number.isFinite(len) || len <= 0) return next();
    const ct = String(req.headers["content-type"] ?? "").toLowerCase();
    if (!ct.includes("application/json")) {
      return sendError(res, req.requestId,
        Err.validation("UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json"));
    }
    next();
  });

  // --- 5. Body parser (strict, 64kb cap) ---
  app.use(express.json({ limit: "64kb", strict: true }));

  // --- 6. Per-request timeout (bounded processing) ---
  // On timeout: if the handler has not yet responded, send a 503 in the
  // existing SystemError envelope. The underlying handler keeps running
  // (any durable write it already performed is authoritative). Express's
  // headersSent guard makes a later duplicate response a no-op.
  app.use((req: any, res, next) => {
    const timer = setTimeout(() => {
      if (res.headersSent) return;
      try {
        res.status(503).json({
          requestId: req.requestId,
          error: {
            code: "REQUEST_TIMEOUT",
            message: "request processing exceeded deadline",
            category: "runtime",
            recoverable: true,
            timestamp: Date.now(),
          },
        });
      } catch { /* ignore */ }
    }, timeoutMs);
    res.on("finish", () => clearTimeout(timer));
    res.on("close", () => clearTimeout(timer));
    next();
  });

  // --- 7. Liveness (process-level) ---
  app.get("/health", (req: any, res) => {
    res.json({ requestId: req.requestId, data: { ok: true, kind: "live" } });
  });
  app.get("/health/live", (req: any, res) => {
    res.json({ requestId: req.requestId, data: { ok: true, kind: "live" } });
  });

  // --- 8. Readiness (dependency-level). Read-only; no provider calls,
  //        no lease acquisition, no recovery state mutation. ---
  app.get("/health/ready", (req: any, res) => {
    const checks: Record<string, boolean> = {
      executionStore: !!deps.services.executionStore,
      releaseIntents: !!deps.services.releaseIntents,
      recoveryOperations: !!deps.services.recoveryOperations,
      recoveryControl: !!deps.services.recoveryControl,
      sessions: !!deps.services.sessions,
      audit: !!deps.services.audit,
    };
    const ready = Object.values(checks).every(Boolean);
    res.status(ready ? 200 : 503).json({
      requestId: req.requestId,
      data: { ok: ready, kind: "ready", checks },
    });
  });

  // --- 9. Protected routes: authenticate, then rate limit, then route ---
  const sessionMw = requireSession(deps.services);
  app.use("/api/recovery", (req: any, res, next) => {
    sessionMw(req, res, (err?: unknown) => {
      if (err) {
        // Unauthenticated. Bucket by client address.
        const ip = String(req.ip ?? req.socket?.remoteAddress ?? "unknown");
        const rl = limiter.check(ip, "auth-fail");
        if (!rl.allowed) {
          res.setHeader("Retry-After", String(rl.retryAfterSec));
          return sendError(res, req.requestId,
            Err.denied("RATE_LIMITED", "too many authentication failures"));
        }
        return next(err);
      }
      // Authenticated. Bucket by principal.
      const principal = String(req.actor?.id ?? "unknown");
      const bucket: RateLimitBucket = req.method === "GET" ? "read" : "control";
      const rl = limiter.check(principal, bucket);
      if (!rl.allowed) {
        res.setHeader("Retry-After", String(rl.retryAfterSec));
        return sendError(res, req.requestId,
          Err.denied("RATE_LIMITED", "request rate exceeded for " + bucket));
      }
      next();
    });
  });

  app.use("/api/recovery", createRecoveryRouter(deps));

  // --- 10. 404 (unmatched route) ---
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

  // --- 11. Terminal error handler ---
  app.use((err: any, req: any, res: any, _next: unknown) => {
    if (res.headersSent) return;
    // Express body-parser errors -> deterministic 4xx in our envelope.
    const t = err && typeof err === "object" ? (err as any).type : undefined;
    const status = err && typeof err === "object" ? (err as any).status : undefined;
    const isParseFail = t === "entity.parse.failed" ||
      (status === 400 && err instanceof SyntaxError);
    const isTooLarge = t === "entity.too.large" || status === 413;
    if (isParseFail) {
      return sendError(res, req.requestId ?? "req_unknown",
        Err.validation("MALFORMED_JSON", "request body is not valid JSON"));
    }
    if (isTooLarge) {
      return sendError(res, req.requestId ?? "req_unknown",
        Err.validation("REQUEST_TOO_LARGE", "request body exceeds 64kb limit"));
    }
    sendError(res, req.requestId ?? "req_unknown", err);
  });

  return app;
}