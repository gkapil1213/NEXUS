export interface ThreatCorrelation {
  correlationId: string;
  signalIds: string[];
  confidence: number;
  reason: string;
  createdAt: string;
}

export function correlateThreats(signals: { signalId: string; assetId: string; category: string }[]): ThreatCorrelation[] {
  const groups = new Map<string, ThreatCorrelation>();
  for (const sig of signals) {
    const key = `${sig.assetId}:${sig.category}`;
    if (!groups.has(key)) {
      groups.set(key, { correlationId: `corr-${key}-${Date.now()}`, signalIds: [sig.signalId], confidence: 0.5, reason: `related signals for ${key}`, createdAt: new Date().toISOString() });
    } else {
      const g = groups.get(key)!;
      g.signalIds.push(sig.signalId);
      g.confidence = Math.min(1, g.confidence + 0.1);
    }
  }
  return Array.from(groups.values()).filter(g => g.signalIds.length > 1);
}
