import { createPolicyEvolutionContext } from './worker-policy-evolution-context';
import { attributeOutcome } from './worker-policy-outcome-attribution';
import { evaluateEvolutionEffectiveness } from './worker-policy-evolution-effectiveness';
import { learnFromOutcome } from './worker-policy-outcome-learning';
import { generatePolicyEvolutionProposal } from './worker-policy-evolution-proposal';
import { arbitrateObjectives } from './worker-policy-objective-arbitrator';
import { detectPolicyEvolutionConflict } from './worker-policy-evolution-conflict';
import { governPolicyEvolution } from './worker-policy-evolution-governance';
import { evaluatePolicyEvolutionSafety } from './worker-policy-evolution-safety-gate';
import { evaluateRollout } from './worker-policy-evolution-rollout';
import { verifyPolicyOutcome } from './worker-policy-evolution-verification';
import { evaluatePromotion } from './worker-policy-promotion';
import { evaluateRollback } from './worker-policy-evolution-rollback';
import { evaluatePolicyStability } from './worker-policy-evolution-stability';
import { addVersionToLineage, PolicyLineage } from './worker-policy-lineage';
import { createAuditEvent } from './worker-policy-evolution-audit';

export interface OrchestrationInput {
  tenantId: string;
  policyId: string;
  parentVersion: string;
  proposedVersion: string;
  decisionId: string;
  learningCycleId: string;
  correlationId: string;
  workerScope: string;
  evidenceReferences: string[];
  baselinePeriod: { start: string; end: string };
  treatmentPeriod: { start: string; end: string };
  controlPeriod?: { start: string; end: string };
  expectedOutcome: string;
  actualOutcome?: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';
  attribution: {
    temporalOrdering: boolean;
    baselineMetrics: Record<string, number>;
    treatmentMetrics: Record<string, number>;
    controlMetrics?: Record<string, number>;
    concurrentChanges: string[];
    incidents: string[];
    telemetryQuality: 'HIGH' | 'MEDIUM' | 'LOW';
    observationWindowDays: number;
  };
  effectiveness: {
    sampleSize: number;
    successRate: number;
    failureRate: number;
    rollbackRate: number;
    reliability?: number;
    availability?: number;
    latencyP95?: number;
    cost?: number;
    incidentCount?: number;
    recoveryTime?: number;
    conflictingMetrics?: boolean;
    telemetryFresh: boolean;
  };
  proposal: {
    rationale: string;
    evidenceIds: string[];
    expectedImprovement: string;
    expectedRisk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';
    expectedCostImpact: 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN';
    expectedReliabilityImpact: 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN';
    rollbackPlan: string;
    rolloutPlan: string;
    expiry: string;
    activeIncident: boolean;
    productionFreeze: boolean;
    cooldownSatisfied: boolean;
    blastRadiusAcceptable: boolean;
    policyCurrent: boolean;
    duplicateCheck: boolean;
  };
  arbitration: {
    impacts: { objective: 'SAFETY'|'RELIABILITY'|'RECOVERY'|'AVAILABILITY'|'PERFORMANCE'|'COST'; impact: 'POSITIVE'|'NEGATIVE'|'NEUTRAL'|'UNKNOWN' }[];
  };
  conflict: {
    activeProposals: { policyId: string; proposedVersion: string; status: string }[];
    activeRecovery: boolean;
    activeRelease: boolean;
    activeOptimization: boolean;
    staleProposal: boolean;
    dependencyConflict: boolean;
    tenantScopeConflict: boolean;
  };
  governance: {
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';
    confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
    productionFreeze: boolean;
    activeIncident: boolean;
    cooldownSatisfied: boolean;
    blastRadiusAcceptable: boolean;
    dependencyHealthy: boolean;
    staleDecision: boolean;
    staleTelemetry: boolean;
    tenantIsolationValid: boolean;
  };
  safety: {
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';
    confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
    staleTelemetry: boolean;
    stalePolicy: boolean;
    staleAuthorization: boolean;
    missingRollback: boolean;
    blastRadiusExcessive: boolean;
    activeCriticalIncident: boolean;
    productionFreeze: boolean;
    dependencyFailure: boolean;
    insufficientEvidence: boolean;
    conflictingPolicyState: boolean;
  };
  rollout: {
    currentStage: 'OBSERVE_ONLY' | 'CANARY' | 'LIMITED' | 'PROGRESSIVE' | 'FULL' | 'HOLD' | 'ROLLBACK';
    state: {
      errorRate: number;
      latencyP95: number;
      reliability: number;
      cost: number;
      rollbackRate: number;
      incidentRate: number;
    };
    thresholds: {
      maxErrorRate: number;
      maxLatencyP95: number;
      minReliability: number;
      maxCost: number;
      maxRollbackRate: number;
      maxIncidentRate: number;
    };
  };
  verification: {
    sampleSize: number;
    baselineReliability: number;
    actualReliability: number;
    baselineCost: number;
    actualCost: number;
    baselinePerformance: number;
    actualPerformance: number;
    errorChange: number;
    latencyChange: number;
    incidentChange: number;
    rollbackEvents: number;
    telemetryFresh: boolean;
    conflictingMetrics: boolean;
  };
  promotion: {
    verificationResult: string;
    confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
    governanceDecision: string;
    safetyDecision: string;
    activeIncident: boolean;
    stableObservation: boolean;
    conflictingNewerPolicy: boolean;
    policyStillCurrent: boolean;
    cooldownSatisfied: boolean;
  };
  rollback: {
    previousKnownGoodVersion: string;
    trigger: 'RELIABILITY_REGRESSION' | 'ERROR_SPIKE' | 'LATENCY_VIOLATION' | 'INCIDENT' | 'SAFETY_VIOLATION' | 'COST_EXPLOSION' | 'POLICY_INSTABILITY' | 'REPEATED_FAILED_ROLLOUT';
    duplicateRollback: boolean;
    rollbackAuthorized: boolean;
    rollbackAvailable: boolean;
    governanceAllowed: boolean;
    safetyAllowed: boolean;
    activeIncident: boolean;
    productionFreeze: boolean;
  };
  stability: {
    recentPolicyChanges: number;
    recentRollbacks: number;
    recentFailedRollouts: number;
    cooldownActive: boolean;
    minObservationWindowSatisfied: boolean;
    oscillationDetected: boolean;
    adaptationFrequencyExceeded: boolean;
    rollbackFrequencyExceeded: boolean;
    telemetryFresh: boolean;
  };
  currentLineage?: PolicyLineage;
}

