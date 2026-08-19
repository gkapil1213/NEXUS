/**
 * NEXUS Phase 2 — Pass 2: Secure agent execution & execution policy.
 *
 * One controlled boundary for every agent execution:
 *
 *   identity → AuthorizationService (permission) → AgentPolicyEngine
 *   (capability) → ExecutionPolicyEngine (risk routing) → [approval gate] →
 *   agent.execute → persist → audit → event
 *
 * Design rules honored here:
 *  - Fail closed: an unknown operation, unknown agent, or missing mapping is
 *    DENIED — never executed.
 *  - No arbitrary execution: the capability model exposes only read/inspect/
 *    analyze/generate. There is no shell, command, filesystem or deployment
 *    capability in this pass.
 *  - Agents never inherit identity permissions; they declare their own
 *    required_permissions and the identity must hold them.
 *  - REQUIRES_APPROVAL and BLOCKED never execute the agent.
 *  - An agent exception is persisted as FAILED with the real structured error
 *    — never converted to SUCCESS.
 *  - The same ExecutionPolicyEngine answers both preview() and run(), so the
 *    Security Preview can never disagree with actual execution.
 */

import type { AgentRegistry } from "./agents";
import { buildAgentContext } from "./agents";
import type { AuditService } from "./audit";
import type { EventService } from "./events";
import type { AuthorizationService } from "./security";
import { nid, type NexusEngine } from "./db";
import { Err, toSystemError } from "./errors";
import type {
  AgentExecutionRecord,
  OperationSpec,
  OperationType,
  Permission,
  PolicyCheck,
  PolicyDecision,
  PolicyVerdict,
  Project,
  RiskLevel,
  User,
} from "./types";

/** Minimal authenticated identity needed for policy decisions. */
export type PolicyActor = Pick<User, "id" | "email" | "role" | "status">;

/* ----------------------------- Operation catalog --------------------------- */

/**
 * Canonical operation → (capability, permission, risk) mapping. The policy
 * engine refuses to evaluate any operation absent from this table.
 */
export const OPERATION_SPECS: Record<OperationType, OperationSpec> = {
  PROJECT_INSPECT: { operation: "PROJECT_INSPECT", capability: "inspect", permission: "agent:execute", risk: "LOW" },
  PROJECT_ANALYZE: { operation: "PROJECT_ANALYZE", capability: "analyze", permission: "agent:execute", risk: "LOW" },
  EXECUTION_INSPECT: { operation: "EXECUTION_INSPECT", capability: "read_execution", permission: "execution:read", risk: "LOW" },
  TEST_RUN: { operation: "TEST_RUN", capability: "run_test", permission: "execution:create", risk: "MEDIUM" },
  ARTIFACT_GENERATE: { operation: "ARTIFACT_GENERATE", capability: "generate_artifact", permission: "artifact:create", risk: "MEDIUM" },
};

export function specFor(operation: OperationType): OperationSpec | null {
  return OPERATION_SPECS[operation] ?? null;
}

/* ------------------------------ AgentPolicyEngine -------------------------- */

/**
 * Capability gate: answers "may this identity run this agent for this
 * operation?" considering the agent's declared capabilities and the
 * permissions it requires. Pure — no side effects, no persistence.
 */
export class AgentPolicyEngine {
  decideCapability(
    agent: { capabilities: readonly string[]; required_permissions?: readonly Permission[] },
    operation: OperationType,
  ): { allowed: boolean; reason: string } {
    const spec = specFor(operation);
    if (!spec) return { allowed: false, reason: `operation '${operation}' has no policy mapping` };
    if (!agent.capabilities.includes(spec.capability)) {
      return { allowed: false, reason: `agent does not declare capability '${spec.capability}'` };
    }
    return { allowed: true, reason: `agent declares capability '${spec.capability}'` };
  }

