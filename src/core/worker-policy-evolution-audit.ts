import { redactSecrets } from './secret-redaction';

export interface AuditEvent {
  tenantId: string;
  correlationId: string;
  policyId: string;
  policyVersion: string;
  eventType: string;
  actor: string;
  timestamp: string;
  result: string;
  reason: string;
  redactedMetadata: Record<string, unknown>;
}

export function createAuditEvent(input: {
  tenantId: string;
  correlationId: string;
  policyId: string;
  policyVersion: string;
  eventType: string;
  actor?: string;
  result: string;
  reason: string;
  metadata?: Record<string, unknown>;
}): AuditEvent {
  return {
    tenantId: input.tenantId,
    correlationId: input.correlationId,
    policyId: input.policyId,
    policyVersion: input.policyVersion,
    eventType: input.eventType,
    actor: input.actor ?? 'system',
    timestamp: new Date().toISOString(),
    result: input.result,
    reason: input.reason,
    redactedMetadata: input.metadata ? redactSecrets(input.metadata) : {},
  };
}
