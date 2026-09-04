import Database from "better-sqlite3";
import { WorkerIncidentCorrelator } from "./worker-incident-correlator";
import { WorkerRecoveryStrategy } from "./worker-recovery-strategy";
import { WorkerRecoveryRisk } from "./worker-recovery-risk";
import { WorkerRecoveryBudget } from "./worker-recovery-budget";
import { WorkerRecoveryPlan } from "./worker-recovery-plan";
import { WorkerRecoveryExecutor } from "./worker-recovery-executor";
import { WorkerRecoveryVerification } from "./worker-recovery-verification";
import { WorkerRecoveryOutcome } from "./worker-recovery-outcome";

export class WorkerReliabilityOrchestrator {
  constructor(
    private db: Database.Database,
    private correlator: WorkerIncidentCorrelator,
    private strategy: WorkerRecoveryStrategy,
    private risk: WorkerRecoveryRisk,
    private budget: WorkerRecoveryBudget,
    private planStore: WorkerRecoveryPlan,
    private executor: WorkerRecoveryExecutor,
    private verifier: WorkerRecoveryVerification,
    private outcome: WorkerRecoveryOutcome
  ) {}

  orchestrate(incidentId: string, correlationId: string, sliBefore: number, sliAfter: number): { recoveryId: string; state: string; verification: string; outcome: string } {
    const strategyCandidate = this.strategy.select(0.3, 0.2, 0.9, "HEALTHY", "NORMAL");
    const riskEval = this.risk.evaluate(0.3, 0.2, 0.1, 0.2, 0.1);
    const budgetOk = this.budget.checkAndRecord(incidentId);
    if (!budgetOk) return { recoveryId: "", state: "DENIED", verification: "UNKNOWN", outcome: "UNKNOWN" };

    const recoveryId = `rec_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const created = this.planStore.create({
      recoveryId,
      incidentId,
      correlationId,
      strategy: strategyCandidate.strategy,
      riskLevel: riskEval.riskClass,
      blastRadius: "LOW",
      confidence: strategyCandidate.confidence,
      idempotencyKey: recoveryId,
    });
    if (!created) return { recoveryId, state: "DUPLICATE", verification: "UNKNOWN", outcome: "UNKNOWN" };

    const executed = this.executor.execute(recoveryId, recoveryId);
    if (!executed) return { recoveryId, state: "FAILED", verification: "UNKNOWN", outcome: "UNKNOWN" };

    const verification = this.verifier.verify(recoveryId, sliBefore, sliAfter, "increase", true);
    const outcomeClassification = this.outcome.classify(sliBefore, sliAfter, "increase", false);
    this.outcome.persist(recoveryId, outcomeClassification, 0.8);

    this.planStore.updateState(recoveryId, "RECOVERED");
    return { recoveryId, state: "RECOVERED", verification, outcome: outcomeClassification };
  }
}
