// src/api/recovery/routes.ts
// Phase 179: operator recovery control API.
//
// Five routes, each gated by requireSession (attached in http.ts) and by
// the existing project-scoped authorization helper authorizeProject().
//
// Permission mapping (reuses the existing Permission union):
//   read                       -> execution:read
//   reconcile request          -> execution:retry
//   cancellation request       -> execution:cancel
//
// Reads go through RecoveryOperationsService (Phase 178, read-only).
// Writes go through RecoveryControlService (Phase 178, fenced). This file
// never touches the intent store directly, never writes KNOWN_GOOD, and
// never invokes a provider.

import { Router, type Response } from "express";
import { createHash } from "crypto";
import { authorizeProject } from "../../core/project-authorization";
import { Err } from "../../core/errors";
import { sendError } from "../../server/errors";
import type { KernelServices } from "../../core/kernel";
import type { IdempotencyStore } from "../../server/idempotency";

export interface RecoveryRouterDeps {
  services: KernelServices;
  idempotency: IdempotencyStore;
}

export function createRecoveryRouter(deps: RecoveryRouterDeps): Router {
  const router = Router();

  const authzCtx = () => ({
    engine: deps.services.engine,
    audit: deps.services.audit,
    memberships: deps.services.memberships,
  });

  const requireOps = () => {
    if (!deps.services.recoveryOperations) {
      throw Err.startup("RECOVERY_NOT_WIRED", "recovery operations service not available");
    }
    if (!deps.services.recoveryControl) {
      throw Err.startup("RECOVERY_NOT_WIRED", "recovery control service not available");
    }
    if (!deps.services.releaseIntents) {
      throw Err.startup("RELEASE_INTENTS_NOT_WIRED", "release intent service not available");
    }
    return {
      ops: deps.services.recoveryOperations,
      ctrl: deps.services.recoveryControl,
      intents: deps.services.releaseIntents,
    };
  };

  // -------- GET /api/recovery/intents --------
  router.get("/intents", async (req: any, res) => {
    try {
      const { ops } = requireOps();
      const actor = req.actor;
      const projectId = typeof req.query.projectId === "string" ? req.query.projectId : "";
      if (!projectId) {
        throw Err.validation("PROJECT_ID_REQUIRED", "projectId query parameter is required");
      }
      const environment = typeof req.query.environment === "string" ? req.query.environment : undefined;
      await authorizeProject(authzCtx(), actor, "execution:read", projectId);
      const filter: { projectId: string; environment?: string } = { projectId };
      if (environment) filter.environment = environment;
      const snapshots = ops.listSnapshots(filter);
      res.json({ requestId: req.requestId, data: { snapshots } });
    } catch (e) {
      sendError(res, req.requestId, e);
    }
  });

  // -------- GET /api/recovery/intents/:intentKey --------
  router.get("/intents/:intentKey", async (req: any, res) => {
    try {
      const { ops, intents } = requireOps();
      const actor = req.actor;
      const intentKey = String(req.params.intentKey);
      const intent = intents.get(intentKey);
      if (!intent) throw Err.notFound("INTENT_NOT_FOUND", "intent not found");
      if (!intent.projectId) throw Err.integrity("PROJECT_MISSING", "intent has no projectId");
      await authorizeProject(authzCtx(), actor, "execution:read", intent.projectId);
      const envQuery = typeof req.query.environment === "string" ? req.query.environment : undefined;
      if (envQuery && envQuery !== intent.environment) {
        throw Err.validation("ENVIRONMENT_MISMATCH", "environment does not match intent");
      }
      const snapshot = ops.snapshot(intentKey);
      const decision = ops.explainDecision(intent);
      const evidence = ops.inspectEvidence(intent);
      const identity = snapshot ? ops.verifyIdentityChain(snapshot) : null;
      const freshness = snapshot ? ops.evaluateFreshness(snapshot, evidence) : null;
      res.json({
        requestId: req.requestId,
        data: { snapshot, decision, evidence, identity, freshness },
      });
    } catch (e) {
      sendError(res, req.requestId, e);
    }
  });

  // -------- GET /api/recovery/intents/:intentKey/decision --------
  router.get("/intents/:intentKey/decision", async (req: any, res) => {
    try {
      const { ops, intents } = requireOps();
      const actor = req.actor;
      const intentKey = String(req.params.intentKey);
      const intent = intents.get(intentKey);
      if (!intent) throw Err.notFound("INTENT_NOT_FOUND", "intent not found");
      if (!intent.projectId) throw Err.integrity("PROJECT_MISSING", "intent has no projectId");
      await authorizeProject(authzCtx(), actor, "execution:read", intent.projectId);
      const decision = ops.explainDecision(intent);
      res.json({ requestId: req.requestId, data: { decision } });
    } catch (e) {
      sendError(res, req.requestId, e);
    }
  });

  // -------- POST /api/recovery/intents/:intentKey/reconcile --------
  router.post("/intents/:intentKey/reconcile", async (req: any, res) => {
    await withIdempotency(deps, req, res, async () => {
      const { ctrl, intents } = requireOps();
      const actor = req.actor;
      const intentKey = String(req.params.intentKey);
      const intent = intents.get(intentKey);
      if (!intent) throw Err.notFound("INTENT_NOT_FOUND", "intent not found");
      if (!intent.projectId) throw Err.integrity("PROJECT_MISSING", "intent has no projectId");
      await authorizeProject(authzCtx(), actor, "execution:retry", intent.projectId);

      const body = (req.body ?? {}) as { environment?: unknown; force?: unknown };
      if (body.environment !== undefined && body.environment !== intent.environment) {
        throw Err.validation("ENVIRONMENT_MISMATCH", "environment does not match intent");
      }
      const force = body.force === true;

      const result = await ctrl.requestReconciliation({
        intentKey,
        actor: actor.email,
        projectId: intent.projectId,
        force,
      });
      if (!result.accepted) {
        throw mapRejectToError(result.reason);
      }
      return { status: 200, body: { requestId: req.requestId, data: result } };
    });
  });

  // -------- POST /api/recovery/intents/:intentKey/cancel --------
  router.post("/intents/:intentKey/cancel", async (req: any, res) => {
    await withIdempotency(deps, req, res, async () => {
      const { ctrl, intents } = requireOps();
      const actor = req.actor;
      const intentKey = String(req.params.intentKey);
      const intent = intents.get(intentKey);
      if (!intent) throw Err.notFound("INTENT_NOT_FOUND", "intent not found");
      if (!intent.projectId) throw Err.integrity("PROJECT_MISSING", "intent has no projectId");
      await authorizeProject(authzCtx(), actor, "execution:cancel", intent.projectId);

      const body = (req.body ?? {}) as { environment?: unknown };
      if (body.environment !== undefined && body.environment !== intent.environment) {
        throw Err.validation("ENVIRONMENT_MISMATCH", "environment does not match intent");
      }

      const result = await ctrl.requestCancellation({
        intentKey,
        actor: actor.email,
        projectId: intent.projectId,
      });
      if (!result.accepted) {
        throw mapRejectToError(result.reason);
      }
      return { status: 200, body: { requestId: req.requestId, data: result } };
    });
  });

  return router;
}

