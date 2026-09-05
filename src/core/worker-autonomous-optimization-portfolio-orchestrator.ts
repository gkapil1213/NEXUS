import { createOptimizationPortfolio } from './worker-optimization-portfolio';
import { validateObjectives, ObjectiveDefinition } from './worker-optimization-objectives';
import { createOptimizationCandidate } from './worker-optimization-candidate';
import { classifyPareto } from './worker-optimization-pareto';
import { detectInteraction } from './worker-optimization-interaction';
import { arbitrateCandidate } from './worker-optimization-arbitrator';
import { createResourceBudget, reserveResource } from './worker-optimization-resource-budget';
import { scheduleCandidate } from './worker-optimization-scheduler';
import { governPortfolio } from './worker-optimization-portfolio-governance';
import { evaluatePortfolioSafety } from './worker-optimization-portfolio-safety';
import { evaluatePortfolioRollout } from './worker-optimization-portfolio-rollout';
import { evaluatePortfolioRollback } from './worker-optimization-portfolio-rollback';
import { closePortfolio } from './worker-optimization-portfolio-closure';
import { evaluatePortfolioStability } from './worker-optimization-portfolio-stability';
import { addPortfolioVersion, PortfolioLineage } from './worker-optimization-portfolio-lineage';
import { createPortfolioAuditEvent } from './worker-optimization-portfolio-audit';

export interface PortfolioOrchestrationInput {
  tenantId: string;
  correlationId: string;
  objectives: ObjectiveDefinition[];
  candidates: {
    source: string;
    sourceVersion: string;
    objectiveImpact: Record<string, number>;
    expectedBenefit: number;
    confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
    risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';
    requiredEvidence: string[];
    dependencies: string[];
    conflicts: string[];
    rollbackPlan: string;
  }[];
  resourceLimits: Record<string, number>;
  resourceRequests: Record<string, number>;
  governance: Parameters<typeof governPortfolio>[0];
  safety: Parameters<typeof evaluatePortfolioSafety>[0];
  rollout: Parameters<typeof evaluatePortfolioRollout>[0];
  rollback: Parameters<typeof evaluatePortfolioRollback>[0];
  closure: Parameters<typeof closePortfolio>[0];
  stability: Parameters<typeof evaluatePortfolioStability>[0];
}

