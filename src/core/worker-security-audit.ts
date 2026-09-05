import { redactSecrets } from './secret-redaction';

export interface SecurityAuditEvent {
  tenantId: string;
  correlationId: string;
  assetId?: string;
  findingId?: string;
  incidentId?: string;
  eventType: string;
  actor: string;
  reason: string;
  decision: string;
  timestamp: string;
  redactedMetadata: Record<string, unknown>;
}

export function createSecurityAuditEvent(input: {
  tenantId: string;
  correlationId: string;
  assetId?: string;
  findingId?: string;
  incidentId?: string;
  eventType: string;
  actor?: string;
  reason: string;
  decision: string;
  metadata?: Record<string, unknown>;
}): SecurityAuditEvent {
  return {
    tenantId: input.tenantId,
    correlationId: input.correlationId,
    assetId: input.assetId,
    findingId: input.findingId,
    incidentId: input.incidentId,
    eventType: input.eventType,
    actor: input.actor ?? 'system',
    reason: input.reason,
    decision: input.decision,
    timestamp: new Date().toISOString(),
    redactedMetadata: input.metadata ? redactSecrets(input.metadata) : {},
  };
}
