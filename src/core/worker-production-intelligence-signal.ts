import { randomUUID } from 'crypto';

export type SignalSeverity = 'NORMAL' | 'WARNING' | 'DEGRADED' | 'CRITICAL' | 'UNKNOWN';

export interface ProductionSignal {
  signalId: string;
  source: string;
  environmentId: string;
  serviceId: string;
  timestamp: string;
  metric: string;
  severity: SignalSeverity;
  observedValue: number;
  expectedValue?: number;
  correlationId?: string;
  deploymentContext?: string;
  releaseContext?: string;
  metadata: Record<string, unknown>;
  fingerprint: string;
  createdAt: string;
  idempotencyKey: string;
}

export function createProductionSignal(
  input: Omit<ProductionSignal, 'signalId' | 'createdAt' | 'fingerprint' | 'idempotencyKey'> & { idempotencyKey?: string }
): ProductionSignal {
  const fingerprint = `${input.environmentId}:${input.serviceId}:${input.metric}:${input.observedValue}:${input.timestamp}`;
  const idempotencyKey = input.idempotencyKey ?? fingerprint;
  return {
    signalId: randomUUID(),
    ...input,
    fingerprint,
    createdAt: new Date().toISOString(),
    idempotencyKey,
  };
}

export function isDuplicateSignal(a: ProductionSignal, b: ProductionSignal): boolean {
  return a.fingerprint === b.fingerprint;
}
