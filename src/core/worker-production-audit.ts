import { redactSecrets } from './secret-redaction';

export interface ProductionAuditEvent {
  tenantId: string;
  correlationId: string;
  environmentId: string;
  eventType: string;
  actor: string;
  reason: string;
  decision: string;
  timestamp: string;
  redactedMetadata: Record<string, unknown>;
}

export function createProductionAuditEvent(input: {
  tenantId: string;
  correlationId: string;
  environmentId: string;
  eventType: string;
  actor?: string;
  reason: string;
  decision: string;
  metadata?: Record<string, unknown>;
}): ProductionAuditEvent {
  return {
    tenantId: input.tenantId,
    correlationId: input.correlationId,
    environmentId: input.environmentId,
    eventType: input.eventType,
    actor: input.actor ?? 'system',
    reason: input.reason,
    decision: input.decision,
    timestamp: new Date().toISOString(),
    redactedMetadata: input.metadata ? redactSecrets(input.metadata) : {},
  };
}
