import { createOptimizationHypothesis } from './worker-optimization-hypothesis';
import { captureOptimizationBaseline } from './worker-optimization-baseline';
import { createOptimizationExperiment } from './worker-optimization-experiment';
import { evaluateStatistics } from './worker-optimization-statistics';
import { attributeOutcome } from './worker-policy-outcome-attribution';
import { evaluatePolicyEvolutionSafety } from './worker-policy-evolution-safety-gate';
import { governPolicyEvolution } from './worker-policy-evolution-governance';
import { evaluateRollout } from './worker-policy-evolution-rollout';
import { verifyPolicyOutcome } from './worker-policy-evolution-verification';
import { evaluatePromotion } from './worker-policy-promotion';
import { evaluateRollback } from './worker-policy-evolution-rollback';
import { closeDecision, DecisionClosure } from './worker-optimization-decision-closure';
import { createAuditEvent } from './worker-policy-evolution-audit';

export interface OptimizationOrchestrationInput {
  hypothesis: Parameters<typeof createOptimizationHypothesis>[0];
  baseline: Omit<Parameters<typeof captureOptimizationBaseline>[0], 'hypothesisId' | 'tenantId' | 'correlationId'>;
  experiment: Omit<Parameters<typeof createOptimizationExperiment>[0], 'hypothesisId' | 'tenantId' | 'correlationId'>;
  statistics: Parameters<typeof evaluateStatistics>[0];
  attribution: Parameters<typeof attributeOutcome>[0];
  safety: Parameters<typeof evaluatePolicyEvolutionSafety>[0];
  governance: Parameters<typeof governPolicyEvolution>[0];
  rollout: Parameters<typeof evaluateRollout>[0];
  verification: Parameters<typeof verifyPolicyOutcome>[0];
  promotion: Parameters<typeof evaluatePromotion>[0];
  rollback: Parameters<typeof evaluateRollback>[0];
}

export function orchestrateOptimization(input: OptimizationOrchestrationInput) {
  const hypothesis = createOptimizationHypothesis(input.hypothesis);
  const baseline = captureOptimizationBaseline({
    ...input.baseline,
    hypothesisId: hypothesis.hypothesisId,
    tenantId: hypothesis.tenantId,
    correlationId: hypothesis.correlationId,
  });
  const experiment = createOptimizationExperiment({
    ...input.experiment,
    hypothesisId: hypothesis.hypothesisId,
    tenantId: hypothesis.tenantId,
    correlationId: hypothesis.correlationId,
  });

  const stats = evaluateStatistics(input.statistics);
  const attribution = attributeOutcome(input.attribution);
  const safety = evaluatePolicyEvolutionSafety(input.safety);
  const governance = governPolicyEvolution({
    ...input.governance,
    tenantId: hypothesis.tenantId,
    policyId: 'policy-under-test',
    policyVersion: hypothesis.sourcePolicyVersion,
  });
  const rollout = evaluateRollout(input.rollout);
  const verification = verifyPolicyOutcome(input.verification);
  const promotion = evaluatePromotion({
    ...input.promotion,
    tenantId: hypothesis.tenantId,
    policyId: 'policy-under-test',
    currentVersion: hypothesis.sourcePolicyVersion,
    proposedVersion: 'next',
  });
  const rollback = evaluateRollback({
    ...input.rollback,
    tenantId: hypothesis.tenantId,
    policyId: 'policy-under-test',
    currentVersion: 'next',
  });

  let finalStatus: DecisionClosure['outcome'] = 'DEFERRED';
  if (stats === 'STATISTICALLY_SUPPORTED' && attribution.status === 'CAUSALLY_SUPPORTED' && verification === 'VERIFIED_IMPROVEMENT' && safety === 'ALLOW' && governance === 'ALLOW' && promotion === 'PROMOTED') {
    finalStatus = 'PROMOTED';
  } else if (stats === 'REGRESSION' || verification === 'VERIFIED_REGRESSION') {
    finalStatus = 'ROLLED_BACK';
  } else if (safety === 'DENY' || safety === 'OBSERVE_ONLY') {
    finalStatus = 'ABORTED_SAFETY';
  } else if (stats === 'INSUFFICIENT_DATA') {
    finalStatus = 'INSUFFICIENT_DATA';
  } else {
    finalStatus = 'DEFERRED';
  }

  const decision = closeDecision({
    experimentId: experiment.experimentId,
    hypothesisId: hypothesis.hypothesisId,
    tenantId: hypothesis.tenantId,
    policyVersion: hypothesis.sourcePolicyVersion,
    causalClassification: attribution.status,
    confidence: hypothesis.confidenceRequirement === 'HIGH' ? 'HIGH' : 'MEDIUM',
    metricSummary: baseline.metrics,
    riskSummary: hypothesis.riskLevel,
    safetyDecision: safety,
    governanceDecision: governance,
    rolloutSummary: rollout.nextStage,
    outcome: finalStatus,
    reason: `Based on stats: ${stats}, attribution: ${attribution.status}, verification: ${verification}`,
    correlationId: hypothesis.correlationId,
  });

  const auditEvents = [
    createAuditEvent({
      tenantId: hypothesis.tenantId,
      correlationId: hypothesis.correlationId,
      policyId: 'policy-under-test',
      policyVersion: hypothesis.sourcePolicyVersion,
      eventType: 'HYPOTHESIS_CREATED',
      result: 'CREATED',
      reason: 'Optimization hypothesis created',
    }),
    createAuditEvent({
      tenantId: hypothesis.tenantId,
      correlationId: hypothesis.correlationId,
      policyId: 'policy-under-test',
      policyVersion: hypothesis.sourcePolicyVersion,
      eventType: 'EXPERIMENT_CREATED',
      result: experiment.status,
      reason: 'Optimization experiment created',
    }),
    createAuditEvent({
      tenantId: hypothesis.tenantId,
      correlationId: hypothesis.correlationId,
      policyId: 'policy-under-test',
      policyVersion: hypothesis.sourcePolicyVersion,
      eventType: 'DECISION_CLOSED',
      result: decision.outcome,
      reason: decision.reason,
    }),
  ];

  return {
    hypothesis,
    baseline,
    experiment,
    stats,
    attribution,
    safety,
    governance,
    rollout,
    verification,
    promotion,
    rollback,
    decision,
    auditEvents,
  };
}
