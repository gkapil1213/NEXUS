import { randomUUID } from 'crypto';

export function processProvider(input: any): any {
  return {
    id: randomUUID(),
    name: input.name || 'unknown',
    capabilities: input.capabilities || ['discover_pipelines', 'inspect_pipeline'],
  };
}
