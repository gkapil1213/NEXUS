import { randomUUID } from 'crypto';

export interface Phase26Telemetry {
  telemetryId: string;
  source: string;
  sourceType: 'METRIC' | 'LOG' | 'EVENT' | 'TRACE' | 'HEALTH_CHECK' | 'DEPLOYMENT_SIGNAL' | 'INFRASTRUCTURE_SIGNAL' | 'SECURITY_SIGNAL' | 'PROVIDER_SIGNAL';
  service: string;
  environment: string;
  timestamp: string;
  observedAt: string;
  receivedAt: string;
  value: number;
  unit: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL' | 'UNKNOWN';
  dimensions: Record<string, string>;
  metadata: Record<string, unknown>;
  correlationId: string;
  provenance: string;
  fingerprint: string;
  createdAt: string;
  idempotencyKey: string;
}

export function createPhase26Telemetry(
  input: Omit<Phase26Telemetry, 'telemetryId' | 'createdAt' | 'fingerprint' | 'idempotencyKey'> & { idempotencyKey?: string }
): Phase26Telemetry {
  const fingerprint = `${input.source}:${input.service}:${input.environment}:${input.sourceType}:${input.timestamp}:${input.value}`;
  const idempotencyKey = input.idempotencyKey ?? fingerprint;
  return {
    telemetryId: randomUUID(),
    ...input,
    fingerprint,
    createdAt: new Date().toISOString(),
    idempotencyKey,
  };
}

export function isDuplicateTelemetry(a: Phase26Telemetry, b: Phase26Telemetry): boolean {
  return a.fingerprint === b.fingerprint;
}
