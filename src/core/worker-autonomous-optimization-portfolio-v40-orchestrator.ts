import { createOptimizationPortfolioV40, validatePortfolioV40 } from './worker-optimization-portfolio-v40';
import { createPortfolioCandidate } from './worker-optimization-portfolio-candidate';
import { selectPortfolioCandidates } from './worker-optimization-portfolio-selection';
import { validatePortfolioObjectives } from './worker-optimization-portfolio-objectives';
import { checkPortfolioBudget } from './worker-optimization-portfolio-budget';
import { calculatePortfolioRisk } from './worker-optimization-portfolio-risk';
import { detectCorrelation } from './worker-optimization-portfolio-correlation';
import { detectPortfolioConflict } from './worker-optimization-portfolio-conflict';
import { evaluateDiversification } from './worker-optimization-portfolio-diversification';
import { allocateResources } from './worker-optimization-portfolio-allocation';
import { coordinateExperiments } from './worker-optimization-portfolio-coordination';
import { createPortfolioExperiment } from './worker-optimization-portfolio-experiment';
import { createPortfolioEvidence } from './worker-optimization-portfolio-evidence';
import { calculatePortfolioConfidence } from './worker-optimization-portfolio-confidence';
import { createPortfolioLearningRecord } from './worker-optimization-portfolio-learning';
import { assessLearningTransfer } from './worker-optimization-portfolio-transfer';
import { addPortfolioVersion, PortfolioLineage } from './worker-optimization-portfolio-lineage';
import { governPortfolioAction } from './worker-optimization-portfolio-v40-governance';
import { evaluatePortfolioSafety } from './worker-optimization-portfolio-v40-safety';
import { evaluatePortfolioRollout } from './worker-optimization-portfolio-v40-rollout';
import { evaluatePortfolioRollback } from './worker-optimization-portfolio-v40-rollback';
import { decideRecoveryAction } from './worker-optimization-portfolio-recovery';
import { evaluatePortfolioHealth } from './worker-optimization-portfolio-health';
import { detectPortfolioStagnation } from './worker-optimization-portfolio-stagnation';
import { createPortfolioAuditEvent } from './worker-optimization-portfolio-v40-audit';

export interface PortfolioOrchestrationInput {
  tenantId: string;
  correlationId: string;
  objective: string;
  ownerContext: string;
  includedPopulations: string[];
  resourceBudget: number;
  riskBudget: number;
  experimentLimits: number;
  governancePolicy: string;
  safetyPolicy: string;
  candidateProfiles: Parameters<typeof selectPortfolioCandidates>[0];
  objectives: Parameters<typeof validatePortfolioObjectives>[0];
  budget: Parameters<typeof checkPortfolioBudget>[0];
  budgetUsage: Parameters<typeof checkPortfolioBudget>[1];
  riskInput: Parameters<typeof calculatePortfolioRisk>[0];
  correlationInput: Parameters<typeof detectCorrelation>[0];
  conflictInput: Parameters<typeof detectPortfolioConflict>[0];
  diversificationInput: Parameters<typeof evaluateDiversification>[0];
  allocationRequest: Parameters<typeof allocateResources>[1];
  allocationState: Parameters<typeof allocateResources>[0];
  coordinationInput: Parameters<typeof coordinateExperiments>[0];
  experimentInput: Omit<Parameters<typeof createPortfolioExperiment>[0], 'portfolioId' | 'correlationId'>;
  evidenceInput: Omit<Parameters<typeof createPortfolioEvidence>[0], 'portfolioId' | 'correlationId'>[];
  confidenceInput: Parameters<typeof calculatePortfolioConfidence>[0];
  transferInput: Parameters<typeof assessLearningTransfer>[0];
  governanceInput: Parameters<typeof governPortfolioAction>[0];
  safetyInput: Parameters<typeof evaluatePortfolioSafety>[0];
  rolloutInput: Parameters<typeof evaluatePortfolioRollout>[0];
  rollbackInput: Parameters<typeof evaluatePortfolioRollback>[0];
  healthInput: Parameters<typeof evaluatePortfolioHealth>[0];
  stagnationInput: Parameters<typeof detectPortfolioStagnation>[0];
  lineage?: PortfolioLineage;
}

