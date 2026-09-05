import { redactSecrets } from './secret-redaction';

export interface ExperimentAuditEvent {
  tenantId: string;
  correlationId: string;
  experimentId: string;
  populationId: string;
  populationVersion: number;
  eventType: string;
  actor: string;
  reason: string;
  decision: string;
  timestamp: string;
  redactedMetadata: Record<string, unknown>;
}

export function createExperimentAuditEvent(input: {
  tenantId: string;
  correlationId: string;
  experimentId: string;
  populationId: string;
  populationVersion: number;
  eventType: string;
  actor?: string;
  reason: string;
  decision: string;
  metadata?: Record<string, unknown>;
}): ExperimentAuditEvent {
  return {
    tenantId: input.tenantId,
    correlationId: input.correlationId,
    experimentId: input.experimentId,
    populationId: input.populationId,
    populationVersion: input.populationVersion,
    eventType: input.eventType,
    actor: input.actor ?? 'system',
    reason: input.reason,
    decision: input.decision,
    timestamp: new Date().toISOString(),
    redactedMetadata: input.metadata ? redactSecrets(input.metadata) : {},
  };
}
