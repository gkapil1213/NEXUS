import { randomUUID } from 'crypto';

export function processKnowledge(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    knowledgeType: input.knowledgeType || 'generic',
    title: input.title || null,
    domain: input.domain || null,
    environment: input.environment || null,
    serviceId: input.serviceId || null,
    resourceId: input.resourceId || null,
    provider: input.provider || null,
    incidentId: input.incidentId || null,
    decisionId: input.decisionId || null,
    executionId: input.executionId || null,
    sourceEvent: input.sourceEvent || null,
    sourceEvidence: input.sourceEvidence || null,
    observedOutcome: input.observedOutcome || null,
    confidence: input.confidence || 0,
    reliability: input.reliability || 0,
    freshnessState: input.freshnessState || 'fresh',
    validityState: input.validityState || 'proposed',
    verificationState: input.verificationState || 'unverified',
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: input.updatedAt || new Date().toISOString(),
    lastVerifiedAt: input.lastVerifiedAt || null,
    expiration: input.expiration || null,
    contradictionRef: input.contradictionRef || null,
    supersededBy: input.supersededBy || null,
    fingerprint: input.fingerprint || id,
  };
}

export function processKnowledgeExtraction(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    sourceEvent: input.sourceEvent,
    problem: input.problem || null,
    observedConditions: input.observedConditions || [],
    affectedComponents: input.affectedComponents || [],
    contributingFactors: input.contributingFactors || [],
    action: input.action || null,
    expectedResult: input.expectedResult || null,
    actualResult: input.actualResult || null,
    success: input.success || false,
    regression: input.regression || false,
    rollback: input.rollback || false,
    recovery: input.recovery || false,
    verification: input.verification || null,
    lesson: input.lesson || null,
    constraints: input.constraints || [],
    risks: input.risks || [],
    providerContext: input.providerContext || null,
    environmentContext: input.environmentContext || null,
  };
}

export function processNormalization(input: any): any {
  return {
    id: randomUUID(),
    service: input.service || null,
    resource: input.resource || null,
    provider: input.provider || null,
    environment: input.environment || null,
    eventCategory: input.eventCategory || null,
    failureClass: input.failureClass || null,
    remediationClass: input.remediationClass || null,
    outcomeClass: input.outcomeClass || null,
  };
}

export function processFingerprint(input: any): any {
  const parts = [
    input.domain || '',
    input.service || '',
    input.resource || '',
    input.environment || '',
    input.provider || '',
    input.eventCategory || '',
    input.failureClass || '',
    input.remediationClass || ''
  ].filter(Boolean).join('|');
  const fingerprint = parts || randomUUID();
  return {
    id: randomUUID(),
    fingerprint,
    input,
  };
}

export function processSimilarity(input: any): any {
  let score = 0;
  if (input.exact) score = 1;
  else if (input.strong) score = 0.8;
  else if (input.partial) score = 0.5;
  else if (input.weak) score = 0.2;
  return {
    id: randomUUID(),
    decisionId: input.decisionId,
    knowledgeId: input.knowledgeId,
    similarityScore: score,
    relevance: input.relevance || null,
  };
}

export function processConfidence(input: any): any {
  let confidence = input.confidence || 0;
  if (input.verified) confidence = Math.min(confidence + 0.2, 1);
  if (input.contradicted) confidence = Math.max(confidence - 0.3, 0);
  if (input.stale) confidence = Math.max(confidence - 0.2, 0);
  if (input.repeatedEvidence) confidence = Math.min(confidence + 0.1, 1);
  return {
    id: randomUUID(),
    knowledgeId: input.knowledgeId,
    confidence: Math.round(confidence * 100) / 100,
  };
}

export function processFreshness(input: any): any {
  let state = 'fresh';
  if (input.ageDays > 90) state = 'expired';
  else if (input.ageDays > 30) state = 'stale';
  else if (input.ageDays > 7) state = 'aging';
  return {
    id: randomUUID(),
    knowledgeId: input.knowledgeId,
    freshnessState: state,
    ageDays: input.ageDays || 0,
  };
}

export function processContradiction(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    originalKnowledgeId: input.originalKnowledgeId,
    contradictingKnowledgeId: input.contradictingKnowledgeId,
    reason: input.reason || null,
    detectedAt: input.detectedAt || new Date().toISOString(),
  };
}

export function processSupersession(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    oldKnowledgeId: input.oldKnowledgeId,
    newKnowledgeId: input.newKnowledgeId,
    reason: input.reason || null,
    supersededAt: input.supersededAt || new Date().toISOString(),
  };
}

export function processValidation(input: any): any {
  return {
    id: randomUUID(),
    knowledgeId: input.knowledgeId,
    validationState: input.validationState || 'pending',
    validator: input.validator || 'system',
    timestamp: input.timestamp || new Date().toISOString(),
  };
}

export function processGovernance(input: any): any {
  let decision = 'ALLOW';
  if (input.freeze) decision = 'FREEZE';
  else if (input.deny) decision = 'DENY';
  else if (input.approvalRequired) decision = 'APPROVAL_REQUIRED';
  return {
    id: randomUUID(),
    knowledgeId: input.knowledgeId,
    decision,
    reasons: input.reasons || [],
  };
}

export function processSafety(input: any): any {
  let safe = true;
  const reasons: string[] = [];
  if (input.protectedResource) { safe = false; reasons.push('protected resource'); }
  if (input.unsafeRecommendation) { safe = false; reasons.push('unsafe recommendation'); }
  if (input.unknownProvider) { safe = false; reasons.push('unknown provider'); }
  if (input.unhealthyTarget) { safe = false; reasons.push('unhealthy target'); }
  if (input.excessiveBlastRadius) { safe = false; reasons.push('excessive blast radius'); }
  return {
    id: randomUUID(),
    knowledgeId: input.knowledgeId,
    safe,
    reasons,
  };
}

export function processDecisionIntegration(input: any): any {
  return {
    id: randomUUID(),
    decisionId: input.decisionId,
    knowledgeId: input.knowledgeId,
    evidenceLink: input.evidenceLink || null,
    lineageLink: input.lineageLink || null,
    influence: input.influence || 0,
  };
}

export function processExecutionIntegration(input: any): any {
  return {
    id: randomUUID(),
    executionId: input.executionId,
    knowledgeId: input.knowledgeId,
    outcome: input.outcome || null,
    updatedKnowledgeId: input.updatedKnowledgeId || null,
  };
}

export function processLesson(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    knowledgeId: input.knowledgeId,
    lesson: input.lesson || '',
    outcome: input.outcome || '',
    confidence: input.confidence || 0,
  };
}

export function processKnowledgeReplay(input: any): any {
  return {
    id: randomUUID(),
    knowledgeId: input.knowledgeId,
    replayedInputs: input.replayedInputs || {},
    replayedOutputs: input.replayedOutputs || {},
    divergenceDetected: input.divergenceDetected || false,
  };
}

export function processProvider(input: any): any {
  if (input.unknown) throw new Error('Provider UNAVAILABLE');
  return { id: randomUUID(), name: input.name || 'provider', capabilities: input.capabilities || ['knowledge'] };
}

export function processAutonomousKnowledgeControlPlane(input: any): any {
  if (input.provider === 'unknown') throw new Error('Provider UNAVAILABLE');
  const status = input.approve ? 'COMPLETED' : 'APPROVAL_REQUIRED';
  return {
    id: randomUUID(),
    knowledgeId: input.knowledgeId,
    status,
    evidence: input.evidence || [],
    audit: input.audit || [],
    learning: input.learning || [],
  };
}


