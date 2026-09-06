import { randomUUID } from 'crypto';

export interface PipelineInput {
  name: string;
  provider: string;
  repositoryId?: string;
  branch?: string;
  environmentId?: string;
  externalId?: string;
  owner?: string;
  configFingerprint?: string;
  idempotencyKey?: string;
}

export function processPipeline(input: PipelineInput): any {
  const id = input.idempotencyKey ? input.idempotencyKey : randomUUID();
  return {
    id,
    name: input.name,
    provider: input.provider,
    repository_id: input.repositoryId || null,
    branch: input.branch || null,
    environment_id: input.environmentId || null,
    external_id: input.externalId || null,
    owner: input.owner || null,
    config_fingerprint: input.configFingerprint || null,
    status: 'UNKNOWN',
  };
}
