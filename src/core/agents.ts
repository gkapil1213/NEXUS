/**
 * NEXUS Phase 1 — agent framework foundation.
 *
 * A generic Agent contract, a registry (register/discover/validate with
 * duplicate prevention) and a controlled AgentContext builder that never
 * places secret values into agent inputs — only references.
 *
 * Phase 1 ships exactly one reference agent (InspectorAgent) that performs
 * REAL static analysis of the request + project metadata. Future phases add
 * capable agents behind this same interface.
 */

import { digestOf, nid } from "./db";
import { Err } from "./errors";
import type {
  AgentCapability,
  AgentContext,
  AgentDefinition,
  AgentOutcome,
  EvidenceInput,
  Permission,
  Project,
  SecretReference,
  SystemError,
} from "./types";

/* --------------------------------- Contract -------------------------------- */

export interface Agent {
  readonly definition: AgentDefinition;
  execute(ctx: AgentContext): Promise<AgentOutcome>;
}

/* --------------------------------- Registry -------------------------------- */

export class AgentRegistry {
  private agents = new Map<string, Agent>();

  /** Register an agent. Duplicate ids are rejected — never silently replaced. */
  register(agent: Agent): AgentDefinition {
    const def = agent.definition;
    if (!def.id || !def.name) throw Err.validation("INVALID_AGENT", "agent requires id and name");
    if (def.capabilities.length === 0) {
      throw Err.validation("INVALID_AGENT", "agent must declare at least one capability");
    }
    if (this.agents.has(def.id)) {
      throw Err.conflict("AGENT_EXISTS", `agent '${def.id}' is already registered`);
    }
    this.agents.set(def.id, agent);
    return def;
  }

  get(id: string): Agent | undefined {
    return this.agents.get(id);
  }

  list(): AgentDefinition[] {
    return Array.from(this.agents.values())
      .map((a) => a.definition)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Deterministic selection: agents exposing the capability, by id order. */
  byCapability(capability: AgentCapability): Agent[] {
    return Array.from(this.agents.values())
      .filter((a) => a.definition.capabilities.includes(capability))
      .sort((a, b) => a.definition.id.localeCompare(b.definition.id));
  }

  count(): number {
    return this.agents.size;
  }
}

/* --------------------------------- Context --------------------------------- */

export interface ContextInput {
  execution_id: string;
  project: Project;
  request: string;
  permissions: Permission[];
  configuration: Record<string, unknown>;
  evidence_refs?: string[];
  secret_refs?: SecretReference[];
}

/** Build the controlled context an agent receives. Secret VALUES never enter. */
export function buildAgentContext(input: ContextInput): AgentContext {
  return {
    execution_id: input.execution_id,
    project_id: input.project.id,
    request: input.request,
    permissions: [...input.permissions],
    configuration: {
      ...input.configuration, // safe values only
      project_summary: {
        id: input.project.id,
        name: input.project.name,
        status: input.project.status,
        repository: input.project.repository || null,
        default_branch: input.project.default_branch,
      },
    },
    evidence_refs: [...(input.evidence_refs ?? [])],
    secret_refs: [...(input.secret_refs ?? [])], // references only
  };
}

/* ------------------------------ Inspector agent ---------------------------- */

/**
 * The Phase 1 reference agent. Performs real static analysis: computes the
 * request digest, extracts structural metrics and derives requirement
 * signals — every output is computed from actual inputs and labelled
 * STATIC_ANALYSIS. It never claims execution results it did not produce.
 */
export class InspectorAgent implements Agent {
  readonly definition: AgentDefinition = {
    id: "nexus.inspector",
    name: "Inspector",
    description: "Static analysis of engineering requests against project context. Produces digests, metrics and requirement signals.",
    version: "1.0.0",
    capabilities: ["inspect", "analyze"],
    // Phase 2 Pass 2 — explicit contract: the invoking identity must hold
    // agent:execute, and the agent's own operations are LOW risk.
    required_permissions: ["agent:execute"],
    risk_level: "LOW",
  };

  async execute(ctx: AgentContext): Promise<AgentOutcome> {
    const requestDigest = await digestOf(ctx.request);
    const words = ctx.request.split(/\s+/).filter(Boolean);
    const sentences = ctx.request.split(/[.!?\n]+/).filter((s) => s.trim().length > 0);

    const signals = [
      ["ui", /interface|dashboard|screen|page|app|mobile|web/i],
      ["api", /api|endpoint|rest|graphql|service/i],
      ["data", /database|store|persist|data|record/i],
      ["auth", /auth|login|user|permission|role/i],
      ["integration", /integrat|webhook|ci|deploy|pipeline/i],
    ] as const;
    const detected = signals.filter(([, re]) => re.test(ctx.request)).map(([k]) => k);

    const summary = (ctx.configuration.project_summary ?? { id: ctx.project_id, name: null, repository: null, default_branch: null }) as {
      id: string;
      name: string | null;
      repository: string | null;
      default_branch: string | null;
    };
    const report = {
      request_digest: requestDigest,
      metrics: { words: words.length, sentences: sentences.length, characters: ctx.request.length },
      requirement_signals: detected,
      project: { id: summary.id, name: summary.name, repository: summary.repository, branch: summary.default_branch },
      note: "Phase 1 foundation: static analysis only. Execution capabilities arrive in later phases.",
      generated_at: new Date().toISOString(),
    };
    const reportJson = JSON.stringify(report, null, 2);

    const evidence: EvidenceInput[] = [
      {
        type: "hash",
        source: "STATIC_ANALYSIS",
        content: requestDigest,
        metadata: { label: "request digest (sha256)" },
      },
      {
        type: "report",
        source: "STATIC_ANALYSIS",
        content: reportJson,
        metadata: { label: "inspection report", signals: detected },
      },
    ];

    return {
      status: "completed",
      summary: `Inspected request (${words.length} words, ${detected.length} signal${detected.length === 1 ? "" : "s"}: ${detected.join(", ") || "none"})`,
      artifacts: [{ kind: "report", name: "inspection-report.json", content: reportJson }],
      evidence,
    };
  }
}

export function failureOutcome(message: string, code = "AGENT_FAILED"): AgentOutcome {
  const error: SystemError = {
    code,
    message,
    category: "runtime",
    recoverable: false,
    timestamp: Date.now(),
  };
  return { status: "failed", summary: message, error };
}

export { nid };
