import { randomUUID } from 'crypto';
export function processResourceObservation(input: any): any {
  return {
    id: randomUUID(),
    resourceId: input.resourceId,
    observedAt: input.observedAt || new Date().toISOString(),
    cpuUtilization: input.cpuUtilization,
    memoryUtilization: input.memoryUtilization,
    storageUtilization: input.storageUtilization,
    networkUtilization: input.networkUtilization,
    requestRate: input.requestRate,
    throughput: input.throughput,
    latencyMs: input.latencyMs,
    queueDepth: input.queueDepth,
    connectionUsage: input.connectionUsage,
    errorRate: input.errorRate,
    capacityHeadroom: input.capacityHeadroom,
  };
}