export function orchestratePortfolio(input: PortfolioOrchestrationInput) {
  // Validate objectives
  const objectiveValidation = validateObjectives(input.objectives);
  if (!objectiveValidation.valid) {
    throw new Error(`Invalid objectives: ${objectiveValidation.reason}`);
  }

  // Create portfolio
  const portfolio = createOptimizationPortfolio({
    tenantId: input.tenantId,
    objectiveSet: input.objectives.map(o => o.name),
    candidates: [],
    experiments: [],
    policyVersions: [],
    state: 'DRAFT',
    priority: 1,
    risk: 'UNKNOWN',
    expectedBenefit: 0,
    confidence: 'UNKNOWN',
    resourceRequirements: input.resourceRequests,
    dependencies: [],
    conflicts: [],
    correlationId: input.correlationId,
  });

  // Create candidates and arbitrate
  const candidateObjects = input.candidates.map(c => createOptimizationCandidate({
    tenantId: input.tenantId,
    source: c.source,
    sourceVersion: c.sourceVersion,
    objectiveImpact: c.objectiveImpact,
    expectedBenefit: c.expectedBenefit,
    confidence: c.confidence,
    risk: c.risk,
    requiredEvidence: c.requiredEvidence,
    dependencies: c.dependencies,
    conflicts: c.conflicts,
    rollbackPlan: c.rollbackPlan,
    correlationId: input.correlationId,
  }));

  const arbitratedCandidates = candidateObjects.map(c => ({
    candidate: c,
    decision: arbitrateCandidate({
      candidateRisk: c.risk,
      confidence: c.confidence,
      expectedBenefit: c.expectedBenefit,
      hardConstraintViolation: false, // we'll assume false for now; would be set by pareto
      activeIncident: input.governance.activeIncident,
      productionFreeze: input.governance.productionFreeze,
      insufficientEvidence: input.governance.insufficientEvidence,
      resourceOvercommit: false, // we'll check later
      conflictDetected: false,
    }),
  }));

  // Resource budget
  let budget = createResourceBudget(input.tenantId, input.resourceLimits);
  let resourceSuccess = true;
  for (const [resource, amount] of Object.entries(input.resourceRequests)) {
    const res = reserveResource(budget, resource, amount);
    if (!res.success) {
      resourceSuccess = false;
      break;
    }
    budget = res.budget;
  }

  // Governance and safety
  const governance = governPortfolio(input.governance);
  const safety = evaluatePortfolioSafety(input.safety);

  // Simple scheduling decision: use first candidate if any
  const scheduling = scheduleCandidate({
    candidateId: candidateObjects[0]?.candidateId ?? 'none',
    tenantId: input.tenantId,
    dependencies: candidateObjects[0]?.dependencies ?? [],
    conflicts: candidateObjects[0]?.conflicts ?? [],
    risk: candidateObjects[0]?.risk ?? 'UNKNOWN',
    activeIncident: input.governance.activeIncident,
    productionFreeze: input.governance.productionFreeze,
    resourceAvailable: resourceSuccess,
    concurrentExperiments: 0,
    maxConcurrentExperiments: 1,
  }, []);

  // Rollout
  const rollout = evaluatePortfolioRollout(input.rollout);

  // Rollback
  const rollback = evaluatePortfolioRollback(input.rollback);

  // Closure
  const closure = closePortfolio(input.closure);

  // Stability
  const stability = evaluatePortfolioStability(input.stability);

  // Lineage
  const lineage: PortfolioLineage = {
    portfolioId: portfolio.portfolioId,
    tenantId: input.tenantId,
    versions: [],
  };
  const lineageWithVersion = addPortfolioVersion(lineage, {
    version: '1',
    parentVersion: null,
    reason: 'initial portfolio',
    candidateIds: candidateObjects.map(c => c.candidateId),
    experimentIds: [],
    correlationId: input.correlationId,
    timestamp: new Date().toISOString(),
    status: 'ACTIVE',
  });

  // Audit events
  const auditEvents = [
    createPortfolioAuditEvent({
      tenantId: input.tenantId,
      correlationId: input.correlationId,
      entityId: portfolio.portfolioId,
      entityVersion: '1',
      eventType: 'PORTFOLIO_CREATED',
      reason: 'Portfolio created',
      decision: portfolio.state,
    }),
    createPortfolioAuditEvent({
      tenantId: input.tenantId,
      correlationId: input.correlationId,
      entityId: portfolio.portfolioId,
      entityVersion: '1',
      eventType: 'CANDIDATE_ARBITRATED',
      reason: 'Candidates arbitrated',
      decision: arbitratedCandidates[0]?.decision ?? 'NONE',
    }),
    createPortfolioAuditEvent({
      tenantId: input.tenantId,
      correlationId: input.correlationId,
      entityId: portfolio.portfolioId,
      entityVersion: '1',
      eventType: 'GOVERNANCE_DECISION',
      reason: 'Governance evaluation',
      decision: governance,
    }),
    createPortfolioAuditEvent({
      tenantId: input.tenantId,
      correlationId: input.correlationId,
      entityId: portfolio.portfolioId,
      entityVersion: '1',
      eventType: 'SAFETY_DECISION',
      reason: 'Safety evaluation',
      decision: safety,
    }),
  ];

  return {
    portfolio,
    objectiveValidation,
    candidateObjects,
    arbitratedCandidates,
    resourceSuccess,
    governance,
    safety,
    scheduling,
    rollout,
    rollback,
    closure,
    stability,
    lineage: lineageWithVersion,
    auditEvents,
  };
}
