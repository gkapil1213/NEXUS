import { randomUUID } from 'crypto';

export interface Anomaly {
  anomalyId: string;
  telemetryId: string;
  detector: 'THRESHOLD' | 'BASELINE' | 'SUDDEN_CHANGE' | 'SUSTAINED_DEGRADATION';
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  score: number;
  explanation: string;
  detectedAt: string;
  confidence: number;
  provenance: string;
  fingerprint: string;
  idempotencyKey: string;
}

export function detectThresholdAnomaly(telemetry: { value: number }, threshold: number): { detected: boolean; severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; score: number } {
  if (telemetry.value > threshold) {
    const score = Math.min(1, (telemetry.value - threshold) / threshold);
    const severity = score > 0.7 ? 'CRITICAL' : score > 0.4 ? 'HIGH' : score > 0.2 ? 'MEDIUM' : 'LOW';
    return { detected: true, severity, score };
  }
  return { detected: false, severity: 'LOW', score: 0 };
}

export function createAnomaly(
  input: Omit<Anomaly, 'anomalyId' | 'detectedAt' | 'fingerprint' | 'idempotencyKey'> & { idempotencyKey?: string }
): Anomaly {
  const fingerprint = `${input.telemetryId}:${input.detector}:${input.severity}`;
  const idempotencyKey = input.idempotencyKey ?? fingerprint;
  return {
    anomalyId: randomUUID(),
    ...input,
    detectedAt: new Date().toISOString(),
    fingerprint,
    idempotencyKey,
  };
}
