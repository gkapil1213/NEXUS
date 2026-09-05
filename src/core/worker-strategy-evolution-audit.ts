import { redactSecrets } from './secret-redaction';

export interface EvolutionAuditEvent {
  tenantId: string;
  correlationId: string;
  strategyId: string;
  generationId: string;
  candidateId?: string;
  eventType: string;
  actor: string;
  reason: string;
  decision: string;
  timestamp: string;
  redactedMetadata: Record<string, unknown>;
}

export function createEvolutionAuditEvent(input: {
  tenantId: string;
  correlationId: string;
  strategyId: string;
  generationId: string;
  candidateId?: string;
  eventType: string;
  actor?: string;
  reason: string;
  decision: string;
  metadata?: Record<string, unknown>;
}): EvolutionAuditEvent {
  return {
    tenantId: input.tenantId,
    correlationId: input.correlationId,
    strategyId: input.strategyId,
    generationId: input.generationId,
    candidateId: input.candidateId,
    eventType: input.eventType,
    actor: input.actor ?? 'system',
    reason: input.reason,
    decision: input.decision,
    timestamp: new Date().toISOString(),
    redactedMetadata: input.metadata ? redactSecrets(input.metadata) : {},
  };
}
