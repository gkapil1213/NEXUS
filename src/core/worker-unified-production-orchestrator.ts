import Database from "better-sqlite3";
import { WorkerDecisionContext } from "./worker-decision-context";
import { WorkerDecisionNormalizer, DomainRecommendation } from "./worker-decision-normalizer";
import { WorkerDecisionConflictDetector } from "./worker-decision-conflict-detector";
import { WorkerDecisionRisk } from "./worker-decision-risk";
import { WorkerDecisionConfidence } from "./worker-decision-confidence";
import { WorkerDecisionArbitrator } from "./worker-decision-arbitrator";
import { WorkerDecisionGovernance } from "./worker-decision-governance";
import { WorkerDecisionSafetyGate } from "./worker-decision-safety-gate";
import { WorkerDecisionAuthorization } from "./worker-decision-authorization";
import { WorkerDecisionExecutor } from "./worker-decision-executor";
import { WorkerDecisionVerification } from "./worker-decision-verification";
import { WorkerDecisionOutcome } from "./worker-decision-outcome";

export class UnifiedProductionOrchestrator {
  private normalizer = new WorkerDecisionNormalizer();
  private conflictDetector = new WorkerDecisionConflictDetector();
  private risk = new WorkerDecisionRisk();
  private confidence = new WorkerDecisionConfidence();
  private arbitrator = new WorkerDecisionArbitrator();
  private governance = new WorkerDecisionGovernance();
  private safetyGate = new WorkerDecisionSafetyGate();
  private authorization = new WorkerDecisionAuthorization();
  private executor: WorkerDecisionExecutor;
  private verifier = new WorkerDecisionVerification();
  private outcome: WorkerDecisionOutcome;

  constructor(private db: Database.Database) {
    this.executor = new WorkerDecisionExecutor(db);
    this.outcome = new WorkerDecisionOutcome(db);
  }

  orchestrate(context: any, recs: DomainRecommendation[], reliability: number, sloState: string, telemetryFresh: boolean): any {
    const normalized = recs.map(r => this.normalizer.normalize(r));
    const conflicts = this.conflictDetector.detect(normalized);
    const riskLevel = this.risk.evaluate(reliability, sloState, context.activeIncidents, context.blastRadius, context.rollbackAvailable, context.confidence);
    const confidenceLevel = this.confidence.evaluate(telemetryFresh, context.dataComplete, context.agreement, context.historicalEvidence);
    const arbitrated = this.arbitrator.arbitrate(normalized, conflicts);
    const governance = this.governance.evaluate({ environment: context.environment, productionFreeze: context.productionFreeze, activeIncident: context.activeIncidents > 0, risk: riskLevel, confidence: confidenceLevel, rollbackAvailable: context.rollbackAvailable });
    const safety = this.safetyGate.evaluate({ governance, risk: riskLevel, confidence: confidenceLevel, staleState: context.staleState, duplicateAction: context.duplicateAction, cooldownActive: context.cooldownActive, rollbackAvailable: context.rollbackAvailable, reliability, headroom: context.headroom });
    const auth = this.authorization.authorize(safety, context.epochValid, context.ownershipValid);

    return { normalized, conflicts, riskLevel, confidenceLevel, arbitrated, governance, safety, auth };
  }
}
