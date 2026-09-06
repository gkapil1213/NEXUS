import { randomUUID } from 'crypto';
export function processTelemetry(input: any): any {
  if (!input.signalType) throw new Error('Invalid telemetry: missing signalType');
  if (input.invalid) throw new Error('Invalid telemetry rejected');
  const fingerprint = input.fingerprint || input.idempotencyKey || randomUUID();
  return {
    id: fingerprint,
    fingerprint,
    sourceId: input.sourceId || null,
    signalType: input.signalType,
    serviceId: input.serviceId || null,
    resourceId: input.resourceId || null,
    timestamp: input.timestamp || new Date().toISOString(),
    value: input.value || null,
    dimensions: input.dimensions || {},
    severity: input.severity || 'info',
    environment: input.environment || null,
    correlationId: input.correlationId || null,
  };
}
