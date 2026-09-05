import { redactSecrets } from './secret-redaction';

export interface MetaAuditEvent {
  tenantId: string;
  correlationId: string;
  metaExperimentId: string;
  methodId?: string;
  eventType: string;
  actor: string;
  reason: string;
  decision: string;
  timestamp: string;
  redactedMetadata: Record<string, unknown>;
}

export function createMetaAuditEvent(input: {
  tenantId: string;
  correlationId: string;
  metaExperimentId: string;
  methodId?: string;
  eventType: string;
  actor?: string;
  reason: string;
  decision: string;
  metadata?: Record<string, unknown>;
}): MetaAuditEvent {
  return {
    tenantId: input.tenantId,
    correlationId: input.correlationId,
    metaExperimentId: input.metaExperimentId,
    methodId: input.methodId,
    eventType: input.eventType,
    actor: input.actor ?? 'system',
    reason: input.reason,
    decision: input.decision,
    timestamp: new Date().toISOString(),
    redactedMetadata: input.metadata ? redactSecrets(input.metadata) : {},
  };
}
