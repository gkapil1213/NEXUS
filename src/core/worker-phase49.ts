import { randomUUID } from 'crypto';

export function processFramework(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    name: input.name,
    version: input.version || '1.0',
    status: input.status || 'active',
    jurisdiction: input.jurisdiction || null,
    effectiveDate: input.effectiveDate || null,
    controlFamilies: input.controlFamilies || [],
    controls: input.controls || [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function processPolicy(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    name: input.name,
    version: input.version || '1.0',
    owner: input.owner || null,
    scope: input.scope || null,
    severity: input.severity || 'medium',
    enforcementMode: input.enforcementMode || 'advisory',
    effectiveStatus: input.effectiveStatus || 'active',
    evaluationCriteria: input.evaluationCriteria || null,
    associatedControls: input.associatedControls || [],
    associatedResources: input.associatedResources || [],
  };
}

export function processControl(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    controlId: input.controlId,
    frameworkId: input.frameworkId || null,
    requirement: input.requirement || null,
    description: input.description || null,
    severity: input.severity || 'medium',
    owner: input.owner || null,
    evaluationState: input.evaluationState || 'unknown',
    evidenceRequirements: input.evidenceRequirements || null,
    remediationRequirements: input.remediationRequirements || null,
  };
}

export function processAsset(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    name: input.name,
    assetType: input.assetType || 'unknown',
    environment: input.environment || null,
    owner: input.owner || null,
    criticality: input.criticality || 'unknown',
    protectionState: input.protectionState || 'unprotected',
  };
}

export function processEvidence(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    source: input.source || 'system',
    assetId: input.assetId || null,
    controlId: input.controlId || null,
    collectedAt: input.collectedAt || new Date().toISOString(),
    validityWindow: input.validityWindow || null,
    provenance: input.provenance || null,
    integrityMetadata: input.integrityMetadata || null,
    evidenceStatus: input.evidenceStatus || 'collected',
    evaluator: input.evaluator || null,
  };
}

export function processEvidenceValidation(input: any): any {
  return {
    id: randomUUID(),
    evidenceId: input.evidenceId,
    valid: !!(input.integrityValid && input.notStale),
    reason: input.reason || null,
  };
}

export function processAssessment(input: any): any {
  let state = 'pending';
  if (input.pass) state = 'pass';
  else if (input.fail) state = 'fail';
  else if (input.unknown) state = 'unknown';
  return {
    id: randomUUID(),
    controlId: input.controlId,
    assetId: input.assetId || null,
    evidenceId: input.evidenceId || null,
    assessmentState: state,
  };
}

export function processPolicyEvaluation(input: any): any {
  let result = 'pass';
  if (input.fail) result = 'fail';
  else if (input.unknown) result = 'unknown';
  return {
    id: randomUUID(),
    policyId: input.policyId,
    assetId: input.assetId || null,
    result,
    reasons: input.reasons || [],
  };
}

export function processViolation(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    policyId: input.policyId,
    assetId: input.assetId || null,
    severity: input.severity || 'medium',
    detectedAt: input.detectedAt || new Date().toISOString(),
    state: input.state || 'open',
    evidenceId: input.evidenceId || null,
    owner: input.owner || null,
    riskLevel: input.riskLevel || null,
    remediationStatus: input.remediationStatus || null,
  };
}

export function processComplianceRisk(input: any): any {
  let riskLevel = 'unknown';
  if (input.critical) riskLevel = 'critical';
  else if (input.high) riskLevel = 'high';
  else if (input.medium) riskLevel = 'medium';
  else if (input.low) riskLevel = 'low';
  return {
    id: randomUUID(),
    violationId: input.violationId,
    riskLevel,
    reasons: input.reasons || [],
  };
}

export function processRegulatoryMapping(input: any): any {
  return {
    id: randomUUID(),
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    targetType: input.targetType,
    targetId: input.targetId,
    mappingType: input.mappingType || 'regulatory',
  };
}

export function processControlMapping(input: any): any {
  return {
    id: randomUUID(),
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    targetType: input.targetType,
    targetId: input.targetId,
    mappingType: 'control',
  };
}

export function processException(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    policyId: input.policyId || null,
    controlId: input.controlId || null,
    assetId: input.assetId || null,
    justification: input.justification || null,
    owner: input.owner || null,
    riskAcceptance: input.riskAcceptance || null,
    expiration: input.expiration || null,
    status: input.status || 'pending',
    approvalId: input.approvalId || null,
  };
}

export function processApproval(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    planId: input.planId,
    approver: input.approver || null,
    decision: input.decision || 'pending',
    approvedAt: input.approvedAt || null,
  };
}

export function processGovernance(input: any): any {
  let decision = 'ALLOW';
  if (input.freeze) decision = 'FREEZE';
  else if (input.deny) decision = 'DENY';
  else if (input.approvalRequired || input.risk === 'high' || input.risk === 'critical') decision = 'APPROVAL_REQUIRED';
  return {
    id: randomUUID(),
    resourceId: input.resourceId,
    decision,
    reasons: input.reasons || [],
  };
}

