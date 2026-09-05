import { redactSecrets } from './secret-redaction';

export interface PopulationAuditEvent {
  tenantId: string;
  correlationId: string;
  populationId: string;
  populationVersion: number;
  strategyId?: string;
  eventType: string;
  actor: string;
  reason: string;
  decision: string;
  timestamp: string;
  redactedMetadata: Record<string, unknown>;
}

export function createPopulationAuditEvent(input: {
  tenantId: string;
  correlationId: string;
  populationId: string;
  populationVersion: number;
  strategyId?: string;
  eventType: string;
  actor?: string;
  reason: string;
  decision: string;
  metadata?: Record<string, unknown>;
}): PopulationAuditEvent {
  return {
    tenantId: input.tenantId,
    correlationId: input.correlationId,
    populationId: input.populationId,
    populationVersion: input.populationVersion,
    strategyId: input.strategyId,
    eventType: input.eventType,
    actor: input.actor ?? 'system',
    reason: input.reason,
    decision: input.decision,
    timestamp: new Date().toISOString(),
    redactedMetadata: input.metadata ? redactSecrets(input.metadata) : {},
  };
}
