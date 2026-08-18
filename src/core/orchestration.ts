/**
 * NEXUS Phase 1 — NexusOrchestrator.
 *
 * The single, deterministic execution path:
 *
 *   validate request → create execution (QUEUED) → select agent (registry)
 *     → RUNNING → agent.execute(controlled context) → record evidence +
 *     artifacts + events → SUCCEEDED | FAILED
 *
 * An execution is marked SUCCEEDED only when the agent genuinely completed.
 * Failures preserve the real structured error. No path converts a failure
 * into success, and agents receive no secret values.
 */

import type { AgentRegistry, Agent } from "./agents";
import { buildAgentContext } from "./agents";
import { CONFIG, safeConfigView } from "./config";
import type { ArtifactService, ExecutionService, EvidenceService, ProjectService } from "./services";
import { can, permissionsFor } from "./security";
import { toSystemError } from "./errors";
import { Err } from "./errors";
import { nid } from "./db";
import type { AgentRun, Execution, NexusEvent, Project } from "./types";
import type { Actor } from "./services";
import type { NexusEngine } from "./db";
import type { EventService } from "./events";
import type { AuditService } from "./audit";
import { validateRequestText } from "./security";

export interface OrchestratorServices {
  engine: NexusEngine;
  events: EventService;
  audit: AuditService;
  registry: AgentRegistry;
  projects: ProjectService;
  executions: ExecutionService;
  evidence: EvidenceService;
  artifacts: ArtifactService;
}

export interface SubmitResult {
  execution: Execution;
  agent_run: AgentRun | null;
  events: NexusEvent[];
}

export class NexusOrchestrator {
  constructor(private svc: OrchestratorServices) {}

  /** Deterministic agent selection: first registered agent with the needed
   *  capability. Arbitrary agent choice from untrusted input is not allowed. */
  private selectAgent(): Agent | null {
    return this.svc.registry.byCapability("inspect")[0] ?? null;
  }

  async submit(actor: Actor, projectId: string, requestText: string): Promise<SubmitResult> {
    const request = validateRequestText(requestText);

    // Authorization — denials are audited and thrown.
    if (!can(actor, "execution:create")) {
      await this.svc.audit.record({
        actor: actor.email,
        action: "denied:execution:create",
        resource_type: "execution",
        resource_id: "*",
        result: "deny",
        metadata: { role: actor.role },
      });
      throw Err.denied("PERMISSION_DENIED", `role ${actor.role} does not hold 'execution:create'`);
    }

    // The project must exist and be ACTIVE.
    const project: Project = await this.svc.projects.get(actor, projectId);
    if (project.status !== "ACTIVE") {
      throw Err.validation("PROJECT_NOT_ACTIVE", `project is ${project.status} — only ACTIVE projects accept executions`);
    }

    const events: NexusEvent[] = [];

    // 1. Create the execution (QUEUED) — audited + evented.
    let execution = await this.svc.executions.createQueued(actor, project.id, request);
    await this.svc.audit.record({
      actor: actor.email,
      action: "execution.create",
      resource_type: "execution",
      resource_id: execution.id,
      result: "allow",
      metadata: { project_id: project.id, request_preview: `${request.slice(0, 80)}${request.length > 80 ? "…" : ""}` },
    });
    events.push(await this.svc.events.emit({ type: "execution.created", source: "Orchestrator", execution_id: execution.id, payload: { project_id: project.id } }));

    // 2. Select the agent deterministically.
    const agent = this.selectAgent();
    if (!agent) {
      execution = await this.svc.executions.transition(actor, execution.id, "FAILED", toSystemError(Err.runtime("NO_AGENT_AVAILABLE", "no registered agent provides the required capability")));
      return { execution, agent_run: null, events };
    }

    // 3. RUNNING + agent run record.
    execution = await this.svc.executions.transition(actor, execution.id, "RUNNING");
    const agentRun: AgentRun = {
      id: nid("run"),
      execution_id: execution.id,
      agent_id: agent.definition.id,
      started_at: Date.now(),
      completed_at: null,
      status: "RUNNING",
      outcome_summary: "",
      error: null,
    };
    await this.svc.engine.put("agent_runs", agentRun.id, agentRun);
    events.push(await this.svc.events.emit({ type: "agent.started", source: "Orchestrator", execution_id: execution.id, payload: { agent_id: agent.definition.id, agent_run_id: agentRun.id } }));
    await this.svc.audit.record({
      actor: actor.email,
      action: "agent.execute",
      resource_type: "agent",
      resource_id: agent.definition.id,
      result: "allow",
      metadata: { execution_id: execution.id, agent_version: agent.definition.version },
    });

    // 4. Execute with a controlled context (no secrets, no arbitrary commands).
    const ctx = buildAgentContext({
      execution_id: execution.id,
      project,
      request,
      permissions: permissionsFor(actor.role),
      configuration: { env: CONFIG.env, version: CONFIG.version, ...safeConfigView() },
    });

    try {
      const outcome = await agent.execute(ctx);

      if (outcome.status === "failed") {
        agentRun.status = "FAILED";
        agentRun.completed_at = Date.now();
        agentRun.outcome_summary = outcome.summary;
        agentRun.error = outcome.error;
        await this.svc.engine.put("agent_runs", agentRun.id, agentRun);
        events.push(await this.svc.events.emit({ type: "agent.failed", source: agent.definition.id, execution_id: execution.id, payload: { agent_run_id: agentRun.id, code: outcome.error.code } }));
        execution = await this.svc.executions.transition(actor, execution.id, "FAILED", outcome.error);
        return { execution, agent_run: agentRun, events };
      }

      // 5. Record REAL evidence + artifacts from the outcome.
      for (const ev of outcome.evidence) {
        await this.svc.evidence.record(execution.id, ev);
      }
      for (const art of outcome.artifacts) {
        await this.svc.artifacts.register(execution.id, art);
      }

      agentRun.status = "SUCCEEDED";
      agentRun.completed_at = Date.now();
      agentRun.outcome_summary = outcome.summary;
      await this.svc.engine.put("agent_runs", agentRun.id, agentRun);
      events.push(await this.svc.events.emit({ type: "agent.completed", source: agent.definition.id, execution_id: execution.id, payload: { agent_run_id: agentRun.id, evidence: outcome.evidence.length, artifacts: outcome.artifacts.length } }));

      // 6. SUCCEEDED — only reachable when the agent genuinely completed.
      execution = await this.svc.executions.transition(actor, execution.id, "SUCCEEDED");
      return { execution, agent_run: agentRun, events };
    } catch (e) {
      const error = toSystemError(e, "AGENT_EXECUTION_FAILED");
      agentRun.status = "FAILED";
      agentRun.completed_at = Date.now();
      agentRun.outcome_summary = error.message;
      agentRun.error = error;
      await this.svc.engine.put("agent_runs", agentRun.id, agentRun);
      events.push(await this.svc.events.emit({ type: "agent.failed", source: agent.definition.id, execution_id: execution.id, payload: { agent_run_id: agentRun.id, code: error.code } }));
      execution = await this.svc.executions.transition(actor, execution.id, "FAILED", error);
      return { execution, agent_run: agentRun, events };
    }
  }

  async agentRuns(executionId: string): Promise<AgentRun[]> {
    const rows = await this.svc.engine.byIndex<AgentRun>("agent_runs", "byExecution", executionId);
    return rows.sort((a, b) => a.started_at - b.started_at);
  }
}

export type { NexusEvent };
