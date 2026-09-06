import { randomUUID } from 'crypto';

export type ReliabilityRiskLevel = 'EXCELLENT'|'HEALTHY'|'DEGRADED'|'HIGH_RISK'|'CRITICAL'|'INSUFFICIENT_EVIDENCE';
export type RecommendationAction = 'CONTINUE'|'CONTINUE_WITH_ENHANCED_VERIFICATION'|'PAUSE'|'REQUIRE_APPROVAL'|'CONTAIN'|'ROLLBACK_RECOMMENDED'|'INVESTIGATE'|'BLOCK';

interface SignalRecord {
  id: string;
  signalType: string;
  source?: string;
  environmentId?: string;
  serviceId?: string;
  severity?: string;
  observedValue: number;
  baselineValue?: number;
  confidence: number;
  evidenceId?: string;
  fingerprint: string;
}

interface BaselineRecord {
  id: string;
  metric: string;
  scope?: string;
  environmentId?: string;
  serviceId?: string;
  baselineValue: number;
  sampleCount: number;
  confidence: number;
  fingerprint: string;
}

interface AssessmentRecord {
  id: string;
  targetType: string;
  targetId: string;
  environmentId?: string;
  reliabilityScore: number;
  riskLevel: ReliabilityRiskLevel;
  confidence: number;
  evidenceCount: number;
  regressionRisk?: number;
  deploymentRisk?: number;
  rollbackRisk?: number;
  fingerprint: string;
}

const signals = new Map<string, SignalRecord>();
const baselines = new Map<string, BaselineRecord>();
const assessments = new Map<string, AssessmentRecord>();
const anomalies = new Map<string, any>();
const recommendations = new Map<string, any>();
const observations = new Map<string, any>();

function fingerprint(input: any): string { return JSON.stringify(input); }

export function createSignal(input: any): SignalRecord {
  const fp = fingerprint({ type: input.signalType, env: input.environmentId, svc: input.serviceId, value: input.observedValue, ts: input.occurredAt || new Date().toISOString() });
  if (signals.has(fp)) return signals.get(fp)!;
  const sig: SignalRecord = {
    id: randomUUID(),
    signalType: input.signalType,
    source: input.source,
    environmentId: input.environmentId,
    serviceId: input.serviceId,
    severity: input.severity,
    observedValue: input.observedValue,
    baselineValue: input.baselineValue,
    confidence: input.confidence || 0,
    evidenceId: input.evidenceId,
    fingerprint: fp,
  };
  signals.set(fp, sig);
  return sig;
}

export function createBaseline(input: any): BaselineRecord {
  const fp = fingerprint({ metric: input.metric, scope: input.scope, env: input.environmentId, svc: input.serviceId, value: input.baselineValue });
  if (baselines.has(fp)) return baselines.get(fp)!;
  const bl: BaselineRecord = {
    id: randomUUID(),
    metric: input.metric,
    scope: input.scope,
    environmentId: input.environmentId,
    serviceId: input.serviceId,
    baselineValue: input.baselineValue,
    sampleCount: input.sampleCount || 0,
    confidence: input.confidence || 0,
    fingerprint: fp,
  };
  baselines.set(fp, bl);
  return bl;
}

export function detectAnomaly(input: any): { anomaly: any; fingerprint: string } {
  const fp = fingerprint({ type: input.anomalyType, target: input.targetId, value: input.observedValue, baseline: input.baselineValue });
  const deviation = input.deviation ?? (input.observedValue !== undefined && input.baselineValue !== undefined ? Math.abs(input.observedValue - input.baselineValue) : 0);
  if (deviation === 0) return { anomaly: null, fingerprint: fp };
  if (!anomalies.has(fp)) {
    anomalies.set(fp, {
      id: randomUUID(),
      targetType: input.targetType || 'service',
      targetId: input.targetId,
      anomalyType: input.anomalyType,
      severity: input.severity || 'LOW',
      deviation,
      confidence: input.confidence || 0,
      status: 'OPEN',
      fingerprint: fp,
    });
  }
  return { anomaly: anomalies.get(fp), fingerprint: fp };
}

