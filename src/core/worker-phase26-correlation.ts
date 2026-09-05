export interface SignalCorrelation {
  correlationId: string;
  relatedSignals: string[];
  correlationType: string;
  confidence: number;
  timeWindow: string;
  explanation: string;
  createdAt: string;
}

export function correlateSignals(signals: { telemetryId: string; service: string; environment: string; timestamp: string }[], timeWindowMs: number): SignalCorrelation[] {
  const groups = new Map<string, SignalCorrelation>();
  for (const sig of signals) {
    const key = `${sig.service}:${sig.environment}`;
    if (!groups.has(key)) {
      groups.set(key, {
        correlationId: `corr-${key}-${Date.now()}`,
        relatedSignals: [sig.telemetryId],
        correlationType: 'SERVICE_ENVIRONMENT',
        confidence: 0.5,
        timeWindow: `${timeWindowMs}ms`,
        explanation: `Signals for ${sig.service} in ${sig.environment}`,
        createdAt: new Date().toISOString(),
      });
    } else {
      const g = groups.get(key)!;
      g.relatedSignals.push(sig.telemetryId);
      g.confidence = Math.min(1, g.confidence + 0.1);
    }
  }
  return Array.from(groups.values());
}
