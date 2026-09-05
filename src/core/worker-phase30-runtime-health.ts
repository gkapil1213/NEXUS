export type RuntimeHealthStatus = 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN' | 'RECOVERING' | 'UNAVAILABLE';

export interface RuntimeHealthInput {
  latency: number;
  errorRate: number;
  throughput: number;
  availability: number;
  saturation: number;
  cpuPressure: number;
  memoryPressure: number;
  restartFrequency: number;
  requestFailures: number;
  queuePressure: number;
  connectionFailures: number;
  thresholds: { maxLatency: number; maxErrorRate: number; minThroughput: number; minAvailability: number; maxSaturation: number; maxCpuPressure: number; maxMemoryPressure: number; maxRestartFrequency: number; maxRequestFailures: number; maxQueuePressure: number; maxConnectionFailures: number };
}

export function evaluateRuntimeHealth(input: RuntimeHealthInput): RuntimeHealthStatus {
  if (input.availability === 0) return 'UNAVAILABLE';
  if (input.errorRate > input.thresholds.maxErrorRate || input.availability < input.thresholds.minAvailability || input.latency > input.thresholds.maxLatency) return 'UNHEALTHY';
  if (input.cpuPressure > input.thresholds.maxCpuPressure || input.memoryPressure > input.thresholds.maxMemoryPressure || input.saturation > input.thresholds.maxSaturation || input.restartFrequency > input.thresholds.maxRestartFrequency) return 'DEGRADED';
  if (input.throughput < input.thresholds.minThroughput || input.requestFailures > input.thresholds.maxRequestFailures || input.queuePressure > input.thresholds.maxQueuePressure) return 'DEGRADED';
  return 'HEALTHY';
}