export function assessReliability(input: any): AssessmentRecord {
  const fp = fingerprint(input);
  if (assessments.has(fp)) return assessments.get(fp)!;
  const assessment: AssessmentRecord = {
    id: randomUUID(),
    targetType: input.targetType || 'service',
    targetId: input.targetId,
    environmentId: input.environmentId,
    reliabilityScore: input.reliabilityScore || 0,
    riskLevel: input.riskLevel || 'INSUFFICIENT_EVIDENCE',
    confidence: input.confidence || 0,
    evidenceCount: input.evidenceCount || 0,
    regressionRisk: input.regressionRisk || 0,
    deploymentRisk: input.deploymentRisk || 0,
    rollbackRisk: input.rollbackRisk || 0,
    fingerprint: fp,
  };
  assessments.set(fp, assessment);
  return assessment;
}

export function generateRecommendation(input: any): { recommendation: any; fingerprint: string } {
  const fp = fingerprint({ assessmentId: input.assessmentId, action: input.action });
  if (!recommendations.has(fp)) {
    recommendations.set(fp, {
      id: randomUUID(),
      assessmentId: input.assessmentId,
      action: input.action,
      priority: input.priority || 0,
      confidence: input.confidence || 0,
      requiredApproval: input.requiredApproval || false,
      status: 'PROPOSED',
      fingerprint: fp,
    });
  }
  return { recommendation: recommendations.get(fp), fingerprint: fp };
}

export function verifyRecommendation(input: any): { observation: any; fingerprint: string } {
  const fp = fingerprint({ recommendationId: input.recommendationId, expected: input.expectedOutcome, actual: input.actualOutcome });
  if (!observations.has(fp)) {
    observations.set(fp, {
      id: randomUUID(),
      recommendationId: input.recommendationId,
      expectedOutcome: input.expectedOutcome,
      actualOutcome: input.actualOutcome,
      outcomeClass: input.outcomeClass || 'INSUFFICIENT_EVIDENCE',
      deviation: input.deviation || 0,
      fingerprint: fp,
    });
  }
  return { observation: observations.get(fp), fingerprint: fp };
}

export function classifyOutcome(expected: string, actual: string): string {
  if (expected === actual) return 'CONFIRMED';
  if (actual === 'partial') return 'PARTIALLY_CONFIRMED';
  if (expected === 'success' && actual === 'failure') return 'INCORRECT';
  if (actual === 'regression') return 'REGRESSION';
  return 'UNEXPECTED';
}

export function replayAssessment(input: any): { replayed: boolean; divergenceDetected: boolean; result: any } {
  const first = assessReliability(input);
  const second = assessReliability(input);
  return { replayed: true, divergenceDetected: first.fingerprint !== second.fingerprint, result: second };
}

export function createIncident(targetId: string, severity: string): { signature: string } {
  return { signature: `${targetId}:${severity}` };
}

export function generateEvidence(assessmentId: string, type: string, content: Record<string, unknown>): { evidenceId: string; assessmentId: string; type: string } {
  return { evidenceId: randomUUID(), assessmentId, type };
}

export function recordAudit(assessmentId: string, action: string): { auditId: string; assessmentId: string; action: string } {
  return { auditId: randomUUID(), assessmentId, action };
}

export function recordLineage(assessmentId: string): { lineageId: string; assessmentId: string } {
  return { lineageId: randomUUID(), assessmentId };
}

export function recordLearning(assessmentId: string, outcome: string): { learningId: string; assessmentId: string; outcome: string } {
  return { learningId: randomUUID(), assessmentId, outcome };
}

export function redactSecret(text: string): string {
  return text
    .replace(/password\s*[:=]\s*\S+/gi, 'password=[REDACTED]')
    .replace(/token\s*[:=]\s*\S+/gi, 'token=[REDACTED]')
    .replace(/api[_-]?key\s*[:=]\s*\S+/gi, 'api_key=[REDACTED]')
    .replace(/authorization\s*[:=]\s*\S+/gi, 'authorization=[REDACTED]')
    .replace(/secret\s*[:=]\s*\S+/gi, 'secret=[REDACTED]')
    .replace(/access[_-]?token\s*[:=]\s*\S+/gi, 'access_token=[REDACTED]');
}
