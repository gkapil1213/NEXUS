import { randomUUID } from 'crypto';

export function processPipelineDiscovery(input: any): any {
  if (input.provider === 'unknown') {
    throw new Error('Provider UNAVAILABLE');
  }
  return {
    id: randomUUID(),
    provider: input.provider,
    repositoryId: input.repositoryId || null,
    pipelines: [],
  };
}
