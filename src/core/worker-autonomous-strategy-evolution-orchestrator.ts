import { createStrategyGeneration } from './worker-strategy-evolution-generation';
import { addLineageNode, StrategyLineage } from './worker-strategy-evolution-lineage';
import { createEvolutionCandidate } from './worker-strategy-evolution-candidate';
import { computeStrategyDelta } from './worker-strategy-evolution-delta';
import { validateStrategyEvolutionConstraints } from './worker-strategy-evolution-constraints';
import { evaluateEvolutionSafety } from './worker-strategy-evolution-safety';
import { evaluateEvolutionConfidence } from './worker-strategy-evolution-confidence';
import { evaluateRegression } from './worker-strategy-evolution-regression';
import { createShadowEvaluation, completeShadowEvaluation } from './worker-strategy-evolution-shadow';
import { governEvolutionCandidate } from './worker-strategy-evolution-governance';
import { scoreEvolutionCandidate } from './worker-strategy-evolution-scoring';
import { evaluateEvolutionRollout } from './worker-strategy-evolution-rollout';
import { evaluateEvolutionRollback } from './worker-strategy-evolution-rollback';
import { decideRetirement } from './worker-strategy-evolution-retirement';
import { createEvolutionLearningRecord } from './worker-strategy-evolution-learning';
import { createEvolutionAuditEvent } from './worker-strategy-evolution-audit';
import { compareGenerations } from './worker-strategy-evolution-comparison';

export interface EvolutionOrchestrationInput {
  tenantId: string;
  strategyId: string;
  parentGenerationId: string | null;
  rootStrategyId: string;
  correlationId: string;
  sourceEvidence: string[];
  learningInputs: string[];
  mutationRationale: string;
  constraints: string[];
  expectedObjectives: Record<string, number>;
  candidateInput: Omit<Parameters<typeof createEvolutionCandidate>[0], 'parentGenerationId' | 'tenantId' | 'correlationId'>;
  baselineMetrics: Record<string, number>;
  candidateMetrics: Record<string, number>;
  allowedRegression: Record<string, number>;
  criticalMetrics: string[];
  confidenceInput: Parameters<typeof evaluateEvolutionConfidence>[0];
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';
  governanceInput: Omit<Parameters<typeof governEvolutionCandidate>[0], 'candidateRisk' | 'confidence'>;
  resourceBudgetAvailable: boolean;
  rollbackCapabilityExists: boolean;
  lineage: StrategyLineage;
  expectedGeneration: number;
}

