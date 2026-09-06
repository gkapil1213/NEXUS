import { randomUUID } from 'crypto';

// Agent
export function processAgent(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    agentKey: input.agentKey || id,
    name: input.name || null,
    agentType: input.agentType || 'generic',
    status: input.status || 'active',
    healthState: input.healthState || 'unknown',
    version: input.version || null,
    provider: input.provider || null,
    capabilities: input.capabilities || [],
    specialization: input.specialization || null,
    priority: input.priority || 0,
    maxConcurrency: input.maxConcurrency || 1,
    currentLoad: input.currentLoad || 0,
    metadata: input.metadata || {},
  };
}

// Capability
export function processCapability(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    agentId: input.agentId,
    capability: input.capability,
    proficiency: input.proficiency || 0.5,
    enabled: input.enabled || false,
    metadata: input.metadata || {},
  };
}

// Agent health
export function processAgentHealth(input: any): any {
  return {
    id: input.idempotencyKey || randomUUID(),
    agentId: input.agentId,
    healthState: input.healthState || 'unknown',
    observedAt: input.observedAt || new Date().toISOString(),
  };
}

// Agent load
export function processAgentLoad(input: any): any {
  return {
    id: randomUUID(),
    agentId: input.agentId,
    currentLoad: input.currentLoad || 0,
    maxConcurrency: input.maxConcurrency || 1,
    availableCapacity: Math.max((input.maxConcurrency || 1) - (input.currentLoad || 0), 0),
  };
}

// Task
export function processTask(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    taskKey: input.taskKey || id,
    parentTaskId: input.parentTaskId || null,
    taskType: input.taskType || 'generic',
    objective: input.objective || null,
    priority: input.priority || 0,
    status: input.status || 'pending',
    requiredCapabilities: input.requiredCapabilities || [],
    constraints: input.constraints || [],
    context: input.context || {},
    deadline: input.deadline || null,
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: input.updatedAt || new Date().toISOString(),
  };
}

// Task decomposition
export function processTaskDecomposition(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    parentTaskId: input.parentTaskId,
    childTasks: input.childTasks || [],
    dependencies: input.dependencies || [],
  };
}

// Task dependency
export function processTaskDependency(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    taskId: input.taskId,
    dependencyTaskId: input.dependencyTaskId,
    dependencyType: input.dependencyType || 'requires',
    status: input.status || 'pending',
  };
}

// Agent selection
export function processAgentSelection(input: any): any {
  // Simplified deterministic selection: choose agent with highest priority then lowest load
  const candidates = input.candidates || [];
  if (candidates.length === 0) return { id: randomUUID(), selectedAgentId: null, reason: 'no eligible agent' };
  const sorted = [...candidates].sort((a, b) => (b.priority || 0) - (a.priority || 0) || (a.currentLoad || 0) - (b.currentLoad || 0));
  return { id: randomUUID(), selectedAgentId: sorted[0].id, candidates: sorted };
}

// Assignment
export function processAssignment(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    taskId: input.taskId,
    agentId: input.agentId,
    assignmentState: input.assignmentState || 'assigned',
    assignedAt: input.assignedAt || new Date().toISOString(),
    releasedAt: input.releasedAt || null,
    reason: input.reason || null,
  };
}

// Lease
export function processLease(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    taskId: input.taskId,
    agentId: input.agentId,
    leaseToken: input.leaseToken || randomUUID(),
    leaseState: input.leaseState || 'active',
    acquiredAt: input.acquiredAt || new Date().toISOString(),
    expiresAt: input.expiresAt || new Date(Date.now() + 60000).toISOString(),
    renewedAt: input.renewedAt || null,
    releasedAt: input.releasedAt || null,
  };
}

// Handoff
export function processHandoff(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    taskId: input.taskId,
    fromAgentId: input.fromAgentId,
    toAgentId: input.toAgentId,
    reason: input.reason || null,
    contextSnapshot: input.contextSnapshot || {},
    handoffState: input.handoffState || 'pending',
    createdAt: input.createdAt || new Date().toISOString(),
    completedAt: input.completedAt || null,
  };
}

