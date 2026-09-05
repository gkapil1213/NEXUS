import { randomUUID } from 'crypto';

export interface SecuritySignal {
  signalId: string;
  source: string;
  sourceType: string;
  category: string;
  severity: 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';
  assetId: string;
  timestamp: string;
  correlationId: string;
  evidence: string[];
  fingerprint: string;
  createdAt: string;
  idempotencyKey: string;
}

export function createSecuritySignal(
  input: Omit<SecuritySignal, 'signalId' | 'createdAt' | 'fingerprint' | 'idempotencyKey'> & { idempotencyKey?: string }
): SecuritySignal {
  if (!input.source || !input.category || !input.assetId) {
    throw new Error('malformed security signal: missing required fields');
  }
  const fingerprint = `${input.source}:${input.category}:${input.assetId}:${input.timestamp}`;
  const idempotencyKey = input.idempotencyKey ?? fingerprint;
  return {
    signalId: randomUUID(),
    ...input,
    fingerprint,
    createdAt: new Date().toISOString(),
    idempotencyKey,
  };
}