  /** The identity must hold every permission the agent itself requires. */
  decideRequiredPermissions(
    actor: PolicyActor,
    agent: { required_permissions?: readonly Permission[] },
    authz: AuthorizationService,
  ): { allowed: boolean; reason: string } {
    const required = agent.required_permissions ?? [];
    for (const perm of required) {
      const d = authz.decide(actor, perm);
      if (!d.allowed) {
        return { allowed: false, reason: `identity lacks agent-required permission '${perm}' (${d.reason})` };
      }
    }
    return { allowed: true, reason: required.length === 0 ? "agent requires no extra permissions" : "all agent-required permissions held" };
  }
}

/* ---------------------------- ExecutionPolicyEngine ------------------------ */

export interface PolicyRequest {
  actor: PolicyActor;
  agentId: string;
  operation: OperationType;
  riskLevel?: RiskLevel; // defaults to the operation's canonical risk
  projectId?: string;
  executionId?: string;
}

/**
 * Full policy evaluation. Composes, in order: operation mapping → agent
 * existence → identity status → capability → permission → risk routing.
 * Returns a rich PolicyDecision; every check that ran is recorded so the
 * result is explainable and auditable. Fail-closed at every step.
 */
export class ExecutionPolicyEngine {
  constructor(
    private registry: AgentRegistry,
    private authz: AuthorizationService,
    private agentPolicy: AgentPolicyEngine,
  ) {}

  evaluate(req: PolicyRequest): PolicyDecision {
    const checks: PolicyCheck[] = [];
    const deny = (reason: string): PolicyDecision => ({ verdict: "DENIED", reason, checks });

    // 1. Operation must have a canonical mapping — fail closed.
    const spec = specFor(req.operation);
    if (!spec) {
      checks.push({ name: "operation_mapping", passed: false, detail: `no mapping for '${req.operation}'` });
      return deny(`operation '${req.operation}' is not supported`);
    }
    checks.push({ name: "operation_mapping", passed: true, detail: `${req.operation} → ${spec.capability}/${spec.permission}/${spec.risk}` });

    // 2. Agent must be registered.
    const agent = this.registry.get(req.agentId);
    if (!agent) {
      checks.push({ name: "agent_registered", passed: false, detail: `agent '${req.agentId}' not found` });
      return deny(`agent '${req.agentId}' is not registered`);
    }
    checks.push({ name: "agent_registered", passed: true, detail: agent.definition.id });

    // 3. Identity must be active (suspended/disabled fail closed).
    if (req.actor.status !== "active") {
      checks.push({ name: "identity_active", passed: false, detail: `identity is ${req.actor.status}` });
      return deny(`identity is ${req.actor.status}`);
    }
    checks.push({ name: "identity_active", passed: true, detail: "active" });

    // 4. Capability gate.
    const cap = this.agentPolicy.decideCapability(agent.definition, req.operation);
    checks.push({ name: "capability", passed: cap.allowed, detail: cap.reason });
    if (!cap.allowed) return deny(cap.reason);

    // 5. Permission gate (reuses Pass-1 AuthorizationService — no duplicated RBAC).
    const perm = this.authz.decide(req.actor, spec.permission);
    checks.push({ name: "permission", passed: perm.allowed, detail: perm.reason });
    if (!perm.allowed) return deny(perm.reason);

    const reqPerms = this.agentPolicy.decideRequiredPermissions(req.actor, agent.definition, this.authz);
    checks.push({ name: "agent_required_permissions", passed: reqPerms.allowed, detail: reqPerms.reason });
    if (!reqPerms.allowed) return deny(reqPerms.reason);

    // 6. Risk routing.
    const risk: RiskLevel = req.riskLevel ?? spec.risk;
    checks.push({ name: "risk_routing", passed: true, detail: `risk=${risk}` });
    switch (risk) {
      case "LOW":
        return { verdict: "ALLOWED", reason: "low-risk operation authorized", checks };
      case "MEDIUM":
        return { verdict: "ALLOWED", reason: "medium-risk operation authorized by policy", checks };
      case "HIGH":
        return { verdict: "REQUIRES_APPROVAL", reason: "high-risk operation requires approval", checks };
      case "CRITICAL":
        return { verdict: "BLOCKED", reason: "critical operations are blocked in this pass", checks };
    }
  }
}

