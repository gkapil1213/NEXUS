export type RecoveryStrategy =
  | "NO_ACTION"
  | "OBSERVE"
  | "RETRY"
  | "REBALANCE"
  | "DRAIN_WORKER"
  | "RESTART_WORKER"
  | "FAILOVER"
  | "REDISTRIBUTE_WORKLOAD"
  | "SCALE_OUT"
  | "SCALE_IN"
  | "RESTORE_OWNERSHIP"
  | "RENEW_LEASE"
  | "FREEZE_AUTONOMY"
  | "ROLLBACK_CONTROL"
  | "ESCALATE";

export interface StrategyCandidate {
  strategy: RecoveryStrategy;
  score: number;
  risk: number;
  confidence: number;
  expectedRecovery: number;
  blastRadius: number;
  reason: string;
}

export class WorkerRecoveryStrategy {
  select(riskScore: number, blastRadius: number, confidence: number, sloState: string, errorBudgetState: string): StrategyCandidate {
    let strategy: RecoveryStrategy = "NO_ACTION";
    if (sloState === "CRITICAL" || errorBudgetState === "CRITICAL") strategy = "ROLLBACK_CONTROL";
    else if (riskScore > 0.8 || blastRadius > 0.8) strategy = "ESCALATE";
    else if (confidence < 0.5) strategy = "OBSERVE";
    else if (riskScore > 0.6) strategy = "REDISTRIBUTE_WORKLOAD";
    else if (riskScore > 0.4) strategy = "REBALANCE";
    else strategy = "RETRY";
    return {
      strategy,
      score: (1 - riskScore) * confidence,
      risk: riskScore,
      confidence,
      expectedRecovery: confidence,
      blastRadius,
      reason: `slo:${sloState},budget:${errorBudgetState}`,
    };
  }
}
