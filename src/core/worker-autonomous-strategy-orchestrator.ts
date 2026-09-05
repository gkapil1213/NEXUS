import { createOptimizationStrategy } from './worker-optimization-strategy';
import { synthesizeStrategyCandidate } from './worker-optimization-strategy-synthesis';
import { scoreStrategy } from './worker-optimization-strategy-scoring';
import { findParetoOptimal } from './worker-optimization-strategy-pareto';
import { checkConstraint } from './worker-optimization-strategy-constraints';
import { arbitrateStrategy } from './worker-optimization-strategy-arbitrator';
import { governStrategy } from './worker-optimization-strategy-governance';
import { evaluateStrategySafety } from './worker-optimization-strategy-safety';
import { reserveStrategyResources } from './worker-optimization-strategy-resource-budget';
import { evaluateStrategyRollout } from './worker-optimization-strategy-rollout';
import { verifyStrategyOutcome } from './worker-optimization-strategy-verification';
import { evaluateStrategyRollback } from './worker-optimization-strategy-rollback';
import { addStrategyLineageVersion, StrategyLineage } from './worker-optimization-strategy-lineage';
import { createStrategyAuditEvent } from './worker-optimization-strategy-audit';

export interface StrategyOrchestrationInput {
  tenantId: string;
  correlationId: string;
  strategy: Omit<Parameters<typeof createOptimizationStrategy>[0], 'tenantId' | 'correlationId'>;
  synthesis: Omit<Parameters<typeof synthesizeStrategyCandidate>[0], 'tenantId' | 'strategyId' | 'correlationId'>;
  constraints: Parameters<typeof checkConstraint>[0][];
  arbitration: Parameters<typeof arbitrateStrategy>[0];
  governance: Parameters<typeof governStrategy>[0];
  safety: Parameters<typeof evaluateStrategySafety>[0];
  resourceLimits: Record<string, number>;
  resourceRequests: Record<string, number>;
  rollout: Parameters<typeof evaluateStrategyRollout>[0];
  verification: Parameters<typeof verifyStrategyOutcome>[0];
  rollback: Parameters<typeof evaluateStrategyRollback>[0];
  lineageInitial?: StrategyLineage;
}

export function orchestrateStrategy(input: StrategyOrchestrationInput) {
  // 1. Create strategy
  const strategy = createOptimizationStrategy({
    ...input.strategy,
    tenantId: input.tenantId,
    correlationId: input.correlationId,
  });

  // 2. Synthesize candidate
  const candidate = synthesizeStrategyCandidate({
    ...input.synthesis,
    tenantId: input.tenantId,
    strategyId: strategy.strategyId,
    correlationId: input.correlationId,
  });

  // 3. Score candidate
  const score = scoreStrategy({
    objectiveBenefit: Object.values(candidate.objectiveImpacts).reduce((s, v) => s + v, 0),
    confidence: candidate.confidence,
    evidenceQuality: input.synthesis.evidenceQuality,
    durabilityFactor: input.synthesis.durabilityFactor,
    interactionFactor: input.synthesis.interactionFactor,
    riskPenalty: input.synthesis.riskPenalty,
    resourcePenalty: input.synthesis.resourcePenalty,
  });

  // 4. Constraints
  const hardConstraintsViolated = input.constraints.some(c => c.type === 'HARD' && !checkConstraint(c));

  // 5. Arbitration
  const arbitration = arbitrateStrategy({
    ...input.arbitration,
    hardConstraintViolation: hardConstraintsViolated,
  });

  // 6. Governance
  const governance = governStrategy(input.governance);

  // 7. Safety
  const safety = evaluateStrategySafety(input.safety);

  // 8. Resource budget
  const resourceResult = reserveStrategyResources(
    { tenantId: input.tenantId, limits: input.resourceLimits, currentUsage: {}, reserved: {} },
    input.resourceRequests
  );

  // 9. Rollout
  const rollout = evaluateStrategyRollout(input.rollout);

  // 10. Verification
  const verification = verifyStrategyOutcome(input.verification);

  // 11. Rollback
  const rollback = evaluateStrategyRollback(input.rollback);

  // 12. Lineage
  const lineageBase: StrategyLineage = input.lineageInitial ?? {
    strategyId: strategy.strategyId,
    tenantId: input.tenantId,
    versions: [],
  };
  const lineage = addStrategyLineageVersion(lineageBase, {
    version: '1',
    parentVersion: null,
    strategyId: strategy.strategyId,
    candidateIds: [candidate.candidateId],
    portfolioIds: strategy.portfolioRefs,
    experimentIds: [],
    policyIds: [],
    evidenceRefs: strategy.evidenceRefs,
    reason: 'strategy orchestration',
    status: 'ACTIVE',
    timestamp: new Date().toISOString(),
  });

  // 13. Audit events
  const auditEvents = [
    createStrategyAuditEvent({
      tenantId: input.tenantId,
      correlationId: input.correlationId,
      strategyId: strategy.strategyId,
      strategyVersion: '1',
      eventType: 'STRATEGY_CREATED',
      reason: 'Strategy created',
      decision: strategy.lifecycleStatus,
    }),
    createStrategyAuditEvent({
      tenantId: input.tenantId,
      correlationId: input.correlationId,
      strategyId: strategy.strategyId,
      strategyVersion: '1',
      eventType: 'STRATEGY_SCORED',
      reason: `Score: ${score.score}`,
      decision: score.score > 0 ? 'SCORED' : 'LOW_SCORE',
    }),
    createStrategyAuditEvent({
      tenantId: input.tenantId,
      correlationId: input.correlationId,
      strategyId: strategy.strategyId,
      strategyVersion: '1',
      eventType: 'STRATEGY_CONSTRAINT_DENIED',
      reason: hardConstraintsViolated ? 'Hard constraint violated' : 'Constraints passed',
      decision: hardConstraintsViolated ? 'DENY' : 'ALLOW',
    }),
    createStrategyAuditEvent({
      tenantId: input.tenantId,
      correlationId: input.correlationId,
      strategyId: strategy.strategyId,
      strategyVersion: '1',
      eventType: 'STRATEGY_ARBITRATION_DENIED',
      reason: arbitration,
      decision: arbitration,
    }),
  ];

  return {
    strategy,
    candidate,
    score,
    hardConstraintsViolated,
    arbitration,
    governance,
    safety,
    resourceSuccess: resourceResult.success,
    resourceReason: resourceResult.reason,
    rollout,
    verification,
    rollback,
    lineage,
    auditEvents,
  };
}
