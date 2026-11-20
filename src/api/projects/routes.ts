import { Router } from "express";
import type { KernelServices } from "../../core/kernel";
import { sendError } from "../../server/errors";
import { Err } from "../../core/errors";

type ActorRequest = {
  actor: any;
  requestId?: string;
  params: Record<string, string>;
  body?: unknown;
};

function bodyObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw Err.validation("INVALID_REQUEST_BODY", "request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

function rejectUnknownFields(
  body: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) throw Err.validation("UNKNOWN_REQUEST_FIELD", "request contains unsupported fields");
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw Err.validation("INVALID_REQUEST_FIELD", `${field} must be a valid string`);
  }
  return value;
}

function optionalString(
  body: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw Err.validation("INVALID_REQUEST_FIELD", `${field} must be a valid string`);
  }
  return value;
}

function safeProject(project: any) {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    status: project.status,
    repository: project.repository,
    default_branch: project.default_branch,
    created_at: project.created_at,
    updated_at: project.updated_at,
  };
}

function safeExecution(execution: any) {
  return {
    id: execution.id,
    project_id: execution.project_id,
    request: execution.request,
    status: execution.status,
    started_at: execution.started_at,
    completed_at: execution.completed_at,
    created_by: execution.created_by,
  };
}

function handleError(res: any, req: ActorRequest, error: unknown): void {
  sendError(res, String(req.requestId ?? "unknown"), error);
}

export function createProjectsRouter(services: KernelServices): Router {
  const router = Router();

  router.get("/", async (req: any, res: any) => {
    try {
      const projects = await services.projects.list(req.actor);
      res.json({
        requestId: req.requestId,
        data: projects.map(safeProject),
      });
    } catch (error) {
      handleError(res, req, error);
    }
  });

  router.get("/:projectId", async (req: any, res: any) => {
    try {
      const project = await services.projects.get(
        req.actor,
        req.params.projectId,
      );
      res.json({
        requestId: req.requestId,
        data: safeProject(project),
      });
    } catch (error) {
      handleError(res, req, error);
    }
  });

  router.post("/", async (req: any, res: any) => {
    try {
      const body = bodyObject(req.body);
      rejectUnknownFields(body, [
        "name",
        "description",
        "repository",
        "default_branch",
      ]);

      const project = await services.projects.create(req.actor, {
        name: requiredString(body.name, "name"),
        description: optionalString(body, "description"),
        repository: optionalString(body, "repository"),
        default_branch: optionalString(body, "default_branch"),
      });

      res.status(201).json({
        requestId: req.requestId,
        data: safeProject(project),
      });
    } catch (error) {
      handleError(res, req, error);
    }
  });

  router.patch("/:projectId", async (req: any, res: any) => {
    try {
      const body = bodyObject(req.body);
      rejectUnknownFields(body, [
        "name",
        "description",
        "repository",
        "default_branch",
        "status",
      ]);

      const patch: {
        name?: string;
        description?: string;
        repository?: string;
        default_branch?: string;
        status?: "ACTIVE" | "PAUSED" | "ARCHIVED";
      } = {};

      for (const field of [
        "name",
        "description",
        "repository",
        "default_branch",
      ] as const) {
        const value = optionalString(body, field);
        if (value !== undefined) patch[field] = value;
      }

      if (body.status !== undefined) {
        if (
          body.status !== "ACTIVE" &&
          body.status !== "PAUSED" &&
          body.status !== "ARCHIVED"
        ) {
          throw Err.validation("INVALID_PROJECT_STATUS", "status must be ACTIVE, PAUSED, or ARCHIVED");
        }
        patch.status = body.status;
      }

      if (Object.keys(patch).length === 0) {
        throw Err.validation("EMPTY_PROJECT_PATCH", "at least one project field must be provided");
      }

      const project = await services.projects.update(
        req.actor,
        req.params.projectId,
        patch,
      );

      res.json({
        requestId: req.requestId,
        data: safeProject(project),
      });
    } catch (error) {
      handleError(res, req, error);
    }
  });

  router.get("/:projectId/executions", async (req: any, res: any) => {
    try {
      const executions = await services.executions.byProject(
        req.actor,
        req.params.projectId,
      );
      res.json({
        requestId: req.requestId,
        data: executions.map(safeExecution),
      });
    } catch (error) {
      handleError(res, req, error);
    }
  });

  return router;
}

export function createExecutionsRouter(services: KernelServices): Router {
  const router = Router();

  router.get("/:executionId", async (req: any, res: any) => {
    try {
      const execution = await services.executions.get(
        req.actor,
        req.params.executionId,
      );
      res.json({
        requestId: req.requestId,
        data: safeExecution(execution),
      });
    } catch (error) {
      handleError(res, req, error);
    }
  });

  return router;
}