import { randomUUID } from 'crypto';

export type CapacityRiskLevel = 'LOW'|'MEDIUM'|'HIGH'|'CRITICAL'|'UNKNOWN';
export type SaturationLevel = 'NORMAL'|'ELEVATED'|'DEGRADED'|'SATURATED'|'CRITICAL'|'UNKNOWN';
export type RecommendationAction = 'CONTINUE'|'THROTTLE'|'QUEUE'|'DEFER'|'REDUCE_CONCURRENCY'|'INCREASE_VERIFICATION_INTERVAL'|'SCALE_RECOMMENDED'|'OPTIMIZE_WORKLOAD'|'INVESTIGATE'|'REQUIRE_APPROVAL'|'BLOCK';

interface CapacitySignal {
  id: string;
  signalType: string;
  environmentId?: string;
  serviceId?: string;
  resourceType?: string;
  resourceId?: string;
  observedValue: number;
  baselineValue?: number;
  confidence: number;
  fingerprint: string;
}

interface CapacityAssessment {
  id: string;
  targetType: string;
  targetId: string;
  environmentId?: string;
  utilization: number;
  headroom: number;
  saturationLevel: SaturationLevel;
  capacityScore: number;
  performanceScore: number;
  confidence: number;
  riskLevel: CapacityRiskLevel;
  fingerprint: string;
}

interface PerformanceObservation {
  id: string;
  targetType: string;
  targetId: string;
  environmentId?: string;
  metric: string;
  value: number;
  baseline?: number;
  deviation?: number;
  confidence: number;
  fingerprint: string;
}

const signals = new Map<string, CapacitySignal>();
const baselines = new Map<string, any>();
const assessments = new Map<string, CapacityAssessment>();
const observations = new Map<string, PerformanceObservation>();
const anomalies = new Map<string, any>();
const recommendations = new Map<string, any>();
const optimizationObservations = new Map<string, any>();

function fingerprint(input: any): string { return JSON.stringify(input); }

// Signal ingestion
export function createSignal(input: any): CapacitySignal {
  const fp = fingerprint({ type: input.signalType, env: input.environmentId, svc: input.serviceId, res: input.resourceId, value: input.observedValue, ts: input.occurredAt || new Date().toISOString() });
  if (signals.has(fp)) return signals.get(fp)!;
  const sig: CapacitySignal = {
    id: randomUUID(),
    signalType: input.signalType,
    environmentId: input.environmentId,
    serviceId: input.serviceId,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    observedValue: input.observedValue,
    baselineValue: input.baselineValue,
    confidence: input.confidence || 0,
    fingerprint: fp,
  };
  signals.set(fp, sig);
  return sig;
}

// Baseline
export function createBaseline(input: any): any {
  const fp = fingerprint({ metric: input.metric, target: input.targetId, env: input.environmentId, svc: input.serviceId, res: input.resourceId, value: input.baselineValue });
  if (baselines.has(fp)) return baselines.get(fp)!;
  const bl = {
    id: randomUUID(),
    metric: input.metric,
    targetType: input.targetType || 'service',
    targetId: input.targetId,
    environmentId: input.environmentId,
    serviceId: input.serviceId,
    resourceId: input.resourceId,
    baselineValue: input.baselineValue,
    unit: input.unit,
    sampleCount: input.sampleCount || 0,
    confidence: input.confidence || 0,
    fingerprint: fp,
  };
  baselines.set(fp, bl);
  return bl;
}

// Performance observation
export function observePerformance(input: any): PerformanceObservation {
  const fp = fingerprint({ target: input.targetId, env: input.environmentId, metric: input.metric, value: input.value, ts: input.observedAt || new Date().toISOString() });
  if (observations.has(fp)) return observations.get(fp)!;
  const obs: PerformanceObservation = {
    id: randomUUID(),
    targetType: input.targetType || 'service',
    targetId: input.targetId,
    environmentId: input.environmentId,
    metric: input.metric,
    value: input.value,
    baseline: input.baseline,
    deviation: input.deviation !== undefined ? input.deviation : (input.baseline !== undefined ? input.value - input.baseline : undefined),
    confidence: input.confidence || 0,
    fingerprint: fp,
  };
  observations.set(fp, obs);
  return obs;
}

// Capacity assessment
export function assessCapacity(input: any): CapacityAssessment {
  const fp = fingerprint(input);
  if (assessments.has(fp)) return assessments.get(fp)!;
  const assessment: CapacityAssessment = {
    id: randomUUID(),
    targetType: input.targetType || 'service',
    targetId: input.targetId,
    environmentId: input.environmentId,
    utilization: input.utilization || 0,
    headroom: input.headroom !== undefined ? input.headroom : (input.maxCapacity !== undefined ? Math.max(input.maxCapacity - (input.utilization || 0), 0) : NaN),
    saturationLevel: input.saturationLevel || 'UNKNOWN',
    capacityScore: input.capacityScore || 0,
    performanceScore: input.performanceScore || 0,
    confidence: input.confidence || 0,
    riskLevel: input.riskLevel || 'UNKNOWN',
    fingerprint: fp,
  };
  assessments.set(fp, assessment);
  return assessment;
}

