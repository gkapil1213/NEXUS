import { randomUUID } from 'crypto';

export type PipelineStageName = 'CHECKOUT' | 'DEPENDENCY_INSTALL' | 'TYPECHECK' | 'LINT' | 'UNIT_TEST' | 'INTEGRATION_TEST' | 'BUILD' | 'STATIC_ANALYSIS' | 'SECURITY_SCAN' | 'ARTIFACT' | 'VERIFY_ARTIFACT' | 'RELEASE_CANDIDATE' | 'PROMOTION';

export interface PipelineDefinition {
  pipelineId: string;
  version: number;
  name: string;
  stages: PipelineStageName[];
  requiredStages: PipelineStageName[];
  timeoutMs: number;
  retryPolicy: { maxRetries: number; backoffMs: number };
  approvalRequired: boolean;
  artifactRequired: boolean;
  securityRequired: boolean;
  fingerprint: string;
  owner: string;
  policy: string;
  createdAt: string;
  updatedAt: string;
  correlationId: string;
  idempotencyKey: string;
}

export function createPipelineDefinition(
  input: Omit<PipelineDefinition, 'pipelineId' | 'createdAt' | 'updatedAt' | 'fingerprint' | 'idempotencyKey'> & { idempotencyKey?: string }
): PipelineDefinition {
  const fingerprint = `${input.name}:${input.version}:${input.stages.join(',')}:${input.requiredStages.join(',')}`;
  const idempotencyKey = input.idempotencyKey ?? fingerprint;
  const now = new Date().toISOString();
  return {
    pipelineId: randomUUID(),
    ...input,
    fingerprint,
    createdAt: now,
    updatedAt: now,
    idempotencyKey,
  };
}

export function validatePipelineDefinition(pipeline: PipelineDefinition): { valid: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!pipeline.name) reasons.push('missing name');
  if (pipeline.stages.length === 0) reasons.push('no stages');
  if (pipeline.requiredStages.some(s => !pipeline.stages.includes(s))) reasons.push('required stage not in stages');
  if (pipeline.timeoutMs <= 0) reasons.push('invalid timeout');
  if (pipeline.retryPolicy.maxRetries < 0) reasons.push('invalid retry policy');
  if (pipeline.artifactRequired && !pipeline.stages.includes('ARTIFACT')) reasons.push('artifact required but no ARTIFACT stage');
  if (pipeline.securityRequired && !pipeline.stages.includes('SECURITY_SCAN')) reasons.push('security required but no SECURITY_SCAN stage');
  return { valid: reasons.length === 0, reasons };
}
