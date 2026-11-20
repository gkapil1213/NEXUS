
import { Router, type Request, type Response, type NextFunction } from "express";
import {
  createAuthApi,
  type KernelServices,
} from "../../core/kernel";
import {
  validateEmail,
  validateName,
  validatePassword,
} from "../../core/security";
import type { PublicUser } from "../../core/types";
import { Err } from "../../core/errors";
import { requireSession } from "../../server/auth-middleware";
import { sendError } from "../../server/errors";
import {
  RateLimiter,
  type RateLimitBucket,
} from "../../server/rate-limit";

interface AuthRouterDeps {
  services: KernelServices;
  limiter: RateLimiter;
}

function bearerToken(req: Request): string {
  const raw = req.headers.authorization;
  if (!raw?.startsWith("Bearer ")) {
    throw Err.auth("UNAUTHENTICATED", "authentication required");
  }

  const token = raw.slice("Bearer ".length).trim();
  if (!token) {
    throw Err.auth("UNAUTHENTICATED", "authentication required");
  }

  return token;
}

function requireString(body: unknown, field: string): string {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    typeof (body as Record<string, unknown>)[field] !== "string"
  ) {
    throw Err.validation("INVALID_INPUT", `${field} must be a string`);
  }

  return (body as Record<string, string>)[field];
}

function clientAddress(req: Request): string {
  return String(req.ip ?? req.socket.remoteAddress ?? "unknown");
}

function rateLimit(
  limiter: RateLimiter,
  principal: string,
  bucket: RateLimitBucket,
  res: Response,
  requestId: string,
): boolean {
  const decision = limiter.check(principal, bucket);

  if (!decision.allowed) {
    res.setHeader("Retry-After", String(decision.retryAfterSec));
    sendError(
      res,
      requestId,
      Err.denied("RATE_LIMITED", "request rate exceeded"),
    );
    return false;
  }

  return true;
}

function handleAuthFailure(
  req: Request,
  res: Response,
  next: NextFunction,
  limiter: RateLimiter,
  error: unknown,
): void {
  const requestId = (req as any).requestId ?? "req_unknown";

  if (
    !rateLimit(
      limiter,
      clientAddress(req),
      "auth-fail",
      res,
      requestId,
    )
  ) {
    return;
  }

  next(error);
}

function safeSessionResponse(
  user: PublicUser,
  session: { token: string; expires_at: number },
) {
  return {
    user,
    session: {
      token: session.token,
      expires_at: session.expires_at,
    },
  };
}

export function createAuthRouter(deps: AuthRouterDeps): Router {
  const router = Router();
  const auth = createAuthApi(deps.services);
  const sessionMw = requireSession(deps.services);

  router.get("/status", async (req, res) => {
    const requestId = (req as any).requestId ?? "req_unknown";

    try {
      if (!rateLimit(
        deps.limiter,
        clientAddress(req),
        "read",
        res,
        requestId,
      )) return;

      res.json({
        requestId,
        data: { initialized: await auth.hasUsers() },
      });
    } catch (error) {
      sendError(res, requestId, error);
    }
  });

  router.post("/bootstrap", async (req, res) => {
    const requestId = (req as any).requestId ?? "req_unknown";

    try {
      if (!rateLimit(
        deps.limiter,
        clientAddress(req),
        "auth-fail",
        res,
        requestId,
      )) return;

      const email = validateEmail(requireString(req.body, "email"));
      const name = validateName(requireString(req.body, "name"));
      const password = requireString(req.body, "password");
      validatePassword(password);

      const result = await auth.bootstrapFirstUser(email, name, password);

      res.status(201).json({
        requestId,
        data: safeSessionResponse(result.user, result.session),
      });
    } catch (error) {
      sendError(res, requestId, error);
    }
  });

  router.post("/login", async (req, res) => {
    const requestId = (req as any).requestId ?? "req_unknown";

    try {
      if (!rateLimit(
        deps.limiter,
        clientAddress(req),
        "auth-fail",
        res,
        requestId,
      )) return;

      const email = validateEmail(requireString(req.body, "email"));
      const password = requireString(req.body, "password");

      const result = await auth.login(email, password);

      res.json({
        requestId,
        data: safeSessionResponse(result.user, result.session),
      });
    } catch (error) {
      sendError(res, requestId, error);
    }
  });

  router.get("/session", (req: Request, res: Response, next: NextFunction) => {
    sessionMw(req, res, (error?: unknown) => {
      if (error) {
        return handleAuthFailure(
          req, res, next, deps.limiter, error,
        );
      }

      const requestId = (req as any).requestId ?? "req_unknown";
      const actor = (req as any).actor as PublicUser | undefined;

      if (!actor) {
        return sendError(
          res,
          requestId,
          Err.auth("UNAUTHENTICATED", "authentication required"),
        );
      }

      if (!rateLimit(deps.limiter, actor.id, "read", res, requestId)) {
        return;
      }

      res.json({ requestId, data: { user: actor } });
    });
  });

  router.post("/logout", (req: Request, res: Response, next: NextFunction) => {
    sessionMw(req, res, async (error?: unknown) => {
      if (error) {
        return handleAuthFailure(
          req, res, next, deps.limiter, error,
        );
      }

      const requestId = (req as any).requestId ?? "req_unknown";
      const actor = (req as any).actor as PublicUser | undefined;

      if (!actor) {
        return sendError(
          res,
          requestId,
          Err.auth("UNAUTHENTICATED", "authentication required"),
        );
      }

      if (!rateLimit(deps.limiter, actor.id, "control", res, requestId)) {
        return;
      }

      try {
        await auth.logout(bearerToken(req));
        res.json({ requestId, data: { success: true } });
      } catch (logoutError) {
        sendError(res, requestId, logoutError);
      }
    });
  });

  return router;
}
