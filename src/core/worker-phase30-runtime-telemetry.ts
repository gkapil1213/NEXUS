import { randomUUID } from 'crypto';

export interface RuntimeTelemetry {
  telemetryId: string;
  serviceId: string;
  timestamp: string;
  metric: string;
  value: number;
  unit: string;
  correlationId: string;
  createdAt: string;
  idempotencyKey: string;
}

export function createRuntimeTelemetry(input: Omit<RuntimeTelemetry, 'telemetryId' | 'createdAt' | 'idempotencyKey'> & { idempotencyKey?: string }): RuntimeTelemetry {
  const idempotencyKey = input.idempotencyKey ?? `${input.serviceId}:${input.metric}:${input.timestamp}`;
  return { telemetryId: randomUUID(), ...input, createdAt: new Date().toISOString(), idempotencyKey };
}