// Saturation
export function detectSaturation(utilization: number, thresholdHigh: number = 0.9, thresholdCritical: number = 1.0): SaturationLevel {
  if (utilization >= thresholdCritical) return 'CRITICAL';
  if (utilization >= thresholdHigh) return 'SATURATED';
  if (utilization >= 0.7) return 'ELEVATED';
  if (utilization >= 0.5) return 'DEGRADED';
  return 'NORMAL';
}

// Anomaly
export function detectAnomaly(input: any): { anomaly: any | null; fingerprint: string } {
  const fp = fingerprint({ target: input.targetId, metric: input.metric, value: input.observedValue, baseline: input.baselineValue });
  const deviation = input.deviation !== undefined ? input.deviation : (input.observedValue !== undefined && input.baselineValue !== undefined ? Math.abs(input.observedValue - input.baselineValue) : 0);
  if (deviation === 0) return { anomaly: null, fingerprint: fp };
  if (!anomalies.has(fp)) {
    anomalies.set(fp, {
      id: randomUUID(),
      targetType: input.targetType || 'service',
      targetId: input.targetId,
      metric: input.metric,
      observedValue: input.observedValue,
      baselineValue: input.baselineValue,
      deviation,
      severity: input.severity || 'LOW',
      confidence: input.confidence || 0,
      status: 'OPEN',
      fingerprint: fp,
    });
  }
  return { anomaly: anomalies.get(fp), fingerprint: fp };
}

// Risk
export function calculateRisk(assessment: CapacityAssessment): CapacityRiskLevel {
  if (assessment.utilization >= 1) return 'CRITICAL';
  if (assessment.utilization >= 0.9) return 'HIGH';
  if (assessment.utilization >= 0.7) return 'MEDIUM';
  return 'LOW';
}

export function assessWorkloadRisk(currentUtilization: number, requestedUtilization: number, capacity: number): { risk: 'SAFE'|'CAUTION'|'HIGH_RISK'|'BLOCKED'|'UNKNOWN'; reason: string } {
  if (!capacity) return { risk: 'UNKNOWN', reason: 'capacity unknown' };
  const projected = currentUtilization + requestedUtilization;
  if (projected > capacity) return { risk: 'BLOCKED', reason: 'exceeds capacity' };
  if (projected >= capacity * 0.9) return { risk: 'HIGH_RISK', reason: 'near capacity' };
  if (projected >= capacity * 0.7) return { risk: 'CAUTION', reason: 'elevated' };
  return { risk: 'SAFE', reason: 'acceptable' };
}

// Recommendation
export function generateRecommendation(input: any): { recommendation: any; fingerprint: string } {
  const fp = fingerprint({ assessmentId: input.assessmentId, action: input.action, targetId: input.targetId, requiredApproval: input.requiredApproval || false });
  if (!recommendations.has(fp)) {
    recommendations.set(fp, {
      id: randomUUID(),
      assessmentId: input.assessmentId,
      action: input.action,
      targetType: input.targetType || 'service',
      targetId: input.targetId,
      expectedEffect: input.expectedEffect,
      riskLevel: input.riskLevel || 'UNKNOWN',
      confidence: input.confidence || 0,
      requiredApproval: input.requiredApproval || false,
      verificationPlan: input.verificationPlan,
      status: 'PROPOSED',
      fingerprint: fp,
    });
  }
  return { recommendation: recommendations.get(fp), fingerprint: fp };
}

// Optimization verification
export function verifyOptimization(input: any): { observation: any; fingerprint: string } {
  const fp = fingerprint({ recommendationId: input.recommendationId, expected: input.expectedEffect, actual: input.actualEffect, deviation: input.deviation || 0 });
  if (!optimizationObservations.has(fp)) {
    optimizationObservations.set(fp, {
      id: randomUUID(),
      recommendationId: input.recommendationId,
      expectedEffect: input.expectedEffect,
      actualEffect: input.actualEffect,
      deviation: input.deviation || 0,
      outcomeClass: input.outcomeClass || 'INSUFFICIENT_EVIDENCE',
      fingerprint: fp,
    });
  }
  return { observation: optimizationObservations.get(fp), fingerprint: fp };
}

// Incident
export function createIncident(targetId: string, severity: string): { signature: string } {
  return { signature: `${targetId}:${severity}` };
}

// Evidence, Audit, Lineage, Learning
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

// Replay
export function replayCapacityAssessment(input: any): { replayed: boolean; divergenceDetected: boolean; result: any } {
  const first = assessCapacity(input);
  const second = assessCapacity(input);
  return { replayed: true, divergenceDetected: first.fingerprint !== second.fingerprint, result: second };
}

// Redaction
export function redactSecret(text: string): string {
  return text
    .replace(/password\s*[:=]\s*\S+/gi, 'password=[REDACTED]')
    .replace(/token\s*[:=]\s*\S+/gi, 'token=[REDACTED]')
    .replace(/api[_-]?key\s*[:=]\s*\S+/gi, 'api_key=[REDACTED]')
    .replace(/authorization\s*[:=]\s*\S+/gi, 'authorization=[REDACTED]')
    .replace(/secret\s*[:=]\s*\S+/gi, 'secret=[REDACTED]')
    .replace(/access[_-]?token\s*[:=]\s*\S+/gi, 'access_token=[REDACTED]');
}