export function orchestrateOptimizationPortfolio(input: PortfolioOrchestrationInput) {
  const auditEvents: ReturnType<typeof createPortfolioAuditEvent>[] = [];

  const portfolio = createOptimizationPortfolioV40({
    tenantId: input.tenantId,
    objective: input.objective,
    ownerContext: input.ownerContext,
    includedPopulations: input.includedPopulations,
    resourceBudget: input.resourceBudget,
    riskBudget: input.riskBudget,
    experimentLimits: input.experimentLimits,
    governancePolicy: input.governancePolicy,
    safetyPolicy: input.safetyPolicy,
    correlationId: input.correlationId,
  });

  const validation = validatePortfolioV40(portfolio);
  if (!validation.valid) {
    auditEvents.push(createPortfolioAuditEvent({ tenantId: input.tenantId, correlationId: input.correlationId, portfolioId: portfolio.portfolioId, eventType: 'PORTFOLIO_REJECTED', reason: validation.reason, decision: 'INVALID' }));
    return { status: 'INVALID', reason: validation.reason, portfolio, auditEvents };
  }

  const objValidation = validatePortfolioObjectives(input.objectives);
  if (!objValidation.valid) {
    return { status: 'INVALID', reason: objValidation.reason, portfolio, auditEvents };
  }

  const budgetCheck = checkPortfolioBudget(input.budget, input.budgetUsage);
  if (!budgetCheck.allowed) {
    auditEvents.push(createPortfolioAuditEvent({ tenantId: input.tenantId, correlationId: input.correlationId, portfolioId: portfolio.portfolioId, eventType: 'PORTFOLIO_REJECTED', reason: budgetCheck.reason, decision: 'DENIED' }));
    return { status: 'REJECTED', reason: budgetCheck.reason, portfolio, auditEvents };
  }

  const risk = calculatePortfolioRisk(input.riskInput);
  const correlation = detectCorrelation(input.correlationInput);
  const conflict = detectPortfolioConflict(input.conflictInput);
  if (conflict.conflicted) {
    auditEvents.push(createPortfolioAuditEvent({ tenantId: input.tenantId, correlationId: input.correlationId, portfolioId: portfolio.portfolioId, eventType: 'PORTFOLIO_CONFLICT', reason: conflict.reasons.join(', '), decision: 'DENIED' }));
    return { status: 'REJECTED', reason: `conflicts: ${conflict.reasons.join(', ')}`, portfolio, auditEvents };
  }

  const diversification = evaluateDiversification(input.diversificationInput);
  if (!diversification.preserved) {
    return { status: 'REJECTED', reason: diversification.reason, portfolio, auditEvents };
  }

  const selectedCandidates = selectPortfolioCandidates(input.candidateProfiles, 2);
  const candidates = selectedCandidates.map(id => createPortfolioCandidate({
    portfolioId: portfolio.portfolioId,
    sourcePopulations: input.includedPopulations,
    action: 'transfer',
    reason: 'selected candidate',
    evidence: [],
    confidence: 0.7,
    impactEstimate: 0.5,
    riskEstimate: risk,
    recommendedAction: 'evaluate',
  }));

  const allocation = allocateResources(input.allocationState, input.allocationRequest);
  if (!allocation.allowed) {
    auditEvents.push(createPortfolioAuditEvent({ tenantId: input.tenantId, correlationId: input.correlationId, portfolioId: portfolio.portfolioId, eventType: 'PORTFOLIO_REJECTED', reason: allocation.reason, decision: 'DENIED' }));
    return { status: 'REJECTED', reason: allocation.reason, portfolio, auditEvents };
  }

  const coordination = coordinateExperiments(input.coordinationInput);
  if (!coordination.proceed) {
    auditEvents.push(createPortfolioAuditEvent({ tenantId: input.tenantId, correlationId: input.correlationId, portfolioId: portfolio.portfolioId, eventType: 'PORTFOLIO_REJECTED', reason: coordination.reason, decision: 'DENIED' }));
    return { status: 'REJECTED', reason: coordination.reason, portfolio, auditEvents };
  }

  const experiment = createPortfolioExperiment({
    ...input.experimentInput,
    portfolioId: portfolio.portfolioId,
    correlationId: input.correlationId,
  });

  const evidenceRecords = input.evidenceInput.map(e => createPortfolioEvidence({ ...e, portfolioId: portfolio.portfolioId, correlationId: input.correlationId }));
  const confidence = calculatePortfolioConfidence(input.confidenceInput);

  const governance = governPortfolioAction(input.governanceInput);
  const safety = evaluatePortfolioSafety(input.safetyInput);

  if (governance === 'DENIED' || safety === 'DENY') {
    auditEvents.push(createPortfolioAuditEvent({ tenantId: input.tenantId, correlationId: input.correlationId, portfolioId: portfolio.portfolioId, eventType: 'PORTFOLIO_REJECTED', reason: `governance=${governance}, safety=${safety}`, decision: 'DENIED' }));
    return { status: 'REJECTED', reason: `governance=${governance}, safety=${safety}`, portfolio, auditEvents };
  }

  const transfer = assessLearningTransfer(input.transferInput);
  const learningRecord = transfer.approved ? createPortfolioLearningRecord({
    tenantId: input.tenantId,
    portfolioId: portfolio.portfolioId,
    sourcePopulationId: input.transferInput.sourcePopulationId,
    targetPopulationId: input.transferInput.targetPopulationId,
    strategyId: input.transferInput.sourceStrategyId,
    transferredKnowledge: 'transferred strategy',
    evidence: [],
    confidence,
    decision: 'APPROVED',
    outcome: 'PENDING',
    correlationId: input.correlationId,
  }) : null;

  const rollout = evaluatePortfolioRollout(input.rolloutInput);
  const rollback = evaluatePortfolioRollback(input.rollbackInput);
  const health = evaluatePortfolioHealth(input.healthInput);
  const stagnation = detectPortfolioStagnation(input.stagnationInput);
  const recovery = decideRecoveryAction({ portfolioHealth: health, safetyHealthy: safety === 'ALLOW', governanceAllowed: governance === 'APPROVED', budgetAvailable: budgetCheck.allowed });

  const lineageBase: PortfolioLineage = input.lineage ?? { portfolioId: portfolio.portfolioId, tenantId: input.tenantId, versions: [] };
  const lineage = addPortfolioVersion(lineageBase, {
    version: '1',
    parentVersion: null,
    reason: 'initial',
    candidateIds: [],
    experimentIds: [],
    correlationId: input.correlationId,
    timestamp: new Date().toISOString(),
    status: 'ACTIVE',
  });

  auditEvents.push(createPortfolioAuditEvent({ tenantId: input.tenantId, correlationId: input.correlationId, portfolioId: portfolio.portfolioId, eventType: 'PORTFOLIO_CREATED', reason: 'created', decision: 'CREATED' }));
  auditEvents.push(createPortfolioAuditEvent({ tenantId: input.tenantId, correlationId: input.correlationId, portfolioId: portfolio.portfolioId, eventType: 'PORTFOLIO_EVALUATED', reason: `health=${health}, stagnation=${stagnation}`, decision: 'EVALUATED' }));

  return {
    status: 'COMPLETED',
    portfolio,
    validation,
    objValidation,
    budgetCheck,
    risk,
    correlation,
    conflict,
    diversification,
    selectedCandidates,
    candidates,
    allocation,
    coordination,
    experiment,
    evidenceRecords,
    confidence,
    governance,
    safety,
    transfer,
    learningRecord,
    rollout,
    rollback,
    health,
    stagnation,
    recovery,
    lineage,
    auditEvents,
  };
}