export function processSafety(input: any): any {
  let safe = true;
  const reasons: string[] = [];
  if (input.protectedResource) { safe = false; reasons.push('protected resource'); }
  if (input.unknownProvider) { safe = false; reasons.push('unknown provider'); }
  if (input.unknownPolicy) { safe = false; reasons.push('unknown policy'); }
  if (input.unknownComplianceState) { safe = false; reasons.push('unknown compliance state'); }
  if (input.criticalRisk) { safe = false; reasons.push('critical risk'); }
  if (input.circuitBreakerOpen) { safe = false; reasons.push('circuit breaker open'); }
  return { id: randomUUID(), resourceId: input.resourceId, safe, reasons };
}

export function processRemediationPlan(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    violationId: input.violationId,
    rootCause: input.rootCause || null,
    proposedAction: input.proposedAction || null,
    affectedResources: input.affectedResources || [],
    dependencies: input.dependencies || [],
    expectedOutcome: input.expectedOutcome || null,
    risk: input.risk || null,
    rollbackStrategy: input.rollbackStrategy || null,
    verificationCriteria: input.verificationCriteria || null,
    approvalRequirement: input.approvalRequirement || null,
  };
}

export function processRemediationExecution(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  const result: any = {
    id,
    idempotencyKey: input.idempotencyKey || id,
    planId: input.planId,
    state: input.state || 'planned',
    provider: input.provider || null,
    result: input.result || null,
    error: input.error || null,
    startedAt: input.startedAt || null,
    completedAt: input.completedAt || null,
  };
  if (input.from && input.to) {
    const valid: Record<string, string[]> = {
      planned: ['approval_required', 'approved', 'cancelled'],
      approval_required: ['approved', 'denied'],
      approved: ['running', 'cancelled'],
      running: ['succeeded', 'failed', 'halted'],
      halted: ['cancelled'],
      succeeded: ['verified'],
      verified: [],
      failed: ['rolled_back'],
      rolled_back: [],
      denied: [],
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

export function processRemediationVerification(input: any): any {
  let state = 'unknown';
  if (input.verified) state = 'verified';
  else if (input.failed) state = 'failed';
  else if (input.regression) state = 'regression';
  return { id: randomUUID(), executionId: input.executionId, state, evidenceRef: input.evidenceRef || null };
}

export function processRemediationRollback(input: any): any {
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

export function processCircuitBreaker(input: any): any {
  const failures = input.failures || 0;
  const threshold = input.threshold || 3;
  const state = input.state || (failures >= threshold ? 'OPEN' : 'CLOSED');
  return { id: randomUUID(), scope: input.scope || 'compliance', state, failures };
}

export function processIncident(input: any): any {
  const id = input.signature || randomUUID();
  return {
    id,
    violationId: input.violationId || null,
    severity: input.severity || 'medium',
    signature: input.signature || null,
    state: 'open',
  };
}

export function processEscalation(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    incidentId: input.incidentId,
    level: input.level || 'high',
    reason: input.reason || '',
    target: input.target || null,
    state: 'pending',
  };
}

export function processImpact(input: any): any {
  return {
    id: randomUUID(),
    violationId: input.violationId,
    affectedAssets: input.affectedAssets || [],
    affectedServices: input.affectedServices || [],
    businessImpact: input.businessImpact || null,
  };
}

export function processBlastRadius(input: any): any {
  let classification = 'low';
  if (input.critical) classification = 'critical';
  else if (input.high) classification = 'high';
  else if (input.medium) classification = 'medium';
  return { id: randomUUID(), violationId: input.violationId, classification };
}

export function processCorrelation(input: any): any {
  return {
    id: randomUUID(),
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    targetType: input.targetType,
    targetId: input.targetId,
    correlationStrength: input.correlationStrength || 'unknown',
  };
}

export function processLineage(input: any): any {
  return {
    id: randomUUID(),
    frameworkId: input.frameworkId || null,
    policyId: input.policyId || null,
    controlId: input.controlId || null,
    assetId: input.assetId || null,
    evidenceId: input.evidenceId || null,
    assessmentId: input.assessmentId || null,
    violationId: input.violationId || null,
    remediationPlanId: input.remediationPlanId || null,
    executionId: input.executionId || null,
    verificationId: input.verificationId || null,
    rollbackId: input.rollbackId || null,
    incidentId: input.incidentId || null,
    learningOutcomeId: input.learningOutcomeId || null,
  };
}

export function processAudit(input: any): any {
  return {
    id: randomUUID(),
    eventType: input.eventType,
    actor: input.actor || 'system',
    action: input.action || input.eventType,
    resource: input.resource,
    decision: input.decision || null,
    previousState: input.previousState || null,
    newState: input.newState || null,
    reason: input.reason || null,
    timestamp: new Date().toISOString(),
  };
}

export function processLearning(input: any): any {
  return {
    id: randomUUID(),
    violationId: input.violationId || null,
    pattern: input.pattern || '',
    outcome: input.outcome || '',
    recommendation: input.recommendation || '',
    confidence: input.confidence || 0,
  };
}

export function processProvider(input: any): any {
  if (input.unknown) throw new Error('Provider UNAVAILABLE');
  return { id: randomUUID(), name: input.name || 'provider', capabilities: input.capabilities || ['compliance'] };
}

export function processAutonomousComplianceControlPlane(input: any): any {
  if (input.provider === 'unknown') throw new Error('Provider UNAVAILABLE');
  const status = input.approve ? 'COMPLIANT' : 'APPROVAL_REQUIRED';
  return {
    id: randomUUID(),
    resourceId: input.resourceId,
    status,
    evidence: input.evidence || [],
    audit: input.audit || [],
    learning: input.learning || [],
  };
}