/* ---------------------------- AgentExecutionService ------------------------ */

export interface AgentExecutionRequest extends PolicyRequest {
  /** Text handed to the agent as its request context. */
  requestText?: string;
}

export interface AgentExecutionServices {
  engine: NexusEngine;
  registry: AgentRegistry;
  authz: AuthorizationService;
  agentPolicy: AgentPolicyEngine;
  execPolicy: ExecutionPolicyEngine;
  audit: AuditService;
  events: EventService;
}

/**
 * The single controlled execution boundary. All agent execution flows through
 * run(); agents cannot be invoked directly by callers that want policy
 * enforcement. preview() answers the same policy question without executing.
 */
export class AgentExecutionService {
  constructor(private svc: AgentExecutionServices) {}

  /** Policy-only answer — identical engine to run(), no side effects beyond none. */
  preview(req: PolicyRequest): PolicyDecision {
    return this.svc.execPolicy.evaluate(req);
  }

  async list(): Promise<AgentExecutionRecord[]> {
    const rows = await this.svc.engine.all<AgentExecutionRecord>("agent_executions");
    return rows.sort((a, b) => b.started_at - a.started_at);
  }

  async run(req: AgentExecutionRequest): Promise<AgentExecutionRecord> {
    const started = Date.now();
    const executionId = req.executionId ?? nid("aex");
    const operation = req.operation;

    // Idempotency: a repeated request for the same logical execution returns
    // the existing record rather than creating duplicate work.
    const existing = await this.findByExecution(executionId, operation);
    if (existing) {
      await this.audit("agent.execution.requested", req, existing.decision, "idempotent: returned existing execution", existing.id);
      return existing;
    }

    const decision = this.svc.execPolicy.evaluate(req);
    const spec = specFor(operation);
    const risk: RiskLevel = req.riskLevel ?? spec?.risk ?? "LOW";

    // Non-ALLOWED decisions never execute the agent.
    if (decision.verdict !== "ALLOWED") {
      const status = decision.verdict === "BLOCKED" ? "BLOCKED" : decision.verdict === "REQUIRES_APPROVAL" ? "BLOCKED" : "FAILED";
      const rec = this.persist({
        execution_id: executionId,
        agent_id: req.agentId,
        operation,
        identity_id: req.actor.id,
        project_id: req.projectId ?? "",
        risk,
        decision: decision.verdict,
        status,
        started_at: started,
        completed_at: Date.now(),
        result_summary: decision.reason,
        error:
          decision.verdict === "DENIED"
            ? toSystemError(Err.denied("PERMISSION_DENIED", `permission denied: ${decision.reason}`))
            : null,
      });
      await this.svc.engine.put("agent_executions", rec.id, rec);
      await this.audit(
        decision.verdict === "BLOCKED" ? "agent.execution.blocked" : decision.verdict === "REQUIRES_APPROVAL" ? "agent.execution.blocked" : "agent.execution.denied",
        req,
        decision.verdict,
        decision.reason,
        rec.id,
      );
      return rec;
    }

    // ALLOWED — execute the agent inside a controlled context.
    await this.audit("agent.execution.allowed", req, "ALLOWED", decision.reason, executionId);
    await this.svc.events.emit({
      type: "agent.started",
      source: "AgentExecutionService",
      execution_id: executionId,
      payload: { agent_id: req.agentId, operation },
    });

    const agent = this.svc.registry.get(req.agentId)!;
    const project = req.projectId ? await this.svc.engine.get<Project>("projects", req.projectId) : undefined;
    if (!project) {
      const rec = this.persist({
        execution_id: executionId,
        agent_id: req.agentId,
        operation,
        identity_id: req.actor.id,
        project_id: req.projectId ?? "",
        risk,
        decision: "ALLOWED",
        status: "FAILED",
        started_at: started,
        completed_at: Date.now(),
        result_summary: "project not found",
        error: toSystemError(Err.notFound("PROJECT_NOT_FOUND", "project not found")),
      });
      await this.svc.engine.put("agent_executions", rec.id, rec);
      await this.audit("agent.execution.failed", req, "ALLOWED", "project not found", rec.id);
      await this.svc.events.emit({ type: "agent.failed", source: agent.definition.id, execution_id: executionId, payload: { code: "PROJECT_NOT_FOUND" } });
      return rec;
    }

    const ctx = buildAgentContext({
      execution_id: executionId,
      project,
      request: req.requestText ?? "",
      permissions: [],
      configuration: {},
    });

    try {
      const outcome = await agent.execute(ctx);
      if (outcome.status === "failed") {
        const rec = this.persist({
          execution_id: executionId,
          agent_id: req.agentId,
          operation,
          identity_id: req.actor.id,
          project_id: project.id,
          risk,
          decision: "ALLOWED",
          status: "FAILED",
          started_at: started,
          completed_at: Date.now(),
          result_summary: outcome.summary,
          error: outcome.error,
        });
        await this.svc.engine.put("agent_executions", rec.id, rec);
        await this.audit("agent.execution.failed", req, "ALLOWED", outcome.summary, rec.id);
        await this.svc.events.emit({ type: "agent.failed", source: agent.definition.id, execution_id: executionId, payload: { code: outcome.error.code } });
        return rec;
      }

      const rec = this.persist({
        execution_id: executionId,
        agent_id: req.agentId,
        operation,
        identity_id: req.actor.id,
        project_id: project.id,
        risk,
        decision: "ALLOWED",
        status: "SUCCEEDED",
        started_at: started,
        completed_at: Date.now(),
        result_summary: outcome.summary,
        error: null,
      });
      await this.svc.engine.put("agent_executions", rec.id, rec);
      await this.audit("agent.execution.completed", req, "ALLOWED", outcome.summary, rec.id);
      await this.svc.events.emit({ type: "agent.completed", source: agent.definition.id, execution_id: executionId, payload: { evidence: outcome.evidence.length, artifacts: outcome.artifacts.length } });
      return rec;
    } catch (e) {
      // A thrown agent is a FAILED execution — the real error is preserved.
      const error = toSystemError(e, "AGENT_EXECUTION_FAILED");
      const rec = this.persist({
        execution_id: executionId,
        agent_id: req.agentId,
        operation,
        identity_id: req.actor.id,
        project_id: project.id,
        risk,
        decision: "ALLOWED",
        status: "FAILED",
        started_at: started,
        completed_at: Date.now(),
        result_summary: error.message,
        error,
      });
      await this.svc.engine.put("agent_executions", rec.id, rec);
      await this.audit("agent.execution.failed", req, "ALLOWED", error.message, rec.id);
      await this.svc.events.emit({ type: "agent.failed", source: agent.definition.id, execution_id: executionId, payload: { code: error.code } });
      return rec;
    }
  }

  private persist(partial: Omit<AgentExecutionRecord, "id">): AgentExecutionRecord {
    return { id: nid("agx"), ...partial };
  }

  private async findByExecution(executionId: string, operation: OperationType): Promise<AgentExecutionRecord | undefined> {
    const rows = await this.svc.engine.byIndex<AgentExecutionRecord>("agent_executions", "byExecution", executionId);
    return rows.find((r) => r.operation === operation);
  }

  private async audit(
    action: string,
    req: PolicyRequest,
    decision: PolicyVerdict,
    reason: string,
    resourceId: string,
  ): Promise<void> {
    await this.svc.audit.record({
      actor: req.actor.email,
      action,
      resource_type: "agent_execution",
      resource_id: resourceId,
      result: decision === "ALLOWED" ? "allow" : decision === "DENIED" ? "deny" : decision === "BLOCKED" ? "deny" : "info",
      // No secrets, tokens or credential material is ever placed here; the
      // audit service additionally redacts forbidden keys before storage.
      metadata: {
        agent: req.agentId,
        operation: req.operation,
        project: req.projectId ?? null,
        execution: req.executionId ?? null,
        decision,
        risk: req.riskLevel ?? specFor(req.operation)?.risk ?? null,
        reason,
      },
    });
  }
}
