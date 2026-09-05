import { redactSecrets } from './secret-redaction';

export interface RecoveryAuditEvent {
  tenantId: string;
  correlationId: string;
  recoveryId?: string;
  eventType: string;
  actor: string;
  reason: string;
  decision: string;
  timestamp: string;
  redactedMetadata: Record<string, unknown>;
}

export function createRecoveryAuditEvent(input: {
  tenantId: string;
  correlationId: string;
  recoveryId?: string;
  eventType: string;
  actor?: string;
  reason: string;
  decision: string;
  metadata?: Record<string, unknown>;
}): RecoveryAuditEvent {
  return {
    tenantId: input.tenantId,
    correlationId: input.correlationId,
    recoveryId: input.recoveryId,
    eventType: input.eventType,
    actor: input.actor ?? 'system',
    reason: input.reason,
    decision: input.decision,
    timestamp: new Date().toISOString(),
    redactedMetadata: input.metadata ? redactSecrets(input.metadata) : {},
  };
}