// Context
export function processContext(input: any): any {
  return {
    id: randomUUID(),
    taskId: input.taskId,
    contextData: input.contextData || {},
    sourceKnowledgeIds: input.sourceKnowledgeIds || [],
    createdAt: input.createdAt || new Date().toISOString(),
  };
}

// Message
export function processMessage(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    taskId: input.taskId || null,
    senderAgentId: input.senderAgentId || null,
    receiverAgentId: input.receiverAgentId || null,
    messageType: input.messageType || 'generic',
    payload: input.payload || {},
    correlationId: input.correlationId || null,
    createdAt: input.createdAt || new Date().toISOString(),
  };
}

// Recommendation
export function processRecommendation(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    taskId: input.taskId,
    agentId: input.agentId,
    recommendationType: input.recommendationType || 'generic',
    recommendation: input.recommendation || null,
    confidence: input.confidence || 0,
    evidence: input.evidence || [],
    risk: input.risk || null,
  };
}

// Conflict
export function processConflict(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    taskId: input.taskId,
    conflictType: input.conflictType || 'generic',
    participants: input.participants || [],
    conflictingRecommendations: input.conflictingRecommendations || [],
    severity: input.severity || 'medium',
    status: input.status || 'open',
    resolution: input.resolution || null,
  };
}

// Consensus
export function processConsensus(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    taskId: input.taskId,
    participants: input.participants || [],
    votes: input.votes || [],
    consensusState: input.consensusState || 'pending',
    consensusScore: input.consensusScore || 0,
    decision: input.decision || null,
    rationale: input.rationale || null,
  };
}

// Arbitration
export function processArbitration(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    taskId: input.taskId,
    conflictId: input.conflictId || null,
    arbitrationMethod: input.arbitrationMethod || 'deterministic',
    inputs: input.inputs || {},
    outcome: input.outcome || null,
    rationale: input.rationale || null,
  };
}

// Coordination safety
export function processCoordinationSafety(input: any): any {
  let safe = true;
  const reasons: string[] = [];
  if (input.unknownAgent) { safe = false; reasons.push('unknown agent'); }
  if (input.unknownCapability) { safe = false; reasons.push('unknown capability'); }
  if (input.disabledAgent) { safe = false; reasons.push('disabled agent'); }
  if (input.unhealthyAgent) { safe = false; reasons.push('unhealthy agent'); }
  if (input.overloadedAgent) { safe = false; reasons.push('overloaded agent'); }
  if (input.unknownProvider) { safe = false; reasons.push('unknown provider'); }
  if (input.circuitBreakerOpen) { safe = false; reasons.push('circuit breaker open'); }
  if (input.protectedResource) { safe = false; reasons.push('protected resource'); }
  if (input.excessiveBlastRadius) { safe = false; reasons.push('excessive blast radius'); }
  if (input.missingRollback) { safe = false; reasons.push('missing rollback'); }
  if (input.missingVerification) { safe = false; reasons.push('missing verification'); }
  if (input.expiredLease) { safe = false; reasons.push('expired lease'); }
  if (input.conflictingAssignment) { safe = false; reasons.push('conflicting assignment'); }
  if (input.invalidTaskTransition) { safe = false; reasons.push('invalid task transition'); }
  if (input.invalidHandoff) { safe = false; reasons.push('invalid handoff'); }
  return { id: randomUUID(), taskId: input.taskId, safe, reasons };
}

// Governance
export function processGovernance(input: any): any {
  let decision = 'ALLOW';
  if (input.freeze) decision = 'FREEZE';
  else if (input.deny) decision = 'DENY';
  else if (input.approvalRequired || input.risk === 'high' || input.risk === 'critical') decision = 'APPROVAL_REQUIRED';
  return { id: randomUUID(), taskId: input.taskId, decision, reasons: input.reasons || [] };
}

