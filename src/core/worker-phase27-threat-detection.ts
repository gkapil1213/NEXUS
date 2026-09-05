import { randomUUID } from 'crypto';

export interface SecurityDetection {
  detectionId: string;
  signalId: string;
  rule: string;
  confidence: number;
  explanation: string;
  assetId: string;
  potentialImpact: string;
  provenance: string;
  createdAt: string;
  idempotencyKey: string;
}

export function detectThreat(signal: { category: string; severity: string }): { detected: boolean; confidence: number; rule: string; explanation: string } {
  const isThreat = signal.severity === 'HIGH' || signal.severity === 'CRITICAL';
  if (!isThreat) return { detected: false, confidence: 0, rule: 'none', explanation: 'below threat threshold' };
  const confidence = signal.severity === 'CRITICAL' ? 0.95 : 0.7;
  return { detected: true, confidence, rule: `rule-${signal.category}`, explanation: `Signal category ${signal.category} with ${signal.severity} severity` };
}

export function createSecurityDetection(input: Omit<SecurityDetection, 'detectionId' | 'createdAt' | 'idempotencyKey'> & { idempotencyKey?: string }): SecurityDetection {
  const idempotencyKey = input.idempotencyKey ?? input.signalId;
  return { detectionId: randomUUID(), ...input, createdAt: new Date().toISOString(), idempotencyKey };
}