function mapRejectToError(reason: string) {
  if (/terminal/i.test(reason)) return Err.conflict("TERMINAL_STATE", reason);
  if (/exhaust/i.test(reason)) return Err.conflict("RETRIES_EXHAUSTED", reason);
  if (/lease/i.test(reason)) return Err.conflict("LEASE_HELD", reason);
  if (/cancel/i.test(reason)) return Err.conflict("CANCELLATION_IN_PROGRESS", reason);
  if (/not found/i.test(reason)) return Err.notFound("INTENT_NOT_FOUND", reason);
  if (/scope/i.test(reason)) return Err.denied("SCOPE_MISMATCH", reason);
  return Err.conflict("CONTROL_REJECTED", reason);
}

async function withIdempotency(
  deps: RecoveryRouterDeps,
  req: any,
  res: Response,
  handler: () => Promise<{ status: number; body: unknown }>,
): Promise<void> {
  try {
    const rawKey = req.headers["idempotency-key"];
    const key = typeof rawKey === "string" ? rawKey : Array.isArray(rawKey) ? rawKey[0] : undefined;
    if (!key) {
      throw Err.validation("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key header is required");
    }
    const actor = req.actor;
    if (!actor) throw Err.auth("UNAUTHENTICATED", "authentication required");
    const principalId = actor.id;
    const method = String(req.method);
    const path = String(req.path);
    const bodyString = JSON.stringify(req.body ?? {});
    const requestHash = createHash("sha256").update(bodyString).digest("hex");

    const existing = deps.idempotency.lookup(key);
    if (existing) {
      if (
        existing.principalId !== principalId ||
        existing.method !== method ||
        existing.path !== path ||
        existing.requestHash !== requestHash
      ) {
        throw Err.conflict(
          "IDEMPOTENCY_KEY_REUSED",
          "Idempotency-Key reused with a different request",
        );
      }
      const replayed = JSON.parse(existing.responseBody);
      res.status(existing.responseStatus).json(replayed);
      return;
    }

    const { status, body } = await handler();
    if (status >= 200 && status < 300) {
      deps.idempotency.store({
        idempotencyKey: key,
        principalId,
        method,
        path,
        requestHash,
        responseStatus: status,
        responseBody: JSON.stringify(body),
        createdAt: Date.now(),
      });
    }
    res.status(status).json(body);
  } catch (e) {
    sendError(res, req.requestId, e);
  }
}