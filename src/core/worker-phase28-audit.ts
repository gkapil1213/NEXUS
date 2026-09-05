import { redactSecrets } from './secret-redaction';

export interface InfrastructureAuditEvent {
  tenantId: string;
  correlationId: string;
  eventType: string;
  actor: string;
  reason: string;
  decision: string;
  timestamp: string;
  redactedMetadata: Record<string, unknown>;
}

export function createInfrastructureAuditEvent(input: {
  tenantId: string;
  correlationId: string;
  eventType: string;
  actor?: string;
  reason: string;
  decision: string;
  metadata?: Record<string, unknown>;
}): InfrastructureAuditEvent {
  return {
    tenantId: input.tenantId,
    correlationId: input.correlationId,
    eventType: input.eventType,
    actor: input.actor ?? 'system',
    reason: input.reason,
    decision: input.decision,
    timestamp: new Date().toISOString(),
    redactedMetadata: input.metadata ? redactSecrets(input.metadata) : {},
  };
}
