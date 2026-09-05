import { redactSecrets } from './secret-redaction';

export interface PortfolioAuditEvent {
  tenantId: string;
  correlationId: string;
  portfolioId: string;
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
  portfolioId?: string;
  entityId?: string;
  entityVersion?: string;
  eventType: string;
  actor?: string;
  reason: string;
  decision: string;
  metadata?: Record<string, unknown>;
}): PortfolioAuditEvent {
  const portfolioId = input.portfolioId ?? input.entityId ?? 'unknown';
  const safeMetadata = { ...(input.metadata ?? {}) };
  if (input.entityVersion !== undefined) safeMetadata['entityVersion'] = input.entityVersion;
  return {
    tenantId: input.tenantId,
    correlationId: input.correlationId,
    portfolioId,
    eventType: input.eventType,
    actor: input.actor ?? 'system',
    reason: input.reason,
    decision: input.decision,
    timestamp: new Date().toISOString(),
    redactedMetadata: redactSecrets(safeMetadata),
  };
}
