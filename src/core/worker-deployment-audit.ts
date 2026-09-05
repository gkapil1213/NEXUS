import { redactSecrets } from './secret-redaction';

export interface DeploymentAuditEvent {
  tenantId: string;
  correlationId: string;
  deploymentId?: string;
  releaseId?: string;
  artifactId?: string;
  targetId?: string;
  eventType: string;
  actor: string;
  reason: string;
  decision: string;
  timestamp: string;
  redactedMetadata: Record<string, unknown>;
}

export function createDeploymentAuditEvent(input: {
  tenantId: string;
  correlationId: string;
  deploymentId?: string;
  releaseId?: string;
  artifactId?: string;
  targetId?: string;
  eventType: string;
  actor?: string;
  reason: string;
  decision: string;
  metadata?: Record<string, unknown>;
}): DeploymentAuditEvent {
  return {
    tenantId: input.tenantId,
    correlationId: input.correlationId,
    deploymentId: input.deploymentId,
    releaseId: input.releaseId,
    artifactId: input.artifactId,
    targetId: input.targetId,
    eventType: input.eventType,
    actor: input.actor ?? 'system',
    reason: input.reason,
    decision: input.decision,
    timestamp: new Date().toISOString(),
    redactedMetadata: input.metadata ? redactSecrets(input.metadata) : {},
  };
}