export interface OrchestrationResult {
  context: ReturnType<typeof createPolicyEvolutionContext>;
  attribution: ReturnType<typeof attributeOutcome>;
  effectiveness: ReturnType<typeof evaluateEvolutionEffectiveness>;
  learning: ReturnType<typeof learnFromOutcome>;
  proposal: ReturnType<typeof generatePolicyEvolutionProposal>;
  arbitration: ReturnType<typeof arbitrateObjectives>;
  conflict: ReturnType<typeof detectPolicyEvolutionConflict>;
  governance: ReturnType<typeof governPolicyEvolution>;
  safety: ReturnType<typeof evaluatePolicyEvolutionSafety>;
  rollout: ReturnType<typeof evaluateRollout>;
  verification: ReturnType<typeof verifyPolicyOutcome>;
  promotion: ReturnType<typeof evaluatePromotion>;
  rollback: ReturnType<typeof evaluateRollback>;
  stability: ReturnType<typeof evaluatePolicyStability>;
  auditEvents: ReturnType<typeof createAuditEvent>[];
}

export function orchestratePolicyEvolution(input: OrchestrationInput): OrchestrationResult {
  const context = createPolicyEvolutionContext({
    tenantId: input.tenantId,
    policyId: input.policyId,
    parentVersion: input.parentVersion,
    proposedVersion: input.proposedVersion,
    decisionId: input.decisionId,
    learningCycleId: input.learningCycleId,
    correlationId: input.correlationId,
    workerScope: input.workerScope,
    evidenceReferences: input.evidenceReferences,
    baselinePeriod: input.baselinePeriod,
    treatmentPeriod: input.treatmentPeriod,
    controlPeriod: input.controlPeriod,
    expectedOutcome: input.expectedOutcome,
    actualOutcome: input.actualOutcome,
    confidence: input.confidence,
    risk: input.risk,
  });

  const attribution = attributeOutcome(input.attribution);

  const effectiveness = evaluateEvolutionEffectiveness(input.effectiveness);

  const learning = learnFromOutcome({
    outcome: input.verification ? verifyPolicyOutcome(input.verification) : 'UNKNOWN',
    attributionStatus: attribution.status,
    confidence: input.confidence,
    policyCharacteristics: {
      reliability: input.effectiveness.reliability ?? 0,
      cost: input.effectiveness.cost ?? 0,
      performance: input.verification.actualPerformance ?? 0,
      risk: input.risk === 'CRITICAL' ? 1 : input.risk === 'HIGH' ? 0.7 : input.risk === 'MEDIUM' ? 0.4 : 0.1,
    },
    environmentalConstraints: [],
  });

  const proposal = generatePolicyEvolutionProposal({
    tenantId: input.tenantId,
    policyId: input.policyId,
    sourceVersion: input.parentVersion,
    proposedVersion: input.proposedVersion,
    rationale: input.proposal.rationale,
    evidenceIds: input.proposal.evidenceIds,
    expectedImprovement: input.proposal.expectedImprovement,
    expectedRisk: input.proposal.expectedRisk,
    expectedCostImpact: input.proposal.expectedCostImpact,
    expectedReliabilityImpact: input.proposal.expectedReliabilityImpact,
    confidence: input.confidence,
    rollbackPlan: input.proposal.rollbackPlan,
    rolloutPlan: input.proposal.rolloutPlan,
    expiry: input.proposal.expiry,
    activeIncident: input.proposal.activeIncident,
    productionFreeze: input.proposal.productionFreeze,
    cooldownSatisfied: input.proposal.cooldownSatisfied,
    blastRadiusAcceptable: input.proposal.blastRadiusAcceptable,
    policyCurrent: input.proposal.policyCurrent,
    duplicateCheck: input.proposal.duplicateCheck,
  });

  const arbitration = arbitrateObjectives({
    tenantId: input.tenantId,
    policyId: input.policyId,
    impacts: input.arbitration.impacts,
  });

  const conflict = detectPolicyEvolutionConflict({
    tenantId: input.tenantId,
    policyId: input.policyId,
    sourceVersion: input.parentVersion,
    proposedVersion: input.proposedVersion,
    activeProposals: input.conflict.activeProposals,
    activeRecovery: input.conflict.activeRecovery,
    activeRelease: input.conflict.activeRelease,
    activeOptimization: input.conflict.activeOptimization,
    staleProposal: input.conflict.staleProposal,
    dependencyConflict: input.conflict.dependencyConflict,
    tenantScopeConflict: input.conflict.tenantScopeConflict,
  });

  const governance = governPolicyEvolution({
    tenantId: input.tenantId,
    policyId: input.policyId,
    policyVersion: input.proposedVersion,
    ...input.governance,
  });

  const safety = evaluatePolicyEvolutionSafety(input.safety);

  const rollout = evaluateRollout({
    currentStage: input.rollout.currentStage,
    state: {
      ...input.rollout.state,
      stage: input.rollout.currentStage,
    },
    thresholds: input.rollout.thresholds,
  });

  const verification = verifyPolicyOutcome(input.verification);

  const promotion = evaluatePromotion({
    tenantId: input.tenantId,
    policyId: input.policyId,
    currentVersion: input.parentVersion,
    proposedVersion: input.proposedVersion,
    ...input.promotion,
  });

  const rollback = evaluateRollback({
    tenantId: input.tenantId,
    policyId: input.policyId,
    currentVersion: input.proposedVersion,
    ...input.rollback,
  });

  const stability = evaluatePolicyStability(input.stability);

  const auditEvents: ReturnType<typeof createAuditEvent>[] = [
    createAuditEvent({
      tenantId: input.tenantId,
      correlationId: input.correlationId,
      policyId: input.policyId,
      policyVersion: input.proposedVersion,
      eventType: 'LEARNING_STARTED',
      result: 'EXECUTED',
      reason: 'Phase 17.29 orchestration started',
    }),
    createAuditEvent({
      tenantId: input.tenantId,
      correlationId: input.correlationId,
      policyId: input.policyId,
      policyVersion: input.proposedVersion,
      eventType: 'ATTRIBUTION_COMPLETED',
      result: attribution.status,
      reason: 'Causal outcome attribution computed',
    }),
    createAuditEvent({
      tenantId: input.tenantId,
      correlationId: input.correlationId,
      policyId: input.policyId,
      policyVersion: input.proposedVersion,
      eventType: 'GOVERNANCE_DECISION',
      result: governance,
      reason: 'Governance evaluation',
    }),
    createAuditEvent({
      tenantId: input.tenantId,
      correlationId: input.correlationId,
      policyId: input.policyId,
      policyVersion: input.proposedVersion,
      eventType: 'SAFETY_DECISION',
      result: safety,
      reason: 'Safety gate evaluation',
    }),
    createAuditEvent({
      tenantId: input.tenantId,
      correlationId: input.correlationId,
      policyId: input.policyId,
      policyVersion: input.proposedVersion,
      eventType: 'ROLLOUT_EVALUATION',
      result: rollout.nextStage,
      reason: 'Rollout stage evaluation',
    }),
    createAuditEvent({
      tenantId: input.tenantId,
      correlationId: input.correlationId,
      policyId: input.policyId,
      policyVersion: input.proposedVersion,
      eventType: 'VERIFICATION_COMPLETED',
      result: verification,
      reason: 'Outcome verification',
    }),
  ];

  return {
    context,
    attribution,
    effectiveness,
    learning,
    proposal,
    arbitration,
    conflict,
    governance,
    safety,
    rollout,
    verification,
    promotion,
    rollback,
    stability,
    auditEvents,
  };
}