// Execution
export function processExecution(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  const result: any = {
    id,
    idempotencyKey: input.idempotencyKey || id,
    taskId: input.taskId,
    agentId: input.agentId,
    state: input.state || 'planned',
    attempt: input.attempt || 1,
    startedAt: input.startedAt || null,
    completedAt: input.completedAt || null,
    error: input.error || null,
    result: input.result || null,
  };
  if (input.from && input.to) {
    const valid: Record<string, string[]> = {
      planned: ['running', 'cancelled'],
      running: ['verifying', 'failed', 'halted'],
      verifying: ['succeeded', 'failed'],
      failed: ['retrying', 'cancelled'],
      retrying: ['running'],
      succeeded: [],
      cancelled: [],
      halted: [],
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

// Verification
export function processVerification(input: any): any {
  let state = 'unknown';
  if (input.success) state = 'success';
  else if (input.partial) state = 'partial';
  else if (input.failed) state = 'failed';
  else if (input.regression) state = 'regression';
  return { id: randomUUID(), executionId: input.executionId, state, evidenceRef: input.evidenceRef || null };
}

// Recovery
export function processRecovery(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    taskId: input.taskId,
    recoveryType: input.recoveryType || 'generic',
    state: input.state || 'planned',
    result: input.result || null,
  };
}

// Circuit breaker
export function processCircuitBreaker(input: any): any {
  const failures = input.failures || 0;
  const threshold = input.threshold || 3;
  const state = input.state || (failures >= threshold ? 'OPEN' : 'CLOSED');
  return { id: randomUUID(), scope: input.scope || 'coordination', state, failures };
}

// Incident
export function processIncident(input: any): any {
  const id = input.signature || randomUUID();
  return {
    id,
    taskId: input.taskId || null,
    agentId: input.agentId || null,
    incidentType: input.incidentType || 'generic',
    severity: input.severity || 'medium',
    signature: input.signature || null,
    state: 'open',
  };
}

// Escalation
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

// Evidence
export function processEvidence(input: any): any {
  return {
    id: randomUUID(),
    taskId: input.taskId || null,
    agentId: input.agentId || null,
    evidenceType: input.evidenceType || 'coordination',
    evidence: input.evidence || {},
    integrityHash: input.integrityHash || null,
    createdAt: input.createdAt || new Date().toISOString(),
  };
}

// Audit
export function processAudit(input: any): any {
  return {
    id: randomUUID(),
    taskId: input.taskId || null,
    agentId: input.agentId || null,
    eventType: input.eventType,
    actor: input.actor || 'system',
    action: input.action || input.eventType,
    previousState: input.previousState || null,
    newState: input.newState || null,
    reason: input.reason || null,
    timestamp: new Date().toISOString(),
  };
}

// Lineage
export function processLineage(input: any): any {
  return {
    id: randomUUID(),
    taskId: input.taskId,
    parentTaskId: input.parentTaskId || null,
    agentId: input.agentId || null,
    assignmentId: input.assignmentId || null,
    leaseId: input.leaseId || null,
    recommendationId: input.recommendationId || null,
    consensusId: input.consensusId || null,
    executionId: input.executionId || null,
    incidentId: input.incidentId || null,
  };
}

// Learning
export function processLearning(input: any): any {
  return {
    id: randomUUID(),
    taskId: input.taskId || null,
    outcome: input.outcome || null,
    coordinationPattern: input.coordinationPattern || null,
    agentPerformance: input.agentPerformance || null,
    routingLesson: input.routingLesson || null,
    conflictResolutionLesson: input.conflictResolutionLesson || null,
    handoffLesson: input.handoffLesson || null,
  };
}

// Replay
export function processReplay(input: any): any {
  return {
    id: randomUUID(),
    taskId: input.taskId,
    replayedInputs: input.replayedInputs || {},
    replayedOutputs: input.replayedOutputs || {},
    divergenceDetected: input.divergenceDetected || false,
  };
}

// Provider
export function processProvider(input: any): any {
  if (input.unknown) throw new Error('Provider UNAVAILABLE');
  return { id: randomUUID(), name: input.name || 'provider', capabilities: input.capabilities || ['agent'] };
}

// Control plane
export function processAutonomousCoordinationControlPlane(input: any): any {
  if (input.provider === 'unknown') throw new Error('Provider UNAVAILABLE');
  const status = input.approve ? 'COMPLETED' : 'APPROVAL_REQUIRED';
  return {
    id: randomUUID(),
    taskId: input.taskId,
    status,
    evidence: input.evidence || [],
    audit: input.audit || [],
    learning: input.learning || [],
  };
}

