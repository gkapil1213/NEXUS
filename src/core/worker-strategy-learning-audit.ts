import { redactSecrets } from './secret-redaction';

export interface LearningAuditEvent {
  tenantId: string;
  correlationId: string;
  strategyId: string;
  strategyVersion: string;
  eventType: string;
  actor: string;
  reason: string;
  decision: string;
  timestamp: string;
  redactedMetadata: Record<string, unknown>;
}

export function createLearningAuditEvent(input: {
  tenantId: string;
  correlationId: string;
  strategyId: string;
  strategyVersion: string;
  eventType: string;
  actor?: string;
  reason: string;
  decision: string;
  metadata?: Record<string, unknown>;
}): LearningAuditEvent {
  return {
    tenantId: input.tenantId,
    correlationId: input.correlationId,
    strategyId: input.strategyId,
    strategyVersion: input.strategyVersion,
    eventType: input.eventType,
    actor: input.actor ?? 'system',
    reason: input.reason,
    decision: input.decision,
    timestamp: new Date().toISOString(),
    redactedMetadata: input.metadata ? redactSecrets(input.metadata) : {},
  };
}
