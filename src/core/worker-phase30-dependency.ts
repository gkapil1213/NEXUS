export interface ServiceDependency {
  dependencyId: string;
  serviceId: string;
  dependsOnServiceId: string;
  dependencyType: string;
  criticality: string;
  health: string;
  latency: number;
  failures: number;
  createdAt: string;
  idempotencyKey: string;
}

export function createServiceDependency(input: Omit<ServiceDependency, 'dependencyId' | 'createdAt' | 'idempotencyKey'> & { idempotencyKey?: string }): ServiceDependency {
  const idempotencyKey = input.idempotencyKey ?? `${input.serviceId}:${input.dependsOnServiceId}`;
  return { dependencyId: `dep-${input.serviceId}-${input.dependsOnServiceId}`, ...input, createdAt: new Date().toISOString(), idempotencyKey };
}
