import { redactSecrets } from './secret-redaction';

export interface PortfolioAuditEvent {
  tenantId: string;
  correlationId: string;
  entityId: string;
  entityVersion: string;
  eventType: string;
  actor: string;
  reason: string;
  decision: string;
  timestamp: string;
  redactedMetadata: Record<string, unknown>;
}

export function createPortfolioAuditEvent(input: {
  tenantId: string;
  correlationId: string;
  entityId: string;
  entityVersion: string;
  eventType: string;
  actor?: string;
  reason: string;
  decision: string;
  metadata?: Record<string, unknown>;
}): PortfolioAuditEvent {
  return {
    tenantId: input.tenantId,
    correlationId: input.correlationId,
    entityId: input.entityId,
    entityVersion: input.entityVersion,
    eventType: input.eventType,
    actor: input.actor ?? 'system',
    reason: input.reason,
    decision: input.decision,
    timestamp: new Date().toISOString(),
    redactedMetadata: input.metadata ? redactSecrets(input.metadata) : {},
  };
}
