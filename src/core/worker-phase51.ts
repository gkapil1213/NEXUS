import { randomUUID } from 'crypto';

export function processDecisionContext(input: any): any {
  return {
    id: input.idempotencyKey || randomUUID(),
    decisionId: input.decisionId || null,
    contextType: input.contextType || 'generic',
    contextData: input.contextData || {},
    evidenceRef: input.evidenceRef || null,
    timestamp: input.timestamp || new Date().toISOString(),
  };
}

export function processDecision(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    requestId: input.requestId || null,
    correlationId: input.correlationId || null,
    decisionType: input.decisionType || 'operational',
    subject: input.subject || null,
    contextSnapshot: input.contextSnapshot || null,
    evidenceRefs: input.evidenceRefs || [],
    candidateActions: input.candidateActions || [],
    selectedAction: input.selectedAction || null,
    confidence: input.confidence || 0,
    expectedBenefit: input.expectedBenefit || null,
    expectedRisk: input.expectedRisk || null,
    blastRadius: input.blastRadius || 'unknown',
    reversibility: input.reversibility || 'unknown',
    policyResult: input.policyResult || null,
    approvalRequirement: input.approvalRequirement || null,
    authorizationResult: input.authorizationResult || null,
    decisionStatus: input.decisionStatus || 'pending',
    createdAt: input.createdAt || new Date().toISOString(),
    resolvedAt: input.resolvedAt || null,
  };
}

export function processDecisionCandidate(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    decisionId: input.decisionId,
    candidateAction: input.candidateAction,
    score: input.score || 0,
    reasons: input.reasons || [],
  };
}

export function processDecisionEvaluation(input: any): any {
  return {
    id: randomUUID(),
    decisionId: input.decisionId,
    reliabilityRisk: input.reliabilityRisk || 'unknown',
    securityRisk: input.securityRisk || 'unknown',
    complianceRisk: input.complianceRisk || 'unknown',
    deliveryRisk: input.deliveryRisk || 'unknown',
    operationalRisk: input.operationalRisk || 'unknown',
    costImpact: input.costImpact || 'unknown',
    capacityImpact: input.capacityImpact || 'unknown',
    customerImpact: input.customerImpact || 'unknown',
    dependencyImpact: input.dependencyImpact || 'unknown',
    blastRadius: input.blastRadius || 'unknown',
    reversibility: input.reversibility || 'unknown',
    evidenceConfidence: input.evidenceConfidence || 0,
    overallScore: input.overallScore || 0,
  };
}

export function processDecisionConfidence(input: any): any {
  let confidence = input.confidence || 0;
  if (input.missingEvidence) confidence = Math.min(confidence, 0.3);
  if (input.staleEvidence) confidence = Math.min(confidence, 0.5);
  return { id: randomUUID(), decisionId: input.decisionId, confidence };
}

export function processDecisionConflict(input: any): any {
  return {
    id: randomUUID(),
    decisionId: input.decisionId,
    conflictType: input.conflictType || 'none',
    description: input.description || null,
  };
}

export function processDecisionGovernance(input: any): any {
  let decision = 'ALLOW';
  if (input.freeze) decision = 'FREEZE';
  else if (input.deny) decision = 'DENY';
  else if (input.approvalRequired || input.risk === 'high' || input.risk === 'critical') decision = 'APPROVAL_REQUIRED';
  return { id: randomUUID(), decisionId: input.decisionId, decision, reasons: input.reasons || [] };
}

export function processDecisionSafety(input: any): any {
  let safe = true;
  const reasons: string[] = [];
  if (input.protectedResource) { safe = false; reasons.push('protected resource'); }
  if (input.unknownProvider) { safe = false; reasons.push('unknown provider'); }
  if (input.unknownHealth) { safe = false; reasons.push('unknown health'); }
  if (input.excessiveBlastRadius) { safe = false; reasons.push('excessive blast radius'); }
  if (input.missingRollback) { safe = false; reasons.push('missing rollback'); }
  if (input.missingVerification) { safe = false; reasons.push('missing verification'); }
  if (input.circuitBreakerOpen) { safe = false; reasons.push('circuit breaker open'); }
  return { id: randomUUID(), decisionId: input.decisionId, safe, reasons };
}

export function processDecisionApproval(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    decisionId: input.decisionId,
    approver: input.approver || null,
    status: input.status || 'pending',
    approvedAt: input.approvedAt || null,
    expiresAt: input.expiresAt || null,
  };
}

