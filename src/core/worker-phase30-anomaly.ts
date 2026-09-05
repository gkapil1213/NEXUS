import { randomUUID } from 'crypto';

export type RuntimeAnomalyType = 'LATENCY_SPIKE' | 'ERROR_SPIKE' | 'TRAFFIC_ANOMALY' | 'RESTART_STORM' | 'MEMORY_PRESSURE' | 'CPU_SATURATION' | 'CONNECTION_SATURATION' | 'AVAILABILITY_DROP' | 'QUEUE_GROWTH' | 'UNKNOWN';

export interface RuntimeAnomaly {
  anomalyId: string;
  serviceId: string;
  type: RuntimeAnomalyType;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  confidence: number;
  evidence: string[];
  detectedAt: string;
  idempotencyKey: string;
}

export function createRuntimeAnomaly(input: Omit<RuntimeAnomaly, 'anomalyId' | 'detectedAt' | 'idempotencyKey'> & { idempotencyKey?: string }): RuntimeAnomaly {
  const idempotencyKey = input.idempotencyKey ?? `${input.serviceId}:${input.type}:${input.severity}`;
  return { anomalyId: randomUUID(), ...input, detectedAt: new Date().toISOString(), idempotencyKey };
}

export function detectAnomaly(serviceId: string, metric: string, value: number, baseline: number, threshold: number): RuntimeAnomaly | null {
  const deviation = Math.abs(value - baseline) / Math.max(baseline, 1);
  if (deviation < threshold) return null;
  const severity = deviation > 0.5 ? 'CRITICAL' : deviation > 0.2 ? 'HIGH' : 'MEDIUM';
  let type: RuntimeAnomalyType = 'UNKNOWN';
  if (metric === 'latency') type = 'LATENCY_SPIKE';
  else if (metric === 'error_rate') type = 'ERROR_SPIKE';
  else if (metric === 'restart_count') type = 'RESTART_STORM';
  else if (metric === 'memory_pressure') type = 'MEMORY_PRESSURE';
  else if (metric === 'cpu_pressure') type = 'CPU_SATURATION';
  else if (metric === 'availability') type = 'AVAILABILITY_DROP';
  return createRuntimeAnomaly({ serviceId, type, severity, confidence: Math.min(1, deviation), evidence: [`${metric}=${value}`] });
}
