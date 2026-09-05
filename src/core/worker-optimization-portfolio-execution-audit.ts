import { redactSecrets } from './secret-redaction';

export interface ExecutionAuditEvent {
  tenantId: string;
  correlationId: string;
  portfolioId: string;
  executionId?: string;
  eventType: string;
  actor: string;
  reason: string;
  decision: string;
  timestamp: string;
  redactedMetadata: Record<string, unknown>;
}

export function createExecutionAuditEvent(input: {
  tenantId: string;
  correlationId: string;
  portfolioId: string;
  executionId?: string;
  eventType: string;
  actor?: string;
  reason: string;
  decision: string;
  metadata?: Record<string, unknown>;
}): ExecutionAuditEvent {
  return {
    tenantId: input.tenantId,
    correlationId: input.correlationId,
    portfolioId: input.portfolioId,
    executionId: input.executionId,
    eventType: input.eventType,
    actor: input.actor ?? 'system',
    reason: input.reason,
    decision: input.decision,
    timestamp: new Date().toISOString(),
    redactedMetadata: input.metadata ? redactSecrets(input.metadata) : {},
  };
}