export function processDecisionExecution(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  const result: any = {
    id,
    idempotencyKey: input.idempotencyKey || id,
    decisionId: input.decisionId,
    state: input.state || 'planned',
    provider: input.provider || null,
    result: input.result || null,
    error: input.error || null,
    startedAt: input.startedAt || null,
    completedAt: input.completedAt || null,
  };
  if (input.from && input.to) {
    const valid: Record<string, string[]> = {
      planned: ['approved', 'cancelled'],
      approved: ['executing', 'cancelled'],
      executing: ['verifying', 'failed', 'halted'],
      verifying: ['completed', 'failed'],
      completed: [],
      failed: ['rolling_back'],
      rolling_back: ['rolled_back', 'failed'],
      rolled_back: [],
      halted: [],
      cancelled: [],
    };
    const allowed = valid[input.from] || [];
    if (!allowed.includes(input.to)) throw new Error('Invalid transition');
    result.validTransition = true;
    result.state = input.to;
  }
  if (input.operation === 'halt') result.state = 'halted';
  if (input.circuitBreakerState === 'OPEN') result.blocked = true;
  return result;
}

export function processDecisionVerification(input: any): any {
  let state = 'unknown';
  if (input.success) state = 'success';
  else if (input.partial) state = 'partial';
  else if (input.failed) state = 'failed';
  else if (input.regression) state = 'regression';
  return { id: randomUUID(), executionId: input.executionId, state, evidenceRef: input.evidenceRef || null };
}

export function processDecisionRollback(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    executionId: input.executionId,
    reason: input.reason || null,
    state: input.fail ? 'failed' : 'success',
    result: input.result || 'success',
  };
}

export function processDecisionCircuitBreaker(input: any): any {
  const failures = input.failures || 0;
  const threshold = input.threshold || 3;
  const state = input.state || (failures >= threshold ? 'OPEN' : 'CLOSED');
  return { id: randomUUID(), scope: input.scope || 'decision', state, failures };
}

export function processDecisionIncident(input: any): any {
  const id = input.signature || randomUUID();
  return {
    id,
    decisionId: input.decisionId || null,
    severity: input.severity || 'medium',
    signature: input.signature || null,
    state: 'open',
  };
}

export function processDecisionEvidence(input: any): any {
  return {
    id: randomUUID(),
    decisionId: input.decisionId,
    evidenceType: input.evidenceType || 'decision',
    data: input.data || {},
    timestamp: input.timestamp || new Date().toISOString(),
  };
}

export function processDecisionAudit(input: any): any {
  return {
    id: randomUUID(),
    decisionId: input.decisionId || null,
    eventType: input.eventType,
    actor: input.actor || 'system',
    action: input.action || input.eventType,
    previousState: input.previousState || null,
    newState: input.newState || null,
    reason: input.reason || null,
    timestamp: new Date().toISOString(),
  };
}

export function processDecisionLineage(input: any): any {
  return {
    id: randomUUID(),
    decisionId: input.decisionId,
    sourceSignalId: input.sourceSignalId || null,
    changeId: input.changeId || null,
    deploymentId: input.deploymentId || null,
    releaseId: input.releaseId || null,
    resourceId: input.resourceId || null,
    policyId: input.policyId || null,
    executionId: input.executionId || null,
    evidenceId: input.evidenceId || null,
    learningOutcomeId: input.learningOutcomeId || null,
  };
}

export function processDecisionLearning(input: any): any {
  return {
    id: randomUUID(),
    decisionId: input.decisionId,
    predictedOutcome: input.predictedOutcome || null,
    actualOutcome: input.actualOutcome || null,
    predictionError: input.predictionError || 0,
    actionEffectiveness: input.actionEffectiveness || 0,
    riskAccuracy: input.riskAccuracy || 0,
    confidenceAccuracy: input.confidenceAccuracy || 0,
    rollbackFrequency: input.rollbackFrequency || 0,
    approvalFrequency: input.approvalFrequency || 0,
    policyBlocks: input.policyBlocks || 0,
    recurringFailurePattern: input.recurringFailurePattern || null,
  };
}

export function processDecisionReplay(input: any): any {
  const divergence = input.divergenceDetected || false;
  return {
    id: randomUUID(),
    decisionId: input.decisionId,
    replayedInputs: input.replayedInputs || {},
    replayedOutputs: input.replayedOutputs || {},
    divergenceDetected: divergence,
  };
}

export function processDecisionPriority(input: any): any {
  let priority = 0;
  if (input.critical) priority = 100;
  else if (input.high) priority = 80;
  else if (input.medium) priority = 50;
  else priority = 20;
  return { id: randomUUID(), decisionId: input.decisionId, priority };
}

export function processProvider(input: any): any {
  if (input.unknown) throw new Error('Provider UNAVAILABLE');
  return { id: randomUUID(), name: input.name || 'provider', capabilities: input.capabilities || ['decision'] };
}

export function processAutonomousDecisionControlPlane(input: any): any {
  if (input.provider === 'unknown') throw new Error('Provider UNAVAILABLE');
  const status = input.approve ? 'COMPLETED' : 'APPROVAL_REQUIRED';
  return {
    id: randomUUID(),
    decisionId: input.decisionId,
    status,
    evidence: input.evidence || [],
    audit: input.audit || [],
    learning: input.learning || [],
  };
}