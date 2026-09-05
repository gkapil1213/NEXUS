export interface CorrelatedSignalGroup {
  groupId: string;
  serviceId: string;
  environmentId: string;
  timeWindowStart: string;
  timeWindowEnd: string;
  signalIds: string[];
  deploymentContext?: string;
  releaseContext?: string;
  score: number;
  createdAt: string;
}

export function correlateSignals(signals: { signalId: string; serviceId: string; environmentId: string; timestamp: string; deploymentContext?: string }[], timeWindowMs: number): CorrelatedSignalGroup[] {
  // deterministic grouping by service+environment and time proximity
  const groups = new Map<string, CorrelatedSignalGroup>();
  for (const sig of signals) {
    const key = `${sig.serviceId}:${sig.environmentId}`;
    if (!groups.has(key)) {
      groups.set(key, {
        groupId: `grp-${key}-${sig.timestamp}`,
        serviceId: sig.serviceId,
        environmentId: sig.environmentId,
        timeWindowStart: sig.timestamp,
        timeWindowEnd: sig.timestamp,
        signalIds: [sig.signalId],
        deploymentContext: sig.deploymentContext,

        score: 1,
        createdAt: new Date().toISOString(),
      });
    } else {
      const g = groups.get(key)!;
      g.signalIds.push(sig.signalId);
      g.score += 1;
      if (sig.timestamp < g.timeWindowStart) g.timeWindowStart = sig.timestamp;
      if (sig.timestamp > g.timeWindowEnd) g.timeWindowEnd = sig.timestamp;
    }
  }
  return Array.from(groups.values()).filter(g => g.signalIds.length > 1);
}