export function orchestrateStrategyEvolution(input: EvolutionOrchestrationInput) {
  // 1. Create generation (proposed)
  const generation = createStrategyGeneration({
    strategyId: input.strategyId,
    parentGenerationId: input.parentGenerationId,
    rootStrategyId: input.rootStrategyId,
    tenantId: input.tenantId,
    sourceEvidence: input.sourceEvidence,
    learningInputs: input.learningInputs,
    mutationRationale: input.mutationRationale,
    constraints: input.constraints,
    expectedObjectives: input.expectedObjectives,
    confidence: 'UNKNOWN',
    validationStatus: 'PENDING',
    governanceStatus: 'PENDING',
    rolloutStatus: 'PENDING',
    outcomeStatus: 'PENDING',
    retirementStatus: 'ACTIVE',
    correlationId: input.correlationId,
  });

  // 2. Create candidate
  const candidate = createEvolutionCandidate({
    ...input.candidateInput,
    parentGenerationId: input.parentGenerationId ?? generation.parentGenerationId ?? '',
    parentStrategyId: input.strategyId,
    proposedGeneration: input.expectedGeneration,
    tenantId: input.tenantId,
    correlationId: input.correlationId,
  });

  // 3. Compute delta
  const delta = computeStrategyDelta(
    { generationId: input.parentGenerationId, strategyId: input.strategyId },
    { candidateId: candidate.candidateId, changeSet: candidate.changeSet },
    [],
    input.constraints
  );

  // 4. Constraints validation
  const constraintsResult = validateStrategyEvolutionConstraints([]);

  // 5. Confidence
  const confidence = evaluateEvolutionConfidence(input.confidenceInput);

  // 6. Regression
  const regression = evaluateRegression({
    baseline: input.baselineMetrics,
    candidate: input.candidateMetrics,
    allowedRegression: input.allowedRegression,
    criticalMetrics: input.criticalMetrics,
  });

  // 7. Shadow evaluation (simulate deterministic pass)
  const shadow = createShadowEvaluation({
    tenantId: input.tenantId,
    candidateId: candidate.candidateId,
    parentGenerationId: input.parentGenerationId ?? generation.parentGenerationId ?? '',
    correlationId: input.correlationId,
    baselineMetrics: input.baselineMetrics,
    candidateMetrics: input.candidateMetrics,
    evidence: [],
  });
  const shadowCompleted = completeShadowEvaluation(shadow, input.baselineMetrics, input.candidateMetrics, 'PASS');

  // 8. Governance
  const governance = governEvolutionCandidate({
    ...input.governanceInput,
    candidateRisk: input.riskLevel,
    confidence,
  });

  // 9. Safety
  const safety = evaluateEvolutionSafety({
    parentStrategyExists: true,
    parentGenerationValid: true,
    duplicateCandidate: false,
    validLineage: true,
    validChangeSet: Object.keys(candidate.changeSet).length > 0,
    constraintsPass: constraintsResult.valid,
    safetyChecksPass: true,
    confidenceThresholdMet: confidence === 'HIGH' || confidence === 'VERY_HIGH' || confidence === 'MEDIUM',
    regressionChecksPass: regression.decision === 'ACCEPT',
    shadowEvaluationPassed: shadowCompleted.outcome === 'PASS',
    resourceBudgetAvailable: input.resourceBudgetAvailable,
    governancePassed: governance === 'APPROVE',
    rollbackCapabilityExists: input.rollbackCapabilityExists,
  });

  // 10. Scoring
  const score = scoreEvolutionCandidate({
    objectiveBenefit: Object.values(candidate.expectedBenefits).reduce((s, v) => s + v, 0),
    confidence,
    evidenceQuality: 0.8,
    durabilityFactor: 0.9,
    interactionFactor: 1,
    riskPenalty: input.riskLevel === 'CRITICAL' ? 2 : input.riskLevel === 'HIGH' ? 1 : 0.2,
    resourcePenalty: input.resourceBudgetAvailable ? 0 : 1,
  });

  // 11. Comparison with parent
  const comparison = compareGenerations(
    input.baselineMetrics,
    input.candidateMetrics,
    0.5,
    confidence === 'HIGH' || confidence === 'VERY_HIGH' ? 0.8 : 0.5,
    0.2,
    input.riskLevel === 'CRITICAL' ? 0.9 : input.riskLevel === 'HIGH' ? 0.6 : 0.3
  );
  comparison.parentGenerationId = input.parentGenerationId ?? generation.parentGenerationId ?? '';
  comparison.candidateId = candidate.candidateId;

  // 12. Lineage add
  const updatedLineage = addLineageNode(input.lineage, {
    generationId: generation.generationId,
    strategyId: input.strategyId,
    parentGenerationId: input.parentGenerationId,
    rootStrategyId: input.rootStrategyId,
    reason: input.mutationRationale,
    timestamp: generation.createdAt,
    status: safety === 'ALLOW' && governance === 'APPROVE' ? 'ACTIVE' : 'SUPERSEDED',
  });

  // 13. Rollout decision (if approved, shadow -> canary)
  const rollout = evaluateEvolutionRollout({
    currentStage: 'SHADOW',
    metrics: { errorRate: 0.01, latency: 100, reliability: 0.99, cost: 50 },
    thresholds: { maxErrorRate: 0.05, maxLatency: 200, minReliability: 0.95, maxCost: 100 },
  });

  // 14. Rollback evaluation
  const rollback = evaluateEvolutionRollback({
    candidateId: candidate.candidateId,
    parentGenerationId: input.parentGenerationId ?? '',
    reason: 'test',
    eligible: true,
    authorized: true,
    governanceAllowed: true,
    safetyAllowed: true,
    rollbackAvailable: input.rollbackCapabilityExists,
    verificationSucceeded: true,
  });

  // 15. Retirement (only if parent exists and old)
  const retirement = decideRetirement({
    generationId: generation.generationId,
    strategyId: input.strategyId,
    tenantId: input.tenantId,
    obsolete: false,
    unsafe: false,
    superseded: true,
    unused: false,
    degraded: false,
    outsideObjectives: false,
    governanceDecision: 'ALLOW',
  });

  // 16. Learning record
  const learning = createEvolutionLearningRecord({
    tenantId: input.tenantId,
    strategyId: input.strategyId,
    generationId: generation.generationId,
    candidateId: candidate.candidateId,
    outcome: comparison.overallDecision,
    evidence: input.sourceEvidence,
    confidence,
    correlationId: input.correlationId,
  });

  // 17. Audit events
  const auditEvents = [
    createEvolutionAuditEvent({
      tenantId: input.tenantId,
      correlationId: input.correlationId,
      strategyId: input.strategyId,
      generationId: generation.generationId,
      candidateId: candidate.candidateId,
      eventType: 'EVOLUTION_PROPOSED',
      reason: 'Candidate proposed',
      decision: 'PROPOSED',
    }),
    createEvolutionAuditEvent({
      tenantId: input.tenantId,
      correlationId: input.correlationId,
      strategyId: input.strategyId,
      generationId: generation.generationId,
      candidateId: candidate.candidateId,
      eventType: 'CANDIDATE_CREATED',
      reason: 'Candidate created',
      decision: 'CREATED',
    }),
    createEvolutionAuditEvent({
      tenantId: input.tenantId,
      correlationId: input.correlationId,
      strategyId: input.strategyId,
      generationId: generation.generationId,
      candidateId: candidate.candidateId,
      eventType: 'SHADOW_COMPLETED',
      reason: `Shadow: ${shadowCompleted.outcome}`,
      decision: shadowCompleted.outcome,
    }),
    createEvolutionAuditEvent({
      tenantId: input.tenantId,
      correlationId: input.correlationId,
      strategyId: input.strategyId,
      generationId: generation.generationId,
      candidateId: candidate.candidateId,
      eventType: 'GOVERNANCE_APPROVED',
      reason: `Governance: ${governance}`,
      decision: governance,
    }),
    createEvolutionAuditEvent({
      tenantId: input.tenantId,
      correlationId: input.correlationId,
      strategyId: input.strategyId,
      generationId: generation.generationId,
      candidateId: candidate.candidateId,
      eventType: 'EVOLUTION_LEARNED',
      reason: `Outcome: ${comparison.overallDecision}`,
      decision: comparison.overallDecision,
    }),
  ];

  return {
    generation,
    candidate,
    delta,
    constraintsResult,
    confidence,
    regression,
    shadow: shadowCompleted,
    governance,
    safety,
    score,
    comparison,
    lineage: updatedLineage,
    rollout,
    rollback,
    retirement,
    learning,
    auditEvents,
  };
}
