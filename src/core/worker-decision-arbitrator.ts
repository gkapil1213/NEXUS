import { DomainRecommendation } from "./worker-decision-normalizer";

export type ArbitratedDecision = {
  action: string;
  reason: string;
  confidence: string;
  risk: string;
  conflicts: string[];
};

export class WorkerDecisionArbitrator {
  arbitrate(recs: DomainRecommendation[], conflicts: { actionA: string; actionB: string; conflictType: string; severity: string }[]): ArbitratedDecision {
    if (recs.length === 0) return { action: "OBSERVE_ONLY", reason: "no_recommendations", confidence: "UNKNOWN", risk: "UNKNOWN", conflicts: [] };

    const priority: Record<string, number> = {
      "PROTECT_RELIABILITY": 12,
      "ROLLBACK": 10,
      "CONTAIN": 9,
      "RECOVER": 8,
      "PAUSE_RELEASE": 7,
      "HOLD": 6,
      "DEFER": 5,
      "SCALE_UP": 4,
      "SCALE_DOWN": 3,
      "OPTIMIZE_RESOURCE": 2,
      "REDUCE_COST": 1,
      "RELEASE": 0,
      "OBSERVE_ONLY": -1,
    };

    const normalized = recs.map(r => ({ ...r, action: r.action.toUpperCase() }));
    const sorted = [...normalized].sort((a, b) => (priority[b.action] ?? -2) - (priority[a.action] ?? -2));
    const selected = sorted[0];

    const conflictList = conflicts.map(c => `${c.actionA} vs ${c.actionB}`);
    return {
      action: selected.action,
      reason: selected.reason || "highest_priority",
      confidence: selected.confidence,
      risk: selected.risk,
      conflicts: conflictList,
    };
  }
}
